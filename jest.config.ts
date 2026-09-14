import { existsSync, readdirSync } from 'fs';
import { join } from 'path';

// From `jest` (which package.json declares), not `@jest/types` (present only
// transitively) — a manifest that does not name what the code imports is how a
// working tree and a fresh `npm ci` come to disagree.
import type { Config } from 'jest';

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
 * The pure utility modules held to the bar, as repo-relative paths: exactly the
 * four §0.7.1 names, and no others. A pure rule several services share is not a
 * fifth entry here — it belongs to the `*.logic.ts` parser that owns the input
 * it validates, where the derived services inventory above already gates it.
 *
 * Listed rather than derived because `src/utils/` also holds I/O boundaries
 * (`firebase.ts`, `getUserId.ts`) that the plan excludes from coverage; the
 * exclusion is the point, so it is written where it can be read. A module
 * added here needs a colocated test, which the inventory test enforces.
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
 * `src/services/`, sorted for a stable emission order, followed by whichever of
 * the utility modules above are on disk.
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

    // Only utility modules that are actually on disk are gated. A threshold key
    // matching no covered file is not ignored by Jest — it reports "Coverage
    // data for <path> was not found" and fails the whole run, so naming a
    // module before it exists would block the suite with a message about
    // coverage rather than about the missing file. Deleting or renaming one is
    // still caught loudly: `coverageInventory.test.ts` compares this result
    // against the unfiltered `COVERED_UTIL_MODULES` list.
    const utilModules = COVERED_UTIL_MODULES.filter((relativePath) => existsSync(join(rootDir, relativePath)));

    return [...logicModules, ...utilModules];
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

const coverageThreshold = coverageThresholdFor(coveredPaths);

/**
 * The exact key set emitted into `coverageThreshold` above.
 *
 * Read back off the emitted map with `Object.keys` rather than recomputed, so
 * it cannot describe a gate different from the one Jest is handed — which is
 * the whole reason it is exported: `coverageInventory.test.ts` compares it with
 * its own independent directory read, and a derivation that had quietly drifted
 * (or been replaced by a hand-written list) fails there.
 */
export const coverageThresholdPaths: string[] = Object.keys(coverageThreshold);

const config: Config = {
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
        //
        // The pattern matches the ts-jest preset's own key EXACTLY, which is
        // load-bearing: Jest MERGES a config `transform` with the preset's
        // rather than replacing it, so a narrower key (`^.+\.ts$`) leaves the
        // preset's option-less entry in place beside this one and any `.tsx`
        // would compile against tsconfig.json — which excludes the tests and
        // roots at src/. Reusing the key overrides it, leaving one transform
        // that applies tsconfig.test.json to every TypeScript file.
        '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }],
    },
    // Usage data (calls, instances, results) is cleared before each test so a
    // mock cannot leak assertions between tests. `clearMocks` and not
    // `resetMocks`/`restoreMocks`: those two drop implementations as well,
    // which would strip the `jest.mock` factories jestSetup.ts installs for
    // `utils/firebase` and `middleware/auth` and leave every API suite unable
    // to import app.ts.
    clearMocks: true,
    collectCoverageFrom: coveredPaths,
    // The one cast in this file. Jest's `CoverageThreshold` type declares
    // `global` as a REQUIRED key, so a derived per-path map cannot satisfy it
    // structurally — and adding a `global` entry to satisfy the type is exactly
    // what §0.7.1 forbids, since it would let a module below its own threshold
    // hide behind the average. The cast keeps the type system out of a policy
    // decision; `coverageInventory.test.ts` asserts the absence of `global`.
    coverageThreshold: coverageThreshold as Config['coverageThreshold'],
};

export default config;
