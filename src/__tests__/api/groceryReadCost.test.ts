// The READ-COST suite for the grocery list's catalog hydration: the proof that
// `loadGroceryFoodFacts` asks PostgreSQL for a BOUNDED id list, and that
// bounding it did not change a single fact it returns.
//
// WHY THIS IS A SUITE OF ITS OWN, AND NOT A CASE IN `api/grocery.test.ts`.
// That file is the HTTP contract of the three `…/groceries*` routes — status
// codes, wire bodies, stored rows, the revision that must not move. What is
// proven here is a property of the STATEMENTS the service issues, which no
// response body can show: a hydration that reads the whole `catalog_foods`
// table answers exactly the same JSON as one that reads three index ranges.
// Driving it through a route would also need a plan carrying hundreds of
// distinct foods, when the function under test is exported and takes the id
// list directly.
//
// WHAT THE COST ACTUALLY WAS. One `IN (…)` list per call, however long. On the
// loaded v1 release (`catalog_foods` 10,928 rows / 1,206 pages) the planner
// abandons the primary key once the list passes roughly 5 % of the table's
// rows — measured: Bitmap Heap Scan at 500 ids, Seq Scan with
// `Rows Removed by Filter: 10,328` at 600, and from there `shared hit=1206`,
// the table's ENTIRE relpages, no matter how few ids were asked for. So a
// per-plan read silently became a whole-table read whose cost no longer fell
// when the plan was small, and the oversized list cost ~2.1-2.9 ms to PLAN as
// well (against ~0.35 ms for a 300-id list in the same warm session). The
// service now cuts the deduplicated ids into statements of at most
// `CATALOG_FACTS_ID_CHUNK_SIZE`; the constant's doc block in
// `src/services/grocery.service.ts` carries the full measurement table.
//
// WHAT THIS SUITE ASSERTS, AND WHAT IT DELIBERATELY DOES NOT.
//
//  * IT ASSERTS THE BOUNDED LIST — no statement carries more than
//    {@link CHUNK_SIZE_UNDER_TEST} ids, and the number of `catalog_foods`
//    statements is exactly `ceil(N / 300)`. That property is the CAUSE of the
//    plan node staying on the primary key, and it is the half this suite can
//    own deterministically: it is a property of the code, not of the host.
//  * IT ASSERTS CORRECTNESS ACROSS THE CUT — at 1, 299, 300, 301, 600 and 800
//    distinct ids, every requested id comes back exactly once with the facts
//    the seeded rows hold. The 300/301 pair is the boundary that matters: 301
//    is the first list that becomes two statements, and a union assembled
//    wrongly would lose or duplicate the food that crossed.
//  * IT DOES NOT ASSERT THE PLAN NODE OR ANY TIMING. `EXPLAIN` output and
//    latency are properties of the server, the row count and the cache state;
//    the ambient test database holds a handful of fixture foods rather than a
//    release, so a Bitmap-vs-Seq assertion here would say something about the
//    fixture instead of about the code, and a duration would put host load into
//    the evidence. `api/benchmark.test.ts` states the same policy for search
//    latency, and the plan-node evidence for this read is the operator
//    `EXPLAIN (ANALYZE, BUFFERS)` run recorded against the loaded release.
//
// HOW THE STATEMENTS ARE OBSERVED. Through Prisma's `query` event, by the
// mechanism `src/__tests__/api/catalogCollation.test.ts` established: the
// shipped `src/prisma/client.ts` constructs its client with no `log` option, so
// `prisma.$on('query', …)` does not typecheck against the exported type, and a
// `jest.mock` factory therefore installs a client with
// `log: [{emit: 'event', level: 'query'}]`. Unlike that file, this one does NOT
// redirect the client at a database of its own: the statements under test must
// be issued against the AMBIENT test database the harness truncates, so the
// factory overrides nothing but the logging. The per-call sink and the
// `drainQueryEvents` settle are taken from the same precedent, for the same
// reason — a `query` event arrives asynchronously, so reading the log the
// moment a call returns can see none of its statements.
//
// THE ROWS ARE SEEDED THROUGH THE SHARED FACTORY, 800 of them, and the
// expectation is built from what the factory was ASKED for — never from a
// second call into the code path under test, which would agree with a broken
// implementation. The first case re-reads the whole table through a different
// query shape (no `IN` list at all) and asserts the expectation equals what the
// database actually holds, so the comparison the later cases make is anchored
// in the rows rather than in this file's arithmetic.

