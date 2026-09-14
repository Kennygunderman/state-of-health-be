// Stage 6 of the catalog pipeline: loading a reviewed release into an
// environment. This is the one catalog command an operator runs during a
// release (docs/meal-planning/release-and-recovery.md, step 4).
//
// WHAT THE STAGE DOES when its inputs are present: it verifies every file's
// SHA-256 against manifest.json before any write, then reconciles on stable
// identities — foods upsert on `source_key`, and each food's aliases, portions,
// components and validation record are replaced wholesale inside that food's
// transaction — retires a published food absent from a later release rather
// than deleting it, and refuses to move the active release pointer unless the
// row counts after the load equal the manifest's (Agent Action Plan §0.7.1
// Group 3). Rerunning it is a no-op.
//
// THE EMPTY components.jsonl IS LOADED, NOT SKIPPED. A release whose catalog is
// entirely source-backed single-ingredient records carries zero component rows,
// and that empty set is an assertion the loader must apply rather than ignore:
// because each food's components are replaced WHOLESALE, loading a release with
// no rows for a food is what removes a composition the previous release had, so
// treating the empty member as "nothing to do" would leave a stale composition
// behind and let a food's stored nutrition disagree with what it is derived
// from. The row-count reconciliation covers the member for the same reason — 0
// expected against 0 observed is a check that passed, not a check that was
// absent — and it is the load-time counterpart of the export-time invariant in
// catalog-release.ts: a published `ingredient_derived` food must carry at least
// one component row, so an empty components.jsonl is only ever valid alongside
// an empty published ingredient-derived set.
//
// WHAT IT DOES IN THIS REVISION. The reviewed release
// data/meal-planning/catalog/releases/v1/ is present — five checksummed JSONL
// members and their manifest — but the reconciliation that applies it is still
// an Agent Action Plan §0.7.1 Group 3 deliverable. This entry point is
// therefore the stage's input contract: it parses its flags,
// reports the accepted database origin, checks the release it was asked to load
// — the id, its manifest, and the presence of every file that manifest lists —
// and refuses, naming either the unsatisfied inputs and their remedies or the
// pipeline module that still has to be wired in. Nothing is read from or
// written to the database on any path.
//
// THE CONFIRMATION DOOR IS NOT THIS FILE'S. `catalog-load` is
// `development_or_confirmed` in scripts/lib/dbGuard.ts: against anything other
// than a development origin the guard demands `--confirm-target <dbname>` at
// module load, before this file's own code runs, and exits 1 with
// `{"event":"database_origin_refused","code":"confirmation_required"}` when it
// is absent. The flag is documented in the usage block below and accepted by
// the parser, but it is read from process.argv by the guard and never
// interpreted here — one owner for one rule.
//
// The two guard imports are ordered and load-bearing: Rule
// backend-architecture §10's IPv4-first DNS ordering, then that module-load
// classification, both ahead of anything that could reach Prisma or the network.
import './lib/bootstrap';
import './lib/dbGuard';

import fs from 'fs';

import { classifyDatabaseOrigin, DatabaseOriginError } from './lib/dbGuard';
import { createFatalLogger, createLogger, safeError, writeLineSync } from './lib/logger';
import type { LogFields, LogLevel } from './lib/logger';
import {
    ManifestError,
    assertReleaseVersion,
    loadReleaseManifest,
    releaseFilePath,
} from './lib/manifest';
import type { CatalogReleaseManifest } from './lib/manifest';
import { ModelBudgetError } from './lib/budget';
import { RateLimitConfigError } from './lib/rateLimiter';
import { CheckpointError } from './lib/checkpoint';

const STAGE = 'catalog-load';

const WIRED_BY =
    'src/services/catalog.logic.ts with the release artefact under data/meal-planning/catalog/releases/ (AAP §0.7.1 Group 3)';

const RELEASE_FLAG = '--release';

const logger = createLogger(STAGE);

// ---------------------------------------------------------------------------
// Argument parsing — pure (Rule backend-architecture §1.2).
// ---------------------------------------------------------------------------

export interface LoadOptions {
    readonly help: boolean;
    /** The release id exactly as the operator typed it; validated in preflight. */
    readonly release: string;
}

