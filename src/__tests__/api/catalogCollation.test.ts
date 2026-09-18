// The catalog read path's SERVER-PROPERTY suite: the proofs about
// `GET /catalog/foods`, `GET /catalog/foods/suggestions` and
// `GET /catalog/status` whose failure mode is a property of the PostgreSQL
// server — a collation, an operator class, a plan — rather than a branch in
// TypeScript.
//
// THREE FILES DIVIDE THIS AREA, AND THE SPLIT IS THE DATABASE EACH ONE NEEDS.
// Pure catalog rules — dedupe, `source_key`, publication eligibility, every
// request parser, the row -> DTO mapper — are unit-tested with no database at
// all in `src/services/__tests__/catalog.logic.test.ts`. The HTTP contract of
// the four routes — status codes, wire bodies, visibility, ordering, the
// feature-flag posture and the catalog branch of the diary log route — is
// driven over supertest against the AMBIENT test database in
// `src/__tests__/api/catalog.test.ts` (the suite AAP §0.9.2 names for the
// catalog rows and §0.3.3 for the inventory). This file exists because neither
// of those can reach what it proves: the ambient database's collation cannot
// distinguish a pinned order from an unpinned one (see below), so the evidence
// needs a database with a DIFFERENT default collation — which this file creates
// for itself.
//
// THE SUITE PROVISIONS ITS OWN DATABASE, AND DOES NOT USE THE AMBIENT ONE.
// Every other suite here runs against the ambient test database; this one
// creates a disposable database of its own in `beforeAll` and drops it in
// `afterAll`, for the reason and by the mechanism set out below. The ambient
// database is therefore never read or written here, which is why this file
// neither truncates the feature tables nor coordinates with the shared
// truncation guard — and why the Prisma singleton the services import is mocked
// to point somewhere else entirely. That mock is also why an HTTP round-trip
// through `../setup/testApp` does not belong in this file at all: the shipped
// app's services resolve the same singleton, so a request driven from here
// would read the disposable database rather than the one the harness truncates,
// and would fail on this file's ICU precondition for a reason that has nothing
// to do with the route. Those cases belong in `catalog.test.ts`, which runs
// against the ambient database with the rest of the suite.
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
// applies every committed migration to it, in ledger order, with a plain `pg`
// client — the list is `MIGRATION_SQL` below, and it is the whole ledger rather
// than a chosen subset precisely so the schema under test is the one every
// environment runs — the
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
// the service's own predicate. `idx_catalog_food_aliases_fold_alias` exists for
// the prefix fallback in `catalogMatchSet`, and a btree can answer
// `translate(alias, 'ABC…', 'abc…') LIKE 'x%'` with a range scan only when the
// indexed comparison is byte order — a `*_pattern_ops` operator class, or a
// column collation of C. The database this suite creates has neither by
// accident: its default collation is ICU `und`, which is the hostile case, and
// the index therefore carries `text_pattern_ops` explicitly. The final describe
// pins that class out of `pg_opclass`, pins the plan (with
// `enable_seqscan = off`, so cost is not a variable), and confirms equality is
// still served. The committed schema-evidence gate cannot see an operator class
// at all — `pg_get_indexdef(oid, k, …)` omits it — so these assertions are
// where that property is held.
//
// THE INDEXED EXPRESSION IS THE ASCII FOLD AND NOT `lower()`, which is the same
// portability property the head-noun describe at the bottom of this file pins,
// reaching the prefix branches. `lower()` resolves through the collation while
// the JavaScript side of the comparison does not, so a partial query over a
// name carrying a non-ASCII capital matched on one server and not on another —
// and a prefix branch is the only branch a partial query can match, so the food
// disappeared rather than being mis-ranked. Both sides now fold through the one
// ASCII map (`foldSearchAscii` in JavaScript, `translate()` over the same two
// exported constants in SQL), and `prisma/migrations/
// 20260910000000_catalog_prefix_fold_indexes/migration.sql` indexes that
// expression for all three prefix columns.
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

/** Poll interval of a statement settle, in milliseconds. */
const QUERY_SETTLE_POLL_MS = 2;

/** Consecutive quiet polls that end a statement drain. */
const QUERY_SETTLE_QUIET_POLLS = 3;

