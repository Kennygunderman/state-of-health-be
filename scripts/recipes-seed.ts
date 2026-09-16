// The recipe seed: publishes the curated recipe files as versioned recipes.
//
// WHAT THE STAGE DOES. It reads every data/meal-planning/recipes/*.json file,
// resolves each ingredient by the catalog food's stable `source_key` to a
// published, source-backed, allergen-known row with a default gram weight,
// derives the recipe's nutrition, tags, badges and budget tier from that
// ingredient set through src/services/recipe.logic.ts, and fails a file whose
// declared values disagree with the derivation or whose `instructions` name an
// ingredient-vocabulary term its ingredient list does not carry. It is
// idempotent by `slug`: an unchanged recipe is a no-op, while changed content
// or a stale ingredient snapshot publishes a NEW `recipe_versions` row as
// `current`, retires the previous one and moves `recipes.current_version_id` —
// all in one transaction, because a recipe with two current versions or none is
// unplannable. It then derives the diet x allergen x slot x time coverage
// report FROM THE DATABASE and writes it to
// data/meal-planning/recipes/coverage-report.json (Agent Action Plan §0.7.1
// Group 4, §0.7.3).
//
// TWO PASSES, AND THE ORDER MATTERS. Every selected file is parsed, resolved
// and validated BEFORE the first write, and any single failure refuses the whole
// run. A partially seeded corpus is worse than an unseeded one: the planner's
// coverage check would answer from an incomplete set and the committed coverage
// report would describe recipes that are not there.
//
// NOTHING IS DERIVED TWICE. `total_minutes`, the four `per_serving_*` values,
// `sourced_calories_note`, `diet_tags`, `allergen_tags`, `allergen_status`,
// `badges`, `budget_tier` and `nutrition_provenance` are all read from
// `recipe.logic.ts`'s derivation and none of them from the file — the file's
// declarations are only ever COMPARED against it (§0.7.3: a file cannot talk
// its way to a "Gluten free" badge). `meal_slots` is the one list the file
// owns, because which meals a dish belongs to is not derivable from its
// ingredients. This file therefore computes no tag, badge, total, provenance or
// tier of its own; what it does own is the two rules that need the recipe
// DIRECTORY and the CATALOG rather than one ingredient set — the
// instruction-completeness check and the coverage matrix — and neither belongs
// in a pure module that may not read `scripts/` or `data/`.
//
// THE CONFIRMATION DOOR IS NOT THIS FILE'S. `recipes-seed` is
// `development_or_confirmed` in scripts/lib/dbGuard.ts: against anything other
// than a development origin the guard demands `--confirm-target <dbname>` at
// module load, before this file's own code runs. The flag is documented in the
// usage block and accepted by the parser, but it is read from process.argv by
// the guard and never interpreted here — one owner for one rule.
//
// The two guard imports are ordered and load-bearing: Rule
// backend-architecture §10's IPv4-first DNS ordering, then that module-load
// classification, both ahead of anything that could reach Prisma or the network.
import './lib/bootstrap';
import './lib/dbGuard';

import fs from 'fs';
import path from 'path';

import { classifyDatabaseOrigin, DatabaseOriginError } from './lib/dbGuard';
import { createFatalLogger, createLogger, safeError, writeLineSync } from './lib/logger';
import type { LogFields, LogLevel, ScriptLogger } from './lib/logger';
import { loadCoveragePlan, ManifestError, recipesDir, writeJsonFile } from './lib/manifest';
import type { CoveragePlan } from './lib/manifest';
// Deliberately NOT imported: lib/budget, lib/rateLimiter and lib/checkpoint.
// This stage reads files and writes rows — it makes no vendor call, meters no
// model budget, paces no request and keeps no resumable checkpoint — so those
// modules' error classes are unreachable here. Importing them to classify a
// failure that cannot happen would load three unrelated modules at startup and
// tell a reader this stage can exhaust a model budget, which it cannot.
// The pure derivation layer. Every rule this stage applies to an ingredient set
// comes from here, and this file adds none of its own (see the header).
import { normalizeCanonicalName } from '../src/services/catalog.logic';
import {
    deriveDietTags,
    findStaleIngredients,
    isEligibleForPlanning,
    RecipeDerivationError,
    validateRecipeDeclaration,
} from '../src/services/recipe.logic';
import type {
    CatalogIngredientVersions,
    PlanningPreferences,
    PlanningRecipeVersion,
    RecipeAllergenStatus,
    RecipeDietPreference,
    RecipeIngredientNutrientSnapshot,
    RecipeIngredientSnapshot,
    RecipeNutritionBasis,
    RecipePublicationIngredient,
} from '../src/services/recipe.logic';
import { MEAL_SLOTS } from '../src/types/recipe';
import type { MealSlot } from '../src/types/recipe';
import { UnitConversionError } from '../src/utils/units';

const STAGE = 'recipes-seed';

const RECIPE_LOGIC_MODULE = 'src/services/recipe.logic.ts';

const RECIPE_FILE_EXTENSION = '.json';

/**
 * This stage's OUTPUT, and the one file in the recipe directory that is not a
 * recipe — so every reader of the directory skips it by name.
 */
const COVERAGE_REPORT_FILE = 'coverage-report.json';

/** The only `catalog_foods.publication_status` a NEW recipe version may cite. */
const PUBLISHED_STATUS = 'published';

/** The only `nutrition_provenance` planning admits, on the recipe and on every ingredient. */
const SOURCE_BACKED_PROVENANCE = 'source_backed';

/** The only `allergen_status` a plannable ingredient may carry. */
const KNOWN_ALLERGEN_STATUS = 'known';

const CURRENT_VERSION_STATUS = 'current';
const RETIRED_VERSION_STATUS = 'retired';

/** The version number a first publication writes. */
const FIRST_VERSION = 1;

/**
 * The ceiling on one publish transaction, stated here rather than left to the
 * client default (5 s) that another stage might change.
 *
 * A publication writes one version plus up to a dozen ingredient rows, so the
 * work itself needs milliseconds; the generous ceiling is for the host rather
 * than the statement — this stage runs on a developer machine or a CI runner
 * shared with dozens of other jobs, and a transaction aborted by a scheduling
 * stall would report a seed failure that says nothing about the corpus. The
 * per-recipe transaction is still short-lived: it is one of forty-two, each
 * opened and closed in turn, never one transaction around the whole run.
 */
const PUBLISH_TRANSACTION_TIMEOUT_MS = 30_000;

const logger = createLogger(STAGE);

/* ---------------------------------------------------------------------------
 * Errors — §8: a typed error carrying the data the caller must report
 * ------------------------------------------------------------------------- */

/**
 * Why the seed refused.
 *
 *  - `recipes_unreadable` — the recipe directory or one of its files could not
 *    be read at all, which is an environment or input fault rather than a
 *    content one.
 *  - `unknown_slug` — `--only`/`--slug` named a recipe with no file, so the run
 *    would silently seed nothing and report success.
 *  - `recipes_invalid` — at least one selected file is not publishable: a
 *    malformed payload, an ingredient that does not resolve or is not
 *    publishable, a declaration the derivation contradicts, or an instruction
 *    naming an unlisted ingredient. Every problem found across every file
 *    travels on the error, because an operator fixing the corpus wants all of
 *    them and not the first.
 *  - `publication_failed` — the validated set was refused by the database. The
 *    per-slug transaction means nothing partial survives it.
 */
export type RecipeSeedErrorCode = 'recipes_unreadable' | 'unknown_slug' | 'recipes_invalid' | 'publication_failed';

/**
 * The stage's own failure class.
 *
 * `problems` is the list an operator acts on, one entry per defect, each already
 * naming the recipe slug, its file and — where an ingredient explains the
 * defect — that ingredient's `source_key` or snapshot name. The message is the
 * same list rendered for a terminal, so a caller that only logs the message
 * still reports every defect.
 */
export class RecipeSeedError extends Error {
    constructor(
        public readonly code: RecipeSeedErrorCode,
        message: string,
        public readonly problems: readonly string[] = [],
    ) {
        super(problems.length === 0 ? message : `${message}\n  - ${problems.join('\n  - ')}`);
        this.name = 'RecipeSeedError';
    }
}

/* ---------------------------------------------------------------------------
 * Argument parsing — pure (Rule backend-architecture §1.2).
 * ------------------------------------------------------------------------- */

export interface SeedOptions {
    readonly help: boolean;
    /**
     * `--only`, repeatable, with `--slug` as an alias. Empty means every recipe
     * file in the directory. A narrowed run never writes the coverage report:
     * the report is a claim about the WHOLE corpus, and publishing one recipe's
     * view of it would overwrite the committed artefact with partial numbers.
     */
    readonly only: readonly string[];
    /** Validate everything, write nothing — neither a row nor the report. */
    readonly dryRun: boolean;
}

export interface ArgumentError {
    readonly flag: string;
    readonly message: string;
}

export type ParseResult =
    | { readonly ok: true; readonly options: SeedOptions }
    | { readonly ok: false; readonly errors: readonly ArgumentError[] };

export interface PrerequisiteGap {
    readonly code: string;
    readonly requirement: string;
    readonly remedy: string;
    readonly detail?: string;
}

const HELP_FLAGS: readonly string[] = ['--help', '-h'];

/** The canonical narrowing flag, and the alias the file schema's contract names. */
const ONLY_FLAG = '--only';
const SLUG_FLAG = '--slug';

const DRY_RUN_FLAG = '--dry-run';

// Owned by scripts/lib/dbGuard.ts (see the header): consumed with its value so
// it is not mistaken for a positional argument, and deliberately not
// interpreted here.
const CONFIRM_TARGET_FLAG = '--confirm-target';

interface Token {
    readonly flag: string;
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
    if (argv.some((token) => HELP_FLAGS.includes(token))) {
        return { ok: true, options: { help: true, only: [], dryRun: false } };
    }

    const errors: ArgumentError[] = [];
    const only: string[] = [];
    let dryRun = false;

    let index = 0;
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

        if (flag === ONLY_FLAG || flag === SLUG_FLAG) {
            const value = takeValue(inlineValue);
            if (value === null) {
                errors.push({ flag, message: `${flag} requires a recipe slug` });
                continue;
            }
            // Deduplicated rather than repeated: `--only x --only x` names one
            // recipe, and a duplicate would otherwise publish it twice in one
            // run — the second pass seeing content it had just written.
            if (!only.includes(value)) {
                only.push(value);
            }
            continue;
        }

        if (flag === DRY_RUN_FLAG) {
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

    return { ok: true, options: { help: false, only, dryRun } };
};

// ---------------------------------------------------------------------------
// Usage.
// ---------------------------------------------------------------------------

export const describeUsage = (): string =>
    [
        `Usage: npm run recipes:seed -- [options]   (${STAGE})`,
        '',
        'Publishes data/meal-planning/recipes/*.json as versioned recipes, resolving',
        'every ingredient against the loaded catalog by source_key. Idempotent by slug:',
        'an unchanged recipe is a no-op, while changed content or a stale ingredient',
        'snapshot publishes a new version, retires the previous one and moves',
        'recipes.current_version_id in one transaction. Every selected file is validated',
        'before the first write, so one bad file publishes nothing at all.',
        '',
        'Options:',
        '  --only <slug>               Seed just this recipe slug. Repeatable.',
        '                              Default: every file in the recipes directory.',
        '                              A narrowed run does not write the coverage report,',
        '                              which is a claim about the whole corpus.',
        '  --slug <slug>               Alias for --only.',
        '  --dry-run                   Parse, resolve and validate everything, then stop.',
        '                              No row and no report is written on any path.',
        '  --confirm-target <dbname>   Required by scripts/lib/dbGuard.ts, which owns',
        '                              this flag, whenever DATABASE_URL is not a',
        '                              development origin: it must name that URL\'s',
        '                              database exactly. Without it the guard refuses',
        '                              the run at module load with',
        '                              code "confirmation_required". Never needed',
        '                              against a development origin.',
        '  --help, -h                  Print this usage block and exit 0.',
        '',
        'Inputs read:',
        '  data/meal-planning/recipes/*.json   one file per recipe, each ingredient',
        '                                      referencing a catalog food by source_key',
        '  data/meal-planning/coverage-plan.v1.json',
        '                                      the food-group vocabulary the',
        '                                      instruction-completeness check uses',
        '  src/services/recipe.logic.ts        nutrition derivation, tag derivation and',
        '                                      the eligibility rules',
        '',
        'Output written:',
        `  data/meal-planning/recipes/${COVERAGE_REPORT_FILE}`,
        '                                      the diet x allergen x slot x time coverage',
        '                                      table, derived from the seeded rows. Stable',
        '                                      and byte-identical on a no-op rerun.',
        '',
        'Environment:',
        '  DATABASE_URL   required; classified by scripts/lib/dbGuard.ts. Ingredients',
        '                 resolve against the catalog loaded in it, so run',
        '                 `npm run catalog:load -- --release <vN>` first.',
    ].join('\n');

const writeUsage = (level: LogLevel): void => {
    writeLineSync(describeUsage(), level);
};

// ---------------------------------------------------------------------------
// Preflight.
// ---------------------------------------------------------------------------

export interface SeedPreflightDeps {
    readonly env: NodeJS.ProcessEnv;
    /** manifest.ts's validated recipes directory, seamed for testability. */
    readonly recipesDir: () => string;
    /**
     * The directory's entries, or `null` when it does not exist. `null` and an
     * empty list are different failures with different remedies, so they are
     * not collapsed.
     */
    readonly listDirectory: (absolutePath: string) => readonly string[] | null;
    /** Repository-relative existence check. */
    readonly fileExists: (repoRelativePath: string) => boolean;
}

const repoFileExists = (repoRelativePath: string): boolean =>
    fs.existsSync(path.resolve(__dirname, '..', repoRelativePath));

const listDirectoryOnDisk = (absolutePath: string): readonly string[] | null => {
    try {
        return fs.readdirSync(absolutePath);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') {
            return null;
        }
        // A permission fault is an environment problem, not a missing input:
        // reporting it as "no recipes directory" would send the operator to the
        // wrong fix, so it reaches main's narrowing catch as itself.
        throw error;
    }
};