export interface ArgumentError {
    readonly flag: string;
    readonly message: string;
}

export type ParseResult =
    | { readonly ok: true; readonly options: LoadOptions }
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
        return { ok: true, options: { help: true, release: '' } };
    }

    const errors: ArgumentError[] = [];
    let release: string | null = null;
    let releaseSeen = false;

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

        if (flag === RELEASE_FLAG) {
            // Marked seen before its value is read, so a flag given without one
            // is reported as the missing value it is and not additionally as an
            // absent flag — the operator has one thing to fix, not two.
            const alreadySeen = releaseSeen;
            releaseSeen = true;

            const value = takeValue(inlineValue);
            if (value === null) {
                errors.push({ flag, message: `${flag} requires a release id such as v1` });
                continue;
            }
            if (alreadySeen) {
                errors.push({ flag, message: `${flag} was given more than once; it takes a single value` });
                continue;
            }
            release = value;
            continue;
        }

        if (flag === CONFIRM_TARGET_FLAG) {
            takeValue(inlineValue);
            continue;
        }

        errors.push({ flag, message: `${flag} is not a flag ${STAGE} accepts` });
    }

    // Required with no default: which release is loaded into an environment is
    // never something this command should decide on the operator's behalf.
    if (!releaseSeen) {
        errors.push({ flag: RELEASE_FLAG, message: `${RELEASE_FLAG} is required; name the release to load, such as v1` });
    }

    if (errors.length > 0) {
        return { ok: false, errors };
    }

    return { ok: true, options: { help: false, release: release === null ? '' : release } };
};

// ---------------------------------------------------------------------------
// Usage.
// ---------------------------------------------------------------------------

export const describeUsage = (): string =>
    [
        `Usage: npm run catalog:load -- --release <vN> [options]   (${STAGE})`,
        '',
        'Checks the release it was asked to load and reports what is missing. This',
        'revision carries no loader body, so nothing is read from or written to the',
        'database: the command exits 1 naming either the unsatisfied prerequisites or',
        'the pipeline module that still has to be wired in.',
        '',
        'Options:',
        '  --release <vN>              Required. The release id to load: "v" followed',
        '                              by digits, naming',
        '                              data/meal-planning/catalog/releases/<vN>/.',
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
        '  data/meal-planning/catalog/releases/<vN>/manifest.json   release id, the',
        '                              per-file SHA-256, the row counts and the source',
        '                              dataset and model versions',
        '  data/meal-planning/catalog/releases/<vN>/*.jsonl         every file the',
        '                              manifest lists: foods, aliases, portions,',
        '                              components and validation records',
        '',
        'Environment:',
        '  DATABASE_URL   required; classified by scripts/lib/dbGuard.ts. This is the',
        '                 environment the release is loaded into.',
    ].join('\n');

const writeUsage = (level: LogLevel): void => {
    writeLineSync(describeUsage(), level);
};

// ---------------------------------------------------------------------------
// Preflight.
// ---------------------------------------------------------------------------

export interface LoadPreflightDeps {
    readonly env: NodeJS.ProcessEnv;
    readonly release: string;
    /** manifest.ts's release id rule, seamed so the invalid-id branch is testable. */
    readonly assertReleaseVersion: (release: string) => string;
    readonly loadReleaseManifest: (release: string) => CatalogReleaseManifest;
    readonly releaseFilePath: (release: string, fileName: string) => string;
    readonly fileExists: (absolutePath: string) => boolean;
}

const defaultPreflightDeps = (release: string): LoadPreflightDeps => ({
    env: process.env,
    release,
    assertReleaseVersion,
    loadReleaseManifest,
    releaseFilePath,
    fileExists: (absolutePath: string): boolean => fs.existsSync(absolutePath),
});

/**
 * Names a release file the way the operator sees it — repository-relative —
 * rather than by its absolute path, which is machine-specific and would end up
 * in a committed log.
 */
const describeReleaseFile = (release: string, fileName: string): string =>
    `data/meal-planning/catalog/releases/${release}/${fileName}`;

