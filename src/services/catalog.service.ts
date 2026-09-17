// The read side of the internal food catalog: the three `GET /api/catalog/*`
// use cases — full-text search over published foods, the dislike-suggestion
// chips, and the operator status report.
//
// Orchestration only (Rule backend-architecture §5). Every decision this file
// needs already belongs to a neighbour and is delegated to it:
//
//  * `catalog.logic.ts` owns the rules. `parseCatalogSearchRequest` validates
//    `?q=` together with the page block and is called by the CONTROLLER, not
//    here — a 2-to-60-character bound and a `limit` band are request-validation
//    verdicts (§4), and a service that re-decided them would own the rules
//    twice. `q` arrives already trimmed and bounded, and `page`/`limit` arrive
//    as whole numbers inside the route's band or not at all, because a request
//    outside it was refused with `400 invalid_request` before this file was
//    reached.
//  * `catalog.mapper.ts` owns the row -> DTO boundary, including the closed-set
//    narrowing of every TEXT code column. No response shape is assembled here.
//  * `utils/pagination.ts` owns the offset scheme end to end: the
//    `{page, limit, total, totalPages}` envelope and the strictly parsed
//    per-route `page`/`limit` band at the request boundary
//    (`parsePaginationStrict`, which refuses an out-of-range value rather than
//    clamping it), and `rowWindowFor` — the bounded `LIMIT` and `OFFSET` a
//    paged statement runs with — here, so request input is turned into query
//    arithmetic in one audited place rather than per service. This file returns
//    `{items, total}` and never the envelope (§4).
//
// A SANCTIONED EXCEPTION TO §5.1. Rule backend-architecture §5.1 requires
// `user_id` in every `where`; the reads below carry no tenant predicate,
// deliberately, because `catalog_foods` and its child tables hold no `user_id`
// at all. The catalog is shared reference data — the same rows for every user,
// loaded from a reviewed release — so there is no owner to scope to and no
// cross-user row to leak. A synthetic user scope here would be fiction, not
// safety. A per-user catalog concept (a personal food) already has its own
// owned table, `foods`, and every meal-planning query that touches a
// user-owned table does carry the owner key — but that is a statement about
// meal planning and nothing wider. This file makes no claim about
// `src/services` as a whole, because two queries there would contradict it; see
// the accounting immediately below.
//
// Within meal planning these catalog reads, and the recipe reads that belong to
// `recipe.service.ts`, are the only authenticated reads without a tenant
// predicate. They are NOT the only untenanted queries in the backend, and the
// difference matters to anyone auditing §5.1. Two pre-existing ones are
// legitimate and are recorded here so this comment cannot be read as erasing
// them:
//
//  * `usda.service.ts` reads `usda_api_cache` by `cache_key` alone while
//    serving the authenticated `GET /api/macros/search-branded-foods` and
//    `GET /api/macros/branded-food/:foodId`, because a cached vendor response
//    has no owner either. Same shape of exception as this file's, same
//    justification.
//  * `food.service.ts::updateFood` resolves the row with an owner-scoped
//    `findFirst` and then issues its `update` by `id` alone. The authorization
//    is real — a foreign id never reaches the update — but the WRITE predicate
//    itself carries no `user_id`, so it is not an example of the rule being
//    met, and citing it as one would be wrong. It is shipped behaviour this
//    feature does not touch.
//
// Any further untenanted query is a new exception and needs its own
// justification.
//
// The same exception is why no function below takes `userId` first, as §5's
// signature convention otherwise requires: that parameter exists to scope the
// query, and a parameter accepted only to be ignored would misrepresent these
// reads as owned. The routes are still authenticated — they mount after
// `authenticateFirebaseToken` — so the caller is known; the DATA simply is not
// theirs to begin with.
//
// WHAT THIS FILE DOES NOT DO, each for a stated reason:
//
//  * NO WRITES. The catalog is populated exclusively by the offline scripts
//    (`catalog-import-usda`, `catalog-generate-ai`, `catalog-validate`,
//    `catalog-load`). The request path is read-only, which is what makes
//    "search never mutates the catalog" a property of the architecture rather
//    than a convention.
//  * NO VENDOR CALL. Neither `usda.service.ts` nor `openrouter.service.ts` is
//    imported, so after seeding catalog search cannot make a live USDA or model
//    call — an explicit product guarantee, and the import list below is the
//    structural half of the proof. The behavioural half is
//    `src/__tests__/api/offline.test.ts`, which exercises search and
//    suggestions with `USDA_API_KEY` and `OPENROUTER_API_KEY` unset and the
//    network mocked to throw (AAP §0.9.2).
//  * NO RECIPE READS. The only recipe column touched here is a `COUNT` for the
//    operator status report. Recipe reads belong to
//    `recipe.service.ts::getRecipeVersionForUser` as their single owner, and
//    `GET /api/recipes/:recipeVersionId` reaches it through
//    `catalog.controller.ts`, so the chain is
//    `catalog.routes → catalog.controller → recipe.service`. No recipe query is
//    ever added or re-exported here.
//  * NO FEATURE FLAG. `/catalog/*` is never gated — Add Food's catalog section
//    does not depend on meal planning — while `/recipes/*` is, through
//    `utils/featureFlags.ts`, and that check belongs to `catalog.controller.ts`
//    rather than to this file. The three functions below are reached only from
//    that controller and from `scripts/search-benchmark.ts`.
//  * NO TYPED ERROR OF ITS OWN. None of the three use cases has a failure the
//    client must distinguish: an unmatched search is an empty page, an empty
//    suggestion set is an empty list, and a catalog with no release loaded
//    reports nulls. The one fault that can occur is a stored row contradicting
//    the response contract, which is `catalog.mapper.ts`'s `CatalogMappingError`
//    and belongs to that boundary.
//
// THIS SERVICE IS THE MEASURED UNIT OF THE SEARCH BENCHMARK.
// `data/meal-planning/search-benchmark.v1.json` names
// `catalog.service.searchPublishedFoods` as its `measuredUnit` and declares the
// protocol around it: one untimed warm-up pass, three timed passes, sequential,
// a single connection, timed in process so no HTTP round trip is included (AAP
// §0.9.3). `scripts/search-benchmark.ts` is the runner that contract belongs to,
// and it now carries that measurement body: it imports `searchPublishedFoods`,
// times it in process under that protocol, scores the rank of every committed
// query and writes `data/meal-planning/reports/latest/benchmark-report.json`.
// The p50/p95 figures for this service are therefore whatever that report
// records for the release and conditions it names — and nothing here may be
// read as a measured figure on its own.
//
// The constraint that contract places on this file is what makes the
// measurement mean anything: nothing here may add per-call work that is not
// part of answering the query — no warm-up, no memoisation, no cache, and no
// logging in the hot path. The one exception is deliberate and is the
// protocol's own: each
// use case opens a single transaction so its statements read one snapshot on one
// connection, which is both a correctness requirement (below) and the
// `sequential`/`connections: 1` execution the benchmark declares it measures.

