// The payload-digest mechanics both writers of `catalog_foods` share, as pure
// functions over their arguments: key-sorted JSON, and a SHA-256 of a string.
//
// WHY THIS MODULE EXISTS. `catalog-import-usda.ts` and `catalog-generate-ai.ts`
// each stamp the row they write with a digest of the payload it was derived
// from, and the digest has to be taken the same way in both or the same payload
// would produce two different `source_cache_key` values. The generation stage
// used to import these helpers FROM the import stage's CLI entry point, which
// is a module that starts with `./lib/bootstrap` and `./lib/dbGuard` and
// declares a `main()`: importing it to borrow a hash helper pulls a second
// command's startup ordering and database-origin policy into your own process,
// and it reads as though one CLI were a library for the other (Rule
// backend-architecture §1.1/§7.1 — a script is an I/O recipe, and what both
// recipes share belongs beside them in `lib/`).
//
// So this module is deliberately inert on import: one Node built-in and nothing
// else. It reads no environment variable, opens no connection, registers no
// handler and runs no statement at load, which is what makes it safe for any
// script — or any test — to import for one function.
//
// WHAT DOES NOT LIVE HERE: any catalog DECISION. The three derivations that
// used to sit beside these two helpers — the stored alias list
// (`dedupeSortedAliases`), the `search_text` the STORED `search_vector` is
// generated from (`buildSearchText`), and the two version counters
// `recipe_ingredients` snapshots are checked for staleness against
// (`nextCatalogFoodVersions`, with `StoredVersionedFacts` and
// `CatalogFoodVersions`) — now live in `src/services/catalog.logic.ts`, beside
// the rest of the catalog's rules and under that module's own unit tests
// (`src/services/__tests__/catalog.logic.test.ts`). They are decisions about
// what the catalog
// IS — which names a food answers to, which words find it, and when a frozen
// recipe snapshot has gone stale — and the AAP assigns the catalog's pure rules
// to that module (§0.7.1 Group 3), while Rule backend-architecture §1.1/§7.1
// keeps a script's shared library to the mechanics the scripts themselves need.
// Both stages still derive them identically, because both call the one
// implementation there.
//
// A digest is not such a decision: key-sorted JSON and a SHA-256 are facts
// about bytes, and nothing about the catalog changes if a payload is hashed.
// Classification, the brand screen, portion resolution, the validation checks
// and category bounds are likewise `src/services/catalog.logic.ts`, and each
// stage keeps its own Prisma `select` and persistence.

import crypto from 'crypto';

/**
 * Key-sorted JSON, so a digest of a vendor record does not depend on the order
 * the payload's keys happened to arrive in. `undefined` cannot appear in parsed
 * JSON, so it needs no case.
 */
