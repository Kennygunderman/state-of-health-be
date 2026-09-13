import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import config, {
    BRANCH_COVERAGE_THRESHOLD,
    COVERED_UTIL_MODULES,
    coverageThresholdFor,
    coverageThresholdPaths,
    coveredSourcePaths,
} from '../../../jest.config';

const BACKEND_ROOT = join(__dirname, '..', '..', '..');

const SERVICES_DIRECTORY = join(BACKEND_ROOT, 'src', 'services');

const LOGIC_MODULE_SUFFIX = '.logic.ts';

const TEST_DIRECTORY_NAME = '__tests__';

// The covered utility modules and the two exclusions are spelled out HERE
// rather than imported from the config, and the services directory is read with
// this file's own `readdirSync` rather than by calling `coveredSourcePaths`. A
// test that built its expectation from the derivation it is checking would agree
// with itself no matter what the derivation said — it would stay green while a
// module silently fell out of the gate, which is the one thing this suite
// exists to prevent.
const COVERED_UTILS: readonly string[] = [
    'src/utils/units.ts',
    'src/utils/seededRandom.ts',
    'src/utils/pagination.ts',
    'src/utils/featureFlags.ts',
    'src/utils/calendarDay.ts',
];

const EXCLUDED_UTILS: readonly string[] = ['src/utils/firebase.ts', 'src/utils/getUserId.ts'];

const INTEGRATION_COVERED_SUFFIXES: readonly string[] = ['.service.ts', '.mapper.ts', '.errors.ts'];

const toRepoRelativePosix = (candidate: string): string => {
    const posixCandidate = candidate.replace(/\\/g, '/').replace(/^<rootDir>\/?/, '');
    const rootPrefix = `${BACKEND_ROOT.replace(/\\/g, '/')}/`;

    return posixCandidate.startsWith(rootPrefix) ? posixCandidate.slice(rootPrefix.length) : posixCandidate;
};

const normalised = (paths: readonly string[]): string[] => paths.map(toRepoRelativePosix).sort();

const servicesDirectoryEntries = (): string[] =>
    readdirSync(SERVICES_DIRECTORY, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name);

const expectedInventory = (): string[] => {
    const logicModules = servicesDirectoryEntries()
        .filter((fileName) => fileName.endsWith(LOGIC_MODULE_SUFFIX))
        .map((fileName) => `src/services/${fileName}`);

    return normalised([...logicModules, ...COVERED_UTILS]);
};

const gatedPaths = (): string[] => normalised(coverageThresholdPaths);

const colocatedTestPathFor = (relativePath: string): string => {
    const lastSeparator = relativePath.lastIndexOf('/');
    const directory = relativePath.slice(0, lastSeparator);
    const fileName = relativePath.slice(lastSeparator + 1);

    return `${directory}/${TEST_DIRECTORY_NAME}/${fileName.replace(/\.ts$/, '.test.ts')}`;
};

const thresholdEntries = (): Record<string, { branches: number }> =>
    (config.coverageThreshold ?? {}) as Record<string, { branches: number }>;

const absentFrom = (candidates: readonly string[], present: readonly string[]): string[] =>
    candidates.filter((candidate) => !present.includes(candidate));

