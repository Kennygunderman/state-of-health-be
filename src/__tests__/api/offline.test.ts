/**
 * The offline guarantee (Agent Action Plan §0.1.1): after seeding, plan
 * generation, swaps, grocery aggregation, recipe viewing and internal catalog
 * search make NO live USDA or model calls.
 *
 * This is not a second "it still works" suite. Every other API suite asserts
 * what a request path produces; this one asserts what it does NOT do. A stray
 * `getFoodDetail` inside a swap, or an OpenRouter call to "improve" a recipe
 * description, would leave every one of those suites green and the whole
 * feature broken the day a key rotates or a vendor is down — because nothing
 * else in the test set is looking.
 *
 * TWO LOCKS, AND BOTH ARE LOAD-BEARING.
 *
 *  1. THE KEYS ARE ABSENT. `jestSetup.ts` deletes `USDA_API_KEY` and
 *     `OPENROUTER_API_KEY`, which makes offline the suite-wide DEFAULT rather
 *     than a mode this file switches on. That premise is asserted below rather
 *     than assumed: a future edit to the setup file that set either key would
 *     otherwise leave this suite passing while it had stopped proving anything.
 *
 *  2. THE NETWORK IS TRAPPED. `globalThis.fetch` is replaced by a mock that
 *     THROWS, so even a hard-coded key could not get a request out. A mock that
 *     RESOLVED an error response would be strictly worse: both vendor services
 *     wrap transport failures in typed errors and handle them gracefully, so a
 *     resolved failure would be swallowed, the endpoint would answer exactly as
 *     it does today, and this suite would pass while the dependency it exists
 *     to disprove was still there.
 *
 * ZERO CALLS IS THE ASSERTION, not a 2xx. A passing response only shows the
 * happy path worked; `expect(…).not.toHaveBeenCalled()` after each case, plus
 * one cumulative check over the whole offline block, is the actual proof.
 *
 * WHAT THIS GUARANTEE DOES *NOT* COVER — do not "fix" the scripts to match.
 * The claim is about REQUEST-TIME paths only. The offline catalog pipeline
 * (`scripts/catalog-import-usda.ts`, `scripts/catalog-generate-ai.ts`) calls
 * USDA and OpenRouter legitimately and by design: that is where vendor data
 * enters the system at all, which is precisely what lets request time be
 * offline. Those scripts are covered in `src/__tests__/scripts/**` with
 * injected fakes, never by trapping the network.
 *
 * SCOPE (Rule backend-architecture §11). Every case here needs the mounted app
 * and a real database, which is the "Services/Prisma → integration" row. The
 * two vendor services' own unit behaviour — retry counts, cache keys, the
 * wording of `OpenRouterError` — belongs to
 * `src/services/__tests__/{usda,openrouter}.service.test.ts` and is not
 * duplicated here. What this file owns is the end-to-end statement that the
 * FEATURE's request paths never reach a vendor, and that an unconfigured
 * integration refuses before the network rather than after it (§9).
 */

import { randomUUID } from 'node:crypto';

// Imported before the deletions below, and deliberately so: instantiating the
// Prisma client LOADS `backend/.env`, which repopulates any variable that file
// declares. See the note under the deletions.
import { prisma } from '../../prisma/client';
import {
    FIXTURE_TARGETS,
    FIXTURE_USER_TARGET_COLUMNS,
    FixtureIngredientOptions,
    makeCatalogFood,
    makePlan,
    makePreferences,
    makeRecipeVersion,
    makeUser,
    utcTodayDayKey,
} from '../setup/factories';
import { truncateFeatureTables } from '../setup/testDb';

/* -------------------------------------------------------------------------- *
 * The premise, re-established HERE rather than relied upon (see lock 1 above)
 *
 * `jestSetup.ts` deletes both vendor keys, and that is genuinely the first
 * thing that happens — but it is not the LAST. Instantiating the Prisma client
 * loads `backend/.env`, and the documented developer setup for this repository
 * puts `USDA_API_KEY` and `OPENROUTER_API_KEY` in exactly that file (see
 * `.env.example`). So on any machine configured the documented way, the import
 * above silently puts both keys BACK after the setup file removed them —
 * measured, not supposed: with a populated `.env`, `USDA_API_KEY` is undefined
 * before that import and populated after it.
 *
 * Nothing in Jest's own lifecycle can repair that, because every setup hook
 * runs before the test file and the `.env` load happens inside it. Left alone,
 * this suite would keep passing while proving nothing: `openrouter.service.ts`
 * would freeze a real key, `getApiKey()` would return one, and each endpoint
 * would answer the same 502 after a trapped transport failure instead of before
 * a request — the precise difference this file exists to measure.
 *
 * So the keys are removed again, at the one point in the module graph where it
 * is effective: AFTER the imports that load `.env`, and BEFORE
 * `../setup/testApp` pulls in `app.ts` → `estimate.service.ts` →
 * `openrouter.service.ts`, which reads its key once at module load and freezes
 * the result. TypeScript's CommonJS emit preserves source order, so an
 * interleaved statement between two imports runs between their two `require`
 * calls; the ordering is verified by the premise tests below, which assert the
 * state as the vendor modules found it, and behaviourally by every zero-call
 * assertion in this file.
 *
 * Deleted, never blanked, for the reason `jestSetup.ts` gives: an empty string
 * is a configured-but-invalid key, which would be sent to the vendor.
 * -------------------------------------------------------------------------- */

const USDA_KEY_BEFORE_REMOVAL = process.env.USDA_API_KEY;
const OPENROUTER_KEY_BEFORE_REMOVAL = process.env.OPENROUTER_API_KEY;

delete process.env.USDA_API_KEY;
delete process.env.OPENROUTER_API_KEY;

import { asUser, request } from '../setup/testApp';

/**
 * Derived from the factory rather than imported from `../../generated/prisma`,
 * so this file's import graph stays inside its declared dependencies while
 * still being exactly the row type the factory returns.
 */
type FixtureCatalogFood = Awaited<ReturnType<typeof makeCatalogFood>>;
type FixtureRecipe = Awaited<ReturnType<typeof makeRecipeVersion>>;

/** Every route in this suite is mounted under `/api` by `app.ts`. */
const API = '/api';

/* -------------------------------------------------------------------------- *
 * Lock 1 — the premise, as the vendor modules found it
 *
 * Captured after the whole module graph is loaded, which is the moment that
 * decides everything: `openrouter.service.ts` has by now read
 * `OPENROUTER_API_KEY` once and frozen the result, so these two values are the
 * ones that settled whether that module has a usable config at all. A later
 * read of `process.env` would be reading something the vendor module has
 * already stopped consulting.
 * -------------------------------------------------------------------------- */

const USDA_KEY_AS_LOADED = process.env.USDA_API_KEY;
const OPENROUTER_KEY_AS_LOADED = process.env.OPENROUTER_API_KEY;
const AI_FEATURES_ENABLED_AS_LOADED = process.env.AI_FEATURES_ENABLED;

/**
 * Restores every environment variable this suite is allowed to move, to the
 * values in force once the graph had loaded — so the vendor keys stay removed
 * between tests rather than being restored to whatever `.env` supplied.
 */
const restoreEnvironment = (): void => {
    const restore = (name: string, value: string | undefined): void => {
        if (value === undefined) {
            delete process.env[name];
        } else {
            process.env[name] = value;
        }
    };

    restore('USDA_API_KEY', USDA_KEY_AS_LOADED);
    restore('OPENROUTER_API_KEY', OPENROUTER_KEY_AS_LOADED);
    restore('AI_FEATURES_ENABLED', AI_FEATURES_ENABLED_AS_LOADED);
};

/* -------------------------------------------------------------------------- *
 * Lock 2 — the network trap
 *
 * Local to this file on purpose (Rule §7.1): a shared helper in this folder
 * would arm the trap for suites that legitimately stub vendor transports, and
 * the trap's whole value is that nothing else installs or relaxes it.
 * -------------------------------------------------------------------------- */

