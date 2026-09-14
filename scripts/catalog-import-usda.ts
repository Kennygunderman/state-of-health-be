// Stage 1 of the catalog pipeline: the USDA FoodData Central import.
//
// WHAT THE STAGE DOES. It builds its whole work list first — the curated FDC
// ids in data/meal-planning/usda-manifest.v1.json, then the three dataset
// sweeps that document declares — fetches the records in batches of twenty
// through the rate-limited USDA client, normalises each one against the
// checks in src/services/catalog.logic.ts, and upserts it on `source_key` as a
// candidate or a quarantined row together with its aliases, its portions and
// its machine-readable validation record. It checkpoints its cursor into
// `catalog_import_runs` so an interruption resumes rather than restarts, and
// writes its counts to data/meal-planning/reports/latest/import-report.json
// (Agent Action Plan §0.7.1 Group 3).
//
// WHAT IT DELIBERATELY DOES NOT DO: publish. A record every check accepts is
// written as a `candidate`, because the duplicate-identity decision needs a
// view of the whole table that a batch-at-a-time import cannot have. That is
// `catalog:validate`'s job, and keeping the two apart is what makes this stage
// safe to re-run: every write is an upsert on a key derived from the vendor's
// own id, and `imported_at` is written once on insert and never on update.
//
// WHY THE WORK LIST IS BUILT BEFORE ANY DETAIL FETCH. The plan's batch
// membership is a pure function of the manifest and the dataset listings, so a
// rerun produces identical batches — which is also what makes an earlier run's
// `usda_api_cache` entries reusable, since a batch's cache key is derived from
// its sorted id set. It also means the run knows how much work it has before
// it spends a request on any of it, and that a resume into a changed plan can
// be refused rather than silently misaligned.
//
// EVERY DECISION HERE IS DATA-DRIVEN. Classification, food state, the brand
// screen, cost class, allergen and diet derivation, naming and portion
// resolution are all tables in the manifest, and the pure functions below take
// them as arguments. No decision in this file consults a model, the clock or a
// nutrition value, and the manifest's own `sweepClassificationRules.deterministic`
// note is the contract that describes it.
//
// The two guard imports below are load-bearing and ordered. Rule
// backend-architecture §10 requires the IPv4-first DNS ordering before any
// network module loads, and dbGuard classifies DATABASE_URL at module load —
// TypeScript's CommonJS emit hoists requires in source order, so these two
// running first is what puts both ahead of anything that could reach Prisma or
// the network.
import './lib/bootstrap';
import './lib/dbGuard';

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { classifyDatabaseOrigin, DatabaseOriginError } from './lib/dbGuard';
import { createFatalLogger, createLogger, safeError, writeLineSync } from './lib/logger';
import type { LogFields, LogLevel, ScriptLogger } from './lib/logger';
import { ManifestError, loadCoveragePlan, loadUsdaManifest, reportPath } from './lib/manifest';
import type {
    CatalogFoodState,
    CostClass,
    CoverageCategory,
    CoveragePlan,
    UsdaDefaultPortionSelector,
    UsdaManifest,
    UsdaManifestFood,
    UsdaSweepAllergenDietRules,
    UsdaSweepBrandExclusionRules,
    UsdaSweepClassificationRules,
    UsdaSweepCostClassRules,
    UsdaSweepFoodStateRules,
    UsdaSweepPortionPolicy,
} from './lib/manifest';
import { ModelBudgetError } from './lib/budget';
import { RateLimitConfigError, createUsdaRateLimiter, getUsdaImportRateLimitPerHour } from './lib/rateLimiter';
import {
    CheckpointError,
    appendRunLog,
    finishRun,
    openOrResumeRun,
    recordCounts,
    saveCursor,
    withCatalogStageLock,
} from './lib/checkpoint';
import type { CatalogRunDb } from './lib/checkpoint';

// The normaliser and the checks. Pure, so importing it costs nothing and opens
// no connection — which is why it is a top-level import where the USDA client
// and the Prisma client, both of which construct state at module load, are
// reached lazily from main().
import { buildSourceKey, normalizeCanonicalName, validateCatalogCandidate } from '../src/services/catalog.logic';
import type {
    CatalogFoodCandidate,
    CatalogFoodPortionCandidate,
    CatalogValidationPolicy,
    CatalogValidationVerdict,
} from '../src/services/catalog.logic';
import type { CatalogIdentityStatus } from '../src/types/catalog';
// The one place the unit vocabulary lives. Asking it, rather than carrying a
// second list here, is what keeps a portion's unit in the family the grocery
// list will later display it in.
import { toBaseQuantity, unitFamily } from '../src/utils/units';
// Type-only: the value side of usda.service constructs a Prisma client for its
// response cache, so it is imported inside main() and these stay erased.
import type {
    UsdaFoodDetail,
    UsdaFoodNutrient,
    UsdaFoodPortion,
    UsdaFoodSummary,
} from '../src/services/usda.service';

const STAGE = 'catalog-import-usda';

const USDA_API_KEY_ENV = 'USDA_API_KEY';

// USDA documents 20 FDC ids as the maximum for one POST /foods call, and
// src/services/usda.service.ts exports the same number as MAX_BATCH_FDC_IDS and
// throws above it. Restated rather than imported because the value side of that
// module is loaded lazily from main(); the two are asserted equal there.
const MAX_BATCH_FDC_IDS = 20;

const CATALOG_LOGIC_MODULE = 'src/services/catalog.logic.ts';

const logger = createLogger(STAGE);

// ---------------------------------------------------------------------------
// Argument parsing — pure, so every branch below is decided without touching
// `process`, the filesystem or the clock (Rule backend-architecture §1.2).
// ---------------------------------------------------------------------------

export interface ImportOptions {
    /** `--help`/`-h`; when true nothing else in this object has been honoured. */
    readonly help: boolean;
    /** `--category`, repeatable. Empty means every category in the coverage plan. */
    readonly categories: readonly string[];
    /** `--limit`; `null` means "no limit", which is not the same as 0. */
    readonly limit: number | null;
    readonly resume: boolean;
    readonly dryRun: boolean;
}

export interface ArgumentError {
    /** The flag or token the operator has to change. */
    readonly flag: string;
    readonly message: string;
}

export type ParseResult =
    | { readonly ok: true; readonly options: ImportOptions }
    | { readonly ok: false; readonly errors: readonly ArgumentError[] };

/** One input the stage consumes that is not satisfied. */
export interface PrerequisiteGap {
    /** Stable across revisions: it is what a log consumer greps for. */
    readonly code: string;
    readonly requirement: string;
    /** Names the file to create or the command that produces it. */
    readonly remedy: string;
    /** The narrowed failure behind the gap, when one was observed. */
    readonly detail?: string;
}

const HELP_FLAGS: readonly string[] = ['--help', '-h'];

// dbGuard owns this flag: it reads it straight off process.argv at module load
// to satisfy the `development_or_confirmed` policy. It is accepted and skipped
// here (value included, so it is not mistaken for a positional argument) rather
// than rejected, because an operator who passes it to any stage should get that
// stage's usage, not a parse error about a flag the pipeline does define.
const CONFIRM_TARGET_FLAG = '--confirm-target';

interface Token {
    readonly flag: string;
    /** The `--flag=value` form's value; `null` when the token carried none. */
    readonly inlineValue: string | null;
}

const splitToken = (token: string): Token => {
    const separator = token.indexOf('=');
    if (!token.startsWith('--') || separator < 0) {
        return { flag: token, inlineValue: null };
    }
    return { flag: token.slice(0, separator), inlineValue: token.slice(separator + 1) };
};

export const parseArgs = (argv: readonly string[]): ParseResult => {
    // Help is answered whatever else is on the line: an operator asking how to
    // use the command must not have to write a valid command line first.
    if (argv.some((token) => HELP_FLAGS.includes(token))) {
        return { ok: true, options: { help: true, categories: [], limit: null, resume: false, dryRun: false } };
    }

    const errors: ArgumentError[] = [];
    const categories: string[] = [];
    let limit: number | null = null;
    let limitSeen = false;
    let resume = false;
    let dryRun = false;

    let index = 0;
    // Reads a flag's value from either form. A following token that is itself a
    // flag is never consumed as a value — `--limit --resume` is a missing value,
    // not a limit of "--resume".
    const takeValue = (inlineValue: string | null): string | null => {
        if (inlineValue !== null) {
            return inlineValue.length > 0 ? inlineValue : null;
        }
        const next = index < argv.length ? argv[index] : null;
        if (next === null || next.length === 0 || next.startsWith('-')) {
            return null;
        }
        index += 1;
        return next;
    };

    while (index < argv.length) {
        const { flag, inlineValue } = splitToken(argv[index]);
        index += 1;

        if (flag === '--category') {
            const value = takeValue(inlineValue);
            if (value === null) {
                errors.push({ flag, message: `${flag} requires a coverage-plan category name` });
                continue;
            }
            categories.push(value);
            continue;
        }

        if (flag === '--limit') {
            const value = takeValue(inlineValue);
            if (value === null) {
                errors.push({ flag, message: `${flag} requires a positive integer` });
                continue;
            }
            if (limitSeen) {
                errors.push({ flag, message: `${flag} was given more than once; it takes a single value` });
                continue;
            }
            limitSeen = true;
            const parsed = Number(value);
            if (!Number.isInteger(parsed) || parsed <= 0) {
                errors.push({ flag, message: `${flag} must be a positive integer` });
                continue;
            }
            limit = parsed;
            continue;
        }

        if (flag === '--resume') {
            resume = true;
            continue;
        }

        if (flag === '--dry-run') {
            dryRun = true;
            continue;
        }

        if (flag === CONFIRM_TARGET_FLAG) {
            takeValue(inlineValue);
            continue;
        }

        errors.push({ flag, message: `${flag} is not a flag ${STAGE} accepts` });
    }

    if (errors.length > 0) {
        return { ok: false, errors };
    }

    return { ok: true, options: { help: false, categories, limit, resume, dryRun } };
};

// ---------------------------------------------------------------------------
// Usage.
// ---------------------------------------------------------------------------

export const describeUsage = (): string =>
    [
        `Usage: npm run catalog:import -- [options]   (${STAGE})`,
        '',
        'Imports USDA FoodData Central records into the catalog as candidates.',
        '',
        'Checks every input first and exits 1 naming the unsatisfied prerequisites',
        'and their remedies rather than starting a partial run. Then plans the whole',
        'work list (the curated manifest entries, then the three dataset sweeps),',
        'fetches it in batches of 20 under the configured hourly rate limit, and',
        'upserts each record on its source key together with its aliases, its',
        'portions and its validation record, checkpointing as it goes.',
        '',
        'This stage publishes nothing: a record whose checks pass is written as a',
        'candidate, and catalog:validate is the stage that publishes.',
        '',
        'Re-running is safe. Every write is an upsert keyed on the vendor id and',
        'the batch plan is a pure function of the manifest, so an interrupted run',
        'converges on the same catalog when it resumes. A run that already',
        'SUCCEEDED for this manifest version is recognised and does no work at',
        'all, which is what makes a repeat import incapable of creating',
        'duplicates. Re-deriving an existing catalog - after changing how a field',
        'is computed, say - therefore needs a new manifest version or an empty',
        'catalog, not a second identical run.',
        '',
        'Options:',
        '  --category <name>   Restrict the import to one coverage-plan category.',
        '                      Repeatable. Default: every category in the coverage plan.',
        '  --limit <n>         Stop after n manifest records. Positive integer.',
        '                      Default: no limit.',
        '  --resume            Continue this stage\'s newest unfinished run from its',
        '                      stored cursor instead of starting a new one.',
        '                      Default: off (a new run).',
        '  --dry-run           Report what the import would write without writing it.',
        '                      Default: off.',
        '  --help, -h          Print this usage block and exit 0.',
        '',
        'Inputs read:',
        '  data/meal-planning/usda-manifest.v1.json   curated FDC ids, per-category',
        '  data/meal-planning/coverage-plan.v1.json   category targets and bounds',
        '  src/services/catalog.logic.ts              the per-100g normaliser every',
        '                                             record is written through',
        '',
        'Environment:',
        '  DATABASE_URL                      required; classified by scripts/lib/dbGuard.ts',
        '  USDA_API_KEY                      required; the FoodData Central key',
        '  USDA_IMPORT_RATE_LIMIT_PER_HOUR   optional; integer 1-1000, default 900',
    ].join('\n');

const writeUsage = (level: LogLevel): void => {
    writeLineSync(describeUsage(), level);
};

// ---------------------------------------------------------------------------
// Preflight.
// ---------------------------------------------------------------------------

export interface ImportPreflightDeps {
    readonly env: NodeJS.ProcessEnv;
    readonly loadUsdaManifest: () => unknown;
    readonly loadCoveragePlan: () => unknown;
    readonly resolveRateLimit: (env: NodeJS.ProcessEnv) => number;
    /** Repository-relative existence check, seamed so preflight stays testable. */
    readonly fileExists: (repoRelativePath: string) => boolean;
}

const repoFileExists = (repoRelativePath: string): boolean =>
    fs.existsSync(path.resolve(__dirname, '..', repoRelativePath));

const defaultPreflightDeps = (): ImportPreflightDeps => ({
    env: process.env,
    loadUsdaManifest,
    loadCoveragePlan,
    resolveRateLimit: getUsdaImportRateLimitPerHour,
    fileExists: repoFileExists,
});

// A manifest that fails for its own documented reasons is a prerequisite gap
// with a remedy; anything else (a permission fault, a directory where a file
// belongs) is an environment problem the caller must see as itself, so it is
// rethrown to main's narrowing catch rather than flattened into a gap.
const manifestGap = (
    load: () => unknown,
    code: string,
    requirement: string,
    remedy: string,
): PrerequisiteGap | null => {
    try {
        load();
        return null;
    } catch (error) {
        if (error instanceof ManifestError) {
            return { code, requirement, remedy, detail: `${error.code}: ${error.message}` };
        }
        throw error;
    }
};