import { Prisma } from '../generated/prisma';
import { prisma } from '../prisma/client';
import {
    CatalogFoodResponse,
    CatalogPublicationStatus,
    CatalogStatusResponse,
    CatalogSuggestionsResponse,
} from '../types/catalog';
import { rowWindowFor } from '../utils/pagination';
import {
    SEARCH_ASCII_LOWERCASE,
    SEARCH_ASCII_UPPERCASE,
    SEARCH_HEAD_CONNECTORS,
    SEARCH_RELEVANCE,
    searchQueryHeadNoun,
} from './catalog.logic';
import {
    CatalogFoodPortionRow,
    CatalogFoodRow,
    CatalogReleaseRunRow,
    CatalogStatusCounts,
    CatalogSuggestionRow,
    mapCatalogFood,
    mapCatalogStatus,
    mapCatalogSuggestion,
} from './catalog.mapper';

/* ---------------------------------------------------------------------------
 * How a use case reads
 * ------------------------------------------------------------------------- */

/**
 * The client the statements of one use case run on.
 *
 * Always a transaction client, never the pool: the reads that make up a single
 * response have to agree with each other, and Prisma hands each independent
 * statement whatever connection is free, each with its own snapshot. A catalog
 * load publishing and retiring rows between two of them is not hypothetical —
 * `catalog-load.ts` is an ordinary operator command that can run while the API
 * serves traffic — and the result would be a page of twenty-five rows beside a
 * total taken from a different catalog: a `totalPages` that lies, a client that
 * pages into a gap, and an operator status report whose published count and
 * release pointer describe different moments.
 *
 * `Prisma.TransactionClient` is the pool client minus the methods a transaction
 * cannot offer (`$transaction`, `$connect`, `$disconnect`, …); `$queryRaw` and
 * the model delegates are all retained, so every read below is written exactly
 * as it would be against the pool.
 */
type SnapshotClient = Prisma.TransactionClient;

/**
 * How each use case opens that snapshot.
 *
 * REPEATABLE READ rather than the default READ COMMITTED because that is the
 * whole point: under READ COMMITTED every statement takes a fresh snapshot even
 * inside one transaction, so grouping them would buy the single connection and
 * none of the coherence. Under REPEATABLE READ the first statement fixes the
 * snapshot and the rest read it.
 *
 * These transactions are read-only and short — three indexed statements for a
 * search, five for the status report — so they take no locks a writer can queue
 * behind, and Prisma's default `timeout` applies unchanged. Statements inside
 * one are awaited SEQUENTIALLY: an interactive transaction is one connection, so
 * issuing them together would not parallelise anything, and it is also the
 * execution the benchmark protocol declares (`sequential: true`,
 * `connections: 1`).
 */
const SNAPSHOT_OPTIONS = {
    isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
} as const;

/* ---------------------------------------------------------------------------
 * What the catalog considers visible
 * ------------------------------------------------------------------------- */

/**
 * The only status a read below will surface. `candidate`, `quarantined` and
 * `rejected` have never been published; `retired` was published once and a
 * newer release no longer contains it.
 *
 * `retired` IS NOT `deleted`, and the distinction is why this single predicate
 * is correct rather than merely convenient: a retired row keeps its primary key
 * so the `recipe_ingredients` and `meal_entries` foreign keys that reference it
 * still resolve and a historical recipe or diary entry stays readable, while the
 * food stops being findable in search, in the suggestion chips and in new
 * recipe eligibility. Filtering on `published` gets both halves right at once.
 */
const PUBLISHED: CatalogPublicationStatus = 'published';

/**
 * The text-search configuration, which MUST equal the one the generated column
 * uses: `prisma/migrations/20260908000000_meal_planning/migration.sql` defines
 * `search_vector` as
 * `to_tsvector('english', coalesce(search_text, '')) STORED`. A query built with
 * a different configuration would stem differently from the stored vector and
 * silently under-match, so it is written once and reused for the alias vectors
 * and the query itself.
 */
const TEXT_SEARCH_CONFIG = 'english';

/**
 * The band a prefix-only match scores in, and how it is spread inside it.
 *
 * THE BAND. `ts_rank` is strictly positive for a real full-text hit, so
 * `SEARCH_RELEVANCE.prefixCeiling` — zero — places every prefix match below
 * every stemmed match, which is the ordering a user expects when they have
 * typed a partial word. That boundary is unchanged from the constant this
 * replaces.
 *
 * THE SPREAD, which the boundary alone did not give. Every prefix match used to
 * take the ceiling exactly, so a match set reached only by prefix had one rank
 * for all of it and fell back to alphabetical order: typing "mush" put
 * "Mushroom soup, canned, condensed" above "Mushrooms, white" because M-u-s-h-r
 * -o-o-m-space sorts before M-u-s-h-r-o-o-m-s. Scores are therefore spread over
 * `(prefixCeiling − 1, prefixCeiling]` by COVERAGE — how much of the matched
 * text the typed prefix accounts for — so the food the prefix nearly names
 * comes first. Coverage is clamped to 1 because the branch also fires on
 * `canonical_name`, which can be shorter than `display_name`; without the clamp
 * such a row could score above the ceiling and break the band.
 *
 * Measured on the committed 426-query set: this alone lifts the `partial` kind
 * (a query that is a prefix of the intended name) from 0.575 to 0.950 top-3.
 */
const prefixCoverageScore = (queryLength: number, matchedText: Prisma.Sql): Prisma.Sql => Prisma.sql`
    (${SEARCH_RELEVANCE.prefixCeiling}::real
        - (1::real - LEAST(${queryLength}::real / GREATEST(char_length(${matchedText}), 1)::real, 1::real)))`;

