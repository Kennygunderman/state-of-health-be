/**
 * `catalog.logic.ts` is the pure decision layer of the internal food catalog
 * (Agent Action Plan §0.3.3, §0.7.1 Group 3): identity and the `source_key`
 * every run upserts on, the per-100 g nutrition basis, the aisle mapping, the
 * three-tier validation that turns a candidate into a published, quarantined or
 * rejected row, and the coverage shortfall.
 *
 * What this suite pins, and why each is a decision someone could break:
 *
 *  - **Bounds are parameters, never constants.** Every category band and
 *    tolerance arrives as an argument sourced from `coverage-plan.v1.json`, so
 *    the policy fixture below is deliberately small and explicit: a test that
 *    passed only against the shipped plan would hide a module that had started
 *    reading it directly.
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
    CatalogFoodCandidate,
    CatalogIdentityCandidate,
    CatalogIdentityError,
    CatalogNutritionSource,
    CatalogValidationPolicy,
    CORE_NUTRIENT_FIELDS,
    DEFAULT_BRAND_WORDS,
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
    parseCatalogSearchQuery,
    resolveCatalogDisposition,
    resolveCategoryBounds,
    validateCatalogCandidate,
} from '../catalog.logic';
import { CatalogValidationCheck } from '../../types/catalog';

/* ---------------------------------------------------------------------------
 * Fixtures — a small, explicit stand-in for coverage-plan.v1.json
 * ------------------------------------------------------------------------- */

/**
 * Four categories are enough to exercise every branch: one ordinary band, one
 * with the per-food-state override `grain` and `legume` carry, one with a tight
 * tolerance (oil), and one whose spelling differs from its lookup key.
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

    // The six quarantine names are the coverage plan's `quarantineChecks`
    // vocabulary; `catalog-validate.ts` asserts code and data agree against
    // this derived list, so its membership is part of the contract.
    it('files the six quarantine-tier checks and the two review-tier checks', () => {
        expect([...CATALOG_QUARANTINE_CHECK_NAMES]).toEqual([
            'duplicate_identity',
            'missing_core_nutrient',
            'missing_density',
            'missing_gram_weight',
            'unsourced',
            'unsupported_portion',
        ]);
        expect([...CATALOG_REVIEW_CHECK_NAMES]).toEqual(['allergens_unknown', 'out_of_category_range']);
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
    it('normalises an FDC id to its decimal integer form', () => {
        expect(buildSourceKey({ identitySource: 'usda', fdcId: 171077 })).toBe('usda:171077');
        expect(buildSourceKey({ identitySource: 'usda', fdcId: '171077' })).toBe('usda:171077');
        expect(buildSourceKey({ identitySource: 'usda', fdcId: '0171077' })).toBe('usda:171077');
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
    // onto one row.
    it.each([
        ['a non-integer FDC id', { identitySource: 'usda' as const, fdcId: 17.5 }],
        ['a zero FDC id', { identitySource: 'usda' as const, fdcId: 0 }],
        ['a negative FDC id', { identitySource: 'usda' as const, fdcId: -3 }],
        ['a non-numeric FDC id', { identitySource: 'usda' as const, fdcId: 'abc' }],
        ['an empty FDC id', { identitySource: 'usda' as const, fdcId: '' }],
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

    // "Chicken Broth" is a preparation; only a brand attached to a product form
    // is a product.
    it('does not fire on a generic preparation', () => {
        for (const name of [
            'chicken breast, raw',
            'Chicken Broth',
            'granola bars',
            'rolled oats, dry',
            'olive oil, extra virgin',
        ]) {
            expect(findBrandPatternMatch([name])).toBeNull();
        }
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