export const preflight = (deps: ImportPreflightDeps): readonly PrerequisiteGap[] => {
    const gaps: PrerequisiteGap[] = [];

    const manifest = manifestGap(
        deps.loadUsdaManifest,
        'usda_manifest_unavailable',
        'data/meal-planning/usda-manifest.v1.json must load and declare usdaManifestVersion v1',
        'Add the curated FDC id manifest at data/meal-planning/usda-manifest.v1.json (AAP §0.7.1 Group 3).',
    );
    if (manifest !== null) {
        gaps.push(manifest);
    }

    const plan = manifestGap(
        deps.loadCoveragePlan,
        'coverage_plan_unavailable',
        'data/meal-planning/coverage-plan.v1.json must load and declare coveragePlanVersion v1',
        'Add the 21-category coverage plan at data/meal-planning/coverage-plan.v1.json (AAP §0.7.1 Group 3).',
    );
    if (plan !== null) {
        gaps.push(plan);
    }

    const usdaApiKey = deps.env[USDA_API_KEY_ENV];
    if (usdaApiKey === undefined || usdaApiKey.trim().length === 0) {
        gaps.push({
            code: 'usda_api_key_missing',
            requirement: `${USDA_API_KEY_ENV} must be set: every manifest record is fetched from FoodData Central`,
            remedy: `Set ${USDA_API_KEY_ENV} in backend/.env (see .env.example) or in the environment.`,
        });
    }

    try {
        deps.resolveRateLimit(deps.env);
    } catch (error) {
        if (error instanceof RateLimitConfigError) {
            gaps.push({
                code: 'usda_rate_limit_misconfigured',
                requirement:
                    'USDA_IMPORT_RATE_LIMIT_PER_HOUR must resolve to an integer within the vendor cap so every fetch is paced',
                remedy: 'Set USDA_IMPORT_RATE_LIMIT_PER_HOUR to an integer between 1 and 1000, or unset it to take the default of 900.',
                detail: error.message,
            });
        } else {
            throw error;
        }
    }

    if (!deps.fileExists(CATALOG_LOGIC_MODULE)) {
        gaps.push({
            code: 'catalog_logic_absent',
            requirement: `${CATALOG_LOGIC_MODULE} must exist: it normalises every USDA record to per-100g before the upsert`,
            remedy: `Land ${CATALOG_LOGIC_MODULE} with its unit suite (AAP §0.7.1 Group 3).`,
        });
    }

    return gaps;
};

// ---------------------------------------------------------------------------
// Classification, naming and derivation — pure functions over the manifest.
//
// Every one of these takes its policy as an argument rather than reading the
// manifest itself, so the import's decisions are testable without a document
// on disk, and so a reviewer can see that no decision here consults nutrition
// values, the clock or the network. The manifest's own
// `sweepClassificationRules.deterministic` note is the contract they implement.
// ---------------------------------------------------------------------------

/** The classification a description resolves to, and whether it is in scope. */
export interface SweepClassification {
    readonly category: CoverageCategory;
    readonly foodGroup: string;
    /** True when a rule matched; false means the fallback supplied the values. */
    readonly matched: boolean;
    /** True when the matching rule marks the description out of scope. */
    readonly excluded: boolean;
}

const matchesRule = (
    lowerDescription: string,
    rule: { descriptionStartsWith?: readonly string[]; descriptionContains?: readonly string[] },
): boolean => {
    const startsWith = rule.descriptionStartsWith ?? [];
    for (const needle of startsWith) {
        if (lowerDescription.startsWith(needle)) {
            return true;
        }
    }
    const contains = rule.descriptionContains ?? [];
    for (const needle of contains) {
        if (lowerDescription.indexOf(needle) >= 0) {
            return true;
        }
    }
    return false;
};

/**
 * First match wins, which is why the rule array's order is policy rather than
 * presentation: composite-dish rules precede ingredient rules so an as-eaten
 * description is not classified as its first ingredient.
 */
export const classifyDescription = (
    description: string,
    rules: UsdaSweepClassificationRules,
): SweepClassification => {
    const lower = description.trim().toLowerCase();

    for (const rule of rules.rules) {
        if (matchesRule(lower, rule)) {
            return {
                category: rule.category,
                foodGroup: rule.foodGroup,
                matched: true,
                excluded: rule.excludeFromPublication === true,
            };
        }
    }

    return {
        category: rules.fallback.category,
        foodGroup: rules.fallback.foodGroup,
        matched: false,
        excluded: false,
    };
};

/**
 * The state is read from the description and, failing that, from the dataset —
 * never from nutrition. Raw, dry and cooked forms stay separate rows because
 * their energy per 100 g differs and grocery aggregation must not merge them.
 */
export const resolveFoodState = (
    description: string,
    dataType: string,
    rules: UsdaSweepFoodStateRules,
): CatalogFoodState => {
    const lower = description.trim().toLowerCase();

    for (const rule of rules.rules) {
        if (matchesRule(lower, rule)) {
            return rule.foodState;
        }
    }

    for (const fallback of rules.datasetFallback) {
        if (fallback.dataType === dataType) {
            return fallback.foodState;
        }
    }

    return 'as_purchased';
};

const LETTERS_ONLY_PATTERN = /[^A-Za-z]/g;

/**
 * The sweeps' brand screen. USDA writes manufacturer names in upper case in
 * its own descriptions, so an unexplained all-caps token is the most reliable
 * brand signal in this corpus; the allowlist carries the abbreviations USDA
 * also capitalises (NFS, RTD, DHA) so they are not mistaken for brands.
 *
 * Returns the signal that fired, so the report can say why a record was
 * skipped rather than only that it was.
 */
export const brandExclusionReason = (
    description: string,
    rules: UsdaSweepBrandExclusionRules,
): string | null => {
    for (const symbol of rules.signals.trademarkSymbols) {
        if (description.indexOf(symbol) >= 0) {
            return `trademark_symbol:${symbol}`;
        }
    }

    const lower = description.toLowerCase();
    for (const word of rules.signals.brandWordContains) {
        if (lower.indexOf(word) >= 0) {
            return `brand_word:${word}`;
        }
    }

    const { minimumLetters, allowedAllCaps } = rules.signals.allCapsRun;
    const allowed = new Set(allowedAllCaps.map((token) => token.toUpperCase()));
    for (const rawToken of description.split(/[\s,./()]+/)) {
        const letters = rawToken.replace(LETTERS_ONLY_PATTERN, '');
        if (letters.length < minimumLetters) {
            continue;
        }
        if (letters === letters.toUpperCase() && !allowed.has(letters)) {
            return `all_caps:${letters}`;
        }
    }

    return null;
};

const PLURAL_EXCEPTIONS: Readonly<Record<string, string>> = {
    leaf: 'leaves',
    loaf: 'loaves',
    half: 'halves',
    potato: 'potatoes',
    tomato: 'tomatoes',
    mango: 'mangoes',
    goose: 'geese',
};

/** English pluralisation, enough for a head noun taken from a description. */
export const pluralizeHeadNoun = (noun: string): string | null => {
    const word = noun.trim().toLowerCase();
    if (word.length === 0 || word.indexOf(' ') >= 0) {
        return null;
    }
    const exception = PLURAL_EXCEPTIONS[word];
    if (exception !== undefined) {
        return exception;
    }
    if (word.endsWith('s') || word.endsWith('x') || word.endsWith('z')) {
        return null;
    }
    if (word.endsWith('y') && word.length > 1 && 'aeiou'.indexOf(word.charAt(word.length - 2)) < 0) {
        return `${word.slice(0, -1)}ies`;
    }
    if (word.endsWith('ch') || word.endsWith('sh')) {
        return `${word}es`;
    }
    return `${word}s`;
};

const STATE_WORDS: readonly string[] = [
    'raw',
    'cooked',
    'boiled',
    'roasted',
    'baked',
    'grilled',
    'broiled',
    'steamed',
    'braised',
    'fried',
    'toasted',
    'dried',
    'dehydrated',
    'uncooked',
    'unprepared',
    'canned',
    'frozen',
    'dry',
];

/**
 * A swept record's aliases come from its own description and nothing else — the
 * manifest's `sweepAliasPolicy`: the leading qualifier reordered in front of
 * the head noun ("Rice, brown, long-grain, raw" gives "brown rice"), plus the
 * head noun's plural. No synonym is invented, because an alias is a claim that
 * two names denote the same food and a wrong claim steals rank from the food
 * the user actually meant.
 */
export const deriveSweepAliases = (description: string, canonicalName: string): string[] => {
    const segments = description
        .toLowerCase()
        .split(',')
        .map((segment) => segment.trim())
        .filter((segment) => segment.length > 0);

    if (segments.length === 0) {
        return [];
    }

    const head = segments[0];
    const aliases: string[] = [];

    for (const qualifier of segments.slice(1)) {
        if (STATE_WORDS.indexOf(qualifier) >= 0 || qualifier.indexOf(' ') >= 0) {
            continue;
        }
        aliases.push(`${qualifier} ${head}`);
        break;
    }

    const headWords = head.split(/\s+/);
    const lastWord = headWords[headWords.length - 1];
    const plural = pluralizeHeadNoun(lastWord);
    if (plural !== null) {
        aliases.push(headWords.length === 1 ? plural : `${headWords.slice(0, -1).join(' ')} ${plural}`);
    }

    const normalizedCanonical = normalizeCanonicalName(canonicalName);
    const seen = new Set<string>();
    const kept: string[] = [];
    for (const alias of aliases) {
        const trimmed = alias.trim().toLowerCase();
        if (trimmed.length === 0 || seen.has(trimmed) || normalizeCanonicalName(trimmed) === normalizedCanonical) {
            continue;
        }
        seen.add(trimmed);
        kept.push(trimmed);
    }
    return kept;
};

/**
 * `search_text` feeds the STORED `search_vector`, so it carries the terms that
 * should match and no punctuation: `to_tsvector` owns stemming and weighting,
 * and this file's job is to hand it plain words (Rule backend-architecture §7).
 */
export const buildSearchText = (
    canonicalName: string,
    aliases: readonly string[],
    foodState: CatalogFoodState,
    foodGroup: string,
): string => {
    const words: string[] = [];
    const seen = new Set<string>();
    const push = (value: string): void => {
        for (const word of normalizeCanonicalName(value).split(' ')) {
            if (word.length > 0 && !seen.has(word)) {
                seen.add(word);
                words.push(word);
            }
        }
    };

    push(canonicalName);
    for (const alias of aliases) {
        push(alias);
    }
    push(foodState.replace(/_/g, ' '));
    push(foodGroup.replace(/_/g, ' '));

    return words.join(' ');
};

/** `1` when the category has no row, so a missing policy is visible, not silent. */
export const resolveCostClass = (
    category: string,
    foodGroup: string,
    rules: UsdaSweepCostClassRules,
): CostClass => rules.foodGroupOverrides[foodGroup] ?? rules.byCategory[category] ?? 2;

/** What the allergen and diet derivation concluded, and why review still applies. */
export interface DerivedSafetyTags {
    readonly allergenTags: string[];
    readonly dietTags: string[];
    /** Names the composite markers found, for the validation record's assumptions. */
    readonly compositeMarkers: string[];
}

/**
 * Derives allergen and diet tags from the food group and the description. The
 * derivation only ever narrows — it adds an allergen and removes a diet tag,
 * never the reverse — and it never sets `allergen_status` to `known`:
 * inference is not review, and `allergen_status` is the column the planner
 * reads before putting a food in front of someone with an allergy.
 */
export const deriveSafetyTags = (
    description: string,
    category: string,
    foodGroup: string,
    rules: UsdaSweepAllergenDietRules,
): DerivedSafetyTags => {
    const lower = description.toLowerCase();

    const allergens = new Set<string>(rules.byFoodGroup[foodGroup] ?? []);
    for (const allergen of rules.allergenVocabulary) {
        const markers = rules.descriptionAllergenMarkers[allergen] ?? [];
        for (const marker of markers) {
            if (lower.indexOf(marker) >= 0) {
                allergens.add(allergen);
                break;
            }
        }
    }

    const derivation = rules.dietDerivation;
    const hasMarker = (markers: readonly string[]): boolean => {
        for (const marker of markers) {
            if (lower.indexOf(marker) >= 0) {
                return true;
            }
        }
        return false;
    };

    const dietTags = new Set<string>(rules.dietTagVocabulary);

    const animalCategory = derivation.animalCategories.indexOf(category) >= 0 && category !== 'protein_seafood';
    if (animalCategory || hasMarker(derivation.animalMarkers)) {
        dietTags.delete('vegan');
        dietTags.delete('vegetarian');
        // Meat and poultry are not pescatarian either, so the third tag goes
        // too. Spelled 'pescatarian' to match dietTagVocabulary in
        // usda-manifest.v1.json and the only spelling
        // recipe.logic.ts::isDietCompatible matches: were this literal to drift
        // from the vocabulary the delete would silently miss, and every meat
        // food would be published as pescatarian-admissible.
        dietTags.delete('pescatarian');
    } else if (category === 'protein_seafood' || hasMarker(derivation.seafoodMarkers)) {
        dietTags.delete('vegan');
        dietTags.delete('vegetarian');
    } else if (hasMarker(derivation.dairyEggMarkers)) {
        dietTags.delete('vegan');
    }

    if (allergens.has('wheat')) {
        dietTags.delete('gluten_free');
    }

    const compositeMarkers: string[] = [];
    for (const marker of rules.compositeMarkers.markers) {
        if (lower.indexOf(marker) >= 0) {
            compositeMarkers.push(marker.trim());
        }
    }

    const allergenOrder = rules.allergenVocabulary;
    const dietOrder = rules.dietTagVocabulary;

    return {
        allergenTags: allergenOrder.filter((tag) => allergens.has(tag)),
        dietTags: dietOrder.filter((tag) => dietTags.has(tag)),
        compositeMarkers,
    };
};