/** How long a settle waits for the first event of a call before giving up on one. */
const QUERY_FIRST_EVENT_GRACE_MS = 250;

/**
 * Waits until a recorded statement log has stopped growing.
 *
 * A Prisma `query` event is emitted ASYNCHRONOUSLY, and how many macrotasks it
 * takes to arrive depends on load — several more under `--coverage`, and more
 * again in the whole `src/__tests__/api` folder run, one `--runInBand` process
 * on a shared host. Reading the log after a single fixed tick was therefore a
 * race in both directions: a call's own statements could arrive after the
 * assertion had read the log, making "some statement was issued" fail with
 * zero, and those same late statements could then land during the NEXT call and
 * make "no statement was issued" fail with someone else's SQL.
 *
 * Two hazards live here and only one of them is a waiting problem, so each gets
 * its own remedy. MISATTRIBUTION is fixed structurally, by the callers: every
 * call records into a sink of its own (see `driveHandler`), so a straggler can
 * only ever reach the sink of the call that issued it and no timing assumption
 * can make a refused request look as though it queried. Only "did my own
 * statement arrive yet" needs a wait, and quiescence ALONE will not do for it: a
 * few quiet polls cannot tell "no statement will ever arrive" from "the
 * statement has not arrived yet", so a slow delivery would read as an empty log
 * — the original failure, merely moved. This therefore waits for the first
 * statement of the call up to a grace period, then drains to quiet for any
 * further ones. A call that legitimately issues none pays the grace period and
 * reports an empty log, which is the honest answer rather than a raced one.
 *
 * Shared by both recorders in this file so the two cannot drift apart.
 */
const drainQueryEvents = async (sink: readonly unknown[]): Promise<void> => {
    const tick = () => new Promise((resolve) => setTimeout(resolve, QUERY_SETTLE_POLL_MS));
    const startLength = sink.length;
    const graceDeadline = Date.now() + QUERY_FIRST_EVENT_GRACE_MS;

    while (sink.length === startLength && Date.now() < graceDeadline) {
        await tick();
    }

    let lastCount = sink.length;
    let quietPolls = 0;

    while (quietPolls < QUERY_SETTLE_QUIET_POLLS && Date.now() < graceDeadline + QUERY_FIRST_EVENT_GRACE_MS) {
        await tick();

        if (sink.length === lastCount) {
            quietPolls += 1;
        } else {
            lastCount = sink.length;
            quietPolls = 0;
        }
    }
};

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
import {
    foldSearchAscii,
    SEARCH_ASCII_LOWERCASE,
    SEARCH_ASCII_UPPERCASE,
} from '../../services/catalog.logic';
import { getStatus, getSuggestions, searchPublishedFoods } from '../../services/catalog.service';

const BACKEND_ROOT = path.resolve(__dirname, '..', '..', '..');
// Every entry of the ledger, in order, because this list is what builds the ICU
// database below: an entry left out is DDL the disposable database does not
// have, and the index proofs at the bottom of this file would then be asserting
// about a schema no environment runs. 20260910000000_catalog_prefix_fold_indexes
// is where the three ASCII-fold indexes the prefix branches read come from.
const MIGRATION_SQL = [
    '20260706000000_init',
    '20260908000000_meal_planning',
    '20260909000000_usda_cache_http_status',
    '20260910000000_catalog_prefix_fold_indexes',
].map((migration) => path.join(BACKEND_ROOT, 'prisma', 'migrations', migration, 'migration.sql'));

/**
 * Five names chosen because `C` and ICU disagree about all of them — and
 * because the relevance score cannot tell them apart.
 *
 * THE COLLATION HALF. Case is exactly what the two collations weigh
 * differently: `C` compares raw UTF-8 bytes, so every uppercase letter sorts
 * before every lowercase one, while ICU treats case as a tertiary difference
 * and orders lowercase first. Verified on PostgreSQL 16 against these five
 * names, the two sequences are
 * `BEANS, BLACK | BEANS, black | Beans, BLACK | Beans, black | beans, BLACK`
 * under `C` and
 * `beans, BLACK | Beans, black | Beans, BLACK | BEANS, black | BEANS, BLACK`
 * under `und-x-icu` — they differ from the first element on, so any assertion
 * between them is unambiguous.
 *
 * THE RANK HALF, which is why these five differ ONLY in case. `display_name`
 * decides a page's order only once the ranks are equal, and the relevance score
 * is computed from the name: its word count is the specificity divisor and its
 * head noun sets the weight. Five names that differ in wording — as an earlier
 * revision of this fixture had them — therefore carry five different ranks, and
 * the collation pin below could never be observed. Case-only variants are
 * identical to the scorer at every step (same twelve characters, same two
 * words, same head-segment vector `'bean'`, same head noun) while remaining
 * maximally different to the two collations, so the ranks tie by construction
 * and the collated name is the only thing left that can explain the sequence.
 */
