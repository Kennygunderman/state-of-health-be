// The pure decision layer of the internal food catalog: identity, the per-100g
// nutrition basis, the aisle mapping, and the three-tier validation that turns a
// candidate into a published, quarantined or rejected row.
//
// Everything here is deterministic and synchronous — no Prisma, no fetch, no
// filesystem, no `process.env`, no clock. The import, generation, validation,
// report, release and load scripts and `catalog.service.ts` all delegate their
// DECISIONS to this module rather than reimplementing them, which is why each
// rule below is expressed as a function over its data.
//
// Four conventions are worth stating once, because all four are easy to get
// subtly wrong and every one of them is pinned by a unit test:
//
//  * BOUNDS ARE PARAMETERS. Every threshold — the 21 category codes, the kcal
//    review ranges (with the per-food-state variants `grain` and `legume`
//    carry), the per-category energy-vs-macro tolerances and the global
//    validation bounds — arrives as an argument sourced from
//    `data/meal-planning/coverage-plan.v1.json`, which `scripts/lib/manifest.ts`
//    loads and version-checks. This module imports neither that file nor that
//    loader: the production program is `rootDir: "./src"` and the Docker image
//    excludes `data/`, so an import is not even possible — but the real reason
//    is that retuning a category's plausible energy band must be a reviewed
//    DATA change, not a code edit.
//
//  * THE CLOSED VALUE SETS ARE ENFORCED HERE OR NOWHERE. `publication_status`,
//    `identity_source`, `identity_status`, `nutrition_provenance`,
//    `food_state`, `nutrition_basis`, `allergen_status` and the grocery
//    `category` are plain TEXT columns with no Prisma enum and no CHECK
//    constraint, precisely so that validation lives in this file. A value this
//    module admits reaches the database unchallenged, which is why the guards
//    below are exported and why the tiering introduces no new status.
//
//  * VERDICTS ARE RETURNED, NOT THROWN. A validation answer is a `checks[]`
//    record — one `{name, pass, observed, bound, tier}` entry per rule — and an
//    exception cannot carry that. Throwing is reserved for input that could
//    only be a programming error (`buildSourceKey` with a blank name, which
//    would mint one colliding key for every such candidate).
//
//    A check that could NOT be evaluated is ABSENT from the record rather than
//    recorded as a pass: "we had no per-serving values to compare" and "the
//    values agreed" are different facts, and only one of them is a pass.
//
//  * NULL MEANS UNKNOWN. The nutrient columns are `DOUBLE PRECISION NULL` and a
//    null is never coerced to 0 — a zero is a claim ("contains no fibre") the
//    source never made. The four core macros missing is a quarantine; any other
//    nutrient may legitimately stay null on a published food.
//
// Not this module's job: reading or writing anything (the scripts and
// `catalog.service.ts` own every await and transaction), shaping a wire DTO
// (`catalog.mapper.ts`), the SSRF-safe retrieval of identity evidence
// (`evidence.logic.ts` / `evidence.service.ts`), recipe eligibility beyond the
// nutrition and allergen facts below (`recipe.logic.ts`), and grocery
// aggregation or display (`grocery.logic.ts` over `utils/units.ts`).

import {
    CatalogAllergenStatus,
    CatalogCheckTier,
    CatalogFoodState,
    CatalogIdentitySource,
    CatalogIdentityStatus,
    CatalogNutritionBasis,
    CatalogNutritionProvenance,
    CatalogPublicationStatus,
    CatalogValidationCheck,
    CatalogValidationOutcome,
} from '../types/catalog';
import { NutritionProvenance } from '../types/nutrition';
import { millilitersToGrams, UnitConversionError, unitFamily } from '../utils/units';

/* ---------------------------------------------------------------------------
 * Errors — the narrow case where a verdict cannot express the problem
 * ------------------------------------------------------------------------- */

/**
 * Thrown only by {@link buildSourceKey}, and only for input that cannot yield a
 * usable key: a blank canonical name, a blank category, or a non-canonical FDC
 * id.
 *
 * This is deliberately louder than a verdict. `source_key` is the UNIQUE column
 * every import, generation run and release load upserts on, so a key derived
 * from an empty name would collapse every such candidate onto one row — a
 * silent, permanent data loss that a `checks[]` entry nobody reads would not
 * prevent. Callers validate a candidate's presence fields first; reaching this
 * error means the caller skipped that step.
 */
export class CatalogIdentityError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CatalogIdentityError';
    }
}

/**
 * The validation policy itself is unusable — a bound that is not a finite
 * positive number, one whose arithmetic overflows, or a portion rule that does
 * not match the invariants the database enforces.
 *
 * A distinct class from {@link CatalogIdentityError} because it blames a
 * different thing: the operator's `coverage-plan.v1.json`, not the candidate.
 * That distinction decides the disposition. A candidate judged against a broken
 * policy must not become a `rejected` row — `rejected` means "physically
 * impossible, never publishable", and re-running with a corrected plan would
 * have published it — so the run stops at the first candidate instead of
 * writing a terminal verdict for thousands of salvageable ones.
 */
export class CatalogPolicyError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CatalogPolicyError';
    }
}

/* ---------------------------------------------------------------------------
 * Closed value sets — this module is the only enforcement point
 * ------------------------------------------------------------------------- */

interface ClosedSet<T extends string> {
    values: readonly T[];
    includes: (value: unknown) => value is T;
}

/**
 * Builds a value set from a `Record` keyed by the union, so adding a member to
 * a type in `types/catalog.ts` without listing it here is a COMPILE error
 * rather than a guard that quietly rejects the new value.
 *
 * `hasOwnProperty` and not `in`: `'toString' in members` is true for every
 * object literal, which would admit `toString` as a food state.
 */
const closedSet = <T extends string>(members: Readonly<Record<T, true>>): ClosedSet<T> => {
    const values = Object.keys(members) as T[];
    const includes = (value: unknown): value is T =>
        typeof value === 'string' && Object.prototype.hasOwnProperty.call(members, value);

    return { values, includes };
};

const foodStates = closedSet<CatalogFoodState>({
    raw: true,
    cooked: true,
    prepared: true,
    dry: true,
    as_purchased: true,
});

const identitySources = closedSet<CatalogIdentitySource>({ usda: true, ai_generated: true });

const identityStatuses = closedSet<CatalogIdentityStatus>({
    verified: true,
    ambiguous: true,
    unsourced: true,
});

const nutritionProvenances = closedSet<CatalogNutritionProvenance>({
    source_backed: true,
    ingredient_derived: true,
    ai_estimated: true,
});

const nutritionBases = closedSet<CatalogNutritionBasis>({
    per_100g: true,
    per_100ml: true,
    per_serving: true,
});

const allergenStatuses = closedSet<CatalogAllergenStatus>({ known: true, unknown: true });

const publicationStatuses = closedSet<CatalogPublicationStatus>({
    candidate: true,
    published: true,
    quarantined: true,
    rejected: true,
    retired: true,
});

/** Raw, dry and cooked forms of one food are distinct rows, never duplicates. */
export const CATALOG_FOOD_STATES: readonly CatalogFoodState[] = foodStates.values;
export const isCatalogFoodState: (value: unknown) => value is CatalogFoodState = foodStates.includes;

export const CATALOG_IDENTITY_SOURCES: readonly CatalogIdentitySource[] = identitySources.values;
export const isCatalogIdentitySource: (value: unknown) => value is CatalogIdentitySource =
    identitySources.includes;

export const CATALOG_IDENTITY_STATUSES: readonly CatalogIdentityStatus[] = identityStatuses.values;
export const isCatalogIdentityStatus: (value: unknown) => value is CatalogIdentityStatus =
    identityStatuses.includes;

export const CATALOG_NUTRITION_PROVENANCES: readonly CatalogNutritionProvenance[] =
    nutritionProvenances.values;
export const isCatalogNutritionProvenance: (value: unknown) => value is CatalogNutritionProvenance =
    nutritionProvenances.includes;

export const CATALOG_NUTRITION_BASES: readonly CatalogNutritionBasis[] = nutritionBases.values;
export const isCatalogNutritionBasis: (value: unknown) => value is CatalogNutritionBasis =
    nutritionBases.includes;

export const CATALOG_ALLERGEN_STATUSES: readonly CatalogAllergenStatus[] = allergenStatuses.values;
export const isCatalogAllergenStatus: (value: unknown) => value is CatalogAllergenStatus =
    allergenStatuses.includes;

export const CATALOG_PUBLICATION_STATUSES: readonly CatalogPublicationStatus[] =
    publicationStatuses.values;
export const isCatalogPublicationStatus: (value: unknown) => value is CatalogPublicationStatus =
    publicationStatuses.includes;

/* ---------------------------------------------------------------------------
 * The policy parameter — the coverage plan, passed in
 * ------------------------------------------------------------------------- */

export interface CatalogKcalRange {
    readonly min: number;
    readonly max: number;
}

/**
 * One category's plausibility bounds. Structurally the subset of the coverage
 * plan's `categories[]` entry this module decides with, declared here rather
 * than imported so the dependency runs scripts → services and never the
 * reverse: `scripts/lib/manifest.ts`'s `CoveragePlanCategory` is assignable to
 * this interface (its `category` literal union narrows to `string`, and its
 * `readonly` members and arrays line up).
 */
export interface CatalogCategoryBounds {
    readonly category: string;
    /** Energy outside this band is atypical, not impossible: it flags for review. */
    readonly kcalReviewRange: CatalogKcalRange;
    /**
     * `grain` and `legume` publish both dry and cooked forms whose plausible
     * bands do not overlap (dry rice ≈ 360 kcal, cooked rice ≈ 130), so those
     * categories override the category-wide band per food state.
     */
    readonly kcalReviewRangeByFoodState?: Readonly<Partial<Record<CatalogFoodState, CatalogKcalRange>>>;
    /** Rejection bound on `|4P + 4C + 9F − kcal|`, as a percentage of stated energy. */
    readonly energyMacroTolerancePercent: number;
    /** Counts toward the published catalog; the per-category targets sum to 11,010. */
    readonly publishedTarget: number;
}

export interface CatalogGlobalValidationBounds {
    readonly maxKcalPer100g: number;
    readonly macroMassToleranceFactor: number;
    readonly energyMacroAbsoluteToleranceKcal: number;
    readonly portionConversionTolerancePercent: number;
}

/**
 * The portion half of the coverage plan's `nutritionBasisRule`, as this module
 * enforces it.
 *
 * Every field is a rule the DATABASE also holds, which is why validation has to
 * state it: `catalog_food_portions.gram_weight` is `NOT NULL` and a partial
 * unique index allows one default per food, so a candidate that breaks either
 * rule is not a row that gets published badly — it is a row that cannot be
 * written at all. Validated here, it becomes an auditable quarantine an
 * operator can group and fix; unvalidated, it is a candidate reported
 * publishable that aborts the run's transaction on insert.
 *
 * The plan's other `nutritionBasisRule` members need no field here because they
 * are honoured by construction: `publishableBases` (`per_100g`, `per_100ml`)
 * holds because {@link normalizeToPer100g} publishes nothing on any other
 * basis, `volumeBasisRequiresDensity` is `millilitersToGrams`' own rule,
 * `perServingOnlyWithoutGramWeightCheck` names the check that branch already
 * returns, `requiredNutrients` is {@link CORE_NUTRIENT_FIELDS}, and
 * `nullNutrientMeansUnknown` is this module's null policy throughout.
 */
export interface CatalogNutritionBasisRule {
    /** How many portions may carry `is_default` — one, per the partial unique index. */
    readonly requiredDefaultPortionCount: number;
    /** That the default portion must state a sourced gram weight. Only `true` is supported. */
    readonly defaultPortionRequiresSourcedGramWeight: boolean;
    /**
     * That EVERY retained portion must state one. Only `true` is supported. The
     * source may legitimately state no weight for a portion — the importer never
     * invents one — but such a portion cannot be kept, because the column it
     * would be written to is `NOT NULL`.
     */
    readonly retainedPortionsRequireSourcedGramWeight: boolean;
}

