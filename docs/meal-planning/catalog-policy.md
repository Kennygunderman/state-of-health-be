# Meal planning — catalogue policy

The reviewed decision record for the offline catalogue pipeline: the coverage
plan, the validation checks and their bounds, the provenance model, the
identity-evidence (SSRF) policy and its address-table attestation, the release
artefact, and the search-benchmark thresholds and protocol.

It exists because those decisions are otherwise spread across JSON tables and
pure predicates, where they can be *executed* but not *reviewed*. What follows is
therefore what the code cannot carry: where each bound came from, what it
bounds, and what it deliberately does not promise.

Three habits keep it useful rather than decorative.

- **It records what is reviewed, not what is measured.** Every number an
  operator run produces — published counts, hit rates, latencies — belongs to
  that run's report and is never restated here. A measurement copied into prose
  becomes a claim nobody re-measured.
- **It transcribes a reviewed bound, and points at everything else.** A policy
  value someone chose is written out here so it can be argued with; the data
  behind it — query sets, manifest entries, the food-group taxonomy — is pointed
  at, not copied. Transcription is safe only because it is gated, and the gate
  is named rather than implied: see *How this document is kept true* below. An
  ungated duplicate would drift silently, which is why the line is drawn at
  *reviewed bounds* rather than at convenience.
- **It labels every number by where its authority comes from**, using these
  three markers throughout:

| Marker | Meaning |
| --- | --- |
| **(vendor)** | Documented behaviour of an external service. Not ours to choose; changing the number here would not change the service. |
| **(cited)** | External guidance or a published registry, named in full so a reviewer can go and read it. |
| **(product policy)** | A decision this project made. Arguable, reviewable, and changeable by agreeing to change it. Product-policy numbers about nutrition are engineering guardrails for a general-wellness feature — they are **not** clinical or nutritional guidance. |

## How this document is kept true

Two unit tests read this file off disk and compare what it states against the
files that own the values, so a transcription that drifts turns a run red
instead of surviving as prose.

`src/__tests__/setup/coverageInventory.test.ts` (its `policy-document drift
gate` block) parses the regions delimited by `<!-- BEGIN POLICY GATE: <id> -->`
and `<!-- END POLICY GATE: <id> -->` comments, and compares **every value** in
them with the file that owns it. Three kinds of thing inside a marked region
count as a value, and all three are compared:

- **a number** — a bound, a threshold, a count, a share, a budget, a basis
  amount or a cap;
- **a closed code vocabulary** — the members the region enumerates, and their
  order where it states one, against the array or the union that declares them;
- **an algorithm parameter** — an admissible range, a digest, a normalized
  form, a status a guard answers with. These are compared by *behaviour* where
  the owning code can be called: the gate reads the parameter out of this file,
  applies it, and compares the result with what the exported function does.
  Nothing restates the rule in the test, so a change on either side moves
  exactly one of the two values it prints.

| Gated block | What is compared | Source of truth |
| --- | --- | --- |
| `evidence-retrieval-limits` | scheme, port, redirect ceiling, deadline, body cap, content types, snippet cap; the normalized host form, compared as the pattern's own source; the digest a retrieval records the body under, folded to the spelling of its only call site; the three reachability values, read out of the guard that accepts them, with the count it states, the non-boolean one and **both** statements of the refusing pair; and the two codes a refusal of the policy is recorded as, with their count | `src/services/evidence.logic.ts`, `src/services/evidence.service.ts` (the digest) |
| `registry-row-split` | the reviewed row total in **both** places it is stated, the registry-derived rows with their IPv4/IPv6 split, and the supplemental row | `src/services/evidence.logic.ts` |
| `coverage-totals-and-targets` | both totals, the candidate-volume rule and the acceptance rate it is sized against, all 21 categories' published target and candidate volume, and that the columns sum to the totals | `data/meal-planning/coverage-plan.v1.json` |
| `batching-contract` | the default batch size, the batch-key format, the index pad width, and every figure of the worked example — whose category is read out of this file and resolved against the plan, so a renamed category fails rather than passing against a name typed into the test | `data/meal-planning/coverage-plan.v1.json` |
| `model-call-budget` | the model calls one batch costs and the startup estimate built from it; the stop reason a crossed cap ends the run with; and the admissible range itself, compared **by behaviour** — the variable name and the bound are read out of this file and handed to the resolver, which must refuse each form the sentence names and admit the smallest value it leaves | `data/meal-planning/coverage-plan.v1.json`, `scripts/lib/budget.ts` (the resolver), `scripts/catalog-generate-ai.ts` (the stop reason) |
| `food-group-taxonomy` | the taxonomy size, the common-dislike groups, and the group the dislike behaviour is worked through | `data/meal-planning/coverage-plan.v1.json` |
| `nutrition-basis-rule` | the two publishable bases and that there are only two, the basis the rule **excludes** — compared as every basis the type admits less the ones the plan publishes — the single default portion, the required-nutrient count, the basis amount an unconvertible serving cannot be expressed on, and each check name the rule quarantines with; plus that every requirement the prose argues is still required in data | `data/meal-planning/coverage-plan.v1.json` (`nutritionBasisRule`), `src/services/catalog.logic.ts`, `src/types/catalog.ts` (the basis vocabulary) |
| `catalog-check-tiers` | the tier names themselves, against the union that declares them; each tier's list; and the quarantine list as reviewed data as well as code | `src/types/catalog.ts` (the tier names), `src/services/catalog.logic.ts`, `data/meal-planning/coverage-plan.v1.json` |
| `validation-bounds-and-review-ranges` | the four global bounds and the percentages derived from them; the basis amount every one of them is stated on, including the column heading, which is built from the owned amount rather than retyped; the Atwater divisors the tolerance argument turns on; all 21 review ranges with their per-food-state bands and tolerances; exactly which categories the plan splits by food state, with the count and the one the argument is worked through; and that the two cases named as must-publish fall inside the band they are judged by | `data/meal-planning/coverage-plan.v1.json`, `src/services/catalog.logic.ts` (the basis amount), `src/services/targets.logic.ts` (the divisors) |
| `benchmark-contract` | the four thresholds, the page limit they are measured at, the protocol's warm-up, timed passes and connection, the pagination-check numbers, and the outcome the endpoint would answer the wide reference with — its code obtained by handing that reference limit to the request parser, its status read from the one mapping the controller answers a rejected parse with | `data/meal-planning/search-benchmark.v1.json`, the endpoint's limit floor and ceiling from `src/utils/pagination.ts`, `src/services/catalog.logic.ts` (the code), `src/controllers/catalog.controller.ts` (the status) |
| `usda-vendor-limits`, `usda-rate-limit-recap` | the vendor hourly cap, the import's default share and the headroom between them, **the import ceiling a configured rate is refused above — compared against the cap the accessor enforces, not against the default that aliases it, with that identity asserted as well** — the physical attempts per logical call, the two request shapes, the nutrient numbers, the basis the nutrient array the import reads is stated on, and the vendor status a retried attempt follows | `scripts/lib/rateLimiter.ts`, `src/services/usda.service.ts`, `src/services/catalog.logic.ts` (the basis amount) |

`src/services/__tests__/evidence.logic.test.ts` owns the attestation block
below, which it parses out of this file and counter-signs against the reviewed
document and the module.

The gate runs **both ways**: every marker in this file must be claimed by that
test and every block it expects must be present, and each table's row count is
compared as well — so deleting a row, dropping a marker or renaming one fails
rather than quietly shrinking what is checked. Every failure prints both sides
labelled by the file they came from.

**What is prose rather than gated**, recorded so the claim above is exactly
true. Only two things qualify: text that sits **outside** every marker, and text
inside one that states **no duplicated value** by the definition above. Nothing
else is exempt — a value inside a marked region is compared or it is moved out,
and moving it out is not available to a value that is duplicated.

Outside every marker, and gated nowhere here:

