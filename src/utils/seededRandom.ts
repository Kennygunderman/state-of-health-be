// Mulberry32 — the deterministic PRNG meal-plan generation is built on. Seed
// derivation belongs to the caller (mealPlan.logic.ts hashes the plan inputs
// into a number), so identical inputs always replay an identical sequence.
// Draws are uint32 values scaled by 2^32, keeping every result in [0, 1).
const UINT32_RANGE = 4294967296;

export const mulberry32 = (seed: number): (() => number) => {
    // Coerced once so negative, fractional and out-of-range seeds still yield a
    // defined uint32 sequence rather than NaN.
    let state = seed >>> 0;

    return (): number => {
        state = (state + 0x6D2B79F5) >>> 0;

        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

        return ((t ^ (t >>> 14)) >>> 0) / UINT32_RANGE;
    };
};
