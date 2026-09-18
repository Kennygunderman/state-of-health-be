// The catalog area's HTTP contract suite: what an authenticated client actually
// gets back from the three ungated `/api/catalog/*` reads and from the catalog
// body of the shipped diary-log route. Every case is driven over supertest
// through the shipped `app.ts` — its real mount order and its real auth
// boundary — against the ambient test database (AAP §0.9.2 names this file for
// the catalog rows, §0.3.3 for the suite inventory).
//
// THREE FILES DIVIDE THIS AREA, BY WHAT EACH PROOF NEEDS.
//   * `src/services/__tests__/catalog.logic.test.ts` owns every pure rule, with
//     no database and no HTTP: `parseCatalogSearchRequest`'s bands,
//     `parseCatalogSuggestionsQuery`'s kinds, `normalizeCanonicalName`,
//     `buildSourceKey`, the validation tiers, and `mapCatalogFood`'s basis
//     arithmetic and member list. Nothing below restates one of those
//     predicates; where a rule and its wiring share a case, what is asserted
//     here is the RESPONSE — status, body, and the rows that reached it.
//   * This file owns the wiring: that each path reaches the handler the route
//     table declares, that the handler reaches its service, that the service's
//     rows arrive shaped as `src/types/catalog.ts` declares them, and that the
//     status-and-code table of §0.5.2 holds on the wire.
//   * `src/__tests__/api/catalogCollation.test.ts` owns what is a property of
//     the PostgreSQL server rather than of this code — the `COLLATE "C"`
//     ordering pin and the alias index's operator class — which need a database
//     whose default collation disagrees with `C`, so that suite creates one and
//     redirects the Prisma singleton at it. Ordering is asserted in both files
//     and they assert different things: there, that the comparison is pinned;
//     here, that the three keys are consulted in the declared precedence.
//
// HOW A RANK TIE IS CONSTRUCTED, since three of the ordering cases depend on
// it. `searchPublishedFoods` ranks a food by its BEST contribution. The two
// full-text branches score a weighted `ts_rank`; the two prefix branches score
// how much of the matched text the typed prefix covers, and every prefix score
// sits strictly below every full-text score, so the prefix band is a band and
// not a single value. `catalog_foods.search_vector` is generated from
// `search_text` ALONE, so a food whose `search_text` carries no word of the
// query can only ever match through the prefix on its name — inside that band.
// That is what `UNRELATED_SEARCH_TEXT` below is for.
//
// Coverage is `len(query) / len(matched text)`, so two prefix-only foods tie
// only when their names are the SAME LENGTH — which is why the three ordering
// cases below seed names of equal length when they want a tie, and names of
// deliberately different length when they want coverage to decide. A tie is
// still the only way `display_name` and then `source_key` can be observed
// deciding the order at all.
//
// EVERY CASE SEEDS ITS OWN WORLD. `beforeEach` truncates, so each `it` starts
// from an empty catalog and every count, total and page in the assertions is
// absolute rather than relative to what ran before it.
//
// EVERY NON-2xx BODY GOES THROUGH `expectRefusal`, which asserts the exact
// status and body AND that the body leaks no stack frame, Prisma text or raw
// error object (Rule backend-architecture §4). It is a local helper rather than
// a new module under `../setup`, which holds the shared harness this file only
// consumes.

import * as featureFlags from '../../utils/featureFlags';
import { prisma } from '../../prisma/client';
import { CatalogFoodRow, CatalogMappingError, mapCatalogFood } from '../../services/catalog.mapper';
import { CatalogFoodResponse, CatalogStatusResponse, CatalogSuggestionResponse } from '../../types/catalog';
import { MealEntryResponse } from '../../types/nutrition';
import { MakeCatalogFoodOptions, makeCatalogFood, makeRecipeVersion, makeUser } from '../setup/factories';
import { asUser, request } from '../setup/testApp';
import { truncateFeatureTables } from '../setup/testDb';

/* ---------------------------------------------------------------------------
 * The route bands of §0.5.2, restated where they are asserted.
 * ------------------------------------------------------------------------- */

const SEARCH_DEFAULT_LIMIT = 25;
const SEARCH_MAX_LIMIT = 50;
const SUGGESTIONS_DEFAULT_LIMIT = 12;
const SUGGESTIONS_MAX_LIMIT = 30;
const MIN_QUERY_LENGTH = 2;
const MAX_QUERY_LENGTH = 60;

/** A syntactically valid v4 UUID that names nothing. */
const ABSENT_UUID = 'e3b0c442-98fc-4c14-9afb-f4c8996fb924';

/** The day the log cases post into. Fixed, so no assertion reads the clock. */
const DAY_KEY = '2026-04-14';

/**
 * The search term every search case uses, and the `search_text` that cannot
 * match it.
 *
 * `plainto_tsquery('english', 'kumquat')` stems to `kumquat`, which appears in
 * no word of `UNRELATED_SEARCH_TEXT` — so a food seeded with that text is
 * reachable only through the prefix on its name, at the constant zero rank the
 * header describes.
 */
const TERM = 'kumquat';
const UNRELATED_SEARCH_TEXT = 'citrus oddment';

/* ---------------------------------------------------------------------------
 * Local helpers
 * ------------------------------------------------------------------------- */

/** The awaited supertest response, structurally — so supertest stays unimported. */
interface HttpOutcome {
    status: number;
    body: unknown;
}

/** The only two members any error body of these routes may carry. */
const ERROR_BODY_KEYS: readonly string[] = ['error', 'details'];

/**
 * Text that would mean an internal detail reached the client: a stack frame, a
 * source location, a driver or ORM name, a PostgreSQL diagnostic.
 */
const INTERNAL_LEAK_PATTERN = /prisma|\bstack\b|node_modules|\.ts:\d+|\bat \/|invalid input syntax|sqlstate/i;

/**
 * Asserts an error body is a message and nothing more.
 *
 * Rule backend-architecture §4 is explicit that a failure returns a message
 * rather than the raw `err` object, and names `workout.controller.ts`'s
 * `{error: err}` as the pattern to fix rather than follow. Checked structurally
 * AND textually, because the two failures look different: a serialized Error
 * arrives as extra members, while a message built by interpolating one arrives
 * inside the string `error` already is.
 */
const expectSafeErrorBody = (body: unknown): void => {
    expect(typeof body).toBe('object');
    expect(body).not.toBeNull();

    const record = body as Record<string, unknown>;

    expect(Object.keys(record).filter((key) => !ERROR_BODY_KEYS.includes(key))).toEqual([]);
    expect(typeof record.error).toBe('string');

    if (record.details !== undefined) {
        expect(Array.isArray(record.details)).toBe(true);

        for (const detail of record.details as unknown[]) {
            expect(Object.keys(detail as Record<string, unknown>).sort()).toEqual(['code', 'field']);
        }
    }

    expect(JSON.stringify(record)).not.toMatch(INTERNAL_LEAK_PATTERN);
};

/**
 * The refusal assertion every non-2xx case in this file makes: the exact status
 * and body, plus the hygiene above. One helper rather than two assertions per
 * case, so a case cannot be written that forgets the second one.
 */
const expectRefusal = (outcome: HttpOutcome, status: number, body: unknown): void => {
    expect({ status: outcome.status, body: outcome.body }).toEqual({ status, body });
    expectSafeErrorBody(outcome.body);
};

/** A `400 invalid_request` naming one field, as both catalog parsers render it. */
const invalidRequest = (field: string, code: string): unknown => ({
    error: 'invalid_request',
    details: [{ field, code }],
});

/** The caller every read case is made as, the catalog being shared. */
const READER = { uid: 'catalog-reader' };

/** Any GET of these routes, as the app answers it. */
const getAsUser = async (
    path: string,
    query: Record<string, string> = {},
    identity: { uid: string } = READER,
): Promise<HttpOutcome> => {
    const response = await asUser(request.get(path).query(query), identity);

    return { status: response.status, body: response.body };
};

interface SearchOutcome {
    status: number;
    items: CatalogFoodResponse[];
    pagination: unknown;
}