const COLLATION_SENSITIVE_NAMES = ['BEANS, BLACK', 'BEANS, black', 'Beans, BLACK', 'Beans, black', 'beans, BLACK'];

/**
 * One food state per name, because the names now lower-case to ONE
 * `canonical_name`.
 *
 * `(canonical_name, food_state)` is unique among published rows, so five rows
 * sharing `beans, black` need five distinct states to be publishable at all.
 * That is honest data rather than a workaround — raw, cooked, dry, prepared and
 * as-purchased beans genuinely are distinct catalog rows — and the column takes
 * no part in search scoring or ordering, so it cannot affect what this file
 * measures.
 */
const COLLATION_FOOD_STATES = ['raw', 'cooked', 'dry', 'prepared', 'as_purchased'];

/**
 * The query term, and the reason every seeded row ties on rank.
 *
 * `searchPublishedFoods` orders by `rank DESC` first, so `display_name` only
 * decides once the ranks are equal — and a test about `display_name` ordering
 * has to make them equal. Three things arrange that, and all three are needed:
 * the term is a prefix of every seeded name and every name is the same length,
 * so each row draws the same coverage score from the prefix branch; every row is
 * given identical `search_text`; and the five names are case variants of one
 * another, so the full-text branch reads the same word count, the same
 * head-segment vector and the same head noun from each of them. `MAX(rank)` is
 * therefore the same value for all five, and the collated `display_name` is the
 * deciding key.
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
            food_state: COLLATION_FOOD_STATES[index],
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
    // Its wire contract — the body, each per-status count and the release
    // pointer's three states — is asserted over HTTP in `catalog.test.ts`. What
    // is covered here is the one property that needs a database this file
    // already holds exclusively: getStatus reads its five
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
 * handlers. A supertest round-trip cannot make either half of the claim from
 * this file. The Prisma singleton every service imports is mocked here at the
 * disposable ICU database, so a request driven through the shipped `app` would
 * read that database rather than the one the harness truncates, and would fail
 * on this file's ICU precondition for a reason that has nothing to do with the
 * route. The zero-I/O half additionally needs the mocked client's `query` event
 * stream — a refusal is asserted to have produced NO statement — which a wire
 * response does not expose. The route-level contract of these two reads is
 * driven over supertest in `src/__tests__/api/catalog.test.ts`, against the
 * ambient database.
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
     * Where a `query` event is recorded, or null while nothing is listening.
     *
     * Prisma exposes no `$off`, so the listener registered below outlives every
     * test. A PER-CALL sink rather than one shared array plus a flag is what
     * bounds what any one assertion sees: a statement that lands late can only
     * ever reach the sink of the call that issued it, so it cannot be counted
     * against the next call.
     */
    let activeStatementSink: string[] | null = null;

    beforeAll(() => {
        (prisma as unknown as QueryEventSource).$on('query', (event) => {
            activeStatementSink?.push(event.query);
        });
    });

    /** Drives a handler with its own statement log and returns what it recorded. */
    const driveHandler = async (
        handler: (req: Request, res: Response) => Promise<unknown>,
        query: Record<string, unknown>,
    ): Promise<{ recorded: RecordedResponse; statements: string[] }> => {
        const sink: string[] = [];
        activeStatementSink = sink;

        const { req, res, recorded } = handlerDoubles(query);
        await handler(req, res);
        await drainQueryEvents(sink);

        activeStatementSink = null;

        return { recorded, statements: [...sink] };
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
    const INDEX_NAME = 'idx_catalog_food_aliases_fold_alias';

    /**
     * The indexed expression, written once and used by every plan assertion
     * below.
     *
     * Built from the two constants `catalog.logic.ts` exports and
     * `catalog.service.ts::asciiFoldOf` composes, so this file cannot pin a plan
     * for an expression the service does not issue: an alphabet edited on one
     * side would stop matching the index and the plan assertions would go red
     * here rather than silently downgrade a range scan to a sequential read in
     * production.
     */
    const FOLDED_ALIAS = `translate(alias, '${SEARCH_ASCII_UPPERCASE}', '${SEARCH_ASCII_LOWERCASE}')`;

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
     * Alias text that cannot collide with anything above, carrying capitals so
     * the fold is doing work on the COLUMN side too.
     *
     * The five foods already seeded are the `beans` family, and the suite's
     * assertions count matches of `beans` exactly. These aliases share no prefix
     * with that term, the food they hang off is not a common dislike (so it
     * cannot appear in `getSuggestions`), and its own `display_name` and
     * `canonical_name` do not match the prefix either — so a row reaching the
     * result can only have come through the ALIAS prefix branch.
     *
     * The stem is title-cased and the query below is typed in capitals, so
     * neither side of the comparison is folded already: the stored alias reaches
     * the index through `translate()` and the typed term reaches the pattern
     * through `foldSearchAscii`, which is what the branch actually does. The
     * pattern is therefore derived with the same function the service uses
     * rather than written out, so a fold that stopped being applied on either
     * side fails here instead of passing on pre-folded fixture text.
     */
    const ALIAS_STEM = 'Zalix Murnen';
    const MATCHING_GROUP = '007';
    const PREFIX_QUERY = `${ALIAS_STEM} ${MATCHING_GROUP}`;
    const PREFIX_PATTERN = `${foldSearchAscii(PREFIX_QUERY)}%`;
    const EXACT_ALIAS = foldSearchAscii(`${ALIAS_STEM} ${MATCHING_GROUP} 7`);
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
                   COUNT(*) FILTER (
                       WHERE translate(alias, ${SEARCH_ASCII_UPPERCASE}, ${SEARCH_ASCII_LOWERCASE})
                           LIKE ${PREFIX_PATTERN}
                   ) AS matching
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
        const plan = await explain(`${FOLDED_ALIAS} LIKE '${PREFIX_PATTERN}'`, true);

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
        // Drained rather than snapshotted immediately, for the reason
        // `drainQueryEvents` gives: the `query` event is asynchronous, so
        // reading the array the moment the call returns can see none of the
        // service's statements and turn "exactly one match" into "0 did".
        await drainQueryEvents(captured);
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

    it('still serves equality on the folded alias, which is why no second index is added', async () => {
        const plan = await explain(`${FOLDED_ALIAS} = '${EXACT_ALIAS}'`, false);

        // `text_pattern_ops` supports =, < and > as well as the pattern
        // operators, so replacing `text_ops` costs nothing. That is the evidence
        // behind not adding a second `text_ops` index for equality — and the
        // check that would catch its loss if one day a caller needed it.
        expect(plan).toContain(INDEX_NAME);
        expect(plan).toContain('Index Scan');
    });
});