const defaultPreflightDeps = (): SeedPreflightDeps => ({
    env: process.env,
    recipesDir,
    listDirectory: listDirectoryOnDisk,
    fileExists: repoFileExists,
});

/**
 * The inputs the seed consumes, checked before a connection is opened.
 *
 * All three are present in this checkout, and this function stays because an
 * input can go missing in a consumer's tree: a partial clone, a stripped
 * container image, or a `data/` directory excluded from a build. Naming the
 * missing input and its remedy is what the operator needs; a Prisma error about
 * an empty result set is not.
 */
export const preflight = (deps: SeedPreflightDeps): readonly PrerequisiteGap[] => {
    const gaps: PrerequisiteGap[] = [];

    const entries = deps.listDirectory(deps.recipesDir());
    if (entries === null) {
        gaps.push({
            code: 'recipes_directory_absent',
            requirement: 'data/meal-planning/recipes/ must exist: it is the seed\'s only source of recipe content',
            remedy: 'Restore data/meal-planning/recipes/ from the repository (42 curated files at this revision, at least 40 per the coverage matrix in AAP §0.7.3).',
        });
    } else {
        const recipeFiles = entries.filter((entry) => isRecipeFileName(entry));
        if (recipeFiles.length === 0) {
            gaps.push({
                code: 'recipes_directory_empty',
                requirement: `data/meal-planning/recipes/ must hold at least one *${RECIPE_FILE_EXTENSION} recipe file`,
                remedy: 'Restore the curated recipe files under data/meal-planning/recipes/ (at least 40, per the coverage matrix in AAP §0.7.3).',
                detail: `the directory exists and holds ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}, none of them a recipe *${RECIPE_FILE_EXTENSION}`,
            });
        }
    }

    if (!deps.fileExists(RECIPE_LOGIC_MODULE)) {
        gaps.push({
            code: 'recipe_logic_absent',
            requirement: `${RECIPE_LOGIC_MODULE} must exist: it derives each recipe's nutrition and tags from its ingredient snapshots and decides what a mismatch means`,
            remedy: `Restore ${RECIPE_LOGIC_MODULE} with its unit suite (AAP §0.7.1 Group 4).`,
        });
    }

    return gaps;
};

/* ---------------------------------------------------------------------------
 * The recipe payload: typed accessors over parsed JSON
 *
 * Every field is read through one of these rather than cast. The files are
 * external data — a hand-authored corpus reviewed as a diff — so a wrong TYPE
 * in one (a string where a DOUBLE PRECISION column waits, a null where the
 * column is NOT NULL) has to be named with its file and field here rather than
 * surfacing from inside Prisma with no slug attached.
 * ------------------------------------------------------------------------- */

const render = (value: unknown): string => (value === undefined ? 'undefined' : String(JSON.stringify(value)));

/** A directory entry that is a recipe: a `*.json` file that is not this stage's own output. */
export const isRecipeFileName = (entry: string): boolean =>
    entry.endsWith(RECIPE_FILE_EXTENSION) && entry !== COVERAGE_REPORT_FILE;

const payloadError = (message: string): RecipeSeedError => new RecipeSeedError('recipes_invalid', message);

const asRecord = (value: unknown, where: string): Record<string, unknown> => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw payloadError(`${where}: expected a JSON object, received ${render(value)}`);
    }

    return value as Record<string, unknown>;
};

const text = (row: Record<string, unknown>, field: string, where: string): string => {
    const value = row[field];
    if (typeof value !== 'string' || value.length === 0) {
        throw payloadError(`${where}: ${field} must be a non-empty string, received ${render(value)}`);
    }

    return value;
};

const decimal = (row: Record<string, unknown>, field: string, where: string): number => {
    const value = row[field];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw payloadError(`${where}: ${field} must be a finite number, received ${render(value)}`);
    }

    return value;
};

const positiveDecimal = (row: Record<string, unknown>, field: string, where: string): number => {
    const value = decimal(row, field, where);
    if (!(value > 0)) {
        throw payloadError(`${where}: ${field} must be greater than zero, received ${render(value)}`);
    }

    return value;
};

const wholeNumber = (row: Record<string, unknown>, field: string, where: string): number => {
    const value = decimal(row, field, where);
    if (!Number.isInteger(value)) {
        throw payloadError(`${where}: ${field} must be an integer, received ${render(value)}`);
    }

    return value;
};

const nonNegativeWholeNumber = (row: Record<string, unknown>, field: string, where: string): number => {
    const value = wholeNumber(row, field, where);
    if (value < 0) {
        throw payloadError(`${where}: ${field} must not be negative, received ${render(value)}`);
    }

    return value;
};

const flag = (row: Record<string, unknown>, field: string, where: string): boolean => {
    const value = row[field];
    if (typeof value !== 'boolean') {
        throw payloadError(`${where}: ${field} must be a boolean, received ${render(value)}`);
    }

    return value;
};

/**
 * A list of strings.
 *
 * An EMPTY list is accepted, and that matters for `dietTags`: a recipe with a
 * meat ingredient derives no diet tag at all, so `[]` is the derivation's own
 * answer for an omnivore dish and never an unset field (§0.7.3).
 */
const textList = (row: Record<string, unknown>, field: string, where: string): string[] => {
    const value = row[field];
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
        throw payloadError(`${where}: ${field} must be an array of strings, received ${render(value)}`);
    }

    return value as string[];
};

const nonEmptyTextList = (row: Record<string, unknown>, field: string, where: string): string[] => {
    const value = textList(row, field, where);
    if (value.length === 0) {
        throw payloadError(`${where}: ${field} must hold at least one entry`);
    }

    return value;
};

const list = (row: Record<string, unknown>, field: string, where: string): unknown[] => {
    const value = row[field];
    if (!Array.isArray(value)) {
        throw payloadError(`${where}: ${field} must be an array, received ${render(value)}`);
    }

    return value as unknown[];
};

/** One `ingredients[]` entry as the file states it, in the file's camelCase. */
export interface RecipeIngredientDeclaration {
    readonly sourceKey: string;
    readonly quantity: number;
    readonly unit: string;
    /** Grams of this ingredient in the WHOLE recipe, which yields `yieldServings` servings. */
    readonly gramWeight: number;
    readonly displayText: string;
    readonly sortOrder: number;
    readonly isOptional: boolean;
}

/**
 * One recipe file.
 *
 * `iconKey`, `mealSlots`, `badges`, `allergenStatus` and `budgetTier` are read
 * as their JSON types here and their CLOSED-SET membership is decided by
 * `recipe.logic.ts::validateRecipeDeclaration`, which owns those sets. Checking
 * them twice would be two places to change one list.
 */
export interface RecipeFilePayload {
    readonly file: string;
    readonly slug: string;
    readonly name: string;
    readonly description: string;
    readonly iconKey: string;
    readonly instructions: readonly string[];
    readonly yieldServings: number;
    readonly servingDescription: string;
    readonly prepMinutes: number;
    readonly cookMinutes: number;
    readonly mealSlots: readonly string[];
    readonly dietTags: readonly string[];
    readonly allergenTags: readonly string[];
    readonly allergenStatus: string;
    readonly budgetTier: number;
    readonly badges: readonly string[];
    readonly ingredients: readonly RecipeIngredientDeclaration[];
}

/**
 * Parses one recipe file's contents.
 *
 * The slug must equal the file's basename. Not cosmetic: the slug is the
 * seed's idempotency key, so a file named for one recipe carrying another's
 * slug would publish under a name no reviewer reading the directory expects,
 * and a later rename would publish a duplicate rather than a new version.
 */
export const parseRecipePayload = (file: string, value: unknown): RecipeFilePayload => {
    const where = `recipes/${file}`;
    const row = asRecord(value, where);
    const slug = text(row, 'slug', where);
    const expectedSlug = path.basename(file, RECIPE_FILE_EXTENSION);

    if (slug !== expectedSlug) {
        throw payloadError(`${where}: slug "${slug}" must equal the file's name "${expectedSlug}"`);
    }

    return {
        file,
        slug,
        name: text(row, 'name', where),
        description: text(row, 'description', where),
        iconKey: text(row, 'iconKey', where),
        instructions: nonEmptyTextList(row, 'instructions', where),
        yieldServings: positiveDecimal(row, 'yieldServings', where),
        servingDescription: text(row, 'servingDescription', where),
        prepMinutes: nonNegativeWholeNumber(row, 'prepMinutes', where),
        cookMinutes: nonNegativeWholeNumber(row, 'cookMinutes', where),
        mealSlots: nonEmptyTextList(row, 'mealSlots', where),
        dietTags: textList(row, 'dietTags', where),
        allergenTags: textList(row, 'allergenTags', where),
        allergenStatus: text(row, 'allergenStatus', where),
        budgetTier: wholeNumber(row, 'budgetTier', where),
        badges: textList(row, 'badges', where),
        ingredients: (() => {
            const entries = list(row, 'ingredients', where);
            if (entries.length === 0) {
                throw payloadError(`${where}: ingredients must hold at least one entry — a recipe with none has no derivable nutrition`);
            }

            return entries.map((entry, index) => {
                const ingredientWhere = `${where} ingredient ${index}`;
                const ingredient = asRecord(entry, ingredientWhere);

                return {
                    sourceKey: text(ingredient, 'sourceKey', ingredientWhere),
                    quantity: positiveDecimal(ingredient, 'quantity', ingredientWhere),
                    unit: text(ingredient, 'unit', ingredientWhere),
                    gramWeight: positiveDecimal(ingredient, 'gramWeight', ingredientWhere),
                    displayText: text(ingredient, 'displayText', ingredientWhere),
                    sortOrder: nonNegativeWholeNumber(ingredient, 'sortOrder', ingredientWhere),
                    isOptional: flag(ingredient, 'isOptional', ingredientWhere),
                };
            });
        })(),
    };
};

export interface RecipeFileRead {
    readonly payloads: readonly RecipeFilePayload[];
    /** One entry per file that could not be parsed; the run refuses on any of them. */
    readonly problems: readonly string[];
}

/**
 * Reads the selected recipe files, in slug order.
 *
 * A file that cannot be parsed is COLLECTED rather than thrown, because a
 * corpus edit that broke three files should report three problems; the two
 * conditions that do throw — an unreadable directory and an `--only` slug with
 * no file — are faults in the invocation rather than in the content, and
 * continuing past either would seed a set the operator did not ask for.
 */
