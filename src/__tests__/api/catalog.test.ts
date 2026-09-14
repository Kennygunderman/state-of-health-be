// The catalog area's database-backed suite: the planned home for every proof
// about the read path behind `GET /catalog/foods`,
// `GET /catalog/foods/suggestions` and `GET /catalog/status` that needs a real
// PostgreSQL to make (AAP §0.9.2 names this file for the catalog rows, §0.3.3
// for the suite inventory). Pure catalog rules — dedupe, `source_key`,
// publication eligibility, the match set — are unit-tested without a database
// in `src/services/__tests__/catalog.logic.test.ts`; what lives here is
// everything whose failure mode is a property of the server rather than a
// branch in TypeScript.
//
// THE SUITE PROVISIONS ITS OWN DATABASE, AND DOES NOT USE THE AMBIENT ONE.
// Every other suite here runs against the ambient test database; this one
// creates a disposable database of its own in `beforeAll` and drops it in
// `afterAll`, for the reason and by the mechanism set out below. The ambient
// database is therefore never read or written here, which is why this file
// neither truncates the feature tables nor coordinates with the shared
// truncation guard — and why the Prisma singleton the services import is mocked
// to point somewhere else entirely. A case added below that needs the ambient
// database, an HTTP round-trip through `../setup/testApp` for instance, cannot
// use that mocked singleton: it has to open its own client against
// `process.env.DATABASE_URL`.
//
// WHAT IS BEING PROVEN, AND WHY A UNIT TEST CANNOT DO IT. `catalog.service.ts`
// orders search results and dislike suggestions by `display_name` and
// `source_key`, and AAP §0.9.3 requires the same release loaded into a second,
// independently created database to produce IDENTICAL ranks and page sequences.
// An unqualified `ORDER BY display_name` does not give that: the comparison is
// made under the database's default collation, which is a property of how that
// database was created rather than of the release. The service therefore pins
// `COLLATE "C"` on both text keys.
//
// A pure unit test cannot establish that the pin works, because the whole
// failure mode lives in the server: it is the difference between two databases,
// not a branch in TypeScript. Worse, it cannot even be observed in the ambient
// test database. On this Alpine/musl image libc collations — including
// `en_US.utf8`, which is what the test database is created with — collate
// byte-wise, so the unpinned order and the `C` order coincide there and a
// service that had NO pin at all would still pass. Only PostgreSQL's ICU
// provider gives a genuinely different default ordering (verified on
// PostgreSQL 16.15: `und` ICU orders these five names differently from `C`).
//
// SO THIS SUITE CREATES THAT DATABASE AND RUNS THE REAL SERVICE INSIDE IT.
// `beforeAll` creates a disposable database with an ICU default collation,
// applies both committed migrations to it with a plain `pg` client — the
// mechanism `src/__tests__/api/compat.test.ts` already uses for its disposable
// ledgers — and seeds collation-sensitive rows. The Prisma singleton the service
// imports is redirected at that database through `jest.mock`, so
// `searchPublishedFoods` and `getSuggestions` issue their own real SQL against a
// default collation that disagrees with `C`.
//
// That makes the assertions load-bearing in both directions:
//   * the service's order must equal the `C` order — so the pin is doing the
//     work, and
//   * the database's own default order must DIFFER from the `C` order — which
//     is asserted separately, so the first assertion can never pass merely
//     because the two orders happen to coincide.
// Delete `COLLATE "C"` from either statement and this suite fails, which is the
// regression guard the ambient database cannot provide.
//
// Both collations are recorded as assertions rather than as prose (the ICU
// provider and locale of the database under test, and the pinned collation in
// the order itself), so the conditions the evidence was produced under are part
// of the run and not a claim about it.
//
// A SECOND PROOF RIDES ON THE SAME DATABASE: that the alias index is usable by
// the service's own predicate. `idx_catalog_food_aliases_lower_alias` exists for
// the prefix fallback in `catalogMatchSet`, and a btree can answer
// `lower(alias) LIKE 'x%'` with a range scan only when the indexed comparison is
// byte order — a `*_pattern_ops` operator class, or a column collation of C. The
// database this suite creates has neither by accident: its default collation is
// ICU `und`, which is the hostile case, and the index therefore carries
// `text_pattern_ops` explicitly. The final describe pins that class out of
// `pg_opclass`, pins the plan (with `enable_seqscan = off`, so cost is not a
// variable), and confirms equality is still served. The committed
// schema-evidence gate cannot see an operator class at all —
// `pg_get_indexdef(oid, k, …)` omits it — so these assertions are where that
// property is held.
//
// That the REAL CALLER reaches the index is established in the same describe,
// and deterministically: the mocked Prisma singleton is constructed with query
// event logging, so a real `searchPublishedFoods` call hands back the exact SQL
// and the exact bound parameters it issued, and the page statement is then
// re-planned and executed with those same values through
// `EXPLAIN (ANALYZE, FORMAT JSON)` on its own connection. The assertion is a
// node of that plan tree reading this index, with the `ANALYZE` row and loop
// counters that only a node which ran has. Nothing is timed, nothing is slept
// on, and no cumulative or cluster-wide statistic is consulted, so host load
// cannot fail the test and index activity from elsewhere cannot pass it.
//
// Everything here is read-only with respect to the developer's own data: the
// database is created and dropped by this file and is named after the ambient
// test database, so parallel clones cannot collide.

import fs from 'fs';
import path from 'path';

// --------------------------------------------------------------------------
// A narrow typed surface over node-postgres, for the work Prisma cannot do:
// CREATE DATABASE and DROP DATABASE, and applying a migration file verbatim.
//
// `pg` is a runtime dependency of this service but ships no type declarations,
// and @types/pg is deliberately not added for two test files. This mirrors the
// declaration in `src/__tests__/api/compat.test.ts` for the same reason.
// --------------------------------------------------------------------------

interface PgQueryResult<TRow> {
    rows: TRow[];
}

interface PgClient {
    connect(): Promise<void>;
    query<TRow = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<PgQueryResult<TRow>>;
    end(): Promise<void>;
}

