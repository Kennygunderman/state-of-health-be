// The catalog search MECHANICS suite, run at corpus scale.
//
// ============================================================================
// NON-ACCEPTANCE EVIDENCE. NOTHING HERE IS A STATEMENT ABOUT SEARCH QUALITY.
// ============================================================================
//
// `data/meal-planning/fixtures/benchmark-synthetic-10k.json` carries an
// `acceptanceStatus` field for exactly this purpose, and this file mirrors it
// rather than paraphrasing it — the constant `NON_ACCEPTANCE_STANDING` below is
// asserted against the fixture's own words, so the two cannot drift apart, and
// the standing is printed once in the suite's reported output so a reader of a
// CI log learns it without opening either file.
//
// What a green run here proves is that the harness computes ranks, page
// sequences, totals and zero-result outcomes correctly over a corpus whose right
// answers are known BY CONSTRUCTION. It cannot prove that a person looking for a
// real food finds it, because every food in this corpus is invented: the part
// lists are nonsense words chosen to be disjoint from the accepted catalog, so a
// hit rate measured over them measures the arithmetic of the fixture and nothing
// about the release.
//
// SEARCH-QUALITY ACCEPTANCE IS THE OPERATOR RUN, and it is somewhere else:
// `npm run search:benchmark` (`scripts/search-benchmark.ts`) against the LOADED
// v1 catalog release, under the protocol AAP §0.9.3 sets out — one untimed
// warm-up pass, three timed passes, sequential, a single connection, in process
// — writing `data/meal-planning/reports/latest/benchmark-report.json` with the
// release checksum, the PostgreSQL version, the host and the cache state beside
// its numbers. The thresholds in `data/meal-planning/search-benchmark.v1.json`
// (top-3 >= 90%, top-10 >= 97%, zero-result <= 3%, p95 <= 150 ms) are asserted
// by that run ALONE. This suite asserts none of them, and the omission is
// deliberate rather than forgotten:
//
//  * A HIT RATE over invented foods is unrelated to the hit rate over real ones.
//    The ranks this file does assert are exact because they are derived from the
//    corpus composition rules, not measured — they say the ORDER is the declared
//    one, never that the order is useful.
//  * LATENCY IS NOT ASSERTED AT ALL. It is a property of the host, the
//    PostgreSQL build and the cache state; CI runners vary by an order of
//    magnitude, `shared_buffers` and cache warmth are uncontrolled here, and a
//    p95 gate inside a Jest suite is a flake generator that teaches people to
//    ignore red runs. §0.9.3 assigns latency to the operator run, which reports
//    its conditions alongside it. There is therefore no timing assertion below,
//    not even a generous one.
//
// ============================================================================
// WHAT IS PROVEN HERE, AND WHY IT NEEDS A DATABASE
// ============================================================================
//
// Three mechanics, each of which exists only in PostgreSQL and so cannot be
// reached by a unit test (Rule backend-architecture §11, the "Services/Prisma ->
// integration" row):
//
//  1. ONE ROW PER CANONICAL FOOD however many of its aliases matched, with the
//     food's rank decided by its BEST contribution — `MAX(rank) ... GROUP BY id`
//     over a four-branch `UNION ALL`, and `COUNT(DISTINCT id)` for the total.
//  2. A TOTAL AND PORTABLE ORDER — `ts_rank DESC, display_name COLLATE "C" ASC,
//     source_key COLLATE "C" ASC` — whose final key is the release-stable
//     `source_key` rather than a `gen_random_uuid()` primary key, because
//     §0.9.3 requires two independently loaded databases to produce identical
//     page sequences.
//  3. PAGINATION THAT NEITHER DUPLICATES NOR DROPS A ROW across pages, checked
//     as the fixture's `paginationCheck` invariant defines it.
//
// The scope guard, so nothing here is tested twice: the pure query parsing,
// normalisation and publication rules belong to
// `src/services/__tests__/catalog.logic.test.ts`; `parsePagination` /
// `parsePaginationStrict` / `toPaginationBlock` as FUNCTIONS belong to
// `src/utils/__tests__/pagination.test.ts`; the HTTP contract of the four
// catalog routes over a handful of rows belongs to
// `src/__tests__/api/catalog.test.ts`; and the collation and operator-class
// properties that need a differently-created database belong to
// `src/__tests__/api/catalogCollation.test.ts`. This file owns what only 10,000
// rows can show.
//
// ============================================================================
// TWO ASYMMETRIES THIS SUITE DEPENDS ON — DO NOT "FIX" EITHER
// ============================================================================
//
//  * `catalog.service.searchPublishedFoods` DELIBERATELY DOES NOT APPLY
//    `MAX_LIMIT`. The 50-row cap is the HTTP contract and is applied by
//    `parseCatalogSearchRequest` at the controller; the service is bounded only
//    by `rowWindowFor`'s `MAX_ROWS` (1,000). That gap is what makes the
//    fixture's `singlePageLimit` of 75 readable at all, and the fixture states
//    the consequence plainly: lowering it to 50 to make it routable would weaken
//    the invariant, and putting the reference through the endpoint cannot express
//    it. The pagination check below therefore reads its reference IN PROCESS
//    through the service and its pages OVER HTTP, which is the only combination
//    that expresses the invariant.
//  * THE ROUTE'S PAGE BLOCK IS PARSED, NOT CLAMPED. An earlier design read
//    `?page=` and `?limit=` through the lenient `parsePagination`, so `?page=0`
//    and `?limit=100` were rewritten into a valid request and answered `200 OK`
//    — input nobody sent, reported as success (CWE-20).
//    `parseCatalogSearchRequest` now validates `q` and the page block as one
//    verdict, so both are `400 invalid_request` with the field named. The cases
//    in "the request band of the route" assert the SHIPPED refusal rather than
//    the superseded clamp; a future change that reintroduced clamping would fail
//    them, which is the point.
//
// Every case below reads the corpus and writes nothing to it, so the corpus is
// expanded and inserted ONCE in `beforeAll` and truncated in `afterAll`. The two
// describes that need rows of their own — the contribution probes and the
// generated-column proof — create and remove them within their own scope, so no
// count asserted elsewhere can see them.

import { readFileSync } from 'fs';
import { join } from 'path';

import { prisma } from '../../prisma/client';
import { CatalogSearchResult, searchPublishedFoods } from '../../services/catalog.service';
import { CatalogSearchResponse, PaginationBlock } from '../../types/catalog';
import * as featureFlags from '../../utils/featureFlags';
import { makeUser } from '../setup/factories';
import { asUser, request } from '../setup/testApp';
import { truncateFeatureTables } from '../setup/testDb';

/* ---------------------------------------------------------------------------
 * The fixture contract
 *
 * Read with `readFileSync` and narrowed by the interfaces below rather than
 * imported as a module, which is the convention `compat.test.ts` and the script
 * suites already follow for `data/meal-planning/**`: the declared shape is then
 * part of this file and a fixture edited into a different shape fails HERE, with
 * a name, instead of somewhere downstream as `undefined`.
 * ------------------------------------------------------------------------- */

/** One base entry: the 25-member list whose cross product builds the corpus. */
interface FixtureBase {
    baseIndex: number;
    word: string;
    searchWord: string;
    aliasWord: string;
    food_state: string;
    category: string;
    food_group: string;
    nutrition_basis: string;
    density_g_per_ml: number | null;
    proteinTenths: number;
    carbsTenths: number;
    fatTenths: number;
    fiberTenths: number | null;
    cost_class: number;
    allergen_tags: string[];
    diet_tags: string[];
    is_common_dislike: boolean;
    portionAmount: number;
    portionUnit: string;
    portionGramWeight: number;
}

/** The constants every generated row carries, whatever its index. */
interface FixtureFixedColumns {
    identity_source: string;
    identity_status: string;
    nutrition_provenance: string;
    allergen_status: string;
    nutrition_version: number;
    metadata_version: number;
    imported_at: string;
}

/**
 * A row that is NOT part of the generated corpus and exists so the publication
 * filter is exercised rather than assumed. No alias and no portion row is
 * created for one, deliberately: search filters it out before the portion
 * lookup, so a regressed filter surfaces as `CatalogMappingError` for a food
 * with no default portion — loud instead of silent.
 */
interface FixtureUnpublishedRow {
    source_key: string;
    publication_status: string;
    canonical_name: string;
    display_name: string;
    search_text: string;
    category: string;
    food_state: string;
    food_group: string;
    calories: number;
    protein_g: number;
    carbs_g: number;
    fat_g: number;
    fiber_g: number | null;
    cost_class: number;
}

/**
 * One declared query. `expected` is the COMPLETE ordered match set when the set
 * holds 20 rows or fewer and the first five source keys of the ordered set
 * otherwise, so it is an ORDERING expectation and not only a membership one; an
 * empty `expected` means the query must return no rows at all.
 */
interface FixtureQuery {
    id: string;
    q: string;
    kind: string;
    expected: string[];
}

interface BenchmarkFixture {
    consumedBy: string;
    acceptanceStatus: string;
    expectedCorpusSize: number;
    expectedUnpublishedRowCount: number;
    expectedTableRowCount: number;
    expectedAliasRowCount: number;
    expectedPortionRowCount: number;
    expectationResolution: string;
    sourceKeyFormat: { generated: string; range: string[] };
    generation: {
        partListProduct: string;
        rowIndexRange: number[];
        fixedColumns: FixtureFixedColumns;
        bases: FixtureBase[];
        preparations: string[];
        descriptors: string[];
        sharedWordPair: { baseIndexes: number[]; word: string };
        workedExamples: {
            rowIndex: number;
            catalog_foods: Record<string, unknown>;
            catalog_food_aliases: { food_source_key: string; alias: string }[];
            catalog_food_portions: {
                food_source_key: string;
                description: string;
                amount: number;
                unit: string;
                gram_weight: number;
                is_default: boolean;
                source: string;
            }[];
        }[];
    };
    aliases: { curated: { food_source_key: string; alias: string }[] };
    unpublishedRows: { rows: FixtureUnpublishedRow[] };
    queries: FixtureQuery[];
    matchSetSizes: { sizes: Record<string, number> };
    paginationCheck: {
        queryIds: string[];
        limit: number;
        pages: number;
        singlePageLimit: number;
        referenceMode: string;
    };
    mechanicsExpectations: { standing: string; latency: string };
}

const FIXTURE_PATH = join(
    __dirname,
    '..',
    '..',
    '..',
    'data',
    'meal-planning',
    'fixtures',
    'benchmark-synthetic-10k.json',
);

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as BenchmarkFixture;

/**
 * The words the fixture's own standing begins with, and the words this file's
 * header begins with. Asserted against the fixture rather than restated as
 * prose, so a fixture edited to claim acceptance weight fails the suite it
 * belongs to.
 */
const NON_ACCEPTANCE_STANDING = 'NON-ACCEPTANCE EVIDENCE';

const ACCEPTANCE_RUNNER_COMMAND = 'npm run search:benchmark';

/* ---------------------------------------------------------------------------
 * Route and identity constants
 * ------------------------------------------------------------------------- */

const SEARCH_PATH = '/api/catalog/foods';

const FOODS_PATH = '/api/foods';

/**
 * The route's page band, written as literals rather than imported from
 * `utils/pagination.ts`. Importing the constant would make the assertion
 * tautological — it would compare the module with itself — and these two numbers
 * are the published contract of `GET /catalog/foods` (§0.5.2).
 */
const ROUTE_DEFAULT_LIMIT = 25;
const ROUTE_MAX_LIMIT = 50;

/** The identity every read is made with. The catalog is not scoped to it. */
const READER = { uid: 'benchmark-reader' };

/** A second identity, for the one case that proves the catalog is not per-user. */
const OTHER_READER = { uid: 'benchmark-other-reader' };

/* ---------------------------------------------------------------------------
 * Local helpers
 *
 * Kept in this file rather than promoted to a shared module in
 * `src/__tests__/api/`: Rule backend-architecture §7.1 is the anti-ceremony rule
 * — a helper earns a shared home when a second consumer exists, and the corpus
 * expander has exactly one.
 * ------------------------------------------------------------------------- */

/** The awaited supertest response, structurally, so supertest stays unimported. */
interface HttpOutcome {
    status: number;
    body: unknown;
}