/**
 * What an escaping call raises. A named class rather than a bare `Error` so the
 * failure is unmistakable in a log — the message names the URL that was
 * attempted, which is the one fact needed to find the offending call site.
 */
class VendorCallAttemptedError extends Error {
    constructor(public readonly target: string) {
        super(
            `offline.test.ts network trap: a request path attempted an outbound call to ${target}. ` +
                'Meal planning, recipes and internal catalog search must make no live USDA or model ' +
                'call at request time (AAP §0.1.1). Vendor data enters through the offline catalog ' +
                'scripts, never through a request.',
        );
        this.name = 'VendorCallAttemptedError';
    }
}

/** The first argument of `fetch`, whichever of its three forms arrives. */
const describeFetchTarget = (input: unknown): string => {
    if (typeof input === 'string') {
        return input;
    }

    if (input instanceof URL) {
        return input.toString();
    }

    if (typeof input === 'object' && input !== null && 'url' in input) {
        const { url } = input as { url: unknown };

        if (typeof url === 'string') {
            return url;
        }
    }

    return '<unrecognised fetch target>';
};

/**
 * Attempts within the current test, and attempts across the whole offline
 * block.
 *
 * Kept as plain arrays rather than read off the mock because `jest.config.ts`
 * sets `clearMocks: true`, which wipes a mock's call record before every test —
 * exactly what makes the per-test assertion clean, and exactly what would make
 * a cumulative assertion read zero no matter what happened. The block array is
 * reset once, in the offline block's own `beforeAll`, so it measures that block
 * and cannot be polluted by the deliberate call the non-vacuity case makes.
 *
 * They hold URLs rather than a count so a failure names what was called.
 */
let attemptsThisTest: string[] = [];
let attemptsThisBlock: string[] = [];

const realFetch = globalThis.fetch;

const networkTrap = jest.fn((...args: Parameters<typeof fetch>): never => {
    const target = describeFetchTarget(args[0]);

    attemptsThisTest.push(target);
    attemptsThisBlock.push(target);

    throw new VendorCallAttemptedError(target);
});

const armNetworkTrap = (): void => {
    globalThis.fetch = networkTrap as unknown as typeof fetch;
};

const releaseNetworkTrap = (): void => {
    globalThis.fetch = realFetch;
};

/**
 * The proof, asserted after every offline case.
 *
 * Both forms, deliberately: the array comparison puts the offending URL in the
 * failure message, and the mock assertion is the direct statement that the
 * transport was never entered.
 */
const expectNoOutboundCalls = (): void => {
    expect(attemptsThisTest).toEqual([]);
    expect(networkTrap).not.toHaveBeenCalled();
};

/* -------------------------------------------------------------------------- *
 * The offline world: local rows only
 *
 * No step below can reach a vendor — every value is written straight to
 * PostgreSQL through the factories. That is not incidental: if seeding needed a
 * USDA lookup to produce a plannable catalog, the seeding path would carry the
 * very dependency this suite exists to disprove, and the trap is armed during
 * seeding so that would fail here rather than pass quietly.
 * -------------------------------------------------------------------------- */

const PLANNING_USER = { uid: 'offline-planning-user', email: 'offline@test.invalid' };

/** A second tenant, for the shared-catalog reads that any authenticated user may make. */
const OTHER_USER = { uid: 'offline-other-user' };

const POOL_FOOD_GROUP = 'offline_pool';

/**
 * Thirteen recipes, each admissible in all three main slots.
 *
 * A week is 7 × 3 planned meals and the repetition rule admits a recipe twice,
 * so eleven is the arithmetic floor; thirteen leaves the search room to close
 * the last day without backtracking into a corner. This is the same pool
 * composition `api/concurrency.test.ts` publishes a week from, for the same
 * reason: a published week has to be a property of the catalog rather than of
 * the search's ordering.
 */
const POOL_RECIPE_COUNT = 13;

/**
 * The two ingredients of every pool recipe. Over the factory's two-serving
 * yield these give each recipe 700 kcal / 52 P / 70 C / 23 F per serving
 * (`gram_weight × per100g ÷ 100 ÷ yield`), so any three at ×1 land a day on
 * 2,100 / 156 / 210 / 69 — inside the day tolerance around
 * {@link FIXTURE_TARGETS} whichever three the search picks. The arithmetic is
 * pinned by a test below rather than trusted.
 */
const POOL_MAIN_PER_100G = { calories: 325, protein_g: 24, carbs_g: 32.5, fat_g: 10, fiber_g: 0 };
const POOL_STAPLE_PER_100G = { calories: 100, protein_g: 8, carbs_g: 10, fat_g: 6, fiber_g: 0 };
const POOL_MAIN_GRAMS = 400;
const POOL_STAPLE_GRAMS = 100;

/** The per-serving figures the two ingredients above add up to. */
const PER_SERVING = { calories: 700, protein: 52, carbs: 70, fat: 23 };

/**
 * A food whose default portion is stated in GRAMS, so its grocery line sits in
 * the `mass` unit family — a volume portion against a null density cannot be
 * converted into a shopping quantity at all.
 */
const gramFood = async (displayName: string, overrides: {
    foodGroup?: string;
    isCommonDislike?: boolean;
} = {}): Promise<FixtureCatalogFood> =>
    makeCatalogFood({
        display_name: displayName,
        canonical_name: displayName.toLowerCase(),
        search_text: displayName.toLowerCase(),
        food_group: overrides.foodGroup ?? POOL_FOOD_GROUP,
        is_common_dislike: overrides.isCommonDislike ?? false,
        defaultPortion: { description: '100 g', amount: 100, unit: 'g', gram_weight: 100 },
    });

const poolIngredients = (
    main: FixtureCatalogFood,
    staple: FixtureCatalogFood,
): readonly FixtureIngredientOptions[] => [
    {
        catalogFoodId: main.id,
        per100g: POOL_MAIN_PER_100G,
        gram_weight: POOL_MAIN_GRAMS,
        quantity: POOL_MAIN_GRAMS,
        unit: 'g',
        display_text: `${POOL_MAIN_GRAMS} g`,
    },
    {
        catalogFoodId: staple.id,
        per100g: POOL_STAPLE_PER_100G,
        gram_weight: POOL_STAPLE_GRAMS,
        quantity: POOL_STAPLE_GRAMS,
        unit: 'g',
        display_text: `${POOL_STAPLE_GRAMS} g`,
    },
];

interface PoolRecipe {
    readonly version: FixtureRecipe;
    readonly food: FixtureCatalogFood;
}

/** The planning user, their confirmed targets, and their preferences in UTC. */
const seedPlanner = async (): Promise<void> => {
    await makeUser({ id: PLANNING_USER.uid, ...FIXTURE_USER_TARGET_COLUMNS });
    await makePreferences(PLANNING_USER.uid, { time_zone: 'UTC' });
};

/**
 * A catalog a whole week can be built from, written locally.
 *
 * The staple is in every recipe so the grocery list always has one line every
 * planned meal contributes to, whichever recipes the search picks.
 */
const seedPlannableWorld = async (): Promise<{ staple: FixtureCatalogFood; pool: PoolRecipe[] }> => {
    await seedPlanner();

    const staple = await gramFood('Offline Pool Staple');
    const pool: PoolRecipe[] = [];

    for (let index = 0; index < POOL_RECIPE_COUNT; index += 1) {
        const food = await gramFood(`Offline Pool Food ${index}`);

        pool.push({
            food,
            version: await makeRecipeVersion({
                slug: `offline-pool-${String(index).padStart(2, '0')}`,
                catalogFoodId: food.id,
                ingredients: poolIngredients(food, staple),
            }),
        });
    }

    return { staple, pool };
};

