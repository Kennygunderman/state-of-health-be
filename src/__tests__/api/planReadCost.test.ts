// The READ-COST proof for the planning candidate projection:
// `recipe.service.ts::getRecipeVersionsForPlanning`, the whole-corpus read the
// swap alternatives list and the swap preview are both built on.
//
// WHAT THIS FILE OWNS, AND WHY IT IS ITS OWN SUITE. The projection loads every
// current source-backed recipe version, every one of their `recipe_ingredients`
// rows and those ingredients' `catalog_foods` — four statements — and it used to
// run on EVERY alternatives and preview request, which made the dominant term of
// both reads proportional to the CATALOG rather than to the request. It is now
// served from a process-local cache inside `recipe.service.ts`, validated on
// every call by a content hash of exactly the rows and columns it projects.
// Everything below is a property of that arrangement: how many statements a
// request costs, and — far more importantly — that a cached answer can never
// outlive the data it was built from.
//
// The behaviour of the three swap endpoints themselves belongs to
// `api/swaps.test.ts` and the selection rules to
// `services/__tests__/swap.logic.test.ts`; neither is restated here. What this
// file asserts is invisible to both: they would pass identically with the cache
// removed, and they would also pass with a cache that served a stale corpus.
//
// THE SAFETY ASSERTION IS THE CENTRE OF THE FILE. AAP §0.7.3 requires
// `catalog_foods.{food_group, allergen_status}` to be read LIVE per ingredient,
// so that withdrawing a food's allergen review immediately stops every recipe
// containing it from being planned. A cache is the one thing that could break
// that guarantee silently, which is why "a food's `allergen_status` changes and
// the very next read reflects it" is asserted twice below — once on the service
// projection itself, and once end to end through
// `GET …/alternatives`, where the affected candidate must disappear from the
// list.
//
// NOTHING HERE RESETS THE CACHE, AND THAT IS DELIBERATE. `recipe.service.ts`
// exports no cache-reset hook: the corpus is written only by separate operator
// CLI processes (`recipes-seed.ts`, `catalog-load.ts`, …), so an in-process
// invalidation hook could never observe a publication and the freshness check
// has to be a per-read question asked of the database. This suite is the proof
// that content addressing makes a reset unnecessary: every case below runs after
// `truncateFeatureTables()` has emptied the corpus and a fresh fixture has been
// seeded — with the same fixed `published_at` literal every recipe fixture
// carries — and the first read of each case is asserted to RELOAD. A cache keyed
// on anything coarser (a release id, or counts plus maximum timestamps) would
// serve the previous test's corpus here.
//
// HOW STATEMENTS ARE COUNTED. Through Prisma's `query` event, which reports the
// exact SQL the service issued — the instrument `api/catalogCollation.test.ts`
// established, reused rather than reinvented, including its settle helper
// (`query` events are delivered asynchronously) and its `jest.mock` of the
// Prisma singleton: the shipped `src/prisma/client.ts` is two lines with no
// `log` option, so `prisma.$on('query', …)` does not typecheck against it and a
// suite that wants events has to construct its own client. Unlike that file,
// this one points the client at the AMBIENT test database — the same database
// `truncateFeatureTables` and the factories use — because the app, the harness
// and the assertions all have to see one corpus.

/** One statement Prisma executed, as its `query` event reports it. */
interface QueryEvent {
    /** The SQL with `$n` placeholders, exactly as the engine sent it. */
    query: string;
}

/**
 * The `query`-event surface of the Prisma singleton — the narrowest bridge
 * across the gap the header describes, so the cast stays checked against a
 * shape rather than becoming `any`.
 */
interface QueryEventSource {
    $on(event: 'query', listener: (event: QueryEvent) => void): void;
}

// The singleton every service, the test app and the truncation helper resolve,
// rebuilt with query-event logging and otherwise identical: no `datasourceUrl`
// override, so it connects to the same ambient `DATABASE_URL` the shipped module
// would. `emit: 'event'` and not `'stdout'`, so nothing is printed during an
// ordinary run.
jest.mock('../../prisma/client', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { PrismaClient } = require('../../generated/prisma');

    return { prisma: new PrismaClient({ log: [{ emit: 'event', level: 'query' }] }) };
});