/**
 * The one supported rule, and the shipped `coverage-plan.v1.json` values.
 *
 * These are NOT tunable. Each field restates a constraint the database already
 * enforces, so a rule that relaxed one would only move the failure later: the
 * candidate would be reported publishable and then abort the insert against
 * `NOT NULL` or the partial unique index — the exact defect this validation
 * exists to prevent. {@link assertUsableValidationPolicy} therefore rejects any
 * other rule rather than honouring it, and the enforcement below does not
 * consult the booleans at all, so no future edit can reintroduce a switch.
 *
 * The fields remain in the type because the coverage plan carries them: they let
 * a plan that has drifted from the invariants fail loudly instead of being
 * silently ignored, which is the traceability between plan and validator that
 * having the rule in data is for.
 */
export const DEFAULT_CATALOG_NUTRITION_BASIS_RULE: CatalogNutritionBasisRule = {
    requiredDefaultPortionCount: 1,
    defaultPortionRequiresSourcedGramWeight: true,
    retainedPortionsRequireSourcedGramWeight: true,
};

/**
 * Everything {@link validateCatalogCandidate} decides with. `brandWords` and
 * `productFormWords` are optional because this module ships curated defaults
 * for them ({@link DEFAULT_BRAND_WORDS}, {@link DEFAULT_PRODUCT_FORM_WORDS}) —
 * they are domain vocabulary rather than tunable thresholds, and the coverage
 * plan carries no list of them. `nutritionBasisRule` is optional for the same
 * reason in reverse: the plan does carry it, and
 * {@link DEFAULT_CATALOG_NUTRITION_BASIS_RULE} mirrors those values so a
 * caller that has not yet threaded the plan through still validates against
 * the policy.
 */
export interface CatalogValidationPolicy {
    readonly categories: readonly CatalogCategoryBounds[];
    readonly validationBounds: CatalogGlobalValidationBounds;
    readonly nutritionBasisRule?: CatalogNutritionBasisRule;
    readonly brandWords?: readonly string[];
    readonly productFormWords?: readonly string[];
}

/** The bounds that actually apply to one candidate, after the per-state override. */
export interface ResolvedCategoryBounds {
    readonly category: string;
    readonly kcalRange: CatalogKcalRange;
    readonly energyMacroTolerancePercent: number;
    /** True when {@link CatalogCategoryBounds.kcalReviewRangeByFoodState} supplied the band. */
    readonly kcalRangeFromFoodState: boolean;
}

const categoryKey = (category: string): string => category.trim().toLowerCase();

/**
 * The bounds for a category and food state, or `null` when the coverage plan
 * does not define that category at all.
 *
 * `null` is not a detail: a candidate filed under an undeclared category cannot
 * have its energy checked against anything, which is why
 * {@link validateCatalogCandidate} treats it as a rejection rather than
 * quietly validating it against a default band.
 */
export const resolveCategoryBounds = (
    policy: CatalogValidationPolicy,
    category: string,
    foodState: CatalogFoodState,
): ResolvedCategoryBounds | null => {
    const wanted = categoryKey(category);
    const bounds = policy.categories.find((entry) => categoryKey(entry.category) === wanted);

    if (!bounds) {
        return null;
    }

    const perState = bounds.kcalReviewRangeByFoodState?.[foodState];

    return {
        category: bounds.category,
        kcalRange: perState ?? bounds.kcalReviewRange,
        energyMacroTolerancePercent: bounds.energyMacroTolerancePercent,
        kcalRangeFromFoodState: perState !== undefined,
    };
};

/* ---------------------------------------------------------------------------
 * The check vocabulary and its tiers
 * ------------------------------------------------------------------------- */

/**
 * Every deterministic check this module can record, by stable name.
 *
 * The QUARANTINE-tier names are exactly the `quarantineChecks` vocabulary in
 * `coverage-plan.v1.json`, and {@link CATALOG_QUARANTINE_CHECK_NAMES} is
 * derived from the tier map below so a script can assert code and data agree
 * rather than trusting that they still do. No count is stated here on purpose:
 * the derived constant and the data are the two authorities, and a number in
 * prose is a third that goes stale the next time a check is added.
 *
 * `out_of_category_range` is a REVIEW-tier name even though it is what holds an
 * AI-generated candidate in quarantine: the tier describes the check's own
 * severity, and the disposition rule ({@link resolveCatalogDisposition}) is
 * what turns a review flag into a hold for one identity source and an
 * informational note for the other.
 */
export const CATALOG_CHECK_NAMES = {
    /** A stated nutrient is NaN or Infinity — no arithmetic downstream is meaningful. */
    NUTRIENT_NOT_FINITE: 'nutrient_not_finite',
    /** A stated nutrient is below zero. */
    NUTRIENT_NEGATIVE: 'nutrient_negative',
    /** The basis the nutrients are stated per is zero, negative or not finite. */
    INVALID_BASIS_AMOUNT: 'invalid_basis_amount',
    /** The candidate's category is not one the coverage plan declares. */
    UNKNOWN_CATEGORY: 'unknown_category',
    /** Energy per 100 g above the global ceiling (pure fat is ≈ 884 kcal). */
    KCAL_CEILING: 'kcal_ceiling',
    /** More grams of protein + carbohydrate + fat than the food weighs. */
    MACRO_MASS_CEILING: 'macro_mass_ceiling',
    /** `|4P + 4C + 9F − kcal|` beyond the category's tolerance. */
    ENERGY_MACRO_MISMATCH: 'energy_macro_mismatch',
    /** Per-100 g values and the stated portion values disagree by too much. */
    PORTION_CONVERSION_DRIFT: 'portion_conversion_drift',
    /** An AI-generated candidate named like a manufactured product. */
    BRAND_PATTERN_NAME: 'brand_pattern_name',
    /** An ingredient-derived food declaring no components at all. */
    EMPTY_COMPONENT_SET: 'empty_component_set',
    /** A component quantity or yield factor that is not a positive, finite number. */
    INVALID_COMPONENT_QUANTITY: 'invalid_component_quantity',
    /**
     * A COMPUTED value — a basis mass, a rescale factor, a scaled nutrient, an
     * aggregate component mass or a derived total — that arithmetic on finite
     * inputs turned into `Infinity` or `NaN`.
     *
     * Its own name rather than one of the stated-value checks above, because
     * the fault is different in kind and in remedy: the record's numbers are
     * each individually finite and it is their product or sum that is not, so
     * an operator reading `nutrient_not_finite` would go looking for a nutrient
     * that is not there. Reject tier, because the alternative is worse than a
     * rejection: an unguarded overflow stores a false zero (a total divided by
     * an infinite mass) or writes `Infinity` into a validation observation,
     * which JSONB cannot hold — `JSON.stringify` turns both into `null`, so the
     * audit record would claim the check observed nothing.
     */
    NON_FINITE_COMPUTED_VALUE: 'non_finite_computed_value',

    /** A per-serving record whose serving has no sourced gram weight. */
    MISSING_GRAM_WEIGHT: 'missing_gram_weight',
    /** A volume basis without a positive stored density — millilitres never equal grams. */
    MISSING_DENSITY: 'missing_density',
    /** Any of calories, protein, carbohydrate or fat is unknown. */
    MISSING_CORE_NUTRIENT: 'missing_core_nutrient',
    /** A portion with a non-positive amount or gram weight, or an unconvertible unit. */
    UNSUPPORTED_PORTION: 'unsupported_portion',
    /**
     * A number of default portions other than the one the nutrition-basis rule
     * requires.
     *
     * Recorded rather than left to the database: `catalog_food_portions` carries
     * a partial unique index on `(catalog_food_id) WHERE is_default`, so a
     * second default is a write that FAILS, and a candidate the validator
     * called publishable would abort the run's transaction instead of receiving
     * an auditable verdict an operator can group and fix.
     */
    DEFAULT_PORTION_COUNT: 'default_portion_count',
    /** No identity evidence corroborates the candidate. */
    UNSOURCED: 'unsourced',
    /** Another candidate or row already holds this canonical name and food state. */
    DUPLICATE_IDENTITY: 'duplicate_identity',

    /** Energy per 100 g outside the category's plausible band. */
    OUT_OF_CATEGORY_RANGE: 'out_of_category_range',
    /** The allergen set is explicitly unknown rather than empty. */
    ALLERGENS_UNKNOWN: 'allergens_unknown',
} as const;

export type CatalogCheckName = (typeof CATALOG_CHECK_NAMES)[keyof typeof CATALOG_CHECK_NAMES];

/**
 * The tier every check carries. A `Record` keyed by the name union, so a new
 * check name without a tier is a compile error rather than an `undefined` tier
 * reaching a validation record.
 */
const CHECK_TIERS: Readonly<Record<CatalogCheckName, CatalogCheckTier>> = {
    nutrient_not_finite: 'reject',
    nutrient_negative: 'reject',
    invalid_basis_amount: 'reject',
    unknown_category: 'reject',
    kcal_ceiling: 'reject',
    macro_mass_ceiling: 'reject',
    energy_macro_mismatch: 'reject',
    portion_conversion_drift: 'reject',
    brand_pattern_name: 'reject',
    empty_component_set: 'reject',
    invalid_component_quantity: 'reject',
    non_finite_computed_value: 'reject',

    missing_gram_weight: 'quarantine',
    missing_density: 'quarantine',
    missing_core_nutrient: 'quarantine',
    unsupported_portion: 'quarantine',
    default_portion_count: 'quarantine',
    unsourced: 'quarantine',
    duplicate_identity: 'quarantine',

    out_of_category_range: 'review',
    allergens_unknown: 'review',
};

export const catalogCheckTier = (name: CatalogCheckName): CatalogCheckTier => CHECK_TIERS[name];

const checkNamesInTier = (tier: CatalogCheckTier): readonly CatalogCheckName[] =>
    (Object.keys(CHECK_TIERS) as CatalogCheckName[]).filter((name) => CHECK_TIERS[name] === tier).sort();

/**
 * The quarantine-tier names, sorted — derived from the tier map rather than
 * listed, so `catalog-validate.ts` can assert this equals the coverage plan's
 * `quarantineChecks` and a drift between the code and the data fails loudly
 * instead of producing records nobody can group. Adding a quarantine-tier
 * check here is therefore also a coverage-plan data change.
 */
export const CATALOG_QUARANTINE_CHECK_NAMES: readonly CatalogCheckName[] = checkNamesInTier('quarantine');

export const CATALOG_REJECT_CHECK_NAMES: readonly CatalogCheckName[] = checkNamesInTier('reject');

export const CATALOG_REVIEW_CHECK_NAMES: readonly CatalogCheckName[] = checkNamesInTier('review');

const buildCheck = (
    name: CatalogCheckName,
    pass: boolean,
    observed: number | string | null,
    bound: number | string | null,
): CatalogValidationCheck => ({ name, pass, observed, bound, tier: CHECK_TIERS[name] });

/* ---------------------------------------------------------------------------
 * Identity — normalisation, the source key, and duplicate merging
 * ------------------------------------------------------------------------- */

// Combining diacritical marks, stripped after an NFKD decomposition so
// "jalapeño" and "jalapeno" normalise alike. Written as a code-point range
// rather than a `\p{Diacritic}` property escape, which needs a newer emit
// target than this package compiles to.
const COMBINING_MARKS_PATTERN = /[\u0300-\u036f]/g;
const NON_ALPHANUMERIC_PATTERN = /[^a-z0-9]+/g;
const WHITESPACE_RUN_PATTERN = /\s+/g;

/**
 * The one canonical-name normalisation, used for `source_key` construction,
 * duplicate detection, and the partial unique index on
 * `(canonical_name, food_state) WHERE publication_status = 'published'`.
 *
 * IDEMPOTENT by construction: the result contains only lowercase ASCII
 * alphanumerics separated by single spaces and is trimmed, so a second pass is
 * the identity function. That property is not cosmetic — a normalisation that
 * changed on the second application would mint a different `source_key` for the
 * same food on the next import run and duplicate it.
 *
 * The restricted output alphabet is also what makes the AI source key's
 * colon-delimited segments unambiguous: a normalised name can never contain a
 * colon, so `ai:<category>:<name>:<state>` always splits into four parts.
 *
 * Returns an empty string for a name with no alphanumeric content at all;
 * callers that mint keys must treat that as invalid input rather than a name.
 */
export const normalizeCanonicalName = (name: string): string =>
    name
        .normalize('NFKD')
        .replace(COMBINING_MARKS_PATTERN, '')
        .toLowerCase()
        .replace(NON_ALPHANUMERIC_PATTERN, ' ')
        .replace(WHITESPACE_RUN_PATTERN, ' ')
        .trim();