import { prisma } from '../../prisma/client';
import { GroceryFoodFacts } from '../../services/grocery.logic';
import { loadGroceryFoodFacts } from '../../services/grocery.service';
import { makeCatalogFood } from '../setup/factories';
import { truncateFeatureTables } from '../setup/testDb';

/* ---------------------------------------------------------------------------
 * Observing the statements
 *
 * The three declarations below are the `catalogCollation.test.ts` pattern,
 * narrowed to what this file reads. They are repeated rather than imported
 * because that file builds its client against a disposable ICU database and
 * exports nothing: sharing them would mean exporting a harness from a suite.
 * ------------------------------------------------------------------------- */

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
 * `src/prisma/client.ts` passes no `log` option, so the exported type carries
 * no `query` event and `prisma.$on('query', …)` does not typecheck — while the
 * instance the `jest.mock` factory below installs DOES emit them. This
 * interface is the narrowest bridge across that gap, so the cast stays checked
 * against a shape instead of becoming `any`.
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
 * takes to arrive depends on load. Reading the log after a single fixed tick is
 * a race in both directions: a call's own statements can arrive after the
 * assertion has read the log, turning "three statements" into zero, and those
 * same late statements can then land during the NEXT call and make "no
 * statement was issued" fail with someone else's SQL. Misattribution is fixed
 * structurally — every call records into a sink of its own (see
 * {@link hydrate}) — so only "did my own statement arrive yet" needs a wait,
 * and quiescence alone will not do for it: a few quiet polls cannot tell "no
 * statement will ever arrive" from "the statement has not arrived yet". This
 * therefore waits for the first statement up to a grace period and then drains
 * to quiet, so the empty-input case pays the grace and reports an honest empty
 * log rather than a raced one.
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

// Query-event logging and NOTHING ELSE. The client still resolves
// `DATABASE_URL` from the environment exactly as the shipped module does, so
// the statements observed here are issued against the same ambient test
// database `truncateFeatureTables` guards and truncates — which is what makes
// the seeded rows and the observed SQL two views of one thing. `emit: 'event'`
// rather than `'stdout'`, so an ordinary run prints nothing.
jest.mock('../../prisma/client', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { PrismaClient } = require('../../generated/prisma');

    return {
        prisma: new PrismaClient({ log: [{ emit: 'event', level: 'query' }] }),
    };
});

/* ---------------------------------------------------------------------------
 * What the statements are read for
 * ------------------------------------------------------------------------- */

/**
 * The chunk size this suite pins, restated rather than imported.
 *
 * `CATALOG_FACTS_ID_CHUNK_SIZE` is private to `grocery.service.ts`, and
 * deliberately so — nothing outside that module chooses it. Restating the
 * number here is what makes it a PINNED DECISION: the value is backed by a
 * measured margin (2.7 % of the loaded catalog, 1.67× below the last id count
 * that stayed on the index and 2× below the first that did not), so a future
 * change to it should have to come with a new measurement and an edit to this
 * expectation, not pass silently.
 */
const CHUNK_SIZE_UNDER_TEST = 300;

/** How many distinct foods the corpus holds: the largest case's id count. */
const SEEDED_FOOD_COUNT = 800;

/**
 * The id counts every case runs at.
 *
 * 1 is the degenerate list, 299/300 are the last single-statement lists, 301 is
 * the FIRST list that is cut in two, and 600/800 are the stress shapes the
 * measurement covered (600 being exactly where the unbounded statement flipped
 * to a sequential scan of the release).
 */
const CASE_ID_COUNTS: readonly number[] = [1, 299, 300, 301, 600, 800];