/* -------------------------------------------------------------------------- *
 * Request helpers
 *
 * Identity travels in `x-test-user-id` and nowhere else (Rule §4): it stands in
 * for the Firebase token the real middleware verifies, so every handler still
 * learns its caller through `getUserId(req)` alone. No body below carries a
 * `userId` — except the one case that deliberately sends a foreign one to prove
 * it is ignored.
 * -------------------------------------------------------------------------- */

const generateWeek = async (idempotencyKey: string = randomUUID()) =>
    asUser(request.post(`${API}/meal-planning/plans`), PLANNING_USER).send({
        startDate: utcTodayDayKey(),
        idempotencyKey,
        expectedPreferencesRevision: 1,
        expectedTargetsRevision: 1,
    });

/** A published week, with the response asserted so a later failure is not a mystery. */
const publishWeek = async (): Promise<Record<string, any>> => {
    const response = await generateWeek();

    expect(response.status).toBe(201);

    return response.body as Record<string, any>;
};

/** The day key of a plan's nth day, read off the response the server produced. */
const dayKeyOf = (plan: Record<string, any>, dayIndex = 0): string =>
    String(plan.days[dayIndex].date);

const firstMealOf = (plan: Record<string, any>, dayIndex = 0): Record<string, any> =>
    plan.days[dayIndex].meals[0] as Record<string, any>;

/* -------------------------------------------------------------------------- *
 * Lifecycle
 *
 * The trap is armed AFTER truncation and BEFORE the test body, so it covers
 * fixture seeding as well as the request under test. It is released in
 * `afterEach` because the suite runs `--runInBand`: a trap left installed would
 * follow this file and break every later suite — most spectacularly the two
 * vendor service suites, which stub transports of their own.
 *
 * `afterAll` closes the suite on three guarantees: the database holds none of
 * this file's rows, `globalThis.fetch` is the real one, and the environment is
 * as the module graph left it.
 *
 * The truncation is the part `beforeEach` cannot supply. Truncating before each
 * test makes every case HERE order-independent, and does nothing for the file
 * that runs next: the last case's user, preferences, catalog and plan rows
 * survive the suite, and under `--runInBand` the next suite's first test is the
 * one that finds them — a stray published week or thirteen extra catalog foods
 * read as that suite's own state. §0.9.1 requires each suite to be independent
 * of run order, which is a claim about what a suite LEAVES as much as what it
 * expects, so the residue is removed by the file that created it rather than by
 * whoever follows it.
 *
 * The truncation runs first and the release/restore follow it in a `finally`.
 * Those two calls are this file's last word on process-wide state, so they
 * belong after the only work in the hook that can still fail; and the `finally`
 * is what stops a failing truncation from skipping them, because a trap — or
 * the probe key one case installs — outliving this file would break every suite
 * after it instead of just this one.
 * -------------------------------------------------------------------------- */

beforeEach(async () => {
    await truncateFeatureTables();

    attemptsThisTest = [];
    networkTrap.mockClear();
    armNetworkTrap();
});

afterEach(() => {
    releaseNetworkTrap();
    restoreEnvironment();
});

afterAll(async () => {
    try {
        await truncateFeatureTables();
    } finally {
        releaseNetworkTrap();
        restoreEnvironment();
    }
});

describe('the offline premise this suite rests on', () => {
    it('had no USDA key once the graph was loaded, so the accessor is unconfigured', () => {
        expect(USDA_KEY_AS_LOADED).toBeUndefined();
    });

    it('had no OpenRouter key at the moment that module froze its config', () => {
        expect(OPENROUTER_KEY_AS_LOADED).toBeUndefined();
    });

    /**
     * The guard on the removal above. If a future change moved that block after
     * the `testApp` import — or if the `.env` load moved later in the graph —
     * the two assertions above would still pass while the vendor modules had
     * been handed real keys. This one fails in that case, because the value it
     * checks is the one captured BEFORE the removal: on a machine with a
     * populated `.env` it is a real key, and on CI it is undefined, so the only
     * thing it can assert is the removal's effect rather than its input.
     */
    it('removed whatever the environment and .env between them had supplied', () => {
        expect(process.env.USDA_API_KEY).toBeUndefined();
        expect(process.env.OPENROUTER_API_KEY).toBeUndefined();

        for (const captured of [USDA_KEY_BEFORE_REMOVAL, OPENROUTER_KEY_BEFORE_REMOVAL]) {
            expect(captured === undefined || captured.length > 0).toBe(true);
        }
    });

    /**
     * The trap raises SYNCHRONOUSLY rather than returning a rejected promise.
     * Both vendor services await inside a try/catch, so either form is caught
     * the same way, and a synchronous throw is the harder one to lose: a caller
     * that forgot to handle the failure at all surfaces it immediately instead
     * of as an unhandled rejection after the test has moved on.
     */
    it('arms a trap that throws rather than resolving a failure a service could swallow', () => {
        expect(() => globalThis.fetch('https://example.invalid/probe')).toThrow(
            VendorCallAttemptedError,
        );

        expect(attemptsThisTest).toEqual(['https://example.invalid/probe']);
    });
});

/* -------------------------------------------------------------------------- *
 * An unconfigured integration refuses BEFORE the network (Rule §9)
 *
 * Edge cases before happy paths. §9 requires integration config to be read once
 * behind a small accessor that fails loudly "rather than sending an
 * unauthenticated request", and both vendor services do exactly that. Asserting
 * the status alone would not distinguish that from a service which sent a
 * keyless request, got refused, and mapped the vendor's rejection to the same
 * code. The zero-call assertion is what separates the two.
 *
 * ZERO CALLS ALSO SETTLES "NO RETRIES". `usda.service.ts` retries up to four
 * physical attempts with a 250 ms × attempt backoff, so a check placed after
 * the request would show as four attempts here. No timing assertion is made
 * instead: up to 64 agents validate on this host at once, so a wall-clock bound
 * tight enough to mean anything would be flaky, and zero attempts is the
 * stronger claim anyway. That the transport is genuinely REACHABLE from this
 * endpoint when a key is present is proved positively at the end of this block,
 * so zero here is a fact about the missing key rather than about dead code.
 * -------------------------------------------------------------------------- */

