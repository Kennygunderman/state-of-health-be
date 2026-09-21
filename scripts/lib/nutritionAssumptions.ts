// The decode half of the storage rule for
// `catalog_validation_records.nutrition_assumptions`: a JSON-encoded array of
// strings held in a NULLABLE TEXT column (`String?` in prisma/schema.prisma,
// `TEXT` in the meal-planning migration). Every stage that writes a validation
// record encodes the list with `JSON.stringify` — catalog-import-usda.ts,
// catalog-generate-ai.ts, catalog-validate.ts and catalog-load.ts — so the
// column always holds text, and a reader that wants the list back has to parse
// it.
//
// WHY ONE DECODER RATHER THAN ONE PER READER. Two stages read the column to
// reconstruct the list for a validation record they are re-deriving:
// catalog-validate.ts, which merges an existing record's assumptions forward
// when it re-judges a row, and catalog-report.ts, which emits them on that
// item's record in the validation report. Those two must agree, because the
// report is the evidence for the record: a second copy of this rule is a second
// rule that can drift from the encoder while still parsing, and the symptom
// would be a report stating a different assumption list from the one the row
// carries — a discrepancy nothing downstream can detect. catalog-release.ts
// decodes the same column under a DIFFERENT and deliberate rule (text that will
// not parse becomes the single assumption it is, so a release line cannot
// silently drop a legacy prose value); that is export fidelity, documented at
// `toReleaseValidationLine`, and it is not what a re-derived record wants.
//
// WHY IT LIVES HERE AND NOT IN src/services/catalog.logic.ts. Both consumers
// are catalog CLI stages and no service or route reads this column, so the rule
// is not part of the request-time domain: `scripts/lib/` is the library those
// stages share, and reaching one entry point from another to borrow a decoder
// would pull that command's startup ordering, database-origin policy and vendor
// graph into the borrowing process (Rule backend-architecture §1.1/§7.1 — a
// script is an I/O recipe, and what two recipes share belongs beside them in
// `lib/`).
//
// This module is inert on import by construction: it has no imports at all,
// reads no environment variable, opens no connection and runs nothing at load,
// so any script or test may import it for the one function.

/**
 * The assumptions a validation record already carries, as a list.
 *
 * The column is a JSON-encoded array in a nullable text column, so absent,
 * empty, malformed and populated all have to resolve to something usable. A
 * value that will not parse as an array of strings is dropped rather than
 * guessed at — the alternative is carrying a fragment of unparseable text
 * forward as though it were an assumption.
 */
export const parseStoredAssumptions = (encoded: string | null | undefined): string[] => {
    if (encoded === null || encoded === undefined || encoded.trim().length === 0) {
        return [];
    }
    try {
        const parsed: unknown = JSON.parse(encoded);
        return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
    } catch {
        return [];
    }
};
