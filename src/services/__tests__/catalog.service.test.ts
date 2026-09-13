// The enforcing proof that catalog read ordering does not depend on the
// database it runs in.
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
// variable), reads the `pg_stat_user_indexes.idx_scan` delta across a real
// `searchPublishedFoods` call, and confirms equality is still served. The
// committed schema-evidence gate cannot see an operator class at all —
// `pg_get_indexdef(oid, k, …)` omits it — so these assertions are where that
// property is held.
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
jest.mock('../../prisma/client', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { PrismaClient } = require('../../generated/prisma');
    const url = new URL(process.env.DATABASE_URL as string);
    url.pathname = `${url.pathname}_collation_icu`;

    return { prisma: new PrismaClient({ datasourceUrl: url.toString() }) };
});

import { prisma } from '../../prisma/client';
import { makeCatalogFood } from '../../__tests__/setup/factories';
import { CatalogFoodRow, CatalogMappingError, mapCatalogFood } from '../catalog.mapper';
import { getStatus, getSuggestions, searchPublishedFoods } from '../catalog.service';

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
        it('reports the active release and each publication count from one snapshot', async () => {
            await prisma.catalog_foods.update({
                where: { source_key: 'usda:9000001' },
                data: { publication_status: 'quarantined' },
            });
            await prisma.catalog_import_runs.create({
                data: {
                    kind: 'release_load',
                    manifest_version: 'v-under-test',
                    status: 'succeeded',
                    started_at: new Date('2026-09-01T10:00:00.000Z'),
                    finished_at: new Date('2026-09-01T10:05:00.000Z'),
                },
            });

            const status = await getStatus();

            expect(status.catalogRelease).toBe('v-under-test');
            expect(status.publishedCount).toBe(COLLATION_SENSITIVE_NAMES.length - 1);
            expect(status.quarantinedCount).toBe(1);
            expect(status.rejectedCount).toBe(0);
            expect(status.recipeCount).toBe(0);
            expect(status.lastLoadedAt).toBe('2026-09-01T10:05:00.000Z');
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
 * The alias-prefix index, proven usable by the predicate it exists for.
 *
 * DECLARED LAST, AND THAT IS LOAD-BEARING. Jest runs a describe-scoped
 * `beforeAll` immediately before that describe's first test, in declaration
 * order, and every assertion above depends on exact global state: five published
 * foods, `searchPublishedFoods('beans').total === 5`, `getSuggestions` returning
 * exactly those five names, and `getStatus` counting four published and one
 * quarantined. The food and aliases seeded below would break all three if they
 * existed earlier, so they are created here and nothing above can see them.
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

    /** The `pg_stat_user_indexes` counter for this index, on this database. */
    const readIndexScanCount = async (): Promise<number> => {
        // Statistics accumulate in the backend that did the work and are flushed
        // at transaction end, at most once a second. `pg_stat_force_next_flush`
        // lifts that interval for the calling backend, and
        // `pg_stat_clear_snapshot` drops the per-transaction cached view so the
        // read that follows sees what was just flushed. Both return `void`,
        // which `$queryRaw` cannot deserialize, hence `$executeRawUnsafe` —
        // neither statement interpolates anything.
        await prisma.$executeRawUnsafe('SELECT pg_stat_force_next_flush()');
        await prisma.$executeRawUnsafe('SELECT pg_stat_clear_snapshot()');

        const rows = await prisma.$queryRaw<{ idx_scan: string }[]>`
            SELECT COALESCE(idx_scan, 0)::text AS idx_scan
            FROM pg_stat_user_indexes
            WHERE schemaname = 'public' AND indexrelname = ${INDEX_NAME}
        `;
        if (rows.length !== 1) {
            throw new Error(`${INDEX_NAME} is absent from pg_stat_user_indexes; the migration did not create it.`);
        }
        return Number(rows[0].idx_scan);
    };

    /**
     * The counter once the work that produced it is visible.
     *
     * The search runs on a pooled connection, and the flush above only forces
     * the connection it runs on, so the first read can legitimately precede the
     * flush of the backend that served the search. Polling makes the assertion
     * deterministic instead of racing that: it returns as soon as the counter
     * moves and only spends time when it has not.
     */
    const indexScanCountAbove = async (baseline: number): Promise<number> => {
        const attempts = 40;
        const pauseMs = 250;

        for (let attempt = 0; attempt < attempts; attempt += 1) {
            const observed = await readIndexScanCount();
            if (observed > baseline) {
                return observed;
            }
            await new Promise((resolve) => setTimeout(resolve, pauseMs));
        }
        return readIndexScanCount();
    };

    /**
     * The plan for one statement, as text.
     *
     * The pattern is a literal rather than a bound parameter on purpose: these
     * two tests are about the OPERATOR CLASS, and a literal removes the second
     * condition an index scan needs (the pattern reaching the planner as a
     * constant) as a variable. That condition is what the `idx_scan` test
     * covers, through the real caller. `enable_seqscan = off` is set with `SET
     * LOCAL` inside the transaction, so it cannot leak to another test.
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

    it('seeded the corpus the plan assertions are made against', async () => {
        const [counts] = await prisma.$queryRaw<{ total: bigint; matching: bigint }[]>`
            SELECT COUNT(*) AS total,
                   COUNT(*) FILTER (WHERE lower(alias) LIKE ${PREFIX_PATTERN}) AS matching
            FROM catalog_food_aliases
            WHERE catalog_food_id = ${foodId}::uuid
        `;

        expect(Number(counts.total)).toBe(ALIAS_COUNT);
        // 1% of the corpus: selective enough for an index scan to be the cheaper
        // plan, which is the premise of the idx_scan test.
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
        const before = await readIndexScanCount();
        const result = await searchPublishedFoods(PREFIX_QUERY, 1, 25);
        const after = await indexScanCountAbove(before);

        // The service must have answered from the alias prefix branch: this food
        // matches on no name and no `search_text`, only on its aliases.
        expect(result.total).toBe(1);
        expect(result.items.map((item) => item.name)).toEqual([`Fixture Food ${FOOD_SEQUENCE}`]);

        // And the fallback must have READ the index while doing it. This is the
        // assertion that fails if the pattern goes back to being projected
        // through the `search` CTE: a value selected out of a materialised CTE
        // reaches the planner as a Var rather than a constant, the LIKE bounds
        // cannot be derived from it, and the same call was measured to leave this
        // counter at zero across a 10,000-alias corpus.
        expect(after).toBeGreaterThan(before);
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
