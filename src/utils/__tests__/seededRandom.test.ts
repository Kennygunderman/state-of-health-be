/**
 * `src/utils/seededRandom.ts` is the determinism guarantee meal-plan
 * generation rests on: the same plan inputs must replay the same week, and a
 * draw outside `[0, 1)` would index past the end of a candidate array. Those
 * two properties, plus the seed coercion that keeps a hashed seed from
 * producing `NaN`, are what this suite pins.
 */

import { mulberry32 } from '../seededRandom';

/** Draws `count` values from a fresh generator for `seed`. */
const draw = (seed: number, count: number): number[] => {
    const next = mulberry32(seed);

    return Array.from({ length: count }, () => next());
};

describe('mulberry32 — determinism', () => {
    it('replays an identical sequence for the same seed', () => {
        expect(draw(12345, 25)).toEqual(draw(12345, 25));
    });

    it('gives two generators from one seed independent state', () => {
        const first = mulberry32(7);
        const second = mulberry32(7);

        first();
        first();

        // A shared module-level state would make the second generator continue
        // the first one's sequence, and two plans generated in one process
        // would then differ from the same inputs.
        expect(second()).toBe(draw(7, 1)[0]);
    });

    it('advances on every call rather than repeating one value', () => {
        const sequence = draw(99, 10);

        expect(new Set(sequence).size).toBe(sequence.length);
    });

    it.each([
        [0, 1],
        [1, 2],
        [42, 43],
        [1000, 1001],
    ])('produces different sequences for seeds %i and %i', (left, right) => {
        expect(draw(left, 5)).not.toEqual(draw(right, 5));
    });
});

describe('mulberry32 — range', () => {
    it('keeps every draw in [0, 1)', () => {
        for (const seed of [0, 1, 7, 4294967295, -1, 0.5]) {
            for (const value of draw(seed, 500)) {
                expect(Number.isFinite(value)).toBe(true);
                expect(value).toBeGreaterThanOrEqual(0);
                expect(value).toBeLessThan(1);
            }
        }
    });

    it('spreads draws across the interval rather than clustering at one end', () => {
        // A scale error (dividing by 2^31, or by 2^32 - 1) still lands inside
        // [0, 1) for most inputs, so the range check above cannot catch it; a
        // mean far from 0.5 over a large sample can.
        const sequence = draw(20260105, 5000);
        const mean = sequence.reduce((total, value) => total + value, 0) / sequence.length;

        expect(mean).toBeGreaterThan(0.45);
        expect(mean).toBeLessThan(0.55);
        expect(sequence.filter((value) => value < 0.5).length).toBeGreaterThan(2000);
        expect(sequence.filter((value) => value >= 0.5).length).toBeGreaterThan(2000);
    });
});

describe('mulberry32 — seeds the caller may hand it', () => {
    it.each([
        ['negative', -1],
        ['deeply negative', -987654321],
        ['fractional', 1.75],
        ['above 2^32', 4294967296 + 5],
        ['at the uint32 ceiling', 4294967295],
        ['the maximum safe integer', Number.MAX_SAFE_INTEGER],
        ['zero', 0],
    ])('yields a defined, repeatable sequence for a %s seed', (_case, seed) => {
        const sequence = draw(seed, 5);

        for (const value of sequence) {
            expect(Number.isNaN(value)).toBe(false);
            expect(value).toBeGreaterThanOrEqual(0);
            expect(value).toBeLessThan(1);
        }
        expect(draw(seed, 5)).toEqual(sequence);
    });

    it.each([
        ['NaN', Number.NaN],
        ['Infinity', Number.POSITIVE_INFINITY],
    ])('coerces a %s seed to zero rather than poisoning the sequence', (_case, seed) => {
        // `seed >>> 0` is what makes this safe, and the consequence is worth
        // stating: a seed that failed to parse silently becomes seed 0 and the
        // run is still deterministic, never NaN.
        expect(draw(seed, 5)).toEqual(draw(0, 5));
    });

    it('treats a fractional seed as its truncated uint32', () => {
        expect(draw(7.9, 5)).toEqual(draw(7, 5));
    });

    it('wraps a seed above the uint32 range', () => {
        expect(draw(4294967296 + 7, 5)).toEqual(draw(7, 5));
    });
});
