// The recipe seed: publishes the curated recipe files as versioned recipes.
//
// WHAT THE STAGE DOES when its inputs are present: it reads every
// data/meal-planning/recipes/*.json file, resolves each ingredient by the
// catalog food's stable `source_key` to a published, source-backed,
// allergen-known row with a gram weight, derives the recipe's nutrition and
// diet/allergen tags from that ingredient set and fails a file whose declared
// tags disagree or whose instructions name an unlisted ingredient, and is
// idempotent by `slug`: an unchanged recipe is a no-op, while changed content
// or a stale ingredient snapshot publishes a new `recipe_versions` row as
// `current`, retires the previous one and moves `recipes.current_version_id` —
// all in one transaction. It then writes the diet x allergen x slot x time
// coverage report (Agent Action Plan §0.7.1 Group 4).
//
// WHAT IT DOES IN THIS REVISION. There is no data/meal-planning/recipes/
// directory in this checkout and src/services/recipe.logic.ts — which owns the
// nutrition derivation, the tag derivation and the eligibility rules — is an
// Agent Action Plan §0.7.1 Group 4 deliverable. This entry point is therefore
// the stage's input contract: it parses its flags, reports the accepted
// database origin, checks the inputs the seed consumes, and refuses, naming
// either the unsatisfied inputs and their remedies or the pipeline module that
// still has to be wired in. No recipe row is read or written on any path.
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
import type { LogFields, LogLevel } from './lib/logger';
import { ManifestError, recipesDir } from './lib/manifest';
import { ModelBudgetError } from './lib/budget';
import { RateLimitConfigError } from './lib/rateLimiter';
import { CheckpointError } from './lib/checkpoint';

const STAGE = 'recipes-seed';

const WIRED_BY = 'src/services/recipe.logic.ts with data/meal-planning/recipes/*.json (AAP §0.7.1 Group 4)';

const RECIPE_LOGIC_MODULE = 'src/services/recipe.logic.ts';

const RECIPE_FILE_EXTENSION = '.json';

const logger = createLogger(STAGE);

// ---------------------------------------------------------------------------
// Argument parsing — pure (Rule backend-architecture §1.2).
// ---------------------------------------------------------------------------

export interface SeedOptions {
    readonly help: boolean;
    /** `--only`, repeatable. Empty means every recipe file in the directory. */
    readonly only: readonly string[];
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
        return { ok: true, options: { help: true, only: [] } };
    }

    const errors: ArgumentError[] = [];
    const only: string[] = [];

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

        if (flag === '--only') {
            const value = takeValue(inlineValue);
            if (value === null) {
                errors.push({ flag, message: `${flag} requires a recipe slug` });
                continue;
            }
            only.push(value);
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

    return { ok: true, options: { help: false, only } };
};

// ---------------------------------------------------------------------------
// Usage.
// ---------------------------------------------------------------------------

export const describeUsage = (): string =>
    [
        `Usage: npm run recipes:seed -- [options]   (${STAGE})`,
        '',
        'Checks every input the recipe seed consumes and reports what is missing.',
        'This revision carries no seed body, so no recipe row is read or written: the',
        'command exits 1 naming either the unsatisfied prerequisites or the pipeline',
        'module that still has to be wired in.',
        '',
        'Options:',
        '  --only <slug>               Seed just this recipe slug. Repeatable.',
        '                              Default: every file in the recipes directory.',
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
        '  src/services/recipe.logic.ts        nutrition derivation, tag derivation and',
        '                                      the eligibility rules',
        '',
        'Environment:',
        '  DATABASE_URL   required; classified by scripts/lib/dbGuard.ts. Ingredients',
        '                 resolve against the catalog loaded in it.',
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

export const preflight = (deps: SeedPreflightDeps): readonly PrerequisiteGap[] => {
    const gaps: PrerequisiteGap[] = [];

    const entries = deps.listDirectory(deps.recipesDir());
    if (entries === null) {
        gaps.push({
            code: 'recipes_directory_absent',
            requirement: 'data/meal-planning/recipes/ must exist: it is the seed\'s only source of recipe content',
            remedy: 'Add the curated recipe files under data/meal-planning/recipes/ (at least 40, per the coverage matrix in AAP §0.7.3).',
        });
    } else {
        const recipeFiles = entries.filter((entry) => entry.endsWith(RECIPE_FILE_EXTENSION));
        if (recipeFiles.length === 0) {
            gaps.push({
                code: 'recipes_directory_empty',
                requirement: `data/meal-planning/recipes/ must hold at least one *${RECIPE_FILE_EXTENSION} recipe file`,
                remedy: 'Add the curated recipe files under data/meal-planning/recipes/ (at least 40, per the coverage matrix in AAP §0.7.3).',
                detail: `the directory exists and holds ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}, none of them *${RECIPE_FILE_EXTENSION}`,
            });
        }
    }

    if (!deps.fileExists(RECIPE_LOGIC_MODULE)) {
        gaps.push({
            code: 'recipe_logic_absent',
            requirement: `${RECIPE_LOGIC_MODULE} must exist: it derives each recipe's nutrition and tags from its ingredient snapshots and decides what a mismatch means`,
            remedy: `Land ${RECIPE_LOGIC_MODULE} with its unit suite (AAP §0.7.1 Group 4).`,
        });
    }

    return gaps;
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
const describeFailure = (error: unknown): { code: string; error: { name: string; message: string } } => {
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
    logger.info('stage_invoked', { stage: STAGE, only: parsed.options.only });

    const gaps = preflight(defaultPreflightDeps());
    if (gaps.length > 0) {
        logger.error('stage_prerequisites_unmet', gapFields(gaps));
        return 1;
    }

    logger.error('stage_pipeline_pending', { stage: STAGE, wiredBy: WIRED_BY });
    return 1;
};

// Guarded so importing this module for parseArgs, preflight or describeUsage
// never runs the stage.
if (require.main === module) {
    main()
        .then((exitCode) => {
            process.exit(exitCode);
        })
        .catch((error: unknown) => {
            const failure = describeFailure(error);
            createFatalLogger(STAGE).error('stage_failed', {
                stage: STAGE,
                code: failure.code,
                error: failure.error,
            });
            process.exit(1);
        });
}