describe('an unconfigured integration refuses before the network', () => {
    /** Machine code only: no raw error, no stack, no key name, no vendor URL. */
    const expectSafeFailureBody = (body: unknown, code: string, forbidden: string[]): void => {
        expect(body).toEqual({ error: code });

        const serialised = JSON.stringify(body);

        for (const secret of forbidden) {
            expect(serialised).not.toContain(secret);
        }

        expect(serialised).not.toContain('is not configured');
        expect(serialised).not.toMatch(/\bat\s+\S+:\d+:\d+/);
    };

    describe('USDA branded search, with USDA_API_KEY absent', () => {
        it('answers the shipped 502 branded_search_failed', async () => {
            await seedPlanner();

            const response = await asUser(
                request.get(`${API}/macros/search-branded-foods`).query({ q: 'oat milk' }),
                PLANNING_USER,
            );

            expect(response.status).toBe(502);
            expect(response.body).toEqual({ error: 'branded_search_failed' });
        });

        it('never reaches the transport, because the key is read while building the query string', async () => {
            await seedPlanner();

            await asUser(
                request.get(`${API}/macros/search-branded-foods`).query({ q: 'oat milk' }),
                PLANNING_USER,
            );

            expectNoOutboundCalls();
        });

        it('leaks neither the internal message, the key name nor the vendor host', async () => {
            await seedPlanner();

            const response = await asUser(
                request.get(`${API}/macros/search-branded-foods`).query({ q: 'oat milk' }),
                PLANNING_USER,
            );

            expectSafeFailureBody(response.body, 'branded_search_failed', [
                'USDA_API_KEY',
                'UsdaError',
                'api.nal.usda.gov',
            ]);
        });

        it('writes no cache row, which a refusal after the request would have left behind', async () => {
            await seedPlanner();

            await asUser(
                request.get(`${API}/macros/search-branded-foods`).query({ q: 'oat milk' }),
                PLANNING_USER,
            );

            expect(await prisma.usda_api_cache.count()).toBe(0);
            expectNoOutboundCalls();
        });
    });

    describe('OpenRouter estimation, with OPENROUTER_API_KEY absent', () => {
        it('answers 502 estimation_failed from the text estimate without a call', async () => {
            await seedPlanner();

            const response = await asUser(
                request.post(`${API}/macros/estimate`),
                PLANNING_USER,
            ).send({ text: 'two eggs and a slice of toast' });

            expect(response.status).toBe(502);
            expect(response.body).toEqual({ error: 'estimation_failed' });
            expectNoOutboundCalls();
        });

        it('answers 502 estimation_failed from the label scan without a call', async () => {
            await seedPlanner();

            const response = await asUser(
                request.post(`${API}/macros/label-scan`),
                PLANNING_USER,
            ).send({ imageBase64: 'aGVsbG8=' });

            expect(response.status).toBe(502);
            expect(response.body).toEqual({ error: 'estimation_failed' });
            expectNoOutboundCalls();
        });

        it('leaks neither the internal message, the key name nor the vendor host', async () => {
            await seedPlanner();

            const response = await asUser(
                request.post(`${API}/macros/estimate`),
                PLANNING_USER,
            ).send({ text: 'two eggs and a slice of toast' });

            expectSafeFailureBody(response.body, 'estimation_failed', [
                'OPENROUTER_API_KEY',
                'OpenRouterError',
                'EstimateFailedError',
                'openrouter.ai',
            ]);
        });

        /**
         * The extraction of the transport into `openrouter.service.ts` moved the
         * "not configured" failure from an `EstimateFailedError` raised in the
         * estimate service to an `OpenRouterError` raised in the vendor module
         * and translated back at the estimate service's boundary. The client
         * must not be able to tell: same status, same machine code, both
         * endpoints. `openrouter.service.test.ts` pins the message text; this
         * pins the HTTP result.
         */
        it('translates the vendor error at the service boundary, so both endpoints answer identically', async () => {
            await seedPlanner();

            const [estimate, labelScan] = [
                await asUser(request.post(`${API}/macros/estimate`), PLANNING_USER).send({
                    text: 'a bowl of chili',
                }),
                await asUser(request.post(`${API}/macros/label-scan`), PLANNING_USER).send({
                    imageBase64: 'aGVsbG8=',
                }),
            ];

            expect(estimate.status).toBe(502);
            expect(labelScan.status).toBe(502);
            expect(estimate.body).toEqual(labelScan.body);
            expectNoOutboundCalls();
        });
    });

    /**
     * NON-VACUITY, kept as a permanent test rather than a manual check.
     *
     * Everything above asserts that a call did not happen. That is only
     * meaningful if a call COULD have happened, so this drives the same endpoint
     * with a key present and shows it reaches the transport — which is also why
     * the keyless cases above are facts about the missing key and not about an
     * unreachable code path.
     *
     * It works on the USDA path specifically because `getApiKey()` reads
     * `process.env` on every call, so the key can be restored in-test.
     * `openrouter.service.ts` captures its key at module load and documents that
     * mutating it afterwards has no effect, so the same manoeuvre there would
     * require `jest.resetModules()` and would be testing that module's loading
     * rather than this feature's request paths.
     */
    describe('the trap is armed on a path that can actually reach it', () => {
        it('reaches the USDA transport once the key is present, and still answers 502', async () => {
            await seedPlanner();
            process.env.USDA_API_KEY = 'offline-suite-probe-key';

            const response = await asUser(
                request.get(`${API}/macros/search-branded-foods`).query({ q: 'oat milk' }),
                PLANNING_USER,
            );

            expect(attemptsThisTest.length).toBeGreaterThan(0);
            expect(
                attemptsThisTest.every((target) => target.startsWith('https://api.nal.usda.gov/')),
            ).toBe(true);
            expect(response.status).toBe(502);
            expect(response.body).toEqual({ error: 'branded_search_failed' });
        });
    });
});

/* -------------------------------------------------------------------------- *
 * The feature works entirely offline (AAP §0.1.1)
 *
 * Every case asserts a 2xx AND a correct payload AND zero outbound calls. The
 * payload matters as much as the call count: nutrition figures that came out
 * right prove the numbers were derived from stored gram weights, which is the
 * positive half of the same claim.
 * -------------------------------------------------------------------------- */