- The provenance, calculation-method and publication-status vocabularies. They
  are enumerated between marked regions, not inside them; `src/types/catalog.ts`
  spells them and `src/services/__tests__/catalog.logic.test.ts` pins them.
- The release, load and refresh procedures, and
  [`release-and-recovery.md`](./release-and-recovery.md), which owns them.
- The status tables at the head of this document, whose subject is which files
  exist and which reports an operator produced — not a bound.

Inside a marked region, and not a duplicated value:

- **The names of things.** An environment variable (`CATALOG_BATCH_SIZE`,
  `EVIDENCE_FETCH_TIMEOUT_MS`), a column
  (`catalog_validation_records.identity_evidence`), a JSON key
  (`nutritionBasisRule`, `validationBounds`, `thresholds`), a function
  (`validateEvidencePolicy`, `url.domainToASCII`, `catalogCheckTier`), a payload
  field (`foodNutrients`, `labelNutrients`), an HTTP method or an endpoint path
  names a thing; it carries no value. So do the formulas written entirely in
  those names — `max(0, candidateVolume − usdaCandidatesImported)`,
  `ceil(aiCandidates / CATALOG_BATCH_SIZE)` — whose numeric members are gated
  wherever they appear, and whose arithmetic the worked example exercises.
- **The absence of a value**, which has nothing to compare: `NULL` meaning
  unknown, an `undefined` tier, an `Infinity` a check refuses to store. The
  *rules* behind those sentences are gated — each one is paired with the plan
  flag that keeps it required — but the sentinels themselves state no bound.
- **Cited external figures**, labelled `(cited)` where they appear: the OWASP
  Cheat Sheet and Top Ten entry, the IANA registries, the RFC numbers, USDA's
  public-domain basis, the ≈ 884 kcal per 100 g of pure fat, and the kcal
  figures given for egg white and egg yolk — whose position inside the reviewed
  band *is* gated, as is the basis those figures are stated on.
- **Illustrative examples that name no contract value**: the `example.gov`
  family used to show how wildcard matching works, and the mushroom varieties
  behind the food group — the group itself is compared against the taxonomy.
- **Every sentence that argues for a bound** rather than stating one.

## Scope and the guarantee

Everything in this document describes work that happens **offline**, before a
release ships: importing USDA records, generating candidates, validating them,
freezing a release and loading it. The user-facing feature does not run any of
it.

That yields the guarantee worth stating precisely, because it is the reason the
pipeline is shaped this way: **once a release is loaded and the recipes are
seeded, plan generation, meal swaps, grocery aggregation, recipe viewing and
internal catalogue search make no live USDA call and no model call.** They read
tables. A vendor outage, an exhausted API key or a withdrawn model cannot
degrade them, and no user request pays vendor latency.

`USDA_API_KEY` and `OPENROUTER_API_KEY` keep the request-time roles they already
had — the estimate, label-scan and branded-search endpoints — and are
*additionally* required by the scripts described here. The two uses are
independent: the scripts need them to build a release, and the request path
needs them for features that are not part of meal planning.

One corollary, recorded because a reader looking for it will otherwise assume
the opposite: request-time meal planning makes **no** model call, so it is
neither metered by `ai_usage` nor gated by `AI_FEATURES_ENABLED`. The only paid
calls in this pipeline are the offline generation and review calls, metered as
described below.

## Status at this commit

| Referenced thing | State |
| --- | --- |
| `src/services/evidence.logic.ts`, `src/services/evidence.service.ts`, `data/meal-planning/evidence-allowlist.v1.json` and the attestation below | present, and cross-checked by `src/services/__tests__/evidence.logic.test.ts` on every run |
| `data/meal-planning/coverage-plan.v1.json`, `data/meal-planning/usda-manifest.v1.json`, `data/meal-planning/search-benchmark.v1.json` | present; they are the authoritative record for the plan, the import manifest and the benchmark contract |
| `src/services/catalog.logic.ts` check vocabulary, tiers and category bounds | present |
| `src/routes/catalog.routes.ts`, `src/controllers/catalog.controller.ts`, `src/services/catalog.service.ts` | present and mounted — `app.ts` registers the router after the authentication boundary, so `GET /api/catalog/foods`, `/catalog/foods/suggestions`, `/catalog/status` and `/recipes/:recipeVersionId` are live reads |
| Catalogue acceptance evidence — the per-category published counts, the shortfall and the quarantine list | **operator-produced, and committed** at `data/meal-planning/reports/latest/import-report.json` (`npm run catalog:import`) and `data/meal-planning/reports/latest/validation-report.json` (`npm run catalog:validate`, aggregated by `npm run catalog:report`). Those two artefacts are where the counts live; each one measures **one database at one moment**, which is why this document states none of them and why `GET /api/catalog/status` answers separately, live, from whichever release the database being asked has loaded. |
| The loaded release's own coverage figures | carried by `catalog/releases/v1/manifest.json`, which records the per-category published counts and the exact shortfall it was frozen with. That manifest is the measurement; this document is not. |
| Search-benchmark acceptance evidence — hit rates, zero-result rate, page sequences, p50/p95 | **operator-produced by `npm run search:benchmark`**, which runs the fixed query set against a loaded release and writes the report named by `acceptanceReport` in `search-benchmark.v1.json`. A report from such a run **is committed** at that path — `data/meal-planning/reports/latest/benchmark-report.json`, which declares `acceptanceEvidence.thisReportIsAcceptanceEvidence` — and it records a **passing** verdict: the run met all four bounds. The measured hit rates, zero-result rate and latencies are **not restated here** — the report states them beside its own `generatedAt`, together with the release and conditions it measured and no others, and that is where they are read. The bounds themselves are the contract's, not a measurement, and are stated once in the benchmark-contract block below. |
| Cross-database determinism evidence | **the runner produces it when it is given a peer**: passing `--compare-with <peer-report.json>` — the flag the runner actually declares — makes it compare itself against a report produced from a second, independently loaded database of the same release and record that peer's SHA-256 and determinism fingerprint, the per-query rank comparison, the page-sequence comparison and the two database identities in `crossDatabaseReproduction`, with latency the only figure free to differ and a disagreement failing the run; a run given no peer derives `verdict.standing` accordingly. The committed report was produced without one, so its `crossDatabaseReproduction` records `not_evaluated_by_a_single_run` together with the exact steps that produce the comparison. The second load was performed and is recorded in [`requirement-evidence-checklist.md`](./requirement-evidence-checklist.md); the committed artefact is the single-run report. |
| The synthetic-fixture benchmark suite | **present** at `src/__tests__/api/benchmark.test.ts`. The runner resolves that path with `fs.existsSync` at write time rather than reading a declared flag, and the committed benchmark report records the result as `acceptanceEvidence.nonAcceptanceSuite.presentInThisCheckout`. It exercises the mechanics only; a green run of it is still not acceptance evidence, as both that file and the report state. |

