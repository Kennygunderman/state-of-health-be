/**
 * The catalog release loader — `scripts/catalog-load.ts` — against a real
 * PostgreSQL.
 *
 * Agent Action Plan §0.9.2 names this file for four scenarios, and they are the
 * four `describe` blocks in the middle of it: a v1 load, a rerun in which
 * everything is a no-op, a failure after partial progress followed by a
 * successful rerun, and a v1 → v2 upgrade that retires the food the newer
 * release drops. §0.9.2 additionally names it for "catalog load verifies
 * checksums and refuses tampered releases", which is the block above them,
 * because that refusal is only meaningful if it happens with NOTHING written —
 * so what it asserts is the state of the tables, not the shape of the error.
 *
 * WHY THE RELEASES ARE SYNTHESIZED. Every behavioural test below builds a
 * miniature release in a temporary directory from
 * `data/meal-planning/fixtures/catalog-foods.fixture.json`, taking the fixture's
 * PUBLISHED slice — 26 foods, 54 aliases, 28 portions, 4 compositions and 26
 * validation records — because that is exactly what an exporter emits: a release
 * carries the published set and nothing else. The digests in each manifest are
 * MEASURED from the bytes written, never asserted from a constant, so a release
 * is only ever loaded against its own real checksums.
 *
 * The synthesized records also carry the identity EVIDENCE a published row must
 * have — an observed 2xx retrieval status, a body digest, the matched snippet
 * and, for a USDA row, its cache key and per-food digest — because the loader
 * now refuses a published food whose record is short of any of them and the
 * exporter refuses to produce such a release at all. 21 of the fixture's 26
 * published records predate that floor and carry `identity_evidence: []`, so
 * the harness supplies one deterministically from the food's own key (see
 * `syntheticIdentityEvidence`); the fixture is a shared artefact this suite only
 * reads. The block "a release whose published rows are not evidenced is refused
 * before any write" then removes one field at a time from ONE record and asserts
 * the refusal, its member, its line and that the tables are still empty.
 *
 * The slice is not arbitrary either. It carries the two published
 * `ingredient_derived` foods whose four compositions point at three other
 * published foods, so `component_food_source_key` → local id remapping is
 * genuinely exercised — including the FORWARD reference that makes it
 * interesting, since `ai:condiment_sauce:lemon olive oil dressing:prepared`
 * sorts before the `usda:` foods it derives from and therefore loads before they
 * exist. It also carries five foods with a `generation_batch_key`, so the
 * unresolved-batch fact is exercised against a database that holds no batch
 * ledger.
 *
 * One of those two derived parents is shipped RE-DERIVED, for the same reason
 * and on the same terms as the identity evidence above: the loader now
 * recomputes every published `ingredient_derived` food from the components the
 * release states for it, and the fixture's
 * `ai:prepared_meal:herbed yogurt dip:prepared` is deliberately one
 * `component_nutrition_version` behind its component — which is the fixture's
 * whole purpose and is asserted in `catalog.logic.test.ts`, so the shared
 * artefact is left untouched and the release built from it carries the form an
 * exporter could have produced (see `REDERIVED_STALE_PARENT`, whose arithmetic
 * is written out so a reader checks it by hand rather than against the function
 * under test). The block "a release whose derived foods disagree with their
 * compositions is refused before any write" then puts each defect back, one at
 * a time, and asserts the refusal, its member, its line, its gap and that the
 * tables are still empty.
 *
 * THE REAL ARTEFACT IS LOADED HERE, WHOLE. The last block applies the committed
 * 9,422-food release through `runLoad` and then applies it again, because
 * §0.9.1's gate — the release loaded twice, the second run reporting no insert
 * and no update — is the one claim no synthesized release can stand in for: it
 * is what says the bytes in this repository reconcile against a database, and
 * it is the acceptance signal §0.9.3 asks for. It is by far the longest-running
 * test in this file — it reconciles every row of an 11,046-food release against
 * PostgreSQL, twice — which is why it is ONE test rather than the vehicle for
 * every behavioural claim above it. No wall-clock figure is quoted: how long it
 * takes is a property of the runner and the database it is pointed at, and a
 * number here would read as a budget this suite does not assert.
 *
 * It is also not covered anywhere else, which is worth stating because the
 * neighbouring suite reads as though it were. `src/__tests__/api/seed-rerun.test.ts`
 * verifies this release's manifest — every member's streamed digest, byte length
 * and row count — but applies only the 69-food ingredient slice its recipes
 * need, and does so through Prisma directly rather than through this loader,
 * deferring the loader's own run here by name. Deferring back to it would leave
 * the corpus-loadability claim owned by neither.
 *
 * WHAT IS DELIBERATELY NOT HERE, because it belongs to other suites:
 * the pure catalog rules (`catalog.logic.test.ts`), the `/catalog/*` HTTP
 * contract and search relevance (`api/catalog.test.ts`), import, generation and
 * seed behaviour (`scripts/catalog-import.test.ts`, `api/seed-rerun.test.ts`),
 * cross-stage races (`api/concurrency.test.ts`) and the out-of-process
 * database-guard proof (`setup/testDb.test.ts`). The guard block below is the
 * in-process policy decision only.
 *
 * SAFETY AND ISOLATION. No database name is hardcoded: the suite truncates
 * through `setup/testDb.ts::truncateFeatureTables`, which re-runs the identity
 * guard (`NODE_ENV=test`, `ALLOW_DB_TRUNCATE=true`, a `_test`-class name on a
 * local host) and the schema-freshness gate before emptying anything. Every
 * temporary release directory is removed afterwards, `clearManifestCache()` runs
 * after each test because `manifest.ts` memoises by absolute path, and nothing
 * here writes to `process.env` or mocks a module internal — the mid-load failure
 * is injected through `LoadDeps`, which is what that seam is for.
 *
 * Run it with:
 *
 *   NODE_ENV=test ALLOW_DB_TRUNCATE=true \
 *     DATABASE_URL=postgresql://…@127.0.0.1:5433/<name>_test \
 *     npx jest src/__tests__/scripts --runInBand
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';

import {
    CatalogLoadError,
    describeFailure,
    parseArgs,
    preflight,
    runLoad,
} from '../../../scripts/catalog-load';
import type { LoadDb, LoadDeps, LoadPreflightDeps, LoadSummary } from '../../../scripts/catalog-load';
import { runRelease } from '../../../scripts/catalog-release';
import type { ReleaseDb, ReleaseFoodRow, ReleaseRunRow } from '../../../scripts/catalog-release';
import { assessIdentityEvidence, evidenceGapCodes } from '../../../scripts/lib/catalogEvidence';
import type { SourceCacheRow } from '../../../scripts/lib/catalogEvidence';
// The digest helpers the import stage takes `body_sha256` and `record_sha256`
// with, used by the exported-release case so its evidence resolves against a
// real cached payload.
import { canonicalJsonString, sha256Hex } from '../../../scripts/lib/catalogFoodFacts';
import { canonicalValidationRunKey, catalogInputIdentity, getActiveReleaseLoad } from '../../../scripts/lib/checkpoint';
import type { CatalogInputRunRow } from '../../../scripts/lib/checkpoint';
import {
    DatabaseOriginError,
    SCRIPT_DATABASE_POLICIES,
    assertScriptDatabase,
    classifyDatabaseOrigin,
    entryScriptName,
    evaluateScriptDatabase,
} from '../../../scripts/lib/dbGuard';
import { createLogger } from '../../../scripts/lib/logger';
import type { ScriptLogger } from '../../../scripts/lib/logger';
import {
    ManifestError,
    assertReleaseVersion,
    clearManifestCache,
    fixturePath,
    loadCoveragePlan,
    loadReleaseManifest,
    releaseDir,
    releaseFilePath,
} from '../../../scripts/lib/manifest';
import type { CatalogReleaseManifest } from '../../../scripts/lib/manifest';
import type { Prisma } from '../../generated/prisma';
import { prisma } from '../../prisma/client';
import { getSuggestions, searchPublishedFoods } from '../../services/catalog.service';
import { makeRecipeVersion, makeUser } from '../setup/factories';
import { truncateFeatureTables } from '../setup/testDb';

/** A load of 260 synthesized foods runs twice in one test; the default 5 s is not enough. */
jest.setTimeout(180_000);

const FOODS_FILE = 'foods.jsonl';
const ALIASES_FILE = 'aliases.jsonl';
const PORTIONS_FILE = 'portions.jsonl';
const COMPONENTS_FILE = 'components.jsonl';
const VALIDATION_RECORDS_FILE = 'validation-records.jsonl';

const RELEASE_MEMBERS: readonly string[] = [
    FOODS_FILE,
    ALIASES_FILE,
    PORTIONS_FILE,
    COMPONENTS_FILE,
    VALIDATION_RECORDS_FILE,
];

/** The real release every environment loads, used only by the artefact block. */
const REAL_RELEASE = 'v1';

/**
 * The loader's chunk size, restated here because two tests reason about it: the
 * apply pass reads a whole chunk of foods and their children BEFORE it applies
 * any of them, so "which bytes has the load already read?" is answered in
 * chunks, not in single foods.
 */
const LOADER_CHUNK_SIZE = 250;

/** The `nutrition_method` every synthesized validation record carries, for the tampers. */
const SYNTHETIC_METHOD = 'synthetic_method_0';

/** Injected everywhere a clock is needed, so no assertion depends on the wall clock. */
const NOW = new Date('2026-09-14T09:30:00.000Z');

const silentLogger: ScriptLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => silentLogger,
};

type Row = Record<string, unknown>;

/* ---------------------------------------------------------------------------
 * The fixture, read once, and the release lines derived from it
 * ------------------------------------------------------------------------- */

interface FixtureDocument {
    readonly foods: readonly Row[];
    readonly aliases: readonly Row[];
    readonly portions: readonly Row[];
    readonly components: readonly Row[];
    readonly validation_records: readonly Row[];
}

const fixture = JSON.parse(
    fs.readFileSync(fixturePath('catalog-foods.fixture.json'), 'utf-8'),
) as FixtureDocument;

const FOOD_LINE_FIELDS: readonly string[] = [
    'source_key',
    'canonical_name',
    'display_name',
    'category',
    'food_state',
    'food_group',
    'identity_source',
    'identity_status',
    'nutrition_provenance',
    'publication_status',
    'nutrition_basis',
    'basis_amount',
    'calories',
    'protein_g',
    'carbs_g',
    'fat_g',
    'fiber_g',
    'density_g_per_ml',
    'allergen_tags',
    'allergen_status',
    'diet_tags',
    'is_common_dislike',
    'cost_class',
    'nutrition_version',
    'metadata_version',
    'usda_fdc_id',
    'usda_data_type',
    'usda_description',
    'source_version',
    'source_cache_key',
    'generation_batch_key',
    'search_text',
    'imported_at',
];

const VALIDATION_LINE_FIELDS: readonly string[] = [
    'food_source_key',
    'canonical_identity',
    'aliases',
    'category',
    'food_state',
    'identity_source',
    'identity_status',
    'nutrition_provenance',
    'nutrition_method',
    'portion_units',
    'identity_evidence',
    'checks',
    'llm_review',
    'outcome',
    'reviewed_at',
    'publication_status',
    'source_versions',
    'history',
];

const pick = (row: Row, fields: readonly string[]): Row => {
    const picked: Row = {};
    for (const field of fields) {
        picked[field] = row[field] ?? null;
    }
    return picked;
};

const textsOf = (value: unknown): string[] => (Array.isArray(value) ? [...(value as string[])].sort() : []);

/**
 * The inverse of `catalog-release.ts::toReleaseValidationLine`: the column holds
 * JSON text (or prose, or null) and the release states an array, so the fixture's
 * stored form is mapped onto the release's exactly as the exporter maps it.
 */
const releaseAssumptions = (stored: unknown): string[] => {
    if (typeof stored !== 'string' || stored.length === 0) {
        return [];
    }
    try {
        const parsed: unknown = JSON.parse(stored);
        return Array.isArray(parsed) ? (parsed as string[]) : [stored];
    } catch {
        return [stored];
    }
};

const foodLine = (food: Row): Row => ({
    ...pick(food, FOOD_LINE_FIELDS),
    allergen_tags: textsOf(food.allergen_tags),
    diet_tags: textsOf(food.diet_tags),
});

const aliasLine = (alias: Row): Row => ({
    food_source_key: alias.food_source_key,
    alias: String(alias.alias).toLowerCase(),
});

const portionLine = (portion: Row): Row => ({
    food_source_key: portion.food_source_key,
    description: portion.description,
    amount: portion.amount,
    unit: portion.unit,
    gram_weight: portion.gram_weight,
    is_default: portion.is_default,
    source: portion.source,
});

const componentLine = (component: Row): Row => ({
    food_source_key: component.food_source_key,
    component_food_source_key: component.component_source_key,
    quantity_grams: component.quantity_grams,
    yield_factor: component.yield_factor,
    component_nutrition_version: component.component_nutrition_version,
    sort_order: component.sort_order,
});

/**
 * The identity evidence a SYNTHESIZED release carries for one record.
 *
 * WHY THE HARNESS SUPPLIES ONE. `catalog-load.ts` now applies the
 * identity-evidence floor to every published food's record before it writes
 * anything, and `catalog-release.ts` refuses to export a published row without
 * one — so a release whose published rows carry no retrieval record is not a
 * release any exporter could have produced, and building one here would test the
 * loader against bytes that cannot exist. `catalog-foods.fixture.json` predates
 * that floor: 21 of its 26 published rows carry `identity_evidence: []` (its
 * five generated rows already carry a complete reference-page record). The
 * fixture is a shared artefact this suite only reads, so the missing record is
 * synthesized HERE, deterministically from the food's own key, exactly as the
 * importer would have written it — a real 2xx status, a 64-hex body digest, the
 * `usda_api_cache` key and the per-food digest that make one batch response
 * evidence for this food.
 *
 * A record the fixture DOES carry is passed through untouched, so the camelCase
 * spelling `evidence.service.ts` writes is exercised by the generated rows
 * alongside the importer's snake_case one.
 */
const digestOf = (subject: string): string => crypto.createHash('sha256').update(subject).digest('hex');

const syntheticIdentityEvidence = (record: Row): Row[] => {
    const foodSourceKey = String(record.food_source_key);

    if (record.identity_source === 'ai_generated') {
        return [
            {
                url: `https://fdc.nal.usda.gov/food-details/${encodeURIComponent(foodSourceKey)}/nutrients`,
                finalHost: 'fdc.nal.usda.gov',
                status: 200,
                bodySha256: digestOf(`body:${foodSourceKey}`),
                matchedSnippet: String(record.category),
                fetchedAt: NOW.toISOString(),
            },
        ];
    }

    return [
        {
            url: 'https://api.nal.usda.gov/fdc/v1/foods',
            method: 'POST',
            final_host: 'api.nal.usda.gov',
            http_status: 200,
            source_cache_key: `POST /foods?#{"fdcIds":["${foodSourceKey}"],"format":"full"}`,
            retrieval_source: 'usda_api_cache',
            body_sha256: digestOf(`body:${foodSourceKey}`),
            record_sha256: digestOf(`record:${foodSourceKey}`),
            matched_snippet: String(record.category),
            fetched_at: NOW.toISOString(),
        },
    ];
};

const releaseIdentityEvidence = (record: Row): unknown =>
    Array.isArray(record.identity_evidence) && record.identity_evidence.length > 0
        ? record.identity_evidence
        : syntheticIdentityEvidence(record);

const validationLine = (record: Row): Row => ({
    ...pick(record, VALIDATION_LINE_FIELDS),
    aliases: textsOf(record.aliases),
    identity_evidence: releaseIdentityEvidence(record),
    nutrition_assumptions: releaseAssumptions(record.nutrition_assumptions),
    history: Array.isArray(record.history) ? record.history : [],
});

interface ReleaseContent {
    readonly foods: Row[];
    readonly aliases: Row[];
    readonly portions: Row[];
    readonly components: Row[];
    readonly validationRecords: Row[];
}

/**
 * The fixture's STALE derived parent, and the scalars a re-derivation of it
 * produces.
 *
 * WHY THE HARNESS RE-DERIVES IT. `catalog-load.ts` now recomputes every
 * published `ingredient_derived` food from the components the release states
 * for it and refuses a release whose parent scalars, basis or component version
 * pins disagree — and `catalog-release.ts` will not export such a release
 * either. `catalog-foods.fixture.json` predates that gate and carries one row
 * that is deliberately on the wrong side of it:
 * `ai:prepared_meal:herbed yogurt dip:prepared` pins `usda:9200115` at
 * `nutrition_version` 1 while that food is at 2, and its stored scalars are the
 * derivation at those version-1 values (which the row's `superseded_nutrition`
 * block keeps, so both results stay recomputable by a reader). That is the
 * fixture's purpose and `src/services/__tests__/catalog.logic.test.ts` asserts
 * it, so the file is left exactly as it is — and the release built FROM it is
 * repaired here instead, which is what wave 1 did for the 21 published records
 * that carry no retrieval evidence (see `syntheticIdentityEvidence`).
 *
 * THE NUMBERS ARE STATED, NOT RECOMPUTED. Re-deriving them in the harness with
 * the same function the loader calls would make the "a consistent release loads
 * cleanly" case assert the arithmetic against itself. So they are written out,
 * and a reader checks them by hand — 150 g of `usda:9200115` at its CURRENT
 * values (59 kcal, 10.19 P, 3.6 C, 0.39 F, 0 fibre) plus 10 g of
 * `usda:9200114` (22 kcal, 0.35 P, 6.9 C, 0.24 F, 0.3 fibre), both at yield
 * factor 1, so 160 g in and 160 g out:
 *
 *     calories (1.5×59  + 0.1×22 ) / 160 × 100 = 56.6875
 *     protein  (1.5×10.19 + 0.1×0.35) / 160 × 100 = 9.575
 *     carbs    (1.5×3.6  + 0.1×6.9) / 160 × 100 = 3.80625
 *     fat      (1.5×0.39 + 0.1×0.24) / 160 × 100 = 0.380625
 *     fibre    (1.5×0    + 0.1×0.3) / 160 × 100 = 0.01875
 *
 * A fixture change that moved either component's nutrition would make the
 * release inconsistent and every load case below would refuse it, which is the
 * loud failure this form is chosen for.
 */
const STALE_DERIVED_PARENT = 'ai:prepared_meal:herbed yogurt dip:prepared';

const REDERIVED_STALE_PARENT: Readonly<Record<string, number>> = {
    calories: 56.6875,
    protein_g: 9.575,
    carbs_g: 3.80625,
    fat_g: 0.380625,
    fiber_g: 0.01875,
};

/**
 * The fixture's published slice, in the order a release states it, with its one
 * stale derived parent shipped re-derived (see {@link REDERIVED_STALE_PARENT}).
 *
 * Each component line's pin is taken from the component FOOD's current
 * `nutrition_version` rather than from the stored pin, because that is what an
 * exporter can only ever emit: a release states one version of each food, so a
 * pin naming another one describes a composition those bytes do not carry. For
 * the three already-current rows this changes nothing.
 */
const publishedSlice = (): ReleaseContent => {
    const published = fixture.foods.filter((food) => food.publication_status === 'published');
    const keys = new Set(published.map((food) => String(food.source_key)));
    const owns = (row: Row): boolean => keys.has(String(row.food_source_key));
    const currentNutritionVersion = new Map(
        published.map((food) => [String(food.source_key), food.nutrition_version]),
    );

    const rederived = (food: Row): Row =>
        food.source_key === STALE_DERIVED_PARENT ? { ...food, ...REDERIVED_STALE_PARENT } : food;

    return {
        foods: published.map(foodLine).map(rederived),
        aliases: fixture.aliases.filter(owns).map(aliasLine),
        portions: fixture.portions.filter(owns).map(portionLine),
        components: fixture.components
            .filter((component) => owns(component) && keys.has(String(component.component_source_key)))
            .map(componentLine)
            .map((component) => ({
                ...component,
                component_nutrition_version:
                    currentNutritionVersion.get(String(component.component_food_source_key)) ??
                    component.component_nutrition_version,
            })),
        validationRecords: fixture.validation_records.filter(owns).map(validationLine),
    };
};

/* ---------------------------------------------------------------------------
 * Writing a release to disk, with measured digests
 * ------------------------------------------------------------------------- */

interface BuiltRelease {
    readonly release: string;
    readonly root: string;
    readonly manifest: CatalogReleaseManifest;
}

const temporaryRoots: string[] = [];

const compare = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

const byParentThen = (secondKey: string): ((left: Row, right: Row) => number) => (left, right) => {
    const parents = compare(String(left.food_source_key), String(right.food_source_key));
    return parents !== 0 ? parents : compare(String(left[secondKey]), String(right[secondKey]));
};