import { prisma } from '../../prisma/client';
import { getRecipeVersionsForPlanning } from '../../services/recipe.service';
import { PlanRecipeCandidate } from '../../services/mealPlan.logic';
import { SwapAlternativesResponse, SwapPreviewResponse } from '../../types/mealPlanning';
import {
    FIXTURE_USER_TARGET_COLUMNS,
    FixtureRecipeVersion,
    makePlan,
    makePreferences,
    makeRecipeVersion,
    makeUser,
} from '../setup/factories';
import { asUser, request } from '../setup/testApp';
import { truncateFeatureTables } from '../setup/testDb';

/* ---------------------------------------------------------------------------
 * The statement instrument
 * ------------------------------------------------------------------------- */

/** Poll interval while waiting for the barrier statement's event, in milliseconds. */
const QUERY_SETTLE_POLL_MS = 2;

/** How long a settle waits for that event before declaring the instrument broken. */
const QUERY_SETTLE_TIMEOUT_MS = 5_000;

/**
 * The barrier statement's alias. Distinctive because it is matched on, and
 * excluded from every count below — the instrument must not measure itself.
 */
const SENTINEL_MARKER = 'plan_read_cost_sentinel';

const isSentinelStatement = (event: QueryEvent): boolean => event.query.includes(SENTINEL_MARKER);

/**
 * Waits until every statement of the measured call has been RECORDED, not
 * merely issued.
 *
 * `api/catalogCollation.test.ts` records why a wait is needed at all: a Prisma
 * `query` event is emitted ASYNCHRONOUSLY, so reading the log straight after an
 * awaited call races in both directions — a call's own statements can arrive
 * after the assertion has read the log (a count reads low), and those same
 * stragglers can then land during the NEXT call (a count reads high).
 * Misattribution is prevented structurally, by giving every measured call a sink
 * of its own ({@link measure}); what remains is "have my own statements arrived
 * yet", and that file answers it with a grace period plus quiescence.
 *
 * THIS FILE ANSWERS IT WITH A BARRIER INSTEAD, because its assertions are exact
 * counts — "this request issued the corpus projection zero times" — and a
 * time-based settle can only ever say "nothing has arrived for a while", which
 * on a loaded shared host is indistinguishable from a slow delivery. So the
 * settle issues one trivial statement of its own AFTER the call and waits for
 * THAT statement's event: the client reports its events in the order the engine
 * completed them, so the barrier's arrival is positive evidence that every
 * statement issued before it has already been recorded.
 *
 * A barrier that never arrives THROWS, naming the instrument. Every count in
 * this file would otherwise silently read low, which is the direction that turns
 * a regression into a pass.
 */
const settleStatements = async (sink: readonly QueryEvent[]): Promise<void> => {
    const tick = () => new Promise((resolve) => setTimeout(resolve, QUERY_SETTLE_POLL_MS));

    await prisma.$queryRaw`SELECT 1 AS plan_read_cost_sentinel`;

    const deadline = Date.now() + QUERY_SETTLE_TIMEOUT_MS;

    while (!sink.some(isSentinelStatement)) {
        if (Date.now() >= deadline) {
            throw new Error(
                `The statement instrument did not observe its own barrier within ` +
                    `${QUERY_SETTLE_TIMEOUT_MS} ms (${sink.length} statements recorded). Every count ` +
                    'in this suite would read low, so the run is failed rather than reported.',
            );
        }

        await tick();
    }
};

/**
 * Where statements are recorded while a measurement is open, and `null`
 * otherwise — so the fixture seeding in `beforeEach` (hundreds of statements)
 * is never counted against a case.
 */
let activeSink: QueryEvent[] | null = null;

/**
 * The alias the freshness statement projects. Present in no other statement in
 * the codebase, so it identifies the per-read content hash exactly.
 */
const STAMP_MARKER = 'versions_stamp';

/**
 * What identifies the PROJECTION's root statement, and why these three markers
 * together.
 *
 * `getRecipeVersionsForPlanning` is the only read that orders `recipe_versions`
 * by the JOINED recipe slug, which Prisma emits as the `orderby_1` alias. The
 * per-serving column pins it to the candidate projection rather than to the two
 * id-keyed reads in the same module, and excluding the stamp marker keeps the
 * freshness check — which names the same columns in its hash — out of the count.
 */