/**
 * `LIKE` metacharacters, escaped before a caller's text becomes a pattern.
 *
 * Not cosmetic: a `q` of `%` builds the pattern `%%`, which matches every
 * published row and turns a search into a full-catalog scan. Backslash is
 * `LIKE`'s default escape character and the pattern is a bound parameter, so
 * escaping the three characters here is the whole fix. This is SQL-pattern
 * mechanics that cannot be separated from the statement below, not a business
 * rule that belongs in `catalog.logic.ts`.
 */
const LIKE_METACHARACTERS = /[\\%_]/g;

/* ---------------------------------------------------------------------------
 * The text a relevance score is computed from
 * ------------------------------------------------------------------------- */

/**
 * The two columns a match can be scored against, as fragments rather than
 * strings, so a column name appears once in this file and a branch cannot
 * accidentally score one column while filtering on another.
 */
const DISPLAY_NAME = Prisma.sql`f.display_name`;
const ALIAS = Prisma.sql`a.alias`;

/**
 * The food's name as a tsvector, which is what {@link SEARCH_RELEVANCE} scores
 * the name match on.
 *
 * Built per row because no column stores it: `catalog_foods.search_vector` is
 * generated from `search_text`, which bundles the name with the aliases, the
 * food state and the food group. Those extra words are exactly what must NOT
 * dilute the name's own specificity, so the name is tokenised separately. The
 * configuration is {@link TEXT_SEARCH_CONFIG} for the same reason the stored
 * column uses it: two configurations stem differently and would under-match.
 */
const nameVector = Prisma.sql`to_tsvector(${TEXT_SEARCH_CONFIG}::regconfig, f.display_name)`;

/**
 * How many words a name carries — the specificity divisor: the measure of how
 * much of a food's name is NOT the query.
 *
 * Counted by splitting on spaces rather than by counting the tsvector's
 * lexemes, for two reasons that happen to agree. It is cheaper — no tsvector is
 * built, so the alias branch does not tokenise each matched food's name a
 * second time, which measured on the widest query of the committed set
 * ("chicken", 674 matching foods and 849 matching aliases) is the difference
 * between roughly +35 ms and +10 ms of statement time. And it is a better
 * measure of verbosity: the lexeme count DROPS stopwords, so "Rice with
 * raisins" counted two words against "Brown rice, dry"'s three and a dish
 * outranked the ingredient. Measured over the committed 426-query set, the word
 * count also scores marginally better — top-3 0.948 against 0.944, with the
 * `exact` kind at 0.915 against 0.902.
 *
 * `GREATEST(…, 1)` is not defensive padding: `array_length` returns NULL for an
 * empty array, and dividing by NULL would make that row's rank NULL and sort it
 * unpredictably under `ORDER BY rank DESC`. Clamping to one word scores such a
 * row as a single-word name, which is the closest true statement available.
 */
const wordCountOf = (text: Prisma.Sql): Prisma.Sql =>
    Prisma.sql`GREATEST(array_length(string_to_array(btrim(${text}), ' '), 1), 1)::real`;

/**
 * The head segment of a name: everything before its first comma.
 *
 * Both USDA and this catalog name a food as head-then-qualifiers — "Beef,
 * ground", "Rice, brown and wild, cooked, NS as to fat" — so the text before
 * the first comma is what the food IS and the rest describes it. A name with no
 * comma is its own head segment, which `split_part` already returns.
 */
const headSegmentOf = (text: Prisma.Sql): Prisma.Sql => Prisma.sql`split_part(${text}, ',', 1)`;

/**
 * Case-fold A-Z and nothing else, in SQL.
 *
 * The SQL half of `catalog.logic.ts`'s `foldSearchAscii`, built from the same
 * two exported constants so the JavaScript and SQL folds cannot drift apart.
 * That file explains why the fold has to be ASCII-only; the short version is
 * that `lower()` resolves through the database's collation while
 * `String.prototype.toLowerCase` does not, so using either one on its own side
 * of the head-noun comparison made the tier depend on the server's locale and
 * broke the cross-database rank reproducibility §0.9.3 requires.
 *
 * `translate()` is a character-for-character map with no locale input at all,
 * and the two argument strings are the same 26 letters the JavaScript side
 * folds. Non-ASCII characters pass through untouched on both sides and are
 * normalised by `to_tsvector`/`plainto_tsquery`, which apply one text-search
 * configuration to both halves of the comparison.
 */
const asciiFoldOf = (text: Prisma.Sql): Prisma.Sql =>
    Prisma.sql`translate(${text}, ${SEARCH_ASCII_UPPERCASE}, ${SEARCH_ASCII_LOWERCASE})`;

/**
 * The head phrase of a head segment: everything before its first connector.
 *
 * `SEARCH_HEAD_CONNECTORS` in `catalog.logic.ts` explains which words end a
 * head phrase and why, and the same list is folded here so a food's name and a
 * search term have their heads taken by one rule. The ASCII fold is applied
 * first so a connector written "With" is still recognised; the result is only
 * ever fed to `to_tsvector`, which normalises case anyway, so nothing
 * downstream depends on the case of what comes back.
 */
const headPhraseOf = (text: Prisma.Sql): Prisma.Sql =>
    SEARCH_HEAD_CONNECTORS.reduce(
        (phrase, connector) => Prisma.sql`split_part(${phrase}, ${` ${connector} `}, 1)`,
        asciiFoldOf(text),
    );

/**
 * The head noun of a phrase: the last whitespace-separated token of its head
 * phrase.
 *
 * English puts the head of a nominal compound last — "brown RICE" is a rice,
 * "rice BREAD" is a bread — which is the signal that separates the food a query
 * names from the food it merely modifies.
 *
 * Deliberately built from `translate`/`split_part`/`reverse`/`btrim` rather
 * than a regular expression, and deliberately NOT from `lower()`. §0.9.3
 * requires two independently loaded databases to produce identical ranks, so
 * every operation on the path to a rank has to be locale-free:
 *
 *  * POSIX character classes such as `[[:alnum:]]` resolve through the
 *    database's ctype, so a regex-based extraction could tokenise an accented
 *    name differently on two servers.
 *  * `lower()` resolves through the collation. It was used here, and it was a
 *    defect: the query's head noun is extracted in JavaScript, where
 *    `'İNCİR'.toLowerCase()` is `i` + U+0307, while `lower('İNCİR')` is
 *    `incir` under `en_US.utf8` and different again under ICU. The two sides of
 *    the comparison then disagreed, so which tier a food scored in depended on
 *    the server. `asciiFoldOf` replaces it.
 *
 * What remains — `translate` over a fixed 26-letter map, `split_part`,
 * `reverse`, `btrim` — are character-level operations with no locale input at
 * all, so the extracted head noun is a property of the release rather than of
 * the server. Any punctuation left on the token, and every non-ASCII character,
 * is normalised by `to_tsvector` at the point of comparison, which applies one
 * text-search configuration to both halves of it.
 *
 * `api/catalogCollation.test.ts` pins this against a real ICU database: the
 * extraction must return the same value under the database default as under
 * `COLLATE "C"`, and that value must equal what the JavaScript side computes.
 */