interface PgModule {
    Client: new (config: { connectionString: string }) => PgClient;
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pg = require('pg') as PgModule;

// --------------------------------------------------------------------------
// A narrow typed surface over the two other untyped things this file reads: the
// Prisma query log, and PostgreSQL's JSON plan output. Both are declared with
// only the fields the assertions use, so a change in either is a compile error
// here rather than a silently absent property at runtime.
// --------------------------------------------------------------------------

/** One statement Prisma executed, as its `query` event reports it. */
interface QueryEvent {
    /** The SQL with `$n` placeholders, exactly as the engine sent it. */
    query: string;
    /** The values bound to those placeholders, as a JSON array in a string. */
    params: string;
}

/**
 * The `query`-event surface of the Prisma singleton.
 *
 * `src/prisma/client.ts` constructs its client with no `log` option, so the
 * exported type has no `query` event in it and `prisma.$on('query', …)` does not
 * typecheck — while the instance the `jest.mock` factory below installs DOES
 * emit them, because that factory adds `log: [{emit: 'event', level: 'query'}]`.
 * This interface is the narrowest bridge across that gap: it names the one
 * method and the two fields this file uses, so the cast stays checked against a
 * shape instead of becoming `any`.
 */
interface QueryEventSource {
    $on(event: 'query', listener: (event: QueryEvent) => void): void;
}

/**
 * One node of an `EXPLAIN (ANALYZE, FORMAT JSON)` plan tree.
 *
 * Every field but the node type is optional because PostgreSQL emits each per
 * node kind: `Index Name` only on a node that reads an index, and the `Actual …`
 * counters only under `ANALYZE` — which is what makes their PRESENCE evidence
 * that the node ran. `Plans` is the child list and is absent on a leaf.
 */
interface PlanNode {
    'Node Type': string;
    'Index Name'?: string;
    'Actual Rows'?: number;
    'Actual Loops'?: number;
    Plans?: PlanNode[];
}

/**
 * The single row `EXPLAIN (… FORMAT JSON)` returns. `pg` parses a `json` column
 * itself, so `QUERY PLAN` arrives as the one-element array PostgreSQL documents
 * rather than as text needing a second `JSON.parse`.
 */
interface ExplainedStatementRow {
    'QUERY PLAN': { Plan: PlanNode }[];
}

/**
 * The naming rule for the disposable database, in one place.
 *
 * Derived from the ambient `DATABASE_URL` so that each parallel clone gets its
 * own (`soh_test_23` -> `soh_test_23_collation_icu`) and no two runs can race on
 * one name. The `jest.mock` factory below has to repeat this derivation — a
 * hoisted factory cannot reach a module-scope binding without a TDZ error — and
 * the first test asserts the service really is connected to this database, so
 * the two derivations cannot silently drift apart.
 */
const ICU_DATABASE_SUFFIX = '_collation_icu';

const databaseUrlFor = (ambientUrl: string, database: string): string => {
    const url = new URL(ambientUrl);
    url.pathname = `/${database}`;
    return url.toString();
};

const ambientUrl = (): string => {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set; this suite needs the ambient test database to derive from.');
    return url;
};

const ambientDatabaseName = (): string => new URL(ambientUrl()).pathname.replace(/^\//, '');
const icuDatabaseName = (): string => `${ambientDatabaseName()}${ICU_DATABASE_SUFFIX}`;

// Redirect the singleton the service imports at the ICU database. The factory is
// hoisted above the imports, so it derives the URL from the environment itself
// rather than from anything in this module's scope. `new PrismaClient()` does
// not connect, so constructing it here is safe even though the database is
// created later in `beforeAll`.
//
// `log: [{emit: 'event', …}]` is what makes the index evidence at the bottom of
// this file possible: it hands a subscriber the exact SQL and the exact bound
// parameters the service issued, so the plan asserted there is the plan of the
// service's OWN statement rather than of one this test rewrote. `emit: 'event'`
// and not `'stdout'`, so nothing is printed during an ordinary run.
jest.mock('../../prisma/client', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { PrismaClient } = require('../../generated/prisma');
    const url = new URL(process.env.DATABASE_URL as string);
    url.pathname = `${url.pathname}_collation_icu`;

    return {
        prisma: new PrismaClient({
            datasourceUrl: url.toString(),
            log: [{ emit: 'event', level: 'query' }],
        }),
    };
});

import { Request, Response } from 'express';

import { prisma } from '../../prisma/client';
import {
    getCatalogSuggestionsController,
    searchCatalogFoodsController,
} from '../../controllers/catalog.controller';
import { makeCatalogFood } from '../setup/factories';
import { CatalogFoodRow, CatalogMappingError, mapCatalogFood } from '../../services/catalog.mapper';
import { getStatus, getSuggestions, searchPublishedFoods } from '../../services/catalog.service';

const BACKEND_ROOT = path.resolve(__dirname, '..', '..', '..');
const MIGRATION_SQL = ['20260706000000_init', '20260908000000_meal_planning'].map((migration) =>
    path.join(BACKEND_ROOT, 'prisma', 'migrations', migration, 'migration.sql'),
);

/**
 * Five names chosen because `C` and ICU disagree about all of them.
 *
 * Case, comma and hyphen are exactly what the two collations weigh differently:
 * `C` compares raw UTF-8 bytes, so uppercase sorts before lowercase and
 * punctuation sorts by its code point, while ICU applies language-aware rules
 * that treat case as a tertiary difference and largely ignore punctuation. The
 * resulting sequences share no common prefix, so any assertion between them is
 * unambiguous.
 */
const COLLATION_SENSITIVE_NAMES = ['Beans, black', 'Beans black', 'beans, green', 'Beans-lima', 'BEANS, navy'];

/**
 * The query term, and the reason every seeded row ties on rank.
 *
 * `searchPublishedFoods` orders by `rank DESC` first, so `display_name` only
 * decides once the ranks are equal — and a test about `display_name` ordering
 * has to make them equal. Two things arrange that: the term is a prefix of every
 * seeded name, so each row draws the same constant `PREFIX_MATCH_RANK` from the
 * prefix branch, and every row is given identical `search_text`, so the
 * full-text branch scores them identically too. `MAX(rank)` is therefore the
 * same value for all five, and the collated `display_name` is the deciding key.
 */
const QUERY = 'beans';
const SHARED_SEARCH_TEXT = 'beans legume';

interface NameRow {
    display_name: string;
}

/** The same rows, ordered by the database's own default collation. */
const defaultCollationOrder = async (): Promise<string[]> => {
    const rows = await prisma.$queryRaw<NameRow[]>`
        SELECT display_name FROM catalog_foods
        WHERE publication_status = 'published'
        ORDER BY display_name ASC, source_key ASC
    `;
    return rows.map((row) => row.display_name);
};

/** The same rows, ordered the way the service pins. */
const pinnedCollationOrder = async (): Promise<string[]> => {
    const rows = await prisma.$queryRaw<NameRow[]>`
        SELECT display_name FROM catalog_foods
        WHERE publication_status = 'published'
        ORDER BY display_name COLLATE "C" ASC, source_key COLLATE "C" ASC
    `;
    return rows.map((row) => row.display_name);
};

const withMaintenanceClient = async (run: (client: PgClient) => Promise<void>): Promise<void> => {
    const client = new pg.Client({ connectionString: databaseUrlFor(ambientUrl(), 'postgres') });
    await client.connect();
    try {
        await run(client);
    } finally {
        await client.end();
    }
};

jest.setTimeout(120_000);

beforeAll(async () => {
    const database = icuDatabaseName();

    await withMaintenanceClient(async (client) => {
        const icu = await client.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM pg_collation WHERE collname = 'und-x-icu'",
        );
        if (icu.rows[0]?.count === '0') {
            throw new Error(
                'This PostgreSQL server has no ICU collation support, so a database whose default ' +
                    'collation differs from C cannot be created and the ordering pin cannot be ' +
                    'proven here. Run the suite against a server built with ICU (the project uses ' +
                    'postgres:16-alpine, which has it).',
            );
        }

        // Identifiers cannot be parameterised. The name is derived from
        // DATABASE_URL and matched against the database-name grammar before it
        // is interpolated, so nothing caller-controlled reaches the statement.
        if (!/^[a-z_][a-z0-9_]*$/.test(database)) {
            throw new Error(`Refusing to create a database from the unsafe name "${database}".`);
        }

        await client.query(`DROP DATABASE IF EXISTS "${database}"`);
        await client.query(
            `CREATE DATABASE "${database}" TEMPLATE template0 LOCALE_PROVIDER icu ICU_LOCALE 'und' LOCALE 'C'`,
        );
    });

    const url = databaseUrlFor(ambientUrl(), database);
    const schemaClient = new pg.Client({ connectionString: url });
    await schemaClient.connect();
    try {
        for (const sqlPath of MIGRATION_SQL) {
            await schemaClient.query(fs.readFileSync(sqlPath, 'utf8'));
        }
    } finally {
        await schemaClient.end();
    }

    for (const [index, name] of COLLATION_SENSITIVE_NAMES.entries()) {
        await makeCatalogFood({
            sequence: index + 1,
            display_name: name,
            canonical_name: name.toLowerCase(),
            search_text: SHARED_SEARCH_TEXT,
            is_common_dislike: true,
        });
    }
});