/** One page of search results as the route answers it. */
interface SearchPage {
    status: number;
    items: CatalogSearchResponse['items'];
    pagination: PaginationBlock;
    body: unknown;
}

const getAsReader = async (
    path: string,
    query: Record<string, string | number> = {},
    identity = READER,
): Promise<HttpOutcome> => {
    const response = await asUser(request.get(path).query(query), identity);

    return { status: response.status, body: response.body };
};

/** One page over HTTP — the client's path, envelope included. */
const searchOverHttp = async (
    query: Record<string, string | number>,
    identity = READER,
): Promise<SearchPage> => {
    const { status, body } = await getAsReader(SEARCH_PATH, query, identity);
    const page = body as Partial<CatalogSearchResponse>;

    return {
        status,
        items: page.items ?? [],
        pagination: page.pagination ?? { page: 0, limit: 0, total: 0, totalPages: 0 },
        body,
    };
};

/**
 * One page in process — the same function `scripts/search-benchmark.ts` names as
 * its `measuredUnit`, so the mechanics asserted here are asserted over the code
 * path acceptance measures. Timed by nobody: see the header.
 */
const searchInProcess = (q: string, page: number, limit: number): Promise<CatalogSearchResult> =>
    searchPublishedFoods(q, page, limit);

const idsOf = (items: readonly { id: string }[]): string[] => items.map((item) => item.id);

/** The only two members an error body of this route may carry. */
const ERROR_BODY_KEYS: readonly string[] = ['error', 'details'];

/**
 * Text that would mean an internal detail reached the client: a stack frame, a
 * source location, a driver or ORM name, a PostgreSQL diagnostic.
 */
const INTERNAL_LEAK_PATTERN = /prisma|\bstack\b|node_modules|\.ts:\d+|\bat \/|invalid input syntax|sqlstate/i;

/**
 * Asserts a refusal is a machine code and a field list, and nothing more.
 *
 * Rule backend-architecture §4 requires a message rather than the raw `err`
 * object, and §8 requires the status and the code to be the contract — so the
 * assertion is on status, code and payload, never on an error class's identity,
 * which no client can observe.
 */
const expectFieldRefusal = (
    outcome: HttpOutcome,
    field: 'q' | 'page' | 'limit',
    code: string,
): void => {
    expect(outcome.status).toBe(400);

    const body = outcome.body as { error?: unknown; details?: unknown };

    expect(body.error).toBe('invalid_request');
    expect(Object.keys(body as Record<string, unknown>).sort()).toStrictEqual([...ERROR_BODY_KEYS].sort());
    expect(body.details).toContainEqual({ field, code });
    expect(JSON.stringify(outcome.body)).not.toMatch(INTERNAL_LEAK_PATTERN);
};

/* ---------------------------------------------------------------------------
 * Expanding the specification into a corpus
 *
 * The fixture declares three short part lists and the rules that turn a
 * zero-based row index into one `catalog_foods` row; this is the expander those
 * rules are written for (`expansionOwner`: it lives in the consuming suite, and
 * deliberately not in `scripts/search-benchmark.ts`, which must stay unable to
 * pass or fail on account of a synthetic fixture).
 *
 * EVERY FIELD IS A PURE FUNCTION OF THE ROW INDEX. No clock, no random source,
 * no environment, no database and no dependence on insertion order — which is
 * what makes two expansions byte-identical and an exact page sequence assertable
 * at all. Nutrients are integer TENTHS summed exactly and divided by ten once,
 * so the doubles are the same everywhere and calories are COMPUTED from the
 * macros at 4/4/9 rather than declared beside them.
 * ------------------------------------------------------------------------- */

const SOURCE_KEY_PREFIX = 'synthetic-bench10k:';

const SOURCE_KEY_DIGITS = 5;

const PUBLISHED = 'published';

const BASIS_AMOUNT = 100;

const PORTION_SOURCE = 'synthetic_fixture';

/** Grams per tenth-of-a-gram, applied once at the end of the arithmetic. */
const TENTHS_PER_GRAM = 10;

/** kcal per gram of protein, carbohydrate and fat — the 4/4/9 convention. */
const KCAL_PER_GRAM_PROTEIN = 4;
const KCAL_PER_GRAM_CARBS = 4;
const KCAL_PER_GRAM_FAT = 9;

/** The reject-tier energy bound of `coverage-plan.v1.json`, per 100 g. */
const MAX_KCAL_PER_BASIS = 900;

/** The macro-mass factor: the three macros may not exceed the basis by 2%. */
const MACRO_MASS_FACTOR = 1.02;

/** Tolerance for one division by ten, so a bound is not failed by float dust. */
const FLOAT_EPSILON = 1e-9;

/** The columns of one expanded `catalog_foods` row. No `id`, no `search_vector`, no `user_id`. */
interface ExpandedFood {
    source_key: string;
    canonical_name: string;
    display_name: string;
    category: string;
    food_state: string;
    food_group: string;
    identity_source: string;
    identity_status: string;
    nutrition_provenance: string;
    publication_status: string;
    nutrition_basis: string;
    basis_amount: number;
    calories: number;
    protein_g: number;
    carbs_g: number;
    fat_g: number;
    fiber_g: number | null;
    density_g_per_ml: number | null;
    allergen_tags: string[];
    allergen_status: string;
    diet_tags: string[];
    is_common_dislike: boolean;
    cost_class: number;
    nutrition_version: number;
    metadata_version: number;
    search_text: string;
    imported_at: Date;
}

interface ExpandedAlias {
    food_source_key: string;
    alias: string;
}

interface ExpandedPortion {
    food_source_key: string;
    description: string;
    amount: number;
    unit: string;
    gram_weight: number;
    is_default: boolean;
    source: string;
}

interface ExpandedCorpus {
    foods: ExpandedFood[];
    aliases: ExpandedAlias[];
    portions: ExpandedPortion[];
}

const sourceKeyFor = (rowIndex: number): string =>
    `${SOURCE_KEY_PREFIX}${String(rowIndex).padStart(SOURCE_KEY_DIGITS, '0')}`;

/** The release's own convention: canonical `pretzels`, display `Pretzels`. */
const toDisplayName = (canonicalName: string): string =>
    `${canonicalName.charAt(0).toUpperCase()}${canonicalName.slice(1)}`;

const tenthsToGrams = (tenths: number): number => tenths / TENTHS_PER_GRAM;

/**
 * Mixed radix, most significant digit first: one base contributes
 * `preparations.length * descriptors.length` rows and the descriptor is the
 * fastest-moving part. Derived from the part-list LENGTHS rather than from the
 * fixture's stated 400 and 20, so the decomposition and the product assertion
 * cannot disagree.
 */
const decomposeRowIndex = (
    rowIndex: number,
    preparationCount: number,
    descriptorCount: number,
): { baseIndex: number; preparationIndex: number; descriptorIndex: number } => {
    const rowsPerBase = preparationCount * descriptorCount;

    return {
        baseIndex: Math.floor(rowIndex / rowsPerBase),
        preparationIndex: Math.floor((rowIndex % rowsPerBase) / descriptorCount),
        descriptorIndex: rowIndex % descriptorCount,
    };
};

const expandCorpus = (spec: BenchmarkFixture): ExpandedCorpus => {
    const { bases, preparations, descriptors, fixedColumns } = spec.generation;
    const importedAt = new Date(fixedColumns.imported_at);
    const rowCount = bases.length * preparations.length * descriptors.length;

    const foods: ExpandedFood[] = [];
    const aliases: ExpandedAlias[] = [];
    const portions: ExpandedPortion[] = [];

    for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
        const { baseIndex, preparationIndex, descriptorIndex } = decomposeRowIndex(
            rowIndex,
            preparations.length,
            descriptors.length,
        );
        const base = bases[baseIndex];
        const preparation = preparations[preparationIndex];
        const descriptor = descriptors[descriptorIndex];

        const canonicalName = `${base.word} ${preparation} ${descriptor}`;
        const sourceKey = sourceKeyFor(rowIndex);

        const proteinTenths = base.proteinTenths + descriptorIndex;
        const carbsTenths = base.carbsTenths + preparationIndex;
        const caloriesTenths =
            KCAL_PER_GRAM_PROTEIN * proteinTenths +
            KCAL_PER_GRAM_CARBS * carbsTenths +
            KCAL_PER_GRAM_FAT * base.fatTenths;

        foods.push({
            source_key: sourceKey,
            canonical_name: canonicalName,
            display_name: toDisplayName(canonicalName),
            category: base.category,
            food_state: base.food_state,
            food_group: base.food_group,
            identity_source: fixedColumns.identity_source,
            identity_status: fixedColumns.identity_status,
            nutrition_provenance: fixedColumns.nutrition_provenance,
            publication_status: PUBLISHED,
            nutrition_basis: base.nutrition_basis,
            basis_amount: BASIS_AMOUNT,
            calories: tenthsToGrams(caloriesTenths),
            protein_g: tenthsToGrams(proteinTenths),
            carbs_g: tenthsToGrams(carbsTenths),
            fat_g: tenthsToGrams(base.fatTenths),
            fiber_g: base.fiberTenths === null ? null : tenthsToGrams(base.fiberTenths),
            density_g_per_ml: base.density_g_per_ml,
            allergen_tags: [...base.allergen_tags],
            allergen_status: fixedColumns.allergen_status,
            diet_tags: [...base.diet_tags],
            is_common_dislike: base.is_common_dislike,
            cost_class: base.cost_class,
            nutrition_version: fixedColumns.nutrition_version,
            metadata_version: fixedColumns.metadata_version,
            // Four tokens: the three the name carries plus one it does not, so
            // `searchWord` is reachable only through the food's own vector.
            search_text: `${canonicalName} ${base.searchWord}`,
            imported_at: importedAt,
        });

        aliases.push({
            food_source_key: sourceKey,
            // The alias word appears in no `search_text` anywhere in the corpus,
            // so this row is the only way its first token can be reached.
            alias: `${base.aliasWord} ${preparation} ${descriptor}`,
        });

        portions.push({
            food_source_key: sourceKey,
            description: `${base.portionAmount} ${base.portionUnit}`,
            amount: base.portionAmount,
            unit: base.portionUnit,
            gram_weight: base.portionGramWeight,
            is_default: true,
            source: PORTION_SOURCE,
        });
    }

    // The curated misspellings are additional and explicit, because a misspelling
    // is retrievable only once it has been curated into an alias.
    for (const curated of spec.aliases.curated) {
        aliases.push({ food_source_key: curated.food_source_key, alias: curated.alias });
    }

    // The four non-published rows, with the same fixed and null columns and no
    // alias and no portion of their own.
    for (const row of spec.unpublishedRows.rows) {
        foods.push({
            source_key: row.source_key,
            canonical_name: row.canonical_name,
            display_name: row.display_name,
            category: row.category,
            food_state: row.food_state,
            food_group: row.food_group,
            identity_source: fixedColumns.identity_source,
            identity_status: fixedColumns.identity_status,
            nutrition_provenance: fixedColumns.nutrition_provenance,
            publication_status: row.publication_status,
            nutrition_basis: 'per_100g',
            basis_amount: BASIS_AMOUNT,
            calories: row.calories,
            protein_g: row.protein_g,
            carbs_g: row.carbs_g,
            fat_g: row.fat_g,
            fiber_g: row.fiber_g,
            density_g_per_ml: null,
            allergen_tags: [],
            allergen_status: fixedColumns.allergen_status,
            diet_tags: [],
            is_common_dislike: false,
            cost_class: row.cost_class,
            nutrition_version: fixedColumns.nutrition_version,
            metadata_version: fixedColumns.metadata_version,
            search_text: row.search_text,
            imported_at: importedAt,
        });
    }

    return { foods, aliases, portions };
};

/* ---------------------------------------------------------------------------
 * The constraints block, checked before a row is inserted
 *
 * A generator that breaks one of these fails the LOAD with a database error
 * rather than an assertion, and a load error is much harder to read than a named
 * violation — so the whole set is evaluated first and the insert is refused if
 * anything is wrong. Returned as a list rather than thrown per clause so one run
 * reports every violation it found.
 * ------------------------------------------------------------------------- */

/** Columns the expansion must never emit, each for its own reason. */
const FORBIDDEN_COLUMNS: readonly string[] = ['id', 'search_vector', 'user_id'];