/** JSONL as the exporter writes it: one compact object per line, LF-terminated. */
const toJsonl = (rows: readonly Row[]): string =>
    rows.length === 0 ? '' : `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;

/**
 * What a caller may declare beyond the members themselves.
 *
 * `evidence` is the manifest block `catalog-release.ts` measures while it
 * exports. It is OPTIONAL here on purpose: the default release carries no block
 * at all, which is the reviewed-release-cut-before-the-block case the loader has
 * to keep loading, and the cases that pass one exercise the cross-check.
 */
interface ReleaseOverrides {
    readonly evidence?: unknown;
}

const writeRelease = (release: string, content: ReleaseContent, overrides: ReleaseOverrides = {}): BuiltRelease => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `catalog-load-${release}-`));
    temporaryRoots.push(root);

    const foods = [...content.foods].sort((left, right) => compare(String(left.source_key), String(right.source_key)));
    const aliases = [...content.aliases].sort(byParentThen('alias'));
    const portions = [...content.portions].sort(byParentThen('description'));
    const components = [...content.components].sort(byParentThen('component_food_source_key'));
    const validationRecords = [...content.validationRecords].sort((left, right) =>
        compare(String(left.food_source_key), String(right.food_source_key)),
    );

    const contents: Readonly<Record<string, string>> = {
        [FOODS_FILE]: toJsonl(foods),
        [ALIASES_FILE]: toJsonl(aliases),
        [PORTIONS_FILE]: toJsonl(portions),
        [COMPONENTS_FILE]: toJsonl(components),
        [VALIDATION_RECORDS_FILE]: toJsonl(validationRecords),
    };
    const rowCounts: Readonly<Record<string, number>> = {
        [FOODS_FILE]: foods.length,
        [ALIASES_FILE]: aliases.length,
        [PORTIONS_FILE]: portions.length,
        [COMPONENTS_FILE]: components.length,
        [VALIDATION_RECORDS_FILE]: validationRecords.length,
    };

    for (const member of RELEASE_MEMBERS) {
        fs.writeFileSync(path.join(root, member), contents[member], 'utf-8');
    }

    // Measured from the bytes on disk, exactly as catalog-release.ts measures
    // them: a digest taken from the string in memory would not describe the file
    // the loader reads.
    const files = RELEASE_MEMBERS.map((member) => {
        const bytes = fs.readFileSync(path.join(root, member));
        return {
            path: member,
            name: member,
            sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
            row_count: rowCounts[member],
            bytes: bytes.length,
        };
    });

    const derivedCount = foods.filter((food) => food.nutrition_provenance === 'ingredient_derived').length;
    const manifest: CatalogReleaseManifest = {
        release_id: release,
        manifest_version: 'v1',
        coverage_plan_version: 'v1',
        generated_at: NOW.toISOString(),
        produced_by: 'pipeline',
        files,
        counts: {
            foods: foods.length,
            published_foods: foods.length,
            aliases: aliases.length,
            portions: portions.length,
            components: components.length,
            published_ingredient_derived: derivedCount,
            validation_records: validationRecords.length,
        },
        source_datasets: [
            {
                name: 'SR Legacy',
                version: 'SR Legacy 2019-04',
                retrieved_at: NOW.toISOString(),
                public_domain: true,
            },
        ],
        model_versions: {
            generation_model: null,
            review_model: null,
            prompt_version: null,
            generation_prompt_version: null,
            review_prompt_version: null,
        },
        coverage: {
            coverage_plan_version: 'v1',
            published_total: foods.length,
            shortfall_total: 0,
            categories: [],
        },
    };
    // Added as an extra key rather than through the shared type: the manifest is
    // a document on disk, and `evidence` is an additive block a release may or
    // may not carry, which is exactly the pair of cases the loader is held to.
    const declared: Record<string, unknown> = { ...manifest };
    if (overrides.evidence !== undefined) {
        declared.evidence = overrides.evidence;
    }

    fs.writeFileSync(path.join(root, 'manifest.json'), `${JSON.stringify(declared, null, 2)}\n`, 'utf-8');

    return { release, root, manifest: declared as unknown as CatalogReleaseManifest };
};

/**
 * Changes exactly one byte of a member, leaving its length and row count intact
 * so that only the DIGEST can catch it — which is the point of the check.
 *
 * A member with no bytes cannot have one flipped, so the zero-row
 * `components.jsonl` is tampered with by ADDING one: the digest and the byte
 * length both move, and an empty member is verified like any other.
 */
const tamperOneByte = (built: BuiltRelease, member: string): void => {
    const absolute = path.join(built.root, member);
    const bytes = fs.readFileSync(absolute);

    if (bytes.length === 0) {
        fs.writeFileSync(absolute, Buffer.from('\n'));
        return;
    }

    const index = bytes.indexOf(0x31);
    if (index < 0) {
        throw new Error(`${member} carries no "1" to flip; the tamper helper needs one byte to change.`);
    }
    const mutated = Buffer.from(bytes);
    mutated[index] = 0x32;
    fs.writeFileSync(absolute, mutated);
};

const loadDeps = (built: BuiltRelease, overrides: Partial<LoadDeps> = {}): LoadDeps => ({
    db: prisma as unknown as LoadDb,
    runDb: prisma,
    release: built.release,
    manifest: built.manifest,
    releaseRoot: built.root,
    logger: silentLogger,
    now: () => NOW,
    dryRun: false,
    ...overrides,
});

const preflightDeps = (built: BuiltRelease, overrides: Partial<LoadPreflightDeps> = {}): LoadPreflightDeps => ({
    env: {},
    release: built.release,
    assertReleaseVersion,
    loadReleaseManifest: () => built.manifest,
    releaseFilePath: (_release: string, fileName: string) => path.join(built.root, fileName),
    fileExists: (absolutePath: string) => fs.existsSync(absolutePath),
    ...overrides,
});

/* ---------------------------------------------------------------------------
 * Reading the result back
 * ------------------------------------------------------------------------- */

const tableCounts = async (): Promise<Record<string, number>> => ({
    foods: await prisma.catalog_foods.count(),
    aliases: await prisma.catalog_food_aliases.count(),
    portions: await prisma.catalog_food_portions.count(),
    components: await prisma.catalog_food_components.count(),
    validationRecords: await prisma.catalog_validation_records.count(),
    runs: await prisma.catalog_import_runs.count(),
});

interface IdentitySnapshot {
    readonly foods: readonly string[];
    readonly aliases: readonly string[];
    readonly portions: readonly string[];
    readonly components: readonly string[];
    readonly validationRecords: readonly string[];
}

/**
 * Every row's primary key, paired with the stable identity it hangs off.
 *
 * The ids are the assertion: "replaced wholesale" must mean reconciled, not
 * deleted and reinserted, because `recipe_ingredients` and `meal_entries`
 * reference `catalog_foods.id` and because a rerun that churned every child row
 * would be indistinguishable from a no-op by counts alone.
 */
const identities = async (): Promise<IdentitySnapshot> => {
    const foods = await prisma.catalog_foods.findMany({
        select: {
            id: true,
            source_key: true,
            catalog_food_aliases: { select: { id: true, alias: true } },
            catalog_food_portions: { select: { id: true, description: true } },
            catalog_food_components: {
                select: { id: true, component_catalog_foods: { select: { source_key: true } } },
            },
            catalog_validation_records: { select: { id: true } },
        },
        orderBy: { source_key: 'asc' },
    });

    return {
        foods: foods.map((food) => `${food.source_key}=${food.id}`),
        aliases: foods
            .flatMap((food) => food.catalog_food_aliases.map((alias) => `${food.source_key}/${alias.alias}=${alias.id}`))
            .sort(),
        portions: foods
            .flatMap((food) =>
                food.catalog_food_portions.map((portion) => `${food.source_key}/${portion.description}=${portion.id}`),
            )
            .sort(),
        components: foods
            .flatMap((food) =>
                food.catalog_food_components.map(
                    (component) =>
                        `${food.source_key}/${component.component_catalog_foods.source_key}=${component.id}`,
                ),
            )
            .sort(),
        validationRecords: foods
            .filter((food) => food.catalog_validation_records !== null)
            .map((food) => `${food.source_key}=${food.catalog_validation_records?.id ?? ''}`)
            .sort(),
    };
};

/** One catalog food with every child row this suite asserts on. */
type FoodWithChildren = Prisma.catalog_foodsGetPayload<{
    include: {
        catalog_food_aliases: true;
        catalog_food_portions: true;
        catalog_food_components: { include: { component_catalog_foods: true } };
        catalog_validation_records: true;
    };
}>;

const foodBySourceKey = async (sourceKey: string): Promise<FoodWithChildren | null> =>
    prisma.catalog_foods.findUnique({
        where: { source_key: sourceKey },
        include: {
            catalog_food_aliases: { orderBy: { alias: 'asc' } },
            catalog_food_portions: { orderBy: { description: 'asc' } },
            catalog_food_components: { include: { component_catalog_foods: true } },
            catalog_validation_records: true,
        },
    });

/** What a run row is read back as: the ledger columns, never the log. */
type RunRow = Prisma.catalog_import_runsGetPayload<{
    select: { id: true; kind: true; manifest_version: true; status: true; counts: true; cursor: true };
}>;

const runRows = async (): Promise<RunRow[]> =>
    prisma.catalog_import_runs.findMany({
        orderBy: { started_at: 'asc' },
        select: { id: true, kind: true, manifest_version: true, status: true, counts: true, cursor: true },
    });

/** The two `ingredient_derived` foods the published slice carries, and their compositions. */
const DERIVED_PARENT = 'ai:condiment_sauce:lemon olive oil dressing:prepared';
const DROPPED_FOOD = 'usda:9200120';
const SURVIVING_FOOD = 'usda:9200101';
const KEPT_ALIAS = 'skinless chicken breast';
const DROPPED_ALIAS = 'chicken';
const ADDED_ALIAS = 'chicken breast fillet';

beforeEach(async () => {
    await truncateFeatureTables();
});

afterEach(() => {
    // manifest.ts memoises by absolute path, and `loadReleaseManifest` is used
    // by the real-artefact block below; without this a later test could be
    // served a manifest an earlier one loaded.
    clearManifestCache();
});

afterAll(() => {
    for (const root of temporaryRoots) {
        fs.rmSync(root, { recursive: true, force: true });
    }
    temporaryRoots.length = 0;
});

/* ---------------------------------------------------------------------------
 * Verification precedes every write
 * ------------------------------------------------------------------------- */

describe('a tampered release is refused with nothing written', () => {
    const expectRefusal = async (member: string): Promise<void> => {
        const built = writeRelease('v1', publishedSlice());
        tamperOneByte(built, member);

        const failure = await runLoad(loadDeps(built)).then(
            () => null,
            (error: unknown) => error,
        );

        expect(failure).toBeInstanceOf(CatalogLoadError);
        const refusal = failure as CatalogLoadError;
        expect(refusal.code).toBe('release_file_digest_mismatch');
        expect(refusal.context.file).toBe(member);

        // The whole claim: verification runs before the first write, so a
        // tampered release leaves the target database exactly as it was —
        // including `catalog_import_runs`, which means no run was even opened.
        expect(await tableCounts()).toEqual({
            foods: 0,
            aliases: 0,
            portions: 0,
            components: 0,
            validationRecords: 0,
            runs: 0,
        });
        expect(await getActiveReleaseLoad(prisma)).toBeNull();
    };

    it('refuses a one-byte change to foods.jsonl', async () => {
        await expectRefusal(FOODS_FILE);
    });

    it('refuses a one-byte change to portions.jsonl', async () => {
        await expectRefusal(PORTIONS_FILE);
    });

    it('refuses a byte added to the zero-row components.jsonl', async () => {
        // An empty member is an asserted empty composition set, not an absent
        // file, so it is verified like any other — which is what makes "0 rows"
        // a check that passed rather than one that was skipped.
        const built = writeRelease('v1', { ...publishedSlice(), components: [] });
        expect(built.manifest.counts.components).toBe(0);

        tamperOneByte(built, COMPONENTS_FILE);

        const failure = await runLoad(loadDeps(built)).then(
            () => null,
            (error: unknown) => error,
        );

        expect(failure).toBeInstanceOf(CatalogLoadError);
        expect((failure as CatalogLoadError).code).toBe('release_file_digest_mismatch');
        expect((failure as CatalogLoadError).context.file).toBe(COMPONENTS_FILE);
        expect((await tableCounts()).foods).toBe(0);
        expect((await tableCounts()).runs).toBe(0);
    });

    it('refuses a release whose manifest names another release', async () => {
        const built = writeRelease('v2', publishedSlice());

        await expect(runLoad(loadDeps(built, { release: 'v1' }))).rejects.toMatchObject({
            code: 'release_id_mismatch',
        });
        expect((await tableCounts()).runs).toBe(0);
    });

    it('refuses a manifest that declares one member twice, with nothing read and nothing written', async () => {
        // The internal-ambiguity refusal ON THE PATH THAT READS BYTES. `main`
        // never reaches it — preflight reports the same defect as a
        // prerequisite gap first — but `runLoad` is exported and driven
        // directly, and a caller that skipped preflight must not end up
        // verifying a member against whichever of two digests came last.
        const built = writeRelease('v1', publishedSlice());
        const declared = built.manifest.files.find(
            (file) => file.path === PORTIONS_FILE,
        ) as CatalogReleaseManifest['files'][number];
        const doctored: CatalogReleaseManifest = {
            ...built.manifest,
            files: [...built.manifest.files, { ...declared, sha256: 'f'.repeat(64) }],
        };

        const failure = await runLoad(loadDeps(built, { manifest: doctored })).then(
            () => null,
            (error: unknown) => error,
        );

        expect(failure).toBeInstanceOf(CatalogLoadError);
        const refusal = failure as CatalogLoadError;
        expect(refusal.code).toBe('release_member_declared_twice');
        expect(refusal.context.file).toBe(PORTIONS_FILE);

        // Refused while assembling the file list, so no member was streamed and
        // no run row was opened.
        expect(await tableCounts()).toEqual({
            foods: 0,
            aliases: 0,
            portions: 0,
            components: 0,
            validationRecords: 0,
            runs: 0,
        });
        expect(await getActiveReleaseLoad(prisma)).toBeNull();
    });
});

/* ---------------------------------------------------------------------------
 * The document a release is read through
 *
 * `loadReleaseManifest` is the only way this stage obtains a manifest, and it
 * resolves under the repository's own data root from a release id alone — the
 * path-taking loader beneath it is not exported. So these four refusals are
 * exercised where the loader actually meets them, by writing a manifest into a
 * scratch release directory inside the data root and removing it again. The id
 * has to satisfy the release-id rule, so it is a version number no release uses.
 *
 * They assert the code and nothing else: each one sends the operator somewhere
 * different — an unrun pipeline stage, a truncated write, a document this build
 * cannot interpret — and the message is free to change.
 * ------------------------------------------------------------------------- */

describe('a release manifest that cannot be read', () => {
    const SCRATCH_RELEASE = 'v9001';

    const consistentManifest = (): Record<string, unknown> => ({
        release_id: SCRATCH_RELEASE,
        manifest_version: 'v1',
        coverage_plan_version: 'v1',
        generated_at: NOW.toISOString(),
        produced_by: 'pipeline',
        files: [],
        counts: {},
        source_datasets: [],
        model_versions: {},
        coverage: {},
    });

    /**
     * Writes `body` as the scratch release's manifest — or leaves the directory
     * empty when it is null — and removes the directory afterwards whatever the
     * assertions do, because this one writes inside the working tree.
     */
    const withScratchManifest = (body: string | null, assertions: () => void): void => {
        const directory = releaseDir(SCRATCH_RELEASE);
        try {
            fs.mkdirSync(directory, { recursive: true });
            if (body !== null) {
                fs.writeFileSync(path.join(directory, 'manifest.json'), body, 'utf-8');
            }
            clearManifestCache();
            assertions();
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
            clearManifestCache();
        }
    };

    const refusalOf = (release: string): ManifestError => {
        try {
            loadReleaseManifest(release);
        } catch (error) {
            return error as ManifestError;
        }
        throw new Error(`loadReleaseManifest('${release}') was expected to refuse, and returned a manifest.`);
    };

    it('reports a release directory that carries no manifest', () => {
        withScratchManifest(null, () => {
            const refusal = refusalOf(SCRATCH_RELEASE);
            expect(refusal).toBeInstanceOf(ManifestError);
            expect(refusal.code).toBe('file_not_found');
        });
    });

    it('reports a manifest that is not JSON', () => {
        withScratchManifest(`${JSON.stringify(consistentManifest()).slice(0, 40)}`, () => {
            const refusal = refusalOf(SCRATCH_RELEASE);
            expect(refusal).toBeInstanceOf(ManifestError);
            expect(refusal.code).toBe('invalid_json');
        });
    });

    it('reports a manifest that states no coverage-plan version', () => {
        const { coverage_plan_version: _omitted, ...withoutVersion } = consistentManifest();

        withScratchManifest(JSON.stringify(withoutVersion), () => {
            const refusal = refusalOf(SCRATCH_RELEASE);
            expect(refusal).toBeInstanceOf(ManifestError);
            expect(refusal.code).toBe('missing_version_field');
        });
    });

    it('reports a manifest produced from a coverage plan this build does not carry', () => {
        withScratchManifest(JSON.stringify({ ...consistentManifest(), coverage_plan_version: 'v2' }), () => {
            const refusal = refusalOf(SCRATCH_RELEASE);
            expect(refusal).toBeInstanceOf(ManifestError);
            expect(refusal.code).toBe('version_mismatch');
        });
    });

    it('is not memoised, so the second read fails the same way as the first', () => {
        // The cache is written only after every check has passed, which is what
        // makes a refused manifest safe to leave on disk: the next reader is
        // refused too, rather than served a document nothing validated.
        withScratchManifest(JSON.stringify({ ...consistentManifest(), coverage_plan_version: 'v2' }), () => {
            expect(refusalOf(SCRATCH_RELEASE).code).toBe('version_mismatch');
            expect(refusalOf(SCRATCH_RELEASE).code).toBe('version_mismatch');
        });
    });
});


/* ---------------------------------------------------------------------------
 * The window between the two reads
 *
 * Verification and the apply pass each read the release from disk, so an edit
 * between them would otherwise be applied unreviewed. The tampers above all
 * happen before `runLoad` and are caught by verification; these two happen
 * INSIDE a load, through the two seams `LoadDeps` exposes, and are caught by
 * the two mechanisms that bind the applied bytes to the verified ones.
 * ------------------------------------------------------------------------- */

/**
 * Replaces the LAST occurrence of `from` with `to` in a member, keeping its byte
 * length and its row count identical so that no re-measurement of the file's
 * size or of its rows could ever notice.
 */
const mutateSameLength = (built: BuiltRelease, member: string, from: string, to: string): void => {
    if (Buffer.byteLength(from) !== Buffer.byteLength(to)) {
        throw new Error(`the tamper must preserve the byte length: "${from}" and "${to}" differ`);
    }

    const absolute = path.join(built.root, member);
    const bytes = fs.readFileSync(absolute);
    const at = bytes.lastIndexOf(from);
    if (at < 0) {
        throw new Error(`${member} carries no "${from}" to change`);
    }

    const mutated = Buffer.from(bytes);
    mutated.write(to, at, 'utf-8');
    fs.writeFileSync(absolute, mutated);
    expect(fs.statSync(absolute).size).toBe(bytes.length);
};

describe('a release that changes between its verification and the load', () => {
    /**
     * A modification time chosen so it can be restored bit-for-bit: an integer
     * number of seconds is exactly representable as the double `utimes` takes,
     * where an arbitrary nanosecond timestamp is not.
     */
    const FROZEN_MTIME_SECONDS = 1_700_000_000;

    it('refuses a same-length edit whose file identity is indistinguishable, and activates nothing', async () => {
        // THE DIGEST ON ITS OWN, with the cheap check deliberately defeated:
        // the edit keeps the member's byte length, its row count AND its inode,
        // and its modification time is restored to the value verification
        // measured, so nothing but a digest over the bytes the apply pass read
        // can tell that the release changed.
        const built = syntheticRelease('v1', 12);
        const declared = built.manifest.files.find((file) => file.path === VALIDATION_RECORDS_FILE);
        const absolute = path.join(built.root, VALIDATION_RECORDS_FILE);
        fs.utimesSync(absolute, FROZEN_MTIME_SECONDS, FROZEN_MTIME_SECONDS);

        const failure = await runLoad(
            loadDeps(built, {
                onReleaseVerified: () => {
                    mutateSameLength(built, VALIDATION_RECORDS_FILE, SYNTHETIC_METHOD, 'synthetic_method_1');
                    fs.utimesSync(absolute, FROZEN_MTIME_SECONDS, FROZEN_MTIME_SECONDS);
                },
            }),
        ).then(
            () => null,
            (error: unknown) => error,
        );

        expect(failure).toBeInstanceOf(CatalogLoadError);
        const refusal = failure as CatalogLoadError;
        expect(refusal.code).toBe('release_file_changed_during_load');
        expect(refusal.context.file).toBe(VALIDATION_RECORDS_FILE);
        // The comparison that failed is the digest one, not the identity one:
        // what it names is the 64-character checksum the manifest declares.
        expect(refusal.context.expected).toBe(declared?.sha256);
        expect(String(refusal.context.expected)).toHaveLength(64);
        expect(refusal.context.observed).not.toBe(declared?.sha256);

        const runs = await runRows();
        expect(runs).toHaveLength(1);
        expect(runs[0].status).toBe('failed');
        // THE PROPERTY, and the reason the release is not spooled into verified
        // copies: rows the edit reached may well have been written — the refusal
        // comes after the apply pass — but the run is failed and the active
        // release pointer never moves onto them, so a rerun over a correct
        // release repairs it.
        expect(await prisma.catalog_foods.count()).toBe(built.manifest.counts.foods);
        expect(await getActiveReleaseLoad(prisma)).toBeNull();
    });

    it('applies the bytes it verified when a member is edited after they were read', async () => {
        // The other side of the same window, and the reason the digest is a
        // guarantee rather than a race: each member is streamed once, so an
        // edit made after the load has read those bytes cannot change what the
        // load applies. The rows carry the REVIEWED value and the run succeeds.
        const built = syntheticRelease('v1', 12);
        const lastFood = `usda:93${String(built.manifest.counts.foods - 1).padStart(5, '0')}`;

        const summary = await runLoad(
            loadDeps(built, {
                onFoodSettled: ({ index }) => {
                    if (index === 0) {
                        mutateSameLength(built, VALIDATION_RECORDS_FILE, SYNTHETIC_METHOD, 'synthetic_method_1');
                    }
                },
            }),
        );

        expect(summary.activated).toBe(true);
        expect(summary.counts.foodsInserted).toBe(built.manifest.counts.foods);
        const stored = await foodBySourceKey(lastFood);
        expect(stored?.catalog_validation_records?.nutrition_method).toBe(SYNTHETIC_METHOD);
    });

    it('refuses a member replaced before the apply pass opens it, with nothing written', async () => {
        const built = writeRelease('v1', publishedSlice());

        const failure = await runLoad(
            loadDeps(built, {
                onReleaseVerified: () => {
                    // The ordinary case: a member regenerated, truncated or
                    // half-written between the two reads.
                    fs.writeFileSync(path.join(built.root, PORTIONS_FILE), '', 'utf-8');
                },
            }),
        ).then(
            () => null,
            (error: unknown) => error,
        );

        expect(failure).toBeInstanceOf(CatalogLoadError);
        expect((failure as CatalogLoadError).code).toBe('release_file_changed_during_load');
        expect((failure as CatalogLoadError).context.file).toBe(PORTIONS_FILE);

        // Refused ahead of the first write, so the run row is the only trace:
        // no food, no child row, not even a retirement.
        expect(await tableCounts()).toEqual({
            foods: 0,
            aliases: 0,
            portions: 0,
            components: 0,
            validationRecords: 0,
            runs: 1,
        });
        expect((await runRows())[0].status).toBe('failed');
        expect(await getActiveReleaseLoad(prisma)).toBeNull();
    });

    it('refuses it on the dry-run path too, where not even a run row is opened', async () => {
        const built = writeRelease('v1', publishedSlice());

        const failure = await runLoad(
            loadDeps(built, {
                dryRun: true,
                onReleaseVerified: () => {
                    fs.writeFileSync(path.join(built.root, ALIASES_FILE), '', 'utf-8');
                },
            }),
        ).then(
            () => null,
            (error: unknown) => error,
        );

        expect(failure).toBeInstanceOf(CatalogLoadError);
        expect((failure as CatalogLoadError).code).toBe('release_file_changed_during_load');
        expect((failure as CatalogLoadError).context.file).toBe(ALIASES_FILE);
        expect((await tableCounts()).runs).toBe(0);
    });
});

/* ---------------------------------------------------------------------------
 * (a) The load
 * ------------------------------------------------------------------------- */

describe('loading a release', () => {
    it('applies every food, its children and its compositions, and activates the run', async () => {
        const built = writeRelease('v1', publishedSlice());
        const expected = built.manifest.counts;

        const summary = await runLoad(loadDeps(built));

        expect(summary.dryRun).toBe(false);
        expect(summary.resumed).toBe(false);
        expect(summary.activated).toBe(true);
        expect(summary.runId).not.toBeNull();
        expect(summary.counts.foodsInserted).toBe(expected.foods);
        expect(summary.counts.foodsUpdated).toBe(0);
        expect(summary.counts.foodsUnchanged).toBe(0);
        expect(summary.counts.aliasesWritten).toBe(expected.aliases);
        expect(summary.counts.portionsWritten).toBe(expected.portions);
        expect(summary.counts.validationRecordsWritten).toBe(expected.validation_records);
        expect(summary.counts.foodsRetired).toBe(0);

        // Every member verified, with the digest the manifest declares.
        expect(summary.verification.map((member) => member.file)).toEqual(RELEASE_MEMBERS);
        for (const member of summary.verification) {
            const declared = built.manifest.files.find((file) => file.path === member.file);
            expect(member.sha256).toBe(declared?.sha256);
            expect(member.rowCount).toBe(declared?.row_count);
            expect(member.bytes).toBe(declared?.bytes);
        }

        // And every post-load count check passed, which is the gate activation
        // sits behind.
        expect(summary.countChecks.every((check) => check.ok)).toBe(true);
        expect(summary.countChecks.map((check) => check.name)).toEqual([
            'published_foods',
            'aliases',
            'portions',
            'components',
            'validation_records',
            'published_ingredient_derived',
        ]);

        expect(await tableCounts()).toEqual({
            foods: expected.foods,
            aliases: expected.aliases,
            portions: expected.portions,
            components: expected.components,
            validationRecords: expected.validation_records,
            runs: 1,
        });

        const active = await getActiveReleaseLoad(prisma);
        expect(active?.releaseId).toBe('v1');
        expect(active?.runId).toBe(summary.runId);
        expect((await runRows())[0].status).toBe('succeeded');
    });

    it('remaps a composition onto the local food it points at, including a forward reference', async () => {
        const slice = publishedSlice();
        const built = writeRelease('v1', slice);

        const summary = await runLoad(loadDeps(built));

        // The parent sorts before the `usda:` foods it derives from, so NOTHING
        // could be written for it in file order: the whole food was deferred and
        // applied — row, aliases, portions, composition and validation record in
        // one transaction — once its targets existed. Both numbers matter:
        // deferred is not skipped.
        expect(summary.counts.foodsDeferred).toBe(2);
        expect(summary.counts.componentsWritten).toBe(built.manifest.counts.components);
        // And a deferred food counts as an ordinary insert once it is applied.
        expect(summary.counts.foodsInserted).toBe(built.manifest.counts.foods);

        const parent = await foodBySourceKey(DERIVED_PARENT);
        const declared = slice.components.filter((component) => component.food_source_key === DERIVED_PARENT);
        expect(parent?.catalog_food_components).toHaveLength(declared.length);

        for (const component of declared) {
            const stored = parent?.catalog_food_components.find(
                (row) => row.component_catalog_foods.source_key === component.component_food_source_key,
            );
            expect(stored).toBeDefined();
            // The portable key was replaced by THIS database's id.
            const target = await foodBySourceKey(String(component.component_food_source_key));
            expect(stored?.component_catalog_food_id).toBe(target?.id);
            expect(stored?.quantity_grams).toBe(component.quantity_grams);
            expect(stored?.sort_order).toBe(component.sort_order);
        }
    });

    it('stores the release exactly, including the JSON-encoded validation assumptions', async () => {
        const slice = publishedSlice();
        const built = writeRelease('v1', slice);

        await runLoad(loadDeps(built));

        const line = slice.foods.find((food) => food.source_key === SURVIVING_FOOD) as Row;
        const stored = await foodBySourceKey(SURVIVING_FOOD);
        expect(stored?.calories).toBe(line.calories);
        expect(stored?.canonical_name).toBe(line.canonical_name);
        expect(stored?.publication_status).toBe('published');
        expect(stored?.imported_at?.toISOString()).toBe(line.imported_at);
        // Never written: the release carries no id and no search_vector, and the
        // generated column is the database's to compute.
        expect(stored?.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(FOOD_LINE_FIELDS).not.toContain('search_vector');

        // And yet it is populated, from the `search_text` the release DOES
        // state: the column is `GENERATED ALWAYS AS … STORED`, so a load that
        // named it would be rejected by PostgreSQL outright, and one that omits
        // it still produces a searchable row. Matched with `plainto_tsquery`
        // rather than compared as text, so the claim is "this row is findable
        // by its own search text" and not an assertion about stemmed output.
        // Read through $queryRaw because Prisma models the column as
        // `Unsupported("tsvector")` and cannot select it.
        const [vector] = await prisma.$queryRaw<{ present: boolean; findable: boolean }[]>`
            SELECT search_vector IS NOT NULL AS present,
                   search_vector @@ plainto_tsquery('english', ${String(line.search_text)}) AS findable
            FROM catalog_foods
            WHERE source_key = ${SURVIVING_FOOD}
        `;
        expect(vector.present).toBe(true);
        expect(vector.findable).toBe(true);

        const record = slice.validationRecords.find(
            (entry) => entry.food_source_key === SURVIVING_FOOD,
        ) as Row;
        expect(stored?.catalog_validation_records?.nutrition_assumptions).toBe(
            JSON.stringify(record.nutrition_assumptions),
        );
        expect(stored?.catalog_validation_records?.reviewed_at.toISOString()).toBe(record.reviewed_at);
    });

    it('loads a food whose generation batch this database does not hold, and counts the fact', async () => {
        const built = writeRelease('v1', publishedSlice());

        const summary = await runLoad(loadDeps(built));

        // Five slice foods name a batch key; a release ships no batch ledger, so
        // the link stays null and the fact is counted rather than refused.
        expect(summary.counts.generationBatchUnresolved).toBeGreaterThan(0);
        const withBatchKey = publishedSlice().foods.filter((food) => food.generation_batch_key !== null);
        expect(summary.counts.generationBatchUnresolved).toBe(withBatchKey.length);

        for (const food of withBatchKey) {
            const stored = await foodBySourceKey(String(food.source_key));
            expect(stored?.generation_batch_id).toBeNull();
            expect(stored?.publication_status).toBe('published');
        }
    });

    it('resolves a generation batch this database does hold', async () => {
        const slice = publishedSlice();
        const withBatchKey = slice.foods.find((food) => food.generation_batch_key !== null) as Row;
        const batchKey = String(withBatchKey.generation_batch_key);

        const run = await prisma.catalog_import_runs.create({
            data: { kind: 'ai_generation', manifest_version: 'v1', status: 'succeeded', counts: {}, log: [] },
        });
        const batch = await prisma.catalog_generation_batches.create({
            data: {
                run_id: run.id,
                batch_key: batchKey,
                category: String(withBatchKey.category),
                model: 'test-model',
                prompt_version: 'v1',
                status: 'validated',
            },
        });

        const built = writeRelease('v1', slice);
        const summary = await runLoad(loadDeps(built));

        expect(summary.counts.generationBatchUnresolved).toBe(
            slice.foods.filter((food) => food.generation_batch_key !== null).length - 1,
        );
        expect((await foodBySourceKey(String(withBatchKey.source_key)))?.generation_batch_id).toBe(batch.id);
    });
});

/* ---------------------------------------------------------------------------
 * (b) The rerun
 * ------------------------------------------------------------------------- */

describe('loading the same release again', () => {
    it('reports no insert and no update, and leaves every row and every id untouched', async () => {
        const built = writeRelease('v1', publishedSlice());

        const first = await runLoad(loadDeps(built));
        const before = await identities();
        const updatedBefore = await prisma.catalog_foods.aggregate({ _max: { updated_at: true } });

        const second = await runLoad(loadDeps(built));

        expect(second.counts.foodsInserted).toBe(0);
        expect(second.counts.foodsUpdated).toBe(0);
        expect(second.counts.foodsUnchanged).toBe(built.manifest.counts.foods);
        expect(second.counts.aliasesWritten).toBe(0);
        expect(second.counts.aliasesRemoved).toBe(0);
        expect(second.counts.portionsWritten).toBe(0);
        expect(second.counts.portionsRemoved).toBe(0);
        expect(second.counts.componentsWritten).toBe(0);
        expect(second.counts.componentsRemoved).toBe(0);
        expect(second.counts.validationRecordsWritten).toBe(0);
        expect(second.counts.foodsRetired).toBe(0);

        // Identity, not just counts: the same food rows and the same child rows,
        // which is what distinguishes reconciliation from delete-then-insert.
        expect(await identities()).toEqual(before);
        const updatedAfter = await prisma.catalog_foods.aggregate({ _max: { updated_at: true } });
        expect(updatedAfter._max.updated_at?.toISOString()).toBe(updatedBefore._max.updated_at?.toISOString());

        // The settled run is left exactly as it was and this invocation gets its
        // own row — a release is desired state, so the second load runs.
        const runs = await runRows();
        expect(runs).toHaveLength(2);
        expect(runs.map((run) => run.status)).toEqual(['succeeded', 'succeeded']);
        expect(second.runId).not.toBe(first.runId);
        expect((runs[0].counts as Record<string, number>).foodsInserted).toBe(built.manifest.counts.foods);
        expect((runs[1].counts as Record<string, number>).foodsUnchanged).toBe(built.manifest.counts.foods);
        expect((await getActiveReleaseLoad(prisma))?.runId).toBe(second.runId);
    });

    it('is a no-op through a dry run too, and opens no run row for it', async () => {
        const built = writeRelease('v1', publishedSlice());
        await runLoad(loadDeps(built));
        const before = await identities();

        const planned = await runLoad(loadDeps(built, { dryRun: true }));

        expect(planned.runId).toBeNull();
        expect(planned.activated).toBe(false);
        expect(planned.counts.foodsUnchanged).toBe(built.manifest.counts.foods);
        expect(planned.counts.foodsInserted).toBe(0);
        expect(planned.countChecks).toEqual([]);
        expect(await identities()).toEqual(before);
        expect((await tableCounts()).runs).toBe(1);
    });

    it('plans a first load without writing anything at all', async () => {
        const built = writeRelease('v1', publishedSlice());

        const planned = await runLoad(loadDeps(built, { dryRun: true }));

        expect(planned.runId).toBeNull();
        expect(planned.counts.foodsInserted).toBe(built.manifest.counts.foods);
        expect(planned.verification).toHaveLength(RELEASE_MEMBERS.length);
        expect(await tableCounts()).toEqual({
            foods: 0,
            aliases: 0,
            portions: 0,
            components: 0,
            validationRecords: 0,
            runs: 0,
        });
    });
});

/* ---------------------------------------------------------------------------
 * What a dry run reports
 *
 * `--dry-run` promises "the same reconciliation", and the usage block and the
 * runbook both say so, so the child rows are part of what it has to report: a
 * dry run that reported 9,422 foods and zero aliases would be describing a
 * load nobody is about to run.
 * ------------------------------------------------------------------------- */

/**
 * v2 as the upgrade block builds it, with one of the derived parent's
 * compositions dropped — and the parent RE-DERIVED from what is left, because a
 * release that changed a composition without changing the numbers it produces
 * is one the loader refuses as `release_component_inconsistent` and one the
 * exporter would never cut.
 *
 * The dropped line is the first the fixture states for that parent — 60 g of
 * `usda:9200109` (olive oil) — leaving 40 g of `usda:9200114` (lemon juice) at
 * yield factor 1. A single component at unit yield derives to that component's
 * own per-100 g values, whatever its quantity: 40 g in, 40 g out, so
 * `(40/100 × v) / 40 × 100 = v` for every nutrient. Hence the lemon-juice row's
 * values verbatim, and hence the `nutrition_version` bump beside them — the
 * parent's nutrition moved, and a stored nutrient change that left the counter
 * alone would make every recipe snapshot citing it read as current.
 */
const REDERIVED_FROM_LEMON_JUICE_ALONE: Readonly<Record<string, number>> = {
    calories: 22,
    protein_g: 0.35,
    carbs_g: 6.9,
    fat_g: 0.24,
    fiber_g: 0.3,
};

const upgradedSliceWithoutOneComposition = (): ReleaseContent => {
    const slice = upgradedSlice();
    const dropped = slice.components.find((component) => component.food_source_key === DERIVED_PARENT) as Row;

    return {
        ...slice,
        foods: slice.foods.map((food) =>
            food.source_key === DERIVED_PARENT
                ? { ...food, ...REDERIVED_FROM_LEMON_JUICE_ALONE, nutrition_version: 2 }
                : food,
        ),
        components: slice.components.filter((component) => component !== dropped),
    };
};

describe('a dry run reports the child rows it would write', () => {
    it('reports the release\'s own alias, portion, composition and validation totals against an empty target', async () => {
        const built = writeRelease('v1', publishedSlice());
        const expected = built.manifest.counts;

        const planned = await runLoad(loadDeps(built, { dryRun: true }));

        expect(planned.counts.foodsInserted).toBe(expected.foods);
        expect(planned.counts.aliasesWritten).toBe(expected.aliases);
        expect(planned.counts.portionsWritten).toBe(expected.portions);
        expect(planned.counts.componentsWritten).toBe(expected.components);
        expect(planned.counts.validationRecordsWritten).toBe(expected.validation_records);
        // Nothing is stored, so nothing can be removed — and a dry run never
        // defers, because no reference it reported could resolve later.
        expect(planned.counts.aliasesRemoved).toBe(0);
        expect(planned.counts.portionsRemoved).toBe(0);
        expect(planned.counts.componentsRemoved).toBe(0);
        expect(planned.counts.foodsDeferred).toBe(0);
        expect(planned.counts.foodsUpdated).toBe(0);
        expect(planned.counts.foodsUnchanged).toBe(0);

        expect(await tableCounts()).toEqual({
            foods: 0,
            aliases: 0,
            portions: 0,
            components: 0,
            validationRecords: 0,
            runs: 0,
        });
        expect(await prisma.catalog_generation_batches.count()).toBe(0);
    });

    it('reports the child rows an upgrade would remove, and changes nothing', async () => {
        const first = writeRelease('v1', publishedSlice());
        await runLoad(loadDeps(first));

        const before = await identities();
        const updatedBefore = await prisma.catalog_foods.aggregate({ _max: { updated_at: true } });
        const second = writeRelease('v2', upgradedSliceWithoutOneComposition());

        const planned = await runLoad(loadDeps(second, { dryRun: true }));

        // The survivor's alias set is rewritten, its default portion moves
        // between two existing rows and a third is added, and the derived
        // parent loses one composition.
        expect(planned.counts.aliasesWritten).toBe(1);
        expect(planned.counts.aliasesRemoved).toBe(1);
        expect(planned.counts.portionsWritten).toBe(3);
        expect(planned.counts.portionsRemoved).toBe(0);
        expect(planned.counts.componentsWritten).toBe(0);
        expect(planned.counts.componentsRemoved).toBe(1);
        expect(planned.counts.validationRecordsWritten).toBe(0);
        // The survivor and the derived parent; every other food is unchanged.
        expect(planned.counts.foodsUpdated).toBe(2);
        expect(planned.counts.foodsUnchanged).toBe(first.manifest.counts.foods - 3);
        expect(planned.counts.foodsInserted).toBe(0);
        // Named rather than counted, and not retired: a dry run reports the
        // retirement it would apply without applying it.
        expect(planned.retiredSourceKeys).toEqual([DROPPED_FOOD]);
        expect(planned.counts.foodsRetired).toBe(0);

        // And the target is byte-for-byte where it was: the same rows, the same
        // ids and the same `updated_at`.
        expect(await identities()).toEqual(before);
        const updatedAfter = await prisma.catalog_foods.aggregate({ _max: { updated_at: true } });
        expect(updatedAfter._max.updated_at?.toISOString()).toBe(updatedBefore._max.updated_at?.toISOString());
        expect((await foodBySourceKey(DROPPED_FOOD))?.publication_status).toBe('published');
        expect((await tableCounts()).runs).toBe(1);
    });
});

/* ---------------------------------------------------------------------------
 * (c) Failure after partial progress
 * ------------------------------------------------------------------------- */

/**
 * A release of `count` foods, synthesized from one published fixture food so the
 * load crosses the loader's 250-food checkpoint boundary and a resumed run has a
 * stored cursor to pick up from.
 *
 * Three columns move with the ordinal because three constraints apply to a
 * published food: `source_key` is unique, `usda_fdc_id` is unique, and
 * `(canonical_name, food_state)` is unique among published rows.
 */
const syntheticRelease = (release: string, count: number): BuiltRelease => {
    const slice = publishedSlice();
    const template = slice.foods.find((food) => food.source_key === SURVIVING_FOOD) as Row;
    const templateRecord = slice.validationRecords.find(
        (record) => record.food_source_key === SURVIVING_FOOD,
    ) as Row;

    const foods: Row[] = [];
    const aliases: Row[] = [];
    const portions: Row[] = [];
    const validationRecords: Row[] = [];

    for (let ordinal = 0; ordinal < count; ordinal += 1) {
        const padded = String(ordinal).padStart(5, '0');
        const sourceKey = `usda:93${padded}`;
        foods.push({
            ...template,
            source_key: sourceKey,
            canonical_name: `synthetic food ${padded}`,
            display_name: `Synthetic food ${padded}`,
            usda_fdc_id: 9300000 + ordinal,
            search_text: `synthetic food ${padded}`,
            generation_batch_key: null,
        });
        aliases.push({ food_source_key: sourceKey, alias: `synthetic ${padded}` });
        portions.push({
            food_source_key: sourceKey,
            description: '100 g',
            amount: 100,
            unit: 'g',
            gram_weight: 100,
            is_default: true,
            source: 'usda_food_portion',
        });
        validationRecords.push({
            ...templateRecord,
            food_source_key: sourceKey,
            nutrition_method: SYNTHETIC_METHOD,
        });
    }

    return writeRelease(release, { foods, aliases, portions, components: [], validationRecords });
};

/* ---------------------------------------------------------------------------
 * A forward reference that outlives a checkpoint
 * ------------------------------------------------------------------------- */

/** The derived parent of the forward-reference release; sorts after `ai:beverage:…`. */
const FORWARD_PARENT = 'ai:condiment_sauce:synthetic dressing:prepared';

const FORWARD_SETTLED_BEFORE_PARENT = 100;
const FORWARD_TARGETS = 2;
const FORWARD_FOOD_COUNT = 260;

const forwardSettledKey = (ordinal: number): string =>
    `ai:beverage:synthetic drink ${String(ordinal).padStart(5, '0')}:prepared`;

const forwardTargetKey = (ordinal: number): string => `usda:94${String(ordinal).padStart(5, '0')}`;

/**
 * A release of 260 foods — larger than the loader's 250-food chunk, so a real
 * cursor checkpoint is written mid-load — whose derived parent sorts BEFORE the
 * two foods its composition names.
 *
 * The three positions are the point of it. `ai:beverage:…` sorts before
 * `ai:condiment_sauce:…` sorts before `usda:…`, so the first 100 foods settle
 * normally, the parent at index 100 is deferred (its targets are the last two
 * foods in the release, inside the SECOND chunk), and the checkpoint at 250
 * foods is therefore taken while a food is outstanding — exactly the state the
 * cursor watermark exists for.
 */
const forwardReferenceRelease = (release: string): BuiltRelease => {
    const slice = publishedSlice();
    const template = slice.foods.find((food) => food.source_key === SURVIVING_FOOD) as Row;
    const templateRecord = slice.validationRecords.find(
        (record) => record.food_source_key === SURVIVING_FOOD,
    ) as Row;

    const foods: Row[] = [];
    const aliases: Row[] = [];
    const portions: Row[] = [];
    const validationRecords: Row[] = [];

    const add = (sourceKey: string, ordinal: number, overrides: Row): void => {
        const padded = String(ordinal).padStart(5, '0');
        foods.push({
            ...template,
            source_key: sourceKey,
            canonical_name: `synthetic ${sourceKey}`,
            display_name: `Synthetic ${padded}`,
            search_text: `synthetic ${padded}`,
            generation_batch_key: null,
            ...overrides,
        });
        aliases.push({ food_source_key: sourceKey, alias: `synthetic ${sourceKey}` });
        portions.push({
            food_source_key: sourceKey,
            description: '100 g',
            amount: 100,
            unit: 'g',
            gram_weight: 100,
            is_default: true,
            source: 'usda_food_portion',
        });
        validationRecords.push({
            ...templateRecord,
            food_source_key: sourceKey,
            nutrition_method: SYNTHETIC_METHOD,
        });
    };

    for (let ordinal = 0; ordinal < FORWARD_SETTLED_BEFORE_PARENT; ordinal += 1) {
        add(forwardSettledKey(ordinal), ordinal, {
            identity_source: 'ai_generated',
            usda_fdc_id: null,
            usda_data_type: null,
            usda_description: null,
        });
    }

    add(FORWARD_PARENT, FORWARD_SETTLED_BEFORE_PARENT, {
        identity_source: 'ai_generated',
        nutrition_provenance: 'ingredient_derived',
        usda_fdc_id: null,
        usda_data_type: null,
        usda_description: null,
    });

    const targetCount = FORWARD_FOOD_COUNT - FORWARD_SETTLED_BEFORE_PARENT - 1;
    for (let ordinal = 0; ordinal < targetCount; ordinal += 1) {
        add(forwardTargetKey(ordinal), ordinal, { usda_fdc_id: 9400000 + ordinal });
    }

    // The last two foods in the release, so the parent cannot be applied until
    // the second chunk has run.
    const components: Row[] = [];
    for (let offset = 0; offset < FORWARD_TARGETS; offset += 1) {
        components.push({
            food_source_key: FORWARD_PARENT,
            component_food_source_key: forwardTargetKey(targetCount - 1 - offset),
            quantity_grams: 40 + offset,
            yield_factor: 1,
            component_nutrition_version: 1,
            sort_order: offset,
        });
    }

    return writeRelease(release, { foods, aliases, portions, components, validationRecords });
};

/** The two foods `FORWARD_PARENT` derives from, in `sort_order`. */
const forwardTargetKeys = (): readonly string[] => {
    const targetCount = FORWARD_FOOD_COUNT - FORWARD_SETTLED_BEFORE_PARENT - 1;
    return [forwardTargetKey(targetCount - 1), forwardTargetKey(targetCount - 2)];
};

describe('a load that fails after partial progress', () => {
    it('records the run as failed, leaves the pointer where it was, and keeps what it settled coherent', async () => {
        const built = writeRelease('v1', publishedSlice());
        const injected = new Error('database connection lost mid-load');
        const settled: string[] = [];

        await expect(
            runLoad(
                loadDeps(built, {
                    onFoodSettled: ({ sourceKey, index }) => {
                        settled.push(sourceKey);
                        if (index === 3) {
                            throw injected;
                        }
                    },
                }),
            ),
        ).rejects.toBe(injected);

        // Two of the first four foods the release states are the derived
        // parents, and a deferred food is not settled — so the seam saw the two
        // that were, and the throw landed on the food at index 3.
        expect(settled).toHaveLength(2);

        const runs = await runRows();
        expect(runs).toHaveLength(1);
        expect(runs[0].status).toBe('failed');
        // A failed load never becomes the newest succeeded release_load row, so
        // there is no pointer to roll back — it simply never moved.
        expect(await getActiveReleaseLoad(prisma)).toBeNull();

        // What it did settle is internally consistent: each food carries the
        // children and the validation record the release states for it.
        const slice = publishedSlice();
        for (const sourceKey of settled) {
            const stored = await foodBySourceKey(sourceKey);
            expect(stored).not.toBeNull();
            expect(stored?.catalog_validation_records).not.toBeNull();
            expect(stored?.catalog_food_aliases.map((alias) => alias.alias).sort()).toEqual(
                slice.aliases
                    .filter((alias) => alias.food_source_key === sourceKey)
                    .map((alias) => String(alias.alias))
                    .sort(),
            );
            expect(stored?.catalog_food_portions).toHaveLength(
                slice.portions.filter((portion) => portion.food_source_key === sourceKey).length,
            );
        }

        // THE LOAD-BEARING ASSERTION. The first food the release states is a
        // derived parent whose composition points forward, so the failure came
        // while it was still queued — and nothing at all was written for it. It
        // is ABSENT rather than published without its composition, which is what
        // makes the rerun below a repair rather than a second chance.
        expect(settled[0]).not.toBe(DERIVED_PARENT);
        expect(await foodBySourceKey(DERIVED_PARENT)).toBeNull();
        expect(await foodBySourceKey('ai:prepared_meal:herbed yogurt dip:prepared')).toBeNull();

        // The rerun continues the failed run, reconciles the rest and activates.
        const rerun = await runLoad(loadDeps(built));

        expect(rerun.resumed).toBe(true);
        expect(rerun.runId).toBe(runs[0].id);
        expect(rerun.activated).toBe(true);
        expect(
            rerun.counts.foodsInserted +
                rerun.counts.foodsUpdated +
                rerun.counts.foodsUnchanged +
                rerun.counts.foodsSkippedByCursor,
        ).toBe(built.manifest.counts.foods);
        // Nothing was skipped: the failure came before the first checkpoint, and
        // the watermark had frozen at the very first food in any case, so every
        // food was reconciled again.
        expect(rerun.counts.foodsSkippedByCursor).toBe(0);
        // The two foods the interrupted attempt settled are unchanged; every
        // other food, the two deferred parents included, is a fresh insert.
        expect(rerun.counts.foodsUnchanged).toBe(settled.length);
        expect(rerun.counts.foodsInserted).toBe(built.manifest.counts.foods - settled.length);
        expect(rerun.counts.foodsUpdated).toBe(0);
        expect(rerun.counts.foodsDeferred).toBe(2);
        expect((await foodBySourceKey(DERIVED_PARENT))?.catalog_food_components).toHaveLength(2);
        expect(rerun.countChecks.every((check) => check.ok)).toBe(true);
        expect((await getActiveReleaseLoad(prisma))?.releaseId).toBe('v1');
        expect((await tableCounts()).foods).toBe(built.manifest.counts.foods);
    });

    it('leaves an already-active release active when the next one fails part-way', async () => {
        // The operational shape of the invariant, and the one the null case
        // above cannot make: an environment already serving v1 attempts v2, v2
        // fails after writing some of itself, and `GET /api/catalog/status`
        // must still report v1. A pointer that moved would name a release only
        // half applied.
        const first = writeRelease('v1', publishedSlice());
        const settled = await runLoad(loadDeps(first));
        const activeBefore = await getActiveReleaseLoad(prisma);
        expect(activeBefore?.releaseId).toBe('v1');
        expect(activeBefore?.runId).toBe(settled.runId);

        const second = writeRelease('v2', upgradedSlice());
        const injected = new Error('interrupted part-way through v2');

        await expect(
            runLoad(
                loadDeps(second, {
                    onFoodSettled: ({ index }) => {
                        if (index === 10) {
                            throw injected;
                        }
                    },
                }),
            ),
        ).rejects.toBe(injected);

        const runs = await runRows();
        expect(runs).toHaveLength(2);
        expect(runs[1].status).toBe('failed');
        expect(runs[1].manifest_version).toBe('v2');

        // Unmoved: still v1, still the run that actually completed.
        const activeAfter = await getActiveReleaseLoad(prisma);
        expect(activeAfter?.releaseId).toBe('v1');
        expect(activeAfter?.runId).toBe(settled.runId);

        // And the documented repair — rerunning the same release — carries the
        // pointer over exactly once it succeeds.
        const repaired = await runLoad(loadDeps(second));

        expect(repaired.activated).toBe(true);
        expect(repaired.countChecks.every((check) => check.ok)).toBe(true);
        expect((await getActiveReleaseLoad(prisma))?.releaseId).toBe('v2');
    });

    it('resumes from the stored cursor rather than starting over', async () => {
        const built = syntheticRelease('v1', 260);
        const injected = new Error('interrupted after the first checkpoint');

        await expect(
            runLoad(
                loadDeps(built, {
                    onFoodSettled: ({ index }) => {
                        if (index === 254) {
                            throw injected;
                        }
                    },
                }),
            ),
        ).rejects.toBe(injected);

        const failed = (await runRows())[0];
        expect(failed.status).toBe('failed');
        // The cursor was written at the 250-food checkpoint, so it names the
        // 250th food and not the 255th the run reached.
        expect((failed.cursor as Record<string, unknown>).lastSourceKey).toBe('usda:9300249');
        expect((failed.cursor as Record<string, unknown>).verifiedFiles).toEqual(RELEASE_MEMBERS);
        expect(await prisma.catalog_foods.count()).toBe(255);

        const rerun = await runLoad(loadDeps(built));

        expect(rerun.resumed).toBe(true);
        expect(rerun.counts.foodsSkippedByCursor).toBe(250);
        // The five foods the failed attempt applied after its checkpoint are
        // reconciled again and are unchanged; the five it never reached are new.
        expect(rerun.counts.foodsUnchanged).toBe(5);
        expect(rerun.counts.foodsInserted).toBe(5);
        expect(rerun.activated).toBe(true);
        expect(await prisma.catalog_foods.count()).toBe(260);
        expect((await getActiveReleaseLoad(prisma))?.runId).toBe(failed.id);
    });

    it('ignores a cursor that does not describe the release on disk', async () => {
        const built = syntheticRelease('v1', 260);
        const injected = new Error('interrupted after the first checkpoint');

        await expect(
            runLoad(
                loadDeps(built, {
                    onFoodSettled: ({ index }) => {
                        if (index === 254) {
                            throw injected;
                        }
                    },
                }),
            ),
        ).rejects.toBe(injected);

        // The same release id, a different artefact: the stored cursor names a
        // position in a file that no longer exists, so resuming into it would
        // skip foods the release states.
        const replacement = syntheticRelease('v1', 12);
        const rerun = await runLoad(loadDeps(replacement));

        expect(rerun.resumed).toBe(true);
        expect(rerun.counts.foodsSkippedByCursor).toBe(0);
        expect(rerun.counts.foodsUnchanged).toBe(12);
        expect(rerun.counts.foodsRetired).toBe(255 - 12);
        expect(rerun.activated).toBe(true);
    });

    it('freezes the cursor at the last settled food while one is deferred, and repairs it on the rerun', async () => {
        const built = forwardReferenceRelease('v1');
        const injected = new Error('interrupted after the first checkpoint');

        await expect(
            runLoad(
                loadDeps(built, {
                    onFoodSettled: ({ index }) => {
                        if (index === 254) {
                            throw injected;
                        }
                    },
                }),
            ),
        ).rejects.toBe(injected);

        const failed = (await runRows())[0];
        expect(failed.status).toBe('failed');

        // THE LOAD-BEARING ASSERTION: the deferred parent is ABSENT. Not a
        // published row with no composition — no row, no alias, no portion and
        // no validation record, because the whole food waits together.
        expect(await foodBySourceKey(FORWARD_PARENT)).toBeNull();
        expect(
            await prisma.catalog_food_aliases.count({
                where: { catalog_foods: { source_key: FORWARD_PARENT } },
            }),
        ).toBe(0);
        // Every other food up to the interruption settled: 100 before the
        // parent and 154 after it.
        expect(await prisma.catalog_foods.count()).toBe(254);

        // The checkpoint at 250 foods was written while the parent was
        // outstanding, so the watermark names the last SETTLED food before it —
        // the 100th — and not the 250th the chunk reached.
        expect((failed.cursor as Record<string, unknown>).lastSourceKey).toBe(
            forwardSettledKey(FORWARD_SETTLED_BEFORE_PARENT - 1),
        );
        expect((failed.cursor as Record<string, unknown>).verifiedFiles).toEqual(RELEASE_MEMBERS);

        const rerun = await runLoad(loadDeps(built));

        expect(rerun.resumed).toBe(true);
        expect(rerun.runId).toBe(failed.id);
        expect(rerun.activated).toBe(true);
        // Exactly the foods the frozen watermark covers are skipped; the parent
        // and everything after it is re-read.
        expect(rerun.counts.foodsSkippedByCursor).toBe(FORWARD_SETTLED_BEFORE_PARENT);
        expect(rerun.counts.foodsDeferred).toBe(1);
        expect(rerun.counts.foodsUnchanged).toBe(154);
        expect(rerun.counts.foodsInserted).toBe(6);
        expect(rerun.counts.foodsUpdated).toBe(0);
        expect(rerun.countChecks.every((check) => check.ok)).toBe(true);

        const parent = await foodBySourceKey(FORWARD_PARENT);
        expect(parent?.catalog_food_components).toHaveLength(FORWARD_TARGETS);
        expect(parent?.catalog_validation_records).not.toBeNull();
        for (const [offset, targetKey] of forwardTargetKeys().entries()) {
            const target = await foodBySourceKey(targetKey);
            const stored = parent?.catalog_food_components.find(
                (component) => component.component_catalog_foods.source_key === targetKey,
            );
            expect(stored?.component_catalog_food_id).toBe(target?.id);
            expect(stored?.quantity_grams).toBe(40 + offset);
            expect(stored?.sort_order).toBe(offset);
        }
        expect(await prisma.catalog_foods.count()).toBe(FORWARD_FOOD_COUNT);
        expect((await getActiveReleaseLoad(prisma))?.runId).toBe(failed.id);
    });

    it('resumes to the same outcome when the failure lands in the deferred pass', async () => {
        const built = forwardReferenceRelease('v1');
        const injected = new Error('interrupted while the deferred food was settling');

        await expect(
            runLoad(
                loadDeps(built, {
                    onFoodSettled: ({ sourceKey }) => {
                        if (sourceKey === FORWARD_PARENT) {
                            throw injected;
                        }
                    },
                }),
            ),
        ).rejects.toBe(injected);

        const failed = (await runRows())[0];
        expect(failed.status).toBe('failed');
        expect(await getActiveReleaseLoad(prisma)).toBeNull();
        // The deferred food committed WHOLE before the seam was told about it,
        // so the parent is either absent or complete — never published without
        // its composition.
        expect((await foodBySourceKey(FORWARD_PARENT))?.catalog_food_components).toHaveLength(FORWARD_TARGETS);
        // The final checkpoint never ran, so the watermark is still the frozen
        // one: the run resumes from before the parent and re-reconciles it.
        expect((failed.cursor as Record<string, unknown>).lastSourceKey).toBe(
            forwardSettledKey(FORWARD_SETTLED_BEFORE_PARENT - 1),
        );

        const rerun = await runLoad(loadDeps(built));

        expect(rerun.resumed).toBe(true);
        expect(rerun.runId).toBe(failed.id);
        expect(rerun.activated).toBe(true);
        expect(rerun.counts.foodsSkippedByCursor).toBe(FORWARD_SETTLED_BEFORE_PARENT);
        // Its targets are stored now, so there is nothing left to defer and
        // every re-read food is a no-op.
        expect(rerun.counts.foodsDeferred).toBe(0);
        expect(rerun.counts.foodsUnchanged).toBe(FORWARD_FOOD_COUNT - FORWARD_SETTLED_BEFORE_PARENT);
        expect(rerun.counts.foodsInserted).toBe(0);
        expect(rerun.counts.foodsUpdated).toBe(0);
        expect(rerun.countChecks.every((check) => check.ok)).toBe(true);
        expect((await foodBySourceKey(FORWARD_PARENT))?.catalog_food_components).toHaveLength(FORWARD_TARGETS);
        expect(await prisma.catalog_foods.count()).toBe(FORWARD_FOOD_COUNT);
    });
});

/* ---------------------------------------------------------------------------
 * (c2) Failure PART WAY THROUGH one food's transaction
 *
 * The block above interrupts a load BETWEEN foods, where each food either
 * committed whole or was never begun. This one interrupts a load INSIDE one
 * food's transaction, after some of that food's child rows have been written,
 * because that is the only state in which the run's counters and the database
 * can disagree: PostgreSQL rolls the writes back, and an in-memory increment
 * taken before the commit would survive that rollback and be persisted into the
 * failed run row that AAP §0.7.1 requires to be truthful repair evidence.
 *
 * THE FAILURE COMES FROM THE RELEASE'S OWN CONTENT, not from a seam and not
 * from a mocked internal: the last food is given a SECOND default portion, and
 * `unique_default_catalog_food_portion` — the partial unique index over
 * `catalog_food_id WHERE is_default` — refuses the second insert. Every release
 * check passes it (portions are unique per description, and one file cannot
 * state a cross-row database invariant), so the refusal lands where it is
 * wanted: after the food row, after its aliases and after its first portion.
 * ------------------------------------------------------------------------- */

/** The last published food in `source_key` order, so every other food settles before it. */
const LAST_FOOD_IN_RELEASE = 'usda:9200123';

/** The extra portion that collides with that food's existing default. */
const SECOND_DEFAULT_PORTION = '10 olives';

const sliceWithTwoDefaultPortionsOnTheLastFood = (): ReleaseContent => {
    const slice = publishedSlice();
    const existing = slice.portions.find(
        (portion) => portion.food_source_key === LAST_FOOD_IN_RELEASE && portion.is_default === true,
    ) as Row;

    return {
        ...slice,
        portions: [...slice.portions, { ...existing, description: SECOND_DEFAULT_PORTION, is_default: true }],
    };
};

describe('a load that fails part way through one food\'s transaction', () => {
    it('records no count for the child rows the rollback removed', async () => {
        const slice = sliceWithTwoDefaultPortionsOnTheLastFood();
        const sourceKeys = slice.foods.map((food) => String(food.source_key)).sort();
        // Stated as an assertion because the arithmetic below depends on it: the
        // colliding food is the LAST one the release states, so the failure
        // comes after every other food has settled.
        expect(sourceKeys[sourceKeys.length - 1]).toBe(LAST_FOOD_IN_RELEASE);
        expect(slice.portions.filter((portion) => portion.food_source_key === LAST_FOOD_IN_RELEASE)).toHaveLength(2);

        const built = writeRelease('v1', slice);

        const failure = await runLoad(loadDeps(built)).then(
            () => null,
            (error: unknown) => error,
        );

        // PostgreSQL's own refusal, mid-transaction: the second default portion
        // violates the partial unique index.
        expect((failure as { code?: unknown } | null)?.code).toBe('P2002');

        // The whole food is gone — the row the transaction created, its aliases
        // and both of its portions — because the transaction rolled back.
        expect(await foodBySourceKey(LAST_FOOD_IN_RELEASE)).toBeNull();
        expect(
            await prisma.catalog_food_portions.count({ where: { description: SECOND_DEFAULT_PORTION } }),
        ).toBe(0);

        const runs = await runRows();
        expect(runs).toHaveLength(1);
        expect(runs[0].status).toBe('failed');
        expect(await getActiveReleaseLoad(prisma)).toBeNull();

        // THE ASSERTION THE FINDING IS ABOUT. The target started empty, so every
        // row it now holds is one this run inserted — which makes the failed
        // run's counts checkable against the database itself rather than against
        // a restated expectation. Before the per-transaction accounting, the
        // rolled-back food's alias and portion writes were already in
        // `state.counts` and were persisted here, so `aliasesWritten` and
        // `portionsWritten` each exceeded the rows that exist.
        // There was something to over-count. The release states two aliases and
        // two portions for the food whose transaction rolled back, and
        // `reconcileAliases` plus the first portion insert both ran before the
        // collision — so a run-wide counter mutated inside the transaction
        // would have kept three writes the database does not hold.
        expect(slice.aliases.filter((alias) => alias.food_source_key === LAST_FOOD_IN_RELEASE)).toHaveLength(2);

        const stored = await tableCounts();
        // Facts about the release rather than about rows, counted outside every
        // transaction and therefore unaffected by the rollback: one per distinct
        // batch key this database does not hold.
        const unresolvedBatches = new Set(
            slice.foods.map((food) => food.generation_batch_key).filter((key) => key !== null && key !== undefined),
        ).size;

        expect(runs[0].counts).toEqual({
            foodsInserted: stored.foods,
            aliasesWritten: stored.aliases,
            portionsWritten: stored.portions,
            validationRecordsWritten: stored.validationRecords,
            // The two derived parents were deferred and the deferred pass never
            // ran, so nothing was written for them: a truthful count of work
            // attempted, and the reason `componentsWritten` is absent entirely.
            foodsDeferred: 2,
            generationBatchUnresolved: unresolvedBatches,
        });
        expect(stored.components).toBe(0);
        expect(stored.foods).toBe(built.manifest.counts.foods - 3);

        // And the repair: the same release with the colliding portion removed
        // reconciles the food the rollback left absent and activates.
        const repaired = await runLoad(loadDeps(writeRelease('v1', publishedSlice())));

        expect(repaired.activated).toBe(true);
        expect(repaired.countChecks.every((check) => check.ok)).toBe(true);
        expect((await foodBySourceKey(LAST_FOOD_IN_RELEASE))?.catalog_food_portions).toHaveLength(1);
    });
});

/* ---------------------------------------------------------------------------
 * (d) The upgrade
 * ------------------------------------------------------------------------- */

/** v2: one published food dropped, and one surviving food's children rewritten. */
const upgradedSlice = (): ReleaseContent => {
    const slice = publishedSlice();

    const foods = slice.foods
        .filter((food) => food.source_key !== DROPPED_FOOD)
        .map((food) =>
            food.source_key === SURVIVING_FOOD
                ? { ...food, calories: 125, nutrition_version: 2, metadata_version: 2 }
                : food,
        );

    const aliases = slice.aliases
        .filter((alias) => alias.food_source_key !== DROPPED_FOOD)
        .filter((alias) => !(alias.food_source_key === SURVIVING_FOOD && alias.alias === DROPPED_ALIAS))
        .concat([{ food_source_key: SURVIVING_FOOD, alias: ADDED_ALIAS }]);

    const portions = slice.portions
        .filter((portion) => portion.food_source_key !== DROPPED_FOOD)
        .map((portion) => {
            if (portion.food_source_key !== SURVIVING_FOOD) {
                return portion;
            }
            // The default MOVES between two existing portions, which is the case
            // the one-default partial unique index makes ordering-sensitive.
            if (portion.description === '100 g') {
                return { ...portion, is_default: false };
            }
            return { ...portion, is_default: true, gram_weight: 150 };
        })
        .concat([
            {
                food_source_key: SURVIVING_FOOD,
                description: '1 fillet',
                amount: 1,
                unit: 'fillet',
                gram_weight: 174,
                is_default: false,
                source: 'usda_food_portion',
            },
        ]);

    return {
        foods,
        aliases,
        portions,
        components: slice.components.filter(
            (component) =>
                component.food_source_key !== DROPPED_FOOD && component.component_food_source_key !== DROPPED_FOOD,
        ),
        validationRecords: slice.validationRecords.filter((record) => record.food_source_key !== DROPPED_FOOD),
    };
};

describe('upgrading to the next release', () => {
    it('retires the food v2 drops, keeps it referenceable, and replaces a survivor\'s children wholesale', async () => {
        const first = writeRelease('v1', publishedSlice());
        await runLoad(loadDeps(first));

        const dropped = await foodBySourceKey(DROPPED_FOOD);
        expect(dropped).not.toBeNull();
        const droppedId = dropped?.id as string;
        const beforeIds = await identities();

        // Both reference classes a retirement must survive: a recipe ingredient
        // (RESTRICT) and a diary entry (SET NULL).
        const version = await makeRecipeVersion({ slug: 'load-retirement', catalogFoodId: droppedId });
        const user = await makeUser();
        const meal = await prisma.meals.create({
            data: { user_id: user.id, date: new Date('2026-09-10T00:00:00.000Z'), name: 'Lunch' },
        });
        const entry = await prisma.meal_entries.create({
            data: {
                meal_id: meal.id,
                user_id: user.id,
                date: new Date('2026-09-10T00:00:00.000Z'),
                name: 'Cremini mushrooms',
                servings: 1,
                calories: 22,
                protein_g: 3,
                carbs_g: 4,
                fat_g: 0,
                input_method: 'search',
                nutrition_provenance: 'source_backed',
                catalog_food_id: droppedId,
            },
        });

        // Present in search and in the dislike suggestions while published.
        const searchedBefore = await searchPublishedFoods('mushrooms', 1, 25);
        expect(searchedBefore.items.map((item) => item.id)).toContain(droppedId);
        const suggestedBefore = await getSuggestions('dislike', 25);
        expect(suggestedBefore.items.map((item) => item.id)).toContain(droppedId);

        const second = writeRelease('v2', upgradedSlice());
        const summary = await runLoad(loadDeps(second));

        expect(summary.counts.foodsRetired).toBe(1);
        expect(summary.retiredSourceKeys).toEqual([DROPPED_FOOD]);
        expect(summary.counts.foodsUpdated).toBe(1);
        // Every other food v2 carries is byte-identical to what v1 loaded.
        expect(summary.counts.foodsUnchanged).toBe(second.manifest.counts.foods - 1);
        expect(summary.countChecks.every((check) => check.ok)).toBe(true);
        expect(summary.activated).toBe(true);

        // RETIRED, NOT DELETED: the row, its id and both references survive.
        const retired = await foodBySourceKey(DROPPED_FOOD);
        expect(retired?.id).toBe(droppedId);
        expect(retired?.publication_status).toBe('retired');
        expect(await prisma.catalog_foods.count()).toBe(publishedSlice().foods.length);

        const ingredient = await prisma.recipe_ingredients.findFirst({
            where: { recipe_version_id: version.id },
            include: { catalog_foods: true },
        });
        expect(ingredient?.catalog_foods.id).toBe(droppedId);
        expect(ingredient?.catalog_foods.publication_status).toBe('retired');

        const reloadedEntry = await prisma.meal_entries.findUnique({ where: { id: entry.id } });
        expect(reloadedEntry?.catalog_food_id).toBe(droppedId);

        // And it is gone from both published reads, while its sibling remains.
        const searchedAfter = await searchPublishedFoods('mushrooms', 1, 25);
        expect(searchedAfter.items.map((item) => item.id)).not.toContain(droppedId);
        expect(searchedAfter.items.length).toBeGreaterThan(0);
        const suggestedAfter = await getSuggestions('dislike', 25);
        expect(suggestedAfter.items.map((item) => item.id)).not.toContain(droppedId);
        expect(suggestedAfter.items.length).toBeGreaterThan(0);

        // The survivor: scalars updated, children reconciled rather than
        // rewritten — the alias and portion rows v2 keeps hold their v1 ids.
        const survivor = await foodBySourceKey(SURVIVING_FOOD);
        expect(survivor?.calories).toBe(125);
        expect(survivor?.nutrition_version).toBe(2);
        expect(survivor?.catalog_food_aliases.map((alias) => alias.alias).sort()).toEqual(
            [ADDED_ALIAS, KEPT_ALIAS].sort(),
        );

        const keptAliasId = beforeIds.aliases.find((entryText) =>
            entryText.startsWith(`${SURVIVING_FOOD}/${KEPT_ALIAS}=`),
        );
        expect((await identities()).aliases).toContain(keptAliasId);
        expect(
            beforeIds.aliases.some((entryText) => entryText.startsWith(`${SURVIVING_FOOD}/${DROPPED_ALIAS}=`)),
        ).toBe(true);
        expect(
            (await identities()).aliases.some((entryText) =>
                entryText.startsWith(`${SURVIVING_FOOD}/${DROPPED_ALIAS}=`),
            ),
        ).toBe(false);

        const gramPortion = survivor?.catalog_food_portions.find((portion) => portion.description === '100 g');
        const cupPortion = survivor?.catalog_food_portions.find((portion) => portion.description === '1 cup, diced');
        expect(gramPortion?.is_default).toBe(false);
        expect(cupPortion?.is_default).toBe(true);
        expect(cupPortion?.gram_weight).toBe(150);
        expect(survivor?.catalog_food_portions.map((portion) => portion.description).sort()).toEqual([
            '1 cup, diced',
            '1 fillet',
            '100 g',
        ]);
        expect((await identities()).portions).toContain(
            beforeIds.portions.find((entryText) => entryText.startsWith(`${SURVIVING_FOOD}/100 g=`)),
        );

        // Counted here rather than read off the summary: what v2's manifest
        // states has to be true of the database, independently of the loader
        // having compared it.
        expect(await prisma.catalog_foods.count({ where: { publication_status: 'published' } })).toBe(
            second.manifest.counts.published_foods,
        );
        expect(
            await prisma.catalog_food_aliases.count({
                where: { catalog_foods: { publication_status: 'published' } },
            }),
        ).toBe(second.manifest.counts.aliases);
        expect(
            await prisma.catalog_food_portions.count({
                where: { catalog_foods: { publication_status: 'published' } },
            }),
        ).toBe(second.manifest.counts.portions);
        expect(
            await prisma.catalog_validation_records.count({
                where: { catalog_foods: { publication_status: 'published' } },
            }),
        ).toBe(second.manifest.counts.validation_records);

        expect((await getActiveReleaseLoad(prisma))?.releaseId).toBe('v2');
    });

    it('publishes a retired food again when a later release carries it', async () => {
        const first = writeRelease('v1', publishedSlice());
        await runLoad(loadDeps(first));
        const second = writeRelease('v2', upgradedSlice());
        await runLoad(loadDeps(second));
        expect((await foodBySourceKey(DROPPED_FOOD))?.publication_status).toBe('retired');

        // Reconciliation is symmetric: the release states each food's
        // publication status, so loading v1 again restores what v2 retired.
        const back = await runLoad(loadDeps(first));

        expect(back.counts.foodsRestored).toBe(1);
        expect(back.counts.foodsRetired).toBe(0);
        expect((await foodBySourceKey(DROPPED_FOOD))?.publication_status).toBe('published');
        expect(back.countChecks.every((check) => check.ok)).toBe(true);
        expect((await getActiveReleaseLoad(prisma))?.releaseId).toBe('v1');
    });
});

/* ---------------------------------------------------------------------------
 * A composition that can never resolve
 * ------------------------------------------------------------------------- */

describe('a composition the release cannot resolve', () => {
    it('refuses a release that is not closed over its own references, before it opens a run row', async () => {
        const slice = publishedSlice();
        const orphanedTarget = String(slice.components[0].component_food_source_key);

        // The component food is removed from the release while the composition
        // that points at it stays, and this database does not hold it either.
        const broken: ReleaseContent = {
            foods: slice.foods.filter((food) => food.source_key !== orphanedTarget),
            aliases: slice.aliases.filter((alias) => alias.food_source_key !== orphanedTarget),
            portions: slice.portions.filter((portion) => portion.food_source_key !== orphanedTarget),
            components: slice.components,
            validationRecords: slice.validationRecords.filter(
                (record) => record.food_source_key !== orphanedTarget,
            ),
        };
        const built = writeRelease('v1', broken);

        const failure = await runLoad(loadDeps(built)).then(
            () => null,
            (error: unknown) => error,
        );

        // WHERE THIS REFUSAL MOVED TO, AND WHY IT IS A DIFFERENT CODE NOW. This
        // used to reach the apply pass as `component_reference_unresolved`,
        // which is the refusal for a composition the LOAD could not satisfy —
        // after a run row had been opened and closed 'failed'. The same bytes
        // are now refused by verification as `release_components_not_closed`: a
        // published composition naming a food `foods.jsonl` does not publish
        // makes the release unverifiable rather than unloadable, because those
        // bytes state no nutrition or version for that component, so the
        // parent's totals and pins can be compared with nothing. The earlier
        // refusal is also strictly cheaper — no run row exists at all —
        // and `component_reference_unresolved` keeps naming its own defect,
        // which the cycle below is.
        expect(failure).toBeInstanceOf(CatalogLoadError);
        expect((failure as CatalogLoadError).code).toBe('release_components_not_closed');
        expect((failure as CatalogLoadError).context.componentSourceKey).toBe(orphanedTarget);
        expect((failure as CatalogLoadError).context.sourceKey).toBe(String(slice.components[0].food_source_key));

        expect(await foodBySourceKey(String(slice.components[0].food_source_key))).toBeNull();
        expect(await runRows()).toEqual([]);
        expect(await getActiveReleaseLoad(prisma)).toBeNull();
    });

    it('refuses two foods that derive from each other, after the fixpoint sweep gives up', async () => {
        const slice = publishedSlice();
        const template = slice.foods.find((food) => food.source_key === SURVIVING_FOOD) as Row;
        const templateRecord = slice.validationRecords.find(
            (record) => record.food_source_key === SURVIVING_FOOD,
        ) as Row;

        const first = 'ai:prepared_meal:cycle first:prepared';
        const second = 'ai:prepared_meal:cycle second:prepared';
        const derived = (sourceKey: string): Row => ({
            ...template,
            source_key: sourceKey,
            canonical_name: `cycle ${sourceKey}`,
            display_name: `Cycle ${sourceKey}`,
            identity_source: 'ai_generated',
            nutrition_provenance: 'ingredient_derived',
            usda_fdc_id: null,
            usda_data_type: null,
            usda_description: null,
            generation_batch_key: null,
            search_text: `cycle ${sourceKey}`,
        });
        const composition = (parent: string, component: string): Row => ({
            food_source_key: parent,
            component_food_source_key: component,
            quantity_grams: 50,
            yield_factor: 1,
            component_nutrition_version: 1,
            sort_order: 0,
        });

        // Each food's composition names the other, so no ordering can ever
        // resolve either one — which is exactly what a fixpoint detects.
        const built = writeRelease('v1', {
            foods: [derived(first), derived(second)],
            aliases: [],
            portions: [],
            components: [composition(first, second), composition(second, first)],
            validationRecords: [
                { ...templateRecord, food_source_key: first },
                { ...templateRecord, food_source_key: second },
            ],
        });

        const failure = await runLoad(loadDeps(built)).then(
            () => null,
            (error: unknown) => error,
        );

        expect(failure).toBeInstanceOf(CatalogLoadError);
        const refusal = failure as CatalogLoadError;
        expect(refusal.code).toBe('component_reference_unresolved');
        expect([first, second]).toContain(refusal.context.sourceKey);
        expect([first, second]).toContain(refusal.context.componentSourceKey);
        expect(refusal.context.sourceKey).not.toBe(refusal.context.componentSourceKey);

        // Neither food was written: a deferred food is written whole or not at
        // all, so a cycle leaves no half-published pair behind.
        expect(await foodBySourceKey(first)).toBeNull();
        expect(await foodBySourceKey(second)).toBeNull();
        expect(await tableCounts()).toEqual({
            foods: 0,
            aliases: 0,
            portions: 0,
            components: 0,
            validationRecords: 0,
            runs: 1,
        });
        expect((await runRows())[0].status).toBe('failed');
        expect(await getActiveReleaseLoad(prisma)).toBeNull();
    });

    it('refuses a child row whose food the release does not carry', async () => {
        const slice = publishedSlice();
        const built = writeRelease('v1', {
            ...slice,
            aliases: [...slice.aliases, { food_source_key: 'usda:9999999', alias: 'orphan' }],
        });

        const failure = await runLoad(loadDeps(built)).then(
            () => null,
            (error: unknown) => error,
        );

        expect(failure).toBeInstanceOf(CatalogLoadError);
        expect((failure as CatalogLoadError).code).toBe('release_child_without_food');
        expect((failure as CatalogLoadError).context.file).toBe(ALIASES_FILE);
    });

    it('refuses a food the release carries with no validation record', async () => {
        const slice = publishedSlice();
        const built = writeRelease('v1', {
            ...slice,
            validationRecords: slice.validationRecords.filter(
                (record) => record.food_source_key !== SURVIVING_FOOD,
            ),
        });
        // The manifest counts agree with the files, so this is not a manifest
        // defect: the release itself ships a published food with no evidence.
        expect(built.manifest.counts.validation_records).toBe(built.manifest.counts.foods - 1);

        const failure = await runLoad(loadDeps(built)).then(
            () => null,
            (error: unknown) => error,
        );

        expect(failure).toBeInstanceOf(CatalogLoadError);
        expect((failure as CatalogLoadError).code).toBe('release_validation_record_missing');
        expect((failure as CatalogLoadError).context.sourceKey).toBe(SURVIVING_FOOD);
    });
});

/* ---------------------------------------------------------------------------
 * A published row this release cannot evidence is never written (F01, F25)
 *
 * The committed v1 release carried 11,046 published rows whose mandatory
 * retrieval status was null — a condition the import stage itself quarantines —
 * behind a manifest whose digests bound exactly those bytes as the accepted
 * evidence. The exporter refuses to produce such a release now; these cases pin
 * the other half, because a release reaches an environment as BYTES: this loader
 * may be handed one cut by an older build, or one edited after review, and it is
 * the stage that decides what a database ends up holding.
 * ------------------------------------------------------------------------- */

describe('a release whose published rows are not evidenced is refused before any write', () => {
    /** Replaces one published food's retrieval record, leaving every other line alone. */
    const withEvidence = (content: ReleaseContent, foodSourceKey: string, evidence: unknown): ReleaseContent => ({
        ...content,
        validationRecords: content.validationRecords.map((record) =>
            record.food_source_key === foodSourceKey ? { ...record, identity_evidence: evidence } : record,
        ),
    });

    const recordOf = (content: ReleaseContent, foodSourceKey: string): Row =>
        content.validationRecords.find((record) => record.food_source_key === foodSourceKey) as Row;

    /**
     * The evidence block the exporter would have measured for this content,
     * derived here from the released lines rather than copied from the
     * implementation: the loader's cross-check is only meaningful against a
     * block a reader could compute from the members themselves.
     */
    const evidenceBlockFor = (content: ReleaseContent): Row => {
        const published = content.foods.filter((food) => food.publication_status === 'published');
        const sources = Array.from(new Set(published.map((food) => String(food.identity_source)))).sort();

        return {
            published_foods: published.length,
            assessed_records: published.length,
            complete_records: published.length,
            observed_status_min: 200,
            observed_status_max: 200,
            identity_sources: sources.map((identity_source) => {
                const ofSource = published.filter((food) => food.identity_source === identity_source).length;
                return {
                    identity_source,
                    published_foods: ofSource,
                    assessed_records: ofSource,
                    observed_status_min: 200,
                    observed_status_max: 200,
                };
            }),
            gap_codes: [],
        };
    };

    const emptyTables = {
        foods: 0,
        aliases: 0,
        portions: 0,
        components: 0,
        validationRecords: 0,
        runs: 0,
    };

    const refusalOf = async (built: BuiltRelease): Promise<CatalogLoadError> => {
        const failure = await runLoad(loadDeps(built)).then(
            () => null,
            (error: unknown) => error,
        );
        expect(failure).toBeInstanceOf(CatalogLoadError);
        return failure as CatalogLoadError;
    };

    it('loads a release whose every published record is complete, with no evidence block declared', async () => {
        // The baseline the refusals below are a departure from, and the
        // reviewed-release-cut-before-the-block case: the row-level floor is
        // authoritative on its own, so a manifest with no `evidence` block is
        // still fully checked and still loads.
        const built = writeRelease('v1', publishedSlice());
        expect((built.manifest as unknown as Row).evidence).toBeUndefined();

        const summary = await runLoad(loadDeps(built));

        expect(summary.activated).toBe(true);
        expect(summary.counts.foodsInserted).toBe(built.manifest.counts.foods);
        expect(await prisma.catalog_validation_records.count()).toBe(built.manifest.counts.validation_records);
    });

    it('loads a release whose manifest evidence block agrees with its members', async () => {
        const slice = publishedSlice();
        const built = writeRelease('v1', slice, { evidence: evidenceBlockFor(slice) });

        const summary = await runLoad(loadDeps(built));

        expect(summary.activated).toBe(true);
        expect(summary.counts.foodsInserted).toBe(built.manifest.counts.foods);
    });

    it('refuses a published record whose observed HTTP status is null, and writes nothing at all', async () => {
        // The committed v1 defect, one record of an otherwise complete release:
        // every field present, `http_status` null.
        const slice = publishedSlice();
        const record = recordOf(slice, SURVIVING_FOOD);
        const evidence = (record.identity_evidence as Row[]).map((entry) => ({ ...entry, http_status: null }));
        const built = writeRelease('v1', withEvidence(slice, SURVIVING_FOOD, evidence));

        const refusal = await refusalOf(built);

        expect(refusal.code).toBe('release_evidence_incomplete');
        expect(refusal.context.file).toBe(VALIDATION_RECORDS_FILE);
        expect(refusal.context.sourceKey).toBe(SURVIVING_FOOD);
        // The line inside the member, so an operator can open it at the record
        // rather than searching 56 MB for the food.
        const line =
            [...slice.validationRecords]
                .sort((left, right) => compare(String(left.food_source_key), String(right.food_source_key)))
                .findIndex((entry) => entry.food_source_key === SURVIVING_FOOD) + 1;
        expect(refusal.context.line).toBe(line);
        expect(refusal.message).toContain(VALIDATION_RECORDS_FILE);
        expect(refusal.message).toContain(`line ${line}`);
        expect(refusal.message).toContain(SURVIVING_FOOD);
        expect(refusal.message).toContain('retrieval_status_missing');
        expect(refusal.message).toContain('Nothing has been written');
        expect(refusal.message).toContain('npm run catalog:import');

        // The whole claim: the refusal happens in the pass that writes nothing,
        // so the target database is exactly as it was — no food, no run row,
        // and the active release pointer never moved.
        expect(await tableCounts()).toEqual(emptyTables);
        expect(await getActiveReleaseLoad(prisma)).toBeNull();
    });

    it('reports an edited member as an edited member, not as an evidence gap', async () => {
        // Two facts can hold at once, and they have different remedies: "these
        // are not the bytes that were reviewed" is restored from the artefact,
        // while "the reviewed release carries an unevidenced row" needs a
        // re-retrieval and a new release. The digest is the one reported, so an
        // operator is never sent to re-import over what is actually a tampered
        // or truncated file.
        const slice = publishedSlice();
        const record = recordOf(slice, SURVIVING_FOOD);
        const evidence = (record.identity_evidence as Row[]).map((entry) => ({ ...entry, http_status: null }));
        const built = writeRelease('v1', withEvidence(slice, SURVIVING_FOOD, evidence));
        tamperOneByte(built, VALIDATION_RECORDS_FILE);

        const refusal = await refusalOf(built);

        expect(refusal.code).toBe('release_file_digest_mismatch');
        expect(refusal.context.file).toBe(VALIDATION_RECORDS_FILE);
        expect(await tableCounts()).toEqual(emptyTables);
    });

    it.each([
        ['its body digest', { body_sha256: undefined }, 'retrieval_body_digest_missing'],
        ['its usda_api_cache key', { source_cache_key: undefined }, 'retrieval_source_cache_key_missing'],
        ['its per-food record digest', { record_sha256: undefined }, 'retrieval_record_digest_missing'],
        ['its matched snippet', { matched_snippet: '' }, 'retrieval_snippet_missing'],
        ['a successful status', { http_status: 404 }, 'retrieval_status_invalid'],
    ])('refuses a published record missing %s, and writes nothing', async (_what, overrides, code) => {
        const slice = publishedSlice();
        const record = recordOf(slice, SURVIVING_FOOD);
        const evidence = (record.identity_evidence as Row[]).map((entry) => {
            const mutated: Row = { ...entry };
            for (const [field, value] of Object.entries(overrides)) {
                if (value === undefined) {
                    delete mutated[field];
                } else {
                    mutated[field] = value;
                }
            }
            return mutated;
        });
        const built = writeRelease('v1', withEvidence(slice, SURVIVING_FOOD, evidence));

        const refusal = await refusalOf(built);

        expect(refusal.code).toBe('release_evidence_incomplete');
        expect(refusal.context.observed).toBe(code);
        expect(await tableCounts()).toEqual(emptyTables);
    });

    it('refuses a published record that carries no retrieval record at all', async () => {
        const built = writeRelease('v1', withEvidence(publishedSlice(), SURVIVING_FOOD, []));

        const refusal = await refusalOf(built);

        expect(refusal.code).toBe('release_evidence_incomplete');
        expect(refusal.context.observed).toBe('evidence_absent');
        expect(await tableCounts()).toEqual(emptyTables);
    });

    it('refuses a manifest whose evidence block states a count the members do not', async () => {
        const slice = publishedSlice();
        const block = evidenceBlockFor(slice);
        const built = writeRelease('v1', slice, {
            evidence: { ...block, complete_records: Number(block.complete_records) - 1 },
        });

        const refusal = await refusalOf(built);

        expect(refusal.code).toBe('release_evidence_summary_mismatch');
        expect(refusal.context.file).toBe('manifest.json');
        expect(refusal.message).toContain('evidence.complete_records');
        expect(refusal.message).toContain('npm run catalog:release');
        expect(await tableCounts()).toEqual(emptyTables);
    });

    it('refuses a manifest whose evidence block claims a status range the records do not show', async () => {
        const slice = publishedSlice();
        const built = writeRelease('v1', slice, {
            evidence: { ...evidenceBlockFor(slice), observed_status_max: 204 },
        });

        const refusal = await refusalOf(built);

        expect(refusal.code).toBe('release_evidence_summary_mismatch');
        expect(refusal.message).toContain('evidence.observed_status_max');
        expect(await tableCounts()).toEqual(emptyTables);
    });

    it('refuses a manifest whose evidence block miscounts one identity source', async () => {
        const slice = publishedSlice();
        const block = evidenceBlockFor(slice);
        const sources = (block.identity_sources as Row[]).map((source, index) =>
            index === 0 ? { ...source, published_foods: Number(source.published_foods) + 5 } : source,
        );
        const built = writeRelease('v1', slice, { evidence: { ...block, identity_sources: sources } });

        const refusal = await refusalOf(built);

        expect(refusal.code).toBe('release_evidence_summary_mismatch');
        expect(refusal.message).toContain('evidence.identity_sources');
        expect(await tableCounts()).toEqual(emptyTables);
    });

    it('refuses a manifest whose evidence block claims gaps the records do not carry', async () => {
        // A block stating gaps is a claim about rows this release does not hold:
        // the row-level floor has just assessed every one of them and found
        // none, so the two cannot both describe these members.
        const slice = publishedSlice();
        const built = writeRelease('v1', slice, {
            evidence: {
                ...evidenceBlockFor(slice),
                gap_codes: [{ code: 'retrieval_status_missing', foods: 3 }],
            },
        });

        const refusal = await refusalOf(built);

        expect(refusal.code).toBe('release_evidence_summary_mismatch');
        expect(refusal.message).toContain('evidence.gap_codes');
        expect(await tableCounts()).toEqual(emptyTables);
    });

    it('refuses an evidence block that is not even an object, rather than reading past it', async () => {
        const built = writeRelease('v1', publishedSlice(), { evidence: 'complete' });

        const refusal = await refusalOf(built);

        expect(refusal.code).toBe('release_evidence_summary_mismatch');
        expect(await tableCounts()).toEqual(emptyTables);
    });

    it('ignores a field of the evidence block this loader does not know', async () => {
        // Forward compatibility: a later manifest version may state more than
        // this build reads, and a loader that refused the unknown key would
        // reject a release it has no fault to find with.
        const slice = publishedSlice();
        const built = writeRelease('v1', slice, {
            evidence: { ...evidenceBlockFor(slice), assessed_hosts: ['api.nal.usda.gov'] },
        });

        const summary = await runLoad(loadDeps(built));

        expect(summary.activated).toBe(true);
    });
    /**
     * The count of published rows whose identity source binds a
     * `usda_api_cache` payload, derived from the released lines the way the
     * loader derives it — so the attestation cases below are stated against the
     * members and not against a constant that would drift with the fixture.
     */
    const cacheBoundCount = (content: ReleaseContent): number =>
        content.foods.filter(
            (food) => food.publication_status === 'published' && food.identity_source === 'usda',
        ).length;

    it('loads a release whose attestation covers every published row that binds a cached payload', async () => {
        // The passing shape of the one evidence rule this stage cannot re-make.
        // The exporter resolved each of these rows' `source_cache_key` against
        // `usda_api_cache`, recomputed both digests from the stored payload and
        // recorded that it did; the loader's part is to require the attestation
        // to COVER the rows these bytes ship, which it does.
        const slice = publishedSlice();
        const required = cacheBoundCount(slice);
        expect(required).toBeGreaterThan(0);
        const built = writeRelease('v1', slice, {
            evidence: {
                ...evidenceBlockFor(slice),
                source_cache_resolution: {
                    required_records: required,
                    resolved_records: required,
                    cache_rows_read: required,
                },
            },
        });

        const summary = await runLoad(loadDeps(built));

        expect(summary.activated).toBe(true);
        expect(summary.counts.foodsInserted).toBe(built.manifest.counts.foods);
    });

    it('refuses a manifest attesting fewer resolved bindings than the release publishes', async () => {
        // The half of F25 that survives the export gate: bytes cut by a build
        // that resolved only some of its rows, or edited afterwards to claim it
        // had. The loader cannot recompute a single one of those digests, so an
        // attestation that does not cover the shipped rows is the last signal
        // there is — and it refuses on it.
        const slice = publishedSlice();
        const required = cacheBoundCount(slice);
        const built = writeRelease('v1', slice, {
            evidence: {
                ...evidenceBlockFor(slice),
                source_cache_resolution: {
                    required_records: required,
                    resolved_records: required - 1,
                    cache_rows_read: required - 1,
                },
            },
        });

        const refusal = await refusalOf(built);

        expect(refusal.code).toBe('release_evidence_cache_unresolved');
        expect(refusal.context.file).toBe('manifest.json');
        expect(refusal.context.expected).toBe(required);
        expect(refusal.context.observed).toBe(required - 1);
        expect(refusal.message).toContain(`attests ${required - 1} resolved source-cache binding(s)`);
        // The honest statement of why this is a refusal and not a check: the
        // loader says what it cannot do rather than implying it verified.
        expect(refusal.message).toContain('usda_api_cache is a database table and no release member carries it');
        expect(refusal.message).toContain('npm run catalog:release');
        expect(refusal.message).toContain('Nothing has been written');
        expect(await tableCounts()).toEqual(emptyTables);
        expect(await getActiveReleaseLoad(prisma)).toBeNull();
    });

    it.each([
        ['null', null],
        ['a string', 'all of them'],
        ['a fraction', 0.5],
    ])('refuses an attestation whose resolved_records is %s', async (_what, resolved) => {
        // An unreadable count attests nothing, and reading past it would let a
        // manifest opt out of the only binding check this stage has.
        const slice = publishedSlice();
        const built = writeRelease('v1', slice, {
            evidence: {
                ...evidenceBlockFor(slice),
                source_cache_resolution: {
                    required_records: cacheBoundCount(slice),
                    resolved_records: resolved,
                    cache_rows_read: 1,
                },
            },
        });

        const refusal = await refusalOf(built);

        expect(refusal.code).toBe('release_evidence_cache_unresolved');
        expect(await tableCounts()).toEqual(emptyTables);
    });

    it('reports an attestation whose required_records miscounts the members as a summary mismatch', async () => {
        // `required_records` IS measurable from these bytes, so a wrong one is
        // the same class of fault as any other number the block gets wrong —
        // and it gets the summary-mismatch remedy ("work out which of the two
        // moved") rather than the re-cut remedy.
        const slice = publishedSlice();
        const required = cacheBoundCount(slice);
        const built = writeRelease('v1', slice, {
            evidence: {
                ...evidenceBlockFor(slice),
                source_cache_resolution: {
                    required_records: required + 3,
                    resolved_records: required + 3,
                    cache_rows_read: 1,
                },
            },
        });

        const refusal = await refusalOf(built);

        expect(refusal.code).toBe('release_evidence_summary_mismatch');
        expect(refusal.message).toContain('evidence.source_cache_resolution.required_records');
        expect(await tableCounts()).toEqual(emptyTables);
    });

    it('loads a release whose evidence block states no attestation at all, which is a real limit', async () => {
        // Stated as a test because it is a documented gap and not an oversight:
        // a release cut before the exporter measured this carries nothing to
        // enforce, and nothing in the bytes distinguishes it from one that
        // resolved. Refusing it would strand reviewed artefacts this loader has
        // no fault to find with, so it loads — and the verification log line
        // records that the release attested nothing, which is the only place an
        // operator can see which of the two they applied.
        const slice = publishedSlice();
        const block = evidenceBlockFor(slice);
        expect(block.source_cache_resolution).toBeUndefined();
        const built = writeRelease('v1', slice, { evidence: block });

        const summary = await runLoad(loadDeps(built));

        expect(summary.activated).toBe(true);
    });


    it('refuses the same release on the dry-run path, where not even a run row is opened', async () => {
        const slice = publishedSlice();
        const record = recordOf(slice, SURVIVING_FOOD);
        const evidence = (record.identity_evidence as Row[]).map((entry) => ({ ...entry, http_status: null }));
        const built = writeRelease('v1', withEvidence(slice, SURVIVING_FOOD, evidence));

        const failure = await runLoad(loadDeps(built, { dryRun: true })).then(
            () => null,
            (error: unknown) => error,
        );

        expect(failure).toBeInstanceOf(CatalogLoadError);
        expect((failure as CatalogLoadError).code).toBe('release_evidence_incomplete');
        expect(await tableCounts()).toEqual(emptyTables);
    });

    it('does not gate the record of a food the release does not publish', async () => {
        // The floor is a PUBLICATION rule. A release only exports published
        // rows, and the contradiction of one that does not is already reported
        // as `release_published_count_mismatch` — so an unpublished line's
        // record is not re-reported as an evidence gap, and the loader's own
        // count check is what names the real defect.
        const slice = publishedSlice();
        const record = recordOf(slice, SURVIVING_FOOD);
        const unpublished: ReleaseContent = {
            ...withEvidence(slice, SURVIVING_FOOD, [{ ...(record.identity_evidence as Row[])[0], http_status: null }]),
            foods: slice.foods.map((food) =>
                food.source_key === SURVIVING_FOOD ? { ...food, publication_status: 'quarantined' } : food,
            ),
        };
        const built = writeRelease('v1', unpublished);

        const refusal = await refusalOf(built);

        expect(refusal.code).toBe('release_published_count_mismatch');
        expect(await tableCounts()).toEqual(emptyTables);
    });

    /**
     * THE TWO STAGES AGREE BY CONSTRUCTION, NOT BY HAND.
     *
     * Every case above builds its release here, so the `evidence` block they
     * declare is one this suite wrote — which is exactly the kind of agreement
     * that can drift. This case takes the block out of the suite's hands: it
     * runs the real exporter (`runRelease`, on an in-memory catalog and a real
     * directory), then loads the bytes it produced through the real loader. The
     * cross-check in the middle is therefore between two implementations and
     * nothing else, and a change to either side's measurement — a differently
     * spelled field, a count taken over a different set, a status range derived
     * another way — fails here instead of in an operator's release.
     */
    it('loads a release this exporter actually produced, evidence block and all', async () => {
        const release = 'v1';
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-exported-'));
        temporaryRoots.push(root);

        const ingest: ReleaseRunRow = {
            kind: 'usda_import',
            manifest_version: 'the-import',
            status: 'succeeded',
            finished_at: new Date('2026-09-14T08:00:00.000Z'),
        };
        const ledger: ReleaseRunRow[] = [
            ingest,
            {
                kind: 'validation',
                manifest_version: canonicalValidationRunKey(
                    'v1',
                    catalogInputIdentity([ingest as unknown as CatalogInputRunRow]),
                ),
                status: 'succeeded',
                finished_at: new Date('2026-09-14T09:00:00.000Z'),
                counts: { judged: 2, unchanged: 2 },
            },
        ];

        // The exporter now RESOLVES a published USDA row's digests against the
        // `usda_api_cache` payload they cite, so this case's evidence is
        // derived from a real payload with the same two helpers the import
        // stage uses. A constant digest would be refused — which is the point
        // of that gate and is pinned in `catalog-release.test.ts`.
        const EXPORTED_FDC_ID = 9300001;
        const exportedCacheRecord: Record<string, unknown> = {
            fdcId: EXPORTED_FDC_ID,
            description: 'Carrots, raw',
            dataType: 'SR Legacy',
        };
        const exportedCachePayload = [exportedCacheRecord];
        const exportedCacheKey = `POST /foods?#{"fdcIds":[${EXPORTED_FDC_ID}],"format":"full"}`;
        const exportedCacheRow: SourceCacheRow = {
            cache_key: exportedCacheKey,
            payload: exportedCachePayload,
            http_status: 200,
        };
        const exportedUsdaEvidence = (): Row[] => [
            {
                url: 'https://api.nal.usda.gov/fdc/v1/foods',
                method: 'POST',
                final_host: 'api.nal.usda.gov',
                http_status: 200,
                source_cache_key: exportedCacheKey,
                retrieval_source: 'import_run',
                body_sha256: sha256Hex(canonicalJsonString(exportedCachePayload)),
                record_sha256: sha256Hex(canonicalJsonString(exportedCacheRecord)),
                matched_snippet: 'Carrots, raw',
                fetched_at: NOW.toISOString(),
            },
        ];

        const validationRecordFor = (
            sourceKey: string,
            identitySource: string,
        ): NonNullable<ReleaseFoodRow['catalog_validation_records']> => ({
            canonical_identity: { canonical_name: sourceKey, food_state: 'raw' },
            aliases: [],
            category: 'produce_vegetable',
            food_state: 'raw',
            identity_source: identitySource,
            identity_status: 'verified',
            nutrition_provenance: 'source_backed',
            nutrition_method: 'usda_sr_legacy_per_100g',
            nutrition_assumptions: null,
            portion_units: [],
            identity_evidence:
                identitySource === 'usda'
                    ? exportedUsdaEvidence()
                    : syntheticIdentityEvidence({
                          food_source_key: sourceKey,
                          identity_source: identitySource,
                          category: 'produce_vegetable',
                      }),
            checks: [{ name: 'energy_vs_macros', pass: true, observed: 0, bound: 30 }],
            llm_review: null,
            outcome: 'accepted',
            reviewed_at: NOW,
            publication_status: 'published',
            source_versions: { usda: 'SR Legacy 2019-04' },
            history: [],
        });

        const exportedFood = (sourceKey: string, identitySource: string): ReleaseFoodRow => ({
            source_key: sourceKey,
            canonical_name: sourceKey,
            display_name: sourceKey,
            category: 'produce_vegetable',
            food_state: 'raw',
            food_group: 'carrot',
            identity_source: identitySource,
            identity_status: 'verified',
            nutrition_provenance: 'source_backed',
            publication_status: 'published',
            nutrition_basis: 'per_100g',
            basis_amount: 100,
            calories: 41,
            protein_g: 0.9,
            carbs_g: 9.6,
            fat_g: 0.2,
            fiber_g: 2.8,
            density_g_per_ml: null,
            allergen_tags: [],
            allergen_status: 'known',
            diet_tags: ['vegan'],
            is_common_dislike: false,
            cost_class: 1,
            nutrition_version: 1,
            metadata_version: 1,
            // Which record inside the cached payload is this food's. A
            // published USDA row whose fdcId the catalog does not hold cannot
            // have its per-food digest bound to anything, and the exporter
            // refuses one.
            usda_fdc_id: identitySource === 'usda' ? EXPORTED_FDC_ID : null,
            usda_data_type: 'SR Legacy',
            usda_description: sourceKey,
            source_version: 'SR Legacy 2019-04',
            source_cache_key: identitySource === 'usda' ? exportedCacheKey : `cache:${sourceKey}`,
            search_text: sourceKey,
            imported_at: new Date('2026-09-14T08:00:00.000Z'),
            catalog_generation_batches:
                identitySource === 'ai_generated'
                    ? {
                          batch_key: 'v1:produce_vegetable:0001',
                          model: 'google/gemini-2.5-flash',
                          prompt_version: 'catalog-generation-2026-09-08',
                      }
                    : null,
            catalog_food_aliases: [],
            catalog_food_portions: [
                {
                    description: '1 cup chopped',
                    amount: 1,
                    unit: 'cup',
                    gram_weight: 128,
                    is_default: true,
                    source: 'usda',
                },
            ],
            catalog_food_components: [],
            catalog_validation_records: validationRecordFor(sourceKey, identitySource),
        });

        const rows: readonly ReleaseFoodRow[] = [
            exportedFood('usda:9300001', 'usda'),
            exportedFood('ai:produce_vegetable:roasted carrot coins:prepared', 'ai_generated'),
        ].sort((left, right) => compare(left.source_key, right.source_key));

        const releaseDb: ReleaseDb = {
            catalog_foods: {
                findMany: async (args: unknown): Promise<ReleaseFoodRow[]> => {
                    const query = args as { where: { source_key?: { gt: string } }; take: number };
                    const after = query.where.source_key?.gt;
                    return rows
                        .filter((food) => after === undefined || food.source_key > after)
                        .slice(0, query.take);
                },
            },
            usda_api_cache: {
                findMany: async (args: unknown): Promise<SourceCacheRow[]> => {
                    const query = args as { where: { cache_key: { in: readonly string[] } } };
                    return query.where.cache_key.in.includes(exportedCacheKey) ? [exportedCacheRow] : [];
                },
            },
            catalog_import_runs: {
                create: async (): Promise<{ id: string }> => ({ id: 'run-export' }),
                update: async (): Promise<{ id: string }> => ({ id: 'run-export' }),
                findMany: async (): Promise<ReleaseRunRow[]> => [...ledger],
            },
            $transaction: async <T>(work: (tx: ReleaseDb) => Promise<T>): Promise<T> => work(releaseDb),
        };

        const outcome = await runRelease({
            db: releaseDb,
            coveragePlan: loadCoveragePlan(),
            release,
            logger: silentLogger,
            now: () => NOW,
            releaseDir: () => root,
            writeFile: (absolutePath: string, contents: string) =>
                fs.writeFileSync(absolutePath, contents, 'utf-8'),
            readFileBytes: (absolutePath: string) => fs.readFileSync(absolutePath),
            ensureDir: (absolutePath: string) => fs.mkdirSync(absolutePath, { recursive: true }),
            pageSize: 1,
        });

        expect(outcome.publishedFoods).toBe(rows.length);
        const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf-8')) as Row;
        // The exporter's own measurement, unedited: two published rows, one per
        // identity source, every status observed as 200 and no gap at all.
        expect(manifest.evidence).toEqual({
            published_foods: 2,
            assessed_records: 2,
            complete_records: 2,
            observed_status_min: 200,
            observed_status_max: 200,
            identity_sources: [
                {
                    identity_source: 'ai_generated',
                    published_foods: 1,
                    assessed_records: 1,
                    observed_status_min: 200,
                    observed_status_max: 200,
                },
                {
                    identity_source: 'usda',
                    published_foods: 1,
                    assessed_records: 1,
                    observed_status_min: 200,
                    observed_status_max: 200,
                },
            ],
            gap_codes: [],
            // The attestation the loader cannot re-make: one published USDA row
            // required a source-cache binding, it resolved, and it read the one
            // cached response behind it.
            source_cache_resolution: {
                required_records: 1,
                resolved_records: 1,
                cache_rows_read: 1,
            },
        });

        const summary = await runLoad({
            db: prisma as unknown as LoadDb,
            runDb: prisma,
            release,
            manifest: manifest as unknown as CatalogReleaseManifest,
            releaseRoot: root,
            logger: silentLogger,
            now: () => NOW,
            dryRun: false,
        });

        expect(summary.activated).toBe(true);
        expect(summary.counts.foodsInserted).toBe(rows.length);
        expect(await prisma.catalog_validation_records.count()).toBe(rows.length);
        expect((await getActiveReleaseLoad(prisma))?.releaseId).toBe(release);
    });
});

