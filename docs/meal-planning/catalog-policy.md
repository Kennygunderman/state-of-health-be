# Meal planning — catalogue policy

The reviewed policy record for the internal food catalogue: the identity-evidence
(SSRF) policy and its address-table attestation, the provenance model, and where
the coverage plan, the validation checks and bounds, and the search-benchmark
thresholds and protocol are authoritatively recorded.

Two habits keep this document useful rather than decorative.

- **It records what is reviewed, not what is measured.** Every number an
  operator run produces — published counts, hit rates, latencies — belongs to
  that run's report, and is never restated here.
- **It points at the machine-readable source wherever one exists**, and does not
  copy it. A table duplicated into prose drifts silently; a pointer cannot. The
  one exception is the attestation block below, which is *deliberately* a
  transcription, because its whole purpose is to be a third, independent
  signature.

## Status at this commit

| Referenced thing | State |
| --- | --- |
| `src/services/evidence.logic.ts`, `src/services/evidence.service.ts`, `data/meal-planning/evidence-allowlist.v1.json` and the attestation below | present, and cross-checked by `src/services/__tests__/evidence.logic.test.ts` on every run |
| `data/meal-planning/coverage-plan.v1.json`, `data/meal-planning/usda-manifest.v1.json`, `data/meal-planning/search-benchmark.v1.json` | present; they are the authoritative record for the plan, the import manifest and the benchmark contract |
| `src/services/catalog.logic.ts` check vocabulary, tiers and category bounds | present |
| Catalogue acceptance evidence — the per-category published counts, the shortfall and the quarantine list | **operator-produced, not in this repository.** `npm run catalog:validate` then `npm run catalog:report` write them from a loaded database. `src/services/catalog.service.ts` exports the `getStatus` read that reports a published count, but no catalog router is mounted at this commit (`src/routes/` carries none), so the report — not an API response — is where those numbers exist today. Nothing here states them. |
| Search-benchmark acceptance evidence — hit rates, zero-result rate, page sequences, p50/p95 | **operator-produced, not in this repository.** `npm run search:benchmark` runs the fixed query set against a loaded release and writes the report named by `acceptanceReport` in `search-benchmark.v1.json`. The same file's `nonAcceptanceSuite` block records, for the synthetic-fixture Jest suite at the path it names — a suite that is not part of this commit — that a green run of it would still not be acceptance evidence. |

## The reviewed evidence-allowlist attestation

`data/meal-planning/evidence-allowlist.v1.json` carries the address policy the
identity-evidence fetch is judged against: one row per special-purpose address
block, with the reachability the IANA registries state for it. An address
matching **no** row is ordinary global unicast by design, because the registries
enumerate the special-purpose blocks exhaustively — which is exactly why a row
that quietly disappears is dangerous rather than harmless. Lose the
`169.254.0.0/16` row and the cloud metadata address becomes a permitted fetch
target, with nothing in the logs to say so.

So the table is counter-signed three times, and a refresh is three coordinated
edits rather than one:

1. the document — `data/meal-planning/evidence-allowlist.v1.json`;
2. the code — `REVIEWED_RANGE_TABLE`, `REVIEWED_SUPPLEMENTAL_CIDRS`,
   `REVIEWED_REGISTRY_SNAPSHOT` and `REVIEWED_ALLOWLIST_VERSION` in
   `src/services/evidence.logic.ts`, which refuses a document that is not the
   reviewed one;
3. this record — the block below, transcribed by the reviewer.

`src/services/__tests__/evidence.logic.test.ts` reads all three off disk and
asserts them against each other, so any single edit fails the suite and names
which source disagreed.

<!-- BEGIN EVIDENCE ALLOWLIST ATTESTATION -->

```text
allowlist-version: v1
registry-snapshot: 2026-09-08
reviewed-rows-total: 52
registry-derived-rows: 51
supplemental-rows: 1
supplemental-block: ::/96 | RFC 4291 IPv4-Compatible prefix, deprecated and not a row of the current IANA IPv6 Special-Purpose Address Registry. Carried so that an embedded form such as ::a9fe:a9fe cannot outflank the 169.254.0.0/16 row once unwrapEmbeddedIpv4 has unwrapped it.
```