const headNounOf = (text: Prisma.Sql): Prisma.Sql =>
    Prisma.sql`reverse(split_part(reverse(btrim(${headPhraseOf(text)})), ' ', 1))`;

/* ---------------------------------------------------------------------------
 * Search
 * ------------------------------------------------------------------------- */

/**
 * What one page of search results is, before it becomes a wire shape.
 *
 * `total` is the size of the whole match set, not of `items`, and the controller
 * turns it into the `pagination` block with `toPaginationBlock` — the same split
 * `food.service.ts` and `food.controller.ts` already use for `GET /api/foods`.
 */
export interface CatalogSearchResult {
    items: CatalogFoodResponse[];
    total: number;
}

/**
 * The match set: every published food that matches `q`, with each food's own
 * best contribution, before ranking or paging.
 *
 * Built once and shared by both statements of a search, which is the point of
 * extracting it. The page and the count must describe the SAME set — a count
 * computed from a differently-worded predicate is a `totalPages` that lies and a
 * client that pages into an empty result — and the only way to guarantee that is
 * one definition with two tails. It is a parameterised `Prisma.Sql` fragment, so
 * composition keeps `q` a bound parameter and never becomes string building.
 *
 * WHAT A CONTRIBUTION'S `rank` IS, AND WHY IT IS NOT `ts_rank` ALONE.
 * `ts_rank`'s default normalisation scores by term frequency and ignores
 * document length, and a catalog food mentions any one word about once — so an
 * unaided `ts_rank` returns THE SAME VALUE for an entire match set. Measured
 * against the v1 release, `q = 'salt'` matches 595 published foods and the
 * number of distinct `ts_rank` values over them is exactly one; the order then
 * came entirely from the `display_name` tiebreaker, i.e. alphabetically, which
 * is why "Salt" itself came 463rd. Each branch below therefore scores its
 * contribution with the weights in `catalog.logic.ts`'s {@link
 * SEARCH_RELEVANCE} — field, specificity and head noun, documented in full
 * there — and `ORDER BY rank DESC, display_name, source_key` is unchanged: the
 * keys are the same three in the same precedence, and only the value of the
 * first one now discriminates. Every input to a score is release data
 * (`display_name`, an alias, `search_text`), never a database-generated id, so
 * two independently loaded databases still rank identically, as §0.9.3
 * requires.
 *
 * FOUR CONTRIBUTIONS, EACH FOR A REASON THE OTHERS CANNOT COVER:
 *
 *  1. The food's own `search_vector` — the STORED generated column, read
 *     through the GIN index. This is the ordinary relevance path, and it is what
 *     makes plurals work: `plainto_tsquery` stems "mushrooms" to `mushroom` and
 *     matches a vector built from "Mushrooms, white". Its score reads the
 *     `display_name` separately from that bundle, because the bundle is what
 *     made relevance unrankable: `search_text` concatenates the name with every
 *     alias, the food state and the food group, so a well-curated generic food
 *     carries more words in it than a verbose USDA survey name does. The name
 *     alone answers "is this food CALLED what was typed", and the bundle is
 *     kept as the weaker {@link SEARCH_RELEVANCE.textOnly} path so a food
 *     matched only by a state or group word is still found and still ranked
 *     last among real matches.
 *  2. Every alias, scored on the fly. Aliases carry no tsvector column of their
 *     own, so their vector is computed per row; a LATERAL binds it once so the
 *     `@@` test and the `ts_rank` do not each recompute it. This branch is
 *     load-bearing rather than redundant: it is what lets a food be found by a
 *     word that appears in none of its own columns — "eggplant" reaching
 *     "Aubergine" — and nothing guarantees a food's `search_text` repeats its
 *     aliases. An alias is an ALTERNATIVE NAME, so a hit here weighs as much as
 *     a name hit, and its divisor is the LEAST SPECIFIC of the two names the
 *     match went through — `GREATEST(alias words, name words)`. Both halves
 *     of that were measured against v1 and each fixes the other's failure.
 *     Dividing by the alias alone let the one-word alias "chickens" on
 *     "Chicken, NS as to part and cooking method, NS as to skin eaten" score
 *     0.06079 and outrank "Chicken breast" on its own name at 0.03040, so for
 *     every category word the survey placeholder rows took page one. Dividing
 *     by the food's name alone put "Egg" first for "chicken", because its alias
 *     "chicken egg" mentions the word while its own one-word name makes it look
 *     maximally specific. Bounding by both says the honest thing: an alias
 *     cannot make a food look more precisely named than it is, and a vague food
 *     does not become precise by carrying a short alias.
 *  3. and 4. A prefix fallback over the food's names and over its aliases. A
 *     stemmed query has no prefix semantics at all, so a two-character `q` such
 *     as "mu" matches NOTHING through 1 or 2 while a user is still typing. The
 *     comparison is written `lower(col) LIKE pattern` rather than `col ILIKE`
 *     because `ILIKE` has no index support at all without `pg_trgm`, and
 *     left-anchored because a prefix is the only LIKE shape a btree can answer
 *     with a range scan; an interior whole word is already covered by 1 and 2,
 *     which tokenise every word of the text.
 *
 *     KNOWN, BOUNDED DIVERGENCE IN THESE TWO BRANCHES, stated rather than
 *     hidden. Their pattern is folded in JavaScript (`q.toLowerCase()`) and
 *     their columns in SQL (`lower(col)`), and those two folds are not the same
 *     function outside A-Z: `'İNCİR'.toLowerCase()` is `i` + U+0307 while
 *     `lower('İNCİR')` is `incir` under en_US and `İncİr` under C. The head-noun
 *     path had the same defect and was fixed by folding both sides through
 *     {@link asciiFoldOf} / `foldSearchAscii` over one shared alphabet; these
 *     two branches CANNOT take that fix here, because
 *     `idx_catalog_food_aliases_lower_alias` indexes the expression
 *     `lower(alias) text_pattern_ops`, so writing `translate(alias, …) LIKE …`
 *     instead would no longer match the indexed expression and would replace
 *     the range scan with a sequential read of every published alias — the
 *     opposite of what the index below exists for, and a change the collation
 *     suite's index-scan pin would (correctly) fail.
 *     What this costs today: nothing measurable. Across release v1 no alias and
 *     no canonical_name contains a non-ASCII character at all, and exactly 2 of
 *     11,046 display_names do — `usda:2710826` and `usda:2727573`, whose only
 *     non-ASCII byte is U+00A0 NO-BREAK SPACE, which is not an uppercase letter,
 *     so `lower()` and the ASCII fold return the same string for both rows. The
 *     branches are therefore fold-equivalent on the shipped catalog, which is
 *     why `npm run search:benchmark` reproduces rank-for-rank across two
 *     independently loaded databases.
 *     What it would cost if a future release carried a non-ASCII uppercase
 *     letter: a partial query over that text would miss these branches (and a
 *     partial query matches through NO other branch, since a stemmed query has
 *     no prefix semantics), so the food would be absent from results rather
 *     than merely mis-ranked, and which queries were affected would depend on
 *     the server's collation.
 *     THE FIX, and who owns it: add an expression index over the ASCII fold —
 *     `(translate(alias, 'ABC…', 'abc…') text_pattern_ops)` and the matching
 *     pair on `display_name`/`canonical_name` — and then fold both sides here
 *     as the head-noun path already does. The index lives in
 *     `prisma/schema.prisma`, `prisma/migrations/20260908000000_meal_planning/`
 *     and `docs/meal-planning/expected-schema-diff.sql`, which belong to the
 *     schema work unit, so the change is theirs to make and this comment is the
 *     request for it.
 *
 * WHAT AN INDEX SCAN ON THE ALIAS PREFIX ACTUALLY NEEDS — TWO CONDITIONS, BOTH
 * MEASURED, AND THE SECOND IS WHY THE PATTERN IS BOUND INTO THE BRANCHES BELOW
 * RATHER THAN PROJECTED THROUGH THE CTE.
 *
 *  * The index must carry `text_pattern_ops`. PostgreSQL derives the `>=`/`<`
 *    range bounds a LIKE prefix becomes only when the indexed comparison is
 *    byte order — a `*_pattern_ops` operator class, or a column collation of C.
 *    The databases this project creates are `en_US.utf8`, and the one this
 *    service's own suite runs against is ICU `und`, so neither gives that for
 *    free; `idx_catalog_food_aliases_lower_alias` is declared with the class in
 *    `prisma/migrations/20260908000000_meal_planning/migration.sql` for exactly
 *    this predicate. Under the default `text_ops` the planner refuses the index
 *    even with `enable_seqscan = off` — it is unusable, not merely unattractive.
 *  * The pattern must reach the planner as a CONSTANT. The bound-derivation only
 *    runs when the LIKE right-hand side is a plan-time `Const`; a value
 *    projected out of a CTE arrives as a `Var`, and PostgreSQL materialises this
 *    CTE anyway because `search` is referenced more than once. Measured with the
 *    class in place: the same statement with the pattern selected from the CTE
 *    used no index at all, while binding it into each branch — which is what the
 *    two branches below do — produced the index scan.
 *
 * Both conditions are asserted, not asserted-to:
 * `src/__tests__/api/catalogCollation.test.ts` — the suite that provisions a
 * database whose default collation makes the class load-bearing —
 * pins the operator class out of `pg_opclass`, pins the plan under
 * `enable_seqscan = off`, and reads the `pg_stat_user_indexes.idx_scan` delta
 * across a real `searchPublishedFoods` call. The cost direction they protect,
 * measured on a 10,000-alias corpus at 1% selectivity: ~2.5-3.0 ms for the
 * sequential scan against ~0.1-0.2 ms for the index scan.
 *
 * The alias branches still read the whole published alias set for the two
 * full-text contributions, because the schema declares no GIN index over aliases
 * and a trigram index would need `CREATE EXTENSION pg_trgm`, which this schema
 * deliberately does not use. That cost is stated here rather than hidden, and it
 * is what `npm run search:benchmark` measures against the p95 threshold.
 */