const PROJECTION_MARKERS: readonly string[] = [
    '"public"."recipe_versions"',
    '"orderby_1"."slug" ASC',
    '"per_serving_calories"',
];

const isStampStatement = (event: QueryEvent): boolean => event.query.includes(STAMP_MARKER);

const isProjectionStatement = (event: QueryEvent): boolean =>
    !isStampStatement(event) && PROJECTION_MARKERS.every((marker) => event.query.includes(marker));

/** What one measured call cost, in statements — the instrument's own barrier excluded. */
interface StatementCost {
    /** Executions of the whole-corpus projection — the four-statement read. */
    projections: number;
    /** Executions of the one-statement freshness check. */
    stamps: number;
    /** Every statement the call issued, the projection's relation loads included. */
    total: number;
}

const costOf = (sink: readonly QueryEvent[]): StatementCost => {
    const statements = sink.filter((event) => !isSentinelStatement(event));

    return {
        projections: statements.filter(isProjectionStatement).length,
        stamps: statements.filter(isStampStatement).length,
        total: statements.length,
    };
};

/**
 * Runs one operation with a statement sink of its own and reports what it cost.
 *
 * The sink is installed for the duration of the call and removed afterwards, so
 * a straggler can only ever reach the sink of the call that issued it.
 */
const measure = async <TResult>(
    operation: () => Promise<TResult>,
): Promise<{ result: TResult; cost: StatementCost }> => {
    const sink: QueryEvent[] = [];
    activeSink = sink;

    try {
        const result = await operation();
        await settleStatements(sink);

        return { result, cost: costOf(sink) };
    } finally {
        activeSink = null;
    }
};

/* ---------------------------------------------------------------------------
 * The world
 * ------------------------------------------------------------------------- */

const USER_ID = 'plan-read-cost-user';

/**
 * A two-day week starting yesterday, so it holds every zone's today and stays
 * the user's current plan. Two days rather than seven because nothing here
 * depends on the week's shape — only on one day having a swappable lunch.
 */
const PLAN_DAY_COUNT = 2;

/** The planned day the swap cases aim at: the second, which is today. */
const PLANNED_DAY_INDEX = 1;

const LUNCH_SLOT = 'lunch';

/**
 * The planned meal's per-serving nutrition. Three of these make a 2,100 kcal day
 * — exactly `FIXTURE_TARGETS` — so the seeded day starts inside every tolerance
 * §0.7.3 states and a candidate's admissibility is decided by the candidate.
 */
const PLANNED_PER_SERVING = { calories: 700, protein: 52, carbs: 70, fat: 23 };

/**
 * The candidates' per-serving nutrition. At ×1 the day becomes 2,160 kcal /
 * 162 P / 216 C / 71 F, inside the day tolerance on all four (and ×1.25 is
 * outside it), so every candidate below is offered at ×1 — the same arithmetic
 * `api/swaps.test.ts` already relies on for its equal-portion candidate.
 */
const CANDIDATE_PER_SERVING = { calories: 760, protein: 58, carbs: 76, fat: 25 };

/** The portion every candidate here is admissible at; see above. */
const CANDIDATE_PORTION_MULTIPLIER = 1;

/**
 * Slugs, stated rather than derived, because the ORDER they impose is asserted:
 * the projection's contract is `(slug, version)` ascending, and these four sort
 * into a different order from the one they are created in, so a result that
 * merely echoed insertion order could not pass.
 */
const PLANNED_SLUG = 'plan-read-cost-planned';
const FIRST_CANDIDATE_SLUG = 'plan-read-cost-candidate-a';
const SECOND_CANDIDATE_SLUG = 'plan-read-cost-candidate-b';
const ADDED_CANDIDATE_SLUG = 'plan-read-cost-candidate-added';