describe('the feature works entirely offline', () => {
    // Reset once, here, so the cumulative assertion at the end of this block
    // measures exactly this block — not the deliberate call the non-vacuity
    // case above makes, and not anything a later block does.
    beforeAll(() => {
        attemptsThisBlock = [];
    });

    describe('the seeded world itself', () => {
        it('derives its recipe nutrition from stored gram weights, with no vendor lookup', async () => {
            const { pool } = await seedPlannableWorld();

            expect(pool).toHaveLength(POOL_RECIPE_COUNT);

            for (const { version } of pool) {
                expect({
                    calories: version.per_serving_calories,
                    protein: version.per_serving_protein_g,
                    carbs: version.per_serving_carbs_g,
                    fat: version.per_serving_fat_g,
                }).toEqual(PER_SERVING);
                expect(version.nutrition_provenance).toBe('source_backed');
            }

            expectNoOutboundCalls();
        });
    });

    describe('plan generation', () => {
        it('publishes a complete seven-day plan with days, meals and grocery items', async () => {
            const { staple } = await seedPlannableWorld();

            const plan = await publishWeek();

            expect(plan.status).toBe('active');
            expect(plan.days).toHaveLength(7);
            expect(plan.summary.plannedMeals).toBe(21);
            expect(plan.summary.groceryItemCount).toBeGreaterThan(0);

            for (const day of plan.days) {
                const meals = day.meals as Array<Record<string, any>>;

                expect(meals).toHaveLength(3);

                // Each meal's planned nutrition is its recipe's stored
                // per-serving figure times the slot's own multiplier — the
                // generator sizes slots from the day-guidance split, so the
                // three are not all ×1 — and the day is their sum. Nothing here
                // came from a vendor; it is arithmetic over ingredient grams.
                for (const planned of meals) {
                    expect(planned.planned.calories).toBe(
                        Math.round(PER_SERVING.calories * planned.portionMultiplier),
                    );
                    expect(planned.recipe.nutritionProvenance).toBe('source_backed');
                }

                expect(
                    meals.reduce((total, planned) => total + planned.planned.calories, 0),
                ).toBe(day.plannedTotals.calories);

                expect(day.plannedTotals).toEqual({
                    calories: 2100,
                    protein: 156,
                    carbs: 210,
                    fat: 69,
                });
            }

            // The staple is in all 21 planned meals, at gram_weight ÷ yield ×
            // multiplier = 100 ÷ 2 × 1 = 50 g each. The list is arithmetic over
            // stored portions, so the total is exact.
            const stapleLine = await prisma.grocery_items.findFirstOrThrow({
                where: { meal_plan_id: String(plan.id), catalog_food_id: staple.id },
            });

            expect(Number(stapleLine.quantity_grams)).toBe(21 * 50);
            expect(stapleLine.display_text.length).toBeGreaterThan(0);

            expectNoOutboundCalls();
        });

        it('regenerates the week, superseding the previous plan', async () => {
            await seedPlannableWorld();
            const plan = await publishWeek();

            const regenerated = await asUser(
                request.post(`${API}/meal-planning/plans/${plan.id}/regenerate`),
                PLANNING_USER,
            ).send({
                idempotencyKey: randomUUID(),
                expectedPlanRevision: plan.revision,
                expectedPreferencesRevision: 1,
                expectedTargetsRevision: 1,
            });

            expect(regenerated.status).toBe(201);
            expect(regenerated.body.id).not.toBe(plan.id);
            expect(regenerated.body.days).toHaveLength(7);
            expect(regenerated.body.generationAttempt).toBe(plan.generationAttempt + 1);

            const replaced = await prisma.meal_plans.findUniqueOrThrow({
                where: { id: String(plan.id) },
            });

            expect(replaced.status).toBe('superseded');
            expectNoOutboundCalls();
        });
    });

    describe('plan reads', () => {
        it('returns the current plan and one day in full', async () => {
            await seedPlannableWorld();
            const plan = await publishWeek();

            const current = await asUser(
                request.get(`${API}/meal-planning/plans/current`),
                PLANNING_USER,
            );

            expect(current.status).toBe(200);
            expect(current.body.current.id).toBe(plan.id);
            expect(current.body.upcoming).toBeNull();

            const dayKey = dayKeyOf(plan, 0);
            const day = await asUser(
                request.get(`${API}/meal-planning/plans/${plan.id}/days/${dayKey}`),
                PLANNING_USER,
            );

            expect(day.status).toBe(200);
            expect(day.body.planId).toBe(plan.id);
            expect(day.body.day.date).toBe(dayKey);
            expect(day.body.day.meals).toHaveLength(3);
            expect(day.body.isWritable).toBe(true);

            expectNoOutboundCalls();
        });
    });

    describe('swapping a planned meal', () => {
        it('lists alternatives, previews one with its delta, and commits it', async () => {
            await seedPlannableWorld();
            const plan = await publishWeek();
            const meal = firstMealOf(plan, 0);
            const base = `${API}/meal-planning/plans/${plan.id}/meals/${meal.id}`;

            const alternatives = await asUser(request.get(`${base}/alternatives`), PLANNING_USER);

            expect(alternatives.status).toBe(200);
            expect(alternatives.body.current.id).toBe(meal.id);
            expect(alternatives.body.alternatives.length).toBeGreaterThan(0);

            const candidate = alternatives.body.alternatives[0];

            expect(candidate.recipeVersionId).not.toBe(meal.recipe.versionId);
            // Every pool recipe carries identical stored nutrition, so the
            // portion that best fits the day is the one the current meal
            // already uses, and the candidate's figure matches it exactly.
            expect(candidate.portionMultiplier).toBe(meal.portionMultiplier);
            expect(candidate.calories).toBe(meal.planned.calories);

            const preview = await asUser(
                request.get(`${base}/alternatives/${candidate.recipeVersionId}/preview`),
                PLANNING_USER,
            );

            expect(preview.status).toBe(200);
            expect(preview.body.targets.calories).toBe(FIXTURE_TARGETS.calories);
            // Every pool recipe carries the same stored nutrition, so exchanging
            // one for another moves the day by exactly nothing. A computed zero
            // is still a computation — over local rows.
            expect(preview.body.calorieDelta).toBe(0);
            expect(preview.body.dayTotalsIfSwapped.calories).toBe(2100);
            expect(preview.body.planRevision).toBe(plan.revision);

            const commit = await asUser(request.post(`${base}/swap`), PLANNING_USER).send({
                recipeVersionId: candidate.recipeVersionId,
                portionMultiplier: preview.body.alternative.portionMultiplier,
                expectedPlanRevision: plan.revision,
                idempotencyKey: randomUUID(),
            });

            expect(commit.status).toBe(200);
            expect(commit.body.meal.recipe.versionId).toBe(candidate.recipeVersionId);
            expect(commit.body.planRevision).toBe(plan.revision + 1);
            expect(commit.body.day.plannedTotals.calories).toBe(2100);

            expectNoOutboundCalls();
        });
    });

    describe('the weekly grocery list', () => {
        it('aggregates from stored portions, takes a check, and unchecks all', async () => {
            await seedPlannableWorld();
            const plan = await publishWeek();
            const base = `${API}/meal-planning/plans/${plan.id}/groceries`;

            const list = await asUser(request.get(base), PLANNING_USER);

            expect(list.status).toBe(200);
            expect(list.body.planId).toBe(plan.id);
            expect(list.body.totalCount).toBeGreaterThan(0);
            expect(list.body.checkedCount).toBe(0);
            expect(list.body.checkedItems).toEqual([]);

            const items = (list.body.sections as Array<Record<string, any>>).flatMap(
                (section) => section.items as Array<Record<string, any>>,
            );

            expect(items.length).toBe(list.body.totalCount);
            // Measured quantities, never container counts: every line carries the
            // grams it was aggregated from.
            for (const item of items) {
                expect(item.quantityGrams).toBeGreaterThan(0);
                expect(typeof item.displayText).toBe('string');
                expect(item.flag).toBeNull();
            }

            const toggled = await asUser(
                request.put(`${base}/${items[0].id}`),
                PLANNING_USER,
            ).send({ isChecked: true });

            expect(toggled.status).toBe(200);
            expect(toggled.body.item.isChecked).toBe(true);
            expect(toggled.body.checkedCount).toBe(1);

            const unchecked = await asUser(request.post(`${base}/uncheck-all`), PLANNING_USER).send(
                {},
            );

            expect(unchecked.status).toBe(200);
            expect(unchecked.body.checkedCount).toBe(0);

            expectNoOutboundCalls();
        });
    });

    describe('recipe detail', () => {
        it('renders name, instructions, nutrition and ingredients from local rows', async () => {
            const { pool, staple } = await seedPlannableWorld();
            const version = pool[0].version;

            const response = await asUser(
                request.get(`${API}/recipes/${version.id}`),
                PLANNING_USER,
            );

            expect(response.status).toBe(200);
            expect(response.body.versionId).toBe(version.id);
            expect(response.body.status).toBe('current');
            expect(response.body.instructions.length).toBeGreaterThan(0);
            expect(response.body.perServing).toEqual(PER_SERVING);
            expect(response.body.nutritionProvenance).toBe('source_backed');

            const ingredients = response.body.ingredients as Array<Record<string, any>>;

            expect(ingredients).toHaveLength(2);
            expect(ingredients.map((ingredient) => ingredient.catalogFoodId)).toEqual([
                pool[0].food.id,
                staple.id,
            ]);
            expect(ingredients.map((ingredient) => ingredient.gramWeight)).toEqual([
                POOL_MAIN_GRAMS,
                POOL_STAPLE_GRAMS,
            ]);

            expectNoOutboundCalls();
        });

        it('is readable by any authenticated caller, the catalog being tenant-less', async () => {
            const { pool } = await seedPlannableWorld();
            await makeUser({ id: OTHER_USER.uid });

            const response = await asUser(
                request.get(`${API}/recipes/${pool[0].version.id}`),
                OTHER_USER,
            );

            expect(response.status).toBe(200);
            expectNoOutboundCalls();
        });
    });

    describe('internal catalog search', () => {
        it('ranks matches out of PostgreSQL, with no vendor query', async () => {
            await seedPlanner();
            const matching = await gramFood('Offline Chickpea Stew');
            await gramFood('Offline Unrelated Kale');

            const response = await asUser(
                request.get(`${API}/catalog/foods`).query({ q: 'chickpea' }),
                PLANNING_USER,
            );

            expect(response.status).toBe(200);

            const items = response.body.items as Array<Record<string, any>>;

            expect(items.map((item) => item.id)).toEqual([matching.id]);
            expect(items[0].name).toBe('Offline Chickpea Stew');
            expect(items[0].nutritionProvenance).toBe('source_backed');
            expect(items[0].defaultPortion.gramWeight).toBe(100);
            expect(response.body.pagination).toEqual(
                expect.objectContaining({ page: 1, total: 1, totalPages: 1 }),
            );

            expectNoOutboundCalls();
        });

        it('serves the dislike suggestion chips', async () => {
            await seedPlanner();
            await gramFood('Offline Common Dislike', { isCommonDislike: true });
            await gramFood('Offline Not A Dislike');

            const response = await asUser(
                request.get(`${API}/catalog/foods/suggestions`).query({ kind: 'dislike' }),
                PLANNING_USER,
            );

            expect(response.status).toBe(200);
            expect(
                (response.body.items as Array<Record<string, any>>).map((item) => item.name),
            ).toEqual(['Offline Common Dislike']);

            expectNoOutboundCalls();
        });

        it('reports catalog status from local counts', async () => {
            const { pool } = await seedPlannableWorld();

            const response = await asUser(request.get(`${API}/catalog/status`), PLANNING_USER);

            expect(response.status).toBe(200);
            // No release has been loaded into this database, so both release
            // members are null while the counts still describe what is there.
            expect(response.body.catalogRelease).toBeNull();
            expect(response.body.lastLoadedAt).toBeNull();
            expect(response.body.recipeCount).toBe(pool.length);
            expect(response.body.publishedCount).toBe(pool.length + 1);
            expect(response.body.quarantinedCount).toBe(0);

            expectNoOutboundCalls();
        });
    });

    describe('logging a planned meal into the diary', () => {
        it('writes the entry from the server-derived snapshot and shows it in the diary read', async () => {
            await seedPlannableWorld();
            const plan = await publishWeek();
            const dayKey = dayKeyOf(plan, 0);
            const meal = firstMealOf(plan, 0);

            // The diary read self-heals the four buckets, which is where the
            // client gets the bucket id it logs against.
            const diary = await asUser(request.get(`${API}/macros/${dayKey}`), PLANNING_USER);

            expect(diary.status).toBe(200);

            const buckets = diary.body.meals as Array<Record<string, any>>;
            const breakfast = buckets.find((bucket) => bucket.name === 'Breakfast');

            expect(breakfast).toBeDefined();

            const logged = await asUser(
                request.post(`${API}/meal-planning/plans/${plan.id}/meals/${meal.id}/log`),
                PLANNING_USER,
            ).send({
                servings: 1,
                date: dayKey,
                diaryMealId: breakfast?.id,
                expectedPlanRevision: plan.revision,
                idempotencyKey: randomUUID(),
            });

            expect(logged.status).toBe(201);
            expect(logged.body.entry.inputMethod).toBe('meal_plan');
            expect(logged.body.entry.nutritionProvenance).toBe('source_backed');
            expect(logged.body.entry.mealPlanMealId).toBe(meal.id);
            // The snapshot is the PLANNED PORTION, derived by the server from
            // the recipe's stored ingredient weights and the slot's multiplier —
            // which the generator sets per slot from the day-guidance split, so
            // this is deliberately the meal's own figure rather than one serving.
            expect(logged.body.entry.calories).toBe(meal.planned.calories);
            expect(meal.planned.calories).toBe(
                Math.round(PER_SERVING.calories * meal.portionMultiplier),
            );
            expect(logged.body.mealPlanMeal.loggedEntries).toHaveLength(1);

            const afterLogging = await asUser(
                request.get(`${API}/macros/${dayKey}`),
                PLANNING_USER,
            );

            expect(afterLogging.status).toBe(200);

            const entries = (afterLogging.body.meals as Array<Record<string, any>>).flatMap(
                (bucket) => bucket.entries as Array<Record<string, any>>,
            );

            expect(entries).toHaveLength(1);
            expect(entries[0].id).toBe(logged.body.entry.id);
            expect(entries[0].inputMethod).toBe('meal_plan');
            expect(afterLogging.body.totals.calories).toBe(meal.planned.calories);
            expect(afterLogging.body.targets.calories).toBe(FIXTURE_TARGETS.calories);

            expectNoOutboundCalls();
        });
    });

    describe('preferences and targets', () => {
        it('reads the stored preferences', async () => {
            await seedPlanner();

            const response = await asUser(
                request.get(`${API}/meal-planning/preferences`),
                PLANNING_USER,
            );

            expect(response.status).toBe(200);
            expect(response.body.setupStatus).toBe('completed');
            expect(response.body.revision).toBe(1);
            expect(response.body.timeZone).toBe('UTC');
            expect(response.body.hasActivePlan).toBe(false);

            expectNoOutboundCalls();
        });

        it('saves a setup step', async () => {
            await seedPlanner();

            const response = await asUser(
                request.put(`${API}/meal-planning/preferences/steps/diet`),
                PLANNING_USER,
            ).send({
                timeZone: 'UTC',
                expectedRevision: 1,
                diet: 'vegetarian',
                allergens: ['milk'],
            });

            expect(response.status).toBe(200);
            expect(response.body.preferences.diet).toBe('vegetarian');
            expect(response.body.preferences.allergens).toEqual(['milk']);
            expect(response.body.preferences.revision).toBe(2);

            expectNoOutboundCalls();
        });

        it('reads the confirmed targets', async () => {
            await seedPlanner();

            const response = await asUser(
                request.get(`${API}/meal-planning/targets`),
                PLANNING_USER,
            );

            expect(response.status).toBe(200);
            expect(response.body.targets).toEqual(FIXTURE_TARGETS);
            expect(response.body.complete).toBe(true);
            expect(response.body.source).toBe('estimated');
            expect(response.body.stale).toBe(false);

            expectNoOutboundCalls();
        });

        it('saves manual targets exactly as entered', async () => {
            await seedPlanner();

            const response = await asUser(
                request.put(`${API}/meal-planning/targets`),
                PLANNING_USER,
            ).send({
                source: 'manual',
                calories: 2000,
                protein: 150,
                carbs: 200,
                fat: 67,
                expectedTargetsRevision: 1,
            });

            expect(response.status).toBe(200);
            expect(response.body.targets.targets).toEqual({
                calories: 2000,
                protein: 150,
                carbs: 200,
                fat: 67,
            });
            expect(response.body.targets.source).toBe('manual');
            expect(response.body.targets.revision).toBe(2);

            expectNoOutboundCalls();
        });

        /**
         * The estimate is arithmetic over stored answers — an equation, not a
         * lookup. The exact figures and the clamp bounds belong to
         * `targets.logic.test.ts`; what matters here is that the endpoint
         * produces them with no network, and that asking twice gives the same
         * answer, which a vendor-backed estimate could not promise.
         */
        it('computes the target estimate arithmetically and deterministically', async () => {
            await seedPlanner();

            const first = await asUser(
                request.get(`${API}/meal-planning/targets/estimate`),
                PLANNING_USER,
            );

            expect(first.status).toBe(200);
            expect(first.body.source).toBe('estimated');
            expect(first.body.estimateRevision).toBe(1);
            expect(first.body.inputs).toEqual(
                expect.objectContaining({
                    age: 34,
                    heightCm: 178,
                    weightKg: 79,
                    sexForEstimate: 'male',
                    activityLevel: 'lightly_active',
                    goal: 'maintain',
                }),
            );
            expect(first.body.adjustment).toBe(0);
            expect(first.body.bmr).toBeGreaterThan(0);
            expect(first.body.tdee).toBeGreaterThan(first.body.bmr);
            expect(first.body.calories).toBeGreaterThan(0);

            const second = await asUser(
                request.get(`${API}/meal-planning/targets/estimate`),
                PLANNING_USER,
            );

            expect(second.body).toEqual(first.body);
            expectNoOutboundCalls();
        });
    });

    /**
     * The cumulative check. Each case above asserts its own zero, but a case
     * could be added later without one; this measures the whole block at once,
     * so no single case can hide a call another case's assertion would have
     * caught.
     */
    describe('taken together', () => {
        it('made no outbound call anywhere in this block', () => {
            expect(attemptsThisBlock).toEqual([]);
        });
    });
});