const catalogMatchSet = (q: string): Prisma.Sql => {
    const prefixPattern = `${q.toLowerCase().replace(LIKE_METACHARACTERS, '\\$&')}%`;
    // Code points, which is what PostgreSQL's `char_length` counts over UTF-8,
    // so the coverage ratio means the same thing on both sides. Computed here
    // rather than as `char_length($1)` only because the value is the same for
    // every row of the statement.
    const queryLength = [...q].length;

    return Prisma.sql`
        WITH search AS (
            SELECT plainto_tsquery(${TEXT_SEARCH_CONFIG}::regconfig, ${q}) AS tsq,
                plainto_tsquery(${TEXT_SEARCH_CONFIG}::regconfig, ${searchQueryHeadNoun(q)}) AS head_tsq
        ),
        contributions AS (
            SELECT f.id,
                (CASE
                    WHEN to_tsvector(${TEXT_SEARCH_CONFIG}::regconfig, name_parts.head_noun) @@ s.head_tsq
                        THEN ${SEARCH_RELEVANCE.headNoun}::real
                    WHEN to_tsvector(${TEXT_SEARCH_CONFIG}::regconfig, name_text.head_segment) @@ s.tsq
                        THEN ${SEARCH_RELEVANCE.headSegment}::real
                    ELSE ${SEARCH_RELEVANCE.outsideHead}::real
                END
                    * GREATEST(
                        ts_rank(name_text.vector, s.tsq),
                        ${SEARCH_RELEVANCE.textOnly}::real * ts_rank(f.search_vector, s.tsq)
                    )
                    / name_parts.words) AS rank
            FROM catalog_foods f
            CROSS JOIN search s
            CROSS JOIN LATERAL (
                SELECT ${nameVector} AS vector, ${headSegmentOf(DISPLAY_NAME)} AS head_segment
            ) name_text
            CROSS JOIN LATERAL (
                SELECT ${wordCountOf(DISPLAY_NAME)} AS words,
                    ${headNounOf(Prisma.sql`name_text.head_segment`)} AS head_noun
            ) name_parts
            WHERE f.publication_status = ${PUBLISHED}
                AND f.search_vector @@ s.tsq

            UNION ALL

            SELECT f.id, ${prefixCoverageScore(queryLength, DISPLAY_NAME)} AS rank
            FROM catalog_foods f
            WHERE f.publication_status = ${PUBLISHED}
                AND (lower(f.display_name) LIKE ${prefixPattern} OR lower(f.canonical_name) LIKE ${prefixPattern})

            UNION ALL

            SELECT a.catalog_food_id AS id,
                (CASE
                    WHEN to_tsvector(${TEXT_SEARCH_CONFIG}::regconfig, ${headNounOf(ALIAS)}) @@ s.head_tsq
                        THEN ${SEARCH_RELEVANCE.aliasHeadNoun}::real
                    ELSE ${SEARCH_RELEVANCE.aliasOther}::real
                END
                    * ts_rank(alias_vector.value, s.tsq)
                    / name_parts.words) AS rank
            FROM catalog_food_aliases a
            JOIN catalog_foods f ON f.id = a.catalog_food_id
            CROSS JOIN search s
            CROSS JOIN LATERAL (
                SELECT to_tsvector(${TEXT_SEARCH_CONFIG}::regconfig, a.alias) AS value
            ) alias_vector
            CROSS JOIN LATERAL (
                SELECT GREATEST(${wordCountOf(ALIAS)}, ${wordCountOf(DISPLAY_NAME)}) AS words
            ) name_parts
            WHERE f.publication_status = ${PUBLISHED}
                AND alias_vector.value @@ s.tsq

            UNION ALL

            SELECT a.catalog_food_id AS id, ${prefixCoverageScore(queryLength, ALIAS)} AS rank
            FROM catalog_food_aliases a
            JOIN catalog_foods f ON f.id = a.catalog_food_id
            WHERE f.publication_status = ${PUBLISHED}
                AND lower(a.alias) LIKE ${prefixPattern}
        )
    `;
};