const countBy = <T>(values: readonly T[], key: (value: T) => string): Map<string, number> => {
    const counts = new Map<string, number>();

    for (const value of values) {
        const mapKey = key(value);
        counts.set(mapKey, (counts.get(mapKey) ?? 0) + 1);
    }

    return counts;
};

const duplicatesIn = <T>(values: readonly T[], key: (value: T) => string): string[] =>
    [...countBy(values, key).entries()].filter(([, count]) => count > 1).map(([mapKey]) => mapKey);

const collectConstraintViolations = (corpus: ExpandedCorpus, spec: BenchmarkFixture): string[] => {
    const violations: string[] = [];
    const { bases, preparations, descriptors } = spec.generation;
    const published = corpus.foods.filter((food) => food.publication_status === PUBLISHED);
    const bySourceKey = new Map(corpus.foods.map((food) => [food.source_key, food]));

    // The size, from the part lists up: a mis-edited part list fails here rather
    // than producing a corpus of the wrong size that weakens everything after it.
    const partListProduct = bases.length * preparations.length * descriptors.length;
    if (partListProduct !== spec.expectedCorpusSize) {
        violations.push(
            `part-list product ${bases.length} x ${preparations.length} x ${descriptors.length} = ` +
                `${partListProduct} is not expectedCorpusSize ${spec.expectedCorpusSize}`,
        );
    }
    if (published.length !== spec.expectedCorpusSize) {
        violations.push(`expanded ${published.length} published rows, expected ${spec.expectedCorpusSize}`);
    }
    if (corpus.foods.length - published.length !== spec.expectedUnpublishedRowCount) {
        violations.push(
            `expanded ${corpus.foods.length - published.length} non-published rows, expected ` +
                `${spec.expectedUnpublishedRowCount}`,
        );
    }
    if (corpus.foods.length !== spec.expectedTableRowCount) {
        violations.push(`expanded ${corpus.foods.length} rows, expected ${spec.expectedTableRowCount}`);
    }
    if (corpus.aliases.length !== spec.expectedAliasRowCount) {
        violations.push(`expanded ${corpus.aliases.length} aliases, expected ${spec.expectedAliasRowCount}`);
    }
    if (corpus.portions.length !== spec.expectedPortionRowCount) {
        violations.push(`expanded ${corpus.portions.length} portions, expected ${spec.expectedPortionRowCount}`);
    }

    // uniqueSourceKey: `catalog_foods_source_key_key`.
    const duplicateKeys = duplicatesIn(corpus.foods, (food) => food.source_key);
    if (duplicateKeys.length > 0) {
        violations.push(`duplicate source_key: ${duplicateKeys.slice(0, 5).join(', ')}`);
    }

    // uniquePublishedIdentity: `unique_published_catalog_food_identity`, which
    // constrains PUBLISHED rows only — the retired row repeats row 0 verbatim and
    // is legal for exactly that reason.
    const duplicateIdentities = duplicatesIn(published, (food) => `${food.canonical_name}|${food.food_state}`);
    if (duplicateIdentities.length > 0) {
        violations.push(
            `duplicate published (canonical_name, food_state): ${duplicateIdentities.slice(0, 5).join(', ')}`,
        );
    }

    // uniqueUsdaFdcId: the column is unique and every row leaves it null, which
    // PostgreSQL permits any number of. An invented id would both be a false
    // provenance claim and cap the corpus at one row per value.
    const withFdcId = corpus.foods.filter((food) => Object.keys(food).includes('usda_fdc_id'));
    if (withFdcId.length > 0) {
        violations.push(`${withFdcId.length} rows emit usda_fdc_id, which must stay unset`);
    }

    for (const food of corpus.foods) {
        // searchTextOnEveryRow: `search_vector` is generated from `search_text`,
        // so an empty one is a permanently unfindable row rather than a wrong one.
        if (food.search_text.trim().length === 0) {
            violations.push(`${food.source_key} has an empty search_text`);
        }

        // columnsNeverEmitted.
        const forbidden = Object.keys(food).filter((column) => FORBIDDEN_COLUMNS.includes(column));
        if (forbidden.length > 0) {
            violations.push(`${food.source_key} emits ${forbidden.join(', ')}`);
        }

        // coreNutrientsNotNull: only `fiber_g` may be unknown.
        const core = [food.calories, food.protein_g, food.carbs_g, food.fat_g];
        if (core.some((value) => !Number.isFinite(value))) {
            violations.push(`${food.source_key} has a non-finite core nutrient`);
        }
        if (food.fiber_g !== null && !Number.isFinite(food.fiber_g)) {
            violations.push(`${food.source_key} has a non-finite fiber_g`);
        }

        // nutritionBounds.
        if (food.calories > MAX_KCAL_PER_BASIS + FLOAT_EPSILON) {
            violations.push(`${food.source_key} states ${food.calories} kcal, above ${MAX_KCAL_PER_BASIS}`);
        }
        const macroMass = food.protein_g + food.carbs_g + food.fat_g;
        if (macroMass > food.basis_amount * MACRO_MASS_FACTOR + FLOAT_EPSILON) {
            violations.push(
                `${food.source_key} states ${macroMass} g of macros against a ${food.basis_amount} g basis`,
            );
        }
    }

    // referentialClosure, for the child rows...
    const duplicateAliases = duplicatesIn(corpus.aliases, (alias) => `${alias.food_source_key}|${alias.alias}`);
    if (duplicateAliases.length > 0) {
        violations.push(`duplicate (food, alias): ${duplicateAliases.slice(0, 5).join(', ')}`);
    }
    for (const alias of corpus.aliases) {
        if (!bySourceKey.has(alias.food_source_key)) {
            violations.push(`alias "${alias.alias}" names the unknown food ${alias.food_source_key}`);
        }
    }
    const duplicateDefaults = duplicatesIn(
        corpus.portions.filter((portion) => portion.is_default),
        (portion) => portion.food_source_key,
    );
    if (duplicateDefaults.length > 0) {
        violations.push(`more than one default portion for: ${duplicateDefaults.slice(0, 5).join(', ')}`);
    }
    for (const portion of corpus.portions) {
        if (!bySourceKey.has(portion.food_source_key)) {
            violations.push(`portion "${portion.description}" names the unknown food ${portion.food_source_key}`);
        }
        if (!(portion.gram_weight > 0)) {
            violations.push(`portion "${portion.description}" has a non-positive gram weight`);
        }
    }

    // ...and for the expectations, which must name published rows of this corpus.
    for (const query of spec.queries) {
        for (const sourceKey of query.expected) {
            const food = bySourceKey.get(sourceKey);
            if (food === undefined) {
                violations.push(`${query.id} expects the unknown food ${sourceKey}`);
            } else if (food.publication_status !== PUBLISHED) {
                violations.push(`${query.id} expects ${sourceKey}, which is ${food.publication_status}`);
            }
        }
    }

    return violations;
};

/* ---------------------------------------------------------------------------
 * Loading the corpus
 *
 * Inserted in bulk, in chunks: 10,000 single-row inserts would spend the whole
 * suite's budget on round trips, and one statement carrying every row would
 * exceed PostgreSQL's 65,535 bound parameters per statement. The chunk sizes
 * below keep each statement far inside that limit.
 * ------------------------------------------------------------------------- */

const FOOD_CHUNK_SIZE = 500;

const CHILD_CHUNK_SIZE = 2_000;

const chunk = <T>(values: readonly T[], size: number): T[][] => {
    const chunks: T[][] = [];

    for (let start = 0; start < values.length; start += size) {
        chunks.push(values.slice(start, start + size));
    }

    return chunks;
};

/**
 * Inserts the corpus and returns the `source_key` -> local id map every
 * expectation is resolved through.
 *
 * The ids are READ BACK rather than supplied, because the expansion emits no
 * `id`: `gen_random_uuid()` assigns one, primary keys therefore differ between
 * two loads of the same corpus, and that is precisely why the fixture names
 * every expected food by its portable `source_key` — the same resolution
 * `scripts/search-benchmark.ts` performs against a loaded release.
 */
const loadCorpus = async (corpus: ExpandedCorpus): Promise<Map<string, string>> => {
    for (const foods of chunk(corpus.foods, FOOD_CHUNK_SIZE)) {
        await prisma.catalog_foods.createMany({ data: foods });
    }

    const inserted = await prisma.catalog_foods.findMany({
        where: { source_key: { startsWith: SOURCE_KEY_PREFIX } },
        select: { id: true, source_key: true },
    });
    const idBySourceKey = new Map(inserted.map((food) => [food.source_key, food.id]));

    const aliasRows = corpus.aliases.map((alias) => ({
        catalog_food_id: idBySourceKey.get(alias.food_source_key) as string,
        alias: alias.alias,
    }));
    for (const aliases of chunk(aliasRows, CHILD_CHUNK_SIZE)) {
        await prisma.catalog_food_aliases.createMany({ data: aliases });
    }

    const portionRows = corpus.portions.map((portion) => ({
        catalog_food_id: idBySourceKey.get(portion.food_source_key) as string,
        description: portion.description,
        amount: portion.amount,
        unit: portion.unit,
        gram_weight: portion.gram_weight,
        is_default: portion.is_default,
        source: portion.source,
    }));
    for (const portions of chunk(portionRows, CHILD_CHUNK_SIZE)) {
        await prisma.catalog_food_portions.createMany({ data: portions });
    }

    return idBySourceKey;
};

/* ---------------------------------------------------------------------------
 * The corpus, expanded once and read by every case
 * ------------------------------------------------------------------------- */

/**
 * Generous on purpose. Ten thousand foods, ten thousand aliases and ten
 * thousand portions are inserted once, and the pagination check alone makes 64
 * searches over a corpus whose alias branches score every published alias per
 * query. The fixture's `expectedCorpusSize` is not negotiable — a smaller corpus
 * would make the three-page traversals partial and weaken the whole suite — so
 * when this suite is slow the timeout is what moves.
 */
jest.setTimeout(900_000);

const corpus = expandCorpus(fixture);

let idBySourceKey = new Map<string, string>();

const localId = (sourceKey: string): string => {
    const id = idBySourceKey.get(sourceKey);

    if (id === undefined) {
        throw new Error(`${sourceKey} was not loaded, so no expectation can be resolved through it`);
    }

    return id;
};

const localIds = (sourceKeys: readonly string[]): string[] => sourceKeys.map(localId);

const queryById = (id: string): FixtureQuery => {
    const query = fixture.queries.find((candidate) => candidate.id === id);

    if (query === undefined) {
        throw new Error(`the fixture defines no query ${id}, so the case written for it cannot run`);
    }

    return query;
};

/** The declared size of a query match set: what `COUNT(DISTINCT id)` must return. */
const declaredTotalOf = (id: string): number => {
    const total = fixture.matchSetSizes.sizes[id];

    if (total === undefined) {
        throw new Error(`the fixture declares no match-set size for ${id}`);
    }

    return total;
};

/**
 * `expected` is the COMPLETE ordered match set at or below this size and the
 * first five source keys of the ordered set above it.
 */
const COMPLETE_EXPECTATION_LIMIT = 20;

beforeAll(async () => {
    // Before a row is inserted, and before the database is even touched: an
    // insert that violates one of the fixture's constraints fails with a raw
    // constraint error naming an index, and the reader then debugs the fixture
    // instead of reading the violation.
    const violations = collectConstraintViolations(corpus, fixture);

    if (violations.length > 0) {
        throw new Error(
            `The expanded corpus violates ${violations.length} declared constraint(s), so it was not ` +
                `inserted:\n  - ${violations.join('\n  - ')}`,
        );
    }

    await truncateFeatureTables();
    idBySourceKey = await loadCorpus(corpus);

    // The one user row this suite needs, and the one thing it needs it for: the
    // envelope-parity case calls `GET /api/foods`, whose service seeds a starter
    // list for a caller that has none — and `foods.user_id` carries a foreign key
    // to `users`, so a caller with no row there would make that call a 500 about
    // referential integrity rather than a statement about the page block. The
    // catalog reads below need no user row at all, which is the point of the
    // §5.1 exception they rest on.
    await makeUser({ id: READER.uid });
});

afterAll(async () => {
    // `--runInBand` means every later suite pays for anything left behind, and a
    // stray 10,000-row corpus would corrupt `catalog.test.ts`'s counts.
    await truncateFeatureTables();
});