<!-- END EVIDENCE ALLOWLIST ATTESTATION -->

**Why the total and the registry-derived count differ.** 52 is every row the
reviewed table carries; 51 of them are transcriptions of the two IANA
special-purpose registries (26 IPv4 rows and 25 IPv6 rows), and one — `::/96` —
is carried for hardening. Presenting 52 as a registry-row count would misstate
what a reviewer is being asked to counter-sign: at a refresh it is the
registry-derived figure that gets diffed against the registry pages, and it
would be wrong by one. The two sets are therefore counted, attested and
validated separately, and `validateEvidencePolicy` refuses a document that
reclassifies a block from one set into the other in either direction, even
though such a document's total still adds up.

**The block's format**, which the sibling test parses strictly:

- The block is everything between the `BEGIN EVIDENCE ALLOWLIST ATTESTATION` and
  `END EVIDENCE ALLOWLIST ATTESTATION` HTML comments; each marker appears exactly
  once in this file.
- Blank lines and the fence lines around the code block are ignored. Every other
  line is `key: value`, with the key in lower case and hyphenated.
- `allowlist-version`, `registry-snapshot`, `reviewed-rows-total`,
  `registry-derived-rows` and `supplemental-rows` each appear exactly once. The
  three counts are plain non-negative integers; `registry-snapshot` is a
  `YYYY-MM-DD` date.
- `supplemental-block` appears once per supplemental block, as
  `<cidr> | <reason it is carried>`. Both halves are required: a block nobody
  wrote a reason for is a block nobody reviewed.
- An unknown key, a repeated single-value key, a missing key or an unparsable
  count fails the suite. The parser never guesses, because a value it guessed at
  would be a signature nobody gave.

## Identity-evidence retrieval policy (SSRF)

`scripts/catalog-generate-ai.ts` asks a language model to propose URLs that
corroborate a generated food's identity, then fetches them. A model-proposed URL
is attacker-influenced input, so `src/services/evidence.logic.ts` decides and
`src/services/evidence.service.ts` acts, in this order, and any failure leaves
the candidate `quarantined` rather than published.

| Rule | Value as the reviewed policy states it |
| --- | --- |
| Scheme | `https` only |
| Port | 443 only; an explicit `:443` is accepted because the URL parser normalises it away |
| Credentials | a URL carrying userinfo is refused outright |
| Host form | no IP-literal hosts; the host is IDNA-converted (`url.domainToASCII`), lower-cased, one trailing dot stripped, and must then match `^[a-z0-9-]+(\.[a-z0-9-]+)+$` |
| Host matching | per label, never by substring: `example.gov` matches that exact host, `*.example.gov` matches a host with at least one further label, so `notexample.gov`, `example.gov.evil.com` and bare `example.gov` never match the wildcard |
| Authorization | per claim: the requested evidence type must be one the matched host class declares (table below) |
| Address policy | the host is resolved once, and **every** returned address must parse, be unicast, and fall in no table row whose reachability is `false` or `n/a`; the most specific matching row decides, so a globally reachable block nested inside a non-global parent is admitted. Embedded and translated IPv6 forms are unwrapped and the carried IPv4 address is judged as well |
| DNS pinning | the address that passed is pinned for the connection, so the name is never resolved a second time (DNS rebinding) |
| Redirects | at most 2, each re-validated from the URL step onward; any cross-host redirect ends the fetch and is not configurable by the document |
| Deadline | 10 s for the whole retrieval |
| Body cap | 1 MiB measured on the **decompressed** body, with the stream aborted at the cap — a compressed-size cap would be a zip-bomb hole |
| Content types | `text/html`, `application/json`, `text/plain` |
| Fetched bytes | **data, never instructions.** The body is matched against the candidate's name and hashed; it is never fed back into a prompt |

The document may **narrow** any of those limits and can never widen one: lists
are intersected with the reviewed ceilings and numeric caps take the smaller of
the two, so a stale or tampered allowlist cannot unlock a scheme, a port, a
content type, a longer deadline or a bigger body than the code sanctions. A
document that is malformed rather than merely narrow resolves to *nothing
permitted* and is refused outright, with the refusal recorded as a refusal of the
*policy* (`policy_invalid`, `range_table_unclassifiable`) rather than of the
candidate — an operator reading those two codes knows the candidate was never
judged.