/**
 * One ranked page of matching foods.
 *
 * ONE ROW PER FOOD, WHATEVER MATCHED. `contributions` yields one row per
 * matching name and per matching alias, so a food with four matching aliases
 * appears five times; `MAX(rank) ... GROUP BY id` collapses that to a single row
 * and, in the same step, decides the food's rank by its BEST contribution — so
 * the closest-matching alias is what ranks the food. Without the aggregation
 * "Mushrooms, white" would occupy four of the twenty-five slots on page one and
 * the total would count it four times.
 *
 * THE ORDER IS TOTAL AND PORTABLE: `rank DESC, display_name ASC, source_key
 * ASC`, with both text keys sorted under an explicit collation. Two independent
 * things make it portable, and the order needs both:
 *
 *  1. `source_key` as the final key. Primary keys are `gen_random_uuid()` and
 *     therefore differ between two independently loaded databases, so an order
 *     that fell back to `id` would produce different page sequences on two
 *     machines holding the same release, and a row could be both skipped and
 *     repeated across pages. `source_key` is deterministic
 *     (`usda:<fdcId>` / `ai:<category>:<name>:<state>`), so it settles every tie
 *     the same way everywhere.
 *  2. `COLLATE "C"` on both text keys. Without it the comparison is the
 *     DATABASE's default collation, which is a property of how the database was
 *     created rather than of this release — and the orders genuinely differ.
 *     Measured on PostgreSQL 16 over five catalog-shaped names ('Beans, black',
 *     'Beans black', 'beans, green', 'Beans-lima', 'BEANS, navy'), `C` yields
 *     `BEANS, navy | Beans black | Beans, black | Beans-lima | beans, green`
 *     while `und-x-icu` — the default a database created with the ICU locale
 *     provider gets — yields
 *     `Beans black | Beans-lima | Beans, black | beans, green | BEANS, navy`.
 *     That is a different page sequence for the same catalog, which AAP §0.9.3
 *     forbids ("identical ranks and page sequences" on a second independently
 *     loaded database), and the `source_key` tiebreaker cannot rescue it because
 *     it is consulted only after `display_name` has already compared unequal —
 *     and would itself be collation-dependent for the same reason.
 *
 * `C` is byte order over the stored UTF-8, built into every PostgreSQL server
 * and needing no extension or locale to be installed, so it is available and
 * identical in every environment. Sorting by bytes rather than by language does
 * mean 'Zucchini' precedes 'apple'; that is the price of an order two machines
 * agree on, and the ordering contract in
 * `data/meal-planning/search-benchmark.v1.json` records it as the pinned choice.
 */
const selectSearchPage = (db: SnapshotClient, matchSet: Prisma.Sql, limit: number, offset: number) =>
    db.$queryRaw<CatalogFoodRow[]>`
        ${matchSet},
        ranked AS (
            SELECT id, MAX(rank) AS rank
            FROM contributions
            GROUP BY id
        )
        SELECT
            f.id,
            f.display_name,
            f.category,
            f.food_state,
            f.identity_source,
            f.nutrition_provenance,
            f.nutrition_basis,
            f.basis_amount,
            f.calories,
            f.protein_g,
            f.carbs_g,
            f.fat_g,
            f.fiber_g,
            f.density_g_per_ml,
            f.allergen_tags,
            f.allergen_status,
            f.food_group
        FROM ranked r
        JOIN catalog_foods f ON f.id = r.id
        ORDER BY r.rank DESC, f.display_name COLLATE "C" ASC, f.source_key COLLATE "C" ASC
        LIMIT ${limit} OFFSET ${offset}
    `;

/**
 * The size of the whole match set.
 *
 * `COUNT(DISTINCT id)` over the same contributions the page is built from, so it
 * counts the DE-DUPLICATED set the client will actually be paged through and not
 * the pre-aggregation join rows. Run on the caller's snapshot client, so the
 * count describes the same catalog the page came from.
 */
const countSearchMatches = (db: SnapshotClient, matchSet: Prisma.Sql) =>
    db.$queryRaw<{ count: bigint }[]>`
        ${matchSet}
        SELECT COUNT(DISTINCT id) AS count FROM contributions
    `;