export const canonicalJsonString = (value: unknown): string => {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value ?? null);
    }
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJsonString).join(',')}]`;
    }
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
    );
    return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJsonString(nested)}`).join(',')}}`;
};

export const sha256Hex = (text: string): string => crypto.createHash('sha256').update(text).digest('hex');
/**
 * The characters a model-supplied string may never contain, whatever else it
 * says, as one pattern both stages test against.
 *
 * Membership is chosen by what each class DOES to a sink this pipeline writes,
 * not by how unusual it looks:
 *
 *  * `\u0000` cannot exist in a PostgreSQL `text` or `jsonb` value at all. A
 *    name carrying one does not arrive truncated, it aborts the statement while
 *    the parameter is being bound (SQLSTATE 22021, surfacing as an opaque
 *    Prisma P2010), so a whole batch fails on one candidate — and a value that
 *    reached an evidence fetch or a digest first spent a network round trip and
 *    a hash on a string that could never be stored.
 *  * The remaining C0 controls, DEL and the C1 range are what forge a second
 *    line in a terminal or a CI log, and what a report reader's pager
 *    interprets as an escape sequence (CWE-117). The three ORDINARY whitespace
 *    C0 characters — tab, LF, CR — are excluded from this set and collapsed to
 *    a single space by {@link boundedModelText} instead, because a trailing
 *    newline in a proposed name is a formatting artefact rather than a hostile
 *    payload, and refusing the candidate for it would cost a usable food.
 *  * The zero-width format controls (U+200B–U+200D, U+FEFF) and the line and
 *    paragraph separators (U+2028/U+2029) make two different strings render
 *    identically, or break a line where none was stored.
 *  * Every bidi control, matched as `\p{Bidi_Control}` rather than as a list of
 *    ranges. The property is the definition this contract means, and naming it
 *    is what keeps the two from drifting apart: an enumeration of the U+200x
 *    and U+202x blocks silently omits U+061C ARABIC LETTER MARK, which carries
 *    `Bidi_Control=Yes` and sits nowhere near them, and a future Unicode
 *    version may add another such outlier. The property resolves to twelve code
 *    points today (U+061C, U+200E/F, U+202A–E, U+2066–9) and is evaluated by
 *    the engine, so it cannot fall behind a hand-copied range.
 *
 * Both classes matter here for the same reason: a food NAME is what a user
 * reads in search results and in a diary row, and what a curator compares
 * against retrieved evidence, so a name that renders as something other than
 * what is stored defeats the review this catalog's publication decision rests
 * on.
 */
const FORBIDDEN_MODEL_TEXT_PATTERN =
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200d\u2028\u2029\ufeff]|\p{Bidi_Control}/u;

/** Tab, LF and CR: collapsed rather than refused, with every other control refused above. */
const COLLAPSIBLE_WHITESPACE_PATTERN = /\s+/g;

/**
 * A surrogate code unit that is not part of a valid pair.
 *
 * JavaScript strings are UTF-16 and permit a lone surrogate; PostgreSQL's
 * `text` is UTF-8 and has no encoding for one, so such a value is another
 * statement-level failure rather than a storage question. It cannot be repaired
 * — there is no character to keep — so a string carrying one is refused.
 */
const UNPAIRED_SURROGATE_PATTERN = /[\ud800-\udbff](?![\udc00-\udfff])|(?:^|[^\ud800-\udbff])[\udc00-\udfff]/;

/**
 * One model-supplied string, narrowed to something this pipeline may store,
 * digest, log and put in front of a curator — or `null`, which means the field
 * is unusable and the candidate or the field is refused.
 *
 * `null` is the fail-closed answer and the point of the function: it is
 * returned for a non-string, for a string that is empty once trimmed, and for a
 * string carrying any character in {@link FORBIDDEN_MODEL_TEXT_PATTERN} or an
 * unpaired surrogate. The alternative — stripping the offending characters and
 * storing what is left — silently changes a name into a DIFFERENT name and then
 * presents it as the model's proposal, which is exactly the "never present a
 * generated value as established" rule (AAP §0.1.2) applied to identity rather
 * than to nutrition. Refusing costs one candidate; rewriting costs the audit
 * trail.
 *
 * What it DOES do to an acceptable string: trims it, collapses every run of
 * ordinary whitespace to one space, and bounds it at `maxChars`. The bound is
 * the caller's, because the ceilings differ by field (a canonical name and an
 * advisory review reason are not the same size of thing) and neither belongs to
 * this module.
 *
 * Shared by `catalog-generate-ai.ts` (every string read off a generation
 * payload) and `catalog-validate.ts` (the advisory review's free-text reason),
 * for the reason stated at the top of this file: the two stages write and
 * annotate the same rows, so a character one of them refuses and the other
 * stores is a difference in what the catalog contains, not a style difference.
 *
 * @param value the field as the payload carried it, of unknown type
 * @param maxChars the ceiling this field is kept to, in UTF-16 code units
 *
 * @example
 * boundedModelText('  chicken   breast\n', 200); // → 'chicken breast'
 * boundedModelText('chicken\u0000breast', 200);  // → null
 */
export const boundedModelText = (value: unknown, maxChars: number): string | null => {
    if (typeof value !== 'string') {
        return null;
    }

    if (FORBIDDEN_MODEL_TEXT_PATTERN.test(value) || UNPAIRED_SURROGATE_PATTERN.test(value)) {
        return null;
    }

    const bound = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 0;
    if (bound === 0) {
        return null;
    }

    // Trimmed after the refusal above, so a control character hiding in
    // leading or trailing whitespace is refused rather than trimmed away.
    const collapsed = value.trim().replace(COLLAPSIBLE_WHITESPACE_PATTERN, ' ');
    const bounded = collapsed.length > bound ? collapsed.slice(0, bound) : collapsed;

    // The cut is in UTF-16 code units, so it can land BETWEEN the two halves of
    // a surrogate pair and manufacture the lone surrogate the input was checked
    // for. Dropping the orphaned high half is the only repair that leaves valid
    // text, and it costs one character of a value already being truncated.
    const lastUnit = bounded.length > 0 ? bounded.charCodeAt(bounded.length - 1) : 0;
    const whole = lastUnit >= 0xd800 && lastUnit <= 0xdbff ? bounded.slice(0, -1) : bounded;

    return whole.length > 0 ? whole : null;
};
