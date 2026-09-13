/**
 * `catalog.logic.ts` is the pure decision layer of the internal food catalog
 * (Agent Action Plan §0.3.3, §0.7.1 Group 3): identity and the `source_key`
 * every run upserts on, the per-100 g nutrition basis, the aisle mapping, the
 * three-tier validation that turns a candidate into a published, quarantined or
 * rejected row, and the coverage shortfall.
 *
 * What this suite pins, and why each is a decision someone could break:
 *
 *  - **The shipped plan and the committed fixture are what the coverage runs
 *    against.** `data/meal-planning/coverage-plan.v1.json` (21 categories) and
 *    `data/meal-planning/fixtures/catalog-foods.fixture.json` (34 rows, every
 *    §0.7.3 boundary among them) are read from disk at the bottom of this file
 *    and drive the per-category sweeps, the per-tier cases and every boundary
 *    case. A reduced stand-in cannot pin a band it does not declare.
 *  - **Bounds are parameters, never constants.** Every category band and
 *    tolerance arrives as an argument, so the four-category `POLICY` below is
 *    retained on purpose beside the shipped plan: a suite that only ever passed
 *    the real plan in would hide a module that had started reading the file
 *    directly, and the sharpest proof of the difference is one candidate whose
 *    verdict changes when the policy does ("bounds are parameters, not
 *    constants", at the end of this file).
 *  - **The closed value sets are enforced here or nowhere.** The status columns
 *    are plain TEXT with no Prisma enum and no CHECK constraint, so a value the
 *    guards admit reaches the database unchallenged — including
 *    `Object.prototype` members, which a bare `in` check would wave through.
 *  - **Verdicts are returned, not thrown**, and a check that could not be
 *    EVALUATED is absent from the record rather than recorded as a pass: "we had
 *    no per-serving values to compare" and "the values agreed" are different
 *    facts. Only `buildSourceKey` throws, and only for input that would mint one
 *    colliding key for every bad candidate.
 *  - **Null means unknown, never 0.** A zero is a claim the source never made,
 *    so a missing term makes the whole derived sum unknown.
 *  - **Reject beats quarantine beats review**, and the review tier is the only
 *    one whose consequence depends on the identity source — a USDA record
 *    publishes with its flag recorded, a generated one is held. An advisory
 *    model review can lift a review flag and can never overturn a rejection.
 *  - **Determinism.** `normalizeCanonicalName` is idempotent, `dedupeIdentity`
 *    picks the same survivor whatever order the candidates arrived in, and
 *    `deriveComponentNutrition` sums in a declared order because floating-point
 *    addition is not associative — a result that differed in the last bits would
 *    read as a staleness change on the next refresh.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

import {
    CATALOG_ALLERGEN_STATUSES,
    CATALOG_CHECK_NAMES,
    CATALOG_FOOD_STATES,
    CATALOG_IDENTITY_SOURCES,
    CATALOG_IDENTITY_STATUSES,
    CATALOG_NUTRITION_BASES,
    CATALOG_NUTRITION_PROVENANCES,
    CATALOG_PUBLICATION_STATUSES,
    CATALOG_QUARANTINE_CHECK_NAMES,
    CATALOG_REJECT_CHECK_NAMES,
    CATALOG_REVIEW_CHECK_NAMES,
    CatalogCategoryBounds,
    CatalogFoodCandidate,
    CatalogFoodPortionCandidate,
    CatalogGlobalValidationBounds,
    CatalogIdentityCandidate,
    CatalogIdentityError,
    CatalogNutrientInput,
    CatalogNutritionBasisRule,
    CatalogNutritionSource,
    CatalogPolicyError,
    CatalogValidationContext,
    CatalogValidationPolicy,
    assertUsableValidationPolicy,
    CORE_NUTRIENT_FIELDS,
    DEFAULT_BRAND_WORDS,
    DEFAULT_CATALOG_NUTRITION_BASIS_RULE,
    DEFAULT_PRODUCT_FORM_WORDS,
    GROCERY_CATEGORY_ORDER,
    MAX_SEARCH_QUERY_LENGTH,
    MIN_SEARCH_QUERY_LENGTH,
    PER_100G_BASIS_AMOUNT,
    buildSourceKey,
    catalogCheckTier,
    computeCoverageShortfall,
    dedupeIdentity,
    deriveComponentNutrition,
    findBrandPatternMatch,
    groceryCategorySortIndex,
    isCatalogAllergenStatus,
    isCatalogFoodState,
    isCatalogIdentitySource,
    isCatalogIdentityStatus,
    isCatalogNutritionBasis,
    isCatalogNutritionProvenance,
    isCatalogPublicationStatus,
    isEstimatedNutrition,
    isGroceryCategory,
    isRecipeEligibleCatalogFood,
    mapCategoryToGroceryCategory,
    normalizeCanonicalName,
    normalizeToPer100g,
    parseCanonicalFdcId,
    parseCatalogSearchQuery,
    resolveCatalogDisposition,
    resolveCategoryBounds,
    validateCatalogCandidate,
} from '../catalog.logic';
import {
    CatalogAllergenStatus,
    CatalogFoodState,
    CatalogIdentitySource,
    CatalogIdentityStatus,
    CatalogNutritionBasis,
    CatalogNutritionProvenance,
    CatalogPublicationStatus,
    CatalogValidationCheck,
    CatalogValidationOutcome,
} from '../../types/catalog';

/* ---------------------------------------------------------------------------
 * Fixtures — a deliberately synthetic policy, kept beside the shipped one
 *
 * The shipped 21-category plan and the committed catalog fixture are loaded at
 * the bottom of this file and own the category, tier and boundary coverage.
 * What follows is a hand-built policy and candidate, retained for two jobs the
 * shipped data cannot do:
 *
 *  1. proving the module decides from its `policy` ARGUMENT rather than from
 *     `coverage-plan.v1.json` — the same candidate gets a different verdict
 *     under a policy that differs from the shipped one (see "bounds are
 *     parameters, not constants" at the end of this file);
 *  2. reaching branch cases no real catalog row carries, and none should — a
 *     NaN nutrient, a negative nutrient, a portion in an unconvertible unit, a
 *     per-serving label set that disagrees with the per-100 g values.
 * ------------------------------------------------------------------------- */

/**
 * Four categories are enough to exercise every branch: one ordinary band, one
 * with the per-food-state override `grain` and `legume` carry, one with a tight
 * tolerance (oil), and one whose spelling differs from its lookup key.
 *
 * Deliberately NOT the shipped plan, and deliberately not a copy of four of its
 * rows either: `SHIPPED_POLICY` below is the shipped plan, and the value of
 * keeping both is that a candidate can be judged against each and be seen to
 * come out differently.
 */
const POLICY: CatalogValidationPolicy = {
    categories: [
        {
            category: 'protein_poultry',
            kcalReviewRange: { min: 80, max: 350 },
            energyMacroTolerancePercent: 15,
            publishedTarget: 400,
        },
        {
            category: 'grain',
            kcalReviewRange: { min: 80, max: 400 },
            kcalReviewRangeByFoodState: {
                dry: { min: 300, max: 400 },
                cooked: { min: 80, max: 200 },
            },
            energyMacroTolerancePercent: 15,
            publishedTarget: 600,
        },
        {
            category: 'oil_fat',
            kcalReviewRange: { min: 700, max: 900 },
            energyMacroTolerancePercent: 8,
            publishedTarget: 150,
        },
        {
            category: 'produce_vegetable',
            kcalReviewRange: { min: 5, max: 150 },
            energyMacroTolerancePercent: 30,
            publishedTarget: 1200,
        },
    ],
    validationBounds: {
        maxKcalPer100g: 900,
        macroMassToleranceFactor: 1.02,
        energyMacroAbsoluteToleranceKcal: 30,
        portionConversionTolerancePercent: 5,
    },
};

/** A raw chicken breast that passes every deterministic check. */
const publishableCandidate = (
    overrides: Partial<CatalogFoodCandidate> = {},
): CatalogFoodCandidate => ({
    source_key: 'usda:171077',
    canonical_name: 'chicken breast, raw',
    display_name: 'Chicken breast, raw',
    category: 'protein_poultry',
    food_state: 'raw',
    identity_source: 'usda',
    identity_status: 'verified',
    nutrition_provenance: 'source_backed',
    allergen_status: 'known',
    allergen_tags: [],
    nutrition_basis: 'per_100g',
    basis_amount: 100,
    calories: 120,
    protein_g: 22.5,
    carbs_g: 0,
    fat_g: 2.6,
    fiber_g: 0,
    portions: [
        { description: '1 breast', amount: 1, unit: 'each', gram_weight: 174, is_default: true },
    ],
    ...overrides,
});

const checkNamed = (
    checks: readonly CatalogValidationCheck[],
    name: string,
): CatalogValidationCheck | undefined => checks.find((check) => check.name === name);

const failingCheck = (name: string, tier: 'reject' | 'quarantine' | 'review'): CatalogValidationCheck => ({
    name,
    pass: false,
    observed: null,
    bound: null,
    tier,
});

const passingCheck = (name: string, tier: 'reject' | 'quarantine' | 'review'): CatalogValidationCheck => ({
    name,
    pass: true,
    observed: null,
    bound: null,
    tier,
});

/* ---------------------------------------------------------------------------
 * Closed value sets
 * ------------------------------------------------------------------------- */

describe('closed value set guards', () => {
    const guards: readonly [string, (value: unknown) => boolean, readonly string[]][] = [
        ['food state', isCatalogFoodState, CATALOG_FOOD_STATES],
        ['identity source', isCatalogIdentitySource, CATALOG_IDENTITY_SOURCES],
        ['identity status', isCatalogIdentityStatus, CATALOG_IDENTITY_STATUSES],
        ['nutrition provenance', isCatalogNutritionProvenance, CATALOG_NUTRITION_PROVENANCES],
        ['nutrition basis', isCatalogNutritionBasis, CATALOG_NUTRITION_BASES],
        ['allergen status', isCatalogAllergenStatus, CATALOG_ALLERGEN_STATUSES],
        ['publication status', isCatalogPublicationStatus, CATALOG_PUBLICATION_STATUSES],
        ['grocery category', isGroceryCategory, GROCERY_CATEGORY_ORDER],
    ];

    it.each(guards)('%s admits every declared member', (_label, guard, values) => {
        expect(values.length).toBeGreaterThan(0);
        for (const value of values) {
            expect(guard(value)).toBe(true);
        }
    });

    it.each(guards)('%s rejects an undeclared string', (_label, guard) => {
        expect(guard('definitely_not_a_member')).toBe(false);
        expect(guard('')).toBe(false);
    });

    it.each(guards)('%s rejects non-strings', (_label, guard) => {
        for (const value of [null, undefined, 0, 1, true, {}, [], Symbol('x')]) {
            expect(guard(value)).toBe(false);
        }
    });

    // A bare `in` or index lookup reaches Object.prototype, which would admit
    // `toString` as a food state and write it to a TEXT column with no CHECK.
    it.each(guards)('%s rejects Object.prototype members', (_label, guard) => {
        for (const value of ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf']) {
            expect(guard(value)).toBe(false);
        }
    });

    it('declares the five food states, three provenances and five publication statuses', () => {
        expect([...CATALOG_FOOD_STATES].sort()).toEqual([
            'as_purchased',
            'cooked',
            'dry',
            'prepared',
            'raw',
        ]);
        expect([...CATALOG_NUTRITION_PROVENANCES].sort()).toEqual([
            'ai_estimated',
            'ingredient_derived',
            'source_backed',
        ]);
        expect([...CATALOG_PUBLICATION_STATUSES].sort()).toEqual([
            'candidate',
            'published',
            'quarantined',
            'rejected',
            'retired',
        ]);
    });
});

/* ---------------------------------------------------------------------------
 * The check vocabulary and its tiers
 * ------------------------------------------------------------------------- */

describe('check tiers', () => {
    it('gives every declared check name exactly one tier', () => {
        const names = Object.values(CATALOG_CHECK_NAMES);

        expect(names.length).toBeGreaterThan(0);
        for (const name of names) {
            expect(['reject', 'quarantine', 'review']).toContain(catalogCheckTier(name));
        }
    });

    it('derives the three tier lists as a sorted partition of the vocabulary', () => {
        const names = Object.values(CATALOG_CHECK_NAMES);
        const partitioned = [
            ...CATALOG_REJECT_CHECK_NAMES,
            ...CATALOG_QUARANTINE_CHECK_NAMES,
            ...CATALOG_REVIEW_CHECK_NAMES,
        ];

        expect([...partitioned].sort()).toEqual([...names].sort());
        for (const list of [
            CATALOG_REJECT_CHECK_NAMES,
            CATALOG_QUARANTINE_CHECK_NAMES,
            CATALOG_REVIEW_CHECK_NAMES,
        ]) {
            expect([...list]).toEqual([...list].sort());
        }
    });

    // The quarantine names are the coverage plan's `quarantineChecks`
    // vocabulary; `catalog-validate.ts` asserts code and data agree against
    // this derived list, so its membership is part of the contract and adding
    // one here is also a coverage-plan data change.
    it('files the seven quarantine-tier checks and the two review-tier checks', () => {
        expect([...CATALOG_QUARANTINE_CHECK_NAMES]).toEqual([
            'default_portion_count',
            'duplicate_identity',
            'missing_core_nutrient',
            'missing_density',
            'missing_gram_weight',
            'unsourced',
            'unsupported_portion',
        ]);
        expect([...CATALOG_REVIEW_CHECK_NAMES]).toEqual(['allergens_unknown', 'out_of_category_range']);
    });

    // A computed overflow is a reject, not a quarantine: the record's numbers
    // cannot be salvaged by more data arriving later.
    it('files non_finite_computed_value as reject', () => {
        expect(catalogCheckTier(CATALOG_CHECK_NAMES.NON_FINITE_COMPUTED_VALUE)).toBe('reject');
        expect(catalogCheckTier(CATALOG_CHECK_NAMES.DEFAULT_PORTION_COUNT)).toBe('quarantine');
    });

    // The tier describes the check's own severity; the disposition rule is what
    // turns a review flag into a hold for one identity source and a note for
    // the other.
    it('files out_of_category_range as review, not quarantine', () => {
        expect(catalogCheckTier(CATALOG_CHECK_NAMES.OUT_OF_CATEGORY_RANGE)).toBe('review');
        expect(catalogCheckTier(CATALOG_CHECK_NAMES.BRAND_PATTERN_NAME)).toBe('reject');
        expect(catalogCheckTier(CATALOG_CHECK_NAMES.MISSING_GRAM_WEIGHT)).toBe('quarantine');
    });
});

/* ---------------------------------------------------------------------------
 * resolveCategoryBounds
 * ------------------------------------------------------------------------- */

describe('resolveCategoryBounds', () => {
    it('returns the category-wide band when no per-state override applies', () => {
        const bounds = resolveCategoryBounds(POLICY, 'protein_poultry', 'raw');

        expect(bounds).toEqual({
            category: 'protein_poultry',
            kcalRange: { min: 80, max: 350 },
            energyMacroTolerancePercent: 15,
            kcalRangeFromFoodState: false,
        });
    });

    // Dry rice ≈ 360 kcal and cooked rice ≈ 130 do not share a plausible band.
    it('prefers the per-food-state band and says it did', () => {
        expect(resolveCategoryBounds(POLICY, 'grain', 'dry')).toEqual({
            category: 'grain',
            kcalRange: { min: 300, max: 400 },
            energyMacroTolerancePercent: 15,
            kcalRangeFromFoodState: true,
        });
        expect(resolveCategoryBounds(POLICY, 'grain', 'cooked')).toEqual({
            category: 'grain',
            kcalRange: { min: 80, max: 200 },
            energyMacroTolerancePercent: 15,
            kcalRangeFromFoodState: true,
        });
    });

    it('falls back to the category-wide band for a state the override omits', () => {
        const bounds = resolveCategoryBounds(POLICY, 'grain', 'prepared');

        expect(bounds?.kcalRange).toEqual({ min: 80, max: 400 });
        expect(bounds?.kcalRangeFromFoodState).toBe(false);
    });

    it('matches the category case- and whitespace-insensitively', () => {
        expect(resolveCategoryBounds(POLICY, '  Protein_Poultry ', 'raw')?.category).toBe('protein_poultry');
    });

    // Not a detail: a candidate under an undeclared category cannot have its
    // energy checked against anything, so validation rejects rather than
    // silently judging it against a default band.
    it('returns null for a category the plan does not declare', () => {
        expect(resolveCategoryBounds(POLICY, 'nonexistent_category', 'raw')).toBeNull();
        expect(resolveCategoryBounds({ ...POLICY, categories: [] }, 'grain', 'dry')).toBeNull();
    });
});

/* ---------------------------------------------------------------------------
 * normalizeCanonicalName
 * ------------------------------------------------------------------------- */

describe('normalizeCanonicalName', () => {
    it('lowercases, strips diacritics and collapses punctuation to single spaces', () => {
        expect(normalizeCanonicalName('Jalapeño')).toBe('jalapeno');
        expect(normalizeCanonicalName('Chicken Breast, Raw')).toBe('chicken breast raw');
        expect(normalizeCanonicalName('  Rice   (long-grain), dry  ')).toBe('rice long grain dry');
        expect(normalizeCanonicalName('crème fraîche')).toBe('creme fraiche');
    });

    // A normalisation that changed on the second application would mint a
    // different source_key for the same food on the next import and duplicate it.
    it('is idempotent', () => {
        for (const name of ['Jalapeño', '  Rice   (long-grain), dry  ', 'Olive Oil — extra virgin', 'a']) {
            const once = normalizeCanonicalName(name);
            expect(normalizeCanonicalName(once)).toBe(once);
        }
    });

    // The restricted alphabet is what makes the AI key's colon-delimited
    // segments unambiguous.
    it('never emits a colon, so the generated source key always splits into four parts', () => {
        expect(normalizeCanonicalName('soup: chicken noodle')).toBe('soup chicken noodle');
    });

    it('returns an empty string for a name with no alphanumeric content', () => {
        expect(normalizeCanonicalName('---')).toBe('');
        expect(normalizeCanonicalName('   ')).toBe('');
        expect(normalizeCanonicalName('')).toBe('');
    });
});

/* ---------------------------------------------------------------------------
 * buildSourceKey
 * ------------------------------------------------------------------------- */

describe('buildSourceKey', () => {
    it('reads the number and the canonical decimal string as one key', () => {
        expect(buildSourceKey({ identitySource: 'usda', fdcId: 171077 })).toBe('usda:171077');
        expect(buildSourceKey({ identitySource: 'usda', fdcId: '171077' })).toBe('usda:171077');
        expect(buildSourceKey({ identitySource: 'usda', fdcId: '  171077  ' })).toBe('usda:171077');
    });

    it('builds the four-segment generated key from the normalised name', () => {
        expect(
            buildSourceKey({
                identitySource: 'ai_generated',
                category: 'produce_vegetable',
                canonicalName: 'Roasted Brussels Sprouts',
                foodState: 'cooked',
            }),
        ).toBe('ai:produce_vegetable:roasted brussels sprouts:cooked');
    });

    it('lowercases and trims the category code but keeps its underscores', () => {
        expect(
            buildSourceKey({
                identitySource: 'ai_generated',
                category: '  Produce_Vegetable ',
                canonicalName: 'kale',
                foodState: 'raw',
            }),
        ).toBe('ai:produce_vegetable:kale:raw');
    });

    // Louder than a verdict on purpose: source_key is the UNIQUE upsert column,
    // so a key derived from an empty name would collapse every such candidate
    // onto one row — and a key derived from a coerced id would file a food
    // under another record's identity.
    it.each([
        ['a non-integer FDC id', { identitySource: 'usda' as const, fdcId: 17.5 }],
        ['a zero FDC id', { identitySource: 'usda' as const, fdcId: 0 }],
        ['a negative FDC id', { identitySource: 'usda' as const, fdcId: -3 }],
        ['a non-numeric FDC id', { identitySource: 'usda' as const, fdcId: 'abc' }],
        ['an empty FDC id', { identitySource: 'usda' as const, fdcId: '' }],
        // Each of these is a spelling `Number()` would have accepted with a
        // DIFFERENT value: '0171077' is a second text for one id (two keys, two
        // rows for one food), '0x10' reads as 16, '1e3' as 1000 and the unsafe
        // integer rounds onto a neighbouring record.
        ['a leading-zero FDC id', { identitySource: 'usda' as const, fdcId: '0171077' }],
        ['a hexadecimal FDC id', { identitySource: 'usda' as const, fdcId: '0x10' }],
        ['an exponent-notation FDC id', { identitySource: 'usda' as const, fdcId: '1e3' }],
        ['a signed FDC id', { identitySource: 'usda' as const, fdcId: '+171077' }],
        ['an unsafe-integer FDC id', { identitySource: 'usda' as const, fdcId: '9007199254740993' }],
        ['an unsafe-integer FDC number', { identitySource: 'usda' as const, fdcId: 2 ** 53 + 2 }],
    ])('throws CatalogIdentityError for %s', (_label, input) => {
        expect(() => buildSourceKey(input)).toThrow(CatalogIdentityError);
    });

    it('throws for a category code whose shape would make the key ambiguous', () => {
        for (const category of ['produce vegetable', 'produce:vegetable', '', 'Produce-Vegetable']) {
            expect(() =>
                buildSourceKey({
                    identitySource: 'ai_generated',
                    category,
                    canonicalName: 'kale',
                    foodState: 'raw',
                }),
            ).toThrow(CatalogIdentityError);
        }
    });

    it('throws for a canonical name with no alphanumeric content', () => {
        expect(() =>
            buildSourceKey({
                identitySource: 'ai_generated',
                category: 'produce_vegetable',
                canonicalName: '---',
                foodState: 'raw',
            }),
        ).toThrow(/canonical name with alphanumeric content/);
    });

    it('throws for a food state outside the closed set', () => {
        expect(() =>
            buildSourceKey({
                identitySource: 'ai_generated',
                category: 'produce_vegetable',
                canonicalName: 'kale',
                foodState: 'steamed' as never,
            }),
        ).toThrow(/food_state must be one of/);
    });
});

/* ---------------------------------------------------------------------------
 * parseCanonicalFdcId — the one FDC identity parser
 * ------------------------------------------------------------------------- */

/**
 * The table below is the whole contract. `usda.service.test.ts` asserts the
 * same verdicts through `normalizeFdcIds` against the parser this module now
 * owns — one function, checked from both sides — because the vendor boundary's
 * cache key and this module's `source_key` are two views of one identity, and a
 * parser that differed between them by a single accepted form would fetch one
 * food and file it under another.
 */
