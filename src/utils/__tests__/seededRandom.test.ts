import { mulberry32 } from '../seededRandom';

const SEED_0_SEQUENCE = [
    0.26642920868471265, 0.0003297457005828619, 0.2232720274478197, 0.1462021479383111, 0.46732782293111086,
];

const SEED_1_SEQUENCE = [
    0.6270739405881613, 0.002735721180215478, 0.5274470399599522, 0.9810509674716741, 0.9683778982143849,
];

const SEED_42_SEQUENCE = [
    0.6011037519201636, 0.44829055899754167, 0.8524657934904099, 0.6697340414393693, 0.17481389874592423,
];

const UINT32_CEILING_FIRST_DRAW = 0.8964226141106337;

const UINT32_RANGE = 4294967296;

const LOCKSTEP_DRAWS = 1000;

const RANGE_SEEDS = [0, 1, 42, 7, 99999];

const RANGE_DRAWS_PER_SEED = 1000;

const take = (next: () => number, count: number): number[] => {
    const values: number[] = [];

    for (let index = 0; index < count; index += 1) {
        values.push(next());
    }

    return values;
};

describe('mulberry32', () => {
    describe('determinism', () => {
        // The sequences asserted below are a regression lock, not sample output:
        // they were computed from this module on Node 22.23.2 and are what makes
        // the release evidence in Agent Action Plan §0.9.3 — a second freshly
        // loaded database replaying an identical week — mean anything. Every draw
        // decides which of several equal-scoring recipes a slot receives, so a
        // different value here silently changes published plans. If a change to
        // the generator makes these fail, the generator is what is wrong; these
        // numbers are only re-recorded alongside regenerated release evidence.
        it('replays the recorded sequence for seed 0', () => {
            expect(take(mulberry32(0), SEED_0_SEQUENCE.length)).toEqual(SEED_0_SEQUENCE);
        });

        it('replays the recorded sequence for seed 1', () => {
            expect(take(mulberry32(1), SEED_1_SEQUENCE.length)).toEqual(SEED_1_SEQUENCE);
        });

        it('replays the recorded sequence for seed 42', () => {
            expect(take(mulberry32(42), SEED_42_SEQUENCE.length)).toEqual(SEED_42_SEQUENCE);
        });

        it('keeps two generators built from one seed in lockstep over a long run', () => {
            const first = mulberry32(20260908);
            const second = mulberry32(20260908);

            expect(take(first, LOCKSTEP_DRAWS)).toEqual(take(second, LOCKSTEP_DRAWS));
        });

        it('gives each generator its own state rather than one shared across the module', () => {
            const advanced = mulberry32(42);
            const untouched = mulberry32(42);

            take(advanced, 2);

            expect(take(untouched, SEED_42_SEQUENCE.length)).toEqual(SEED_42_SEQUENCE);
        });

        it('starts each seed at a different draw', () => {
            const firstDraws = [mulberry32(0)(), mulberry32(1)(), mulberry32(42)()];

            expect(new Set(firstDraws).size).toBe(firstDraws.length);
        });

        it('produces a different sequence for each seed', () => {
            expect(take(mulberry32(0), 5)).not.toEqual(take(mulberry32(1), 5));
            expect(take(mulberry32(1), 5)).not.toEqual(take(mulberry32(42), 5));
            expect(take(mulberry32(0), 5)).not.toEqual(take(mulberry32(42), 5));
        });

        it('advances on every call rather than repeating one value', () => {
            const sequence = take(mulberry32(99), 10);

            expect(new Set(sequence).size).toBe(sequence.length);
        });
    });

    describe('output range', () => {
        it('keeps every draw at or above zero and strictly below one', () => {
            for (const seed of RANGE_SEEDS) {
                for (const value of take(mulberry32(seed), RANGE_DRAWS_PER_SEED)) {
                    expect(value).toBeGreaterThanOrEqual(0);
                    expect(value).toBeLessThan(1);
                }
            }
        });
    });

    describe('seed coercion', () => {
        it('reads a negative seed as its unsigned 32-bit equivalent', () => {
            expect(mulberry32(-1)()).toBe(UINT32_CEILING_FIRST_DRAW);
            expect(mulberry32(0xFFFFFFFF)()).toBe(UINT32_CEILING_FIRST_DRAW);
        });

        it('truncates a fractional seed towards zero', () => {
            expect(mulberry32(42.7)()).toBe(SEED_42_SEQUENCE[0]);
            expect(mulberry32(42)()).toBe(SEED_42_SEQUENCE[0]);
        });

        it('wraps a seed above the unsigned 32-bit range', () => {
            expect(take(mulberry32(UINT32_RANGE + 7), 5)).toEqual(take(mulberry32(7), 5));
        });

        it('treats zero as a real seed rather than a missing one', () => {
            expect(take(mulberry32(0), SEED_0_SEQUENCE.length)).toEqual(SEED_0_SEQUENCE);
        });

        it('falls back to seed zero for a seed that is not a number', () => {
            expect(take(mulberry32(Number.NaN), SEED_0_SEQUENCE.length)).toEqual(SEED_0_SEQUENCE);
        });

        it('falls back to seed zero for an infinite seed', () => {
            expect(take(mulberry32(Number.POSITIVE_INFINITY), SEED_0_SEQUENCE.length)).toEqual(SEED_0_SEQUENCE);
        });
    });
});