/**
 * A realistic plan's distinct-food count.
 *
 * AAP §0.5.1 publishes three meals a day for seven days, and that plan needs
 * 37-42 distinct catalog foods (measured). 42 is the top of that range, so the
 * "one statement" assertion below holds for every plan a user can generate —
 * the common path's statement count is unchanged by chunking, which is the
 * no-regression half of this suite.
 */
const PLAN_SHAPED_ID_COUNT = 42;

/** How many copies of one id the dedup case passes in. */
const DUPLICATE_ID_REPEATS = 400;

/* ---------------------------------------------------------------------------
 * Reading the recorded SQL
 * ------------------------------------------------------------------------- */

/** The hydration's parent statement: the projection over `catalog_foods`. */
const CATALOG_FOODS_FROM = 'FROM "public"."catalog_foods"';

/** Its relation statement: the `is_default` portion of the foods it returned. */
const CATALOG_PORTIONS_FROM = 'FROM "public"."catalog_food_portions"';

/**
 * Every `IN (…)` list in one statement, as its length.
 *
 * Prisma renders a list predicate as `IN ($1,$2,…)` — one placeholder per
 * value — so the number of placeholders in the group IS the number of ids that
 * statement carries. Counted from the SQL rather than from the bound
 * parameters because the parameter array also holds the `OFFSET` value, and it
 * is the list the planner sees that the bound is about.
 */
const inListLengths = (sql: string): number[] =>
    [...sql.matchAll(/ IN \((\$\d+(?:,\$\d+)*)\)/g)].map((match) => match[1].split(',').length);

/** The longest id list any of these statements carried, or 0 when none did. */
const longestIdList = (statements: readonly string[]): number =>
    statements.flatMap(inListLengths).reduce((longest, length) => Math.max(longest, length), 0);

const statementsFrom = (statements: readonly string[], table: string): string[] =>
    statements.filter((sql) => sql.includes(table));

/* ---------------------------------------------------------------------------
 * The corpus
 *
 * 800 foods that differ in every column the facts carry, so an entry matched to
 * the wrong id is a failure rather than a coincidence. The cycles are coprime
 * with each other and with the chunk size, which is what keeps a chunk
 * boundary from landing on a repeating shape.
 * ------------------------------------------------------------------------- */

const CATEGORY_CYCLE: readonly string[] = ['produce_vegetable', 'protein_meat', 'dairy', 'grain', 'other'];

const FOOD_STATE_CYCLE: readonly string[] = ['raw', 'cooked', 'dry'];

/**
 * Densities including the null case. Every value is exactly representable in
 * binary floating point, so a stored `double precision` round trip returns the
 * number this file wrote and the comparison needs no epsilon.
 */
const DENSITY_CYCLE: readonly (number | null)[] = [null, 0.5, 0.25, 0.75];

/**
 * Default portions whose `amount` is NOT always 1 — the property the
 * projection's `amount` column exists for, since `volumeDensityFor` computes a
 * density as `gram_weight / (amount * ml per unit)`.
 */
const PORTION_CYCLE: readonly { description: string; amount: number; unit: string; gram_weight: number }[] = [
    { description: '1 cup', amount: 1, unit: 'cup', gram_weight: 200 },
    { description: '0.5 cup', amount: 0.5, unit: 'cup', gram_weight: 107 },
    { description: '2 tbsp', amount: 2, unit: 'tbsp', gram_weight: 30 },
];

/**
 * Every 11th food keeps NO default portion, and every 7th carries a SECOND,
 * non-default one.
 *
 * Both exist to keep the projection honest across the cut. A `default_portion:
 * null` food is what validation quarantines and the rules tolerate for a mass
 * row, and a food with a non-default portion beside its default one is how the
 * `is_default` sub-select would be caught if a chunked read ever dropped it —
 * the extra portion is an unsized container ("1 bottle"), exactly the line the
 * display contract forbids generating, so projecting it would be visible. Food
 * 77 is both, which is the sharpest shape available: a non-default portion
 * exists and the facts must still read null.
 */
const PORTIONLESS_EVERY = 11;

const EXTRA_PORTION_EVERY = 7;