/* ---------------------------------------------------------------------------
 * The corpus itself
 * ------------------------------------------------------------------------- */

describe('the synthetic corpus this suite measures', () => {
    it('carries the fixture own non-acceptance standing, and names the run that does carry acceptance', () => {
        // The assertion is on the FIXTURE's words rather than on a restatement,
        // so the two halves of the cross-reference cannot drift: if this file's
        // header and the fixture ever disagreed about the standing, this fails.
        expect(fixture.acceptanceStatus).toContain(NON_ACCEPTANCE_STANDING);
        expect(fixture.acceptanceStatus).toContain(ACCEPTANCE_RUNNER_COMMAND);
        expect(fixture.mechanicsExpectations.standing).toContain('None is a quality threshold');
        expect(fixture.mechanicsExpectations.latency).toContain('Not asserted here');
        expect(fixture.consumedBy).toBe('src/__tests__/api/benchmark.test.ts');
        // Every expectation is a portable source_key, never a database id.
        expect(fixture.expectationResolution).toBe('sourceKey');
    });

    it('expands the three part lists to exactly expectedCorpusSize published foods', () => {
        const { bases, preparations, descriptors } = fixture.generation;

        expect(bases.length * preparations.length * descriptors.length).toBe(fixture.expectedCorpusSize);
        expect(fixture.generation.partListProduct).toContain(String(fixture.expectedCorpusSize));
        expect(corpus.foods.filter((food) => food.publication_status === PUBLISHED)).toHaveLength(
            fixture.expectedCorpusSize,
        );
        expect(corpus.foods).toHaveLength(fixture.expectedTableRowCount);
        expect(corpus.aliases).toHaveLength(fixture.expectedAliasRowCount);
        expect(corpus.portions).toHaveLength(fixture.expectedPortionRowCount);
    });

    it('violates none of the constraints the fixture declares', () => {
        // The same list `beforeAll` refuses to insert on, asserted as a case so
        // the clause that broke is named in the report rather than in a throw.
        expect(collectConstraintViolations(corpus, fixture)).toStrictEqual([]);
    });

    it('spans exactly the generated source-key range the fixture declares', () => {
        const generated = corpus.foods
            .filter((food) => food.publication_status === PUBLISHED)
            .map((food) => food.source_key);

        // Fixed-width padding, so lexicographic order equals numeric order: the
        // final ordering key of catalog search is `source_key ASC`, and without
        // it row 10 would page before row 2.
        expect([generated[0], generated[generated.length - 1]]).toStrictEqual(fixture.sourceKeyFormat.range);
        expect(fixture.generation.rowIndexRange).toStrictEqual([0, fixture.expectedCorpusSize - 1]);
    });

    it.each(fixture.generation.workedExamples.map((example) => [example.rowIndex, example] as const))(
        'reproduces the fixture worked example for row %s',
        (rowIndex, example) => {
            const sourceKey = sourceKeyFor(rowIndex);
            const food = corpus.foods.find((candidate) => candidate.source_key === sourceKey);
            const alias = corpus.aliases.filter((candidate) => candidate.food_source_key === sourceKey);
            const portion = corpus.portions.filter((candidate) => candidate.food_source_key === sourceKey);

            expect(food).toBeDefined();

            const expanded = food as ExpandedFood;
            const emitted = example.catalog_foods;

            // Column by column against the example's own printed answer, which
            // is what makes this expander checkable by hand: a derivation rule
            // read wrongly is named here, with its column, rather than surfacing
            // 400 rows later as a match set of the wrong size.
            for (const [column, value] of Object.entries(emitted)) {
                if (column === 'imported_at') {
                    expect(expanded.imported_at.toISOString()).toBe(value);
                    continue;
                }

                if (value === null && !(column in expanded)) {
                    // A column the expansion never emits: `usda_fdc_id` and the
                    // four false-provenance columns. Omitted from the INSERT,
                    // which is the same stored outcome as the declared null and
                    // the reason 10,004 rows coexist under a UNIQUE index.
                    continue;
                }

                expect({ [column]: expanded[column as keyof ExpandedFood] }).toStrictEqual({ [column]: value });
            }

            // The example prints the GENERATED alias; both example rows also
            // carry a curated misspelling, which is an additional row by design
            // — so the expansion is the example's alias followed by whatever the
            // curated list names for the same food, in that order.
            const curatedForFood = fixture.aliases.curated.filter(
                (candidate) => candidate.food_source_key === sourceKey,
            );

            expect(alias).toStrictEqual([...example.catalog_food_aliases, ...curatedForFood]);
            expect(portion).toStrictEqual(example.catalog_food_portions);
        },
    );

    it('derives a byte-identical corpus on a second expansion', () => {
        // Determinism is the property every page-sequence assertion rests on:
        // no clock, no random source, no environment, no insertion order.
        expect(JSON.stringify(expandCorpus(fixture))).toBe(JSON.stringify(corpus));
    });

    it('inserted exactly the rows it expanded, and nothing else', async () => {
        const [foods, published, aliases, portions, defaults] = await Promise.all([
            prisma.catalog_foods.count(),
            prisma.catalog_foods.count({ where: { publication_status: PUBLISHED } }),
            prisma.catalog_food_aliases.count(),
            prisma.catalog_food_portions.count(),
            prisma.catalog_food_portions.count({ where: { is_default: true } }),
        ]);

        expect(foods).toBe(fixture.expectedTableRowCount);
        expect(published).toBe(fixture.expectedCorpusSize);
        expect(aliases).toBe(fixture.expectedAliasRowCount);
        expect(portions).toBe(fixture.expectedPortionRowCount);
        expect(defaults).toBe(fixture.expectedPortionRowCount);
        expect(idBySourceKey.size).toBe(fixture.expectedTableRowCount);
    });
});

/* ---------------------------------------------------------------------------
 * Edge cases first (Rule backend-architecture §11): the rows search must NOT
 * return, the queries that must return nothing, and the requests it must refuse.
 * ------------------------------------------------------------------------- */

describe('the publication filter', () => {
    it.each(fixture.unpublishedRows.rows.map((row) => [row.publication_status, row] as const))(
        'never returns a %s row, searched by its own canonical name',
        async (_status, row) => {
            const { status, items, pagination } = await searchOverHttp({ q: row.canonical_name });

            expect(status).toBe(200);
            expect(idsOf(items)).not.toContain(localId(row.source_key));
            // `retired` is the subtle one: it WAS published, it keeps its primary
            // key so historical recipe and diary references still resolve, and it
            // leaves search. Its canonical name repeats row 0 verbatim, so the
            // total here is 1 for it and 0 for the three that never published.
            expect(pagination.total).toBe(row.publication_status === 'retired' ? 1 : 0);
        },
    );

    it('returns the published twin, exactly once, of the retired row that repeats it', async () => {
        const retired = fixture.unpublishedRows.rows.find((row) => row.publication_status === 'retired');
        const twinSourceKey = sourceKeyFor(0);

        expect(retired?.canonical_name).toBe(corpus.foods[0].canonical_name);

        const { items, pagination } = await searchOverHttp({ q: corpus.foods[0].canonical_name });

        // Two rows in the table share this canonical name and food state — legal
        // because `unique_published_catalog_food_identity` constrains published
        // rows only — and exactly one of them is findable.
        expect(pagination.total).toBe(1);
        expect(idsOf(items)).toStrictEqual([localId(twinSourceKey)]);
    });

    it('does not surface a non-published row through the prefix fallback either', async () => {
        // 'quarrow' heads the display_name of three non-published rows and of no
        // generated row, so a prefix match on the folded `display_name` would
        // find them if the filter ran anywhere but first.
        const { status, items, pagination } = await searchOverHttp({ q: 'quarrow' });

        expect(status).toBe(200);
        expect(items).toStrictEqual([]);
        expect(pagination.total).toBe(0);
    });
});

describe('a query that matches nothing', () => {
    const zeroResultQueries = fixture.queries.filter((query) => query.expected.length === 0);

    it('covers the three distinct causes the fixture records', () => {
        // A name only a non-published row carries, an uncurated misspelling, and
        // two tokens of the same part ANDed. Asserted so a fixture that lost one
        // of the causes cannot quietly reduce this describe to a single case.
        expect(zeroResultQueries.map((query) => query.id)).toStrictEqual([
            'q010',
            'q011',
            'q019',
            'q020',
            'q030',
        ]);
        expect(new Set(zeroResultQueries.map((query) => query.kind))).toStrictEqual(
            new Set(['exact', 'multi_word', 'misspelling']),
        );
    });

    it.each(zeroResultQueries.map((query) => [query.id, query] as const))(
        'answers %s with an empty page and never an error',
        async (_id, query) => {
            const { status, items, pagination, body } = await searchOverHttp({ q: query.q });

            // A decoded empty list is a distinct client state with its own copy
            // (§0.2.5), so it is a 200 — never a 404, never a 5xx — and the
            // envelope still has to be answerable: `totalPages: 0`, because the
            // client pages while `page < totalPages`.
            expect(status).toBe(200);
            expect(items).toStrictEqual([]);
            expect(pagination).toStrictEqual({ page: 1, limit: ROUTE_DEFAULT_LIMIT, total: 0, totalPages: 0 });
            expect(body).not.toHaveProperty('error');
        },
    );
});

describe('the request band of the route', () => {
    type RefusalCase = [string, Record<string, string | number>, 'q' | 'page' | 'limit', string];

    // THE PAGE BLOCK IS PARSED, NOT CLAMPED — see the second asymmetry in the
    // header. `parseCatalogSearchRequest` validates `?q=`, `?page=` and
    // `?limit=` as ONE verdict, so each case below is the refusal the shipped
    // parser gives, not the lenient clamp `parsePagination` would have applied.
    const refusals: RefusalCase[] = [
        ['an absent q', {}, 'q', 'required'],
        ['a blank q', { q: '   ' }, 'q', 'required'],
        ['a one-character q', { q: 'z' }, 'q', 'invalid_length'],
        ['a q of 61 characters', { q: 'z'.repeat(61) }, 'q', 'invalid_length'],
        ['a q carrying a control character', { q: 'zentil\u0000vanded' }, 'q', 'invalid_characters'],
        ['page 0', { q: 'zentil', page: 0 }, 'page', 'out_of_range'],
        ['a negative page', { q: 'zentil', page: -1 }, 'page', 'out_of_range'],
        ['a fractional page', { q: 'zentil', page: '2.7' }, 'page', 'invalid'],
        ['a non-numeric page', { q: 'zentil', page: 'abc' }, 'page', 'invalid'],
        ['limit 0', { q: 'zentil', limit: 0 }, 'limit', 'out_of_range'],
        ['a limit above the route cap', { q: 'zentil', limit: 100 }, 'limit', 'out_of_range'],
        ['a non-numeric limit', { q: 'zentil', limit: 'abc' }, 'limit', 'invalid'],
    ];

    it.each(refusals)('refuses %s', async (_case, query, field, code) => {
        const outcome = await getAsReader(SEARCH_PATH, query);

        expectFieldRefusal(outcome, field, code);
    });

    it('names every failing field of one request, so two mistakes cost one round trip', async () => {
        const outcome = await getAsReader(SEARCH_PATH, { q: 'z', limit: 100 });

        expect(outcome.status).toBe(400);
        expect((outcome.body as { details: unknown[] }).details).toStrictEqual([
            { field: 'q', code: 'invalid_length' },
            { field: 'limit', code: 'out_of_range' },
        ]);
    });

    const acceptances: [string, Record<string, string | number>][] = [
        ['the shortest accepted q', { q: 'ze' }],
        ['a q of exactly 60 characters', { q: 'z'.repeat(60) }],
        ['the route page cap', { q: 'zentil', limit: ROUTE_MAX_LIMIT }],
        ['the last page of a 400-row match set', { q: 'zentil', page: 16, limit: ROUTE_DEFAULT_LIMIT }],
    ];

    it.each(acceptances)('accepts %s', async (_case, query) => {
        const { status, pagination } = await searchOverHttp(query);

        expect(status).toBe(200);
        expect(pagination.limit).toBeLessThanOrEqual(ROUTE_MAX_LIMIT);
    });

    it('defaults the page block to page 1 and the route default limit', async () => {
        const { pagination } = await searchOverHttp({ q: 'zentil' });

        expect(pagination.page).toBe(1);
        expect(pagination.limit).toBe(ROUTE_DEFAULT_LIMIT);
    });

    it('refuses a caller with no identity, and answers no request with 403', async () => {
        // The router mounts after `app.use(authenticateFirebaseToken)`, so this
        // is a security posture rather than a detail. 401 and never 403: Rule
        // backend-architecture §1.5 keeps 403 out of the vocabulary entirely.
        const response = await request.get(SEARCH_PATH).query({ q: 'zentil' });

        expect(response.status).toBe(401);
        expect(response.status).not.toBe(403);
        expect(response.body).toStrictEqual({ error: 'No token provided' });
    });
});