afterAll(async () => {
    await prisma.$disconnect();
    await withMaintenanceClient(async (client) => {
        await client.query(`DROP DATABASE IF EXISTS "${icuDatabaseName()}"`);
    });
});

describe('catalog read ordering across databases', () => {
    describe('the conditions this evidence was produced under', () => {
        it('runs the service against a database whose default collation is ICU, not C', async () => {
            const [row] = await prisma.$queryRaw<
                { current_database: string; datlocprovider: string; daticulocale: string | null }[]
            >`
                SELECT current_database(), datlocprovider::text, daticulocale
                FROM pg_database WHERE datname = current_database()
            `;

            // Also the guard that the jest.mock derivation and icuDatabaseName()
            // still agree: if they drifted, the service would be querying the
            // ambient database and this assertion would name it.
            expect(row.current_database).toBe(icuDatabaseName());
            expect(row.datlocprovider).toBe('i');
            expect(row.daticulocale).toBe('und');
        });

        it('orders these names differently by default than C does, so the pin is observable', async () => {
            const [byDefault, pinned] = [await defaultCollationOrder(), await pinnedCollationOrder()];

            expect(byDefault).toHaveLength(COLLATION_SENSITIVE_NAMES.length);
            expect(pinned).toHaveLength(COLLATION_SENSITIVE_NAMES.length);
            // The hazard the pin exists for. Without this, every assertion below
            // could pass on a database where the two orders coincide.
            expect(byDefault).not.toEqual(pinned);
        });
    });

    describe('searchPublishedFoods', () => {
        it('returns the C order rather than the database default order', async () => {
            const result = await searchPublishedFoods(QUERY, 1, 50);
            const returned = result.items.map((item) => item.name);

            expect(result.total).toBe(COLLATION_SENSITIVE_NAMES.length);
            expect(returned).toEqual(await pinnedCollationOrder());
            expect(returned).not.toEqual(await defaultCollationOrder());
        });

        it('pages that order without a gap or a repeat', async () => {
            const single = await searchPublishedFoods(QUERY, 1, 50);
            const paged = [
                ...(await searchPublishedFoods(QUERY, 1, 2)).items,
                ...(await searchPublishedFoods(QUERY, 2, 2)).items,
                ...(await searchPublishedFoods(QUERY, 3, 2)).items,
            ].map((item) => item.id);

            expect(paged).toEqual(single.items.map((item) => item.id));
            expect(new Set(paged).size).toBe(paged.length);
        });
    });

    describe('getSuggestions', () => {
        it('returns the C order rather than the database default order', async () => {
            const { items } = await getSuggestions('dislike', 30);
            const returned = items.map((item) => item.name);

            expect(returned).toEqual(await pinnedCollationOrder());
            expect(returned).not.toEqual(await defaultCollationOrder());
        });
    });

    // getStatus carries no ordering, so it is not part of the collation proof.
    // It is covered here because this suite is the only place with a migrated
    // catalog database to hand, and because getStatus now reads its five
    // statements inside one REPEATABLE READ snapshot: that grouping is worth one
    // test that proves the five still answer coherently through it, rather than
    // shipping a transaction no automated test ever enters.
    describe('getStatus', () => {
        /**
         * The one test in this file that WRITES to the shared seed, and why it
         * puts it back.
         *
         * A status report is a report about global state — a release pointer and
         * four counts — so proving it needs a quarantined food and a succeeded
         * `release_load` run to exist. Both are exactly the rows every other
         * assertion in this file counts: the two collation orders select every
         * published food, and `searchPublishedFoods('beans').total` is five
         * because five `beans` rows are published. Leaving the quarantine in
         * place would make those assertions depend on this test running after
         * them, which is the coupling this `finally` removes: the fixture state
         * this test found is the fixture state it leaves, so the suite has no
         * declaration order it relies on.
         *
         * `finally` rather than `afterEach`: the restore is part of this test's
         * own contract, and a failed expectation must not also leave the
         * database altered for whatever runs next.
         */
        it('reports the active release and each publication count from one snapshot', async () => {
            const quarantinedSourceKey = 'usda:9000001';

            await prisma.catalog_foods.update({
                where: { source_key: quarantinedSourceKey },
                data: { publication_status: 'quarantined' },
            });
            // The id is captured from the create rather than matched back by
            // `manifest_version`, so the delete below can only remove the row
            // this test inserted.
            const releaseRun = await prisma.catalog_import_runs.create({
                data: {
                    kind: 'release_load',
                    manifest_version: 'v-under-test',
                    status: 'succeeded',
                    started_at: new Date('2026-09-01T10:00:00.000Z'),
                    finished_at: new Date('2026-09-01T10:05:00.000Z'),
                },
            });

            try {
                const status = await getStatus();

                expect(status.catalogRelease).toBe('v-under-test');
                expect(status.publishedCount).toBe(COLLATION_SENSITIVE_NAMES.length - 1);
                expect(status.quarantinedCount).toBe(1);
                expect(status.rejectedCount).toBe(0);
                expect(status.recipeCount).toBe(0);
                expect(status.lastLoadedAt).toBe('2026-09-01T10:05:00.000Z');
            } finally {
                await prisma.catalog_foods.update({
                    where: { source_key: quarantinedSourceKey },
                    data: { publication_status: 'published' },
                });
                await prisma.catalog_import_runs.delete({ where: { id: releaseRun.id } });
            }
        });
    });

    // The read boundary every food above passed through, asserted directly for
    // the one input the database cannot be made to produce.
    //
    // `catalog_foods.allergen_tags` is `TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]`
    // (`prisma/migrations/20260908000000_meal_planning/migration.sql`), so no
    // statement against the migrated database above can store an absent value —
    // which is exactly why the mapper is called directly here. The value can
    // still ARRIVE absent: `catalog.service.ts` reads its search page through
    // `$queryRaw<CatalogFoodRow[]>`, a type assertion over whatever the
    // statement returns, so a column dropped from that projection, a view, or a
    // row written around the migration reaches `mapCatalogFood` as `null`.
    //
    // What it must not do then is answer with `[]`. Allergen tags are what the
    // client shows a user checking whether a food is safe for them and what
    // planning eligibility is decided against (§0.7.3), so `[]` is the positive
    // claim "contains none of the nine named allergens" rather than "unknown" —
    // whether the data is unknown is stated separately, by `allergen_status`.
    // Placed in this suite for the reason `getStatus` is: it is the catalog read
    // boundary's own file, and the assertions cost nothing here.
    describe('mapCatalogFood safety mapping', () => {
        const FOOD_ID = 'd3b07384-d9a4-4f1b-8b9d-2b0b6e4f0a11';

        const portions = [
            { description: '1 cup', amount: 1, unit: 'cup', gram_weight: 180, is_default: true },
        ];

        const foodRow = (overrides: Readonly<Record<string, unknown>> = {}): CatalogFoodRow =>
            ({
                id: FOOD_ID,
                display_name: 'Fixture Food 1',
                category: 'protein_plant',
                food_state: 'cooked',
                identity_source: 'usda',
                nutrition_provenance: 'source_backed',
                nutrition_basis: 'per_100g',
                basis_amount: 100,
                calories: 120,
                protein_g: 9,
                carbs_g: 21,
                fat_g: 1,
                fiber_g: 7,
                allergen_tags: ['milk'],
                allergen_status: 'known',
                food_group: 'legume',
                ...overrides,
            }) as unknown as CatalogFoodRow;

        it('emits the stored allergen tags for a row that satisfies the contract', () => {
            expect(mapCatalogFood(foodRow(), portions).allergenTags).toEqual(['milk']);
        });

        it('emits an empty list for a food genuinely stored with no allergen tags', () => {
            expect(mapCatalogFood(foodRow({ allergen_tags: [] }), portions).allergenTags).toEqual([]);
        });

        it('fails closed rather than claiming the food contains no allergens', () => {
            expect(() => mapCatalogFood(foodRow({ allergen_tags: null }), portions)).toThrow(CatalogMappingError);
            expect(() => mapCatalogFood(foodRow({ allergen_tags: undefined }), portions)).toThrow(
                CatalogMappingError,
            );
            expect(() => mapCatalogFood(foodRow({ allergen_tags: 'milk' }), portions)).toThrow(CatalogMappingError);
        });

        it('names the column and the row so an operator knows what to repair', () => {
            expect(() => mapCatalogFood(foodRow({ allergen_tags: null }), portions)).toThrow(
                new RegExp(`catalog_foods\\.allergen_tags[\\s\\S]*${FOOD_ID}`),
            );
        });

        it('fails closed on a tag that is not a string, naming the index', () => {
            expect(() => mapCatalogFood(foodRow({ allergen_tags: ['milk', 7] }), portions)).toThrow(
                /catalog_foods\.allergen_tags\[1\]/,
            );
        });
    });
});