/** `GET /api/catalog/foods` with the envelope split out, for the 200 cases. */
const searchFoods = async (
    query: Record<string, string>,
    identity: { uid: string } = READER,
): Promise<SearchOutcome> => {
    const { status, body } = await getAsUser('/api/catalog/foods', query, identity);
    const envelope = body as { items?: CatalogFoodResponse[]; pagination?: unknown };

    return { status, items: envelope.items ?? [], pagination: envelope.pagination };
};

/** The names of one page, in the order the page returned them. */
const namesOf = (items: readonly CatalogFoodResponse[]): string[] => items.map((item) => item.name);

const suggestions = async (
    query: Record<string, string> = { kind: 'dislike' },
): Promise<{ status: number; body: { items?: CatalogSuggestionResponse[]; pagination?: unknown } }> => {
    const { status, body } = await getAsUser('/api/catalog/foods/suggestions', query);

    return { status, body: body as { items?: CatalogSuggestionResponse[]; pagination?: unknown } };
};

const catalogStatus = async (): Promise<{ status: number; body: CatalogStatusResponse }> => {
    const { status, body } = await getAsUser('/api/catalog/status');

    return { status, body: body as CatalogStatusResponse };
};

/**
 * A published food reachable by {@link TERM} through the prefix on its name and
 * through nothing else, so it scores inside the prefix band.
 *
 * TWO SUCH FOODS TIE ONLY WHEN THEIR NAMES ARE THE SAME LENGTH. A prefix
 * contribution is scored by coverage — the typed prefix's share of the matched
 * text — so `display_name` decides the score as well as the tiebreaker, and a
 * tie has to be built rather than assumed. Every ordering case below that needs
 * a tie therefore uses names of equal length, and says so.
 *
 * `sequence` is always passed explicitly: it is what makes `source_key` and
 * `usda_fdc_id` deterministic, and two foods sharing one would collide on
 * either unique index.
 */
const makePrefixOnlyFood = (
    sequence: number,
    displayName: string,
    overrides: MakeCatalogFoodOptions = {},
) =>
    makeCatalogFood({
        sequence,
        display_name: displayName,
        canonical_name: displayName.toLowerCase(),
        search_text: UNRELATED_SEARCH_TEXT,
        ...overrides,
    });

const addAlias = (foodId: string, alias: string) =>
    prisma.catalog_food_aliases.create({ data: { catalog_food_id: foodId, alias } });

const addPortion = (
    foodId: string,
    portion: { description: string; amount: number; unit: string; gram_weight: number },
) =>
    prisma.catalog_food_portions.create({
        data: { catalog_food_id: foodId, ...portion, is_default: false, source: 'usda_food_portion' },
    });

beforeEach(async () => {
    await truncateFeatureTables();
});

afterEach(() => {
    // The feature-flag cases below spy on a read-once accessor; restoring here
    // rather than in that describe keeps the flag on for every neighbouring
    // suite under `--runInBand`.
    jest.restoreAllMocks();
});

afterAll(async () => {
    await truncateFeatureTables();
});