/* ---------------------------------------------------------------------------
 * Mechanic 1 — one row per canonical food
 * ------------------------------------------------------------------------- */

describe('one row per canonical food, however many contributions matched', () => {
    /** The two rows that share a canonical name in two food states. */
    const SHARED_PAIR = [sourceKeyFor(9599), sourceKeyFor(9999)] as const;

    it('collapses a food matched through its own text and both of its aliases to one row', async () => {
        // 'zarphed grendic' is a preparation and a descriptor with no base word:
        // one row per base entry, so 25 rows and no more. For the two shared-word
        // rows the same two tokens are additionally carried by the generated
        // alias AND by the curated misspelling, so those foods match through
        // three separate documents each — five contributions once the two prefix
        // branches are counted — and must still occupy one slot apiece.
        const aliasesOfPair = await prisma.catalog_food_aliases.findMany({
            where: { catalog_food_id: { in: SHARED_PAIR.map(localId) } },
            select: { alias: true },
        });
        const matchingAliases = aliasesOfPair.filter(
            (row) => row.alias.includes('zarphed') && row.alias.includes('grendic'),
        );

        expect(matchingAliases).toHaveLength(4);
        for (const sourceKey of SHARED_PAIR) {
            const food = corpus.foods.find((candidate) => candidate.source_key === sourceKey) as ExpandedFood;
            expect(food.search_text).toContain('zarphed grendic');
        }

        const { items, pagination } = await searchOverHttp({
            q: 'zarphed grendic',
            limit: ROUTE_MAX_LIMIT,
        });
        const ids = idsOf(items);

        expect(pagination.total).toBe(fixture.matchSetSizes.sizes.q018);
        expect(ids).toHaveLength(25);
        expect(new Set(ids).size).toBe(25);
        for (const sourceKey of SHARED_PAIR) {
            expect(ids.filter((id) => id === localId(sourceKey))).toHaveLength(1);
        }
    });

    it('counts distinct foods rather than contributions in the total', async () => {
        // 'murnix' is an alias word: it appears in no `search_text` anywhere, so
        // every one of the 400 matching foods is reached through its alias row —
        // and through that row a second time via the alias prefix branch. An
        // un-aggregated count would report 800.
        const { items, pagination } = await searchOverHttp({ q: 'murnix' });
        const ids = idsOf(items);

        expect(pagination.total).toBe(fixture.matchSetSizes.sizes.q021);
        expect(pagination.total).toBe(400);
        expect(ids).toHaveLength(ROUTE_DEFAULT_LIMIT);
        expect(new Set(ids).size).toBe(ROUTE_DEFAULT_LIMIT);
    });

    it('reaches a food through a prefix its stemmed query cannot match', async () => {
        // The prefix branch is load-bearing rather than redundant: 'wendr' is not
        // a lexeme of any document in this corpus, so without the fallback a user
        // still typing would match nothing at all.
        const [{ stemmed_match: stemmedMatch }] = await prisma.$queryRaw<{ stemmed_match: boolean }[]>`
            SELECT (search_vector @@ plainto_tsquery('english', 'wendr')) AS stemmed_match
            FROM catalog_foods
            WHERE source_key = ${sourceKeyFor(9415)}
        `;

        expect(stemmedMatch).toBe(false);

        const { pagination } = await searchOverHttp({ q: 'wendr' });

        expect(pagination.total).toBe(fixture.matchSetSizes.sizes.q031);
        expect(pagination.total).toBe(800);
    });

    it('returns a food found by the stemmed branch and the prefix branch exactly once', async () => {
        // 'zentil' is BOTH a lexeme of its rows' `search_text` and the first word
        // of their names, so every one of the 400 matching foods contributes
        // through two branches at once.
        const [{ stemmed_match: stemmedMatch }] = await prisma.$queryRaw<{ stemmed_match: boolean }[]>`
            SELECT (search_vector @@ plainto_tsquery('english', 'zentil')) AS stemmed_match
            FROM catalog_foods
            WHERE source_key = ${sourceKeyFor(0)}
        `;

        expect(stemmedMatch).toBe(true);
        expect(corpus.foods[0].display_name.toLowerCase().startsWith('zentil')).toBe(true);

        const { items, pagination } = await searchOverHttp({ q: 'zentil', limit: ROUTE_MAX_LIMIT });
        const ids = idsOf(items);

        expect(pagination.total).toBe(400);
        expect(new Set(ids).size).toBe(ids.length);
    });
});

/* ---------------------------------------------------------------------------
 * Mechanic 1b — the rank a food takes from its BEST contribution
 *
 * The fixture corpus cannot show this half on its own, and that is a property of
 * the corpus rather than an oversight: every document carries each query term at
 * most once, so `ts_rank` returns the same value for every member of a match set
 * and the aggregation has no differing contributions to choose between. These six
 * rows are this suite's own, created and removed inside this describe so no count
 * asserted elsewhere can see them, and they exist to make the choice observable.
 * ------------------------------------------------------------------------- */

describe('the rank a food takes from its best contribution', () => {
    const PROBE_PREFIX = 'synthetic-bench10k-probe:';

    /** Invented, disjoint from every fixture vocabulary and from each other. */
    const ALIAS_RANK_TERM = 'wuxtaprobe';
    const DEDUPE_TERM = 'kribaprobe';
    const EVERY_BRANCH_TERM = 'delvaprobe';

    const ALIAS_RANKED = `${PROBE_PREFIX}alias-ranked`;
    const NAME_RANKED = `${PROBE_PREFIX}name-ranked`;
    const EVERY_BRANCH = `${PROBE_PREFIX}every-branch`;
    const DEDUPE_KEYS = [1, 2, 3].map((ordinal) => `${PROBE_PREFIX}dedupe-${ordinal}`);

    const probeIdBySourceKey = new Map<string, string>();

    const makeProbe = async (input: {
        sourceKey: string;
        canonicalName: string;
        searchText: string;
        aliases: string[];
    }): Promise<void> => {
        const created = await prisma.catalog_foods.create({
            data: {
                source_key: input.sourceKey,
                canonical_name: input.canonicalName,
                display_name: toDisplayName(input.canonicalName),
                category: 'other',
                food_state: 'raw',
                food_group: 'food_ingredient_other',
                identity_source: fixture.generation.fixedColumns.identity_source,
                identity_status: fixture.generation.fixedColumns.identity_status,
                nutrition_provenance: fixture.generation.fixedColumns.nutrition_provenance,
                publication_status: PUBLISHED,
                nutrition_basis: 'per_100g',
                basis_amount: BASIS_AMOUNT,
                calories: 100,
                protein_g: 5,
                carbs_g: 10,
                fat_g: 3,
                fiber_g: null,
                allergen_tags: [],
                allergen_status: fixture.generation.fixedColumns.allergen_status,
                diet_tags: [],
                is_common_dislike: false,
                cost_class: 1,
                nutrition_version: fixture.generation.fixedColumns.nutrition_version,
                metadata_version: fixture.generation.fixedColumns.metadata_version,
                search_text: input.searchText,
                imported_at: new Date(fixture.generation.fixedColumns.imported_at),
                // Every published food has a default portion; `mapCatalogFood`
                // raises `CatalogMappingError` without one, so a probe row
                // lacking it would fail this describe for the wrong reason.
                catalog_food_portions: {
                    create: {
                        description: '100 g',
                        amount: 100,
                        unit: 'g',
                        gram_weight: 100,
                        is_default: true,
                        source: PORTION_SOURCE,
                    },
                },
                catalog_food_aliases: {
                    create: input.aliases.map((alias) => ({ alias })),
                },
            },
            select: { id: true, source_key: true },
        });

        probeIdBySourceKey.set(created.source_key, created.id);
    };

    const probeId = (sourceKey: string): string => probeIdBySourceKey.get(sourceKey) as string;

    beforeAll(async () => {
        // The alias-ranked food carries the term THREE TIMES in one alias and not
        // at all in its own text, so its alias contribution outranks a single
        // occurrence; the name-ranked food carries it once in its own text. The
        // display names are chosen so that `display_name ASC` would order them
        // the other way round — which is what makes the observed order evidence
        // about rank rather than about the name.
        await makeProbe({
            sourceKey: ALIAS_RANKED,
            canonicalName: 'zzprobe alias ranked',
            searchText: 'zzprobe alias ranked',
            aliases: [`${ALIAS_RANK_TERM} ${ALIAS_RANK_TERM} ${ALIAS_RANK_TERM}`],
        });
        await makeProbe({
            sourceKey: NAME_RANKED,
            canonicalName: 'aaprobe name ranked',
            searchText: `aaprobe name ranked ${ALIAS_RANK_TERM}`,
            aliases: [],
        });

        for (const [index, sourceKey] of DEDUPE_KEYS.entries()) {
            await makeProbe({
                sourceKey,
                canonicalName: `ddprobe dedupe ${index + 1}`,
                searchText: `ddprobe dedupe ${index + 1}`,
                aliases: [`${DEDUPE_TERM} alpha`, `${DEDUPE_TERM} beta`, `${DEDUPE_TERM} gamma`],
            });
        }

        await makeProbe({
            sourceKey: EVERY_BRANCH,
            canonicalName: `${EVERY_BRANCH_TERM} carrier row`,
            searchText: `${EVERY_BRANCH_TERM} carrier row`,
            aliases: [`${EVERY_BRANCH_TERM} one`, `${EVERY_BRANCH_TERM} two`, `${EVERY_BRANCH_TERM} three`],
        });
    });

    afterAll(async () => {
        // Cascades to the probes' aliases and portions, so the corpus the rest of
        // the suite reads is exactly what `beforeAll` loaded.
        await prisma.catalog_foods.deleteMany({ where: { source_key: { startsWith: PROBE_PREFIX } } });
    });

    it('lets the best-matching alias decide the food rank, over the name of another food', async () => {
        const aliasRanked = await prisma.catalog_foods.findFirstOrThrow({
            where: { source_key: ALIAS_RANKED },
            select: { display_name: true },
        });
        const nameRanked = await prisma.catalog_foods.findFirstOrThrow({
            where: { source_key: NAME_RANKED },
            select: { display_name: true },
        });

        // Byte order, because the service pins `COLLATE "C"`: the name-ranked
        // food sorts FIRST on name, so if it comes second, rank is why.
        expect(
            Buffer.compare(
                Buffer.from(nameRanked.display_name, 'utf8'),
                Buffer.from(aliasRanked.display_name, 'utf8'),
            ),
        ).toBe(-1);

        const { items, pagination } = await searchOverHttp({ q: ALIAS_RANK_TERM });

        expect(pagination.total).toBe(2);
        expect(idsOf(items)).toStrictEqual([probeId(ALIAS_RANKED), probeId(NAME_RANKED)]);
    });

    it('reports three foods reached through nine aliases as three', async () => {
        const aliasRows = await prisma.catalog_food_aliases.count({
            where: { alias: { startsWith: DEDUPE_TERM } },
        });

        expect(aliasRows).toBe(9);

        const { items, pagination } = await searchOverHttp({ q: DEDUPE_TERM });

        // `COUNT(DISTINCT id)`, not a count of contributions: a total of 9 would
        // make `totalPages` lie and the client's infinite scroll spin.
        expect(pagination.total).toBe(3);
        expect(new Set(idsOf(items))).toStrictEqual(new Set(DEDUPE_KEYS.map(probeId)));
    });

    it('collapses a food matched by its own name and by every one of its aliases to one row', async () => {
        const { items, pagination } = await searchOverHttp({ q: EVERY_BRANCH_TERM });

        // Eight contributions for one food, every arm of `catalogMatchSet`
        // firing: its own name vector and name prefix, then a vector and a
        // prefix for each of its three aliases. `COUNT(DISTINCT id)` is why the
        // page still holds one row.
        expect(pagination.total).toBe(1);
        expect(idsOf(items)).toStrictEqual([probeId(EVERY_BRANCH)]);
    });
});