/* ---------------------------------------------------------------------------
 * The page block of a catalog request is PARSED, not clamped.
 *
 * WHAT IS BEING PROVEN. `?page=` and `?limit=` used to be read at the controller
 * through the lenient `parsePagination`, which bounds whatever it is handed — so
 * `?page=0` was served as page one, `?page=2.7` as page two, `?limit=1000` as
 * fifty rows, and `?limit=31` on the suggestions route as thirty chips, each
 * with `200 OK`. A caller could not tell any of those from a request that was
 * actually honoured. AAP §0.5.2 requires the opposite — `page >= 1`, `limit`
 * inside the route's band, and validation "before any Prisma or planning work
 * (`*.logic.ts` parsers, 400 with field codes)" — and answering success for
 * input that was silently rewritten is the CWE-20 defect this describe pins
 * closed.
 *
 * WHY HERE, AND WHY THROUGH THE HANDLERS RATHER THAN SUPERTEST. Both halves of
 * the contract are one claim and belong in one place: a malformed page block is
 * refused WITHOUT the database being touched, and an omitted one still takes the
 * route's default and returns a real page. The second half needs published rows,
 * which this file's disposable database already has, so the handlers are driven
 * with a minimal request/response pair — the instrument
 * `src/__tests__/api/requestParserWiring.test.ts` uses for the same two catalog
 * handlers. A supertest round-trip is not available: `src/routes/catalog.routes.ts`
 * does not exist yet, so no catalog path is mounted on `app`, and asserting
 * through a router that is not there would assert nothing.
 *
 * "BEFORE ANY PRISMA WORK" IS MEASURED, not assumed. The mocked singleton this
 * file installs emits a `query` event per statement, so a refusal is asserted to
 * have produced NONE. That is what makes the POSITION of the parse — the first
 * statement of the handler, before the service call — load-bearing rather than
 * tidy.
 *
 * DECLARATION ORDER IS NOT LOAD-BEARING, by the same rule the rest of this file
 * follows: nothing below writes to the database, and the five published `beans`
 * foods are the whole corpus a `beans` search can reach (the probe food the next
 * describe seeds matches no `beans` prefix and no `beans` full-text term), so
 * every count here holds whichever order the describes run in.
 * ------------------------------------------------------------------------- */