describe('GET /api/catalog/foods', () => {
    describe('the page envelope the client pages on', () => {
        it('answers a match with its items and a complete page block, and nothing else', async () => {
            await makePrefixOnlyFood(1, 'Kumquat Whole');

            const { status, body } = await getAsUser('/api/catalog/foods', { q: TERM });
            const envelope = body as { items: CatalogFoodResponse[]; pagination: unknown };

            expect(status).toBe(200);
            expect(Object.keys(envelope).sort()).toEqual(['items', 'pagination']);
            expect(namesOf(envelope.items)).toEqual(['Kumquat Whole']);
            expect(envelope.pagination).toEqual({
                page: 1,
                limit: SEARCH_DEFAULT_LIMIT,
                total: 1,
                totalPages: 1,
            });
            // The catalog is shared reference data with no owner column, so the
            // food was created and served without a `users` row existing at all.
            expect(await prisma.users.count()).toBe(0);
        });

        it('reports the ceiling of a total that is not a multiple of the limit', async () => {
            await makePrefixOnlyFood(1, 'Kumquat Alpha');
            await makePrefixOnlyFood(2, 'Kumquat Beta');
            await makePrefixOnlyFood(3, 'Kumquat Gamma');

            const { items, pagination } = await searchFoods({ q: TERM, limit: '2' });

            // Two of three on the page, and a `totalPages` the infinite query
            // can step to: it pages while `page < totalPages`, so a floor here
            // would strand the third food.
            expect(items).toHaveLength(2);
            expect(pagination).toEqual({ page: 1, limit: 2, total: 3, totalPages: 2 });
        });

        it('serves the remainder page without restating the whole total', async () => {
            await makePrefixOnlyFood(1, 'Kumquat Alpha');
            await makePrefixOnlyFood(2, 'Kumquat Beta');
            await makePrefixOnlyFood(3, 'Kumquat Gamma');

            const { items, pagination } = await searchFoods({ q: TERM, page: '2', limit: '2' });

            expect(namesOf(items)).toEqual(['Kumquat Gamma']);
            expect(pagination).toEqual({ page: 2, limit: 2, total: 3, totalPages: 2 });
        });

        it('reports no pages at all for a term nothing matches', async () => {
            await makePrefixOnlyFood(1, 'Kumquat Whole');

            const { status, items, pagination } = await searchFoods({ q: 'rutabaga' });

            expect(status).toBe(200);
            expect(items).toEqual([]);
            expect(pagination).toEqual({
                page: 1,
                limit: SEARCH_DEFAULT_LIMIT,
                total: 0,
                totalPages: 0,
            });
        });
    });

    describe('the request bands of the route', () => {
        it('accepts the largest page the route publishes', async () => {
            await makePrefixOnlyFood(1, 'Kumquat Whole');

            const { status, pagination } = await searchFoods({ q: TERM, limit: String(SEARCH_MAX_LIMIT) });

            expect(status).toBe(200);
            expect(pagination).toEqual({
                page: 1,
                limit: SEARCH_MAX_LIMIT,
                total: 1,
                totalPages: 1,
            });
        });

        // Refused rather than clamped, which is the contract: a request that was
        // quietly rewritten and answered `200 OK` reports success for input
        // nobody sent.
        it.each([
            ['a limit above the route cap', { limit: String(SEARCH_MAX_LIMIT + 1) }, 'limit', 'out_of_range'],
            ['a limit of zero', { limit: '0' }, 'limit', 'out_of_range'],
            ['a fractional limit', { limit: '7.9' }, 'limit', 'invalid'],
            ['a page of zero', { page: '0' }, 'page', 'out_of_range'],
            ['a negative page', { page: '-1' }, 'page', 'out_of_range'],
            ['a page that is not a number', { page: 'abc' }, 'page', 'invalid'],
        ])('refuses %s, naming the field', async (_case, band, field, code) => {
            const outcome = await getAsUser('/api/catalog/foods', { q: TERM, ...band });

            expectRefusal(outcome, 400, invalidRequest(field, code));
        });

        it('refuses a query too short to be worth matching the catalog against', async () => {
            const outcome = await getAsUser('/api/catalog/foods', { q: 'k' });

            expectRefusal(outcome, 400, invalidRequest('q', 'invalid_length'));
        });

        it('refuses a query longer than the route accepts once trimmed', async () => {
            // Padded, so the length that is judged is demonstrably the trimmed
            // one: the padding alone would take it past the bound either way.
            const outcome = await getAsUser('/api/catalog/foods', {
                q: `  ${'k'.repeat(MAX_QUERY_LENGTH + 1)}  `,
            });

            expectRefusal(outcome, 400, invalidRequest('q', 'invalid_length'));
        });

        it('refuses a query that is only whitespace', async () => {
            const outcome = await getAsUser('/api/catalog/foods', { q: '   ' });

            expectRefusal(outcome, 400, invalidRequest('q', 'required'));
        });

        it('accepts a padded query whose trimmed length is within the band', async () => {
            await makePrefixOnlyFood(1, 'Kumquat Whole');

            const { status, items } = await searchFoods({ q: `  ${TERM}  ` });

            expect(status).toBe(200);
            expect(namesOf(items)).toEqual(['Kumquat Whole']);
        });

        it('names every field a request got wrong, so one round trip corrects it', async () => {
            const outcome = await getAsUser('/api/catalog/foods', { q: 'k'.repeat(MIN_QUERY_LENGTH - 1), page: '0' });

            expectRefusal(outcome, 400, {
                error: 'invalid_request',
                details: [
                    { field: 'q', code: 'invalid_length' },
                    { field: 'page', code: 'out_of_range' },
                ],
            });
        });
    });

    describe('which foods a client may see', () => {
        it('returns published foods and hides every other publication status', async () => {
            const published = await makePrefixOnlyFood(1, 'Kumquat Published');
            await makePrefixOnlyFood(2, 'Kumquat Candidate', { publication_status: 'candidate' });
            await makePrefixOnlyFood(3, 'Kumquat Quarantined', { publication_status: 'quarantined' });
            await makePrefixOnlyFood(4, 'Kumquat Rejected', { publication_status: 'rejected' });
            // The one that matters most: `catalog-load.ts` retires a food a
            // newer release no longer carries, and it stays referenceable by
            // recipes and diary entries while being invisible here.
            await makePrefixOnlyFood(5, 'Kumquat Retired', { publication_status: 'retired' });

            const { items, pagination } = await searchFoods({ q: TERM });

            expect(items.map((item) => item.id)).toEqual([published.id]);
            expect(pagination).toMatchObject({ total: 1 });
        });

        it('returns one row per food however many of its aliases match', async () => {
            const food = await makeCatalogFood({
                sequence: 1,
                display_name: 'Aubergine Whole',
                canonical_name: 'aubergine whole',
                search_text: 'aubergine',
            });
            await addAlias(food.id, 'eggplant');
            await addAlias(food.id, 'eggplant large');

            const { items, pagination } = await searchFoods({ q: 'eggplant' });

            // Both aliases match by full text and both by prefix, so the food
            // contributes four rows before `MAX(rank) … GROUP BY id` collapses
            // them; without that it would occupy four slots and be counted four
            // times.
            expect(items).toHaveLength(1);
            expect(items[0].id).toBe(food.id);
            expect(pagination).toMatchObject({ total: 1 });
        });

        it('finds a food by a word that appears in none of its own columns', async () => {
            const food = await makeCatalogFood({
                sequence: 1,
                display_name: 'Aubergine Whole',
                canonical_name: 'aubergine whole',
                search_text: 'aubergine',
            });
            await addAlias(food.id, 'eggplant');

            const { items } = await searchFoods({ q: 'eggplant' });

            expect(items.map((item) => item.id)).toEqual([food.id]);
        });

        it('serves two different callers the same foods, the catalog being shared', async () => {
            const food = await makePrefixOnlyFood(1, 'Kumquat Whole');
            const first = await makeUser({ sequence: 1 });
            const second = await makeUser({ sequence: 2 });

            const forFirst = await searchFoods({ q: TERM }, { uid: first.id });
            const forSecond = await searchFoods({ q: TERM }, { uid: second.id });

            // The documented exception to Rule §5.1: `catalog_foods` carries no
            // `user_id`, so these reads have no owner to scope to and no
            // cross-user row to leak. The sharing is asserted rather than
            // assumed.
            expect(forFirst.items.map((item) => item.id)).toEqual([food.id]);
            expect(forSecond.items.map((item) => item.id)).toEqual([food.id]);
        });

        it('refuses rather than inventing the default portion its contract promises', async () => {
            const logged = jest.spyOn(console, 'error').mockImplementation(() => undefined);
            const food = await makePrefixOnlyFood(1, 'Kumquat Whole');
            await prisma.catalog_food_portions.deleteMany({ where: { catalog_food_id: food.id } });

            const outcome = await getAsUser('/api/catalog/foods', { q: TERM });

            // `CatalogFoodResponse.defaultPortion` is non-null for every
            // published item, and this is how that promise is kept: the read
            // fails closed rather than answering with a fabricated gram weight
            // every recipe and grocery quantity would then be computed from.
            expectRefusal(outcome, 500, { error: 'Failed to search catalog foods' });
            expect(logged).toHaveBeenCalled();
        });
    });

    describe('the order of a page', () => {
        it('puts a full-text match above a name that only matched by prefix', async () => {
            // Alphabetically first, so a missing `rank DESC` would put it first.
            await makePrefixOnlyFood(1, 'Kumquat Alpha');
            await makeCatalogFood({
                sequence: 2,
                display_name: 'Kumquat Zeta',
                canonical_name: 'kumquat zeta',
                search_text: 'kumquat preserved',
            });

            const { items } = await searchFoods({ q: TERM });

            expect(namesOf(items)).toEqual(['Kumquat Zeta', 'Kumquat Alpha']);
        });

        it('breaks a tie on rank with the display name', async () => {
            // Three names of the SAME LENGTH, so the prefix coverage — and
            // therefore the rank — is identical and only `display_name` is left
            // to explain the sequence.
            await makePrefixOnlyFood(3, 'Kumquat Gamma');
            await makePrefixOnlyFood(1, 'Kumquat Alpha');
            await makePrefixOnlyFood(2, 'Kumquat Delta');

            const { items } = await searchFoods({ q: TERM });

            // Seeded out of order, so insertion order cannot satisfy this.
            expect(namesOf(items)).toEqual(['Kumquat Alpha', 'Kumquat Delta', 'Kumquat Gamma']);
        });

        it('puts the name the typed prefix covers most of first', async () => {
            // Both are reachable only by prefix, so both sit in the prefix band
            // and `display_name` would order the longer name first. It comes
            // second, so coverage is what ordered them — the fix for a prefix
            // match set that used to tie at one rank and fall back to
            // alphabetical order.
            await makePrefixOnlyFood(1, 'Kumquat, canned in heavy syrup');
            await makePrefixOnlyFood(2, 'Kumquat, raw');

            const { items } = await searchFoods({ q: TERM });

            expect(namesOf(items)).toEqual(['Kumquat, raw', 'Kumquat, canned in heavy syrup']);
        });

        it('puts the food the query names above a food that merely mentions it', async () => {
            // Both match on meaning, so both are outside the prefix band and
            // the alphabetically-first name would win on the tiebreaker. The
            // food whose name IS the term wins instead: its name carries fewer
            // unrelated words, and the term is its head noun rather than a
            // qualifier after the comma.
            await makeCatalogFood({
                sequence: 1,
                display_name: 'Bread, kumquat',
                canonical_name: 'bread, kumquat',
                search_text: 'bread kumquat baked',
            });
            await makeCatalogFood({
                sequence: 2,
                display_name: 'Kumquat',
                canonical_name: 'kumquat',
                search_text: 'kumquat raw fruit',
            });

            const { items } = await searchFoods({ q: TERM });

            expect(namesOf(items)).toEqual(['Kumquat', 'Bread, kumquat']);
        });

        it('does not let a short alias on a vague food outrank a precisely named one', async () => {
            // The measured defect this scoring exists for: an alias used to be
            // scored against its own length, so a one-word alias on a food with
            // a long name outranked the food the user actually meant.
            const vague = await makeCatalogFood({
                sequence: 1,
                display_name: 'Fruit, NS as to type, NS as to preparation',
                canonical_name: 'fruit, ns as to type, ns as to preparation',
                search_text: 'fruit unspecified',
            });
            await addAlias(vague.id, TERM);
            await makeCatalogFood({
                sequence: 2,
                display_name: 'Kumquat, raw',
                canonical_name: 'kumquat, raw',
                search_text: 'kumquat raw fruit',
            });

            const { items } = await searchFoods({ q: TERM });

            expect(namesOf(items)).toEqual(['Kumquat, raw', 'Fruit, NS as to type, NS as to preparation']);
        });

        it('puts a full-text match on the head noun above one on a modifier', async () => {
            // "kumquat bread" is a bread; "Kumquat, raw" is a kumquat. Both
            // names carry the term and the same number of words, so only the
            // head-noun rule can separate them — and the alphabetical
            // tiebreaker would have chosen the other way round.
            await makeCatalogFood({
                sequence: 1,
                display_name: 'Kumquat bread',
                canonical_name: 'kumquat bread',
                search_text: 'kumquat bread baked',
            });
            await makeCatalogFood({
                sequence: 2,
                display_name: 'Kumquat, raw',
                canonical_name: 'kumquat, raw',
                search_text: 'kumquat raw fruit',
            });

            const { items } = await searchFoods({ q: TERM });

            expect(namesOf(items)).toEqual(['Kumquat, raw', 'Kumquat bread']);
        });

        it('applies the head-noun rule to a name no two collations case-fold alike', async () => {
            // THE PORTABILITY GUARD, and the reason it is an ordering case here
            // rather than a unit test. The head noun is extracted TWICE — in
            // JavaScript for the query (`searchQueryHeadNoun`) and in SQL for
            // the name — and the two extractions have to produce byte-identical
            // text or the comparison silently fails and the food drops a tier.
            // Tier decides `rank`, and `rank` is the FIRST ordering key, so
            // `COLLATE "C"` on the two text tiebreakers cannot repair it.
            //
            // They did diverge. The SQL side folded with `lower()`, which
            // resolves through the collation, and the JavaScript side with
            // `toLowerCase()`, which does not: `'MURNİX'.toLowerCase()` gives
            // `murni` + U+0307 + `x` while `lower('MURNİX')` gives a plain
            // `murnix` on this database — so NEITHER food below matched on its
            // head noun, both fell to the head-segment weight, their ranks tied
            // and the collated name decided, returning them the other way
            // round. Under an ICU collation the same code matched, which is the
            // whole defect: the answer depended on the server, and AAP §§0.5.2
            // and 0.9.3 require two independently loaded databases to agree.
            //
            // U+0130 sits in the MIDDLE of the term on purpose. The food that
            // must rank first has to sort SECOND in C byte order, or a build
            // with no head-noun signal at all would pass this; a term opening
            // with U+0130 encodes as 0xC4 0xB0 and would always sort last.
            const unicodeTerm = 'MURNİX';

            await makeCatalogFood({
                sequence: 1,
                display_name: 'MURNİX bread',
                canonical_name: 'murnİx bread',
                search_text: 'MURNİX bread',
                food_state: 'cooked',
            });
            await makeCatalogFood({
                sequence: 2,
                display_name: 'Zested MURNİX',
                canonical_name: 'zested murnİx',
                search_text: 'Zested MURNİX',
                food_state: 'raw',
            });

            // The premise, asserted rather than assumed: C byte order puts the
            // modifier first, so the expectation below can only be met by rank.
            expect(['MURNİX bread', 'Zested MURNİX'].slice().sort()).toEqual([
                'MURNİX bread',
                'Zested MURNİX',
            ]);

            const { items } = await searchFoods({ q: unicodeTerm });

            expect(namesOf(items)).toEqual(['Zested MURNİX', 'MURNİX bread']);
        });

        it('returns a food a PARTIAL query reaches only through its non-ASCII uppercase name', async () => {
            // THE SAME PORTABILITY GUARD ONE BRANCH EARLIER, and the sharper
            // half of it. The head-noun case above is about which TIER a food
            // scores in; this one is about whether the food is in the result at
            // all. A partial query — a strict prefix of a word — matches through
            // NO branch but the two prefix branches, because `plainto_tsquery`
            // has no prefix semantics, so a fold mismatch on this path does not
            // mis-rank the food, it removes it.
            //
            // Both sides fold through the one ASCII map now: the pattern with
            // `foldSearchAscii`, the three columns with `translate()` over the
            // same two exported constants, indexed by
            // `20260910000000_catalog_prefix_fold_indexes`. Under the pairing
            // this replaced — `q.toLowerCase()` against `lower(col)` — the
            // pattern was `murni` + U+0307 while `lower()` answered a plain
            // `murnix…` on this database and `murnİx…` under C, so the row below
            // was returned on some servers and not on others. AAP §§0.5.2 and
            // 0.9.3 require two independently loaded databases to answer the
            // same way, which a food that is present in one and absent in the
            // other fails outright.
            //
            // `catalogCollation.test.ts` makes the same claim against an ICU
            // database, which is the other collation this project meets; this
            // case is the ambient half, driven over HTTP through the shipped
            // route.
            const partial = 'MURNİ';
            const food = await makePrefixOnlyFood(1, 'MURNİXBERRY, raw', {
                // What `normalizeCanonicalName` produces for this name: NFKD
                // decomposition drops the combining dot, so the canonical name
                // is plain ASCII while the display name keeps U+0130. Written
                // out rather than derived, so the fixture says which column the
                // capital is in.
                canonical_name: 'murnixberry raw',
            });

            const { status, items, pagination } = await searchFoods({ q: partial });

            expect(status).toBe(200);
            expect(items.map((item) => item.id)).toEqual([food.id]);
            expect(pagination).toMatchObject({ total: 1 });
        });

        it('returns a food a PARTIAL query reaches only through its non-ASCII uppercase alias', async () => {
            // The alias branch of the same guard: this food's own two name
            // columns carry no word of the term, so the row can only have
            // arrived through the alias prefix — the branch
            // `idx_catalog_food_aliases_fold_alias` serves. The alias is stored
            // in capitals, so the fold is doing work on the column side rather
            // than on pre-folded fixture text.
            const food = await makePrefixOnlyFood(1, 'Bottled compote', {
                canonical_name: 'bottled compote',
            });
            await addAlias(food.id, 'MURNİXBERRY PEEL');

            const { status, items, pagination } = await searchFoods({ q: 'MURNİ' });

            expect(status).toBe(200);
            expect(items.map((item) => item.id)).toEqual([food.id]);
            expect(pagination).toMatchObject({ total: 1 });
        });

        it('puts a name match above a food matched only by its descriptor words', async () => {
            // The weakest positive band, and the reason it stays positive: the
            // second food is still found and still returned, it simply cannot
            // outrank a food that is called what the user typed.
            await makeCatalogFood({
                sequence: 1,
                display_name: 'Aubergine, raw',
                canonical_name: 'aubergine, raw',
                search_text: `aubergine raw ${TERM} adjacent`,
            });
            await makeCatalogFood({
                sequence: 2,
                display_name: 'Kumquat, raw',
                canonical_name: 'kumquat, raw',
                search_text: 'kumquat raw fruit',
            });

            const { items, pagination } = await searchFoods({ q: TERM });

            // Asserted whole, so "still returned" is part of the claim rather
            // than an inference from the order.
            expect(pagination).toEqual({ page: 1, limit: SEARCH_DEFAULT_LIMIT, total: 2, totalPages: 1 });
            expect(namesOf(items)).toEqual(['Kumquat, raw', 'Aubergine, raw']);
        });

        it('breaks a tie on rank and display name with the portable source key', async () => {
            const second = await makePrefixOnlyFood(2, 'Kumquat Tie', {
                canonical_name: 'kumquat tie second',
                source_key: 'usda:9100002',
            });
            const first = await makePrefixOnlyFood(1, 'Kumquat Tie', {
                canonical_name: 'kumquat tie first',
                source_key: 'usda:9100001',
            });

            const { items } = await searchFoods({ q: TERM });

            // `source_key` and not `id`: primary keys are `gen_random_uuid()`
            // and differ between two databases holding the same release, so an
            // order falling back to one would page differently per machine.
            expect(items.map((item) => item.id)).toEqual([first.id, second.id]);
        });
    });

    describe('the food each row carries', () => {
        const FOOD_FIELDS: readonly string[] = [
            'id',
            'name',
            'category',
            'foodState',
            'identitySource',
            'nutritionProvenance',
            'nutritionBasis',
            'basisAmount',
            'calories',
            'protein',
            'carbs',
            'fat',
            'fiber',
            'defaultPortion',
            'allergenTags',
            'allergenStatus',
            'foodGroup',
        ];

        const seedPreserve = () =>
            makeCatalogFood({
                sequence: 1,
                display_name: 'Kumquat Preserve',
                canonical_name: 'kumquat preserve',
                search_text: 'kumquat preserve',
                category: 'produce_fruit',
                food_state: 'prepared',
                identity_source: 'usda',
                nutrition_provenance: 'source_backed',
                calories: 71,
                protein_g: 1.9,
                carbs_g: 15.9,
                fat_g: 0.9,
                fiber_g: 6.5,
                allergen_tags: ['sesame'],
                allergen_status: 'known',
                food_group: 'citrus',
                defaultPortion: { description: '1 fruit', amount: 1, unit: 'fruit', gram_weight: 19 },
            });

        it('carries exactly the members the response contract declares', async () => {
            const food = await seedPreserve();

            const { items } = await searchFoods({ q: TERM });

            expect(items[0]).toStrictEqual({
                id: food.id,
                name: 'Kumquat Preserve',
                category: 'produce_fruit',
                foodState: 'prepared',
                identitySource: 'usda',
                nutritionProvenance: 'source_backed',
                // The mass basis the stored values are stated per, never the
                // portion: a client reaching one portion with
                // `gramWeight / basisAmount` performs the same single
                // multiplication the diary snapshot does.
                nutritionBasis: 'per_100g',
                basisAmount: 100,
                calories: 71,
                protein: 1.9,
                carbs: 15.9,
                fat: 0.9,
                fiber: 6.5,
                defaultPortion: { description: '1 fruit', amount: 1, unit: 'fruit', gramWeight: 19 },
                allergenTags: ['sesame'],
                allergenStatus: 'known',
                foodGroup: 'citrus',
            });
        });

        it('carries no column of the row that is not part of the contract', async () => {
            await seedPreserve();

            const { items } = await searchFoods({ q: TERM });

            // Named as well as pinned by the assertion above, because the two
            // members a raw row would volunteer are the ones that must never
            // reach a client: the generated `search_vector`, and any owner key
            // a reader might expect to find on a shared row.
            expect(Object.keys(items[0]).sort()).toEqual([...FOOD_FIELDS].sort());
            expect(items[0]).not.toHaveProperty('search_vector');
            expect(items[0]).not.toHaveProperty('searchVector');
            expect(items[0]).not.toHaveProperty('userId');
        });

        it('reports an unknown fibre value as null rather than as zero', async () => {
            await makePrefixOnlyFood(1, 'Kumquat Whole', { fiber_g: null });

            const { items } = await searchFoods({ q: TERM });

            // null is UNKNOWN. A 0 would claim the food contains no fibre, which
            // is a different and unsupported statement.
            expect(items[0].fiber).toBeNull();
        });

        it('reports identity, state and safety as machine codes, never as display copy', async () => {
            await seedPreserve();

            const { items } = await searchFoods({ q: TERM });
            const item = items[0];

            // The client maps each of these through `strings.ts`, so a display
            // string here ('Source-backed', 'Raw') would put copy on the wire.
            expect({
                category: item.category,
                foodState: item.foodState,
                identitySource: item.identitySource,
                nutritionProvenance: item.nutritionProvenance,
                allergenStatus: item.allergenStatus,
                foodGroup: item.foodGroup,
            }).toEqual({
                category: 'produce_fruit',
                foodState: 'prepared',
                identitySource: 'usda',
                nutritionProvenance: 'source_backed',
                allergenStatus: 'known',
                foodGroup: 'citrus',
            });
        });

        it('reports each nutrition-provenance class as its own value, estimates included', async () => {
            const sourceBacked = await makePrefixOnlyFood(1, 'Kumquat Sourced', {
                nutrition_provenance: 'source_backed',
            });
            const derived = await makePrefixOnlyFood(2, 'Kumquat Derived', {
                nutrition_provenance: 'ingredient_derived',
            });
            const estimated = await makePrefixOnlyFood(3, 'Kumquat Estimated', {
                nutrition_provenance: 'ai_estimated',
            });

            const { items } = await searchFoods({ q: TERM });
            const byId = new Map(items.map((item) => [item.id, item.nutritionProvenance]));

            // All three are searchable and each carries its own class, which is
            // what lets the client label an estimate as one everywhere it
            // appears — the labelling the prompt requires through search,
            // details and the diary.
            expect(byId.get(sourceBacked.id)).toBe('source_backed');
            expect(byId.get(derived.id)).toBe('ingredient_derived');
            expect(byId.get(estimated.id)).toBe('ai_estimated');
        });

        it('keeps identity source and nutrition provenance independent of one another', async () => {
            await makePrefixOnlyFood(1, 'Kumquat Generated', {
                identity_source: 'ai_generated',
                identity_status: 'verified',
                nutrition_provenance: 'source_backed',
                usda_fdc_id: null,
                source_key: 'ai:produce_fruit:kumquat generated:cooked',
            });

            const { items } = await searchFoods({ q: TERM });

            // Three independent facts, never one mixed enum: a generated
            // identity can still carry source-backed nutrition.
            expect({
                identitySource: items[0].identitySource,
                nutritionProvenance: items[0].nutritionProvenance,
            }).toEqual({ identitySource: 'ai_generated', nutritionProvenance: 'source_backed' });
        });
    });
});