const ISO_MONTH_PATTERN = /^(\d{4})-(\d{2})/;
const US_DATE_PATTERN = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

/**
 * `"<dataType> YYYY-MM"`, reproducing the reviewed rows' `"SR Legacy 2019-04"`.
 * USDA states `publicationDate` as `M/D/YYYY` on a detail record and as ISO on
 * a list record, so both forms are parsed rather than one being assumed.
 */
export const buildSourceVersion = (dataType: string, publicationDate: string | undefined): string => {
    const raw = (publicationDate ?? '').trim();

    const iso = ISO_MONTH_PATTERN.exec(raw);
    if (iso !== null) {
        return `${dataType} ${iso[1]}-${iso[2]}`;
    }

    const us = US_DATE_PATTERN.exec(raw);
    if (us !== null) {
        return `${dataType} ${us[3]}-${us[1].padStart(2, '0')}`;
    }

    return dataType;
};

/**
 * Reads one nutrient from a USDA record, tolerating every shape the API uses:
 * a detail record nests the descriptor (`nutrient.number` with `amount`) while
 * list and search results flatten it (`nutrientNumber` with `value`). A
 * missing nutrient is `null` — "unknown", never coerced to zero, because zero
 * is a claim about the food and `null` is the absence of one.
 */
export const readNutrientAmount = (
    nutrients: readonly UsdaFoodNutrient[] | undefined,
    nutrientNumber: string,
): number | null => {
    for (const entry of nutrients ?? []) {
        const nested = entry.nutrient?.number;
        const candidateNumber = nested ?? entry.nutrientNumber ?? (entry as { number?: string | number }).number;
        if (candidateNumber === undefined || String(candidateNumber) !== nutrientNumber) {
            continue;
        }
        const amount = entry.amount ?? entry.value;
        if (typeof amount === 'number' && Number.isFinite(amount)) {
            return amount;
        }
    }
    return null;
};

/** Total dietary fibre. Not one of the four core nutrients, so absence is fine. */
const FIBER_NUTRIENT_NUMBER = '291';

const QUANTITY_NOT_SPECIFIED = 'quantity not specified';
const LEADING_AMOUNT_PATTERN = /^\s*(\d+(?:\.\d+)?)\s*(?:\/\s*(\d+(?:\.\d+)?)\s*)?/;
const UNIT_TOKEN_PATTERN = /[a-z]+/g;

/**
 * A parenthetical in a USDA portion label is a yield or weight note, never the
 * measure: "roast (yield from 714 g raw meat)" is one roast, not one gram.
 */
const PARENTHETICAL_PATTERN = /\([^)]*\)/g;

/** A leading amount has already been read into `amount`; it is not the unit. */
const LEADING_QUANTITY_PATTERN = /^\s*\d+(?:\.\d+)?(?:\s*\/\s*\d+(?:\.\d+)?)?\s*/;

/** Two-word units ("fl oz", "fluid ounce") need the first two tokens as a phrase. */
const UNIT_PHRASE_TOKENS = 2;

/**
 * How far a mass measure's stated weight may drift from the source's own gram
 * weight before the label is judged not to be describing this portion.
 *
 * The only drift this has to absorb is USDA's own rounding: gram weights are
 * recorded as integers, so "1 oz" is stored as 28 or 29 rather than 28.35 and
 * "0.5 oz" as 15 rather than 14.17. That error is bounded in GRAMS, not in
 * percent — which is why the tolerance is an absolute floor with a relative
 * term for large weights, rather than a percentage that would reject a
 * correctly rounded half-ounce.
 */
const MASS_IDENTITY_TOLERANCE_G = 1;
const MASS_IDENTITY_TOLERANCE_RATIO = 0.02;

/** A household measure read off one `foodPortions` entry. */
export interface ParsedPortionLabel {
    readonly description: string;
    readonly amount: number;
    readonly unit: string;
}

/**
 * Turns a USDA portion into the household measure a grocery list can display.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE. `amount` and `unit` describe the
 * measure the source states; `gram_weight` is the weight, and it is a separate
 * column. Substituting the weight into the measure — storing "1 cup, halves"
 * as `amount: 152, unit: "g"` — destroys the unit family the grocery display
 * depends on and contradicts the row's own description, which is the defect
 * this importer is written to avoid.
 *
 * A unit token `src/utils/units.ts` recognises is kept as that unit. A
 * household noun it does not recognise (apple, patty, fillet, sprig) becomes
 * the count unit `each`, which is what `formatCount` and `pluralizeCount`
 * consume, and the noun stays in the description, where the user reads it.
 */
/**
 * Whether a reviewed selector is describing this source label.
 *
 * The same exact-then-containment rule {@link matchSelectorPortion} pairs them
 * by, applied to the label text alone so the two cannot disagree about what
 * counts as a match. A selector that names no measure at all describes any
 * label, which is the documented "no measure named" fallback.
 */
export const selectorDescribesLabel = (selector: UsdaDefaultPortionSelector, label: string): boolean => {
    const wanted = (selector.modifier ?? selector.portionDescription ?? selector.description ?? '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');
    if (wanted.length === 0) {
        return true;
    }
    const normalized = label.trim().toLowerCase().replace(/\s+/g, ' ');
    return normalized === wanted || normalized.indexOf(wanted) >= 0 || wanted.indexOf(normalized) >= 0;
};

export const parsePortionLabel = (
    portion: UsdaFoodPortion,
    dataType: string,
    selector?: UsdaDefaultPortionSelector,
): ParsedPortionLabel | null => {
    const labelSource =
        dataType === 'Survey (FNDDS)'
            ? (portion.portionDescription ?? '')
            : dataType === 'Foundation'
              ? [portion.measureUnit?.name, portion.portionDescription]
                    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
                    .join(', ')
              : (portion.modifier ?? '');

    const label = labelSource.trim();
    if (label.length === 0 || label.toLowerCase().indexOf(QUANTITY_NOT_SPECIFIED) >= 0) {
        return null;
    }

    // FNDDS embeds the amount at the start of the label and keeps a numeric
    // measure code in `modifier`; the reference datasets carry the amount in
    // their own `amount` field. Parsing the leading number off the FNDDS label
    // is therefore reading the amount, not guessing it.
    let amount = typeof portion.amount === 'number' && portion.amount > 0 ? portion.amount : null;
    let description = label;

    if (dataType === 'Survey (FNDDS)') {
        const leading = LEADING_AMOUNT_PATTERN.exec(label);
        if (leading !== null && leading[0].trim().length > 0) {
            const numerator = Number(leading[1]);
            const denominator = leading[2] === undefined ? null : Number(leading[2]);
            const parsed = denominator !== null && denominator > 0 ? numerator / denominator : numerator;
            if (Number.isFinite(parsed) && parsed > 0) {
                amount = parsed;
                description = label.slice(leading[0].length).trim();
            }
        }
    }

    if (amount === null || !Number.isFinite(amount) || amount <= 0) {
        return null;
    }
    if (description.length === 0) {
        description = label;
    }

    // The selector's own description is the reviewed wording and wins when one
    // was supplied — but only over the portion the selector actually describes.
    // `matchSelectorPortion` is what pairs the two, and it answers null when
    // nothing matches; this second check makes the guarantee local rather than
    // a property of the caller, so handing this function an unrelated portion
    // and a selector cannot mint "1 cup / 30 g" out of a source "1 slice /
    // 30 g". A selector that does not describe this label is ignored and the
    // source's own measure is derived below.
    if (selector !== undefined && selectorDescribesLabel(selector, label)) {
        return {
            description: selector.description,
            amount: typeof selector.amount === 'number' && selector.amount > 0 ? selector.amount : amount,
            unit: resolvePortionUnit(selector.unit, selector.description),
        };
    }

    // The curated branch above returns the unit a human approved, verbatim. A
    // unit derived here is confirmed against the source's own gram weight
    // before it is trusted, so a label whose head noun happens to collide with
    // a mass token cannot write a portion that contradicts its own weight.
    const derived = resolvePortionUnit(undefined, description);
    const reconciled = reconcileMassUnit(amount, derived, portion.gramWeight);
    if (reconciled === null) {
        return null;
    }

    return { description, amount, unit: reconciled };
};

/**
 * A unit token `units.ts` recognises, or `each`. `units.ts` is the one place
 * the unit vocabulary lives, so this asks it rather than carrying a second
 * list that could drift from the one grocery display actually uses.
 */
export const resolvePortionUnit = (declaredUnit: string | undefined, description: string): string => {
    const declared = (declaredUnit ?? '').trim().toLowerCase();
    if (declared.length > 0 && unitFamily(declared) !== null) {
        return declared;
    }

    // The measure is the HEAD of the label — what precedes the first comma
    // qualifier, with any parenthetical note and any already-read leading
    // amount removed. Scanning the whole label instead reads the "g" out of
    // "roast (yield from 714 g raw meat)" and stores a 591 g roast as one
    // gram: a row that contradicts its own description and drags the grocery
    // row into the mass family. The qualifiers a label carries after its head
    // ("cup, sifted", "steak, excluding refuse") describe the food, not the
    // measure, so they are never a source of units either.
    const head = description
        .toLowerCase()
        .replace(PARENTHETICAL_PATTERN, ' ')
        .split(',')[0]
        .replace(LEADING_QUANTITY_PATTERN, '')
        .trim()
        .replace(/\s+/g, ' ');

    if (head.length > 0 && unitFamily(head) !== null) {
        return head;
    }

    const tokens: string[] = head.match(UNIT_TOKEN_PATTERN) ?? [];
    const phrase = tokens.slice(0, UNIT_PHRASE_TOKENS).join(' ');
    if (phrase.length > 0 && unitFamily(phrase) !== null) {
        return phrase;
    }

    const leading = tokens.length > 0 ? tokens[0] : '';
    if (leading.length > 0 && unitFamily(leading) !== null) {
        return leading;
    }

    // Every remaining household measure is a count of something the
    // description names — "1 apple, medium", "1 patty", "roast (yield from
    // 714 g raw meat)" — so it belongs to the count family, and the noun
    // stays in the description where the user reads it.
    return 'each';
};

/**
 * Confirms a resolved mass unit against the source's own gram weight, and
 * rejects the portion outright when the two cannot both be true.
 *
 * A mass measure's weight IS its amount: "3 oz" weighs 3 oz and "45 g" weighs
 * 45 g. So when a mass unit disagrees with the gram weight the source states
 * for the same portion, the label is not measuring this food in this state.
 * USDA's yield portions are the case that matters: "1 oz, raw (yield after
 * cooking)" carries `gramWeight: 9`, because an ounce of the RAW food yields
 * 9 g cooked. For the cooked food the row is neither an ounce (1 oz is not
 * 9 g) nor a count of anything, so it is not a household measure at all, and
 * `null` drops it. The food keeps its 100 g basis portion, which is the
 * source's own statement and needs no household measure to be true.
 *
 * Dropping is the only honest outcome: naming it `each` would assert a count
 * the label never made, and keeping `oz` would assert a weight the source
 * contradicts. Volume carries no comparable identity — a cup of flour is
 * 120 g and a cup of water 237 g — so only mass can be checked this way, and
 * only mass is.
 */
export const reconcileMassUnit = (
    amount: number,
    unit: string,
    gramWeight: number | null | undefined,
): string | null => {
    if (unitFamily(unit) !== 'mass' || typeof gramWeight !== 'number' || gramWeight <= 0) {
        return unit;
    }

    const statedGrams = toBaseQuantity(amount, unit).amount;
    const tolerance = Math.max(MASS_IDENTITY_TOLERANCE_G, gramWeight * MASS_IDENTITY_TOLERANCE_RATIO);

    return Math.abs(statedGrams - gramWeight) <= tolerance ? unit : null;
};

/**
 * Resolves the portions of one record, household measures first and the
 * source's own 100 g basis always.
 *
 * The basis row is not an invented weight: a per-100 g record states its
 * nutrition for 100 g, so a 100 g portion is that statement restated. It is
 * what lets a Foundation record carrying no `foodPortions` publish without
 * anyone fabricating a household measure, and a household portion always wins
 * the default when the record states one.
 */
export const resolvePortions = (
    detail: UsdaFoodDetail,
    dataType: string,
    policy: UsdaSweepPortionPolicy,
    selector?: UsdaDefaultPortionSelector,
): CatalogFoodPortionCandidate[] => {
    const sourcePortions = (detail.foodPortions ?? [])
        .map((portion, index) => ({ portion, index }))
        .filter(({ portion }) => typeof portion.gramWeight === 'number' && portion.gramWeight > 0)
        .sort((left, right) => {
            const sequence =
                Number(left.portion.sequenceNumber ?? Number.MAX_SAFE_INTEGER) -
                Number(right.portion.sequenceNumber ?? Number.MAX_SAFE_INTEGER);
            if (Number.isFinite(sequence) && sequence !== 0) {
                return sequence;
            }
            const byWeight = Number(left.portion.gramWeight) - Number(right.portion.gramWeight);
            return byWeight !== 0 ? byWeight : left.index - right.index;
        });

    const household: CatalogFoodPortionCandidate[] = [];
    const seenDescriptions = new Set<string>();

    if (selector !== undefined) {
        const matched = matchSelectorPortion(sourcePortions.map(({ portion }) => portion), dataType, selector);
        if (matched !== null) {
            const label = parsePortionLabel(matched, dataType, selector);
            if (label !== null) {
                seenDescriptions.add(label.description.toLowerCase());
                household.push({
                    description: label.description,
                    amount: label.amount,
                    unit: label.unit,
                    gram_weight: Number(matched.gramWeight),
                    is_default: true,
                    source: 'usda_food_portion',
                });
            }
        }
    }

    if (household.length === 0) {
        for (const { portion } of sourcePortions) {
            if (household.length >= MAX_HOUSEHOLD_PORTIONS) {
                break;
            }
            const label = parsePortionLabel(portion, dataType);
            if (label === null) {
                continue;
            }
            const key = label.description.toLowerCase();
            if (seenDescriptions.has(key)) {
                continue;
            }
            seenDescriptions.add(key);
            household.push({
                description: label.description,
                amount: label.amount,
                unit: label.unit,
                gram_weight: Number(portion.gramWeight),
                is_default: household.length === 0,
                source: 'usda_food_portion',
            });
        }
    }

    const basis = policy.basisPortion;
    if (!seenDescriptions.has(basis.description.toLowerCase())) {
        household.push({
            description: basis.description,
            amount: basis.amount,
            unit: basis.unit,
            gram_weight: basis.gramWeight,
            is_default: household.length === 0,
            source: basis.source,
        });
    }

    return household;
};

