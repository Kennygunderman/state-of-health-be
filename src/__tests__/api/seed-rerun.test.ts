// The corpus gate: is the committed catalog release and recipe corpus LOADABLE
// into a real PostgreSQL, INTERNALLY CLOSED once loaded, and is re-applying it
// a no-op?
//
// Agent Action Plan §0.3.3 names this file, and §0.9.2 states the claim it
// settles: "every ingredient published and source-backed, nutrition
// recomputation equals stored per-serving values", for a corpus that §0.7.3
// requires to be reachable from a database rather than from a JSON file. Until
// this suite existed, those claims had only file-level evidence — digests,
// parses and counts — which says nothing about whether the release's shape
// matches the migrated schema or whether the 269 ingredient references resolve
// once the rows are actually in a table. That gap is code review finding
// DATA-04's remaining clause, and closing it is this file's whole purpose.
//
// HOW THE ROWS GET IN. The recipes are published by the PRODUCTION stage:
// `scripts/recipes-seed.ts::runSeed` is called below with the committed recipe
// directory, the real Prisma client, a pinned clock and a report path outside
// the repository, so the 42 payloads reach the database through exactly the
// code an operator runs and every §0.7.3 gate — ingredient resolution by
// `source_key`, the publication preconditions, declared-versus-derived,
// instruction completeness — is exercised against the real corpus rather than
// restated here.
//
// The CATALOG slice, by contrast, is applied through Prisma directly rather
// than through `scripts/catalog-load.ts` — not because that stage is unbuilt,
// since it carries its whole write half (verification, retirement, per-food
// reconciliation, applied-byte and count verification, activation), but because
// it applies the WHOLE release: all 11,046 published foods with their 15,939
// aliases, 31,899 portions and 11,046 validation records, and it refuses to
// activate unless the row counts after the load equal the manifest's. That is
// exactly what "WHY IT LOADS ONLY A SLICE" below rules out here — this gate
// needs the 69-food ingredient slice the recipes depend on and nothing more,
// and applying the release whole would make it a benchmark. The loader's own run
// is covered where it belongs, by `src/__tests__/scripts/catalog-load.test.ts`:
// a v1 load, a no-op rerun, a failure after partial progress repaired by
// rerunning, a v1 → v2 upgrade, and a tampered release refused with nothing
// written. What is applied below reconciles on the stable identities
// `catalog-load.ts` documents (`catalog_foods.source_key`, and each food's
// aliases, portions and validation record replaced wholesale inside that food's
// own transaction), which is why re-applying the slice leaves the same rows —
// the eighth claim in the list below.
//
// WHAT IT PROVES, in the order the describes run:
//   1. the manifest gate — every release file's streamed SHA-256, byte length
//      and row count equals what `manifest.json` declares, and the `counts`
//      block agrees with the per-file row counts;
//   2. the corpus as committed — ≥ 40 payloads each named for its slug,
//      closed-set icon keys, slots and badges, and whole-file closure;
//   3. loadability — the ingredient slice inserts into `catalog_foods`,
//      `catalog_food_aliases`, `catalog_food_portions` and
//      `catalog_validation_records` with no constraint violation, which is
//      itself the proof that the release's nullability, types and identities
//      fit the migrated schema (unique `source_key`, unique `usda_fdc_id`, the
//      partial unique index on published `(canonical_name, food_state)`, the
//      one-default-portion partial unique index) and that the generated
//      `search_vector` expression accepts every row;
//   4. referential closure INSIDE the database — no alias, portion or
//      validation record without its food, and every recipe ingredient row
//      resolving to an inserted food;
//   5. the §0.7.3 planning preconditions on every food a recipe depends on;
//   6. nutrition recomputed from the STORED rows through the production
//      derivation in `services/recipe.logic.ts`, per-serving = total ÷
//      `yield_servings`, and `total_minutes` = prep + cook;
//   7. the §0.7.3 coverage matrix — the diet × single-allergen × slot ×
//      time-tier table the seed derives FROM the seeded rows — meeting every
//      guaranteed cell's threshold of four and every reduced cell's threshold
//      of two, and equalling the committed
//      `data/meal-planning/recipes/coverage-report.json` byte for byte;
//   8. idempotent re-application — the same release applied a second time
//      leaves the row counts, the food identities and every row's content
//      unchanged, publishes no second recipe version and re-emits the same
//      coverage report;
//   9. the SNAPSHOT the publication froze — every `recipe_ingredients` row's
//      name, provenance, allergen and diet lists, per-100 g nutrients and both
//      catalog version counters are the values the resolved `catalog_foods` row
//      held at publication, and its quantity, unit, display text, order and
//      optionality are the payload's;
//  10. what the API serves out of that corpus — `GET /api/catalog/status`
//      counting the seeded recipes and loaded foods, and
//      `GET /api/recipes/:recipeVersionId` answering a seeded current version
//      from the snapshot columns rather than the live catalog row;
//  11. a corpus file the seed REFUSES — nine defects, each reported with the
//      recipe and the offending element, none of them published, and the
//      already-seeded corpus left exactly as it stood;
//  12. IMMUTABILITY BY VERSION, the claim this file exists for most: a changed
//      payload, and separately a stale ingredient snapshot by each of the two
//      catalog version counters, publishes a NEW version, promotes it to
//      `current` and retires the old one — whose content is byte-identical
//      afterwards — in one transaction that leaves exactly one current version,
//      while the retired version stays readable for the plan that references
//      it, keeps the numbers that plan was built from, and leaves the plannable
//      set offering only the current one;
//  13. the coverage report RECOMPUTED rather than echoed — a deliberately
//      reduced seeded set moves its numbers, which is what makes claim 7's
//      equality with the committed artefact evidence rather than a tautology.
//
// CLAIMS 9–13 ARE THE MUTATING HALF, and they run last for that reason: claims
// 1–8 read state their own `beforeAll` captured, so every block that changes
// the database is declared after them — Jest runs a describe's `beforeAll`
// immediately before its first test, so the order above is also the order the
// writes happen in. Claim 13 truncates, so it is last of all.
//
// WHY IT LOADS ONLY A SLICE. `validation-records.jsonl` is 50 MB and
// `foods.jsonl` 13 MB, against 11,046 published foods. Loading all of them
// would make this suite a benchmark rather than a gate, so every file is
// STREAMED line by line — the digest is taken off the same stream — and only
// the slice the recipes actually depend on is inserted: the distinct ingredient
// `source_key` set (69 foods at this revision) with their aliases (226),
// portions (139) and validation records (69). Whole-file integrity is asserted
// from the streamed measurements, which never materialise the files.
//
// HOW `coverage-report.json` IS TREATED HERE. The committed artefact is READ
// and never written: the seed is given a report path under `os.tmpdir()`, and
// the emitted document is compared against the committed one both as parsed
// values and byte for byte. A suite that rewrote it could not fail on a
// coverage regression — it would simply commit one. The recipe FILES are
// treated the same way: every case that needs a changed or defective payload
// copies the committed one into a directory under `os.tmpdir()` and edits the
// copy, so no run here can write inside `data/meal-planning/`.
//
// WHAT THIS SUITE DELIBERATELY DOES NOT ASSERT, and why. Plan-DTO nutrition
// rounding and `portionText` strings belong to the mapper's own suites and
// appear nowhere here. Everything else this corpus declares — `dietTags`,
// `allergenTags`, `allergenStatus`, `badges`, `budgetTier` — is compared
// against the derivation below, which is also the gate the seed itself applied
// before publishing: a payload whose declaration disagreed would have refused
// the whole run rather than reaching those assertions, which is a claim of its
// own and is why claim 11 asserts that refusal directly.
//
// WHAT ITS SIBLINGS OWN, so a reader looking for a case finds it. The stage's
// own mechanics — argument parsing, the preflight gaps, the dry and narrowed
// runs, the pure vocabulary helpers, and the same promotion and refusal
// behaviours against a five-row SYNTHETIC catalog — are
// `src/__tests__/scripts/recipes-seed.test.ts`, whose header cedes the real
// corpus against the real release to this file. The full
// `GET /api/recipes/:recipeVersionId` response matrix and the retired-version
// visibility matrix are `api/recipes.test.ts` and `api/ownership.test.ts`; the
// alternatives ENDPOINT in all its states is `api/swaps.test.ts`; the catalog
// status route is `api/catalog.test.ts`; the loader's own run, including a
// tampered release, is `src/__tests__/scripts/catalog-load.test.ts`. What the
// API-facing claims below add is the subject none of those has: the corpus this
// repository actually ships, served end to end.
//
// MEASURED FACTS THE ASSERTIONS BELOW ARE CALIBRATED TO, so a reader does not
// mistake a deliberate silence for an oversight: three slice foods state no
// `fiber_g`, so four recipes derive a null fibre total — fibre is asserted as a
// propagation rule rather than as a number; ten recipes carry a
// `sourced_calories_note` because their sourced energy diverges from the 4/4/9
// estimate by 5.1 %–7.8 %, which is a disclosure and not a defect, so the note
// is asserted to be present exactly where the divergence exceeds the
// threshold; and exactly one of the 269 ingredient rows is optional, which is
// included in every total by policy. One further measured property shapes how
// the recomputation is compared rather than what it claims: the Prisma client
// encodes a float parameter to fifteen significant digits, so a `DOUBLE
// PRECISION` column holds the derived double to within one ulp and not bit for
// bit — see `FLOAT8_ROUND_TRIP_TOLERANCE`, which records the probe that
// establishes it.
//
// SAFETY AND ISOLATION. The suite hardcodes no database name: it truncates
// through `setup/testDb.ts::truncateFeatureTables`, which re-runs the identity
// guard (`NODE_ENV=test`, `ALLOW_DB_TRUNCATE=true`, a `_test`-class name on a
// local host) and the schema-freshness gate before emptying the feature tables,
// and it truncates again at the end so it leaves the database as it found it.
// Run it with:
//
//   NODE_ENV=test ALLOW_DB_TRUNCATE=true \
//     DATABASE_URL=postgresql://…@127.0.0.1:5433/<name>_test \
//     npx jest --ci --runInBand src/__tests__/api/seed-rerun.test.ts

import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';

import {
    loadCoveragePlan,
    loadReleaseManifest,
    recipesDir,
    releaseFilePath,
    writeJsonFile,
} from '../../../scripts/lib/manifest';
import type { CatalogReleaseManifest } from '../../../scripts/lib/manifest';
import type { LogFields, ScriptLogger } from '../../../scripts/lib/logger';
// The stage under test. Importing a `scripts/` entry point is safe here for the
// reason `scripts/lib/dbGuard.ts` documents at its module-load block: its
// enforcement is keyed on `argv[1]` naming one of the known scripts, which
// under Jest is the jest binary, so the import classifies nothing and can end
// no process. The module is side-effect-free otherwise — its `main()` is behind
// `require.main === module` and it reaches Prisma only through a dynamic import
// inside it, which `src/__tests__/scripts/recipes-seed.test.ts` proves from a
// child process.
import { RecipeSeedError, runSeed } from '../../../scripts/recipes-seed';
import type { CoverageReport, SeedDb, SeedDeps, SeedOutcome } from '../../../scripts/recipes-seed';
import { Prisma } from '../../generated/prisma';
import { prisma } from '../../prisma/client';
import {
    deriveRecipeNutrition,
    deriveRecipeVersionFields,
    deriveTotalMinutes,
    evaluatePlanningEligibility,
    isMealSlot,
    isRecipeBadge,
    isRecipeIconKey,
    SOURCED_CALORIE_DIVERGENCE_THRESHOLD,
} from '../../services/recipe.logic';
import type {
    PlanningPreferences,
    RecipeAllergenStatus,
    RecipeIngredientNutrientSnapshot,
    RecipeNutritionBasis,
    RecipePublicationIngredient,
} from '../../services/recipe.logic';
import { getRecipeVersionsForPlanning } from '../../services/recipe.service';
import type { NutritionProvenance } from '../../types/nutrition';
import type { RecipeVersionResponse } from '../../types/recipe';
import { makePlan, makePreferences, makeUser } from '../setup/factories';
import type { FixtureMealPlan } from '../setup/factories';
import { asUser, request } from '../setup/testApp';
import type { TestIdentity } from '../setup/testApp';
import { truncateFeatureTables } from '../setup/testDb';

/** The release this checkpoint ships and every environment loads (§0.7.1). */
const RELEASE_ID = 'v1';

/**
 * The five data members of a release, in the order the format contract lists
 * them.
 *
 * Restated here rather than imported from `scripts/catalog-release.ts`, which
 * exports the same list as `RELEASE_DATA_FILES`: this list is what the
 * manifest's own `files[]` is CHECKED against below, and a check that imported
 * its expectation from the producer of the thing it checks would pass by
 * construction. A release that grew or lost a member therefore fails here
 * rather than being silently half-checked.
 */
const RELEASE_DATA_FILES: readonly string[] = Object.freeze([
    'foods.jsonl',
    'aliases.jsonl',
    'portions.jsonl',
    'components.jsonl',
    'validation-records.jsonl',
]);

/** `data/meal-planning/recipes/` holds one payload per file, and this report. */
const COVERAGE_REPORT_FILE = 'coverage-report.json';

/** §0.7.3's floor on the corpus: forty distinct recipes. */
const MINIMUM_RECIPE_COUNT = 40;

/** The version number a first publication writes, and the only one a rerun may leave. */
const FIRST_VERSION = 1;

/**
 * The publication instant. Pinned like every other database-backed suite's
 * clock, so `published_at` is an exactly assertable value rather than one that
 * moves with the run.
 */
const PUBLISHED_AT = new Date('2026-09-13T12:00:00.000Z');

/**
 * Streaming 70 MB, digesting it and applying ~500 statements twice is well
 * inside this, and a hook that hangs on a database is worth failing rather than
 * waiting on.
 */
const LOAD_TIMEOUT_MS = 300_000;

/**
 * How close a `DOUBLE PRECISION` column read back has to be to the double that
 * was written, as a RELATIVE difference.
 *
 * Not a softened assertion — a measured property of the write path. The Prisma
 * client encodes a float parameter to fifteen significant digits, so a derived
 * value such as `177.79299999999998` is stored as the neighbouring double
 * `177.793`: probed directly, `prisma.catalog_foods.create({calories:
 * 177.79299999999998})` followed by `SELECT calories::text` answers `177.793`.
 * PostgreSQL itself is exact — with `extra_float_digits = 1`,
 * `SELECT 177.79299999999998::float8::text` returns the literal verbatim — so
 * the one-ulp gap is introduced on the way in and no assertion on this stack
 * can compare a recomputation to a stored double bit for bit.
 *
 * The observed gaps are ~1e-16 relative (one ulp at these magnitudes). This
 * bound is four orders of magnitude above that and ten orders below the single
 * decimal place any of these numbers is ever displayed at, so a real
 * arithmetic error — a wrong gram weight, a missing ingredient, a division by
 * the wrong yield — is still caught by many orders of magnitude.
 */
const FLOAT8_ROUND_TRIP_TOLERANCE = 1e-12;

const sameStoredNumber = (stored: number, recomputed: number): boolean => {
    if (stored === recomputed) {
        return true;
    }
    if (!Number.isFinite(stored) || !Number.isFinite(recomputed)) {
        return false;
    }

    const scale = Math.max(Math.abs(stored), Math.abs(recomputed));
    return Math.abs(stored - recomputed) <= scale * FLOAT8_ROUND_TRIP_TOLERANCE;
};

/* ---------------------------------------------------------------------------
 * Reading the release: typed accessors over parsed JSON
 *
 * Every field below is read through one of these rather than cast, because the
 * release is an external file and a wrong TYPE in it is exactly the defect this
 * suite is meant to catch — a null where the column is NOT NULL, a string where
 * the column is DOUBLE PRECISION. The refusal names the file, the row and the
 * field, which is what an operator needs to fix the data.
 * ------------------------------------------------------------------------- */

const render = (value: unknown): string => (value === undefined ? 'undefined' : String(JSON.stringify(value)));

const asRecord = (value: unknown, where: string): Record<string, unknown> => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error(`${where}: expected a JSON object, received ${render(value)}`);
    }

    return value as Record<string, unknown>;
};

const text = (row: Record<string, unknown>, field: string, where: string): string => {
    const value = row[field];
    if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`${where}: ${field} must be a non-empty string, received ${render(value)}`);
    }

    return value;
};

const optionalText = (row: Record<string, unknown>, field: string, where: string): string | null => {
    const value = row[field];
    return value === null || value === undefined ? null : text(row, field, where);
};

const decimal = (row: Record<string, unknown>, field: string, where: string): number => {
    const value = row[field];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`${where}: ${field} must be a finite number, received ${render(value)}`);
    }

    return value;
};

const optionalDecimal = (row: Record<string, unknown>, field: string, where: string): number | null => {
    const value = row[field];
    return value === null || value === undefined ? null : decimal(row, field, where);
};

const wholeNumber = (row: Record<string, unknown>, field: string, where: string): number => {
    const value = decimal(row, field, where);
    if (!Number.isInteger(value)) {
        throw new Error(`${where}: ${field} must be an integer, received ${render(value)}`);
    }

    return value;
};

const optionalWholeNumber = (row: Record<string, unknown>, field: string, where: string): number | null => {
    const value = row[field];
    return value === null || value === undefined ? null : wholeNumber(row, field, where);
};

const flag = (row: Record<string, unknown>, field: string, where: string): boolean => {
    const value = row[field];
    if (typeof value !== 'boolean') {
        throw new Error(`${where}: ${field} must be a boolean, received ${render(value)}`);
    }

    return value;
};