const CANONICAL_FDC_ID_CASES: ReadonlyArray<[string, unknown, number | null]> = [
    ['a positive integer', 171077, 171077],
    ['the canonical decimal string', '171077', 171077],
    ['a decimal string with surrounding whitespace', '  171077  ', 171077],
    ['the largest safe integer', Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
    ['zero', 0, null],
    ['a negative number', -1, null],
    ['a fraction', 1.5, null],
    ['an unsafe integer', 2 ** 53 + 2, null],
    ['NaN', Number.NaN, null],
    ['Infinity', Number.POSITIVE_INFINITY, null],
    ['the string zero', '0', null],
    ['a leading zero', '0171077', null],
    ['hexadecimal notation', '0x10', null],
    ['exponent notation', '1e3', null],
    ['a decimal point', '1.5', null],
    ['an explicit plus sign', '+171077', null],
    ['an explicit minus sign', '-171077', null],
    ['an empty string', '', null],
    ['whitespace only', '   ', null],
    ['a value past the safe integer range', '9007199254740993', null],
    ['null', null, null],
    ['undefined', undefined, null],
    ['a nested array that stringifies to a number', [1], null],
    ['an object', {}, null],
    ['a boolean', true, null],
];

describe('parseCanonicalFdcId', () => {
    it.each(CANONICAL_FDC_ID_CASES)('reads %s', (_label, value, expected) => {
        expect(parseCanonicalFdcId(value)).toBe(expected);
    });

    // The coercions the canonical rule exists to refuse, stated as the values
    // `Number()` would have produced: each is a real USDA record that is not the
    // one the text names.
    it('refuses the forms Number() would have silently retargeted', () => {
        expect(Number('0x10')).toBe(16);
        expect(parseCanonicalFdcId('0x10')).toBeNull();
        expect(Number('1e3')).toBe(1000);
        expect(parseCanonicalFdcId('1e3')).toBeNull();
        expect(Number('9007199254740993')).toBe(9007199254740992);
        expect(parseCanonicalFdcId('9007199254740993')).toBeNull();
    });
});

/* ---------------------------------------------------------------------------
 * dedupeIdentity
 * ------------------------------------------------------------------------- */

describe('dedupeIdentity', () => {
    const candidate = (
        overrides: Partial<CatalogIdentityCandidate> & Pick<CatalogIdentityCandidate, 'source_key'>,
    ): CatalogIdentityCandidate => ({
        canonical_name: 'brown rice',
        food_state: 'cooked',
        identity_source: 'ai_generated',
        ...overrides,
    });

    it('keeps every candidate when no two share a name and state', () => {
        const plan = dedupeIdentity([
            candidate({ source_key: 'ai:grain:brown rice:cooked' }),
            candidate({ source_key: 'usda:1', canonical_name: 'white rice', identity_source: 'usda' }),
        ]);

        expect(plan.survivors.map((entry) => entry.source_key)).toEqual([
            'ai:grain:brown rice:cooked',
            'usda:1',
        ]);
        expect(plan.merges).toEqual([]);
        expect(plan.duplicateSourceKeys).toEqual([]);
    });

    // Raw, cooked, dry and as-purchased forms have different energy per 100 g;
    // collapsing them would lose data and make the per-state bands meaningless.
    it('treats food state as half the identity', () => {
        const plan = dedupeIdentity([
            candidate({ source_key: 'a', food_state: 'cooked' }),
            candidate({ source_key: 'b', food_state: 'dry' }),
            candidate({ source_key: 'c', food_state: 'raw' }),
        ]);

        expect(plan.survivors).toHaveLength(3);
        expect(plan.duplicateSourceKeys).toEqual([]);
    });

    it('groups names that differ only by punctuation, case or diacritics', () => {
        const plan = dedupeIdentity([
            candidate({ source_key: 'a', canonical_name: 'Brown Rice' }),
            candidate({ source_key: 'b', canonical_name: 'brown, rice' }),
        ]);

        expect(plan.survivors).toHaveLength(1);
        expect(plan.duplicateSourceKeys).toEqual(['b']);
    });

    // An import that processed a manifest in a different sequence would
    // otherwise keep a different row and produce a catalog that no longer
    // matches its own benchmark expectations.
    it('prefers the USDA record whatever order the candidates arrived in', () => {
        const sourced = candidate({ source_key: 'usda:9', identity_source: 'usda' });
        const generated = candidate({ source_key: 'ai:grain:brown rice:cooked' });

        for (const input of [
            [sourced, generated],
            [generated, sourced],
        ]) {
            const plan = dedupeIdentity(input);

            expect(plan.survivors.map((entry) => entry.source_key)).toEqual(['usda:9']);
            expect(plan.duplicateSourceKeys).toEqual(['ai:grain:brown rice:cooked']);
        }
    });

    it('breaks a same-source tie on the lower source key, in either input order', () => {
        const first = candidate({ source_key: 'ai:a' });
        const second = candidate({ source_key: 'ai:b' });

        for (const input of [
            [first, second],
            [second, first],
        ]) {
            expect(dedupeIdentity(input).survivors.map((entry) => entry.source_key)).toEqual(['ai:a']);
        }
    });

    it("folds the loser's names into the survivor's aliases, minus what it already answers to", () => {
        const plan = dedupeIdentity([
            candidate({
                source_key: 'usda:9',
                identity_source: 'usda',
                canonical_name: 'brown rice',
                aliases: ['wholegrain rice'],
            }),
            candidate({
                source_key: 'ai:x',
                canonical_name: 'Brown Rice',
                display_name: 'Brown rice, cooked',
                aliases: ['wholegrain rice', 'brown rice cooked', '  ', 'Wholegrain Rice'],
            }),
        ]);

        expect(plan.merges).toHaveLength(1);
        expect(plan.merges[0].survivorSourceKey).toBe('usda:9');
        expect(plan.merges[0].duplicateSourceKey).toBe('ai:x');
        // Only one alias survives, and each exclusion is a rule: 'Brown Rice'
        // and 'Wholegrain Rice' normalise to names the survivor already answers
        // to, the blank alias is dropped, and 'brown rice cooked' is the
        // NORMALISED form of the display name already collected — deduplication
        // is by normalised form, so the survivor never gains two aliases that
        // differ only in case or punctuation and would both index the same way.
        expect(plan.merges[0].aliases).toEqual(['Brown rice, cooked']);
    });

    it('keeps the first spelling of two aliases that normalise alike', () => {
        const plan = dedupeIdentity([
            candidate({ source_key: 'usda:9', identity_source: 'usda', canonical_name: 'quinoa' }),
            candidate({
                source_key: 'ai:x',
                canonical_name: 'quinoa',
                aliases: ['Andean Grain', 'andean grain', 'andean, grain'],
            }),
        ]);

        expect(plan.merges[0].aliases).toEqual(['Andean Grain']);
    });

    it('returns survivors, merges and duplicate keys in a stable sorted order', () => {
        const plan = dedupeIdentity([
            candidate({ source_key: 'ai:c' }),
            candidate({ source_key: 'ai:a' }),
            candidate({ source_key: 'ai:b' }),
            candidate({ source_key: 'zzz', canonical_name: 'quinoa' }),
        ]);

        expect(plan.survivors.map((entry) => entry.source_key)).toEqual(['ai:a', 'zzz']);
        expect(plan.merges.map((entry) => entry.duplicateSourceKey)).toEqual(['ai:b', 'ai:c']);
        expect(plan.duplicateSourceKeys).toEqual(['ai:b', 'ai:c']);
    });

    it('handles an empty candidate list', () => {
        expect(dedupeIdentity([])).toEqual({ survivors: [], merges: [], duplicateSourceKeys: [] });
    });
});

/* ---------------------------------------------------------------------------
 * parseCatalogSearchQuery
 * ------------------------------------------------------------------------- */

describe('parseCatalogSearchQuery', () => {
    it('accepts a trimmed query within bounds', () => {
        expect(parseCatalogSearchQuery('  chicken  ')).toEqual({ kind: 'ok', q: 'chicken' });
        expect(parseCatalogSearchQuery('ri')).toEqual({ kind: 'ok', q: 'ri' });
        expect(parseCatalogSearchQuery('x'.repeat(MAX_SEARCH_QUERY_LENGTH))).toEqual({
            kind: 'ok',
            q: 'x'.repeat(MAX_SEARCH_QUERY_LENGTH),
        });
    });

    // `qs` yields an array when a parameter repeats; the first occurrence wins,
    // exactly as parsePagination treats a repeated `page`.
    it('takes the first occurrence of a repeated parameter', () => {
        expect(parseCatalogSearchQuery(['rice', 'beans'])).toEqual({ kind: 'ok', q: 'rice' });
        expect(parseCatalogSearchQuery([])).toMatchObject({ kind: 'error' });
    });

    it.each([
        ['undefined', undefined],
        ['null', null],
        ['a number', 7],
        ['an object', {}],
        ['an empty string', ''],
        ['whitespace only', '   '],
    ])('reports `required` for %s', (_label, value) => {
        expect(parseCatalogSearchQuery(value)).toEqual({
            kind: 'error',
            code: 'invalid_request',
            message: 'q is required',
            details: [{ field: 'q', code: 'required' }],
        });
    });

    // A one-character query matches most of a ten-thousand-item catalog, so it
    // is refused rather than served.
    it('reports `invalid_length` outside the two-to-sixty band', () => {
        for (const raw of ['x', ' y ', 'x'.repeat(MAX_SEARCH_QUERY_LENGTH + 1)]) {
            expect(parseCatalogSearchQuery(raw)).toEqual({
                kind: 'error',
                code: 'invalid_request',
                message: `q must be between ${MIN_SEARCH_QUERY_LENGTH} and ${MAX_SEARCH_QUERY_LENGTH} characters`,
                details: [{ field: 'q', code: 'invalid_length' }],
            });
        }
    });

    // The regression guard. A U+0000 cannot be represented in a PostgreSQL
    // `text` value at all, and `q` reaches `plainto_tsquery` and the alias
    // `LIKE` as a BOUND PARAMETER, so a query the parser answered `ok` failed
    // while the parameter was being bound — SQLSTATE 22021 wrapped as Prisma
    // P2010 — instead of returning a validation verdict.
    it.each([
        ['an interior NUL byte', 'zen\u0000til'],
        ['a trailing NUL byte', 'a\u0000'],
    ])('reports `invalid_characters` for %s', (_label, raw) => {
        expect(parseCatalogSearchQuery(raw)).toEqual({
            kind: 'error',
            code: 'invalid_request',
            message: 'q must not contain control characters',
            details: [{ field: 'q', code: 'invalid_characters' }],
        });
    });

    it.each([
        ['U+0001, start of heading', 'ri\u0001ce'],
        ['U+001F, unit separator', 'ri\u001fce'],
        ['U+007F, DEL', 'ri\u007fce'],
        ['an interior newline', 'zen\ntil'],
    ])('reports `invalid_characters` for %s inside an otherwise valid query', (_label, raw) => {
        expect(parseCatalogSearchQuery(raw)).toEqual({
            kind: 'error',
            code: 'invalid_request',
            message: 'q must not contain control characters',
            details: [{ field: 'q', code: 'invalid_characters' }],
        });
    });

    // Precedence: the length of a string carrying control bytes is not a
    // meaningful complaint, so the character class is checked first — in both
    // directions, a query too long and one too short.
    it('reports `invalid_characters` rather than `invalid_length` for an out-of-band query', () => {
        const controlCharacterVerdict = {
            kind: 'error',
            code: 'invalid_request',
            message: 'q must not contain control characters',
            details: [{ field: 'q', code: 'invalid_characters' }],
        };
        const tooLong = `${'x'.repeat(MAX_SEARCH_QUERY_LENGTH)}\u0000`;

        expect(tooLong.length).toBe(MAX_SEARCH_QUERY_LENGTH + 1);
        expect(parseCatalogSearchQuery(tooLong)).toEqual(controlCharacterVerdict);
        // NUL is not whitespace, so this survives `trim` as a one-character
        // query and is refused for what it carries, not for its length.
        expect(parseCatalogSearchQuery('\u0000')).toEqual(controlCharacterVerdict);
    });

    // The other side of the new branch. `trim` removes the edge whitespace
    // before the class is tested, so a tab or newline around a query is not
    // what this rejects, and every non-control character is still searchable
    // text.
    it('accepts a query padded with whitespace control characters', () => {
        expect(parseCatalogSearchQuery('\t chicken \n')).toEqual({ kind: 'ok', q: 'chicken' });
    });

    it.each([
        ['accented text', 'café — crème brûlée'],
        ['a well-formed emoji', 'salad \ud83e\udd57 bowl'],
    ])('accepts %s unchanged', (_label, raw) => {
        expect(parseCatalogSearchQuery(raw)).toEqual({ kind: 'ok', q: raw });
    });
});

/* ---------------------------------------------------------------------------
 * findBrandPatternMatch
 * ------------------------------------------------------------------------- */

describe('findBrandPatternMatch', () => {
    it('fires on a trademark claim in any spelling', () => {
        expect(findBrandPatternMatch(['Crunchy Flakes®'])).toMatchObject({
            reason: 'trademark_symbol',
            value: 'Crunchy Flakes®',
        });
        expect(findBrandPatternMatch(['Crunchy Flakes™'])?.reason).toBe('trademark_symbol');
        expect(findBrandPatternMatch(['Crunchy Flakes(R)'])?.reason).toBe('trademark_symbol');
        expect(findBrandPatternMatch(['Crunchy Flakes(tm)'])?.reason).toBe('trademark_symbol');
    });

    it('fires on a curated brand word wherever it sits in the name', () => {
        expect(findBrandPatternMatch(['coca cola classic'])).toMatchObject({
            reason: 'brand_word',
            token: 'coca',
        });
        expect(findBrandPatternMatch(['yogurt, chobani plain'])).toMatchObject({
            reason: 'brand_word',
            token: 'chobani',
        });
    });

    it('fires on a non-leading proper noun followed by a product form', () => {
        expect(findBrandPatternMatch(['granola Kettle crunch'])).toMatchObject({
            reason: 'proper_noun_product_form',
            token: 'Kettle crunch',
        });
    });

    // The fabricated names the reject tier exists for. A brand at position zero
    // used to escape the check entirely, which made the mandatory rejection
    // depend on the brand happening to sit mid-name.
    it.each([
        ['Acme Bar', 'Acme bar'],
        ['Nova Drink', 'Nova drink'],
        ['Zesta Crisps', 'Zesta crisps'],
        // The capitalised form need not be adjacent: the name is still written
        // as a product.
        ['Acme Protein Bar', 'Acme bar'],
    ])('fires on the leading proper noun of %s', (name, token) => {
        expect(findBrandPatternMatch([name])).toMatchObject({
            value: name,
            reason: 'proper_noun_product_form',
            token,
        });
    });

    // "Chicken Broth" is a preparation; only a brand attached to a product form
    // is a product. The sentence-case names below all pair a capitalised first
    // word with a product form and must NOT fire — their leading capital is
    // English, not branding.
    it('does not fire on a generic preparation', () => {
        for (const name of [
            'chicken breast, raw',
            'Chicken Broth',
            'granola bars',
            'rolled oats, dry',
            'olive oil, extra virgin',
            'Protein bar',
            'Orange juice',
            'Breakfast cereal',
            'Trail mix',
            'Greek yogurt',
            'Rice cereal, cooked',
        ]) {
            expect(findBrandPatternMatch([name])).toBeNull();
        }
    });

    // A leading proper noun on its own proves nothing, so the product form has
    // to be there too.
    it('does not fire on a leading proper noun with no product form after it', () => {
        expect(findBrandPatternMatch(['Acme tomatoes, raw'])).toBeNull();
        expect(findBrandPatternMatch(['Nova greens'])).toBeNull();
    });

    it('scans aliases as well as the name and reports which value fired', () => {
        const match = findBrandPatternMatch(['rolled oats', 'Cheerios style oats']);

        expect(match).toMatchObject({ value: 'Cheerios style oats', reason: 'brand_word' });
    });

    it('skips blank and non-string values instead of throwing', () => {
        expect(findBrandPatternMatch(['', '   ', null as never, 7 as never, 'rolled oats'])).toBeNull();
        expect(findBrandPatternMatch([])).toBeNull();
    });

    // Vocabulary, not a threshold: the policy may replace both lists without a
    // code change.
    it('honours replacement vocabularies', () => {
        expect(
            findBrandPatternMatch(['acme rolled oats'], { brandWords: ['acme'] }),
        ).toMatchObject({ reason: 'brand_word', token: 'acme' });
        // The default brand word is no longer in the replacement list.
        expect(findBrandPatternMatch(['pepsi cola'], { brandWords: ['acme'] })).toBeNull();
        expect(
            findBrandPatternMatch(['oats Kettle thing'], { productFormWords: ['thing'] }),
        ).toMatchObject({ reason: 'proper_noun_product_form' });
    });

    it('exposes non-empty default vocabularies', () => {
        expect(DEFAULT_BRAND_WORDS.length).toBeGreaterThan(0);
        expect(DEFAULT_PRODUCT_FORM_WORDS.length).toBeGreaterThan(0);
    });
});

/* ---------------------------------------------------------------------------
 * normalizeToPer100g
 * ------------------------------------------------------------------------- */

describe('normalizeToPer100g', () => {
    const source = (overrides: Partial<CatalogNutritionSource> = {}): CatalogNutritionSource => ({
        nutrition_basis: 'per_100g',
        basis_amount: 100,
        calories: 200,
        protein_g: 10,
        carbs_g: 20,
        fat_g: 8,
        ...overrides,
    });

    it('passes a per-100 g record through with a unit factor', () => {
        const result = normalizeToPer100g(source());

        expect(result.kind).toBe('ok');
        if (result.kind !== 'ok') {
            return;
        }
        expect(result.normalized.nutrition_basis).toBe('per_100g');
        expect(result.normalized.basis_amount).toBe(PER_100G_BASIS_AMOUNT);
        expect(result.normalized.basisGrams).toBe(100);
        expect(result.normalized.factor).toBe(1);
        expect(result.normalized.nutrition).toEqual({
            calories: 200,
            protein_g: 10,
            carbs_g: 20,
            fat_g: 8,
            fiber_g: null,
        });
    });

    it('rescales a basis that is not 100 units', () => {
        const result = normalizeToPer100g(source({ basis_amount: 50 }));

        expect(result.kind).toBe('ok');
        if (result.kind !== 'ok') {
            return;
        }
        expect(result.normalized.factor).toBe(2);
        expect(result.normalized.nutrition.calories).toBe(400);
    });

    // Null is never coerced to 0 — a zero claims the food contains none of the
    // nutrient, which for fibre is a claim the source did not make.
    it('keeps an unknown nutrient unknown through the rescale', () => {
        const result = normalizeToPer100g(source({ basis_amount: 50, fiber_g: null, carbs_g: null }));

        expect(result.kind).toBe('ok');
        if (result.kind !== 'ok') {
            return;
        }
        expect(result.normalized.nutrition.carbs_g).toBeNull();
        expect(result.normalized.nutrition.fiber_g).toBeNull();
        expect(result.normalized.nutrition.calories).toBe(400);
    });

    it('converts a volume basis through the stored density', () => {
        const result = normalizeToPer100g(
            source({ nutrition_basis: 'per_100ml', density_g_per_ml: 0.5 }),
        );

        expect(result.kind).toBe('ok');
        if (result.kind !== 'ok') {
            return;
        }
        // 100 ml at 0.5 g/ml weighs 50 g, so the per-100 g values double.
        expect(result.normalized.basisGrams).toBe(50);
        expect(result.normalized.nutrition.calories).toBe(400);
    });

    // Millilitres never equal grams: a missing density is a quarantine, not an
    // assumption of 1 g/ml.
    it.each([
        ['a missing density', undefined],
        ['a null density', null],
        ['a zero density', 0],
        ['a negative density', -1],
        ['a non-finite density', Number.NaN],
    ])('reports missing_density for %s on a volume basis', (_label, density) => {
        const result = normalizeToPer100g(
            source({ nutrition_basis: 'per_100ml', density_g_per_ml: density }),
        );

        expect(result.kind).toBe('error');
        if (result.kind !== 'error') {
            return;
        }
        expect(result.check.name).toBe(CATALOG_CHECK_NAMES.MISSING_DENSITY);
        expect(result.check.tier).toBe('quarantine');
        expect(result.check.pass).toBe(false);
    });

    it('converts a per-serving basis through the serving gram weight', () => {
        const result = normalizeToPer100g(
            source({ nutrition_basis: 'per_serving', basis_amount: 1, serving_gram_weight: 40 }),
        );

        expect(result.kind).toBe('ok');
        if (result.kind !== 'ok') {
            return;
        }
        expect(result.normalized.basisGrams).toBe(40);
        expect(result.normalized.nutrition.calories).toBe(500);
    });

    // `basis_amount` counts SERVINGS on this basis. Reading a two-serving label
    // as one serving halves the basis mass and so DOUBLES every per-100 g
    // value — the silent kind of wrong, because the result still looks like
    // food.
    it.each([
        ['two servings', 2, 80, 250],
        ['half a serving', 0.5, 20, 1000],
        ['two and a half servings', 2.5, 100, 200],
    ])(
        'multiplies the serving weight by a basis amount of %s',
        (_label, basisAmount, expectedGrams, expectedCalories) => {
            const result = normalizeToPer100g(
                source({
                    nutrition_basis: 'per_serving',
                    basis_amount: basisAmount,
                    serving_gram_weight: 40,
                }),
            );

            expect(result.kind).toBe('ok');
            if (result.kind !== 'ok') {
                return;
            }
            expect(result.normalized.basisGrams).toBe(expectedGrams);
            expect(result.normalized.nutrition.calories).toBe(expectedCalories);
        },
    );

    // Inventing a weight is exactly the fabricated nutrition the catalog policy
    // forbids, so the record is quarantined and never counts toward the 10,000.
    it.each([
        ['no weight', undefined],
        ['a null weight', null],
        ['a zero weight', 0],
        ['a negative weight', -5],
        ['a non-finite weight', Number.POSITIVE_INFINITY],
    ])('reports missing_gram_weight for a per-serving record with %s', (_label, weight) => {
        const result = normalizeToPer100g(
            source({ nutrition_basis: 'per_serving', basis_amount: 1, serving_gram_weight: weight }),
        );

        expect(result.kind).toBe('error');
        if (result.kind !== 'error') {
            return;
        }
        expect(result.check.name).toBe(CATALOG_CHECK_NAMES.MISSING_GRAM_WEIGHT);
        expect(result.check.tier).toBe('quarantine');
    });

    it.each([
        ['zero', 0],
        ['negative', -100],
        ['NaN', Number.NaN],
        ['Infinity', Number.POSITIVE_INFINITY],
    ])('reports invalid_basis_amount for a %s basis amount', (_label, amount) => {
        const result = normalizeToPer100g(source({ basis_amount: amount }));

        expect(result.kind).toBe('error');
        if (result.kind !== 'error') {
            return;
        }
        expect(result.check.name).toBe(CATALOG_CHECK_NAMES.INVALID_BASIS_AMOUNT);
        expect(result.check.tier).toBe('reject');
    });

    // A record parsed from JSON is screened by isCatalogNutritionBasis before it
    // reaches here, so arriving with anything else is a programming error.
    it('throws for a basis outside the three declared values', () => {
        expect(() =>
            normalizeToPer100g(source({ nutrition_basis: 'per_pound' as never })),
        ).toThrow(CatalogIdentityError);
    });

    /**
     * Every input below is finite and individually plausible to a
     * finiteness check; it is the product, the quotient or the sum that is not a
     * real number. An unguarded overflow does not fail loudly — it either stores
     * `Infinity` in a `DOUBLE PRECISION` column and `null` in the JSONB audit
     * record, or divides to a plausible-looking zero.
     */
    describe('computed values that overflow', () => {
        it('reports a basis mass a finite volume and density multiplied out of range', () => {
            const result = normalizeToPer100g(
                source({
                    nutrition_basis: 'per_100ml',
                    basis_amount: 1e308,
                    density_g_per_ml: 10,
                }),
            );

            expect(result.kind).toBe('error');
            if (result.kind !== 'error') {
                return;
            }
            // NOT missing_density: the density is present and usable, so a
            // `missing_density` verdict would send an operator looking for data
            // that is already there.
            expect(result.check.name).toBe(CATALOG_CHECK_NAMES.NON_FINITE_COMPUTED_VALUE);
            expect(result.check.tier).toBe('reject');
            expect(typeof result.check.observed).toBe('string');
        });

        it('reports a basis mass a serving count multiplied out of range', () => {
            const result = normalizeToPer100g(
                source({
                    nutrition_basis: 'per_serving',
                    basis_amount: 1e308,
                    serving_gram_weight: 40,
                }),
            );

            expect(result.kind).toBe('error');
            if (result.kind !== 'error') {
                return;
            }
            expect(result.check.name).toBe(CATALOG_CHECK_NAMES.NON_FINITE_COMPUTED_VALUE);
            expect(String(result.check.observed)).toContain('per_serving');
        });

        // A denormal basis mass divides into an infinite factor, which would
        // scale every stated nutrient to Infinity.
        it('reports a rescale factor a denormal basis divided out of range', () => {
            const result = normalizeToPer100g(source({ basis_amount: 5e-324 }));

            expect(result.kind).toBe('error');
            if (result.kind !== 'error') {
                return;
            }
            expect(result.check.name).toBe(CATALOG_CHECK_NAMES.NON_FINITE_COMPUTED_VALUE);
            expect(String(result.check.observed)).toContain('factor=');
        });

        it('reports a nutrient the rescale multiplied out of range, naming the field', () => {
            const result = normalizeToPer100g(source({ basis_amount: 1e-100, calories: 1e308 }));

            expect(result.kind).toBe('error');
            if (result.kind !== 'error') {
                return;
            }
            expect(result.check.name).toBe(CATALOG_CHECK_NAMES.NON_FINITE_COMPUTED_VALUE);
            expect(String(result.check.observed)).toContain('calories=Infinity');
        });

        // The record is auditable or it is not: JSONB has no Infinity and no
        // NaN, so an observation that is not finite is recorded as text.
        it('records the observation as text rather than as a number JSONB cannot hold', () => {
            const result = normalizeToPer100g(
                source({ nutrition_basis: 'per_serving', basis_amount: 1e308, serving_gram_weight: 40 }),
            );

            expect(result.kind).toBe('error');
            if (result.kind !== 'error') {
                return;
            }
            expect(JSON.parse(JSON.stringify(result.check)).observed).toBe(result.check.observed);
        });
    });
});

/* ---------------------------------------------------------------------------
 * deriveComponentNutrition
 * ------------------------------------------------------------------------- */

describe('deriveComponentNutrition', () => {
    const component = (
        quantityGrams: number,
        yieldFactor: number,
        nutrition: { calories: number | null; protein_g: number | null; carbs_g: number | null; fat_g: number | null; fiber_g?: number | null },
        extras: { sort_order?: number; component_catalog_food_id?: string } = {},
    ) => ({
        quantity_grams: quantityGrams,
        yield_factor: yieldFactor,
        component_nutrition_version: 1,
        nutrition,
        ...extras,
    });

    it('sums component contributions and divides by the finished weight', () => {
        const result = deriveComponentNutrition([
            component(100, 1, { calories: 100, protein_g: 10, carbs_g: 5, fat_g: 2, fiber_g: 1 }),
            component(100, 1, { calories: 200, protein_g: 20, carbs_g: 10, fat_g: 4, fiber_g: 2 }),
        ]);

        expect(result.kind).toBe('ok');
        if (result.kind !== 'ok') {
            return;
        }
        expect(result.derived.inputGrams).toBe(200);
        expect(result.derived.yieldedGrams).toBe(200);
        expect(result.derived.nutrition).toEqual({
            calories: 150,
            protein_g: 15,
            carbs_g: 7.5,
            fat_g: 3,
            fiber_g: 1.5,
        });
        expect(result.derived.nutrition_basis).toBe('per_100g');
        expect(result.derived.componentNutritionVersions).toEqual([1, 1]);
    });

    // Cooking changes MASS, not nutrients: losing water does not lose protein,
    // so a food that loses half its water is twice as energy-dense per 100 g.
    it('applies the yield factor to mass only', () => {
        const result = deriveComponentNutrition([
            component(200, 0.5, { calories: 100, protein_g: 10, carbs_g: 0, fat_g: 0 }),
        ]);

        expect(result.kind).toBe('ok');
        if (result.kind !== 'ok') {
            return;
        }
        expect(result.derived.inputGrams).toBe(200);
        expect(result.derived.yieldedGrams).toBe(100);
        expect(result.derived.nutrition.calories).toBe(200);
        expect(result.derived.nutrition.protein_g).toBe(20);
    });

    // Always ingredient_derived: the components may each be source-backed, but
    // the QUANTITIES are assumed, so the result is an estimate.
    it('labels the result ingredient_derived', () => {
        const result = deriveComponentNutrition([
            component(100, 1, { calories: 100, protein_g: 1, carbs_g: 1, fat_g: 1 }),
        ]);

        expect(result.kind === 'ok' && result.derived.nutrition_provenance).toBe('ingredient_derived');
        expect(isEstimatedNutrition('ingredient_derived')).toBe(true);
    });

    // A sum missing a term is not a smaller sum.
    it('makes a nutrient unknown when any component does not state it', () => {
        const result = deriveComponentNutrition([
            component(100, 1, { calories: 100, protein_g: 10, carbs_g: 5, fat_g: 2, fiber_g: null }),
            component(100, 1, { calories: 200, protein_g: 20, carbs_g: 10, fat_g: 4, fiber_g: 2 }),
        ]);

        expect(result.kind).toBe('ok');
        if (result.kind !== 'ok') {
            return;
        }
        expect(result.derived.nutrition.fiber_g).toBeNull();
        expect(result.derived.nutrition.calories).toBe(150);
    });

    it('treats an omitted fiber value as unknown', () => {
        const result = deriveComponentNutrition([
            component(100, 1, { calories: 100, protein_g: 1, carbs_g: 1, fat_g: 1 }),
        ]);

        expect(result.kind === 'ok' && result.derived.nutrition.fiber_g).toBeNull();
    });

    // Floating-point addition is not associative: the same rows arriving in a
    // different sequence must not produce a result that differs in the last bits
    // and reads as a staleness change on the next refresh.
    it('sums in sort_order then component id, independently of array order', () => {
        const a = component(33.3, 1, { calories: 111.1, protein_g: 1.1, carbs_g: 2.2, fat_g: 3.3 }, {
            sort_order: 0,
            component_catalog_food_id: 'aaa',
        });
        const b = component(66.7, 1, { calories: 222.2, protein_g: 2.2, carbs_g: 4.4, fat_g: 6.6 }, {
            sort_order: 0,
            component_catalog_food_id: 'bbb',
        });
        const c = component(10.1, 1, { calories: 333.3, protein_g: 3.3, carbs_g: 6.6, fat_g: 9.9 }, {
            sort_order: 1,
            component_catalog_food_id: 'ccc',
        });

        const forward = deriveComponentNutrition([a, b, c]);
        const shuffled = deriveComponentNutrition([c, b, a]);

        expect(forward).toEqual(shuffled);
    });

    it('orders components with equal sort order and no id by their array position', () => {
        const first = component(50, 1, { calories: 100, protein_g: 1, carbs_g: 1, fat_g: 1 });
        const second = component(50, 1, { calories: 300, protein_g: 3, carbs_g: 3, fat_g: 3 });
        const result = deriveComponentNutrition([first, second]);

        expect(result.kind === 'ok' && result.derived.nutrition.calories).toBe(200);
    });

    it('reports empty_component_set for a food declaring no components', () => {
        const result = deriveComponentNutrition([]);

        expect(result.kind).toBe('error');
        if (result.kind !== 'error') {
            return;
        }
        expect(result.check.name).toBe(CATALOG_CHECK_NAMES.EMPTY_COMPONENT_SET);
        expect(result.check.tier).toBe('reject');
    });

    it.each([
        ['a zero quantity', 0, 1],
        ['a negative quantity', -10, 1],
        ['a non-finite quantity', Number.NaN, 1],
        ['a zero yield factor', 100, 0],
        ['a negative yield factor', 100, -1],
        ['a non-finite yield factor', 100, Number.POSITIVE_INFINITY],
    ])('reports invalid_component_quantity for %s', (_label, quantity, yieldFactor) => {
        const result = deriveComponentNutrition([
            component(quantity, yieldFactor, { calories: 1, protein_g: 1, carbs_g: 1, fat_g: 1 }),
        ]);

        expect(result.kind).toBe('error');
        if (result.kind !== 'error') {
            return;
        }
        expect(result.check.name).toBe(CATALOG_CHECK_NAMES.INVALID_COMPONENT_QUANTITY);
        expect(result.check.tier).toBe('reject');
    });

    /**
     * Each component below passes the per-component positivity check; it is the
     * AGGREGATE that leaves the range of a double. The infinite finished weight
     * is the dangerous case: `total / Infinity` is exactly 0, so without a guard
     * the food would publish with stored nutrition claiming it contains nothing.
     */
    describe('aggregates that overflow', () => {
        it('reports a finished weight the yield factors multiplied out of range', () => {
            const result = deriveComponentNutrition([
                component(1e308, 10, { calories: 1, protein_g: 1, carbs_g: 1, fat_g: 1 }),
            ]);

            expect(result.kind).toBe('error');
            if (result.kind !== 'error') {
                return;
            }
            expect(result.check.name).toBe(CATALOG_CHECK_NAMES.NON_FINITE_COMPUTED_VALUE);
            expect(result.check.tier).toBe('reject');
            expect(String(result.check.observed)).toContain('yieldedGrams=Infinity');
        });

        it('reports an input weight the quantities summed out of range', () => {
            const result = deriveComponentNutrition([
                component(1.5e308, 1, { calories: 1, protein_g: 1, carbs_g: 1, fat_g: 1 }),
                component(1.5e308, 1, { calories: 1, protein_g: 1, carbs_g: 1, fat_g: 1 }),
            ]);

            expect(result.kind).toBe('error');
            if (result.kind !== 'error') {
                return;
            }
            expect(result.check.name).toBe(CATALOG_CHECK_NAMES.NON_FINITE_COMPUTED_VALUE);
            expect(String(result.check.observed)).toContain('inputGrams=Infinity');
        });

        // A known-but-unrepresentable total is neither a value nor an unknown,
        // and `null` would claim the components never stated it.
        it('fails the derivation rather than recording an overflowed total as unknown', () => {
            const result = deriveComponentNutrition([
                component(1e300, 1, { calories: 1e300, protein_g: 1, carbs_g: 1, fat_g: 1 }),
            ]);

            expect(result.kind).toBe('error');
            if (result.kind !== 'error') {
                return;
            }
            expect(result.check.name).toBe(CATALOG_CHECK_NAMES.NON_FINITE_COMPUTED_VALUE);
            expect(String(result.check.observed)).toContain('calories');
        });

        it('never returns a derived value that is not a real number', () => {
            const result = deriveComponentNutrition([
                component(1e308, 1, { calories: 1e308, protein_g: 1e308, carbs_g: 1, fat_g: 1 }),
            ]);

            expect(result.kind).toBe('error');
        });
    });
});

/* ---------------------------------------------------------------------------
 * The grocery aisle mapping
 * ------------------------------------------------------------------------- */

describe('mapCategoryToGroceryCategory', () => {
    it.each([
        ['produce_vegetable', 'produce'],
        ['produce_fruit', 'produce'],
        ['produce', 'produce'],
        ['protein_meat', 'protein'],
        ['protein_seafood', 'protein'],
        ['dairy', 'dairy_alternatives'],
        ['dairy_alternative', 'dairy_alternatives'],
        ['grain', 'grains_bread'],
        ['bread_bakery', 'grains_bread'],
    ])('files %s under %s', (category, expected) => {
        expect(mapCategoryToGroceryCategory(category)).toBe(expected);
    });

    it.each(['condiment_sauce', 'spice_herb', 'beverage', 'snack', 'sweet', 'prepared_meal', 'other'])(
        'closes the list with pantry_other for %s',
        (category) => {
            expect(mapCategoryToGroceryCategory(category)).toBe('pantry_other');
        },
    );

    // Total by construction: an undefined aisle would silently drop the row from
    // the shopping list.
    it('is total — an unknown or empty category still resolves to an aisle', () => {
        for (const category of ['', '   ', 'category_a_future_plan_adds', 'toString', '__proto__']) {
            expect(isGroceryCategory(mapCategoryToGroceryCategory(category))).toBe(true);
        }
        expect(mapCategoryToGroceryCategory('category_a_future_plan_adds')).toBe('pantry_other');
    });

    // Matching is by prefix so a new sibling files itself beside its family
    // instead of falling to the pantry.
    it('files an unseen sibling beside its family', () => {
        expect(mapCategoryToGroceryCategory('produce_herb')).toBe('produce');
        expect(mapCategoryToGroceryCategory('protein_insect')).toBe('protein');
    });

    it('matches case- and whitespace-insensitively but not on a bare substring', () => {
        expect(mapCategoryToGroceryCategory('  Produce_Vegetable ')).toBe('produce');
        // "produceish" is not the `produce` family: the prefix must be the whole
        // code or be followed by an underscore.
        expect(mapCategoryToGroceryCategory('produceish')).toBe('pantry_other');
    });

    it('orders the aisles with pantry_other last', () => {
        expect(groceryCategorySortIndex('produce')).toBe(0);
        expect(groceryCategorySortIndex('pantry_other')).toBe(GROCERY_CATEGORY_ORDER.length - 1);
        const indexes = GROCERY_CATEGORY_ORDER.map(groceryCategorySortIndex);
        expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
    });
});

/* ---------------------------------------------------------------------------
 * resolveCatalogDisposition
 * ------------------------------------------------------------------------- */

describe('resolveCatalogDisposition', () => {
    it('publishes a clean check list', () => {
        const disposition = resolveCatalogDisposition(
            [passingCheck('kcal_ceiling', 'reject'), passingCheck('unsourced', 'quarantine')],
            { identitySource: 'usda' },
        );

        expect(disposition).toEqual({
            publicationStatus: 'published',
            outcome: 'accepted',
            reviewFlags: [],
            decidingCheckNames: [],
            countsTowardPublishedTarget: true,
        });
    });

    it('rejects when any reject-tier check failed, whatever else did', () => {
        const disposition = resolveCatalogDisposition(
            [
                failingCheck('kcal_ceiling', 'reject'),
                failingCheck('unsourced', 'quarantine'),
                failingCheck('allergens_unknown', 'review'),
            ],
            { identitySource: 'usda' },
        );

        expect(disposition.publicationStatus).toBe('rejected');
        expect(disposition.outcome).toBe('rejected');
        expect(disposition.decidingCheckNames).toEqual(['kcal_ceiling']);
        // The review flag is still recorded — it is the informational part.
        expect(disposition.reviewFlags).toEqual(['allergens_unknown']);
        expect(disposition.countsTowardPublishedTarget).toBe(false);
    });

    it('quarantines when a quarantine-tier check failed and no reject-tier one did', () => {
        const disposition = resolveCatalogDisposition(
            [failingCheck('missing_core_nutrient', 'quarantine'), failingCheck('unsourced', 'quarantine')],
            { identitySource: 'usda' },
        );

        expect(disposition.publicationStatus).toBe('quarantined');
        expect(disposition.outcome).toBe('quarantined');
        expect(disposition.decidingCheckNames).toEqual(['missing_core_nutrient', 'unsourced']);
        expect(disposition.countsTowardPublishedTarget).toBe(false);
    });

    // The source is authoritative and the flag is informational.
    it('publishes a USDA record that only tripped a review flag, and records the flag', () => {
        const disposition = resolveCatalogDisposition(
            [failingCheck('out_of_category_range', 'review')],
            { identitySource: 'usda' },
        );

        expect(disposition.publicationStatus).toBe('published');
        expect(disposition.reviewFlags).toEqual(['out_of_category_range']);
        expect(disposition.decidingCheckNames).toEqual([]);
    });

    it('holds a generated record against the same review flag', () => {
        const disposition = resolveCatalogDisposition(
            [failingCheck('out_of_category_range', 'review')],
            { identitySource: 'ai_generated' },
        );

        expect(disposition.publicationStatus).toBe('quarantined');
        expect(disposition.decidingCheckNames).toEqual(['out_of_category_range']);
        expect(disposition.reviewFlags).toEqual(['out_of_category_range']);
    });

    it('lifts a held review flag when the advisory review confirmed it', () => {
        const disposition = resolveCatalogDisposition(
            [failingCheck('out_of_category_range', 'review')],
            {
                identitySource: 'ai_generated',
                advisoryReview: { confirmedCheckNames: ['out_of_category_range'] },
            },
        );

        expect(disposition.publicationStatus).toBe('published');
        expect(disposition.reviewFlags).toEqual(['out_of_category_range']);
    });

    it('lifts a held review flag when a curator allowlisted it', () => {
        const disposition = resolveCatalogDisposition(
            [failingCheck('allergens_unknown', 'review')],
            {
                identitySource: 'ai_generated',
                curatorAllowlistedCheckNames: ['allergens_unknown'],
            },
        );

        expect(disposition.publicationStatus).toBe('published');
    });

    it('keeps holding a generated record when only some review flags were lifted', () => {
        const disposition = resolveCatalogDisposition(
            [
                failingCheck('out_of_category_range', 'review'),
                failingCheck('allergens_unknown', 'review'),
            ],
            {
                identitySource: 'ai_generated',
                advisoryReview: { confirmedCheckNames: ['out_of_category_range'] },
            },
        );

        expect(disposition.publicationStatus).toBe('quarantined');
        expect(disposition.decidingCheckNames).toEqual(['allergens_unknown']);
    });

    it('tolerates an absent, null or empty advisory review', () => {
        for (const advisoryReview of [undefined, null, {}, { confirmedCheckNames: [] }]) {
            const disposition = resolveCatalogDisposition(
                [failingCheck('out_of_category_range', 'review')],
                { identitySource: 'ai_generated', advisoryReview },
            );

            expect(disposition.publicationStatus).toBe('quarantined');
        }
    });

    // Structural rather than a promise: a reject- or quarantine-tier failure
    // returns before the review branch is reached.
    it('never lets an advisory review overturn a rejection or a quarantine', () => {
        const context = {
            identitySource: 'ai_generated' as const,
            advisoryReview: {
                confirmedCheckNames: ['kcal_ceiling', 'missing_core_nutrient', 'out_of_category_range'],
            },
            curatorAllowlistedCheckNames: ['kcal_ceiling', 'missing_core_nutrient'],
        };

        expect(
            resolveCatalogDisposition([failingCheck('kcal_ceiling', 'reject')], context).publicationStatus,
        ).toBe('rejected');
        expect(
            resolveCatalogDisposition([failingCheck('missing_core_nutrient', 'quarantine')], context)
                .publicationStatus,
        ).toBe('quarantined');
    });

    it('publishes an empty check list', () => {
        expect(resolveCatalogDisposition([], { identitySource: 'ai_generated' }).publicationStatus).toBe(
            'published',
        );
    });
});

/* ---------------------------------------------------------------------------
 * validateCatalogCandidate
 * ------------------------------------------------------------------------- */

describe('validateCatalogCandidate', () => {
    it('publishes a well-formed, source-backed candidate', () => {
        const verdict = validateCatalogCandidate(publishableCandidate(), POLICY);

        expect(verdict.publicationStatus).toBe('published');
        expect(verdict.outcome).toBe('accepted');
        expect(verdict.decidingCheckNames).toEqual([]);
        expect(verdict.reviewFlags).toEqual([]);
        expect(verdict.countsTowardPublishedTarget).toBe(true);
        expect(verdict.normalizedNutrition).toEqual({
            calories: 120,
            protein_g: 22.5,
            carbs_g: 0,
            fat_g: 2.6,
            fiber_g: 0,
        });
        expect(verdict.checks.every((check) => check.pass)).toBe(true);
    });

    // Every entry carries what was observed, the bound it was judged against and
    // the tier that governs it, so catalog-report.ts can group failures without
    // consulting this code.
    it('records every evaluated check with a tier', () => {
        const verdict = validateCatalogCandidate(publishableCandidate(), POLICY);

        expect(verdict.checks.length).toBeGreaterThan(0);
        for (const check of verdict.checks) {
            expect(['reject', 'quarantine', 'review']).toContain(check.tier);
            expect(check.tier).toBe(catalogCheckTier(check.name as never));
            expect(typeof check.pass).toBe('boolean');
        }
    });

    // A USDA Branded record legitimately carries a brand, which the vendor — not
    // a model — asserted.
    it('judges only a generated candidate on its name', () => {
        const branded = { canonical_name: 'Cheerios cereal', display_name: 'Cheerios' };

        expect(
            checkNamed(
                validateCatalogCandidate(publishableCandidate(branded), POLICY).checks,
                CATALOG_CHECK_NAMES.BRAND_PATTERN_NAME,
            ),
        ).toBeUndefined();

        const generated = validateCatalogCandidate(
            publishableCandidate({
                ...branded,
                identity_source: 'ai_generated',
                source_key: 'ai:protein_poultry:cheerios cereal:raw',
            }),
            POLICY,
        );

        expect(generated.publicationStatus).toBe('rejected');
        expect(generated.decidingCheckNames).toContain(CATALOG_CHECK_NAMES.BRAND_PATTERN_NAME);
    });

    it('rejects a candidate filed under an undeclared category', () => {
        const verdict = validateCatalogCandidate(
            publishableCandidate({ category: 'not_in_the_plan' }),
            POLICY,
        );

        expect(verdict.publicationStatus).toBe('rejected');
        expect(verdict.decidingCheckNames).toContain(CATALOG_CHECK_NAMES.UNKNOWN_CATEGORY);
        // With no bounds there is nothing to judge energy against, so neither the
        // mismatch nor the range check is recorded as a pass.
        expect(checkNamed(verdict.checks, CATALOG_CHECK_NAMES.ENERGY_MACRO_MISMATCH)).toBeUndefined();
        expect(checkNamed(verdict.checks, CATALOG_CHECK_NAMES.OUT_OF_CATEGORY_RANGE)).toBeUndefined();
    });

    it.each([
        ['a non-finite nutrient', { calories: Number.NaN }, CATALOG_CHECK_NAMES.NUTRIENT_NOT_FINITE],
        ['an infinite nutrient', { fat_g: Number.POSITIVE_INFINITY }, CATALOG_CHECK_NAMES.NUTRIENT_NOT_FINITE],
        ['a negative nutrient', { protein_g: -1 }, CATALOG_CHECK_NAMES.NUTRIENT_NEGATIVE],
    ])('rejects %s', (_label, overrides, expectedCheck) => {
        const verdict = validateCatalogCandidate(publishableCandidate(overrides), POLICY);

        expect(verdict.publicationStatus).toBe('rejected');
        expect(verdict.decidingCheckNames).toContain(expectedCheck);
    });

    it('rejects energy above the global ceiling', () => {
        // Pure fat is ≈ 884 kcal, so 950 is impossible per 100 g.
        const verdict = validateCatalogCandidate(
            publishableCandidate({
                category: 'oil_fat',
                calories: 950,
                protein_g: 0,
                carbs_g: 0,
                fat_g: 105,
            }),
            POLICY,
        );

        expect(verdict.publicationStatus).toBe('rejected');
        expect(verdict.decidingCheckNames).toContain(CATALOG_CHECK_NAMES.KCAL_CEILING);
    });

    // You cannot have more grams of macronutrient than the food weighs.
    it('rejects a macro mass beyond the tolerated weight', () => {
        const verdict = validateCatalogCandidate(
            publishableCandidate({ calories: 500, protein_g: 60, carbs_g: 50, fat_g: 10 }),
            POLICY,
        );

        expect(verdict.publicationStatus).toBe('rejected');
        expect(verdict.decidingCheckNames).toContain(CATALOG_CHECK_NAMES.MACRO_MASS_CEILING);
    });

    it('rejects an energy-vs-macro mismatch beyond the category tolerance', () => {
        // 4·5 + 4·5 + 9·1 = 49 kcal against a stated 400: far outside 15 %.
        const verdict = validateCatalogCandidate(
            publishableCandidate({ calories: 400, protein_g: 5, carbs_g: 5, fat_g: 1 }),
            POLICY,
        );

        expect(verdict.publicationStatus).toBe('rejected');
        expect(verdict.decidingCheckNames).toContain(CATALOG_CHECK_NAMES.ENERGY_MACRO_MISMATCH);
    });

    // The 30 kcal floor in max(30, T%) keeps a low-energy food from failing on
    // rounding alone.
    it('absorbs small absolute disagreement on a low-energy food', () => {
        const verdict = validateCatalogCandidate(
            publishableCandidate({
                category: 'produce_vegetable',
                calories: 20,
                protein_g: 2,
                carbs_g: 3,
                fat_g: 0.2,
                fiber_g: 1.5,
            }),
            POLICY,
        );

        expect(checkNamed(verdict.checks, CATALOG_CHECK_NAMES.ENERGY_MACRO_MISMATCH)?.pass).toBe(true);
        expect(verdict.publicationStatus).toBe('published');
    });

    // Judged against an absolute allowance: a percentage of the difference
    // would fail a candidate exactly on its bound, because the IEEE-754 round
    // trip lands a hair above the integer.
    it('passes a candidate whose disagreement sits exactly on the category bound', () => {
        // oil_fat at 8 %: 800 kcal allows 64; 4·0 + 4·0 + 9·81.7 = 735.3, a
        // difference of 64.7 — just over, so it fails; 81.8 g gives 736.2 and a
        // difference of 63.8 — just under, so it passes.
        const candidate = (fat: number) =>
            publishableCandidate({
                category: 'oil_fat',
                calories: 800,
                protein_g: 0,
                carbs_g: 0,
                fat_g: fat,
                fiber_g: 0,
            });

        expect(
            checkNamed(
                validateCatalogCandidate(candidate(81.8), POLICY).checks,
                CATALOG_CHECK_NAMES.ENERGY_MACRO_MISMATCH,
            )?.pass,
        ).toBe(true);
        expect(
            checkNamed(
                validateCatalogCandidate(candidate(81.7), POLICY).checks,
                CATALOG_CHECK_NAMES.ENERGY_MACRO_MISMATCH,
            )?.pass,
        ).toBe(false);
    });

    it('omits the energy-vs-macro check when a macro is unknown', () => {
        const verdict = validateCatalogCandidate(publishableCandidate({ fat_g: null }), POLICY);

        expect(checkNamed(verdict.checks, CATALOG_CHECK_NAMES.ENERGY_MACRO_MISMATCH)).toBeUndefined();
        expect(checkNamed(verdict.checks, CATALOG_CHECK_NAMES.MACRO_MASS_CEILING)).toBeUndefined();
        // …and quarantines on the missing core nutrient instead.
        expect(verdict.publicationStatus).toBe('quarantined');
        expect(verdict.decidingCheckNames).toContain(CATALOG_CHECK_NAMES.MISSING_CORE_NUTRIENT);
    });

    it.each(CORE_NUTRIENT_FIELDS)('quarantines a candidate whose %s is unknown', (field) => {
        const verdict = validateCatalogCandidate(publishableCandidate({ [field]: null }), POLICY);

        expect(verdict.publicationStatus).toBe('quarantined');
        expect(verdict.decidingCheckNames).toContain(CATALOG_CHECK_NAMES.MISSING_CORE_NUTRIENT);
        expect(checkNamed(verdict.checks, CATALOG_CHECK_NAMES.MISSING_CORE_NUTRIENT)?.observed).toContain(
            field,
        );
    });

    // Any other nutrient may legitimately stay null on a published food.
    it('publishes a candidate whose fibre is unknown', () => {
        const verdict = validateCatalogCandidate(publishableCandidate({ fiber_g: null }), POLICY);

        expect(verdict.publicationStatus).toBe('published');
        expect(verdict.normalizedNutrition?.fiber_g).toBeNull();
    });

    it('quarantines a candidate with no default portion', () => {
        const verdict = validateCatalogCandidate(publishableCandidate({ portions: [] }), POLICY);

        expect(verdict.publicationStatus).toBe('quarantined');
        expect(verdict.decidingCheckNames).toContain(CATALOG_CHECK_NAMES.MISSING_GRAM_WEIGHT);
        expect(checkNamed(verdict.checks, CATALOG_CHECK_NAMES.MISSING_GRAM_WEIGHT)?.observed).toBe(
            'no default portion',
        );
    });

    it('quarantines a default portion whose gram weight the source never stated', () => {
        const verdict = validateCatalogCandidate(
            publishableCandidate({
                portions: [
                    { description: '1 breast', amount: 1, unit: 'each', gram_weight: null, is_default: true },
                ],
            }),
            POLICY,
        );

        expect(verdict.publicationStatus).toBe('quarantined');
        expect(verdict.decidingCheckNames).toContain(CATALOG_CHECK_NAMES.MISSING_GRAM_WEIGHT);
    });

    // One missing gram weight is one check rather than two records of the same
    // fact.
    it('records missing_gram_weight once when the conversion already reported it', () => {
        const verdict = validateCatalogCandidate(
            publishableCandidate({
                nutrition_basis: 'per_serving',
                basis_amount: 1,
                serving_gram_weight: null,
                portions: [],
            }),
            POLICY,
        );

        const recorded = verdict.checks.filter(
            (check) => check.name === CATALOG_CHECK_NAMES.MISSING_GRAM_WEIGHT,
        );

        expect(recorded).toHaveLength(1);
        expect(verdict.publicationStatus).toBe('quarantined');
        expect(verdict.normalizedNutrition).toBeNull();
    });

    it('quarantines a volume-basis candidate with no stored density', () => {
        const verdict = validateCatalogCandidate(
            publishableCandidate({ nutrition_basis: 'per_100ml', density_g_per_ml: null }),
            POLICY,
        );

        expect(verdict.publicationStatus).toBe('quarantined');
        expect(verdict.decidingCheckNames).toContain(CATALOG_CHECK_NAMES.MISSING_DENSITY);
        expect(verdict.normalizedNutrition).toBeNull();
    });

    it.each([
        [
            'a non-positive amount',
            { description: '1 cup', amount: 0, unit: 'cup', gram_weight: 100, is_default: false },
        ],
        [
            'a non-positive gram weight',
            { description: '1 cup', amount: 1, unit: 'cup', gram_weight: -5, is_default: false },
        ],
        [
            'an unconvertible unit',
            { description: 'a smidge', amount: 1, unit: 'smidge', gram_weight: 5, is_default: false },
        ],
    ])('quarantines %s among the portions', (_label, portion) => {
        const verdict = validateCatalogCandidate(
            publishableCandidate({
                portions: [
                    { description: '1 breast', amount: 1, unit: 'each', gram_weight: 174, is_default: true },
                    portion,
                ],
            }),
            POLICY,
        );

        expect(verdict.publicationStatus).toBe('quarantined');
        expect(verdict.decidingCheckNames).toContain(CATALOG_CHECK_NAMES.UNSUPPORTED_PORTION);
    });

    it('omits the portion-support check when the candidate states no portions', () => {
        const verdict = validateCatalogCandidate(publishableCandidate({ portions: [] }), POLICY);

        expect(checkNamed(verdict.checks, CATALOG_CHECK_NAMES.UNSUPPORTED_PORTION)).toBeUndefined();
        expect(checkNamed(verdict.checks, CATALOG_CHECK_NAMES.DEFAULT_PORTION_COUNT)).toBeUndefined();
    });

    /**
     * The portion rules the coverage plan's `nutritionBasisRule` states and the
     * database also holds: `catalog_food_portions.gram_weight` is NOT NULL and a
     * partial unique index allows one default per food. A candidate that breaks
     * either is not a row that publishes badly — it is a row that cannot be
     * written — so the verdict has to say so, or the run aborts on insert with
     * nothing in the validation record to explain why.
     */
    describe('the default-portion and gram-weight policy', () => {
        it('quarantines a second default portion and records the count observed', () => {
            const verdict = validateCatalogCandidate(
                publishableCandidate({
                    portions: [
                        { description: '1 breast', amount: 1, unit: 'each', gram_weight: 174, is_default: true },
                        { description: '1 cup', amount: 1, unit: 'cup', gram_weight: 140, is_default: true },
                    ],
                }),
                POLICY,
            );

            expect(verdict.publicationStatus).toBe('quarantined');
            expect(verdict.decidingCheckNames).toContain(CATALOG_CHECK_NAMES.DEFAULT_PORTION_COUNT);
            expect(checkNamed(verdict.checks, CATALOG_CHECK_NAMES.DEFAULT_PORTION_COUNT)).toMatchObject({
                observed: 2,
                bound: 1,
                pass: false,
                tier: 'quarantine',
            });
        });

        it('quarantines a portion set whose portions are all non-default', () => {
            const verdict = validateCatalogCandidate(
                publishableCandidate({
                    portions: [
                        { description: '1 cup', amount: 1, unit: 'cup', gram_weight: 140, is_default: false },
                    ],
                }),
                POLICY,
            );

            expect(verdict.publicationStatus).toBe('quarantined');
            expect(checkNamed(verdict.checks, CATALOG_CHECK_NAMES.DEFAULT_PORTION_COUNT)?.observed).toBe(0);
        });

        it('passes the count check on exactly one default portion', () => {
            const verdict = validateCatalogCandidate(
                publishableCandidate({
                    portions: [
                        { description: '1 breast', amount: 1, unit: 'each', gram_weight: 174, is_default: true },
                        { description: '1 cup', amount: 1, unit: 'cup', gram_weight: 140, is_default: false },
                    ],
                }),
                POLICY,
            );

            expect(verdict.publicationStatus).toBe('published');
            expect(checkNamed(verdict.checks, CATALOG_CHECK_NAMES.DEFAULT_PORTION_COUNT)?.pass).toBe(true);
        });

        // The source stating no weight is honest and one is never invented — but
        // a portion the pipeline keeps must have one, because the column it
        // would be written to is NOT NULL.
        it('quarantines a non-default portion whose gram weight the source never stated', () => {
            const verdict = validateCatalogCandidate(
                publishableCandidate({
                    portions: [
                        { description: '1 breast', amount: 1, unit: 'each', gram_weight: 174, is_default: true },
                        { description: '1 cup', amount: 1, unit: 'cup', gram_weight: null, is_default: false },
                    ],
                }),
                POLICY,
            );

            expect(verdict.publicationStatus).toBe('quarantined');
            expect(verdict.decidingCheckNames).toContain(CATALOG_CHECK_NAMES.UNSUPPORTED_PORTION);
            expect(String(checkNamed(verdict.checks, CATALOG_CHECK_NAMES.UNSUPPORTED_PORTION)?.observed)).toContain(
                'no gram weight',
            );
        });

        // One missing weight stays one record: the default portion's own weight
        // is missing_gram_weight's fact, with the bound that names it.
        it('records a missing default weight once, not also as an unsupported portion', () => {
            const verdict = validateCatalogCandidate(
                publishableCandidate({
                    portions: [
                        { description: '1 breast', amount: 1, unit: 'each', gram_weight: null, is_default: true },
                    ],
                }),
                POLICY,
            );

            expect(verdict.publicationStatus).toBe('quarantined');
            expect(verdict.decidingCheckNames).toEqual([CATALOG_CHECK_NAMES.MISSING_GRAM_WEIGHT]);
            expect(checkNamed(verdict.checks, CATALOG_CHECK_NAMES.UNSUPPORTED_PORTION)?.pass).toBe(true);
        });

        // These are database invariants, not thresholds. A plan that relaxed one
        // would not change what may be published — it would only move the failure
        // from an auditable quarantine to an aborted insert, which is the defect
        // this validation exists to prevent. So a drifted rule FAILS rather than
        // being honoured, and rather than being silently disregarded.
        const WEAKENED_RULES: [string, CatalogNutritionBasisRule][] = [
            [
                'a default portion without a sourced gram weight',
                {
                    requiredDefaultPortionCount: 1,
                    defaultPortionRequiresSourcedGramWeight: false,
                    retainedPortionsRequireSourcedGramWeight: true,
                },
            ],
            [
                'a retained portion without a sourced gram weight',
                {
                    requiredDefaultPortionCount: 1,
                    defaultPortionRequiresSourcedGramWeight: true,
                    retainedPortionsRequireSourcedGramWeight: false,
                },
            ],
            [
                'two default portions',
                {
                    requiredDefaultPortionCount: 2,
                    defaultPortionRequiresSourcedGramWeight: true,
                    retainedPortionsRequireSourcedGramWeight: true,
                },
            ],
            [
                'no default portion at all',
                {
                    requiredDefaultPortionCount: 0,
                    defaultPortionRequiresSourcedGramWeight: true,
                    retainedPortionsRequireSourcedGramWeight: true,
                },
            ],
        ];

        it.each(WEAKENED_RULES)('refuses a policy that would allow %s', (_label, nutritionBasisRule) => {
            const weakened: CatalogValidationPolicy = { ...POLICY, nutritionBasisRule };

            expect(() => validateCatalogCandidate(publishableCandidate(), weakened)).toThrow(
                CatalogPolicyError,
            );
            expect(() => assertUsableValidationPolicy(weakened)).toThrow(/nutritionBasisRule must match/);
        });

        // The point of refusing is that nothing unstorable can be reported
        // publishable, whatever the plan says — so the invariant verdicts must be
        // identical under every policy the validator accepts.
        it.each(WEAKENED_RULES)(
            'still quarantines an unstorable portion set when the policy says %s',
            (_label, nutritionBasisRule) => {
                const nullNonDefault = publishableCandidate({
                    portions: [
                        { description: '1 breast', amount: 1, unit: 'each', gram_weight: 174, is_default: true },
                        { description: '1 cup', amount: 1, unit: 'cup', gram_weight: null, is_default: false },
                    ],
                });
                const nullDefault = publishableCandidate({
                    portions: [
                        { description: '1 breast', amount: 1, unit: 'each', gram_weight: null, is_default: true },
                    ],
                });
                const twoDefaults = publishableCandidate({
                    portions: [
                        { description: '1 breast', amount: 1, unit: 'each', gram_weight: 174, is_default: true },
                        { description: '1 cup', amount: 1, unit: 'cup', gram_weight: 140, is_default: true },
                    ],
                });

                for (const candidate of [nullNonDefault, nullDefault, twoDefaults]) {
                    // The weakened policy cannot publish it, because it cannot
                    // reach a verdict; the accepted policy quarantines it.
                    expect(() =>
                        validateCatalogCandidate(candidate, { ...POLICY, nutritionBasisRule }),
                    ).toThrow(CatalogPolicyError);
                    expect(validateCatalogCandidate(candidate, POLICY).publicationStatus).toBe(
                        'quarantined',
                    );
                }
            },
        );

        it('accepts the one supported rule whether it is passed explicitly or omitted', () => {
            const explicit: CatalogValidationPolicy = {
                ...POLICY,
                nutritionBasisRule: DEFAULT_CATALOG_NUTRITION_BASIS_RULE,
            };

            expect(assertUsableValidationPolicy(explicit)).toEqual(DEFAULT_CATALOG_NUTRITION_BASIS_RULE);
            expect(assertUsableValidationPolicy(POLICY)).toEqual(DEFAULT_CATALOG_NUTRITION_BASIS_RULE);
            expect(validateCatalogCandidate(publishableCandidate(), explicit)).toEqual(
                validateCatalogCandidate(publishableCandidate(), POLICY),
            );
        });

        // Defaulting to silence would make an unthreaded caller validate against
        // a laxer rule than the plan states.
        it('defaults to the shipped coverage-plan rule when the policy omits it', () => {
            expect(DEFAULT_CATALOG_NUTRITION_BASIS_RULE).toEqual({
                requiredDefaultPortionCount: 1,
                defaultPortionRequiresSourcedGramWeight: true,
                retainedPortionsRequireSourcedGramWeight: true,
            });
            expect(POLICY.nutritionBasisRule).toBeUndefined();
            expect(
                validateCatalogCandidate(
                    publishableCandidate({
                        portions: [
                            {
                                description: '1 breast',
                                amount: 1,
                                unit: 'each',
                                gram_weight: 174,
                                is_default: true,
                            },
                            { description: '1 cup', amount: 1, unit: 'cup', gram_weight: null, is_default: false },
                        ],
                    }),
                    POLICY,
                ).publicationStatus,
            ).toBe('quarantined');
        });
    });

    /**
     * Validation arithmetic on finite inputs, guarded at every product, sum,
     * divisor and output. A check whose own comparison overflowed must fail and
     * must still say what it observed: `Infinity` in a JSONB observation becomes
     * `null`, which reads as "nothing was observed".
     */
    // A bound is as capable of overflowing as a candidate value, and a bound
    // that overflows is worse: `Infinity` as a ceiling PASSES every candidate
    // and then stores as `null`, so the record reads as a satisfied check
    // against a bound nobody can see. Asserted before any check runs.
    describe('policy bounds that cannot decide', () => {
        const UNUSABLE_BOUNDS: [string, number][] = [
            ['Infinity', Number.POSITIVE_INFINITY],
            ['NaN', Number.NaN],
            ['zero', 0],
            ['negative', -1],
        ];

        it.each(UNUSABLE_BOUNDS)('refuses a global bound of %s', (_label, value) => {
            const policy: CatalogValidationPolicy = {
                ...POLICY,
                validationBounds: { ...POLICY.validationBounds, maxKcalPer100g: value },
            };

            expect(() => assertUsableValidationPolicy(policy)).toThrow(CatalogPolicyError);
            expect(() => validateCatalogCandidate(publishableCandidate(), policy)).toThrow(
                /validationBounds\.maxKcalPer100g/,
            );
        });

        it.each(UNUSABLE_BOUNDS)('refuses a per-category bound of %s', (_label, value) => {
            const policy: CatalogValidationPolicy = {
                ...POLICY,
                categories: POLICY.categories.map((category) => ({
                    ...category,
                    energyMacroTolerancePercent: value,
                })),
            };

            expect(() => validateCatalogCandidate(publishableCandidate(), policy)).toThrow(
                /energyMacroTolerancePercent/,
            );
        });

        // The factor itself is finite and positive — it is the PRODUCT that
        // overflows, which is why validating the supplied numbers alone is not
        // enough and the derived ceiling is asserted where it is derived.
        it('refuses a finite tolerance factor whose macro-mass ceiling overflows', () => {
            const policy: CatalogValidationPolicy = {
                ...POLICY,
                validationBounds: {
                    ...POLICY.validationBounds,
                    macroMassToleranceFactor: Number.MAX_VALUE,
                },
            };

            expect(Number.isFinite(policy.validationBounds.macroMassToleranceFactor)).toBe(true);
            expect(100 * policy.validationBounds.macroMassToleranceFactor).toBe(Number.POSITIVE_INFINITY);
            expect(() => assertUsableValidationPolicy(policy)).toThrow(CatalogPolicyError);
            expect(() => validateCatalogCandidate(publishableCandidate(), policy)).toThrow(
                /macro-mass ceiling of Infinity/,
            );
        });

        // The regression in full: without the assertion this candidate came back
        // `published` with a `macro_mass_ceiling` that passed against a bound
        // JSONB stores as `null`.
        it('never publishes against an overflowed ceiling, and every accepted bound round-trips JSONB', () => {
            const overflowing: CatalogValidationPolicy = {
                ...POLICY,
                validationBounds: {
                    ...POLICY.validationBounds,
                    macroMassToleranceFactor: Number.MAX_VALUE,
                },
            };

            expect(() => validateCatalogCandidate(publishableCandidate(), overflowing)).toThrow(
                CatalogPolicyError,
            );

            const verdict = validateCatalogCandidate(publishableCandidate(), POLICY);
            const ceiling = checkNamed(verdict.checks, CATALOG_CHECK_NAMES.MACRO_MASS_CEILING);

            expect(verdict.publicationStatus).toBe('published');
            expect(Number.isFinite(ceiling?.bound as number)).toBe(true);
            for (const check of verdict.checks) {
                expect(JSON.parse(JSON.stringify(check))).toEqual(check);
            }
        });

        it('accepts the shipped bounds unchanged', () => {
            expect(assertUsableValidationPolicy(POLICY)).toEqual(DEFAULT_CATALOG_NUTRITION_BASIS_RULE);
        });

        // A review band's FLOOR of zero is a real bound, not a missing one:
        // `beverage`, `condiment_sauce`, `spice_herb` and `other` all ship with
        // `kcalReviewRange.min: 0` because a zero-calorie drink is an ordinary
        // food. Rejecting zero everywhere would refuse the shipped plan.
        it('accepts a zero review floor while still refusing a zero ceiling', () => {
            const zeroFloor: CatalogValidationPolicy = {
                ...POLICY,
                categories: POLICY.categories.map((category) => ({
                    ...category,
                    kcalReviewRange: { ...category.kcalReviewRange, min: 0 },
                })),
            };
            const zeroCeiling: CatalogValidationPolicy = {
                ...POLICY,
                categories: POLICY.categories.map((category) => ({
                    ...category,
                    kcalReviewRange: { ...category.kcalReviewRange, max: 0 },
                })),
            };

            expect(() => assertUsableValidationPolicy(zeroFloor)).not.toThrow();
            expect(validateCatalogCandidate(publishableCandidate(), zeroFloor).publicationStatus).toBe(
                'published',
            );
            expect(() => assertUsableValidationPolicy(zeroCeiling)).toThrow(/kcalReviewRange\.max/);
        });
    });

    describe('validation arithmetic that overflows', () => {
        it('fails the macro-mass ceiling on an overflowed sum and records it as text', () => {
            const verdict = validateCatalogCandidate(
                publishableCandidate({
                    calories: 100,
                    protein_g: 1e308,
                    carbs_g: 1e308,
                    fat_g: 1e308,
                }),
                POLICY,
            );

            const check = checkNamed(verdict.checks, CATALOG_CHECK_NAMES.MACRO_MASS_CEILING);

            expect(verdict.publicationStatus).toBe('rejected');
            expect(check?.pass).toBe(false);
            expect(check?.observed).toBe('Infinity');
            expect(JSON.parse(JSON.stringify(check)).observed).toBe('Infinity');
        });

        // A check that could not be EVALUATED is absent from the record rather
        // than recorded against its own rule.
        it('omits the energy-mismatch check when the macro mass could not be summed', () => {
            const verdict = validateCatalogCandidate(
                publishableCandidate({
                    calories: 100,
                    protein_g: 1e308,
                    carbs_g: 1e308,
                    fat_g: 1e308,
                }),
                POLICY,
            );

            expect(checkNamed(verdict.checks, CATALOG_CHECK_NAMES.ENERGY_MACRO_MISMATCH)).toBeUndefined();
        });

        it('fails the portion-drift check when the expectation overflowed', () => {
            const verdict = validateCatalogCandidate(
                publishableCandidate({
                    calories: 1e308,
                    protein_g: 1,
                    carbs_g: 1,
                    fat_g: 1,
                    per_serving_nutrition: { calories: 1, protein_g: 1, carbs_g: 1, fat_g: 1 },
                    portions: [
                        {
                            description: '1 breast',
                            amount: 1,
                            unit: 'each',
                            gram_weight: 1e300,
                            is_default: true,
                        },
                    ],
                }),
                POLICY,
            );

            const check = checkNamed(verdict.checks, CATALOG_CHECK_NAMES.PORTION_CONVERSION_DRIFT);

            expect(check?.pass).toBe(false);
            expect(String(check?.observed)).toContain('not finite');
            expect(verdict.publicationStatus).toBe('rejected');
        });

        // Nothing a candidate can state may put a value JSONB cannot hold into
        // the record every published row keeps.
        it('records every observation in a form JSONB round-trips', () => {
            const verdicts = [
                validateCatalogCandidate(
                    publishableCandidate({ calories: 1e308, protein_g: 1e308, carbs_g: 1e308, fat_g: 1e308 }),
                    POLICY,
                ),
                validateCatalogCandidate(
                    publishableCandidate({
                        nutrition_basis: 'per_serving',
                        basis_amount: 1e308,
                        serving_gram_weight: 40,
                    }),
                    POLICY,
                ),
            ];

            for (const verdict of verdicts) {
                for (const check of verdict.checks) {
                    expect(JSON.parse(JSON.stringify(check))).toEqual(check);
                }
            }
        });
    });

    it('quarantines a candidate no identity evidence corroborates', () => {
        const verdict = validateCatalogCandidate(
            publishableCandidate({ identity_status: 'unsourced' }),
            POLICY,
        );

        expect(verdict.publicationStatus).toBe('quarantined');
        expect(verdict.decidingCheckNames).toContain(CATALOG_CHECK_NAMES.UNSOURCED);
    });

    it('accepts an ambiguous identity as sourced', () => {
        expect(
            validateCatalogCandidate(publishableCandidate({ identity_status: 'ambiguous' }), POLICY)
                .publicationStatus,
        ).toBe('published');
    });

    // undefined means duplicate detection has not run; explicit null means it
    // ran and found none, which is a genuine pass.
    it('omits the duplicate check until duplicate detection has run', () => {
        const verdict = validateCatalogCandidate(publishableCandidate(), POLICY, {});

        expect(checkNamed(verdict.checks, CATALOG_CHECK_NAMES.DUPLICATE_IDENTITY)).toBeUndefined();
    });

    it('records a passing duplicate check when detection found none', () => {
        const verdict = validateCatalogCandidate(publishableCandidate(), POLICY, {
            duplicateOfSourceKey: null,
        });

        expect(checkNamed(verdict.checks, CATALOG_CHECK_NAMES.DUPLICATE_IDENTITY)?.pass).toBe(true);
        expect(verdict.publicationStatus).toBe('published');
    });

    // A duplicate merges as an alias of its survivor, never published a second
    // time.
    it('quarantines a candidate another row already holds the identity of', () => {
        const verdict = validateCatalogCandidate(publishableCandidate(), POLICY, {
            duplicateOfSourceKey: 'usda:1',
        });

        expect(verdict.publicationStatus).toBe('quarantined');
        expect(verdict.decidingCheckNames).toContain(CATALOG_CHECK_NAMES.DUPLICATE_IDENTITY);
        expect(checkNamed(verdict.checks, CATALOG_CHECK_NAMES.DUPLICATE_IDENTITY)?.observed).toBe('usda:1');
    });

    it('publishes a USDA record outside its category band, with the flag recorded', () => {
        const verdict = validateCatalogCandidate(
            publishableCandidate({
                category: 'produce_vegetable',
                calories: 300,
                protein_g: 5,
                carbs_g: 60,
                fat_g: 4,
                fiber_g: 8,
            }),
            POLICY,
        );

        expect(verdict.publicationStatus).toBe('published');
        expect(verdict.reviewFlags).toEqual([CATALOG_CHECK_NAMES.OUT_OF_CATEGORY_RANGE]);
        expect(verdict.countsTowardPublishedTarget).toBe(true);
    });

    it('holds a generated record outside its category band until it is confirmed', () => {
        const candidate = publishableCandidate({
            source_key: 'ai:produce_vegetable:mystery mash:prepared',
            canonical_name: 'mystery mash',
            display_name: 'Mystery mash',
            identity_source: 'ai_generated',
            identity_status: 'verified',
            category: 'produce_vegetable',
            calories: 300,
            protein_g: 5,
            carbs_g: 60,
            fat_g: 4,
            fiber_g: 8,
        });

        expect(validateCatalogCandidate(candidate, POLICY).publicationStatus).toBe('quarantined');
        expect(
            validateCatalogCandidate(candidate, POLICY, {
                advisoryReview: { confirmedCheckNames: [CATALOG_CHECK_NAMES.OUT_OF_CATEGORY_RANGE] },
            }).publicationStatus,
        ).toBe('published');
        expect(
            validateCatalogCandidate(candidate, POLICY, {
                curatorAllowlistedCheckNames: [CATALOG_CHECK_NAMES.OUT_OF_CATEGORY_RANGE],
            }).publicationStatus,
        ).toBe('published');
    });

    // The bands are wide on purpose: egg white ≈ 52 and egg yolk ≈ 322 both sit
    // inside protein_egg's 40–350, and grain carries separate dry and cooked
    // bands, so the check flags the atypical rather than rejecting the real.
    it('judges dry and cooked grain against their own bands', () => {
        const grain = (foodState: 'dry' | 'cooked', calories: number, carbs: number) =>
            publishableCandidate({
                category: 'grain',
                food_state: foodState,
                calories,
                protein_g: 7,
                carbs_g: carbs,
                fat_g: 1,
                fiber_g: 2,
            });

        // Dry rice ≈ 360 kcal: inside 300–400 for `dry`, outside 80–200 for `cooked`.
        expect(
            checkNamed(
                validateCatalogCandidate(grain('dry', 360, 79), POLICY).checks,
                CATALOG_CHECK_NAMES.OUT_OF_CATEGORY_RANGE,
            )?.pass,
        ).toBe(true);
        expect(
            checkNamed(
                validateCatalogCandidate(grain('cooked', 360, 79), POLICY).checks,
                CATALOG_CHECK_NAMES.OUT_OF_CATEGORY_RANGE,
            )?.pass,
        ).toBe(false);
        // Cooked rice ≈ 130 kcal: inside 80–200 for `cooked`.
        expect(
            checkNamed(
                validateCatalogCandidate(grain('cooked', 130, 27), POLICY).checks,
                CATALOG_CHECK_NAMES.OUT_OF_CATEGORY_RANGE,
            )?.pass,
        ).toBe(true);
    });

    it('names the food state in the bound when the per-state band decided it', () => {
        const bound = checkNamed(
            validateCatalogCandidate(
                publishableCandidate({
                    category: 'grain',
                    food_state: 'dry',
                    calories: 360,
                    protein_g: 7,
                    carbs_g: 79,
                    fat_g: 1,
                    fiber_g: 2,
                }),
                POLICY,
            ).checks,
            CATALOG_CHECK_NAMES.OUT_OF_CATEGORY_RANGE,
        )?.bound;

        expect(bound).toBe('300-400 kcal/100g for grain (dry)');
    });

    it('flags an unknown allergen set for review and still publishes a USDA record', () => {
        const verdict = validateCatalogCandidate(
            publishableCandidate({ allergen_status: 'unknown' }),
            POLICY,
        );

        expect(verdict.publicationStatus).toBe('published');
        expect(verdict.reviewFlags).toEqual([CATALOG_CHECK_NAMES.ALLERGENS_UNKNOWN]);
    });

    it('rejects a per-serving label set that disagrees with the per-100 g values', () => {
        const verdict = validateCatalogCandidate(
            publishableCandidate({
                // 174 g of the per-100 g record is 208.8 kcal; 300 is far outside 5 %.
                per_serving_nutrition: { calories: 300, protein_g: 39.15, carbs_g: 0, fat_g: 4.524 },
            }),
            POLICY,
        );

        expect(verdict.publicationStatus).toBe('rejected');
        expect(verdict.decidingCheckNames).toContain(CATALOG_CHECK_NAMES.PORTION_CONVERSION_DRIFT);
        expect(checkNamed(verdict.checks, CATALOG_CHECK_NAMES.PORTION_CONVERSION_DRIFT)?.observed).toMatch(
            /calories \d+\.\d{2}%/,
        );
    });

    it('accepts a per-serving label set that agrees within tolerance', () => {
        const verdict = validateCatalogCandidate(
            publishableCandidate({
                per_serving_nutrition: {
                    calories: 208.8,
                    protein_g: 39.15,
                    carbs_g: 0,
                    fat_g: 4.524,
                    fiber_g: 0,
                },
            }),
            POLICY,
        );

        expect(checkNamed(verdict.checks, CATALOG_CHECK_NAMES.PORTION_CONVERSION_DRIFT)?.pass).toBe(true);
        expect(verdict.publicationStatus).toBe('published');
    });

    // Absent means there is nothing to cross-check, and the check is omitted
    // rather than passed.
    it.each([
        ['no per-serving values at all', undefined],
        ['an explicit null', null],
        ['per-serving values with nothing comparable', { calories: null, protein_g: null, carbs_g: null, fat_g: null }],
    ])('omits the drift check for %s', (_label, perServing) => {
        const verdict = validateCatalogCandidate(
            publishableCandidate({ per_serving_nutrition: perServing }),
            POLICY,
        );

        expect(checkNamed(verdict.checks, CATALOG_CHECK_NAMES.PORTION_CONVERSION_DRIFT)).toBeUndefined();
    });

    it('reports a whole hundred percent drift against a zero expectation', () => {
        const verdict = validateCatalogCandidate(
            publishableCandidate({
                // carbs are 0 per 100 g, so any non-zero statement is a full miss
                // rather than an Infinity that JSONB would store as null.
                per_serving_nutrition: { calories: 208.8, protein_g: 39.15, carbs_g: 4, fat_g: 4.524 },
            }),
            POLICY,
        );

        const drift = checkNamed(verdict.checks, CATALOG_CHECK_NAMES.PORTION_CONVERSION_DRIFT);

        expect(drift?.pass).toBe(false);
        expect(drift?.observed).toBe('carbs_g 100.00%');
    });

    it('omits the drift check when no serving gram weight is available', () => {
        const verdict = validateCatalogCandidate(
            publishableCandidate({
                portions: [
                    { description: '1 breast', amount: 1, unit: 'each', gram_weight: null, is_default: true },
                ],
                per_serving_nutrition: { calories: 208.8, protein_g: 39.15, carbs_g: 0, fat_g: 4.524 },
            }),
            POLICY,
        );

        expect(checkNamed(verdict.checks, CATALOG_CHECK_NAMES.PORTION_CONVERSION_DRIFT)).toBeUndefined();
    });

    it('prefers an explicit serving gram weight over the default portion for the drift check', () => {
        const verdict = validateCatalogCandidate(
            publishableCandidate({
                serving_gram_weight: 100,
                per_serving_nutrition: { calories: 120, protein_g: 22.5, carbs_g: 0, fat_g: 2.6 },
            }),
            POLICY,
        );

        expect(checkNamed(verdict.checks, CATALOG_CHECK_NAMES.PORTION_CONVERSION_DRIFT)?.pass).toBe(true);
    });

    it('returns a verdict rather than throwing for a candidate that fails everything', () => {
        const verdict = validateCatalogCandidate(
            {
                canonical_name: 'nonsense',
                category: 'not_a_category',
                food_state: 'raw',
                identity_source: 'ai_generated',
                identity_status: 'unsourced',
                nutrition_provenance: 'ai_estimated',
                allergen_status: 'unknown',
                nutrition_basis: 'per_100g',
                basis_amount: 0,
                calories: -1,
                protein_g: Number.NaN,
                carbs_g: null,
                fat_g: null,
            },
            POLICY,
            { duplicateOfSourceKey: 'usda:1' },
        );

        expect(verdict.publicationStatus).toBe('rejected');
        expect(verdict.countsTowardPublishedTarget).toBe(false);
        expect(verdict.normalizedNutrition).toBeNull();
        expect(verdict.decidingCheckNames).toEqual(
            expect.arrayContaining([
                CATALOG_CHECK_NAMES.UNKNOWN_CATEGORY,
                CATALOG_CHECK_NAMES.NUTRIENT_NOT_FINITE,
                CATALOG_CHECK_NAMES.NUTRIENT_NEGATIVE,
                CATALOG_CHECK_NAMES.INVALID_BASIS_AMOUNT,
            ]),
        );
    });
});

/* ---------------------------------------------------------------------------
 * Provenance and recipe eligibility
 * ------------------------------------------------------------------------- */

describe('isEstimatedNutrition', () => {
    it('counts ingredient-derived and AI-estimated nutrition as estimates', () => {
        expect(isEstimatedNutrition('ingredient_derived')).toBe(true);
        expect(isEstimatedNutrition('ai_estimated')).toBe(true);
    });

    // user_entered is unverified rather than estimated, and source_backed is
    // neither.
    it('counts source-backed and user-entered nutrition as not estimates', () => {
        expect(isEstimatedNutrition('source_backed')).toBe(false);
        expect(isEstimatedNutrition('user_entered')).toBe(false);
    });
});

describe('isRecipeEligibleCatalogFood', () => {
    const facts = {
        publication_status: 'published' as const,
        nutrition_provenance: 'source_backed' as const,
        allergen_status: 'known' as const,
    };

    it('admits a published, source-backed food with known allergens', () => {
        expect(isRecipeEligibleCatalogFood(facts)).toBe(true);
    });

    // A retired or quarantined row stays referenceable by existing recipes but
    // may not enter a NEW one.
    it.each(['candidate', 'quarantined', 'rejected', 'retired'] as const)(
        'refuses a %s row',
        (publication_status) => {
            expect(isRecipeEligibleCatalogFood({ ...facts, publication_status })).toBe(false);
        },
    );

    // So a planned meal is never an estimate.
    it.each(['ingredient_derived', 'ai_estimated', 'user_entered'] as const)(
        'refuses %s nutrition',
        (nutrition_provenance) => {
            expect(isRecipeEligibleCatalogFood({ ...facts, nutrition_provenance })).toBe(false);
        },
    );

    // Whatever the user selected.
    it('refuses unknown allergen metadata', () => {
        expect(isRecipeEligibleCatalogFood({ ...facts, allergen_status: 'unknown' })).toBe(false);
    });
});

/* ---------------------------------------------------------------------------
 * computeCoverageShortfall
 * ------------------------------------------------------------------------- */

describe('computeCoverageShortfall', () => {
    it('reports the per-category and total shortfall exactly', () => {
        const shortfall = computeCoverageShortfall(POLICY, {
            protein_poultry: 400,
            grain: 550,
            oil_fat: 0,
            produce_vegetable: 1200,
        });

        expect(shortfall.categories).toEqual([
            { category: 'protein_poultry', publishedTarget: 400, published: 400, shortfall: 0 },
            { category: 'grain', publishedTarget: 600, published: 550, shortfall: 50 },
            { category: 'oil_fat', publishedTarget: 150, published: 0, shortfall: 150 },
            { category: 'produce_vegetable', publishedTarget: 1200, published: 1200, shortfall: 0 },
        ]);
        expect(shortfall.publishedTotal).toBe(2150);
        expect(shortfall.publishedTargetTotal).toBe(2350);
        expect(shortfall.shortfallTotal).toBe(200);
        expect(shortfall.meetsTarget).toBe(false);
        expect(shortfall.unknownCategories).toEqual([]);
    });

    it('reports every target as a shortfall when nothing has been published', () => {
        const shortfall = computeCoverageShortfall(POLICY, {});

        expect(shortfall.publishedTotal).toBe(0);
        expect(shortfall.shortfallTotal).toBe(2350);
        expect(shortfall.meetsTarget).toBe(false);
        expect(shortfall.categories.every((entry) => entry.shortfall === entry.publishedTarget)).toBe(true);
    });

    // A surplus in one category never offsets a deficit in another.
    it('treats a surplus as a zero shortfall, not a negative one', () => {
        const shortfall = computeCoverageShortfall(POLICY, {
            protein_poultry: 900,
            grain: 500,
            oil_fat: 150,
            produce_vegetable: 1200,
        });

        expect(shortfall.categories[0].shortfall).toBe(0);
        expect(shortfall.categories[1].shortfall).toBe(100);
        expect(shortfall.shortfallTotal).toBe(100);
        expect(shortfall.meetsTarget).toBe(false);
    });

    it('meets the target only when every category does', () => {
        const shortfall = computeCoverageShortfall(POLICY, {
            protein_poultry: 400,
            grain: 600,
            oil_fat: 150,
            produce_vegetable: 1200,
        });

        expect(shortfall.shortfallTotal).toBe(0);
        expect(shortfall.meetsTarget).toBe(true);
    });

    // A dropped count is a fabricated shortfall — the one thing this must never
    // produce.
    it('sums two spellings of one category rather than dropping either', () => {
        const shortfall = computeCoverageShortfall(POLICY, {
            grain: 300,
            ' Grain ': 300,
        });

        expect(shortfall.categories[1]).toEqual({
            category: 'grain',
            publishedTarget: 600,
            published: 600,
            shortfall: 0,
        });
        expect(shortfall.unknownCategories).toEqual([]);
    });

    // A total that silently absorbed them would report a catalog larger than the
    // plan describes.
    it('excludes undeclared categories from the total and names them, sorted', () => {
        const shortfall = computeCoverageShortfall(POLICY, {
            protein_poultry: 400,
            zebra_category: 25,
            apple_category: 10,
        });

        expect(shortfall.publishedTotal).toBe(400);
        expect(shortfall.unknownCategories).toEqual(['apple_category', 'zebra_category']);
    });

    it('reports nothing for an empty plan', () => {
        const shortfall = computeCoverageShortfall({ ...POLICY, categories: [] }, { grain: 5 });

        expect(shortfall.categories).toEqual([]);
        expect(shortfall.publishedTotal).toBe(0);
        expect(shortfall.publishedTargetTotal).toBe(0);
        expect(shortfall.meetsTarget).toBe(true);
        expect(shortfall.unknownCategories).toEqual(['grain']);
    });
});

/* ---------------------------------------------------------------------------
 * The shipped coverage plan and the committed catalog fixture
 *
 * Both are read from disk at run time — never deep-imported, because `data/`
 * sits outside the production program's `rootDir` and the Docker image excludes
 * it, and never through `scripts/lib/manifest.ts`, which pulls fs and a logger
 * into what is otherwise a pure suite. The path convention is the one
 * `evidence.logic.test.ts` uses for `evidence-allowlist.v1.json`.
 *
 * Each document is validated ONCE, here, and a shape failure is thrown as the
 * reason the suite cannot run rather than surfacing as a hundred confusing
 * assertion failures against data nothing accepted.
 * ------------------------------------------------------------------------- */

const MEAL_PLANNING_DATA_DIRECTORY = join(__dirname, '..', '..', '..', 'data', 'meal-planning');

const readCommittedJson = (...segments: readonly string[]): unknown => {
    const path = join(MEAL_PLANNING_DATA_DIRECTORY, ...segments);

    try {
        return JSON.parse(readFileSync(path, 'utf8')) as unknown;
    } catch (error) {
        throw new Error(
            `catalog.logic.test.ts cannot run: ${path} could not be read or parsed ` +
                `(${error instanceof Error ? error.message : String(error)}).`,
        );
    }
};

const isJsonRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const isJsonString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

const isJsonNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const isJsonPositiveInteger = (value: unknown): value is number => isJsonNumber(value) && Number.isInteger(value) && value > 0;

const isJsonNullableNumber = (value: unknown): value is number | null => value === null || isJsonNumber(value);

const isJsonStringArray = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((entry) => typeof entry === 'string');

/** A `{min, max}` band, as the coverage plan writes one. */
const isJsonKcalRange = (value: unknown): boolean =>
    isJsonRecord(value) && isJsonNumber(value.min) && isJsonNumber(value.max) && value.min <= value.max;

/* ---------------------------------------------------------------------------
 * coverage-plan.v1.json
 * ------------------------------------------------------------------------- */

/**
 * One `categories[]` entry of the coverage plan. A structural SUPERSET of
 * {@link CatalogCategoryBounds} — it adds `candidateVolume`, which the import
 * and generation runs size their batches from and the validator has no use for
 * — so the document assigns to a `CatalogValidationPolicy` without a cast.
 */
interface CoveragePlanCategory extends CatalogCategoryBounds {
    readonly candidateVolume: number;
}

/** The parts of the coverage plan this suite reads. */
interface CoveragePlanDocument {
    readonly coveragePlanVersion: string;
    readonly publishedTargetTotal: number;
    readonly candidateVolumeTotal: number;
    readonly candidateVolumeMultiplier: number;
    readonly categories: readonly CoveragePlanCategory[];
    readonly validationBounds: CatalogGlobalValidationBounds;
}

const coveragePlanCategoryProblems = (entry: unknown, index: number): string[] => {
    if (!isJsonRecord(entry)) {
        return [`categories[${index}] is not an object`];
    }

    const problems: string[] = [];
    const at = (field: string): string => `categories[${index}].${field}`;

    if (!isJsonString(entry.category)) {
        problems.push(`${at('category')} is not a non-empty string`);
    }
    if (!isJsonPositiveInteger(entry.publishedTarget)) {
        problems.push(`${at('publishedTarget')} is not a positive integer`);
    }
    if (!isJsonPositiveInteger(entry.candidateVolume)) {
        problems.push(`${at('candidateVolume')} is not a positive integer`);
    }
    if (!isJsonNumber(entry.energyMacroTolerancePercent) || entry.energyMacroTolerancePercent <= 0) {
        problems.push(`${at('energyMacroTolerancePercent')} is not a positive number`);
    }
    if (!isJsonKcalRange(entry.kcalReviewRange)) {
        problems.push(`${at('kcalReviewRange')} is not a {min <= max} band`);
    }

    const perState = entry.kcalReviewRangeByFoodState;
    if (perState !== undefined) {
        if (!isJsonRecord(perState)) {
            problems.push(`${at('kcalReviewRangeByFoodState')} is not an object`);
        } else {
            for (const [foodState, range] of Object.entries(perState)) {
                if (!isCatalogFoodState(foodState)) {
                    problems.push(`${at('kcalReviewRangeByFoodState')} keys on "${foodState}", not a food state`);
                }
                if (!isJsonKcalRange(range)) {
                    problems.push(`${at(`kcalReviewRangeByFoodState.${foodState}`)} is not a {min <= max} band`);
                }
            }
        }
    }

    return problems;
};

const coveragePlanProblems = (document: unknown): string[] => {
    if (!isJsonRecord(document)) {
        return ['the document is not an object'];
    }

    const problems: string[] = [];

    if (!isJsonString(document.coveragePlanVersion)) {
        problems.push('coveragePlanVersion is not a non-empty string');
    }
    for (const field of ['publishedTargetTotal', 'candidateVolumeTotal', 'candidateVolumeMultiplier'] as const) {
        if (!isJsonNumber(document[field])) {
            problems.push(`${field} is not a number`);
        }
    }

    const bounds = document.validationBounds;
    if (!isJsonRecord(bounds)) {
        problems.push('validationBounds is not an object');
    } else {
        for (const field of [
            'maxKcalPer100g',
            'macroMassToleranceFactor',
            'energyMacroAbsoluteToleranceKcal',
            'portionConversionTolerancePercent',
        ] as const) {
            const value = bounds[field];

            if (!isJsonNumber(value) || value <= 0) {
                problems.push(`validationBounds.${field} is not a positive number`);
            }
        }
    }

    if (!Array.isArray(document.categories) || document.categories.length === 0) {
        problems.push('categories is not a non-empty array');

        return problems;
    }

    document.categories.forEach((entry, index) => {
        problems.push(...coveragePlanCategoryProblems(entry, index));
    });

    const codes = document.categories
        .filter(isJsonRecord)
        .map((entry) => entry.category)
        .filter(isJsonString);
    const duplicated = codes.filter((code, index) => codes.indexOf(code) !== index);
    if (duplicated.length > 0) {
        problems.push(`categories declares ${[...new Set(duplicated)].join(', ')} more than once`);
    }

    return problems;
};

/**
 * The committed coverage plan, validated once. Anything wrong with the document
 * is reported here, naming every problem, because the alternative is a suite
 * that fails everywhere and explains nowhere.
 */
const SHIPPED_PLAN: CoveragePlanDocument = (() => {
    const document = readCommittedJson('coverage-plan.v1.json');
    const problems = coveragePlanProblems(document);

    if (problems.length > 0) {
        throw new Error(
            `catalog.logic.test.ts cannot run: coverage-plan.v1.json does not have the shape this suite ` +
                `drives the validator with — ${problems.join('; ')}`,
        );
    }

    return document as CoveragePlanDocument;
})();

/**
 * The shipped plan AS the module's policy argument: the categories and the
 * global bounds, and nothing else. `brandWords`/`productFormWords` are
 * deliberately omitted — the coverage plan carries no such list, so the module's
 * curated defaults are what production uses and what this suite must exercise.
 */
const SHIPPED_POLICY: CatalogValidationPolicy = {
    categories: SHIPPED_PLAN.categories,
    validationBounds: SHIPPED_PLAN.validationBounds,
};

/** AAP §0.7.3: twenty-one categories, 11,010 published targets, 13,765 candidates. */
const COVERAGE_PLAN_CATEGORY_COUNT = 21;
const COVERAGE_PLAN_PUBLISHED_TARGET_TOTAL = 11010;
const COVERAGE_PLAN_CANDIDATE_VOLUME_TOTAL = 13765;

const CATEGORY_CODES: readonly string[] = SHIPPED_PLAN.categories.map((entry) => entry.category);

const planCategory = (category: string): CoveragePlanCategory => {
    const entry = SHIPPED_PLAN.categories.find((candidate) => candidate.category === category);

    if (!entry) {
        throw new Error(`the coverage plan declares no category "${category}"`);
    }

    return entry;
};

/** One band that actually applies to a candidate: category-wide, or per food state. */
interface CategoryBand {
    readonly category: string;
    readonly foodState: CatalogFoodState;
    readonly min: number;
    readonly max: number;
    readonly fromFoodState: boolean;
}

/**
 * A food state no category overrides, so the category-wide band is the one that
 * resolves for it. `dry` and `cooked` would pick up `grain`'s and `legume`'s
 * overrides, which the per-state cases below exercise on purpose.
 */
const BAND_PROBE_FOOD_STATE: CatalogFoodState = 'as_purchased';

/** Every band a category declares: its category-wide one, then each per-state override. */
const categoryBands = (category: string): readonly CategoryBand[] => {
    const entry = planCategory(category);
    const bands: CategoryBand[] = [
        {
            category,
            foodState: BAND_PROBE_FOOD_STATE,
            min: entry.kcalReviewRange.min,
            max: entry.kcalReviewRange.max,
            fromFoodState: false,
        },
    ];

    for (const [foodState, range] of Object.entries(entry.kcalReviewRangeByFoodState ?? {})) {
        if (isCatalogFoodState(foodState) && range) {
            bands.push({ category, foodState, min: range.min, max: range.max, fromFoodState: true });
        }
    }

    return bands;
};

const PER_FOOD_STATE_BANDS: readonly CategoryBand[] = CATEGORY_CODES.flatMap((category) =>
    categoryBands(category).filter((band) => band.fromFoodState),
);

/**
 * A synthetic candidate for one category and band, at a stated energy.
 *
 * Fat carries all of the energy, so `9 × fat_g` reproduces `calories` and the
 * energy-vs-macro check can never be what decides a band case; at the plan's
 * 900 kcal ceiling that is 100 g, inside the 102 g mass allowance. The name is
 * lower-case and generic so the brand-pattern check — which only runs on the
 * generated branch — has nothing to fire on, leaving the band as the single
 * variable.
 */
const bandProbe = (
    category: string,
    foodState: CatalogFoodState,
    calories: number,
    identitySource: CatalogIdentitySource,
    overrides: Partial<CatalogFoodCandidate> = {},
): CatalogFoodCandidate => {
    const name = `${category.replace(/_/g, ' ')} band probe`;

    return {
        source_key:
            identitySource === 'usda' ? 'usda:9990001' : `ai:${category}:${name}:${foodState}`,
        canonical_name: name,
        display_name: name,
        category,
        food_state: foodState,
        identity_source: identitySource,
        identity_status: 'verified',
        nutrition_provenance: identitySource === 'usda' ? 'source_backed' : 'ai_estimated',
        allergen_status: 'known',
        allergen_tags: [],
        nutrition_basis: 'per_100g',
        basis_amount: 100,
        calories,
        protein_g: 0,
        carbs_g: 0,
        fat_g: calories / 9,
        fiber_g: 0,
        portions: [{ description: '100 g', amount: 100, unit: 'g', gram_weight: 100, is_default: true }],
        ...overrides,
    };
};

/** Duplicate detection ran and found none — the genuine pass, not the omitted check. */
const DEDUPED_CONTEXT: CatalogValidationContext = { duplicateOfSourceKey: null };

/* ---------------------------------------------------------------------------
 * fixtures/catalog-foods.fixture.json
 *
 * Snake_case database rows, not wire DTOs, so a row is handed to this module
 * unmapped. 34 foods, 24 published, and every boundary AAP §0.7.3 names among
 * them. The `note` field every row may carry is documentation rather than a
 * column, and nothing below reads it.
 * ------------------------------------------------------------------------- */

/** The values a food carried at an earlier `nutrition_version`. */
interface CatalogFixtureSupersededNutrition extends CatalogNutrientInput {
    readonly nutrition_version: number;
}

/** One `catalog_foods` row, plus the two documented non-column fields. */
interface CatalogFixtureFood {
    readonly source_key: string;
    readonly canonical_name: string;
    readonly display_name: string;
    readonly category: string;
    readonly food_state: CatalogFoodState;
    readonly food_group: string;
    readonly identity_source: CatalogIdentitySource;
    readonly identity_status: CatalogIdentityStatus;
    readonly nutrition_provenance: CatalogNutritionProvenance;
    readonly publication_status: CatalogPublicationStatus;
    readonly allergen_status: CatalogAllergenStatus;
    readonly allergen_tags: readonly string[];
    readonly nutrition_basis: CatalogNutritionBasis;
    readonly basis_amount: number;
    readonly nutrition_version: number;
    readonly calories: number | null;
    readonly protein_g: number | null;
    readonly carbs_g: number | null;
    readonly fat_g: number | null;
    readonly fiber_g: number | null;
    readonly density_g_per_ml: number | null;
    /** The label serving set, on the two rows that make the drift check evaluable. */
    readonly per_serving_nutrition?: CatalogNutrientInput | null;
    readonly superseded_nutrition?: readonly CatalogFixtureSupersededNutrition[];
}

interface CatalogFixturePortion extends CatalogFoodPortionCandidate {
    readonly food_source_key: string;
}

interface CatalogFixtureAlias {
    readonly food_source_key: string;
    readonly alias: string;
}

interface CatalogFixtureComponent {
    readonly food_source_key: string;
    readonly component_source_key: string;
    readonly component_catalog_food_id: string;
    readonly quantity_grams: number;
    readonly yield_factor: number;
    readonly component_nutrition_version: number;
    readonly sort_order: number;
}

interface CatalogFixtureValidationRecord {
    readonly food_source_key: string;
    readonly outcome: CatalogValidationOutcome;
    readonly publication_status: CatalogPublicationStatus;
    readonly checks: readonly CatalogValidationCheck[];
    /** Advisory, and consulted only in the review branch. `null` on every USDA row. */
    readonly llm_review: { readonly confirmedCheckNames?: readonly string[] } | null;
}

interface CatalogFixtureDocument {
    readonly counts: {
        readonly foods: number;
        readonly aliases: number;
        readonly portions: number;
        readonly components: number;
        readonly validation_records: number;
        readonly published_foods: number;
        readonly recipe_eligible_foods: number;
    };
    readonly foods: readonly CatalogFixtureFood[];
    readonly aliases: readonly CatalogFixtureAlias[];
    readonly portions: readonly CatalogFixturePortion[];
    readonly components: readonly CatalogFixtureComponent[];
    readonly validation_records: readonly CatalogFixtureValidationRecord[];
}

const catalogFixtureFoodProblems = (row: unknown, index: number): string[] => {
    if (!isJsonRecord(row)) {
        return [`foods[${index}] is not an object`];
    }

    const problems: string[] = [];
    const key = isJsonString(row.source_key) ? row.source_key : `foods[${index}]`;

    for (const field of ['source_key', 'canonical_name', 'display_name', 'category', 'food_group'] as const) {
        if (!isJsonString(row[field])) {
            problems.push(`${key}.${field} is not a non-empty string`);
        }
    }
    for (const field of ['calories', 'protein_g', 'carbs_g', 'fat_g', 'fiber_g', 'density_g_per_ml'] as const) {
        if (!isJsonNullableNumber(row[field])) {
            problems.push(`${key}.${field} is neither a number nor null (null means unknown)`);
        }
    }
    for (const field of ['basis_amount', 'nutrition_version'] as const) {
        if (!isJsonPositiveInteger(row[field])) {
            problems.push(`${key}.${field} is not a positive integer`);
        }
    }
    if (!isJsonStringArray(row.allergen_tags)) {
        problems.push(`${key}.allergen_tags is not an array of strings`);
    }

    // The closed sets are enforced by the module's own guards, so a fixture
    // value the database would accept but this module would not fails here.
    if (!isCatalogFoodState(row.food_state)) {
        problems.push(`${key}.food_state "${String(row.food_state)}" is not a food state`);
    }
    if (!isCatalogIdentitySource(row.identity_source)) {
        problems.push(`${key}.identity_source "${String(row.identity_source)}" is not an identity source`);
    }
    if (!isCatalogIdentityStatus(row.identity_status)) {
        problems.push(`${key}.identity_status "${String(row.identity_status)}" is not an identity status`);
    }
    if (!isCatalogNutritionProvenance(row.nutrition_provenance)) {
        problems.push(`${key}.nutrition_provenance "${String(row.nutrition_provenance)}" is not a provenance`);
    }
    if (!isCatalogPublicationStatus(row.publication_status)) {
        problems.push(`${key}.publication_status "${String(row.publication_status)}" is not a publication status`);
    }
    if (!isCatalogAllergenStatus(row.allergen_status)) {
        problems.push(`${key}.allergen_status "${String(row.allergen_status)}" is not an allergen status`);
    }
    if (!isCatalogNutritionBasis(row.nutrition_basis)) {
        problems.push(`${key}.nutrition_basis "${String(row.nutrition_basis)}" is not a nutrition basis`);
    }

    return problems;
};

const catalogFixtureProblems = (document: unknown): string[] => {
    if (!isJsonRecord(document)) {
        return ['the document is not an object'];
    }

    const problems: string[] = [];
    const arrays = ['foods', 'aliases', 'portions', 'components', 'validation_records'] as const;

    for (const field of arrays) {
        const value = document[field];

        if (!Array.isArray(value) || value.length === 0) {
            problems.push(`${field} is not a non-empty array`);
        }
    }
    if (!isJsonRecord(document.counts)) {
        problems.push('counts is not an object');
    }
    if (problems.length > 0) {
        return problems;
    }

    const foods = document.foods as unknown[];
    foods.forEach((row, index) => {
        problems.push(...catalogFixtureFoodProblems(row, index));
    });

    const sourceKeys = new Set(
        foods.filter(isJsonRecord).map((row) => (isJsonString(row.source_key) ? row.source_key : '')),
    );

    // Children name their parent by `food_source_key`. A dangling reference
    // would silently drop a portion or a validation record from every case
    // below, which is the one failure mode a fixture-driven suite must not have.
    for (const field of ['aliases', 'portions', 'components', 'validation_records'] as const) {
        (document[field] as unknown[]).forEach((row, index) => {
            if (!isJsonRecord(row)) {
                problems.push(`${field}[${index}] is not an object`);

                return;
            }
            if (!isJsonString(row.food_source_key) || !sourceKeys.has(row.food_source_key)) {
                problems.push(`${field}[${index}].food_source_key "${String(row.food_source_key)}" names no food`);
            }
            if (
                field === 'components' &&
                (!isJsonString(row.component_source_key) || !sourceKeys.has(row.component_source_key))
            ) {
                problems.push(
                    `components[${index}].component_source_key "${String(row.component_source_key)}" names no food`,
                );
            }
            if (field === 'validation_records' && !Array.isArray(row.checks)) {
                problems.push(`validation_records[${index}].checks is not an array`);
            }
        });
    }

    return problems;
};

/** The committed catalog fixture, validated once — same policy as the plan above. */
const CATALOG_FIXTURE: CatalogFixtureDocument = (() => {
    const document = readCommittedJson('fixtures', 'catalog-foods.fixture.json');
    const problems = catalogFixtureProblems(document);

    if (problems.length > 0) {
        throw new Error(
            `catalog.logic.test.ts cannot run: catalog-foods.fixture.json does not have the shape this suite ` +
                `drives the validator with — ${problems.join('; ')}`,
        );
    }

    return document as CatalogFixtureDocument;
})();

const fixtureFood = (sourceKey: string): CatalogFixtureFood => {
    const food = CATALOG_FIXTURE.foods.find((row) => row.source_key === sourceKey);

    if (!food) {
        throw new Error(`catalog-foods.fixture.json holds no food "${sourceKey}"`);
    }

    return food;
};

const fixturePortions = (sourceKey: string): CatalogFoodPortionCandidate[] =>
    CATALOG_FIXTURE.portions
        .filter((portion) => portion.food_source_key === sourceKey)
        .map((portion) => ({
            description: portion.description,
            amount: portion.amount,
            unit: portion.unit,
            gram_weight: portion.gram_weight,
            is_default: portion.is_default,
            source: portion.source,
        }));

const fixtureAliases = (sourceKey: string): string[] =>
    CATALOG_FIXTURE.aliases.filter((alias) => alias.food_source_key === sourceKey).map((alias) => alias.alias);

const fixtureComponents = (sourceKey: string): readonly CatalogFixtureComponent[] =>
    CATALOG_FIXTURE.components.filter((component) => component.food_source_key === sourceKey);

const fixtureRecord = (sourceKey: string): CatalogFixtureValidationRecord | null =>
    CATALOG_FIXTURE.validation_records.find((record) => record.food_source_key === sourceKey) ?? null;

const requireFixtureRecord = (sourceKey: string): CatalogFixtureValidationRecord => {
    const record = fixtureRecord(sourceKey);

    if (!record) {
        throw new Error(`catalog-foods.fixture.json holds no validation record for "${sourceKey}"`);
    }

    return record;
};

/**
 * One fixture row as a validation candidate: the food joined with its portions
 * and aliases, with `serving_gram_weight` taken from the default portion — the
 * same join `catalog-validate.ts` performs over the release files.
 */
const fixtureCandidate = (
    sourceKey: string,
    overrides: Partial<CatalogFoodCandidate> = {},
): CatalogFoodCandidate => {
    const food = fixtureFood(sourceKey);
    const portions = fixturePortions(sourceKey);
    const defaultPortion = portions.find((portion) => portion.is_default) ?? null;

    return {
        source_key: food.source_key,
        canonical_name: food.canonical_name,
        display_name: food.display_name,
        aliases: fixtureAliases(sourceKey),
        category: food.category,
        food_state: food.food_state,
        identity_source: food.identity_source,
        identity_status: food.identity_status,
        nutrition_provenance: food.nutrition_provenance,
        allergen_status: food.allergen_status,
        allergen_tags: food.allergen_tags,
        nutrition_basis: food.nutrition_basis,
        basis_amount: food.basis_amount,
        calories: food.calories,
        protein_g: food.protein_g,
        carbs_g: food.carbs_g,
        fat_g: food.fat_g,
        fiber_g: food.fiber_g,
        density_g_per_ml: food.density_g_per_ml,
        serving_gram_weight: defaultPortion?.gram_weight ?? null,
        portions,
        per_serving_nutrition: food.per_serving_nutrition ?? null,
        ...overrides,
    };
};

/**
 * The context the fixture's stored records were produced with: duplicate
 * detection ran and found none, and each generated row carries its advisory
 * review. The review is passed BECAUSE it is advisory — every row below whose
 * flag it declines to confirm stays held, which is the assertion that proves it.
 */
const fixtureContext = (sourceKey: string): CatalogValidationContext => ({
    duplicateOfSourceKey: null,
    advisoryReview: fixtureRecord(sourceKey)?.llm_review ?? null,
});

const validateFixtureRow = (sourceKey: string, overrides: Partial<CatalogFoodCandidate> = {}) =>
    validateCatalogCandidate(fixtureCandidate(sourceKey, overrides), SHIPPED_POLICY, fixtureContext(sourceKey));

/**
 * `retired` is not a validation outcome: `validateCatalogCandidate` can only
 * return `published`, `quarantined` or `rejected`, and `catalog-load.ts` alone
 * sets `retired`, for a previously published food a newer release dropped. So
 * the retired row's expected VERDICT is `published` — which is exactly what its
 * stored record's `outcome: accepted` says validation decided.
 */
const expectedVerdictStatus = (food: CatalogFixtureFood): CatalogPublicationStatus =>
    food.publication_status === 'retired' ? 'published' : food.publication_status;

const FIXTURE_VALIDATED_ROWS: readonly { sourceKey: string; expectedStatus: CatalogPublicationStatus }[] =
    CATALOG_FIXTURE.foods
        .filter((food) => fixtureRecord(food.source_key) !== null)
        .map((food) => ({ sourceKey: food.source_key, expectedStatus: expectedVerdictStatus(food) }));

const FIXTURE_PUBLISHED_BY_CATEGORY: Readonly<Record<string, number>> = CATALOG_FIXTURE.foods
    .filter((food) => food.publication_status === 'published')
    .reduce<Record<string, number>>((counts, food) => {
        counts[food.category] = (counts[food.category] ?? 0) + 1;

        return counts;
    }, {});

/** The nutrients of one fixture row, in the shape a component derivation takes. */
const fixtureNutrition = (sourceKey: string): CatalogNutrientInput => {
    const food = fixtureFood(sourceKey);

    return {
        calories: food.calories,
        protein_g: food.protein_g,
        carbs_g: food.carbs_g,
        fat_g: food.fat_g,
        fiber_g: food.fiber_g,
    };
};

/** The nutrients that row carried at an earlier `nutrition_version`. */
const fixtureSupersededNutrition = (sourceKey: string, nutritionVersion: number): CatalogNutrientInput => {
    const superseded = (fixtureFood(sourceKey).superseded_nutrition ?? []).find(
        (entry) => entry.nutrition_version === nutritionVersion,
    );

    if (!superseded) {
        throw new Error(`"${sourceKey}" records no superseded nutrition at version ${nutritionVersion}`);
    }

    return {
        calories: superseded.calories,
        protein_g: superseded.protein_g,
        carbs_g: superseded.carbs_g,
        fat_g: superseded.fat_g,
        fiber_g: superseded.fiber_g,
    };
};

/**
 * A parent's components, each carrying the per-100 g nutrition of the food it
 * points at. `nutritionBySourceKey` substitutes a component's values — which is
 * how the stale parent is recomputed from the version its pointer records
 * rather than from the version the component now carries.
 */
const fixtureComponentInputs = (
    parentSourceKey: string,
    nutritionBySourceKey: Readonly<Record<string, CatalogNutrientInput>> = {},
) =>
    fixtureComponents(parentSourceKey).map((component) => ({
        quantity_grams: component.quantity_grams,
        yield_factor: component.yield_factor,
        component_nutrition_version: component.component_nutrition_version,
        component_catalog_food_id: component.component_catalog_food_id,
        sort_order: component.sort_order,
        nutrition:
            nutritionBySourceKey[component.component_source_key] ??
            fixtureNutrition(component.component_source_key),
    }));

/**
 * The recipe fixture's ingredient references, read for exactly one assertion —
 * that a RETIRED catalog food stays referenceable by the recipe versions that
 * already hold it while never entering a new one. Recipe derivation itself is
 * `recipe.logic.ts`'s, and nothing else in this suite reads this document.
 */
const RECIPE_FIXTURE_INGREDIENT_SOURCE_KEYS: readonly string[] = (() => {
    const document = readCommittedJson('fixtures', 'recipes.fixture.json');

    if (!isJsonRecord(document) || !Array.isArray(document.recipe_ingredients)) {
        throw new Error(
            'catalog.logic.test.ts cannot run: recipes.fixture.json holds no recipe_ingredients array',
        );
    }

    return document.recipe_ingredients
        .filter(isJsonRecord)
        .map((row) => row.food_source_key)
        .filter(isJsonString);
})();

/** The fixture rows AAP §0.7.3 names as boundaries, by `source_key`. */
const ROW = {
    RAW_POULTRY: 'usda:9200101',
    GRAIN_DRY: 'usda:9200103',
    GRAIN_COOKED: 'usda:9200104',
    LEGUME_DRY: 'usda:9200105',
    LEGUME_COOKED: 'usda:9200106',
    EGG_WHITE: 'usda:9200107',
    EGG_YOLK: 'usda:9200108',
    UNKNOWN_FIBRE: 'usda:9200113',
    STALE_COMPONENT: 'usda:9200115',
    ALLERGENS_UNKNOWN_SOURCED: 'usda:9200116',
    DRIFT_BEYOND_ALLOWANCE: 'usda:9200117',
    DRIFT_ON_ALLOWANCE: 'usda:9200118',
    RETIRED: 'usda:9200119',
    AI_PUBLISHED: 'ai:produce_vegetable:roasted carrot coins:cooked',
    DERIVED_CURRENT: 'ai:condiment_sauce:lemon olive oil dressing:prepared',
    DERIVED_STALE: 'ai:prepared_meal:herbed yogurt dip:prepared',
    MISSING_DENSITY: 'ai:beverage:cold brew coffee concentrate:prepared',
    MISSING_CORE_NUTRIENT: 'ai:spice_herb:smoked paprika blend:dry',
    UNSOURCED: 'ai:other:mixed micronutrient powder:dry',
    ALLERGENS_UNKNOWN_GENERATED: 'ai:snack:seeded multigrain crisps:as_purchased',
    KCAL_ON_CEILING: 'ai:oil_fat:high oleic sunflower oil:as_purchased',
    KCAL_PAST_CEILING: 'ai:other:rendered fat blend:prepared',
    MACRO_MASS_ON_ALLOWANCE: 'ai:protein_plant:pea protein isolate:dry',
    MACRO_MASS_PAST_ALLOWANCE: 'ai:protein_plant:textured pea protein concentrate:dry',
    BRAND_PATTERN: 'ai:snack:acme brand protein crisps:as_purchased',
    UNVALIDATED_CANDIDATE: 'ai:produce_fruit:frozen mango chunks:raw',
} as const;

/* ---------------------------------------------------------------------------
 * The shipped coverage plan, as the policy
 * ------------------------------------------------------------------------- */

describe('the shipped coverage plan, loaded as the validation policy', () => {
    it('declares the twenty-one categories the plan names, each exactly once', () => {
        expect(CATEGORY_CODES).toHaveLength(COVERAGE_PLAN_CATEGORY_COUNT);
        expect(new Set(CATEGORY_CODES).size).toBe(COVERAGE_PLAN_CATEGORY_COUNT);
    });

    // The bands, tolerances, targets and volumes TRANSCRIBED from AAP §0.7.3 —
    // written out here rather than read from the document, because a file that
    // is its own only authority can be retuned without anyone reviewing it.
    // Retuning a band is meant to be a reviewed DATA change; this is the review
    // expressed as an assertion, and the sweeps below then run on whatever the
    // document says, so the two together catch both a wrong value and a value
    // the module stopped reading.
    it('matches the bands, tolerances, targets and volumes AAP 0.7.3 tabulates', () => {
        expect(
            SHIPPED_PLAN.categories.map((entry) => ({
                category: entry.category,
                min: entry.kcalReviewRange.min,
                max: entry.kcalReviewRange.max,
                tolerance: entry.energyMacroTolerancePercent,
                publishedTarget: entry.publishedTarget,
                candidateVolume: entry.candidateVolume,
            })),
        ).toEqual([
            { category: 'produce_vegetable', min: 5, max: 150, tolerance: 30, publishedTarget: 1200, candidateVolume: 1500 },
            { category: 'produce_fruit', min: 15, max: 350, tolerance: 30, publishedTarget: 700, candidateVolume: 875 },
            { category: 'protein_meat', min: 80, max: 450, tolerance: 15, publishedTarget: 700, candidateVolume: 875 },
            { category: 'protein_poultry', min: 80, max: 350, tolerance: 15, publishedTarget: 400, candidateVolume: 500 },
            { category: 'protein_seafood', min: 50, max: 350, tolerance: 15, publishedTarget: 600, candidateVolume: 750 },
            { category: 'protein_egg', min: 40, max: 350, tolerance: 15, publishedTarget: 60, candidateVolume: 75 },
            { category: 'protein_plant', min: 50, max: 500, tolerance: 20, publishedTarget: 350, candidateVolume: 438 },
            { category: 'dairy', min: 30, max: 450, tolerance: 15, publishedTarget: 600, candidateVolume: 750 },
            { category: 'dairy_alternative', min: 10, max: 300, tolerance: 25, publishedTarget: 250, candidateVolume: 313 },
            // 80-400 is the union of grain's own dry and cooked bands, which
            // §0.7.3 states as the pair rather than as a category-wide range.
            { category: 'grain', min: 80, max: 400, tolerance: 15, publishedTarget: 600, candidateVolume: 750 },
            { category: 'bread_bakery', min: 200, max: 450, tolerance: 15, publishedTarget: 500, candidateVolume: 625 },
            { category: 'legume', min: 60, max: 400, tolerance: 20, publishedTarget: 250, candidateVolume: 313 },
            { category: 'nut_seed', min: 450, max: 700, tolerance: 12, publishedTarget: 350, candidateVolume: 438 },
            { category: 'oil_fat', min: 700, max: 900, tolerance: 8, publishedTarget: 150, candidateVolume: 188 },
            { category: 'condiment_sauce', min: 0, max: 600, tolerance: 30, publishedTarget: 700, candidateVolume: 875 },
            { category: 'spice_herb', min: 0, max: 400, tolerance: 40, publishedTarget: 300, candidateVolume: 375 },
            { category: 'beverage', min: 0, max: 120, tolerance: 40, publishedTarget: 600, candidateVolume: 750 },
            { category: 'snack', min: 200, max: 600, tolerance: 15, publishedTarget: 600, candidateVolume: 750 },
            { category: 'sweet', min: 150, max: 600, tolerance: 20, publishedTarget: 500, candidateVolume: 625 },
            { category: 'prepared_meal', min: 50, max: 400, tolerance: 20, publishedTarget: 1400, candidateVolume: 1750 },
            { category: 'other', min: 0, max: 900, tolerance: 30, publishedTarget: 200, candidateVolume: 250 },
        ]);
    });

    it('matches the dry and cooked bands AAP 0.7.3 gives grain and legume', () => {
        expect(
            SHIPPED_PLAN.categories
                .filter((entry) => entry.kcalReviewRangeByFoodState !== undefined)
                .map((entry) => ({ category: entry.category, states: entry.kcalReviewRangeByFoodState })),
        ).toEqual([
            { category: 'grain', states: { dry: { min: 300, max: 400 }, cooked: { min: 80, max: 200 } } },
            { category: 'legume', states: { dry: { min: 300, max: 400 }, cooked: { min: 60, max: 200 } } },
        ]);
    });

    it('matches the global validation bounds AAP 0.7.3 states', () => {
        expect(SHIPPED_PLAN.validationBounds).toEqual({
            tier: 'reject',
            maxKcalPer100g: 900,
            macroMassToleranceFactor: 1.02,
            energyMacroAbsoluteToleranceKcal: 30,
            portionConversionTolerancePercent: 5,
        });
    });

    // Two totals the budget estimate, the run report and the shortfall
    // assertion all read: a per-category target that no longer adds up to them
    // would mis-size every one of the three.
    it('sums its per-category published targets to the declared total', () => {
        const summed = SHIPPED_PLAN.categories.reduce((total, entry) => total + entry.publishedTarget, 0);

        expect(summed).toBe(SHIPPED_PLAN.publishedTargetTotal);
        expect(summed).toBe(COVERAGE_PLAN_PUBLISHED_TARGET_TOTAL);
    });

    it('sums its per-category candidate volumes to the declared total', () => {
        const summed = SHIPPED_PLAN.categories.reduce((total, entry) => total + entry.candidateVolume, 0);

        expect(summed).toBe(SHIPPED_PLAN.candidateVolumeTotal);
        expect(summed).toBe(COVERAGE_PLAN_CANDIDATE_VOLUME_TOTAL);
    });

    it('takes every candidate volume as ceil(multiplier x target), as exact integers', () => {
        for (const entry of SHIPPED_PLAN.categories) {
            expect({ category: entry.category, candidateVolume: entry.candidateVolume }).toEqual({
                category: entry.category,
                candidateVolume: Math.ceil(SHIPPED_PLAN.candidateVolumeMultiplier * entry.publishedTarget),
            });
        }
    });

    // Dry rice at 360 kcal and cooked rice at 123 do not share a plausible
    // band; nothing else in the plan publishes two such forms.
    it('carries a per-food-state band on exactly the two categories whose forms do not overlap', () => {
        expect(
            SHIPPED_PLAN.categories
                .filter((entry) => entry.kcalReviewRangeByFoodState !== undefined)
                .map((entry) => entry.category),
        ).toEqual(['grain', 'legume']);
    });

    it.each(CATEGORY_CODES)('resolves the band and tolerance the plan declares for %s', (category) => {
        const entry = planCategory(category);

        expect(resolveCategoryBounds(SHIPPED_POLICY, category, BAND_PROBE_FOOD_STATE)).toEqual({
            category,
            kcalRange: { min: entry.kcalReviewRange.min, max: entry.kcalReviewRange.max },
            energyMacroTolerancePercent: entry.energyMacroTolerancePercent,
            kcalRangeFromFoodState: false,
        });
    });

    it.each(PER_FOOD_STATE_BANDS)(
        'prefers the $foodState band $category declares over its category-wide one',
        ({ category, foodState, min, max }) => {
            const entry = planCategory(category);

            expect(resolveCategoryBounds(SHIPPED_POLICY, category, foodState)).toEqual({
                category,
                kcalRange: { min, max },
                energyMacroTolerancePercent: entry.energyMacroTolerancePercent,
                kcalRangeFromFoodState: true,
            });
            // Otherwise the override is decoration rather than a decision.
            expect({ min, max }).not.toEqual({
                min: entry.kcalReviewRange.min,
                max: entry.kcalReviewRange.max,
            });
        },
    );

    // An undefined aisle would silently drop a row from the shopping list, and
    // an unused aisle would be a section header nothing ever files under.
    it('files every declared category under one of the five aisles, using all five', () => {
        const aisles = CATEGORY_CODES.map((category) => mapCategoryToGroceryCategory(category));

        expect(aisles.every((aisle) => isGroceryCategory(aisle))).toBe(true);
        expect(new Set(aisles)).toEqual(new Set(GROCERY_CATEGORY_ORDER));
    });

    // The shape guard is what turns a malformed document into one readable
    // failure instead of a hundred confusing ones, and a guard nothing
    // exercises is a guard that has quietly stopped guarding.
    it('names the problem in a coverage plan it could not drive the validator with', () => {
        expect(coveragePlanProblems(SHIPPED_PLAN)).toEqual([]);
        expect(coveragePlanProblems('not a document')).toEqual(['the document is not an object']);
        expect(coveragePlanProblems({ ...SHIPPED_PLAN, categories: [] })).toEqual([
            'categories is not a non-empty array',
        ]);
        expect(
            coveragePlanProblems({
                ...SHIPPED_PLAN,
                categories: [...SHIPPED_PLAN.categories, SHIPPED_PLAN.categories[0]],
            }),
        ).toEqual([`categories declares ${SHIPPED_PLAN.categories[0].category} more than once`]);
        expect(
            coveragePlanProblems({
                ...SHIPPED_PLAN,
                validationBounds: { ...SHIPPED_PLAN.validationBounds, maxKcalPer100g: 0 },
            }),
        ).toEqual(['validationBounds.maxKcalPer100g is not a positive number']);
    });

    it('reports the whole published target as the shortfall when nothing is published', () => {
        const shortfall = computeCoverageShortfall(SHIPPED_POLICY, {});

        expect(shortfall.categories).toHaveLength(COVERAGE_PLAN_CATEGORY_COUNT);
        expect(shortfall.publishedTargetTotal).toBe(COVERAGE_PLAN_PUBLISHED_TARGET_TOTAL);
        expect(shortfall.shortfallTotal).toBe(COVERAGE_PLAN_PUBLISHED_TARGET_TOTAL);
        expect(shortfall.meetsTarget).toBe(false);
        expect(shortfall.unknownCategories).toEqual([]);
    });
});

/* ---------------------------------------------------------------------------
 * Every category of the shipped plan, at the edges of its own bands
 *
 * Table-driven from `coverage-plan.v1.json` itself, which is what makes the
 * coverage complete rather than representative: the committed fixture holds
 * rows in 17 of the 21 categories, and a band is exercised here whether or not
 * a real row happens to occupy it. The energy at each edge comes from the plan,
 * so retuning a band moves these cases with it and retuning it WRONGLY — a band
 * a real food no longer fits — is what the fixture cases below catch.
 * ------------------------------------------------------------------------- */

describe('every coverage-plan category, at the edges of its own bands', () => {
    it.each(CATEGORY_CODES)('publishes %s on both edges of every band it declares', (category) => {
        for (const band of categoryBands(category)) {
            for (const calories of [band.min, band.max]) {
                for (const identitySource of CATALOG_IDENTITY_SOURCES) {
                    const verdict = validateCatalogCandidate(
                        bandProbe(category, band.foodState, calories, identitySource),
                        SHIPPED_POLICY,
                        DEDUPED_CONTEXT,
                    );

                    expect({
                        band: `${category}/${band.foodState}`,
                        calories,
                        identitySource,
                        status: verdict.publicationStatus,
                        reviewFlags: verdict.reviewFlags,
                        inBand: checkNamed(verdict.checks, CATALOG_CHECK_NAMES.OUT_OF_CATEGORY_RANGE)?.pass,
                    }).toEqual({
                        band: `${category}/${band.foodState}`,
                        calories,
                        identitySource,
                        status: 'published',
                        reviewFlags: [],
                        inBand: true,
                    });
                }
            }
        }
    });

    // The review tier is the only one whose consequence depends on the source:
    // a USDA record publishes with the flag recorded, a generated one is held
    // until the advisory review confirms it.
    it.each(CATEGORY_CODES)('flags %s outside every band it declares, holding only the generated row', (category) => {
        const outside = categoryBands(category).flatMap((band) => [
            // A negative energy is not an out-of-band case but a rejected
            // nutrient, so a band starting at 0 has no "below" edge.
            ...(band.min >= 1 ? [{ band, calories: band.min - 1 }] : []),
            // And a band reaching the global ceiling has no "above" edge that
            // is not the ceiling case instead.
            ...(band.max < SHIPPED_PLAN.validationBounds.maxKcalPer100g
                ? [{ band, calories: band.max + 1 }]
                : []),
        ]);

        if (outside.length === 0) {
            // `other` declares 0-900 — the whole admissible range — so it has
            // no out-of-band energy that is not also past the global ceiling,
            // which the reject-tier case covers instead. Pinning that it is the
            // only such category is the assertion; inventing a case is not.
            expect(categoryBands(category)).toEqual([
                {
                    category: 'other',
                    foodState: BAND_PROBE_FOOD_STATE,
                    min: 0,
                    max: SHIPPED_PLAN.validationBounds.maxKcalPer100g,
                    fromFoodState: false,
                },
            ]);

            return;
        }

        for (const { band, calories } of outside) {
            const sourced = validateCatalogCandidate(
                bandProbe(category, band.foodState, calories, 'usda'),
                SHIPPED_POLICY,
                DEDUPED_CONTEXT,
            );
            const generated = validateCatalogCandidate(
                bandProbe(category, band.foodState, calories, 'ai_generated'),
                SHIPPED_POLICY,
                DEDUPED_CONTEXT,
            );
            const confirmed = validateCatalogCandidate(
                bandProbe(category, band.foodState, calories, 'ai_generated'),
                SHIPPED_POLICY,
                {
                    ...DEDUPED_CONTEXT,
                    advisoryReview: {
                        confirmedCheckNames: [CATALOG_CHECK_NAMES.OUT_OF_CATEGORY_RANGE],
                    },
                },
            );

            expect({
                band: `${category}/${band.foodState}`,
                calories,
                sourced: sourced.publicationStatus,
                sourcedFlags: sourced.reviewFlags,
                generated: generated.publicationStatus,
                generatedDeciding: generated.decidingCheckNames,
                confirmed: confirmed.publicationStatus,
            }).toEqual({
                band: `${category}/${band.foodState}`,
                calories,
                sourced: 'published',
                sourcedFlags: [CATALOG_CHECK_NAMES.OUT_OF_CATEGORY_RANGE],
                generated: 'quarantined',
                generatedDeciding: [CATALOG_CHECK_NAMES.OUT_OF_CATEGORY_RANGE],
                confirmed: 'published',
            });
        }
    });
});

/* ---------------------------------------------------------------------------
 * Every category of the shipped plan, one case per tier
 * ------------------------------------------------------------------------- */

describe('every coverage-plan category, one case per validation tier', () => {
    it.each(CATEGORY_CODES)('rejects a %s candidate one kcal past the global ceiling', (category) => {
        const calories = SHIPPED_PLAN.validationBounds.maxKcalPer100g + 1;

        for (const identitySource of CATALOG_IDENTITY_SOURCES) {
            const verdict = validateCatalogCandidate(
                bandProbe(category, BAND_PROBE_FOOD_STATE, calories, identitySource),
                SHIPPED_POLICY,
                DEDUPED_CONTEXT,
            );

            expect({
                category,
                identitySource,
                status: verdict.publicationStatus,
                deciding: verdict.decidingCheckNames,
                counts: verdict.countsTowardPublishedTarget,
            }).toEqual({
                category,
                identitySource,
                status: 'rejected',
                deciding: [CATALOG_CHECK_NAMES.KCAL_CEILING],
                counts: false,
            });
        }
    });

    it.each(CATEGORY_CODES)('quarantines a %s candidate whose fat is unknown', (category) => {
        const band = categoryBands(category)[0];

        for (const identitySource of CATALOG_IDENTITY_SOURCES) {
            const verdict = validateCatalogCandidate(
                bandProbe(category, band.foodState, band.min, identitySource, { fat_g: null }),
                SHIPPED_POLICY,
                DEDUPED_CONTEXT,
            );

            expect({
                category,
                identitySource,
                status: verdict.publicationStatus,
                deciding: verdict.decidingCheckNames,
            }).toEqual({
                category,
                identitySource,
                status: 'quarantined',
                deciding: [CATALOG_CHECK_NAMES.MISSING_CORE_NUTRIENT],
            });
        }
    });

    it.each(CATEGORY_CODES)('flags unknown allergens on %s, publishing only the sourced row', (category) => {
        const band = categoryBands(category)[0];
        const unknownAllergens = { allergen_status: 'unknown' as const };

        const sourced = validateCatalogCandidate(
            bandProbe(category, band.foodState, band.min, 'usda', unknownAllergens),
            SHIPPED_POLICY,
            DEDUPED_CONTEXT,
        );
        const generated = validateCatalogCandidate(
            bandProbe(category, band.foodState, band.min, 'ai_generated', unknownAllergens),
            SHIPPED_POLICY,
            DEDUPED_CONTEXT,
        );
        const allowlisted = validateCatalogCandidate(
            bandProbe(category, band.foodState, band.min, 'ai_generated', unknownAllergens),
            SHIPPED_POLICY,
            {
                ...DEDUPED_CONTEXT,
                curatorAllowlistedCheckNames: [CATALOG_CHECK_NAMES.ALLERGENS_UNKNOWN],
            },
        );

        expect({
            category,
            sourced: sourced.publicationStatus,
            sourcedFlags: sourced.reviewFlags,
            generated: generated.publicationStatus,
            generatedDeciding: generated.decidingCheckNames,
            allowlisted: allowlisted.publicationStatus,
        }).toEqual({
            category,
            sourced: 'published',
            sourcedFlags: [CATALOG_CHECK_NAMES.ALLERGENS_UNKNOWN],
            generated: 'quarantined',
            generatedDeciding: [CATALOG_CHECK_NAMES.ALLERGENS_UNKNOWN],
            allowlisted: 'published',
        });
    });
});

/* ---------------------------------------------------------------------------
 * The per-category energy-vs-macro tolerance
 * ------------------------------------------------------------------------- */

// max(30 kcal, T % of the stated energy), with T from the plan: produce is
// judged at 30 % (fibre, organic acids) and oil at 8 %, and the 30 kcal floor
// keeps a low-energy food from failing on rounding alone.
describe('the per-category energy-vs-macro tolerance', () => {
    it.each(CATEGORY_CODES)('judges %s against the tolerance the plan declares for it', (category) => {
        const entry = planCategory(category);
        const calories = Math.round((entry.kcalReviewRange.min + entry.kcalReviewRange.max) / 2);
        const allowed = Math.max(
            SHIPPED_PLAN.validationBounds.energyMacroAbsoluteToleranceKcal,
            (calories * entry.energyMacroTolerancePercent) / 100,
        );
        // Fat alone carries the energy, so removing `difference` kcal of fat
        // makes 4P + 4C + 9F disagree with the stated energy by exactly that.
        const disagreeingBy = (difference: number) =>
            validateCatalogCandidate(
                bandProbe(category, BAND_PROBE_FOOD_STATE, calories, 'usda', {
                    fat_g: (calories - difference) / 9,
                }),
                SHIPPED_POLICY,
                DEDUPED_CONTEXT,
            );

        const inside = disagreeingBy(allowed - 1);
        const outside = disagreeingBy(allowed + 1);
        const insideCheck = checkNamed(inside.checks, CATALOG_CHECK_NAMES.ENERGY_MACRO_MISMATCH);

        expect(insideCheck?.bound as number).toBeCloseTo(allowed, 6);
        expect(insideCheck?.observed as number).toBeCloseTo(allowed - 1, 6);
        expect({ category, status: inside.publicationStatus, pass: insideCheck?.pass }).toEqual({
            category,
            status: 'published',
            pass: true,
        });
        expect({ category, status: outside.publicationStatus, deciding: outside.decidingCheckNames }).toEqual({
            category,
            status: 'rejected',
            deciding: [CATALOG_CHECK_NAMES.ENERGY_MACRO_MISMATCH],
        });
    });
});

/* ---------------------------------------------------------------------------
 * The committed catalog fixture, judged by the shipped policy
 * ------------------------------------------------------------------------- */

describe('the committed catalog fixture', () => {
    it('matches the counts it declares', () => {
        expect({
            foods: CATALOG_FIXTURE.foods.length,
            aliases: CATALOG_FIXTURE.aliases.length,
            portions: CATALOG_FIXTURE.portions.length,
            components: CATALOG_FIXTURE.components.length,
            validation_records: CATALOG_FIXTURE.validation_records.length,
            published_foods: CATALOG_FIXTURE.foods.filter((food) => food.publication_status === 'published')
                .length,
        }).toEqual({
            foods: CATALOG_FIXTURE.counts.foods,
            aliases: CATALOG_FIXTURE.counts.aliases,
            portions: CATALOG_FIXTURE.counts.portions,
            components: CATALOG_FIXTURE.counts.components,
            validation_records: CATALOG_FIXTURE.counts.validation_records,
            published_foods: CATALOG_FIXTURE.counts.published_foods,
        });
    });

    // Same reason as the coverage plan's guard: a dangling child or a value
    // outside a closed set has to name itself, once, before the rest of this
    // block runs against data nothing accepted.
    it('names the problem in a fixture it could not drive the validator with', () => {
        expect(catalogFixtureProblems(CATALOG_FIXTURE)).toEqual([]);
        expect(catalogFixtureProblems({ ...CATALOG_FIXTURE, foods: [] })).toEqual([
            'foods is not a non-empty array',
        ]);
        expect(
            catalogFixtureProblems({
                ...CATALOG_FIXTURE,
                portions: [{ ...CATALOG_FIXTURE.portions[0], food_source_key: 'usda:0' }],
            }),
        ).toEqual(['portions[0].food_source_key "usda:0" names no food']);
        expect(
            catalogFixtureProblems({
                ...CATALOG_FIXTURE,
                foods: CATALOG_FIXTURE.foods.map((food, index) =>
                    index === 0 ? { ...food, food_state: 'liquefied' } : food,
                ),
            }),
        ).toEqual([`${CATALOG_FIXTURE.foods[0].source_key}.food_state "liquefied" is not a food state`]);
    });

    it('files every food under a category the coverage plan declares', () => {
        for (const food of CATALOG_FIXTURE.foods) {
            expect({
                sourceKey: food.source_key,
                resolved: resolveCategoryBounds(SHIPPED_POLICY, food.category, food.food_state) !== null,
            }).toEqual({ sourceKey: food.source_key, resolved: true });
        }
    });

    // The partial unique index allows exactly one, and the
    // `missing_gram_weight` check requires its weight to be sourced.
    it('gives every food exactly one default portion with a sourced gram weight', () => {
        for (const food of CATALOG_FIXTURE.foods) {
            const defaults = fixturePortions(food.source_key).filter((portion) => portion.is_default);

            expect({
                sourceKey: food.source_key,
                defaults: defaults.length,
                positiveWeight: defaults.every(
                    (portion) => portion.gram_weight !== null && portion.gram_weight > 0,
                ),
            }).toEqual({ sourceKey: food.source_key, defaults: 1, positiveWeight: true });
        }
    });

    // The fixture's records were produced with `duplicateOfSourceKey: null`, so
    // that claim has to hold over the whole file — and the two rice rows are
    // where it could plausibly fail, since they share a canonical name.
    it('holds no duplicate identity, and keeps the two rice states apart', () => {
        const plan = dedupeIdentity(
            CATALOG_FIXTURE.foods.map((food) => ({
                source_key: food.source_key,
                canonical_name: food.canonical_name,
                food_state: food.food_state,
                identity_source: food.identity_source,
                display_name: food.display_name,
                aliases: fixtureAliases(food.source_key),
            })),
        );

        expect(plan.merges).toEqual([]);
        expect(plan.duplicateSourceKeys).toEqual([]);
        expect(plan.survivors).toHaveLength(CATALOG_FIXTURE.counts.foods);
        expect(plan.survivors.map((survivor) => survivor.source_key)).toEqual(
            expect.arrayContaining([ROW.GRAIN_DRY, ROW.GRAIN_COOKED]),
        );
    });

    // The single most valuable assertion in this file: every stored record was
    // produced by this module over these rows, so the module must still produce
    // it — the same checks, in the same order, with the same observed values
    // and bounds, and the same outcome. A retuned constant, a reordered check
    // or a changed observation all surface here.
    it.each(FIXTURE_VALIDATED_ROWS)('reproduces the stored verdict for $sourceKey', ({ sourceKey, expectedStatus }) => {
        const record = requireFixtureRecord(sourceKey);
        const verdict = validateFixtureRow(sourceKey);

        expect(verdict.publicationStatus).toBe(expectedStatus);
        expect(verdict.outcome).toBe(record.outcome);
        expect(verdict.checks).toEqual(record.checks);
    });

    // `candidate` is what a generated row arrives as and `retired` is the
    // loader's; a verdict that produced either would be claiming a decision
    // this module does not own.
    it('never returns a status validation does not own', () => {
        for (const { sourceKey } of FIXTURE_VALIDATED_ROWS) {
            expect(['published', 'quarantined', 'rejected']).toContain(
                validateFixtureRow(sourceKey).publicationStatus,
            );
        }
    });

    // A coverage count therefore reads the STORED status, never the verdict:
    // the retired row validates as published and must not be counted as part of
    // the live catalog.
    it('counts toward the published target every row validation published, including the retired one', () => {
        const counting = FIXTURE_VALIDATED_ROWS.filter(
            ({ sourceKey }) => validateFixtureRow(sourceKey).countsTowardPublishedTarget,
        ).map(({ sourceKey }) => sourceKey);
        const published = CATALOG_FIXTURE.foods
            .filter((food) => food.publication_status === 'published')
            .map((food) => food.source_key);

        expect(new Set(counting)).toEqual(new Set([...published, ROW.RETIRED]));
        expect(counting).toHaveLength(CATALOG_FIXTURE.counts.published_foods + 1);
    });

    it('reports the fixture published counts as an exact per-category shortfall', () => {
        const shortfall = computeCoverageShortfall(SHIPPED_POLICY, FIXTURE_PUBLISHED_BY_CATEGORY);

        expect(shortfall.publishedTotal).toBe(CATALOG_FIXTURE.counts.published_foods);
        expect(shortfall.unknownCategories).toEqual([]);
        expect(shortfall.meetsTarget).toBe(false);
        expect(shortfall.shortfallTotal).toBe(
            COVERAGE_PLAN_PUBLISHED_TARGET_TOTAL - CATALOG_FIXTURE.counts.published_foods,
        );
        for (const entry of shortfall.categories) {
            expect({ category: entry.category, shortfall: entry.shortfall }).toEqual({
                category: entry.category,
                shortfall: entry.publishedTarget - (FIXTURE_PUBLISHED_BY_CATEGORY[entry.category] ?? 0),
            });
        }
    });

    it('agrees with the fixture on which foods a NEW recipe may use', () => {
        const eligible = CATALOG_FIXTURE.foods
            .filter((food) =>
                isRecipeEligibleCatalogFood({
                    publication_status: food.publication_status,
                    nutrition_provenance: food.nutrition_provenance,
                    allergen_status: food.allergen_status,
                }),
            )
            .map((food) => food.source_key);

        expect(eligible).toHaveLength(CATALOG_FIXTURE.counts.recipe_eligible_foods);
        // Published but estimated, retired, and published but allergen-unknown:
        // all three fail a different one of the three conditions.
        expect(eligible).not.toContain(ROW.AI_PUBLISHED);
        expect(eligible).not.toContain(ROW.RETIRED);
        expect(eligible).not.toContain(ROW.ALLERGENS_UNKNOWN_SOURCED);
        expect(eligible).toContain(ROW.RAW_POULTRY);
    });
});

/* ---------------------------------------------------------------------------
 * The fixture rows AAP §0.7.3 names as boundaries
 * ------------------------------------------------------------------------- */

describe('the boundary rows of the committed fixture', () => {
    it('publishes a row whose energy sits exactly on the global ceiling', () => {
        const verdict = validateFixtureRow(ROW.KCAL_ON_CEILING);

        expect(fixtureFood(ROW.KCAL_ON_CEILING).calories).toBe(
            SHIPPED_PLAN.validationBounds.maxKcalPer100g,
        );
        expect(checkNamed(verdict.checks, CATALOG_CHECK_NAMES.KCAL_CEILING)).toEqual({
            name: CATALOG_CHECK_NAMES.KCAL_CEILING,
            pass: true,
            observed: 900,
            bound: 900,
            tier: 'reject',
        });
        // 900 is also the top of oil_fat's own band, so it passes both.
        expect(checkNamed(verdict.checks, CATALOG_CHECK_NAMES.OUT_OF_CATEGORY_RANGE)).toEqual({
            name: CATALOG_CHECK_NAMES.OUT_OF_CATEGORY_RANGE,
            pass: true,
            observed: 900,
            bound: '700-900 kcal/100g for oil_fat',
            tier: 'review',
        });
        expect(verdict.publicationStatus).toBe('published');
        expect(verdict.reviewFlags).toEqual([]);
    });

    it('rejects a row one kcal past the global ceiling, recording the band it also left', () => {
        const verdict = validateFixtureRow(ROW.KCAL_PAST_CEILING);

        expect(fixtureFood(ROW.KCAL_PAST_CEILING).calories).toBe(
            SHIPPED_PLAN.validationBounds.maxKcalPer100g + 1,
        );
        expect(verdict.publicationStatus).toBe('rejected');
        expect(verdict.decidingCheckNames).toEqual([CATALOG_CHECK_NAMES.KCAL_CEILING]);
        expect(verdict.reviewFlags).toEqual([CATALOG_CHECK_NAMES.OUT_OF_CATEGORY_RANGE]);
        expect(verdict.countsTowardPublishedTarget).toBe(false);
    });

    it('publishes a row whose macro mass is exactly the tolerated weight', () => {
        const food = fixtureFood(ROW.MACRO_MASS_ON_ALLOWANCE);
        const verdict = validateFixtureRow(ROW.MACRO_MASS_ON_ALLOWANCE);
        const allowedMass =
            PER_100G_BASIS_AMOUNT * SHIPPED_PLAN.validationBounds.macroMassToleranceFactor;

        expect((food.protein_g ?? 0) + (food.carbs_g ?? 0) + (food.fat_g ?? 0)).toBeCloseTo(allowedMass, 6);
        expect(checkNamed(verdict.checks, CATALOG_CHECK_NAMES.MACRO_MASS_CEILING)).toEqual({
            name: CATALOG_CHECK_NAMES.MACRO_MASS_CEILING,
            pass: true,
            observed: 102,
            bound: 102,
            tier: 'reject',
        });
        expect(verdict.publicationStatus).toBe('published');
    });

    it('rejects a row one gram of macro mass past the same allowance', () => {
        const verdict = validateFixtureRow(ROW.MACRO_MASS_PAST_ALLOWANCE);

        expect(verdict.publicationStatus).toBe('rejected');
        expect(verdict.decidingCheckNames).toEqual([CATALOG_CHECK_NAMES.MACRO_MASS_CEILING]);
        expect(checkNamed(verdict.checks, CATALOG_CHECK_NAMES.MACRO_MASS_CEILING)).toEqual({
            name: CATALOG_CHECK_NAMES.MACRO_MASS_CEILING,
            pass: false,
            observed: 103,
            bound: 102,
            tier: 'reject',
        });
        // The two protein_plant rows differ by one gram and nothing else that
        // matters: both sit inside the category band.
        expect(checkNamed(verdict.checks, CATALOG_CHECK_NAMES.OUT_OF_CATEGORY_RANGE)?.pass).toBe(true);
    });

    it('passes a portion conversion drifting by exactly the allowance', () => {
        const verdict = validateFixtureRow(ROW.DRIFT_ON_ALLOWANCE);

        expect(checkNamed(verdict.checks, CATALOG_CHECK_NAMES.PORTION_CONVERSION_DRIFT)).toEqual({
            name: CATALOG_CHECK_NAMES.PORTION_CONVERSION_DRIFT,
            pass: true,
            observed: 'calories 5.00%',
            bound: `within ${SHIPPED_PLAN.validationBounds.portionConversionTolerancePercent}% of the per-100g values at 50 g`,
            tier: 'reject',
        });
        expect(verdict.publicationStatus).toBe('published');
    });

    it('rejects a portion conversion drifting past the allowance', () => {
        const verdict = validateFixtureRow(ROW.DRIFT_BEYOND_ALLOWANCE);

        expect(verdict.publicationStatus).toBe('rejected');
        expect(verdict.decidingCheckNames).toEqual([CATALOG_CHECK_NAMES.PORTION_CONVERSION_DRIFT]);
        expect(checkNamed(verdict.checks, CATALOG_CHECK_NAMES.PORTION_CONVERSION_DRIFT)?.observed).toBe(
            'calories 15.81%',
        );
    });

    // AAP §0.7.3 requires this suite to prove exactly this: the bands are wide
    // enough to contain each category's real extremes, so they flag oddities
    // rather than rejecting real foods.
    it('publishes egg white and egg yolk from the one protein_egg band', () => {
        expect(planCategory('protein_egg').kcalReviewRange).toEqual({ min: 40, max: 350 });
        expect([fixtureFood(ROW.EGG_WHITE).calories, fixtureFood(ROW.EGG_YOLK).calories]).toEqual([52, 322]);

        for (const sourceKey of [ROW.EGG_WHITE, ROW.EGG_YOLK]) {
            const verdict = validateFixtureRow(sourceKey);

            expect({
                sourceKey,
                category: fixtureFood(sourceKey).category,
                identitySource: fixtureFood(sourceKey).identity_source,
                status: verdict.publicationStatus,
                flags: verdict.reviewFlags,
                bound: checkNamed(verdict.checks, CATALOG_CHECK_NAMES.OUT_OF_CATEGORY_RANGE)?.bound,
            }).toEqual({
                sourceKey,
                category: 'protein_egg',
                identitySource: 'usda',
                status: 'published',
                flags: [],
                bound: '40-350 kcal/100g for protein_egg',
            });
        }
    });

    it.each([
        { form: 'dry', sourceKey: ROW.GRAIN_DRY, bound: '300-400 kcal/100g for grain (dry)' },
        { form: 'cooked', sourceKey: ROW.GRAIN_COOKED, bound: '80-200 kcal/100g for grain (cooked)' },
        { form: 'dry', sourceKey: ROW.LEGUME_DRY, bound: '300-400 kcal/100g for legume (dry)' },
        { form: 'cooked', sourceKey: ROW.LEGUME_COOKED, bound: '60-200 kcal/100g for legume (cooked)' },
    ])('publishes the $form form of $sourceKey against its own band', ({ sourceKey, bound }) => {
        const verdict = validateFixtureRow(sourceKey);

        expect({
            status: verdict.publicationStatus,
            flags: verdict.reviewFlags,
            bound: checkNamed(verdict.checks, CATALOG_CHECK_NAMES.OUT_OF_CATEGORY_RANGE)?.bound,
        }).toEqual({ status: 'published', flags: [], bound });
    });

    // The partial unique index is on (canonical_name, food_state), so one
    // identity in two forms is two published rows rather than a duplicate.
    it('publishes two states of one rice identity without either shadowing the other', () => {
        const dry = fixtureFood(ROW.GRAIN_DRY);
        const cooked = fixtureFood(ROW.GRAIN_COOKED);

        expect(normalizeCanonicalName(dry.canonical_name)).toBe(normalizeCanonicalName(cooked.canonical_name));
        expect(dry.display_name).toBe(cooked.display_name);
        expect(dry.food_state).not.toBe(cooked.food_state);
        expect([
            validateFixtureRow(ROW.GRAIN_DRY).publicationStatus,
            validateFixtureRow(ROW.GRAIN_COOKED).publicationStatus,
        ]).toEqual(['published', 'published']);
    });

    // The review tier's only source-dependent consequence, on the two rows that
    // differ in nothing else that decides.
    it('publishes the sourced unknown-allergen row and holds the generated one', () => {
        const sourced = validateFixtureRow(ROW.ALLERGENS_UNKNOWN_SOURCED);
        const generated = validateFixtureRow(ROW.ALLERGENS_UNKNOWN_GENERATED);

        expect(fixtureFood(ROW.ALLERGENS_UNKNOWN_SOURCED).allergen_status).toBe('unknown');
        expect(fixtureFood(ROW.ALLERGENS_UNKNOWN_GENERATED).allergen_status).toBe('unknown');

        expect({ status: sourced.publicationStatus, flags: sourced.reviewFlags }).toEqual({
            status: 'published',
            flags: [CATALOG_CHECK_NAMES.ALLERGENS_UNKNOWN],
        });
        expect({
            status: generated.publicationStatus,
            deciding: generated.decidingCheckNames,
            flags: generated.reviewFlags,
        }).toEqual({
            status: 'quarantined',
            deciding: [CATALOG_CHECK_NAMES.ALLERGENS_UNKNOWN],
            flags: [CATALOG_CHECK_NAMES.ALLERGENS_UNKNOWN],
        });

        // Its stored advisory review declined to confirm the flag, which is why
        // it is held; a review that confirms it lifts the hold and can do
        // nothing else.
        expect(requireFixtureRecord(ROW.ALLERGENS_UNKNOWN_GENERATED).llm_review?.confirmedCheckNames).toEqual(
            [],
        );
        expect(
            validateCatalogCandidate(
                fixtureCandidate(ROW.ALLERGENS_UNKNOWN_GENERATED),
                SHIPPED_POLICY,
                {
                    duplicateOfSourceKey: null,
                    advisoryReview: { confirmedCheckNames: [CATALOG_CHECK_NAMES.ALLERGENS_UNKNOWN] },
                },
            ).publicationStatus,
        ).toBe('published');
    });

    // Generation proposes generic preparations only: a model-proposed
    // manufacturer cannot verify a model-proposed product.
    it('rejects the generated row whose name carries a brand word', () => {
        const verdict = validateFixtureRow(ROW.BRAND_PATTERN);

        expect(verdict.publicationStatus).toBe('rejected');
        expect(verdict.decidingCheckNames).toEqual([CATALOG_CHECK_NAMES.BRAND_PATTERN_NAME]);
        expect(checkNamed(verdict.checks, CATALOG_CHECK_NAMES.BRAND_PATTERN_NAME)?.observed).toBe(
            'brand_word: brand in "acme brand protein crisps"',
        );
    });

    it('quarantines the generated row no identity evidence corroborates', () => {
        const verdict = validateFixtureRow(ROW.UNSOURCED);

        expect(fixtureFood(ROW.UNSOURCED).identity_status).toBe('unsourced');
        expect(verdict.publicationStatus).toBe('quarantined');
        expect(verdict.decidingCheckNames).toEqual([CATALOG_CHECK_NAMES.UNSOURCED]);
    });

    // Millilitres are never assumed to equal grams.
    it('quarantines the volume-basis row with no stored density', () => {
        const verdict = validateFixtureRow(ROW.MISSING_DENSITY);

        expect(fixtureFood(ROW.MISSING_DENSITY).nutrition_basis).toBe('per_100ml');
        expect(fixtureFood(ROW.MISSING_DENSITY).density_g_per_ml).toBeNull();
        expect(verdict.publicationStatus).toBe('quarantined');
        expect(verdict.decidingCheckNames).toEqual([CATALOG_CHECK_NAMES.MISSING_DENSITY]);
        expect(verdict.normalizedNutrition).toBeNull();
    });

    // Null means unknown either way; which nutrient it is decides the outcome.
    it('quarantines the row whose core nutrient is unknown and publishes the row whose fibre is', () => {
        const core = validateFixtureRow(ROW.MISSING_CORE_NUTRIENT);
        const fibre = validateFixtureRow(ROW.UNKNOWN_FIBRE);

        expect(fixtureFood(ROW.MISSING_CORE_NUTRIENT).fat_g).toBeNull();
        expect(core.publicationStatus).toBe('quarantined');
        expect(core.decidingCheckNames).toEqual([CATALOG_CHECK_NAMES.MISSING_CORE_NUTRIENT]);
        expect(checkNamed(core.checks, CATALOG_CHECK_NAMES.MISSING_CORE_NUTRIENT)?.observed).toBe('fat_g');

        expect(fixtureFood(ROW.UNKNOWN_FIBRE).fiber_g).toBeNull();
        expect(fibre.publicationStatus).toBe('published');
        expect(fibre.normalizedNutrition?.fiber_g).toBeNull();
    });

    it('recomputes the current ingredient-derived parent exactly', () => {
        const components = fixtureComponents(ROW.DERIVED_CURRENT);
        const result = deriveComponentNutrition(fixtureComponentInputs(ROW.DERIVED_CURRENT));

        expect(result.kind).toBe('ok');
        if (result.kind !== 'ok') {
            return;
        }
        expect(result.derived.nutrition).toEqual(fixtureNutrition(ROW.DERIVED_CURRENT));
        expect(result.derived.nutrition_provenance).toBe('ingredient_derived');
        expect(result.derived.inputGrams).toBe(
            components.reduce((total, component) => total + component.quantity_grams, 0),
        );
        expect(result.derived.yieldedGrams).toBe(
            components.reduce(
                (total, component) => total + component.quantity_grams * component.yield_factor,
                0,
            ),
        );
        expect(result.derived.componentNutritionVersions).toEqual(
            components.map((component) => component.component_nutrition_version),
        );
        // Published, and an estimate whatever its components were, so it is
        // never an ingredient of a planned recipe.
        expect(validateFixtureRow(ROW.DERIVED_CURRENT).publicationStatus).toBe('published');
        expect(isEstimatedNutrition(fixtureFood(ROW.DERIVED_CURRENT).nutrition_provenance)).toBe(true);
    });

    // Staleness is a pointer comparison, not a check: the row publishes with
    // numbers derived from a version its component has since moved past, and a
    // refresh is what recomputes them.
    it('recomputes the stale ingredient-derived parent from the version its pointer records', () => {
        const pointer = fixtureComponents(ROW.DERIVED_STALE).find(
            (component) => component.component_source_key === ROW.STALE_COMPONENT,
        );

        expect(pointer?.component_nutrition_version).toBe(1);
        expect(fixtureFood(ROW.STALE_COMPONENT).nutrition_version).toBe(2);

        const stale = deriveComponentNutrition(
            fixtureComponentInputs(ROW.DERIVED_STALE, {
                [ROW.STALE_COMPONENT]: fixtureSupersededNutrition(ROW.STALE_COMPONENT, 1),
            }),
        );
        const refreshed = deriveComponentNutrition(fixtureComponentInputs(ROW.DERIVED_STALE));

        expect(stale.kind).toBe('ok');
        expect(refreshed.kind).toBe('ok');
        if (stale.kind !== 'ok' || refreshed.kind !== 'ok') {
            return;
        }
        expect(stale.derived.nutrition).toEqual(fixtureNutrition(ROW.DERIVED_STALE));
        expect(refreshed.derived.nutrition).not.toEqual(stale.derived.nutrition);
        expect(validateFixtureRow(ROW.DERIVED_STALE).publicationStatus).toBe('published');
    });

    // Retirement is the loader's decision for a food a newer release dropped,
    // never a verdict; the row stays referenceable by the recipe versions that
    // already hold it and may not enter a new one.
    it('validates the retired row as published and leaves retirement to the loader', () => {
        const food = fixtureFood(ROW.RETIRED);
        const verdict = validateFixtureRow(ROW.RETIRED);

        expect(food.publication_status).toBe('retired');
        expect(CATALOG_PUBLICATION_STATUSES).toContain('retired');
        expect(requireFixtureRecord(ROW.RETIRED).outcome).toBe('accepted');
        expect(verdict.publicationStatus).toBe('published');
        expect(verdict.outcome).toBe('accepted');
        expect(
            isRecipeEligibleCatalogFood({
                publication_status: food.publication_status,
                nutrition_provenance: food.nutrition_provenance,
                allergen_status: food.allergen_status,
            }),
        ).toBe(false);
        expect(RECIPE_FIXTURE_INGREDIENT_SOURCE_KEYS).toContain(ROW.RETIRED);
    });

    // `candidate` is what a generated row arrives as, before validation runs.
    it('leaves the unvalidated candidate row without a record, and accepts it once validation runs', () => {
        expect(fixtureFood(ROW.UNVALIDATED_CANDIDATE).publication_status).toBe('candidate');
        expect(CATALOG_PUBLICATION_STATUSES).toContain('candidate');
        expect(fixtureRecord(ROW.UNVALIDATED_CANDIDATE)).toBeNull();
        expect(validateFixtureRow(ROW.UNVALIDATED_CANDIDATE).publicationStatus).toBe('published');
    });

    it('publishes an AI-estimated row and still refuses it to a recipe', () => {
        const food = fixtureFood(ROW.AI_PUBLISHED);

        expect(validateFixtureRow(ROW.AI_PUBLISHED).publicationStatus).toBe('published');
        expect(food.nutrition_provenance).toBe('ai_estimated');
        expect(isEstimatedNutrition(food.nutrition_provenance)).toBe(true);
        expect(
            isRecipeEligibleCatalogFood({
                publication_status: food.publication_status,
                nutrition_provenance: food.nutrition_provenance,
                allergen_status: food.allergen_status,
            }),
        ).toBe(false);
    });
});

/* ---------------------------------------------------------------------------
 * Bounds are parameters, not constants
 *
 * The property the small `POLICY` at the top of this file exists for, stated
 * as the sharpest form of itself: one committed fixture row, judged twice, and
 * a different verdict each time because the POLICY differed — not the row, not
 * the module. A module that had started reading `coverage-plan.v1.json` itself
 * would pass every other test in this file and fail every test here.
 * ------------------------------------------------------------------------- */

describe('bounds are parameters, not constants', () => {
    const withBounds = (overrides: Partial<CatalogGlobalValidationBounds>): CatalogValidationPolicy => ({
        ...SHIPPED_POLICY,
        validationBounds: { ...SHIPPED_POLICY.validationBounds, ...overrides },
    });

    const withCategoryBand = (category: string, min: number, max: number): CatalogValidationPolicy => ({
        ...SHIPPED_POLICY,
        categories: SHIPPED_POLICY.categories.map((entry) =>
            entry.category === category ? { ...entry, kcalReviewRange: { min, max } } : entry,
        ),
    });

    const withSwappedFoodStateBands = (category: string): CatalogValidationPolicy => ({
        ...SHIPPED_POLICY,
        categories: SHIPPED_POLICY.categories.map((entry) => {
            if (entry.category !== category) {
                return entry;
            }

            const bands = entry.kcalReviewRangeByFoodState ?? {};

            return { ...entry, kcalReviewRangeByFoodState: { dry: bands.cooked, cooked: bands.dry } };
        }),
    });

    const verdictUnder = (sourceKey: string, policy: CatalogValidationPolicy) =>
        validateCatalogCandidate(fixtureCandidate(sourceKey), policy, fixtureContext(sourceKey));

    it('rejects under a tightened macro-mass factor the row the shipped plan publishes', () => {
        expect(verdictUnder(ROW.MACRO_MASS_ON_ALLOWANCE, SHIPPED_POLICY).publicationStatus).toBe('published');

        const tightened = verdictUnder(
            ROW.MACRO_MASS_ON_ALLOWANCE,
            withBounds({ macroMassToleranceFactor: 1.01 }),
        );

        expect(tightened.publicationStatus).toBe('rejected');
        expect(tightened.decidingCheckNames).toEqual([CATALOG_CHECK_NAMES.MACRO_MASS_CEILING]);
        expect(checkNamed(tightened.checks, CATALOG_CHECK_NAMES.MACRO_MASS_CEILING)?.bound).toBe(101);
    });

    it('rejects under a lowered energy ceiling the row the shipped plan publishes', () => {
        expect(verdictUnder(ROW.KCAL_ON_CEILING, SHIPPED_POLICY).publicationStatus).toBe('published');

        const lowered = verdictUnder(ROW.KCAL_ON_CEILING, withBounds({ maxKcalPer100g: 899 }));

        expect(lowered.publicationStatus).toBe('rejected');
        expect(lowered.decidingCheckNames).toEqual([CATALOG_CHECK_NAMES.KCAL_CEILING]);
    });

    it('rejects under a tightened portion tolerance the row the shipped plan publishes', () => {
        expect(verdictUnder(ROW.DRIFT_ON_ALLOWANCE, SHIPPED_POLICY).publicationStatus).toBe('published');

        const tightened = verdictUnder(
            ROW.DRIFT_ON_ALLOWANCE,
            withBounds({ portionConversionTolerancePercent: 4 }),
        );

        expect(tightened.publicationStatus).toBe('rejected');
        expect(tightened.decidingCheckNames).toEqual([CATALOG_CHECK_NAMES.PORTION_CONVERSION_DRIFT]);
    });

    it('holds under a narrowed category band the generated row the shipped plan publishes', () => {
        const narrowed = verdictUnder(ROW.MACRO_MASS_ON_ALLOWANCE, withCategoryBand('protein_plant', 50, 400));

        expect(narrowed.publicationStatus).toBe('quarantined');
        expect(narrowed.decidingCheckNames).toEqual([CATALOG_CHECK_NAMES.OUT_OF_CATEGORY_RANGE]);
        expect(checkNamed(narrowed.checks, CATALOG_CHECK_NAMES.OUT_OF_CATEGORY_RANGE)?.bound).toBe(
            '50-400 kcal/100g for protein_plant',
        );
    });

    it.each([
        { sourceKey: ROW.GRAIN_DRY, category: 'grain' },
        { sourceKey: ROW.LEGUME_COOKED, category: 'legume' },
    ])('flags $sourceKey once the per-food-state bands of $category are swapped', ({ sourceKey, category }) => {
        expect(verdictUnder(sourceKey, SHIPPED_POLICY).reviewFlags).toEqual([]);

        const swapped = verdictUnder(sourceKey, withSwappedFoodStateBands(category));

        // Still published — it is a USDA row, and the review tier publishes
        // those with the flag recorded — but the verdict is not the same one.
        expect(swapped.publicationStatus).toBe('published');
        expect(swapped.reviewFlags).toEqual([CATALOG_CHECK_NAMES.OUT_OF_CATEGORY_RANGE]);
    });

    // The four-category policy at the top of this file is not a smaller copy of
    // the plan: it declares no `protein_egg` at all, and a candidate under an
    // undeclared category is rejected rather than judged against a default band.
    it('rejects against the four-category policy the row the shipped plan publishes', () => {
        expect(verdictUnder(ROW.EGG_WHITE, SHIPPED_POLICY).publicationStatus).toBe('published');

        const underSmallPolicy = verdictUnder(ROW.EGG_WHITE, POLICY);

        expect(underSmallPolicy.publicationStatus).toBe('rejected');
        expect(underSmallPolicy.decidingCheckNames).toEqual([CATALOG_CHECK_NAMES.UNKNOWN_CATEGORY]);
        expect(POLICY.categories.map((entry) => entry.category)).not.toContain('protein_egg');
    });
});