export const readRecipeFiles = (directory: string, only: readonly string[]): RecipeFileRead => {
    let entries: readonly string[];
    try {
        entries = fs.readdirSync(directory);
    } catch (error) {
        throw new RecipeSeedError(
            'recipes_unreadable',
            `the recipe directory could not be read: ${safeError(error).message}`,
        );
    }

    const available = entries.filter((entry) => isRecipeFileName(entry)).sort();
    const selected =
        only.length === 0
            ? available
            : only.map((slug) => {
                  const file = `${slug}${RECIPE_FILE_EXTENSION}`;
                  if (!available.includes(file)) {
                      throw new RecipeSeedError(
                          'unknown_slug',
                          `--only named "${slug}", which has no file in the recipe directory`,
                      );
                  }
                  return file;
              });

    const payloads: RecipeFilePayload[] = [];
    const problems: string[] = [];

    for (const file of [...selected].sort()) {
        let raw: string;
        try {
            raw = fs.readFileSync(path.join(directory, file), 'utf8');
        } catch (error) {
            throw new RecipeSeedError(
                'recipes_unreadable',
                `recipes/${file} could not be read: ${safeError(error).message}`,
            );
        }

        let parsed: unknown;
        try {
            // The parser's own message is not forwarded: since Node 20 it quotes
            // the offending part of the document, and file contents must not
            // reach a log. The position is what an author needs and it is in
            // the file itself.
            parsed = JSON.parse(raw) as unknown;
        } catch {
            problems.push(`recipes/${file}: is not valid JSON`);
            continue;
        }

        try {
            payloads.push(parseRecipePayload(file, parsed));
        } catch (error) {
            if (error instanceof RecipeSeedError) {
                problems.push(...(error.problems.length > 0 ? error.problems : [error.message]));
                continue;
            }
            throw error;
        }
    }

    return { payloads, problems };
};

/* ---------------------------------------------------------------------------
 * Resolving an ingredient against the loaded catalog
 * ------------------------------------------------------------------------- */

/** The `catalog_food_portions` facts the publication gate reads. */
export interface SeedCatalogPortionRow {
    is_default: boolean;
    gram_weight: number;
}

/**
 * The `catalog_foods` row a recipe ingredient resolves to.
 *
 * `food_group`, `allergen_status`, `cost_class`, `nutrition_basis` and
 * `density_g_per_ml` are read from HERE and not from `recipe_ingredients`,
 * which does not snapshot them — the same join `recipe.service.ts` performs at
 * read time (`recipe.service.ts:404,468-491`).
 */
export interface SeedCatalogFoodRow {
    id: string;
    source_key: string;
    canonical_name: string;
    display_name: string;
    food_group: string;
    publication_status: string;
    nutrition_provenance: string;
    allergen_status: string;
    allergen_tags: string[];
    diet_tags: string[];
    nutrition_basis: string;
    density_g_per_ml: number | null;
    calories: number | null;
    protein_g: number | null;
    carbs_g: number | null;
    fat_g: number | null;
    fiber_g: number | null;
    cost_class: number;
    nutrition_version: number;
    metadata_version: number;
    catalog_food_portions: SeedCatalogPortionRow[];
}

/** The identity text the instruction-completeness check matches an ingredient against. */
export interface IngredientIdentityText {
    readonly foodGroup: string;
    readonly canonicalName: string;
    readonly displayName: string;
}

/** A resolved ingredient: what the derivation reads, plus the identity text and the row's id. */
export interface ResolvedIngredient {
    readonly declaration: RecipeIngredientDeclaration;
    readonly food: SeedCatalogFoodRow;
    readonly publication: RecipePublicationIngredient;
    readonly identity: IngredientIdentityText;
}

const isFiniteNonNegative = (value: number | null): value is number =>
    value !== null && Number.isFinite(value) && value >= 0;

/**
 * Every reason a `catalog_foods` row may not back a NEW recipe version.
 *
 * All seven are §0.7.3 preconditions rather than preferences, and each is
 * reported with the offending `source_key` so the operator knows which catalog
 * row to fix rather than which recipe to delete:
 *
 *  - not `published` — a candidate, quarantined, rejected or RETIRED row. A
 *    retired food may keep backing an EXISTING version (that is what makes
 *    historical plans readable), but a new version built on one would be
 *    unplannable from the moment it published.
 *  - not `source_backed` — an estimate never enters planning, so a recipe built
 *    on one could never be planned either.
 *  - `allergen_status` not `known` — a food nobody has reviewed cannot be
 *    certified safe for any user, whatever they selected.
 *  - a missing or negative core macro — a sum missing a term is not a smaller
 *    sum, and `snapshot_per_100g` types all four as required.
 *  - `per_100ml` with no density — millilitres never equal grams (~9 % on oil).
 *  - a nutrition basis that is neither per-100 g nor per-100 ml — a
 *    `per_serving`-only food has no sourced gram basis to scale from.
 *  - no single default portion with a positive gram weight — the one weight
 *    every unit conversion and grocery line is derived from.
 */
const describeUnpublishableFood = (food: SeedCatalogFoodRow): string[] => {
    const problems: string[] = [];

    if (food.publication_status !== PUBLISHED_STATUS) {
        problems.push(`publication_status is "${food.publication_status}", not "${PUBLISHED_STATUS}"`);
    }
    if (food.nutrition_provenance !== SOURCE_BACKED_PROVENANCE) {
        problems.push(`nutrition_provenance is "${food.nutrition_provenance}", not "${SOURCE_BACKED_PROVENANCE}"`);
    }
    if (food.allergen_status !== KNOWN_ALLERGEN_STATUS) {
        problems.push(`allergen_status is "${food.allergen_status}", not "${KNOWN_ALLERGEN_STATUS}"`);
    }

    for (const [field, value] of [
        ['calories', food.calories],
        ['protein_g', food.protein_g],
        ['carbs_g', food.carbs_g],
        ['fat_g', food.fat_g],
    ] as const) {
        if (!isFiniteNonNegative(value)) {
            problems.push(`${field} is ${render(value)}, which is not a finite non-negative number`);
        }
    }

    if (food.nutrition_basis !== 'per_100g' && food.nutrition_basis !== 'per_100ml') {
        problems.push(
            `nutrition_basis is "${food.nutrition_basis}"; a recipe ingredient must be stated per_100g or per_100ml`,
        );
    }
    if (food.nutrition_basis === 'per_100ml' && !isFiniteNonNegative(food.density_g_per_ml)) {
        problems.push('is stated per_100ml with no density_g_per_ml, so it cannot convert to grams');
    }

    const defaults = food.catalog_food_portions.filter((portion) => portion.is_default);
    if (defaults.length !== 1) {
        problems.push(`has ${defaults.length} default catalog_food_portions rows, not exactly one`);
    } else if (!(defaults[0].gram_weight > 0)) {
        problems.push(`its default portion states gram_weight ${render(defaults[0].gram_weight)}, which is not positive`);
    }

    return problems;
};

/**
 * A resolved ingredient in the shape the derivation reads.
 *
 * Called only after `describeUnpublishableFood` accepted the row, which is what
 * makes the four non-null assertions on the core macros sound: each was checked
 * to be a finite non-negative number, and `RecipeIngredientNutrientSnapshot`
 * types all four as required precisely so an unchecked null cannot reach a sum.
 */
const toPublicationIngredient = (
    declaration: RecipeIngredientDeclaration,
    food: SeedCatalogFoodRow,
): RecipePublicationIngredient => ({
    catalog_food_id: food.id,
    snapshot_name: food.display_name,
    snapshot_provenance: SOURCE_BACKED_PROVENANCE,
    snapshot_allergen_tags: food.allergen_tags,
    snapshot_diet_tags: food.diet_tags,
    is_optional: declaration.isOptional,
    food_group: food.food_group,
    allergen_status: KNOWN_ALLERGEN_STATUS as RecipeAllergenStatus,
    cost_class: food.cost_class,
    catalog_nutrition_version: food.nutrition_version,
    catalog_metadata_version: food.metadata_version,
    snapshot_per_100g: {
        calories: food.calories as number,
        protein_g: food.protein_g as number,
        carbs_g: food.carbs_g as number,
        fat_g: food.fat_g as number,
        // Absent and null both mean unknown, and unknown propagates: a recipe
        // one of whose ingredients states no fibre derives a null fibre total
        // rather than a total that quietly counted it as zero.
        fiber_g: food.fiber_g,
    },
    quantity: declaration.quantity,
    unit: declaration.unit,
    gram_weight: declaration.gramWeight,
    display_text: declaration.displayText,
    sort_order: declaration.sortOrder,
    nutrition_basis: food.nutrition_basis as RecipeNutritionBasis,
    density_g_per_ml: food.density_g_per_ml,
});

export interface IngredientResolution {
    readonly resolved: readonly ResolvedIngredient[];
    readonly problems: readonly string[];
}

/**
 * Resolves every ingredient of one payload by `source_key` — never by a
 * database id, so the same files seed identically into any database (§0.7.3).
 *
 * Every failure is collected and prefixed with the recipe slug AND the
 * offending `source_key`, because "an ingredient is missing" without either
 * names neither the file to fix nor the catalog row to load.
 */
export const resolveIngredients = (
    payload: RecipeFilePayload,
    foodsBySourceKey: ReadonlyMap<string, SeedCatalogFoodRow>,
): IngredientResolution => {
    const resolved: ResolvedIngredient[] = [];
    const problems: string[] = [];
    const where = `${payload.slug} (recipes/${payload.file})`;
    const seen = new Set<string>();

    for (const declaration of payload.ingredients) {
        if (seen.has(declaration.sourceKey)) {
            problems.push(
                `${where}: ingredient "${declaration.sourceKey}" is listed twice; one row per catalog food, with the quantity summed`,
            );
            continue;
        }
        seen.add(declaration.sourceKey);

        const food = foodsBySourceKey.get(declaration.sourceKey);
        if (food === undefined) {
            problems.push(
                `${where}: ingredient "${declaration.sourceKey}" resolves to no catalog_foods row; load the catalog release that carries it`,
            );
            continue;
        }

        const refusals = describeUnpublishableFood(food);
        if (refusals.length > 0) {
            for (const refusal of refusals) {
                problems.push(`${where}: ingredient "${declaration.sourceKey}" ${refusal}`);
            }
            continue;
        }

        resolved.push({
            declaration,
            food,
            publication: toPublicationIngredient(declaration, food),
            identity: {
                foodGroup: food.food_group,
                canonicalName: food.canonical_name,
                displayName: food.display_name,
            },
        });
    }

    return { resolved, problems };
};

/* ---------------------------------------------------------------------------
 * Instruction completeness — "every nutritive ingredient is listed"
 *
 * §0.7.3 requires every nutritive ingredient to appear in `ingredients[]`:
 * oils, butter, dressings, sugar and marinades included, because an unlisted
 * tablespoon of oil is ~120 uncounted kcal on a plate the user was told the
 * calories of. The enforceable form of that rule is this: if the prose names a
 * food the ingredient list does not carry, the file fails.
 *
 * The vocabulary is DATA rather than a word list written here — the food-group
 * taxonomy in `coverage-plan.v1.json` plus every published catalog food's
 * canonical name — so it grows with the catalog and cannot go stale against it.
 * Both sides are normalised identically and folded for plurals, so "tomatoes"
 * in a step matches the catalog's "tomato" and neither spelling is privileged.
 *
 * WHY THIS LIVES HERE AND NOT IN `recipe.logic.ts`. The rule needs the coverage
 * plan (a `data/` document) and a table-wide read of `catalog_foods`, neither of
 * which a pure module in `src/services/` may reach; it is also a property of the
 * FILE rather than of a published version, so nothing at request time asks it.
 * ------------------------------------------------------------------------- */

/** Tokens at or below this length are left alone: "oats" is not "oat" plus an s. */
const MIN_PLURAL_FOLD_LENGTH = 4;

/**
 * One token with its English plural folded away.
 *
 * Deliberately crude and deliberately SYMMETRIC: it is applied to the
 * vocabulary and to the instructions through the same function, so the only
 * property that matters is that the two sides agree. "berries" and "berry" fold
 * together, "tomatoes" folds to "tomato", "oils" to "oil"; a `ss` ending is
 * left alone so "glass" does not become "gla".
 */
export const foldPluralToken = (token: string): string => {
    if (token.length < MIN_PLURAL_FOLD_LENGTH) {
        return token;
    }
    if (token.endsWith('ies')) {
        return `${token.slice(0, -3)}y`;
    }
    if (token.endsWith('es')) {
        return token.slice(0, -2);
    }
    if (token.endsWith('s') && !token.endsWith('ss')) {
        return token.slice(0, -1);
    }

    return token;
};

/**
 * Text as this check compares it: `normalizeCanonicalName`'s accent folding,
 * lower-casing and non-alphanumeric collapse — the catalog's own identity
 * normalisation, reused rather than re-derived — with plural folding per token
 * on top, which that function deliberately does not do (two catalog foods may
 * differ only in plurality, so its identity key must keep them apart).
 */
export const normalizeVocabularyText = (value: string): string =>
    normalizeCanonicalName(value)
        .split(' ')
        .filter((token) => token.length > 0)
        .map(foldPluralToken)
        .join(' ');

/**
 * The ingredient vocabulary, split by shape because the two shapes are matched
 * differently.
 *
 * A MULTI-WORD term matches as a substring: "olive oil" is named by "extra
 * virgin olive oil" and by "olive oil, refined". A SINGLE-WORD term matches only
 * as a whole token, because a substring test on one would fire on "oat" inside
 * "coat" and "rice" inside "price" — the false positives that make a gate get
 * switched off.
 */