/** At most three household measures: enough to display, short of a catalogue. */
const MAX_HOUSEHOLD_PORTIONS = 3;

/**
 * The manifest's `portionResolution.matching` rule: amount must equal the
 * selector's, label equality is preferred over containment, and the lowest
 * gram weight breaks a remaining tie so resolution is deterministic.
 */
export const matchSelectorPortion = (
    portions: readonly UsdaFoodPortion[],
    dataType: string,
    selector: UsdaDefaultPortionSelector,
): UsdaFoodPortion | null => {
    const wanted = (selector.modifier ?? selector.portionDescription ?? selector.description ?? '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');
    const wantedAmount = typeof selector.amount === 'number' ? selector.amount : null;

    const eligible = portions.filter((portion) => {
        if (typeof portion.gramWeight !== 'number' || portion.gramWeight <= 0) {
            return false;
        }
        if (wantedAmount === null) {
            return true;
        }
        // FNDDS keeps the amount inside the label, so its own `amount` field is
        // not comparable and the label carries the check instead.
        if (dataType === 'Survey (FNDDS)') {
            return true;
        }
        return typeof portion.amount === 'number' && Math.abs(portion.amount - wantedAmount) < 1e-9;
    });

    const labelOf = (portion: UsdaFoodPortion): string =>
        (dataType === 'Survey (FNDDS)'
            ? (portion.portionDescription ?? '')
            : dataType === 'Foundation'
              ? [portion.measureUnit?.name, portion.portionDescription]
                    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
                    .join(', ')
              : (portion.modifier ?? '')
        )
            .trim()
            .toLowerCase()
            .replace(/\s+/g, ' ');

    const byWeight = (left: UsdaFoodPortion, right: UsdaFoodPortion): number =>
        Number(left.gramWeight) - Number(right.gramWeight);

    const exact = eligible.filter((portion) => labelOf(portion) === wanted).sort(byWeight);
    if (exact.length > 0) {
        return exact[0];
    }

    if (wanted.length > 0) {
        const contained = eligible.filter((portion) => labelOf(portion).indexOf(wanted) >= 0).sort(byWeight);
        if (contained.length > 0) {
            return contained[0];
        }
        const containing = eligible.filter((portion) => wanted.indexOf(labelOf(portion)) >= 0 && labelOf(portion).length > 0).sort(byWeight);
        if (containing.length > 0) {
            return containing[0];
        }

        // The selector NAMES a measure and no source label matches it, so there
        // is no portion here that the selector describes. Returning the
        // lowest-weight eligible portion instead would hand `parsePortionLabel`
        // an unrelated row to relabel: a source "1 slice / 30 g" would be
        // published as the selector's "1 cup / 30 g", a conversion no source
        // states and the same contradiction between measure and weight that
        // this importer exists to prevent. The record's own portions are
        // resolved on their own labels instead, and the unresolved selector is
        // recorded on the validation record for review.
        return null;
    }

    // The selector names nothing to match against — it carries an amount only —
    // so the lowest-weight eligible portion contradicts no claim.
    return eligible.length > 0 ? eligible.slice().sort(byWeight)[0] : null;
};

// ---------------------------------------------------------------------------
// Building one catalog row from one USDA record.
// ---------------------------------------------------------------------------

/** Everything one record contributes, assembled before anything is written. */
export interface PreparedCatalogFood {
    readonly sourceKey: string;
    readonly fdcId: number;
    readonly candidate: CatalogFoodCandidate;
    readonly aliases: readonly string[];
    readonly portions: readonly CatalogFoodPortionCandidate[];
    readonly row: {
        readonly canonical_name: string;
        readonly display_name: string;
        readonly category: string;
        readonly food_state: string;
        readonly identity_status: string;
        readonly usda_data_type: string;
        readonly usda_description: string;
        readonly source_version: string;
        readonly source_cache_key: string;
        readonly food_group: string;
        readonly is_common_dislike: boolean;
        readonly cost_class: number;
        readonly search_text: string;
        readonly diet_tags: readonly string[];
    };
    /** Why this record's numbers are what they are, for the validation record. */
    readonly assumptions: readonly string[];
    /**
     * True when the description matched no classification rule, so the food
     * took the manifest's fallback category and food group. Its identity is
     * sound — USDA states it — but its category is a placeholder, and
     * publishing it would file it in the wrong grocery aisle and leave it
     * invisible to the dislike exclusions, which work through `food_group`.
     * Recorded on the validation record so validation holds it as a candidate
     * however many times it is re-judged.
     */
    readonly curatorReviewRequired: boolean;
    /**
     * The sentence `catalog_validation_records.nutrition_method` carries, which
     * has to agree with {@link assumptions}: a record whose assumptions say
     * energy was derived cannot have a method that says nothing was derived.
     * Derived here, next to the derivation, rather than written as a fixed
     * string by the caller — the two drifted apart exactly once that way.
     */
    readonly nutritionMethod: string;
    /**
     * How this record was actually obtained, for
     * `catalog_validation_records.identity_evidence`. USDA records are their
     * own identity evidence (Agent Action Plan §0.7.3), so this is a retrieval
     * record for the vendor request rather than for a fetched web page — which
     * is why it names the request it describes instead of borrowing
     * `evidence.service.ts`'s web-page shape.
     *
     * Every field states something observed. `url` and `method` are the
     * endpoint the client really calls (the batch `POST /foods`, never a
     * per-food `GET /food/{id}` — nothing in this pipeline makes one), and
     * `source_cache_key` is the key that response is recorded under in
     * `usda_api_cache`, so a reader can look the payload up and recompute
     * `body_sha256` from it. `http_status` is `null` when
     * `retrieval_source` is `usda_api_cache`, because in that case this run
     * read a recorded response and made no HTTP exchange at all; it is 200
     * only when this run's own request returned the records, which
     * `fetchFromUsda` only does on a 2xx.
     */
    readonly evidence: {
        readonly url: string;
        readonly method: string;
        readonly request_body: { readonly fdcIds: readonly number[]; readonly format: string };
        readonly final_host: string;
        readonly http_status: number | null;
        readonly source_cache_key: string;
        readonly retrieval_source: UsdaRetrievalSource;
        readonly body_sha256: string | null;
        readonly body_sha256_subject: string;
        readonly record_sha256: string;
        readonly record_sha256_subject: string;
        readonly matched_snippet: string;
        readonly fetched_at: string;
        readonly fetched_at_source: string;
    };
    readonly curated: boolean;
}

/** Where a record came from: a reviewed entry, or a dataset sweep. */
export type ImportAssignment =
    | { readonly kind: 'curated'; readonly entry: UsdaManifestFood }
    | {
          readonly kind: 'sweep';
          readonly sweepKey: string;
          readonly category: CoverageCategory;
          readonly foodGroup: string;
          readonly classified: boolean;
      };

const USDA_API_HOST = 'api.nal.usda.gov';

/**
 * The one endpoint this stage reads detail records from. `usda.service.ts`
 * exposes a single-record `getFoodDetail` as well, but this pipeline never
 * calls it: twenty ids per request is what keeps a 13,000-food sweep inside the
 * vendor's hourly cap, so every record here arrives in a batch response and the
 * evidence record must say so.
 */
export const USDA_BATCH_PATH = '/foods';
export const USDA_BATCH_ENDPOINT = `https://${USDA_API_HOST}/fdc/v1${USDA_BATCH_PATH}`;
/** The `format` the client sends; part of the cached request body, so part of the key. */
export const USDA_BATCH_FORMAT = 'full';

/**
 * Where a batch response came from on this run.
 *
 * `usda_api_cache` means the response was already on record when this run
 * looked, so the run read it and issued no request — and the recorded
 * `fetched_at` is the vendor retrieval time, which is the honest answer to
 * "when was this obtained from USDA". `import_run` means it was not on record,
 * so the only retrieval time this run can state is its own clock.
 */
export type UsdaRetrievalSource = 'usda_api_cache' | 'import_run';

/**
 * The observed facts about one batch request, produced by the client that makes
 * it (see {@link ImportUsdaClient.describeBatchRetrieval}) rather than inferred
 * here, because only the client knows how it reaches the vendor and what its
 * cache recorded.
 */
export interface UsdaBatchRetrieval {
    /** The ids that addressed the response, normalised the way the cache key is. */
    readonly requestedFdcIds: readonly number[];
    /** `usda_api_cache.cache_key` for this request — the row that holds the payload. */
    readonly cacheKey: string;
    /**
     * sha256 of the canonical JSON of the whole recorded response payload, or
     * `null` when nothing was recorded under {@link cacheKey} for this run to
     * digest. Null rather than an empty string: there is no digest, and a
     * fixed-shape placeholder in a hash field reads as one.
     */
    readonly responseSha256: string | null;
    readonly source: UsdaRetrievalSource;
    /** `usda_api_cache.fetched_at`; `null` when the response was not on record. */
    readonly cachedAt: Date | null;
}

/**
 * Key-sorted JSON, so a digest of a vendor record does not depend on the order
 * the payload's keys happened to arrive in. `undefined` cannot appear in parsed
 * JSON, so it needs no case.
 */