describe('GET /api/catalog/foods/suggestions', () => {
    /** A published food flagged as a common dislike — what this route draws from. */
    const makeDislikeFood = (sequence: number, displayName: string, overrides: MakeCatalogFoodOptions = {}) =>
        makeCatalogFood({
            sequence,
            display_name: displayName,
            canonical_name: displayName.toLowerCase(),
            is_common_dislike: true,
            food_group: 'mushroom',
            ...overrides,
        });

    it('answers with the narrow three-member projection the chips render', async () => {
        const food = await makeDislikeFood(1, 'Mushrooms White');

        const { status, body } = await suggestions();

        expect(status).toBe(200);
        expect(Object.keys(body).sort()).toEqual(['items']);
        // Three members and no more: these are the food-preferences chips, so
        // the projection deliberately carries no nutrition and no provenance.
        expect(body.items).toStrictEqual([{ id: food.id, name: 'Mushrooms White', foodGroup: 'mushroom' }]);
    });

    it('draws only on published foods the coverage plan flagged', async () => {
        const flagged = await makeDislikeFood(1, 'Mushrooms White');
        await makeDislikeFood(2, 'Mushrooms Candidate', { publication_status: 'candidate' });
        await makeCatalogFood({
            sequence: 3,
            display_name: 'Mushrooms Unflagged',
            canonical_name: 'mushrooms unflagged',
            is_common_dislike: false,
        });

        const { body } = await suggestions();

        expect(body.items?.map((item) => item.id)).toEqual([flagged.id]);
    });

    it('serves twelve chips when the request names no limit', async () => {
        const names = Array.from({ length: SUGGESTIONS_DEFAULT_LIMIT + 1 }, (_unused, index) =>
            `Mushrooms ${String(index).padStart(2, '0')}`,
        );

        for (const [index, name] of names.entries()) {
            await makeDislikeFood(index + 1, name);
        }

        const { body } = await suggestions();

        // Twelve and thirty, not the search route's twenty-five and fifty: two
        // different bands, and mixing them up is exactly the wiring slip this
        // suite exists to catch.
        expect(body.items?.map((item) => item.name)).toEqual(names.slice(0, SUGGESTIONS_DEFAULT_LIMIT));
    });

    it('serves the largest page this route publishes when it is asked for exactly', async () => {
        await makeDislikeFood(1, 'Mushrooms White');

        const { status, body } = await suggestions({ kind: 'dislike', limit: String(SUGGESTIONS_MAX_LIMIT) });

        expect(status).toBe(200);
        expect(body.items).toHaveLength(1);
    });

    it.each([
        ['above this route´s maximum', String(SUGGESTIONS_MAX_LIMIT + 1), 'out_of_range'],
        ['at the search route´s maximum, which is not this one', String(SEARCH_MAX_LIMIT), 'out_of_range'],
        ['zero', '0', 'out_of_range'],
        ['fractional', '7.9', 'invalid'],
    ])('refuses a limit %s', async (_case, limit, code) => {
        const outcome = await getAsUser('/api/catalog/foods/suggestions', { kind: 'dislike', limit });

        expectRefusal(outcome, 400, invalidRequest('limit', code));
    });

    it.each([
        ['names a kind this endpoint does not answer', { kind: 'favourite' }],
        ['names no kind at all', {}],
    ])('refuses a request that %s', async (_case, query) => {
        const outcome = await getAsUser('/api/catalog/foods/suggestions', query);

        // One detail for both, because the contract defines a single kind: "you
        // sent the wrong one" and "you sent none" ask the caller for the same
        // correction.
        expectRefusal(outcome, 400, invalidRequest('kind', 'unsupported'));
    });

    it('refuses the unanswerable kind before it complains about the page size', async () => {
        const outcome = await getAsUser('/api/catalog/foods/suggestions', { kind: 'favourite', limit: '0' });

        expectRefusal(outcome, 400, invalidRequest('kind', 'unsupported'));
    });

    it('offers the same chips in the same order to an identical repeated request', async () => {
        await makeDislikeFood(2, 'Mushrooms Shiitake');
        await makeDislikeFood(1, 'Mushrooms Portobello');
        await makeDislikeFood(3, 'Mushrooms White');

        const first = await suggestions();
        const second = await suggestions();

        // A total order, so a re-render cannot reshuffle the chips under the
        // user's finger; seeded out of alphabetical order, so insertion order
        // cannot satisfy it.
        expect(first.body.items?.map((item) => item.name)).toEqual([
            'Mushrooms Portobello',
            'Mushrooms Shiitake',
            'Mushrooms White',
        ]);
        expect(second.body.items).toEqual(first.body.items);
    });
});