Figures live in the artefact that measured them, as above. *Which of these
commands were run, and what each one returned* is one table, in
[`requirement-evidence-checklist.md`](./requirement-evidence-checklist.md#what-was-verified-in-this-environment);
this document cites it rather than restating an outcome that would then have to
be kept in step in two places.

## Data licensing, and why a release ships inside this repository

The backend architecture guide requires the terms to be checked *before* storage
is designed, on the grounds that data retention shapes storage. Recording the
finding rather than the assumption:

**USDA FoodData Central is public domain, with no retention restrictions**
**(vendor).** `src/services/usda.service.ts` already states this in its header as
the basis for the shipped snapshot-at-log-time model, where a logged meal keeps
its own copy of the nutrient values.

Two design decisions rest on that finding, and would not survive without it:

1. **Normalising USDA records into `catalog_foods`.** A redistribution
   restriction would have forced a reference-only model — store the FDC id,
   fetch on read — which would have made every search and every plan a vendor
   call and destroyed the offline guarantee above.
2. **Shipping a checksummed release inside this repository.** `foods.jsonl` and
   its siblings contain USDA descriptions, portions and nutrient values.
   Committing them is redistribution, which the public-domain basis permits. The
   release manifest records that basis explicitly: each entry in
   `source_datasets` carries its dataset version and a `public_domain` flag, so
   the licence claim travels with the data rather than living only here.

**The finding covers the USDA data source and nothing else.** It is not a
general conclusion about nutrition data. A future provider — a commercial
database, a restaurant menu feed, a manufacturer catalogue — needs its own terms
review *before* storage is designed for it, and may well permit reference-only
storage while forbidding redistribution, in which case it cannot enter a release
at all. Model-generated records are a separate question again: they are not
redistributed third-party data, and what constrains them is the provenance model
below, not a licence.

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

<!-- BEGIN POLICY GATE: registry-row-split -->

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

<!-- END POLICY GATE: registry-row-split -->

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

<!-- BEGIN POLICY GATE: evidence-retrieval-limits -->

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
| Deadline | 10 s for the whole retrieval, from `EVIDENCE_FETCH_TIMEOUT_MS` |
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

**Fail-closed, enumerated.** "Reject on anything unexpected" is easy to write
and easy to erode, so the conditions that must reject are listed rather than
implied. Each of these ends the retrieval with the candidate quarantined:

- the DNS lookup errors, or returns an empty answer;
- any returned address does not parse as a dotted-quad IPv4 or an RFC 4291 IPv6
  text form;
- any returned address is non-unicast, or falls in a table row whose reachability
  is `false` or `n/a`;
- **a mixed answer set in which even one address is non-global** — the set is
  judged as a whole, because accepting the first global address in a set that
  also resolves to a private one is exactly the split-horizon answer an attacker
  wants;
- a range the table cannot classify at all, which is treated as a defect in the
  reviewed policy rather than as a permissive default;
- the host fails IDNA conversion, matches no allowlist entry, or matches one that
  does not authorize the claim being made.

There is no "unknown, therefore allowed" branch anywhere in that list, and the
absence is the point: an SSRF filter that guesses is a filter that can be taught
to guess wrong.

**Where this policy comes from (cited).** The scheme, port, credential, address
and redirect rules follow the **OWASP Server-Side Request Forgery Prevention
Cheat Sheet**, and the threat it addresses is **OWASP Top 10 2021 A10:
Server-Side Request Forgery**. The address table is transcribed from the **IANA
IPv4 Special-Purpose Address Registry** and the **IANA IPv6 Special-Purpose
Address Registry**, the registries established by **RFC 6890**, and the embedded
and translated IPv6 forms it unwraps are those of **RFC 4291** (IPv4-mapped, and
the deprecated IPv4-compatible prefix), **RFC 6052** and **RFC 8215** (the NAT64
well-known and local-use translation prefixes), **RFC 3056** (6to4) and **RFC
4380** (Teredo). Addresses are parsed as the RFC 4291 text forms, including the
RFC 5952 compressed notation. Reachability values are taken as the registries
state them, including `n/a`, which is why the three values are never collapsed
into a boolean.

**What a retrieval records.** One record per URL actually retrieved, stored in
`catalog_validation_records.identity_evidence`: the URL **that served the
recorded bytes** (after any same-host redirect), that URL's host, the HTTP
status, the SHA-256 of the body, the matched snippet (≤ 500 characters, `null`
when the page was fetched but the candidate's name was not found in it) and the
fetch time. Evidence that failed to corroborate is not the same thing as no
evidence, and both leave the candidate quarantined. URLs are logged at host
level, and no credentials are ever attached.

<!-- END POLICY GATE: evidence-retrieval-limits -->

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
meal is never an estimate.

### An AI review never promotes a value

The generation pass may be followed by a second-model review, whose output is
written to `catalog_validation_records.llm_review`. That field is **advisory and
only advisory**, and it is *recorded* rather than *read*: it can never raise
`nutrition_provenance`, never turn `ai_estimated` into `source_backed`, never
satisfy a check that failed, and never release a candidate a review-tier flag is
holding. Nothing reads it as evidence.

The absence is enforced by the type rather than by care. Neither
`CatalogValidationContext` nor `CatalogDispositionInput` in
`src/services/catalog.logic.ts` has a member a model answer could arrive through,
so `resolveCatalogDisposition` has no channel to consult one: the only set that
lifts a held review flag is `curatorAllowlistedCheckNames`, which a human
supplies. `catalog-validate.ts` obtains a review, counts it and writes it to
`llm_review`, and the disposition it stores beside it was computed from the row
and the policy alone.

The reason is a line this feature does not cross: **a model agreeing that a
number looks plausible is not a source for that number, and an AI plausibility
review is never presented as verified nutrition.** A second model raises
confidence and produces no evidence, so treating agreement as corroboration
would manufacture provenance out of two guesses. Consequently an AI estimate is
labelled as an estimate on every surface it reaches — catalogue search results,
food detail and the diary entry it is logged into — and the label is derived
from the stored column rather than passed in by a caller.

### `retired`, and why nothing is deleted

A food that a later release no longer carries becomes
`publication_status = 'retired'`. It is never deleted, and `catalog-load.ts` is
the only writer of that value.

Retirement is a one-way door out of *discovery*, not out of *existence*. A
retired row is excluded from catalogue search, from the dislike suggestions and
from eligibility for newly seeded recipes, so it cannot be chosen again. It stays
fully readable and fully referenceable, because two kinds of history point at it:
`recipe_ingredients` rows in already-published recipe versions, and
`meal_entries` rows in users' diaries. Deleting the food would either break those
foreign keys or silently rewrite what a user ate. Disappearing from search is
acceptable; disappearing from a diary is not.

### Nutrition is versioned, so a refresh cannot rewrite history

`catalog_foods` carries `nutrition_version` and `metadata_version`, bumped when
the nutrient values and the descriptive or safety metadata respectively change.
A recipe ingredient stores the per-100 g values it was computed from *and* the
versions they came from, so a later catalogue refresh changes the catalogue and
leaves every existing recipe version exactly as published. The recipe-side
consequence — when a stale snapshot causes a new recipe version to be published
and the previous one retired — belongs to the planning policy and is described in
[`planning-policy.md`](planning-policy.md) rather than repeated here.

## Coverage plan

`data/meal-planning/coverage-plan.v1.json` is the plan of record, and the source
of truth wherever a figure appears both there and here: the targets and bounds
transcribed below are reviewed values, kept honest by being diffed against that
file rather than trusted. It carries, per its own field names: the two totals
(`publishedTargetTotal`, `candidateVolumeTotal`), the 21 categories with their
`publishedTarget` and `candidateVolume`, the candidate-volume rule
(`candidateVolumeMultiplier`, `candidateVolumeRounding`) and the AI-candidate
formula (`aiCandidateFormula`), the batching contract (`defaultBatchSize`,
`batchKeyFormat`, `batchIndexPadWidth`, `modelCallsPerBatch`) that makes a rerun
address exactly the same batches, the prompt versions, and the controlled
`foodGroups` taxonomy that makes a dislike cover a food group without touching
unrelated ones.

<!-- BEGIN POLICY GATE: coverage-totals-and-targets -->

### Two totals, which are not the same number

Conflating these is the single easiest way to misread the plan, so they are named
separately everywhere:

| Total | Value | What it counts |
| --- | --- | --- |
| **Published target** | **11,010** (product policy) | Rows the catalogue aims to have *published* when the pipeline is done. Above the 10,000 requirement by 1,010, deliberately: quarantine decisions land late, and a target with no slack turns one batch of late quarantines into a missed requirement. |
| **Candidate volume** | **13,765** (product policy) | Rows the import and generation runs aim to *produce* for validation. `ceil(1.25 × publishedTarget)` per category, sized against a historical acceptance rate of roughly 80 %. |

The multiplier is a sizing estimate, not a promise: if acceptance runs below
80 % the shortfall is reported rather than back-filled, because the alternative —
generating until the number is reached — optimises for the count instead of for
the records.

### Per-category targets

Transcribed from `coverage-plan.v1.json`, which is the source of truth on any
disagreement. All figures are product policy. Each candidate volume is
`ceil(1.25 × publishedTarget)`.

| Category | Published target | Candidate volume |
| --- | --- | --- |
| `produce_vegetable` | 1,200 | 1,500 |
| `produce_fruit` | 700 | 875 |
| `protein_meat` | 700 | 875 |
| `protein_poultry` | 400 | 500 |
| `protein_seafood` | 600 | 750 |
| `protein_egg` | 60 | 75 |
| `protein_plant` | 350 | 438 |
| `dairy` | 600 | 750 |
| `dairy_alternative` | 250 | 313 |
| `grain` | 600 | 750 |
| `bread_bakery` | 500 | 625 |
| `legume` | 250 | 313 |
| `nut_seed` | 350 | 438 |
| `oil_fat` | 150 | 188 |
| `condiment_sauce` | 700 | 875 |
| `spice_herb` | 300 | 375 |
| `beverage` | 600 | 750 |
| `snack` | 600 | 750 |
| `sweet` | 500 | 625 |
| `prepared_meal` | 1,400 | 1,750 |
| `other` | 200 | 250 |
| **Total** | **11,010** | **13,765** |

<!-- END POLICY GATE: coverage-totals-and-targets -->

<!-- BEGIN POLICY GATE: batching-contract -->

### How a category becomes a set of batches

USDA is imported first, because a sourced record beats a generated one; model
generation only fills what USDA did not cover. Per category:

1. **AI candidates** = `max(0, candidateVolume − usdaCandidatesImported)`. A
   category USDA already covered yields zero, and is kept in the plan with a zero
   rather than dropped, so the run report shows it was considered rather than
   forgotten.
2. **Batch count** = `ceil(aiCandidates / CATALOG_BATCH_SIZE)`, the batch size
   defaulting to the plan's own `defaultBatchSize` of 25 (product policy). The
   final batch carries the remainder rather than being padded out.
3. **Batch key** = `<coveragePlanVersion>:<category>:<batchIndex>`, the index
   zero-based and zero-padded to four digits.

Worked example — `protein_plant`, in the case where USDA contributed nothing to
it. AI candidates = 438 − 0 = 438; batches = `ceil(438 / 25)` = **18**, indexed
`0`–`17`; the first seventeen hold 25 candidates each and the tail batch holds
`438 − 17 × 25` = **13**. Its key is `v1:protein_plant:0017`.

The keys are derived, never recorded incidentally, and that is what makes a
rerun safe: an interrupted run resumes by addressing the same keys, so it
continues the same eighteen batches instead of starting a nineteenth. Changing
the batch size would re-cut every key and turn a resume into a restart, which is
why a malformed `CATALOG_BATCH_SIZE` fails the run rather than falling back.

<!-- END POLICY GATE: batching-contract -->

<!-- BEGIN POLICY GATE: food-group-taxonomy -->

### The food-group taxonomy, and what it is for

`coverage-plan.v1.json` carries a controlled taxonomy of **123** `foodGroup`
values (product policy), each belonging to exactly one category, and every
published food carries exactly one of them. 31 are marked
`isCommonDislikeGroup`, which is what seeds the suggested dislikes during setup.

The taxonomy exists for one behaviour that a free-text approach cannot deliver
safely. When a user says they dislike mushrooms, the preference stores both the
food id they picked *and* its `foodGroup`, so planning excludes every food in the
`mushroom` group — white, portobello, shiitake — and **nothing outside it**. Name
matching would either miss the varieties it did not think of or over-exclude on a
shared substring, and a dislike that quietly removes an unrelated food is a
correctness bug the user cannot diagnose.

<!-- END POLICY GATE: food-group-taxonomy -->

### Shortfall is reported exactly

Per-category shortfall is `max(0, publishedTarget − published)`, **reported
exactly and never rounded**, by `npm run catalog:report`. Per category the run
reports `candidates`, `aiCandidates`, `batches`, `published`, `quarantined` and
`shortfall`.

A shortfall is an **unmet requirement**, and reporting it plainly is the required
behaviour rather than a fallback. Nothing in the pipeline may respond to one by
relaxing a validation bound, publishing a quarantined row or generating filler:
those would each convert a visible gap into an invisible quality loss. It is that
report, not this document, that states whether a target was met.

## Metering the model calls

The backend architecture guide requires metering *before* spending, and states
the reason: **a failed call still costs tokens, so failures must not become free
retries.** The shipped request-time analogue is `entitlement.service.ts`, which
consumes a user's daily quota before the model call rather than after it.

`scripts/lib/budget.ts` keeps that same order at operator scope. Around every
OpenRouter call the pipeline makes:

1. **Reserve** one call against the run's budget, recorded in
   `catalog_generation_batches.model_calls_reserved`, *before* the call is made.
2. **Spend** it.
3. **Record** the outcome in `model_calls_used` and `tokens_used`.

Because the reservation lands first, a call that fails has still been paid for in
the ledger, and a retry costs another reservation. Reservations are summed per
run, so an interrupted run that resumes continues against the same remaining
budget rather than a fresh one — the spend is not forgiven by the interruption.

<!-- BEGIN POLICY GATE: model-call-budget -->

`CATALOG_MODEL_CALL_BUDGET` is the hard cap, and generation and review calls
share it (`modelCallsPerBatch` is 2). It is a **required positive integer with no
default**: missing, blank, non-numeric or ≤ 0 fails the run closed at startup.
That deliberately parts company with the per-user quota, which falls back to a
small default, and the asymmetry is the argument: a missing per-user quota
degrades one request gracefully, whereas a missing spend cap on an unattended run
that makes thousands of paid calls has no safe fallback — any number the module
invented would be a spending decision it is not entitled to make.

Two gates follow from the cap:

- **At startup**, before the first vendor call, the planned cost
  (`2 × Σ batches`) is estimated and logged unconditionally, and the run fails
  closed if it would exceed the cap. A run that cannot afford to finish should
  not start and spend most of the money first.
- **Mid-run**, a reservation that would cross the cap stops the run with
  `budget_exhausted`.

<!-- END POLICY GATE: model-call-budget -->

Failures are typed and carry their figures rather than a message, following the
`DailyQuotaError` template: `budget_misconfigured`, `budget_insufficient`,
`budget_exhausted`, `batch_not_found` and `batch_run_mismatch`, each carrying the
limit and the reservations already made. The last two are separate codes on
purpose — "nothing was reserved under this key" and "this key belongs to another
run" are different operator mistakes with different fixes.

**Rule versus reality, stated because a reviewer will look for it.** The guide's
metering is per-user and request-scoped (`ai_usage`, keyed by the verified token's
claims), and these scripts have no user: they run for an operator, from a
terminal, with no request. The *order* is what transfers, not the ledger, so the
budget is operator-scoped and lives with the run. And the corollary from the scope
section holds in the other direction: request-time meal planning makes no model
call at all, so it is neither metered by `ai_usage` nor gated by
`AI_FEATURES_ENABLED`. No user-facing meal-planning request can spend a token.

## The vendor boundaries

Both vendors are reached through one module each, configured once at the module
boundary, with failures translated into an error of our own. Callers depend on
those modules' exported functions and never on a vendor SDK, a vendor error shape
or `process.env`.

The same instinct explains why the bounds in this document live in reviewed JSON
rather than in the predicates that apply them. **Every validation bound arrives
as a parameter**: `catalog.logic.ts` is handed the policy — the category bands,
the tolerances, the basis rule — and reads no environment variable and no file of
its own. An integration or a limit is therefore *chosen at the boundary*, by the
script or the service that has already loaded the plan, and never by a branch on
the environment buried inside a decision. Two things follow that are worth having:
the rules are unit-testable by handing them a policy, and changing a bound is a
reviewable data change rather than a code edit.

### OpenRouter — `src/services/openrouter.service.ts`

Extracted so that the request-time AI endpoints and these offline scripts share
one transport rather than maintaining two. It satisfies the guide's integration
rules in the two places that matter:

- **Config is read once, behind an accessor that fails loudly.**
  `getOpenRouterConfig()` resolves the key and the model names once and throws
  `OpenRouterError('not_configured', …)` when the key is absent, rather than
  sending an unauthenticated request and reporting whatever the vendor says about
  it. Model precedence is resolved there too, so neither the estimate judge nor
  the catalogue review pass decides it independently.
- **Vendor failures are wrapped in our own typed error.** `OpenRouterError`
  carries a `kind` — `not_configured`, and the transport, empty-response,
  timeout, network and unparseable cases — plus the HTTP status where there was
  one. Callers branch on `kind`; nothing pattern-matches an OpenRouter response
  body.

The catalogue then maps `OpenRouterError` into its **own** `CatalogGenerationError`
(a typed `code` plus context), and the reason is worth recording because the
mapping looks redundant until you ask what the alternative would be. The obvious
shortcut is to reuse the estimate feature's `EstimateFailedError`, since it
already exists and already wraps model failures. That would make the offline
catalogue depend on an estimate-domain error — a batch of catalogue candidates
failing would raise "estimate failed", which is untrue and unloggable — and it
would couple the two, so a change the catalogue wanted would alter the request
path. The estimate service keeps translating the same `kind`s into
`EstimateFailedError` with its existing status codes and messages **unchanged**;
the extraction moved the transport and left every client-visible behaviour where
it was.

### USDA FoodData Central — `src/services/usda.service.ts`

The sole vendor path for the import: `catalog-import-usda.ts` issues no fetch of
its own, so the retry policy, the deadlines, the caching and the key handling
exist in exactly one place. `getApiKey()` is the same loudly-failing accessor
pattern, throwing `UsdaError` rather than sending an unauthenticated request, and
vendor failures surface as `UsdaError`.

<!-- BEGIN POLICY GATE: usda-vendor-limits -->

**The rate limiter sits in the script process, not in the service**, and that
placement is the interesting decision. USDA allows **1,000 requests per hour per
key (vendor)**; `USDA_IMPORT_RATE_LIMIT_PER_HOUR` defaults to **900 (product
policy)**, leaving 100 an hour on the same key for the running API's estimate,
label-scan and branded-search traffic — the import must not starve the live
service.

**That number is an enforced ceiling as well as the default, and an operator
planning a faster run needs to read it that way.** Configuring the variable
above **900 (the import ceiling, product policy)** does not raise the pace: it
is **refused at startup**, before a single request is paced, by the one accessor
that reads the variable — a `RateLimitConfigError` naming the offending value,
the ceiling it broke and the reservation the remaining allowance exists for. The
importer's own preflight reports the same refusal as the gap code
`usda_rate_limit_misconfigured`, whose remedy is to set a positive integer no
greater than that ceiling or to unset the variable and take the ceiling as the
default. Only a lower value is accepted, and a lower value only paces the import
more gently; nothing can raise it, which is precisely what keeps the headroom
above reserved for the live service. A value inside the vendor's cap but above
the ceiling is refused for that reason and not because USDA would throttle it.

The service keeps its own retry behaviour of up to four physical
attempts per logical call, so counting *logical* calls would undercount by up to
four times. The limiter therefore wraps `globalThis.fetch` for the USDA host
**inside the script process**, where every physical attempt — including retries
after a 429 or a 5xx — consumes a token, while the API process is left untouched.
When the bucket empties the import **pauses rather than fails**: the rate limit is
a pace, and a long import legitimately outlasts one hour.

Two vendor request shapes bound the import: batch detail fetches take at most
**20 FDC ids** and list pages at most **200 rows** (both vendor). The batch fetch
is a `POST`, which forced a widening of the response cache: keys must be aware of
the method *and* the request body, with the ids sorted and de-duplicated, so two
different batches — or the same batch in a different order — can neither collide
nor be served each other's response. Existing `GET` keys are byte-identical to
what they were, so nothing already cached was invalidated by the change.

Nutrient numbers are read from USDA's data dictionary — **203** protein, **204**
fat, **205** carbohydrate, **208** energy in kcal (vendor) — and the two nutrient
shapes are never mixed: the per-100 g `foodNutrients` array is what this import
reads, while the detail endpoint's `labelNutrients` are already per serving.
Reading one as the other would be wrong by the serving weight and would look
plausible.

<!-- END POLICY GATE: usda-vendor-limits -->

## The nutrition basis rule

<!-- BEGIN POLICY GATE: nutrition-basis-rule -->

A publishable food states its nutrients **per 100 g**, or **per 100 ml together
with a density** — millilitres never equal grams, so a volume basis without a
stored density is not convertible and is quarantined with `missing_density`. It
also carries **exactly one** default portion, whose gram weight is **sourced**.

A `per_serving`-only record whose serving has no sourced gram weight is
therefore **quarantined** with `missing_gram_weight`. It is neither published nor
searchable, and it never counts toward a target. The reason is that publishing it
would require **inventing** the gram weight: without one, "one serving" cannot be
converted to the per-100 g basis the recipe arithmetic and the grocery
aggregation both need, and any number chosen to fill the gap would be a fabricated
value presented with the same confidence as a sourced one. The manifest states
the same rule from the import side — a portion selector that resolves to nothing
is quarantined rather than published, for the same reason.

**Which writer can produce such a row is worth stating plainly, because neither
build stage can.** `catalog:import` reads USDA's per-100 g `foodNutrients` array
and `catalog:generate` asks the model for per-100 g values, so both write
`per_100g` into `nutrition_basis` and nothing else; the excluded basis reaches
the catalog only through `catalog:load`, which takes each row's basis from the
release JSONL as the release recorded it, or through a row inserted into the
table by hand. The check therefore guards **what a release load brings in and
what `catalog:validate` re-judges afterwards**, not importer or generator output
whose basis is fixed at the source. Validation is what makes that guard bite: it
reads every `candidate` and `published` row (and `quarantined` rows as well
under `--revalidate-quarantined`, or when the run already owes them a review),
so a loaded row whose serving carries no gram weight is judged on the next pass
and taken back out of the published set even though the release line asserted
`published` — `catalog:load` restores each line's stored status rather than
re-deciding it, and this stage decides it afterwards. None of that relaxes the
rule: `validateCatalogCandidate` applies the same judgement to every row it
reads, whatever wrote it, and a release produced by an older or a foreign
pipeline is the realistic way this tier fires in practice.

This is also why the report lists **quarantined counts per category** beside the
published counts: a category can miss its target because the records were not
found or because they were found and quarantined, and those call for different
work. Reporting them separately keeps the shortfall truthful rather than merely
unflattering. `nutritionBasisRule` in `coverage-plan.v1.json` states the rule in
data, including the four required nutrients (calories, protein, carbohydrate,
fat).

One distinction inside that rule carries more weight than its size suggests. A
nutrient that is `NULL` means **unknown**, and is **never coerced to 0**. The
four core nutrients being unknown quarantines the row with
`missing_core_nutrient`; any *other* nutrient may legitimately stay unknown and
is stored as `NULL`. Coercing an unknown to zero would be the most damaging
rounding in the pipeline, because zero is a *claim* — "this food contains no
fibre" — presented with the same authority as a measured value, and every total
computed from it would be quietly wrong in the direction that looks healthiest.

<!-- END POLICY GATE: nutrition-basis-rule -->

## Validation checks and bounds

Every deterministic check is recorded on the row it judged, with its observed
value, its bound and its **tier**, and the tier decides the row's
`publication_status`. The tiers use the existing status values; **no new
publication status is introduced by validation.**

- `reject` — physically impossible. The row is `rejected` and is never
  publishable.
- `quarantine` — unusable until more data arrives. The row is `quarantined` and
  is re-validated on the next run.
- `review` — plausible but atypical. A USDA-sourced row publishes with the flag
  recorded, because the source is authoritative and the flag is informational; an
  AI-generated row stays quarantined until a curator allowlists the flagged
  check.

That asymmetry in the `review` tier is deliberate. An unusual value from USDA is
evidence about an unusual food, and suppressing it would discard real records
(the same ranges would drop egg yolk and dry rice). An unusual value from a model
is more likely to be an error than a discovery, because a model has no
measurement behind it. So the *flag* is identical and the *consequence* differs
by `identity_source`: the row is annotated either way, and only the unsourced one
waits for a curator to allowlist `out_of_category_range`.

A curator is the only route out, and deliberately the only one. The advisory
review is recorded beside such a row and decides nothing about it (see *An AI
review never promotes a value*): a second model agreeing that an atypical value
looks plausible would otherwise be the thing that published AI-derived nutrition,
which is precisely what this feature does not do.

<!-- BEGIN POLICY GATE: catalog-check-tiers -->

### The checks in each tier

As `src/services/catalog.logic.ts` emits them — `CATALOG_CHECK_NAMES` for the
vocabulary, `catalogCheckTier` for the tier, and the per-tier lists derived from
that map rather than written out, so a new check without a tier is a compile
error rather than an `undefined` tier reaching a record.

**`reject`** — `nutrient_not_finite`, `nutrient_negative`,
`invalid_basis_amount`, `unknown_category`, `kcal_ceiling`,
`macro_mass_ceiling`, `energy_macro_mismatch`, `portion_conversion_drift`,
`brand_pattern_name`, `empty_component_set`, `invalid_component_quantity`,
`non_finite_computed_value`, `unknown_tag_code`, `inconsistent_tag_set`.

`non_finite_computed_value` is worth distinguishing from
`nutrient_not_finite`: every stated value is individually finite and it is their
product or sum that is not, so an operator sent to look for a non-finite nutrient
would find none. It rejects rather than quarantines because the alternative is
worse than rejection — an unguarded overflow stores a false zero, or writes
`Infinity` into an observation that JSONB cannot hold and JSON serialisation
turns into `null`, leaving an audit record that claims the check observed nothing.

`unknown_tag_code` and `inconsistent_tag_set` judge the two SAFETY tag lists
against the closed vocabularies `CATALOG_ALLERGEN_TAGS` (`milk`, `eggs`,
`peanuts`, `tree_nuts`, `soy`, `wheat`, `fish`, `shellfish`, `sesame` — the
spellings `preferences.logic.ts` stores from the user's own selection) and
`CATALOG_DIET_TAGS` (`vegan`, `vegetarian`, `pescatarian`, `gluten_free` — the
spellings `recipe.logic.ts` emits). Both lists are matched BY CODE downstream:
the planner excludes on the user's selected allergens and derives diet
compatibility from the ingredient tags, so a code no consumer can match is
silently equivalent to claiming no allergen and no diet at all. That is the
unsafe direction, and no later data corrects it, so an off-vocabulary entry —
including a blank string or an entry that is not a string — rejects rather than
waits.

`inconsistent_tag_set` rejects a diet claim the food's own allergen list refutes,
under `CATALOG_DIET_TAG_EXCLUSIONS`: `vegan` excludes `milk`, `eggs`, `fish` and
`shellfish`; `vegetarian` excludes `fish` and `shellfish`; `gluten_free` excludes
`wheat`. A food carrying `milk` is not vegan whichever of its two lists is wrong,
so the record cannot be true as written. It is deliberately NOT an implication
closure — `vegan` without `vegetarian` is incomplete rather than false, and
`recipe.logic.ts` closes a derived tag set under `DIET_TAG_IMPLICATIONS` — and
`pescatarian` with `fish` is legitimate rather than contradictory. Each check is
omitted from a record rather than recorded as a pass when its input is
unavailable: `unknown_tag_code` needs at least one list, and
`inconsistent_tag_set` needs both, because it is a statement about their
agreement.

The same rules are exported as the pure `classifyCatalogTagSets`, so the
generation stage can refuse a candidate AT PARSE TIME — one candidate lost
instead of a stored value that costs a re-validation and a re-release — and can
build its prompt's JSON-schema `enum`s from the same two arrays this tier judges
against. The validation record is the audit trail; the parse-time refusal is the
gate, the same division `brand_pattern_name` already has.

**`quarantine`** — `missing_gram_weight`, `missing_density`,
`missing_core_nutrient`, `unsupported_portion`, `default_portion_count`,
`unsourced`, `duplicate_identity`. This list is also stated as data in the
coverage plan's `quarantineChecks`, and `catalog-validate.ts` asserts the two are
equal, so adding a quarantine-tier check in code is also a reviewed data change.

Two of these carry a decision rather than just a condition.
`duplicate_identity` — another candidate already holds this canonical name and
food state — resolves by **merging the duplicate as an alias of the survivor**
rather than publishing twice, so the second name stays searchable while the
catalogue keeps one row per food. And `default_portion_count` is recorded as a
check rather than left to the database, even though a partial unique index
already forbids a second default portion: as a database error it would abort the
run's transaction for a candidate the validator had called publishable, whereas as
a check it becomes an auditable verdict an operator can group and fix.

**`review`** — `out_of_category_range`, `allergens_unknown`.

<!-- END POLICY GATE: catalog-check-tiers -->

<!-- BEGIN POLICY GATE: validation-bounds-and-review-ranges -->

### Global bounds

From `validationBounds` in `coverage-plan.v1.json`; all product policy, and
engineering guardrails rather than nutritional guidance.

| Bound | Value | Rejects when |
| --- | --- | --- |
| Energy ceiling | 900 kcal per 100 g | Above it. Pure fat is about 884 kcal per 100 g, so nothing edible exceeds this. |
| Macro-mass tolerance factor | 1.02 | Protein + carbohydrate + fat weigh more than the food does, allowing 2 % for rounding in the source. |
| Absolute energy tolerance | 30 kcal | Used as `max(30 kcal, T %)`, so small totals are not rejected for a rounding difference. |
| Portion-conversion tolerance | 5 % | Per-100 g values and the stated portion values disagree by more, where a gram weight exists to compare them. |

### Per-category review ranges and tolerances

Transcribed from `categories[]` in `coverage-plan.v1.json`
(`kcalReviewRange`, `kcalReviewRangeByFoodState`, `energyMacroTolerancePercent`);
that file is the source of truth on any disagreement. All product policy, and not
nutritional guidance. The range is a **review** bound — outside it a row is
flagged, and only an AI-generated row is withheld — while `T` feeds the
**reject**-tier energy-versus-macro check.

| Category | kcal/100 g review range | `T` |
| --- | --- | --- |
| `produce_vegetable` | 5–150 | 30 % |
| `produce_fruit` | 15–350 | 30 % |
| `protein_meat` | 80–450 | 15 % |
| `protein_poultry` | 80–350 | 15 % |
| `protein_seafood` | 50–350 | 15 % |
| `protein_egg` | 40–350 | 15 % |
| `protein_plant` | 50–500 | 20 % |
| `dairy` | 30–450 | 15 % |
| `dairy_alternative` | 10–300 | 25 % |
| `grain` | 80–400 — by food state: `dry` 300–400, `cooked` 80–200 | 15 % |
| `bread_bakery` | 200–450 | 15 % |
| `legume` | 60–400 — by food state: `dry` 300–400, `cooked` 60–200 | 20 % |
| `nut_seed` | 450–700 | 12 % |
| `oil_fat` | 700–900 | 8 % |
| `condiment_sauce` | 0–600 | 30 % |
| `spice_herb` | 0–400 | 40 % |
| `beverage` | 0–120 | 40 % |
| `snack` | 200–600 | 15 % |
| `sweet` | 150–600 | 20 % |
| `prepared_meal` | 50–400 | 20 % |
| `other` | 0–900 | 30 % |

`grain` and `legume` are the two categories whose range is split by
`food_state`, because cooking triples the water content: dry rice and cooked rice
differ by roughly a factor of three, and one band wide enough to hold both would
flag neither when a genuinely wrong value fell between them. The narrower
per-state bands are what make the check meaningful for them, and the wide
category band remains for a row whose state is not one of the two.

The tolerances differ per category for the same kind of reason. Fibre and organic
acids contribute energy that `4/4/9` arithmetic does not predict, so produce and
spices get 30–40 %; oils are almost pure fat and should reconcile almost exactly,
so `oil_fat` gets 8 %.

**The ranges are deliberately wide, and are not rejections.** They exist to flag
oddities rather than to exclude real foods, which is why each band comfortably
contains its category's genuine extremes. The concrete cases the unit tests pin,
each of which must **publish** from USDA data: **egg white** (around 52 kcal) and
**egg yolk** (around 322 kcal), both inside `protein_egg`'s 40–350; and **cooked
rice** and **dry rice**, each inside its own `grain` per-state band. A change that
tightened these ranges into plausible-looking narrower ones would fail on exactly
those four.

<!-- END POLICY GATE: validation-bounds-and-review-ranges -->

## The release artefact, and how it is loaded

A catalogue is not regenerated per environment. It is produced once, reviewed,
and then loaded — so that what a user searches is a reviewed artefact rather than
whatever the vendors and the model happened to return the day that environment
was set up.

### What `catalog:release` freezes

Into `data/meal-planning/catalog/releases/v<N>/`: five JSONL data files — foods,
aliases, portions, components and validation records — plus a `manifest.json`
carrying

- the release id and manifest version, the coverage-plan version it was built
  against, the producer and the timestamp;
- **per file, a measured SHA-256, row count and byte size** — measured from the
  bytes actually written, never declared ahead of them;
- aggregate counts per member;
- the **source dataset versions** with their public-domain basis recorded per
  dataset (§ *Data licensing* above);
- the model and prompt versions, which are `null` for a release no generation
  contributed to — a USDA-only release says so rather than implying a model
  touched it;
- a **measured coverage block**: per-category published counts and the exact
  shortfall the release was frozen with, never rounded and never omitted.

Three things are deliberately **absent from every emitted row**: the database
`id` (a local identity that would be meaningless, and misleading, in another
database), the generated search column (a `STORED` column the target database
derives for itself), and any user id — the catalogue tables carry none, and an
export is the one operator-scoped read in a codebase where every other query is
user-scoped. No credential is recorded anywhere in a release.

### What `catalog:load` does

- **Verifies every file's checksum against the manifest before anything is
  written.** A tampered or truncated release is refused while the database is
  still untouched, rather than half-applied.
- **Upserts foods by their stable `source_key`**, so loading the same release
  twice is a no-op rather than a duplicate set.
- **Replaces each food's aliases, portions, components and validation record
  wholesale, inside that food's own transaction**, remapping component references
  from release keys to local ids. Wholesale replacement is what makes a reload
  converge: merging would leave a child row that a later release removed.
- **Retires** a published food a newer release does not carry, rather than
  deleting it (§ *`retired`* above). This script is the only writer of that
  value.
- **Verifies the row counts after the load equal the manifest's.** If they do
  not, the run is recorded **failed** and the active release pointer is **not
  moved** — so a partial load never becomes the catalogue anyone is reading, and
  there is nothing to roll back. Re-running over a correct release repairs it.

### The active release pointer

Defined precisely, because "the loaded release" is otherwise ambiguous: it is the
**most recent release-load run row whose status is succeeded**. A failed load
therefore cannot become it — the pointer simply stays on the previous good
release — and that row is what `GET /api/catalog/status` reports as the release
in effect.

### The operating rule

**`catalog:load` is the only path that populates a non-development environment.**
A new catalogue version is produced on a development machine, reviewed as a new
release directory in a pull request, and then loaded. No environment regenerates
a catalogue from live vendor or model output, which is what makes two environments
comparable at all and what keeps an unreviewed model response out of a database
users read. Loading into anything but a database whose own NAME says development
additionally requires the operator to name the target database on the command
line, so it cannot happen by an inherited environment variable — and a local
database that is development by its host alone counts as "anything but", because
that classification covers every database answering on loopback, a deployment
database among them.

The four stages that produce a catalogue enforce the same rule from the other
side: `catalog:import`, `catalog:generate`, `catalog:validate` and
`catalog:release` are `development_or_test` in the database guard, so they run
only against a development-by-name or `_test` database and carry no confirmation
flag at all. Building a catalogue in a shared environment is therefore not a
discouraged option, it is a refused one. The operator sequence lives in
[`release-and-recovery.md`](release-and-recovery.md).

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
in the runner, because lowering one is how a failing benchmark turns green.

### What search promises

The contract the benchmark measures, as `catalog.service.ts` implements it:

- **Published rows only.** Every retrieval branch filters on
  `publication_status = 'published'`, so candidate, quarantined, rejected and
  retired rows are unreachable through search.
- **One row per canonical food.** A food's own name and each of its aliases are
  scored separately, then aggregated with `MAX(rank)` grouped by food. A food
  with five matching aliases therefore appears **once**, ranked by its
  best-matching alias — an alias improves a food's position and never adds a
  duplicate. The result total counts distinct foods over the same contributions,
  so the count and the pages agree.
- **Ordering:** rank descending, then display name, then `source_key` — both text
  keys compared under the `C` collation.

The `source_key` tiebreaker is the part worth explaining, because it looks like
an arbitrary third key. It is the only candidate that is **portable**: a database
`id` is assigned locally, so ordering by it would give two databases loaded from
the same release different page sequences. With a portable final key, the same
release loaded anywhere produces the same order — which is precisely what makes
release determinism *observable*, and it is why both text keys pin a collation
rather than inheriting the database's default (a property of how that database was
created, not of the release; the two orders genuinely differ).

<!-- BEGIN POLICY GATE: benchmark-contract -->

### The thresholds

Transcribed from `thresholds` in `search-benchmark.v1.json`, which is the source
of truth on any disagreement. All product policy.

| Threshold | Bound |
| --- | --- |
| Top-3 hit rate | ≥ 0.90 |
| Top-10 hit rate | ≥ 0.97 |
| Zero-result rate | ≤ 0.03 |
| p95 latency | ≤ 150 ms, measured at a page limit of 25 |

**The verdict is fail-closed**: a missed threshold exits non-zero, and a run that
measured nothing writes no report, so neither an absent nor a stale report can be
read as a pass. A report recording a miss is a record of an **unmet requirement**,
not evidence of one.

### The protocol

Stated precisely enough to reproduce: **one untimed warm-up pass**, then **three
timed passes**, **sequential**, on **one connection**, timed **in process**
around the search service function.

Each of those is load-bearing. The warm-up is untimed so the timed passes measure
the steady state the report claims rather than a cold read of the index. The
stopwatch sits on the service function rather than on an HTTP round trip so the
figures exclude network, Express and JSON-serialisation time and stay comparable
across machines. One connection and no concurrency so a percentile describes the
query rather than queueing behind other queries.

Expectations name a food by its stable `source_key`, resolved to the local id
after the release is loaded — never by an environment-local id. A key that does
not resolve is a **hard failure of the whole run**: it is never skipped and never
scored as a miss, because an unresolvable expectation means the query set and the
loaded release disagree about what is published, and no hit rate can describe
that.

The report records the conditions it was taken under: the release checksum, the
PostgreSQL version, host CPU and memory, shared buffers, the warm-cache
condition, and both the pinned ordering collation and the database's default
collation. The last pair is what makes a cross-database comparison readable —
two runs whose ranks and page sequences match *while their default collations
differ* is evidence the order belongs to the release, whereas two runs that agree
because both databases were created identically evidence nothing.

### The pagination check

For each of a fixed set of queries, pages 1–3 fetched at limit 25 (offsets 0, 25
and 50) must concatenate to the first 75 food ids of a single wider fetch of the
same query, in the same order, with no id repeated and none missing.

The one non-obvious detail: that 75-row reference is read **in process**, because
`GET /catalog/foods` validates `limit` as 1–50 and would answer `400
invalid_request`. The cap is an HTTP contract enforced in the pagination helper,
and the search service deliberately does not clamp, so the invariant is
expressible in process and not over the endpoint. Two tempting shortcuts are
both wrong: lowering the reference to 50 weakens the invariant to two pages, and
routing it through the endpoint cannot express it at all.

<!-- END POLICY GATE: benchmark-contract -->

### Where acceptance evidence lives

The runner is `scripts/search-benchmark.ts` (`npm run search:benchmark`), and the
report it writes — named by `acceptanceReport` in the same file — **is** the
acceptance evidence. That report is produced by an operator run against a loaded
release, so no measured rank, hit rate or latency appears in this document; read
the report for what a run measured and whether it met the bar.

**A Jest run is never acceptance evidence.** The synthetic-fixture suite
`src/__tests__/api/benchmark.test.ts` is present in this checkout, and it
exercises the benchmark *mechanics* — exact match-set sizes, the full ordering
rule including a pair that ties on rank and again on display name so the
`source_key` tiebreaker is what decides, and three-page traversal over match sets
large enough to fill the pages — against a deterministic synthetic corpus whose
keys are prefixed so no row of it can be mistaken for release data. It can
therefore be green while real search quality is unmeasured, which is exactly why
it is labelled non-acceptance in both that file and the query set.
`src/__tests__/scripts/search-benchmark.test.ts` is non-acceptance for the same
reason one level up: it proves the runner's own rules — the ones below — over
fakes, and proves nothing about search quality.

### What a run must satisfy before its report may be cited

Four rules decide whether a report is acceptance evidence at all, and each one
exists because a report that broke it would still have looked like evidence.
They are enforced by the runner, not by review, and each carries its own error
code.

- **The report describes the release it names.** Before the warm-up pass the run
  reads the active release — the newest succeeded `release_load` run, the same
  pointer `GET /api/catalog/status` reports — and refuses unless it is the
  release the query set names (`release_not_loaded`, `release_mismatch`). It then
  compares every count in that release's manifest with the live published graph
  and refuses on any disagreement (`release_counts_disagree`), so a partially
  applied load cannot be measured and filed under the release it was meant to
  be.
- **The report describes ONE committed catalog state.** The run holds the catalog
  graph's shared stage lock — the same lock every mutating stage takes
  exclusively — for its whole lifetime, and re-reads the release pointer and all
  six counts after the last measurement. A corpus that moved is
  `corpus_moved_during_run` and **no report is written**: unlike a missed
  threshold, figures taken across two catalog states are not a measurement of
  anything.
- **Acceptance standing is derived, never declared.** A run deviating from the
  committed protocol — a `--passes` override, a datasource pool limit that
  differs from the contract's or could not be read back, or a missing stage lock
  — records `verdict.standing: diagnostic_only` and
  `thisReportIsAcceptanceEvidence: false`, lists what differed under
  `acceptanceEvidence.protocolDeviations`, and is **refused outright** if it
  targets the committed artefact path (`diagnostic_run_to_acceptance_path`). A
  one-pass diagnostic therefore cannot overwrite the acceptance report or be
  cited as one.
- **A threshold is compared against the measurement, not against its display
  form.** The three rate bounds are decided by integer arithmetic over the
  counts and the latency bound against the unrounded percentile; the rounded
  figures in the report are for reading, and every check also carries
  `measuredExact`. A rate that would round onto its bound from below fails.

Beyond the thresholds, three structural invariants fail the run with their own
codes: paging that repeats or drops an id
(`pagination_invariant_failed`), a rank or match-set total that moves between
the timed passes (`rank_unstable_across_timed_passes` — an ordering that is not
total cannot be reproduced anywhere, so it is raised rather than averaged away),
and a cross-database comparison that disagrees
(`cross_database_reproduction_differs`).

### How release determinism is evidenced

Release determinism is a property of two runs, so one run cannot assert it. The
procedure is: load the same release into a second, independently created
database, run the benchmark there with `--out <second-report.json>`, then run it
against the first database with `--compare-with <second-report.json>`.

The comparison is recorded in the committed report's
`crossDatabaseReproduction` block and is machine-readable: the peer report's
SHA-256 and its `determinismFingerprint` (a digest over every query's rank,
full-result-set position, match-set total, matched `source_key` and within-run
rank stability, and over both portable page sequences of every pagination
query), the per-query rank comparison, the page-sequence comparison, and the two
database identities. Ranks and page sequences must be identical and only latency
may differ, so a disagreement fails the run through the
`cross_database_reproduction_differs` invariant.

Three input conditions are refused before a comparison is allowed to mean
anything, because each of them would otherwise produce an `identical` outcome
that asserts something the two runs cannot support.

- **The two reports must describe two databases.** Each records the PostgreSQL
  system identifier and database oid it read — an opaque fingerprint carrying no
  name, host or connection string. The relationship between them is three-valued
  (`same`, `distinct`, `unverifiable`) and only `distinct` proceeds: a
  comparison of a database with itself is refused
  (`compare_report_same_database`), and so is a pair in which either side could
  not read either component (`compare_report_identity_unverifiable`). An
  unreadable identity is not evidence of difference, so on a server that
  restricts `pg_control_system()` the run refuses rather than presenting a
  self-comparison as second-database evidence. The relationship the run
  established is recorded as `identityRelationship`.
- **Both runs must be protocol-eligible.** The peer must carry
  `verdict.standing: acceptance_evidence`, must have had stable ranks across its
  own timed passes, and must have passed its own pagination check; the run doing
  the comparing must itself carry no protocol deviation. Otherwise the run is
  refused with `compare_report_not_protocol_eligible`. A one-pass or unlocked
  run cannot establish within-run rank stability, so it cannot contribute to a
  claim about the release. Missing either relevance threshold does **not** make
  a report ineligible — a threshold miss is a valid measurement of an unmet
  requirement, and the committed reports are exactly that.
- **This run's own invariants must have held.** When the comparing run's ranks
  moved between its timed passes, or its pagination check failed, the outcome is
  `not_established` rather than `identical`: the per-query comparison is still
  recorded and auditable, but an ordering that is not total within one run
  cannot be a property of the release. This case does not raise
  `cross_database_reproduction_differs` — the underlying invariant already fails
  the run, and a second code for the same fact would misdescribe it.

Page sequences are compared as `source_key`s rather than ids for the reason the
tiebreaker exists: an id is assigned locally, so two databases loaded from one
release would disagree about it while agreeing about everything that matters.

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

## What this policy does not promise

<!-- BEGIN POLICY GATE: usda-rate-limit-recap -->

The coverage plan states a target, not an outcome. Reaching the published target
depends on things this document cannot guarantee:

- **the USDA rate limit** — 1,000 requests an hour per key (vendor), of which the
  import uses at most 900, so a large import takes the time it takes and can be
  cut short;
- **OpenRouter availability** during offline seeding, and the model call budget
  the run was given;
- **identity evidence passing the checks** — a candidate whose evidence cannot be
  retrieved and matched under the SSRF policy stays quarantined, however
  plausible its numbers look.

<!-- END POLICY GATE: usda-rate-limit-recap -->

Where a target is not reached, the **shortfall is reported exactly** — per
category, unrounded — and treated as an **unmet requirement**. It is never
filled. Not by relaxing a bound, not by publishing a quarantined row, not by
generating records to make a count, and not by writing a plausible number into a
document. The same applies to the search thresholds: they are the bar, the run is
fail-closed, and the committed report states what was measured against them — at
this commit that report records a bar **not yet met**, which is the honest state
rather than a rounding of it.

And the hard line on invention, which no shortfall justifies crossing: **no
brand, product variant, restaurant item or barcode is ever invented.** Generation
proposes generic foods and preparations only; branded coverage comes from USDA
Branded records and the existing live branded search, never from a model. A
number nobody measured and a product nobody makes are the two failure modes a
food catalogue cannot recover from, because a user has no way to tell either from
the real thing.