/* ---------------------------------------------------------------------------
 * A release that contradicts itself about a derived food is never written (F03)
 *
 * A published `ingredient_derived` food's nutrient scalars are not a source's
 * statement about it — they are the output of `deriveComponentNutrition` over
 * that food's composition (AAP §0.5.1). This loader applies those scalars from
 * `foods.jsonl` and reconciles `catalog_food_components` from
 * `components.jsonl` in a SEPARATE step, and nothing compared the two: the
 * recomputation existed, correct and unit-tested, with no production caller
 * anywhere in the pipeline. So a release whose components disagree with its
 * foods published that disagreement into every environment that loaded it,
 * with the manifest's digests binding the contradiction as the reviewed
 * artefact — and a recipe built on such a parent then snapshots its numbers
 * with a `nutrition_version` saying they are current, which is what makes the
 * error unfalsifiable from inside the system afterwards.
 *
 * WHAT THESE CASES ASSERT. That the check is applied to the BYTES, before a
 * row is written; that it names the member, the line, the food and the gap so
 * an operator can open the release at the composition; that the target
 * database and the active release pointer are untouched by the refusal; that
 * it is decided by what the release CARRIES rather than by what a food's line
 * claims, so relabelling a component-bearing parent cannot switch it off; and
 * that a release which is not closed over its own component references is
 * refused as that, first, because a composition pointing outside the release
 * states no component nutrition to recompute from and would otherwise be
 * resolved against whatever the destination database holds.
 * ------------------------------------------------------------------------- */