/* -------------------------------------------------------------------------- *
 * Metering is untouched (AAP §0.1.1, Rule §9)
 *
 * Meal planning is deliberately OUTSIDE `ai_usage` metering and outside the
 * `AI_FEATURES_ENABLED` kill switch, and both halves matter. The first is the
 * consequence of making no request-time model call: §9's "meter before you
 * spend" is satisfied vacuously here precisely because there is nothing to
 * spend, and a planning request that consumed a user's daily AI quota would be
 * charging them for arithmetic. The second stops an unrelated AI kill switch
 * from disabling the planner — planning has its own switch,
 * `MEAL_PLANNING_ENABLED`.
 *
 * "Unchanged" is asserted over ROWS, not a count, so a request that both added
 * and removed a row could not pass. The baseline is genuinely empty because
 * `truncateFeatureTables()` names `ai_usage` and `usda_api_cache` explicitly —
 * neither is reachable by a cascade from `users`.
 * -------------------------------------------------------------------------- */

describe('metering is untouched by meal planning', () => {
    interface MeteringSnapshot {
        aiUsage: Array<{ user_id: string; day: string; count: number }>;
        usdaCacheKeys: string[];
    }

    const meteringSnapshot = async (): Promise<MeteringSnapshot> => ({
        aiUsage: (
            await prisma.ai_usage.findMany({ orderBy: [{ user_id: 'asc' }, { day: 'asc' }] })
        ).map((row) => ({ user_id: row.user_id, day: row.day, count: row.count })),
        usdaCacheKeys: (
            await prisma.usda_api_cache.findMany({ orderBy: { cache_key: 'asc' } })
        ).map((row) => row.cache_key),
    });

    /**
     * Asserts the status while keeping the body in the failure output: the
     * workload below drives sixteen endpoints, and "expected 200, received 409"
     * without the machine code would not say which precondition had moved.
     */
    const expectOk = (response: { status: number; body: unknown }, expected = 200): void => {
        expect({ status: response.status, body: response.body }).toMatchObject({
            status: expected,
        });
    };

    /**
     * One pass over the whole feature: every read, plus the four writes that
     * change state. Shared by both tests below so "still works" and "meters
     * nothing" are measured over exactly the same workload.
     */
    const runFullPlanningWorkload = async (): Promise<void> => {
        const plan = await publishWeek();
        const dayKey = dayKeyOf(plan, 0);
        const meal = firstMealOf(plan, 0);
        const planBase = `${API}/meal-planning/plans/${plan.id}`;

        for (const path of [
            `${API}/meal-planning/preferences`,
            `${API}/meal-planning/targets`,
            `${API}/meal-planning/targets/estimate`,
            `${API}/meal-planning/plans/current`,
            `${planBase}/days/${dayKey}`,
            `${planBase}/affected-meals`,
            `${planBase}/meals/${meal.id}/alternatives`,
            `${planBase}/groceries`,
            `${API}/recipes/${meal.recipe.versionId}`,
            `${API}/catalog/status`,
        ]) {
            expectOk(await asUser(request.get(path), PLANNING_USER));
        }

        expectOk(
            await asUser(request.get(`${API}/catalog/foods`).query({ q: 'offline' }), PLANNING_USER),
        );
        expectOk(
            await asUser(
                request.get(`${API}/catalog/foods/suggestions`).query({ kind: 'dislike' }),
                PLANNING_USER,
            ),
        );

        // A grocery check, then the swap, then the log — the three writes that
        // touch a published week, in an order where each one's precondition is
        // the previous one's result.
        const groceries = await asUser(request.get(`${planBase}/groceries`), PLANNING_USER);
        const firstItem = (groceries.body.sections as Array<Record<string, any>>).flatMap(
            (section) => section.items as Array<Record<string, any>>,
        )[0];

        expectOk(
            await asUser(request.put(`${planBase}/groceries/${firstItem.id}`), PLANNING_USER).send({
                isChecked: true,
            }),
        );
        expectOk(await asUser(request.post(`${planBase}/groceries/uncheck-all`), PLANNING_USER).send({}));

        const alternatives = await asUser(
            request.get(`${planBase}/meals/${meal.id}/alternatives`),
            PLANNING_USER,
        );
        const candidate = (alternatives.body.alternatives as Array<Record<string, any>>)[0];
        const swapped = await asUser(
            request.post(`${planBase}/meals/${meal.id}/swap`),
            PLANNING_USER,
        ).send({
            recipeVersionId: candidate.recipeVersionId,
            portionMultiplier: candidate.portionMultiplier,
            expectedPlanRevision: plan.revision,
            idempotencyKey: randomUUID(),
        });

        expectOk(swapped);

        const diary = await asUser(request.get(`${API}/macros/${dayKey}`), PLANNING_USER);

        expectOk(diary);

        const breakfast = (diary.body.meals as Array<Record<string, any>>).find(
            (bucket) => bucket.name === 'Breakfast',
        );

        expectOk(
            await asUser(request.post(`${planBase}/meals/${meal.id}/log`), PLANNING_USER).send({
                servings: 1,
                date: dayKey,
                diaryMealId: breakfast?.id,
                expectedPlanRevision: swapped.body.planRevision,
                idempotencyKey: randomUUID(),
            }),
            201,
        );
    };

    it('leaves ai_usage and usda_api_cache exactly as they were', async () => {
        await seedPlannableWorld();

        const before = await meteringSnapshot();

        expect(before).toEqual({ aiUsage: [], usdaCacheKeys: [] });

        await runFullPlanningWorkload();

        // Rows compared, not counted: an added row and a removed one cannot
        // cancel out here. A cache row in particular would prove a vendor call
        // had been attempted even if it had failed.
        expect(await meteringSnapshot()).toEqual(before);
        expectNoOutboundCalls();
    });

    it('keeps working with AI_FEATURES_ENABLED off, having its own switch', async () => {
        await seedPlannableWorld();
        process.env.AI_FEATURES_ENABLED = 'false';

        await runFullPlanningWorkload();

        // The flag was genuinely in force for those requests — proved by the one
        // endpoint it does govern refusing in the same breath. Without this the
        // test above it would pass even if the variable had never been read.
        const estimate = await asUser(request.post(`${API}/macros/estimate`), PLANNING_USER).send({
            text: 'a bowl of chili',
        });

        expect(estimate.status).toBe(503);
        expect(estimate.body).toEqual({ error: 'feature_disabled' });
        expectNoOutboundCalls();
    });

    /**
     * The contrast that keeps the assertion above meaningful.
     *
     * "Planning writes no `ai_usage` row" would be worth nothing if nothing ever
     * wrote one. The AI endpoints do, and they do it BEFORE the model call — the
     * §9 ordering, so a failed call still costs its quota and failures cannot
     * become free retries. Here the call fails at the unconfigured accessor and
     * the row is written anyway, which is the whole point of that ordering.
     */
    it('still meters an AI endpoint before it spends, which planning never does', async () => {
        await seedPlanner();

        const estimate = await asUser(request.post(`${API}/macros/estimate`), PLANNING_USER).send({
            text: 'a bowl of chili',
        });

        expect(estimate.status).toBe(502);
        expect(estimate.body).toEqual({ error: 'estimation_failed' });

        const metered = await prisma.ai_usage.findMany();

        expect(metered).toHaveLength(1);
        expect(metered[0].user_id).toBe(PLANNING_USER.uid);
        expect(metered[0].count).toBe(1);

        expectNoOutboundCalls();
    });
});

