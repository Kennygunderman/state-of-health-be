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
//    `food_state`, `nutrition_basis`, `allergen_status`, the members of
//    `allergen_tags` and `diet_tags`, and the grocery `category` are plain TEXT
//    (or `TEXT[]`) columns with no Prisma enum and no CHECK constraint,
//    precisely so that validation lives in this file. A value this module
//    admits reaches the database unchallenged, which is why the guards below
//    are exported and why the tiering introduces no new status. The two tag
//    vocabularies are the sharpest case: they are SAFETY metadata the planner
//    matches by code, so a value outside them excludes nothing rather than
//    failing anywhere.
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
import { DEFAULT_LIMIT, MAX_LIMIT, parsePaginationStrict } from '../utils/pagination';
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

/**
 * The provenance set, and the guard every reader of the unrestricted
 * `nutrition_provenance` TEXT column narrows through.
 *
 * Two of those readers are outside this domain and neither tolerates a value
 * this set does not name, so the set is the enforcement point for both:
 * `recipe.service.ts` downgrades an unrecognised value to the unverifiable
 * class, which can only make a recipe ineligible for planning, and
 * `nutrition.logic.ts` refuses to write a diary entry for it at all — a stored
 * class the diary cannot read renders no label, which would suppress the
 * estimate warning an AI-estimated or ingredient-derived food must carry
 * (§0.1.4(i)). Adding a member here therefore widens what may be logged and
 * labelled, not merely what validation accepts.
 */
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
    /**
     * An `allergen_tags` or `diet_tags` entry outside
     * {@link CATALOG_ALLERGEN_TAGS} / {@link CATALOG_DIET_TAGS} — including a
     * blank string and an entry that is not a string at all.
     *
     * Reject tier, because an off-vocabulary code is not a fact waiting for
     * more data: both lists are SAFETY metadata matched by code (the planner
     * excludes on the user's selected allergens, `recipe.logic.ts` derives diet
     * compatibility from the ingredient tags), so a code no consumer can match
     * is silently equivalent to claiming no allergen and no diet at all. That
     * is the unsafe direction, and it is the direction a stored value would
     * keep failing in on every re-validation.
     */
    UNKNOWN_TAG_CODE: 'unknown_tag_code',
    /**
     * A diet claim the food's own allergen list contradicts, under
     * {@link CATALOG_DIET_TAG_EXCLUSIONS}.
     *
     * Reject tier for the same reason as `macro_mass_ceiling`: the record
     * cannot be true as written. A food carrying `milk` is not vegan, whichever
     * of the two lists is wrong, and no later data makes both right — so it is
     * rejected rather than held, and rejection returns before the review branch
     * so no curator allowlist and no advisory model answer can publish it.
     */
    INCONSISTENT_TAG_SET: 'inconsistent_tag_set',

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
    unknown_tag_code: 'reject',
    inconsistent_tag_set: 'reject',

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
 * The stored-row derivations both writers of `catalog_foods` must agree on
 * ------------------------------------------------------------------------- */

// WHY THESE THREE RULES ARE HERE. `catalog-import-usda.ts` and
// `catalog-generate-ai.ts` write the same table from two different sources —
// curated USDA records and AI-generated candidates — and they have to derive
// three things identically or the table stops being one catalog: the alias list
// a food answers to, the `search_text` the STORED `search_vector` is generated
// from, and the two version counters `recipe_ingredients` snapshots are checked
// for staleness against. Each is a decision about what the catalog IS rather
// than a mechanic of either command, so it belongs with the other catalog rules
// in this module and is unit-tested beside them (AAP §0.7.1 Group 3, Rule
// backend-architecture §1.1/§7.1 — a script is an I/O recipe, and the domain
// rules it applies live in the service layer it calls).
//
// What stays in `scripts/lib/catalogFoodFacts.ts` is the payload-digest
// mechanics the two commands also share (`canonicalJsonString`, `sha256Hex`):
// key-sorted JSON and a SHA-256 are facts about bytes, with no catalog decision
// in them.

/**
 * The alias list to store for one food: lower-cased, internally
 * whitespace-collapsed, de-duplicated, sorted, and never the canonical name
 * itself.
 *
 * Both writers must agree on this because the aliases feed
 * {@link buildSearchText}, and therefore the stored `search_vector`: a food
 * whose aliases differ by case or by ordering between two runs produces a
 * different `search_text`, which is a spurious update on every rerun and a
 * different search corpus on every release. The canonical name is excluded
 * because the name is already indexed in its own right — storing it again as an
 * alias would double its contribution to the score.
 *
 * Sorting is by code unit (byte order for the ASCII these names normalise to),
 * the same comparator the release export and the `COLLATE "C"` tiebreakers use,
 * so the order is a property of the data rather than of the host's locale.
 *
 * @param aliases the candidate's own alias claims, in any order
 * @param canonicalName the food's canonical name, which is never an alias
 *
 * @example
 * dedupeSortedAliases([' Aubergine ', 'aubergine', 'Egg  plant'], 'eggplant');
 * // → ['aubergine', 'egg plant']
 */
export const dedupeSortedAliases = (aliases: readonly string[], canonicalName: string): string[] => {
    const normalizedCanonical = normalizeCanonicalName(canonicalName);
    const seen = new Set<string>();
    const kept: string[] = [];

    for (const alias of aliases) {
        const trimmed = alias.trim().toLowerCase().replace(WHITESPACE_RUN_PATTERN, ' ');
        if (trimmed.length === 0 || seen.has(trimmed) || normalizeCanonicalName(trimmed) === normalizedCanonical) {
            continue;
        }
        seen.add(trimmed);
        kept.push(trimmed);
    }

    return kept.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
};

/**
 * `search_text` feeds the STORED `search_vector`, so it carries the terms that
 * should match and no punctuation: `to_tsvector` owns stemming and weighting,
 * and this rule's job is to hand it plain words (Rule backend-architecture §7).
 *
 * The words are the canonical name's, then every alias's, then the food state's
 * and the food group's, first occurrence kept and later repeats dropped — so
 * the result is stable across two runs over the same facts, which is what makes
 * a rerun a no-op rather than an update. The state and group are underscored
 * codes (`as_purchased`, `bell_pepper`), and the underscore is expanded to a
 * space so each half is its own searchable word instead of one lexeme no user
 * would type.
 *
 * Both writers must agree on this for the same reason they must agree on the
 * alias list: the column is the search corpus, and two stages deriving it by
 * two rules would make a food's reachability depend on which stage happened to
 * write it.
 */
export const buildSearchText = (
    canonicalName: string,
    aliases: readonly string[],
    foodState: CatalogFoodState,
    foodGroup: string,
): string => {
    const words: string[] = [];
    const seen = new Set<string>();
    const push = (value: string): void => {
        for (const word of normalizeCanonicalName(value).split(' ')) {
            if (word.length > 0 && !seen.has(word)) {
                seen.add(word);
                words.push(word);
            }
        }
    };

    push(canonicalName);
    for (const alias of aliases) {
        push(alias);
    }
    push(foodState.replace(/_/g, ' '));
    push(foodGroup.replace(/_/g, ' '));

    return words.join(' ');
};

/**
 * Everything the two version counters on `catalog_foods` answer for, plus the
 * counters themselves.
 *
 * Every field is optional and nullable on purpose. The columns Prisma reads
 * back are nullable where prisma/schema.prisma says so — the five nutrients
 * and `density_g_per_ml` are `DOUBLE PRECISION NULL`, where NULL means unknown
 * and never zero — and a field the caller has no value for arrives as
 * `undefined`. {@link nextCatalogFoodVersions} normalises the two into one
 * "no value" so neither reads as a change against the other.
 */
export interface StoredVersionedFacts {
    /**
     * The counters as stored. Read from the existing row only — the incoming
     * facts do not carry a version, because what the next version IS is this
     * module's decision rather than the vendor payload's.
     */
    nutrition_version?: number | null;
    metadata_version?: number | null;

    // THE NUTRITION SET: the five values `recipe_ingredients.snapshot_per_100g`
    // freezes, the three that fix what "per 100" means (a per_100ml basis, a
    // basis amount of 50 or a density each change what the same five numbers
    // describe), the provenance `snapshot_provenance` freezes, and the vendor
    // facts the numbers were read from — a different fdc id, data type or
    // publication month means a different source record produced them, which a
    // recipe holding the old snapshot has to be told about.
    calories?: number | null;
    protein_g?: number | null;
    carbs_g?: number | null;
    fat_g?: number | null;
    fiber_g?: number | null;
    nutrition_basis?: string | null;
    basis_amount?: number | null;
    density_g_per_ml?: number | null;
    nutrition_provenance?: string | null;
    usda_fdc_id?: number | null;
    usda_data_type?: string | null;
    source_version?: string | null;

    // THE METADATA SET: identity and safety. `snapshot_name` freezes the name a
    // recipe displays, `snapshot_allergen_tags` and `snapshot_diet_tags` freeze
    // what it may claim, and `food_group` is what a user's dislike selection
    // excludes by. `allergen_status` is here because 'known' → 'unknown' is a
    // change of safety standing even when the tag list is untouched.
    canonical_name?: string | null;
    display_name?: string | null;
    food_group?: string | null;
    allergen_status?: string | null;
    allergen_tags?: readonly string[] | null;
    diet_tags?: readonly string[] | null;
}

/** The two counters to write, and which set moved to get them there. */
export interface CatalogFoodVersions {
    readonly nutritionVersion: number;
    readonly metadataVersion: number;
    /** False on an insert: a new row's counters start at 1, they do not move. */
    readonly nutritionChanged: boolean;
    readonly metadataChanged: boolean;
}

/**
 * Order-insensitive set comparison for the two tag arrays: a food whose diet
 * tags came back in a different order has not changed, and versioning it would
 * be versioning the vendor's array ordering.
 */
const sameStringSet = (
    left: readonly string[] | null | undefined,
    right: readonly string[] | null | undefined,
): boolean => {
    const a = [...(left ?? [])].sort();
    const b = [...(right ?? [])].sort();
    return a.length === b.length && a.every((value, index) => value === b[index]);
};

/**
 * One fact compared, with absent and NULL treated as the same "no value".
 *
 * Strict equality is the right test for the numbers here: they are read per
 * 100 g out of the same vendor payload by the same deterministic code, so a
 * rerun that changes nothing produces bit-identical doubles, and a tolerance
 * would only hide a real vendor revision. What DOES need normalising is
 * `undefined` vs `null` — `fiber_g` is written as `?? null` and a fact the
 * caller omits arrives as `undefined` — which without this would read as a
 * change on every single rerun.
 */
const sameFact = (
    left: string | number | null | undefined,
    right: string | number | null | undefined,
): boolean => (left ?? null) === (right ?? null);