describe('GET /api/catalog/status', () => {
    const succeededReleaseLoad = (manifestVersion: string, finishedAt: string, startedAt: string) =>
        prisma.catalog_import_runs.create({
            data: {
                kind: 'release_load',
                manifest_version: manifestVersion,
                status: 'succeeded',
                started_at: new Date(startedAt),
                finished_at: new Date(finishedAt),
            },
        });

    it('reports every member of the operator contract, with no release loaded', async () => {
        const { status, body } = await catalogStatus();

        expect(status).toBe(200);
        expect(body).toStrictEqual({
            // Both null in the never-loaded state, which is the one state the
            // nullable members describe.
            catalogRelease: null,
            publishedCount: 0,
            quarantinedCount: 0,
            rejectedCount: 0,
            recipeCount: 0,
            lastLoadedAt: null,
        });
    });

    it('counts each publication status as its own figure', async () => {
        await makeCatalogFood({ sequence: 1 });
        await makeCatalogFood({ sequence: 2 });
        await makeCatalogFood({ sequence: 3, publication_status: 'quarantined' });
        await makeCatalogFood({ sequence: 4, publication_status: 'rejected' });
        await makeCatalogFood({ sequence: 5, publication_status: 'rejected' });
        await makeCatalogFood({ sequence: 6, publication_status: 'rejected' });
        // Reported by none of the three counts, so a count that silently
        // swallowed a fourth status would show up here.
        await makeCatalogFood({ sequence: 7, publication_status: 'candidate' });
        await makeCatalogFood({ sequence: 8, publication_status: 'retired' });

        const { body } = await catalogStatus();

        expect({
            publishedCount: body.publishedCount,
            quarantinedCount: body.quarantinedCount,
            rejectedCount: body.rejectedCount,
        }).toEqual({ publishedCount: 2, quarantinedCount: 1, rejectedCount: 3 });
    });

    it('counts the recipe versions planning may currently use, and no others', async () => {
        const food = await makeCatalogFood({ sequence: 1 });
        await makeRecipeVersion({ sequence: 2, catalogFoodId: food.id });
        await makeRecipeVersion({ sequence: 3, catalogFoodId: food.id, status: 'retired' });

        const { body } = await catalogStatus();

        // The release gate reads this number as "distinct plannable recipes", so
        // a retired version — still readable for the plans that reference it —
        // must not inflate it.
        expect(body.recipeCount).toBe(1);
        expect(body.publishedCount).toBe(1);
    });

    it('reports the release the newest succeeded load carries', async () => {
        await succeededReleaseLoad('v1', '2026-09-01T10:05:00.000Z', '2026-09-01T10:00:00.000Z');

        const { body } = await catalogStatus();

        expect({ catalogRelease: body.catalogRelease, lastLoadedAt: body.lastLoadedAt }).toEqual({
            catalogRelease: 'v1',
            lastLoadedAt: '2026-09-01T10:05:00.000Z',
        });
    });

    it('keeps the earlier succeeded release active when a later load failed', async () => {
        await succeededReleaseLoad('v1', '2026-09-01T10:05:00.000Z', '2026-09-01T10:00:00.000Z');
        await prisma.catalog_import_runs.create({
            data: {
                kind: 'release_load',
                manifest_version: 'v2',
                status: 'failed',
                started_at: new Date('2026-09-02T10:00:00.000Z'),
                finished_at: new Date('2026-09-02T10:01:00.000Z'),
            },
        });

        const { body } = await catalogStatus();

        // A failed or partial load must not move the release pointer: the
        // previous release simply stays active, which is what makes re-running
        // the loader safe.
        expect({ catalogRelease: body.catalogRelease, lastLoadedAt: body.lastLoadedAt }).toEqual({
            catalogRelease: 'v1',
            lastLoadedAt: '2026-09-01T10:05:00.000Z',
        });
    });

    it('ignores a succeeded run that is not a release load', async () => {
        await prisma.catalog_import_runs.create({
            data: {
                kind: 'usda_import',
                manifest_version: 'usda-manifest-v1',
                status: 'succeeded',
                started_at: new Date('2026-09-03T10:00:00.000Z'),
                finished_at: new Date('2026-09-03T11:00:00.000Z'),
            },
        });

        const { body } = await catalogStatus();

        // An import is not a release: reporting its manifest as the live
        // catalog would tell an operator a release is loaded when none is.
        expect({ catalogRelease: body.catalogRelease, lastLoadedAt: body.lastLoadedAt }).toEqual({
            catalogRelease: null,
            lastLoadedAt: null,
        });
    });

    it('falls back to the start of a succeeded load that recorded no finish', async () => {
        await prisma.catalog_import_runs.create({
            data: {
                kind: 'release_load',
                manifest_version: 'v1',
                status: 'succeeded',
                started_at: new Date('2026-09-01T10:00:00.000Z'),
                finished_at: null,
            },
        });

        const { body } = await catalogStatus();

        // The fallback to `started_at` lives in `getStatus`, not in
        // `mapCatalogStatus` — the mapper reports `null` for a missing finish
        // and is the defence for any other caller. What this pins is the
        // pairing the two nullable members promise: a reported release always
        // carries a load time, so an operator never reads a release id beside a
        // blank timestamp and has to guess which of the two is wrong.
        expect(body.lastLoadedAt).toBe('2026-09-01T10:00:00.000Z');
        expect(body.catalogRelease).toBe('v1');
    });
});