/**
 * The default portions of one page of foods, grouped by food.
 *
 * A partial unique index allows at most one `is_default` portion per food, so
 * this returns one row per food that has one. Only the default is fetched
 * because that is the only portion `CatalogFoodResponse` exposes — the rest
 * inform conversions the server performs elsewhere, and a measured search should
 * not carry them.
 *
 * A food whose default portion is missing is left with an empty list rather than
 * patched here: `mapCatalogFood` raises `CatalogMappingError` for it, which is
 * the correct outcome, because validation quarantines a candidate without a
 * portion of known gram weight and the alternative is inventing the gram weight
 * every recipe and grocery quantity would then be computed from.
 */
const defaultPortionsByFood = async (
    db: SnapshotClient,
    foodIds: readonly string[],
): Promise<Map<string, CatalogFoodPortionRow[]>> => {
    const portions = await db.catalog_food_portions.findMany({
        where: { catalog_food_id: { in: [...foodIds] }, is_default: true },
        select: {
            catalog_food_id: true,
            description: true,
            amount: true,
            unit: true,
            gram_weight: true,
            is_default: true,
        },
    });

    const byFood = new Map<string, CatalogFoodPortionRow[]>();
    for (const { catalog_food_id, ...portion } of portions) {
        const forFood = byFood.get(catalog_food_id) ?? [];
        forFood.push(portion);
        byFood.set(catalog_food_id, forFood);
    }

    return byFood;
};

/**
 * `GET /api/catalog/foods` — one page of published catalog foods matching `q`.
 *
 * `q` is expected trimmed and within the bounds `parseCatalogSearchRequest`
 * enforces at the controller; an out-of-range query is that parser's verdict and
 * never an exception from here. A caller that passes no search term at all gets
 * an empty page without a query being issued, because an empty prefix pattern is
 * the match-all `%` and returning the entire catalog is the one answer that
 * would be wrong in every case.
 *
 * `page` AND `limit` ARE BOUNDED, NOT CAPPED AT THE ROUTE'S NUMBERS.
 * `rowWindowFor` in `utils/pagination.ts` turns the pair into the `LIMIT` and
 * `OFFSET` this query runs with, and it is what keeps request input out of the
 * statement: `(page - 1) * limit` on a twenty-digit page is a number PostgreSQL
 * rejects for `OFFSET` — a 500 from a query parameter. An HTTP caller can no
 * longer reach that case, because `parseCatalogSearchRequest` refuses a page
 * outside `[1, MAX_PAGE]` at the boundary; the window is still derived in the
 * shared helper rather than here so the bound also holds for the direct
 * callers that never meet a request parser at all.
 *
 * What it does NOT do is apply `MAX_LIMIT`. That cap is the HTTP contract (a
 * page of `GET /catalog/foods` is at most 50) and is applied by the request
 * parser the controller calls, because `scripts/search-benchmark.ts` reads a
 * single `limit=75` reference page in process to prove that pages 1 to 3 at
 * `limit=25` concatenate to it with no duplicate and no missing id. Capping at
 * 50 here would silently truncate that reference and make the pagination check
 * pass vacuously, which is why `rowWindowFor`'s own guard (`MAX_ROWS`) sits far
 * above the route's cap.
 *
 * THE THREE STATEMENTS READ ONE SNAPSHOT. Page, total and default portions are a
 * single answer: the total describes the set the page came from, and every
 * returned food must have the portion that food actually has. Read through
 * separate pool connections they can straddle a catalog load, so they run
 * sequentially inside one REPEATABLE READ transaction — see {@link
 * SnapshotClient} for what that prevents and {@link SNAPSHOT_OPTIONS} for why
 * that isolation level.
 */
export const searchPublishedFoods = async (
    q: string,
    page: number,
    limit: number,
): Promise<CatalogSearchResult> => {
    if (q.trim().length === 0) {
        return { items: [], total: 0 };
    }

    const matchSet = catalogMatchSet(q.trim());
    const { limit: rowLimit, offset } = rowWindowFor(page, limit);

    return prisma.$transaction(async (db) => {
        const rows = await selectSearchPage(db, matchSet, rowLimit, offset);
        const totals = await countSearchMatches(db, matchSet);
        const portions = await defaultPortionsByFood(
            db,
            rows.map((row) => row.id),
        );

        return {
            // Mapped in the order the statement returned, so the ranking
            // survives: the portion lookup is keyed by id and must not reorder
            // the page.
            items: rows.map((row) => mapCatalogFood(row, portions.get(row.id) ?? [])),
            total: Number(totals[0]?.count ?? 0),
        };
    }, SNAPSHOT_OPTIONS);
};

/* ---------------------------------------------------------------------------
 * Suggestions
 * ------------------------------------------------------------------------- */

/**
 * The kinds of suggestion the catalog can offer. One value today — the dislike
 * chips on the food-preferences step — and it stays a parameter so that a
 * second kind is an added row in {@link SUGGESTION_FILTERS} rather than a new
 * endpoint.
 */
export type CatalogSuggestionKind = 'dislike';

/**
 * Which published foods each kind draws from, as the predicate its statement
 * carries.
 *
 * `is_common_dislike` is a curated hint carried by the coverage plan and loaded
 * with the release, not a computed property, so selecting a kind is a lookup
 * rather than a rule — and the `(is_common_dislike, publication_status)` index
 * exists for exactly this predicate, which is why the flag leads it.
 *
 * A `Prisma.Sql` fragment rather than a `catalog_foodsWhereInput` because the
 * statement below has to be raw (see {@link getSuggestions}); it is a
 * parameterised fragment, so composing it keeps every value a bound parameter.
 */
const SUGGESTION_FILTERS: Record<CatalogSuggestionKind, Prisma.Sql> = {
    dislike: Prisma.sql`f.is_common_dislike = true`,
};

/**
 * `GET /api/catalog/foods/suggestions` — the chips shown beside the food-search
 * field, so a user can decline a common ingredient without searching for it.
 *
 * The order is stable and portable for the same reasons the search page's is,
 * and needs the same two devices: `display_name` then `source_key` rather than
 * the `gen_random_uuid()` primary key, and `COLLATE "C"` on both so the sequence
 * is a property of the release and not of the collation the database happened to
 * be created with. Without a total order a re-render could reshuffle the chips
 * under the user's finger; without the explicit collation two databases holding
 * one release could offer the same chips in different orders.
 *
 * WRITTEN RAW FOR THAT COLLATION, and for nothing else. Prisma's `orderBy`
 * cannot express `COLLATE`, and there is no argument by which it could, so the
 * only way to pin the comparison is the statement itself. The shape is otherwise
 * exactly the `findMany` it replaces — same predicate, same three selected
 * columns ({@link CatalogSuggestionRow}), same `LIMIT` — and it is a single
 * statement, so it needs no snapshot transaction: one statement is already one
 * snapshot.
 *
 * `limit` is bounded by {@link rowWindowFor}'s row guard rather than by the
 * route's cap, as in {@link searchPublishedFoods}, so a direct caller cannot put
 * a non-finite value into `LIMIT`; the per-route maximum belongs to
 * `parseCatalogSuggestionsQuery`, which refuses a `?limit=` above 30 rather
 * than trimming it to 30.
 */