/* -------------------------------------------------------------------------- *
 * Boundaries of the claim: retired and stale local rows
 *
 * This is where a vendor call would most plausibly sneak in. Every case above
 * reads rows that are current and published, so a live lookup would be
 * redundant there; a RETIRED food or a recipe whose ingredient snapshot no
 * longer matches the catalog is the situation where "just re-fetch it" looks
 * like a fix. It is not: a retired row stays referenceable precisely so history
 * keeps rendering, and a stale snapshot is resolved by re-seeding a new recipe
 * version, never by reaching for the live value at request time.
 * -------------------------------------------------------------------------- */

describe('the guarantee holds for retired and stale local rows', () => {
    it('reads a plan built from a retired recipe version and retired foods', async () => {
        const main = await gramFood('Offline Retired Main');
        const staple = await gramFood('Offline Retired Staple');
        const version = await makeRecipeVersion({
            slug: 'offline-retired-recipe',
            catalogFoodId: main.id,
            ingredients: poolIngredients(main, staple),
            status: 'retired',
        });

        await makeUser({ id: PLANNING_USER.uid, ...FIXTURE_USER_TARGET_COLUMNS });
        await makePreferences(PLANNING_USER.uid, { time_zone: 'UTC' });

        const plan = await makePlan(PLANNING_USER.uid, { recipeVersionId: version.id });

        // The catalog moves on after the plan was published: both foods are
        // retired, which removes them from search but must not remove them from
        // the week that already references them.
        await prisma.catalog_foods.updateMany({
            where: { id: { in: [main.id, staple.id] } },
            data: { publication_status: 'retired' },
        });

        const dayKey = plan.meal_plan_days[0].date.toISOString().slice(0, 10);
        const day = await asUser(
            request.get(`${API}/meal-planning/plans/${plan.id}/days/${dayKey}`),
            PLANNING_USER,
        );

        expect(day.status).toBe(200);
        expect(day.body.day.meals).toHaveLength(3);

        // The retired VERSION stays readable for the owner of the plan that
        // references it — history, served from local rows.
        const recipe = await asUser(request.get(`${API}/recipes/${version.id}`), PLANNING_USER);

        expect(recipe.status).toBe(200);
        expect(recipe.body.status).toBe('retired');
        expect(recipe.body.perServing).toEqual(PER_SERVING);
        expect(recipe.body.ingredients).toHaveLength(2);

        // …while the retired foods are gone from search, which is the other half
        // of retirement and proves the rows really were retired.
        const search = await asUser(
            request.get(`${API}/catalog/foods`).query({ q: 'retired' }),
            PLANNING_USER,
        );

        expect(search.status).toBe(200);
        expect(search.body.items).toEqual([]);

        expectNoOutboundCalls();
    });

    it('renders a stale ingredient snapshot from the snapshot, not from the live row', async () => {
        const main = await gramFood('Offline Stale Main');
        const staple = await gramFood('Offline Stale Staple');
        const frozenName = 'Name Frozen At Publication';
        const version = await makeRecipeVersion({
            slug: 'offline-stale-recipe',
            catalogFoodId: main.id,
            ingredients: [
                {
                    catalogFoodId: main.id,
                    per100g: POOL_MAIN_PER_100G,
                    gram_weight: POOL_MAIN_GRAMS,
                    quantity: POOL_MAIN_GRAMS,
                    unit: 'g',
                    display_text: `${POOL_MAIN_GRAMS} g`,
                    snapshot_name: frozenName,
                },
                {
                    catalogFoodId: staple.id,
                    per100g: POOL_STAPLE_PER_100G,
                    gram_weight: POOL_STAPLE_GRAMS,
                    quantity: POOL_STAPLE_GRAMS,
                    unit: 'g',
                    display_text: `${POOL_STAPLE_GRAMS} g`,
                },
            ],
        });

        await makeUser({ id: PLANNING_USER.uid });

        // A catalog refresh renames the food and re-derives its nutrition,
        // bumping both version counters. The recipe's snapshot is now stale by
        // definition — and must still be what the response shows.
        await prisma.catalog_foods.update({
            where: { id: main.id },
            data: {
                display_name: 'Renamed After A Catalog Refresh',
                calories: 9999,
                protein_g: 1,
                carbs_g: 1,
                fat_g: 1,
                nutrition_version: { increment: 1 },
                metadata_version: { increment: 1 },
            },
        });

        const response = await asUser(request.get(`${API}/recipes/${version.id}`), PLANNING_USER);

        expect(response.status).toBe(200);

        const ingredients = response.body.ingredients as Array<Record<string, any>>;

        expect(ingredients[0].name).toBe(frozenName);
        expect(ingredients[0].name).not.toBe('Renamed After A Catalog Refresh');
        expect(ingredients[0].nutritionProvenance).toBe('source_backed');
        // Derived at publication from the snapshot's per-100 g values, so the
        // 9,999 kcal now on the live row cannot reach this response.
        expect(response.body.perServing).toEqual(PER_SERVING);

        expectNoOutboundCalls();
    });
});