/* ---------------------------------------------------------------------------
 * The head-noun tier is locale-free
 *
 * WHY THIS IS HERE RATHER THAN IN A UNIT TEST. The head-noun signal is decided
 * in SQL, between a `to_tsvector` of the food's head noun and a
 * `plainto_tsquery` of the query's — and the two head nouns are extracted by
 * two different runtimes, one in `catalog.logic.ts::searchQueryHeadNoun` for the
 * query and one in `catalog.service.ts` for the name. Only a database can show
 * whether they agree, and only a database whose collation is not C can show
 * whether their agreement depends on the collation.
 *
 * THE DEFECT THIS PINS. The SQL side folded case with `lower()`, which resolves
 * through the collation, while the JavaScript side used
 * `String.prototype.toLowerCase`, which does not: `'İNCİR'.toLowerCase()` is
 * `i` + U+0307 COMBINING DOT ABOVE, `lower('İNCİR')` is a plain `incir` under
 * `en_US.utf8`, and under ICU it is different again. So for any name carrying a
 * non-ASCII capital the head-noun comparison could fail on one server and
 * succeed on another, putting the food in a different TIER — and tier decides
 * `rank`, which is the FIRST ordering key. `COLLATE "C"` on the two text
 * tiebreakers cannot repair that, because it is only consulted once the ranks
 * are equal. AAP §§0.5.2 and 0.9.3 require two independently loaded databases
 * to answer with identical ranks and page sequences, so this was a portability
 * defect and not a cosmetic one.
 *
 * Both sides now fold through the one ASCII-only map — `foldSearchAscii` in
 * JavaScript, `translate()` over the same two exported constants in SQL — so
 * the comparison's inputs are byte-identical wherever the release is loaded,
 * and everything outside A-Z is left for `to_tsvector`/`plainto_tsquery` to
 * normalise, which they do to both halves at once.
 * ------------------------------------------------------------------------- */