export const canonicalJsonString = (value: unknown): string => {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value ?? null);
    }
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJsonString).join(',')}]`;
    }
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
    );
    return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJsonString(nested)}`).join(',')}}`;
};

export const sha256Hex = (text: string): string => crypto.createHash('sha256').update(text).digest('hex');

/**
 * Assembles one candidate from one USDA detail record.
 *
 * Nutrition is read per 100 g, which is what every generic USDA data type
 * states. A record that states macros but no energy takes the manifest's
 * documented Atwater derivation, and the derivation is recorded as an
 * assumption on the food's validation record rather than applied silently —
 * "nutrition_method" and "nutrition_assumptions" exist so a reader can tell a
 * stated value from a derived one.
 */
export const prepareCatalogFood = (
    detail: UsdaFoodDetail,
    assignment: ImportAssignment,
    manifest: UsdaManifest,
    fetchedAt: Date,
    retrieval: UsdaBatchRetrieval,
): PreparedCatalogFood => {
    const description = (detail.description ?? '').trim();
    const dataType = (detail.dataType ?? (assignment.kind === 'curated' ? assignment.entry.usdaDataType : '')).trim();
    const nutrients = detail.foodNutrients;

    const protein = readNutrientAmount(nutrients, manifest.nutrientNumbers.protein);
    const carbs = readNutrientAmount(nutrients, manifest.nutrientNumbers.carbs);
    const fat = readNutrientAmount(nutrients, manifest.nutrientNumbers.fat);
    const fiber = readNutrientAmount(nutrients, FIBER_NUTRIENT_NUMBER);
    const statedCalories = readNutrientAmount(nutrients, manifest.nutrientNumbers.calories);

    const assumptions: string[] = [];
    let calories = statedCalories;
    let caloriesDerived = false;
    if (calories === null && protein !== null && carbs !== null && fat !== null) {
        calories = Math.round((4 * protein + 4 * carbs + 9 * fat) * 100) / 100;
        caloriesDerived = true;
        assumptions.push(
            `calories derived from the manifest's documented fallback (${manifest.caloriesFallback}); the source stated no energy value`,
        );
    }

    const curated = assignment.kind === 'curated';
    const category = curated ? assignment.entry.category : assignment.category;
    const foodGroup = curated ? assignment.entry.foodGroup : assignment.foodGroup;

    const foodState = curated
        ? assignment.entry.foodState
        : resolveFoodState(description, dataType, manifest.sweepFoodStateRules);

    const canonicalName = curated ? assignment.entry.canonicalName : description.toLowerCase().replace(/\s+/g, ' ');
    const displayName = curated ? assignment.entry.displayName : description;

    const aliases = curated
        ? dedupeSortedAliases(assignment.entry.aliases, canonicalName)
        : dedupeSortedAliases(deriveSweepAliases(description, canonicalName), canonicalName);

    const portions = resolvePortions(
        detail,
        dataType,
        manifest.sweepPortionPolicy,
        curated ? assignment.entry.defaultPortion : undefined,
    );

    if (curated && !portions.some((portion) => portion.source === 'usda_food_portion')) {
        assumptions.push(
            `the reviewed portion selector "${assignment.entry.defaultPortion.description}" resolved to no gram weight on the live record; the food carries the source's 100 g basis instead and its household measure needs re-verification`,
        );
    } else if (
        curated &&
        !portions.some(
            (portion) =>
                portion.source === 'usda_food_portion' &&
                portion.description === assignment.entry.defaultPortion.description,
        )
    ) {
        // The selector named a measure the live record does not carry, so the
        // default portion below is the record's own, resolved on its own label.
        // Said plainly because the reviewed household measure is the thing a
        // curator would want to re-check, and silence here would read as if the
        // selector had been honoured.
        assumptions.push(
            `no portion on the live record matches the reviewed selector "${assignment.entry.defaultPortion.description}", so the default portion is the record's own measure rather than the reviewed one; the selector needs re-verification against the current record`,
        );
    }

    // A curated food's safety metadata comes from its reviewed determination
    // and from nowhere else — never from derivation, and never from an empty
    // set standing in for one. An empty `allergenTags` list is the positive
    // claim "reviewed, and this food contains none of the nine", so writing it
    // beside `allergen_status: 'known'` on a food whose allergens were never
    // reviewed is how wheat flour, egg, peanut butter, shrimp and salmon would
    // come to look safe to an allergic user, and the planner's hard exclusion
    // reads exactly these two columns.
    const reviewed = curated ? assignment.entry.reviewedSafety : undefined;
    const reviewedStatus = reviewed?.allergenStatus === 'known' ? 'known' : 'unknown';
    // A reviewed entry's tags are carried whatever its status, because the two
    // columns say different things: `allergen_tags` is what the food is known
    // to contain, and `allergen_status` is whether that list is complete. A
    // reviewed entry recorded as "unknown" with `wheat` on it means "contains
    // wheat, and we are not certain nothing else is in it" — dropping the
    // wheat would throw away a reviewed fact, and promoting the status would
    // claim a completeness nobody established. Only the status gates planning
    // (Agent Action Plan §0.7.3), so carrying the tags is safe in both
    // directions: the food stays out of every plan, and a user reading it in
    // Add Food still sees the allergen that is known to be there.
    const reviewedTags = reviewed === undefined ? null : [...reviewed.allergenTags];
    const safety = curated
        ? {
              allergenTags: reviewedTags ?? [],
              dietTags: [...(reviewed?.dietTags ?? [])],
              compositeMarkers: [] as string[],
          }
        : deriveSafetyTags(description, category, foodGroup, manifest.sweepAllergenDietRules);

    if (curated) {
        const tagText = safety.allergenTags.length > 0 ? safety.allergenTags.join(', ') : 'none of the nine';
        if (reviewedTags === null) {
            assumptions.push(
                'no reviewed allergen determination is recorded for this entry, so allergen_status is "unknown" and no allergen or diet tag is asserted; the food is searchable but never planned as an ingredient',
            );
        } else if (reviewedStatus === 'known') {
            assumptions.push(
                `allergen and diet tags are the reviewed determination recorded for this entry in the manifest (allergens: ${tagText}); allergen_status is "known", so the food may be planned as an ingredient`,
            );
        } else {
            assumptions.push(
                `allergen and diet tags are the reviewed determination recorded for this entry in the manifest (allergens: ${tagText}), but the review did not establish that the list is complete, so allergen_status is "unknown": the tags are a floor and the food is searchable but never planned as an ingredient`,
            );
        }
    }

    if (!curated) {
        assumptions.push(
            'allergen and diet tags were derived from the food group and the description, not reviewed; allergen_status is "unknown" so the food is searchable but never planned as an ingredient',
        );
        if (safety.compositeMarkers.length > 0) {
            assumptions.push(
                `the description names a composite preparation (${safety.compositeMarkers.join(', ')}), so its derived allergen set is a floor rather than a complete set`,
            );
        }
        if (!assignment.classified) {
            assumptions.push(
                'the description matched no classification rule, so the food took the manifest fallback category and is left unpublished pending a curator',
            );
        }
    }

    const expected = curated ? (assignment.entry.expectedUsdaDescription ?? '').trim() : '';
    const identityStatus: CatalogIdentityStatus =
        expected.length > 0 && expected.toLowerCase() !== description.toLowerCase() ? 'ambiguous' : 'verified';
    if (identityStatus === 'ambiguous') {
        assumptions.push(
            `the live description "${description}" differs from the reviewed "${expected}", so identity_status is "ambiguous" and the record is not published`,
        );
    }

    const candidate: CatalogFoodCandidate = {
        source_key: buildSourceKey({ identitySource: 'usda', fdcId: detail.fdcId }),
        canonical_name: canonicalName,
        display_name: displayName,
        aliases,
        category,
        food_state: foodState,
        identity_source: 'usda',
        identity_status: identityStatus,
        nutrition_provenance: 'source_backed',
        allergen_status: curated ? reviewedStatus : 'unknown',
        allergen_tags: safety.allergenTags,
        nutrition_basis: 'per_100g',
        basis_amount: 100,
        calories,
        protein_g: protein,
        carbs_g: carbs,
        fat_g: fat,
        fiber_g: fiber,
        density_g_per_ml: null,
        portions,
    };

    return {
        sourceKey: candidate.source_key as string,
        fdcId: detail.fdcId,
        candidate,
        aliases,
        portions,
        row: {
            canonical_name: canonicalName,
            display_name: displayName,
            category,
            food_state: foodState,
            identity_status: identityStatus,
            usda_data_type: dataType,
            usda_description: description,
            source_version: buildSourceVersion(dataType, detail.publicationDate),
            // The key of the batch response this row was read out of, so the
            // payload behind it can be looked up. Shared by the (up to twenty)
            // foods of that batch, which is what it means.
            source_cache_key: retrieval.cacheKey,
            food_group: foodGroup,
            // Only the reviewed entries seed the dislike suggestions: a swept
            // record flagged by its group would crowd the twelve curated chips
            // out of `GET /catalog/foods/suggestions`, and the dislike
            // exclusion itself works through food_group, so nothing is lost.
            is_common_dislike: curated ? assignment.entry.isCommonDislike : false,
            cost_class: curated
                ? assignment.entry.costClass
                : resolveCostClass(category, foodGroup, manifest.sweepCostClassRules),
            search_text: buildSearchText(canonicalName, aliases, foodState, foodGroup),
            diet_tags: safety.dietTags,
        },
        assumptions,
        nutritionMethod: caloriesDerived
            ? `protein, fat, carbohydrate and fibre read per 100 g from the record's own foodNutrients (203 protein, 204 fat, 205 carbohydrate, 291 fibre); the record stated no energy value (208), so energy was derived from those same macros by the manifest's documented fallback (${manifest.caloriesFallback}). No value came from another food.`
            : "every value read per 100 g from the record's own foodNutrients (203 protein, 204 fat, 205 carbohydrate, 208 energy, 291 fibre); nothing was scaled, derived or estimated",
        curatorReviewRequired: !curated && !assignment.classified,
        evidence: {
            url: USDA_BATCH_ENDPOINT,
            method: 'POST',
            request_body: { fdcIds: retrieval.requestedFdcIds, format: USDA_BATCH_FORMAT },
            final_host: USDA_API_HOST,
            http_status: retrieval.source === 'usda_api_cache' ? null : 200,
            source_cache_key: retrieval.cacheKey,
            retrieval_source: retrieval.source,
            body_sha256: retrieval.responseSha256,
            body_sha256_subject:
                retrieval.responseSha256 === null
                    ? `null: no ${USDA_BATCH_PATH} response was recorded in usda_api_cache under source_cache_key when this run read it, so there was nothing to digest`
                    : `sha256 of the key-sorted JSON of the whole ${USDA_BATCH_PATH} response payload recorded in usda_api_cache under source_cache_key`,
            record_sha256: sha256Hex(canonicalJsonString(detail)),
            record_sha256_subject: "sha256 of the key-sorted JSON of this food's own record within that response",
            matched_snippet: description.slice(0, 500),
            fetched_at: (retrieval.cachedAt ?? fetchedAt).toISOString(),
            fetched_at_source:
                retrieval.cachedAt === null
                    ? 'import run clock: the response was not on record in usda_api_cache when this run read it, so no vendor retrieval time is available'
                    : 'usda_api_cache.fetched_at: the time the response was retrieved from USDA',
        },
        curated,
    };
};

/** Lower-case, de-duplicated, sorted, and never the canonical name itself. */
export const dedupeSortedAliases = (aliases: readonly string[], canonicalName: string): string[] => {
    const normalizedCanonical = normalizeCanonicalName(canonicalName);
    const seen = new Set<string>();
    const kept: string[] = [];

    for (const alias of aliases) {
        const trimmed = alias.trim().toLowerCase().replace(/\s+/g, ' ');
        if (trimmed.length === 0 || seen.has(trimmed) || normalizeCanonicalName(trimmed) === normalizedCanonical) {
            continue;
        }
        seen.add(trimmed);
        kept.push(trimmed);
    }

    return kept.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
};

// ---------------------------------------------------------------------------
// Persistence.
// ---------------------------------------------------------------------------

/**
 * The narrow slice of the Prisma client this stage writes through. Declared
 * structurally so the script-level suite can drive `runImport` against a fake
 * without a database, and so this file never depends on the generated client's
 * shape beyond the four models it touches.
 */
export interface ImportDb {
    catalog_foods: {
        /**
         * The stored row carries `id` and `imported_at` for the write itself
         * and {@link StoredVersionedFacts} for the version decision, as one
         * intersection rather than a second hand-maintained field list: a fact
         * the comparison reads and the read does not return would be invisible
         * to it, and that is the failure this shape rules out.
         */
        findUnique(
            args: unknown,
        ): Promise<({ id: string; imported_at: Date | null } & StoredVersionedFacts) | null>;
        create(args: unknown): Promise<{ id: string }>;
        update(args: unknown): Promise<{ id: string }>;
    };
    catalog_food_aliases: {
        deleteMany(args: unknown): Promise<{ count: number }>;
        createMany(args: unknown): Promise<{ count: number }>;
    };
    catalog_food_portions: {
        deleteMany(args: unknown): Promise<{ count: number }>;
        createMany(args: unknown): Promise<{ count: number }>;
    };
    catalog_validation_records: {
        upsert(args: unknown): Promise<{ id: string }>;
    };
    $transaction<T>(work: (tx: ImportDb) => Promise<T>, options?: { timeout?: number }): Promise<T>;
}

/** What persisting one record did, so the report counts real outcomes. */
export type PersistOutcome = 'inserted' | 'updated';

/**
 * Everything the two version counters on `catalog_foods` answer for, plus the
 * counters themselves.
 *
 * Every field is optional and nullable on purpose. The columns Prisma reads
 * back are nullable where prisma/schema.prisma says so — the five nutrients
 * and `density_g_per_ml` are `DOUBLE PRECISION NULL`, where NULL means unknown
 * and never zero — and a field the caller has no value for arrives as
 * `undefined`. {@link nextCatalogFoodVersions} normalises the two into one
 * "no value" so neither reads as a change against the other.
 */
export interface StoredVersionedFacts {
    /**
     * The counters as stored. Read from the existing row only — the incoming
     * facts do not carry a version, because what the next version IS is this
     * module's decision rather than the vendor payload's.
     */
    nutrition_version?: number | null;
    metadata_version?: number | null;

    // THE NUTRITION SET: the five values `recipe_ingredients.snapshot_per_100g`
    // freezes, the three that fix what "per 100" means (a per_100ml basis, a
    // basis amount of 50 or a density each change what the same five numbers
    // describe), the provenance `snapshot_provenance` freezes, and the vendor
    // facts the numbers were read from — a different fdc id, data type or
    // publication month means a different source record produced them, which a
    // recipe holding the old snapshot has to be told about.
    calories?: number | null;
    protein_g?: number | null;
    carbs_g?: number | null;
    fat_g?: number | null;
    fiber_g?: number | null;
    nutrition_basis?: string | null;
    basis_amount?: number | null;
    density_g_per_ml?: number | null;
    nutrition_provenance?: string | null;
    usda_fdc_id?: number | null;
    usda_data_type?: string | null;
    source_version?: string | null;

    // THE METADATA SET: identity and safety. `snapshot_name` freezes the name a
    // recipe displays, `snapshot_allergen_tags` and `snapshot_diet_tags` freeze
    // what it may claim, and `food_group` is what a user's dislike selection
    // excludes by. `allergen_status` is here because 'known' → 'unknown' is a
    // change of safety standing even when the tag list is untouched.
    canonical_name?: string | null;
    display_name?: string | null;
    food_group?: string | null;
    allergen_status?: string | null;
    allergen_tags?: readonly string[] | null;
    diet_tags?: readonly string[] | null;
}

// TWO FIELDS THIS STAGE WRITES ARE DELIBERATELY IN NEITHER SET, because the
// next reader's first instinct is to add them and a spurious bump is not free:
// it makes every recipe using the food stale, and `recipes-seed.ts` answers a
// stale ingredient by publishing a NEW recipe version and retiring the old one.
//   * source_cache_key is retrieval bookkeeping — the key of the batch response
//     this row was read out of. Re-fetching the same food in a differently
//     composed batch changes it while changing no snapshot value and no
//     provenance, so bumping on it would version the catalog by how the import
//     happened to group its requests.
//   * category is read by no snapshot column. It drives the grocery aisle,
//     which is derived live from the current row at list time, so a
//     recategorised food is already reported correctly without a new version.
// Both remain fully written by the upsert below; they are simply not evidence
// that a frozen snapshot has stopped describing this food.

/** The two counters to write, and which set moved to get them there. */
export interface CatalogFoodVersions {
    readonly nutritionVersion: number;
    readonly metadataVersion: number;
    /** False on an insert: a new row's counters start at 1, they do not move. */
    readonly nutritionChanged: boolean;
    readonly metadataChanged: boolean;
}

/**
 * The Prisma `select` the version decision needs, typed as a total record over
 * {@link StoredVersionedFacts} so that adding a field to a comparison set
 * without selecting it is a compile error. Left unselected it would arrive as
 * `undefined` on every read and bump the counter on every rerun.
 */
const VERSIONED_FACT_SELECT: Record<keyof StoredVersionedFacts, true> = {
    nutrition_version: true,
    metadata_version: true,
    calories: true,
    protein_g: true,
    carbs_g: true,
    fat_g: true,
    fiber_g: true,
    nutrition_basis: true,
    basis_amount: true,
    density_g_per_ml: true,
    nutrition_provenance: true,
    usda_fdc_id: true,
    usda_data_type: true,
    source_version: true,
    canonical_name: true,
    display_name: true,
    food_group: true,
    allergen_status: true,
    allergen_tags: true,
    diet_tags: true,
};

/**
 * Order-insensitive set comparison for the two tag arrays: a food whose diet
 * tags came back in a different order has not changed, and versioning it would
 * be versioning the vendor's array ordering.
 */