const textList = (row: Record<string, unknown>, field: string, where: string): string[] => {
    const value = row[field];
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
        throw new Error(`${where}: ${field} must be an array of strings, received ${render(value)}`);
    }

    return value as string[];
};

const list = (row: Record<string, unknown>, field: string, where: string): unknown[] => {
    const value = row[field];
    if (!Array.isArray(value)) {
        throw new Error(`${where}: ${field} must be an array, received ${render(value)}`);
    }

    return value as unknown[];
};

/**
 * A required JSON column's value.
 *
 * The ONE cast in this file, and it is a narrowing of provenance rather than of
 * type: the value came out of `JSON.parse`, so it already IS a JSON value —
 * `Prisma.InputJsonValue` is simply the name the client gives that set. What is
 * checked is presence, because these columns are NOT NULL and a missing one has
 * to fail before the insert rather than inside Prisma.
 */
const jsonValue = (row: Record<string, unknown>, field: string, where: string): Prisma.InputJsonValue => {
    const value = row[field];
    if (value === null || value === undefined) {
        throw new Error(`${where}: ${field} must be present, received ${render(value)}`);
    }

    return value as Prisma.InputJsonValue;
};

const optionalJsonValue = (
    row: Record<string, unknown>,
    field: string,
    where: string,
): Prisma.InputJsonValue | null => {
    const value = row[field];
    return value === null || value === undefined ? null : jsonValue(row, field, where);
};

/* ---------------------------------------------------------------------------
 * The release's four row shapes
 * ------------------------------------------------------------------------- */

interface ReleaseFood {
    readonly source_key: string;
    readonly canonical_name: string;
    readonly display_name: string;
    readonly category: string;
    readonly food_state: string;
    readonly food_group: string;
    readonly identity_source: string;
    readonly identity_status: string;
    readonly nutrition_provenance: string;
    readonly publication_status: string;
    readonly nutrition_basis: string;
    readonly basis_amount: number;
    readonly calories: number | null;
    readonly protein_g: number | null;
    readonly carbs_g: number | null;
    readonly fat_g: number | null;
    readonly fiber_g: number | null;
    readonly density_g_per_ml: number | null;
    readonly allergen_tags: string[];
    readonly allergen_status: string;
    readonly diet_tags: string[];
    readonly is_common_dislike: boolean;
    readonly cost_class: number;
    readonly nutrition_version: number;
    readonly metadata_version: number;
    readonly usda_fdc_id: number | null;
    readonly usda_data_type: string | null;
    readonly usda_description: string | null;
    readonly source_version: string | null;
    readonly source_cache_key: string | null;
    readonly generation_batch_key: string | null;
    readonly search_text: string | null;
    readonly imported_at: string | null;
}

interface ReleaseAlias {
    readonly food_source_key: string;
    readonly alias: string;
}

interface ReleasePortion {
    readonly food_source_key: string;
    readonly description: string;
    readonly amount: number;
    readonly unit: string;
    readonly gram_weight: number;
    readonly is_default: boolean;
    readonly source: string;
}

interface ReleaseValidationRecord {
    readonly food_source_key: string;
    readonly canonical_identity: Prisma.InputJsonValue;
    readonly aliases: string[];
    readonly category: string;
    readonly food_state: string;
    readonly identity_source: string;
    readonly identity_status: string;
    readonly nutrition_provenance: string;
    readonly nutrition_method: string;
    /**
     * The release states an ARRAY; `catalog_validation_records` stores JSON text
     * in a `String?` column. `catalog-release.ts::toReleaseValidationLine`
     * documents that round trip from the storage side — it parses the column
     * back to the array the format states — so the load direction is
     * `JSON.stringify`, and the parsed array is kept here so the stored text can
     * be asserted to parse back to it.
     */
    readonly nutrition_assumptions: unknown[];
    readonly portion_units: Prisma.InputJsonValue;
    readonly identity_evidence: Prisma.InputJsonValue;
    readonly checks: Prisma.InputJsonValue;
    readonly llm_review: Prisma.InputJsonValue | null;
    readonly outcome: string;
    readonly reviewed_at: string;
    readonly publication_status: string;
    readonly source_versions: Prisma.InputJsonValue;
    readonly history: Prisma.InputJsonValue;
}

const parseFood = (value: unknown, where: string): ReleaseFood => {
    const row = asRecord(value, where);

    return {
        source_key: text(row, 'source_key', where),
        canonical_name: text(row, 'canonical_name', where),
        display_name: text(row, 'display_name', where),
        category: text(row, 'category', where),
        food_state: text(row, 'food_state', where),
        food_group: text(row, 'food_group', where),
        identity_source: text(row, 'identity_source', where),
        identity_status: text(row, 'identity_status', where),
        nutrition_provenance: text(row, 'nutrition_provenance', where),
        publication_status: text(row, 'publication_status', where),
        nutrition_basis: text(row, 'nutrition_basis', where),
        basis_amount: decimal(row, 'basis_amount', where),
        calories: optionalDecimal(row, 'calories', where),
        protein_g: optionalDecimal(row, 'protein_g', where),
        carbs_g: optionalDecimal(row, 'carbs_g', where),
        fat_g: optionalDecimal(row, 'fat_g', where),
        fiber_g: optionalDecimal(row, 'fiber_g', where),
        density_g_per_ml: optionalDecimal(row, 'density_g_per_ml', where),
        allergen_tags: textList(row, 'allergen_tags', where),
        allergen_status: text(row, 'allergen_status', where),
        diet_tags: textList(row, 'diet_tags', where),
        is_common_dislike: flag(row, 'is_common_dislike', where),
        cost_class: wholeNumber(row, 'cost_class', where),
        nutrition_version: wholeNumber(row, 'nutrition_version', where),
        metadata_version: wholeNumber(row, 'metadata_version', where),
        usda_fdc_id: optionalWholeNumber(row, 'usda_fdc_id', where),
        usda_data_type: optionalText(row, 'usda_data_type', where),
        usda_description: optionalText(row, 'usda_description', where),
        source_version: optionalText(row, 'source_version', where),
        source_cache_key: optionalText(row, 'source_cache_key', where),
        generation_batch_key: optionalText(row, 'generation_batch_key', where),
        search_text: optionalText(row, 'search_text', where),
        imported_at: optionalText(row, 'imported_at', where),
    };
};

const parseAlias = (value: unknown, where: string): ReleaseAlias => {
    const row = asRecord(value, where);

    return {
        food_source_key: text(row, 'food_source_key', where),
        alias: text(row, 'alias', where),
    };
};

const parsePortion = (value: unknown, where: string): ReleasePortion => {
    const row = asRecord(value, where);

    return {
        food_source_key: text(row, 'food_source_key', where),
        description: text(row, 'description', where),
        amount: decimal(row, 'amount', where),
        unit: text(row, 'unit', where),
        gram_weight: decimal(row, 'gram_weight', where),
        is_default: flag(row, 'is_default', where),
        source: text(row, 'source', where),
    };
};

const parseValidationRecord = (value: unknown, where: string): ReleaseValidationRecord => {
    const row = asRecord(value, where);

    return {
        food_source_key: text(row, 'food_source_key', where),
        canonical_identity: jsonValue(row, 'canonical_identity', where),
        aliases: textList(row, 'aliases', where),
        category: text(row, 'category', where),
        food_state: text(row, 'food_state', where),
        identity_source: text(row, 'identity_source', where),
        identity_status: text(row, 'identity_status', where),
        nutrition_provenance: text(row, 'nutrition_provenance', where),
        nutrition_method: text(row, 'nutrition_method', where),
        nutrition_assumptions: list(row, 'nutrition_assumptions', where),
        portion_units: jsonValue(row, 'portion_units', where),
        identity_evidence: jsonValue(row, 'identity_evidence', where),
        checks: jsonValue(row, 'checks', where),
        llm_review: optionalJsonValue(row, 'llm_review', where),
        outcome: text(row, 'outcome', where),
        reviewed_at: text(row, 'reviewed_at', where),
        publication_status: text(row, 'publication_status', where),
        source_versions: jsonValue(row, 'source_versions', where),
        history: jsonValue(row, 'history', where),
    };
};

/* ---------------------------------------------------------------------------
 * The recipe payloads
 * ------------------------------------------------------------------------- */

interface PayloadIngredient {
    readonly sourceKey: string;
    readonly quantity: number;
    readonly unit: string;
    readonly gramWeight: number;
    readonly displayText: string;
    readonly sortOrder: number;
    readonly isOptional: boolean;
}

interface RecipePayload {
    readonly file: string;
    readonly slug: string;
    readonly name: string;
    readonly description: string;
    readonly iconKey: string;
    readonly instructions: string[];
    readonly yieldServings: number;
    readonly servingDescription: string;
    readonly prepMinutes: number;
    readonly cookMinutes: number;
    readonly mealSlots: string[];
    readonly dietTags: string[];
    readonly allergenTags: string[];
    readonly allergenStatus: string;
    readonly budgetTier: number;
    readonly badges: string[];
    readonly ingredients: readonly PayloadIngredient[];
}

const parseRecipePayload = (file: string, value: unknown): RecipePayload => {
    const where = `recipes/${file}`;
    const row = asRecord(value, where);

    return {
        file,
        slug: text(row, 'slug', where),
        name: text(row, 'name', where),
        description: text(row, 'description', where),
        iconKey: text(row, 'iconKey', where),
        instructions: textList(row, 'instructions', where),
        yieldServings: decimal(row, 'yieldServings', where),
        servingDescription: text(row, 'servingDescription', where),
        prepMinutes: wholeNumber(row, 'prepMinutes', where),
        cookMinutes: wholeNumber(row, 'cookMinutes', where),
        mealSlots: textList(row, 'mealSlots', where),
        dietTags: textList(row, 'dietTags', where),
        allergenTags: textList(row, 'allergenTags', where),
        allergenStatus: text(row, 'allergenStatus', where),
        budgetTier: wholeNumber(row, 'budgetTier', where),
        badges: textList(row, 'badges', where),
        ingredients: list(row, 'ingredients', where).map((entry, index) => {
            const ingredientWhere = `${where} ingredient ${index}`;
            const ingredient = asRecord(entry, ingredientWhere);

            return {
                sourceKey: text(ingredient, 'sourceKey', ingredientWhere),
                quantity: decimal(ingredient, 'quantity', ingredientWhere),
                unit: text(ingredient, 'unit', ingredientWhere),
                gramWeight: decimal(ingredient, 'gramWeight', ingredientWhere),
                displayText: text(ingredient, 'displayText', ingredientWhere),
                sortOrder: wholeNumber(ingredient, 'sortOrder', ingredientWhere),
                isOptional: flag(ingredient, 'isOptional', ingredientWhere),
            };
        }),
    };
};

/* ---------------------------------------------------------------------------
 * Streaming a release file: one pass for the digest, the bytes, the rows and
 * whatever the caller wants out of them
 * ------------------------------------------------------------------------- */

interface FileMeasurement {
    readonly sha256: string;
    readonly bytes: number;
    readonly rowCount: number;
}

/**
 * Reads one JSONL member line by line, hashing and counting the bytes as they
 * arrive.
 *
 * The digest is taken from a `data` listener on the SAME read stream `readline`
 * consumes, so it covers the file exactly as read — including the trailing
 * newline and anything `readline` would drop — rather than a re-read that could
 * disagree with the parsed rows. Both listeners see every chunk, and the
 * resulting digests are what `manifest.json` is compared against below.
 *
 * `readFileSync` is not an option here: `validation-records.jsonl` is 50 MB and
 * would be held in memory in its entirety, on top of the parsed rows.
 */
const streamReleaseFile = async (
    fileName: string,
    onRow: (row: unknown, where: string) => void,
): Promise<FileMeasurement> => {
    const absolutePath = releaseFilePath(RELEASE_ID, fileName);
    const hash = createHash('sha256');
    let bytes = 0;
    let rowCount = 0;

    const stream = fs.createReadStream(absolutePath);
    stream.on('data', (chunk: string | Buffer) => {
        const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        hash.update(buffer);
        bytes += buffer.length;
    });

    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of lines) {
        if (line.length === 0) {
            continue;
        }

        rowCount += 1;
        const where = `${fileName} row ${rowCount}`;
        let parsed: unknown;
        try {
            parsed = JSON.parse(line) as unknown;
        } catch (error) {
            throw new Error(`${where} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
        }
        onRow(parsed, where);
    }

    return { sha256: hash.digest('hex'), bytes, rowCount };
};

/* ---------------------------------------------------------------------------
 * What one pass over the corpus produces
 * ------------------------------------------------------------------------- */

interface ReleaseSlice {
    readonly foods: readonly ReleaseFood[];
    readonly aliases: readonly ReleaseAlias[];
    readonly portions: readonly ReleasePortion[];
    readonly records: readonly ReleaseValidationRecord[];
}

interface OrphanReport {
    readonly aliases: readonly string[];
    readonly portions: readonly string[];
    readonly records: readonly string[];
    readonly ingredients: readonly string[];
}

interface Corpus {
    readonly manifest: CatalogReleaseManifest;
    readonly measurements: ReadonlyMap<string, FileMeasurement>;
    readonly payloads: readonly RecipePayload[];
    readonly slice: ReleaseSlice;
    readonly orphans: OrphanReport;
    /** Every distinct ingredient `source_key`, sorted. */
    readonly ingredientKeys: readonly string[];
    /** Ingredient rows across the whole corpus. */
    readonly ingredientRowCount: number;
}

const readRecipePayloads = (): RecipePayload[] =>
    fs
        .readdirSync(recipesDir())
        .filter((name) => name.endsWith('.json') && name !== COVERAGE_REPORT_FILE)
        .sort()
        .map((name) => {
            const raw = fs.readFileSync(path.join(recipesDir(), name), 'utf8');
            let parsed: unknown;
            try {
                parsed = JSON.parse(raw) as unknown;
            } catch (error) {
                throw new Error(
                    `recipes/${name} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
                );
            }

            return parseRecipePayload(name, parsed);
        });

/**
 * One pass over the release and the recipe directory.
 *
 * The whole-file key set is collected for the closure checks while the slice is
 * collected for the load, so neither needs a second pass and nothing but the
 * 11,046 `source_key` strings and the slice itself is ever resident.
 */
const readCorpus = async (): Promise<Corpus> => {
    const manifest = loadReleaseManifest(RELEASE_ID);
    const payloads = readRecipePayloads();

    const ingredientKeySet = new Set<string>();
    let ingredientRowCount = 0;
    for (const payload of payloads) {
        for (const ingredient of payload.ingredients) {
            ingredientKeySet.add(ingredient.sourceKey);
            ingredientRowCount += 1;
        }
    }

    const releaseKeys = new Set<string>();
    const foods: ReleaseFood[] = [];
    const measurements = new Map<string, FileMeasurement>();

    measurements.set(
        'foods.jsonl',
        await streamReleaseFile('foods.jsonl', (row, where) => {
            const food = parseFood(row, where);
            releaseKeys.add(food.source_key);
            if (ingredientKeySet.has(food.source_key)) {
                foods.push(food);
            }
        }),
    );

    const aliases: ReleaseAlias[] = [];
    const aliasOrphans: string[] = [];
    measurements.set(
        'aliases.jsonl',
        await streamReleaseFile('aliases.jsonl', (row, where) => {
            const alias = parseAlias(row, where);
            if (!releaseKeys.has(alias.food_source_key)) {
                aliasOrphans.push(`${where}: ${alias.food_source_key}`);
            }
            if (ingredientKeySet.has(alias.food_source_key)) {
                aliases.push(alias);
            }
        }),
    );

    const portions: ReleasePortion[] = [];
    const portionOrphans: string[] = [];
    measurements.set(
        'portions.jsonl',
        await streamReleaseFile('portions.jsonl', (row, where) => {
            const portion = parsePortion(row, where);
            if (!releaseKeys.has(portion.food_source_key)) {
                portionOrphans.push(`${where}: ${portion.food_source_key}`);
            }
            if (ingredientKeySet.has(portion.food_source_key)) {
                portions.push(portion);
            }
        }),
    );

    // Counted and digested like the rest. The release carries no components at
    // this revision, and an empty member is exactly what the manifest declares
    // — so it is measured rather than skipped, because a file that grew rows
    // nobody loads would otherwise pass unnoticed.
    measurements.set('components.jsonl', await streamReleaseFile('components.jsonl', () => undefined));

    const records: ReleaseValidationRecord[] = [];
    const recordOrphans: string[] = [];
    measurements.set(
        'validation-records.jsonl',
        await streamReleaseFile('validation-records.jsonl', (row, where) => {
            const record = parseValidationRecord(row, where);
            if (!releaseKeys.has(record.food_source_key)) {
                recordOrphans.push(`${where}: ${record.food_source_key}`);
            }
            if (ingredientKeySet.has(record.food_source_key)) {
                records.push(record);
            }
        }),
    );

    const ingredientKeys = [...ingredientKeySet].sort();

    return {
        manifest,
        measurements,
        payloads,
        slice: { foods, aliases, portions, records },
        orphans: {
            aliases: aliasOrphans,
            portions: portionOrphans,
            records: recordOrphans,
            ingredients: ingredientKeys.filter((key) => !releaseKeys.has(key)),
        },
        ingredientKeys,
        ingredientRowCount,
    };
};

/* ---------------------------------------------------------------------------
 * Applying the release — the reconciliation `catalog-load.ts` documents
 * ------------------------------------------------------------------------- */