interface SuiteFixture {
    plannedRecipe: FixtureRecipeVersion;
    /** The candidate whose food the allergen-withdrawal case re-reviews. */
    firstCandidate: FixtureRecipeVersion;
    /** The candidate that must survive that withdrawal, so the flip is shown to be targeted. */
    secondCandidate: FixtureRecipeVersion;
    planId: string;
    lunchMealId: string;
}

let fixture: SuiteFixture;

/**
 * One recipe at exactly the given per-serving nutrition, with a food of its own.
 *
 * `perServing` rather than composed ingredients: the factory synthesises the
 * single ingredient that adds up to it, so the stored per-serving columns cannot
 * disagree with the ingredient rows — and because each call omits
 * `catalogFoodId`, every recipe gets a DISTINCT `catalog_foods` row. That is
 * what makes the allergen-withdrawal case surgical: re-reviewing one food can
 * only affect the one recipe that uses it.
 */
const makeCandidateRecipe = async (
    slug: string,
    perServing: typeof PLANNED_PER_SERVING,
): Promise<FixtureRecipeVersion> => makeRecipeVersion({ slug, perServing });

const seedFixture = async (): Promise<SuiteFixture> => {
    await makeUser({ id: USER_ID, ...FIXTURE_USER_TARGET_COLUMNS });
    await makePreferences(USER_ID);

    const plannedRecipe = await makeCandidateRecipe(PLANNED_SLUG, PLANNED_PER_SERVING);
    const firstCandidate = await makeCandidateRecipe(FIRST_CANDIDATE_SLUG, CANDIDATE_PER_SERVING);
    const secondCandidate = await makeCandidateRecipe(SECOND_CANDIDATE_SLUG, CANDIDATE_PER_SERVING);

    const plan = await makePlan(USER_ID, {
        dayCount: PLAN_DAY_COUNT,
        recipeVersionId: plannedRecipe.id,
    });

    const plannedDay = plan.meal_plan_days[PLANNED_DAY_INDEX];
    const lunch = plannedDay.meal_plan_meals.find((meal) => meal.slot === LUNCH_SLOT);

    if (lunch === undefined) {
        throw new Error('The plan fixture has no lunch to swap; makePlan no longer plants one.');
    }

    return {
        plannedRecipe,
        firstCandidate,
        secondCandidate,
        planId: plan.id,
        lunchMealId: lunch.id,
    };
};

/* ---------------------------------------------------------------------------
 * The reads under measurement
 * ------------------------------------------------------------------------- */

const alternativesPath = (): string =>
    `/api/meal-planning/plans/${fixture.planId}/meals/${fixture.lunchMealId}/alternatives`;

const previewPath = (recipeVersionId: string): string =>
    `${alternativesPath()}/${recipeVersionId}/preview`;

const readAlternatives = async (): Promise<SwapAlternativesResponse> => {
    const response = await asUser(request.get(alternativesPath()), { uid: USER_ID }).expect(200);

    return response.body as SwapAlternativesResponse;
};

const readPreview = async (recipeVersionId: string): Promise<SwapPreviewResponse> => {
    const response = await asUser(request.get(previewPath(recipeVersionId)), {
        uid: USER_ID,
    }).expect(200);

    return response.body as SwapPreviewResponse;
};

/** The candidate slugs the projection returned, in the order it returned them. */
const slugsOf = (candidates: readonly PlanRecipeCandidate[]): string[] =>
    candidates.map((candidate) => candidate.slug);

const alternativeIdsOf = (response: SwapAlternativesResponse): string[] =>
    response.alternatives.map((alternative) => alternative.recipeVersionId);

/** The one candidate for a slug, with a failure that names it when it is absent. */
const candidateFor = (candidates: readonly PlanRecipeCandidate[], slug: string): PlanRecipeCandidate => {
    const found = candidates.find((candidate) => candidate.slug === slug);

    if (found === undefined) {
        throw new Error(
            `The planning projection no longer carries "${slug}"; it returned ${JSON.stringify(
                slugsOf(candidates),
            )}.`,
        );
    }

    return found;
};

beforeAll(() => {
    (prisma as unknown as QueryEventSource).$on('query', (event) => {
        activeSink?.push(event);
    });
});

beforeEach(async () => {
    await truncateFeatureTables();
    fixture = await seedFixture();
});