describe('a release whose derived foods disagree with their compositions is refused before any write', () => {
    const emptyTables = {
        foods: 0,
        aliases: 0,
        portions: 0,
        components: 0,
        validationRecords: 0,
        runs: 0,
    };

    const refusalOf = async (built: BuiltRelease): Promise<CatalogLoadError> => {
        const failure = await runLoad(loadDeps(built)).then(
            () => null,
            (error: unknown) => error,
        );
        expect(failure).toBeInstanceOf(CatalogLoadError);
        return failure as CatalogLoadError;
    };

    /** Replaces one published food's line, leaving every other line alone. */
    const withFood = (content: ReleaseContent, sourceKey: string, overrides: Row): ReleaseContent => ({
        ...content,
        foods: content.foods.map((food) => (food.source_key === sourceKey ? { ...food, ...overrides } : food)),
    });

    /** Replaces the component lines of one parent, leaving every other line alone. */
    const withComponents = (
        content: ReleaseContent,
        parentSourceKey: string,
        rewrite: (component: Row) => Row,
    ): ReleaseContent => ({
        ...content,
        components: content.components.map((component) =>
            component.food_source_key === parentSourceKey ? rewrite(component) : component,
        ),
    });

    /**
     * The `components.jsonl` line a refusal about a given parent is reported
     * at: the member is written sorted by parent then component key, and the
     * first line of that parent is where an operator opens the file.
     */
    const firstComponentLineOf = (content: ReleaseContent, parentSourceKey: string): number =>
        [...content.components]
            .sort(byParentThen('component_food_source_key'))
            .findIndex((component) => component.food_source_key === parentSourceKey) + 1;

    /** The `foods.jsonl` line of a given food, for the parent-with-no-composition case. */
    const foodLineOf = (content: ReleaseContent, sourceKey: string): number =>
        [...content.foods]
            .sort((left, right) => compare(String(left.source_key), String(right.source_key)))
            .findIndex((food) => food.source_key === sourceKey) + 1;

    it('loads a consistent derived release and lands the scalars and the composition it states', async () => {
        // The baseline the refusals below are a departure from. The slice
        // carries two published `ingredient_derived` parents whose four
        // compositions point at three other published foods — including the
        // FORWARD reference that makes the loader defer a parent — so this
        // asserts that the cross-check passes a release the pipeline could
        // actually have cut, and that the rows it then writes are the ones the
        // release stated.
        const slice = publishedSlice();
        const built = writeRelease('v1', slice);

        const summary = await runLoad(loadDeps(built));

        expect(summary.activated).toBe(true);
        expect(summary.counts.foodsInserted).toBe(built.manifest.counts.foods);
        expect((await tableCounts()).components).toBe(built.manifest.counts.components);

        // The re-derived parent, read back from the database: the scalars the
        // release stated, and the composition they are the derivation of.
        const stale = await foodBySourceKey(STALE_DERIVED_PARENT);
        expect(stale?.nutrition_provenance).toBe('ingredient_derived');
        expect(stale?.calories).toBe(REDERIVED_STALE_PARENT.calories);
        expect(stale?.protein_g).toBe(REDERIVED_STALE_PARENT.protein_g);
        expect(stale?.carbs_g).toBe(REDERIVED_STALE_PARENT.carbs_g);
        expect(stale?.fat_g).toBe(REDERIVED_STALE_PARENT.fat_g);
        expect(stale?.fiber_g).toBe(REDERIVED_STALE_PARENT.fiber_g);
        expect(
            stale?.catalog_food_components
                .map(
                    (component) =>
                        `${component.component_catalog_foods.source_key}@${component.component_nutrition_version}`,
                )
                .sort(),
        ).toEqual(['usda:9200114@1', 'usda:9200115@2']);

        // And the already-consistent parent, untouched by the repair.
        const dressing = await foodBySourceKey(DERIVED_PARENT);
        expect(dressing?.catalog_food_components).toHaveLength(2);
        expect((await getActiveReleaseLoad(prisma))?.releaseId).toBe('v1');
    });

    it('refuses a derived parent whose scalars are not what its components derive to, and writes nothing', async () => {
        // The numbers stay internally consistent — 1.2× every value, so the
        // energy-macro identity still holds and the category band still
        // contains it — which is precisely why nothing but this check can
        // catch it.
        const slice = publishedSlice();
        const inconsistent = withFood(slice, STALE_DERIVED_PARENT, {
            calories: Number(REDERIVED_STALE_PARENT.calories) * 1.2,
            protein_g: Number(REDERIVED_STALE_PARENT.protein_g) * 1.2,
            carbs_g: Number(REDERIVED_STALE_PARENT.carbs_g) * 1.2,
            fat_g: Number(REDERIVED_STALE_PARENT.fat_g) * 1.2,
            fiber_g: Number(REDERIVED_STALE_PARENT.fiber_g) * 1.2,
        });
        const built = writeRelease('v1', inconsistent);

        const refusal = await refusalOf(built);

        expect(refusal.code).toBe('release_component_inconsistent');
        expect(refusal.context.file).toBe(COMPONENTS_FILE);
        expect(refusal.context.line).toBe(firstComponentLineOf(inconsistent, STALE_DERIVED_PARENT));
        expect(refusal.context.sourceKey).toBe(STALE_DERIVED_PARENT);
        expect(refusal.context.observed).toBe('parent_nutrition_disagrees');
        expect(refusal.message).toContain(COMPONENTS_FILE);
        expect(refusal.message).toContain(`line ${firstComponentLineOf(inconsistent, STALE_DERIVED_PARENT)}`);
        expect(refusal.message).toContain(STALE_DERIVED_PARENT);
        expect(refusal.message).toContain('parent_nutrition_disagrees');
        // The two numbers, so the refusal is actionable without recomputing.
        expect(refusal.message).toContain('catalog_foods.calories');
        expect(refusal.message).toContain('components derive 56.6875');
        expect(refusal.message).toContain('Nothing has been written');
        expect(refusal.message).toContain('the active release pointer has not moved');
        expect(refusal.message).toContain('npm run catalog:validate');

        // The whole claim: the refusal happens in the pass that writes nothing.
        expect(await tableCounts()).toEqual(emptyTables);
        expect(await getActiveReleaseLoad(prisma)).toBeNull();
    });

    it('refuses a pin naming a component version the release does not carry', async () => {
        // The fixture's original defect, put back deliberately: the parent's
        // totals are stated as having come from `usda:9200115` at
        // `nutrition_version` 1, and the release carries that food at 2. The
        // composition those bytes describe is therefore not the one the numbers
        // came from, and no check on either row can see it — the parent's own
        // counter never moved.
        const slice = publishedSlice();
        const stalePin = withComponents(slice, STALE_DERIVED_PARENT, (component) =>
            component.component_food_source_key === 'usda:9200115'
                ? { ...component, component_nutrition_version: 1 }
                : component,
        );
        const built = writeRelease('v1', stalePin);

        const refusal = await refusalOf(built);

        expect(refusal.code).toBe('release_component_inconsistent');
        expect(refusal.context.sourceKey).toBe(STALE_DERIVED_PARENT);
        expect(refusal.message).toContain('component_version_stale');
        expect(refusal.message).toContain('catalog_food_components.component_nutrition_version');
        expect(refusal.message).toContain('usda:9200115');
        expect(refusal.message).toContain('pinned 1, component now at 2');
        expect(await tableCounts()).toEqual(emptyTables);
        expect(await getActiveReleaseLoad(prisma)).toBeNull();
    });

    it('refuses a published derived food the release gives no composition at all', async () => {
        // Reported at the food's own `foods.jsonl` line, because a parent with
        // no component rows appears nowhere in `components.jsonl` and a line
        // number there would name another food's composition.
        const slice = publishedSlice();
        const stripped: ReleaseContent = {
            ...slice,
            components: slice.components.filter((component) => component.food_source_key !== STALE_DERIVED_PARENT),
        };
        const built = writeRelease('v1', stripped);

        const refusal = await refusalOf(built);

        expect(refusal.code).toBe('release_component_inconsistent');
        expect(refusal.context.file).toBe(FOODS_FILE);
        expect(refusal.context.line).toBe(foodLineOf(stripped, STALE_DERIVED_PARENT));
        expect(refusal.context.sourceKey).toBe(STALE_DERIVED_PARENT);
        expect(refusal.message).toContain('components_absent');
        expect(refusal.message).toContain('at least one component row');
        expect(await tableCounts()).toEqual(emptyTables);
    });

    it('refuses a derived parent whose basis is not the one a derivation produces', async () => {
        const slice = publishedSlice();
        const built = writeRelease(
            'v1',
            withFood(slice, STALE_DERIVED_PARENT, { nutrition_basis: 'per_100ml', basis_amount: 100 }),
        );

        const refusal = await refusalOf(built);

        expect(refusal.code).toBe('release_component_inconsistent');
        expect(refusal.message).toContain('parent_basis_disagrees');
        expect(refusal.message).toContain('catalog_foods.nutrition_basis/basis_amount');
        expect(await tableCounts()).toEqual(emptyTables);
    });

    it('refuses a component-bearing parent that claims its numbers were not derived from them', async () => {
        // THE BYPASS THIS CASE USED TO BLESS. It asserted that the same wrong
        // scalars LOAD as long as the parent's line says `source_backed`, on
        // the reasoning that a sourced row cannot disagree with a composition.
        // The reasoning is what is wrong: the gate was keyed on the claim, so
        // editing one text field in `foods.jsonl` both relabelled the row and
        // switched off the check that reads its component lines — and the
        // manifest's digests then bound the result as the reviewed artefact.
        //
        // The release is now refused because of what it CARRIES. The parent has
        // component lines, so its numbers are derivable from them and
        // `deriveComponentNutrition` calls anything it derives
        // `ingredient_derived`; a composition plus any other provenance is one
        // food stating two incompatible things about where its numbers came
        // from, and loading it would publish both the contradiction and the
        // wrong scalars in this database.
        const slice = publishedSlice();
        const relabelled = withFood(slice, STALE_DERIVED_PARENT, {
            nutrition_provenance: 'source_backed',
            calories: Number(REDERIVED_STALE_PARENT.calories) * 1.2,
        });
        const built = writeRelease('v1', relabelled);

        const refusal = await refusalOf(built);

        expect(refusal.code).toBe('release_component_inconsistent');
        expect(refusal.context.file).toBe(COMPONENTS_FILE);
        expect(refusal.context.line).toBe(firstComponentLineOf(relabelled, STALE_DERIVED_PARENT));
        expect(refusal.context.sourceKey).toBe(STALE_DERIVED_PARENT);
        expect(refusal.message).toContain('parent_provenance_disagrees');
        expect(refusal.message).toContain('catalog_foods.nutrition_provenance');
        expect(refusal.message).toContain('source_backed, on a food carrying 2 component row(s)');
        // The recomputation still ran underneath the contradiction, so one
        // refusal names both the mislabelling and the numbers.
        expect(refusal.message).toContain('parent_nutrition_disagrees');
        expect(refusal.message).toContain('components derive 56.6875');
        expect(await tableCounts()).toEqual(emptyTables);
        expect(await getActiveReleaseLoad(prisma)).toBeNull();
    });

    it('loads a sourced food that carries no composition at all', async () => {
        // THE GATE IS STILL INERT WHERE NOTHING IS IN PLAY, which is the common
        // case and the reason it reads the release's component lines rather
        // than a row's claim: a `source_backed` food with no composition in the
        // release has nothing to disagree with, so it loads with its scalars
        // exactly as the release states them.
        const slice = publishedSlice();
        const sourced: ReleaseContent = {
            ...withFood(slice, STALE_DERIVED_PARENT, {
                nutrition_provenance: 'source_backed',
                calories: Number(REDERIVED_STALE_PARENT.calories) * 1.2,
            }),
            components: slice.components.filter(
                (component) => component.food_source_key !== STALE_DERIVED_PARENT,
            ),
        };
        const built = writeRelease('v1', sourced);

        const summary = await runLoad(loadDeps(built));

        expect(summary.activated).toBe(true);
        expect((await foodBySourceKey(STALE_DERIVED_PARENT))?.calories).toBe(
            Number(REDERIVED_STALE_PARENT.calories) * 1.2,
        );
    });

    it('refuses a release whose published composition names a food it does not publish', async () => {
        // THE GAP THIS CLOSES. The recomputation needs the component food's own
        // nutrition and its current `nutrition_version`, and a reference
        // outside `foods.jsonl` supplies neither — so the parent used to be
        // passed over UNCHECKED here, and the apply pass then resolved the same
        // key against whatever this database held under it, at whatever version
        // that row now carries. An externally-resolved component could
        // therefore activate a published parent whose totals were taken at a
        // version the local food has moved past, and nothing would report it:
        // the staleness detector compares counters, and the parent's own
        // counter never moved.
        //
        // The release is refused instead, because a release is a statement of
        // desired state every environment must read identically and this one
        // would mean something different in each. The exporter already refuses
        // to cut it (`componentTargetOutsideRelease`), so this is the same rule
        // applied to bytes it did not produce.
        const slice = publishedSlice();
        const componentKey = String(slice.components[0].component_food_source_key);
        const parentKey = String(slice.components[0].food_source_key);
        const notClosed: ReleaseContent = {
            foods: slice.foods.filter((food) => food.source_key !== componentKey),
            aliases: slice.aliases.filter((alias) => alias.food_source_key !== componentKey),
            portions: slice.portions.filter((portion) => portion.food_source_key !== componentKey),
            components: slice.components,
            validationRecords: slice.validationRecords.filter(
                (record) => record.food_source_key !== componentKey,
            ),
        };
        // The manifest's counts are measured from these bytes, so the removed
        // food is absent from the published count too — otherwise
        // `release_published_count_mismatch` would report first and this gate
        // would never be reached.
        const built = writeRelease('v1', notClosed);

        const refusal = await refusalOf(built);

        expect(refusal.code).toBe('release_components_not_closed');
        expect(refusal.context.file).toBe(COMPONENTS_FILE);
        expect(refusal.context.sourceKey).toBe(parentKey);
        expect(refusal.context.componentSourceKey).toBe(componentKey);
        expect(refusal.message).toContain(componentKey);
        expect(refusal.message).toContain('not closed over its own component references');
        expect(refusal.message).toContain('Nothing has been written');
        expect(refusal.message).toContain('npm run catalog:release');
        // Before any write, and before a run row: the refusal is raised by the
        // verification pass, which opens nothing.
        expect(await tableCounts()).toEqual(emptyTables);
        expect(await runRows()).toEqual([]);
        expect(await getActiveReleaseLoad(prisma)).toBeNull();
    });

    it('refuses a composition pointing at a food this database already holds, rather than resolving it locally', async () => {
        // THE CASE THAT USED TO LOAD, and the one the gap was reachable
        // through: the component food IS in this database, from an earlier
        // release, so the apply pass could resolve the key — against a row
        // whose current nutrition and version nothing compared with the pin the
        // release states. Membership in the release, not in the destination, is
        // what makes a composition loadable.
        await runLoad(loadDeps(writeRelease('v0', publishedSlice())));

        const slice = publishedSlice();
        const componentKey = String(slice.components[0].component_food_source_key);
        expect(await foodBySourceKey(componentKey)).not.toBeNull();

        const notClosed: ReleaseContent = {
            foods: slice.foods.filter((food) => food.source_key !== componentKey),
            aliases: slice.aliases.filter((alias) => alias.food_source_key !== componentKey),
            portions: slice.portions.filter((portion) => portion.food_source_key !== componentKey),
            components: slice.components,
            validationRecords: slice.validationRecords.filter(
                (record) => record.food_source_key !== componentKey,
            ),
        };
        const built = writeRelease('v1', notClosed);

        const refusal = await refusalOf(built);

        expect(refusal.code).toBe('release_components_not_closed');
        expect(refusal.context.componentSourceKey).toBe(componentKey);
        // The v0 load stays exactly where it was: this refusal writes nothing
        // and moves no pointer.
        expect((await getActiveReleaseLoad(prisma))?.releaseId).toBe('v0');
    });

    it('reports an edited member as an edited member, not as an inconsistency', async () => {
        // Two facts can hold at once with different remedies, and the order is
        // the same one the identity-evidence floor keeps: "these are not the
        // bytes that were reviewed" is restored from the artefact, while "the
        // reviewed release contradicts itself" needs a re-derivation and a new
        // release. The digest is the one reported.
        const slice = publishedSlice();
        const built = writeRelease(
            'v1',
            withFood(slice, STALE_DERIVED_PARENT, { calories: Number(REDERIVED_STALE_PARENT.calories) * 1.2 }),
        );
        tamperOneByte(built, COMPONENTS_FILE);

        const refusal = await refusalOf(built);

        expect(refusal.code).toBe('release_file_digest_mismatch');
        expect(refusal.context.file).toBe(COMPONENTS_FILE);
        expect(await tableCounts()).toEqual(emptyTables);
    });

    it('refuses the same release on the dry-run path, where not even a run row is opened', async () => {
        const slice = publishedSlice();
        const built = writeRelease(
            'v1',
            withFood(slice, STALE_DERIVED_PARENT, { calories: Number(REDERIVED_STALE_PARENT.calories) * 1.2 }),
        );

        const failure = await runLoad(loadDeps(built, { dryRun: true })).then(
            () => null,
            (error: unknown) => error,
        );

        expect(failure).toBeInstanceOf(CatalogLoadError);
        expect((failure as CatalogLoadError).code).toBe('release_component_inconsistent');
        expect(await tableCounts()).toEqual(emptyTables);
    });

    it('is inert against a release that publishes no derived food', async () => {
        // The committed v1 release is exactly this shape — a zero-row
        // `components.jsonl` and no published `ingredient_derived` row — so the
        // gate must cost it nothing and refuse nothing. Both derived parents
        // are re-declared `ai_estimated` and their compositions dropped, which
        // is the only way to state that set in a release the exporter would
        // accept.
        const slice = publishedSlice();
        const derivedKeys = new Set(slice.components.map((component) => String(component.food_source_key)));
        const built = writeRelease('v1', {
            ...slice,
            foods: slice.foods.map((food) =>
                derivedKeys.has(String(food.source_key)) ? { ...food, nutrition_provenance: 'ai_estimated' } : food,
            ),
            components: [],
        });
        expect(built.manifest.counts.components).toBe(0);
        expect(built.manifest.counts.published_ingredient_derived).toBe(0);

        const summary = await runLoad(loadDeps(built));

        expect(summary.activated).toBe(true);
        expect((await tableCounts()).components).toBe(0);
    });
});