/**
 * The catalog reads are never gated; the recipe read is.
 *
 * `featureFlags.ts` reads `MEAL_PLANNING_ENABLED` ONCE at import behind an
 * accessor, so the switch cannot be flipped by assigning to `process.env` here
 * — the module graph is already built. The accessor is the seam the module
 * publishes for exactly this reason, so it is spied on; the file-level
 * `afterEach` restores it, which is what keeps the flag on for the suites that
 * need it under `--runInBand`.
 */
describe('with meal planning switched off at the server', () => {
    const disablePlanning = () => jest.spyOn(featureFlags, 'isMealPlanningEnabled').mockReturnValue(false);

    it('still serves a real page of catalog search results', async () => {
        const food = await makePrefixOnlyFood(1, 'Kumquat Whole');
        disablePlanning();

        const { status, items } = await searchFoods({ q: TERM });

        // Asserted as a positive rather than as "not 503": this exemption is
        // what keeps Add Food's catalog section working while planning is off.
        expect(status).toBe(200);
        expect(items.map((item) => item.id)).toEqual([food.id]);
    });

    it('still serves the dislike suggestion chips', async () => {
        const food = await makeCatalogFood({ sequence: 1, is_common_dislike: true });
        disablePlanning();

        const { status, body } = await suggestions();

        expect(status).toBe(200);
        expect(body.items?.map((item) => item.id)).toEqual([food.id]);
    });

    it('still reports the operator status', async () => {
        await makeCatalogFood({ sequence: 1 });
        disablePlanning();

        const { status, body } = await catalogStatus();

        expect(status).toBe(200);
        expect(body.publishedCount).toBe(1);
    });

    it('refuses the recipe read, which is the one gated route of this router', async () => {
        disablePlanning();

        const outcome = await getAsUser(`/api/recipes/${ABSENT_UUID}`);

        // Two prefixes, one router and one controller, deliberately different
        // postures. The rest of `/recipes/*` belongs to `recipes.test.ts`; this
        // is the contrast.
        expectRefusal(outcome, 503, { error: 'feature_disabled' });
    });

    it('answers the recipe read again once planning is back on', async () => {
        const outcome = await getAsUser(`/api/recipes/${ABSENT_UUID}`);

        // The spy is restored between cases, so the 503 above was the flag and
        // not a route that had stopped answering.
        expectRefusal(outcome, 404, { error: 'Recipe not found' });
    });
});