/**
 * Both version counters for the row about to be written.
 *
 * WHY THIS EXISTS AT ALL. `recipe_ingredients` freezes `snapshot_per_100g`,
 * `snapshot_name`, `snapshot_provenance`, `snapshot_allergen_tags` and
 * `snapshot_diet_tags` beside the two counters they were taken at, and
 * `src/services/recipe.logic.ts::isIngredientSnapshotStale` detects a stale
 * snapshot by comparing BOTH counters for INEQUALITY — nothing compares the
 * values themselves. A counter that is reset to 1, or that fails to move when
 * its facts did, therefore means a published recipe goes on claiming nutrition
 * or safety metadata the catalog no longer states: with the allergen set that
 * is a safety bug, not a cosmetic one (AAP §0.5.1, §0.7.3, and the counter
 * contract "nutrition_version bumped on any nutrient change, metadata_version
 * bumped on any allergen/diet/name/food-group change").
 *
 * Each counter answers for its own set and only its own: a renamed food does
 * not reversion its nutrition, and a changed nutrient does not reversion its
 * safety metadata, because either spurious bump forces a needless new recipe
 * version across every recipe using the food. An unchanged set PRESERVES the
 * stored counter rather than recomputing it, which is what keeps a no-op rerun
 * byte-identical and an exported release stable.
 *
 * `next` may carry more than the compared facts — the caller passes the whole
 * scalar set it is about to write — and everything outside the two sets above
 * is ignored.
 *
 * @param existing the stored row, or `null` when this `source_key` is new
 * @param next the facts about to be written
 *
 * @example
 * // A rerun that changed nothing keeps both counters where they were.
 * nextCatalogFoodVersions({ nutrition_version: 3, metadata_version: 2, calories: 165 }, { calories: 165 });
 * // → { nutritionVersion: 3, metadataVersion: 2, nutritionChanged: false, metadataChanged: false }
 */
export const nextCatalogFoodVersions = (
    existing: StoredVersionedFacts | null,
    next: StoredVersionedFacts,
): CatalogFoodVersions => {
    // A new row is at version 1 on both counters. There is no stored snapshot
    // of it anywhere yet, so nothing has moved and nothing can be stale.
    if (existing === null) {
        return { nutritionVersion: 1, metadataVersion: 1, nutritionChanged: false, metadataChanged: false };
    }

    const nutritionChanged =
        !sameFact(existing.calories, next.calories) ||
        !sameFact(existing.protein_g, next.protein_g) ||
        !sameFact(existing.carbs_g, next.carbs_g) ||
        !sameFact(existing.fat_g, next.fat_g) ||
        !sameFact(existing.fiber_g, next.fiber_g) ||
        !sameFact(existing.nutrition_basis, next.nutrition_basis) ||
        !sameFact(existing.basis_amount, next.basis_amount) ||
        !sameFact(existing.density_g_per_ml, next.density_g_per_ml) ||
        !sameFact(existing.nutrition_provenance, next.nutrition_provenance) ||
        !sameFact(existing.usda_fdc_id, next.usda_fdc_id) ||
        !sameFact(existing.usda_data_type, next.usda_data_type) ||
        !sameFact(existing.source_version, next.source_version);

    const metadataChanged =
        !sameFact(existing.canonical_name, next.canonical_name) ||
        !sameFact(existing.display_name, next.display_name) ||
        !sameFact(existing.food_group, next.food_group) ||
        !sameFact(existing.allergen_status, next.allergen_status) ||
        !sameStringSet(existing.allergen_tags, next.allergen_tags) ||
        !sameStringSet(existing.diet_tags, next.diet_tags);

    // A stored counter this rule never wrote (a hand-loaded row, a release
    // predating the column) is read as 1 rather than as "no version": the
    // column is NOT NULL in the schema, and treating a missing counter as 0
    // would silently renumber a snapshot that already cites 1.
    return {
        nutritionVersion: (existing.nutrition_version ?? 1) + (nutritionChanged ? 1 : 0),
        metadataVersion: (existing.metadata_version ?? 1) + (metadataChanged ? 1 : 0),
        nutritionChanged,
        metadataChanged,
    };
};


/* ---------------------------------------------------------------------------
 * Shared request-query readers — used by BOTH request parsers below
 * ------------------------------------------------------------------------- */

/**
 * A query that is not a readable object becomes an EMPTY record rather than a
 * refusal of its own: a request with no query string and one carrying none of
 * the fields a route reads are the same request here, and the missing field is
 * what each parser then refuses (or defaults, where the contract has a
 * default). Keeping the narrowing total is what lets the page-block delegation
 * be unconditional — `parsePaginationStrict` never has to be reached with
 * something it would guard again.
 */
const asQueryRecord = (query: unknown): Record<string, unknown> =>
    typeof query === 'object' && query !== null && !Array.isArray(query)
        ? (query as Record<string, unknown>)
        : {};

/**
 * `qs` yields an array when a parameter repeats (`?kind=dislike&kind=x`); the
 * first occurrence wins, exactly as {@link parseCatalogSearchQuery} treats a
 * repeated `q` and `parsePaginationStrict` a repeated `page`.
 */
const firstOccurrence = (value: unknown): unknown => (Array.isArray(value) ? value[0] : value);

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

/**
 * The refusal branch {@link parseCatalogSearchQuery} already produces, derived
 * rather than re-declared so every request parser in this module answers with
 * ONE body shape. A hand-written copy would be free to drift from the `details`
 * the client renders beside its fields, which is why
 * `recipe.logic.ts::RecipeVersionPathRefusal` derives its own the same way.
 */
type CatalogQueryRefusal = Exclude<ParsedCatalogSearchQuery, { kind: 'ok' }>;

const SEARCH_QUERY_FIELD = 'q';

/**
 * The C0 control characters plus DEL. A plain character class with no `u` flag
 * on purpose: `tsconfig.json` targets es2016 and declares no `lib`, so the
 * unicode property escape `\p{Cc}` this would otherwise be written as does not
 * compile against this program.
 */
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/;

const invalidSearchQuery = (message: string, code: string): ParsedCatalogSearchQuery => ({
    kind: 'error',
    code: 'invalid_request',
    message,
    details: [{ field: SEARCH_QUERY_FIELD, code }],
});

/**
 * Validates `?q=` for `GET /catalog/foods`: the trimmed query must be 2 to 60
 * characters and must carry no control character.
 *
 * The lower bound is the rule worth pinning — a one-character query matches
 * most of a ten-thousand-item catalog, so it is rejected rather than served.
 * The page and limit of the same request belong to `parsePaginationStrict`, and
 * {@link parseCatalogSearchRequest} is what composes the two rules into the one
 * verdict the handler receives — so this function stays the `q` rule alone and
 * is still separately testable as such. This module never CLAMPS a limit: a
 * request outside the route's band is refused, and the in-process benchmark
 * fetch reads past that band by calling the service directly, where no request
 * band applies.
 *
 * A control character is refused HERE, and before the length is measured. The
 * refusal has to happen in the parser because U+0000 cannot be represented in
 * a PostgreSQL `text` value at all, and `q` reaches the database as a bound
 * parameter of `plainto_tsquery` and the alias `LIKE` in `catalog.service.ts`
 * — so the statement fails while the parameter is being bound, surfacing as an
 * opaque driver error (SQLSTATE 22021 wrapped as Prisma P2010) instead of the
 * `400 invalid_request` a bad query string owes the caller (§0.5.2). The
 * refused class is the whole of C0 plus DEL rather than U+0000 alone: the rest
 * bind cleanly, but only to search for text no user typed. It precedes the
 * length test because the length of a string carrying control bytes is not a
 * meaningful complaint, and it rejects rather than strips, because a stripped
 * query is a different query silently answered.
 *
 * `unknown` rather than `string`: `req.query` members are user input, and `qs`
 * yields an array when a parameter repeats — the first occurrence wins, exactly
 * as `parsePaginationStrict` treats a repeated `page`.
 */
export const parseCatalogSearchQuery = (query: unknown): ParsedCatalogSearchQuery => {
    const raw = Array.isArray(query) ? query[0] : query;

    if (typeof raw !== 'string' || raw.trim().length === 0) {
        return invalidSearchQuery('q is required', 'required');
    }

    const q = raw.trim();

    if (CONTROL_CHARACTER_PATTERN.test(q)) {
        return invalidSearchQuery('q must not contain control characters', 'invalid_characters');
    }

    if (q.length < MIN_SEARCH_QUERY_LENGTH || q.length > MAX_SEARCH_QUERY_LENGTH) {
        return invalidSearchQuery(
            `q must be between ${MIN_SEARCH_QUERY_LENGTH} and ${MAX_SEARCH_QUERY_LENGTH} characters`,
            'invalid_length',
        );
    }

    return { kind: 'ok', q };
};

export type ParsedCatalogSearchRequest =
    | { kind: 'ok'; q: string; page: number; limit: number }
    | CatalogQueryRefusal;

/**
 * Validates the WHOLE query string of `GET /catalog/foods`: `?q=`, `?page=` and
 * `?limit=`, as one verdict.
 *
 * THIS IS THE ONE PARSER THE SEARCH HANDLER CALLS, which is the point of it.
 * The handler is `getUserId` → parse → one service call (§0.7.2,
 * Rule backend-architecture §4), and the page block used to be read separately
 * through the LENIENT `parsePagination` after `q` had been validated here — so
 * `?page=0`, `?page=2.7`, `?page=-1`, `?page=abc` and `?limit=1000` were
 * clamped or truncated into a different, valid request and answered `200 OK`
 * (CWE-20). §0.5.2 requires the opposite: `page >= 1`, `limit` within the
 * route's band, and validation "before any Prisma or planning work
 * (`*.logic.ts` parsers, 400 with field codes)". Composing both rules into one
 * verdict is what makes that structural rather than a habit — there is no
 * second, laxer path to the service left to take.
 *
 * THE BOUNDS ARE THIS ROUTE'S, stated here where the route's rule lives:
 * `DEFAULT_LIMIT` (25) when `?limit=` is omitted and `MAX_LIMIT` (50) as its
 * ceiling (§0.5.2). They are passed explicitly rather than left to the
 * helper's own defaults so that reading this function tells you the contract,
 * and `catalog.service.searchPublishedFoods` still accepts a larger `limit`
 * from a direct in-process caller — `scripts/search-benchmark.ts` reads a
 * `limit=75` reference page (§0.9.3) — because the cap is a property of the
 * REQUEST, not of the query.
 *
 * EVERY FAILING FIELD IS NAMED, in field order `q`, `page`, `limit`, so a
 * request that gets two of them wrong is corrected in one round trip. The
 * messages are joined into one server-side diagnostic; the client renders
 * `details` and maps each `code` to its own copy.
 */
export const parseCatalogSearchRequest = (query: unknown): ParsedCatalogSearchRequest => {
    const record = asQueryRecord(query);

    const parsedQuery = parseCatalogSearchQuery(record[SEARCH_QUERY_FIELD]);
    const parsedPage = parsePaginationStrict(
        { page: record.page, limit: record.limit },
        { defaultLimit: DEFAULT_LIMIT, maxLimit: MAX_LIMIT },
    );

    if (parsedQuery.kind !== 'ok' || parsedPage.kind !== 'ok') {
        const messages = [
            ...(parsedQuery.kind === 'ok' ? [] : [parsedQuery.message]),
            ...(parsedPage.kind === 'ok' ? [] : [parsedPage.message]),
        ];
        const details: CatalogFieldError[] = [
            ...(parsedQuery.kind === 'ok' ? [] : parsedQuery.details),
            ...(parsedPage.kind === 'ok' ? [] : parsedPage.details),
        ];

        return {
            kind: 'error',
            code: 'invalid_request',
            // A server-side diagnostic; the client renders `details`, never
            // this string.
            message: messages.join('; '),
            details,
        };
    }

    return { kind: 'ok', q: parsedQuery.q, page: parsedPage.page, limit: parsedPage.limit };
};

