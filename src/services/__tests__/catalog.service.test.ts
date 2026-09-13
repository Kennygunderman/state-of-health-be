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