/* ---------------------------------------------------------------------------
 * Mechanic 2 — a total and portable order
 * ------------------------------------------------------------------------- */

describe('the order of a page', () => {
    // The order is `rank DESC, display_name COLLATE "C" ASC, source_key COLLATE
    // "C" ASC`, and the three keys are asserted where each one can be OBSERVED:
    // the precedence of `rank` over the name belongs to the probe describe above,
    // which is the only place in this corpus where two foods of one match set
    // carry different ranks, and the two name keys belong here, where every rank
    // ties by construction and nothing else can explain the sequence.

    /** Byte comparison, which is what `COLLATE "C"` sorts by. */
    const byteCompare = (left: string, right: string): number =>
        Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));

    const orderKeysFor = async (ids: readonly string[]): Promise<{ display_name: string; source_key: string }[]> => {
        const rows = await prisma.catalog_foods.findMany({
            where: { id: { in: [...ids] } },
            select: { id: true, display_name: true, source_key: true },
        });
        const byId = new Map(rows.map((row) => [row.id, row]));

        // Re-ordered into the sequence the page returned, not the order the
        // lookup happened to answer in.
        return ids.map((id) => {
            const row = byId.get(id);

            if (row === undefined) {
                throw new Error(`the page returned ${id}, which is not a row of this corpus`);
            }

            return { display_name: row.display_name, source_key: row.source_key };
        });
    };

    it('breaks a tie on rank by display_name, ascending under byte order', async () => {
        // One preparation word across every base entry: the widest shape that is
        // not a base word, and the only one whose first page MIXES bases — so an
        // order that grouped by insertion or by base would show up here first.
        const preparationQuery = queryById('q006');
        const { items } = await searchOverHttp({ q: preparationQuery.q });
        const keys = await orderKeysFor(idsOf(items));

        expect(preparationQuery.q).toBe('vanded');
        expect(idsOf(items).slice(0, 5)).toStrictEqual(localIds(preparationQuery.expected));

        for (let index = 1; index < keys.length; index += 1) {
            // Non-decreasing, and the equal case is settled by the next key.
            expect(byteCompare(keys[index - 1].display_name, keys[index].display_name)).toBeLessThanOrEqual(0);
        }
    });

    it('breaks a tie on rank AND display_name by the portable source_key', async () => {
        const pair = queryById('q002');
        const [first, second] = pair.expected.map(
            (sourceKey) => corpus.foods.find((food) => food.source_key === sourceKey) as ExpandedFood,
        );

        // The two rows of the shared-word pair are the same food name in two
        // states, so nothing above `source_key` can separate them.
        expect(first.display_name).toBe(second.display_name);
        expect(first.food_state).not.toBe(second.food_state);
        expect(byteCompare(first.source_key, second.source_key)).toBe(-1);

        const { items, pagination } = await searchOverHttp({ q: pair.q });

        expect(pagination.total).toBe(2);
        expect(idsOf(items)).toStrictEqual(localIds(pair.expected));
    });

    it('orders every same-named pair of a wide match set by source_key, not by primary key', async () => {
        // 800 rows and 400 same-named pairs, reached only through the prefix
        // branch: the sharpest available test of the final key. The pairs are
        // what make it sharp. Prefix coverage is measured against the matched
        // text, so two rows carrying the SAME `display_name` necessarily carry
        // the same coverage, tie again on the name, and leave `source_key` as
        // the only key that can separate them. (The 800 rows as a whole do not
        // tie — coverage puts the shortest names first — which is why this case
        // compares consecutive rows of equal name rather than the whole page.)
        // A ranking that fell back to the `gen_random_uuid()` primary key would
        // reorder these pairs on every load, which is exactly what §0.9.3
        // forbids.
        const { items } = await searchOverHttp({ q: 'wendr', limit: ROUTE_MAX_LIMIT });
        const keys = await orderKeysFor(idsOf(items));
        const samePairs = keys.filter(
            (key, index) => index > 0 && keys[index - 1].display_name === key.display_name,
        );

        expect(samePairs.length).toBeGreaterThan(0);
        for (let index = 1; index < keys.length; index += 1) {
            const previous = keys[index - 1];
            const current = keys[index];

            if (previous.display_name === current.display_name) {
                expect(byteCompare(previous.source_key, current.source_key)).toBe(-1);
            }
        }
    });

    it('returns a byte-identical id sequence when the same query is repeated', async () => {
        // Without an explicit total order PostgreSQL is free to vary row order
        // between executions of one statement, so repetition is the check.
        //
        // WITHIN one load, because that is the strongest claim ids can carry:
        // `gen_random_uuid()` assigns a different primary key on every load, so
        // the sequence that is stable ACROSS loads is the sequence of source
        // keys — which is what the expectation below compares, and what two
        // consecutive runs of this suite over two independent loads demonstrate.
        const runs = await Promise.all([
            searchOverHttp({ q: 'gilvic' }),
            searchOverHttp({ q: 'gilvic' }),
            searchOverHttp({ q: 'gilvic' }),
        ]);
        const sequences = runs.map((run) => idsOf(run.items));

        expect(sequences[1]).toStrictEqual(sequences[0]);
        expect(sequences[2]).toStrictEqual(sequences[0]);
        expect(sequences[0].slice(0, 5)).toStrictEqual(localIds(queryById('q007').expected));
    });

    it('slices the same global order whatever the page size', async () => {
        const wide = await searchInProcess('zentil', 1, fixture.paginationCheck.singlePageLimit);
        const narrow = await searchOverHttp({ q: 'zentil', limit: ROUTE_DEFAULT_LIMIT });

        expect(idsOf(wide.items).slice(0, ROUTE_DEFAULT_LIMIT)).toStrictEqual(idsOf(narrow.items));
    });
});

/* ---------------------------------------------------------------------------
 * The declared query set
 *
 * Each of the six kinds the acceptance contract defines, mapped onto this corpus:
 * `exact` a stored name or token, `plural` a token the english stemmer folds,
 * `misspelling` a token that exists only in a curated alias, `alias` a name the
 * food answers to through its alias row or through its own `search_text`,
 * `multi_word` tokens the tsquery ANDs, and `partial` a prefix that is no lexeme.
 * ------------------------------------------------------------------------- */

describe('the declared query set', () => {
    /** Where the head of each query ordered match set was found, for the log below. */
    interface MechanicsHit {
        id: string;
        kind: string;
        total: number;
        headPosition: number | null;
    }

    const mechanicsHits: MechanicsHit[] = [];

    it('declares the six kinds the acceptance contract defines, and a size for every query', () => {
        expect(new Set(fixture.queries.map((query) => query.kind))).toStrictEqual(
            new Set(['exact', 'plural', 'misspelling', 'alias', 'multi_word', 'partial']),
        );
        expect(Object.keys(fixture.matchSetSizes.sizes).sort()).toStrictEqual(
            fixture.queries.map((query) => query.id).sort(),
        );
    });

    it.each(fixture.queries.map((query) => [`${query.id} (${query.kind})`, query] as const))(
        'answers %s exactly as the fixture declares',
        async (_label, query) => {
            const declaredTotal = declaredTotalOf(query.id);
            const { status, items, pagination } = await searchOverHttp({ q: query.q });
            const ids = idsOf(items);
            const expectedIds = localIds(query.expected);

            expect(status).toBe(200);
            // The size of the whole match set, checkable by hand against
            // `matchSetArithmetic` — a corpus change that silently widened a set
            // fails here rather than passing quietly.
            expect(pagination.total).toBe(declaredTotal);

            if (declaredTotal === 0) {
                expect(ids).toStrictEqual([]);
            } else if (declaredTotal <= COMPLETE_EXPECTATION_LIMIT) {
                // The complete ordered match set, so this is an ordering
                // assertion and not only a membership one.
                expect(ids).toStrictEqual(expectedIds);
            } else {
                expect(ids.slice(0, expectedIds.length)).toStrictEqual(expectedIds);
            }

            mechanicsHits.push({
                id: query.id,
                kind: query.kind,
                total: pagination.total,
                headPosition: expectedIds.length === 0 ? null : ids.indexOf(expectedIds[0]),
            });
        },
    );

    it('reports its own standing, and reports no quality figure as acceptance', () => {
        // Depends on the cases above having run, which is why it is declared
        // after them: Jest executes a describe body in order.
        expect(mechanicsHits).toHaveLength(fixture.queries.length);

        const scored = mechanicsHits.filter((hit) => hit.total > 0);
        const headOfSet = scored.filter((hit) => hit.headPosition === 0);

        // Not a hit rate: `expected` IS the ordered prefix of each match set, so
        // this counts the arithmetic of the fixture rather than the usefulness of
        // the ranking. It is asserted because it is structural, and it is
        // reported with its standing attached so a reader of a CI log cannot
        // mistake it for the acceptance figure.
        expect(headOfSet).toHaveLength(scored.length);

        // eslint-disable-next-line no-console -- the standing has to reach the run's output, not only this file
        console.info(
            `[benchmark.test.ts] ${NON_ACCEPTANCE_STANDING}: mechanics over ${fixture.expectedCorpusSize} ` +
                `invented foods. ${scored.length} of ${mechanicsHits.length} declared queries have a non-empty ` +
                `match set and every one returned its declared head first; ${
                    mechanicsHits.length - scored.length
                } are zero-result by construction. No relevance or latency threshold is evaluated here — ` +
                `search-quality acceptance is "${ACCEPTANCE_RUNNER_COMMAND}" against the loaded v1 release.`,
        );
    });
});

/* ---------------------------------------------------------------------------
 * Mechanic 3 — pagination that neither duplicates nor drops a row
 * ------------------------------------------------------------------------- */

describe('the pagination check the fixture declares', () => {
    const spec = fixture.paginationCheck;

    it('names only queries the set defines, each wide enough to fill every page', () => {
        expect(spec.referenceMode).toBe('in_process');
        expect(spec.pages * spec.limit).toBe(spec.singlePageLimit);

        for (const id of spec.queryIds) {
            // A partial traversal would make the invariant pass vacuously.
            expect(declaredTotalOf(queryById(id).id)).toBeGreaterThanOrEqual(spec.singlePageLimit);
        }
    });

    it('cannot read the wide reference over HTTP, which is why it is read in process', async () => {
        // The asymmetry this suite depends on, in one case. The route validates
        // `limit` as 1..50, so the 75-row reference is a 400 there; the service
        // applies no route cap, so the same 75 rows read in process. Lowering
        // `singlePageLimit` to 50 to make it routable would weaken the invariant
        // below, and putting the reference through the endpoint cannot express it.
        const overHttp = await getAsReader(SEARCH_PATH, { q: 'zentil', limit: spec.singlePageLimit });

        expectFieldRefusal(overHttp, 'limit', 'out_of_range');

        const inProcess = await searchInProcess('zentil', 1, spec.singlePageLimit);

        expect(inProcess.items).toHaveLength(spec.singlePageLimit);
    });

    it.each(spec.queryIds.map((id) => [id] as const))(
        'pages %s with no duplicate and no gap',
        async (id) => {
            const query = queryById(id);
            const declaredTotal = declaredTotalOf(id);
            const pagedIds: string[] = [];
            const totals: number[] = [];

            for (let page = 1; page <= spec.pages; page += 1) {
                const { status, items, pagination } = await searchOverHttp({
                    q: query.q,
                    page,
                    limit: spec.limit,
                });

                expect(status).toBe(200);
                expect(items).toHaveLength(spec.limit);
                expect(pagination.page).toBe(page);
                expect(pagination.limit).toBe(spec.limit);
                expect(pagination.totalPages).toBe(Math.ceil(declaredTotal / spec.limit));

                totals.push(pagination.total);
                pagedIds.push(...idsOf(items));
            }

            // The reference: one wide fetch of the same query, in process.
            const reference = await searchInProcess(query.q, 1, spec.singlePageLimit);
            const referenceIds = idsOf(reference.items);

            expect(reference.total).toBe(declaredTotal);
            expect(referenceIds).toHaveLength(Math.min(spec.singlePageLimit, reference.total));
            // Same ids, same order: no gap, and nothing reordered between pages.
            expect(pagedIds).toStrictEqual(referenceIds);
            // And nothing served twice, which a lost tiebreaker would produce.
            expect(new Set(pagedIds).size).toBe(pagedIds.length);
            // One total for one query, whichever page reported it.
            expect(totals).toStrictEqual(Array(spec.pages).fill(declaredTotal));
        },
    );
});