export const SOURCE_KEY_USDA_PREFIX = 'usda';
export const SOURCE_KEY_AI_PREFIX = 'ai';
const SOURCE_KEY_SEPARATOR = ':';

// A coverage category code: lowercase, digits and underscores only. The 21
// codes themselves are data (`coverage-plan.v1.json`); only their shape is a
// rule, because the source key is colon-delimited.
const CATEGORY_CODE_PATTERN = /^[a-z0-9_]+$/;

/**
 * The input {@link buildSourceKey} derives a key from. Discriminated on
 * `identitySource` because the two forms share no fields: a USDA record is
 * identified by the FDC id the vendor assigned, and a generated record by the
 * identity it claims.
 */
export type CatalogSourceKeyInput =
    | { identitySource: 'usda'; fdcId: number | string }
    | {
          identitySource: 'ai_generated';
          category: string;
          canonicalName: string;
          foodState: CatalogFoodState;
      };

// Decimal digits with no sign, no exponent, no fraction and no leading zero.
// The shape is half of the canonical rule; `Number.isSafeInteger` below is the
// other half.
const CANONICAL_FDC_ID_PATTERN = /^[1-9][0-9]*$/;

/**
 * The canonical numeric form of a USDA FoodData Central id, or `null` when the
 * value is not one.
 *
 * ONE parser for the whole codebase. `usda.service.ts` imports this function
 * for its cache keys and its record checks, because the two must agree on which
 * record an id names: that module's cache key, this module's `source_key` and
 * the fetch that filled both are three views of a single identity, and a parser
 * that differed between them would fetch one food and file it under another.
 * It lives here rather than in the vendor boundary because the canonical form
 * of an identity is a decision, and because the pure layer is importable from
 * anywhere — `usda.service.ts` reaches Prisma and `process.env`, so the
 * dependency only runs this way round.
 *
 * `Number()` coercion is the thing being avoided, and every rejected form below
 * is one it would have accepted with a different value: `'0x10'` reads as 16,
 * `'1e3'` as 1000, `'0171077'` as 171077 (a second text for one id, so two
 * `source_key` strings and two rows for one food), `'9007199254740993'` as
 * …992 — an id that rounds onto a DIFFERENT legitimate record. A number must
 * already be a positive safe integer; a string must be canonical decimal
 * digits, optionally surrounded by whitespace. Everything else — including a
 * nested array whose `String()` happens to look numeric — is not an id.
 */