describe('the catalog request boundary refuses a malformed page block before any I/O', () => {
    /** The route bands AAP §0.5.2 fixes, restated where they are asserted. */
    const SEARCH_DEFAULT_LIMIT = 25;
    const SEARCH_MAX_LIMIT = 50;
    const SUGGESTIONS_MAX_LIMIT = 30;

    /** Every published food a `beans` search can reach (seeded in `beforeAll`). */
    const PUBLISHED_BEANS = COLLATION_SENSITIVE_NAMES.length;

    /** What the response double recorded, in place of a wire response. */
    interface RecordedResponse {
        statusCode: number | null;
        body: unknown;
    }

    interface ResponseDouble {
        status(code: number): ResponseDouble;
        json(body: unknown): ResponseDouble;
    }

    const handlerDoubles = (
        query: Record<string, unknown>,
    ): { req: Request; res: Response; recorded: RecordedResponse } => {
        const recorded: RecordedResponse = { statusCode: null, body: null };
        const res: ResponseDouble = {
            status: (code: number) => {
                recorded.statusCode = code;

                return res;
            },
            json: (body: unknown) => {
                recorded.body = body;

                return res;
            },
        };

        return {
            // `getUserId` reads the uid the auth middleware attached; these
            // routes resolve the caller and then have nothing to scope by, the
            // catalog being shared reference data.
            req: { user: { uid: 'catalog-boundary-user' }, params: {}, query } as unknown as Request,
            res: res as unknown as Response,
            recorded,
        };
    };

    /**
     * Statements the mocked client issued while `recordingQueries` is on.
     *
     * Prisma exposes no `$off`, so the listener registered below outlives each
     * test; the flag and the reset are what bound what any one assertion sees.
     */
    const observedStatements: string[] = [];
    let recordingQueries = false;

    beforeAll(() => {
        (prisma as unknown as QueryEventSource).$on('query', (event) => {
            if (recordingQueries) {
                observedStatements.push(event.query);
            }
        });
    });

    /**
     * Drives a handler with a clean statement log and returns what it recorded.
     *
     * The macrotask tick after the handler resolves is deliberate: a `query`
     * event is emitted asynchronously, so a statement issued by this call could
     * otherwise arrive after the assertion read the log and make "no statement"
     * true only by racing it.
     */
    const driveHandler = async (
        handler: (req: Request, res: Response) => Promise<unknown>,
        query: Record<string, unknown>,
    ): Promise<{ recorded: RecordedResponse; statements: string[] }> => {
        observedStatements.length = 0;
        recordingQueries = true;

        const { req, res, recorded } = handlerDoubles(query);
        await handler(req, res);
        await new Promise((resolve) => setImmediate(resolve));

        recordingQueries = false;

        return { recorded, statements: [...observedStatements] };
    };

    describe('GET /catalog/foods', () => {
        it('serves the default page block when the request names only q', async () => {
            const { recorded, statements } = await driveHandler(searchCatalogFoodsController, { q: QUERY });

            expect(recorded.statusCode).toBeNull();
            expect(recorded.body).toMatchObject({
                pagination: {
                    page: 1,
                    limit: SEARCH_DEFAULT_LIMIT,
                    total: PUBLISHED_BEANS,
                    totalPages: 1,
                },
            });
            expect((recorded.body as { items: unknown[] }).items).toHaveLength(PUBLISHED_BEANS);
            // The converse of every refusal below: a well-formed request DOES
            // reach the database, so the gate cannot be passing by refusing
            // everything.
            expect(statements.length).toBeGreaterThan(0);
        });

        it('uses an explicit page block exactly as it was asked for', async () => {
            const { recorded } = await driveHandler(searchCatalogFoodsController, {
                q: QUERY,
                page: '2',
                limit: '2',
            });

            expect(recorded.statusCode).toBeNull();
            expect(recorded.body).toMatchObject({
                pagination: { page: 2, limit: 2, total: PUBLISHED_BEANS, totalPages: 3 },
            });
            expect((recorded.body as { items: unknown[] }).items).toHaveLength(2);
        });

        it.each([
            ['a zero page', { page: '0' }, { field: 'page', code: 'out_of_range' }],
            ['a negative page', { page: '-1' }, { field: 'page', code: 'out_of_range' }],
            ['a fractional page', { page: '2.7' }, { field: 'page', code: 'invalid' }],
            ['a nonnumeric page', { page: 'abc' }, { field: 'page', code: 'invalid' }],
            [
                'a page past the supported depth',
                { page: '99999999999999999999' },
                { field: 'page', code: 'out_of_range' },
            ],
            [
                'a limit above the route cap',
                { limit: String(SEARCH_MAX_LIMIT + 1) },
                { field: 'limit', code: 'out_of_range' },
            ],
            ['a limit of a thousand', { limit: '1000' }, { field: 'limit', code: 'out_of_range' }],
            ['a zero limit', { limit: '0' }, { field: 'limit', code: 'out_of_range' }],
            ['a fractional limit', { limit: '7.9' }, { field: 'limit', code: 'invalid' }],
        ])('refuses %s with no statement issued', async (_label, pageBlock, detail) => {
            const { recorded, statements } = await driveHandler(searchCatalogFoodsController, {
                q: QUERY,
                ...pageBlock,
            });

            expect(recorded.statusCode).toBe(400);
            expect(recorded.body).toEqual({ error: 'invalid_request', details: [detail] });
            expect(statements).toEqual([]);
        });

        it('names both fields of a request that gets both wrong', async () => {
            const { recorded, statements } = await driveHandler(searchCatalogFoodsController, {
                q: QUERY,
                page: 'abc',
                limit: '0',
            });

            expect(recorded.statusCode).toBe(400);
            expect(recorded.body).toEqual({
                error: 'invalid_request',
                details: [
                    { field: 'page', code: 'invalid' },
                    { field: 'limit', code: 'out_of_range' },
                ],
            });
            expect(statements).toEqual([]);
        });
    });

    describe('GET /catalog/foods/suggestions', () => {
        it('serves the maximum page of chips when it is asked for exactly', async () => {
            const { recorded, statements } = await driveHandler(getCatalogSuggestionsController, {
                kind: 'dislike',
                limit: String(SUGGESTIONS_MAX_LIMIT),
            });

            expect(recorded.statusCode).toBeNull();
            expect((recorded.body as { items: unknown[] }).items).toHaveLength(PUBLISHED_BEANS);
            expect(statements.length).toBeGreaterThan(0);
        });

        it.each([
            ['above the maximum', String(SUGGESTIONS_MAX_LIMIT + 1), 'out_of_range'],
            ['a thousand', '1000', 'out_of_range'],
            ['zero', '0', 'out_of_range'],
            ['fractional', '7.9', 'invalid'],
            ['free text', 'twelve', 'invalid'],
        ])('refuses a limit %s with no statement issued', async (_label, limit, code) => {
            const { recorded, statements } = await driveHandler(getCatalogSuggestionsController, {
                kind: 'dislike',
                limit,
            });

            expect(recorded.statusCode).toBe(400);
            expect(recorded.body).toEqual({ error: 'invalid_request', details: [{ field: 'limit', code }] });
            expect(statements).toEqual([]);
        });
    });
});