/* ---------------------------------------------------------------------------
 * The page envelope the client pages on
 * ------------------------------------------------------------------------- */

describe('the page envelope', () => {
    const envelopes: [string, string, number, number][] = [
        ['a 400-row match set', 'q003', 400, 16],
        ['an 800-row match set', 'q005', 800, 32],
        ['a 500-row match set', 'q006', 500, 20],
    ];

    it.each(envelopes)('reports %s as its total and page count', async (_case, id, total, totalPages) => {
        expect(declaredTotalOf(id)).toBe(total);

        const { pagination } = await searchOverHttp({ q: queryById(id).q });

        expect(pagination).toStrictEqual({ page: 1, limit: ROUTE_DEFAULT_LIMIT, total, totalPages });
    });

    it('answers a page beyond the last with an empty list and the same total', async () => {
        const query = queryById('q003');
        const beyond = Math.ceil(declaredTotalOf('q003') / ROUTE_DEFAULT_LIMIT) + 1;

        const { status, items, pagination } = await searchOverHttp({ q: query.q, page: beyond });

        // Not a 404 and not an error: the client has simply paged past the end.
        expect(status).toBe(200);
        expect(items).toStrictEqual([]);
        expect(pagination).toStrictEqual({
            page: beyond,
            limit: ROUTE_DEFAULT_LIMIT,
            total: declaredTotalOf('q003'),
            totalPages: 16,
        });
    });

    it('carries the same block shape GET /api/foods already returns', async () => {
        // One envelope for both list endpoints, because the client's infinite
        // query decodes ONE shape for both (Rule backend-architecture §6): a
        // divergence here breaks catalog paging silently rather than loudly.
        const catalog = await searchOverHttp({ q: 'zentil' });
        const foods = await getAsReader(FOODS_PATH, {});
        const foodsBlock = (foods.body as { pagination?: Record<string, unknown> }).pagination ?? {};

        expect(foods.status).toBe(200);
        expect(Object.keys(catalog.pagination).sort()).toStrictEqual(['limit', 'page', 'total', 'totalPages']);
        expect(Object.keys(foodsBlock).sort()).toStrictEqual(Object.keys(catalog.pagination).sort());
    });
});

/* ---------------------------------------------------------------------------
 * The schema the search rests on
 *
 * At 10,000 rows a sequential scan still answers correctly, so an index that
 * silently failed to be created would be invisible to every case above — and the
 * generated column is the one construct Prisma datamodel cannot express, so it
 * is hand-written in the migration and worth asserting directly.
 * ------------------------------------------------------------------------- */