describe('the head-noun tier on a name whose case no two collations fold alike', () => {
    /**
     * The query, and why its capital sits in the middle of the word.
     *
     * `MURNİX` carries U+0130 LATIN CAPITAL LETTER I WITH DOT ABOVE — the
     * character whose fold differs between JavaScript, glibc and ICU — but it
     * begins with an ASCII `M`. That matters for the assertion below: the
     * ordering has to be decided by RANK and not by the collated name, so the
     * food that should rank FIRST must sort SECOND in C byte order. A term
     * starting with the non-ASCII capital could never arrange that, because
     * U+0130 encodes as 0xC4 0xB0 and would always sort last.
     */
    const QUERY_TERM = 'MURNİX';

    /** The query IS this food's head noun: it names what the food is. */
    const HEAD_NOUN_NAME = 'Zested MURNİX';

    /** The query only MODIFIES this food: a bread, not a murnix. */
    const MODIFIER_NAME = 'MURNİX bread';

    /**
     * Two words each, so the specificity divisor is equal and cannot explain the
     * order; distinct states because the two names are distinct canonical names
     * only after folding, and `(canonical_name, food_state)` is the unique key
     * among published rows.
     */
    const UNICODE_FIXTURE: readonly { name: string; state: string; sequence: number }[] = [
        { name: HEAD_NOUN_NAME, state: 'raw', sequence: 950 },
        { name: MODIFIER_NAME, state: 'cooked', sequence: 951 },
    ];

    const createdIds: string[] = [];

    beforeAll(async () => {
        for (const row of UNICODE_FIXTURE) {
            const food = await makeCatalogFood({
                sequence: row.sequence,
                display_name: row.name,
                canonical_name: foldSearchAscii(row.name),
                food_state: row.state,
                // The food's own vector has to carry the term, or the full-text
                // branch never reaches the row and there is no tier to observe.
                search_text: row.name,
            });
            createdIds.push(food.id);
        }
    });

    afterAll(async () => {
        if (createdIds.length === 0) return;

        await prisma.catalog_foods.deleteMany({ where: { id: { in: createdIds } } });
    });

    it('sorts the two names in the OPPOSITE order to the one rank must produce', async () => {
        // The premise of the next case, asserted rather than assumed. If these
        // two names ever sorted the same way the ranking is expected to, the
        // assertion below would pass on a build with no head-noun signal at all.
        const rows = await prisma.$queryRaw<{ display_name: string }[]>`
            SELECT display_name FROM catalog_foods
            WHERE id = ANY(${createdIds}::uuid[])
            ORDER BY display_name COLLATE "C" ASC
        `;

        expect(rows.map((row) => row.display_name)).toEqual([MODIFIER_NAME, HEAD_NOUN_NAME]);
    });

    it('ranks the food the query NAMES above the food it merely modifies', async () => {
        const { items, total } = await searchPublishedFoods(QUERY_TERM, 1, 50);

        expect(total).toBe(UNICODE_FIXTURE.length);
        // Only a locale-free fold gets here. With `lower()` on the SQL side and
        // `toLowerCase()` on the JavaScript side, neither food matched on its
        // head noun, both fell to the head-segment weight, their ranks tied, and
        // the collated name decided — returning MODIFIER_NAME first, which is
        // what the case above proves is the tie order.
        expect(items.map((item) => item.name)).toEqual([HEAD_NOUN_NAME, MODIFIER_NAME]);
    });

    it('pages that order without a gap or a repeat', async () => {
        const single = await searchPublishedFoods(QUERY_TERM, 1, 50);
        const paged = [
            ...(await searchPublishedFoods(QUERY_TERM, 1, 1)).items,
            ...(await searchPublishedFoods(QUERY_TERM, 2, 1)).items,
        ].map((item) => item.id);

        expect(paged).toEqual(single.items.map((item) => item.id));
        expect(new Set(paged).size).toBe(paged.length);
    });

    it('folds a non-ASCII name identically under this collation and under C', async () => {
        // The mechanism behind the case above, stated on its own so a reader can
        // see why it holds. `translate()` is a character-for-character map with
        // no locale input, so both collations return one value — and that value
        // is what `foldSearchAscii` returns in JavaScript, which is what makes
        // the two sides of the comparison byte-identical.
        for (const { name } of UNICODE_FIXTURE) {
            const [row] = await prisma.$queryRaw<{ by_default: string; by_c: string }[]>`
                SELECT translate(${name}, ${SEARCH_ASCII_UPPERCASE}, ${SEARCH_ASCII_LOWERCASE}) AS by_default,
                       translate(${name} COLLATE "C", ${SEARCH_ASCII_UPPERCASE}, ${SEARCH_ASCII_LOWERCASE}) AS by_c
            `;

            expect(row.by_default).toBe(foldSearchAscii(name));
            expect(row.by_c).toBe(foldSearchAscii(name));
        }
    });

    it('would not fold it identically through lower(), which is why lower() is gone', async () => {
        // The other half of the same statement, and the sharp one: `lower()`
        // resolves through the collation, so on THIS server it answers two
        // different things for one input depending on which collation the
        // argument carries. A rank computed through it is a property of the
        // server rather than of the release.
        //
        // Three answers exist for `MURNİX` across the collations this project
        // meets — ICU folds U+0130 to `i` + U+0307, C leaves it untouched, and
        // `en_US.utf8` drops the dot to a plain `i` — which is why the fix was
        // to stop case-folding anything outside A-Z rather than to make one
        // side imitate the other. This case fails if `lower()` is ever put back
        // on the head-noun path and someone reasons that the collations agree.
        const [row] = await prisma.$queryRaw<{ by_default: string; by_c: string }[]>`
            SELECT lower(${HEAD_NOUN_NAME}) AS by_default,
                   lower(${HEAD_NOUN_NAME} COLLATE "C") AS by_c
        `;

        expect(row.by_default).not.toBe(row.by_c);
        // And neither of them is what JavaScript produces, which is the
        // divergence the head-noun comparison used to sit on top of.
        expect(new Set([row.by_default, row.by_c, HEAD_NOUN_NAME.toLowerCase()]).size).toBeGreaterThan(1);
    });
});