/* ---------------------------------------------------------------------------
 * The alias-prefix index, proven usable by the predicate it exists for.
 *
 * DECLARATION ORDER IS NOT LOAD-BEARING. Every assertion above is made against
 * exactly five published foods: `defaultCollationOrder`/`pinnedCollationOrder`
 * select EVERY published row, so a sixth published food appears in the expected
 * order while being absent from a `beans` search result, and `getStatus` counts
 * four published beside one quarantined. The probe food seeded below is
 * published, so while it exists it contradicts both. So this describe seeds it
 * in its own `beforeAll` and REMOVES it in its own `afterAll`, and `getStatus`
 * restores the one row it quarantines: each describe leaves the database exactly
 * as it found it, so all four pass in any order and a reordering or a scheduling
 * change cannot break an unrelated test.
 *
 * The corpus still has to be invisible to the assertions above WHILE it exists,
 * because one shared ICU database serves the whole file and a describe-scoped
 * hook only bounds time, not visibility. Three properties give that, and all
 * three are why the alias text below looks the way it does:
 *
 *   * the alias stem shares no prefix with `beans`, so no alias can reach a
 *     `beans` result through the prefix fallback;
 *   * the probe food is not a common dislike, so it cannot appear in
 *     `getSuggestions`; and
 *   * its own `display_name` and `canonical_name` do not match that prefix
 *     either, so it cannot reach a `beans` result through the name branch.
 * ------------------------------------------------------------------------- */