afterAll(async () => {
    await truncateFeatureTables();
});

/* ---------------------------------------------------------------------------
 * (a) The cost of a repeated read
 * ------------------------------------------------------------------------- */

describe('the planning candidate projection is loaded once per corpus', () => {
    it('issues the whole-corpus projection on the first read and never again for the same corpus', async () => {
        const first = await measure(() => getRecipeVersionsForPlanning());
        const second = await measure(() => getRecipeVersionsForPlanning());

        // Four statements for the projection — the version rows, their recipes,
        // their ingredients and those ingredients' foods — plus the one-statement
        // freshness check the read now begins with.
        expect(first.cost.projections).toBe(1);
        expect(first.cost.stamps).toBe(1);
        expect(first.cost.total).toBe(5);

        // The whole of a repeat read: one statement, no projection.
        expect(second.cost.projections).toBe(0);
        expect(second.cost.stamps).toBe(1);
        expect(second.cost.total).toBe(1);
    });

    it('reloads after the corpus is emptied and reseeded, with no cache-reset hook', async () => {
        await measure(() => getRecipeVersionsForPlanning());

        // The state every case in this file starts from: a corpus replaced
        // wholesale between two reads, with identical content shapes and the
        // same fixed `published_at` literal, and no reset call in between.
        await truncateFeatureTables();
        fixture = await seedFixture();

        const afterReseed = await measure(() => getRecipeVersionsForPlanning());

        expect(afterReseed.cost.projections).toBe(1);
        expect(slugsOf(afterReseed.result)).toEqual([
            FIRST_CANDIDATE_SLUG,
            SECOND_CANDIDATE_SLUG,
            PLANNED_SLUG,
        ]);
    });

    it('loads the corpus once for two alternatives requests', async () => {
        const first = await measure(readAlternatives);
        const second = await measure(readAlternatives);

        expect(first.cost.projections).toBe(1);
        expect(second.cost.projections).toBe(0);

        // Each request still asks the freshness question exactly once — the
        // cache is validated per read, never assumed for a window of time.
        expect(first.cost.stamps).toBe(1);
        expect(second.cost.stamps).toBe(1);

        // The answer is unchanged by where it came from.
        expect(alternativeIdsOf(second.result)).toEqual(alternativeIdsOf(first.result));
        expect(alternativeIdsOf(first.result)).toEqual([
            fixture.firstCandidate.id,
            fixture.secondCandidate.id,
        ]);
    });

    it('loads the corpus once for an alternatives request followed by a preview', async () => {
        const alternatives = await measure(readAlternatives);
        const preview = await measure(() => readPreview(fixture.firstCandidate.id));

        expect(alternatives.cost.projections).toBe(1);
        expect(preview.cost.projections).toBe(0);
        expect(preview.cost.stamps).toBe(1);

        expect(preview.result.alternative.recipe.versionId).toBe(fixture.firstCandidate.id);
        expect(preview.result.alternative.portionMultiplier).toBe(CANDIDATE_PORTION_MULTIPLIER);
    });

    it('collapses concurrent first reads into one load', async () => {
        const { result, cost } = await measure(() =>
            Promise.all([getRecipeVersionsForPlanning(), getRecipeVersionsForPlanning()]),
        );

        // The in-flight load is shared, so a cold start under concurrency costs
        // one projection rather than one per caller.
        expect(cost.projections).toBe(1);

        const [left, right] = result;
        expect(slugsOf(left)).toEqual(slugsOf(right));
        expect(left).not.toBe(right);
    });
});

/* ---------------------------------------------------------------------------
 * (b) The AAP §0.7.3 liveness guarantee — the assertion this file exists for
 * ------------------------------------------------------------------------- */