/** The seeded ids in seeding order; every case takes its list from the front. */
const seededIds: string[] = [];

/** The facts each seeded id must produce, from what the factory was asked for. */
const expectedFactsById = new Map<string, GroceryFoodFacts>();

const expectedFactsFor = (ids: readonly string[]): GroceryFoodFacts[] =>
    ids.map((id) => {
        const facts = expectedFactsById.get(id);

        if (facts === undefined) {
            throw new Error(`${id} was not seeded by this suite, so no expectation can be resolved through it`);
        }

        return facts;
    });

const byFoodId = (left: GroceryFoodFacts, right: GroceryFoodFacts): number =>
    left.catalog_food_id.localeCompare(right.catalog_food_id);

/**
 * Generous on purpose: 800 foods are inserted one by one through the shared
 * factory (a nested create each, so a food is never observable without its
 * portion), and the twelve hydrations below each pay the settle grace. The
 * corpus size is not negotiable — 800 is the stress shape the measurement
 * covered and the only size at which a three-chunk union is exercised — so when
 * this suite is slow the timeout is what moves.
 */
jest.setTimeout(300_000);

beforeAll(async () => {
    await truncateFeatureTables();

    for (let ordinal = 0; ordinal < SEEDED_FOOD_COUNT; ordinal += 1) {
        const portion = PORTION_CYCLE[ordinal % PORTION_CYCLE.length];
        const food = await makeCatalogFood({
            category: CATEGORY_CYCLE[ordinal % CATEGORY_CYCLE.length],
            food_state: FOOD_STATE_CYCLE[ordinal % FOOD_STATE_CYCLE.length],
            density_g_per_ml: DENSITY_CYCLE[ordinal % DENSITY_CYCLE.length],
            defaultPortion: portion,
        });

        const portionless = (ordinal + 1) % PORTIONLESS_EVERY === 0;

        seededIds.push(food.id);
        expectedFactsById.set(food.id, {
            catalog_food_id: food.id,
            food_state: food.food_state,
            name: food.display_name,
            category: food.category,
            density_g_per_ml: food.density_g_per_ml,
            default_portion: portionless ? null : { ...portion },
        });
    }

    // The two deviations from "one food, one default portion", applied after the
    // factory has produced its uniform rows so the deviation is visible here
    // rather than hidden in a factory option.
    const portionlessIds = seededIds.filter((_id, ordinal) => (ordinal + 1) % PORTIONLESS_EVERY === 0);

    await prisma.catalog_food_portions.deleteMany({ where: { catalog_food_id: { in: portionlessIds } } });
    await prisma.catalog_food_portions.createMany({
        data: seededIds
            .filter((_id, ordinal) => (ordinal + 1) % EXTRA_PORTION_EVERY === 0)
            .map((catalogFoodId) => ({
                catalog_food_id: catalogFoodId,
                description: '1 bottle',
                amount: 1,
                unit: 'bottle',
                gram_weight: 750,
                is_default: false,
                source: 'fixture_non_default_portion',
            })),
    });
});

afterAll(async () => {
    // `--runInBand` means every later suite pays for anything left behind, and
    // 800 stray foods would corrupt the counts `api/catalog.test.ts` asserts.
    await truncateFeatureTables();
});

/* ---------------------------------------------------------------------------
 * The instrument
 * ------------------------------------------------------------------------- */

/**
 * Where a `query` event is recorded, or null while nothing is listening.
 *
 * Prisma exposes no `$off`, so the listener registered below outlives every
 * test. A PER-CALL sink rather than one shared array plus a flag is what bounds
 * what any one assertion sees: a statement that lands late can only ever reach
 * the sink of the call that issued it, so seeding statements and the next
 * case's statements can never be counted against this one.
 */
let activeStatementSink: string[] | null = null;

beforeAll(() => {
    (prisma as unknown as QueryEventSource).$on('query', (event) => {
        activeStatementSink?.push(event.query);
    });
});