export interface IngredientVocabulary {
    readonly singleWordTerms: ReadonlySet<string>;
    readonly multiWordTerms: readonly string[];
}

export const buildIngredientVocabulary = (
    foodGroups: readonly string[],
    canonicalNames: readonly string[],
): IngredientVocabulary => {
    const terms = new Set<string>();

    for (const foodGroup of foodGroups) {
        // The taxonomy spells its groups `nut_seed`, `olive_oil`: underscores
        // are word separators there, and the normaliser collapses them to
        // spaces, which is what makes `olive_oil` a two-word term.
        terms.add(normalizeVocabularyText(foodGroup));
    }
    for (const canonicalName of canonicalNames) {
        terms.add(normalizeVocabularyText(canonicalName));
    }
    terms.delete('');

    const singleWordTerms = new Set<string>();
    const multiWordTerms: string[] = [];
    for (const term of terms) {
        if (term.includes(' ')) {
            multiWordTerms.push(term);
        } else {
            singleWordTerms.add(term);
        }
    }

    return { singleWordTerms, multiWordTerms: multiWordTerms.sort() };
};

/** A vocabulary term a step names that no listed ingredient accounts for. */
export interface UnlistedInstructionTerm {
    readonly term: string;
    readonly instruction: string;
}

/**
 * Whether a listed ingredient accounts for a term.
 *
 * Substring matching in BOTH directions, which is what makes the check hold
 * without a synonym table: the step's "rice" is accounted for by the
 * ingredient "brown rice, cooked" (term inside name), and the step's "canola
 * oil" by the ingredient "oil" if the catalog ever named one that plainly (name
 * inside term). The food group answers the remaining case, where the prose uses
 * the category word — "cheese" for "Feta cheese" through the `cheese` group.
 */
const termIsAccounted = (term: string, identities: readonly IngredientIdentityText[]): boolean =>
    identities.some((identity) => {
        if (normalizeVocabularyText(identity.foodGroup) === term) {
            return true;
        }

        return [identity.canonicalName, identity.displayName]
            .map((value) => normalizeVocabularyText(value))
            .some((name) => name.length > 0 && (name.includes(term) || term.includes(name)));
    });

/**
 * Every ingredient-vocabulary term the instructions name that the ingredient
 * list does not account for, with the step that named it.
 *
 * Each step is matched on its own so the refusal can quote it: an operator
 * fixing "Heat the canola oil" needs the sentence, not the whole method.
 */
export const findUnlistedInstructionTerms = (
    instructions: readonly string[],
    identities: readonly IngredientIdentityText[],
    vocabulary: IngredientVocabulary,
): UnlistedInstructionTerm[] => {
    const unlisted: UnlistedInstructionTerm[] = [];
    const reported = new Set<string>();

    for (const instruction of instructions) {
        const normalized = normalizeVocabularyText(instruction);
        if (normalized.length === 0) {
            continue;
        }

        const hits = new Set<string>();
        for (const token of new Set(normalized.split(' '))) {
            if (vocabulary.singleWordTerms.has(token)) {
                hits.add(token);
            }
        }
        for (const term of vocabulary.multiWordTerms) {
            if (normalized.includes(term)) {
                hits.add(term);
            }
        }

        for (const term of [...hits].sort()) {
            // Reported once per recipe rather than once per step: the fix is one
            // ingredient row, and repeating it per sentence buries the others.
            if (reported.has(term) || termIsAccounted(term, identities)) {
                continue;
            }
            reported.add(term);
            unlisted.push({ term, instruction });
        }
    }

    return unlisted;
};

/* ---------------------------------------------------------------------------
 * Planning one publication: the columns a version write holds
 * ------------------------------------------------------------------------- */

/**
 * The `recipe_versions` columns one publication of a payload writes.
 *
 * `version`, `status`, `published_at` and `retired_at` are NOT here: they are
 * decided by the transaction from what is already stored, and including them
 * would make the content comparison below answer "changed" for a recipe whose
 * content is identical and whose version number is simply higher.
 */
export interface PlannedRecipeVersion {
    readonly name: string;
    readonly description: string;
    readonly icon_key: string;
    readonly instructions: readonly string[];
    readonly yield_servings: number;
    readonly serving_description: string;
    readonly prep_minutes: number;
    readonly cook_minutes: number;
    readonly total_minutes: number;
    readonly meal_slots: readonly string[];
    readonly diet_tags: readonly string[];
    readonly allergen_tags: readonly string[];
    readonly allergen_status: string;
    readonly budget_tier: number;
    readonly badges: readonly string[];
    readonly nutrition_provenance: string;
    readonly per_serving_calories: number;
    readonly per_serving_protein_g: number;
    readonly per_serving_carbs_g: number;
    readonly per_serving_fat_g: number;
    readonly sourced_calories_note: string | null;
}

/** One `recipe_ingredients` row, snapshot columns included. */
export interface PlannedRecipeIngredient {
    readonly catalog_food_id: string;
    readonly catalog_nutrition_version: number;
    readonly catalog_metadata_version: number;
    readonly snapshot_per_100g: RecipeIngredientNutrientSnapshot;
    readonly snapshot_name: string;
    readonly snapshot_provenance: string;
    readonly snapshot_allergen_tags: readonly string[];
    readonly snapshot_diet_tags: readonly string[];
    readonly quantity: number;
    readonly unit: string;
    readonly gram_weight: number;
    readonly display_text: string;
    readonly sort_order: number;
    readonly is_optional: boolean;
}

export interface RecipePublicationPlan {
    readonly slug: string;
    readonly file: string;
    readonly version: PlannedRecipeVersion;
    /** Ordered by `sort_order`, so the stored set and this one compare index by index. */
    readonly ingredients: readonly PlannedRecipeIngredient[];
    /** The resolved ingredients, kept for staleness detection and the coverage report. */
    readonly publicationIngredients: readonly RecipePublicationIngredient[];
}

export interface RecipeValidation {
    readonly slug: string;
    readonly file: string;
    /** `null` whenever `problems` is non-empty: an invalid file has no publication. */
    readonly plan: RecipePublicationPlan | null;
    readonly problems: readonly string[];
}

const bySortOrder = <T extends { readonly sort_order: number }>(left: T, right: T): number =>
    left.sort_order - right.sort_order;

/**
 * Parses, resolves and validates one payload, answering with its publication or
 * with every reason it has none.
 *
 * The three gates, in order, because each needs the previous one's output:
 * ingredient resolution (the catalog facts), the declared-versus-derived gate
 * (`recipe.logic.ts::validateRecipeDeclaration`, which returns the derivation
 * this publication is built FROM), and instruction completeness.
 *
 * `RecipeDerivationError` and `UnitConversionError` are caught and reported as
 * problems rather than propagated: both mean this file's numbers are
 * meaningless — an impossible nutrient, a non-positive yield, a volume with no
 * density — which is a defect in this recipe and not a reason to abandon the
 * validation of the other forty-one.
 */
export const validateRecipeFile = (
    payload: RecipeFilePayload,
    foodsBySourceKey: ReadonlyMap<string, SeedCatalogFoodRow>,
    vocabulary: IngredientVocabulary,
): RecipeValidation => {
    const where = `${payload.slug} (recipes/${payload.file})`;
    const { resolved, problems: resolutionProblems } = resolveIngredients(payload, foodsBySourceKey);

    if (resolutionProblems.length > 0) {
        return { slug: payload.slug, file: payload.file, plan: null, problems: resolutionProblems };
    }

    const publicationIngredients = resolved.map((ingredient) => ingredient.publication);
    const problems: string[] = [];

    let verdict;
    try {
        verdict = validateRecipeDeclaration(
            {
                icon_key: payload.iconKey,
                meal_slots: payload.mealSlots,
                badges: payload.badges,
                diet_tags: payload.dietTags,
                allergen_tags: payload.allergenTags,
                prep_minutes: payload.prepMinutes,
                cook_minutes: payload.cookMinutes,
                yield_servings: payload.yieldServings,
                allergen_status: payload.allergenStatus,
                budget_tier: payload.budgetTier,
            },
            publicationIngredients,
        );
    } catch (error) {
        if (error instanceof RecipeDerivationError || error instanceof UnitConversionError) {
            return {
                slug: payload.slug,
                file: payload.file,
                plan: null,
                problems: [`${where}: ${error.name}: ${error.message}`],
            };
        }
        throw error;
    }

    for (const mismatch of verdict.mismatches) {
        // The tag-set messages already name their offending ingredients, so the
        // list is appended only for a single-value mismatch — `allergen_status`
        // is the one that carries ingredients without naming them in its
        // sentence — and a doubled list is avoided.
        const named =
            mismatch.code !== 'mismatch' || mismatch.ingredients.length === 0
                ? ''
                : ` Ingredients: ${mismatch.ingredients.join(', ')}.`;
        problems.push(`${where}: ${mismatch.message}${named}`);
    }

    for (const unlisted of findUnlistedInstructionTerms(
        payload.instructions,
        resolved.map((ingredient) => ingredient.identity),
        vocabulary,
    )) {
        problems.push(
            `${where}: instructions name "${unlisted.term}", which no listed ingredient accounts for — ` +
                'every nutritive ingredient must be listed (AAP §0.7.3), because an unlisted tablespoon of oil ' +
                `is ~120 uncounted kcal. Step: "${unlisted.instruction}"`,
        );
    }

    if (problems.length > 0) {
        return { slug: payload.slug, file: payload.file, plan: null, problems };
    }

    const derived = verdict.derived;

    return {
        slug: payload.slug,
        file: payload.file,
        problems: [],
        plan: {
            slug: payload.slug,
            file: payload.file,
            version: {
                name: payload.name,
                description: payload.description,
                icon_key: payload.iconKey,
                instructions: [...payload.instructions],
                yield_servings: payload.yieldServings,
                serving_description: payload.servingDescription,
                prep_minutes: payload.prepMinutes,
                cook_minutes: payload.cookMinutes,
                // Every value below is the DERIVATION's, never the file's.
                total_minutes: derived.totalMinutes,
                // The one list the file owns: which meals a dish belongs to is
                // not derivable from its ingredients.
                meal_slots: [...payload.mealSlots],
                diet_tags: derived.dietTags,
                allergen_tags: derived.allergenTags,
                allergen_status: derived.allergenStatus,
                budget_tier: derived.budgetTier,
                badges: derived.badges,
                nutrition_provenance: derived.nutritionProvenance,
                per_serving_calories: derived.perServing.calories,
                per_serving_protein_g: derived.perServing.protein,
                per_serving_carbs_g: derived.perServing.carbs,
                per_serving_fat_g: derived.perServing.fat,
                sourced_calories_note: derived.sourcedCaloriesNote,
            },
            ingredients: publicationIngredients
                .map((ingredient) => ({
                    catalog_food_id: ingredient.catalog_food_id,
                    catalog_nutrition_version: ingredient.catalog_nutrition_version,
                    catalog_metadata_version: ingredient.catalog_metadata_version,
                    snapshot_per_100g: ingredient.snapshot_per_100g,
                    snapshot_name: ingredient.snapshot_name,
                    snapshot_provenance: ingredient.snapshot_provenance,
                    snapshot_allergen_tags: [...ingredient.snapshot_allergen_tags],
                    snapshot_diet_tags: [...ingredient.snapshot_diet_tags],
                    quantity: ingredient.quantity,
                    unit: ingredient.unit,
                    gram_weight: ingredient.gram_weight,
                    display_text: ingredient.display_text,
                    sort_order: ingredient.sort_order,
                    is_optional: ingredient.is_optional,
                }))
                .sort(bySortOrder),
            publicationIngredients,
        },
    };
};

/* ---------------------------------------------------------------------------
 * Is what is stored already what we would publish?
 * ------------------------------------------------------------------------- */

/**
 * How close a `DOUBLE PRECISION` column read back has to be to the double that
 * was written, as a RELATIVE difference.
 *
 * Not a softened comparison — a measured property of the write path, recorded
 * with its probe in `src/__tests__/api/seed-rerun.test.ts:176-201`: the Prisma
 * client encodes a float parameter to fifteen significant digits, so a derived
 * value such as `177.79299999999998` is stored as the neighbouring double
 * `177.793` and no comparison on this stack can be bit for bit. Without this
 * tolerance every rerun would read its own rounding as a content change and
 * publish a new version of all forty-two recipes, which is exactly the
 * churn idempotency is for. The observed gaps are ~1e-16 relative; this bound
 * is four orders above that and ten below the one decimal place any of these
 * numbers is displayed at, so a real arithmetic error is still caught by many
 * orders of magnitude.
 */
