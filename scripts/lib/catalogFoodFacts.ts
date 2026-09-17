// Facts about one `catalog_foods` row that both writers of that table have to
// agree on, as pure functions over their arguments.
//
// WHY THIS MODULE EXISTS. `catalog-import-usda.ts` and `catalog-generate-ai.ts`
// write the same table from two different sources — curated USDA records and
// AI-generated candidates — and they have to derive four things identically or
// the table stops being one catalog: the `search_text` the STORED
// `search_vector` is generated from, the alias list that feeds it, the
// key-sorted JSON a payload digest is taken over, and the two version counters
// `recipe_ingredients` snapshots are checked for staleness against. The
// generation stage used to import all four FROM the import stage's CLI entry
// point, which is a module that starts with `./lib/bootstrap` and `./lib/dbGuard`
// and declares a `main()`: importing it to borrow a hash helper pulls a second
// command's startup ordering and database-origin policy into your own process,
// and it reads as though one CLI were a library for the other (Rule
// backend-architecture §1.1/§7.1 — a script is an I/O recipe, and what both
// recipes share belongs beside them in `lib/`).
//
// So this module is deliberately inert on import: two Node built-ins, one
// type-only import, and one pure module from `src/services/`. It reads no
// environment variable, opens no connection, registers no handler and runs no
// statement at load, which is what makes it safe for any script — or any test —
// to import for one function.
//
// WHAT DOES NOT LIVE HERE. Anything either stage decides for itself:
// classification, the brand screen, portion resolution, the validation checks
// and category bounds (those are `src/services/catalog.logic.ts`, which both
// stages call), and each stage's own Prisma `select` and persistence. The test
// is whether the two stages MUST agree on it for the table to be coherent.

import crypto from 'crypto';

import { normalizeCanonicalName } from '../../src/services/catalog.logic';

import type { CatalogFoodState } from './manifest';

/**
 * Key-sorted JSON, so a digest of a vendor record does not depend on the order
 * the payload's keys happened to arrive in. `undefined` cannot appear in parsed
 * JSON, so it needs no case.
 */
export const canonicalJsonString = (value: unknown): string => {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value ?? null);
    }
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJsonString).join(',')}]`;
    }
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
    );
    return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJsonString(nested)}`).join(',')}}`;
};

export const sha256Hex = (text: string): string => crypto.createHash('sha256').update(text).digest('hex');


/** Lower-case, de-duplicated, sorted, and never the canonical name itself. */
export const dedupeSortedAliases = (aliases: readonly string[], canonicalName: string): string[] => {
    const normalizedCanonical = normalizeCanonicalName(canonicalName);
    const seen = new Set<string>();
    const kept: string[] = [];

    for (const alias of aliases) {
        const trimmed = alias.trim().toLowerCase().replace(/\s+/g, ' ');
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
 * and this file's job is to hand it plain words (Rule backend-architecture §7).
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

    // A stored counter this stage never wrote (a hand-loaded row, a release
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