describe('a catalog re-review invalidates the cached candidates immediately', () => {
    /** Withdraws one food's allergen review — the safety-critical column. */
    const withdrawAllergenReview = async (catalogFoodId: string): Promise<void> => {
        await prisma.catalog_foods.update({
            where: { id: catalogFoodId },
            data: { allergen_status: 'unknown' },
        });
    };

    const foodOf = (recipe: FixtureRecipeVersion): string => {
        const [ingredient] = recipe.recipe_ingredients;

        if (ingredient === undefined) {
            throw new Error('A recipe fixture was created with no ingredients.');
        }

        return ingredient.catalog_food_id;
    };

    it('reloads and reports the withdrawn review on the very next read', async () => {
        const before = await measure(() => getRecipeVersionsForPlanning());
        expect(candidateFor(before.result, FIRST_CANDIDATE_SLUG).ingredients[0].allergen_status).toBe(
            'known',
        );

        await withdrawAllergenReview(foodOf(fixture.firstCandidate));

        const after = await measure(() => getRecipeVersionsForPlanning());

        // The stamp hashes `catalog_foods.allergen_status` (and `updated_at`,
        // which PostgreSQL bumps on any write), so the next read cannot be
        // served from the cache.
        expect(after.cost.projections).toBe(1);
        expect(candidateFor(after.result, FIRST_CANDIDATE_SLUG).ingredients[0].allergen_status).toBe(
            'unknown',
        );

        // Targeted: the other candidate's own review is untouched.
        expect(candidateFor(after.result, SECOND_CANDIDATE_SLUG).ingredients[0].allergen_status).toBe(
            'known',
        );
    });

    it('stops offering the affected recipe through GET …/alternatives', async () => {
        const before = await measure(readAlternatives);
        expect(alternativeIdsOf(before.result)).toContain(fixture.firstCandidate.id);

        await withdrawAllergenReview(foodOf(fixture.firstCandidate));

        const after = await measure(readAlternatives);

        expect(after.cost.projections).toBe(1);
        // An ingredient whose review has been withdrawn is unreviewed, and an
        // unreviewed ingredient is never plannable for anybody (§0.7.3).
        expect(alternativeIdsOf(after.result)).toEqual([fixture.secondCandidate.id]);
    });

    it('reloads when a food that is not an allergen matter changes too', async () => {
        await measure(() => getRecipeVersionsForPlanning());

        // `food_group` is the other live column the projection joins: a dislike
        // stores a food's group, so a group assigned after publication must
        // exclude the recipe for a user who disliked that group.
        await prisma.catalog_foods.update({
            where: { id: foodOf(fixture.firstCandidate) },
            data: { food_group: 'plan-read-cost-regrouped' },
        });

        const after = await measure(() => getRecipeVersionsForPlanning());

        expect(after.cost.projections).toBe(1);
        expect(candidateFor(after.result, FIRST_CANDIDATE_SLUG).ingredients[0].food_group).toBe(
            'plan-read-cost-regrouped',
        );
    });
});

/* ---------------------------------------------------------------------------
 * (c) A corpus change invalidates the cached candidates
 * ------------------------------------------------------------------------- */

describe('a published or retired recipe version invalidates the cached candidates', () => {
    it('reloads and offers a newly published version', async () => {
        const before = await measure(readAlternatives);
        expect(alternativeIdsOf(before.result)).toEqual([
            fixture.firstCandidate.id,
            fixture.secondCandidate.id,
        ]);

        const added = await makeCandidateRecipe(ADDED_CANDIDATE_SLUG, CANDIDATE_PER_SERVING);

        const after = await measure(readAlternatives);

        expect(after.cost.projections).toBe(1);
        expect(alternativeIdsOf(after.result)).toEqual([
            fixture.firstCandidate.id,
            added.id,
            fixture.secondCandidate.id,
        ]);
    });

    it('reloads and withdraws a retired version', async () => {
        const before = await measure(() => getRecipeVersionsForPlanning());
        expect(slugsOf(before.result)).toContain(SECOND_CANDIDATE_SLUG);

        await prisma.recipe_versions.update({
            where: { id: fixture.secondCandidate.id },
            data: { status: 'retired', retired_at: new Date() },
        });

        const after = await measure(() => getRecipeVersionsForPlanning());

        expect(after.cost.projections).toBe(1);
        expect(slugsOf(after.result)).toEqual([FIRST_CANDIDATE_SLUG, PLANNED_SLUG]);
    });

    it('reloads when a projected column of a plannable version changes in place', async () => {
        const before = await measure(() => getRecipeVersionsForPlanning());
        expect(candidateFor(before.result, FIRST_CANDIDATE_SLUG).total_minutes).toBe(
            fixture.firstCandidate.total_minutes,
        );

        // `total_minutes` is the value a user's cooking-time limit is applied
        // to, and `recipe_versions` carries no `updated_at` for a freshness
        // check to lean on — which is exactly why the stamp hashes the column
        // itself rather than a timestamp.
        const lengthenedMinutes = fixture.firstCandidate.total_minutes + 30;

        await prisma.recipe_versions.update({
            where: { id: fixture.firstCandidate.id },
            data: { total_minutes: lengthenedMinutes },
        });

        const after = await measure(() => getRecipeVersionsForPlanning());

        expect(after.cost.projections).toBe(1);
        expect(candidateFor(after.result, FIRST_CANDIDATE_SLUG).total_minutes).toBe(
            lengthenedMinutes,
        );
    });
});