describe('the schema the search rests on', () => {
    interface IndexRow {
        indexname: string;
        indexdef: string;
    }

    const indexesOf = (table: string): Promise<IndexRow[]> =>
        prisma.$queryRaw<IndexRow[]>`
            SELECT indexname, indexdef
            FROM pg_indexes
            WHERE schemaname = current_schema() AND tablename = ${table}
        `;

    it('carries the GIN index the full-text branch reads', async () => {
        const indexes = await indexesOf('catalog_foods');
        const gin = indexes.find((index) => index.indexname === 'idx_catalog_foods_search_vector');

        expect(gin).toBeDefined();
        expect((gin as IndexRow).indexdef).toMatch(/USING gin \("?search_vector"?\)/i);
    });

    it('carries the GIN index the alias full-text branch reads', async () => {
        const indexes = await indexesOf('catalog_food_aliases');
        const gin = indexes.find(
            (index) => index.indexname === 'idx_catalog_food_aliases_search_vector',
        );

        // Without this index the alias full-text branch has no way to answer
        // `search_vector @@ tsq` except by reading every alias row, which is a
        // fixed floor under EVERY search including one that matches nothing:
        // measured on the v1 release, a zero-result query cost 63 ms of that
        // floor alone and fell to 3 ms once the index existed.
        expect(gin).toBeDefined();
        expect((gin as IndexRow).indexdef).toMatch(/USING gin \("?search_vector"?\)/i);
    });

    it('carries the ASCII-fold index the alias prefix branch needs', async () => {
        const indexes = await indexesOf('catalog_food_aliases');
        const prefix = indexes.find((index) => index.indexname === 'idx_catalog_food_aliases_fold_alias');

        expect(prefix).toBeDefined();
        // `text_pattern_ops` is what lets a left-anchored LIKE become a range
        // scan; under the default operator class the planner cannot use the
        // index at all. The indexed expression is the ASCII fold both sides of
        // the comparison now go through — `lower()` resolved through the
        // collation and the JavaScript side did not, so a partial query over a
        // non-ASCII capital matched on some servers only.
        // `catalogCollation.test.ts` owns the plan-level proof.
        expect((prefix as IndexRow).indexdef).toMatch(/translate\(alias, .*\) text_pattern_ops/i);
    });

    it('constrains published identity only, which is why the retired twin is legal', async () => {
        const indexes = await indexesOf('catalog_foods');
        const identity = indexes.find(
            (index) => index.indexname === 'unique_published_catalog_food_identity',
        );

        expect(identity).toBeDefined();
        expect((identity as IndexRow).indexdef).toMatch(/WHERE \(publication_status = 'published'/i);
    });

    it('populates search_vector from search_text alone, and refuses a direct write to it', async () => {
        const probeKey = `${SOURCE_KEY_PREFIX}generated-column-probe`;
        const probeTerm = 'vectorprobeword';

        try {
            // Written through the Prisma client, which cannot even NAME the
            // column: an `Unsupported("tsvector")` field is absent from the
            // generated create input, so the only thing this row supplies is
            // `search_text`. The row is a candidate, so no search over the
            // corpus can see it.
            await prisma.catalog_foods.create({
                data: {
                    source_key: probeKey,
                    canonical_name: `${probeTerm} candidate row`,
                    display_name: toDisplayName(`${probeTerm} candidate row`),
                    category: 'other',
                    food_state: 'raw',
                    food_group: 'food_ingredient_other',
                    identity_source: fixture.generation.fixedColumns.identity_source,
                    identity_status: fixture.generation.fixedColumns.identity_status,
                    nutrition_provenance: fixture.generation.fixedColumns.nutrition_provenance,
                    publication_status: 'candidate',
                    nutrition_basis: 'per_100g',
                    basis_amount: BASIS_AMOUNT,
                    calories: 100,
                    protein_g: 5,
                    carbs_g: 10,
                    fat_g: 3,
                    allergen_tags: [],
                    allergen_status: fixture.generation.fixedColumns.allergen_status,
                    diet_tags: [],
                    is_common_dislike: false,
                    cost_class: 1,
                    nutrition_version: fixture.generation.fixedColumns.nutrition_version,
                    metadata_version: fixture.generation.fixedColumns.metadata_version,
                    search_text: `${probeTerm} candidate row`,
                },
            });

            const [stored] = await prisma.$queryRaw<{ populated: boolean; matches: boolean }[]>`
                SELECT
                    (search_vector IS NOT NULL) AS populated,
                    (search_vector @@ plainto_tsquery('english', ${probeTerm})) AS matches
                FROM catalog_foods
                WHERE source_key = ${probeKey}
            `;

            expect(stored.populated).toBe(true);
            expect(stored.matches).toBe(true);

            // And the other half: PostgreSQL owns the column, so a statement that
            // supplies it is rejected rather than honoured.
            await expect(
                prisma.$executeRawUnsafe(
                    'UPDATE catalog_foods SET search_vector = to_tsvector(\'english\', \'overwritten\') ' +
                        'WHERE source_key = $1',
                    probeKey,
                ),
            ).rejects.toThrow(/non-DEFAULT value into column|generated column/i);

            const [afterAttempt] = await prisma.$queryRaw<{ matches: boolean }[]>`
                SELECT (search_vector @@ plainto_tsquery('english', ${probeTerm})) AS matches
                FROM catalog_foods
                WHERE source_key = ${probeKey}
            `;

            expect(afterAttempt.matches).toBe(true);

            // The same refusal on the INSERT path, which is the one the corpus
            // loader would hit if the expansion ever emitted the column.
            await expect(
                prisma.$executeRawUnsafe(
                    'INSERT INTO catalog_foods (source_key, canonical_name, display_name, category, ' +
                        'food_state, identity_source, identity_status, nutrition_provenance, ' +
                        'nutrition_version, metadata_version, nutrition_basis, basis_amount, ' +
                        'publication_status, allergen_status, food_group, cost_class, search_text, ' +
                        'search_vector) VALUES ($1, $2, $2, \'other\', \'raw\', \'ai_generated\', ' +
                        '\'unsourced\', \'ai_estimated\', 1, 1, \'per_100g\', 100, \'candidate\', ' +
                        '\'unknown\', \'food_ingredient_other\', 1, $2, to_tsvector(\'english\', $2))',
                    `${probeKey}-insert`,
                    `${probeTerm} insert attempt`,
                ),
            ).rejects.toThrow(/non-DEFAULT value into column|generated column/i);

            expect(await prisma.catalog_foods.count({ where: { source_key: `${probeKey}-insert` } })).toBe(0);
        } finally {
            // Removed here rather than in an `afterAll`, so no later case can see
            // a row the corpus counts do not include.
            await prisma.catalog_foods.deleteMany({
                where: { source_key: { startsWith: probeKey } },
            });
        }
    });

    it('leaves the whole corpus with a populated search_vector', async () => {
        const [{ unpopulated }] = await prisma.$queryRaw<{ unpopulated: bigint }[]>`
            SELECT COUNT(*) AS unpopulated
            FROM catalog_foods
            WHERE search_vector IS NULL OR search_vector = ''::tsvector
        `;

        // A row whose vector is empty is permanently unfindable rather than
        // wrong, which is the failure mode this asserts away over all 10,004.
        expect(Number(unpopulated)).toBe(0);
    });

    it('can answer the full-text branch from the GIN index', async () => {
        // ADVISORY, and gated as such: the planner may legitimately prefer a
        // sequential scan at this size, so the assertion is that the index is
        // USABLE — measured with sequential scans disabled for this transaction
        // only — not that it is preferred. `catalogCollation.test.ts` owns the
        // cost-direction evidence.
        const plan = await prisma.$transaction(async (db) => {
            await db.$executeRawUnsafe('SET LOCAL enable_seqscan = off');

            // The vector predicate alone, so the GIN index is the only index
            // that could answer it: adding the `publication_status` predicate the
            // service also carries would let the planner satisfy this with the
            // `(publication_status, category)` btree instead and turn a usability
            // check into a coin toss about which index it preferred.
            return db.$queryRawUnsafe<{ 'QUERY PLAN': unknown }[]>(
                "EXPLAIN (FORMAT JSON) SELECT id FROM catalog_foods " +
                    "WHERE search_vector @@ plainto_tsquery('english', 'zentil')",
            );
        });

        expect(JSON.stringify(plan)).toContain('idx_catalog_foods_search_vector');
    });

    it('can answer the alias full-text branch from the GIN index', async () => {
        // Same advisory gating and the same reason as the catalog_foods case
        // above: the vector predicate stands alone so the GIN index is the only
        // index that could answer it.
        const plan = await prisma.$transaction(async (db) => {
            await db.$executeRawUnsafe('SET LOCAL enable_seqscan = off');

            return db.$queryRawUnsafe<{ 'QUERY PLAN': unknown }[]>(
                'EXPLAIN (FORMAT JSON) SELECT catalog_food_id FROM catalog_food_aliases ' +
                    "WHERE search_vector @@ plainto_tsquery('english', 'zentil')",
            );
        });

        expect(JSON.stringify(plan)).toContain('idx_catalog_food_aliases_search_vector');
    });

    it('leaves every alias row with a populated search_vector', async () => {
        const [{ unpopulated }] = await prisma.$queryRaw<{ unpopulated: bigint }[]>`
            SELECT COUNT(*) AS unpopulated
            FROM catalog_food_aliases
            WHERE search_vector IS NULL OR search_vector = to_tsvector('english', '')
        `;

        // `alias` is NOT NULL, so the generated expression can only produce an
        // empty vector for an alias with no lexemes. One that does is
        // permanently unfindable through the full-text branch rather than
        // merely mis-ranked.
        expect(Number(unpopulated)).toBe(0);
    });

    it('offers the plan-cache mode the search statements are planned under', async () => {
        // THE MECHANISM `searchPublishedFoods` DEPENDS ON, pinned because its
        // absence is silent. Every branch of the match set is index-served only
        // when the planner sees the parameter VALUES: the prefix branches derive
        // their B-tree range bounds from the LIKE pattern and the full-text
        // branches take their selectivity from the tsquery. Prisma sends one
        // parameterised prepared statement whose text is identical for every
        // query the app runs, so under the default `plan_cache_mode = auto`
        // PostgreSQL switches to a GENERIC plan after five executions and
        // abandons those indexes. Measured on the v1 release, that made the
        // first query of a connection cost 64 ms and every query after it
        // 196-283 ms; `force_custom_plan` puts the whole set at 2.9-79.5 ms.
        const [{ mode }] = await prisma.$queryRaw<{ mode: string }[]>`
            SELECT setting AS mode FROM pg_settings WHERE name = 'plan_cache_mode'
        `;
        expect(typeof mode).toBe('string');

        // Transaction-scoped, which is what makes it safe to issue on a pooled
        // connection: it must apply inside the transaction and be gone after it.
        const inside = await prisma.$transaction(async (db) => {
            await db.$executeRawUnsafe('SET LOCAL plan_cache_mode = force_custom_plan');
            const [row] = await db.$queryRaw<{ mode: string }[]>`
                SELECT current_setting('plan_cache_mode') AS mode
            `;
            return row.mode;
        });
        const [{ mode: after }] = await prisma.$queryRaw<{ mode: string }[]>`
            SELECT current_setting('plan_cache_mode') AS mode
        `;

        expect(inside).toBe('force_custom_plan');
        expect(after).not.toBe('force_custom_plan');
    });

    it('still issues that directive from the search transaction', () => {
        // A SOURCE TRIPWIRE, and deliberately so. Removing the directive changes
        // no result, no ordering and no row count, so every functional test in
        // this repository keeps passing while the worst-case search doubles and
        // the other seven triple. There is no observable the suite can read back
        // after the fact either: `SET LOCAL` reverts at COMMIT, so by the time a
        // test can query the session the evidence is gone. Pinning the call site
        // is what makes its deletion fail loudly. If the service stops needing
        // it — a Prisma release that stops preparing these statements, or a
        // rewrite that makes the plan parameter-insensitive — delete this test
        // WITH the measurement that shows the regression is gone.
        const source = readFileSync(
            join(__dirname, '..', '..', 'services', 'catalog.service.ts'),
            'utf8',
        );
        const body = source.slice(source.indexOf('export const searchPublishedFoods'));

        expect(body).toContain('forceCustomPlanForThisTransaction');
        expect(source).toContain('SET LOCAL plan_cache_mode = force_custom_plan');
    });
});

/* ---------------------------------------------------------------------------
 * What these reads do not depend on
 * ------------------------------------------------------------------------- */

describe('what the catalog read does not depend on', () => {
    // The spy below has to be UNDONE, and nothing in the configuration does it:
    // `jest.config.ts` sets `clearMocks` and deliberately not `restoreMocks`,
    // because restoring before every test would strip the `jest.mock` factories
    // `jestSetup.ts` installs for `utils/firebase` and `middleware/auth` and
    // leave this suite unable to import `app.ts`. Clearing wipes a mock's call
    // record and keeps its implementation, so an unrestored
    // `mockReturnValue(false)` is not a fact about one case — it is the value
    // every later case in this file reads for the flag, silently, while looking
    // like the real accessor. `restoreAllMocks` here is the narrow form of what
    // `restoreMocks` would do globally: it undoes the `jest.spyOn` above (the
    // only spy in this file) and cannot touch those factories, which are plain
    // functions rather than mocks. `catalog.test.ts` and `targets.test.ts` use
    // the same hook for the same reason.
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('serves a real page with meal planning switched off at the server', async () => {
        // `/catalog/*` is never gated — Add Food catalog section does not depend
        // on meal planning — and `catalog.test.ts` owns the full posture. Asserted
        // once here so a corpus-scale run cannot come to depend on the flag.
        jest.spyOn(featureFlags, 'isMealPlanningEnabled').mockReturnValue(false);

        expect(featureFlags.isMealPlanningEnabled()).toBe(false);

        const { status, items, pagination } = await searchOverHttp({ q: queryById('q001').q });

        expect(status).toBe(200);
        expect(pagination.total).toBe(1);
        expect(idsOf(items)).toStrictEqual(localIds(queryById('q001').expected));
    });

    it('answers two different callers identically, because the catalog has no owner', async () => {
        // The isolation pin for the case above, in the position that can observe
        // it: this is the case its spy would have leaked into. The accessor is
        // the module's own function again — not a mock — and it reads the `true`
        // that `jestSetup.ts` puts in `MEAL_PLANNING_ENABLED`, so a future edit
        // that dropped the restoring hook fails HERE with the reason, rather than
        // quietly running the rest of the file with planning switched off.
        expect(jest.isMockFunction(featureFlags.isMealPlanningEnabled)).toBe(false);
        expect(featureFlags.isMealPlanningEnabled()).toBe(true);

        const reader = await searchOverHttp({ q: 'quibbin' }, READER);
        const other = await searchOverHttp({ q: 'quibbin' }, OTHER_READER);

        // The sanctioned exception to Rule backend-architecture §5.1: these rows
        // are shared reference data, so there is no owner to scope to and no
        // cross-user row to leak. The reads are still authenticated.
        expect(other.status).toBe(200);
        expect(JSON.stringify(other.body)).toBe(JSON.stringify(reader.body));
    });

    it('holds no user_id column to scope by in the first place', async () => {
        const scoped = await prisma.$queryRaw<{ table_name: string }[]>`
            SELECT table_name
            FROM information_schema.columns
            WHERE table_schema = current_schema()
                AND column_name = 'user_id'
                AND table_name IN ('catalog_foods', 'catalog_food_aliases', 'catalog_food_portions')
        `;

        expect(scoped).toStrictEqual([]);
    });
});

/**
 * The read-path schema objects that carry no behaviour of their own.
 *
 * WHY THESE ARE PINNED HERE AND NOT SOMEWHERE ELSE. An index and a statistics
 * object change only how fast an answer arrives, never what it is, so every
 * functional test in this repository passes with all four of them dropped. The
 * two defects they fix were found by reading query plans, and nothing but an
 * assertion of this shape can notice them coming back:
 *
 *  * `meal_plans_user_id_start_date_id_idx` replaced a declared index on
 *    `(user_id, status, start_date)` that had `idx_scan = 0` on a 1,503-plan
 *    fixture because no statement carried a `status` predicate. Its key order
 *    matches the plan-lifecycle read — equality on `user_id`, then the read's
 *    own `ORDER BY start_date, id` — which is what turns that read into an
 *    Index Only Scan with no Sort node.
 *  * The four statistics objects tell the planner that `meal_plan_id` and
 *    `user_id` are correlated (a plan's days all belong to that plan's owner)
 *    and that `user_id` and `date` are. Without them PostgreSQL multiplies the
 *    two selectivities as if independent and underestimated by 7x, 22x and 41x
 *    on the same fixture.
 *
 * THE STATEMENT AND THE INDEX MUST MOVE TOGETHER. The read that this index
 * exists for lives in `mealPlan.service.ts`, which this unit does not own. That
 * is exactly why the key order is asserted rather than described: if that read
 * gains a `status` predicate or changes its ordering, this test fails and names
 * the index that has to follow it, instead of the index quietly going unused
 * again.
 */
describe('the schema the plan reads rest on', () => {
    it('carries the plan-lifecycle index in the key order that read scans', async () => {
        const indexes = await prisma.$queryRaw<{ indexname: string; indexdef: string }[]>`
            SELECT indexname, indexdef
            FROM pg_indexes
            WHERE schemaname = current_schema() AND tablename = 'meal_plans'
        `;
        const lifecycle = indexes.find(
            (index) => index.indexname === 'meal_plans_user_id_start_date_id_idx',
        );

        expect(lifecycle).toBeDefined();
        // Key order is the whole point: `user_id` first for the equality, then
        // `start_date, id` so the read's ORDER BY is satisfied by the scan.
        expect((lifecycle as { indexdef: string }).indexdef).toMatch(
            /\("?user_id"?, "?start_date"?, "?id"?\)/i,
        );
    });

    it('no longer carries the status-leading index nothing could use', async () => {
        const retired = await prisma.$queryRaw<{ present: boolean }[]>`
            SELECT to_regclass('meal_plans_user_id_status_start_date_idx') IS NOT NULL AS present
        `;

        // Kept as its own assertion rather than folded into the one above: an
        // unused index is not free. It is maintained on every insert and update
        // to a hot, per-user table, so leaving it beside its replacement would
        // pay for two and read from one.
        expect(retired[0]?.present).toBe(false);
    });

    it('carries extended statistics on every correlated pair the plan reads filter by', async () => {
        const stats = await prisma.$queryRaw<{ stxname: string; kinds: string }[]>`
            SELECT stxname, stxkind::text AS kinds
            FROM pg_statistic_ext
            WHERE stxnamespace = current_schema()::regnamespace
            ORDER BY stxname
        `;
        const names = stats.map((row) => row.stxname);

        expect(names).toStrictEqual(
            expect.arrayContaining([
                'grocery_items_meal_plan_id_user_id_stx',
                'meal_entries_user_id_date_stx',
                'meal_plan_days_meal_plan_id_user_id_stx',
                'meal_plan_meals_meal_plan_id_user_id_stx',
            ]),
        );
    });

    it('points each of those statistics at the column pair its read filters by', async () => {
        // THE COLUMN PAIR IS THE WHOLE VALUE. A statistics object declared on
        // the wrong two columns is indistinguishable from none at all — it is
        // created, it is ANALYZEd, it reports as present, and it corrects
        // nothing. Names cannot be trusted to encode it either, since the name
        // is just a string the migration chose. So the keys are resolved back
        // through `pg_attribute` and compared against the predicates the reads
        // actually carry: `meal_plan_id = $1 AND user_id = $2` on the three
        // plan-child tables, and `user_id = $1 AND date = $2` on the diary.
        //
        // WHY POPULATED-NESS IS NOT ASSERTED HERE. `CREATE STATISTICS` only
        // declares; ANALYZE computes, and it can only compute from rows. This
        // suite truncates its tables, so in this database three of the four
        // objects hold ndistinct data and `meal_entries_user_id_date_stx` holds
        // none — a property of the fixture, not of the schema, which would make
        // such an assertion flap rather than protect anything. The migration
        // runs ANALYZE on all four tables itself, and the estimates it corrects
        // were verified against a populated 1,503-plan database, where the
        // previous underestimates of 7x, 22x and 41x became exact.
        const keyed = await prisma.$queryRaw<{ stxname: string; tbl: string; cols: string }[]>`
            SELECT e.stxname,
                c.relname AS tbl,
                (
                    SELECT string_agg(a.attname, ',' ORDER BY a.attnum)
                    FROM pg_attribute a
                    WHERE a.attrelid = e.stxrelid
                        AND a.attnum = ANY (e.stxkeys::int2[])
                ) AS cols
            FROM pg_statistic_ext e
            JOIN pg_class c ON c.oid = e.stxrelid
            WHERE e.stxnamespace = current_schema()::regnamespace
                AND e.stxname LIKE '%_stx'
            ORDER BY e.stxname
        `;
        const pairs = Object.fromEntries(keyed.map((row) => [row.stxname, `${row.tbl}(${row.cols})`]));

        expect(pairs).toMatchObject({
            grocery_items_meal_plan_id_user_id_stx: 'grocery_items(meal_plan_id,user_id)',
            meal_entries_user_id_date_stx: 'meal_entries(user_id,date)',
            meal_plan_days_meal_plan_id_user_id_stx: 'meal_plan_days(meal_plan_id,user_id)',
            meal_plan_meals_meal_plan_id_user_id_stx: 'meal_plan_meals(meal_plan_id,user_id)',
        });
    });
});