export const FLOAT8_ROUND_TRIP_TOLERANCE = 1e-12;

export const sameStoredNumber = (stored: number, written: number): boolean => {
    if (stored === written) {
        return true;
    }
    if (!Number.isFinite(stored) || !Number.isFinite(written)) {
        return false;
    }

    const scale = Math.max(Math.abs(stored), Math.abs(written));
    return Math.abs(stored - written) <= scale * FLOAT8_ROUND_TRIP_TOLERANCE;
};

/**
 * Deep equivalence between a value read back from the database and the value
 * that was written.
 *
 * Two deliberate differences from `JSON.stringify` equality. Numbers go through
 * {@link sameStoredNumber}, for the reason above. And objects are compared by
 * KEY rather than by serialised order, because `jsonb` does not preserve
 * insertion order — PostgreSQL stores object keys sorted, so `snapshot_per_100g`
 * returns as `{fat_g, carbs_g, fiber_g, calories, protein_g}` however it was
 * written, which is the same object and a different string.
 */
export const equivalentContent = (stored: unknown, written: unknown): boolean => {
    if (typeof stored === 'number' && typeof written === 'number') {
        return sameStoredNumber(stored, written);
    }

    if (Array.isArray(stored) && Array.isArray(written)) {
        return (
            stored.length === written.length && stored.every((entry, index) => equivalentContent(entry, written[index]))
        );
    }

    if (
        typeof stored === 'object' &&
        stored !== null &&
        typeof written === 'object' &&
        written !== null &&
        !Array.isArray(stored) &&
        !Array.isArray(written)
    ) {
        const storedRecord = stored as Record<string, unknown>;
        const writtenRecord = written as Record<string, unknown>;
        const keys = new Set([...Object.keys(storedRecord), ...Object.keys(writtenRecord)]);

        return [...keys].every((key) => equivalentContent(storedRecord[key], writtenRecord[key]));
    }

    return stored === written;
};

/** One content difference between the stored current version and the planned one. */
export interface ContentDifference {
    readonly field: string;
    readonly stored: string;
    readonly planned: string;
}

/**
 * Every field in which the stored current version differs from what would be
 * published now.
 *
 * The ingredient set is compared as ONE field rather than row by row: a changed
 * gram weight, a re-ordered list and a removed ingredient are all "the
 * ingredients changed", and one new version answers all three.
 */
export const compareStoredContent = (
    stored: { readonly version: PlannedRecipeVersion; readonly ingredients: readonly PlannedRecipeIngredient[] },
    planned: RecipePublicationPlan,
): ContentDifference[] => {
    const differences: ContentDifference[] = [];

    for (const [field, plannedValue] of Object.entries(planned.version)) {
        const storedValue = stored.version[field as keyof PlannedRecipeVersion];
        if (!equivalentContent(storedValue, plannedValue)) {
            differences.push({ field, stored: render(storedValue), planned: render(plannedValue) });
        }
    }

    if (!equivalentContent(stored.ingredients, planned.ingredients)) {
        differences.push({
            field: 'recipe_ingredients',
            stored: render(stored.ingredients),
            planned: render(planned.ingredients),
        });
    }

    return differences;
};

/* ---------------------------------------------------------------------------
 * Persistence.
 * ------------------------------------------------------------------------- */

/** A stored `recipe_ingredients` row. */
export interface StoredIngredientRow {
    id: string;
    catalog_food_id: string;
    catalog_nutrition_version: number;
    catalog_metadata_version: number;
    snapshot_per_100g: unknown;
    snapshot_name: string;
    snapshot_provenance: string;
    snapshot_allergen_tags: string[];
    snapshot_diet_tags: string[];
    quantity: number;
    unit: string;
    gram_weight: number;
    display_text: string;
    sort_order: number;
    is_optional: boolean;
}

/** A stored `recipe_versions` row with its ingredient rows. */
export interface StoredVersionRow {
    id: string;
    version: number;
    name: string;
    description: string | null;
    icon_key: string;
    instructions: unknown;
    yield_servings: number;
    serving_description: string;
    prep_minutes: number;
    cook_minutes: number;
    total_minutes: number;
    meal_slots: string[];
    diet_tags: string[];
    allergen_tags: string[];
    allergen_status: string;
    budget_tier: number;
    badges: string[];
    nutrition_provenance: string;
    per_serving_calories: number;
    per_serving_protein_g: number;
    per_serving_carbs_g: number;
    per_serving_fat_g: number;
    sourced_calories_note: string | null;
    status: string;
    recipe_ingredients: StoredIngredientRow[];
}

/** A stored `recipes` row with its current version and the version numbers it has used. */
export interface StoredRecipeRow {
    id: string;
    slug: string;
    current_version_id: string | null;
    current_version: StoredVersionRow | null;
    recipe_versions: { version: number }[];
}

/** An ingredient row joined to the catalog facts `recipe_ingredients` does not snapshot. */
export interface JoinedIngredientRow extends StoredIngredientRow {
    catalog_foods: {
        food_group: string;
        allergen_status: string;
        cost_class: number;
        nutrition_basis: string;
        density_g_per_ml: number | null;
    };
}

/** A recipe read back for the coverage report: its current version, ingredients and their foods. */
export interface JoinedRecipeRow {
    slug: string;
    current_version: (Omit<StoredVersionRow, 'recipe_ingredients'> & {
        recipe_ingredients: JoinedIngredientRow[];
    }) | null;
}

/**
 * The narrow slice of the Prisma client this stage goes through.
 *
 * Declared structurally, like `catalog-import-usda.ts`'s `ImportDb`, so the
 * script-level suite can drive `runSeed` against any client that satisfies it
 * and so this file never depends on the generated client's shape beyond the
 * three models it touches. `findMany`/`findUnique` carry the row type as a
 * parameter because the same method serves three different selects here — the
 * full food row, its two version counters, and canonical names alone — and one
 * fixed return type for all three would be a fiction.
 */
// WHY THESE WRITES CARRY NO OWNER PREDICATE. Rule backend-architecture §5.1
// requires `user_id` in every `where`, including updates and deletes, because a
// write found by id alone is a cross-user write waiting to happen. The recipe
// and catalog tables are the sanctioned exception, and prisma/schema.prisma and
// AAP §0.5.1 both say so at the model: `recipes`, `recipe_versions`,
// `recipe_ingredients` and the two `catalog_*` tables read here hold SHARED
// REFERENCE DATA with no `user_id` BY DESIGN — every user plans from the same
// recipe corpus — so there is no tenant to scope to, and adding an owner column
// would be a mistake rather than a fix. No request-scoped identity can reach
// this file either: it runs only from an operator CLI, never behind
// `authenticateFirebaseToken`, so there is no verified token to scope by.
//
// The compensating controls are therefore about WHICH DATABASE and WHICH ROW
// rather than which user. scripts/lib/dbGuard.ts classifies `DATABASE_URL`
// before any client exists and, because `recipes-seed` is registered
// `development_or_confirmed`, demands `--confirm-target <dbname>` for any
// non-development origin; `slug` (unique) selects the recipe and `source_key`
// selects each ingredient's food, so no write here is found by a bare id.
export interface SeedDb {
    catalog_foods: {
        findMany<Row = SeedCatalogFoodRow>(args: unknown): Promise<Row[]>;
    };
    recipes: {
        findUnique<Row = StoredRecipeRow>(args: unknown): Promise<Row | null>;
        findMany<Row = JoinedRecipeRow>(args: unknown): Promise<Row[]>;
        create(args: unknown): Promise<{ id: string }>;
        update(args: unknown): Promise<{ id: string }>;
    };
    recipe_versions: {
        create(args: unknown): Promise<{ id: string; version: number }>;
        update(args: unknown): Promise<{ id: string }>;
    };
    $transaction<T>(work: (tx: SeedDb) => Promise<T>, options?: { timeout?: number }): Promise<T>;
}

/** What publishing one recipe did. */
export type PublishAction = 'created' | 'promoted' | 'unchanged';

export interface PublishResult {
    readonly slug: string;
    readonly action: PublishAction;
    /** The version number that is `current` after this call. */
    readonly version: number;
    readonly ingredientRows: number;
    /** Why a new version was published; `null` for a no-op. */
    readonly reason: string | null;
}

/**
 * The stored current version in the shape the planned one is compared against.
 *
 * `description` reads `?? ''` because the column is nullable and the payload's
 * is not: a null stored description and an empty planned one are the same
 * absence, and treating them as different would republish on every run.
 */
const toStoredContent = (
    version: StoredVersionRow,
): { version: PlannedRecipeVersion; ingredients: PlannedRecipeIngredient[] } => ({
    version: {
        name: version.name,
        description: version.description ?? '',
        icon_key: version.icon_key,
        instructions: version.instructions as string[],
        yield_servings: version.yield_servings,
        serving_description: version.serving_description,
        prep_minutes: version.prep_minutes,
        cook_minutes: version.cook_minutes,
        total_minutes: version.total_minutes,
        meal_slots: version.meal_slots,
        diet_tags: version.diet_tags,
        allergen_tags: version.allergen_tags,
        allergen_status: version.allergen_status,
        budget_tier: version.budget_tier,
        badges: version.badges,
        nutrition_provenance: version.nutrition_provenance,
        per_serving_calories: version.per_serving_calories,
        per_serving_protein_g: version.per_serving_protein_g,
        per_serving_carbs_g: version.per_serving_carbs_g,
        per_serving_fat_g: version.per_serving_fat_g,
        sourced_calories_note: version.sourced_calories_note,
    },
    ingredients: [...version.recipe_ingredients]
        .map((row) => ({
            catalog_food_id: row.catalog_food_id,
            catalog_nutrition_version: row.catalog_nutrition_version,
            catalog_metadata_version: row.catalog_metadata_version,
            snapshot_per_100g: row.snapshot_per_100g as RecipeIngredientNutrientSnapshot,
            snapshot_name: row.snapshot_name,
            snapshot_provenance: row.snapshot_provenance,
            snapshot_allergen_tags: row.snapshot_allergen_tags,
            snapshot_diet_tags: row.snapshot_diet_tags,
            quantity: row.quantity,
            unit: row.unit,
            gram_weight: row.gram_weight,
            display_text: row.display_text,
            sort_order: row.sort_order,
            is_optional: row.is_optional,
        }))
        .sort(bySortOrder),
});

/** A stored ingredient row in the shape `findStaleIngredients` reads. */
const toSnapshotForStaleness = (row: StoredIngredientRow): RecipeIngredientSnapshot => ({
    catalog_food_id: row.catalog_food_id,
    snapshot_name: row.snapshot_name,
    snapshot_provenance: row.snapshot_provenance as RecipePublicationIngredient['snapshot_provenance'],
    snapshot_allergen_tags: row.snapshot_allergen_tags,
    snapshot_diet_tags: row.snapshot_diet_tags,
    is_optional: row.is_optional,
    catalog_nutrition_version: row.catalog_nutrition_version,
    catalog_metadata_version: row.catalog_metadata_version,
    snapshot_per_100g: row.snapshot_per_100g as RecipeIngredientNutrientSnapshot,
    quantity: row.quantity,
    unit: row.unit,
    gram_weight: row.gram_weight,
    display_text: row.display_text,
    sort_order: row.sort_order,
});

/** The `recipe_versions` create payload, with its ingredient rows nested. */
const versionCreateData = (
    plan: RecipePublicationPlan,
    recipeId: string,
    version: number,
    now: Date,
): Record<string, unknown> => ({
    recipe_id: recipeId,
    version,
    name: plan.version.name,
    description: plan.version.description,
    icon_key: plan.version.icon_key,
    instructions: [...plan.version.instructions],
    yield_servings: plan.version.yield_servings,
    serving_description: plan.version.serving_description,
    prep_minutes: plan.version.prep_minutes,
    cook_minutes: plan.version.cook_minutes,
    total_minutes: plan.version.total_minutes,
    meal_slots: [...plan.version.meal_slots],
    diet_tags: [...plan.version.diet_tags],
    allergen_tags: [...plan.version.allergen_tags],
    allergen_status: plan.version.allergen_status,
    budget_tier: plan.version.budget_tier,
    badges: [...plan.version.badges],
    nutrition_provenance: plan.version.nutrition_provenance,
    per_serving_calories: plan.version.per_serving_calories,
    per_serving_protein_g: plan.version.per_serving_protein_g,
    per_serving_carbs_g: plan.version.per_serving_carbs_g,
    per_serving_fat_g: plan.version.per_serving_fat_g,
    sourced_calories_note: plan.version.sourced_calories_note,
    status: CURRENT_VERSION_STATUS,
    published_at: now,
    recipe_ingredients: {
        create: plan.ingredients.map((ingredient) => ({
            catalog_food_id: ingredient.catalog_food_id,
            catalog_nutrition_version: ingredient.catalog_nutrition_version,
            catalog_metadata_version: ingredient.catalog_metadata_version,
            snapshot_per_100g: ingredient.snapshot_per_100g,
            snapshot_name: ingredient.snapshot_name,
            snapshot_provenance: ingredient.snapshot_provenance,
            snapshot_allergen_tags: [...ingredient.snapshot_allergen_tags],
            snapshot_diet_tags: [...ingredient.snapshot_diet_tags],
            quantity: ingredient.quantity,
            unit: ingredient.unit,
            gram_weight: ingredient.gram_weight,
            display_text: ingredient.display_text,
            sort_order: ingredient.sort_order,
            is_optional: ingredient.is_optional,
        })),
    },
});