const sameStringSet = (
    left: readonly string[] | null | undefined,
    right: readonly string[] | null | undefined,
): boolean => {
    const a = [...(left ?? [])].sort();
    const b = [...(right ?? [])].sort();
    return a.length === b.length && a.every((value, index) => value === b[index]);
};

/**
 * One fact compared, with absent and NULL treated as the same "no value".
 *
 * Strict equality is the right test for the numbers here: they are read per
 * 100 g out of the same vendor payload by the same deterministic code, so a
 * rerun that changes nothing produces bit-identical doubles, and a tolerance
 * would only hide a real vendor revision. What DOES need normalising is
 * `undefined` vs `null` — `fiber_g` is written as `?? null` and a fact the
 * caller omits arrives as `undefined` — which without this would read as a
 * change on every single rerun.
 */
const sameFact = (
    left: string | number | null | undefined,
    right: string | number | null | undefined,
): boolean => (left ?? null) === (right ?? null);

/**
 * Both version counters for the row about to be written.
 *
 * WHY THIS EXISTS AT ALL. `recipe_ingredients` freezes `snapshot_per_100g`,
 * `snapshot_name`, `snapshot_provenance`, `snapshot_allergen_tags` and
 * `snapshot_diet_tags` beside the two counters they were taken at, and
 * `src/services/recipe.logic.ts::isIngredientSnapshotStale` detects a stale
 * snapshot by comparing BOTH counters for INEQUALITY — nothing compares the
 * values themselves. A counter that is reset to 1, or that fails to move when
 * its facts did, therefore means a published recipe goes on claiming nutrition
 * or safety metadata the catalog no longer states: with the allergen set that
 * is a safety bug, not a cosmetic one (AAP §0.5.1, §0.7.3, and the counter
 * contract "nutrition_version bumped on any nutrient change, metadata_version
 * bumped on any allergen/diet/name/food-group change").
 *
 * Each counter answers for its own set and only its own: a renamed food does
 * not reversion its nutrition, and a changed nutrient does not reversion its
 * safety metadata, because either spurious bump forces a needless new recipe
 * version across every recipe using the food. An unchanged set PRESERVES the
 * stored counter rather than recomputing it, which is what keeps a no-op rerun
 * byte-identical and an exported release stable.
 *
 * `next` may carry more than the compared facts — the caller passes the whole
 * scalar set it is about to write — and everything outside the two sets above
 * is ignored.
 *
 * @param existing the stored row, or `null` when this `source_key` is new
 * @param next the facts about to be written
 *
 * @example
 * // A rerun that changed nothing keeps both counters where they were.
 * nextCatalogFoodVersions({ nutrition_version: 3, metadata_version: 2, calories: 165 }, { calories: 165 });
 * // → { nutritionVersion: 3, metadataVersion: 2, nutritionChanged: false, metadataChanged: false }
 */
export const nextCatalogFoodVersions = (
    existing: StoredVersionedFacts | null,
    next: StoredVersionedFacts,
): CatalogFoodVersions => {
    // A new row is at version 1 on both counters. There is no stored snapshot
    // of it anywhere yet, so nothing has moved and nothing can be stale.
    if (existing === null) {
        return { nutritionVersion: 1, metadataVersion: 1, nutritionChanged: false, metadataChanged: false };
    }

    const nutritionChanged =
        !sameFact(existing.calories, next.calories) ||
        !sameFact(existing.protein_g, next.protein_g) ||
        !sameFact(existing.carbs_g, next.carbs_g) ||
        !sameFact(existing.fat_g, next.fat_g) ||
        !sameFact(existing.fiber_g, next.fiber_g) ||
        !sameFact(existing.nutrition_basis, next.nutrition_basis) ||
        !sameFact(existing.basis_amount, next.basis_amount) ||
        !sameFact(existing.density_g_per_ml, next.density_g_per_ml) ||
        !sameFact(existing.nutrition_provenance, next.nutrition_provenance) ||
        !sameFact(existing.usda_fdc_id, next.usda_fdc_id) ||
        !sameFact(existing.usda_data_type, next.usda_data_type) ||
        !sameFact(existing.source_version, next.source_version);

    const metadataChanged =
        !sameFact(existing.canonical_name, next.canonical_name) ||
        !sameFact(existing.display_name, next.display_name) ||
        !sameFact(existing.food_group, next.food_group) ||
        !sameFact(existing.allergen_status, next.allergen_status) ||
        !sameStringSet(existing.allergen_tags, next.allergen_tags) ||
        !sameStringSet(existing.diet_tags, next.diet_tags);

    // A stored counter this stage never wrote (a hand-loaded row, a release
    // predating the column) is read as 1 rather than as "no version": the
    // column is NOT NULL in the schema, and treating a missing counter as 0
    // would silently renumber a snapshot that already cites 1.
    return {
        nutritionVersion: (existing.nutrition_version ?? 1) + (nutritionChanged ? 1 : 0),
        metadataVersion: (existing.metadata_version ?? 1) + (metadataChanged ? 1 : 0),
        nutritionChanged,
        metadataChanged,
    };
};

/**
 * Writes one food, its aliases, its portions and its validation record.
 *
 * Aliases and portions are replaced wholesale rather than merged: the source
 * record is the authority on both, so a rerun after a manifest change must
 * converge on what the manifest now says instead of accumulating every alias
 * the food has ever had. `imported_at` is written once on insert and never on
 * update, which is what keeps a rerun's exported release byte-identical.
 */
export const persistPreparedFood = async (
    db: ImportDb,
    prepared: PreparedCatalogFood,
    verdict: CatalogValidationVerdict,
    publicationStatus: string,
    now: Date,
): Promise<PersistOutcome> => {
    const existing = await db.catalog_foods.findUnique({
        where: { source_key: prepared.sourceKey },
        select: {
            id: true,
            imported_at: true,
            ...VERSIONED_FACT_SELECT,
        },
    });

    // Assembled without the two version counters, because the counters are
    // DERIVED from these very values: comparing what this write is about to
    // store — rather than re-reading `prepared` a second time — is what keeps
    // the comparison and the write from ever describing different facts.
    const facts = {
        canonical_name: prepared.row.canonical_name,
        display_name: prepared.row.display_name,
        category: prepared.row.category,
        food_state: prepared.row.food_state,
        identity_source: 'usda',
        identity_status: prepared.row.identity_status,
        nutrition_provenance: 'source_backed',
        nutrition_basis: 'per_100g',
        basis_amount: 100,
        calories: prepared.candidate.calories,
        protein_g: prepared.candidate.protein_g,
        carbs_g: prepared.candidate.carbs_g,
        fat_g: prepared.candidate.fat_g,
        fiber_g: prepared.candidate.fiber_g ?? null,
        density_g_per_ml: null,
        usda_fdc_id: prepared.fdcId,
        usda_data_type: prepared.row.usda_data_type,
        usda_description: prepared.row.usda_description,
        source_version: prepared.row.source_version,
        source_cache_key: prepared.row.source_cache_key,
        publication_status: publicationStatus,
        allergen_tags: prepared.candidate.allergen_tags ?? [],
        allergen_status: prepared.candidate.allergen_status,
        diet_tags: prepared.row.diet_tags,
        food_group: prepared.row.food_group,
        is_common_dislike: prepared.row.is_common_dislike,
        cost_class: prepared.row.cost_class,
        search_text: prepared.row.search_text,
        updated_at: now,
    };

    const versions = nextCatalogFoodVersions(existing, facts);
    const scalars = {
        ...facts,
        nutrition_version: versions.nutritionVersion,
        metadata_version: versions.metadataVersion,
    };

    const foodId =
        existing === null
            ? (await db.catalog_foods.create({ data: { ...scalars, source_key: prepared.sourceKey, imported_at: now } }))
                  .id
            : (await db.catalog_foods.update({ where: { id: existing.id }, data: scalars })).id;

    await db.catalog_food_aliases.deleteMany({ where: { catalog_food_id: foodId } });
    if (prepared.aliases.length > 0) {
        await db.catalog_food_aliases.createMany({
            data: prepared.aliases.map((alias) => ({ catalog_food_id: foodId, alias })),
            skipDuplicates: true,
        });
    }

    await db.catalog_food_portions.deleteMany({ where: { catalog_food_id: foodId } });
    // gram_weight is NOT NULL, so a portion whose weight the source never
    // stated is not persisted — it stays on the candidate, where the
    // `missing_gram_weight` check can see it, rather than being written as a
    // zero that would read as a fact.
    const storablePortions = prepared.portions.filter(
        (portion) => typeof portion.gram_weight === 'number' && portion.gram_weight > 0,
    );
    if (storablePortions.length > 0) {
        await db.catalog_food_portions.createMany({
            data: storablePortions.map((portion) => ({
                catalog_food_id: foodId,
                description: portion.description,
                amount: portion.amount,
                unit: portion.unit,
                gram_weight: portion.gram_weight as number,
                is_default: portion.is_default,
                source: portion.source ?? 'usda_food_portion',
            })),
            skipDuplicates: true,
        });
    }

    const record = buildValidationRecordData(prepared, verdict, publicationStatus, now);
    await db.catalog_validation_records.upsert({
        where: { catalog_food_id: foodId },
        create: { catalog_food_id: foodId, ...record, history: [] },
        update: record,
    });

    return existing === null ? 'inserted' : 'updated';
};

/**
 * The machine-readable validation record AAP 0.1.1 requires for every item:
 * what the food claims to be, how its nutrition was arrived at, what was
 * assumed, which checks ran with their observed values and bounds, and what
 * evidence establishes its identity.
 *
 * `nutrition_assumptions` is a JSON-encoded array in a TEXT column — the
 * column Prisma declares is `String?`, and the release exporter parses it back
 * to the array the release format states.
 */
export const buildValidationRecordData = (
    prepared: PreparedCatalogFood,
    verdict: CatalogValidationVerdict,
    publicationStatus: string,
    now: Date,
): Record<string, unknown> => ({
    canonical_identity: {
        source_key: prepared.sourceKey,
        canonical_name: prepared.row.canonical_name,
        display_name: prepared.row.display_name,
        food_state: prepared.row.food_state,
        category: prepared.row.category,
        food_group: prepared.row.food_group,
        usda_fdc_id: prepared.fdcId,
        usda_data_type: prepared.row.usda_data_type,
        usda_description: prepared.row.usda_description,
        // Read by validation, which holds such a row as a candidate no matter
        // how many times it is re-judged: the checks can see nothing wrong
        // with an unclassified food, because what is missing is a category
        // only a curator can assign.
        curator_review_required: prepared.curatorReviewRequired,
    },
    aliases: prepared.aliases.slice(),
    category: prepared.row.category,
    food_state: prepared.row.food_state,
    identity_source: 'usda',
    identity_status: prepared.row.identity_status,
    nutrition_provenance: 'source_backed',
    // Derived alongside the numbers it describes, so a record whose
    // assumptions state a derivation cannot carry a method that denies one.
    nutrition_method: prepared.nutritionMethod,
    nutrition_assumptions: JSON.stringify(prepared.assumptions),
    portion_units: prepared.portions.map((portion) => ({
        description: portion.description,
        amount: portion.amount,
        unit: portion.unit,
        gram_weight: portion.gram_weight,
        is_default: portion.is_default,
        source: portion.source ?? 'usda_food_portion',
    })),
    identity_evidence: [prepared.evidence],
    checks: verdict.checks,
    // Null on purpose, and meaningfully so: no model was consulted about this
    // food. A model name here would imply a review that never happened.
    llm_review: null,
    outcome: prepared.curatorReviewRequired ? 'quarantined' : verdict.outcome,
    reviewed_at: now,
    publication_status: publicationStatus,
    source_versions: {
        usda_data_type: prepared.row.usda_data_type,
        source_version: prepared.row.source_version,
        usda_manifest_version: 'v1',
        coverage_plan_version: 'v1',
    },
});

// ---------------------------------------------------------------------------
// The work plan.
// ---------------------------------------------------------------------------

/** One detail fetch: up to `detailBatchSize` ids that share an assignment kind. */
export interface ImportBatch {
    readonly index: number;
    readonly source: 'curated' | string;
    readonly fdcIds: readonly number[];
}

export interface ImportPlan {
    readonly batches: readonly ImportBatch[];
    /** Assignments keyed by FDC id, so a batch's records are mapped without a lookup table per batch. */
    readonly assignments: ReadonlyMap<number, ImportAssignment>;
    /** Identifies the plan, so a resume into a changed plan is refused rather than silently misaligned. */
    readonly fingerprint: string;
    readonly skipped: Readonly<Record<string, number>>;
}

const chunk = <T>(items: readonly T[], size: number): T[][] => {
    const out: T[][] = [];
    for (let index = 0; index < items.length; index += size) {
        out.push(items.slice(index, index + size));
    }
    return out;
};

/**
 * Builds the whole fetch plan before any detail request, from the curated
 * entries and then the dataset sweeps, in the manifest's declared order.
 *
 * The list pass is what makes the plan deterministic: the sweeps' ids, their
 * classification and the brand screen are all decided here, so the batch
 * membership a rerun produces is identical — which is also what makes the
 * `usda_api_cache` entries from an earlier run reusable, since a batch's cache
 * key is derived from its sorted id set.
 */