/* ---------------------------------------------------------------------------
 * The search relevance policy
 * ------------------------------------------------------------------------- */

/**
 * How much each kind of match contributes to a food's relevance score, and the
 * ceiling of the prefix band.
 *
 * WHY THIS POLICY EXISTS AT ALL. `ts_rank` alone does not rank this catalog.
 * Its default normalisation scores a document by term frequency and ignores
 * document length, and a catalog food mentions any given word about once — so
 * an entire match set collapses onto ONE rank value. On a bare category word
 * such as `q = 'salt'`, every published food that mentions it shares a single
 * value of `ts_rank(search_vector, plainto_tsquery('english','salt'))`. With
 * every rank equal, the order is decided entirely by the tiebreakers below it —
 * `display_name`, i.e. alphabetical byte order, which is uncorrelated with
 * relevance, so the food actually called "Salt" sat pages deep for "salt" and
 * "Chicken breast" for "chicken", and the §0.7.3 relevance bar (top-3 ≥ 90 %,
 * top-10 ≥ 97 %) was missed. The rates before and after are a property of a
 * benchmark run rather than of this file, so they are read from
 * `data/meal-planning/reports/latest/benchmark-report.json` and not restated
 * here.
 *
 * WHAT THE POLICY CHANGES, AND WHAT IT DELIBERATELY DOES NOT. It changes only
 * the VALUE of `rank`. `catalog.service.ts` still ranks a food by
 * `MAX(rank) … GROUP BY id` over the same four contribution branches and still
 * orders by `rank DESC, display_name COLLATE "C" ASC, source_key COLLATE "C"
 * ASC` (§0.5.2, §0.7.1, and the `ordering` contract in
 * `data/meal-planning/search-benchmark.v1.json`). No key is added, removed or
 * reordered; the score simply discriminates, which is the only way both of
 * those AAP statements can hold at once.
 *
 * THE THREE SIGNALS, each of which fixes a measured failure:
 *
 *  1. SPECIFICITY — a food's score is divided by the number of
 *     whitespace-separated WORDS in its own `display_name`. Among foods that
 *     all match, the one whose NAME is most nearly the query wins: "Spinach"
 *     (1 word) outranks "Spinach, NS as to form, cooked" (6). The divisor
 *     counts words and not tsvector lexemes on purpose — a lexeme count drops
 *     English stopwords, so "Rice with raisins" would count 2 against "Brown
 *     rice, dry"'s 3 and the vaguer name would win `q = 'rice'`; see
 *     `wordCountOf` in `catalog.service.ts`, which also records what the
 *     lexeme-count variant measured. The divisor is the name and not
 *     `search_text` precisely because `search_text` bundles aliases, state and
 *     food group, so a well-curated generic food carries MORE words there than
 *     a verbose USDA survey name does — normalising on the bundle rewards the
 *     verbose row, which is the opposite of what a user wants.
 *  2. FIELD — a match in the food's own name counts fully; a match only in the
 *     bundled `search_text` (a state word, a food-group word, a descriptor)
 *     counts at {@link SearchRelevanceWeights.textOnly}. An alias is an
 *     ALTERNATIVE NAME and so counts fully too, which is what keeps
 *     "eggplant" → "Aubergine" reachable — but its divisor is the LONGER of the
 *     alias and the food's display name, `GREATEST(alias words, name words)`,
 *     rather than either one alone. Both halves of that are load-bearing, and
 *     each was measured:
 *       * not the alias's own length, because the one-word alias "chickens" on
 *         "Chicken, NS as to part and cooking method, NS as to skin eaten"
 *         then beat "Chicken breast" on its own name — short aliases hijacked
 *         every category query;
 *       * not the food's name alone either, because a one-word name with a
 *         longer alias then inherited the short divisor: "Egg", carrying the
 *         alias "chicken egg", took first place for `q = 'chicken'`.
 *     Taking the maximum makes a food's alias contribution no more specific
 *     than the longer of the two strings it is claimed on.
 *  3. HEAD NOUN — in English a nominal compound's head is its last noun, and it
 *     is what the food IS; everything before it modifies. A query matching the
 *     head noun of the name ("Brown rice, dry" for "rice") therefore counts
 *     fully, a query that only modifies ("Bread, rice" — a bread) counts at
 *     {@link SearchRelevanceWeights.headSegment} when it at least appears in
 *     the head segment, and at {@link SearchRelevanceWeights.outsideHead} when
 *     it appears only in a trailing qualifier. The head segment is the text
 *     before the first comma, which is how both USDA and this catalog name
 *     foods ("Beef, ground" / "Ground beef, 93% lean").
 *
 * WHY EVERY WEIGHT IS A NAMED CONSTANT HERE RATHER THAN A LITERAL IN THE SQL.
 * These are ranking rules, not statement mechanics: they decide which food a
 * user sees first, they are the thing a future retune would touch, and an
 * inverted band would silently push every stemmed match below every prefix
 * match. `catalog.service.ts` binds them as query parameters, so this object is
 * their single source of truth. They are NOT in
 * `data/meal-planning/coverage-plan.v1.json` — unlike the validation bounds,
 * which arrive as arguments — because that document describes the catalog's
 * content and carries no search key; nothing loads a manifest to answer a
 * search, and adding one would put file I/O on the measured request path.
 *
 * THE VALUES ARE NOT ARBITRARY. Each was adopted from a full measurement of
 * the committed query set against the loaded v1 release, adding ONE signal at a
 * time and keeping the signal only where the measured hit rates improved:
 * specificity on the name first, then the prefix band, then normalising an
 * alias by the longer of the alias and the name, then the head-segment factor,
 * then the head-noun factor, and last the specificity divisor becoming the
 * name's WORD count rather than its lexeme count. That last step is the one
 * worth reading twice, because it was adopted for correctness and not for its
 * margin: a lexeme count drops English stopwords, so "Rice with raisins"
 * counted two against "Brown rice, dry"'s three and the vaguer name won
 * `q = 'rice'`. Counting words treats a postmodified phrase as the longer, less
 * specific name it is — and costs one `to_tsvector` per alias row less, which
 * also took latency off the widest query.
 *
 * WHERE THE DELIVERED FIGURES LIVE, rather than a copy of them here. The
 * acceptance evidence is `data/meal-planning/reports/latest/benchmark-report.json`,
 * written by `npm run search:benchmark` under the §0.9.3 protocol against a
 * loaded release: its `thresholds.checks` block carries each bound from
 * `data/meal-planning/search-benchmark.v1.json` beside the figure measured
 * against it and its own pass verdict, `rollups` carries the top-3 and top-10
 * hit rates as counts as well as rates, and `latency` carries the percentiles,
 * the sample count and the conditions they were taken under. None of its
 * MEASURED figures is restated here, on purpose: a measurement copied into a
 * comment is stale the moment the report is regenerated, while a contract bound
 * like the §0.7.3 relevance bar above is committed and may be named. This
 * comment's job is the REASONING, which the weights themselves fix, and the
 * report's job is the evidence. Release determinism is a property of
 * two runs rather than one, so the report's `crossDatabaseReproduction` block
 * records it only when the command is given a second, independently loaded
 * database's report to compare with (`--compare-with`), and states what it has
 * not yet established otherwise.
 *
 * WHAT THE POLICY STILL DOES NOT REACH, stated here rather than closed. A
 * handful of bare category-word queries ('crackers', 'mushrooms', 'mushroom',
 * 'chicken' in the committed run — the report's `results` name them, and its
 * `diagnostics.beyondMeasuredPage` lists any whose expected food fell past the
 * measured page) rank their expected food outside the top ten: each is a lone
 * category word whose leading results are legitimate members of that category,
 * and moving them would need a signal this policy does not have. The
 * alternative is fitting weights to the benchmark's query list instead of to
 * how names are built, which would make the next query set the retune.
 */
export interface SearchRelevanceWeights {
    /**
     * The query's head noun is the name's head noun: the query names what the
     * food is. Full weight, and the reference the other factors are fractions
     * of, so it is 1 by construction rather than by preference.
     */
    readonly headNoun: number;

    /**
     * Every query lexeme appears in the name's head segment, but the head nouns
     * differ — the query modifies the food rather than naming it ("apple" in
     * "Apple cider"). Below {@link headNoun} and above {@link outsideHead}.
     */
    readonly headSegment: number;

    /**
     * The query matched the name only outside its head segment, i.e. in a
     * trailing qualifier ("rice" in "Bread, rice"). The weakest name match.
     */
    readonly outsideHead: number;

    /** An alias whose head noun is the query's head noun: an alternative name, full weight. */
    readonly aliasHeadNoun: number;

    /** An alias that matches without its head noun being the query's. */
    readonly aliasOther: number;

    /**
     * The query matched neither the name nor an alias, only the bundled
     * `search_text` — a state, food-group or descriptor word. Still a real
     * match, so still positive and still returned; it simply cannot outrank a
     * food that is actually called what the user typed.
     */
    readonly textOnly: number;

    /**
     * The highest score a prefix-only match may take.
     *
     * Zero, so the prefix band stays strictly BELOW every full-text band —
     * `ts_rank` is strictly positive for a real hit, so any positive score
     * outranks any prefix score. That is the same band boundary the previous
     * constant `PREFIX_MATCH_RANK = 0` drew, and it is kept deliberately: a
     * partially typed word should not outrank a food that matched on meaning.
     * Inside the band, `catalog.service.ts` spreads prefix matches over
     * `(ceiling − 1, ceiling]` by how much of the matched text the typed prefix
     * covers, so "mush" reaches "Mushrooms, white" before "Mushroom soup,
     * canned, condensed" instead of the two tying at the ceiling and falling
     * back to alphabetical order.
     */
    readonly prefixCeiling: number;
}

/**
 * The one instance of {@link SearchRelevanceWeights} the search statement binds.
 *
 * Frozen because it is shared policy read on the request path: a caller that
 * mutated a weight would silently retune every subsequent search in the
 * process, with no statement in the code saying so.
 */
export const SEARCH_RELEVANCE: SearchRelevanceWeights = Object.freeze({
    headNoun: 1,
    headSegment: 0.6,
    outsideHead: 0.3,
    aliasHeadNoun: 1,
    aliasOther: 0.6,
    textOnly: 0.1,
    prefixCeiling: 0,
});

/**
 * The function words that end a head phrase, in the order they are stripped.
 *
 * English puts the head of a COMPOUND noun last — "brown RICE" is a rice — but
 * a phrase that postmodifies with a preposition or a conjunction puts its head
 * BEFORE the connector: "GUMBO with rice" is a gumbo, "MACARONI and cheese" is
 * a macaroni dish. Taking the last word of the whole phrase would call both of
 * those a rice and a cheese, which measured against the v1 release is exactly
 * what happened: "Gumbo with rice", "Beans and rice, with meat" and "Beef curry
 * with rice" took the first page for the query "rice", ahead of "Brown rice,
 * dry".
 *
 * Every entry is a PostgreSQL `english` stopword, so none of them can ever be
 * the word a user is searching for — which is what makes truncating at them
 * safe. The list is short and closed on purpose: it is the set that appears in
 * this catalog's own naming, not an attempt at English grammar.
 *
 * Exported so `catalog.service.ts` builds the SQL side from the same list the
 * query side uses; the two must agree or a food and a search term would have
 * their heads taken by different rules.
 */