export const preflight = (deps: LoadPreflightDeps): readonly PrerequisiteGap[] => {
    const gaps: PrerequisiteGap[] = [];

    // Every path below is built from the id, so an invalid one is the whole
    // answer: there is no manifest to look for and no file list to check.
    try {
        deps.assertReleaseVersion(deps.release);
    } catch (error) {
        if (error instanceof ManifestError) {
            gaps.push({
                code: 'release_id_invalid',
                requirement: 'The --release value must be "v" followed by digits, and a single path segment',
                remedy: 'Pass a release id such as --release v1.',
                detail: `${error.code}: ${error.message}`,
            });
            return gaps;
        }
        throw error;
    }

    let manifest: CatalogReleaseManifest;
    try {
        manifest = deps.loadReleaseManifest(deps.release);
    } catch (error) {
        if (error instanceof ManifestError) {
            gaps.push({
                code: 'release_manifest_unavailable',
                requirement: `${describeReleaseFile(deps.release, 'manifest.json')} must load and declare the coverage-plan version this build understands`,
                remedy: `Produce the release with "npm run catalog:release -- --release ${deps.release}" and commit data/meal-planning/catalog/releases/${deps.release}/ (AAP §0.7.1 Group 3).`,
                detail: `${error.code}: ${error.message}`,
            });
            // Without the manifest there is no file list, so the per-file check
            // below has nothing to say. Returning here keeps the refusal to the
            // one thing the operator has to fix first.
            return gaps;
        }
        throw error;
    }

    // Guarded rather than trusted: the manifest is a JSON document on disk, so
    // its declared type does not bind what actually arrives, and a missing
    // `files` array must read as "the manifest does not list its files" rather
    // than throwing inside a preflight check.
    const files = Array.isArray(manifest.files) ? manifest.files : [];
    if (files.length === 0) {
        gaps.push({
            code: 'release_manifest_lists_no_files',
            requirement: `${describeReleaseFile(deps.release, 'manifest.json')} must list the release's files with a SHA-256 and a row count each`,
            remedy: `Reproduce the release with "npm run catalog:release -- --release ${deps.release} --force"; a manifest with no file list cannot be checksum-verified.`,
        });
        return gaps;
    }

    for (const file of files) {
        const fileName = file === null || typeof file !== 'object' ? '' : String(file.path);

        let absolutePath: string;
        try {
            absolutePath = deps.releaseFilePath(deps.release, fileName);
        } catch (error) {
            if (error instanceof ManifestError) {
                // A name the path rule refuses — a separator, "..", an empty
                // entry — is a defective manifest, not a missing file.
                gaps.push({
                    code: 'release_file_name_invalid',
                    requirement: `Every "path" in ${describeReleaseFile(deps.release, 'manifest.json')} must be a single file name inside the release directory`,
                    remedy: `Reproduce the release with "npm run catalog:release -- --release ${deps.release} --force" so its manifest lists plain file names.`,
                    detail: `${error.code}: ${error.message}`,
                });
                continue;
            }
            throw error;
        }

        if (!deps.fileExists(absolutePath)) {
            gaps.push({
                code: 'release_file_missing',
                requirement: `${describeReleaseFile(deps.release, fileName)} must exist: the manifest lists it, and every file is checksum-verified before any write`,
                remedy: `Restore the file, or reproduce the release with "npm run catalog:release -- --release ${deps.release} --force".`,
            });
        }
    }

    return gaps;
};

// ---------------------------------------------------------------------------
// Reporting.
// ---------------------------------------------------------------------------

const gapFields = (gaps: readonly PrerequisiteGap[]): LogFields => {
    const fields: LogFields = { stage: STAGE, gapCount: gaps.length };
    // Several gaps can share a code here — one per missing release file — so the
    // key carries an index after the first, keeping every entry in the line.
    const used = new Set<string>();
    for (const gap of gaps) {
        let key = `gap_${gap.code}`;
        let suffix = 2;
        while (used.has(key)) {
            key = `gap_${gap.code}_${suffix}`;
            suffix += 1;
        }
        used.add(key);
        fields[key] =
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
    logger.info('stage_invoked', { stage: STAGE, release: parsed.options.release });

    const gaps = preflight(defaultPreflightDeps(parsed.options.release));
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