/* ---------------------------------------------------------------------------
 * The input contract: preflight, arguments and reported codes
 * ------------------------------------------------------------------------- */

describe('preflight refuses a manifest that cannot be acted on', () => {
    it('accepts a consistent release', () => {
        const built = writeRelease('v1', publishedSlice());
        expect(preflight(preflightDeps(built))).toEqual([]);
    });

    /**
     * The stage-boundary canary for the manifest-loading refusal.
     *
     * A ManifestError's SENTENCE is the one thing this gap must not repeat:
     * `repo_root_not_found` interpolates an absolute `startDir` and
     * `invalid_merged_report` quotes a foreign JSON parser message, so
     * forwarding the message puts the checkout location and third-party prose
     * into an operator log. The planted path below stands in for both, and the
     * assertion is over the WHOLE gap rather than the `detail` field alone, so
     * a future change that moves the message into `requirement` or `remedy`
     * fails here too.
     */
    it('reports the manifest refusal by code, without repeating the error sentence', () => {
        const built = writeRelease('v1', publishedSlice());
        const plantedPath = '/private/build-agent/checkout/backend/data/meal-planning';
        const gaps = preflight(
            preflightDeps(built, {
                loadReleaseManifest: () => {
                    throw new ManifestError(
                        'repo_root_not_found',
                        `Could not resolve the backend repository root: no package.json was found in ${plantedPath}.`,
                    );
                },
            }),
        );

        expect(gaps.map((gap) => gap.code)).toEqual(['release_manifest_unavailable']);
        expect(gaps[0].detail).toBe('repo_root_not_found');
        expect(JSON.stringify(gaps)).not.toContain(plantedPath);
        expect(JSON.stringify(gaps)).not.toContain('Could not resolve');
    });

    it('names the release-id mismatch and stops there', () => {
        const built = writeRelease('v2', publishedSlice());
        const gaps = preflight(preflightDeps(built, { release: 'v1' }));

        expect(gaps.map((gap) => gap.code)).toEqual(['release_id_mismatch']);
        expect(gaps[0].remedy).toContain('--release v1');
    });

    it('refuses a counts block that disagrees with the files it describes', () => {
        const built = writeRelease('v1', publishedSlice());
        const doctored: CatalogReleaseManifest = {
            ...built.manifest,
            counts: { ...built.manifest.counts, aliases: built.manifest.counts.aliases + 1 },
        };

        const gaps = preflight(preflightDeps(built, { loadReleaseManifest: () => doctored }));

        expect(gaps.map((gap) => gap.code)).toContain('release_manifest_counts_disagree');
    });

    it('refuses a manifest that does not describe all five members', () => {
        const built = writeRelease('v1', publishedSlice());
        const doctored: CatalogReleaseManifest = {
            ...built.manifest,
            files: built.manifest.files.filter((file) => file.path !== COMPONENTS_FILE),
        };

        const gaps = preflight(preflightDeps(built, { loadReleaseManifest: () => doctored }));

        expect(gaps.map((gap) => gap.code)).toContain('release_manifest_member_missing');
    });

    /**
     * A well-formed digest that is not any member's, so a duplicate declaration
     * differs from the one beside it in the one field a verification is held to.
     */
    const FOREIGN_DIGEST = 'f'.repeat(64);

    const declarationOf = (built: BuiltRelease, member: string): CatalogReleaseManifest['files'][number] =>
        built.manifest.files.find((file) => file.path === member) as CatalogReleaseManifest['files'][number];

    it('refuses a member declared twice with conflicting measurements, rather than keeping the last declaration', () => {
        const built = writeRelease('v1', publishedSlice());
        const declared = declarationOf(built, FOODS_FILE);
        const doctored: CatalogReleaseManifest = {
            ...built.manifest,
            files: [
                ...built.manifest.files,
                // The same member again, stating another digest and one row
                // more: two declarations of one file that cannot both be true.
                { ...declared, sha256: FOREIGN_DIGEST, row_count: declared.row_count + 1 },
            ],
        };

        const gaps = preflight(preflightDeps(built, { loadReleaseManifest: () => doctored }));

        // THE DUPLICATION AND NOTHING ELSE. The second declaration's row_count
        // disagrees with counts.foods, so a loader that collapsed the pair to
        // the last entry would report that disagreement instead — a complaint
        // derived from a declaration the document itself contradicts, sending
        // the operator after the wrong defect.
        expect(gaps.map((gap) => gap.code)).toEqual(['release_manifest_member_duplicated']);
    });

    it('refuses a member declared twice even when both declarations agree', () => {
        // Ambiguity is structural, not a function of the contents: the manifest
        // is the release's file list, and a member listed twice would be
        // verified twice and stated twice in the run's cursor.
        const built = writeRelease('v1', publishedSlice());
        const doctored: CatalogReleaseManifest = {
            ...built.manifest,
            files: [...built.manifest.files, { ...declarationOf(built, ALIASES_FILE) }],
        };

        const gaps = preflight(preflightDeps(built, { loadReleaseManifest: () => doctored }));

        expect(gaps.map((gap) => gap.code)).toEqual(['release_manifest_member_duplicated']);
    });

    it('refuses a files[] entry that names no path rather than passing over it', () => {
        const built = writeRelease('v1', publishedSlice());
        const doctored: CatalogReleaseManifest = {
            ...built.manifest,
            files: [
                ...built.manifest.files,
                // A manifest is a JSON document, so its declared type does not
                // bind what arrives: this entry carries measurements and no
                // "path" at all.
                {
                    name: FOODS_FILE,
                    sha256: FOREIGN_DIGEST,
                    row_count: 1,
                    bytes: 1,
                } as unknown as CatalogReleaseManifest['files'][number],
            ],
        };

        const gaps = preflight(preflightDeps(built, { loadReleaseManifest: () => doctored }));

        // Reported as misdeclared, and NOT turned into a hunt for a file called
        // "undefined": a coerced name would send the operator looking for a
        // file the manifest never stated.
        expect(gaps.map((gap) => gap.code)).toEqual(['release_manifest_entry_invalid']);
    });

    it('reports a member whose entry carries no usable path as both misdeclared and undeclared', () => {
        const built = writeRelease('v1', publishedSlice());
        const doctored: CatalogReleaseManifest = {
            ...built.manifest,
            files: built.manifest.files.map((file) =>
                file.path === COMPONENTS_FILE
                    ? ({ ...file, path: 42 } as unknown as CatalogReleaseManifest['files'][number])
                    : file,
            ),
        };

        const gaps = preflight(preflightDeps(built, { loadReleaseManifest: () => doctored }));

        // Both facts, because they are two different fixes: the entry is
        // defective, and the member it was meant to describe is therefore not
        // declared at all.
        expect(gaps.map((gap) => gap.code).sort()).toEqual([
            'release_manifest_entry_invalid',
            'release_manifest_member_missing',
        ]);
    });

    it('refuses a manifest stating fewer validation records than foods', () => {
        const built = writeRelease('v1', publishedSlice());
        const doctored: CatalogReleaseManifest = {
            ...built.manifest,
            counts: { ...built.manifest.counts, validation_records: built.manifest.counts.foods - 1 },
        };

        const gaps = preflight(preflightDeps(built, { loadReleaseManifest: () => doctored }));

        expect(gaps.map((gap) => gap.code)).toContain('release_validation_records_incomplete');
    });
});