export const SEARCH_HEAD_CONNECTORS: readonly string[] = ['with', 'and', 'in', 'on', 'from', 'for', 'of'];

/**
 * The head noun of a search term: the last word of its head phrase.
 *
 * The query side of the head-noun rule {@link SEARCH_RELEVANCE} describes, and
 * it applies the same three steps the SQL applies to a food's name, in the same
 * order: take everything before the first comma, then everything before the
 * first {@link SEARCH_HEAD_CONNECTORS} entry, then the last
 * whitespace-separated word of what remains. "brown rice" gives `rice`,
 * "chicken with rice" gives `chicken`, "beans, black" gives `beans`.
 *
 * It lives here, and not as one more SQL expression in `catalog.service.ts`,
 * for two reasons. It is a rule about language rather than a statement
 * mechanic, so a unit test of it is worth having (Rule backend-architecture
 * §7.1); and it is evaluated ONCE per search rather than once per candidate
 * row, so computing it before the statement keeps it off the per-row path that
 * §0.9.3's latency budget is measured on.
 *
 * Case is folded and punctuation is left alone: the result is handed to
 * `plainto_tsquery`, which lower-cases, discards punctuation and applies the
 * same stemming the stored vectors were built with, so doing either here would
 * be redundant — the fold is only so a connector written "With" is still
 * recognised. A term of one word is its own head noun, and a term that reduces
 * to nothing yields the empty string, whose `plainto_tsquery` is an empty query
 * that matches nothing — so the head-noun weight simply does not apply. That is
 * the correct outcome rather than a special case: `parseCatalogSearchQuery` has
 * already refused an empty term at the boundary, and `searchPublishedFoods`
 * returns an empty page for one without issuing a statement.
 */
export const SEARCH_ASCII_UPPERCASE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export const SEARCH_ASCII_LOWERCASE = 'abcdefghijklmnopqrstuvwxyz';

/**
 * Case-fold A-Z and nothing else.
 *
 * THE ONE FOLD BOTH SIDES OF THE HEAD-NOUN COMPARISON USE, and the reason it is
 * not `toLowerCase()`. That comparison is made in SQL, between a `to_tsvector`
 * of the food's head noun and a `plainto_tsquery` of the query's — so the head
 * noun is extracted twice, once here in JavaScript for the query and once in
 * `catalog.service.ts` for the name. If the two extractions fold case by
 * different rules they can disagree, and the tier the scorer picks then depends
 * on which side of the comparison a character sat.
 *
 * They did disagree. `'İNCİR'.toLowerCase()` is Unicode's default full
 * case-folding and yields `i` + U+0307 COMBINING DOT ABOVE, while PostgreSQL's
 * `lower()` goes through the database's collation and yields a plain `incir`
 * under `en_US.utf8` — a different string, so the head-noun tier silently
 * failed to fire, and it fired differently again under an ICU collation. Ranks
 * are therefore not reproducible across two independently created databases,
 * which AAP §§0.5.2 and 0.9.3 require them to be. A `COLLATE "C"` on the final
 * text tiebreakers does not help: by then the RANK already differs, and rank is
 * the first key.
 *
 * Folding only A-Z removes the divergence at its source rather than patching
 * one side to imitate the other. The map is 26 characters wide, identical in
 * every collation and in every JavaScript engine, and `catalog.service.ts`
 * builds its SQL `translate()` from these same two exported constants so the
 * two cannot drift apart. Everything beyond A-Z is left exactly as stored and
 * normalised by `to_tsvector`/`plainto_tsquery` at the point of comparison —
 * which applies the SAME text-search configuration to both sides within one
 * database, so `İNCİR` matches `İNCİR` and `INCIR` alike, and does so
 * identically wherever the release is loaded.
 *
 * The narrow cost is deliberate: a connector written with a non-ASCII capital
 * would not be recognised. Every member of {@link SEARCH_HEAD_CONNECTORS} is an
 * ASCII English function word, so no such connector exists.
 */
export const foldSearchAscii = (text: string): string =>
    text.replace(
        /[A-Z]/g,
        (letter) => SEARCH_ASCII_LOWERCASE[SEARCH_ASCII_UPPERCASE.indexOf(letter)],
    );

export const searchQueryHeadNoun = (term: string): string => {
    const headPhrase = SEARCH_HEAD_CONNECTORS.reduce(
        (phrase, connector) => phrase.split(` ${connector} `)[0],
        foldSearchAscii(term).split(',')[0],
    ).trim();
    const lastSpace = headPhrase.lastIndexOf(' ');

    return lastSpace === -1 ? headPhrase : headPhrase.slice(lastSpace + 1);
};

/* ---------------------------------------------------------------------------
 * The suggestions query parser
 * ------------------------------------------------------------------------- */

/**
 * The page policy of `GET /catalog/foods/suggestions`: twelve rows by default,
 * thirty at most (§0.5.2).
 *
 * Named and exported HERE rather than held in the controller for the reason
 * every other bound in this module is a value it owns — a limit is a rule about
 * how much of the catalog one request may draw, and a rule that only exists
 * inside an HTTP adapter cannot be unit-tested or asserted against. The pair is
 * deliberately tighter than the search route's 25/50: these rows are the
 * suggestion chips frame 06 renders all at once, not a page the user scrolls.
 */
export const CATALOG_SUGGESTIONS_DEFAULT_LIMIT = 12;
export const CATALOG_SUGGESTIONS_MAX_LIMIT = 30;

/**
 * The suggestion kinds this endpoint answers — one, `dislike` (§0.5.2:
 * `kind ∈ {'dislike'}`).
 *
 * Declared LOCALLY and deliberately, the same trade `recipe.logic.ts` states
 * for its own field-code vocabulary. `catalog.service.ts` publishes an
 * identical `CatalogSuggestionKind`, but a pure module may not import a service
 * (Rule backend-architecture §2: the dependency runs service → logic and never
 * the reverse), and an import here would additionally put a Prisma-bound module
 * behind every unit test of this file. Both are one-member literal unions over
 * the same word, so what this parser returns is assignable to what
 * `getSuggestions` accepts, and a second kind is a wire contract change that
 * has to be made on both sides whichever way round they are declared.
 */
export type CatalogSuggestionKindRequest = 'dislike';

const SUGGESTION_KIND: CatalogSuggestionKindRequest = 'dislike';
const SUGGESTION_KIND_FIELD = 'kind';

/**
 * The wire vocabulary for a suggestions `details[].code`. Machine-readable
 * only — the client maps the code to its own copy:
 *  - `unsupported` — `kind` is absent, or names something this endpoint does
 *    not answer.
 *
 * One member, because one field on this route can fail and one correction
 * answers every way it can: the contract defines a single kind, so "you sent
 * the wrong one" and "you sent none" ask the caller for the same thing.
 */
const UNSUPPORTED_KIND_CODE = 'unsupported';

export type ParsedCatalogSuggestionsQuery =
    | { kind: 'ok'; suggestionKind: CatalogSuggestionKindRequest; limit: number }
    | CatalogQueryRefusal;

/**
 * Validates `?kind=` and `?limit=` for `GET /catalog/foods/suggestions`.
 *
 * A RETURNED VERDICT, never a throw, like every other answer in this module:
 * the caller is `catalog.controller.ts::getCatalogSuggestionsController`, which
 * owes the client `400 invalid_request` naming the field that failed (§0.5.2),
 * and no status code appears in this layer (Rule backend-architecture §8). The
 * judgement belongs to a pure function at that boundary rather than inline in
 * the handler for two reasons: the controller has to stay
 * `getUserId` → parse → one service call (§0.7.2), and this rule is only
 * testable without HTTP once it lives here.
 *
 * IT MUST PRECEDE THE SERVICE CALL. `getSuggestions` indexes a
 * `Record<CatalogSuggestionKind, Prisma.Sql>` with this value to build its
 * `WHERE` fragment, so a kind nobody checked arrives as an `undefined`
 * fragment — a malformed statement for what is really a bad query string.
 *
 * `kind` is the one refusable field, and everything that is not exactly
 * `dislike` is the same single `unsupported` detail: absent, a different word,
 * a non-string, or a repeated parameter whose first occurrence is not
 * `dislike`.
 *
 * `limit` is DELEGATED to `parsePaginationStrict` rather than parsed again here,
 * so this parser states the bounds and owns no arithmetic that could disagree
 * with the search route's. That helper applies the default only when the field
 * is OMITTED and refuses anything else it cannot serve — a fraction, free text,
 * a blank parameter, zero, a negative number, or a value above the maximum —
 * which is the §0.5.2 contract (`limit` 1 to 30, 12 by default, `400
 * invalid_request` with field codes otherwise). It used to CLAMP instead, so
 * `?limit=31` quietly returned 30 chips with `200 OK` and `?limit=7.9` returned
 * seven, reporting success for a request nobody made (CWE-20).
 *
 * `kind` is still refused FIRST, so a request that gets both fields wrong is
 * told about the one that makes the endpoint unanswerable rather than about its
 * page size. `page` is not part of this endpoint's contract — the suggestion
 * set is one capped page — so it is neither read, refused, nor returned.
 */