describe('the mounting of the catalog router', () => {
    it('reaches the suggestions handler rather than letting the search path swallow it', async () => {
        const food = await makeCatalogFood({ sequence: 1, is_common_dislike: true, food_group: 'mushroom' });

        const { status, body } = await suggestions();

        // `/catalog/foods/suggestions` and `/catalog/foods` are both literals
        // in `catalog.routes.ts`, so Express matches them exactly, and what is
        // asserted here is which handler the more specific path reaches. The
        // body below is the suggestions projection of §0.5.2 — `{id, name,
        // foodGroup}` per item and NO `pagination` block — and that is the one
        // answer `searchCatalogFoodsController` cannot give, so it is the
        // evidence that the path reached
        // `catalog.controller.ts::getCatalogSuggestionsController`. A path
        // bound to the wrong handler, or captured by the search read, answers a
        // page of `CatalogFoodResponse` inside a `pagination` envelope instead
        // — which is the failure this case reports.
        expect(status).toBe(200);
        expect(body).not.toHaveProperty('pagination');
        expect(body.items).toStrictEqual([
            { id: food.id, name: food.display_name, foodGroup: 'mushroom' },
        ]);
    });

    it.each([
        ['the search read', '/api/catalog/foods?q=kumquat'],
        ['the suggestions read', '/api/catalog/foods/suggestions?kind=dislike'],
        ['the status read', '/api/catalog/status'],
        ['the recipe read', `/api/recipes/${ABSENT_UUID}`],
    ])('refuses %s to a caller with no identity', async (_case, path) => {
        const response = await request.get(path);

        // The router mounts AFTER `app.use(authenticateFirebaseToken)`, and
        // that is a security posture rather than a detail: on the wrong side of
        // that line these reads would be public.
        expectRefusal({ status: response.status, body: response.body }, 401, { error: 'No token provided' });
    });
});