describe('the command line', () => {
    it('accepts --dry-run as a boolean flag', () => {
        const parsed = parseArgs(['--release', 'v1', '--dry-run']);
        expect(parsed.ok).toBe(true);
        expect(parsed.ok && parsed.options).toEqual({ help: false, release: 'v1', dryRun: true });
    });

    it('defaults --dry-run off and rejects a value for it', () => {
        const parsed = parseArgs(['--release', 'v1']);
        expect(parsed.ok && parsed.options.dryRun).toBe(false);

        const rejected = parseArgs(['--release', 'v1', '--dry-run=false']);
        expect(rejected.ok).toBe(false);
        expect(!rejected.ok && rejected.errors.map((error) => error.flag)).toEqual(['--dry-run']);
    });

    it('reports a load refusal under its own code', () => {
        const described = describeFailure(
            new CatalogLoadError('release_file_digest_mismatch', 'foods.jsonl does not match', {
                file: FOODS_FILE,
            }),
        );

        expect(described.code).toBe('release_file_digest_mismatch');
        expect(described.error.name).toBe('CatalogLoadError');
        expect(describeFailure(new TypeError('something else')).code).toBe('unexpected_error');
    });
});

describe('the database-origin policy this stage runs under', () => {
    // Parse fixtures: only the host and the database name are ever classified,
    // so the userinfo is a placeholder rather than any credential that opens
    // anything — including the local one this suite itself connects with.
    const TEST_URL = 'postgresql://example-user:example-password@127.0.0.1:5433/soh_example_test';
    const DEV_URL = 'postgresql://example-user:example-password@127.0.0.1:5433/soh_example_dev';

    it('is development_or_confirmed', () => {
        expect(SCRIPT_DATABASE_POLICIES['catalog-load']).toBe('development_or_confirmed');
    });

    it('demands --confirm-target for a non-development origin, and accepts the right name only', () => {
        const origin = classifyDatabaseOrigin(TEST_URL);
        expect(origin.originClass).toBe('test');

        const policy = 'development_or_confirmed' as const;
        const withoutFlag = evaluateScriptDatabase({
            script: 'catalog-load',
            policy,
            origin,
            confirmTarget: null,
        });
        expect(withoutFlag.allowed).toBe(false);
        expect(!withoutFlag.allowed && withoutFlag.code).toBe('confirmation_required');

        const wrongName = evaluateScriptDatabase({
            script: 'catalog-load',
            policy,
            origin,
            confirmTarget: 'soh_other_test',
        });
        expect(!wrongName.allowed && wrongName.code).toBe('confirmation_mismatch');

        expect(
            evaluateScriptDatabase({ script: 'catalog-load', policy, origin, confirmTarget: origin.database }),
        ).toEqual({ allowed: true });
    });

    it('refuses an origin it cannot recognise even when --confirm-target names it', () => {
        // The flag confirms a database the guard has classified; it is not a
        // way to assert a classification. An unrecognised origin is therefore
        // refused ahead of the policy, which is what stops `--confirm-target
        // state_of_health` from being the one keystroke between a catalog load
        // and production.
        const origin = classifyDatabaseOrigin('postgresql://app:secret@db.example.com:5432/state_of_health');
        expect(origin.originClass).toBe('unknown');

        const confirmed = evaluateScriptDatabase({
            script: 'catalog-load',
            policy: 'development_or_confirmed',
            origin,
            confirmTarget: origin.database,
        });

        expect(confirmed.allowed).toBe(false);
        expect(!confirmed.allowed && confirmed.code).toBe('unrecognised_origin');
    });

    it('is exercised through an injected argv because the module-load guard keyed on process.argv[1] is a no-op under Jest', () => {
        // Asserted, not assumed: that no-op is what lets this file import
        // `catalog-load.ts` at all, so if argv[1] ever resolved to a known
        // script the import would refuse the run instead of this test failing.
        expect(entryScriptName(process.argv)).toBeNull();
    });

    it('logs the fields it classified and never the connection URL', () => {
        const lines: string[] = [];
        const recorder = createLogger('guard', {
            level: 'debug',
            write: (line: string): void => {
                lines.push(line);
            },
            now: () => NOW,
        });
        const url = 'postgresql://catalog_operator:tr0ub4dor@127.0.0.1:5433/soh_example_dev';

        assertScriptDatabase({
            script: 'catalog-load',
            argv: ['node', 'scripts/catalog-load.ts', '--release', 'v1'],
            env: { DATABASE_URL: url },
            logger: recorder,
        });

        expect(lines).toHaveLength(1);
        const entry = JSON.parse(lines[0]) as Record<string, unknown>;
        expect(entry.event).toBe('database_origin_accepted');
        expect(entry.script).toBe('catalog-load');
        expect(entry.policy).toBe('development_or_confirmed');
        expect(entry.originClass).toBe('development');
        // The CLASSIFICATION and which half of the rule matched — here the
        // database name's `_dev` suffix, which is why no `--confirm-target`
        // flag was needed — plus an opaque digest standing in for the target.
        expect(entry.match).toBe('name');
        expect(entry.targetDigest).toMatch(/^[0-9a-f]{12}$/);

        // Nothing the URL carried around them: no password, no userinfo, not
        // the URL itself, AND NEITHER THE HOST NOR THE DATABASE NAME. This line
        // is emitted on every accepted run, so it reaches CI logs and anything
        // that ships them; a host and a database name there disclose the
        // deployment's topology to every later reader (CWE-532) while telling
        // an operator nothing the classification does not already say.
        // `dbGuard.test.ts` owns the digest's correlate-but-do-not-disclose
        // pair of assertions.
        expect(lines[0]).not.toContain('tr0ub4dor');
        expect(lines[0]).not.toContain('catalog_operator');
        expect(lines[0]).not.toContain(url);
        expect(lines[0]).not.toContain('127.0.0.1');
        expect(lines[0]).not.toContain('soh_example_dev');
        expect(Object.keys(entry)).not.toContain('host');
        expect(Object.keys(entry)).not.toContain('database');
    });

    it('applies the same rule through assertScriptDatabase with an injected argv and env', () => {
        // Injected, never assigned: the guard reads `process.argv` and
        // `process.env` only when it is given neither, and this suite runs
        // inside a Jest worker whose argv is the jest binary.
        expect(() =>
            assertScriptDatabase({
                script: 'catalog-load',
                argv: ['node', 'scripts/catalog-load.ts', '--release', 'v1'],
                env: { DATABASE_URL: TEST_URL },
            }),
        ).toThrow(DatabaseOriginError);

        expect(
            assertScriptDatabase({
                script: 'catalog-load',
                argv: ['node', 'scripts/catalog-load.ts', '--release', 'v1', '--confirm-target', 'soh_example_test'],
                env: { DATABASE_URL: TEST_URL },
            }).originClass,
        ).toBe('test');

        // A development origin needs no flag at all.
        expect(
            assertScriptDatabase({
                script: 'catalog-load',
                argv: ['node', 'scripts/catalog-load.ts', '--release', 'v1'],
                env: { DATABASE_URL: DEV_URL },
            }).originClass,
        ).toBe('development');
    });
});