/* ---------------------------------------------------------------------------
 * The prefix branches are locale-free
 *
 * WHY THIS IS HERE AND NOT IN A UNIT TEST, for the reason the head-noun describe
 * above gives: the comparison is made in SQL between a pattern folded in
 * JavaScript and a column folded by the server, so only a database — and only
 * one whose collation is not C — can show whether the two agree and whether
 * their agreement is a property of the server.
 *
 * THE DEFECT THIS PINS, AND WHY IT WAS WORSE THAN A MIS-RANK. The pattern was
 * built with `q.toLowerCase()` (Unicode full case folding) while the three
 * columns were folded with `lower()` (resolved through the collation), and the
 * two are different functions outside A-Z: `'MURNİ'.toLowerCase()` is `murni` +
 * U+0307 COMBINING DOT ABOVE, while `lower()` answers `murni` + U+0307 under
 * ICU, a plain `murni` under `en_US.utf8`, and `murnİ` — unchanged — under C. A
 * PARTIAL query matches through NO other branch: a stemmed query has no prefix
 * semantics, so `plainto_tsquery` cannot reach a word the user has only started
 * typing. So for a name carrying a non-ASCII capital the food did not drop a
 * tier, it disappeared from the result entirely — on some servers and not on
 * others. AAP §0.9.3 requires two independently loaded databases to answer with
 * identical ranks and page sequences, which a food that is present in one and
 * absent in the other fails outright.
 *
 * Both sides now fold through the one ASCII-only map — `foldSearchAscii` in
 * JavaScript, `translate()` over the same two exported constants in SQL — and
 * `prisma/migrations/20260910000000_catalog_prefix_fold_indexes/migration.sql`
 * indexes that expression for all three prefix columns, so the fold costs the
 * branches nothing.
 *
 * THE CORPUS COVERS EACH PREFIX COLUMN ONCE, because the branches read three
 * and a fix applied to two of them would be invisible to a one-food fixture:
 * one food carries the capital in its `display_name`, one in its
 * `canonical_name` alone, and one in an alias. One partial query must return all
 * three.
 *
 * Only `display_name` carries capitals in release v1 — `normalizeCanonicalName`
 * strips diacritics and case from a canonical name, and the release's aliases
 * are lower-case ASCII — so the other two rows are text the current loader
 * would not write. They are seeded anyway, and deliberately: what this describe
 * pins is the COMPARISON these three branches make, which has to hold for
 * whatever the columns hold. How a canonical name is normalised on the way in is
 * a separate invariant, owned by `catalog.logic.ts` and its own unit tests, and
 * a branch test that leaned on it would silently stop covering two of its three
 * columns the day the loader changed.
 *
 * THE AMBIENT DATABASE IS THE OTHER HALF OF THE SAME CLAIM, and it is asserted
 * in `src/__tests__/api/catalog.test.ts` ('returns a food a partial query
 * reaches only through a non-ASCII uppercase name' and its alias sibling), which
 * drives the same corpus over HTTP against the database the rest of the suite
 * runs on. Two collations, one answer, which is what portability means here.
 *
 * DECLARATION ORDER IS NOT LOAD-BEARING: this describe seeds its three
 * published foods in its own `beforeAll` and removes them in its own
 * `afterAll`, as every describe in this file does, and nothing it seeds matches
 * `beans` on any branch.
 * ------------------------------------------------------------------------- */