const RECIPE_READ_INCLUDE = {
    current_version: { include: { recipe_ingredients: true } },
    recipe_versions: { select: { version: true } },
};

/**
 * Publishes one validated recipe, or leaves it alone.
 *
 * ONE TRANSACTION, and inside it the order is load-bearing:
 * `prisma/migrations/20260908000000_meal_planning/migration.sql:505` creates the
 * NON-DEFERRABLE partial unique index `unique_current_recipe_version ON
 * recipe_versions(recipe_id) WHERE status = 'current'`, so inserting the new
 * current row before retiring the old one fails the statement. Retire, insert,
 * then move `recipes.current_version_id` — and because it is one transaction,
 * a failure anywhere leaves the recipe exactly as current as it was.
 *
 * An existing version is NEVER edited. A version is the record of what a plan
 * was built from and what a diary entry logged, so its content is immutable and
 * `status`/`retired_at` are the only columns a later run may touch.
 *
 * The decision is taken INSIDE the transaction, from the rows it reads there:
 * deciding outside it would let a concurrent run publish between the read and
 * the write, and the loser would insert a second `current` row.
 */
export const publishRecipe = async (
    db: SeedDb,
    plan: RecipePublicationPlan,
    now: Date,
    currentCatalogVersions: ReadonlyMap<string, CatalogIngredientVersions>,
): Promise<PublishResult> =>
    db.$transaction(
        async (tx) => {
            const stored = await tx.recipes.findUnique<StoredRecipeRow>({
                where: { slug: plan.slug },
                include: RECIPE_READ_INCLUDE,
            });

            if (stored === null) {
                const recipe = await tx.recipes.create({ data: { slug: plan.slug } });
                const version = await tx.recipe_versions.create({
                    data: versionCreateData(plan, recipe.id, FIRST_VERSION, now),
                });
                await tx.recipes.update({
                    where: { id: recipe.id },
                    data: { current_version_id: version.id },
                });

                return {
                    slug: plan.slug,
                    action: 'created' as const,
                    version: FIRST_VERSION,
                    ingredientRows: plan.ingredients.length,
                    reason: 'no recipes row existed',
                };
            }

            const current = stored.current_version;
            const reasons: string[] = [];

            if (current === null) {
                // A recipes row whose current version is gone — a version
                // retired by hand, or a `SetNull` from a deleted version. It is
                // unplannable until a version is current again, so republishing
                // is the repair rather than a no-op.
                reasons.push('no current version was stored');
            } else {
                const differences = compareStoredContent(toStoredContent(current), plan);
                if (differences.length > 0) {
                    reasons.push(
                        `content changed in ${differences.map((difference) => difference.field).join(', ')}`,
                    );
                }

                const stale = findStaleIngredients(
                    current.recipe_ingredients.map(toSnapshotForStaleness),
                    currentCatalogVersions,
                );
                if (stale.length > 0) {
                    reasons.push(
                        `stale ingredient snapshot: ${stale
                            .map((ingredient) => `${ingredient.name} (${ingredient.changed.join(', ')})`)
                            .join('; ')}`,
                    );
                }
            }

            if (reasons.length === 0 && current !== null) {
                return {
                    slug: plan.slug,
                    action: 'unchanged' as const,
                    version: current.version,
                    ingredientRows: current.recipe_ingredients.length,
                    reason: null,
                };
            }

            const highestVersion = stored.recipe_versions.reduce(
                (highest, row) => Math.max(highest, row.version),
                0,
            );
            const nextVersion = highestVersion + 1;

            if (current !== null) {
                await tx.recipe_versions.update({
                    where: { id: current.id },
                    data: { status: RETIRED_VERSION_STATUS, retired_at: now },
                });
            }

            const version = await tx.recipe_versions.create({
                data: versionCreateData(plan, stored.id, nextVersion, now),
            });
            await tx.recipes.update({ where: { id: stored.id }, data: { current_version_id: version.id } });

            return {
                slug: plan.slug,
                action: 'promoted' as const,
                version: nextVersion,
                ingredientRows: plan.ingredients.length,
                reason: reasons.join(' | '),
            };
        },
        { timeout: PUBLISH_TRANSACTION_TIMEOUT_MS },
    );

/* ---------------------------------------------------------------------------
 * The coverage report
 *
 * §0.7.3's diet x single-allergen x slot x time-tier table, and the documented
 * boundary of what the seed set promises. Every cell is decided by
 * `recipe.logic.ts::isEligibleForPlanning` — the same function plan generation,
 * swap alternatives and incompatibility flagging come through — so the report
 * cannot promise a profile the planner would refuse.
 *
 * It is derived FROM THE DATABASE, after the writes: a table computed from the
 * files would describe a corpus that may not be what is stored, which is the
 * one thing this artefact exists to rule out.
 * ------------------------------------------------------------------------- */

/** The schema version of the emitted document, bumped when its shape changes. */
const COVERAGE_REPORT_SCHEMA_VERSION = 1;

/** `none` is the mutually exclusive "no allergy" answer, not a tag any food carries. */
const NO_ALLERGEN = 'none';

const COVERAGE_DIETS: readonly RecipeDietPreference[] = ['none', 'vegetarian', 'vegan', 'pescatarian'];

/** The nine named allergens of the preference list, with the no-allergen column first. */
const COVERAGE_ALLERGENS: readonly string[] = [
    NO_ALLERGEN,
    'milk',
    'eggs',
    'peanuts',
    'tree_nuts',
    'soy',
    'wheat',
    'fish',
    'shellfish',
    'sesame',
];

const COVERAGE_SLOTS: readonly MealSlot[] = MEAL_SLOTS;

/** Breakfast, lunch and dinner: the slots §0.7.3 states a guaranteed profile for. */
const COVERAGE_MAIN_SLOTS: readonly MealSlot[] = COVERAGE_SLOTS.slice(0, 3);

/** The four `cooking_time_limit_min` answers, as cumulative ceilings. */
const COVERAGE_TIME_TIERS: readonly number[] = [15, 30, 45, 60];

/** The loosest tier: the one the slot-composition strata are measured at. */
const LOOSEST_TIME_TIER = COVERAGE_TIME_TIERS[COVERAGE_TIME_TIERS.length - 1];

/** A guaranteed cell holds at least this many recipes — what the repeat rule needs for a week. */
const GUARANTEED_THRESHOLD = 4;

/** A reduced cell holds at least this many, which is explicitly NOT enough for a week. */
const REDUCED_THRESHOLD = 2;

/** The tier from which a profile counts as guaranteed with no allergen excluded. */
const GUARANTEED_MIN_TIME_TIER = 45;

/** The tier the reduced clause measures every diet at with no allergen excluded. */
const REDUCED_TIME_TIER = 30;

/** The diets §0.7.3's reduced clause names beside a single allergen. */
const REDUCED_DIETS: readonly RecipeDietPreference[] = ['vegetarian', 'vegan'];

/** §0.7.3's repeat rule: at most two uses a week, never on consecutive days. */
const REPEAT_RULE = {
    maxUsesPerWeek: 2,
    consecutiveDaysAllowed: false,
    minEligiblePerSlotForFullWeek: GUARANTEED_THRESHOLD,
    note:
        'A recipe may be used at most twice in a week and never on consecutive days, so filling seven days of one slot needs at least four eligible recipes. A cell that only meets the reduced threshold of two is NOT sufficient to fill a week for that slot.',
} as const;

/**
 * What every cell means, carried in the artefact so it stays self-describing:
 * a reader of the committed file can check a count by hand without this source.
 */
const ELIGIBILITY_RULE = {
    mirrors: 'src/services/recipe.logic.ts::isEligibleForPlanning',
    clauses: [
        { axis: 'slot', rule: 'the recipe\'s mealSlots contains the slot' },
        { axis: 'diet', rule: 'the diet is \'none\', or the recipe\'s diet tags contain the diet code' },
        { axis: 'allergen', rule: 'the allergen is \'none\', or the recipe\'s allergen tags do not contain it' },
        {
            axis: 'allergenStatus',
            rule: 'the recipe\'s allergenStatus is \'known\' and every ingredient\'s allergen review is \'known\'',
        },
        { axis: 'time', rule: 'prepMinutes + cookMinutes <= timeTier' },
    ],
    dietTagMatching:
        'The diet code is matched against the recipe\'s derived diet tags by exact normalised tag, with no hierarchy re-derivation at count time: containment is already closed into the tags themselves (vegan implies vegetarian implies pescatarian). Seafood admissibility is carried by that same \'pescatarian\' tag and by no other spelling. An earlier revision of the catalog release spelled it \'pescatarian_ok\', which the \'pescatarian\' diet code does not match, so every fish and seafood recipe - having no vegetarian tag for the implication closure to rescue - counted under \'none\' alone and the furtherPescatarian stratum of every main slot read zero. The release, the manifest vocabulary it is imported under and the authored recipe dietTags have since been aligned to \'pescatarian\', so a seafood recipe now counts for the pescatarian diet as intended.',
    recipeTagsAreDerived:
        'Each recipe\'s diet and allergen tags were verified equal to the values derived from its ingredient snapshots, so counting from the declared arrays and counting from the derivation give the same answer.',
    dislikesExcluded:
        'Dislikes are per-user and remove recipes at request time, so they are not an axis of this table; dislike-driven shortfalls surface in the planner\'s catalog_coverage check.',
    timeTiersCumulative:
        'Tiers are cumulative ceilings, so counts are monotonically non-decreasing across 15, 30, 45 and 60 for every diet, allergen and slot triple.',
} as const;

const SLOT_COMPOSITION_NOTES = {
    strata:
        'The four strata partition the recipes eligible for the slot with no allergen excluded at the loosest time tier: vegan; vegetarian but not vegan; pescatarian but not vegetarian; eligible under no diet restriction but not pescatarian. They sum to totalEligible.',
    floors:
        'A floor of null means AAP 0.7.3 states no floor for that stratum at that slot, which is not the same as a floor of zero.',
    crossListing:
        'totalEligible exceeds dedicatedToSlot for lunch and dinner because cross-listed recipes declare both slots and are eligible in each. Cross-listing only adds eligibility; dedicatedToSlot is the auditable floor of recipes authored to that slot alone.',
} as const;

/**
 * The boundary statement §0.7.3 requires the artefact to carry: the table is
 * what the seed PROMISES, and a profile outside it is still served — by the
 * planner's own coverage check, which answers `no_matching_meals` with the
 * limiting-constraint `editStep` rather than an empty plan.
 */
const BOUNDARY_STATEMENT =
    'This report is the documented boundary of what the seed set promises, not a claim that every user profile can be planned. Combinations outside guaranteedCells and reducedCells — two or more excluded allergens, a narrow diet combined with an allergen at the tightest time tier, or dislikes that remove a recipe a guaranteed cell counted — are supported at runtime but not guaranteed. The planner evaluates the user\'s real diet, allergen and dislike intersection and answers 422 no_matching_meals with a limiting-constraint editStep naming what to change, so such a user is told which preference is narrowing the week rather than shown an empty plan.';

/** §0.7.3's per-stratum floors for a main slot: 4 vegan, 3 further vegetarian, 2 further pescatarian, 3 further omnivore. */
const MAIN_SLOT_FLOORS = {
    vegan: 4,
    furtherVegetarian: 3,
    furtherPescatarian: 2,
    furtherOmnivore: 3,
} as const;

/** §0.7.3 states two floors for snacks and none for the other two strata. */
const SNACK_FLOORS = {
    vegan: 4,
    furtherVegetarian: 2,
    furtherPescatarian: null,
    furtherOmnivore: null,
} as const;

export interface CoverageCell {
    readonly diet: string;
    readonly allergen: string;
    readonly slot: string;
    readonly timeTier: number;
    readonly count: number;
}

export interface CoverageThresholdCell extends CoverageCell {
    readonly threshold: number;
}

export interface CoverageStratum {
    readonly floor: number | null;
    readonly count: number;
}