describe('coverage inventory', () => {
    describe('the emitted threshold key set', () => {
        it('gates every src/services/*.logic.ts that is on disk', () => {
            const forgottenModules = absentFrom(expectedInventory(), gatedPaths());

            expect(forgottenModules).toEqual([]);
        });

        it('gates no path that has since been renamed or deleted', () => {
            const orphanedEntries = absentFrom(gatedPaths(), expectedInventory());

            expect(orphanedEntries).toEqual([]);
            for (const relativePath of gatedPaths()) {
                expect(existsSync(join(BACKEND_ROOT, relativePath))).toBe(true);
            }
        });

        it('matches the on-disk inventory exactly', () => {
            expect(gatedPaths()).toEqual(expectedInventory());
        });

        it('is non-empty, so an empty gate cannot pass by matching an empty disk read', () => {
            expect(expectedInventory().length).toBeGreaterThan(0);
            expect(gatedPaths().length).toBeGreaterThan(0);
        });

        it('is the key set Jest is actually handed', () => {
            expect(normalised(Object.keys(thresholdEntries()))).toEqual(gatedPaths());
        });
    });

    describe('the covering test each gated module must have', () => {
        it('gates no module that has no colocated unit test to cover it', () => {
            const modulesWithoutATest = gatedPaths().filter(
                (relativePath) => !existsSync(join(BACKEND_ROOT, colocatedTestPathFor(relativePath))),
            );

            expect(modulesWithoutATest).toEqual([]);
        });

        it('expects the test beside the module it covers', () => {
            expect(colocatedTestPathFor('src/services/targets.logic.ts')).toBe(
                'src/services/__tests__/targets.logic.test.ts',
            );
            expect(colocatedTestPathFor('src/utils/units.ts')).toBe('src/utils/__tests__/units.test.ts');
        });
    });

    describe('the derivation behind it', () => {
        it('lists the same inventory this suite reads from disk', () => {
            expect(normalised(coveredSourcePaths())).toEqual(expectedInventory());
        });

        it('refuses to derive an empty gate when the services directory cannot be read', () => {
            const emptyRoot = mkdtempSync(join(tmpdir(), 'soh-coverage-inventory-'));

            try {
                expect(() => coveredSourcePaths(emptyRoot)).toThrow(/could not be read/);
                expect(() => coveredSourcePaths(emptyRoot)).toThrow(/empty coverage inventory/);
            } finally {
                rmSync(emptyRoot, { recursive: true, force: true });
            }
        });
    });

    describe('the pure utility modules', () => {
        it('gates exactly the ones named, and no others', () => {
            expect(normalised(COVERED_UTIL_MODULES)).toEqual(normalised(COVERED_UTILS));
        });

        it('gates each of them by name, and each is present on disk', () => {
            for (const relativePath of COVERED_UTILS) {
                expect(existsSync(join(BACKEND_ROOT, relativePath))).toBe(true);
                expect(gatedPaths()).toContain(relativePath);
            }
        });
    });

    describe('the modules it deliberately leaves to integration coverage', () => {
        it('gates no orchestration, mapper or error module from src/services', () => {
            const servicesEntries = servicesDirectoryEntries();

            for (const suffix of INTEGRATION_COVERED_SUFFIXES) {
                expect(servicesEntries.some((fileName) => fileName.endsWith(suffix))).toBe(true);
                expect(gatedPaths().filter((relativePath) => relativePath.endsWith(suffix))).toEqual([]);
            }
        });

        it('gates neither src/utils I/O boundary', () => {
            for (const relativePath of EXCLUDED_UTILS) {
                expect(existsSync(join(BACKEND_ROOT, relativePath))).toBe(true);
                expect(gatedPaths()).not.toContain(relativePath);
            }
        });

        it('gates no test file or __tests__ directory', () => {
            const testPaths = gatedPaths().filter(
                (relativePath) => relativePath.includes('__tests__') || relativePath.endsWith('.test.ts'),
            );

            expect(testPaths).toEqual([]);
        });
    });

    describe('the bar each entry enforces', () => {
        it('holds every covered module to the branch threshold on its own', () => {
            const belowTheBar = Object.entries(thresholdEntries())
                .filter(([, entry]) => entry.branches !== BRANCH_COVERAGE_THRESHOLD)
                .map(([relativePath]) => relativePath);

            expect(BRANCH_COVERAGE_THRESHOLD).toBe(80);
            expect(belowTheBar).toEqual([]);
        });

        it('constrains branches and nothing else', () => {
            const withOtherMetrics = Object.entries(thresholdEntries())
                .filter(([, entry]) => Object.keys(entry).length !== 1)
                .map(([relativePath]) => relativePath);

            expect(withOtherMetrics).toEqual([]);
        });

        it('declares no global average for a module to hide behind', () => {
            expect(Object.prototype.hasOwnProperty.call(thresholdEntries(), 'global')).toBe(false);
        });
    });

    describe('collectCoverageFrom', () => {
        it('collects exactly the files the thresholds gate, so every entry is evaluated', () => {
            expect(normalised(config.collectCoverageFrom ?? [])).toEqual(expectedInventory());
        });
    });

    describe('coverageThresholdFor', () => {
        it('emits one branch-only entry per path', () => {
            expect(coverageThresholdFor(['src/a.ts', 'src/b.ts'])).toEqual({
                'src/a.ts': { branches: BRANCH_COVERAGE_THRESHOLD },
                'src/b.ts': { branches: BRANCH_COVERAGE_THRESHOLD },
            });
        });

        it('never synthesises a global entry, whatever it is given', () => {
            expect(Object.keys(coverageThresholdFor([]))).toEqual([]);
            expect(Object.keys(coverageThresholdFor(['src/a.ts']))).toEqual(['src/a.ts']);
        });
    });

    describe('the harness the gate runs under', () => {
        it('runs the database guard from setupFiles, before any application module loads', () => {
            expect(config.setupFiles).toEqual(['<rootDir>/src/__tests__/setup/jestSetup.ts']);
            expect(config.setupFilesAfterEnv).toBeUndefined();
        });
    });
});