export const parseCatalogSuggestionsQuery = (query: unknown): ParsedCatalogSuggestionsQuery => {
    const record = asQueryRecord(query);

    if (firstOccurrence(record[SUGGESTION_KIND_FIELD]) !== SUGGESTION_KIND) {
        return {
            kind: 'error',
            code: 'invalid_request',
            // A server-side diagnostic; the client renders `details`, never
            // this string.
            message: `${SUGGESTION_KIND_FIELD} must be ${SUGGESTION_KIND}`,
            details: [{ field: SUGGESTION_KIND_FIELD, code: UNSUPPORTED_KIND_CODE }],
        };
    }

    const parsedLimit = parsePaginationStrict(
        { limit: record.limit },
        {
            defaultLimit: CATALOG_SUGGESTIONS_DEFAULT_LIMIT,
            maxLimit: CATALOG_SUGGESTIONS_MAX_LIMIT,
        },
    );

    if (parsedLimit.kind !== 'ok') {
        return {
            kind: 'error',
            code: 'invalid_request',
            // A server-side diagnostic; the client renders `details`, never
            // this string.
            message: parsedLimit.message,
            details: parsedLimit.details,
        };
    }

    return { kind: 'ok', suggestionKind: SUGGESTION_KIND, limit: parsedLimit.limit };
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

/**
 * THE REVIEWED EXCEPTION VOCABULARY: words that legitimately LEAD a
 * sentence-case generic catalog name, so their capital carries no information.
 *
 * WHY IT IS NEEDED. Every sentence-case name capitalises its first word, so
 * "Acme bar" and "Protein bar" are the same shape; only the word itself
 * separates a fabricated manufacturer from a food. {@link findBrandPatternMatch}
 * therefore fires on a leading proper noun with a product form after it UNLESS
 * the word is in this list, which is what lets the check reject "Acme bar"
 * without rejecting the generic preparations AI generation exists to propose
 * (AAP §0.7.3).
 *
 * THE ADMISSION CRITERION, so the list can be extended by the same rule it was
 * built with: a word earns a place here when it names a food, an ingredient, a
 * preparation or a meal occasion — something any producer's product could be
 * made of or eaten at. A word that names a MAKER, or that only markets one,
 * does not: "classic", "original", "premium", "select" and "signature" are
 * deliberately absent, and so is any cookware or process noun a brand is built
 * on ("Kettle"), because those are exactly the leading words a fabricated brand
 * uses.
 *
 * Vocabulary rather than a threshold, so it lives in this module beside
 * {@link DEFAULT_BRAND_WORDS} and {@link DEFAULT_PRODUCT_FORM_WORDS} and can be
 * replaced through {@link BrandPatternOptions.genericLeadWords} without a code
 * change. Like those two it is not in `data/meal-planning/coverage-plan.v1.json`
 * — that document describes the catalog's CONTENT and carries no naming
 * vocabulary, which is why {@link CatalogValidationPolicy} declares no list for
 * it either.
 *
 * The food and ingredient entries are the words of the coverage plan's own
 * 123-value `food_group` taxonomy and its 21 category codes (`bell_pepper`,
 * `dairy_alternative`, `nut_seed` …), extended with the everyday ingredient
 * nouns that taxonomy groups rather than names. Taking them from the catalog's
 * own vocabulary is deliberate: a word the catalog files foods under cannot
 * sensibly be read as a manufacturer.
 */
export const DEFAULT_GENERIC_LEAD_WORDS: readonly string[] = [
    // Food groups, ingredients, and the generic nouns a preparation is named
    // for ("Trail mix").
    'almond',
    'anchovy',
    'apple',
    'apricot',
    'artichoke',
    'asparagus',
    'avocado',
    'bacon',
    'bakery',
    'banana',
    'barley',
    'basil',
    'bean',
    'beef',
    'beet',
    'berry',
    'beverage',
    'biscuit',
    'blueberry',
    'bread',
    'broccoli',
    'broth',
    'butter',
    'cabbage',
    'candy',
    'cantaloupe',
    'carrot',
    'cashew',
    'cauliflower',
    'celery',
    'cheese',
    'cherry',
    'chicken',
    'chickpea',
    'chili',
    'chive',
    'chocolate',
    'cilantro',
    'citrus',
    'coconut',
    'coffee',
    'condiment',
    'corn',
    'couscous',
    'cracker',
    'cranberry',
    'cream',
    'crustacean',
    'cucumber',
    'dairy',
    'date',
    'dill',
    'dressing',
    'duck',
    'egg',
    'eggplant',
    'farro',
    'fig',
    'fish',
    'flatbread',
    'flour',
    'fruit',
    'garlic',
    'ginger',
    'grain',
    'granola',
    'grape',
    'grapefruit',
    'green',
    'herb',
    'honey',
    'hummus',
    'juice',
    'kale',
    'kefir',
    'kimchi',
    'kiwi',
    'lamb',
    'leek',
    'legume',
    'lemon',
    'lentil',
    'lettuce',
    'lime',
    'mango',
    'maple',
    'mayonnaise',
    'meal',
    'meat',
    'melon',
    'milk',
    'millet',
    'mint',
    'miso',
    'mollusk',
    'mushroom',
    'mustard',
    'noodle',
    'nut',
    'oat',
    'oatmeal',
    'oil',
    'okra',
    'olive',
    'onion',
    'orange',
    'oregano',
    'papaya',
    'parsley',
    'parsnip',
    'pasta',
    'pastry',
    'pea',
    'peach',
    'peanut',
    'pear',
    'pecan',
    'pepper',
    'pickle',
    'pineapple',
    'pistachio',
    'pizza',
    'plantain',
    'plum',
    'popcorn',
    'pork',
    'potato',
    'poultry',
    'protein',
    'prune',
    'pumpkin',
    'quinoa',
    'radish',
    'raisin',
    'raspberry',
    'rice',
    'rosemary',
    'rye',
    'sage',
    'salad',
    'salmon',
    'salsa',
    'sandwich',
    'sauce',
    'sausage',
    'seafood',
    'seed',
    'seitan',
    'sesame',
    'shrimp',
    'snack',
    'soup',
    'soy',
    'soybean',
    'spice',
    'spinach',
    'sprout',
    'squash',
    'strawberry',
    'sunflower',
    'sweetener',
    'syrup',
    'tahini',
    'tapioca',
    'taro',
    'tea',
    'tempeh',
    'thyme',
    'tofu',
    'tomato',
    'tortilla',
    'trail',
    'tuna',
    'turkey',
    'turnip',
    'vegetable',
    'vinegar',
    'walnut',
    'watermelon',
    'wheat',
    'yam',
    'yogurt',
    'zucchini',

    // Preparation, process and cut words — what was DONE to the food, which is
    // how a generic preparation is distinguished from another ("Roasted carrot
    // coins", "Smoked paprika blend").
    'baked',
    'blanched',
    'boiled',
    'braised',
    'breaded',
    'brewed',
    'broiled',
    'canned',
    'chilled',
    'chopped',
    'cooked',
    'creamed',
    'crushed',
    'cubed',
    'cured',
    'diced',
    'drained',
    'dried',
    'fermented',
    'fresh',
    'fried',
    'frozen',
    'glazed',
    'grated',
    'grilled',
    'ground',
    'instant',
    'jarred',
    'marinated',
    'mashed',
    'milled',
    'minced',
    'mixed',
    'packed',
    'peeled',
    'pickled',
    'poached',
    'powdered',
    'prepared',
    'pressed',
    'puffed',
    'pureed',
    'raw',
    'refried',
    'rendered',
    'roasted',
    'rolled',
    'salted',
    'sauteed',
    'scrambled',
    'seared',
    'seasoned',
    'seeded',
    'shelled',
    'shredded',
    'sliced',
    'smoked',
    'soaked',
    'sprouted',
    'steamed',
    'stewed',
    'stuffed',
    'sweetened',
    'toasted',
    'unsalted',
    'unsweetened',
    'whipped',

    // Meal occasions and courses — when it is eaten ("Breakfast cereal").
    'appetizer',
    'breakfast',
    'brunch',
    'dessert',
    'dinner',
    'entree',
    'lunch',
    'side',
    'starter',
    'supper',

    // Composition, diet and portion qualifiers — a factual claim about the food
    // rather than a name for it ("Low sodium vegetable blend").
    'cold',
    'diet',
    'energy',
    'extra',
    'fortified',
    'gluten',
    'high',
    'hot',
    'large',
    'light',
    'low',
    'medium',
    'mild',
    'mini',
    'natural',
    'nonfat',
    'nutrition',
    'organic',
    'plain',
    'reduced',
    'regular',
    'savory',
    'savoury',
    'skim',
    'small',
    'spicy',
    'sweet',
    'vegan',
    'vegetarian',
    'warm',
    'whole',
    'wholegrain',
    'wholemeal',
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
    /**
     * Replaces {@link DEFAULT_GENERIC_LEAD_WORDS}: the words whose leading
     * capital is English rather than branding. A caller that narrows this list
     * makes the check STRICTER, because every leading proper noun outside it is
     * treated as an unknown maker.
     */
    readonly genericLeadWords?: readonly string[];
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
 * capitalised word with a product form, so the discriminator is the WORD, and
 * where in the name it sits:
 *
 *  * a proper noun that is not the first word is a brand wherever a product
 *    form follows it, in any casing — "granola Kettle crunch" names a product,
 *    and no generic preparation capitalises a word mid-name;
 *  * a proper noun that IS the first word is a brand wherever a product form
 *    follows it and the word is NOT in the reviewed generic vocabulary
 *    {@link DEFAULT_GENERIC_LEAD_WORDS} — "Acme bar", "Nova drink" and "Zesta
 *    crisps" name nothing a food could be made of, while "Protein bar",
 *    "Orange juice" and "Breakfast cereal" lead with a word the catalog itself
 *    files foods under, and their first capital carries no information at all;
 *  * a reviewed generic word leading the name still fires when the product form
 *    after it is capitalised too ("Rice Cereal"). Title case is not how this
 *    pipeline writes a generic — the generator states a sentence-case display
 *    name and a lowercase canonical name — so in this corpus the casing is the
 *    anomaly worth a human's attention, and the matched token is recorded.
 *
 * The AAP states the rule as "capitalised proper noun followed by a product
 * form" with no condition on the form's own casing (§0.7.3), and this is that
 * rule: sentence case is the normal way to write both a food and a fabricated
 * product, so the form's casing was never able to separate them.
 *
 * What this cannot catch, stated so nobody reads more into it. Two residuals
 * remain, and both are narrower than the sentence-case gap that used to sit
 * here. A fabricated brand that IS a reviewed generic word ("Protein bar", sold
 * by someone called Protein) is admitted, because the same words name real
 * foods and refusing them would refuse the generic preparations generation
 * exists to propose; and a fabricated brand carrying no product form at all
 * ("Acme tomatoes, raw") is admitted, because a leading capital on its own is
 * every sentence-case name's first letter and proves nothing. Standing behind
 * both: the curated brand-word list, which names makers outright, and the
 * `unsourced` quarantine — a candidate no allowlisted evidence names never
 * publishes, whoever it claims to be.
 */
export const findBrandPatternMatch = (
    values: readonly string[],
    options: BrandPatternOptions = {},
): BrandPatternMatch | null => {
    const brandWords = new Set((options.brandWords ?? DEFAULT_BRAND_WORDS).map((word) => word.toLowerCase()));
    const productForms = new Set(
        (options.productFormWords ?? DEFAULT_PRODUCT_FORM_WORDS).map((word) => word.toLowerCase()),
    );
    const genericLeadWords = new Set(
        (options.genericLeadWords ?? DEFAULT_GENERIC_LEAD_WORDS).map((word) => word.toLowerCase()),
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
            // position 0 the capital alone is not evidence — the WORD is: a
            // leading proper noun outside the reviewed generic vocabulary names
            // no food, and a product form after it in any casing makes the name
            // a product ("Acme bar"). A reviewed generic word leading the name
            // keeps the narrower title-case trigger, which is the casing
            // anomaly this pipeline's own generic names never carry. Anywhere
            // else the mid-name capital is itself the evidence and the form's
            // casing is immaterial.
            const leadIsReviewedGeneric =
                properNoun.position === 0 && genericLeadWords.has(properNoun.normalized);

            const form = nameWords
                .slice(properNoun.position + 1)
                .find(
                    (word) =>
                        productForms.has(word.normalized) &&
                        (!leadIsReviewedGeneric || CAPITALISED_WORD_PATTERN.test(word.text)),
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
 * The tag vocabularies — allergen codes, diet codes, and their consistency
 *
 * `catalog_foods.allergen_tags` and `catalog_foods.diet_tags` are `TEXT[]` with
 * no Prisma enum and no CHECK constraint, and both are SAFETY metadata rather
 * than description: the planner excludes a recipe whose ingredient tags
 * intersect the user's selected allergens, and `recipe.logic.ts` derives a
 * dish's diet compatibility from its ingredients' diet tags (AAP §0.7.3
 * eligibility). Two consequences follow, and they are why this vocabulary is
 * code and not prose:
 *
 *  * A code outside the vocabulary MATCHES NOTHING. It does not fail loudly
 *    downstream — it reads as "this food declares no such allergen", which is
 *    the one direction of error that reaches a plate.
 *  * A diet claim that contradicts the food's own allergen list is false
 *    whichever half is wrong, so it cannot be repaired by publishing it and
 *    hoping.
 *
 * The two vocabularies are DECLARED here and asserted against the data that
 * also declares them (`catalog.logic.test.ts` compares both, in both
 * directions, with `data/meal-planning/usda-manifest.v1.json`'s
 * `sweepAllergenDietRules.allergenVocabulary` and `dietTagVocabulary`), so a
 * drift between the import's derivation rules and the validator's judgement
 * fails a test instead of shipping an unmatchable tag. The allergen spellings
 * are additionally the ones `preferences.logic.ts::NAMED_ALLERGENS` stores
 * from the user's own selection: the two lists are compared to each other at
 * planning time, so a difference of spelling between them would be a silent
 * failure to exclude.
 * ------------------------------------------------------------------------- */

/**
 * The nine allergen codes a catalog food may carry, in the order the manifest
 * and `preferences.logic.ts` declare them (the FDA/FALCPA major allergens as
 * this product tracks them, sesame included).
 */
export type CatalogAllergenTag =
    | 'milk'
    | 'eggs'
    | 'peanuts'
    | 'tree_nuts'
    | 'soy'
    | 'wheat'
    | 'fish'
    | 'shellfish'
    | 'sesame';

const allergenTagSet = closedSet<CatalogAllergenTag>({
    milk: true,
    eggs: true,
    peanuts: true,
    tree_nuts: true,
    soy: true,
    wheat: true,
    fish: true,
    shellfish: true,
    sesame: true,
});

/**
 * The allergen vocabulary, and the array a JSON-schema `enum` is built from at
 * the generation boundary — an exported list rather than a literal repeated in
 * a prompt schema, so the model is constrained by the same nine values this
 * module judges against.
 */
export const CATALOG_ALLERGEN_TAGS: readonly CatalogAllergenTag[] = allergenTagSet.values;

/**
 * Exact-spelling membership, like every other guard in this module: it answers
 * "is this string the canonical code?" and nothing else.
 * {@link classifyCatalogTagSets} is what resolves a STORED spelling to a code,
 * because a stored value has to be judged the way its consumers read it.
 */
export const isCatalogAllergenTag: (value: unknown) => value is CatalogAllergenTag =
    allergenTagSet.includes;

/**
 * The four diet codes a catalog food may carry.
 *
 * `pescatarian`, and never `pescatarian_ok`: that spelling is the only one
 * `recipe.logic.ts` emits from `DIET_TAG_IMPLICATIONS` and the only one
 * `isDietCompatible('pescatarian', …)` matches, and the manifest records that
 * an earlier revision of its own rules spelled it `pescatarian_ok` — which
 * silently excluded every fish and seafood food, and therefore every seafood
 * recipe, from every pescatarian user's plan, because such a food carries no
 * `vegetarian` tag for the implication closure to rescue.
 */
export type CatalogDietTag = 'vegan' | 'vegetarian' | 'pescatarian' | 'gluten_free';

const dietTagSet = closedSet<CatalogDietTag>({
    vegan: true,
    vegetarian: true,
    pescatarian: true,
    gluten_free: true,
});

/** The diet vocabulary, and the other JSON-schema `enum` source. */
export const CATALOG_DIET_TAGS: readonly CatalogDietTag[] = dietTagSet.values;

/** Exact-spelling membership; see {@link isCatalogAllergenTag}. */
export const isCatalogDietTag: (value: unknown) => value is CatalogDietTag = dietTagSet.includes;

/**
 * The one tag normalisation, and it is deliberately the SAME one every consumer
 * compares with: `recipe.logic.ts::tagKey`, `isDietCompatible` and the
 * ingredient allergen union all key on `normalizeCanonicalName`, so
 * `Gluten Free` and `gluten_free` are one tag to them.
 *
 * Judging membership on the same key is what makes this check honest in both
 * directions: a spelling those functions would match is not reported as
 * unmatchable, and a spelling they would not match is.
 */
const tagKey = (tag: string): string => normalizeCanonicalName(tag);

const allergenTagByKey: ReadonlyMap<string, CatalogAllergenTag> = new Map(
    CATALOG_ALLERGEN_TAGS.map((tag) => [tagKey(tag), tag] as const),
);

const dietTagByKey: ReadonlyMap<string, CatalogDietTag> = new Map(
    CATALOG_DIET_TAGS.map((tag) => [tagKey(tag), tag] as const),
);

/** One diet claim and the allergen codes that make it untrue. */
export interface CatalogDietTagExclusion {
    readonly dietTag: CatalogDietTag;
    readonly excludedAllergenTags: readonly CatalogAllergenTag[];
}

/**
 * The contradictions, and ONLY these.
 *
 * Each row is an exclusion the allergen vocabulary can actually express:
 * a vegan food contains no dairy, egg, fish or shellfish; a vegetarian food
 * contains no fish or shellfish (dairy and eggs are vegetarian); a gluten-free
 * food contains no wheat.
 *
 * Deliberately NOT an implication closure. `vegan` without `vegetarian` is
 * INCOMPLETE, not false — `recipe.logic.ts` closes a tag set under
 * `DIET_TAG_IMPLICATIONS` when it derives one, so the missing member is added
 * where it matters and rejecting the row would reject correct data. This module
 * judges what a list ASSERTS, never what it omits.
 */
export const CATALOG_DIET_TAG_EXCLUSIONS: readonly CatalogDietTagExclusion[] = [
    { dietTag: 'vegan', excludedAllergenTags: ['milk', 'eggs', 'fish', 'shellfish'] },
    { dietTag: 'vegetarian', excludedAllergenTags: ['fish', 'shellfish'] },
    { dietTag: 'gluten_free', excludedAllergenTags: ['wheat'] },
];

/** One contradiction found: the claim, and the allergen code that refutes it. */
export interface CatalogTagContradiction {
    readonly dietTag: CatalogDietTag;
    readonly allergenTag: CatalogAllergenTag;
}

/**
 * The two lists as a caller holds them BEFORE they are trusted: `unknown[]`,
 * because a model payload and a `TEXT[]` column can both carry a non-string,
 * and an absent member means the list was not supplied at all.
 */
export interface CatalogTagSetInput {
    readonly allergenTags?: readonly unknown[] | null;
    readonly dietTags?: readonly unknown[] | null;
}

/**
 * The codes a tag list resolved to, in VOCABULARY order rather than the order
 * they arrived in: a persisted array whose order depended on a model's output
 * would read as a metadata change on the next run.
 */
export interface CatalogResolvedTagSets {
    readonly allergenTags: readonly CatalogAllergenTag[];
    readonly dietTags: readonly CatalogDietTag[];
}

/**
 * The classifier's answer. `ok` means every supplied entry named a code and the
 * two lists agree, so `allergenTags`/`dietTags` are the canonical values a
 * caller may persist; `violation` names what was wrong, with unknown codes and
 * contradictions reported SEPARATELY because they are different faults with
 * different fixes — one is a vocabulary the producer does not know, the other
 * is a claim it got wrong.
 */
export type CatalogTagClassification =
    | ({ readonly kind: 'ok' } & CatalogResolvedTagSets)
    | ({
          readonly kind: 'violation';
          /** The offending `allergen_tags` entries, as text, de-duplicated and sorted. */
          readonly unknownAllergenTags: readonly string[];
          /** The offending `diet_tags` entries, same treatment. */
          readonly unknownDietTags: readonly string[];
          readonly contradictions: readonly CatalogTagContradiction[];
      } & CatalogResolvedTagSets);

/**
 * How an off-vocabulary entry is NAMED in a validation record: its own trimmed
 * text, or its type when it is not text at all.
 *
 * A record has to identify the value an operator must fix, and `observed:
 * "[object Object]"` identifies nothing. Blank and non-string entries get a
 * parenthesised label because they have no text to quote — and they are
 * reported rather than dropped, since a producer emitting `null` into a tag
 * array is exactly the bug this check exists to surface.
 */
const renderTagEntry = (value: unknown): string => {
    if (typeof value !== 'string') {
        return `(${value === null ? 'null' : typeof value})`;
    }

    const trimmed = value.trim();

    return trimmed.length === 0 ? '(blank)' : trimmed;
};

interface ClassifiedTagList<T extends string> {
    readonly resolved: readonly T[];
    readonly unknown: readonly string[];
}

/**
 * One list, resolved against one vocabulary.
 *
 * De-duplication is by KEY, not by text, so `['Milk', 'milk']` is one allergen
 * rather than two — the consumers would read it as one, and a validation record
 * claiming two would misdescribe the food. An entry whose key is empty (`'--'`,
 * `'   '`) is unknown rather than skipped: it is unmatchable, which is the
 * fault being reported, and `recipe.logic.ts::collectTags` drops such a tag for
 * the same reason.
 */
const classifyTagList = <T extends string>(
    entries: readonly unknown[] | null | undefined,
    byKey: ReadonlyMap<string, T>,
    vocabulary: readonly T[],
): ClassifiedTagList<T> => {
    const resolvedKeys = new Set<string>();
    const unknown = new Set<string>();

    for (const entry of entries ?? []) {
        const key = typeof entry === 'string' ? tagKey(entry) : '';
        const code = key.length === 0 ? undefined : byKey.get(key);

        if (code === undefined) {
            unknown.add(renderTagEntry(entry));
            continue;
        }

        resolvedKeys.add(key);
    }

    return {
        resolved: vocabulary.filter((tag) => resolvedKeys.has(tagKey(tag))),
        unknown: [...unknown].sort(),
    };
};

/**
 * Judges one food's two tag lists: every entry must name a code in its
 * vocabulary, and the diet claims must not contradict the allergen list.
 *
 * PURE and exported so the producing stage can call it AT PARSE TIME and refuse
 * a candidate before it is persisted — which is the only place the fault can be
 * fixed cheaply. `catalog-generate-ai.ts` reads model-supplied `allergenTags`
 * and `dietTags` as free strings and writes them verbatim; a refusal there
 * costs one candidate, while the same value stored costs a re-validation, a
 * re-release and, until then, a food whose safety metadata cannot be matched.
 * `validateCatalogCandidate` applies the same rules again for the validation
 * record, which is the audit trail rather than the gate — the same division
 * `findBrandPatternMatch` already has with the brand refusal.
 *
 * A list that was not supplied (`undefined`, or `null` for a JSON record whose
 * column was absent) contributes nothing: it is not an empty list, and no
 * contradiction can be drawn from a list nobody provided. The caller decides
 * what an unavailable input means for its own verdict — this function only ever
 * reports what the values it was given say.
 */
export const classifyCatalogTagSets = (input: CatalogTagSetInput): CatalogTagClassification => {
    const allergens = classifyTagList(input.allergenTags, allergenTagByKey, CATALOG_ALLERGEN_TAGS);
    const diets = classifyTagList(input.dietTags, dietTagByKey, CATALOG_DIET_TAGS);

    const carried = new Set<CatalogAllergenTag>(allergens.resolved);
    const claimed = new Set<CatalogDietTag>(diets.resolved);
    const contradictions: CatalogTagContradiction[] = [];

    for (const exclusion of CATALOG_DIET_TAG_EXCLUSIONS) {
        if (!claimed.has(exclusion.dietTag)) {
            continue;
        }

        for (const allergenTag of exclusion.excludedAllergenTags) {
            if (carried.has(allergenTag)) {
                contradictions.push({ dietTag: exclusion.dietTag, allergenTag });
            }
        }
    }

    const resolved: CatalogResolvedTagSets = {
        allergenTags: allergens.resolved,
        dietTags: diets.resolved,
    };

    if (allergens.unknown.length === 0 && diets.unknown.length === 0 && contradictions.length === 0) {
        return { kind: 'ok', ...resolved };
    }

    return {
        kind: 'violation',
        ...resolved,
        unknownAllergenTags: allergens.unknown,
        unknownDietTags: diets.unknown,
        contradictions,
    };
};

/**
 * One contradiction as a validation record states it — the claim first, because
 * the claim is the part that is refuted.
 */
export const describeCatalogTagContradiction = (contradiction: CatalogTagContradiction): string =>
    `${contradiction.dietTag} with ${contradiction.allergenTag}`;

/**
 * The consistency rule as the `bound` of a recorded check, derived from
 * {@link CATALOG_DIET_TAG_EXCLUSIONS} rather than written out, so an added
 * exclusion cannot leave records describing the rule they were judged against
 * wrongly.
 */
const CATALOG_TAG_CONSISTENCY_RULE: string = CATALOG_DIET_TAG_EXCLUSIONS.map(
    (exclusion) => `${exclusion.dietTag} excludes ${exclusion.excludedAllergenTags.join(', ')}`,
).join('; ');


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
    /**
     * The diet claims stored for this food (`catalog_foods.diet_tags`).
     *
     * Judged rather than trusted: both tag lists are SAFETY METADATA the
     * planner filters on — the allergens through the user's selection and the
     * diet through `recipe.logic.ts`'s ingredient derivation — so a code
     * outside the vocabulary cannot be matched by either, and a list that
     * contradicts the allergen list is a claim about the food that cannot be
     * true. Optional because a caller that reads no diet column has nothing to
     * judge, and a check whose input is unavailable is omitted rather than
     * recorded as a pass.
     */
    diet_tags?: readonly string[];
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
 * The advisory second-model review, as it is RECORDED.
 *
 * ADVISORY, without exception, and the exception is closed structurally rather
 * than promised: NO function in this module accepts one. There is no parameter
 * to pass it to, so no model answer can reach a check, a tier, a nutrient or a
 * disposition — which is what "an AI plausibility review is never presented as
 * verified nutrition" means when it is enforced by the type system instead of
 * by a convention (Agent Action Plan §0.1.2, and §0.7.3's provenance model:
 * "an advisory second-model review writes `llm_review` flags and never
 * promotes values").
 *
 * The shape lives here because `catalog_validation_records.llm_review` is a
 * field of the record this module's verdict fills in, and one home for it
 * keeps `catalog-validate.ts` from declaring a second. The only thing that may
 * move a REVIEW-tier hold is an explicit curator decision
 * ({@link CatalogValidationContext.curatorAllowlistedCheckNames}).
 */
export interface CatalogAdvisoryReview {
    /**
     * Review-tier check names a second model examined and found plausible.
     *
     * Recorded for a CURATOR to read. It lifts nothing on its own: a candidate
     * held by a review-tier flag stays held until a curator allowlists the
     * value, whatever a model answered about it.
     */
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
    /**
     * Review-tier check names a curator has allowlisted for this candidate.
     *
     * THE ONLY INPUT THAT CAN MOVE A REVIEW-TIER HOLD. There is deliberately no
     * sibling field for the advisory model review: see
     * {@link CatalogAdvisoryReview} for why the absence is the guarantee.
     */
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
    /** See {@link CatalogValidationContext.curatorAllowlistedCheckNames}. */
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
 *    `out_of_category_range`) until a CURATOR allowlists the value.
 *
 * A CURATOR, AND NOTHING ELSE. The advisory second-model review is recorded in
 * `catalog_validation_records.llm_review` and cannot appear here: this function
 * takes no advisory parameter, so there is no path by which a model's
 * plausibility answer becomes a publication decision (Agent Action Plan §0.1.2
 * — "NEVER present AI-generated values or an AI plausibility review as
 * verified nutrition" — and §0.7.3, where the advisory review "never promotes
 * values"). A generated candidate whose nutrition sits outside its category
 * band is an AI-derived value, and publishing it on a model's own word would
 * make the review the source of the very claim it was asked to assess.
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

    // One source of lifts, and it is a human decision. An advisory review is
    // not in this set because it is not an input to this function at all.
    const lifted = new Set(input.curatorAllowlistedCheckNames ?? []);
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

/**
 * The two tag judgements, over {@link classifyCatalogTagSets}.
 *
 * Which of them is EVALUABLE depends on which lists the caller supplied, and
 * the module's convention decides the rest: a check whose input is unavailable
 * is absent from the record rather than recorded as a pass.
 *
 *  * `unknown_tag_code` needs at least one list — every entry of a supplied
 *    list is judged, and a list nobody supplied contributes no entries.
 *  * `inconsistent_tag_set` needs BOTH, because it is a statement about their
 *    agreement. A candidate carrying diet claims whose allergen list was never
 *    read has not been shown to be consistent, and recording that as a pass
 *    would be the strongest claim in the record resting on the least evidence.
 *
 * An empty supplied list is an ANSWER, not an absence: `allergen_tags: []` says
 * "no allergens", which is a claim the checks judge (and which nothing here
 * contradicts). That distinction is why the guard tests `undefined`/`null`
 * rather than length, exactly as `duplicateOfSourceKey` distinguishes "did not
 * run" from "ran and found none".
 */
const tagVocabularyChecks = (candidate: CatalogFoodCandidate): CatalogValidationCheck[] => {
    const allergenTagsSupplied = candidate.allergen_tags !== undefined && candidate.allergen_tags !== null;
    const dietTagsSupplied = candidate.diet_tags !== undefined && candidate.diet_tags !== null;

    if (!allergenTagsSupplied && !dietTagsSupplied) {
        return [];
    }

    const classification = classifyCatalogTagSets({
        allergenTags: allergenTagsSupplied ? candidate.allergen_tags : undefined,
        dietTags: dietTagsSupplied ? candidate.diet_tags : undefined,
    });

    // Each offending value is prefixed with the column it came from: the two
    // vocabularies are disjoint, so an operator reading `vegan` in an
    // `allergen_tags` list needs to be told which list to go and fix.
    const unknown =
        classification.kind === 'violation'
            ? [
                  ...classification.unknownAllergenTags.map((entry) => `allergen_tags: ${entry}`),
                  ...classification.unknownDietTags.map((entry) => `diet_tags: ${entry}`),
              ]
            : [];

    // The bound names only the vocabularies that were actually judged, so the
    // record does not imply a list was checked when it was never supplied.
    const judgedVocabularies = [
        allergenTagsSupplied ? `allergen_tags in (${CATALOG_ALLERGEN_TAGS.join(', ')})` : null,
        dietTagsSupplied ? `diet_tags in (${CATALOG_DIET_TAGS.join(', ')})` : null,
    ].filter((part): part is string => part !== null);

    const checks: CatalogValidationCheck[] = [
        buildCheck(
            CATALOG_CHECK_NAMES.UNKNOWN_TAG_CODE,
            unknown.length === 0,
            unknown.length === 0 ? null : unknown.join('; '),
            judgedVocabularies.join('; '),
        ),
    ];

    if (allergenTagsSupplied && dietTagsSupplied) {
        const contradictions = classification.kind === 'violation' ? classification.contradictions : [];

        checks.push(
            buildCheck(
                CATALOG_CHECK_NAMES.INCONSISTENT_TAG_SET,
                contradictions.length === 0,
                contradictions.length === 0
                    ? null
                    : contradictions.map(describeCatalogTagContradiction).join(', '),
                CATALOG_TAG_CONSISTENCY_RULE,
            ),
        );
    }

    return checks;
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

    // Beside the other judgements of STATED values, and before the nutrition
    // conversion: the tag lists are metadata the conversion neither reads nor
    // affects, and a candidate whose basis cannot be converted still has a tag
    // set that is either matchable or not.
    checks.push(...tagVocabularyChecks(candidate));

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

/* ---------------------------------------------------------------------------
 * Component coverage — what makes an EMPTY components export an asserted fact
 * ------------------------------------------------------------------------- */

/**
 * `ingredient_derived`, tied to the union rather than written as a bare
 * literal, so renaming the member is a compile error here instead of a rule
 * that quietly stops matching anything — which is the exact failure mode this
 * section exists to make impossible.
 */
const DERIVES_FROM_COMPOSITION: NutritionProvenance = 'ingredient_derived';

/**
 * The per-food facts the component-coverage rule turns on.
 *
 * `nutrition_provenance` is a plain `string` and not {@link NutritionProvenance}
 * on purpose. It arrives from a TEXT column — the schema declares no enums, so
 * every enumeration in this domain is validated here rather than by the
 * database — and a parameter demanding the union would be satisfied by a cast
 * at the call site, which is precisely where a value the database really holds
 * gets asserted out of existence. Read as text, an unrecognised value declares
 * no composition, and needing none is the correct answer for it.
 */
export interface CatalogComponentCoverageFacts {
    /**
     * The portable identity, repeated verbatim in the verdict: a refusal has to
     * name a food the operator can find in the release, and a local uuid means
     * nothing in another database.
     */
    readonly source_key: string;
    readonly nutrition_provenance: string;
    /**
     * How many of this food's component rows RESOLVE to a component food. A row
     * pointing at a food the set does not contain is not a composition —
     * nothing can be derived from it — so an unresolved row must not be counted
     * here, and the caller is the only layer that can tell the difference.
     */
    readonly resolvable_component_count: number;
}

/** The verdict of {@link assessComponentCoverage}. */
export interface CatalogComponentCoverage {
    /** True when no derived food is missing its composition. */
    readonly ok: boolean;
    /**
     * The `source_key` of every derived food carrying no resolvable
     * composition, sorted, so a refusal message reads the same whatever order
     * the rows were supplied in.
     */
    readonly derivedWithoutComponents: readonly string[];
    /**
     * How many of the supplied foods derive their nutrition from a stored
     * composition. This is the number a release manifest publishes beside its
     * component row count, and taking both from one verdict is what makes the
     * two incapable of disagreeing.
     */
    readonly derivedCount: number;
}

/**
 * Whether every food that DERIVES its nutrition carries a composition to derive
 * it from — the rule that turns a zero-row component export into an asserted
 * fact rather than a blank.
 *
 * A component row is the composition of an ingredient-derived food, so the set
 * of component rows is empty exactly when no supplied food derives its
 * nutrition. Stated the other way round: a derived food with no composition has
 * nothing its nutrient totals could have been computed FROM, so those totals
 * are unsourced and whatever was about to consume them must refuse.
 *
 * Why the rule is needed at all. An empty component export and an export that
 * silently dropped every row are indistinguishable on disk and in a manifest,
 * because the digest of an empty file verifies either way. That is the one
 * ambiguity a reviewer cannot resolve by reading the artefact. This predicate
 * resolves it by making the count a derived consequence — 0 rows is provably
 * correct when, and only when, no derived food is present — and
 * {@link CatalogComponentCoverage.derivedCount} is the companion number that
 * says so out loud.
 *
 * The opposite repair is forbidden and deliberately not offered here: inventing
 * a composition so the export has rows would fabricate a nutrient total, which
 * the catalog policy and the feature's nutrition-integrity requirement both
 * rule out outright.
 *
 * Matching is EXACT on the canonical provenance spelling. Loosening it to
 * tolerate variants is not a safety net — it is how a mis-spelled stored value
 * stops being visible, and this domain has already paid once for a tag that
 * only one spelling matched. A non-finite or non-positive component count is
 * read as no composition, so a miscount can only ever make the rule stricter.
 */
export const assessComponentCoverage = (
    foods: readonly CatalogComponentCoverageFacts[],
): CatalogComponentCoverage => {
    const derived = foods.filter((food) => food.nutrition_provenance === DERIVES_FROM_COMPOSITION);

    const derivedWithoutComponents = derived
        .filter(
            (food) =>
                !Number.isFinite(food.resolvable_component_count) ||
                food.resolvable_component_count <= 0,
        )
        .map((food) => food.source_key)
        .sort();

    return {
        ok: derivedWithoutComponents.length === 0,
        derivedWithoutComponents,
        derivedCount: derived.length,
    };
};

/* ---------------------------------------------------------------------------
 * Evidence artefacts — which run's write may replace which run's evidence
 * ------------------------------------------------------------------------- */

/**
 * The block every writer of a committed evidence artefact records its target's
 * identity in, and the field inside it that carries the digest.
 *
 * WHY THIS EXISTS AT ALL. `data/meal-planning/reports/latest/import-report.json`
 * and `validation-report.json` are co-written by `catalog:import`,
 * `catalog:generate`, `catalog:validate` and `catalog:report`, each merging its
 * own half over what it finds. Every one of those merges was unconditional, and
 * the artefacts deliberately record `environment.valuesRecorded: "none —
 * environment variable names only, never their values"` — so nothing in either
 * file said WHICH database it described, and a run pointed at another one
 * merged its figures into the same document undetectably. QA produced exactly
 * that: a report run against database A, a validate run against B and a
 * generation run against C left one committed artefact whose `requirement` came
 * from A, whose `counts` came from B and whose generation block came from C,
 * with nothing in the file able to say so.
 *
 * WHY A DIGEST AND NOT THE NAME. The host and the database name are
 * infrastructure topology, and these artefacts are committed and copied into CI
 * output, so recording them would publish an organisation's internal topology
 * (CWE-532) — which is the same argument `scripts/lib/dbGuard.ts` makes for
 * logging `targetDigest` instead of the target. The digest answers the one
 * question an artefact needs answered — were two writes pointed at the same
 * database — and cannot answer any other.
 */
export const CATALOG_ARTIFACT_TARGET_IDENTITY_KEY = 'targetIdentity';
export const CATALOG_ARTIFACT_TARGET_DIGEST_FIELD = 'targetDigest';

/**
 * The digest value that means "the writing run could not name its target".
 *
 * Identical to what `scripts/lib/logger.ts`'s `opaqueDigest` returns for an
 * empty input, because that is exactly where it comes from: a run whose
 * `DATABASE_URL` fixes no host and no database name hashes an empty string.
 * Such a value is NOT an identity, so it is read as no recorded identity at all
 * rather than as a target that differs from every real one.
 */
export const CATALOG_ARTIFACT_UNIDENTIFIED_TARGET = 'none';

/**
 * What a write found when it compared its own target with the one the artefact
 * on disk records.
 *
 *   * `first_write` — nothing is at that path, so there is no claim to contradict.
 *   * `adopted`     — the artefact records no usable digest. Every artefact
 *                     committed before this mechanism existed is in this state,
 *                     so it is ADOPTED and not refused: refusing here would
 *                     break the legitimate pipeline until somebody re-published
 *                     every report, and no committed file may need editing to
 *                     accommodate a code change.
 *   * `agrees`      — the recorded digest is this run's.
 *   * `differs`     — the recorded digest is some other database's. This is the
 *                     case the mechanism exists for, and the only one that
 *                     refuses.
 */
export type CatalogArtifactTargetVerdict = 'first_write' | 'adopted' | 'agrees' | 'differs';

export interface CatalogArtifactTargetDecision {
    readonly verdict: CatalogArtifactTargetVerdict;
    /** The digest the artefact records, or `null` when it records none usable. */
    readonly recordedDigest: string | null;
    /** This run's own digest, which the write records. */
    readonly runDigest: string;
    /**
     * Whether the write may proceed.
     *
     * Derived here rather than at each of the three call sites: "which verdicts
     * permit a write" is one rule, and three stages re-deriving it from the
     * verdict union is how one of them ends up permitting `differs`.
     */
    readonly mayWrite: boolean;
}

/**
 * The digest an artefact records, or `null` when it records none this rule can
 * use.
 *
 * Absent block, non-object block, absent field, non-string field, empty string
 * and {@link CATALOG_ARTIFACT_UNIDENTIFIED_TARGET} are one answer: the document
 * does not say which database it describes. Read as text from a parsed JSON
 * document, so every one of those shapes is reachable from a file on disk and
 * none of them may be asserted out of existence by a cast at the call site.
 */
const recordedArtifactTargetDigest = (existing: Readonly<Record<string, unknown>>): string | null => {
    const block = existing[CATALOG_ARTIFACT_TARGET_IDENTITY_KEY];

    if (block === null || typeof block !== 'object' || Array.isArray(block)) {
        return null;
    }

    const recorded = (block as Record<string, unknown>)[CATALOG_ARTIFACT_TARGET_DIGEST_FIELD];

    if (typeof recorded !== 'string' || recorded.length === 0 || recorded === CATALOG_ARTIFACT_UNIDENTIFIED_TARGET) {
        return null;
    }

    return recorded;
};

/**
 * Whether this run may merge into the artefact whose fields are `existing`.
 *
 * `existing` is `null` for a path that holds nothing — the ordinary first
 * write — and otherwise the document's own top-level fields as they were read
 * off disk.
 *
 * A run that cannot name its own target (`runDigest` is
 * {@link CATALOG_ARTIFACT_UNIDENTIFIED_TARGET}) and finds a RECORDED identity
 * gets `differs`, deliberately: an unidentified write must not replace evidence
 * produced against a named database, and every stage entry point classifies its
 * origin before it reaches a write, so this can only be a harness or a
 * misconfiguration. The reverse — a named run over an unidentified artefact —
 * is the adoption path above.
 */
export const decideCatalogArtifactTarget = (
    existing: Readonly<Record<string, unknown>> | null,
    runDigest: string,
): CatalogArtifactTargetDecision => {
    if (existing === null) {
        return { verdict: 'first_write', recordedDigest: null, runDigest, mayWrite: true };
    }

    const recordedDigest = recordedArtifactTargetDigest(existing);

    if (recordedDigest === null) {
        return { verdict: 'adopted', recordedDigest: null, runDigest, mayWrite: true };
    }

    if (recordedDigest === runDigest) {
        return { verdict: 'agrees', recordedDigest, runDigest, mayWrite: true };
    }

    return { verdict: 'differs', recordedDigest, runDigest, mayWrite: false };
};

/**
 * A write refused because the artefact it would have merged into describes a
 * different database.
 *
 * Its own class rather than a stage's general failure, because the remedy is
 * neither a code change nor a data repair: the operator pointed a stage at one
 * database and a report directory produced against another, and the answer is
 * to publish to a different directory (`catalog:report --out`) or to re-publish
 * the pair from the database this run addresses. Each stage maps it to its own
 * reported code at its edge (Rule backend-architecture §8).
 */
export class CatalogArtifactTargetError extends Error {
    public readonly code = 'artefact_target_mismatch';

    constructor(
        message: string,
        public readonly context: {
            /** The artefact's file name — never its absolute path, which is environment. */
            readonly file: string;
            readonly recordedDigest: string | null;
            readonly runDigest: string;
        },
    ) {
        super(message);
        this.name = 'CatalogArtifactTargetError';
    }
}

/**
 * The decision, with the refusal raised rather than returned.
 *
 * Every caller of {@link decideCatalogArtifactTarget} that is about to WRITE
 * wants the same two lines of code, and one of them is a throw — so it is
 * written once here and the callers keep the decision for their log line. The
 * message names the file and both digests and nothing else: a refusal a
 * reviewer reads must not be the place the database name finally appears.
 */
export const assertCatalogArtifactTarget = (input: {
    readonly file: string;
    readonly existing: Readonly<Record<string, unknown>> | null;
    readonly runDigest: string;
}): CatalogArtifactTargetDecision => {
    const decision = decideCatalogArtifactTarget(input.existing, input.runDigest);

    if (!decision.mayWrite) {
        throw new CatalogArtifactTargetError(
            `${input.file} records ${CATALOG_ARTIFACT_TARGET_IDENTITY_KEY}.${CATALOG_ARTIFACT_TARGET_DIGEST_FIELD} ` +
                `"${String(decision.recordedDigest)}" and this run addresses "${decision.runDigest}", so the ` +
                'document describes a different database and nothing was written — the committed artefact is ' +
                'intact. An evidence artefact is the record of one catalog, so merging this run into it would ' +
                'produce a file whose sections describe two. Publish to a directory of this run\u2019s own ' +
                '(catalog:report --out), or re-publish the pair from the database this run addresses.',
            { file: input.file, recordedDigest: decision.recordedDigest, runDigest: input.runDigest },
        );
    }

    return decision;
};

/**
 * The block a write records, and the only fields in it.
 *
 * DELIBERATELY CARRIES NO VERDICT. The block is part of a byte-for-byte
 * deterministic artefact — `catalog-report.ts` writes no wall-clock value so a
 * rerun against unchanged data produces an identical file, and the suite pins
 * that — and the verdict is not a property of the target: it is a property of
 * the write, which was `first_write` into an empty directory and `agrees` on
 * every run after it. Recording it here would make the first artefact differ
 * from every later one for a reason that has nothing to do with the catalog.
 * The verdict is reported in the run's log, where a per-write fact belongs.
 */
export const catalogArtifactTargetIdentity = (runDigest: string): Record<string, unknown> => ({
    [CATALOG_ARTIFACT_TARGET_DIGEST_FIELD]: runDigest,
    digestBasis:
        'A one-way digest of the database this artefact describes (scripts/lib/logger.ts opaqueDigest: SHA-256 of ' +
        'host/database, truncated). It answers whether two writes addressed the same database and discloses ' +
        'neither the host nor the database name, which is why it can live in a committed file. A stage refuses to ' +
        'merge into an artefact recording a different digest; an artefact recording none is adopted, so a document ' +
        'published before this field existed still merges.',
});