export interface SlotComposition {
    readonly dedicatedToSlot: number;
    readonly totalEligible: number;
    readonly composition: {
        readonly vegan: CoverageStratum;
        readonly furtherVegetarian: CoverageStratum;
        readonly furtherPescatarian: CoverageStratum;
        readonly furtherOmnivore: CoverageStratum;
    };
}

export interface CoverageReport {
    readonly schemaVersion: number;
    readonly recipeCount: number;
    readonly crossListedRecipeCount: number;
    readonly dimensions: {
        readonly diets: readonly string[];
        readonly allergens: readonly string[];
        readonly slots: readonly string[];
        readonly mainSlots: readonly string[];
        readonly timeTiers: readonly number[];
    };
    readonly eligibilityRule: typeof ELIGIBILITY_RULE;
    readonly repeatRule: typeof REPEAT_RULE;
    readonly slotComposition: Readonly<Record<string, SlotComposition>>;
    readonly slotCompositionNotes: typeof SLOT_COMPOSITION_NOTES;
    readonly eligibleCounts: readonly CoverageCell[];
    readonly guaranteedCells: readonly CoverageThresholdCell[];
    readonly reducedCells: readonly CoverageThresholdCell[];
    readonly boundary: string;
}

/** One seeded recipe as the report counts it. */
export interface CoverageRecipe {
    readonly slug: string;
    readonly mealSlots: readonly string[];
    /** The DERIVED diet tags, which is what the stratum split reads. */
    readonly dietTags: readonly string[];
    readonly version: PlanningRecipeVersion;
}

const coveragePreferences = (
    diet: RecipeDietPreference,
    allergen: string,
    timeTier: number,
): PlanningPreferences => ({
    diet,
    // `none` means "no allergen excluded", which is an EMPTY list and never the
    // literal tag: matching `none` against a food's tags would exclude every
    // food for the user who declared no allergy at all.
    allergens: allergen === NO_ALLERGEN ? [] : [allergen],
    // Dislikes are per-user and are not an axis of this table.
    disliked_food_ids: [],
    disliked_food_groups: [],
    cooking_time_limit_min: timeTier,
});

const carriesDietTag = (recipe: CoverageRecipe, tag: string): boolean => {
    const target = normalizeCanonicalName(tag);
    return recipe.dietTags.some((candidate) => normalizeCanonicalName(candidate) === target);
};

const eligibleForSlot = (
    recipes: readonly CoverageRecipe[],
    diet: RecipeDietPreference,
    allergen: string,
    slot: MealSlot,
    timeTier: number,
): CoverageRecipe[] =>
    recipes.filter((recipe) =>
        isEligibleForPlanning(recipe.version, coveragePreferences(diet, allergen, timeTier), slot),
    );

const stratumOf = (recipe: CoverageRecipe): keyof typeof MAIN_SLOT_FLOORS => {
    if (carriesDietTag(recipe, 'vegan')) {
        return 'vegan';
    }
    if (carriesDietTag(recipe, 'vegetarian')) {
        return 'furtherVegetarian';
    }
    if (carriesDietTag(recipe, 'pescatarian')) {
        return 'furtherPescatarian';
    }

    return 'furtherOmnivore';
};

/**
 * The §0.7.3 coverage table, derived from the seeded recipes.
 *
 * Pure and exported: the report is the artefact reviewers read and
 * `seed-rerun.test.ts` asserts against, so the derivation is unit-testable from
 * plain objects with no database in the way. Key and array order are fixed by
 * the loops below rather than by any map iteration, which is what makes a rerun
 * byte-identical.
 */
export const deriveCoverageReport = (recipes: readonly CoverageRecipe[]): CoverageReport => {
    const eligibleCounts: CoverageCell[] = [];
    for (const diet of COVERAGE_DIETS) {
        for (const allergen of COVERAGE_ALLERGENS) {
            for (const slot of COVERAGE_SLOTS) {
                for (const timeTier of COVERAGE_TIME_TIERS) {
                    eligibleCounts.push({
                        diet,
                        allergen,
                        slot,
                        timeTier,
                        count: eligibleForSlot(recipes, diet, allergen, slot, timeTier).length,
                    });
                }
            }
        }
    }

    const countOf = new Map(
        eligibleCounts.map((cell) => [`${cell.diet}|${cell.allergen}|${cell.slot}|${cell.timeTier}`, cell.count]),
    );
    const cellAt = (
        diet: string,
        allergen: string,
        slot: string,
        timeTier: number,
        threshold: number,
    ): CoverageThresholdCell => ({
        diet,
        allergen,
        slot,
        timeTier,
        threshold,
        count: countOf.get(`${diet}|${allergen}|${slot}|${timeTier}`) ?? 0,
    });

    // GUARANTEED (>= 4 eligible, which is what the repeat rule needs for a
    // seven-day week): every diet with no allergen at 45 minutes or looser, for
    // every slot; and the `none` diet with any single allergen at any tier, for
    // every main slot.
    const guaranteedCells: CoverageThresholdCell[] = [];
    for (const diet of COVERAGE_DIETS) {
        for (const slot of COVERAGE_SLOTS) {
            for (const timeTier of COVERAGE_TIME_TIERS) {
                if (timeTier >= GUARANTEED_MIN_TIME_TIER) {
                    guaranteedCells.push(cellAt(diet, NO_ALLERGEN, slot, timeTier, GUARANTEED_THRESHOLD));
                }
            }
        }
    }
    for (const allergen of COVERAGE_ALLERGENS) {
        if (allergen === NO_ALLERGEN) {
            continue;
        }
        for (const slot of COVERAGE_MAIN_SLOTS) {
            for (const timeTier of COVERAGE_TIME_TIERS) {
                guaranteedCells.push(cellAt('none', allergen, slot, timeTier, GUARANTEED_THRESHOLD));
            }
        }
    }

    // REDUCED (>= 2 eligible, asserted and explicitly NOT sufficient for the
    // repeat rule): vegan or vegetarian with any single allergen at 45 minutes
    // or looser, for every main slot; and every diet with no allergen at the
    // 30-minute tier, for every slot. Disjoint from the guaranteed set by
    // construction — the first clause excludes the `none` diet and the second
    // sits below the guaranteed tier.
    const reducedCells: CoverageThresholdCell[] = [];
    for (const diet of COVERAGE_DIETS) {
        if (!REDUCED_DIETS.includes(diet)) {
            continue;
        }
        for (const allergen of COVERAGE_ALLERGENS) {
            if (allergen === NO_ALLERGEN) {
                continue;
            }
            for (const slot of COVERAGE_MAIN_SLOTS) {
                for (const timeTier of COVERAGE_TIME_TIERS) {
                    if (timeTier >= GUARANTEED_MIN_TIME_TIER) {
                        reducedCells.push(cellAt(diet, allergen, slot, timeTier, REDUCED_THRESHOLD));
                    }
                }
            }
        }
    }
    for (const diet of COVERAGE_DIETS) {
        for (const slot of COVERAGE_SLOTS) {
            reducedCells.push(cellAt(diet, NO_ALLERGEN, slot, REDUCED_TIME_TIER, REDUCED_THRESHOLD));
        }
    }

    const slotComposition: Record<string, SlotComposition> = {};
    for (const slot of COVERAGE_SLOTS) {
        const eligible = eligibleForSlot(recipes, 'none', NO_ALLERGEN, slot, LOOSEST_TIME_TIER);
        const floors = slot === 'snack' ? SNACK_FLOORS : MAIN_SLOT_FLOORS;
        const counted: Record<keyof typeof MAIN_SLOT_FLOORS, number> = {
            vegan: 0,
            furtherVegetarian: 0,
            furtherPescatarian: 0,
            furtherOmnivore: 0,
        };
        for (const recipe of eligible) {
            counted[stratumOf(recipe)] += 1;
        }

        slotComposition[slot] = {
            dedicatedToSlot: recipes.filter(
                (recipe) => recipe.mealSlots.length === 1 && recipe.mealSlots[0] === slot,
            ).length,
            totalEligible: eligible.length,
            composition: {
                vegan: { floor: floors.vegan, count: counted.vegan },
                furtherVegetarian: { floor: floors.furtherVegetarian, count: counted.furtherVegetarian },
                furtherPescatarian: { floor: floors.furtherPescatarian, count: counted.furtherPescatarian },
                furtherOmnivore: { floor: floors.furtherOmnivore, count: counted.furtherOmnivore },
            },
        };
    }

    return {
        schemaVersion: COVERAGE_REPORT_SCHEMA_VERSION,
        recipeCount: recipes.length,
        crossListedRecipeCount: recipes.filter((recipe) => recipe.mealSlots.length > 1).length,
        dimensions: {
            diets: COVERAGE_DIETS,
            allergens: COVERAGE_ALLERGENS,
            slots: COVERAGE_SLOTS,
            mainSlots: COVERAGE_MAIN_SLOTS,
            timeTiers: COVERAGE_TIME_TIERS,
        },
        eligibilityRule: ELIGIBILITY_RULE,
        repeatRule: REPEAT_RULE,
        slotComposition,
        slotCompositionNotes: SLOT_COMPOSITION_NOTES,
        eligibleCounts,
        guaranteedCells,
        reducedCells,
        boundary: BOUNDARY_STATEMENT,
    };
};

/**
 * A recipe read back from the database in the shape the report counts.
 *
 * `allergen_status`, `food_group`, the nutrition basis and its density come
 * from the JOINED `catalog_foods` row because `recipe_ingredients` does not
 * snapshot them — the same join `recipe.service.ts` performs at read time — and
 * the eligibility rule reads all four.
 */
export const toCoverageRecipe = (row: JoinedRecipeRow): CoverageRecipe => {
    const version = row.current_version;
    if (version === null) {
        throw new RecipeSeedError(
            'publication_failed',
            `${row.slug}: no current version is stored, so the coverage report cannot count it`,
        );
    }

    const ingredients: RecipePublicationIngredient[] = version.recipe_ingredients.map((ingredient) => ({
        catalog_food_id: ingredient.catalog_food_id,
        snapshot_name: ingredient.snapshot_name,
        snapshot_provenance: ingredient.snapshot_provenance as RecipePublicationIngredient['snapshot_provenance'],
        snapshot_allergen_tags: ingredient.snapshot_allergen_tags,
        snapshot_diet_tags: ingredient.snapshot_diet_tags,
        is_optional: ingredient.is_optional,
        food_group: ingredient.catalog_foods.food_group,
        allergen_status: ingredient.catalog_foods.allergen_status as RecipeAllergenStatus,
        cost_class: ingredient.catalog_foods.cost_class,
        catalog_nutrition_version: ingredient.catalog_nutrition_version,
        catalog_metadata_version: ingredient.catalog_metadata_version,
        snapshot_per_100g: ingredient.snapshot_per_100g as RecipeIngredientNutrientSnapshot,
        quantity: ingredient.quantity,
        unit: ingredient.unit,
        gram_weight: ingredient.gram_weight,
        display_text: ingredient.display_text,
        sort_order: ingredient.sort_order,
        nutrition_basis: ingredient.catalog_foods.nutrition_basis as RecipeNutritionBasis,
        density_g_per_ml: ingredient.catalog_foods.density_g_per_ml,
    }));

    return {
        slug: row.slug,
        mealSlots: version.meal_slots,
        // DERIVED from the snapshots rather than read from the summary column,
        // exactly as the eligibility rule derives them: the column is a record
        // of that derivation and the two must never be able to disagree.
        dietTags: deriveDietTags(ingredients),
        version: {
            status: version.status === CURRENT_VERSION_STATUS ? 'current' : 'retired',
            nutrition_provenance:
                version.nutrition_provenance as PlanningRecipeVersion['nutrition_provenance'],
            allergen_status: version.allergen_status as RecipeAllergenStatus,
            total_minutes: version.total_minutes,
            meal_slots: version.meal_slots,
            ingredients,
        },
    };
};

const COVERAGE_READ_INCLUDE = {
    current_version: {
        include: {
            recipe_ingredients: {
                include: {
                    catalog_foods: {
                        select: {
                            food_group: true,
                            allergen_status: true,
                            cost_class: true,
                            nutrition_basis: true,
                            density_g_per_ml: true,
                        },
                    },
                },
                orderBy: { sort_order: 'asc' },
            },
        },
    },
};

/* ---------------------------------------------------------------------------
 * The stage.
 * ------------------------------------------------------------------------- */