**What a retrieval records.** One record per URL actually retrieved, stored in
`catalog_validation_records.identity_evidence`: the URL **that served the
recorded bytes** (after any same-host redirect), that URL's host, the HTTP
status, the SHA-256 of the body, the matched snippet (≤ 500 characters, `null`
when the page was fetched but the candidate's name was not found in it) and the
fetch time. Evidence that failed to corroborate is not the same thing as no
evidence, and both leave the candidate quarantined. URLs are logged at host
level, and no credentials are ever attached.

### Host classes and the claims each may corroborate

The class set and its host entries are reviewed data in
`evidence-allowlist.v1.json`; what each class is trusted to *attest* is policy,
and is recorded here. A named culinary reference may establish what a dish is and
how it is prepared without being an authority on its nutrition or its allergens,
which is why authorization is per claim rather than per host.

| Host class | Claims it may corroborate |
| --- | --- |
| `usda_fdc` | canonical identity, preparation method, nutrition reference, portion reference, allergen composition, food classification |
| `government_nutrition_reference` | canonical identity, nutrition reference, portion reference, allergen composition, food classification |
| `university_nutrition_reference` | canonical identity, preparation method, nutrition reference, portion reference, food classification |
| `named_culinary_reference` | canonical identity, preparation method, portion reference |

No manufacturer domain appears in any class, by design: AI generation proposes
generic preparations only — the prompt schema has no brand field and a
brand-pattern name is rejected at parse time — so a model-proposed manufacturer
domain could never independently verify a model-proposed product. Branded
coverage comes from USDA Branded records and the existing live branded search.
`validateEvidencePolicy` refuses a class without an identifier, without hosts or
without evidence types, and refuses a host entry that appears in two classes:
an authorization that depends on the order the classes happen to be written in
is an authorization nobody can review.

## Provenance model — four independent facts

A catalogue row's provenance is never one mixed status. Four columns are kept
separately (`catalog_foods` in `prisma/schema.prisma`), because collapsing any
two of them loses a distinction the product makes visible:

| Fact | Column | Values |
| --- | --- | --- |
| Where the identity came from | `identity_source` | `usda`, `ai_generated` |
| Whether that identity is corroborated | `identity_status` | `verified`, `ambiguous`, `unsourced` |
| Where the numbers came from | `nutrition_provenance` | `source_backed`, `ingredient_derived`, `ai_estimated` |
| Whether the row is usable | `publication_status` | `candidate`, `published`, `quarantined`, `rejected`, `retired` |

`ingredient_derived` is an estimate even though its components are sourced,
because the *quantities* are assumed; recipe nutrition, by contrast, is
calculated from exact stored gram weights of source-backed ingredients and is
therefore `source_backed`. Allergen knowledge is its own column again
(`allergen_status`), because "we do not know" must never read as "none".

Two rules follow from the split and are enforced rather than documented:
search returns `published` rows only, and planning admits an ingredient only
when it is `source_backed` **and** `allergen_status = 'known'` — so a planned
meal is never an estimate. A food that leaves a later release is `retired`, never
deleted, because diary entries and recipe versions reference it.

## Coverage plan

`data/meal-planning/coverage-plan.v1.json` is the plan of record and the only
place its numbers live. It carries, per its own field names: the two totals
(`publishedTargetTotal`, `candidateVolumeTotal`), the 21 categories with their
`publishedTarget` and `candidateVolume`, the candidate-volume rule
(`candidateVolumeMultiplier`, `candidateVolumeRounding`) and the AI-candidate
formula (`aiCandidateFormula`), the batching contract (`defaultBatchSize`,
`batchKeyFormat`, `batchIndexPadWidth`, `modelCallsPerBatch`) that makes a rerun
address exactly the same batches, the prompt versions, and the controlled
`foodGroups` taxonomy that makes a dislike cover a food group without touching
unrelated ones.

The category tables are not reproduced here. Per-category shortfall is
`max(0, publishedTarget − published)`, reported exactly and never rounded, by
`npm run catalog:report` — and it is that report, not this document, that states
whether a target was met.

## Validation checks and bounds

Every deterministic check is recorded on the row it judged, with its observed
value, its bound and its **tier**, and the tier decides the row's
`publication_status`:

- `reject` — physically impossible. The row is `rejected` and is never
  publishable.
- `quarantine` — unusable until more data arrives. The row is `quarantined` and
  is re-validated on the next run.
- `review` — plausible but atypical. A USDA-sourced row publishes with the flag
  recorded, because the source is authoritative and the flag is informational; an
  AI-generated row stays quarantined until a review confirms it.

The vocabulary and the tier of each check are in `src/services/catalog.logic.ts`
(`CATALOG_CHECK_NAMES`, `catalogCheckTier`, and the per-tier lists derived from
them). The numeric bounds are in `coverage-plan.v1.json`: `validationBounds` for
the absolute ones (kcal ceiling, macro-mass tolerance factor, the absolute
energy-versus-macro tolerance, the portion-conversion tolerance) and
`categories[]` for the per-category `kcalReviewRange` and
`energyMacroTolerancePercent`. Review ranges are deliberately wide enough to
contain each category's real extremes — egg white and egg yolk both sit inside
the protein_egg range — so they flag oddities instead of rejecting real foods.

Two bounds are worth naming because they are easy to get wrong in the permissive
direction. A nutrient that is `NULL` means *unknown* and is never coerced to 0,
which is why `missing_core_nutrient` quarantines rather than publishing a zero.
And a publishable row needs a nutrition basis of `per_100g` (or `per_100ml` with
a density) and exactly one default portion with a sourced gram weight: a
`per_serving`-only row whose serving has no sourced weight is quarantined with
`missing_gram_weight`, because publishing it would mean inventing the weight.
`nutritionBasisRule` in `coverage-plan.v1.json` states that rule in data.

## Search benchmark — thresholds and protocol

`data/meal-planning/search-benchmark.v1.json` is the benchmark contract: the
fixed query set, the `thresholds` block (top-3 and top-10 hit rates, the
zero-result ceiling and the p95 latency limit), the `protocol` block (warm-up and
timed passes, sequential single-connection execution, and in-process timing of
the search function so network time is excluded), the `ordering` the results are
compared against, the `paginationCheck` definition, and
`expectationResolution` — every expectation names a food by its stable
`source_key`, resolved to the local id after a release is loaded, never by an
environment-local UUID.

The thresholds are reviewed policy and live in that file rather than as literals
in the runner, because lowering one is how a failing benchmark turns green. The
runner is `scripts/search-benchmark.ts` (`npm run search:benchmark`); it fails
closed, and the report it writes — named by `acceptanceReport` in the same file —
is the acceptance evidence. That report is produced by an operator run against a
loaded release and is not part of this repository, so no measured rank, hit rate
or latency appears in this document. Release determinism is evidenced by running
the same benchmark against a second, independently loaded database: the ranks and
page sequences must be identical, and only latencies may differ.

## Refreshing the registry snapshot

1. Transcribe the two IANA special-purpose registries into
   `evidence-allowlist.v1.json`: one row per registry entry, with its CIDR in
   canonical lower-case text written on its own network address, its registry
   name, its family, and its `globallyReachable` value exactly as the registry
   states it (`true`, `false` or `"n/a"` — the three are never collapsed into a
   boolean). Update `registrySnapshot`, `rowCount`, `registryRowCount`,
   `supplementalRowCount` and `supplementalCidrs`.
2. Update `REVIEWED_RANGE_TABLE`, `REVIEWED_SUPPLEMENTAL_CIDRS` and
   `REVIEWED_REGISTRY_SNAPSHOT` in `src/services/evidence.logic.ts` to match.
   The reviewed counts are derived from those two lists, never written by hand.
3. Transcribe the new snapshot date and the three counts into the attestation
   block above, with a reason line for every supplemental block.
4. Run
   `NODE_ENV=test ALLOW_DB_TRUNCATE=true DATABASE_URL=<test database> npx jest src/services/__tests__/evidence.logic.test.ts`.
   Any step done alone fails it, and the failure names the two sources that
   disagreed.