/* ---------------------------------------------------------------------------
 * (d) The cached answer IS the uncached answer
 * ------------------------------------------------------------------------- */

describe('caching changes nothing about the candidate set', () => {
    it('serves the same candidates in the same (slug, version) order as the load did', async () => {
        const loaded = await measure(() => getRecipeVersionsForPlanning());
        const served = await measure(() => getRecipeVersionsForPlanning());

        expect(loaded.cost.projections).toBe(1);
        expect(served.cost.projections).toBe(0);

        // Field for field, ingredients included — the eligibility rules read
        // every one of them.
        expect(served.result).toEqual(loaded.result);

        // The load-bearing pre-order, asserted on both: `recipes.slug` ascending,
        // which is NOT the order the fixture created these three in.
        const expectedOrder = [FIRST_CANDIDATE_SLUG, SECOND_CANDIDATE_SLUG, PLANNED_SLUG];
        expect(slugsOf(loaded.result)).toEqual(expectedOrder);
        expect(slugsOf(served.result)).toEqual(expectedOrder);
    });

    it('is not invalidated by a write outside the plannable set', async () => {
        const loaded = await measure(() => getRecipeVersionsForPlanning());
        expect(loaded.cost.projections).toBe(1);

        // A second version of an existing recipe, published `retired` — the
        // shape a catalog refresh leaves behind, and a row the projection's
        // `status = 'current'` predicate excludes. Its ingredient row and its
        // own new food are outside the projected set too.
        const retiredSecondVersion = await makeRecipeVersion({
            recipeId: fixture.firstCandidate.recipe_id,
            version: fixture.firstCandidate.version + 1,
            perServing: CANDIDATE_PER_SERVING,
            status: 'retired',
        });

        const after = await measure(() => getRecipeVersionsForPlanning());

        // The stamp covers the PROJECTED set and nothing else, so a write that
        // cannot change a single candidate does not cost a reload — which is
        // what keeps the cache useful while an operator loads a release.
        expect(after.cost.projections).toBe(0);
        expect(slugsOf(after.result)).toEqual([
            FIRST_CANDIDATE_SLUG,
            SECOND_CANDIDATE_SLUG,
            PLANNED_SLUG,
        ]);
        expect(after.result.map((candidate) => candidate.recipe_version_id)).not.toContain(
            retiredSecondVersion.id,
        );
    });
});

/* ---------------------------------------------------------------------------
 * (e) A consumer cannot corrupt the cached set
 * ------------------------------------------------------------------------- */

describe('the returned array is the caller\u2019s to mutate', () => {
    it('survives a caller sorting its result in place', async () => {
        const first = await getRecipeVersionsForPlanning();

        // The one mutation a consumer is most likely to make: ranking the
        // candidates in place. `swap.logic.ts` and `mealPlan.logic.ts` both sort
        // derived arrays today; this pins that doing it to THIS array is safe.
        first.reverse();
        first.pop();

        const second = await measure(() => getRecipeVersionsForPlanning());

        expect(second.cost.projections).toBe(0);
        expect(slugsOf(second.result)).toEqual([
            FIRST_CANDIDATE_SLUG,
            SECOND_CANDIDATE_SLUG,
            PLANNED_SLUG,
        ]);
        expect(second.result).not.toBe(first);
    });
});