/** Calls the hydration with its own statement log and returns both. */
const hydrate = async (ids: readonly string[]): Promise<{ facts: GroceryFoodFacts[]; statements: string[] }> => {
    const sink: string[] = [];
    activeStatementSink = sink;

    const facts = await loadGroceryFoodFacts(ids);
    await drainQueryEvents(sink);

    activeStatementSink = null;

    return { facts, statements: [...sink] };
};

/* ---------------------------------------------------------------------------
 * The corpus the expectations come from
 * ------------------------------------------------------------------------- */

describe('the seeded corpus', () => {
    it('holds exactly the facts this suite expects, read back without an id list', async () => {
        // A DIFFERENT query shape on purpose — the whole table, no `IN (…)` —
        // so the expectation the cases below compare against is anchored in the
        // rows themselves rather than in a second call into the code under test,
        // which would agree with a broken implementation.
        const foods = await prisma.catalog_foods.findMany({
            select: { id: true, display_name: true, category: true, food_state: true, density_g_per_ml: true },
        });
        const portions = await prisma.catalog_food_portions.findMany({
            where: { is_default: true },
            select: { catalog_food_id: true, description: true, amount: true, unit: true, gram_weight: true },
        });
        const defaultPortionByFoodId = new Map(
            portions.map((portion) => [
                portion.catalog_food_id,
                {
                    description: portion.description,
                    amount: portion.amount,
                    unit: portion.unit,
                    gram_weight: portion.gram_weight,
                },
            ]),
        );

        const stored: GroceryFoodFacts[] = foods.map((food) => ({
            catalog_food_id: food.id,
            food_state: food.food_state,
            name: food.display_name,
            category: food.category,
            density_g_per_ml: food.density_g_per_ml,
            default_portion: defaultPortionByFoodId.get(food.id) ?? null,
        }));

        expect(stored).toHaveLength(SEEDED_FOOD_COUNT);
        expect([...stored].sort(byFoodId)).toStrictEqual(expectedFactsFor(seededIds).sort(byFoodId));
    });

    it('includes the shapes the projection has to survive', () => {
        const expectations = expectedFactsFor(seededIds);

        // A food with no default portion, one whose portion is not one of its
        // unit (the `amount` column's reason for existing), and a null density
        // beside real ones. Asserted as counts so a corpus that quietly lost a
        // shape fails here rather than weakening a case downstream.
        expect(expectations.filter((facts) => facts.default_portion === null)).toHaveLength(
            Math.floor(SEEDED_FOOD_COUNT / PORTIONLESS_EVERY),
        );
        expect(expectations.filter((facts) => facts.default_portion?.amount === 0.5).length).toBeGreaterThan(0);
        expect(expectations.filter((facts) => facts.density_g_per_ml === null).length).toBeGreaterThan(0);
        expect(expectations.filter((facts) => facts.density_g_per_ml === 0.75).length).toBeGreaterThan(0);
    });
});

/* ---------------------------------------------------------------------------
 * Correctness across the cut, and the bound that causes the index path
 * ------------------------------------------------------------------------- */