describe('the alias-prefix index the search fallback depends on', () => {
    const INDEX_NAME = 'idx_catalog_food_aliases_lower_alias';

    /**
     * The seeded corpus, and why it is this size.
     *
     * The plan the FREE planner picks is a cost decision, so the test that reads
     * the real service's index usage has to make the index the cheaper option.
     * Measured on this database shape, the crossover sits between 200 and 1,000
     * aliases (200: not used; 1,000, 2,000 and 5,000: used), so 2,000 is chosen
     * with margin on the right side of it while staying quick to seed. The
     * matching group is 1% of that, which is a realistic prefix selectivity —
     * a pattern matching every row is legitimately a sequential scan and would
     * prove nothing.
     */
    const ALIAS_COUNT = 2_000;
    const ALIAS_GROUPS = 100;

    /**
     * Alias text that cannot collide with anything above.
     *
     * The five foods already seeded are the `beans` family, and the suite's
     * assertions count matches of `beans` exactly. These aliases share no prefix
     * with that term, the food they hang off is not a common dislike (so it
     * cannot appear in `getSuggestions`), and its own `display_name` and
     * `canonical_name` do not match the prefix either — so a row reaching the
     * result can only have come through the ALIAS prefix branch.
     */
    const ALIAS_STEM = 'zalix murnen';
    const MATCHING_GROUP = '007';
    const PREFIX_QUERY = `${ALIAS_STEM} ${MATCHING_GROUP}`;
    const PREFIX_PATTERN = `${PREFIX_QUERY}%`;
    const EXACT_ALIAS = `${ALIAS_STEM} ${MATCHING_GROUP} 7`;
    const FOOD_SEQUENCE = 901;

    let foodId = '';

    /**
     * The node types that answer a predicate FROM a btree index.
     *
     * A set rather than one name, because which of the three the planner picks
     * is a costing decision that carries no meaning for this proof: a bitmap
     * scan is what it chooses when the matching rows are scattered, an index-only
     * scan when the projection is covered. Pinning a single shape would turn a
     * legitimate re-costing into a failure — the plan observed here is currently
     * `Bitmap Index Scan`, and a change to `Index Scan` would be no regression.
     * The set is still asserted rather than assumed, because these three are the
     * node types that read a btree BY KEY: a node that merely named this index
     * while answering some other way would not be the evidence this test claims.
     */
    const INDEX_SCAN_NODE_TYPES: readonly string[] = ['Index Scan', 'Index Only Scan', 'Bitmap Index Scan'];

    /**
     * What distinguishes the page statement from the count statement.
     *
     * `searchPublishedFoods` issues both over the same `contributions` set, so
     * both read `catalog_food_aliases` and both bind the prefix pattern; only the
     * page carries the `LIMIT`/`OFFSET` window `rowWindowFor` produced. The page
     * is the statement that RETURNED the row the assertion below names, so it is
     * the statement whose plan is the evidence — and naming it precisely is what
     * lets the selection insist on exactly ONE match instead of silently
     * explaining whichever statement came first. Remove this condition and the
     * selection matches two statements and fails, which is the intended
     * behaviour of an ambiguous predicate rather than a defect in it.
     */
    const PAGE_WINDOW = /LIMIT \$\d+ OFFSET \$\d+/;

    /**
     * The values one logged statement was executed with.
     *
     * Parsed rather than string-matched because the same array is what the
     * EXPLAIN below has to bind: a plan produced for different values is not
     * evidence about this call, since a LIKE prefix becomes an index range scan
     * only when the pattern reaches the planner as a constant. Parameters that
     * are not a JSON array would be a change in Prisma's logging rather than a
     * failure of the service, so that is reported as itself.
     */
    const boundValues = (statement: QueryEvent): unknown[] => {
        const parsed: unknown = JSON.parse(statement.params);
        if (!Array.isArray(parsed)) {
            throw new Error(
                `Prisma logged parameters that are not a JSON array (${statement.params}), so the captured ` +
                    'statement cannot be re-bound for EXPLAIN.',
            );
        }
        return parsed;
    };

    /**
     * The one statement of the captured call whose plan is the evidence.
     *
     * Exactly one match is required, and that is the guard: a predicate that
     * matched two statements would explain an arbitrary one of them, and a
     * predicate that matched none — because the alias branch was removed, or the
     * pattern stopped being a parameter — must say so rather than leave the test
     * asserting about nothing. The failure prints every statement the call
     * issued, which is what an engineer needs to see to tell those cases apart.
     */
    const aliasPrefixPageStatement = (statements: readonly QueryEvent[]): QueryEvent => {
        const matches = statements.filter(
            (statement) =>
                statement.query.includes('catalog_food_aliases') &&
                PAGE_WINDOW.test(statement.query) &&
                boundValues(statement).includes(PREFIX_PATTERN),
        );

        if (matches.length !== 1) {
            const issued = statements.map((statement) => statement.query.replace(/\s+/g, ' ').trim()).join('\n  ');
            throw new Error(
                `Expected exactly one statement of this searchPublishedFoods call to read ` +
                    `catalog_food_aliases, bind the prefix pattern "${PREFIX_PATTERN}" and carry the page ` +
                    `window, but ${matches.length} did. The statements issued were:\n  ${issued}`,
            );
        }

        return matches[0];
    };

    /**
     * The plan of one captured statement, re-planned and EXECUTED with that
     * statement's own parameter values.
     *
     * On a dedicated `pg` connection rather than the Prisma pool, for two
     * reasons: `EXPLAIN (ANALYZE)` runs the statement, so issuing it through the
     * client whose log is being read would append to that log; and a plain `pg`
     * client binds the values back exactly as Prisma bound them, with no
     * re-serialisation of its own. The connection is closed in `finally`, so a
     * failed assertion cannot leave it open against a database `afterAll` is
     * about to drop.
     *
     * Re-planning is intended and is what makes this deterministic: the same
     * SQL, the same values and the same table statistics put the planner in
     * exactly the position it was in when the service ran — the plan is still
     * its own cost-based choice — and this time the chosen plan is returned
     * instead of discarded.
     */
    const planOf = async (statement: QueryEvent): Promise<PlanNode> => {
        const client = new pg.Client({ connectionString: databaseUrlFor(ambientUrl(), icuDatabaseName()) });
        await client.connect();
        try {
            const explained = await client.query<ExplainedStatementRow>(
                `EXPLAIN (ANALYZE, FORMAT JSON) ${statement.query}`,
                boundValues(statement),
            );
            const [row] = explained.rows;
            const plan = row?.['QUERY PLAN'][0]?.Plan;
            if (!plan) {
                throw new Error(
                    `EXPLAIN (ANALYZE, FORMAT JSON) returned no plan tree for the captured statement: ` +
                        `${statement.query}`,
                );
            }
            return plan;
        } finally {
            await client.end();
        }
    };

    /** Every node of a plan tree that names an index, depth first. */
    const indexNodesOf = (node: PlanNode): PlanNode[] => [
        ...(node['Index Name'] === undefined ? [] : [node]),
        ...(node.Plans ?? []).flatMap(indexNodesOf),
    ];

    /**
     * The node that read `indexName`, or a failure naming what the plan read
     * instead.
     *
     * Throwing rather than handing `undefined` back for the test to assert on:
     * the message that makes a regression diagnosable is the list of indexes the
     * planner DID choose, and that list only exists here.
     */
    const indexNodeFor = (plan: PlanNode, indexName: string): PlanNode => {
        const indexNodes = indexNodesOf(plan);
        const match = indexNodes.find((node) => node['Index Name'] === indexName);

        if (!match) {
            const chosen = indexNodes.map((node) => `${node['Node Type']} using ${node['Index Name']}`).join(', ');
            throw new Error(
                `The plan of searchPublishedFoods' own page statement reads no index named ${indexName}. ` +
                    `Index nodes in that plan: ${chosen === '' ? 'none' : chosen}.`,
            );
        }

        return match;
    };

    /**
     * The plan for one statement, as text.
     *
     * The pattern is a literal rather than a bound parameter on purpose: these
     * two tests are about the OPERATOR CLASS, and a literal removes the second
     * condition an index scan needs (the pattern reaching the planner as a
     * constant) as a variable. That condition is what the captured-statement
     * test below covers, through the real caller. `enable_seqscan = off` is set
     * with `SET LOCAL` inside the transaction, so it cannot leak to another
     * test.
     */
    const explain = async (predicate: string, disableSeqScan: boolean): Promise<string> =>
        prisma.$transaction(async (tx) => {
            if (disableSeqScan) {
                await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
            }
            const rows = await tx.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(
                `EXPLAIN SELECT catalog_food_id FROM catalog_food_aliases WHERE ${predicate}`,
            );
            return rows.map((row) => row['QUERY PLAN']).join('\n');
        });

    beforeAll(async () => {
        const food = await makeCatalogFood({
            sequence: FOOD_SEQUENCE,
            search_text: 'index probe food',
            // Excluded from the dislike suggestions by construction, so this food
            // is invisible to every assertion that counts them.
            is_common_dislike: false,
        });
        foodId = food.id;

        // One statement rather than 2,000 round trips: `generate_series` builds
        // the alias text server-side. The only value crossing from this process
        // is the food id, and it is BOUND; the stem and the two counts are
        // constants of this file, placed in the statement because PostgreSQL
        // cannot infer a type for a bare parameter used as a modulus or as a
        // `generate_series` bound.
        await prisma.$executeRawUnsafe(
            `INSERT INTO catalog_food_aliases (catalog_food_id, alias)
             SELECT $1::uuid,
                    '${ALIAS_STEM} ' || lpad((series % ${ALIAS_GROUPS})::text, 3, '0') || ' ' || series
             FROM generate_series(0, ${ALIAS_COUNT - 1}) AS series`,
            foodId,
        );

        // Without statistics the planner costs the table from its defaults, and
        // the cost-based test below would be measuring the absence of an ANALYZE
        // rather than the index.
        await prisma.$executeRawUnsafe('ANALYZE catalog_food_aliases');
    });

    /**
     * The corpus removed again, which is what makes this describe's position in
     * the file irrelevant.
     *
     * An empty `foodId` means `beforeAll` threw before the food was created, so
     * there is nothing to remove: returning early keeps a setup failure reported
     * as itself instead of being followed by a second, derived error from a
     * delete that was never going to match a row.
     *
     * The aliases are deleted explicitly before the food even though
     * `catalog_food_aliases.catalog_food_id` is declared `ON DELETE CASCADE`
     * (`prisma/migrations/20260908000000_meal_planning/migration.sql`), because a
     * suite's cleanup should not silently depend on a foreign key's action:
     * whichever way that constraint is later written, this describe still
     * removes what it created. `catalog_food_portions` — the one default portion
     * `makeCatalogFood` nests — is left to the cascade, since deleting a food
     * without its portion is not a state any test may observe.
     *
     * Jest runs a describe-scoped `afterAll` BEFORE the file-scoped one, so the
     * Prisma connection this needs is still open: the file's `afterAll`
     * `$disconnect()`s and then drops the whole database.
     */
    afterAll(async () => {
        if (!foodId) return;

        await prisma.catalog_food_aliases.deleteMany({ where: { catalog_food_id: foodId } });
        await prisma.catalog_foods.delete({ where: { id: foodId } });
    });

    it('seeded the corpus the plan assertions are made against', async () => {
        const [counts] = await prisma.$queryRaw<{ total: bigint; matching: bigint }[]>`
            SELECT COUNT(*) AS total,
                   COUNT(*) FILTER (WHERE lower(alias) LIKE ${PREFIX_PATTERN}) AS matching
            FROM catalog_food_aliases
            WHERE catalog_food_id = ${foodId}::uuid
        `;

        expect(Number(counts.total)).toBe(ALIAS_COUNT);
        // 1% of the corpus: selective enough for an index scan to be the cheaper
        // plan, which is the premise of the captured-statement plan test below.
        expect(Number(counts.matching)).toBe(ALIAS_COUNT / ALIAS_GROUPS);
    });

    it('is declared with the text_pattern_ops operator class on its first key', async () => {
        // Read from the catalog because this is precisely what the §0.9.1 schema
        // gate could not see before this change: `pg_get_indexdef(oid, k, …)`
        // renders the key expression WITHOUT its operator class, so the class has
        // to be joined out of pg_opclass by the per-key oid in `indclass` (an
        // oidvector, zero-based).
        const [index] = await prisma.$queryRaw<{ amname: string; opcname: string; keys: number }[]>`
            SELECT am.amname, oc.opcname, i.indnkeyatts AS keys
            FROM pg_index i
            JOIN pg_class ic ON ic.oid = i.indexrelid
            JOIN pg_class tc ON tc.oid = i.indrelid
            JOIN pg_namespace n ON n.oid = tc.relnamespace
            JOIN pg_am am ON am.oid = ic.relam
            JOIN pg_opclass oc ON oc.oid = i.indclass[0]
            WHERE n.nspname = 'public' AND ic.relname = ${INDEX_NAME}
        `;

        expect(index).toBeDefined();
        expect(index.amname).toBe('btree');
        expect(index.keys).toBe(1);
        expect(index.opcname).toBe('text_pattern_ops');
    });

    it('is the plan for a left-anchored alias prefix even with sequential scans disabled', async () => {
        const plan = await explain(`lower(alias) LIKE '${PREFIX_PATTERN}'`, true);

        // This is the assertion that fails if the operator class is reverted.
        // With the default `text_ops` the planner cannot derive the >=/< bounds a
        // LIKE prefix becomes — the column collation here is ICU `und`, not C —
        // and it then refuses this index even with `enable_seqscan = off`,
        // falling back to a scan or to an unrelated index. `~>=~` and `~<~` are
        // the pattern-ops comparison operators those bounds are expressed with,
        // so their presence is what distinguishes a genuine range scan on this
        // index from an index chosen for some other reason and filtered.
        expect(plan).toContain(INDEX_NAME);
        expect(plan).toMatch(/~>=~/);
        expect(plan).toMatch(/~<~/);
    });

    it('is used by searchPublishedFoods itself, under the planner´s own costing', async () => {
        const captured: QueryEvent[] = [];
        // Prisma exposes no `$off`, so this listener outlives the test; the flag
        // is what bounds what it may see. Together with the snapshot taken the
        // moment the call returns, it keeps the selection below looking at the
        // statements of THIS call only — a statement from the plan query or from
        // `afterAll` reaching the array would make "exactly one match" a claim
        // about the wrong call.
        let capturing = true;
        (prisma as unknown as QueryEventSource).$on('query', (event) => {
            if (capturing) {
                captured.push({ query: event.query, params: event.params });
            }
        });

        const result = await searchPublishedFoods(PREFIX_QUERY, 1, 25);
        const issued = [...captured];
        capturing = false;

        // The service must have answered from the alias prefix branch: this food
        // matches on no name and no `search_text`, only on its aliases.
        expect(result.total).toBe(1);
        expect(result.items.map((item) => item.name)).toEqual([`Fixture Food ${FOOD_SEQUENCE}`]);

        // And the fallback must have read the index while doing it — established
        // from the plan of the service's OWN statement, bound to the service's
        // own parameter values, rather than from a counter. This is the assertion
        // that fails if the pattern goes back to being projected through the
        // `search` CTE: a value selected out of a materialised CTE reaches the
        // planner as a Var rather than a constant, the LIKE bounds cannot be
        // derived from it, and the alias branch becomes a sequential scan.
        const indexNode = indexNodeFor(await planOf(aliasPrefixPageStatement(issued)), INDEX_NAME);

        expect(INDEX_SCAN_NODE_TYPES).toContain(indexNode['Node Type']);
        // The two ANALYZE-only counters, asserted by PRESENCE and by loop count:
        // `EXPLAIN` without `ANALYZE` emits neither, and a node that was planned
        // but never executed reports zero loops. So this is what separates "the
        // planner chose this index" from "this index was actually read". Rows and
        // loops, never a duration — a duration would put host load back into the
        // evidence, which is the property this test exists to have.
        expect(typeof indexNode['Actual Rows']).toBe('number');
        expect(typeof indexNode['Actual Loops']).toBe('number');
        expect(indexNode['Actual Loops']).toBeGreaterThanOrEqual(1);
    });

    it('still serves equality on lower(alias), which is why no second index is added', async () => {
        const plan = await explain(`lower(alias) = '${EXACT_ALIAS}'`, false);

        // `text_pattern_ops` supports =, < and > as well as the pattern
        // operators, so replacing `text_ops` costs nothing. That is the evidence
        // behind not adding a second `text_ops` index for equality — and the
        // check that would catch its loss if one day a caller needed it.
        expect(plan).toContain(INDEX_NAME);
        expect(plan).toContain('Index Scan');
    });
});
