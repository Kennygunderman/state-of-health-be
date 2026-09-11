/**
 * The coverage gate's own test (Agent Action Plan §0.7.1 / §0.9.1).
 *
 * The gate in `jest.config.ts` is derived from disk so that a new
 * `src/services/*.logic.ts` cannot ship uncovered. This suite is what makes
 * that promise enforceable: it reads the same directory INDEPENDENTLY — with
 * its own `readdirSync`, not by calling the helper it is checking — and
 * asserts the emitted inventory, the `collectCoverageFrom` list and the
 * per-path thresholds all agree with it. A `*.logic.ts` added without a
 * covering suite therefore turns the run red here (and again in the coverage
 * summary), instead of slipping through a hand-maintained list.
 */

import { existsSync, readdirSync } from 'fs';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import config, {
    BRANCH_COVERAGE_THRESHOLD,
    COVERED_UTIL_MODULES,
    coverageThresholdFor,
    coveredSourcePaths,
} from '../../../jest.config';

/** The backend package root — `src/__tests__/setup` is three levels down. */
const BACKEND_ROOT = join(__dirname, '..', '..', '..');

/**
 * The expected inventory, derived here from scratch. Deliberately duplicated
 * logic: a test that called `coveredSourcePaths()` to compute its own
 * expectation could only ever agree with itself.
 */
const expectedInventory = (): string[] => {
    const logicModules = readdirSync(join(BACKEND_ROOT, 'src', 'services'))
        .filter((fileName) => fileName.endsWith('.logic.ts'))
        .sort()
        .map((fileName) => `src/services/${fileName}`);

    return [...logicModules, ...COVERED_UTIL_MODULES];
};

describe('coveredSourcePaths', () => {
    it('lists every src/services/*.logic.ts on disk plus the four pure utils', () => {
        expect(coveredSourcePaths()).toEqual(expectedInventory());
    });

    it('names files that exist, so a renamed module cannot leave a stale entry behind', () => {
        for (const relativePath of coveredSourcePaths()) {
            expect(existsSync(join(BACKEND_ROOT, relativePath))).toBe(true);
        }
    });

    it('includes no test file, snapshot or directory from src/services', () => {
        for (const relativePath of coveredSourcePaths()) {
            expect(relativePath).toMatch(/\.ts$/);
            expect(relativePath).not.toContain('__tests__');
            expect(relativePath).not.toMatch(/\.test\.ts$/);
        }
    });

    it('refuses to derive an empty gate when the services directory cannot be read', () => {
        // A missing directory must fail loudly: an empty inventory would mean
        // an empty coverageThreshold, which passes every module unconditionally
        // — the one way this gate could stop protecting anything while still
        // reporting success. The fixture root lives in the OS temp directory,
        // so nothing is written inside the checkout.
        const emptyRoot = mkdtempSync(join(tmpdir(), 'soh-coverage-inventory-'));

        try {
            expect(() => coveredSourcePaths(emptyRoot)).toThrow(/could not be read/);
            expect(() => coveredSourcePaths(emptyRoot)).toThrow(/empty coverage inventory/);
        } finally {
            rmSync(emptyRoot, { recursive: true, force: true });
        }
    });
});

describe('the emitted Jest configuration', () => {
    it('collects coverage from exactly the derived inventory', () => {
        expect(config.collectCoverageFrom).toEqual(expectedInventory());
    });

    it('holds every covered file to the §0.9.1 branch threshold on its own', () => {
        const threshold = config.coverageThreshold as Record<string, { branches: number }>;

        expect(Object.keys(threshold).sort()).toEqual([...expectedInventory()].sort());
        for (const entry of Object.values(threshold)) {
            expect(entry).toEqual({ branches: BRANCH_COVERAGE_THRESHOLD });
        }
        expect(BRANCH_COVERAGE_THRESHOLD).toBe(80);
    });

    it('declares no global average, so no module can hide behind one', () => {
        const threshold = config.coverageThreshold as Record<string, unknown>;

        expect(Object.prototype.hasOwnProperty.call(threshold, 'global')).toBe(false);
    });

    it('runs the database guard from setupFiles, before any application module loads', () => {
        expect(config.setupFiles).toEqual(['<rootDir>/src/__tests__/setup/jestSetup.ts']);
        expect(config.setupFilesAfterEnv).toBeUndefined();
    });
});

describe('coverageThresholdFor', () => {
    it('emits one branch-only entry per path and nothing else', () => {
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