/* -------------------------------------------------------------------------- *
 * Identity is the verified token's, never the body's (Rule §4)
 *
 * Every request above authenticates through `x-test-user-id` and sends no
 * `userId`, so on its own the suite only shows that the body is not USED. These
 * two cases show it is not TRUSTED, which is the stronger claim and the one §4
 * actually makes — and they show it holds under both parser dispositions the
 * feature contains, because "the body is ignored" means something different in
 * each. Neither reaches a vendor either, so the offline assertion stands.
 * -------------------------------------------------------------------------- */

describe('a body-supplied userId never establishes identity', () => {
    it('refuses it outright where the endpoint keeps an allowlist', async () => {
        await seedPlannableWorld();

        const plan = await publishWeek();
        const meal = firstMealOf(plan);
        const dayKey = dayKeyOf(plan);

        const diary = await asUser(request.get(`${API}/macros/${dayKey}`), PLANNING_USER);

        expect(diary.status).toBe(200);

        const breakfast = (diary.body.meals as Array<Record<string, any>>).find(
            (bucket) => bucket.name === 'Breakfast',
        );

        expect(breakfast).toBeDefined();

        // An otherwise-valid log body, plus a foreign `userId`. The log endpoint
        // parses against an explicit accepted-key list, so the key is named and
        // rejected rather than quietly dropped — no handler downstream ever gets
        // the chance to read it.
        const response = await asUser(
            request.post(`${API}/meal-planning/plans/${plan.id}/meals/${meal.id}/log`),
            PLANNING_USER,
        ).send({
            servings: 1,
            date: dayKey,
            diaryMealId: breakfast?.id,
            expectedPlanRevision: plan.revision,
            idempotencyKey: randomUUID(),
            userId: OTHER_USER.uid,
        });

        expect(response.status).toBe(400);
        expect(response.body.error).toBe('invalid_request');
        expect(response.body.details).toContainEqual({ field: 'userId', code: 'unknown_field' });

        // Refused at the parser, so nothing was written.
        expect(await prisma.meal_entries.count()).toBe(0);

        expectNoOutboundCalls();
    });

    it('ignores it where the endpoint tolerates extra keys, and the caller still owns the write', async () => {
        await seedPlannableWorld();
        await makeUser({ id: OTHER_USER.uid, ...FIXTURE_USER_TARGET_COLUMNS });
        await makePreferences(OTHER_USER.uid, { time_zone: 'UTC' });

        // Generation parses no accepted-key list, so the foreign `userId` is
        // simply not read. The write must land on the header identity.
        const response = await asUser(
            request.post(`${API}/meal-planning/plans`),
            PLANNING_USER,
        ).send({
            startDate: utcTodayDayKey(),
            idempotencyKey: randomUUID(),
            expectedPreferencesRevision: 1,
            expectedTargetsRevision: 1,
            userId: OTHER_USER.uid,
        });

        expect(response.status).toBe(201);

        // Asserted at the row, not only at the response: the plan belongs to the
        // authenticated caller and no plan exists for the user the body named.
        expect(await prisma.meal_plans.findMany({ select: { user_id: true } })).toEqual([
            { user_id: PLANNING_USER.uid },
        ]);

        const foreignView = await asUser(
            request.get(`${API}/meal-planning/plans/current`),
            OTHER_USER,
        );

        expect(foreignView.status).toBe(200);
        expect(foreignView.body.current).toBeNull();
        expect(foreignView.body.upcoming).toBeNull();

        expectNoOutboundCalls();
    });
});
