import { readdirSync } from 'fs';
import { join } from 'path';

import type { Config } from '@jest/types';

/**
 * The backend Jest configuration (Agent Action Plan §0.7.1 Group 1).
 *
 * Two things here are load-bearing rather than conventional, and both exist to
 * keep the §0.9.1 coverage gate honest:
 *
 *  1. The covered-file set is READ FROM DISK at config time, never hand-listed.
 *     A new `src/services/*.logic.ts` therefore joins the gate the moment it is
 *     written, so it cannot ship uncovered because someone forgot to add a
 *     line here. `src/__tests__/setup/coverageInventory.test.ts` imports the
 *     derivation below and pins it against its own independent directory read,
 *     so a stale inventory fails the run instead of passing quietly.
 *
 *  2. The threshold is PER PATH with no `global` entry. A global average lets a
 *     module with no branch coverage hide behind well-covered neighbours; one
 *     entry per file means each module is held to 80 % branch coverage on its
 *     own, which is exactly what §0.9.1 asserts.
 *
 * Run it the way the gate does — the guard in `src/__tests__/setup/testDb.ts`
 * refuses anything else:
 *
 *   NODE_ENV=test ALLOW_DB_TRUNCATE=true \
 *     DATABASE_URL=postgresql://…@127.0.0.1:5433/<name>_test npm test
 */

/**
 * The single branch-coverage bar every covered module is held to (§0.9.1).
 * Exported so the inventory test asserts against the same number the gate uses.
 */
export const BRANCH_COVERAGE_THRESHOLD = 80;

/** Where the pure domain modules live, relative to this file. */
const SERVICES_DIRECTORY = 'src/services';

/** The dot-suffix convention Rule 7 §7 gives the backend's pure modules. */
const LOGIC_MODULE_SUFFIX = '.logic.ts';

/**
 * The four pure utility modules §0.7.1 names explicitly, as repo-relative
 * paths. They are listed rather than derived because `src/utils/` also holds
 * I/O boundaries (`firebase.ts`, `getUserId.ts`) that the plan excludes from
 * coverage; the exclusion is the point, so it is written where it can be read.
 */
export const COVERED_UTIL_MODULES: readonly string[] = [
    'src/utils/units.ts',
    'src/utils/seededRandom.ts',
    'src/utils/pagination.ts',
    'src/utils/featureFlags.ts',
];

/**
 * Reads the services directory, or fails with a message that says why the gate
 * could not be derived.
 *
 * An unreadable directory THROWS rather than yielding `[]`: an empty gate
 * passes everything, which is the one failure mode a coverage gate must never
 * have. The return type is inferred from the call so the `withFileTypes`
 * overload is the one that applies.
 */
const readServicesDirectory = (servicesDirectory: string) => {
    try {
        return readdirSync(servicesDirectory, { withFileTypes: true });
    } catch (error) {
        throw new Error(
            `jest.config.ts cannot derive the coverage gate: ${servicesDirectory} could not be read ` +
                `(${error instanceof Error ? error.message : String(error)}). Refusing to continue with an ` +
                'empty coverage inventory, which would pass every module unconditionally.',
        );
    }
};

/**
 * Every file the coverage gate covers: each `*.logic.ts` presently in
 * `src/services/`, sorted for a stable emission order, followed by the four
 * utility modules above.
 *
 * `rootDir` is a parameter so a test can point the derivation at a fixture
 * directory, and defaults to this file's own directory — the repository root
 * for the backend package, which is also Jest's `rootDir`.
 *
 * An unreadable services directory THROWS rather than yielding `[]`: an empty
 * gate passes everything, which is the one failure mode a coverage gate must
 * never have.
 */
export const coveredSourcePaths = (rootDir: string = __dirname): string[] => {
    const servicesDirectory = join(rootDir, SERVICES_DIRECTORY);
    const logicModules = readServicesDirectory(servicesDirectory)
        .filter((entry) => entry.isFile() && entry.name.endsWith(LOGIC_MODULE_SUFFIX))
        .map((entry) => entry.name)
        .sort()
        .map((fileName) => `${SERVICES_DIRECTORY}/${fileName}`);

    return [...logicModules, ...COVERED_UTIL_MODULES];
};

/**
 * One `{ branches: 80 }` entry per covered path and nothing else — in
 * particular no `global` key, so no module can average its way past the bar.
 */
export const coverageThresholdFor = (paths: readonly string[]): Record<string, { branches: number }> => {
    const threshold: Record<string, { branches: number }> = {};

    for (const path of paths) {
        threshold[path] = { branches: BRANCH_COVERAGE_THRESHOLD };
    }

    return threshold;
};

const coveredPaths = coveredSourcePaths();

const config: Config.InitialOptions = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    roots: ['<rootDir>/src'],
    testMatch: ['**/__tests__/**/*.test.ts'],
    // A `setupFiles` entry, not `setupFilesAfterEach`/`setupFilesAfterEnv`: it
    // has to run before the test framework and before any application module
    // is imported, because its first statement is the database guard.
    setupFiles: ['<rootDir>/src/__tests__/setup/jestSetup.ts'],
    transform: {
        // The modern per-transform form. The `globals: {'ts-jest': …}` spelling
        // is deprecated in ts-jest 29 and warns on every run.
        '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }],
    },
    collectCoverageFrom: coveredPaths,
    // The one cast in this file. `@jest/types`' `CoverageThreshold` declares
    // `global` as a REQUIRED key, so a derived per-path map cannot satisfy it
    // structurally — and adding a `global` entry to satisfy the type is exactly
    // what §0.7.1 forbids, since it would let a module below its own threshold
    // hide behind the average. The cast keeps the type system out of a policy
    // decision; `coverageInventory.test.ts` asserts the absence of `global`.
    coverageThreshold: coverageThresholdFor(coveredPaths) as Config.InitialOptions['coverageThreshold'],
};

export default config;