export interface SeedDeps {
    /** The narrow client slice this stage writes through. */
    readonly prisma: SeedDb;
    /** Absolute path to the recipe directory; injected so a suite seeds a temporary corpus. */
    readonly recipesDir: string;
    /** The publication clock. Injected so `published_at` is an assertable value in a suite. */
    readonly now: () => Date;
    readonly options: SeedOptions;
    readonly logger: ScriptLogger;
    /** The food-group taxonomy half of the instruction vocabulary. */
    readonly coveragePlan: CoveragePlan;
    /**
     * Absolute path the coverage report is written to. Injected for the same
     * reason as the directory: a suite must be able to produce the artefact
     * without overwriting the committed one.
     */
    readonly reportPath: string;
    readonly writeReport: (absolutePath: string, value: unknown) => void;
}

export interface SeedOutcome {
    readonly selected: readonly string[];
    readonly created: readonly string[];
    readonly promoted: readonly string[];
    readonly unchanged: readonly string[];
    /** Ingredient rows the run wrote; zero for a no-op rerun and for a dry run. */
    readonly ingredientRows: number;
    readonly dryRun: boolean;
    readonly report: CoverageReport | null;
    readonly reportPath: string | null;
    /** Why no report was written, or `null` when one was. */
    readonly reportSkippedReason: string | null;
}

/**
 * Reads the two catalog facts the run needs: the full row for every ingredient
 * the corpus names, and the version counters of every food an already-stored
 * version points at.
 *
 * The second read is what lets `findStaleIngredients` tell "this food's
 * metadata moved" from "this food is gone", rather than reporting a food it
 * simply never asked about as absent.
 */
const readCatalogFacts = async (
    db: SeedDb,
    sourceKeys: readonly string[],
): Promise<Map<string, SeedCatalogFoodRow>> => {
    if (sourceKeys.length === 0) {
        return new Map();
    }

    const foods = await db.catalog_foods.findMany<SeedCatalogFoodRow>({
        where: { source_key: { in: [...sourceKeys] } },
        orderBy: { source_key: 'asc' },
        include: { catalog_food_portions: { select: { is_default: true, gram_weight: true } } },
    });

    return new Map(foods.map((food) => [food.source_key, food]));
};

/**
 * Publishes the curated recipe files as versioned recipes.
 *
 * The stage in one function, in the order §0.7.3 requires: read, resolve,
 * validate EVERYTHING, then write, then derive the report from what was
 * written. The validation pass is complete before the first write because a
 * partially seeded corpus is worse than an unseeded one — the planner's
 * coverage check would answer from an incomplete set.
 */
export const runSeed = async (deps: SeedDeps): Promise<SeedOutcome> => {
    const { logger, options, prisma } = deps;

    const { payloads, problems: payloadProblems } = readRecipeFiles(deps.recipesDir, options.only);
    logger.info('recipes_read', {
        stage: STAGE,
        files: payloads.length,
        unparsable: payloadProblems.length,
        only: [...options.only],
        dryRun: options.dryRun,
    });

    const sourceKeys = [...new Set(payloads.flatMap((payload) => payload.ingredients.map((i) => i.sourceKey)))].sort();
    const foodsBySourceKey = await readCatalogFacts(prisma, sourceKeys);

    // The whole published table's canonical names, one column wide: the
    // instruction-completeness vocabulary is only as good as the catalog behind
    // it, and a narrowed read would let a term pass because this run happened
    // not to select the recipe that names it.
    const publishedNames = await prisma.catalog_foods.findMany<{ canonical_name: string }>({
        where: { publication_status: PUBLISHED_STATUS },
        select: { canonical_name: true },
        orderBy: { canonical_name: 'asc' },
    });
    const vocabulary = buildIngredientVocabulary(
        deps.coveragePlan.foodGroups.map((entry) => entry.foodGroup),
        publishedNames.map((row) => row.canonical_name),
    );
    logger.info('vocabulary_built', {
        stage: STAGE,
        foodGroups: deps.coveragePlan.foodGroups.length,
        publishedCanonicalNames: publishedNames.length,
        singleWordTerms: vocabulary.singleWordTerms.size,
        multiWordTerms: vocabulary.multiWordTerms.length,
        resolvableIngredients: foodsBySourceKey.size,
        referencedIngredients: sourceKeys.length,
    });

    const plans: RecipePublicationPlan[] = [];
    const problems: string[] = [...payloadProblems];
    for (const payload of payloads) {
        const validation = validateRecipeFile(payload, foodsBySourceKey, vocabulary);
        if (validation.plan === null) {
            problems.push(...validation.problems);
            continue;
        }
        plans.push(validation.plan);
    }

    if (problems.length > 0) {
        // Loudly, with every defect, and before any write: §0.7.3's "fails
        // loudly and nothing is published".
        logger.error('recipes_rejected', {
            stage: STAGE,
            files: payloads.length,
            problemCount: problems.length,
            problems,
        });
        throw new RecipeSeedError(
            'recipes_invalid',
            `${problems.length} problem${problems.length === 1 ? '' : 's'} in the selected recipe files; nothing was published`,
            problems,
        );
    }

    logger.info('recipes_validated', {
        stage: STAGE,
        recipes: plans.length,
        ingredientRows: plans.reduce((total, plan) => total + plan.ingredients.length, 0),
    });

    if (options.dryRun) {
        const reason = 'dry run: every file was validated and nothing was written';
        logger.info('dry_run_completed', { stage: STAGE, recipes: plans.length, note: reason });

        return {
            selected: plans.map((plan) => plan.slug),
            created: [],
            promoted: [],
            unchanged: [],
            ingredientRows: 0,
            dryRun: true,
            report: null,
            reportPath: null,
            reportSkippedReason: reason,
        };
    }

    const currentCatalogVersions = new Map<string, CatalogIngredientVersions>(
        [...foodsBySourceKey.values()].map((food) => [
            food.id,
            {
                catalog_nutrition_version: food.nutrition_version,
                catalog_metadata_version: food.metadata_version,
            },
        ]),
    );
    // Every food a STORED version points at, whether or not the corpus still
    // names it, so a food that is present but unreferenced is not mistaken for
    // one that is gone. A retired food is included deliberately: it may keep
    // backing the version it was published into, and only `describeUnpublishable
    // Food` refuses it for a NEW one.
    const storedFoodIds = new Set<string>();
    for (const plan of plans) {
        const stored = await prisma.recipes.findUnique<StoredRecipeRow>({
            where: { slug: plan.slug },
            include: RECIPE_READ_INCLUDE,
        });
        for (const ingredient of stored?.current_version?.recipe_ingredients ?? []) {
            if (!currentCatalogVersions.has(ingredient.catalog_food_id)) {
                storedFoodIds.add(ingredient.catalog_food_id);
            }
        }
    }
    if (storedFoodIds.size > 0) {
        const storedFoods = await prisma.catalog_foods.findMany<{
            id: string;
            nutrition_version: number;
            metadata_version: number;
        }>({
            where: { id: { in: [...storedFoodIds] } },
            select: { id: true, nutrition_version: true, metadata_version: true },
        });
        for (const food of storedFoods) {
            currentCatalogVersions.set(food.id, {
                catalog_nutrition_version: food.nutrition_version,
                catalog_metadata_version: food.metadata_version,
            });
        }
    }

    const now = deps.now();
    const created: string[] = [];
    const promoted: string[] = [];
    const unchanged: string[] = [];
    let ingredientRows = 0;

    for (const plan of plans) {
        const result = await publishRecipe(prisma, plan, now, currentCatalogVersions);

        if (result.action === 'created') {
            created.push(result.slug);
            ingredientRows += result.ingredientRows;
            logger.info('recipe_published', {
                stage: STAGE,
                slug: result.slug,
                version: result.version,
                ingredientRows: result.ingredientRows,
            });
            continue;
        }
        if (result.action === 'promoted') {
            promoted.push(result.slug);
            ingredientRows += result.ingredientRows;
            logger.info('recipe_version_promoted', {
                stage: STAGE,
                slug: result.slug,
                version: result.version,
                ingredientRows: result.ingredientRows,
                reason: result.reason,
            });
            continue;
        }

        unchanged.push(result.slug);
        logger.debug('recipe_unchanged', { stage: STAGE, slug: result.slug, version: result.version });
    }

    logger.info('recipes_published', {
        stage: STAGE,
        created: created.length,
        promoted: promoted.length,
        unchanged: unchanged.length,
        ingredientRows,
    });

    // A NARROWED RUN MUST NOT WRITE THE REPORT. The table is a claim about the
    // whole corpus, and the committed artefact is reviewed as a diff, so
    // emitting one recipe's view of it would replace forty-two recipes' numbers
    // with one's.
    if (options.only.length > 0) {
        const reason = `run narrowed to ${options.only.length} slug${options.only.length === 1 ? '' : 's'}, so the whole-corpus coverage report was not rewritten`;
        logger.warn('coverage_report_skipped', { stage: STAGE, note: reason, only: [...options.only] });

        return {
            selected: plans.map((plan) => plan.slug),
            created,
            promoted,
            unchanged,
            ingredientRows,
            dryRun: false,
            report: null,
            reportPath: null,
            reportSkippedReason: reason,
        };
    }

    const seeded = await prisma.recipes.findMany<JoinedRecipeRow>({
        orderBy: { slug: 'asc' },
        include: COVERAGE_READ_INCLUDE,
    });
    const report = deriveCoverageReport(seeded.map(toCoverageRecipe));
    deps.writeReport(deps.reportPath, report);
    logger.info('coverage_report_written', {
        stage: STAGE,
        recipeCount: report.recipeCount,
        crossListedRecipeCount: report.crossListedRecipeCount,
        cells: report.eligibleCounts.length,
        guaranteedCells: report.guaranteedCells.length,
        reducedCells: report.reducedCells.length,
    });

    return {
        selected: plans.map((plan) => plan.slug),
        created,
        promoted,
        unchanged,
        ingredientRows,
        dryRun: false,
        report,
        reportPath: deps.reportPath,
        reportSkippedReason: null,
    };
};

// ---------------------------------------------------------------------------
// Reporting.
// ---------------------------------------------------------------------------

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

// Every error class this file can observe gets its own reported code; anything
// unrecognised is reported through safeError under `unexpected_error` rather
// than swallowed or printed raw.
export const describeFailure = (error: unknown): { code: string; error: { name: string; message: string } } => {
    if (error instanceof RecipeSeedError) {
        return { code: error.code, error: safeError(error) };
    }
    if (error instanceof DatabaseOriginError) {
        return { code: error.code, error: safeError(error) };
    }
    if (error instanceof ManifestError) {
        return { code: error.code, error: safeError(error) };
    }
    if (error instanceof RecipeDerivationError) {
        return { code: 'recipe_derivation_failed', error: safeError(error) };
    }
    if (error instanceof UnitConversionError) {
        return { code: 'unit_conversion_failed', error: safeError(error) };
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

    // Reaching this line means dbGuard already accepted the origin — including,
    // for a non-development one, the --confirm-target it owns.
    const origin = classifyDatabaseOrigin(process.env.DATABASE_URL);
    logger.info('database_origin_accepted', {
        stage: STAGE,
        originClass: origin.originClass,
        host: origin.host,
        database: origin.database,
        reason: origin.reason,
    });
    logger.info('stage_invoked', { stage: STAGE, only: parsed.options.only, dryRun: parsed.options.dryRun });

    const gaps = preflight(defaultPreflightDeps());
    if (gaps.length > 0) {
        logger.error('stage_prerequisites_unmet', gapFields(gaps));
        return 1;
    }

    // Every input is present, so the stage runs. The Prisma client is reached
    // HERE rather than at module load: `src/prisma/client.ts` constructs the
    // client on import, and the suites that read parseArgs, preflight and the
    // pure derivations above must be able to do so without one.
    const { prisma } = await import('../src/prisma/client');

    try {
        const outcome = await runSeed({
            prisma: prisma as unknown as SeedDb,
            recipesDir: recipesDir(),
            now: () => new Date(),
            options: parsed.options,
            logger,
            coveragePlan: loadCoveragePlan(),
            reportPath: path.join(recipesDir(), COVERAGE_REPORT_FILE),
            writeReport: writeJsonFile,
        });

        logger.info('stage_completed', {
            stage: STAGE,
            selected: outcome.selected.length,
            created: outcome.created.length,
            promoted: outcome.promoted.length,
            unchanged: outcome.unchanged.length,
            ingredientRows: outcome.ingredientRows,
            dryRun: outcome.dryRun,
            reportSkippedReason: outcome.reportSkippedReason,
        });

        return 0;
    } finally {
        // In a `finally` so a refusal disconnects too: an open pool keeps the
        // process alive and a CI step that hangs after reporting its failure
        // reads as a timeout rather than as the refusal it is.
        await prisma.$disconnect();
    }
};

// Guarded so importing this module for parseArgs, preflight, describeUsage, the
// pure helpers or runSeed never runs the stage.
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