export const parseCanonicalFdcId = (value: unknown): number | null => {
    if (typeof value === 'number') {
        return Number.isSafeInteger(value) && value > 0 ? value : null;
    }
    if (typeof value !== 'string' || !CANONICAL_FDC_ID_PATTERN.test(value.trim())) {
        return null;
    }

    const parsed = Number(value.trim());

    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

const requireCanonicalFdcId = (fdcId: number | string): number => {
    const parsed = parseCanonicalFdcId(fdcId);

    if (parsed === null) {
        throw new CatalogIdentityError(
            `A canonical positive FDC id is required to build a source key, received ${String(fdcId)}`,
        );
    }

    return parsed;
};

/**
 * The deterministic UNIQUE upsert key — `usda:<fdcId>` or
 * `ai:<category>:<normalized canonical name>:<food_state>`.
 *
 * This key is the idempotency anchor of the whole pipeline: the USDA import
 * upserts on it, `catalog-load.ts` reconciles a release on it, recipe seed files
 * reference their ingredients by it (never by a database id, so the same files
 * seed identically into any database), and `search-benchmark.v1.json` names its
 * expectations by it. Same inputs must always produce the same string, so the
 * FDC id goes through {@link parseCanonicalFdcId} — `171077` and `'171077'`
 * are one key, and a non-canonical spelling (`'0171077'`, `'1e3'`, `'0x10'`,
 * an unsafe integer) is refused rather than silently coerced into a key for
 * some other record — and the name through {@link normalizeCanonicalName}.
 */
export const buildSourceKey = (input: CatalogSourceKeyInput): string => {
    if (input.identitySource === 'usda') {
        return `${SOURCE_KEY_USDA_PREFIX}${SOURCE_KEY_SEPARATOR}${requireCanonicalFdcId(input.fdcId)}`;
    }

    // The category keeps its code spelling — `produce_vegetable`, not the
    // normalised `produce vegetable` — because the coverage plan, the database
    // column and this key all name the same 21-value list. Only the shape is
    // enforced: a code with a colon or a space in it would make the key's
    // segments ambiguous.
    const category = input.category.trim().toLowerCase();
    const canonicalName = normalizeCanonicalName(input.canonicalName);

    if (!CATEGORY_CODE_PATTERN.test(category)) {
        throw new CatalogIdentityError(
            `A coverage category code matching ${CATEGORY_CODE_PATTERN.source} is required to build a generated source key, received "${input.category}"`,
        );
    }
    if (!canonicalName) {
        throw new CatalogIdentityError(
            `A canonical name with alphanumeric content is required to build a generated source key, received "${input.canonicalName}"`,
        );
    }
    if (!isCatalogFoodState(input.foodState)) {
        throw new CatalogIdentityError(
            `food_state must be one of ${CATALOG_FOOD_STATES.join(', ')}, received ${String(input.foodState)}`,
        );
    }

    return [SOURCE_KEY_AI_PREFIX, category, canonicalName, input.foodState].join(SOURCE_KEY_SEPARATOR);
};


/**
 * What {@link dedupeIdentity} needs of a candidate: the identity columns only,
 * row-shaped and snake_case, so a Prisma row and a parsed release record are
 * both accepted without a mapping step.
 */
export interface CatalogIdentityCandidate {
    source_key: string;
    canonical_name: string;
    food_state: CatalogFoodState;
    identity_source: CatalogIdentitySource;
    display_name?: string;
    aliases?: readonly string[];
}

/** One duplicate folded into a survivor, as the writes the caller must perform. */
export interface CatalogIdentityMerge {
    survivorSourceKey: string;
    duplicateSourceKey: string;
    /**
     * The aliases to add to the survivor: the duplicate's own names and
     * aliases, minus anything the survivor already answers to. Sorted, so two
     * runs over the same data produce the same writes.
     */
    aliases: string[];
}

export interface CatalogDedupePlan {
    /** One candidate per (normalised name, food state), in source-key order. */
    survivors: CatalogIdentityCandidate[];
    merges: CatalogIdentityMerge[];
    /**
     * The source keys that lost, for the validator's `duplicate_identity`
     * check. A duplicate is merged as an alias of its survivor, never published
     * a second time.
     */
    duplicateSourceKeys: string[];
}

const identityGroupKey = (candidate: CatalogIdentityCandidate): string =>
    `${normalizeCanonicalName(candidate.canonical_name)}${SOURCE_KEY_SEPARATOR}${candidate.food_state}`;

// A sourced identity outranks a generated one: USDA's own record is the better
// survivor whatever order the two arrived in.
const IDENTITY_SOURCE_PRECEDENCE: Readonly<Record<CatalogIdentitySource, number>> = {
    usda: 0,
    ai_generated: 1,
};

/**
 * Survivor choice, and the reason it cannot depend on input order: an import
 * that processed a manifest in a different sequence, or a release loaded on a
 * second machine, would otherwise keep a different row and produce a catalog
 * that no longer matches its own benchmark expectations.
 */
const preferredSurvivor = (
    left: CatalogIdentityCandidate,
    right: CatalogIdentityCandidate,
): CatalogIdentityCandidate => {
    const byPrecedence =
        IDENTITY_SOURCE_PRECEDENCE[left.identity_source] - IDENTITY_SOURCE_PRECEDENCE[right.identity_source];

    if (byPrecedence !== 0) {
        return byPrecedence < 0 ? left : right;
    }

    return left.source_key <= right.source_key ? left : right;
};

const aliasesOf = (candidate: CatalogIdentityCandidate): string[] => {
    const names = [candidate.canonical_name, candidate.display_name, ...(candidate.aliases ?? [])];

    return names
        .filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
        .map((name) => name.trim());
};

const dedupeAliases = (aliases: readonly string[], known: ReadonlySet<string>): string[] => {
    const seen = new Set(known);
    const collected: string[] = [];

    for (const alias of aliases) {
        const key = normalizeCanonicalName(alias);
        if (!key || seen.has(key)) {
            continue;
        }
        seen.add(key);
        collected.push(alias);
    }

    return collected.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
};

/**
 * Groups candidates by normalised canonical name PLUS food state, keeps one
 * survivor per group, and returns the merge plan for the rest.
 *
 * Food state is half the key on purpose: raw, cooked, prepared, dry and
 * as-purchased forms of one food are legitimately distinct rows with different
 * energy per 100 g, and collapsing them would both lose data and make the
 * per-food-state energy bands meaningless.
 *
 * The caller performs the writes — this module decides, it does not persist.
 */
export const dedupeIdentity = (candidates: readonly CatalogIdentityCandidate[]): CatalogDedupePlan => {
    const groups = new Map<string, CatalogIdentityCandidate[]>();

    for (const candidate of candidates) {
        const key = identityGroupKey(candidate);
        const group = groups.get(key);

        if (group) {
            group.push(candidate);
        } else {
            groups.set(key, [candidate]);
        }
    }

    const survivors: CatalogIdentityCandidate[] = [];
    const merges: CatalogIdentityMerge[] = [];
    const duplicateSourceKeys: string[] = [];

    for (const group of groups.values()) {
        const survivor = group.reduce(preferredSurvivor);
        survivors.push(survivor);

        const known = new Set(aliasesOf(survivor).map(normalizeCanonicalName));
        const losers = group
            .filter((candidate) => candidate !== survivor)
            .sort((a, b) => (a.source_key < b.source_key ? -1 : a.source_key > b.source_key ? 1 : 0));

        for (const loser of losers) {
            const aliases = dedupeAliases(aliasesOf(loser), known);
            for (const alias of aliases) {
                known.add(normalizeCanonicalName(alias));
            }

            duplicateSourceKeys.push(loser.source_key);
            merges.push({
                survivorSourceKey: survivor.source_key,
                duplicateSourceKey: loser.source_key,
                aliases,
            });
        }
    }

    const bySourceKey = (a: { source_key: string }, b: { source_key: string }): number =>
        a.source_key < b.source_key ? -1 : a.source_key > b.source_key ? 1 : 0;

    return {
        survivors: survivors.sort(bySourceKey),
        merges: merges.sort((a, b) =>
            a.duplicateSourceKey < b.duplicateSourceKey
                ? -1
                : a.duplicateSourceKey > b.duplicateSourceKey
                  ? 1
                  : 0,
        ),
        duplicateSourceKeys: duplicateSourceKeys.sort(),
    };
};

/* ---------------------------------------------------------------------------
 * The search query parser
 * ------------------------------------------------------------------------- */

export const MIN_SEARCH_QUERY_LENGTH = 2;
export const MAX_SEARCH_QUERY_LENGTH = 60;

/** One element of a `400 invalid_request` body's `details` array. */
export interface CatalogFieldError {
    field: string;
    code: string;
}

export type ParsedCatalogSearchQuery =
    | { kind: 'ok'; q: string }
    | {
          kind: 'error';
          code: 'invalid_request';
          message: string;
          details: CatalogFieldError[];
      };

const SEARCH_QUERY_FIELD = 'q';

const invalidSearchQuery = (message: string, code: string): ParsedCatalogSearchQuery => ({
    kind: 'error',
    code: 'invalid_request',
    message,
    details: [{ field: SEARCH_QUERY_FIELD, code }],
});

/**
 * Validates `?q=` for `GET /catalog/foods`: the trimmed query must be 2 to 60
 * characters.
 *
 * The lower bound is the rule worth pinning — a one-character query matches
 * most of a ten-thousand-item catalog, so it is rejected rather than served.
 * The page and limit of the same request belong to `parsePagination`, which
 * caps `limit` at the controller boundary; this module never clamps a limit,
 * because the in-process benchmark fetch deliberately reads past that cap.
 *
 * `unknown` rather than `string`: `req.query` members are user input, and `qs`
 * yields an array when a parameter repeats — the first occurrence wins, exactly
 * as `parsePagination` treats a repeated `page`.
 */
export const parseCatalogSearchQuery = (query: unknown): ParsedCatalogSearchQuery => {
    const raw = Array.isArray(query) ? query[0] : query;

    if (typeof raw !== 'string' || raw.trim().length === 0) {
        return invalidSearchQuery('q is required', 'required');
    }

    const q = raw.trim();

    if (q.length < MIN_SEARCH_QUERY_LENGTH || q.length > MAX_SEARCH_QUERY_LENGTH) {
        return invalidSearchQuery(
            `q must be between ${MIN_SEARCH_QUERY_LENGTH} and ${MAX_SEARCH_QUERY_LENGTH} characters`,
            'invalid_length',
        );
    }

    return { kind: 'ok', q };
};

/* ---------------------------------------------------------------------------
 * Brand-pattern detection — generated candidates are generic preparations
 * ------------------------------------------------------------------------- */

/**
 * Words that only appear in a manufactured product's name. Vocabulary rather
 * than a threshold, so it lives in this module (as `record.logic.ts` keeps its
 * `LOWER_IS_BETTER` set) and can be replaced through
 * {@link CatalogValidationPolicy.brandWords} without a code change.
 */
export const DEFAULT_BRAND_WORDS: readonly string[] = [
    'brand',
    'coca',
    'pepsi',
    'nestle',
    'kellogg',
    'kelloggs',
    'kraft',
    'heinz',
    'danone',
    'dannon',
    'chobani',
    'oreo',
    'doritos',
    'cheerios',
    'gatorade',
    'starbucks',
    'mcdonalds',
    'subway',
    'chipotle',
    'quaker',
    'tyson',
    'perdue',
    'hellmanns',
    'kirkland',
    'trader',
    'costco',
    'walmart',
    'sainsburys',
    'tesco',
];

/**
 * The nouns a brand name is normally attached to ("Acme Crunch Bars"). Matched
 * only after a capitalised proper noun, so "granola bars" — a generic
 * preparation — is not a brand.
 */
export const DEFAULT_PRODUCT_FORM_WORDS: readonly string[] = [
    'bar',
    'bars',
    'bites',
    'blend',
    'bowl',
    'brand',
    'cereal',
    'chips',
    'classic',
    'crisps',
    'crunch',
    'cup',
    'cups',
    'drink',
    'edition',
    'flavor',
    'flavour',
    'formula',
    'juice',
    'meal',
    'mix',
    'nuggets',
    'original',
    'pack',
    'pods',
    'recipe',
    'roll',
    'rolls',
    'sandwich',
    'shake',
    'snack',
    'soda',
    'spread',
    'sticks',
    'wrap',
];

// ® and ™ (and their ASCII spellings) are a trademark claim on their face.
const TRADEMARK_PATTERN = /[®™]|\((?:r|tm)\)/i;
// The words of a name, in order, with their original casing kept — the casing
// is half the signal, so the normalised form alone cannot decide this check.
const NAME_WORD_PATTERN = /[A-Za-z0-9]+/g;
// A capitalised word: one capital followed by at least two lowercase letters,
// which is the shape of a name ("Acme", "Kettle", "Chicken") rather than of a
// unit or an abbreviation ("Oz", "II", "A").
const PROPER_NOUN_WORD_PATTERN = /^[A-Z][a-z]{2,}$/;
const CAPITALISED_WORD_PATTERN = /^[A-Z]/;

export interface BrandPatternMatch {
    /** The value the pattern fired on — the name or one of the aliases. */
    value: string;
    /** `trademark_symbol`, `brand_word` or `proper_noun_product_form`. */
    reason: 'trademark_symbol' | 'brand_word' | 'proper_noun_product_form';
    /** The token that matched, for the validation record's `observed`. */
    token: string;
}

export interface BrandPatternOptions {
    readonly brandWords?: readonly string[];
    readonly productFormWords?: readonly string[];
}

const wordsOf = (value: string): string[] => normalizeCanonicalName(value).split(' ').filter(Boolean);

/** One word of a name: its original text, its normalised form, and its position. */
interface NameWord {
    readonly text: string;
    readonly normalized: string;
    readonly position: number;
}

/**
 * The words of a name with their casing and order intact.
 *
 * `wordsOf` cannot serve here: it normalises to lowercase, and the whole
 * discrimination below turns on which words a name capitalises. Each word is
 * normalised individually so a vocabulary lookup still matches accents and
 * punctuation the way every other rule in this module does.
 */
const nameWordsOf = (value: string): NameWord[] => {
    const words: NameWord[] = [];
    const pattern = new RegExp(NAME_WORD_PATTERN.source, NAME_WORD_PATTERN.flags);
    let match = pattern.exec(value);

    while (match !== null) {
        words.push({
            text: match[0],
            normalized: normalizeCanonicalName(match[0]),
            position: words.length,
        });
        match = pattern.exec(value);
    }

    return words;
};

/**
 * Finds the first brand signal in a name or alias, or `null`.
 *
 * AI generation proposes GENERIC preparations only — its prompt schema has no
 * brand field — because a model-proposed manufacturer domain cannot
 * independently verify a model-proposed product. Branded coverage comes
 * exclusively from USDA Branded records and the live branded search, so a
 * generated candidate that names a product is rejected at parse time rather
 * than published with evidence nobody can check.
 *
 * THE PROPER-NOUN RULE, because it is the one that has to discriminate rather
 * than merely match. A product name and a generic preparation both pair a
 * capitalised word with a product form; what separates them is which OTHER
 * words the name capitalises:
 *
 *  * a proper noun that is not the first word is a brand wherever a product
 *    form follows it — "granola Kettle crunch" names a product, and no generic
 *    preparation capitalises a word mid-name;
 *  * a proper noun that IS the first word only signals a brand when the product
 *    form that follows is itself capitalised — "Acme Bar" and "Nova Drink" are
 *    written as products, while "Protein bar", "Orange juice" and "Chicken
 *    broth" are ordinary sentence-case food names whose first capital carries no
 *    information at all.
 *
 * So the test is "capitalisation beyond sentence case, plus a product form",
 * which is exactly the casing a manufactured product is written in and exactly
 * the casing this pipeline's generic names are not: the generator states a
 * sentence-case display name and a lowercase canonical name. A title-cased
 * generic ("Rice Cereal") is therefore treated as a product name and rejected —
 * deliberately, with the matched token recorded, because in this corpus the
 * casing is the anomaly worth a human's attention.
 *
 * What this cannot catch, stated so nobody reads more into it: a fabricated
 * brand written in sentence case ("Acme bar") is indistinguishable from a
 * generic preparation without a food vocabulary this module does not have. The
 * curated brand-word list and the `unsourced` quarantine — no allowlisted
 * evidence names the product — are what stand behind it.
 */
export const findBrandPatternMatch = (
    values: readonly string[],
    options: BrandPatternOptions = {},
): BrandPatternMatch | null => {
    const brandWords = new Set((options.brandWords ?? DEFAULT_BRAND_WORDS).map((word) => word.toLowerCase()));
    const productForms = new Set(
        (options.productFormWords ?? DEFAULT_PRODUCT_FORM_WORDS).map((word) => word.toLowerCase()),
    );

    for (const value of values) {
        if (typeof value !== 'string' || value.trim().length === 0) {
            continue;
        }

        const trademark = TRADEMARK_PATTERN.exec(value);
        if (trademark) {
            return { value, reason: 'trademark_symbol', token: trademark[0] };
        }

        const words = wordsOf(value);
        const brandWord = words.find((word) => brandWords.has(word));
        if (brandWord) {
            return { value, reason: 'brand_word', token: brandWord };
        }

        const nameWords = nameWordsOf(value);

        for (const properNoun of nameWords) {
            if (!PROPER_NOUN_WORD_PATTERN.test(properNoun.text)) {
                continue;
            }

            // The leading word of any sentence-case name is capitalised, so at
            // position 0 the capital is only evidence when a product form after
            // it is capitalised too; anywhere else the mid-name capital is the
            // evidence and the form's own casing is immaterial.
            const form = nameWords
                .slice(properNoun.position + 1)
                .find(
                    (word) =>
                        productForms.has(word.normalized) &&
                        (properNoun.position > 0 || CAPITALISED_WORD_PATTERN.test(word.text)),
                );

            if (form) {
                return {
                    value,
                    reason: 'proper_noun_product_form',
                    token: `${properNoun.text} ${form.normalized}`,
                };
            }
        }
    }

    return null;
};


/* ---------------------------------------------------------------------------
 * Nutrition — the per-100 g basis and ingredient-derived composition
 * ------------------------------------------------------------------------- */

/** The per-100 g basis every publishable catalog food is stored on. */
export const PER_100G_BASIS_AMOUNT = 100;

/**
 * A complete nutrient set, every member present and `null` where the value is
 * UNKNOWN. Null is never 0: a zero claims the food contains none of the
 * nutrient, which for fibre in particular is a claim the source did not make.
 */
export interface CatalogNutrientValues {
    calories: number | null;
    protein_g: number | null;
    carbs_g: number | null;
    fat_g: number | null;
    fiber_g: number | null;
}

/** The same set as input, where an omitted `fiber_g` means unknown. */
export interface CatalogNutrientInput {
    calories: number | null;
    protein_g: number | null;
    carbs_g: number | null;
    fat_g: number | null;
    fiber_g?: number | null;
}

/**
 * The four nutrients a published food must state. Anything else may stay
 * unknown — the coverage plan's `requiredNutrients`, as a rule rather than a
 * comment.
 */
export const CORE_NUTRIENT_FIELDS: readonly (keyof CatalogNutrientValues)[] = [
    'calories',
    'protein_g',
    'carbs_g',
    'fat_g',
];

const NUTRIENT_FIELDS: readonly (keyof CatalogNutrientValues)[] = [
    ...CORE_NUTRIENT_FIELDS,
    'fiber_g',
];

const readNutrient = (values: CatalogNutrientInput, field: keyof CatalogNutrientValues): number | null => {
    const value = values[field];

    return value === undefined ? null : value;
};

/**
 * A real number strictly greater than zero — the shape every mass, weight,
 * density, amount and factor in this module must have before it is multiplied
 * by anything, and the shape every computed one must still have afterwards.
 */
const isPositiveFinite = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0;

/** Row-shaped nutrition as `catalog_foods` stores it, plus what a conversion needs. */
export interface CatalogNutritionSource {
    nutrition_basis: CatalogNutritionBasis;
    /**
     * How much of the food the stated values describe, IN THE BASIS'S OWN UNIT:
     * grams for `per_100g`, millilitres for `per_100ml`, and SERVINGS for
     * `per_serving` — so `2` on a per-serving record whose serving weighs 40 g
     * means the values describe 80 g of food, and treating it as one serving
     * would double every per-100 g nutrient.
     *
     * Usually 100, 100 and 1 respectively, but never assumed: a label that
     * states two servings' worth is a real record, and the multiplication is
     * what keeps it truthful.
     */
    basis_amount: number;
    calories: number | null;
    protein_g: number | null;
    carbs_g: number | null;
    fat_g: number | null;
    fiber_g?: number | null;
    density_g_per_ml?: number | null;
    /**
     * The gram weight of the serving a `per_serving` basis refers to — the
     * default portion's `gram_weight`. Absent or non-positive is the one thing
     * that cannot be worked around: inventing a weight is exactly the
     * fabricated nutrition the catalog policy forbids.
     */
    serving_gram_weight?: number | null;
}

export interface NormalizedPer100gNutrition {
    nutrition_basis: 'per_100g';
    basis_amount: number;
    nutrition: CatalogNutrientValues;
    /** What the source's stated basis weighed, in grams. */
    basisGrams: number;
    /** The multiplier applied to every stated value: `100 / basisGrams`. */
    factor: number;
}

export type NormalizeToPer100gResult =
    | { kind: 'ok'; normalized: NormalizedPer100gNutrition }
    | { kind: 'error'; check: CatalogValidationCheck };

const scaleNutrients = (values: CatalogNutrientInput, factor: number): CatalogNutrientValues => {
    const scaled: CatalogNutrientValues = {
        calories: null,
        protein_g: null,
        carbs_g: null,
        fat_g: null,
        fiber_g: null,
    };

    for (const field of NUTRIENT_FIELDS) {
        const value = readNutrient(values, field);
        scaled[field] = value === null ? null : value * factor;
    }

    return scaled;
};

/**
 * The fields of a computed nutrient set whose value is not a real number.
 *
 * A stated nutrient and a rescale factor can both be finite while their product
 * is not, and the result of that multiplication must never reach a stored row:
 * `Infinity` would be written to a `DOUBLE PRECISION` column as a value no
 * comparison behaves sensibly against, and recorded in an observation JSONB
 * turns into `null`, which reads as "unknown" — the one thing it is not.
 */
const nonFiniteNutrientFields = (values: CatalogNutrientValues): string[] =>
    NUTRIENT_FIELDS.filter((field) => values[field] !== null && !Number.isFinite(values[field])).map(
        (field) => `${field}=${String(values[field])}`,
    );

/**
 * A computed value as a validation record may carry it.
 *
 * JSONB has no `Infinity` and no `NaN` — `JSON.stringify` writes `null` for
 * both — so a non-finite observation is recorded as its TEXT form. The check
 * that produced it has already failed; this is only about the audit trail
 * saying what was actually observed rather than claiming nothing was.
 */
const observedNumber = (value: number): number | string =>
    Number.isFinite(value) ? value : String(value);

const nonFiniteComputedValueCheck = (observed: string, bound: string): CatalogValidationCheck =>
    buildCheck(CATALOG_CHECK_NAMES.NON_FINITE_COMPUTED_VALUE, false, observed, bound);

/**
 * Brings a source record onto the per-100 g basis, or reports the one check
 * that stops it.
 *
 * A `per_100ml` basis converts through the food's own stored density, and a
 * missing or non-positive density is a FAILURE rather than an assumption that
 * millilitres equal grams — the conversion is delegated to
 * `millilitersToGrams`, whose `UnitConversionError` is exactly this case and is
 * translated here into the `missing_density` check so the candidate is
 * quarantined instead of the run throwing.
 *
 * A `per_serving` basis needs the serving's sourced gram weight; without one
 * the record is quarantined `missing_gram_weight` and never counts toward the
 * published catalog.
 *
 * Values are NOT rounded: the rounding contract rounds once, at the diary
 * snapshot and at display, and an early round here would make a recipe's
 * derived total disagree with the card that shows it.
 */
export const normalizeToPer100g = (source: CatalogNutritionSource): NormalizeToPer100gResult => {
    if (!Number.isFinite(source.basis_amount) || source.basis_amount <= 0) {
        return {
            kind: 'error',
            check: buildCheck(
                CATALOG_CHECK_NAMES.INVALID_BASIS_AMOUNT,
                false,
                source.basis_amount,
                'a finite basis_amount greater than 0',
            ),
        };
    }

    let basisGrams: number;

    switch (source.nutrition_basis) {
        case 'per_100g':
            basisGrams = source.basis_amount;
            break;

        case 'per_100ml':
            try {
                basisGrams = millilitersToGrams(source.basis_amount, source.density_g_per_ml);
            } catch (error) {
                if (error instanceof UnitConversionError) {
                    // `millilitersToGrams` raises one error type for two
                    // different faults — a density it cannot use, and a
                    // conversion that overflowed — so the density it was handed
                    // is what classifies them. Labelling an overflow
                    // `missing_density` would send an operator looking for a
                    // density that is present and correct.
                    if (!isPositiveFinite(source.density_g_per_ml)) {
                        return {
                            kind: 'error',
                            check: buildCheck(
                                CATALOG_CHECK_NAMES.MISSING_DENSITY,
                                false,
                                source.density_g_per_ml ?? null,
                                'a positive density_g_per_ml',
                            ),
                        };
                    }

                    return {
                        kind: 'error',
                        check: nonFiniteComputedValueCheck(
                            `basis mass from ${String(source.basis_amount)} ml at ${String(
                                source.density_g_per_ml,
                            )} g/ml: ${(error as UnitConversionError).message}`,
                            'a finite basis mass in grams',
                        ),
                    };
                }
                throw error;
            }
            break;

        case 'per_serving': {
            const servingGrams = source.serving_gram_weight;

            if (servingGrams == null || !Number.isFinite(servingGrams) || servingGrams <= 0) {
                return {
                    kind: 'error',
                    check: buildCheck(
                        CATALOG_CHECK_NAMES.MISSING_GRAM_WEIGHT,
                        false,
                        servingGrams ?? null,
                        'a sourced serving gram weight greater than 0',
                    ),
                };
            }

            // `basis_amount` counts SERVINGS on this basis, so the stated values
            // describe `basis_amount × servingGrams` of food. Using one
            // serving's weight regardless would read a two-serving label as a
            // one-serving one and double every per-100 g nutrient.
            basisGrams = source.basis_amount * servingGrams;
            break;
        }

        default: {
            // Unreachable while the basis is one of the three declared values.
            // A record parsed from JSON is screened by isCatalogNutritionBasis
            // before it reaches here, so arriving with anything else is a
            // programming error rather than bad data.
            const unreachable: never = source.nutrition_basis;
            throw new CatalogIdentityError(`Unsupported nutrition basis ${String(unreachable)}`);
        }
    }

    // Every branch above multiplied or divided finite inputs, and finite inputs
    // can still overflow: 1e308 ml at 10 g/ml, or 1e308 servings of 40 g. A
    // basis mass that is not a positive real number makes the factor and every
    // value scaled by it meaningless, so it stops here rather than propagating
    // as an `Infinity` nutrient or — worse — as a division that lands on 0.
    if (!isPositiveFinite(basisGrams)) {
        return {
            kind: 'error',
            check: nonFiniteComputedValueCheck(
                `basisGrams=${String(basisGrams)} from a ${source.nutrition_basis} basis of ${String(
                    source.basis_amount,
                )}`,
                'a finite basis mass in grams greater than 0',
            ),
        };
    }

    const factor = PER_100G_BASIS_AMOUNT / basisGrams;

    // A denormal basis mass (5e-324 g) divides into an infinite factor, which
    // would scale every stated nutrient to Infinity.
    if (!isPositiveFinite(factor)) {
        return {
            kind: 'error',
            check: nonFiniteComputedValueCheck(
                `factor=${String(factor)} from basisGrams=${String(basisGrams)}`,
                `a finite ${PER_100G_BASIS_AMOUNT}/basisGrams factor greater than 0`,
            ),
        };
    }

    const nutrition = scaleNutrients(source, factor);
    const nonFinite = nonFiniteNutrientFields(nutrition);

    if (nonFinite.length > 0) {
        return {
            kind: 'error',
            check: nonFiniteComputedValueCheck(
                `${nonFinite.join(', ')} at factor ${String(factor)}`,
                'finite per-100g values',
            ),
        };
    }

    return {
        kind: 'ok',
        normalized: {
            nutrition_basis: 'per_100g',
            basis_amount: PER_100G_BASIS_AMOUNT,
            nutrition,
            basisGrams,
            factor,
        },
    };
};

/** One `catalog_food_components` row, plus the component's own per-100 g values. */
export interface CatalogComponentNutritionInput {
    component_catalog_food_id?: string;
    /** Grams of the component that go IN, before any cooking mass change. */
    quantity_grams: number;
    /** The component's cooked/raw mass change: finished grams per input gram. */
    yield_factor: number;
    component_nutrition_version: number;
    sort_order?: number;
    /** The component's stored per-100 g nutrition. */
    nutrition: CatalogNutrientInput;
}

export interface DerivedCatalogNutrition {
    nutrition_basis: 'per_100g';
    /**
     * Always `ingredient_derived`, and that is a policy statement rather than a
     * default: the components may every one of them be source-backed, but the
     * QUANTITIES are assumed, so the result is an estimate. It is labelled
     * "Estimated from ingredients" and is never recipe-eligible.
     */
    nutrition_provenance: CatalogNutritionProvenance;
    nutrition: CatalogNutrientValues;
    /** Σ `quantity_grams` — what went in. */
    inputGrams: number;
    /** Σ `quantity_grams × yield_factor` — what the finished food weighs. */
    yieldedGrams: number;
    /**
     * The `component_nutrition_version` of each component, in the order they
     * were summed. A refresh compares these with the components' current
     * versions to detect staleness, which is only meaningful because the
     * derivation is deterministic.
     */
    componentNutritionVersions: number[];
}

export type DeriveComponentNutritionResult =
    | { kind: 'ok'; derived: DerivedCatalogNutrition }
    | { kind: 'error'; check: CatalogValidationCheck };

/**
 * Recomputes an ingredient-derived food's per-100 g nutrition from its
 * components.
 *
 * The model, stated once because it is the part that can be got wrong: a
 * component contributes `quantity_grams / 100 × its per-100 g value` of each
 * nutrient, and cooking changes MASS, not nutrients — losing water does not
 * lose protein. So the nutrient totals are the plain sum of the inputs, while
 * the finished weight is `Σ quantity_grams × yield_factor`, and the per-100 g
 * result is `total / yieldedGrams × 100`. A food that loses half its water is
 * therefore twice as energy-dense per 100 g, which is the whole point of
 * storing `yield_factor`.
 *
 * Components are summed in `sort_order` then component-id order rather than
 * array order, because floating-point addition is not associative: the same
 * rows arriving in a different sequence would otherwise produce a result that
 * differs in the last bits and read as a staleness change on the next refresh.
 *
 * Any component whose value for a nutrient is unknown makes the derived value
 * unknown — a sum missing a term is not a smaller sum.
 */
export const deriveComponentNutrition = (
    components: readonly CatalogComponentNutritionInput[],
): DeriveComponentNutritionResult => {
    if (components.length === 0) {
        return {
            kind: 'error',
            check: buildCheck(
                CATALOG_CHECK_NAMES.EMPTY_COMPONENT_SET,
                false,
                0,
                'at least one component',
            ),
        };
    }

    const invalid = components.find(
        (component) => !isPositiveFinite(component.quantity_grams) || !isPositiveFinite(component.yield_factor),
    );

    if (invalid) {
        return {
            kind: 'error',
            check: buildCheck(
                CATALOG_CHECK_NAMES.INVALID_COMPONENT_QUANTITY,
                false,
                `quantity_grams=${String(invalid.quantity_grams)} yield_factor=${String(invalid.yield_factor)}`,
                'positive, finite quantity_grams and yield_factor',
            ),
        };
    }

    const ordered = components
        .map((component, index) => ({ component, index }))
        .sort((left, right) => {
            const bySortOrder = (left.component.sort_order ?? 0) - (right.component.sort_order ?? 0);
            if (bySortOrder !== 0) {
                return bySortOrder;
            }

            const leftId = left.component.component_catalog_food_id ?? '';
            const rightId = right.component.component_catalog_food_id ?? '';
            if (leftId !== rightId) {
                return leftId < rightId ? -1 : 1;
            }

            return left.index - right.index;
        })
        .map((entry) => entry.component);

    let inputGrams = 0;
    let yieldedGrams = 0;

    for (const component of ordered) {
        inputGrams += component.quantity_grams;
        yieldedGrams += component.quantity_grams * component.yield_factor;
    }

    // Each quantity and yield factor was checked above; their products and sums
    // were not, and a set of finite masses can still add up past the range of a
    // double. An infinite yielded mass is the dangerous one: it would divide
    // every nutrient total to exactly 0 and publish a food whose stored
    // nutrition says "contains nothing" — a false claim rather than an error.
    if (!isPositiveFinite(inputGrams) || !isPositiveFinite(yieldedGrams)) {
        return {
            kind: 'error',
            check: nonFiniteComputedValueCheck(
                `inputGrams=${String(inputGrams)} yieldedGrams=${String(yieldedGrams)}`,
                'finite aggregate component masses greater than 0',
            ),
        };
    }

    const nutrition: CatalogNutrientValues = {
        calories: null,
        protein_g: null,
        carbs_g: null,
        fat_g: null,
        fiber_g: null,
    };

    for (const field of NUTRIENT_FIELDS) {
        let total = 0;
        let known = true;

        for (const component of ordered) {
            const value = readNutrient(component.nutrition, field);

            if (value === null) {
                known = false;
                break;
            }

            total += (component.quantity_grams / PER_100G_BASIS_AMOUNT) * value;
        }

        if (!known) {
            nutrition[field] = null;
            continue;
        }

        const perHundredGrams = (total / yieldedGrams) * PER_100G_BASIS_AMOUNT;

        // A known-but-not-finite total is neither a value nor an unknown, and
        // recording it as either would be a false statement: `null` here would
        // claim the source never said, when in fact it said something the
        // arithmetic could not hold. The whole derivation fails instead.
        if (!Number.isFinite(total) || !Number.isFinite(perHundredGrams)) {
            return {
                kind: 'error',
                check: nonFiniteComputedValueCheck(
                    `${field}: total=${String(total)} per100g=${String(perHundredGrams)} over yieldedGrams=${String(
                        yieldedGrams,
                    )}`,
                    'a finite derived per-100g value',
                ),
            };
        }

        nutrition[field] = perHundredGrams;
    }

    return {
        kind: 'ok',
        derived: {
            nutrition_basis: 'per_100g',
            nutrition_provenance: 'ingredient_derived',
            nutrition,
            inputGrams,
            yieldedGrams,
            componentNutritionVersions: ordered.map((component) => component.component_nutrition_version),
        },
    };
};

/* ---------------------------------------------------------------------------
 * The grocery aisle mapping
 * ------------------------------------------------------------------------- */

/** The five aisle codes a weekly grocery list is grouped by, in display order. */
export type GroceryCategory = 'produce' | 'protein' | 'dairy_alternatives' | 'grains_bread' | 'pantry_other';

const groceryCategories = closedSet<GroceryCategory>({
    produce: true,
    protein: true,
    dairy_alternatives: true,
    grains_bread: true,
    pantry_other: true,
});

/** Display order, with `pantry_other` last — it is where the list closes. */
export const GROCERY_CATEGORY_ORDER: readonly GroceryCategory[] = [
    'produce',
    'protein',
    'dairy_alternatives',
    'grains_bread',
    'pantry_other',
];

export const isGroceryCategory: (value: unknown) => value is GroceryCategory = groceryCategories.includes;

/**
 * Sort position of an aisle, so `pantry_other` closing the list is a rule a
 * test can pin rather than the order someone happened to write a literal in.
 */
export const groceryCategorySortIndex = (category: GroceryCategory): number =>
    GROCERY_CATEGORY_ORDER.indexOf(category);

const GROCERY_CATEGORY_PREFIXES: readonly { readonly prefix: string; readonly category: GroceryCategory }[] = [
    { prefix: 'produce', category: 'produce' },
    { prefix: 'protein', category: 'protein' },
    { prefix: 'dairy', category: 'dairy_alternatives' },
    { prefix: 'grain', category: 'grains_bread' },
    { prefix: 'bread', category: 'grains_bread' },
];

/**
 * Collapses the 21 catalog categories onto the five aisles: `produce_*` →
 * Produce, `protein_*` → Protein, `dairy`/`dairy_alternative` → Dairy &
 * alternatives, `grain`/`bread_bakery` → Grains & bread, and everything else →
 * Pantry & other.
 *
 * TOTAL by construction: an unrecognised category — including one a future
 * coverage plan adds — resolves to `pantry_other` and never to `undefined`,
 * because an undefined aisle silently drops the row from the shopping list.
 * Matching is by prefix rather than by an exhaustive table so a new sibling
 * (`produce_herb`, say) files itself beside its family instead of falling to
 * the pantry.
 */
export const mapCategoryToGroceryCategory = (category: string): GroceryCategory => {
    const code = categoryKey(category);
    const match = GROCERY_CATEGORY_PREFIXES.find(
        (entry) => code === entry.prefix || code.startsWith(`${entry.prefix}_`),
    );

    return match ? match.category : 'pantry_other';
};


/* ---------------------------------------------------------------------------
 * The three-tier validation checker
 * ------------------------------------------------------------------------- */

/** One `catalog_food_portions` row as a candidate carries it. */
export interface CatalogFoodPortionCandidate {
    description: string;
    amount: number;
    unit: string;
    /** `null` when the source stated no weight for this portion — never invented. */
    gram_weight: number | null;
    is_default: boolean;
    source?: string;
}

/**
 * Everything {@link validateCatalogCandidate} judges: the identity columns, the
 * stated nutrition on its own basis, the portions, and — where the source gives
 * both — the values printed for one serving.
 *
 * Row-shaped and snake_case, so a Prisma row, a parsed USDA record and a
 * release record are all accepted directly. Turning any of this into a wire DTO
 * is `catalog.mapper.ts`'s job, not this module's.
 */
export interface CatalogFoodCandidate extends CatalogNutritionSource {
    source_key?: string;
    canonical_name: string;
    display_name?: string;
    aliases?: readonly string[];
    category: string;
    food_state: CatalogFoodState;
    identity_source: CatalogIdentitySource;
    identity_status: CatalogIdentityStatus;
    nutrition_provenance: CatalogNutritionProvenance;
    allergen_status: CatalogAllergenStatus;
    allergen_tags?: readonly string[];
    portions?: readonly CatalogFoodPortionCandidate[];
    /**
     * The nutrition stated for ONE serving, when the source states both a
     * per-100 g set and a label set. Present is what makes the
     * `portion_conversion_drift` check evaluable; absent means there is nothing
     * to cross-check and the check is omitted rather than passed.
     */
    per_serving_nutrition?: CatalogNutrientInput | null;
}

/**
 * The advisory second-model review, as this module consumes it.
 *
 * ADVISORY, without exception. It is consulted only in the review branch of
 * {@link resolveCatalogDisposition}, which is a structural guarantee rather
 * than a promise: a reject-tier or quarantine-tier failure returns before the
 * review branch is reached, so no advisory input can overturn one. It also
 * never supplies a value — nothing here is a nutrient — because an AI
 * plausibility review must never be presented as verified nutrition.
 */
export interface CatalogAdvisoryReview {
    /** Review-tier check names a second model examined and found plausible. */
    readonly confirmedCheckNames?: readonly string[];
}

export interface CatalogValidationContext {
    /**
     * The survivor this candidate merges into, from {@link dedupeIdentity}.
     * `undefined` means duplicate detection has not run, and the
     * `duplicate_identity` check is omitted; explicit `null` means it ran and
     * found none, which is a genuine pass.
     */
    readonly duplicateOfSourceKey?: string | null;
    readonly advisoryReview?: CatalogAdvisoryReview | null;
    /** Review-tier check names a curator has allowlisted for this candidate. */
    readonly curatorAllowlistedCheckNames?: readonly string[];
}

/**
 * The three statuses validation can produce, derived from
 * `CatalogPublicationStatus` rather than restated: `candidate` is what a row
 * arrives as and `retired` belongs to `catalog-load.ts`, so neither is a
 * validation outcome — and this module introduces no status of its own.
 */
export type CatalogValidationPublicationStatus = Extract<
    CatalogPublicationStatus,
    'published' | 'quarantined' | 'rejected'
>;

export interface CatalogDisposition {
    publicationStatus: CatalogValidationPublicationStatus;
    outcome: CatalogValidationOutcome;
    /**
     * Every failed review-tier check, recorded whether or not it held the
     * candidate: a USDA record publishes WITH its flag, and the flag is the
     * informational part of that.
     */
    reviewFlags: string[];
    /** The failed checks that decided this disposition; empty for a clean pass. */
    decidingCheckNames: string[];
    /** True only for a published row — the one thing a coverage count may add up. */
    countsTowardPublishedTarget: boolean;
}

export interface CatalogDispositionInput {
    readonly identitySource: CatalogIdentitySource;
    readonly advisoryReview?: CatalogAdvisoryReview | null;
    readonly curatorAllowlistedCheckNames?: readonly string[];
}

export interface CatalogValidationVerdict extends CatalogDisposition {
    /**
     * Every check that was EVALUATED, passing and failing alike. A check whose
     * inputs were unavailable is absent rather than recorded as a pass.
     */
    checks: CatalogValidationCheck[];
    /** The per-100 g values the checks judged, or `null` if the conversion failed. */
    normalizedNutrition: CatalogNutrientValues | null;
}

const OUTCOME_BY_STATUS: Readonly<Record<CatalogValidationPublicationStatus, CatalogValidationOutcome>> = {
    published: 'accepted',
    quarantined: 'quarantined',
    rejected: 'rejected',
};

const disposition = (
    publicationStatus: CatalogValidationPublicationStatus,
    decidingCheckNames: string[],
    reviewFlags: string[],
): CatalogDisposition => ({
    publicationStatus,
    outcome: OUTCOME_BY_STATUS[publicationStatus],
    reviewFlags,
    decidingCheckNames,
    countsTowardPublishedTarget: publicationStatus === 'published',
});

const failedNamesInTier = (checks: readonly CatalogValidationCheck[], tier: CatalogCheckTier): string[] =>
    checks.filter((check) => !check.pass && check.tier === tier).map((check) => check.name);

/**
 * Turns a set of checks into a publication status.
 *
 * Reject beats quarantine beats review, and the review tier is the only one
 * whose consequence depends on where the record came from:
 *
 *  * a USDA-sourced record PUBLISHES with its review flags recorded — the
 *    source is authoritative and the flag is informational;
 *  * a generated record is HELD in quarantine against the flag (typically
 *    `out_of_category_range`) until the advisory review confirms it or a
 *    curator allowlists the value.
 *
 * Exported separately from {@link validateCatalogCandidate} so the rule can be
 * tested against hand-built check lists, independently of how the checks are
 * produced.
 */
export const resolveCatalogDisposition = (
    checks: readonly CatalogValidationCheck[],
    input: CatalogDispositionInput,
): CatalogDisposition => {
    const reviewFlags = failedNamesInTier(checks, 'review');

    const rejected = failedNamesInTier(checks, 'reject');
    if (rejected.length > 0) {
        return disposition('rejected', rejected, reviewFlags);
    }

    const quarantined = failedNamesInTier(checks, 'quarantine');
    if (quarantined.length > 0) {
        return disposition('quarantined', quarantined, reviewFlags);
    }

    if (reviewFlags.length === 0 || input.identitySource === 'usda') {
        return disposition('published', [], reviewFlags);
    }

    const lifted = new Set([
        ...(input.advisoryReview?.confirmedCheckNames ?? []),
        ...(input.curatorAllowlistedCheckNames ?? []),
    ]);
    const held = reviewFlags.filter((name) => !lifted.has(name));

    return held.length > 0
        ? disposition('quarantined', held, reviewFlags)
        : disposition('published', [], reviewFlags);
};

const PERCENT = 100;

/**
 * The Atwater factors the energy-vs-macro check compares against. Named
 * because "4, 4, 9" written inline is exactly the kind of constant that gets
 * transposed, and the mismatch it would cause looks like bad source data.
 */
const ENERGY_PER_GRAM = { protein: 4, carbs: 4, fat: 9 } as const;

const isFiniteNumber = (value: number | null): value is number => value !== null && Number.isFinite(value);

const brandPatternCheck = (candidate: CatalogFoodCandidate, policy: CatalogValidationPolicy): CatalogValidationCheck => {
    const values = [candidate.canonical_name, candidate.display_name, ...(candidate.aliases ?? [])].filter(
        (value): value is string => typeof value === 'string',
    );
    const match = findBrandPatternMatch(values, {
        brandWords: policy.brandWords,
        productFormWords: policy.productFormWords,
    });

    return buildCheck(
        CATALOG_CHECK_NAMES.BRAND_PATTERN_NAME,
        match === null,
        match === null ? null : `${match.reason}: ${match.token} in "${match.value}"`,
        'generic preparation names only',
    );
};

const nutrientSignChecks = (candidate: CatalogFoodCandidate): CatalogValidationCheck[] => {
    const notFinite: string[] = [];
    const negative: string[] = [];

    for (const field of NUTRIENT_FIELDS) {
        const value = readNutrient(candidate, field);

        if (value === null) {
            continue;
        }
        if (!Number.isFinite(value)) {
            notFinite.push(`${field}=${String(value)}`);
            continue;
        }
        if (value < 0) {
            negative.push(`${field}=${String(value)}`);
        }
    }

    return [
        buildCheck(
            CATALOG_CHECK_NAMES.NUTRIENT_NOT_FINITE,
            notFinite.length === 0,
            notFinite.length === 0 ? null : notFinite.join(', '),
            'finite numbers, or null for unknown',
        ),
        buildCheck(
            CATALOG_CHECK_NAMES.NUTRIENT_NEGATIVE,
            negative.length === 0,
            negative.length === 0 ? null : negative.join(', '),
            'greater than or equal to 0',
        ),
    ];
};

const energyChecks = (
    nutrition: CatalogNutrientValues,
    bounds: ResolvedCategoryBounds | null,
    globalBounds: CatalogGlobalValidationBounds,
): CatalogValidationCheck[] => {
    const checks: CatalogValidationCheck[] = [];
    const { calories, protein_g: protein, carbs_g: carbs, fat_g: fat } = nutrition;

    if (isFiniteNumber(calories)) {
        checks.push(
            buildCheck(
                CATALOG_CHECK_NAMES.KCAL_CEILING,
                calories <= globalBounds.maxKcalPer100g,
                calories,
                globalBounds.maxKcalPer100g,
            ),
        );
    }

    if (isFiniteNumber(protein) && isFiniteNumber(carbs) && isFiniteNumber(fat)) {
        // You cannot have more grams of macronutrient than the food weighs; the
        // tolerance factor absorbs the rounding a source publishes with. Fibre
        // is excluded because USDA counts it inside carbohydrate, so adding it
        // would double-count the same grams.
        const macroMass = protein + carbs + fat;
        const allowedMass = PER_100G_BASIS_AMOUNT * globalBounds.macroMassToleranceFactor;

        checks.push(
            buildCheck(
                CATALOG_CHECK_NAMES.MACRO_MASS_CEILING,
                // A sum of three finite values can still overflow, and
                // `Infinity <= allowedMass` is already false — so the verdict is
                // right either way and only the observation needs care: the
                // number goes into the record as text, because JSONB would store
                // it as `null` and the audit trail would read as though nothing
                // had been observed.
                Number.isFinite(macroMass) && macroMass <= allowedMass,
                observedNumber(macroMass),
                allowedMass,
            ),
        );

        // An unusable macro mass makes the energy comparison unusable too, and a
        // check that could not be EVALUATED is absent from the record rather
        // than recorded as a failure of its own rule.
        if (Number.isFinite(macroMass) && isFiniteNumber(calories) && bounds) {
            // The 30 kcal floor in max(30, T%) is what keeps a 20 kcal food from
            // failing on rounding alone, and the per-category percentage is why
            // produce (fibre, organic acids) is judged at 30 % while oil is
            // judged at 8 %.
            //
            // The comparison is against an ABSOLUTE allowance rather than a
            // percentage of the difference: `diff / kcal * 100 > pct` would make
            // a candidate exactly on its bound fail, because the round trip
            // through IEEE-754 lands a hair above the integer.
            const derivedKcal =
                ENERGY_PER_GRAM.protein * protein + ENERGY_PER_GRAM.carbs * carbs + ENERGY_PER_GRAM.fat * fat;
            const difference = Math.abs(derivedKcal - calories);
            const allowed = Math.max(
                globalBounds.energyMacroAbsoluteToleranceKcal,
                (calories * bounds.energyMacroTolerancePercent) / PERCENT,
            );

            checks.push(
                buildCheck(
                    CATALOG_CHECK_NAMES.ENERGY_MACRO_MISMATCH,
                    // Both sides are computed, so both are guarded: an infinite
                    // allowance would otherwise pass an infinite difference
                    // (`Infinity <= Infinity`) and publish a record whose energy
                    // nothing was actually compared against.
                    Number.isFinite(difference) && Number.isFinite(allowed) && difference <= allowed,
                    observedNumber(difference),
                    observedNumber(allowed),
                ),
            );
        }
    }

    return checks;
};

const portionDriftCheck = (
    candidate: CatalogFoodCandidate,
    nutrition: CatalogNutrientValues,
    servingGrams: number,
    tolerancePercent: number,
): CatalogValidationCheck | null => {
    const stated = candidate.per_serving_nutrition;

    if (!stated) {
        return null;
    }

    let worstDriftPercent = 0;
    let worstField: string | null = null;
    let failed = false;
    let compared = false;
    const notFinite: string[] = [];

    for (const field of NUTRIENT_FIELDS) {
        const per100 = nutrition[field];
        const statedValue = readNutrient(stated, field);

        if (!isFiniteNumber(per100) || !isFiniteNumber(statedValue)) {
            continue;
        }

        compared = true;

        const expected = (per100 * servingGrams) / PER_100G_BASIS_AMOUNT;
        const difference = Math.abs(statedValue - expected);
        const allowed = (Math.abs(expected) * tolerancePercent) / PERCENT;

        // The expectation is a product of two finite values and can overflow;
        // an unguarded `Infinity` would make `difference > allowed` read
        // `Infinity > Infinity` — false — and pass a record whose portion
        // arithmetic never resolved. The field is named in the observation
        // instead of a percentage JSONB could not hold.
        if (!Number.isFinite(expected) || !Number.isFinite(difference) || !Number.isFinite(allowed)) {
            notFinite.push(`${field}=${String(expected)}`);
            failed = true;
            continue;
        }
        // A zero expectation admits only a zero statement: there is no ratio to
        // take, so the drift is reported as a whole 100 % rather than as
        // Infinity, which JSONB would store as null.
        const driftPercent =
            expected === 0 ? (statedValue === 0 ? 0 : PERCENT) : (difference / Math.abs(expected)) * PERCENT;

        if (driftPercent > worstDriftPercent) {
            worstDriftPercent = driftPercent;
            worstField = field;
        }
        if (difference > allowed) {
            failed = true;
        }
    }

    if (!compared) {
        return null;
    }

    const observed =
        notFinite.length > 0
            ? `not finite: ${notFinite.join(', ')}`
            : worstField === null
              ? 0
              : `${worstField} ${worstDriftPercent.toFixed(2)}%`;

    return buildCheck(
        CATALOG_CHECK_NAMES.PORTION_CONVERSION_DRIFT,
        !failed,
        observed,
        `within ${tolerancePercent}% of the per-100g values at ${servingGrams} g`,
    );
};

/**
 * Whether a portion's gram weight disqualifies it.
 *
 * `null` is the source stating no weight, which is honest and is never invented
 * — but a portion the pipeline keeps must have one, because
 * `catalog_food_portions.gram_weight` is `NOT NULL`. So `null`, zero, negative
 * and non-finite are one answer here, and there is no policy input that could
 * make any of them acceptable: a weight the column cannot hold is unusable
 * whatever a plan says.
 */
const hasUnusableGramWeight = (portion: CatalogFoodPortionCandidate): boolean =>
    !isPositiveFinite(portion.gram_weight);

const presenceChecks = (
    candidate: CatalogFoodCandidate,
    nutrition: CatalogNutrientValues | null,
    defaultPortion: CatalogFoodPortionCandidate | null,
    normalizationFailure: CatalogValidationCheck | null,
    context: CatalogValidationContext,
    rule: CatalogNutritionBasisRule,
): CatalogValidationCheck[] => {
    const checks: CatalogValidationCheck[] = [];
    const values: CatalogNutrientInput = nutrition ?? candidate;

    const missing = CORE_NUTRIENT_FIELDS.filter((field) => readNutrient(values, field) === null);
    checks.push(
        buildCheck(
            CATALOG_CHECK_NAMES.MISSING_CORE_NUTRIENT,
            missing.length === 0,
            missing.length === 0 ? null : missing.join(', '),
            CORE_NUTRIENT_FIELDS.join(', '),
        ),
    );

    // Skipped when the conversion already reported it, so one missing gram
    // weight is one check rather than two records of the same fact.
    if (normalizationFailure?.name !== CATALOG_CHECK_NAMES.MISSING_GRAM_WEIGHT) {
        const gramWeight = defaultPortion?.gram_weight ?? null;

        checks.push(
            buildCheck(
                CATALOG_CHECK_NAMES.MISSING_GRAM_WEIGHT,
                // Unconditional: a default portion the pipeline can write must
                // exist and must carry a usable weight. No policy input relaxes
                // it, because the column is `NOT NULL` either way.
                defaultPortion !== null && isPositiveFinite(gramWeight),
                defaultPortion === null ? 'no default portion' : gramWeight,
                'one default portion with a sourced gram weight greater than 0',
            ),
        );
    }

    const portions = candidate.portions ?? [];
    if (portions.length > 0) {
        // Counted rather than found: `portions.find(is_default)` answers which
        // portion the serving weight comes from, and says nothing about a second
        // one waiting to fail the insert. The count itself is the observation an
        // operator needs.
        const defaultCount = portions.filter((portion) => portion.is_default).length;

        checks.push(
            buildCheck(
                CATALOG_CHECK_NAMES.DEFAULT_PORTION_COUNT,
                defaultCount === rule.requiredDefaultPortionCount,
                defaultCount,
                rule.requiredDefaultPortionCount,
            ),
        );

        const unsupported = portions
            .filter(
                (portion) =>
                    !isPositiveFinite(portion.amount) ||
                    // The DEFAULT portion's own weight is `missing_gram_weight`'s
                    // fact, recorded there with the bound that names it, so this
                    // check judges the others — one missing weight stays one
                    // record rather than two spellings of it.
                    (!portion.is_default && hasUnusableGramWeight(portion)) ||
                    unitFamily(portion.unit) === null,
            )
            .map(
                (portion) =>
                    `${portion.description || '(no description)'}: ${portion.amount} ${portion.unit} at ${
                        portion.gram_weight === null ? 'no gram weight' : `${String(portion.gram_weight)} g`
                    }`,
            );

        checks.push(
            buildCheck(
                CATALOG_CHECK_NAMES.UNSUPPORTED_PORTION,
                unsupported.length === 0,
                unsupported.length === 0 ? null : unsupported.join('; '),
                'positive amounts and sourced gram weights, in a convertible unit',
            ),
        );
    }

    checks.push(
        buildCheck(
            CATALOG_CHECK_NAMES.UNSOURCED,
            candidate.identity_status !== 'unsourced',
            candidate.identity_status,
            'verified or ambiguous',
        ),
    );

    if (context.duplicateOfSourceKey !== undefined) {
        checks.push(
            buildCheck(
                CATALOG_CHECK_NAMES.DUPLICATE_IDENTITY,
                context.duplicateOfSourceKey === null,
                context.duplicateOfSourceKey,
                'a canonical name and food state no published food already holds',
            ),
        );
    }

    return checks;
};

const reviewChecks = (
    candidate: CatalogFoodCandidate,
    nutrition: CatalogNutrientValues | null,
    bounds: ResolvedCategoryBounds | null,
): CatalogValidationCheck[] => {
    const checks: CatalogValidationCheck[] = [];
    const calories = nutrition?.calories ?? null;

    if (bounds && isFiniteNumber(calories)) {
        // The bands are wide on purpose — egg white at ≈ 52 kcal and egg yolk at
        // ≈ 322 both sit inside protein_egg's 40–350, and grain carries separate
        // dry and cooked bands — so this flags the atypical rather than
        // rejecting the real.
        checks.push(
            buildCheck(
                CATALOG_CHECK_NAMES.OUT_OF_CATEGORY_RANGE,
                calories >= bounds.kcalRange.min && calories <= bounds.kcalRange.max,
                calories,
                `${bounds.kcalRange.min}-${bounds.kcalRange.max} kcal/100g for ${bounds.category}${
                    bounds.kcalRangeFromFoodState ? ` (${candidate.food_state})` : ''
                }`,
            ),
        );
    }

    checks.push(
        buildCheck(
            CATALOG_CHECK_NAMES.ALLERGENS_UNKNOWN,
            candidate.allergen_status === 'known',
            candidate.allergen_status,
            'known',
        ),
    );

    return checks;
};

/**
 * Every numeric bound the policy supplies, with the path an operator would fix
 * and whether zero is a legal value for it.
 *
 * Ceilings and tolerances must be greater than zero — a ceiling of 0 rejects
 * every food and a tolerance factor of 0 makes the macro-mass allowance 0, so
 * neither can decide anything. A review band's floor may legitimately BE zero:
 * `beverage`, `condiment_sauce`, `spice_herb` and `other` all ship with
 * `kcalReviewRange.min: 0`, because a zero-calorie drink is a real food and not
 * an atypical one.
 */
const numericPolicyBounds = (
    policy: CatalogValidationPolicy,
): { path: string; value: number; zeroAllowed: boolean }[] => {
    const { validationBounds: global } = policy;
    const positive = (path: string, value: number) => ({ path, value, zeroAllowed: false });
    const nonNegative = (path: string, value: number) => ({ path, value, zeroAllowed: true });

    const entries = [
        positive('validationBounds.maxKcalPer100g', global.maxKcalPer100g),
        positive('validationBounds.macroMassToleranceFactor', global.macroMassToleranceFactor),
        positive('validationBounds.energyMacroAbsoluteToleranceKcal', global.energyMacroAbsoluteToleranceKcal),
        positive('validationBounds.portionConversionTolerancePercent', global.portionConversionTolerancePercent),
    ];

    for (const category of policy.categories) {
        const at = `categories[${category.category}]`;
        entries.push(
            nonNegative(`${at}.kcalReviewRange.min`, category.kcalReviewRange.min),
            positive(`${at}.kcalReviewRange.max`, category.kcalReviewRange.max),
            positive(`${at}.energyMacroTolerancePercent`, category.energyMacroTolerancePercent),
        );

        for (const [state, range] of Object.entries(category.kcalReviewRangeByFoodState ?? {})) {
            if (range) {
                entries.push(
                    nonNegative(`${at}.kcalReviewRangeByFoodState.${state}.min`, range.min),
                    positive(`${at}.kcalReviewRangeByFoodState.${state}.max`, range.max),
                );
            }
        }
    }

    return entries;
};

/**
 * Proves the policy can decide anything before a single check runs, and returns
 * the portion rule to enforce.
 *
 * Two distinct failures are caught here for one reason: a candidate must never
 * receive a verdict from a policy that cannot produce a correct one.
 *
 * 1. A bound that is not a finite positive number, or whose arithmetic
 *    overflows. Checking the supplied numbers is not sufficient, and the
 *    macro-mass ceiling is why: `macroMassToleranceFactor = Number.MAX_VALUE`
 *    is finite and positive, yet `100 × MAX_VALUE` is `Infinity`, and a ceiling
 *    of `Infinity` passes every candidate and then stores as `null` in JSONB —
 *    a check that reads as satisfied against a bound nobody can see. So the
 *    DERIVED bound is asserted too, at the one place it is derived from.
 * 2. A portion rule that differs from {@link DEFAULT_CATALOG_NUTRITION_BASIS_RULE}.
 *    Those values are database invariants, not thresholds; honouring a relaxed
 *    one would report a candidate publishable and abort the insert instead.
 *    Failing here means a drifted plan is loud rather than quietly disregarded.
 *
 * Throwing rather than recording a check is deliberate: `checks[]` describes a
 * candidate, and neither failure is the candidate's. Recording one would write a
 * terminal `rejected` verdict for a row a corrected plan would publish.
 */
export const assertUsableValidationPolicy = (
    policy: CatalogValidationPolicy,
): CatalogNutritionBasisRule => {
    for (const { path, value, zeroAllowed } of numericPolicyBounds(policy)) {
        const usable = zeroAllowed ? Number.isFinite(value) && value >= 0 : isPositiveFinite(value);

        if (!usable) {
            throw new CatalogPolicyError(
                `${path} must be a finite number ${
                    zeroAllowed ? 'of 0 or more' : 'greater than 0'
                }, received ${String(value)}`,
            );
        }
    }

    const allowedMass = PER_100G_BASIS_AMOUNT * policy.validationBounds.macroMassToleranceFactor;
    if (!isPositiveFinite(allowedMass)) {
        throw new CatalogPolicyError(
            `validationBounds.macroMassToleranceFactor ${String(
                policy.validationBounds.macroMassToleranceFactor,
            )} yields a macro-mass ceiling of ${String(allowedMass)}, which is not a usable bound`,
        );
    }

    const rule = policy.nutritionBasisRule ?? DEFAULT_CATALOG_NUTRITION_BASIS_RULE;
    const expected = DEFAULT_CATALOG_NUTRITION_BASIS_RULE;
    if (
        rule.requiredDefaultPortionCount !== expected.requiredDefaultPortionCount ||
        rule.defaultPortionRequiresSourcedGramWeight !== expected.defaultPortionRequiresSourcedGramWeight ||
        rule.retainedPortionsRequireSourcedGramWeight !== expected.retainedPortionsRequireSourcedGramWeight
    ) {
        throw new CatalogPolicyError(
            `nutritionBasisRule must match the database invariants ${JSON.stringify(
                expected,
            )}, received ${JSON.stringify(rule)}`,
        );
    }

    return expected;
};

/**
 * Runs every deterministic check the coverage plan defines against one
 * candidate and resolves its publication status.
 *
 * This is the single entry point the import, generation and validation scripts
 * call: the per-100 g conversion happens here too, because its failure modes
 * (`missing_density`, `missing_gram_weight`) are themselves checks and belong in
 * the same record as the rest.
 *
 * The record is auditable and replayable on purpose — each entry carries what
 * was observed, the bound it was judged against and the tier that governs it —
 * so `catalog-report.ts` can group failures by check without consulting this
 * code, and a re-validation after a data change can be compared with the last
 * one.
 */
export const validateCatalogCandidate = (
    candidate: CatalogFoodCandidate,
    policy: CatalogValidationPolicy,
    context: CatalogValidationContext = {},
): CatalogValidationVerdict => {
    // Before any check: a policy that cannot decide correctly must not produce a
    // verdict at all. Throws rather than returning one, and returns the portion
    // rule to enforce.
    const rule = assertUsableValidationPolicy(policy);
    const checks: CatalogValidationCheck[] = [];

    // Only a generated candidate is judged on its name: a USDA Branded record
    // legitimately carries a brand, which the vendor — not a model — asserted.
    if (candidate.identity_source === 'ai_generated') {
        checks.push(brandPatternCheck(candidate, policy));
    }

    const bounds = resolveCategoryBounds(policy, candidate.category, candidate.food_state);
    checks.push(
        buildCheck(
            CATALOG_CHECK_NAMES.UNKNOWN_CATEGORY,
            bounds !== null,
            candidate.category,
            'a category declared by the coverage plan',
        ),
    );

    checks.push(...nutrientSignChecks(candidate));

    const portions = candidate.portions ?? [];
    const defaultPortion = portions.find((portion) => portion.is_default) ?? null;
    const servingGrams = candidate.serving_gram_weight ?? defaultPortion?.gram_weight ?? null;

    const conversion = normalizeToPer100g({ ...candidate, serving_gram_weight: servingGrams });
    const normalizedNutrition = conversion.kind === 'ok' ? conversion.normalized.nutrition : null;
    const normalizationFailure = conversion.kind === 'error' ? conversion.check : null;

    if (normalizationFailure) {
        checks.push(normalizationFailure);
    }

    if (normalizedNutrition) {
        checks.push(...energyChecks(normalizedNutrition, bounds, policy.validationBounds));

        if (isPositiveFinite(servingGrams)) {
            const drift = portionDriftCheck(
                candidate,
                normalizedNutrition,
                servingGrams,
                policy.validationBounds.portionConversionTolerancePercent,
            );

            if (drift) {
                checks.push(drift);
            }
        }
    }

    checks.push(
        ...presenceChecks(candidate, normalizedNutrition, defaultPortion, normalizationFailure, context, rule),
    );
    checks.push(...reviewChecks(candidate, normalizedNutrition, bounds));

    return {
        ...resolveCatalogDisposition(checks, {
            identitySource: candidate.identity_source,
            advisoryReview: context.advisoryReview,
            curatorAllowlistedCheckNames: context.curatorAllowlistedCheckNames,
        }),
        checks,
        normalizedNutrition,
    };
};

/* ---------------------------------------------------------------------------
 * Provenance — four independent facts that must never collapse
 * ------------------------------------------------------------------------- */

/**
 * Whether stored nutrition is an ESTIMATE.
 *
 * `ingredient_derived` counts, and that is the non-obvious half of the rule:
 * its components may each be source-backed, but their QUANTITIES are assumed,
 * so the result is an estimate labelled "Estimated from ingredients" — not
 * something that may be presented as verified nutrition. `user_entered` is
 * unverified rather than estimated, so it is not one either; it is a catalog
 * food's impossible value anyway, since the server owns every catalog number.
 */
export const isEstimatedNutrition = (provenance: NutritionProvenance): boolean =>
    provenance === 'ingredient_derived' || provenance === 'ai_estimated';

/**
 * The catalog-side facts recipe eligibility turns on. `nutrition_provenance` is
 * the wider `NutritionProvenance` rather than the catalog-only subset because
 * `recipe_ingredients` carries a frozen TEXT snapshot of it, and a predicate
 * that could not be handed that snapshot would be re-implemented at the call
 * site — which is how the two would drift.
 */
export interface CatalogRecipeEligibilityFacts {
    publication_status: CatalogPublicationStatus;
    nutrition_provenance: NutritionProvenance;
    allergen_status: CatalogAllergenStatus;
}

/**
 * Whether a catalog food may be an ingredient of a planned recipe.
 *
 * All three conditions, and the conjunction is the rule: `published` (a
 * `retired` or `quarantined` row stays referenceable by existing recipes but
 * may not enter a NEW one), `source_backed` nutrition (so a planned meal is
 * never an estimate), and `known` allergens (unknown allergen metadata is never
 * eligible, whatever the user selected).
 *
 * The rest of eligibility — diet tags, disliked foods and groups, cooking time,
 * slots — is `recipe.logic.ts`'s, over the ingredient snapshots. This module
 * owns only these three catalog facts, and never conflates provenance with
 * publication.
 */
export const isRecipeEligibleCatalogFood = (food: CatalogRecipeEligibilityFacts): boolean =>
    food.publication_status === 'published' &&
    food.nutrition_provenance === 'source_backed' &&
    food.allergen_status === 'known';

/* ---------------------------------------------------------------------------
 * Coverage — the shortfall, reported exactly
 * ------------------------------------------------------------------------- */

export interface CatalogCategoryShortfall {
    category: string;
    publishedTarget: number;
    published: number;
    /** `max(0, target − published)`; a surplus is a zero shortfall, not a negative one. */
    shortfall: number;
}

export interface CatalogCoverageShortfall {
    categories: CatalogCategoryShortfall[];
    publishedTotal: number;
    publishedTargetTotal: number;
    shortfallTotal: number;
    meetsTarget: boolean;
    /**
     * Categories the counts carry that the coverage plan does not declare. Their
     * rows are excluded from `publishedTotal`, because a total that silently
     * absorbed them would report a catalog larger than the plan describes.
     */
    unknownCategories: string[];
}

/**
 * The per-category and total shortfall against the coverage plan's published
 * targets, from a count of published rows per category.
 *
 * Reported EXACTLY: every value is an integer difference, nothing is rounded,
 * a category with no published rows still reports its whole target as a
 * shortfall, and a surplus in one category never offsets a deficit in another.
 * The validation tiers above are what turn candidates into published rows, so
 * an over-tight bound surfaces here — which only works if this number is never
 * softened.
 */
export const computeCoverageShortfall = (
    policy: CatalogValidationPolicy,
    publishedByCategory: Readonly<Record<string, number>>,
): CatalogCoverageShortfall => {
    // Counts are keyed the same way categories are matched, and two spellings of
    // one category SUM. Reading the raw key instead would drop a count that
    // differed only in case or whitespace, and a dropped count is a fabricated
    // shortfall — the one thing this function must never produce.
    const countsByKey = new Map<string, number>();
    for (const [category, count] of Object.entries(publishedByCategory)) {
        const key = categoryKey(category);
        countsByKey.set(key, (countsByKey.get(key) ?? 0) + count);
    }

    const counted = new Set<string>();
    const categories: CatalogCategoryShortfall[] = [];

    let publishedTotal = 0;
    let publishedTargetTotal = 0;
    let shortfallTotal = 0;

    for (const bounds of policy.categories) {
        const key = categoryKey(bounds.category);
        counted.add(key);

        const published = countsByKey.get(key) ?? 0;
        const shortfall = Math.max(0, bounds.publishedTarget - published);

        categories.push({
            category: bounds.category,
            publishedTarget: bounds.publishedTarget,
            published,
            shortfall,
        });

        publishedTotal += published;
        publishedTargetTotal += bounds.publishedTarget;
        shortfallTotal += shortfall;
    }

    const unknownCategories = [...countsByKey.keys()].filter((key) => !counted.has(key)).sort();

    return {
        categories,
        publishedTotal,
        publishedTargetTotal,
        shortfallTotal,
        meetsTarget: shortfallTotal === 0,
        unknownCategories,
    };
};