export const getSuggestions = async (
    kind: CatalogSuggestionKind,
    limit: number,
): Promise<CatalogSuggestionsResponse> => {
    const { limit: rows } = rowWindowFor(1, limit);

    const foods = await prisma.$queryRaw<CatalogSuggestionRow[]>`
        SELECT f.id, f.display_name, f.food_group
        FROM catalog_foods f
        WHERE f.publication_status = ${PUBLISHED}
            AND ${SUGGESTION_FILTERS[kind]}
        ORDER BY f.display_name COLLATE "C" ASC, f.source_key COLLATE "C" ASC
        LIMIT ${rows}
    `;

    return { items: foods.map(mapCatalogSuggestion) };
};

/* ---------------------------------------------------------------------------
 * Operator status
 * ------------------------------------------------------------------------- */

/**
 * The two columns that identify the active release load, and the status the
 * run must have reached to count.
 *
 * THE ACTIVE-RELEASE RULE IS OWNED ELSEWHERE AND MIRRORED HERE. The active
 * catalog release is the newest `catalog_import_runs` row with
 * `kind = 'release_load'` and `status = 'succeeded'`; `scripts/lib/checkpoint.ts`
 * owns that definition (`RELEASE_LOAD_RUN_KIND`, `getActiveReleaseLoad`) and
 * documents why this file re-implements it instead of importing it: the
 * dependency direction is one-way — `scripts/` imports `../src/*`, never the
 * reverse — and `.dockerignore` keeps `scripts/` out of the runtime image, so
 * an import reaching from `src/` into `scripts/` would break the very build the
 * API ships in. The duplication is therefore deliberate and load-bearing: if
 * the two ever disagree, the operator-facing pointer and this endpoint disagree
 * about which catalog is live, so a change to one is a change to both.
 *
 * Nothing but a succeeded load reaches this state, which is what makes a failed
 * or partial load harmless — the previous release simply stays active.
 */
const RELEASE_LOAD_RUN_KIND = 'release_load';
const RUN_STATUS_SUCCEEDED = 'succeeded';

/** The statuses reported beside the published count, as a validation breakdown. */
const QUARANTINED: CatalogPublicationStatus = 'quarantined';
const REJECTED: CatalogPublicationStatus = 'rejected';

/**
 * A recipe version that planning may currently use. A partial unique index
 * allows one per recipe, so counting these counts distinct usable recipes —
 * which is the number the release gate checks, and the reason the count is not
 * over `recipes`: a row there whose `current_version_id` is null has no
 * plannable version and must not inflate the gate.
 */
const CURRENT_RECIPE_VERSION_STATUS = 'current';

/**
 * `GET /api/catalog/status` — which release is loaded, when, and how the
 * catalog breaks down.
 *
 * OPERATOR AND ACCEPTANCE EVIDENCE ONLY: this endpoint has no mobile consumer.
 * It is what the release checklist queries to confirm the published-food and
 * recipe counts the release gate requires BEFORE `MEAL_PLANNING_ENABLED` is
 * switched on (AAP §0.7.5 sets those numbers; this endpoint only reports what is
 * there), and what a post-deploy verification reads to confirm the expected
 * release is live. It is therefore deliberately cheap — four aggregates and one
 * indexed row, five reads in total, never a row dump — because a diagnostic that
 * is expensive to run is one nobody runs at the moment it matters.
 *
 * Every count is a separate aggregate rather than a grouped scan so that each
 * one is independently readable, and the five reads run SEQUENTIALLY INSIDE ONE
 * REPEATABLE READ SNAPSHOT rather than concurrently. That is the point of the
 * endpoint: a report whose release pointer came from before a load and whose
 * published count came from after it describes no state the catalog was ever in,
 * and it is exactly the report an operator reads while a load is running. Five
 * indexed reads on one connection are cheap enough that coherence costs nothing
 * worth having.
 */
export const getStatus = async (): Promise<CatalogStatusResponse> => {
    const { releaseLoad, counts } = await prisma.$transaction(async (db) => {
        const activeLoad = await db.catalog_import_runs.findFirst({
            where: { kind: RELEASE_LOAD_RUN_KIND, status: RUN_STATUS_SUCCEEDED },
            orderBy: { started_at: 'desc' },
            select: { manifest_version: true, finished_at: true, started_at: true },
        });

        const snapshotCounts: CatalogStatusCounts = {
            publishedCount: await db.catalog_foods.count({
                where: { publication_status: PUBLISHED },
            }),
            quarantinedCount: await db.catalog_foods.count({
                where: { publication_status: QUARANTINED },
            }),
            rejectedCount: await db.catalog_foods.count({
                where: { publication_status: REJECTED },
            }),
            recipeCount: await db.recipe_versions.count({
                where: { status: CURRENT_RECIPE_VERSION_STATUS },
            }),
        };

        return { releaseLoad: activeLoad, counts: snapshotCounts };
    }, SNAPSHOT_OPTIONS);

    // `manifest_version` carries the release id for a release_load run ('v1' for
    // data/meal-planning/catalog/releases/v1) and is what `catalogRelease`
    // reports. `finished_at` falls back to `started_at` for the same reason
    // `getActiveReleaseLoad` does: the two are written in one statement when a
    // run succeeds, so the fallback keeps `lastLoadedAt` non-null rather than
    // describing a state that occurs. Both are null before any release is
    // loaded, which is the one state the nullable members of the response
    // describe.
    const activeRelease: CatalogReleaseRunRow | null = releaseLoad
        ? {
              manifest_version: releaseLoad.manifest_version,
              finished_at: releaseLoad.finished_at ?? releaseLoad.started_at,
          }
        : null;

    return mapCatalogStatus(activeRelease, counts);
};