export const buildImportPlan = async (
    manifest: UsdaManifest,
    listFoodsForDataType: (dataType: string, pageSize: number, pageNumber: number) => Promise<UsdaFoodSummary[]>,
    options: ImportOptions,
    logger: ScriptLogger,
): Promise<ImportPlan> => {
    const assignments = new Map<number, ImportAssignment>();
    const skipped: Record<string, number> = {
        skippedExcludedClass: 0,
        skippedBrandPattern: 0,
        skippedCuratedFdcId: 0,
        skippedCuratedIdentity: 0,
        skippedUnresolvedEntry: 0,
        skippedDuplicateInPlan: 0,
        skippedCategoryFilter: 0,
    };

    const wantedCategories = new Set(options.categories);
    const inScope = (category: string): boolean => wantedCategories.size === 0 || wantedCategories.has(category);

    // `--limit` is documented as "stop after n manifest records", so it is one
    // budget over the whole work list in workListOrder — the curated entries
    // first, then the sweeps — not n per sweep. Applied where a record is
    // accepted, so the planned record count and the batches that get fetched
    // are the same number rather than two.
    const atLimit = (): boolean => options.limit !== null && assignments.size >= options.limit;

    const curatedIds = new Set<number>();
    const curatedIdentities = new Set<string>();
    const curatedFdcIds: number[] = [];

    for (const entry of manifest.foods) {
        if (entry.fdcId === undefined) {
            // `resolveBy` entries name a food without a verified id. Resolving
            // one needs a search call whose answer a human has to confirm, so
            // the import reports it rather than guessing which hit was meant.
            skipped.skippedUnresolvedEntry += 1;
            continue;
        }
        curatedIdentities.add(`${normalizeCanonicalName(entry.canonicalName)}\u0000${entry.foodState}`);
        if (!inScope(entry.category)) {
            skipped.skippedCategoryFilter += 1;
            curatedIds.add(entry.fdcId);
            continue;
        }
        if (curatedIds.has(entry.fdcId)) {
            skipped.skippedDuplicateInPlan += 1;
            continue;
        }
        curatedIds.add(entry.fdcId);
        // Recorded in curatedIds above even when the budget is spent, so the
        // sweeps still dedupe against every curated id rather than re-importing
        // one under a swept identity.
        if (atLimit()) {
            continue;
        }
        curatedFdcIds.push(entry.fdcId);
        assignments.set(entry.fdcId, { kind: 'curated', entry });
    }

    const batches: ImportBatch[] = [];
    const batchSize = Math.max(1, Math.min(manifest.importLimits.detailBatchSize, MAX_BATCH_FDC_IDS));

    for (const ids of chunk(curatedFdcIds, batchSize)) {
        batches.push({ index: batches.length, source: 'curated', fdcIds: ids });
    }

    for (const sweep of manifest.datasetSweeps) {
        const sweepIds: number[] = [];
        const lastPage = Math.min(sweep.maxPages, sweep.observedLastNonEmptyPage ?? sweep.maxPages);

        for (let page = 1; page <= lastPage; page += 1) {
            if (atLimit()) {
                break;
            }
            const rows = await listFoodsForDataType(sweep.dataType, sweep.pageSize, page);
            if (rows.length === 0) {
                break;
            }

            for (const row of rows) {
                if (atLimit()) {
                    break;
                }
                const description = (row.description ?? '').trim();
                if (description.length === 0) {
                    continue;
                }
                if (sweep.skipFdcIdsPresentInFoods !== false && curatedIds.has(row.fdcId)) {
                    skipped.skippedCuratedFdcId += 1;
                    continue;
                }
                if (assignments.has(row.fdcId)) {
                    skipped.skippedDuplicateInPlan += 1;
                    continue;
                }

                const brand = brandExclusionReason(description, manifest.sweepBrandExclusionRules);
                if (brand !== null) {
                    skipped.skippedBrandPattern += 1;
                    continue;
                }

                const classification = classifyDescription(description, manifest.sweepClassificationRules);
                if (classification.excluded) {
                    skipped.skippedExcludedClass += 1;
                    continue;
                }
                if (!inScope(classification.category)) {
                    skipped.skippedCategoryFilter += 1;
                    continue;
                }

                const foodState = resolveFoodState(description, sweep.dataType, manifest.sweepFoodStateRules);
                const identity = `${normalizeCanonicalName(description)}\u0000${foodState}`;
                if (curatedIdentities.has(identity)) {
                    // A curated identity is reviewed and is pinned by name in
                    // the search benchmark. dedupeIdentity's survivor tiebreak
                    // is the lexicographically smaller source key and knows
                    // nothing about curation, so the collision is avoided here
                    // rather than resolved later in the curated row's favour.
                    skipped.skippedCuratedIdentity += 1;
                    continue;
                }

                assignments.set(row.fdcId, {
                    kind: 'sweep',
                    sweepKey: sweep.sweepKey,
                    category: classification.category,
                    foodGroup: classification.foodGroup,
                    classified: classification.matched,
                });
                sweepIds.push(row.fdcId);
            }
        }

        logger.info('sweep_planned', {
            stage: STAGE,
            sweepKey: sweep.sweepKey,
            dataType: sweep.dataType,
            planned: sweepIds.length,
        });

        for (const ids of chunk(sweepIds, batchSize)) {
            batches.push({ index: batches.length, source: sweep.sweepKey, fdcIds: ids });
        }
    }

    const fingerprint = crypto
        .createHash('sha256')
        .update(JSON.stringify(batches.map((batch) => [batch.source, batch.fdcIds])))
        .digest('hex');

    return { batches, assignments, fingerprint, skipped };
};

// ---------------------------------------------------------------------------
// The run.
// ---------------------------------------------------------------------------

/** The checkpoint this stage resumes from. */
export interface ImportCursor {
    /** Identifies the plan the indices belong to. */
    readonly fingerprint: string;
    readonly nextBatchIndex: number;
}

export interface ImportUsdaClient {
    readonly listFoods: (dataType: string, pageSize: number, pageNumber: number) => Promise<UsdaFoodSummary[]>;
    readonly getFoodsBatch: (fdcIds: readonly number[]) => Promise<UsdaFoodDetail[]>;
    /**
     * The retrieval facts for the request `getFoodsBatch` just made, read from
     * the client's own cache rather than assumed here. Called after the fetch,
     * so a response served from `usda_api_cache` reports the vendor retrieval
     * time it was recorded with, and one this run fetched live reports
     * `import_run` if the best-effort cache write has not landed yet — either
     * way the evidence record states which it is instead of presenting the
     * run's clock as a vendor timestamp.
     */
    readonly describeBatchRetrieval: (fdcIds: readonly number[]) => Promise<UsdaBatchRetrieval>;
}

export interface RunImportDeps {
    readonly db: ImportDb;
    readonly runDb: CatalogRunDb;
    readonly usda: ImportUsdaClient;
    readonly manifest: UsdaManifest;
    readonly coveragePlan: CoveragePlan;
    readonly options: ImportOptions;
    readonly logger: ScriptLogger;
    readonly now: () => Date;
    /** Installs the pacing over `fetch` and returns the restore. Seamed so a test runs unpaced. */
    readonly installRateLimiter: () => () => void;
    readonly writeReport: (report: unknown) => void;
}

export interface ImportOutcome {
    /** `null` for a dry run, which deliberately opens no run — see runImport. */
    readonly runId: string | null;
    readonly resumed: boolean;
    readonly counts: Readonly<Record<string, number>>;
    readonly plannedBatches: number;
    readonly processedBatches: number;
}

const CURSOR_SAVE_EVERY_BATCHES = 5;

/**
 * Runs the import: plan, then fetch and persist batch by batch, checkpointing
 * as it goes.
 *
 * The plan is built first and in full, so the run knows how much work it has
 * before it spends a request on any of it, and so a resume can be refused
 * rather than misaligned when the plan has changed underneath it. Records are
 * fetched, mapped and written one batch at a time and never accumulated: a
 * full sweep is ~11,500 detail records, and holding them would cost hundreds
 * of megabytes for no benefit.
 */
/**
 * The checkpoint key this invocation may claim.
 *
 * The canonical full import claims the manifest version itself, and only it
 * ever completes that key. A run narrowed by `--category` or `--limit` covers
 * part of the plan, so it claims a key naming its own restriction: it can still
 * resume and still refuses to redo itself, but it cannot answer for work it
 * never attempted. The suffix is derived from the options so two different
 * restrictions never share a run.
 */
export const importRunScope = (manifestVersion: string, options: ImportOptions): string => {
    const restricted = options.categories.length > 0 || options.limit !== null;
    if (!restricted) {
        return manifestVersion;
    }

    const scope = JSON.stringify({
        categories: [...options.categories].sort(),
        limit: options.limit,
    });

    return `${manifestVersion}+partial:${crypto.createHash('sha256').update(scope).digest('hex').slice(0, 16)}`;
};

/**
 * Reports what a dry run would write, without a run row, a cursor or a
 * completion — see the note at the call site.
 */
const reportDryRun = async (
    deps: RunImportDeps,
    plan: ImportPlan,
    coveragePlan: CoveragePlan,
): Promise<ImportOutcome> => {
    const counts: Record<string, number> = {
        planned: plan.assignments.size,
        inserted: 0,
        updated: 0,
        candidates: 0,
        quarantined: 0,
        rejected: 0,
        missingFromVendor: 0,
        ...plan.skipped,
    };

    deps.logger.info('dry_run_planned', {
        stage: STAGE,
        batches: plan.batches.length,
        records: plan.assignments.size,
        planFingerprint: plan.fingerprint.slice(0, 16),
        note: 'no run row, cursor or completion was written, so the canonical import is unaffected',
    });

    deps.writeReport({
        stage: STAGE,
        generatedAt: deps.now().toISOString(),
        runId: null,
        usdaManifestVersion: deps.manifest.usdaManifestVersion,
        coveragePlanVersion: coveragePlan.coveragePlanVersion,
        planFingerprint: plan.fingerprint,
        options: {
            categories: deps.options.categories,
            limit: deps.options.limit,
            resume: deps.options.resume,
            dryRun: true,
        },
        plannedBatches: plan.batches.length,
        processedBatches: 0,
        counts,
        byCategory: {},
        failedChecks: {},
        note: 'dry run: the plan only. Nothing was fetched, nothing was written, and no run or checkpoint state was touched, so the canonical import still has its work to do.',
    });

    return {
        runId: null,
        resumed: false,
        counts,
        plannedBatches: plan.batches.length,
        processedBatches: 0,
    };
};

export const runImport = async (deps: RunImportDeps): Promise<ImportOutcome> => {
    const { manifest, coveragePlan, logger, options } = deps;

    const policy: CatalogValidationPolicy = {
        categories: coveragePlan.categories,
        validationBounds: coveragePlan.validationBounds,
    };

    const restoreFetch = deps.installRateLimiter();
    try {
        const plan = await buildImportPlan(manifest, deps.usda.listFoods, options, logger);
        logger.info('plan_built', {
            stage: STAGE,
            batches: plan.batches.length,
            records: plan.assignments.size,
            fingerprint: plan.fingerprint.slice(0, 16),
            ...plan.skipped,
        });

        // A DRY RUN TOUCHES NO RUN STATE AT ALL. openOrResumeRun claims
        // (kind, manifestVersion) and finishRun closes it 'succeeded', after
        // which that pair is a permanent no-op — so a dry run that claimed the
        // canonical key would report what it *would* write and thereby stop the
        // real import from ever writing it. Reporting the plan is the whole job
        // here, and it needs no run row.
        if (options.dryRun) {
            const planned = await reportDryRun(deps, plan, coveragePlan);
            return planned;
        }

        // A run restricted by --category or --limit is NOT the canonical import,
        // and must not be able to close the canonical key. Scoping the version
        // string gives each distinct restriction its own resumable run and
        // leaves the full plan's key untouched, so "partial run, then full run"
        // imports everything instead of the partial set only.
        const runScope = importRunScope(manifest.usdaManifestVersion, options);
        const claim = await openOrResumeRun<ImportCursor>(deps.runDb, {
            kind: 'usda_import',
            manifestVersion: runScope,
            initialCursor: { fingerprint: plan.fingerprint, nextBatchIndex: 0 },
            logger,
            now: deps.now,
        });

        if (claim.alreadyCompleted) {
            logger.info('run_already_completed', {
                stage: STAGE,
                runId: claim.run.id,
                counts: JSON.stringify(claim.run.counts ?? {}),
            });
            return {
                runId: claim.run.id,
                resumed: true,
                counts: (claim.run.counts ?? {}) as Record<string, number>,
                plannedBatches: plan.batches.length,
                processedBatches: 0,
            };
        }

        const savedCursor = claim.run.cursor;
        let startIndex = 0;
        if (claim.resumed && savedCursor !== null && typeof savedCursor === 'object') {
            const cursor = savedCursor as Partial<ImportCursor>;
            if (cursor.fingerprint === plan.fingerprint && typeof cursor.nextBatchIndex === 'number') {
                startIndex = Math.max(0, Math.min(cursor.nextBatchIndex, plan.batches.length));
            } else {
                // The work list changed between runs, so the saved index names
                // a different batch than it did. Restarting is the only correct
                // reading of that, and saying so is better than resuming into
                // the wrong place; the upserts make the repeat a no-op.
                logger.warn('cursor_plan_changed', {
                    stage: STAGE,
                    runId: claim.run.id,
                    savedFingerprint: String(cursor.fingerprint ?? '').slice(0, 16),
                    planFingerprint: plan.fingerprint.slice(0, 16),
                });
                await appendRunLog(deps.runDb, claim.run.id, {
                    event: 'cursor_plan_changed',
                    planFingerprint: plan.fingerprint,
                });
            }
        }

        const counts: Record<string, number> = {
            planned: plan.assignments.size,
            inserted: 0,
            updated: 0,
            candidates: 0,
            quarantined: 0,
            rejected: 0,
            missingFromVendor: 0,
            ...plan.skipped,
        };
        const byCategory: Record<string, number> = {};
        const byCheck: Record<string, number> = {};
        let processedBatches = 0;
        // The batch index the durable `batchesProcessed` total was last brought
        // up to. It starts at the RESUME index, not at 0: recordCounts merges
        // additively into the run row, the earlier invocation already recorded
        // the batches it did, and starting from 0 would record them a second
        // time. On a fresh run startIndex is 0, so the two readings agree.
        let lastCheckpointBatchIndex = startIndex;

        for (let index = startIndex; index < plan.batches.length; index += 1) {
            const batch = plan.batches[index];
            const fetchedAt = deps.now();
            const details = options.dryRun ? [] : await deps.usda.getFoodsBatch(batch.fdcIds);
            const retrieval = options.dryRun ? null : await deps.usda.describeBatchRetrieval(batch.fdcIds);
            const returned = new Set<number>();

            if (!options.dryRun && retrieval !== null) {
                await deps.db.$transaction(
                    async (tx) => {
                        for (const detail of details) {
                            returned.add(detail.fdcId);
                            const assignment = plan.assignments.get(detail.fdcId);
                            if (assignment === undefined) {
                                continue;
                            }

                            const prepared = prepareCatalogFood(detail, assignment, manifest, fetchedAt, retrieval);
                            const verdict = validateCatalogCandidate(prepared.candidate, policy);
                            const publicationStatus = importPublicationStatus(prepared, verdict);

                            const outcome = await persistPreparedFood(
                                tx,
                                prepared,
                                verdict,
                                publicationStatus,
                                fetchedAt,
                            );
                            counts[outcome] += 1;
                            counts[publicationStatusCountKey(publicationStatus)] += 1;
                            byCategory[prepared.row.category] = (byCategory[prepared.row.category] ?? 0) + 1;
                            for (const check of verdict.checks) {
                                if (!check.pass) {
                                    byCheck[check.name] = (byCheck[check.name] ?? 0) + 1;
                                }
                            }
                        }
                    },
                    { timeout: TRANSACTION_TIMEOUT_MS },
                );
            }

            const missing = batch.fdcIds.filter((fdcId) => !returned.has(fdcId));
            counts.missingFromVendor += options.dryRun ? 0 : missing.length;
            processedBatches += 1;

            const done = index + 1;
            if (done % CURSOR_SAVE_EVERY_BATCHES === 0 || done === plan.batches.length) {
                await saveCursor<ImportCursor>(deps.runDb, claim.run.id, {
                    fingerprint: plan.fingerprint,
                    nextBatchIndex: done,
                });
                // The batches THIS checkpoint covers, never the save interval:
                // the final partial checkpoint of a 7-batch run covers 2, and
                // recording 5 would overstate the durable total by 3 for the
                // rest of the run's life. The delta needs no lower guard — this
                // block is reached only when `done` advanced past the previous
                // checkpoint, so it is always at least 1.
                await recordCounts(deps.runDb, claim.run.id, {
                    batchesProcessed: done - lastCheckpointBatchIndex,
                });
                lastCheckpointBatchIndex = done;
                logger.info('batch_progress', {
                    stage: STAGE,
                    batch: done,
                    ofBatches: plan.batches.length,
                    inserted: counts.inserted,
                    updated: counts.updated,
                    candidates: counts.candidates,
                    quarantined: counts.quarantined,
                });
            }
        }

        const report = {
            stage: STAGE,
            generatedAt: deps.now().toISOString(),
            runId: claim.run.id,
            usdaManifestVersion: manifest.usdaManifestVersion,
            coveragePlanVersion: coveragePlan.coveragePlanVersion,
            planFingerprint: plan.fingerprint,
            options: {
                categories: options.categories,
                limit: options.limit,
                resume: options.resume,
                dryRun: options.dryRun,
            },
            plannedBatches: plan.batches.length,
            processedBatches,
            counts,
            byCategory,
            failedChecks: byCheck,
            note: 'publication_status is candidate or quarantined here by design: catalog:validate is the stage that publishes.',
        };
        deps.writeReport(report);

        await finishRun(deps.runDb, claim.run.id, 'succeeded', { counts, logger });

        return {
            runId: claim.run.id,
            resumed: claim.resumed,
            counts,
            plannedBatches: plan.batches.length,
            processedBatches,
        };
    } finally {
        // Unconditional: install() replaced globalThis.fetch, and leaving a
        // paced fetch behind would silently throttle everything that runs after
        // this stage in the same process.
        restoreFetch();
    }
};