const toFoodData = (food: ReleaseFood): Prisma.catalog_foodsUncheckedCreateInput => ({
    source_key: food.source_key,
    canonical_name: food.canonical_name,
    display_name: food.display_name,
    category: food.category,
    food_state: food.food_state,
    food_group: food.food_group,
    identity_source: food.identity_source,
    identity_status: food.identity_status,
    nutrition_provenance: food.nutrition_provenance,
    publication_status: food.publication_status,
    nutrition_basis: food.nutrition_basis,
    basis_amount: food.basis_amount,
    calories: food.calories,
    protein_g: food.protein_g,
    carbs_g: food.carbs_g,
    fat_g: food.fat_g,
    fiber_g: food.fiber_g,
    density_g_per_ml: food.density_g_per_ml,
    allergen_tags: food.allergen_tags,
    allergen_status: food.allergen_status,
    diet_tags: food.diet_tags,
    is_common_dislike: food.is_common_dislike,
    cost_class: food.cost_class,
    nutrition_version: food.nutrition_version,
    metadata_version: food.metadata_version,
    usda_fdc_id: food.usda_fdc_id,
    usda_data_type: food.usda_data_type,
    usda_description: food.usda_description,
    source_version: food.source_version,
    source_cache_key: food.source_cache_key,
    search_text: food.search_text,
    imported_at: food.imported_at === null ? null : new Date(food.imported_at),
});

interface CatalogApplyReport {
    readonly created: number;
    readonly updated: number;
}

/**
 * Loads the ingredient slice, reconciling on `source_key`.
 *
 * One transaction PER FOOD, each replacing that food's aliases, portions and
 * validation record wholesale — the reconciliation `catalog-load.ts`'s header
 * documents, and the reason a second application is a no-op rather than a
 * duplicate: the food row keeps its identity (so `recipe_ingredients` keeps
 * resolving) while its children are rewritten from the release.
 *
 * `generation_batch_key` is deliberately not mapped to `generation_batch_id`:
 * the local uuid means nothing in another database, which is why the release
 * exports the portable batch key, and every food in this slice carries a null
 * one. A slice food that arrived WITH a batch key would need
 * `catalog_generation_batches` loaded first, so it is refused here rather than
 * silently dropped.
 */
const applyCatalogSlice = async (slice: ReleaseSlice): Promise<CatalogApplyReport> => {
    const aliasesByFood = new Map<string, ReleaseAlias[]>();
    for (const alias of slice.aliases) {
        aliasesByFood.set(alias.food_source_key, [...(aliasesByFood.get(alias.food_source_key) ?? []), alias]);
    }

    const portionsByFood = new Map<string, ReleasePortion[]>();
    for (const portion of slice.portions) {
        portionsByFood.set(portion.food_source_key, [
            ...(portionsByFood.get(portion.food_source_key) ?? []),
            portion,
        ]);
    }

    const recordsByFood = new Map<string, ReleaseValidationRecord>();
    for (const record of slice.records) {
        recordsByFood.set(record.food_source_key, record);
    }

    let created = 0;
    let updated = 0;

    for (const food of slice.foods) {
        if (food.generation_batch_key !== null) {
            throw new Error(
                `${food.source_key} carries generation_batch_key "${food.generation_batch_key}", so loading it ` +
                    'requires catalog_generation_batches to be loaded first; this suite loads the ' +
                    'recipe-ingredient slice only.',
            );
        }

        const data = toFoodData(food);

        // Sequentially, one transaction per food: the reconciliation unit is a
        // food and its children, and a parallel fan-out would interleave 69
        // transactions for no measurable gain on a slice this size.
        await prisma.$transaction(async (tx) => {
            const existing = await tx.catalog_foods.findUnique({ where: { source_key: food.source_key } });
            const row = await tx.catalog_foods.upsert({
                where: { source_key: food.source_key },
                create: data,
                update: data,
            });

            if (existing === null) {
                created += 1;
            } else {
                updated += 1;
            }

            await tx.catalog_validation_records.deleteMany({ where: { catalog_food_id: row.id } });
            await tx.catalog_food_aliases.deleteMany({ where: { catalog_food_id: row.id } });
            await tx.catalog_food_portions.deleteMany({ where: { catalog_food_id: row.id } });

            const aliasRows = aliasesByFood.get(food.source_key) ?? [];
            if (aliasRows.length > 0) {
                await tx.catalog_food_aliases.createMany({
                    data: aliasRows.map((alias) => ({ catalog_food_id: row.id, alias: alias.alias })),
                });
            }

            const portionRows = portionsByFood.get(food.source_key) ?? [];
            if (portionRows.length > 0) {
                await tx.catalog_food_portions.createMany({
                    data: portionRows.map((portion) => ({
                        catalog_food_id: row.id,
                        description: portion.description,
                        amount: portion.amount,
                        unit: portion.unit,
                        gram_weight: portion.gram_weight,
                        is_default: portion.is_default,
                        source: portion.source,
                    })),
                });
            }

            const record = recordsByFood.get(food.source_key);
            if (record !== undefined) {
                await tx.catalog_validation_records.create({
                    data: {
                        catalog_food_id: row.id,
                        canonical_identity: record.canonical_identity,
                        aliases: record.aliases,
                        category: record.category,
                        food_state: record.food_state,
                        identity_source: record.identity_source,
                        identity_status: record.identity_status,
                        nutrition_provenance: record.nutrition_provenance,
                        nutrition_method: record.nutrition_method,
                        nutrition_assumptions: JSON.stringify(record.nutrition_assumptions),
                        portion_units: record.portion_units,
                        identity_evidence: record.identity_evidence,
                        checks: record.checks,
                        // `Prisma.DbNull` and not `null`: a nullable Json column
                        // distinguishes SQL NULL from the JSON value `null`, and
                        // `null` is not accepted by the client's input type.
                        llm_review: record.llm_review === null ? Prisma.DbNull : record.llm_review,
                        outcome: record.outcome,
                        reviewed_at: new Date(record.reviewed_at),
                        publication_status: record.publication_status,
                        source_versions: record.source_versions,
                        history: record.history,
                    },
                });
            }
        });
    }

    return { created, updated };
};

/* ---------------------------------------------------------------------------
 * Publishing the recipes
 * ------------------------------------------------------------------------- */

const requireAllergenStatus = (value: string, where: string): RecipeAllergenStatus => {
    if (value !== 'known' && value !== 'unknown') {
        throw new Error(`${where}: allergen_status must be "known" or "unknown", received "${value}"`);
    }

    return value;
};

const requireProvenance = (value: string, where: string): NutritionProvenance => {
    if (
        value !== 'source_backed' &&
        value !== 'ingredient_derived' &&
        value !== 'ai_estimated' &&
        value !== 'user_entered'
    ) {
        throw new Error(`${where}: nutrition_provenance "${value}" is outside the stored set`);
    }

    return value;
};

/**
 * A recipe ingredient's nutrition basis.
 *
 * `per_serving` is refused rather than mapped: an ingredient stated per serving
 * cannot be converted to grams without a sourced serving weight, which is why
 * `catalog.logic.ts` quarantines such a candidate instead of publishing it. A
 * release that shipped one as a recipe ingredient is a data defect, and this
 * names it.
 */
const requireBasis = (value: string, where: string): RecipeNutritionBasis => {
    if (value !== 'per_100g' && value !== 'per_100ml') {
        throw new Error(
            `${where}: a recipe ingredient's nutrition_basis must be per_100g or per_100ml, received "${value}"`,
        );
    }

    return value;
};

/* ---------------------------------------------------------------------------
 * Publishing the recipes: the production stage
 *
 * The corpus is published by `scripts/recipes-seed.ts::runSeed` — the same
 * function `npm run recipes:seed` calls — with four seams supplied: the Prisma
 * client, the committed recipe directory, a pinned clock and a coverage-report
 * path under `os.tmpdir()`. Nothing about the publication is restated here, so
 * this suite cannot agree with a seeder that is wrong; what it asserts is what
 * the stage left in the database.
 * ------------------------------------------------------------------------- */

/** Where the emitted coverage report goes, so the committed artefact is only ever READ. */
let emittedReportPath: string;

const silentLogger: ScriptLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => silentLogger,
};

const seedDeps = (): SeedDeps => ({
    prisma: prisma as unknown as SeedDb,
    recipesDir: recipesDir(),
    now: () => PUBLISHED_AT,
    options: { help: false, only: [], dryRun: false },
    logger: silentLogger,
    coveragePlan: loadCoveragePlan(),
    reportPath: emittedReportPath,
    writeReport: writeJsonFile,
});

/** The committed coverage report, as bytes and as parsed values. */
const committedReportPath = (): string => path.join(recipesDir(), COVERAGE_REPORT_FILE);

/* ---------------------------------------------------------------------------
 * Reading the loaded state back
 * ------------------------------------------------------------------------- */

interface StoredFood {
    readonly id: string;
    readonly source_key: string;
    readonly canonical_name: string;
    readonly display_name: string;
    readonly category: string;
    readonly food_state: string;
    readonly food_group: string;
    readonly publication_status: string;
    readonly nutrition_provenance: string;
    readonly allergen_status: string;
    readonly nutrition_basis: string;
    readonly basis_amount: number;
    readonly calories: number | null;
    readonly protein_g: number | null;
    readonly carbs_g: number | null;
    readonly fat_g: number | null;
    readonly fiber_g: number | null;
    readonly density_g_per_ml: number | null;
    readonly allergen_tags: string[];
    readonly diet_tags: string[];
    readonly cost_class: number;
    readonly nutrition_version: number;
    readonly metadata_version: number;
    readonly usda_fdc_id: number | null;
    readonly created_at: string;
}

interface StoredChildRow {
    readonly source_key: string;
    readonly content: string;
}

interface CatalogState {
    readonly foods: readonly StoredFood[];
    readonly aliases: readonly StoredChildRow[];
    readonly portions: readonly StoredChildRow[];
    readonly records: readonly StoredChildRow[];
}

/**
 * The loaded catalog as comparable values.
 *
 * `updated_at` is excluded and every other column is included. The column
 * carries `@updatedAt`, so re-applying a release legitimately moves it — it
 * records WHEN the row was last reconciled, not what it holds — while `id` and
 * `created_at` are included precisely because they must NOT move: a load that
 * recreated a food would break every `recipe_ingredients` row pointing at it.
 *
 * The child rows are compared by content keyed on their food's `source_key`
 * rather than by id, because the documented reconciliation replaces them
 * wholesale and their ids are therefore expected to change.
 */
const readCatalogState = async (): Promise<CatalogState> => {
    const foods = await prisma.catalog_foods.findMany({
        orderBy: { source_key: 'asc' },
        include: {
            catalog_food_aliases: { orderBy: { alias: 'asc' } },
            catalog_food_portions: { orderBy: { description: 'asc' } },
            catalog_validation_records: true,
        },
    });

    const aliases: StoredChildRow[] = [];
    const portions: StoredChildRow[] = [];
    const records: StoredChildRow[] = [];

    for (const food of foods) {
        for (const alias of food.catalog_food_aliases) {
            aliases.push({ source_key: food.source_key, content: JSON.stringify({ alias: alias.alias }) });
        }
        for (const portion of food.catalog_food_portions) {
            portions.push({
                source_key: food.source_key,
                content: JSON.stringify({
                    description: portion.description,
                    amount: portion.amount,
                    unit: portion.unit,
                    gram_weight: portion.gram_weight,
                    is_default: portion.is_default,
                    source: portion.source,
                }),
            });
        }
        const record = food.catalog_validation_records;
        if (record !== null) {
            records.push({
                source_key: food.source_key,
                content: JSON.stringify({
                    canonical_identity: record.canonical_identity,
                    aliases: record.aliases,
                    category: record.category,
                    food_state: record.food_state,
                    identity_source: record.identity_source,
                    identity_status: record.identity_status,
                    nutrition_provenance: record.nutrition_provenance,
                    nutrition_method: record.nutrition_method,
                    nutrition_assumptions: record.nutrition_assumptions,
                    portion_units: record.portion_units,
                    identity_evidence: record.identity_evidence,
                    checks: record.checks,
                    llm_review: record.llm_review,
                    outcome: record.outcome,
                    reviewed_at: record.reviewed_at.toISOString(),
                    publication_status: record.publication_status,
                    source_versions: record.source_versions,
                    history: record.history,
                }),
            });
        }
    }

    return {
        foods: foods.map((food) => ({
            id: food.id,
            source_key: food.source_key,
            canonical_name: food.canonical_name,
            display_name: food.display_name,
            category: food.category,
            food_state: food.food_state,
            food_group: food.food_group,
            publication_status: food.publication_status,
            nutrition_provenance: food.nutrition_provenance,
            allergen_status: food.allergen_status,
            nutrition_basis: food.nutrition_basis,
            basis_amount: food.basis_amount,
            calories: food.calories,
            protein_g: food.protein_g,
            carbs_g: food.carbs_g,
            fat_g: food.fat_g,
            fiber_g: food.fiber_g,
            density_g_per_ml: food.density_g_per_ml,
            allergen_tags: food.allergen_tags,
            diet_tags: food.diet_tags,
            cost_class: food.cost_class,
            nutrition_version: food.nutrition_version,
            metadata_version: food.metadata_version,
            usda_fdc_id: food.usda_fdc_id,
            created_at: food.created_at.toISOString(),
        })),
        aliases,
        portions,
        records,
    };
};

/** A stored recipe with its current version, its ingredients and their foods. */
type StoredRecipe = Prisma.recipesGetPayload<{
    include: {
        current_version: { include: { recipe_ingredients: { include: { catalog_foods: true } } } };
    };
}>;

const readStoredRecipes = async (): Promise<StoredRecipe[]> =>
    prisma.recipes.findMany({
        orderBy: { slug: 'asc' },
        include: {
            current_version: { include: { recipe_ingredients: { include: { catalog_foods: true } } } },
        },
    });

/**
 * A stored recipe's ingredients in the shape the derivation reads — from the
 * `recipe_ingredients` snapshot columns for everything the snapshot holds, and
 * from the joined `catalog_foods` row for the three facts it does not
 * (`allergen_status`, `cost_class`, the nutrition basis and its density), which
 * is exactly what `recipe.service.ts` does at read time.
 */
const storedPublicationIngredients = (recipe: StoredRecipe): RecipePublicationIngredient[] => {
    const version = recipe.current_version;
    if (version === null) {
        throw new Error(`${recipe.slug}: no current version is stored`);
    }

    return version.recipe_ingredients.map((row) => ({
        catalog_food_id: row.catalog_food_id,
        snapshot_name: row.snapshot_name,
        snapshot_provenance: requireProvenance(row.snapshot_provenance, `${recipe.slug}/${row.snapshot_name}`),
        snapshot_allergen_tags: row.snapshot_allergen_tags,
        snapshot_diet_tags: row.snapshot_diet_tags,
        is_optional: row.is_optional,
        food_group: row.catalog_foods.food_group,
        allergen_status: requireAllergenStatus(
            row.catalog_foods.allergen_status,
            `${recipe.slug}/${row.snapshot_name}`,
        ),
        cost_class: row.catalog_foods.cost_class,
        catalog_nutrition_version: row.catalog_nutrition_version,
        catalog_metadata_version: row.catalog_metadata_version,
        snapshot_per_100g: row.snapshot_per_100g as unknown as RecipeIngredientNutrientSnapshot,
        quantity: row.quantity,
        unit: row.unit,
        gram_weight: row.gram_weight,
        display_text: row.display_text,
        sort_order: row.sort_order,
        nutrition_basis: requireBasis(row.catalog_foods.nutrition_basis, `${recipe.slug}/${row.snapshot_name}`),
        density_g_per_ml: row.catalog_foods.density_g_per_ml,
    }));
};

/** A user who has answered nothing restrictive: every hard rule still applies. */
const UNRESTRICTED_PREFERENCES: PlanningPreferences = {
    diet: null,
    allergens: [],
    disliked_food_ids: [],
    disliked_food_groups: [],
    cooking_time_limit_min: null,
};

/* ---------------------------------------------------------------------------
 * The run
 * ------------------------------------------------------------------------- */

let corpus: Corpus;
let catalogApply: CatalogApplyReport;
let recipeApply: SeedOutcome;
let emittedReport: string;
let catalogAfterFirstApply: CatalogState;
let storedRecipes: StoredRecipe[];
let foodIdBySourceKey: Map<string, string>;

beforeAll(async () => {
    await truncateFeatureTables();

    corpus = await readCorpus();
    emittedReportPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'seed-rerun-report-')), COVERAGE_REPORT_FILE);

    catalogApply = await applyCatalogSlice(corpus.slice);

    const loaded = await prisma.catalog_foods.findMany({ select: { id: true, source_key: true } });
    foodIdBySourceKey = new Map(loaded.map((row) => [row.source_key, row.id]));

    recipeApply = await runSeed(seedDeps());
    emittedReport = fs.readFileSync(emittedReportPath, 'utf8');

    catalogAfterFirstApply = await readCatalogState();
    storedRecipes = await readStoredRecipes();
}, LOAD_TIMEOUT_MS);