describe('POST /api/macros/meal/:mealId/entries — the catalog body', () => {
    const owner = { uid: '' };
    let breakfastId = '';

    /** The per-serving snapshot a default `makeCatalogFood` produces. */
    const FIXTURE_PER_SERVING: Pick<MealEntryResponse, 'calories' | 'protein' | 'carbs' | 'fat'> = {
        calories: 300,
        protein: 30,
        carbs: 40,
        fat: 4,
    };

    /**
     * The success body, read through its declared type.
     *
     * supertest types `body` as `any`, so a member read off it is unchecked and
     * a renamed DTO member would surface only as a runtime failure. Naming the
     * type here makes the rename a compile error instead, which is the same
     * reason the catalog helpers above name theirs.
     */
    const entryOf = (response: { body: unknown }): MealEntryResponse => response.body as MealEntryResponse;

    const legacyBody = () => ({
        name: 'Scrambled eggs',
        calories: 220,
        protein: 14,
        carbs: 2,
        fat: 16,
    });

    const postEntry = (body: Record<string, unknown>, mealId: string = breakfastId) =>
        asUser(request.post(`/api/macros/meal/${mealId}/entries`).send(body), owner);

    const storedEntries = () =>
        prisma.meal_entries.findMany({
            where: { user_id: owner.uid },
            orderBy: { logged_at: 'asc' },
            select: {
                user_id: true,
                food_id: true,
                catalog_food_id: true,
                meal_plan_meal_id: true,
                name: true,
                serving_text: true,
                servings: true,
                calories: true,
                protein_g: true,
                carbs_g: true,
                fat_g: true,
                input_method: true,
                nutrition_provenance: true,
            },
        });

    beforeEach(async () => {
        const user = await makeUser({ sequence: 1 });
        owner.uid = user.id;

        // The diary meal is obtained the way a client obtains it: the day read
        // materialises the four buckets, so the id posted to below is a real
        // one rather than a row this file inserted.
        const day = await asUser(request.get(`/api/macros/${DAY_KEY}`), owner).expect(200);
        const breakfast = (day.body.meals as { id: string; name: string }[]).find(
            (meal) => meal.name === 'Breakfast',
        );

        if (breakfast === undefined) {
            throw new Error('the day read did not return a Breakfast bucket');
        }

        breakfastId = breakfast.id;
    });

    describe('what the entry carries', () => {
        it('logs a published catalog food from that food´s own record', async () => {
            const food = await makeCatalogFood({ sequence: 2 });

            const response = await postEntry({ catalogFoodId: food.id, servings: 1, inputMethod: 'search' });

            expect(response.status).toBe(201);
            expect(response.body).toStrictEqual({
                id: expect.any(String),
                // No personal food is referenced, because none is created.
                foodId: null,
                // PRESENT and null, never absent: the client's codec decodes
                // this as `string | null`, so a missing key is a different
                // failure from a null one.
                mealPlanMealId: null,
                name: food.display_name,
                servingText: '1 cup',
                servings: 1,
                ...FIXTURE_PER_SERVING,
                inputMethod: 'search',
                nutritionProvenance: 'source_backed',
                loggedAt: expect.any(String),
            });
            expect(Object.keys(entryOf(response) as object)).toContain('mealPlanMealId');
        });

        it('stamps the input method server-side whatever the body claims', async () => {
            const food = await makeCatalogFood({ sequence: 2 });

            const response = await postEntry({
                catalogFoodId: food.id,
                servings: 1,
                inputMethod: 'ai_text',
            });

            expect(response.status).toBe(201);
            // A catalog log is a search log by construction; the body does not
            // get to relabel it, least of all as an AI estimate.
            expect(entryOf(response).inputMethod).toBe('search');
            expect((await storedEntries())[0].input_method).toBe('search');
        });

        it('derives the snapshot from the default portion, and the day´s totals from the servings eaten', async () => {
            const food = await makeCatalogFood({
                sequence: 2,
                defaultPortion: { description: '1 slice', amount: 1, unit: 'slice', gram_weight: 150 },
            });

            const response = await postEntry({ catalogFoodId: food.id, servings: 2, inputMethod: 'search' });
            const day = await asUser(request.get(`/api/macros/${DAY_KEY}`), owner).expect(200);
            const breakfast = (day.body.meals as { name: string; totals: unknown }[]).find(
                (meal) => meal.name === 'Breakfast',
            );

            // Stored per serving, at the portion's own scale: 150 g of a
            // per-100 g record is 1.5x the stored values.
            expect(response.body).toMatchObject({
                servingText: '1 slice',
                servings: 2,
                calories: 225,
                protein: 23,
                carbs: 30,
                fat: 3,
            });
            // And multiplied by the servings eaten exactly once, when the day
            // is totalled — which is what keeps the pre-log card and the diary
            // row equal to the integer.
            expect(breakfast?.totals).toEqual({ calories: 450, protein: 46, carbs: 60, fat: 6 });
        });

        it('scales the snapshot to a serving the food stores', async () => {
            const food = await makeCatalogFood({ sequence: 2 });
            await addPortion(food.id, { description: '1 slice', amount: 1, unit: 'slice', gram_weight: 50 });

            const response = await postEntry({
                catalogFoodId: food.id,
                servings: 1,
                servingText: '1 slice',
                inputMethod: 'search',
            });

            expect(response.status).toBe(201);
            expect(response.body).toMatchObject({
                servingText: '1 slice',
                calories: 75,
                protein: 8,
                carbs: 10,
                fat: 1,
            });
        });

        it('names the default portion when the body names no serving', async () => {
            const food = await makeCatalogFood({ sequence: 2 });
            await addPortion(food.id, { description: '1 slice', amount: 1, unit: 'slice', gram_weight: 50 });

            const response = await postEntry({ catalogFoodId: food.id, servings: 1, inputMethod: 'search' });

            expect(response.status).toBe(201);
            expect(response.body).toMatchObject({ servingText: '1 cup', ...FIXTURE_PER_SERVING });
        });

        it('creates no personal food row for a food the catalog already holds', async () => {
            const food = await makeCatalogFood({ sequence: 2 });

            await postEntry({ catalogFoodId: food.id, servings: 1, inputMethod: 'search' }).expect(201);

            // `logCatalogMealEntry` never touches `foods`: the catalog is
            // shared reference data, not a copy in each user's library.
            expect(await prisma.foods.count()).toBe(0);
            expect((await storedEntries())[0]).toMatchObject({ food_id: null, catalog_food_id: food.id });
        });

        it('writes the entry to the caller from the token, ignoring a userId in the body', async () => {
            const food = await makeCatalogFood({ sequence: 2 });
            const stranger = await makeUser({ sequence: 3 });

            await postEntry({
                catalogFoodId: food.id,
                servings: 1,
                inputMethod: 'search',
                userId: stranger.id,
            }).expect(201);

            // The caller is resolved from the verified token and from nothing
            // else, so an identity in the body is inert.
            expect((await storedEntries()).map((entry) => entry.user_id)).toEqual([owner.uid]);
        });
    });

    describe('a repeated log', () => {
        it('writes a second entry rather than folding the repeat into the first', async () => {
            const food = await makeCatalogFood({ sequence: 2 });
            const body = { catalogFoodId: food.id, servings: 1, inputMethod: 'search' };

            await postEntry(body).expect(201);
            await postEntry(body).expect(201);

            // The shipped legacy writer bumps `servings` when the body's
            // `foodId` matches an existing entry. A catalog body carries no
            // `foodId`, so that branch must not be entered: two logs of the same
            // food are two things eaten, and the diary says so.
            const entries = await storedEntries();
            expect(entries).toHaveLength(2);
            expect(entries.map((entry) => entry.servings)).toEqual([1, 1]);
        });
    });

    describe('a body this route cannot serve', () => {
        it('refuses a serving the food does not store, rather than relabelling the default', async () => {
            const food = await makeCatalogFood({ sequence: 2 });

            const response = await postEntry({
                catalogFoodId: food.id,
                servings: 1,
                servingText: '1 handful',
                inputMethod: 'search',
            });

            expectRefusal({ status: response.status, body: response.body }, 400, { error: 'invalid_serving' });
            expect(await storedEntries()).toEqual([]);
        });

        it.each([
            ['an id that names no food', ABSENT_UUID],
            ['an id that names a food this release has not published', 'candidate'],
        ])('answers 404 for %s', async (_case, idOrStatus) => {
            const catalogFoodId =
                idOrStatus === 'candidate'
                    ? (await makeCatalogFood({ sequence: 2, publication_status: 'candidate' })).id
                    : idOrStatus;

            const response = await postEntry({ catalogFoodId, servings: 1, inputMethod: 'search' });

            // Identical answers, deliberately: an unpublished food is simply
            // absent to a caller, so no request can confirm one exists before
            // it is publishable.
            expectRefusal({ status: response.status, body: response.body }, 404, {
                error: 'catalog_food_not_found',
            });
            expect(await storedEntries()).toEqual([]);
        });

        it('refuses a body that names both a personal food and a catalog food', async () => {
            const food = await makeCatalogFood({ sequence: 2 });

            const response = await postEntry({
                foodId: ABSENT_UUID,
                catalogFoodId: food.id,
                servings: 1,
                inputMethod: 'search',
            });

            // Neither writer can be chosen, and guessing would pick which food
            // the user meant to eat.
            expectRefusal({ status: response.status, body: response.body }, 400, {
                error: 'invalid_payload',
                details: [
                    { field: 'foodId', code: 'conflicting_food_reference' },
                    { field: 'catalogFoodId', code: 'conflicting_food_reference' },
                ],
            });
            expect(await storedEntries()).toEqual([]);
        });

        it('refuses a body that matches neither shape', async () => {
            const response = await postEntry({ servings: 1 });

            expectRefusal({ status: response.status, body: response.body }, 400, {
                error: 'invalid_payload',
                details: [{ field: 'body', code: 'unrecognized_payload' }],
            });
        });

        it.each([
            ['below the minimum', 0.24],
            ['above the maximum', 10.01],
            ['at zero', 0],
            ['carrying a third decimal', 1.005],
        ])('refuses servings %s', async (_case, servings) => {
            const food = await makeCatalogFood({ sequence: 2 });

            const response = await postEntry({ catalogFoodId: food.id, servings, inputMethod: 'search' });

            expectRefusal({ status: response.status, body: response.body }, 400, {
                error: 'invalid_request',
                details: [{ field: 'servings', code: 'invalid_servings' }],
            });
            expect(await storedEntries()).toEqual([]);
        });

        it.each([
            ['the smallest portion the steppers offer', 0.25],
            ['the largest the contract allows', 10],
            // The value the mobile fraction chip stores for a third, which the
            // two-decimal rule must keep accepting.
            ['a third, as the fraction chips store it', 0.33],
        ])('accepts servings of %s', async (_case, servings) => {
            const food = await makeCatalogFood({ sequence: 2 });

            const response = await postEntry({ catalogFoodId: food.id, servings, inputMethod: 'search' });

            expect(response.status).toBe(201);
            expect(entryOf(response).servings).toBe(servings);
        });
    });

    describe('the shipped legacy body, through the same route', () => {
        it('still logs a client-supplied snapshot unchanged', async () => {
            const response = await postEntry(legacyBody());

            // One case, to prove the branch parser did not move the existing
            // path; the deeper pinning of this shape belongs to
            // `compat.test.ts`.
            expect(response.status).toBe(201);
            expect(response.body).toMatchObject({
                name: 'Scrambled eggs',
                calories: 220,
                inputMethod: 'library',
                nutritionProvenance: 'user_entered',
                mealPlanMealId: null,
            });
        });

        it('still answers a malformed legacy body with the message shipped clients read', async () => {
            const response = await postEntry({ name: 'Scrambled eggs' });

            expectRefusal({ status: response.status, body: response.body }, 400, {
                error: 'name, calories, protein, carbs, and fat are required',
            });
        });
    });
});


// The read boundary every food above passed through, asserted directly for the
// one input the database cannot be made to produce.
//
// `catalog_foods.allergen_tags` is `TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]`
// (`prisma/migrations/20260908000000_meal_planning/migration.sql`), so no
// statement against the migrated test database can store an absent value —
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
// Placed in this suite because it is the catalog read boundary's own file and
// the assertion is about the boundary itself; it needs no database, which is
// why it stayed here when the collation proofs moved to their own suite. The
// mapper's other faults — basis amount, core macros, default portion,
// nutrition basis — are covered by the `mapCatalogFood` describes in
// `catalog.logic.test.ts`, which is where a further one belongs; this column is
// the one they leave uncovered, and `allergenTags` is the member a wrong answer
// would mislead a user about.
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