describe('a partial query over text no two collations case-fold alike', () => {
    /**
     * The typed term: a strict prefix of a word, in capitals, carrying U+0130
     * LATIN CAPITAL LETTER I WITH DOT ABOVE.
     *
     * A strict prefix is what makes this a PARTIAL query rather than a
     * full-text one: `plainto_tsquery('english', 'MURNİ')` produces a single
     * lexeme that equals no lexeme of `murnİxberry`, so contributions 1 and 2
     * of `catalogMatchSet` cannot reach any of these foods and the row can only
     * have arrived through a prefix branch. Capitals on this side and capitals
     * in the stored text mean neither side of the comparison is pre-folded.
     */
    const PARTIAL_QUERY = 'MURNİ';

    /** The three foods, one per prefix column the branches read. */
    const NAME_FOOD = 'MURNİXBERRY, raw';
    const CANONICAL_FOOD = 'Preserved compote 952';
    const CANONICAL_TEXT = `${foldSearchAscii(PARTIAL_QUERY)}xberry compote`;
    const ALIAS_FOOD = 'Bottled compote 953';
    const ALIAS_TEXT = 'MURNİXBERRY PEEL';

    /**
     * `search_text` that matches nothing the query stems to, for all three.
     *
     * The stored vector is generated from `search_text` alone, so this is what
     * keeps the full-text branches out of the result and leaves the prefix
     * branches as the only way in.
     */
    const UNREACHED_SEARCH_TEXT = 'fixture prefix corpus';

    const createdIds: string[] = [];

    beforeAll(async () => {
        const name = await makeCatalogFood({
            sequence: 960,
            display_name: NAME_FOOD,
            canonical_name: foldSearchAscii(NAME_FOOD),
            food_state: 'raw',
            search_text: UNREACHED_SEARCH_TEXT,
        });
        // The capital lives in `canonical_name` only, which is the half of the
        // name branch a display-name fixture cannot cover: the branch reads the
        // two columns with an OR, so each needs its own row to be observable.
        const canonical = await makeCatalogFood({
            sequence: 961,
            display_name: CANONICAL_FOOD,
            canonical_name: CANONICAL_TEXT,
            food_state: 'cooked',
            search_text: UNREACHED_SEARCH_TEXT,
        });
        const alias = await makeCatalogFood({
            sequence: 962,
            display_name: ALIAS_FOOD,
            canonical_name: foldSearchAscii(ALIAS_FOOD),
            food_state: 'prepared',
            search_text: UNREACHED_SEARCH_TEXT,
        });
        await prisma.catalog_food_aliases.create({
            data: { catalog_food_id: alias.id, alias: ALIAS_TEXT },
        });

        createdIds.push(name.id, canonical.id, alias.id);
    });

    afterAll(async () => {
        if (createdIds.length === 0) return;

        await prisma.catalog_food_aliases.deleteMany({ where: { catalog_food_id: { in: createdIds } } });
        await prisma.catalog_foods.deleteMany({ where: { id: { in: createdIds } } });
    });

    it('returns every food the partial query reaches, on each of the three prefix columns', async () => {
        const { items, total } = await searchPublishedFoods(PARTIAL_QUERY, 1, 50);

        // Asserted as the whole match set rather than as a membership test: a
        // fold applied to one column and not the others returns a subset, and
        // the count is what makes that a failure instead of a pass on the one
        // food that still arrives.
        expect(total).toBe(createdIds.length);
        expect(items.map((item) => item.name).slice().sort()).toEqual(
            [NAME_FOOD, CANONICAL_FOOD, ALIAS_FOOD].slice().sort(),
        );
    });

    it('pages that match set without a gap or a repeat', async () => {
        const single = await searchPublishedFoods(PARTIAL_QUERY, 1, 50);
        const paged = [
            ...(await searchPublishedFoods(PARTIAL_QUERY, 1, 2)).items,
            ...(await searchPublishedFoods(PARTIAL_QUERY, 2, 2)).items,
        ].map((item) => item.id);

        expect(paged).toEqual(single.items.map((item) => item.id));
        expect(new Set(paged).size).toBe(paged.length);
    });

    it('folds each stored text identically under this collation and under C', async () => {
        // The mechanism behind the case above, stated on its own: `translate()`
        // takes no locale input, so the indexed expression and the pattern are
        // the same bytes wherever the release is loaded — and that value is what
        // `foldSearchAscii` returns in JavaScript, which is the other half of
        // the comparison.
        for (const text of [NAME_FOOD, CANONICAL_TEXT, ALIAS_TEXT]) {
            const [row] = await prisma.$queryRaw<{ by_default: string; by_c: string }[]>`
                SELECT translate(${text}, ${SEARCH_ASCII_UPPERCASE}, ${SEARCH_ASCII_LOWERCASE}) AS by_default,
                       translate(${text} COLLATE "C", ${SEARCH_ASCII_UPPERCASE}, ${SEARCH_ASCII_LOWERCASE}) AS by_c
            `;

            expect(row.by_default).toBe(foldSearchAscii(text));
            expect(row.by_c).toBe(foldSearchAscii(text));
        }
    });

    it('would not have matched through the lower()/toLowerCase() pairing on every server', async () => {
        // The pairing the branches used to carry, evaluated as the branches
        // evaluated it: the pattern folded by JavaScript, the column folded by
        // `lower()`. `toLowerCase()` is called deliberately here — it is the
        // defect being pinned, not a fold this file endorses.
        const legacyPattern = `${PARTIAL_QUERY.toLowerCase()}%`;
        const foldedPattern = `${foldSearchAscii(PARTIAL_QUERY)}%`;

        const [row] = await prisma.$queryRaw<{
            legacy_by_default: boolean;
            legacy_by_c: boolean;
            folded: boolean;
        }[]>`
            SELECT lower(${NAME_FOOD}) LIKE ${legacyPattern} AS legacy_by_default,
                   lower(${NAME_FOOD} COLLATE "C") LIKE ${legacyPattern} AS legacy_by_c,
                   translate(${NAME_FOOD}, ${SEARCH_ASCII_UPPERCASE}, ${SEARCH_ASCII_LOWERCASE})
                       LIKE ${foldedPattern} AS folded
        `;

        // The whole defect in three booleans: the old pairing's answer was a
        // property of the collation the argument carried — matching under this
        // database's ICU default and NOT under C, the collation the page order
        // itself is pinned to — while the fold answers the same thing under
        // both. A food absent from one server's results and present on
        // another's is what AAP §0.9.3 forbids.
        expect(row.legacy_by_default).not.toBe(row.legacy_by_c);
        expect(row.legacy_by_c).toBe(false);
        expect(row.folded).toBe(true);
    });
});