describe.each(CASE_ID_COUNTS)('hydrating %i distinct ids', (idCount) => {
    const expectedChunkLengths: number[] = [];
    let facts: GroceryFoodFacts[] = [];
    let statements: string[] = [];
    let requested: string[] = [];

    beforeAll(async () => {
        requested = seededIds.slice(0, idCount);

        for (let offset = 0; offset < idCount; offset += CHUNK_SIZE_UNDER_TEST) {
            expectedChunkLengths.push(Math.min(CHUNK_SIZE_UNDER_TEST, idCount - offset));
        }

        ({ facts, statements } = await hydrate(requested));
    });

    it('returns every requested id exactly once', () => {
        expect(facts).toHaveLength(idCount);
        expect([...new Set(facts.map((entry) => entry.catalog_food_id))]).toHaveLength(idCount);
        expect(facts.map((entry) => entry.catalog_food_id).sort()).toStrictEqual([...requested].sort());
    });

    it('returns the facts the seeded rows hold, unchanged by the cut', () => {
        // Sorted by id on both sides: the array order of a chunked read is the
        // concatenation of the chunks' own orders, and no caller depends on it
        // (`conversionFactsByFoodId` keys by id). What must not change is the
        // CONTENT, field for field, including the null default portions.
        expect([...facts].sort(byFoodId)).toStrictEqual(expectedFactsFor(requested).sort(byFoodId));
    });

    it(`asks for at most ${String(CHUNK_SIZE_UNDER_TEST)} ids in any one statement`, () => {
        // The property this suite exists for. It covers the relation statement
        // too, which carries the ids the parent chunk matched, so neither half
        // of the hydration can present the planner with an oversized list.
        expect(longestIdList(statements)).toBeLessThanOrEqual(CHUNK_SIZE_UNDER_TEST);
    });

    it('cuts the ids into ceil(n / chunk) catalog_foods statements', () => {
        const parents = statementsFrom(statements, CATALOG_FOODS_FROM);

        expect(parents).toHaveLength(Math.ceil(idCount / CHUNK_SIZE_UNDER_TEST));
        // The exact cut, not just its count: a 301-id list must be 300 + 1, and
        // an implementation that split it 151 + 150 (or asked twice for the same
        // 300) would satisfy the count and fail here.
        expect(parents.flatMap(inListLengths)).toStrictEqual(expectedChunkLengths);
        expect(parents.flatMap(inListLengths).reduce((total, length) => total + length, 0)).toBe(idCount);
    });

    it('reads the default portions once per chunk and no more', () => {
        // Prisma answers the nested `is_default` relation with a statement of
        // its own per parent read, so the whole hydration stays at two
        // statements per chunk — the count the measurement calls "nearly free"
        // beside the planning time an oversized list costs.
        const portionStatements = statementsFrom(statements, CATALOG_PORTIONS_FROM);

        expect(portionStatements).toHaveLength(expectedChunkLengths.length);
        expect(statements).toHaveLength(expectedChunkLengths.length * 2);
    });
});

/* ---------------------------------------------------------------------------
 * The inputs that must cost nothing
 * ------------------------------------------------------------------------- */

describe('inputs that need no statement of their own', () => {
    it('issues no statement at all for an empty id list', async () => {
        const { facts, statements } = await hydrate([]);

        // The early return predates the chunking and must survive it: a loop
        // over zero chunks would also return `[]`, but a `WHERE id IN ()` sent
        // to PostgreSQL would be a round trip for an answer the caller already
        // has. The drain pays its grace period here, so an empty log is an
        // observation rather than a race.
        expect(facts).toStrictEqual([]);
        expect(statements).toStrictEqual([]);
    });

    it('collapses repeated ids into one statement and one entry', async () => {
        const [firstId] = seededIds;
        const { facts, statements } = await hydrate(new Array<string>(DUPLICATE_ID_REPEATS).fill(firstId));

        // 400 copies of one id is past the chunk size, so a dedup applied AFTER
        // the cut would issue two statements for one food and return it twice.
        // The service deduplicates first, which is why this is one statement
        // carrying one id.
        expect(facts).toStrictEqual(expectedFactsFor([firstId]));
        expect(statementsFrom(statements, CATALOG_FOODS_FROM)).toHaveLength(1);
        expect(longestIdList(statements)).toBe(1);
    });
});

/* ---------------------------------------------------------------------------
 * The common path, which must not have regressed
 * ------------------------------------------------------------------------- */

describe('a plan-shaped id list', () => {
    it('costs exactly one catalog_foods statement for the 42 foods a week needs', async () => {
        const requested = seededIds.slice(0, PLAN_SHAPED_ID_COUNT);
        const { facts, statements } = await hydrate(requested);

        // The no-regression assertion: every plan a user can generate needs
        // 37-42 distinct foods (§0.5.1), so chunking changed the statement count
        // of the path that actually runs by nothing at all.
        expect(statementsFrom(statements, CATALOG_FOODS_FROM)).toHaveLength(1);
        expect(longestIdList(statements)).toBe(PLAN_SHAPED_ID_COUNT);
        expect([...facts].sort(byFoodId)).toStrictEqual(expectedFactsFor(requested).sort(byFoodId));
    });
});