afterAll(async () => {
    await truncateFeatureTables();
    fs.rmSync(path.dirname(emittedReportPath), { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- */

describe('the v1 release manifest', () => {
    it('declares the five data files the release format contract lists', () => {
        expect(corpus.manifest.files.map((entry) => entry.path)).toEqual([...RELEASE_DATA_FILES]);
        // `name` is the same string under the name the release format uses, and
        // `catalog-load.ts` reads `path`; a manifest where the two disagree
        // would verify one file and load another.
        for (const entry of corpus.manifest.files) {
            expect(entry.name ?? entry.path).toBe(entry.path);
        }
    });

    it.each([...RELEASE_DATA_FILES])(
        'recomputes %s to the SHA-256, byte length and row count the manifest declares',
        (fileName) => {
            const declared = corpus.manifest.files.find((entry) => entry.path === fileName);
            const observed = corpus.measurements.get(fileName);

            expect(declared).toBeDefined();
            expect(observed).toBeDefined();
            expect({
                sha256: observed?.sha256,
                bytes: observed?.bytes,
                row_count: observed?.rowCount,
            }).toEqual({
                sha256: declared?.sha256,
                bytes: declared?.bytes,
                row_count: declared?.row_count,
            });
        },
    );

    it('agrees with the streamed row counts in its counts block', () => {
        const counts = corpus.manifest.counts;
        const rowCount = (fileName: string): number | undefined => corpus.measurements.get(fileName)?.rowCount;

        expect(counts.foods).toBe(rowCount('foods.jsonl'));
        // A release exports published foods only, so the two spellings are one
        // measurement — asserted rather than assumed, since `catalog-load.ts`
        // refuses to move the release pointer unless the loaded counts match.
        expect(counts.published_foods ?? counts.foods).toBe(rowCount('foods.jsonl'));
        expect(counts.aliases).toBe(rowCount('aliases.jsonl'));
        expect(counts.portions).toBe(rowCount('portions.jsonl'));
        expect(counts.components).toBe(rowCount('components.jsonl'));
        expect(counts.validation_records).toBe(rowCount('validation-records.jsonl'));
    });
});

describe('the recipe corpus as committed', () => {
    it('holds at least forty payloads, each file named for the slug inside it', () => {
        expect(corpus.payloads.length).toBeGreaterThanOrEqual(MINIMUM_RECIPE_COUNT);

        const misnamed = corpus.payloads
            .filter((payload) => `${payload.slug}.json` !== payload.file)
            .map((payload) => `${payload.file} declares slug "${payload.slug}"`);
        expect(misnamed).toEqual([]);

        const slugs = corpus.payloads.map((payload) => payload.slug);
        expect(new Set(slugs).size).toBe(slugs.length);
    });

    it('declares only closed-set icon keys, meal slots and badges', () => {
        const offences: string[] = [];

        for (const payload of corpus.payloads) {
            if (!isRecipeIconKey(payload.iconKey)) {
                offences.push(`${payload.slug}: iconKey "${payload.iconKey}"`);
            }
            if (payload.mealSlots.length === 0) {
                offences.push(`${payload.slug}: no mealSlots, so it is never plannable`);
            }
            for (const slot of payload.mealSlots) {
                if (!isMealSlot(slot)) {
                    offences.push(`${payload.slug}: mealSlot "${slot}"`);
                }
            }
            for (const badge of payload.badges) {
                if (!isRecipeBadge(badge)) {
                    offences.push(`${payload.slug}: badge "${badge}"`);
                }
            }
        }

        expect(offences).toEqual([]);
    });

    it('resolves every ingredient source key to a food in the release', () => {
        expect(corpus.orphans.ingredients).toEqual([]);
        expect(corpus.slice.foods).toHaveLength(corpus.ingredientKeys.length);

        // A payload with no ingredient has no derivable nutrition at all, so
        // the emptiness is named here rather than surfacing as a throw from the
        // derivation with no slug attached.
        const withoutIngredients = corpus.payloads
            .filter((payload) => payload.ingredients.length === 0)
            .map((payload) => payload.slug);
        expect(withoutIngredients).toEqual([]);
    });

    it('names no alias, portion or validation record outside foods.jsonl', () => {
        expect(corpus.orphans.aliases).toEqual([]);
        expect(corpus.orphans.portions).toEqual([]);
        expect(corpus.orphans.records).toEqual([]);
    });
});

describe('loading the ingredient slice into PostgreSQL', () => {
    it('inserts one catalog_foods row per distinct ingredient source key', () => {
        expect(catalogApply).toEqual({ created: corpus.ingredientKeys.length, updated: 0 });
        expect(catalogAfterFirstApply.foods.map((food) => food.source_key)).toEqual([...corpus.ingredientKeys]);
    });

    it('stores every alias, portion and validation record the release carries for them', () => {
        expect(catalogAfterFirstApply.aliases).toHaveLength(corpus.slice.aliases.length);
        expect(catalogAfterFirstApply.portions).toHaveLength(corpus.slice.portions.length);
        expect(catalogAfterFirstApply.records).toHaveLength(corpus.slice.records.length);

        const storedAliases = catalogAfterFirstApply.aliases
            .map((row) => `${row.source_key}|${JSON.parse(row.content).alias as string}`)
            .sort();
        const releaseAliases = corpus.slice.aliases.map((alias) => `${alias.food_source_key}|${alias.alias}`).sort();
        expect(storedAliases).toEqual(releaseAliases);

        const storedPortions = catalogAfterFirstApply.portions
            .map((row) => {
                const portion = JSON.parse(row.content) as Omit<ReleasePortion, 'food_source_key'>;
                return `${row.source_key}|${portion.description}|${portion.amount}|${portion.unit}|${portion.gram_weight}|${portion.is_default}|${portion.source}`;
            })
            .sort();
        const releasePortions = corpus.slice.portions
            .map(
                (portion) =>
                    `${portion.food_source_key}|${portion.description}|${portion.amount}|${portion.unit}|${portion.gram_weight}|${portion.is_default}|${portion.source}`,
            )
            .sort();
        expect(storedPortions).toEqual(releasePortions);
    });

    it('computes the generated search_vector for every inserted food', async () => {
        const rows = await prisma.$queryRawUnsafe<{ source_key: string; has_vector: boolean }[]>(
            'SELECT source_key, search_vector IS NOT NULL AS has_vector FROM catalog_foods ORDER BY source_key',
        );

        expect(rows).toHaveLength(corpus.ingredientKeys.length);
        expect(rows.filter((row) => !row.has_vector)).toEqual([]);
    });

    it('keeps the source key, the USDA id and the published identity unique', async () => {
        const duplicates = await prisma.$queryRawUnsafe<{ kind: string; value: string; occurrences: bigint }[]>(
            `SELECT 'source_key' AS kind, source_key AS value, count(*) AS occurrences
               FROM catalog_foods GROUP BY source_key HAVING count(*) > 1
             UNION ALL
             SELECT 'usda_fdc_id', usda_fdc_id::text, count(*)
               FROM catalog_foods WHERE usda_fdc_id IS NOT NULL GROUP BY usda_fdc_id HAVING count(*) > 1
             UNION ALL
             SELECT 'published_identity', canonical_name || ' / ' || food_state, count(*)
               FROM catalog_foods WHERE publication_status = 'published'
               GROUP BY canonical_name, food_state HAVING count(*) > 1`,
        );

        expect(duplicates).toEqual([]);
    });

    it('round-trips each validation record, including the JSON-text assumptions column', async () => {
        const stored = await prisma.catalog_validation_records.findMany({
            include: { catalog_foods: { select: { source_key: true } } },
        });
        const storedByKey = new Map(stored.map((row) => [row.catalog_foods.source_key, row]));

        expect(storedByKey.size).toBe(corpus.slice.records.length);

        for (const record of corpus.slice.records) {
            const row = storedByKey.get(record.food_source_key);
            expect(row).toBeDefined();
            if (row === undefined) {
                continue;
            }

            expect(row.canonical_identity).toEqual(record.canonical_identity);
            expect(row.portion_units).toEqual(record.portion_units);
            expect(row.checks).toEqual(record.checks);
            expect(row.identity_evidence).toEqual(record.identity_evidence);
            expect(row.source_versions).toEqual(record.source_versions);
            expect(row.aliases.slice().sort()).toEqual(record.aliases.slice().sort());
            expect(row.outcome).toBe(record.outcome);
            expect(row.publication_status).toBe(record.publication_status);
            expect(row.reviewed_at.toISOString()).toBe(new Date(record.reviewed_at).toISOString());
            expect(row.nutrition_assumptions).not.toBeNull();
            expect(JSON.parse(row.nutrition_assumptions ?? 'null')).toEqual(record.nutrition_assumptions);
        }
    });
});

describe('referential closure inside the database', () => {
    it('resolves every alias, portion and validation record to a loaded food', async () => {
        const orphans = await prisma.$queryRawUnsafe<{ kind: string; child_id: string }[]>(
            `SELECT 'alias' AS kind, a.id::text AS child_id
               FROM catalog_food_aliases a LEFT JOIN catalog_foods f ON f.id = a.catalog_food_id
               WHERE f.id IS NULL
             UNION ALL
             SELECT 'portion', p.id::text
               FROM catalog_food_portions p LEFT JOIN catalog_foods f ON f.id = p.catalog_food_id
               WHERE f.id IS NULL
             UNION ALL
             SELECT 'validation_record', v.id::text
               FROM catalog_validation_records v LEFT JOIN catalog_foods f ON f.id = v.catalog_food_id
               WHERE f.id IS NULL`,
        );

        expect(orphans).toEqual([]);
    });

    it('resolves every recipe ingredient row to a loaded food', async () => {
        const rows = await prisma.recipe_ingredients.findMany({
            include: { catalog_foods: { select: { source_key: true } } },
        });

        expect(rows).toHaveLength(corpus.ingredientRowCount);

        const unresolved = rows.filter((row) => !foodIdBySourceKey.has(row.catalog_foods.source_key));
        expect(unresolved).toEqual([]);

        const referenced = new Set(rows.map((row) => row.catalog_foods.source_key));
        expect([...referenced].sort()).toEqual([...corpus.ingredientKeys]);
    });
});

describe('the planning preconditions every recipe ingredient must satisfy', () => {
    it('publishes each one with source-backed nutrition and a known allergen review', () => {
        const offences = catalogAfterFirstApply.foods
            .filter(
                (food) =>
                    food.publication_status !== 'published' ||
                    food.nutrition_provenance !== 'source_backed' ||
                    food.allergen_status !== 'known',
            )
            .map(
                (food) =>
                    `${food.source_key}: publication_status=${food.publication_status}, ` +
                    `nutrition_provenance=${food.nutrition_provenance}, allergen_status=${food.allergen_status}`,
            );

        expect(offences).toEqual([]);
    });

    it('states finite calories, protein, carbohydrate and fat for each one', () => {
        const offences: string[] = [];

        for (const food of catalogAfterFirstApply.foods) {
            for (const [field, value] of Object.entries({
                calories: food.calories,
                protein_g: food.protein_g,
                carbs_g: food.carbs_g,
                fat_g: food.fat_g,
            })) {
                if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
                    offences.push(`${food.source_key}.${field} = ${render(value)}`);
                }
            }
            if (food.nutrition_basis === 'per_100ml' && food.density_g_per_ml === null) {
                offences.push(`${food.source_key} is stated per 100 ml with no density, so it cannot convert to grams`);
            }
        }

        expect(offences).toEqual([]);
    });

    it('gives each one exactly one default portion with a positive gram weight', async () => {
        const foods = await prisma.catalog_foods.findMany({
            orderBy: { source_key: 'asc' },
            include: { catalog_food_portions: true },
        });

        const offences: string[] = [];
        for (const food of foods) {
            const defaults = food.catalog_food_portions.filter((portion) => portion.is_default);
            if (defaults.length !== 1) {
                offences.push(`${food.source_key}: ${defaults.length} default portions`);
                continue;
            }
            if (!(defaults[0].gram_weight > 0)) {
                offences.push(`${food.source_key}: default portion gram_weight = ${defaults[0].gram_weight}`);
            }
        }

        expect(offences).toEqual([]);
    });
});

describe('recipe nutrition recomputed from the stored rows', () => {
    it('publishes one current version per payload, with its ingredient rows', () => {
        expect(recipeApply.promoted).toEqual([]);
        expect(recipeApply.created).toEqual(corpus.payloads.map((payload) => payload.slug).sort());
        expect(recipeApply.unchanged).toEqual([]);
        expect(recipeApply.ingredientRows).toBe(corpus.ingredientRowCount);
        expect(storedRecipes).toHaveLength(corpus.payloads.length);

        const withoutCurrent = storedRecipes.filter((recipe) => recipe.current_version === null).map((r) => r.slug);
        expect(withoutCurrent).toEqual([]);
    });

    it('recomputes every stored per-serving figure from the stored gram weights and per-100 g snapshots', () => {
        const offences: string[] = [];

        for (const recipe of storedRecipes) {
            const version = recipe.current_version;
            if (version === null) {
                continue;
            }

            const ingredients = storedPublicationIngredients(recipe);
            const nutrition = deriveRecipeNutrition(ingredients, version.yield_servings);

            for (const [field, stored, recomputed] of [
                ['per_serving_calories', version.per_serving_calories, nutrition.perServing.calories],
                ['per_serving_protein_g', version.per_serving_protein_g, nutrition.perServing.protein],
                ['per_serving_carbs_g', version.per_serving_carbs_g, nutrition.perServing.carbs],
                ['per_serving_fat_g', version.per_serving_fat_g, nutrition.perServing.fat],
            ] as const) {
                if (!sameStoredNumber(stored, recomputed)) {
                    offences.push(
                        `${recipe.slug}.${field}: stored ${stored}, recomputed ${recomputed}, relative gap ` +
                            `${Math.abs(stored - recomputed) / Math.max(Math.abs(stored), Math.abs(recomputed))}`,
                    );
                }
                if (!Number.isFinite(recomputed) || recomputed <= 0) {
                    offences.push(`${recipe.slug}.${field}: recomputed ${recomputed} is not a positive finite number`);
                }
            }

            // Fibre is a PROPAGATION rule, not a number: it is summed only when
            // every ingredient states it, and three foods in this slice state
            // none, so four recipes hold null here. Asserting a value would
            // either fail on those or force a 0 that no source stated.
            const everyFibreKnown = ingredients.every(
                (ingredient) =>
                    ingredient.snapshot_per_100g.fiber_g !== null &&
                    ingredient.snapshot_per_100g.fiber_g !== undefined,
            );
            if (everyFibreKnown !== (nutrition.total.fiber !== null)) {
                offences.push(
                    `${recipe.slug}: fibre known on every ingredient = ${everyFibreKnown}, ` +
                        `derived total fibre = ${render(nutrition.total.fiber)}`,
                );
            }
        }

        expect(offences).toEqual([]);
    });

    it('divides the whole-recipe totals by yield_servings exactly', () => {
        const offences: string[] = [];

        for (const recipe of storedRecipes) {
            const version = recipe.current_version;
            if (version === null) {
                continue;
            }

            const nutrition = deriveRecipeNutrition(storedPublicationIngredients(recipe), version.yield_servings);
            const expected = {
                calories: nutrition.total.calories / version.yield_servings,
                protein: nutrition.total.protein / version.yield_servings,
                carbs: nutrition.total.carbs / version.yield_servings,
                fat: nutrition.total.fat / version.yield_servings,
            };

            if (JSON.stringify(nutrition.perServing) !== JSON.stringify(expected)) {
                offences.push(
                    `${recipe.slug}: per serving ${render(nutrition.perServing)} is not the total ` +
                        `${render(nutrition.total)} divided by ${version.yield_servings}`,
                );
            }
        }

        expect(offences).toEqual([]);
    });

    it('stores total_minutes as prep plus cook for every recipe', () => {
        const offences: string[] = [];

        for (const recipe of storedRecipes) {
            const version = recipe.current_version;
            if (version === null) {
                continue;
            }

            const derived = deriveTotalMinutes(version.prep_minutes, version.cook_minutes);
            if (version.total_minutes !== derived) {
                offences.push(
                    `${recipe.slug}: total_minutes ${version.total_minutes} is not ` +
                        `${version.prep_minutes} + ${version.cook_minutes}`,
                );
            }
        }

        expect(offences).toEqual([]);
    });

    it('records a sourced-calories note exactly where the 4/4/9 estimate diverges beyond the threshold', () => {
        const offences: string[] = [];
        let withNote = 0;

        for (const recipe of storedRecipes) {
            const version = recipe.current_version;
            if (version === null) {
                continue;
            }

            const nutrition = deriveRecipeNutrition(storedPublicationIngredients(recipe), version.yield_servings);
            const divergence = nutrition.calorieDivergence;
            const expectsNote = divergence !== null && divergence > SOURCED_CALORIE_DIVERGENCE_THRESHOLD;

            if (expectsNote) {
                withNote += 1;
            }
            if (expectsNote !== (version.sourced_calories_note !== null)) {
                offences.push(
                    `${recipe.slug}: divergence ${render(divergence)} against threshold ` +
                        `${SOURCED_CALORIE_DIVERGENCE_THRESHOLD}, stored note ${render(version.sourced_calories_note)}`,
                );
            }
            if (version.sourced_calories_note !== null) {
                expect(version.sourced_calories_note).toBe(nutrition.sourcedCaloriesNote);
            }
        }

        expect(offences).toEqual([]);
        // The disclosure is real rather than theoretical in this corpus, so the
        // clause above is not passing because nothing exercises it.
        expect(withNote).toBeGreaterThan(0);
    });
});

describe('the declarations this corpus makes about its recipes', () => {
    /**
     * Declared versus DERIVED, for every field §0.7.3 holds a recipe file to.
     *
     * The stored column is the DERIVATION's own output — the seed publishes no
     * declared value — so an agreement here is the file's declaration being
     * confirmed by the rules that will consume it. The seed's own gate refuses
     * a disagreement outright, which is why these five cases could not have
     * reached the database disagreeing: they restate that gate's verdict
     * field by field, so a future corpus edit that drifted is named here with
     * its slug and its field rather than only as a refused run.
     *
     * `diet_tags` is among them. Seafood admissibility is carried by the
     * `pescatarian` tag and by no other spelling — an earlier release spelled
     * it `pescatarian_ok`, which the runtime `pescatarian` diet code does not
     * match — and this case is what pins the two to the same vocabulary.
     */
    interface DeclarationCase {
        readonly field: string;
        readonly declared: (payload: RecipePayload) => unknown;
        readonly stored: (version: NonNullable<StoredRecipe['current_version']>) => unknown;
    }

    const declarationCases: readonly DeclarationCase[] = [
        {
            field: 'diet_tags',
            declared: (payload) => payload.dietTags.slice().sort(),
            stored: (version) => version.diet_tags.slice().sort(),
        },
        {
            field: 'allergen_tags',
            declared: (payload) => payload.allergenTags.slice().sort(),
            stored: (version) => version.allergen_tags.slice().sort(),
        },
        {
            field: 'allergen_status',
            declared: (payload) => payload.allergenStatus,
            stored: (version) => version.allergen_status,
        },
        {
            field: 'badges',
            declared: (payload) => payload.badges.slice().sort(),
            stored: (version) => version.badges.slice().sort(),
        },
        {
            field: 'budget_tier',
            declared: (payload) => payload.budgetTier,
            stored: (version) => version.budget_tier,
        },
    ];

    it.each(declarationCases)(
        'derives the declared $field of every payload from its ingredient set',
        ({ field, declared, stored }: DeclarationCase) => {
            const offences: string[] = [];

            for (const recipe of storedRecipes) {
                const version = recipe.current_version;
                const payload = corpus.payloads.find((entry) => entry.slug === recipe.slug);
                if (version === null || payload === undefined) {
                    offences.push(`${recipe.slug}: no current version, or no payload to compare it with`);
                    continue;
                }

                const declaredValue = declared(payload);
                const storedValue = stored(version);
                if (JSON.stringify(storedValue) !== JSON.stringify(declaredValue)) {
                    offences.push(
                        `${recipe.slug}.${field}: declared ${render(declaredValue)}, derived ${render(storedValue)}`,
                    );
                }
            }

            expect(offences).toEqual([]);
        },
    );

    it('stores source-backed provenance on every published version', () => {
        const offences = storedRecipes
            .filter((recipe) => recipe.current_version?.nutrition_provenance !== 'source_backed')
            .map((recipe) => `${recipe.slug}: ${render(recipe.current_version?.nutrition_provenance)}`);

        expect(offences).toEqual([]);
    });
});

describe('planning eligibility for a user who has answered nothing restrictive', () => {
    it('admits every stored recipe version for every slot it declares', () => {
        const refusals: string[] = [];

        for (const recipe of storedRecipes) {
            const version = recipe.current_version;
            if (version === null) {
                continue;
            }

            const ingredients = storedPublicationIngredients(recipe);
            const planningVersion = {
                status: 'current' as const,
                nutrition_provenance: requireProvenance(version.nutrition_provenance, recipe.slug),
                allergen_status: requireAllergenStatus(version.allergen_status, recipe.slug),
                total_minutes: version.total_minutes,
                meal_slots: version.meal_slots,
                ingredients,
            };

            for (const slot of version.meal_slots) {
                if (!isMealSlot(slot)) {
                    refusals.push(`${recipe.slug}: stored meal slot "${slot}" is outside the closed set`);
                    continue;
                }

                const verdict = evaluatePlanningEligibility(planningVersion, UNRESTRICTED_PREFERENCES, slot);
                if (!verdict.eligible) {
                    refusals.push(`${recipe.slug}/${slot}: ${render(verdict.reasons)}`);
                }
            }
        }

        expect(refusals).toEqual([]);
    });
});

describe('the coverage matrix the seed derives from the seeded rows', () => {
    /**
     * §0.7.3's claim about this corpus, settled against the database rather
     * than against the files: the guaranteed profiles hold at least four
     * eligible recipes per slot — which is what the repeat rule (at most two
     * uses a week, never on consecutive days) needs to fill seven days — and
     * the reduced profiles at least two, which is asserted and explicitly NOT
     * sufficient for a week.
     */
    const report = (): CoverageReport => {
        if (recipeApply.report === null) {
            throw new Error('the seed reported no coverage matrix, so §0.7.3 cannot be asserted from it');
        }

        return recipeApply.report;
    };

    it('counts the corpus and its cross-listed recipes', () => {
        expect(report().recipeCount).toBe(corpus.payloads.length);
        expect(report().crossListedRecipeCount).toBe(
            corpus.payloads.filter((payload) => payload.mealSlots.length > 1).length,
        );
        expect(report().eligibleCounts).toHaveLength(
            report().dimensions.diets.length *
                report().dimensions.allergens.length *
                report().dimensions.slots.length *
                report().dimensions.timeTiers.length,
        );
    });

    it('satisfies every guaranteed cell: at least four eligible recipes', () => {
        const shortfalls = report()
            .guaranteedCells.filter((cell) => cell.count < cell.threshold)
            .map(
                (cell) =>
                    `${cell.diet}/${cell.allergen}/${cell.slot}/<=${cell.timeTier}min: ${cell.count} eligible, ` +
                    `threshold ${cell.threshold}`,
            );

        expect(shortfalls).toEqual([]);
        // The clause is not passing because nothing exercises it.
        expect(report().guaranteedCells.length).toBeGreaterThan(0);
        expect(report().guaranteedCells.every((cell) => cell.threshold === 4)).toBe(true);
    });

    it('satisfies every reduced cell: at least two eligible recipes', () => {
        const shortfalls = report()
            .reducedCells.filter((cell) => cell.count < cell.threshold)
            .map(
                (cell) =>
                    `${cell.diet}/${cell.allergen}/${cell.slot}/<=${cell.timeTier}min: ${cell.count} eligible, ` +
                    `threshold ${cell.threshold}`,
            );

        expect(shortfalls).toEqual([]);
        expect(report().reducedCells.length).toBeGreaterThan(0);
        expect(report().reducedCells.every((cell) => cell.threshold === 2)).toBe(true);
    });

    it('meets the §0.7.3 composition floors for every slot that states them', () => {
        const shortfalls: string[] = [];

        for (const [slot, composition] of Object.entries(report().slotComposition)) {
            for (const [stratum, value] of Object.entries(composition.composition)) {
                if (value.floor !== null && value.count < value.floor) {
                    shortfalls.push(`${slot}.${stratum}: ${value.count} recipes, floor ${value.floor}`);
                }
            }
        }

        expect(shortfalls).toEqual([]);
    });

    it('equals the committed data/meal-planning/recipes/coverage-report.json', () => {
        const committed = JSON.parse(fs.readFileSync(committedReportPath(), 'utf8')) as unknown;

        // Parsed first, so a failure names the member that moved rather than a
        // byte offset...
        expect(JSON.parse(JSON.stringify(report()))).toEqual(committed);
        // ...and byte for byte after it, which is what makes the committed
        // artefact reviewable as a diff.
        expect(emittedReport).toBe(fs.readFileSync(committedReportPath(), 'utf8'));
    });

    it('wrote its output to the injected path and left the committed artefact alone', () => {
        expect(recipeApply.reportPath).toBe(emittedReportPath);
        expect(emittedReportPath.startsWith(recipesDir())).toBe(false);
        expect(recipeApply.reportSkippedReason).toBeNull();
    });
});

describe('re-applying the same release', () => {
    let secondCatalogApply: CatalogApplyReport;
    let secondRecipeApply: SeedOutcome;
    let secondEmittedReport: string;
    let catalogAfterSecondApply: CatalogState;
    let recipesAfterSecondApply: StoredRecipe[];

    beforeAll(async () => {
        secondCatalogApply = await applyCatalogSlice(corpus.slice);
        secondRecipeApply = await runSeed(seedDeps());
        secondEmittedReport = fs.readFileSync(emittedReportPath, 'utf8');
        catalogAfterSecondApply = await readCatalogState();
        recipesAfterSecondApply = await readStoredRecipes();
    }, LOAD_TIMEOUT_MS);

    it('updates every food in place and creates none', () => {
        expect(secondCatalogApply).toEqual({ created: 0, updated: corpus.ingredientKeys.length });
    });

    it('keeps every food row id, created_at and content, so recipe ingredients still resolve', () => {
        expect(catalogAfterSecondApply.foods).toEqual(catalogAfterFirstApply.foods);
    });

    it('leaves the alias, portion and validation record content identical', () => {
        expect(catalogAfterSecondApply.aliases).toEqual(catalogAfterFirstApply.aliases);
        expect(catalogAfterSecondApply.portions).toEqual(catalogAfterFirstApply.portions);
        expect(catalogAfterSecondApply.records).toEqual(catalogAfterFirstApply.records);
    });

    it('publishes no second recipe, version or ingredient row and promotes nothing', async () => {
        expect(secondRecipeApply.created).toEqual([]);
        expect(secondRecipeApply.promoted).toEqual([]);
        expect(secondRecipeApply.unchanged).toEqual(corpus.payloads.map((payload) => payload.slug).sort());
        expect(secondRecipeApply.ingredientRows).toBe(0);

        expect(await prisma.recipes.count()).toBe(corpus.payloads.length);
        expect(await prisma.recipe_versions.count()).toBe(corpus.payloads.length);
        expect(await prisma.recipe_ingredients.count()).toBe(corpus.ingredientRowCount);
    });

    it('re-emits a byte-identical coverage report', () => {
        // The one property that makes the committed artefact reviewable: a rerun
        // that reordered a key or moved a float would show as a whole-file diff
        // and bury the change a reviewer is there to read.
        expect(secondEmittedReport).toBe(emittedReport);
    });

    it('holds one current version per recipe, still at version 1, with no duplicate slug', () => {
        const slugs = recipesAfterSecondApply.map((recipe) => recipe.slug);
        expect(slugs).toEqual(storedRecipes.map((recipe) => recipe.slug));
        expect(new Set(slugs).size).toBe(slugs.length);

        const offences: string[] = [];
        for (const recipe of recipesAfterSecondApply) {
            const version = recipe.current_version;
            if (version === null) {
                offences.push(`${recipe.slug}: no current version after the rerun`);
                continue;
            }
            if (version.version !== FIRST_VERSION) {
                offences.push(`${recipe.slug}: version ${version.version}`);
            }
            if (version.status !== 'current') {
                offences.push(`${recipe.slug}: status ${version.status}`);
            }
            if (recipe.current_version_id !== version.id) {
                offences.push(`${recipe.slug}: current_version_id does not point at the current version`);
            }
        }
        expect(offences).toEqual([]);

        const retired = recipesAfterSecondApply.filter((recipe) => recipe.current_version?.retired_at !== null);
        expect(retired).toEqual([]);
    });
});

/* ===========================================================================
 * THE MUTATING HALF — claims 9 to 13
 *
 * Everything above reads the state the top-level `beforeAll` produced. What
 * follows CHANGES that state — it publishes new versions, refuses invalid
 * corpora and finally truncates — so it is declared last, and the order of the
 * blocks below is the order those writes happen in.
 *
 * THE FOUR SEAMS ARE THE SAME FOUR. Every run here is still
 * `scripts/recipes-seed.ts::runSeed`, still with the real Prisma client, a
 * pinned clock and an injected report path; only the recipe DIRECTORY changes,
 * and only ever to a copy under `os.tmpdir()`. Nothing in
 * `data/meal-planning/` is written, which is the one property that lets a
 * coverage regression fail this suite instead of being committed by it.
 * ========================================================================= */

/** The instant a promotion is stamped with, so `retired_at` is distinguishable from `published_at`. */
const PROMOTED_AT = new Date('2026-09-14T08:30:00.000Z');

/** A third instant, for the second promotion of a recipe that was already at version 2. */
const RESTALED_AT = new Date('2026-09-15T09:15:00.000Z');

/** Directories this half wrote under `os.tmpdir()`, removed when the file finishes. */
const temporaryDirectories: string[] = [];

afterAll(() => {
    for (const directory of temporaryDirectories) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

/**
 * One committed payload as raw JSON.
 *
 * Deliberately NOT read through `parseRecipePayload`: half the cases below
 * state a value the typed parse refuses — an icon key outside the closed set, a
 * zero gram weight — and a harness that could not express them could not show
 * that the seed rejects them.
 */
type RawPayload = Record<string, unknown>;

const readCommittedPayload = (file: string): RawPayload =>
    asRecord(JSON.parse(fs.readFileSync(path.join(recipesDir(), file), 'utf8')) as unknown, `recipes/${file}`);

/** A list member of a raw payload, for the cases that edit one. */
const rawList = (payload: RawPayload, field: string, where: string): unknown[] => {
    const value = payload[field];
    if (!Array.isArray(value)) {
        throw new Error(`${where}: ${field} is ${render(value)} in the committed file, so this case cannot edit it`);
    }

    return value;
};

interface TemporaryPayload {
    /** The committed file this copy starts from, so every case begins from a corpus that passes. */
    readonly file: string;
    /** Applied to the copy. Omitted, the copy is byte-equivalent to the committed payload. */
    readonly edit?: (payload: RawPayload) => void;
}

/**
 * A recipe directory under `os.tmpdir()` holding copies of the named committed
 * payloads, each edited in memory before it is written.
 *
 * A directory holding ONE payload is the normal case here, and it is what keeps
 * these blocks fast and their claims narrow: `runSeed` publishes what the
 * directory holds and leaves every other stored recipe alone, so "only the
 * changed recipe was promoted" is a claim about the database rather than about
 * a filter.
 */
const writeTemporaryCorpus = (payloads: readonly TemporaryPayload[]): string => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-rerun-corpus-'));
    temporaryDirectories.push(directory);

    for (const { file, edit } of payloads) {
        const payload = readCommittedPayload(file);
        edit?.(payload);
        fs.writeFileSync(path.join(directory, file), `${JSON.stringify(payload, null, 4)}\n`, 'utf8');
    }

    return directory;
};

/** Every event the stage reported, for the claims that read what an operator would see. */
interface RecordedEvent {
    readonly event: string;
    readonly fields?: LogFields;
}

const recordingLogger = (recorded: RecordedEvent[]): ScriptLogger => {
    const record = (event: string, fields?: LogFields): void => {
        recorded.push({ event, fields });
    };

    const logger: ScriptLogger = {
        debug: record,
        info: record,
        warn: record,
        error: record,
        child: () => logger,
    };

    return logger;
};

/**
 * `runSeed` over a temporary directory.
 *
 * The report goes INSIDE that directory: it is under `os.tmpdir()` like the
 * payloads, and `isRecipeFileName` excludes `coverage-report.json` from a
 * re-read of the directory, so it sits exactly where the committed corpus keeps
 * its own report without being able to touch it.
 */
const seedTemporaryCorpus = async (
    directory: string,
    now: Date,
    logger: ScriptLogger = silentLogger,
): Promise<SeedOutcome> =>
    runSeed({
        ...seedDeps(),
        recipesDir: directory,
        now: () => now,
        logger,
        reportPath: path.join(directory, COVERAGE_REPORT_FILE),
    });

/* ---------------------------------------------------------------------------
 * Reading the published recipes back, versions included
 *
 * `readStoredRecipes` above reads each recipe's CURRENT version, which is what
 * the corpus claims are about. The claims below are about the versions a recipe
 * has HELD — the retired one included — so they read every version with its
 * ingredient rows and compare them by content.
 * ------------------------------------------------------------------------- */

type SnapshotRecipeRow = Prisma.recipesGetPayload<{
    include: { recipe_versions: { include: { recipe_ingredients: true } } };
}>;

type SnapshotVersionRow = SnapshotRecipeRow['recipe_versions'][number];

interface RecipeSnapshot {
    readonly slug: string;
    readonly recipeId: string;
    readonly currentVersionId: string | null;
    /** Every version of this recipe, in version order, ingredient rows in sort order. */
    readonly versions: readonly SnapshotVersionRow[];
}

const readRecipeSnapshot = async (): Promise<Map<string, RecipeSnapshot>> => {
    const recipes = await prisma.recipes.findMany({
        orderBy: { slug: 'asc' },
        include: {
            recipe_versions: {
                orderBy: { version: 'asc' },
                include: { recipe_ingredients: { orderBy: { sort_order: 'asc' } } },
            },
        },
    });

    return new Map(
        recipes.map((recipe) => [
            recipe.slug,
            {
                slug: recipe.slug,
                recipeId: recipe.id,
                currentVersionId: recipe.current_version_id,
                versions: recipe.recipe_versions,
            },
        ]),
    );
};

const requireSnapshot = (snapshot: ReadonlyMap<string, RecipeSnapshot>, slug: string): RecipeSnapshot => {
    const recipe = snapshot.get(slug);
    if (recipe === undefined) {
        throw new Error(`${slug} is not stored, so this case has nothing to assert against`);
    }

    return recipe;
};

const requireVersion = (recipe: RecipeSnapshot, version: number): SnapshotVersionRow => {
    const row = recipe.versions.find((candidate) => candidate.version === version);
    if (row === undefined) {
        throw new Error(
            `${recipe.slug} holds versions ${recipe.versions.map((v) => v.version).join(', ') || 'none'}, not ${version}`,
        );
    }

    return row;
};

/**
 * A version's content, with the only two columns a later run may touch removed.
 *
 * `status` and `retired_at` ARE the retirement; everything else — the name, the
 * instructions, the four per-serving figures, the ingredient rows with their
 * frozen snapshots, and `published_at` — must be identical after a promotion,
 * because a plan built from this version and a diary entry logged from it both
 * read these columns and neither may change under them.
 */
const frozenContent = (version: SnapshotVersionRow): Record<string, unknown> => {
    const content: Record<string, unknown> = { ...version };
    delete content.status;
    delete content.retired_at;

    return content;
};

/** Every version of every recipe except the named one, so "nothing else moved" is assertable in one line. */
const otherRecipes = (
    snapshot: ReadonlyMap<string, RecipeSnapshot>,
    slug: string,
): Map<string, RecipeSnapshot> => new Map([...snapshot].filter(([storedSlug]) => storedSlug !== slug));


/* -------------------------------------------------------------------------- */

describe('publishing the same corpus a third time', () => {
    /**
     * Claim 8 settled that a second application changes no COUNT. Two things it
     * left open are what an operator and a foreign key actually depend on: that
     * every row keeps its IDENTITY — a stage that deleted and reinserted
     * identical content would keep the counts while breaking every
     * `meal_plan_meals` and `meal_entries` row that points at a version — and
     * that the run is OBSERVABLY a no-op, because an operator who cannot tell a
     * real change from noise in the log has no way to review a reseed.
     *
     * A third run rather than a re-reading of the second: idempotence that held
     * once and not twice is not idempotence, and this is the suite whose
     * subject it is.
     */
    let outcome: SeedOutcome;
    let reported: RecordedEvent[];
    let before: Map<string, RecipeSnapshot>;
    let after: Map<string, RecipeSnapshot>;
    let reportAfterThirdRun: string;

    beforeAll(async () => {
        before = await readRecipeSnapshot();
        reported = [];
        // The committed directory and the same injected report path as the two
        // runs above; only the logger differs, so this is the production stage
        // answering for a third time rather than a new scenario.
        outcome = await runSeed({ ...seedDeps(), logger: recordingLogger(reported) });
        reportAfterThirdRun = fs.readFileSync(emittedReportPath, 'utf8');
        after = await readRecipeSnapshot();
    }, LOAD_TIMEOUT_MS);

    it('reports every recipe unchanged and writes no row', () => {
        expect(outcome.created).toEqual([]);
        expect(outcome.promoted).toEqual([]);
        expect(outcome.unchanged).toEqual(corpus.payloads.map((payload) => payload.slug).sort());
        expect(outcome.ingredientRows).toBe(0);
    });

    it('says so in the log, with no publication or promotion event', () => {
        expect(reported.some((entry) => entry.event === 'recipe_published')).toBe(false);
        expect(reported.some((entry) => entry.event === 'recipe_version_promoted')).toBe(false);
        expect(reported.some((entry) => entry.event === 'recipes_rejected')).toBe(false);
        expect(reported.find((entry) => entry.event === 'recipes_published')?.fields).toMatchObject({
            created: 0,
            promoted: 0,
            unchanged: corpus.payloads.length,
            ingredientRows: 0,
        });
    });

    it('leaves every recipe, version and ingredient row exactly as it was, by id', () => {
        // Ids, `published_at`, `status`, every content column and every frozen
        // snapshot, for all forty-two recipes at once. This is the assertion a
        // delete-and-reinsert fails and a row-count assertion does not.
        expect(after).toEqual(before);
    });

    it('re-emits the same coverage report', () => {
        expect(reportAfterThirdRun).toBe(emittedReport);
    });
});

describe('the ingredient snapshots the publication froze', () => {
    /**
     * §0.5.1's reason these columns exist: a plan, a recipe detail and a diary
     * entry read the SNAPSHOT, never the live catalog row, so a catalog refresh
     * cannot change what an existing version says. That only holds if the
     * snapshot was a faithful copy in the first place, which is what this block
     * settles — column by column, against the release row each ingredient
     * resolved to and against the payload that declared it.
     */
    const sliceFoodBySourceKey = (): Map<string, ReleaseFood> =>
        new Map(corpus.slice.foods.map((food) => [food.source_key, food]));

    const payloadIngredient = (slug: string, sourceKey: string): PayloadIngredient => {
        const payload = corpus.payloads.find((entry) => entry.slug === slug);
        const ingredient = payload?.ingredients.find((entry) => entry.sourceKey === sourceKey);
        if (ingredient === undefined) {
            throw new Error(`recipes/${slug}.json declares no ingredient "${sourceKey}"`);
        }

        return ingredient;
    };

    it('copies the resolved catalog row into every snapshot column', () => {
        const foods = sliceFoodBySourceKey();
        const offences: string[] = [];
        let checked = 0;

        for (const recipe of storedRecipes) {
            for (const row of recipe.current_version?.recipe_ingredients ?? []) {
                const sourceKey = row.catalog_foods.source_key;
                const food = foods.get(sourceKey);
                if (food === undefined) {
                    offences.push(`${recipe.slug}/${sourceKey}: resolved to a food the release slice does not carry`);
                    continue;
                }

                checked += 1;
                const snapshot = row.snapshot_per_100g as unknown as RecipeIngredientNutrientSnapshot;
                const observed = {
                    snapshot_name: row.snapshot_name,
                    snapshot_provenance: row.snapshot_provenance,
                    snapshot_allergen_tags: [...row.snapshot_allergen_tags].sort(),
                    snapshot_diet_tags: [...row.snapshot_diet_tags].sort(),
                    calories: snapshot.calories,
                    protein_g: snapshot.protein_g,
                    carbs_g: snapshot.carbs_g,
                    fat_g: snapshot.fat_g,
                    // Absent and null both mean unknown, and the snapshot keeps
                    // that distinction out of the sum by propagating it: a
                    // `?? 0` here would be a claim the release never made.
                    fiber_g: snapshot.fiber_g ?? null,
                };
                const expected = {
                    snapshot_name: food.display_name,
                    // Planning admits nothing else, which is why the seed
                    // stamps the constant rather than copying the column.
                    snapshot_provenance: 'source_backed',
                    snapshot_allergen_tags: [...food.allergen_tags].sort(),
                    snapshot_diet_tags: [...food.diet_tags].sort(),
                    calories: food.calories,
                    protein_g: food.protein_g,
                    carbs_g: food.carbs_g,
                    fat_g: food.fat_g,
                    fiber_g: food.fiber_g,
                };

                if (JSON.stringify(observed) !== JSON.stringify(expected)) {
                    offences.push(
                        `${recipe.slug}/${sourceKey}: snapshot ${render(observed)} is not the release row ${render(expected)}`,
                    );
                }
            }
        }

        expect(offences).toEqual([]);
        // Every ingredient row in the corpus was compared, not merely the ones
        // a lookup happened to find.
        expect(checked).toBe(corpus.ingredientRowCount);
    });

    it('records the catalog nutrition and metadata versions it was published against', () => {
        const foods = sliceFoodBySourceKey();
        const offences: string[] = [];

        for (const recipe of storedRecipes) {
            for (const row of recipe.current_version?.recipe_ingredients ?? []) {
                const food = foods.get(row.catalog_foods.source_key);
                if (food === undefined) {
                    continue;
                }

                // Both counters, independently. A version stored with only the
                // nutrition counter would leave a later metadata change — an
                // allergen or diet tag — undetectable, which is the safety case
                // §0.5.1 gives for storing two columns rather than one.
                if (
                    row.catalog_nutrition_version !== food.nutrition_version ||
                    row.catalog_metadata_version !== food.metadata_version
                ) {
                    offences.push(
                        `${recipe.slug}/${food.source_key}: stored (${row.catalog_nutrition_version}, ` +
                            `${row.catalog_metadata_version}), release (${food.nutrition_version}, ${food.metadata_version})`,
                    );
                }
            }
        }

        expect(offences).toEqual([]);
    });

    it("carries the payload's own quantity, unit, gram weight, display text, order and optionality", () => {
        const offences: string[] = [];

        for (const recipe of storedRecipes) {
            for (const row of recipe.current_version?.recipe_ingredients ?? []) {
                const declared = payloadIngredient(recipe.slug, row.catalog_foods.source_key);
                const observed = {
                    quantity: row.quantity,
                    unit: row.unit,
                    gram_weight: row.gram_weight,
                    display_text: row.display_text,
                    sort_order: row.sort_order,
                    is_optional: row.is_optional,
                };
                const expected = {
                    quantity: declared.quantity,
                    unit: declared.unit,
                    gram_weight: declared.gramWeight,
                    display_text: declared.displayText,
                    sort_order: declared.sortOrder,
                    is_optional: declared.isOptional,
                };

                if (JSON.stringify(observed) !== JSON.stringify(expected)) {
                    offences.push(
                        `${recipe.slug}/${row.catalog_foods.source_key}: stored ${render(observed)} is not the ` +
                            `payload's ${render(expected)}`,
                    );
                }
                if (!(row.gram_weight > 0)) {
                    offences.push(`${recipe.slug}/${row.catalog_foods.source_key}: gram_weight ${row.gram_weight}`);
                }
            }
        }

        expect(offences).toEqual([]);
    });
});

describe('the corpus served through the API', () => {
    /**
     * Any authenticated caller, and that is the point rather than a
     * simplification: `recipes`, `recipe_versions` and the `catalog_*` tables
     * carry no `user_id` BY DESIGN (§0.5.1, Rule backend-architecture §5.1's
     * documented exception), so a current version and the catalog counts are
     * shared reference data every signed-in user reads. Identity still arrives
     * the only way it may, through the verified-token header the auth mock
     * reads (Rule §4).
     */
    const READER: TestIdentity = { uid: 'seed-rerun-reader' };

    /** Nine ingredients, three badges, two slots: the widest response in the corpus. */
    const SERVED_SLUG = 'chicken-burrito-bowl';

    const servedVersion = (): NonNullable<StoredRecipe['current_version']> => {
        const recipe = storedRecipes.find((stored) => stored.slug === SERVED_SLUG);
        const version = recipe?.current_version;
        if (version === undefined || version === null) {
            throw new Error(`${SERVED_SLUG} has no current version stored, so the API claim has no subject`);
        }

        return version;
    };

    it('counts the seeded recipes and the loaded foods through GET /api/catalog/status', async () => {
        const response = await asUser(request.get('/api/catalog/status'), READER);

        expect(response.status).toBe(200);
        expect(response.body).toEqual({
            // Null, and truthfully so: the active release is the newest
            // succeeded `catalog_import_runs` row of kind `release_load`, and
            // this suite applies the ingredient slice through Prisma rather than
            // through `scripts/catalog-load.ts`, which is what writes that row.
            // The non-null case is its own suite's
            // (`src/__tests__/scripts/catalog-load.test.ts`).
            catalogRelease: null,
            lastLoadedAt: null,
            publishedCount: corpus.ingredientKeys.length,
            quarantinedCount: 0,
            rejectedCount: 0,
            recipeCount: corpus.payloads.length,
        });
    });

    it('answers a seeded current version from the snapshot columns', async () => {
        const version = servedVersion();
        const response = await asUser(request.get(`/api/recipes/${version.id}`), READER);

        expect(response.status).toBe(200);
        // Asserted WHOLE rather than field by field: this is the shape the
        // client's io-ts codec decodes (Rule §6), so an extra member, a missing
        // one or an `error` alongside the payload all fail here.
        expect(response.body as RecipeVersionResponse).toEqual({
            versionId: version.id,
            recipeId: version.recipe_id,
            version: FIRST_VERSION,
            status: 'current',
            name: version.name,
            description: version.description ?? '',
            iconKey: version.icon_key,
            instructions: version.instructions,
            yieldServings: version.yield_servings,
            servingDescription: version.serving_description,
            prepMinutes: version.prep_minutes,
            cookMinutes: version.cook_minutes,
            totalMinutes: version.total_minutes,
            mealSlots: version.meal_slots,
            badges: version.badges,
            dietTags: version.diet_tags,
            allergenTags: version.allergen_tags,
            allergenStatus: version.allergen_status,
            budgetTier: version.budget_tier,
            nutritionProvenance: version.nutrition_provenance,
            // Unrounded, as stored: §0.7.3 rounds for display at the wire
            // boundary of the PLAN responses, and a recipe detail carries the
            // full-precision per-serving figures the derivation produced.
            perServing: {
                calories: version.per_serving_calories,
                protein: version.per_serving_protein_g,
                carbs: version.per_serving_carbs_g,
                fat: version.per_serving_fat_g,
            },
            ingredients: [...version.recipe_ingredients]
                .sort((left, right) => left.sort_order - right.sort_order)
                .map((row) => ({
                    catalogFoodId: row.catalog_food_id,
                    // The two members that prove the read went to the SNAPSHOT
                    // and not to the live catalog row.
                    name: row.snapshot_name,
                    nutritionProvenance: row.snapshot_provenance,
                    quantity: row.quantity,
                    unit: row.unit,
                    gramWeight: row.gram_weight,
                    displayText: row.display_text,
                    isOptional: row.is_optional,
                })),
        });
    });
});


describe('a corpus file the seed refuses', () => {
    /**
     * §0.7.3: the seed "fails loudly and nothing is published". Nine defects
     * below, and each case settles the same three things, because any one of
     * them alone would be a hollow pass:
     *
     *   1. the run REFUSES, with `recipes_invalid` and a problem naming the
     *      recipe and the element at fault — Rule backend-architecture §8's
     *      typed-error discipline, since an operator's only recovery is to fix
     *      the named file or load the named catalog row;
     *   2. NOTHING was published — the whole stored corpus, every version and
     *      every ingredient row, is byte-identical to what it was before;
     *   3. the API still serves what it served before, so a refused seed is
     *      invisible to a signed-in user rather than half-applied.
     *
     * Five of the nine are properties of a FILE and five of a catalog ROW, and
     * the row cases mutate `catalog_foods` and put it back: the blocks after
     * this one read the same slice.
     */
    const REFUSED_AT = new Date('2026-09-13T18:00:00.000Z');

    /** The recipe whose current version the API is re-read for after every refusal. */
    const WITNESS_SLUG = 'greek-yogurt-berry-bowl';

    const WITNESS: TestIdentity = { uid: 'seed-rerun-refusal-witness' };

    let before: Map<string, RecipeSnapshot>;
    let witnessVersionId: string;

    beforeAll(async () => {
        before = await readRecipeSnapshot();
        witnessVersionId = requireVersion(requireSnapshot(before, WITNESS_SLUG), FIRST_VERSION).id;
    }, LOAD_TIMEOUT_MS);

    const expectRefusal = async (
        payloads: readonly TemporaryPayload[],
        expected: readonly string[],
    ): Promise<void> => {
        const directory = writeTemporaryCorpus(payloads);
        const reported: RecordedEvent[] = [];

        let refusal: unknown;
        try {
            await seedTemporaryCorpus(directory, REFUSED_AT, recordingLogger(reported));
        } catch (error) {
            refusal = error;
        }

        expect(refusal).toBeInstanceOf(RecipeSeedError);
        const failure = refusal as RecipeSeedError;
        expect(failure.code).toBe('recipes_invalid');
        for (const fragment of expected) {
            expect(failure.problems.join('\n')).toContain(fragment);
        }
        // Reported before it threw, so an operator reading the log sees every
        // defect rather than only the exception's first line.
        expect(reported.some((entry) => entry.event === 'recipes_rejected')).toBe(true);
        expect(reported.some((entry) => entry.event === 'recipe_published')).toBe(false);
        expect(reported.some((entry) => entry.event === 'recipe_version_promoted')).toBe(false);

        expect(await readRecipeSnapshot()).toEqual(before);

        const served = await asUser(request.get(`/api/recipes/${witnessVersionId}`), WITNESS);
        expect(served.status).toBe(200);
        expect((served.body as RecipeVersionResponse).version).toBe(FIRST_VERSION);
        expect((served.body as RecipeVersionResponse).status).toBe('current');
    };

    /**
     * Mutates one loaded food, runs the case and puts the row back.
     *
     * Only the columns these cases touch are restored, named one by one: a
     * blanket write-back of the whole row would also rewrite `updated_at` and
     * would hide a case that changed a column it did not declare.
     */
    const withMutatedFood = async (
        sourceKey: string,
        change: Prisma.catalog_foodsUpdateInput,
        run: () => Promise<void>,
    ): Promise<void> => {
        const original = await prisma.catalog_foods.findUniqueOrThrow({ where: { source_key: sourceKey } });
        await prisma.catalog_foods.update({ where: { source_key: sourceKey }, data: change });

        try {
            await run();
        } finally {
            await prisma.catalog_foods.update({
                where: { source_key: sourceKey },
                data: {
                    publication_status: original.publication_status,
                    nutrition_provenance: original.nutrition_provenance,
                    allergen_status: original.allergen_status,
                    nutrition_basis: original.nutrition_basis,
                    density_g_per_ml: original.density_g_per_ml,
                },
            });
        }
    };

    describe('a declaration the ingredients contradict', () => {
        it('names the ingredients that refuse a diet tag the file claims', async () => {
            await expectRefusal(
                [
                    {
                        file: 'chicken-burrito-bowl.json',
                        edit: (payload) => {
                            rawList(payload, 'dietTags', 'chicken-burrito-bowl').push('vegan');
                        },
                    },
                ],
                [
                    'chicken-burrito-bowl (recipes/chicken-burrito-bowl.json)',
                    'diet_tags declares "vegan", which the ingredients do not support',
                    // The ingredient, not just the field: a file claiming a diet
                    // its chicken contradicts is fixed by reading which row said so.
                    'Chicken breast',
                ],
            );
        });

        it('names the allergen the ingredients produce and the file omits', async () => {
            await expectRefusal(
                [
                    {
                        file: 'spinach-feta-omelette.json',
                        edit: (payload) => {
                            payload.allergenTags = rawList(payload, 'allergenTags', 'spinach-feta-omelette').filter(
                                (tag) => tag !== 'milk',
                            );
                        },
                    },
                ],
                [
                    'spinach-feta-omelette (recipes/spinach-feta-omelette.json)',
                    'allergen_tags does not declare "milk", which the ingredients produce',
                ],
            );
        });

        it('names the ingredient that blocks a declared gluten-free badge', async () => {
            // The safety-relevant direction: a badge is an ingredient-composition
            // claim, and a hand-declared "Gluten free" on a recipe carrying
            // bulgur would be a false one on a screen a coeliac user reads.
            await expectRefusal(
                [
                    {
                        file: 'caprese-farro-salad.json',
                        edit: (payload) => {
                            rawList(payload, 'badges', 'caprese-farro-salad').push('gluten_free');
                        },
                    },
                ],
                [
                    'caprese-farro-salad (recipes/caprese-farro-salad.json)',
                    'badges declares "gluten_free", which the ingredients do not support',
                ],
            );
        });
    });

    describe('a value outside a closed set', () => {
        // Both columns are plain TEXT with no Prisma enum and no CHECK
        // constraint (§0.5.1), so the seed's gate is the only place membership
        // is enforced and these two cases are the only proof that it is.
        it('refuses an icon key the closed set does not hold', async () => {
            await expectRefusal(
                [
                    {
                        file: 'hummus-carrot-sticks.json',
                        edit: (payload) => {
                            payload.iconKey = 'casserole';
                        },
                    },
                ],
                ['hummus-carrot-sticks (recipes/hummus-carrot-sticks.json)', 'icon_key "casserole" is not one of'],
            );
        });

        it('refuses a badge code the closed set does not hold', async () => {
            await expectRefusal(
                [
                    {
                        file: 'roasted-chickpea-snack.json',
                        edit: (payload) => {
                            rawList(payload, 'badges', 'roasted-chickpea-snack').push('super_food');
                        },
                    },
                ],
                [
                    'roasted-chickpea-snack (recipes/roasted-chickpea-snack.json)',
                    // Unquoted, and the difference is load-bearing: a value
                    // outside the closed set is reported against the SET
                    // (`is not one of: …`), while a value the ingredients
                    // merely fail to support is quoted and named with them.
                    'badges declares super_food, which is not one of',
                    'high_protein, gluten_free, dairy_free, vegan, quick',
                ],
            );
        });
    });

    describe('an ingredient the file does not account for', () => {
        it('refuses prose that names an oil the ingredient list omits', async () => {
            // §0.7.3's own example, and the reason the rule exists: an unlisted
            // tablespoon of olive oil is ~120 kcal the user was told were not on
            // the plate. `olive_oil` is a food group in
            // `coverage-plan.v1.json`, so the vocabulary carries it as data
            // rather than as a word list written here.
            await expectRefusal(
                [
                    {
                        file: 'cottage-cheese-cucumber-bowl.json',
                        edit: (payload) => {
                            rawList(payload, 'instructions', 'cottage-cheese-cucumber-bowl').push(
                                'Drizzle the olive oil over the bowl just before serving.',
                            );
                        },
                    },
                ],
                [
                    'cottage-cheese-cucumber-bowl (recipes/cottage-cheese-cucumber-bowl.json)',
                    'instructions name "olive oil", which no listed ingredient accounts for',
                    'Step: "Drizzle the olive oil over the bowl just before serving."',
                ],
            );
        });

        it('refuses a source key the catalog cannot resolve, naming the key', async () => {
            await expectRefusal(
                [
                    {
                        file: 'banana-oat-energy-bites.json',
                        edit: (payload) => {
                            asRecord(
                                rawList(payload, 'ingredients', 'banana-oat-energy-bites')[0],
                                'banana-oat-energy-bites ingredient 0',
                            ).sourceKey = 'usda:999999999';
                        },
                    },
                ],
                [
                    'banana-oat-energy-bites (recipes/banana-oat-energy-bites.json)',
                    'ingredient "usda:999999999" resolves to no catalog_foods row',
                    // The remedy, named in the refusal: the recovery is loading
                    // the release that carries the key, not editing the recipe.
                    'load the catalog release that carries it',
                ],
            );
        });

        it('refuses an ingredient whose gram weight is not positive', async () => {
            // Grams are what every nutrient sum, unit conversion and grocery
            // line is derived from, so a zero is not a small ingredient — it is
            // an ingredient with no weight at all.
            await expectRefusal(
                [
                    {
                        file: 'apple-almond-butter-slices.json',
                        edit: (payload) => {
                            asRecord(
                                rawList(payload, 'ingredients', 'apple-almond-butter-slices')[1],
                                'apple-almond-butter-slices ingredient 1',
                            ).gramWeight = 0;
                        },
                    },
                ],
                [
                    'recipes/apple-almond-butter-slices.json ingredient 1',
                    'gramWeight must be greater than zero, received 0',
                ],
            );
        });
    });

    describe('a catalog row planning could not admit', () => {
        /** Honey, an ingredient of exactly one snack in the corpus. */
        const MUTATED_SOURCE_KEY = 'usda:169640';

        const MUTATED_RECIPE = 'greek-yogurt-honey-berries.json';

        it('refuses a food that is not published', async () => {
            await withMutatedFood(MUTATED_SOURCE_KEY, { publication_status: 'quarantined' }, () =>
                expectRefusal(
                    [{ file: MUTATED_RECIPE }],
                    [
                        `ingredient "${MUTATED_SOURCE_KEY}" publication_status is "quarantined", not "published"`,
                    ],
                ),
            );
        });

        it('refuses a food whose nutrition is an estimate', async () => {
            // The absolute the prompt states: AI-estimated nutrition never
            // enters planning, so it can never enter a recipe either — a recipe
            // built on an estimate would be unplannable the moment it published,
            // and its calories would be presented as calculated.
            await withMutatedFood(MUTATED_SOURCE_KEY, { nutrition_provenance: 'ai_estimated' }, () =>
                expectRefusal(
                    [{ file: MUTATED_RECIPE }],
                    [
                        `ingredient "${MUTATED_SOURCE_KEY}" nutrition_provenance is "ai_estimated", not "source_backed"`,
                    ],
                ),
            );
        });

        it('refuses a food nobody has reviewed for allergens', async () => {
            await withMutatedFood(MUTATED_SOURCE_KEY, { allergen_status: 'unknown' }, () =>
                expectRefusal(
                    [{ file: MUTATED_RECIPE }],
                    [`ingredient "${MUTATED_SOURCE_KEY}" allergen_status is "unknown", not "known"`],
                ),
            );
        });

        it('refuses a volume-basis food with no density', async () => {
            // Millilitres never silently equal grams — ~9 % out on oil — so a
            // volume basis without `density_g_per_ml` has no gram basis to
            // scale from at all.
            await withMutatedFood(
                MUTATED_SOURCE_KEY,
                { nutrition_basis: 'per_100ml', density_g_per_ml: null },
                () =>
                    expectRefusal(
                        [{ file: MUTATED_RECIPE }],
                        [
                            `ingredient "${MUTATED_SOURCE_KEY}" is stated per_100ml with no density_g_per_ml`,
                        ],
                    ),
            );
        });

        it('refuses a food with no default portion', async () => {
            const portions = await prisma.catalog_food_portions.findMany({
                where: { catalog_foods: { source_key: MUTATED_SOURCE_KEY }, is_default: true },
                select: { id: true },
            });
            expect(portions).toHaveLength(1);

            await prisma.catalog_food_portions.update({
                where: { id: portions[0].id },
                data: { is_default: false },
            });

            try {
                await expectRefusal(
                    [{ file: MUTATED_RECIPE }],
                    [
                        `ingredient "${MUTATED_SOURCE_KEY}" has 0 default catalog_food_portions rows, not exactly one`,
                    ],
                );
            } finally {
                await prisma.catalog_food_portions.update({
                    where: { id: portions[0].id },
                    data: { is_default: true },
                });
            }
        });
    });
});


describe('a payload whose content changed', () => {
    /**
     * THE CLAIM THIS FILE EXISTS FOR MOST. A published `recipe_versions` row is
     * frozen: §0.5.1 and the model's own comment require a changed file to
     * publish a NEW version, promote it to `current` and RETIRE the old one,
     * never to edit it. The reason is not tidiness — every plan built from that
     * version and every diary entry logged from it read its columns, so an
     * in-place edit would silently restate what a user was told they ate, which
     * is exactly the integrity the prompt forbids compromising.
     *
     * So the fixture is built in the order that makes the claim meaningful: a
     * plan is published against the version FIRST, while it is still current,
     * and only then does the changed payload reach the seed. Afterwards the
     * plan must still resolve its own version, with its own numbers.
     *
     * The change is `prepMinutes` 5 → 8, which moves `prep_minutes` and the
     * derived `total_minutes` and nothing else: still ≤ 15 minutes, so the
     * `quick` badge the derivation awards is unchanged and the declared-versus-
     * derived gate still passes. A case that had to edit a declared value to
     * make the content differ would be testing two things at once.
     */
    const CHANGED_SLUG = 'greek-yogurt-berry-bowl';

    const CHANGED_FILE = `${CHANGED_SLUG}.json`;

    const CHANGED_PREP_MINUTES = 8;

    const PROMOTED_VERSION = 2;

    const OWNER: TestIdentity = { uid: 'seed-rerun-plan-owner' };

    /** A caller with no plan and no diary entry: the retired version is not theirs to read. */
    const STRANGER: TestIdentity = { uid: 'seed-rerun-stranger' };

    let before: Map<string, RecipeSnapshot>;
    let after: Map<string, RecipeSnapshot>;
    let outcome: SeedOutcome;
    let plan: FixtureMealPlan;
    let retired: SnapshotVersionRow;
    let promoted: SnapshotVersionRow;
    let plannableVersionIds: Set<string>;

    beforeAll(async () => {
        before = await readRecipeSnapshot();

        const plannedVersionId = requireVersion(requireSnapshot(before, CHANGED_SLUG), FIRST_VERSION).id;
        const owner = await makeUser({ id: OWNER.uid });
        await makePreferences(owner.id);
        plan = await makePlan(owner.id, { recipeVersionId: plannedVersionId });

        const directory = writeTemporaryCorpus([
            {
                file: CHANGED_FILE,
                edit: (payload) => {
                    payload.prepMinutes = CHANGED_PREP_MINUTES;
                },
            },
        ]);
        outcome = await seedTemporaryCorpus(directory, PROMOTED_AT);

        after = await readRecipeSnapshot();
        retired = requireVersion(requireSnapshot(after, CHANGED_SLUG), FIRST_VERSION);
        promoted = requireVersion(requireSnapshot(after, CHANGED_SLUG), PROMOTED_VERSION);
        plannableVersionIds = new Set(
            (await getRecipeVersionsForPlanning()).map((candidate) => candidate.recipe_version_id),
        );
    }, LOAD_TIMEOUT_MS);

    /**
     * A second `recipe_versions` row built from a stored one, for the two index
     * probes below. Every NOT NULL column is named rather than spread, because
     * `instructions` is a `Json` column whose read type admits null and whose
     * create type does not — the one place this file states a column list
     * twice, and the alternative is a cast that would hide a column the schema
     * later adds.
     */
    const duplicateVersionData = (
        source: SnapshotVersionRow,
        overrides: { version: number; status: string },
    ): Prisma.recipe_versionsUncheckedCreateInput => ({
        recipe_id: source.recipe_id,
        version: overrides.version,
        name: source.name,
        description: source.description,
        icon_key: source.icon_key,
        instructions: source.instructions as Prisma.InputJsonValue,
        yield_servings: source.yield_servings,
        serving_description: source.serving_description,
        prep_minutes: source.prep_minutes,
        cook_minutes: source.cook_minutes,
        total_minutes: source.total_minutes,
        meal_slots: source.meal_slots,
        diet_tags: source.diet_tags,
        allergen_tags: source.allergen_tags,
        allergen_status: source.allergen_status,
        budget_tier: source.budget_tier,
        badges: source.badges,
        nutrition_provenance: source.nutrition_provenance,
        per_serving_calories: source.per_serving_calories,
        per_serving_protein_g: source.per_serving_protein_g,
        per_serving_carbs_g: source.per_serving_carbs_g,
        per_serving_fat_g: source.per_serving_fat_g,
        sourced_calories_note: source.sourced_calories_note,
        status: overrides.status,
        published_at: source.published_at,
    });

    const plannedDayKey = (): string => plan.meal_plan_days[0].date.toISOString().slice(0, 10);

    const plannedMeal = (): FixtureMealPlan['meal_plan_days'][number]['meal_plan_meals'][number] => {
        const meal = plan.meal_plan_days[0].meal_plan_meals.find((row) => row.slot === 'breakfast');
        if (meal === undefined) {
            throw new Error('the fixture plan has no breakfast meal, so the reference claims have no subject');
        }

        return meal;
    };

    it('reports one promotion and nothing else', () => {
        expect(outcome.selected).toEqual([CHANGED_SLUG]);
        expect(outcome.promoted).toEqual([CHANGED_SLUG]);
        expect(outcome.created).toEqual([]);
        expect(outcome.unchanged).toEqual([]);
        expect(outcome.ingredientRows).toBe(retired.recipe_ingredients.length);
    });

    it('publishes the change as version 2 and moves current_version_id to it', () => {
        expect(promoted.status).toBe('current');
        expect(promoted.retired_at).toBeNull();
        expect(promoted.published_at).toEqual(PROMOTED_AT);
        expect(promoted.prep_minutes).toBe(CHANGED_PREP_MINUTES);
        expect(promoted.total_minutes).toBe(CHANGED_PREP_MINUTES + promoted.cook_minutes);
        expect(requireSnapshot(after, CHANGED_SLUG).currentVersionId).toBe(promoted.id);
        expect(promoted.recipe_id).toBe(requireSnapshot(before, CHANGED_SLUG).recipeId);
        // A new ROW, not a rewritten one.
        expect(promoted.id).not.toBe(retired.id);
        expect(promoted.recipe_ingredients).toHaveLength(retired.recipe_ingredients.length);
    });

    it('retires the previous version without editing one column of its content', () => {
        expect(retired.status).toBe('retired');
        expect(retired.retired_at).toEqual(PROMOTED_AT);

        // The whole row and its ingredient rows, `status` and `retired_at`
        // aside: the name, the instructions, the four per-serving figures, every
        // frozen snapshot, and `published_at` — which stays the instant this
        // version was published, not the instant it was retired.
        const published = requireVersion(requireSnapshot(before, CHANGED_SLUG), FIRST_VERSION);
        expect(frozenContent(retired)).toEqual(frozenContent(published));
        expect(retired.published_at).toEqual(published.published_at);
    });

    it('leaves exactly one current version, for this recipe and for every other', async () => {
        const offences: string[] = [];

        for (const recipe of after.values()) {
            const current = recipe.versions.filter((version) => version.status === 'current');
            if (current.length !== 1) {
                offences.push(`${recipe.slug}: ${current.length} current versions`);
                continue;
            }
            if (recipe.currentVersionId !== current[0].id) {
                offences.push(`${recipe.slug}: current_version_id does not point at its current version`);
            }
        }

        expect(offences).toEqual([]);
        expect(after.size).toBe(corpus.payloads.length);
        expect(await prisma.recipe_versions.count({ where: { status: 'current' } })).toBe(corpus.payloads.length);
        // One more row than recipes, and exactly one: the promotion added a
        // version rather than replacing one.
        expect(await prisma.recipe_versions.count()).toBe(corpus.payloads.length + 1);
    });

    it('promotes no other recipe: every other slug still holds its first version alone', () => {
        expect(otherRecipes(after, CHANGED_SLUG)).toEqual(otherRecipes(before, CHANGED_SLUG));
    });

    it('holds the two uniqueness invariants the migration declares', async () => {
        // Both are DATABASE invariants rather than conventions — the migration
        // creates the partial index `unique_current_recipe_version ON
        // recipe_versions(recipe_id) WHERE status = 'current'` alongside the
        // declared `UNIQUE (recipe_id, version)` — and a suite that only counted
        // rows would pass against a schema that had lost either. Each probe runs
        // in its own transaction, so the refused statement leaves nothing behind.
        const secondCurrent = prisma.recipe_versions.create({
            data: duplicateVersionData(promoted, { version: 99, status: 'current' }),
        });
        await expect(secondCurrent).rejects.toMatchObject({ code: 'P2002' });

        const duplicateNumber = prisma.recipe_versions.create({
            data: duplicateVersionData(promoted, { version: PROMOTED_VERSION, status: 'retired' }),
        });
        await expect(duplicateNumber).rejects.toMatchObject({ code: 'P2002' });

        expect(
            await prisma.recipe_versions.count({ where: { recipe_id: promoted.recipe_id } }),
        ).toBe(2);
    });

    it('leaves the plan pointing at the version it was built from, with its numbers', async () => {
        const meal = plannedMeal();
        const stored = await prisma.meal_plan_meals.findUniqueOrThrow({ where: { id: meal.id } });

        expect(stored.recipe_version_id).toBe(retired.id);
        expect(stored.planned_calories).toBe(meal.planned_calories);
        expect(stored.planned_protein_g).toBe(meal.planned_protein_g);
        expect(stored.planned_carbs_g).toBe(meal.planned_carbs_g);
        expect(stored.planned_fat_g).toBe(meal.planned_fat_g);

        const response = await asUser(
            request.get(`/api/meal-planning/plans/${plan.id}/days/${plannedDayKey()}`),
            OWNER,
        );

        expect(response.status).toBe(200);
        const served = (response.body as { day: { meals: { id: string }[] } }).day.meals.find(
            (row) => row.id === meal.id,
        ) as
            | {
                  recipe: { versionId: string; totalMinutes: number };
                  planned: { calories: number; protein: number; carbs: number; fat: number };
              }
            | undefined;

        expect(served?.recipe.versionId).toBe(retired.id);
        // The retired version's own cooking time, not the promoted one's: the
        // plan card keeps describing the meal that was planned.
        expect(served?.recipe.totalMinutes).toBe(retired.total_minutes);
        expect(served?.planned).toEqual({
            calories: Math.round(meal.planned_calories),
            protein: Math.round(meal.planned_protein_g),
            carbs: Math.round(meal.planned_carbs_g),
            fat: Math.round(meal.planned_fat_g),
        });
    });

    it('still serves the retired version to the caller whose plan references it', async () => {
        const response = await asUser(request.get(`/api/recipes/${retired.id}`), OWNER);

        expect(response.status).toBe(200);
        const body = response.body as RecipeVersionResponse;
        expect(body.versionId).toBe(retired.id);
        expect(body.version).toBe(FIRST_VERSION);
        expect(body.status).toBe('retired');
        expect(body.prepMinutes).toBe(retired.prep_minutes);
        expect(body.perServing).toEqual({
            calories: retired.per_serving_calories,
            protein: retired.per_serving_protein_g,
            carbs: retired.per_serving_carbs_g,
            fat: retired.per_serving_fat_g,
        });
    });

    it('refuses the retired version to a caller who references nothing, without saying it exists', async () => {
        // The 404 is what proves the 200 above came from the OWNER's reference
        // rather than from retirement leaving the version open to everyone. The
        // full visibility matrix is `api/recipes.test.ts` and
        // `api/ownership.test.ts`; this is the one line that keeps the claim
        // above honest.
        const response = await asUser(request.get(`/api/recipes/${retired.id}`), STRANGER);

        expect(response.status).toBe(404);
        // A message, never the raw error, a stack or Prisma text (Rule §4), and
        // never a 403, which would confirm the resource exists (Rule §1.5).
        expect(Object.keys(response.body as object)).toEqual(['error']);
        expect(typeof (response.body as { error: unknown }).error).toBe('string');
    });

    it('offers only the current version to planning, and to a swap', async () => {
        expect(plannableVersionIds.has(promoted.id)).toBe(true);
        expect(plannableVersionIds.has(retired.id)).toBe(false);
        // Not a vacuous set: the whole corpus is plannable, one version each.
        expect(plannableVersionIds.size).toBe(corpus.payloads.length);

        const response = await asUser(
            request.get(`/api/meal-planning/plans/${plan.id}/meals/${plannedMeal().id}/alternatives`),
            OWNER,
        );

        expect(response.status).toBe(200);
        const body = response.body as {
            current: { recipe: { versionId: string } };
            alternatives: { recipeVersionId: string }[];
        };
        // The meal keeps describing its own, retired recipe...
        expect(body.current.recipe.versionId).toBe(retired.id);
        // ...while nothing on offer is a version planning has retired. The
        // endpoint's own states are `api/swaps.test.ts`'s subject; what is
        // asserted here is only that retirement removed a version from the
        // offer, for however many candidates this corpus and these targets
        // admit.
        for (const alternative of body.alternatives) {
            expect(plannableVersionIds.has(alternative.recipeVersionId)).toBe(true);
            expect(alternative.recipeVersionId).not.toBe(retired.id);
        }
    });
});


describe('an ingredient snapshot the catalog has moved past', () => {
    /**
     * The second way a version is superseded, and the reason
     * `recipe_ingredients` stores TWO counters (§0.5.1). A catalog refresh
     * cannot edit a published version, so the seed detects that a stored
     * snapshot is stale and publishes a new version from the current rows.
     *
     * Each counter is asserted INDEPENDENTLY, and that is the point rather than
     * thoroughness for its own sake: `catalog_metadata_version` moves when an
     * allergen tag, a diet tag, a name or a food group changes, and a staleness
     * check that compared only nutrition would leave a stale ALLERGEN claim
     * published — a safety defect on a screen a user with an allergy reads,
     * even though every number on it is right.
     *
     * Honey is the moved food: exactly one recipe in the corpus lists it as
     * well as this one, and only this one is seeded from the temporary
     * directory, so the promotion's scope is a database fact here rather than a
     * filter's doing. `fiber_g` is the nutrient that moves, because fibre is
     * propagated into `snapshot_per_100g` and reaches no derived column — no
     * badge, no diet tag, no per-serving figure — so the case cannot pass or
     * fail for a second reason.
     */
    const STALE_SLUG = 'greek-yogurt-honey-berries';

    const STALE_FILE = `${STALE_SLUG}.json`;

    const MOVED_SOURCE_KEY = 'usda:169640';

    const MOVED_FIBER_G = 0.7;

    let before: Map<string, RecipeSnapshot>;
    let afterNutritionBump: Map<string, RecipeSnapshot>;
    let afterMetadataBump: Map<string, RecipeSnapshot>;
    let nutritionOutcome: SeedOutcome;
    let metadataOutcome: SeedOutcome;
    let nutritionEvents: RecordedEvent[];
    let metadataEvents: RecordedEvent[];
    let movedFoodId: string;
    let originalNutritionVersion: number;
    let originalMetadataVersion: number;
    let originalFiberG: number | null;

    beforeAll(async () => {
        before = await readRecipeSnapshot();

        const food = await prisma.catalog_foods.findUniqueOrThrow({ where: { source_key: MOVED_SOURCE_KEY } });
        movedFoodId = food.id;
        originalNutritionVersion = food.nutrition_version;
        originalMetadataVersion = food.metadata_version;
        originalFiberG = food.fiber_g;

        nutritionEvents = [];
        await prisma.catalog_foods.update({
            where: { id: movedFoodId },
            data: { nutrition_version: originalNutritionVersion + 1, fiber_g: MOVED_FIBER_G },
        });
        nutritionOutcome = await seedTemporaryCorpus(
            writeTemporaryCorpus([{ file: STALE_FILE }]),
            PROMOTED_AT,
            recordingLogger(nutritionEvents),
        );
        afterNutritionBump = await readRecipeSnapshot();

        metadataEvents = [];
        await prisma.catalog_foods.update({
            where: { id: movedFoodId },
            data: { metadata_version: originalMetadataVersion + 1 },
        });
        metadataOutcome = await seedTemporaryCorpus(
            writeTemporaryCorpus([{ file: STALE_FILE }]),
            RESTALED_AT,
            recordingLogger(metadataEvents),
        );
        afterMetadataBump = await readRecipeSnapshot();
    }, LOAD_TIMEOUT_MS);

    /**
     * Why the stage said it republished.
     *
     * Asserted rather than inferred from the new row, and that is what makes
     * each counter's case independent. Both counters also reach the CONTENT
     * comparison, because `recipe_ingredients` stores them, so "a new version
     * appeared" alone would still hold if `isIngredientSnapshotStale` compared
     * one counter and ignored the other — measured, not assumed: with the
     * metadata comparison removed, every other assertion in this block still
     * passed. The REASON is what distinguishes the two paths, so it is what is
     * pinned.
     */
    const promotionReason = (events: readonly RecordedEvent[]): string => {
        const promotion = events.find((entry) => entry.event === 'recipe_version_promoted');
        if (promotion === undefined) {
            throw new Error('the stage reported no promotion, so there is no reason to read');
        }

        return String(promotion.fields?.reason ?? '');
    };

    afterAll(async () => {
        // The slice is shared state, and the block after this one re-applies it
        // from the release anyway; putting the row back keeps the two in
        // agreement for anything that reads it in between.
        await prisma.catalog_foods.update({
            where: { id: movedFoodId },
            data: {
                nutrition_version: originalNutritionVersion,
                metadata_version: originalMetadataVersion,
                fiber_g: originalFiberG,
            },
        });
    });

    const movedIngredient = (version: SnapshotVersionRow): SnapshotVersionRow['recipe_ingredients'][number] => {
        const row = version.recipe_ingredients.find((ingredient) => ingredient.catalog_food_id === movedFoodId);
        if (row === undefined) {
            throw new Error(`${STALE_SLUG} version ${version.version} does not list the moved food`);
        }

        return row;
    };

    const fiberOf = (row: SnapshotVersionRow['recipe_ingredients'][number]): number | null =>
        (row.snapshot_per_100g as unknown as RecipeIngredientNutrientSnapshot).fiber_g ?? null;

    it('publishes a new version when the nutrition counter moves, and says why', () => {
        expect(nutritionOutcome.promoted).toEqual([STALE_SLUG]);
        expect(nutritionOutcome.created).toEqual([]);
        expect(nutritionOutcome.unchanged).toEqual([]);
        // Named with the ingredient and the counter, because the operator's
        // question after a reseed is which catalog row forced it.
        expect(promotionReason(nutritionEvents)).toContain('stale ingredient snapshot: Honey (nutrition)');

        const promoted = requireVersion(requireSnapshot(afterNutritionBump, STALE_SLUG), 2);
        expect(promoted.status).toBe('current');
        expect(promoted.published_at).toEqual(PROMOTED_AT);
        expect(requireSnapshot(afterNutritionBump, STALE_SLUG).currentVersionId).toBe(promoted.id);
    });

    it('refreshes the moved snapshot in the new version and freezes the old one', () => {
        const published = requireVersion(requireSnapshot(before, STALE_SLUG), FIRST_VERSION);
        const retired = requireVersion(requireSnapshot(afterNutritionBump, STALE_SLUG), FIRST_VERSION);
        const promoted = requireVersion(requireSnapshot(afterNutritionBump, STALE_SLUG), 2);

        expect(movedIngredient(promoted).catalog_nutrition_version).toBe(originalNutritionVersion + 1);
        expect(fiberOf(movedIngredient(promoted))).toBe(MOVED_FIBER_G);

        // The retired version keeps the counter and the value it was published
        // with — which is the whole reason a refresh publishes rather than
        // updates.
        expect(retired.status).toBe('retired');
        expect(retired.retired_at).toEqual(PROMOTED_AT);
        expect(movedIngredient(retired).catalog_nutrition_version).toBe(originalNutritionVersion);
        expect(fiberOf(movedIngredient(retired))).toBe(fiberOf(movedIngredient(published)));
        expect(frozenContent(retired)).toEqual(frozenContent(published));
    });

    it('leaves the per-serving figures alone, because fibre is not one of them', () => {
        const published = requireVersion(requireSnapshot(before, STALE_SLUG), FIRST_VERSION);
        const promoted = requireVersion(requireSnapshot(afterNutritionBump, STALE_SLUG), 2);

        expect({
            calories: promoted.per_serving_calories,
            protein: promoted.per_serving_protein_g,
            carbs: promoted.per_serving_carbs_g,
            fat: promoted.per_serving_fat_g,
        }).toEqual({
            calories: published.per_serving_calories,
            protein: published.per_serving_protein_g,
            carbs: published.per_serving_carbs_g,
            fat: published.per_serving_fat_g,
        });
    });

    it('publishes a further version when only the metadata counter moves', () => {
        // Nothing nutritional changed between the second run and the third: the
        // metadata counter is the whole difference, and the stage says so. This
        // is the clause that would break if the staleness check compared only
        // `catalog_nutrition_version` — a stale allergen or diet claim is a
        // safety defect even on a version whose every number is right.
        expect(metadataOutcome.promoted).toEqual([STALE_SLUG]);
        expect(promotionReason(metadataEvents)).toContain('stale ingredient snapshot: Honey (metadata)');

        const promoted = requireVersion(requireSnapshot(afterMetadataBump, STALE_SLUG), 3);
        expect(promoted.status).toBe('current');
        expect(promoted.published_at).toEqual(RESTALED_AT);
        expect(movedIngredient(promoted).catalog_metadata_version).toBe(originalMetadataVersion + 1);
        expect(movedIngredient(promoted).catalog_nutrition_version).toBe(originalNutritionVersion + 1);
        // The nutrient snapshot is identical to version 2's: the metadata
        // counter is the only thing that moved.
        expect(fiberOf(movedIngredient(promoted))).toBe(MOVED_FIBER_G);

        const nowRetired = requireVersion(requireSnapshot(afterMetadataBump, STALE_SLUG), 2);
        expect(nowRetired.status).toBe('retired');
        expect(nowRetired.retired_at).toEqual(RESTALED_AT);
        expect(frozenContent(nowRetired)).toEqual(
            frozenContent(requireVersion(requireSnapshot(afterNutritionBump, STALE_SLUG), 2)),
        );
    });

    it('keeps exactly one current version through both promotions, and touches no other recipe', async () => {
        const recipe = requireSnapshot(afterMetadataBump, STALE_SLUG);
        expect(recipe.versions.map((version) => version.status)).toEqual(['retired', 'retired', 'current']);
        expect(otherRecipes(afterMetadataBump, STALE_SLUG)).toEqual(otherRecipes(before, STALE_SLUG));
        expect(await prisma.recipe_versions.count({ where: { status: 'current' } })).toBe(corpus.payloads.length);
    });
});

describe('the coverage report recomputed from the rows that are actually seeded', () => {
    /**
     * WHY THIS BLOCK EXISTS. The claim above that the emitted report equals the
     * committed `coverage-report.json` is only evidence if the report is DERIVED
     * from the database. A stage that read the committed file and echoed it back
     * would satisfy that equality for ever, including on the day the corpus lost
     * a recipe — so this block seeds a deliberately reduced corpus into an empty
     * database and shows the numbers move with it.
     *
     * It truncates, so it is the last block in the file. Three payloads are
     * seeded: one breakfast, one lunch-and-dinner and one dinner, which is
     * enough for the table to be non-trivial and far too few for any guaranteed
     * cell to be met.
     */
    const REDUCED_FILES: readonly string[] = [
        'greek-yogurt-berry-bowl.json',
        'chicken-burrito-bowl.json',
        'lemon-herb-baked-salmon.json',
    ];

    let reduced: CoverageReport;
    let reducedDocument: string;
    let committed: CoverageReport;

    beforeAll(async () => {
        await truncateFeatureTables();
        await applyCatalogSlice(corpus.slice);

        const directory = writeTemporaryCorpus(REDUCED_FILES.map((file) => ({ file })));
        const outcome = await seedTemporaryCorpus(directory, PUBLISHED_AT);

        if (outcome.report === null || outcome.reportPath === null) {
            throw new Error('the reduced run emitted no coverage report, so there is nothing to compare');
        }

        reduced = outcome.report;
        reducedDocument = fs.readFileSync(outcome.reportPath, 'utf8');
        committed = JSON.parse(fs.readFileSync(committedReportPath(), 'utf8')) as CoverageReport;
    }, LOAD_TIMEOUT_MS);

    it('counts the seeded recipes, not the payloads on disk', () => {
        expect(reduced.recipeCount).toBe(REDUCED_FILES.length);
        // The committed artefact describes the whole corpus, which is what makes
        // this comparison meaningful rather than circular.
        expect(committed.recipeCount).toBe(corpus.payloads.length);
        expect(reducedDocument).not.toBe(fs.readFileSync(committedReportPath(), 'utf8'));
    });

    it('reports the guaranteed cells as short, because the counts come from the rows', () => {
        const met = reduced.guaranteedCells.filter((cell) => cell.count >= cell.threshold);

        // Three recipes cannot fill any slot's guaranteed cell, and every cell
        // still carries the threshold it is measured against: the numbers moved,
        // the rules did not.
        expect(met).toEqual([]);
        expect(reduced.guaranteedCells.length).toBe(committed.guaranteedCells.length);
        expect(reduced.guaranteedCells.every((cell) => cell.threshold === 4)).toBe(true);
        expect(reduced.reducedCells.every((cell) => cell.threshold === 2)).toBe(true);
    });

    it('keeps its dimensions, its eligibility rule and its documented boundary', () => {
        // The self-describing half of the document is a statement of policy
        // rather than a measurement, so it is identical whatever is seeded —
        // including the boundary §0.7.3 requires it to record: a profile outside
        // the guaranteed and reduced cells is supported at runtime and not
        // promised, and the planner answers `422 no_matching_meals` with an
        // `editStep` rather than an empty plan (`api/plans.test.ts` owns that
        // path).
        expect(reduced.dimensions).toEqual(committed.dimensions);
        expect(reduced.eligibilityRule).toEqual(committed.eligibilityRule);
        expect(reduced.repeatRule).toEqual(committed.repeatRule);
        expect(reduced.repeatRule.minEligiblePerSlotForFullWeek).toBe(4);
        expect(reduced.boundary).toBe(committed.boundary);
        expect(reduced.boundary).toContain('no_matching_meals');
        expect(reduced.schemaVersion).toBe(committed.schemaVersion);
    });

    it('moves the composition counts with the seeded set', () => {
        const shortfalls: string[] = [];

        for (const [slot, composition] of Object.entries(reduced.slotComposition)) {
            const committedSlot = committed.slotComposition[slot];
            if (composition.totalEligible > committedSlot.totalEligible) {
                shortfalls.push(
                    `${slot}: the reduced corpus reports ${composition.totalEligible} eligible recipes, more than ` +
                        `the whole corpus's ${committedSlot.totalEligible}`,
                );
            }
        }

        expect(shortfalls).toEqual([]);
        // Non-vacuity: at least one slot genuinely lost recipes, so the
        // comparison above is not passing on equality everywhere.
        expect(
            Object.entries(reduced.slotComposition).some(
                ([slot, composition]) =>
                    composition.totalEligible < committed.slotComposition[slot].totalEligible,
            ),
        ).toBe(true);
    });
});