/** 30 s: a batch is 20 foods and ~80 statements, well inside it, but a cold pool is not. */
const TRANSACTION_TIMEOUT_MS = 30_000;

/**
 * What the import writes to `publication_status`.
 *
 * The import never publishes. A record the checks would accept is written as a
 * `candidate`, because publication needs the cross-table duplicate check that
 * only a pass over the whole table can make — that is `catalog:validate`'s
 * job, and keeping the two apart is what makes the import safe to re-run.
 */
export const importPublicationStatus = (
    prepared: PreparedCatalogFood,
    verdict: CatalogValidationVerdict,
): string => (verdict.publicationStatus === 'published' ? 'candidate' : verdict.publicationStatus);

const publicationStatusCountKey = (publicationStatus: string): string =>
    publicationStatus === 'candidate'
        ? 'candidates'
        : publicationStatus === 'quarantined'
          ? 'quarantined'
          : publicationStatus === 'rejected'
            ? 'rejected'
            : 'candidates';

// ---------------------------------------------------------------------------
// Reporting.
// ---------------------------------------------------------------------------

// One field per gap, keyed by the gap's stable code, so a refusal is greppable
// by code and readable in one line per prerequisite.
const gapFields = (gaps: readonly PrerequisiteGap[]): LogFields => {
    const fields: LogFields = { stage: STAGE, gapCount: gaps.length };
    for (const gap of gaps) {
        fields[`gap_${gap.code}`] =
            gap.detail === undefined
                ? `${gap.requirement}. ${gap.remedy}`
                : `${gap.requirement}. ${gap.remedy} [${gap.detail}]`;
    }
    return fields;
};

/**
 * The one error class this stage observes that it cannot name by `instanceof`.
 *
 * `UsdaError` is the vendor boundary's own error, and every batch and
 * enumeration failure arrives as one: a definitive `401`/`403`/`404`, which the
 * boundary now reports after a single attempt instead of four, and a request
 * that passed its deadline. Narrowing on the class would mean importing
 * `src/services/usda.service.ts` at module load, which constructs a Prisma
 * client — the very thing `main()` defers with a dynamic import so that this
 * file's pure exports stay importable without a database. The name is set in
 * the class's constructor and pinned by `usda.service.test.ts`, so it is the
 * stable handle available here.
 */
const isUsdaError = (error: unknown): boolean => error instanceof Error && error.name === 'UsdaError';

// Every error class this file can observe gets its own reported code, so an
// operator never has to read a stack trace to know which layer refused. The
// three library classes carry a `code` of their own; RateLimitConfigError
// carries its numbers instead, so it is reported under a fixed code, as is a
// vendor failure — `usda_request_failed` says the run stopped on USDA's answer
// (or its silence) rather than on a defect here, which is the difference
// between re-running with `--resume` and reading code. Anything
// unrecognised is reported through safeError under `unexpected_error` — it is
// never swallowed and never printed raw, because a raw error on this pipeline
// can carry a connection URL or a vendor key.
//
// Exported for the same reason every other decision in this file is: the code
// an operator reads is a behaviour, and `src/__tests__/scripts/` asserts it
// without running a stage.
export const describeFailure = (error: unknown): { code: string; error: { name: string; message: string } } => {
    if (error instanceof DatabaseOriginError) {
        return { code: error.code, error: safeError(error) };
    }
    if (error instanceof ManifestError) {
        return { code: error.code, error: safeError(error) };
    }
    if (error instanceof ModelBudgetError) {
        return { code: error.code, error: safeError(error) };
    }
    if (error instanceof CheckpointError) {
        return { code: error.code, error: safeError(error) };
    }
    if (error instanceof RateLimitConfigError) {
        return { code: 'rate_limit_misconfigured', error: safeError(error) };
    }
    if (isUsdaError(error)) {
        return { code: 'usda_request_failed', error: safeError(error) };
    }
    return { code: 'unexpected_error', error: safeError(error) };
};

const main = async (): Promise<number> => {
    const parsed = parseArgs(process.argv.slice(2));

    if (!parsed.ok) {
        for (const failure of parsed.errors) {
            logger.error('argument_rejected', { stage: STAGE, flag: failure.flag, problem: failure.message });
        }
        writeUsage('error');
        return 1;
    }

    if (parsed.options.help) {
        writeUsage('info');
        return 0;
    }

    // The URL itself never reaches the log — only the classification, the host
    // and the database name. dbGuard has already refused anything it could not
    // classify, so reaching this line means the origin was accepted.
    const origin = classifyDatabaseOrigin(process.env.DATABASE_URL);
    logger.info('database_origin_accepted', {
        stage: STAGE,
        originClass: origin.originClass,
        host: origin.host,
        database: origin.database,
        reason: origin.reason,
    });
    logger.info('stage_invoked', {
        stage: STAGE,
        categories: parsed.options.categories,
        limit: parsed.options.limit,
        resume: parsed.options.resume,
        dryRun: parsed.options.dryRun,
    });

    const gaps = preflight(defaultPreflightDeps());
    if (gaps.length > 0) {
        logger.error('stage_prerequisites_unmet', gapFields(gaps));
        return 1;
    }

    // Every input is present, so the stage runs. The USDA client and the Prisma
    // client are reached here rather than at module load: both construct state
    // on import, and the suites that read parseArgs, preflight and the pure
    // derivations above must be able to do so without either.
    const usdaService = await import('../src/services/usda.service');
    const { prisma } = await import('../src/prisma/client');

    if (usdaService.MAX_BATCH_FDC_IDS !== MAX_BATCH_FDC_IDS) {
        // The client throws above its own ceiling, so a divergence would fail
        // mid-run on a batch this file had already built. Said plainly instead.
        logger.error('batch_ceiling_disagrees', {
            stage: STAGE,
            scriptCeiling: MAX_BATCH_FDC_IDS,
            clientCeiling: usdaService.MAX_BATCH_FDC_IDS,
        });
        return 1;
    }

    const manifest = loadUsdaManifest();
    const coveragePlan = loadCoveragePlan();
    const requestsPerHour = getUsdaImportRateLimitPerHour(process.env);

    const importDeps: RunImportDeps = {
        db: prisma as unknown as ImportDb,
        runDb: prisma as unknown as CatalogRunDb,
        usda: {
            listFoods: (dataType, pageSize, pageNumber) => usdaService.listFoods(dataType, pageSize, pageNumber),
            getFoodsBatch: (fdcIds) => usdaService.getFoodsBatch(fdcIds),
            // The key is rebuilt with the client's own exported builders rather
            // than spelled out here, so it cannot drift from the one
            // `usdaPost` writes: `getFoodsBatch` sends
            // `{fdcIds: normalizeFdcIds(ids), format: 'full'}` to `/foods` with
            // no query parameters, and `cacheKeyForRequest` canonicalises the
            // body the same way for both of us.
            describeBatchRetrieval: async (fdcIds) => {
                const requestedFdcIds = usdaService.normalizeFdcIds(fdcIds);
                const cacheKey = usdaService.cacheKeyForRequest('POST', USDA_BATCH_PATH, {}, {
                    fdcIds: requestedFdcIds,
                    format: USDA_BATCH_FORMAT,
                });
                const cached = await prisma.usda_api_cache.findUnique({
                    where: { cache_key: cacheKey },
                    select: { payload: true, fetched_at: true },
                });
                return {
                    requestedFdcIds,
                    cacheKey,
                    // Digesting the recorded payload is what makes the claim
                    // checkable: a reader can read that row and recompute this.
                    responseSha256: cached === null ? null : sha256Hex(canonicalJsonString(cached.payload)),
                    source: cached === null ? 'import_run' : 'usda_api_cache',
                    cachedAt: cached?.fetched_at ?? null,
                };
            },
        },
        manifest,
        coveragePlan,
        options: parsed.options,
        logger,
        now: () => new Date(),
        installRateLimiter: () =>
            createUsdaRateLimiter({
                requestsPerHour,
                vendorCapPerHour: manifest.importLimits.vendorRequestsPerHour,
                logger,
            }).install(),
        writeReport: (report) => {
            const target = reportPath('import-report.json');
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
        },
    };

    // THE IMPORT'S STAGE CLAIM, AND THE ONE INVOCATION THAT DOES NOT TAKE IT.
    //
    // A real import MUTATES the catalog graph — it upserts foods and replaces
    // their aliases and portions by source_key — so it holds the catalog-graph
    // lock EXCLUSIVELY for as long as it runs, and no second import, no
    // generation, no validation pass and no release load can hold it at the same
    // time (lib/checkpoint.ts's THE STAGE LOCK). The run claim cannot give this:
    // its advisory lock is transaction-scoped and released the moment the claim
    // commits, so it guarantees one run ROW rather than one writer, and a
    // validation pass judging a row this import is about to rewrite was the
    // difference between those two promises.
    //
    // A DRY RUN TAKES NO LOCK, for the same reason it opens no run: it reaches
    // neither `db` nor `runDb` — reportDryRun touches only the plan it was
    // handed, and the suite proves it by refusing every property access on both
    // clients — so it has nothing to exclude and nothing to be excluded from. An
    // operator must be able to ask what an import would do while one is running.
    const outcome = parsed.options.dryRun
        ? await runImport(importDeps)
        : await withCatalogStageLock({ stage: 'usda_import', logger }, () => runImport(importDeps));

    logger.info('stage_completed', {
        stage: STAGE,
        runId: outcome.runId,
        resumed: outcome.resumed,
        plannedBatches: outcome.plannedBatches,
        processedBatches: outcome.processedBatches,
        counts: JSON.stringify(outcome.counts),
    });

    await prisma.$disconnect();
    return 0;
};

// Guarded so importing this module — which is how the later boundary's suites
// reach parseArgs, preflight and describeUsage — never runs the stage.
if (require.main === module) {
    main()
        .then((exitCode) => {
            process.exit(exitCode);
        })
        .catch((error: unknown) => {
            // createFatalLogger, not `logger`: the next statement discards
            // whatever is still buffered on process.stderr.
            const failure = describeFailure(error);
            createFatalLogger(STAGE).error('stage_failed', {
                stage: STAGE,
                code: failure.code,
                error: failure.error,
            });
            process.exit(1);
        });
}