/* ---------------------------------------------------------------------------
 * The real artefact
 * ------------------------------------------------------------------------- */

describe('the committed v1 release', () => {
    /**
     * WHAT THE ARTEFACT ITSELF CARRIES, MEASURED BEFORE IT IS LOADED.
     *
     * This block is the only one that reasons about bytes committed to this
     * repository rather than bytes it wrote, and the identity-evidence floor is
     * the property those bytes have to satisfy. The release measured here was
     * cut by a pipeline pass that observes a real HTTP status per retrieval, so
     * all 9,422 of its published records state an integer 2xx status and the
     * floor holds across every one of them. The release it replaced stated
     * `http_status: null` on all 11,046 of its records — the exact condition the
     * import stage quarantines and the loader refuses — which is the defect
     * F01/F25 named and which is no longer present in the artefact.
     *
     * The artefact is therefore MEASURED with the same rule the loader applies,
     * and the measurement is asserted as a fact of the bytes rather than
     * assumed: every published record is assessed, and the assessment must find
     * no gap. That measurement is what the two tests below turn into §0.9.1's
     * claim — the release loads whole and reruns as a no-op. A loader that
     * refused these bytes fails here, and so does a regeneration that
     * reintroduces an incomplete record, because the measurement is asserted
     * separately from the load rather than inferred from it succeeding.
     */
    interface CommittedEvidence {
        readonly assessed: number;
        readonly incomplete: number;
        readonly first: { readonly sourceKey: string; readonly line: number; readonly codes: readonly string[] } | null;
    }

    let committedEvidence: CommittedEvidence;

    beforeAll(async () => {
        // Streamed rather than read whole: the member is 56 MB of JSONL, and
        // this is the same one-pass shape the loader's verification uses.
        const stream = fs.createReadStream(releaseFilePath(REAL_RELEASE, VALIDATION_RECORDS_FILE));
        const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
        let assessed = 0;
        let incomplete = 0;
        let first: CommittedEvidence['first'] = null;
        let line = 0;

        try {
            for await (const text of lines) {
                line += 1;
                if (text.length === 0) {
                    continue;
                }
                const record = JSON.parse(text) as Row;
                if (record.publication_status !== 'published') {
                    continue;
                }
                assessed += 1;
                const assessment = assessIdentityEvidence(record.identity_evidence, {
                    identitySource: String(record.identity_source),
                });
                if (assessment.complete) {
                    continue;
                }
                incomplete += 1;
                if (first === null) {
                    first = {
                        sourceKey: String(record.food_source_key),
                        line,
                        codes: evidenceGapCodes(assessment),
                    };
                }
            }
        } finally {
            lines.close();
            stream.destroy();
        }

        committedEvidence = { assessed, incomplete, first };
    });

    it('states that every published record it ships meets the evidence floor', () => {
        // The measurement the two tests below rest on, asserted as a fact of the
        // artefact rather than left implicit: every published record is
        // assessed, and none carries a gap. Naming it separately is what makes a
        // regenerated release that reintroduced a null status fail HERE, with
        // the offending food and its gap codes in the suite's output, instead of
        // failing obscurely inside an 80-second load.
        const manifest = loadReleaseManifest(REAL_RELEASE);
        expect(committedEvidence.assessed).toBe(manifest.counts.published_foods ?? manifest.counts.foods);
        expect(committedEvidence.first).toBeNull();
        expect(committedEvidence.incomplete).toBe(0);
    });

    it('is internally consistent and verifies against its own manifest', async () => {
        const manifest = loadReleaseManifest(REAL_RELEASE);

        // The manifest's own consistency — five members, digests and counts that
        // agree with the per-file row counts — with no file read at all.
        expect(
            preflight({
                env: {},
                release: REAL_RELEASE,
                assertReleaseVersion,
                loadReleaseManifest,
                releaseFilePath,
                fileExists: (absolutePath: string) => fs.existsSync(absolutePath),
            }),
        ).toEqual([]);

        // And the bytes on disk, measured through the loader's own verification
        // on a path that writes nothing. The double load of 9,422 foods is
        // §0.9.1's operator check, not this suite's.
        const deps: LoadDeps = {
            db: prisma as unknown as LoadDb,
            runDb: prisma,
            release: REAL_RELEASE,
            manifest,
            releaseRoot: releaseDir(REAL_RELEASE),
            logger: silentLogger,
            now: () => NOW,
            dryRun: true,
        };

        const summary: LoadSummary = await runLoad(deps);

        expect(summary.verification.map((member) => member.file)).toEqual(RELEASE_MEMBERS);
        for (const member of summary.verification) {
            const declared = manifest.files.find((file) => file.path === member.file);
            expect(member.sha256).toBe(declared?.sha256);
            expect(member.bytes).toBe(declared?.bytes);
            expect(member.rowCount).toBe(declared?.row_count);
        }
        expect(summary.counts.foodsInserted).toBe(manifest.counts.foods);
        expect(summary.runId).toBeNull();
        expect(await tableCounts()).toEqual({
            foods: 0,
            aliases: 0,
            portions: 0,
            components: 0,
            validationRecords: 0,
            runs: 0,
        });
    });

    it('loads whole, matches its manifest row for row, and reports nothing to do on the rerun', async () => {
        // §0.9.1's gate, and the one claim a synthesized release cannot make:
        // the bytes committed to this repository reconcile against a database,
        // and doing it twice is a no-op. It reconciles every row of the release
        // twice and so dominates this suite's runtime — which is why it is one
        // test and not the vehicle for the behavioural claims above.
        const manifest = loadReleaseManifest(REAL_RELEASE);
        const deps: LoadDeps = {
            db: prisma as unknown as LoadDb,
            runDb: prisma,
            release: REAL_RELEASE,
            manifest,
            releaseRoot: releaseDir(REAL_RELEASE),
            logger: silentLogger,
            now: () => NOW,
            dryRun: false,
        };

        const first = await runLoad(deps);

        expect(first.activated).toBe(true);
        expect(first.countChecks.every((check) => check.ok)).toBe(true);
        expect(first.counts.foodsInserted).toBe(manifest.counts.foods);
        expect(first.counts.foodsUpdated).toBe(0);

        // Every member's declared row count, against the table it lands in —
        // read from the database rather than off the summary, so the manifest is
        // compared with what is stored and not with what the loader counted.
        const declaredRows = (member: string): number | undefined =>
            manifest.files.find((file) => file.path === member)?.row_count;

        expect(await tableCounts()).toEqual({
            foods: declaredRows(FOODS_FILE),
            aliases: declaredRows(ALIASES_FILE),
            portions: declaredRows(PORTIONS_FILE),
            components: declaredRows(COMPONENTS_FILE),
            validationRecords: declaredRows(VALIDATION_RECORDS_FILE),
            runs: 1,
        });
        // And against the `counts` block, which is the manifest's other
        // statement of the same totals.
        expect(await prisma.catalog_foods.count({ where: { publication_status: 'published' } })).toBe(
            manifest.counts.published_foods,
        );
        expect(await prisma.catalog_food_aliases.count()).toBe(manifest.counts.aliases);
        expect(await prisma.catalog_food_portions.count()).toBe(manifest.counts.portions);
        expect(await prisma.catalog_validation_records.count()).toBe(manifest.counts.validation_records);
        // The real release states no compositions at all: an empty member is
        // data, so it loads to an empty table rather than being skipped.
        expect(declaredRows(COMPONENTS_FILE)).toBe(0);
        expect(manifest.counts.components).toBe(0);

        // Exactly one default portion per food, each with a sourced gram weight:
        // an equal total and an equal distinct count together leave no food with
        // two defaults and none with zero.
        const foods = manifest.counts.foods;
        expect(await prisma.catalog_food_portions.count({ where: { is_default: true } })).toBe(foods);
        const [defaults] = await prisma.$queryRaw<{ owners: bigint }[]>`
            SELECT count(DISTINCT catalog_food_id) AS owners FROM catalog_food_portions WHERE is_default
        `;
        expect(Number(defaults.owners)).toBe(foods);
        expect(
            await prisma.catalog_food_portions.count({ where: { is_default: true, gram_weight: { lte: 0 } } }),
        ).toBe(0);
        // One validation record each, which the table's unique food reference
        // makes a statement about coverage rather than about duplication.
        expect(await prisma.catalog_validation_records.count()).toBe(foods);

        const active = await getActiveReleaseLoad(prisma);
        expect(active?.releaseId).toBe(REAL_RELEASE);
        expect(active?.runId).toBe(first.runId);
        const settled = await runRows();
        expect(settled).toHaveLength(1);
        expect(settled[0].status).toBe('succeeded');
        expect(settled[0].kind).toBe('release_load');
        expect(settled[0].manifest_version).toBe(manifest.release_id);

        // THE GATE: the same release again, reporting no insert and no update.
        const second = await runLoad(deps);

        expect(second.counts.foodsInserted).toBe(0);
        expect(second.counts.foodsUpdated).toBe(0);
        expect(second.counts.foodsUnchanged).toBe(foods);
        expect(second.counts.foodsRetired).toBe(0);
        expect(second.counts.aliasesWritten).toBe(0);
        expect(second.counts.aliasesRemoved).toBe(0);
        expect(second.counts.portionsWritten).toBe(0);
        expect(second.counts.portionsRemoved).toBe(0);
        expect(second.counts.componentsWritten).toBe(0);
        expect(second.counts.componentsRemoved).toBe(0);
        expect(second.counts.validationRecordsWritten).toBe(0);
        expect(second.activated).toBe(true);

        expect(await tableCounts()).toEqual({
            foods: declaredRows(FOODS_FILE),
            aliases: declaredRows(ALIASES_FILE),
            portions: declaredRows(PORTIONS_FILE),
            components: declaredRows(COMPONENTS_FILE),
            validationRecords: declaredRows(VALIDATION_RECORDS_FILE),
            runs: 2,
        });
        expect((await getActiveReleaseLoad(prisma))?.runId).toBe(second.runId);
    });
});
