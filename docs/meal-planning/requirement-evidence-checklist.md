# Meal planning — requirement evidence checklist

The traceability record for the meal-planning feature: every numbered
requirement area and every design flow, each carrying a status and the named
suite, report or artefact that evidences it.

This document is deliberately the least flattering page in the folder. A
checklist that marks everything green tells a reviewer nothing; one that names
its gaps precisely tells them exactly where to look. One requirement is
recorded here as **measured and unmet** and the device walkthrough is recorded
as **unrun** — neither of which is softened below. The rest of this folder
describes how the feature is meant to behave; this file records what has
actually been shown.

Sibling documents own the detail and are linked rather than restated:
[`README.md`](./README.md) for commands and environment variables,
[`api.md`](./api.md) for the wire contract and error codes,
[`catalog-policy.md`](./catalog-policy.md) for catalogue bounds and the search
benchmark contract, [`planning-policy.md`](./planning-policy.md) for the target,
planning, swap, grocery and recipe policies, and
[`release-and-recovery.md`](./release-and-recovery.md) for the release, kill
switches and rollback.

## How to read this document

Four markers are used. The first three are the statuses; the fourth is about a
result rather than about verification, and the distinction matters.

| Marker | What it claims | What it does not claim |
| --- | --- | --- |
| **implemented** | The code is present in the tree and typechecks. | Nothing about behaviour. No test is being cited. |
| **tested** | A named automated suite or a generated report exercises it, **and that suite or command actually ran** — the run is recorded in [What was verified in this environment](#what-was-verified-in-this-environment). | Nothing visual, and nothing about a real device or a deployed environment. |
| **ready-for-human-review** | Implemented, with every automatable part done, but the remaining verification needs a human or an environment absent here — a physical device, a visual comparison against the design, or an operator action against a real environment. Each such row says **what** remains and **why** it could not be automated. | That anyone has looked at it yet. |
| **unmet** | The check ran and the **result missed its bound.** The verification worked; the feature did not clear the bar. | — |

A row may carry two statuses: `tested + ready-for-human-review` means the
server-side and pure-logic parts are covered by suites that ran, while the
rendered result still needs eyes. A row marked `tested` **and** `unmet` means
the measurement is real and so is the shortfall.

**No row claims evidence that was not produced.** Where evidence is pending, the
row says pending and names what would produce it; it never cites a file that
does not exist. A suite that is written but did not run here is not "tested".

**Scope spans two repositories,** so each cited artefact is labelled with the
one that holds it:

- **API** — this repository (`state-of-health-be`). Paths are relative to its
  root: `src/…`, `data/meal-planning/…`, `docs/meal-planning/…`.
- **App** — the React Native client (`state-of-health-tracker`). Paths are
  written `app: src/…`.

Suite citations follow the testing layer table in the backend architecture
guide, Rule 7 §11: a `*.logic.test.ts` is cited for a **rule** (pure, no
database, no mocks), an `api/*.test.ts` for **wiring** (integration against a
test database), and mappers are covered by those integration suites rather than
by logic tests of their own — there is no `*.mapper.test.ts` in this repository
and none is claimed. Each evidence cell names the **decision** the suite pins,
not the fact that a file exists.

## Requirement areas 1–10

The ten in-scope areas, in the order the specification numbers them.

| # | Requirement | Status | Evidence | Notes |
| --- | --- | --- | --- | --- |
| 1 | Seven-step onboarding (intro → goal → body → activity → diet and allergies → food preferences → schedule → cooking and budget), plus editing any answer from the review and plan-settings rows. | tested + ready-for-human-review | API `src/services/__tests__/preferences.logic.test.ts` pins the step parsers, allergen exclusivity (`isNoAllergenSelection`), metric normalisation, the slot/time validation per schedule and time-zone normalisation; `src/__tests__/api/preferences.test.ts` pins that a step save advances the state machine without moving it backwards in edit mode, that a save recomputes an active plan's incompatibility flags, and that a stale `expectedRevision` loses exactly one of two concurrent edits. `app: src/components/MealPlanSetupProvider/__tests__/index.util.test.ts` pins the draft reducers; the per-screen `index.util.test.ts` files pin each step's first-entry state and validate-on-press behaviour. | Resume-after-restart is server-persisted and covered by the API suite. What remains is visual: the eight screens against their frames, the native status bar and safe areas, dynamic type and VoiceOver — none reproducible without a device (see [the checklist](#the-physical-device-checklist--unrun)). Four screens (intro, activity, food preferences, food search) carry no `index.util.ts` and so correctly carry no util test: they hold no derivation worth pinning, their state living in the setup provider and the catalogue queries. |
| 2 | Deterministic target estimate, reviewed and editable, persisted through the existing user-target columns, with planner, diary and account showing identical values. | tested + ready-for-human-review | API `src/services/__tests__/targets.logic.test.ts` pins the energy equation, the activity factor, the goal adjustment, the bound clamps and which bound bound it (`applyTargetBounds`), the macro split, manual-target parsing (including the rejection of a zero macro) and `assessFeasibility`. `src/__tests__/api/targets.test.ts` pins the canonical read, a confirmed estimate surviving later preference saves as stale-but-unchanged, the pinned revision used as a write predicate, and the publication gate against the untouched legacy writer. `src/__tests__/api/compat.test.ts` pins that the legacy target writer is unchanged. `app: src/queries/mealPlanning/__tests__/useSaveNutritionTargetsMutation.util.test.ts` pins the exact invalidation set that makes the diary and account agree after a save. | Bounds and their provenance labelling live in [`planning-policy.md`](./planning-policy.md) §1; they are not restated here. The cross-surface parity is asserted at the data layer — one write, one read, one invalidation set. That the three surfaces *render* the same number is a visual check on a device. |
| 3 | Repeatable USDA import and AI-assisted catalogue expansion producing the required published count, each item with a machine-readable validation record, searchable inside the existing Add Food screen. | tested; **the per-category plan unmet** | API `src/services/__tests__/catalog.logic.test.ts` pins the check tiers, the per-category bounds, canonical-name normalisation, the deterministic `source_key`, identity de-duplication and brand-pattern rejection. `src/services/__tests__/evidence.logic.test.ts` pins the retrieval policy row by row against the committed address table. `src/__tests__/scripts/catalog-import.test.ts` and `catalog-generate.test.ts` pin interruption, checkpoint and budget resume, and an identical rerun producing no duplicate `source_key`; `catalog-load.test.ts` pins load, no-op rerun, recovery after partial progress and a release upgrade. `src/__tests__/api/catalog.test.ts` pins the publication filter, one row per canonical food however many aliases matched, and the catalogue body accepted by the existing diary endpoint. Reports: `data/meal-planning/reports/latest/validation-report.json` and `import-report.json`. | **Met on the required count; unmet per category.** 10,928 published foods against a requirement of 10,000 — a **surplus of 928**, recorded as `requirementMet: true` — and 10,928 of 10,928 carry a validation record, with none missing. 13 of the 21 categories remain below their per-category target, **2,361 items short** in total — reported exactly in the report's `coverageGaps` and as `every_category_meets_its_target: false`, never smoothed against the 8 categories that over-deliver. Of that shortfall **187** items could at most be closed by resolving records the pipeline withheld and **2,174** exceed every row the vendor returned for their category. Every published record carries a complete identity retrieval with an observed 2xx status. Search relevance over the loaded release is **met** and measured — see [the search benchmark](#the-search-benchmark-is-met-and-what-it-does-not-cover). The Add Food surface itself is `ready-for-human-review`. |
| 4 | Seeded recipe catalogue whose ingredients are all imported catalogue foods, with instructions, yield, serving description, times, diet and allergen metadata, and a documented budget tier. | tested | API `src/services/__tests__/recipe.logic.test.ts` pins nutrition derived from stored gram weights, the derivation of allergen tags, allergen status and diet tags from the full ingredient set, badge derivation, and ingredient-snapshot staleness across both the nutrition and metadata versions. `src/__tests__/api/seed-rerun.test.ts` pins the committed corpus, referential closure inside the database, the planning preconditions every ingredient must satisfy, recipe nutrition recomputed from the stored rows, and the declarations the corpus makes about itself. `src/__tests__/scripts/recipes-seed.test.ts` pins the no-op rerun, version promotion on changed content, a declared-versus-derived tag mismatch failing the run, and an unknown ingredient key failing it. Report: `data/meal-planning/recipes/coverage-report.json`. | 42 recipes against a floor of 40, with 269 ingredient rows. The seed is idempotent and its report is reproducible: re-running it here rewrote the coverage report **byte-identically** to the committed one. The report states its own boundary — combinations outside the guaranteed and reduced cells are supported at runtime but not guaranteed, and the planner answers such a user with a limiting-constraint code rather than an empty plan. |
| 5 | Persisted seven-day plan with explicit local dates, slots, recipe versions and portion multipliers; the app reopens the saved plan. | tested + ready-for-human-review | API `src/services/__tests__/mealPlan.logic.test.ts` pins the seed derivation, candidate construction and its portable pre-order, the repetition rule, the scoring terms, the tie-break fixture (`compareCandidateMoves`) and day-tolerance evaluation. `src/__tests__/api/plans.test.ts` pins every field the plan mapper derives, current-versus-upcoming resolution, the day read and regeneration. `src/__tests__/api/concurrency.test.ts` pins the per-user advisory lock, a superseded plan addressed by its old id and revision, and two parallel requests carrying one idempotency key. `app: src/screens/Macros/components/MealPlanTab/__tests__/index.util.test.ts` pins plan selection, rollover and stale-selection reset. | Determinism is a property of candidate generation, and the tie fixture is what pins it. Reopening the saved plan is exercised at the query layer; that the saved week *appears* on reopening a real app is a device check. |
| 6 | Recipe detail with the portion display toggle, ingredient quantities, serving size and planned daily totals. | tested + ready-for-human-review | API `src/services/__tests__/recipe.logic.test.ts` pins ingredient scaling as a pure function, so the toggle cannot alter stored data; `src/__tests__/api/recipes.test.ts` pins the response shape, the frozen ingredient snapshot, the closed code sets, and that a retired version is caller-scoped while a current one is shared reference data. `app: src/screens/RecipeDetail/__tests__/index.util.test.ts` pins the toggle's derived quantities and the planned-context composition. | The requirement that the toggle changes displayed amounts only is enforced structurally: the scaling function is pure and no write path exists from this screen. Layout fidelity is visual. |
| 7 | Swap flow across its states, plus the editable consumed portion at logging time. | tested + ready-for-human-review | API `src/services/__tests__/swap.logic.test.ts` pins one candidate selector shared by the list, preview and commit, portion selection, ranking, the empty-alternatives outcome, the bound-portion requirement, and a logged meal swapped twice. `src/__tests__/api/swaps.test.ts` pins the commit gates, the grocery consequences, the idempotency ledger and a grocery rebuild failing after the meal was written. `src/__tests__/api/fault.test.ts` pins the injected swap fault and a swap whose response is lost after it commits. `app: src/screens/SwapMeal/__tests__/index.util.test.ts`, `index.orchestration.test.ts`, `app: src/screens/SwapPreview/__tests__/index.util.test.ts` and `app: src/queries/mealPlanning/__tests__/useSwapMealMutation.util.test.ts` pin the four screen states and the cache contract. | The drawn loading, empty and failure states are reachable on a device only through the development-only fault-injection variable, whose values are documented in [`README.md`](./README.md). The unconfirmed-outcome variant is distinct from the drawn failure and is pinned by the fault suite. |
| 8 | Weekly grocery checklist: aggregation, aisle grouping, persisted checks, uncheck-all, flagged increases on already-checked items, and the distinct no-plan versus empty-plan states. | tested + ready-for-human-review | API `src/services/__tests__/grocery.logic.test.ts` pins planned grams per ingredient, aggregation by food and state, the epsilon at which two quantities are equal, change classification, unit-family stability, display construction and row building. `src/__tests__/api/grocery.test.ts` pins the list aggregated from planned portions, a single check mark, uncheck-all, and ownership with the capability gate. `src/__tests__/api/concurrency.test.ts` pins a toggle racing the rebuild a swap performs. `app: src/screens/GroceryList/__tests__/index.util.test.ts` pins the row variants, the two empty states and the presence rule for the uncheck-all action; the two grocery mutation option-factory tests pin the optimistic write and its rollback. | The flagged-increase rule is the subtle one and the logic suite pins it: an increase on a checked row keeps the check and compares against the **last acknowledged** amount, a sub-epsilon change is neither an increase nor a decrease, and a decrease produces no flag. |
| 9 | Planned-meal logging into the current diary bucket with the server-derived snapshot, idempotent under retries, carrying the provenance caption. | tested + ready-for-human-review | API `src/services/__tests__/plannedMealLog.logic.test.ts` pins the facts a planned entry carries, the portion and snapshot derivation, consumed totals and the diary-meal acceptability rules. `src/__tests__/api/log.test.ts` pins the bucket a planned log targets, the rounding contract, the idempotency ledger and the logged state derived from the diary. `src/services/__tests__/nutrition.logic.test.ts` pins the payload discrimination and the edit that detaches an entry from its plan. `src/__tests__/api/fault.test.ts` pins a planned log whose response is lost after it commits, replaying the stored response rather than writing twice. `app: src/data/models/__tests__/MealEntry.test.ts` pins every provenance caption, and `app: src/queries/api/macros/__tests__/MacrosDecoder.test.ts` pins the absent, null and populated forms of the new fields. | The caption *string* is pinned by the app model test; the caption *as rendered* under a diary row is visual. Deleting or editing the diary entry changing the plan's logged state is covered by the two diary mutation option-factory tests. |
| 10 | The API surface — routes, controllers, services, types, the additive migration, a real Jest suite replacing the stub, the CLI scripts, the data manifests, the handoff documents, and a PostgreSQL service in CI. | tested, with one named gap | Routes and controllers are mounted and covered by the `src/__tests__/api/*` suites; `src/__tests__/api/ownership.test.ts` pins the route inventory it is built from. The migration is evidenced by two committed artefacts and the one gate that polices both — [`expected-schema-diff.sql`](./expected-schema-diff.sql), the captured `prisma migrate diff --script` output compared as a whole file, and [`schema-catalog-evidence.sql`](./schema-catalog-evidence.sql), the `pg_catalog` extraction and expected result for the expression index, partial-index predicates and array `NOT NULL` that command cannot see — plus the dual-ledger equivalence check in `src/__tests__/api/compat.test.ts`. The stub is gone: `npm test` is a real Jest run of 56 suites, its coverage gate derived from disk by `jest.config.ts` and pinned by `src/__tests__/setup/coverageInventory.test.ts`. `src/__tests__/setup/testDb.test.ts` proves the database guard from outside the process it protects. Scripts are covered by `src/__tests__/scripts/*`. CI declares the PostgreSQL service and every gate. Both repositories' handoff documents are present: this folder's six here, and `app: docs/meal-planning.md` in the app repository, which `app: README.md` links. | **The gap:** the CI workflow has not been observed running on a hosted runner from here; each of its steps was executed locally instead, and the results are in [What was verified](#what-was-verified-in-this-environment). |

### Ownership and error behaviour

Two properties cut across all ten areas, so they are evidenced once here rather
than repeated in every row.

**Ownership — status: tested.** `src/__tests__/api/ownership.test.ts` pins a
route-by-id-class matrix over every user-scoped route: a caller's own id returns
the documented success, while **another tenant's id and an id that names nothing
both return the same 404**, so existence never leaks and no route answers 403.
The suite also pins the route inventory the matrix is built from, so a route
added without an ownership case fails it. The one deliberate exception is shared
reference data — a current recipe version is readable by any caller while a
retired one is caller-scoped, pinned by `src/__tests__/api/recipes.test.ts` —
and it is described in [`api.md`](./api.md) under user scoping.

**Refusals — status: tested.** Every refusal is a machine-readable code rather
than prose, and the suites named in the table above are what pin them: the
capability gate in the preferences, recipes and catalogue suites; the
revision, plan-state and idempotency-conflict codes in the plans, swaps, log and
concurrency suites; the confirmed-versus-unconfirmed distinction in the fault
suite. **The codes, their statuses and their bodies are not restated here** —
[`api.md`](./api.md) carries the contract and its error-code index, and this
document cites the suites that hold the server to it.

### Where an area is not a clean pass

One result is unmet, and it is stated here rather than left to be inferred
from a report. The search benchmark, whose bounds the same measurement
previously missed, now clears all four; what it covers and what it does not is
stated with it.

#### The required published count is met; the per-category plan is not

The aggregate requirement is met and the per-category one is not, so both are
stated. The catalogue publishes **10,928 foods against the requirement of
10,000** — a surplus of **928**, recorded as `requirement_met: true` in the
release manifest's `acceptance` block — and every one of them is validated and
carries its own validation record (**10,928 of 10,928**, none missing). But
**13 of 21 categories are below their published target, 2,361 items short in
total**, while 8 over-deliver. A surplus in one category cannot substitute for a
shortfall in another, and recipe eligibility draws on specific categories, so
the per-category figure is reported rather than netted against them.

The per-category shortfall is broken down rather than left as one number:
**187** of those 2,361 items could at most be closed by resolving a withholding
over rows already imported — the withheld identities and their failing checks
say which — and **2,174** exceed every row the vendor returned for their
category, so no re-validation, bound change or curator pass can produce them.
The plan's per-category targets sum to **11,010**, deliberately above the
requirement so late quarantines cannot put the required count at risk (AAP
§0.7.3), which is why a per-category gap is a coverage statement rather than a
size one — and it is still carried here as an unmet requirement, not as a
metric.

**What closed the aggregate count was curated vendor volume, not the model.**
The USDA import now plans **12,057 records** where the release this one
supersedes planned 10,003: 13,619 generic vendor records less 282 excluded data
classes, 1,077 brand-pattern names, 153 curated duplicates (145 matched by FDC
id, 8 by canonical identity) and 195 refused once a category's candidate volume
was reached, plus the manifest's 145 curated entries. The whole of the
difference from the earlier run sits in one new counter:
**`admittedByRequirementHeadroom` 2,054** counts records a category's
candidate-volume cap would previously have skipped, planned anyway because the
run's total planned count was still below the `plannedVolumeFloor` of **11,300**
that `usda-manifest.v1.json`'s `requirementHeadroom` block derives from the
requirement itself. That rule is bounded and declared in committed data rather
than passed as a flag: it applies only to a run over the whole coverage plan,
only while the planned total is under the floor, and the moment the floor is
reached the per-category cap applies again with `skippedCategoryVolumeReached`
keeping its original meaning. No per-category `publishedTarget` or
`candidateVolume` moves, and an admitted record is an ordinary vendor record —
fetched, classified and judged by the same checks as every other,
`identity_source: 'usda'` with `nutrition_provenance: 'source_backed'`.

AI generation, which the plan intends to fill a remainder, contributed **nothing
publishable**, and the delivered release contains no generated row at all: all
10,928 published foods are `identity_source: 'usda'` and
`nutrition_provenance: 'source_backed'`, and the manifest's
`published_ingredient_derived` is 0. The committed import report's generation
stage is a **dry run** over the re-cut plan — 157 planned batches, 3,762 AI
candidates planned, 0 executed, 0 model calls used, 0 candidates proposed,
`aiEvidence.verified` 0 — so it measures the plan rather than a spend. The
generation run that **did** reach the model provider was measured against the
superseded release and is preserved in this repository's history, at commit
`d0ad935`'s `import-report.json`: 3,788 candidates proposed over 159 metered
model calls, 1,127 removed as duplicates, and every surviving row held in
quarantine on the `unsourced` check because its proposed identity evidence could
not be retrieved from an allow-listed host (`fetch_failed` on 528 candidates).
Those figures are history here, not evidence for this release, and the reason
they did not improve is unchanged: the model proposes plausible deep URLs that do
not exist, the one authoritative allow-listed food page is a JavaScript
application whose served body never contains the food name, and the pages that do
resolve sit outside the allowlist. Widening the allowlist to admit them would be
manufacturing provenance, which §0.1.2 forbids — which is why the count was
closed from reviewed vendor volume instead.
`validation-report.json` and `import-report.json` carry the per-category figures
and the exact gaps; the plan and its bounds are in
[`catalog-policy.md`](./catalog-policy.md).

Both of those artefacts were **re-produced by the run that cut this release**
(the import-stage write at 2026-09-18T17:03:32Z, the validation stage at
17:03:47Z), so they measure the corpus they describe rather than an earlier one.
They record the validator's `checkVocabulary` of **23 names** — where the
superseded artefacts carried 21 — the two additions being `unknown_tag_code` and
`inconsistent_tag_set`, which judge the two safety tag lists; the stage that
judges a stored row supplies both lists from the row, so every item's record
carries both. The completeness that follows is asserted rather than assumed:
`perItemCompleteness.itemsWithAnUnexplainedAbsence` is **0** across the 196,704
check entries recorded over the 10,928 published rows. `catalog-report.ts` still
reports an item whose record predates a check as an **unexplained gap** (a row to
re-validate) rather than explaining the absence away; this release gives it none
to report.

#### One stage note in the import report was written by an earlier revision

`import-report.json` is a document three stages merge into, and each stage
records what its own write preserved, replaced and removed in a note of its own.
Its `importStageWrite` note is the one thing in the committed reports that the
**current** code would not write the same way, and it is called out here rather
than left for a reader to trip over.

That note reports `producedBy` among the keys the import write "left exactly as
it found them" while also reporting `producedBy.aggregatedRunKinds` among the
assertions it removed — both at once, because the revision that wrote it
excluded removed keys from `preservedKeys` by exact name and a sub-key removal
is recorded as a dotted path, which never matched the parent. Its reason
sentence also credits `npm run catalog:report` with putting back
`measurementGaps`, which that command writes into `validation-report.json`
instead, and `producedBy.aggregatedRunKinds`, which no stage writes anywhere.
Commit `3e4d165` fixed all three: a block a removal reached into is now named in
`blocksModifiedByAssertionRemoval` and deliberately kept out of
`preservedKeys`, the classification lists carry only what is true of this
document, and `catalog-report.ts` prunes the sub-key through its own reviewed
`SUPERSEDED_KEYS` so the removal is recorded in the artefact instead of
happening silently. Measured against the delivered document, the corrected code
writes `droppedAggregateAssertions: ["aggregateMeasurementGaps"]` and
`blocksModifiedByAssertionRemoval: []` — the contradiction cannot recur, because
the document no longer carries the sub-key at all.

The note itself was **deliberately not regenerated**, and the reason is a
straight trade rather than an oversight. Only an import run rewrites it. A
cache-warm import on a replica reproduced every figure this section and checks 7
to 16 state — planned 12,057, inserted 12,057, published 10,928, `requirementMet`
true — so the numbers were never in question. What a rerun would cost is
evidence: `usdaRequests` becomes `attempts 0, pauses 0, totalPausedMs 0` on a
cache-served run, and that block is the acceptance evidence for
`USDA_IMPORT_RATE_LIMIT_PER_HOUR` (AAP §0.7.3, §0.10) — 583 attempts, 522
pauses, 1,226,117 ms spent waiting on the limiter. It would also move both stage
timestamps off `2026-09-18T17:03:32Z` and `17:03:47Z`, which is what ties these
reports to the run that cut release v1. Replacing real rate-limiter telemetry
with an all-zero block to tidy one stage note would trade evidence for
neatness, so the note stands as the historical record it is and this section
says what it says and what the code says now.

#### The search benchmark is met, and what it does not cover

`npm run search:benchmark` **fails closed and exits non-zero** on any threshold
it does not meet. Run here against the loaded release it met **all four**: the
bounds are a top-3 hit rate of at least 0.9, a top-10 rate of at least 0.97, a
zero-result rate of at most 0.03 and a p95 latency of at most 150 ms — contract
values owned by `data/meal-planning/search-benchmark.v1.json`, not measurements,
which is why they can be stated here without dating. The measured rates and
latencies behind that verdict live in the committed
`data/meal-planning/reports/latest/benchmark-report.json` (`generatedAt`
2026-09-18T17:13:18.728Z) together with the per-query detail, and check 15 above
records the run's headline outcome. They are deliberately not copied a third
time into this section: a figure inlined into prose is a figure that goes stale
the next time the release is cut, which is exactly what happened to the two
policy documents before this one. The pagination check passed with no repeated
and no dropped row.

That report is the acceptance evidence for search quality, and it is evidence
for exactly the corpus and conditions it names — release v1 at 10,928 published
foods, measured in process against `catalog.service.searchPublishedFoods` — and
for no others. Four queries still sit outside the top ten and are named in the
report rather than averaged away: q023 `crackers`, whose expected row now falls
outside the measured page altogether, at position 35 of 108 matches; q236
`mushrooms` and q237 `mushroom`, both at rank 13 of 99; and q382 `chicken` at
rank 12 of 672. The top-10 rate counts all four as misses rather than smoothing
them, and a pass at that rate is not a claim that every common-food search is
answered well.

The Jest suite `src/__tests__/api/benchmark.test.ts` exercises the same
mechanics over a synthetic corpus and is **explicitly not acceptance
evidence**: a synthetic corpus can show that ranking, paging and the zero-result
path behave, but it cannot show that real common-food searches find real foods.
A green run of it must never be cited as though the bar were met.

The run also established release determinism. Every query returned the same rank
and the same match-set total on all three timed passes — the report records that
per query, in `rankStableAcrossPasses` — and the release was then loaded into a
second, independently created database and measured there. Handing the committed
report back to the runner as the peer
(`npm run search:benchmark -- --out <mine.json> --compare-with
data/meal-planning/reports/latest/benchmark-report.json`) recorded the
comparison machine-readably: **every per-query rank identical, every portable
page sequence identical, the two `determinismFingerprint` digests equal**, and
the two databases positively established as `distinct` from the PostgreSQL
system identifier and database oid each run read back — with latency the only
figure that differed. The counts behind that outcome are in check 16 above,
which is the row that run belongs to. That is the reproducibility property the
release ordering was designed for, and it is what makes the report's figures a
property of the release rather than of one load. The committed artefact is the
single-run report, so its own `crossDatabaseReproduction` block records
`not_evaluated_by_a_single_run` together with the four commands that reproduce
the comparison above.

## Design flows F1–F14

Fourteen flows covering 31 screen states. This is a traceability table: it names
frames, the screens that implement them and the suites that cover them. It
carries no design specification — no colour, no measurement, no node identifier.
The design record lives in the specification, and the visual verification lives
in [the device checklist](#the-physical-device-checklist--unrun).

**One caveat applies to every row and is stated once here.** What is
machine-verifiable about a flow is: route registration and typed parameters,
the pure derivation in each screen's `index.util.ts`, the query composition and
the mutation cache contract, and the server behaviour the flow depends on. What
is **not** machine-verifiable in this environment is the visual dimension —
fidelity against the frame, the native status bar and safe-area insets, dynamic
type at larger sizes, and VoiceOver. No renderer or component-testing library is
installed in the app repository and none was added, so component rendering is
not asserted anywhere; screen logic is tested through extracted pure functions
and option factories instead. **Every row below is therefore
`ready-for-human-review` on its visual dimension**, and the per-row notes carry
only what is specific to that flow. All 18 new routes are registered on the
Macros stack, which was verified by inspection of the registration file.

| Flow | Frames | Destination screen(s) | Status | Evidence | Notes |
| --- | --- | --- | --- | --- | --- |
| **F1** Start setup and choose a goal | 01, 02 | app: `MealPlanIntro`, `MealPlanGoal` | tested + ready-for-human-review | `app: src/screens/MealPlanGoal/__tests__/index.util.test.ts` pins that nothing is preselected, that pace appears only for a directional goal and is hidden for maintain, and the optional goal-weight rule; `app: src/components/MealPlanSetupProvider/__tests__/index.util.test.ts` pins the draft the step writes. API `src/services/__tests__/preferences.logic.test.ts` pins the `goal` step payload; `src/__tests__/api/preferences.test.ts` pins that the first save creates the row. | The intro's sample week is static illustrative content by requirement, and the screen carries no `index.util.ts` because it has no derivation to pin. The returning-user entry point is the state router, covered under F8. |
| **F2** Body details and validation errors | 03, 03b | app: `MealPlanAboutYou` | tested + ready-for-human-review | `app: src/screens/MealPlanAboutYou/__tests__/index.util.test.ts` pins the weigh-in prefill as a labelled suggestion — including the range guard and the case where the user's stored unit is one the control does not offer, which yields no prefill — and the per-field error derivation; `app: src/utility/__tests__/UnitConversionUtility.test.ts` pins the conversions. API `preferences.logic.test.ts` pins `normalizeToMetric` and the input ranges. | The prefill is the one place a stored number can be misread, and the reason is a **recorded limitation, not a covered case**: `body_weight_entries` carries no unit column, so the stored number is read in the unit selected today and a value typed under an earlier unit can pass the range gate and be shown in the wrong unit. What is pinned is the guard around it — the range gate, the stone suppression, the caption and the required confirmation — not the provenance the data does not carry; the risk, its bounds and what would close it are stated in full under [What is unrun or unverified](#what-is-unrun-or-unverified), and on the app side — where the screen lives — under `app: docs/meal-planning.md` § "The weigh-in prefill, and the unit it cannot know", which also carries the device step that exercises it. Nothing is converted silently and no stored weigh-in is rewritten. Values survive a failed submit by construction — the draft lives in the provider. |
| **F3** Activity, then diet and allergies | 04, 05 | app: `MealPlanActivity`, `MealPlanDiet` | tested + ready-for-human-review | `app: src/screens/MealPlanDiet/__tests__/index.util.test.ts` pins that the "none" allergen choice is mutually exclusive with the named allergens in both directions and that nothing is preselected; `app: src/__tests__/constants/strings.test.ts` pins the activity copy the specification replaces. API `preferences.logic.test.ts` pins `parseAllergens` and `isNoAllergenSelection` — the same predicate the services share. | The activity screen is a single-select with no derivation, so it has no util test; its accepted value set is pinned by the step parser. Allergies are never removed automatically, which the exclusivity test is what guards. |
| **F4** Food preferences and catalogue search | 06, 06b | app: `MealPlanFoodPreferences`, `MealPlanFoodSearch` | tested + ready-for-human-review | `app: src/queries/api/catalog/__tests__/CatalogDecoder.test.ts` and `convertCatalogFood.test.ts` pin lenient decoding of provenance and unknown values; `app: src/queries/catalog/__tests__/useCatalogSuggestionsQuery.test.ts` pins the suggestions query; `MealPlanSetupProvider` util test pins the staged selection. API `src/__tests__/api/catalog.test.ts` pins the search band, one row per canonical food however many aliases matched, and the suggestions endpoint. | Selections are staged in the provider and persisted only by the step's own save, so cancelling discards them — pinned in the provider test. Neither screen has an `index.util.ts`: the derivation is in the converters and the provider. The relevance of what search returns is the benchmark above: met over the loaded release, with the four queries it still misses named there. |
| **F5** Schedule, cooking effort and budget | 07, 08 | app: `MealPlanSchedule`, `MealPlanCookingBudget` | tested + ready-for-human-review | `app: src/screens/MealPlanSchedule/__tests__/index.util.test.ts` pins that no schedule is preselected and that choosing one seeds the per-slot default times the user can then change; `app: src/screens/MealPlanCookingBudget/__tests__/index.util.test.ts` pins the budget field's enablement against the no-preference checkbox and its validation message. API `preferences.logic.test.ts` pins `slotsForSchedule`, `validateMealTimes` (one time per slot, no ordering constraint between them) and `mealsPerDayForSchedule`. | The default meal times are product defaults applied on selection, not answers pre-chosen for the user; the test pins that distinction. The budget's no-preference checkbox starts unchecked, so the user must answer one way or the other. |
| **F6** Review targets and edit them | 09, 09b | app: `MealPlanTargets`, `MealPlanEditTargets` | tested + ready-for-human-review | `app: src/screens/MealPlanTargets/__tests__/index.util.test.ts` and `index.orchestration.test.ts` pin the ordered confirm-then-save-then-generate sequence, including that a retry re-runs only what is still unsaved; `app: src/screens/MealPlanEditTargets/__tests__/index.util.test.ts` pins the manual and edit variants and the blank manual route; `app: src/utility/__tests__/RevisionConflictUtility.test.ts` pins the stale-revision recovery. API evidence as for area 2. | The orchestration test is the load-bearing one here: it pins that pressing generate confirms the displayed estimate first, so a plan is never built on numbers the user did not confirm. |
| **F7** Generate the plan and recover from failure | 10, 10b, 10c | app: `MealPlanGenerating` | tested + ready-for-human-review | `app: src/screens/MealPlanGenerating/__tests__/index.util.test.ts` pins the pending, failed and no-match states, the per-context secondary action, and the typed edit target each limiting constraint routes to; `app: src/queries/mealPlanning/__tests__/useGeneratePlanMutation.util.test.ts` and `useRegeneratePlanMutation.util.test.ts` pin the invalidation set and the retry predicate that only retries an unconfirmed outcome. API `src/__tests__/api/plans.test.ts` pins the refusal codes; `mealPlan.logic.test.ts` pins the limiting-constraint analysis; `src/__tests__/api/fault.test.ts` pins the injected generation fault leaving nothing persisted and a generation whose response is lost after it commits. | The drawn failure states are reachable on a device only via the development-only fault variable ([`README.md`](./README.md)). The unconfirmed-outcome variant is a fourth state the design does not draw, and the fault suite is what pins its distinction from a confirmed failure. Allergies are never relaxed to find more meals. |
| **F8** View the weekly plan, empty state to logged meal | 11c, 11, 11b | app: `Macros` + `Macros/components/MealPlanTab` | tested + ready-for-human-review | `app: src/screens/Macros/components/MealPlanTab/__tests__/index.util.test.ts` pins the no-plan state router across every setup status, plan selection with an upcoming plan, day rollover, stale-selection reset, the post-log banner payload and the logged-then-swapped caption derived from the logged entries; `app: src/screens/Macros/__tests__/index.util.test.ts` pins the segment; `app: src/utility/__tests__/MealPlanEntitlementUtility.test.ts`, `MealPlanLifecycleUtility.test.ts` and `app: src/hooks/mealPlanning/__tests__/useMealPlanEntitlement.util.test.ts` pin the flag and unavailability handling; the two plan query util tests pin the day seeding. API `src/__tests__/api/plans.test.ts` pins the day read and the logged state. | This flow carries the most derivation and has the most coverage. The success banner replacing the totals card, and the segmented control and tab bar remaining present, are visual. The diary body is deliberately unmodified, so no scroll-to or highlight behaviour is claimed. |
| **F9** Inspect a planned recipe | 12 | app: `RecipeDetail` | tested + ready-for-human-review | `app: src/screens/RecipeDetail/__tests__/index.util.test.ts` pins the portion toggle's displayed quantities and the planned-context composition from the day query rather than from navigation parameters. API `src/__tests__/api/recipes.test.ts` pins the response, the frozen snapshot and the visibility rule; `recipe.logic.test.ts` pins scaling as a pure function. | The requirement that the toggle changes nothing but displayed amounts is structural: the scaling is pure and the screen has no write path. |
| **F10** Swap a planned meal | 13c, 13, 13b | app: `SwapMeal`, `SwapPreview` | tested + ready-for-human-review | `app: src/screens/SwapMeal/__tests__/index.util.test.ts` and `index.orchestration.test.ts` pin the loading and list states and the alternatives refetch when the plan revision has moved; `app: src/screens/SwapPreview/__tests__/index.util.test.ts` pins the delta and day totals; `useSwapMealMutation.util.test.ts` pins the invalidation set and the removal of previews bound to the pre-swap revision. API `swap.logic.test.ts` pins one selector shared by list, preview and commit; `src/__tests__/api/swaps.test.ts` pins the commit gates and grocery consequences. | That the three surfaces cannot disagree is enforced by sharing one selector, and the logic suite pins a candidate admissible only at a non-default portion being listed at that portion. Only the commit writes; opening an alternative does not. |
| **F11** A swap that returns nothing or fails | 13d, 13e | app: `SwapMeal` | tested + ready-for-human-review | `app: src/screens/SwapMeal/__tests__/index.util.test.ts` pins the empty and error states, including that the reassuring "unchanged" treatment is used only for a confirmed failure; `app: src/utility/__tests__/ApiErrorUtility.test.ts` pins the confirmed-versus-unknown outcome classification. API `swap.logic.test.ts` pins the empty-alternatives outcome; `src/__tests__/api/fault.test.ts` pins the injected swap fault persisting nothing and a swap whose response is lost after it commits replaying its stored result. | These two are sibling outcomes, never sequential. The distinction the classification test pins is the honest one: after a lost response the client must not claim the meal is unchanged, because it may not be. |
| **F12** Shop the grocery list | 14, 14b, 14c | app: `GroceryList` | tested + ready-for-human-review | `app: src/screens/GroceryList/__tests__/index.util.test.ts` pins the row variants including the flagged increase and the inferred checked-decrease, the two distinct empty states, and that the uncheck-all action renders only when something is checked; the two grocery mutation util tests pin the optimistic write, the rollback and the inactive-plan path. API `grocery.logic.test.ts` and `src/__tests__/api/grocery.test.ts` as for area 8. | The no-plan and empty-plan states are different copy for different situations and the test pins both. The uncheck-all presence rule exists so the screen never shows a control that would do nothing. |
| **F13** Log the portion eaten into the diary | 15, 15b | app: `LogPlannedMeal`, then `Macros` diary with `MealEntryRow` | tested + ready-for-human-review | `app: src/screens/LogPlannedMeal/__tests__/index.util.test.ts` and `index.orchestration.test.ts` pin the fixed plan date, the bucket preselected by slot with an explicit fallback, the servings stepper and fraction behaviour, and that the displayed addition equals what the server will store; `app: src/data/models/__tests__/MealEntry.test.ts` pins every provenance caption; `useLogPlannedMealMutation.util.test.ts` pins the invalidation set. API `plannedMealLog.logic.test.ts` and `src/__tests__/api/log.test.ts` as for area 9. | The second frame is the shipped diary screen, so the evidence is the caption and decoder tests rather than a new screen's. The return path after logging passes through the plan day, which is covered under F8. |
| **F14** Change plan settings and regenerate | 16, 16b | app: `PlanSettings` (+ its confirmation dialog) | tested + ready-for-human-review | `app: src/screens/PlanSettings/__tests__/index.util.test.ts` pins the row values, the data-bound dialog counts with their singular and plural forms, and that the "use for next plan" action dispatches navigation and no mutation because every edit was already saved by its own step. API `src/__tests__/api/preferences.test.ts` pins that a preference save recomputes the active plan's incompatibility flags in the same transaction and returns the affected count the banner uses; `src/__tests__/api/plans.test.ts` pins regeneration; `useRegeneratePlanMutation.util.test.ts` pins the cache contract. | The dialog's counts are bound to plan data, not static, and the test pins that. The settings entry point is an addition the design does not draw, so its discoverability is a specific thing for a reviewer to judge. |

Frame accounting: 2 + 2 + 2 + 2 + 2 + 2 + 3 + 3 + 1 + 3 + 2 + 3 + 2 + 2 = **31
screen states**, matching the design file.

## What was verified in this environment

Every row below was executed and its real outcome recorded, including the one
that fails. Together they cover every command in [`README.md`](./README.md)'s
ordered list **from `npx prisma generate` onward** — `catalog:load` twice,
`recipes:seed` and `search:benchmark` **end to end** against the loaded release
among them — so nothing in this folder should be read as saying one of those
went unrun. That list's first step, the host `npm ci`, has no row here on
purpose: it is how the environment was prepared rather than something this work
verifies, and what it produced is the dependency tree every row below then ran
against. A check that could not be run here is **not** listed as passed; it is
in [the next section](#what-is-unrun-or-unverified) instead. Two records below
the table are neither a run nor a gap of this environment's own: read figures
measured by **sibling QA boundaries in other clones**, kept here because no
artefact holds them — [read figures measured
elsewhere](#read-figures-measured-elsewhere-and-what-they-exclude) names whose
runs they were and what they do not cover.

**This table is the run index for this folder, and one level of detail is
deliberately not in it.** `README.md` and the two policy documents state what a
check *is* and cite this table for what it *did*, rather than restating an
outcome that would then have to be kept in step in several places. The table
carries each run's command and its **headline** outcome. A run's **full**
measurement stays in the artefact that produced it — `benchmark-report.json`
for the per-query ranks, page sequences, measurement conditions and latencies;
the release manifest for the per-category catalogue counts — which is what
those artefacts are for, and why this table names them instead of copying them.
So: headline outcome here, full measurement in the artefact that measured it,
and neither in the policy documents.

Provenance: every figure below was measured with the API submodule at `3e4d165`
and the app submodule at `35f08bd` checked out. Those are the commits that carry
every source, test and artefact change on this branch, and the claim to check is
not an assertion that nothing came after them but a command that shows what did:
in the API submodule `git diff --name-only 3e4d165..HEAD -- src scripts prisma
data` is empty, so the only commit after it is this document.

An earlier revision of this paragraph named `b4e0e27` and `487a66a` and asserted
that what came after them changed no compiled file, no test and no committed
artefact. That was **false**, and it is restated here rather than quietly
corrected because a provenance claim is worth exactly what its weakest sentence
is worth: `git diff --name-status b4e0e27..e0653bf -- src` returns
`src/controllers/catalog.controller.ts` and
`src/__tests__/setup/coverageInventory.test.ts`, and `3e4d165` then changed two
scripts, a test file and two report artefacts. Every figure below was therefore
**re-measured at `3e4d165`** rather than carried forward from the commit the old
paragraph named — which is also why check 7 states 10,720 tests where an earlier
revision stated 10,717: the three tests added with `3e4d165` are the difference.

The runs were executed as the work landed, on 2026-09-17 and 2026-09-18, and
every figure that the grown catalogue release, the suites or the lint baseline
moved was re-measured rather than carried forward: checks 7, 12, 13, 15, 16, 21,
22 and 23 state what a run on this tree returned. Where a row quotes a generated
report, the report's own `generatedAt` is quoted beside the figures so the
measurement dates itself.
One row measures the release as it stood **before** it was re-cut and says so in
place — check 14's byte-identical coverage report, whose full re-run would
rewrite a committed artefact rather than re-read one. Environment: Linux
container, Node 22.23.2 with npm 11.18.0, TypeScript 5.8.3, and a local
PostgreSQL 16.15 reached over loopback. Database roles follow the guard's own
rule: a `*_test` database for the suite, a separate development database for the
migration, load, seed and benchmark runs, and a disposable shadow database for
the schema diff. No value of `DATABASE_URL` or of any credential appears in this
document.

| # | Check | Command | Outcome |
| --- | --- | --- | --- |
| 1 | Prisma client generation | `npx prisma generate` | **exit 0** |
| 2 | API typecheck (production config) | `npm run typecheck` | **exit 0**, no errors |
| 3 | API typecheck (tests config) | `npm run typecheck:test` | **exit 0** |
| 4 | API typecheck (scripts config) | `npm run typecheck:scripts` | **exit 0** |
| 5 | API build | `npm run build` | **exit 0** |
| 6 | Migration ledger applied | `npx prisma migrate deploy` on two freshly created databases | **exit 0** on both; all four of `20260706000000_init`, `20260908000000_meal_planning`, `20260909000000_usda_cache_http_status` and `20260910000000_catalog_prefix_fold_indexes` applied in that order, which is the whole of `prisma/migrations/` |
| 7 | API suite with coverage | `NODE_ENV=test ALLOW_DB_TRUNCATE=true npm test` (the gate's own invocation: `jest --ci --runInBand --coverage`) | **56 of 56 suites passed.** 10,720 tests passed, 10,720 total, in 887 s, **nothing skipped** — a skip is not a pass, so the run carrying none is stated rather than left to be counted. **No coverage threshold was violated** — the per-file figures are [below](#per-file-branch-coverage-from-check-7) |
| 8 | Test-database guard, wrong `NODE_ENV` | `NODE_ENV=development npm test` | **Refused, exit 1**, before any application module or Prisma client was imported: the guard reports that `NODE_ENV` must be exactly `test` |
| 9 | Test-database guard, wrong database | `npm test` pointed at the development database | **Refused, exit 1**: the guard reports that the database name must end in `_test` or be exactly `ci` |
| 10 | Schema-drift evidence gate | the workflow's own gate script, run locally against the migrated database | **PASS.** `prisma migrate diff` exited 2 as the gate requires, 1 statement compared and identical to the committed evidence; the catalogue extraction matched on all **23 lines** of the `pg-catalog-expected` payload — 1 generated column, 9 index rows and 13 `array_column` rows, 12 of which carry `not_null=true`. The **1 / 7 / 12** the gate script and [`schema-catalog-evidence.sql`](./schema-catalog-evidence.sql) both name are **floors**, not the measured counts: the section has carried nine indexes since the prefix-fold indexes landed, and a larger set passes while a smaller one cannot — which is why the two files state different numbers from the ones above without contradicting them |
| 11 | Dual-ledger equivalence | included in check 7 (`src/__tests__/api/compat.test.ts`) | **116 of 116 passed, nothing skipped.** Both ledgers produce the same catalogue and preserve every legacy row unchanged, and the normalised `pg_dump --schema-only` comparison RAN: the suite resolves a dump runner whose major version is at least the server's — here `pg_dump` inside the container publishing the port `DATABASE_URL` names, reporting PostgreSQL 16.15 — and a dump it cannot produce fails the gate rather than skipping it. The gate also holds the third migration: the additive `usda_api_cache.http_status` column is excluded from the legacy row hashes and asserted un-backfilled on both ledgers |
| 12 | Catalogue release load | `npm run catalog:load -- --release v1` | **exit 0.** 10,928 foods, 15,777 aliases, 31,537 portions, 0 compositions, 10,928 validation records written; all five files verified against the manifest, every published record's identity evidence assessed (10,928 assessed, 10,928 complete, observed status 200 throughout), and the manifest's source-cache attestation (10,928 of 10,928 records resolved at export) cross-checked, before anything was written |
| 13 | Catalogue load idempotency | the same command again | **exit 0.** 0 inserted, 0 updated, 10,928 unchanged — idempotent |
| 14 | Recipe seed | `npm run recipes:seed` | **exit 0.** 42 recipes created with 269 ingredient rows, and the regenerated `coverage-report.json` was **byte-identical** to the committed one (the working tree stayed clean). That full run measured the release **before it was re-cut**, and the byte-identity is stated as its result rather than restated as a later one's. Re-run on this tree as `npm run recipes:seed -- --dry-run` against the re-cut release, it validated the same corpus — 42 recipes, 269 ingredient rows, all 69 referenced ingredients resolvable among the 10,928 published canonical names — and, by design on that flag, published nothing and left the report alone |
| 15 | Search benchmark | `npm run search:benchmark` | **exit 0 — all four bounds met**, and the run that wrote the committed `benchmark-report.json` (`generatedAt` 2026-09-18T17:13:18.728Z) is the one recorded here: top-3 0.955 (407 of 426), top-10 0.991 (422 of 426) against bounds of 0.9 and 0.97; zero-result rate 0 and p95 62.735 ms, both within bound, over 1,278 timed samples at limit 25. 426 of 426 queries were rank-stable across the timed passes. An independent re-run on this tree against a separately loaded database reproduced every relevance figure and both counts, with latency the only difference (p95 64.4 ms) — recorded as check 16. The per-query detail stays in the report; the bounds are in [`catalog-policy.md`](./catalog-policy.md). Read with [met, and what it does not cover](#the-search-benchmark-is-met-and-what-it-does-not-cover) |
| 16 | Release determinism | the release loaded into a second, independently created database, measured there, and the committed report handed back as the peer with `npm run search:benchmark -- --out <mine.json> --compare-with data/meal-planning/reports/latest/benchmark-report.json` | **`crossDatabaseReproduction.outcome: identical`** — 426 of 426 per-query ranks identical, 20 of 20 portable page sequences identical, `fingerprintsMatch: true` (both runs `363e2950…fc0daf`), the peer's own SHA-256 and `generatedAt` recorded, and the two databases established as `distinct` from the system identifier and database oid each run read back; latency the only difference. Run on this tree against the re-cut release, so the ordering is a property of release v1 rather than of one load |
| 17 | Service health | `npm run dev`, then the unauthenticated health endpoint | `{"status":"ok","version":"unknown"}` — the database round-trip succeeded. The reported version is `unknown` outside a built image, which is expected |
| 18 | Auth boundary | the catalogue status endpoint with no token | **401** with a "no token provided" body, confirming the route sits behind authentication — and confirming why authenticated calls could not be exercised here |
| 19 | Production image build | `docker build -t soh-be-w050 .` from the API repository root (the tag is arbitrary; CI uses `-t soh-be-ci`) | **exit 0**, image 458 MB. The `npm ci`, `npx prisma generate` and `npm ci --omit=dev` layers were served from the local layer cache — `package*.json` and `prisma/` are unchanged, so those layers' inputs are identical — while `COPY src` and `npm run build` executed. The claim this row exists for was then checked directly rather than inferred from a green build: `docker run --rm --entrypoint node -w /app soh-be-w050 -e "…require.resolve…"` resolved `express`, `@prisma/client`, `firebase-admin`, `uuid`, `date-fns`, `dotenv` and `pg` inside the pruned install, with `dist/app.js` and `dist/generated` present. `uuid` is the one that matters: this work moves it from `devDependencies` to `dependencies`, and this image installs with `--omit=dev`. That package also carries an open advisory at the version the AAP pins, whose reachability and standing are recorded under [dispositions awaiting a human ruling](#uuid901--ghsa-w5hq-g745-h8pq-accepted-risk-pending-a-ruling) |
| 20 | App typecheck | `npx tsc --noEmit` | **exit 0** |
| 21 | App suite | `CI=true npx jest --runInBand --ci` | **124 of 124 suites passed, 6,018 of 6,018 tests**, exit 0 (the pre-feature baseline was 42 suites and 577 tests) |
| 22 | App lint against the recorded baseline | `npx eslint --no-fix -f json .` then the baseline comparison script | **Comparison exit 0 — 0 new findings** over the after report's 886 results. 38 findings remain in 20 files against a baseline of 49 in 31 files, so the pre-existing count fell and nothing was added. `eslint .` itself still exits non-zero while baseline findings remain, which is expected and is not this gate |
| 23 | App token-literal gate | `node scripts/token-literal-scan.mjs $(git diff --name-only --diff-filter=ACMR master -- 'src/**/*.styled.*' 'src/**/*.tsx' ':(exclude)src/**/__tests__/**')` | **exit 0 — 213 files scanned, no hardcoded style value found.** That invocation is the documented one, and its scope is both file classes the scanner decides between — every styled module a change touches, `.tsx` ones included, and every component `.tsx`, so the JSX-attribute scan runs as well as the style-object scan, with `__tests__` excluded because a stylesheet test's numbers are the expectation it pins. The file list is derived from the diff rather than fixed, for the same reason the lint gate's is. The rationale for each pathspec term is in `app: docs/meal-planning.md` § "The literal scan" |
| 24 | Branch lineage against the reference commits | `git merge-base --is-ancestor 6bfc66c HEAD` in the API repository, `git merge-base --is-ancestor 788a36f HEAD` in the app repository | **Both answer yes.** AAP §0.1.4 requires each feature branch to sit on its reference commit so that this plan's template edits build on the reference templates rather than conflicting with them. Measured before the fix, neither reference was an ancestor: both branches diverged at the reference's *parent* — `5cdd043` and `603718ee` — so the rebase the plan describes never happened. Each reference was brought in by **merge rather than rebase**, because a rebase would rewrite every commit on both branches and the shas it would invalidate are load-bearing: this document provenances its measurements to two of them, the uuid disposition cites the withdrawn bump `360c765`, and the report artefacts name the commits they were produced at. The API merge is provably content-neutral — the tree it commits hashes to `e318dac…`, byte-identical to its first parent's, because all 39 non-blank lines of `6bfc66c`'s `.env.example` were already present in this branch's superset of it, including the deliberate second `PORT` entry the file explains. The app merge reconciles the one file both sides rewrote, `.env.dist`: the value stays the non-production `http://localhost:3000` that AAP §0.3.1 requires of that template — the reference still points it at the production host, and a copied `.env` must not reach production by omission — while the two facts the branch's own rewrite had dropped are restored beside it, that `"/api"` is appended in `src/constants/endpoints.ts` and that local `expo run` reads the file while EAS builds take the value from EAS environment variables. Nothing under `src/` is touched by either merge, no code reads either template, and the diff-derived scopes of checks 22 and 23 are unchanged at 469 changed lintable files and 213 scanned, because those gates diff trees rather than histories |

One reproduction note for check 7, because it is not a property of the code: the
suite opens a Prisma client per worker, and on a PostgreSQL server shared with
other work the default pool size can exhaust the server's connection slots, at
which point suites fail with `sorry, too many clients already` rather than with
an assertion. Appending `?connection_limit=5&pool_timeout=60` to the test
database URL bounds the pool and the run is green; neither parameter changes
which database is addressed, so the test-database guard still applies its own
rule to the URL. On a server with slots to spare no such parameter is needed.

### Per-file branch coverage from check 7

**Where these numbers come from:** check 7 above — `NODE_ENV=test
ALLOW_DB_TRUNCATE=true npm test`, which runs `jest --ci --runInBand --coverage`
— executed on the delivered tree (the API submodule at `3e4d165`) on
2026-09-18, in the environment stated at the top of this section, against the
`*_test` database. Re-running that one command on that tree is what checks this
table; the `coverage/` directory it writes is not committed.

Two deliberate differences from the reporter's own output: the branch counts
each percentage is computed from are added as a column, because a percentage
alone cannot be compared against a fresh run; and the reporter's
`Uncovered Line #s` column is dropped, because those line numbers move with any
edit to a module while the percentages and counts do not depend on them. The
counts are the `branches.covered` and `branches.total` of the same run's
`coverage/coverage-summary.json`, which is the text reporter's own source and is
obtained by adding `--coverageReporters=json-summary` to the invocation above.

```text
File                          | % Stmts | % Branch |    Branches | % Funcs | % Lines
------------------------------|---------|----------|-------------|---------|---------
All files                     |   99.49 |     98.3 | 2,904/2,954 |     100 |   99.45
 services                     |   99.46 |    98.26 | 2,772/2,821 |     100 |   99.41
  catalog.logic.ts            |   99.85 |    98.31 |     466/474 |     100 |   99.84
  evidence.logic.ts           |   97.42 |    95.04 |     441/464 |     100 |   97.25
  grocery.logic.ts            |     100 |     99.4 |     166/167 |     100 |     100
  mealPlan.logic.ts           |     100 |    98.07 |     356/363 |     100 |     100
  mealPlanningAction.logic.ts |     100 |      100 |     105/105 |     100 |     100
  nutrition.logic.ts          |     100 |      100 |       92/92 |     100 |     100
  plannedMealLog.logic.ts     |     100 |      100 |       94/94 |     100 |     100
  preferences.logic.ts        |     100 |    98.96 |     668/675 |     100 |     100
  recipe.logic.ts             |     100 |    98.36 |     180/183 |     100 |     100
  swap.logic.ts               |     100 |      100 |       78/78 |     100 |     100
  targets.logic.ts            |     100 |      100 |     126/126 |     100 |     100
 utils                        |     100 |    99.24 |     132/133 |     100 |     100
  featureFlags.ts             |     100 |      100 |       12/12 |     100 |     100
  pagination.ts               |     100 |      100 |       39/39 |     100 |     100
  seededRandom.ts             |     100 |      100 |         0/0 |     100 |     100
  units.ts                    |     100 |    98.78 |       81/82 |     100 |     100
```

Three things a reader comparing this against a fresh run needs, because each one
reads as a disagreement when it is not:

- **The two aggregate rows are different numbers.** `All files` is 98.3 % over
  2,904 of 2,954 branches; the `services` group on its own is 98.26 % over 2,772
  of 2,821, the difference being the four utilities (132 of 133). Quoting the
  group's percentage against the whole run's denominator is the easy mistake
  here, which is why both rows and both counts are printed.
- **Istanbul floors its percentages at two decimals** rather than rounding them,
  and drops a trailing zero when it prints: 2,904/2,954 is 98.3073 %, and it
  prints as `98.3`. A reader who rounds instead computes 98.31 and sees a
  mismatch that does not exist. The same applies per file — 668/675 is
  98.9629 %, printed `98.96`, and 466/474 is 98.3122 %, printed `98.31`.
- **`seededRandom.ts` contains no branches at all** (0 of 0), which Istanbul
  reports as 100 %. Its branch threshold therefore passes vacuously; its
  statements, functions and lines are what its tests actually hold.

**And this table is not the gate.** It records one run. What fails the build is
the per-path `branches` threshold in `jest.config.ts` — derived from the files
on disk rather than hand-listed, with no global average that could let a weak
module hide behind a strong one — together with
`src/__tests__/setup/coverageInventory.test.ts`, which fails the run if the
derived set and the files on disk ever diverge. A percentage pasted here going
stale is a documentation defect; a module falling below its bar is a red build.

Fifteen covered paths: the eleven pure domain modules and the four pure
utilities. Service and mapper modules are absent from this table by design —
Rule 7 §11 covers them by integration, which is what the `src/__tests__/api/*`
suites are.

### Read figures measured elsewhere, and what they exclude

**Why these two records sit here rather than in an artefact.** This section's
own rule — a run's headline outcome in the index above, its full measurement in
the artefact that produced it — cannot be followed for the figures below,
because **no artefact exists for them.** The only generated report in this
folder's data directory that carries latencies is the search benchmark's, and
it measures catalogue search rather than any of the reads below; nothing in
this repository publishes a read-latency artefact that a later measurement
could read or compare itself against. This subsection is the only durable
surface these figures have — and that absence is not an oversight, it is
precisely what the second record is about.

**Whose measurements these are, and why their conditions travel with them.**
Neither record is this delivery's own work. Both were produced by sibling QA
boundaries, each working in an independent clone against its own disposable
`*_test` database — created, migrated, catalogue-loaded and seeded by that
boundary alone — under its own host load and with its own harness. No run in
the index above measured any of it, and nothing here should be read as this
delivery's evidence. Every figure is printed with the conditions that produced
it because those conditions are load-bearing: the host is a 12 vCPU machine
shared with roughly 64 concurrent agents at load averages between about 8.6 and
25, so **every absolute timing below is an upper bound** rather than a clean
number. What is contention-invariant — statement counts, query plans, response
shapes and status codes — is what carries a verdict; the milliseconds only
bound it. Both records are gaps as much as they are figures, and each is placed
with its numbers rather than under [What is unrun or
unverified](#what-is-unrun-or-unverified) because the numbers are the substance
of what was achievable instead of the check that could not be run.

#### The six plan-facing reads, and the auth cost their figures exclude

**Conditions.** A read-performance boundary measured the six plan-facing reads
over HTTP against its own `*_test` database, loaded with catalogue release v1 —
10,928 published foods, 42 recipe versions, 269 ingredient rows — plus a
synthetic scale load of roughly 100× that data volume, on PostgreSQL 16.15
reached over loopback, with `ANALYZE` run after every load. Its protocol was
one untimed warm-up request, then at least five timed requests per case, with
the statement count captured per request. Across two full re-runs the statement
counts showed **zero variance** while p50 latency moved by about **±20 %**,
which is the accuracy these figures have.

| Read | Statements per request | p50 | p95 | Response bytes |
| --- | --- | --- | --- | --- |
| `GET /meal-planning/plans/current` | 26 | 32.51 ms | 33.92 ms | 90,334 |
| `GET /meal-planning/plans/:planId/days/:date` | 12 | 6.99 ms | 7.99 ms | 5,676 |
| `GET /meal-planning/plans/:planId/affected-meals` | 4 | 5.78 ms | 7.75 ms | 3,838 |
| `GET /meal-planning/plans/:planId/groceries` | 5 | 25.11 ms | 27.10 ms | 101,964 |
| `GET …/meals/:mealId/alternatives` | 16 | 25.50 ms | 28.28 ms | 2,231 |
| `GET …/alternatives/:recipeVersionId/preview` | 12 | 20.28 ms | 26.33 ms | 2,104 |

**The cold path is a different number, recorded because it answers a different
question.** The first request after process start cost **89.94 ms on the day
read against 6.99 ms warm** — 12.9× — with the statement count identical cold
and warm, so what it measures is Prisma engine and connection initialisation
rather than extra queries. The other reads' cold multiples were 1.3× to 1.4×.
That figure bears on the first request after a deploy or a restart, which is
the same question the one-time key fetch below lands on.

**What every figure above excludes, exactly.** That boundary had no development
Firebase identity token — the reason, and what it leaves unverified, are under
[What is unrun or unverified](#what-is-unrun-or-unverified) — and its harness
replaced exactly one thing to get past the middleware: `verifyIdToken`, the
same identity channel this repository's own `src/__tests__/setup/jestSetup.ts`
mock replaces. Everything else ran untouched — the real Express application,
`authenticateFirebaseToken` itself, the routes, the controllers, the services
and the Prisma client — and an unauthenticated request still returned **401**.
So the consequence is stated rather than left to be inferred: **every latency
figure above excludes Firebase token verification**, and none of them is an
end-to-end production figure.

**What that substitution does not reach.** Statement counts, `EXPLAIN` plans,
N+1 verdicts, index verdicts and the concurrency statement counts do not
involve the auth path at all, so the exclusion does not qualify them; it
qualifies the latencies and nothing else. The distinction is worth drawing in
both directions — a disclosure that quietly withdrew the structural verdicts
too would over-claim as surely as one that hid the exclusion.

**How large the excluded cost is — measured, not estimated.** A sibling
write-performance boundary measured it on the same host against the same real
middleware: one RS256 verification with no network costs about **3.0 ms warm**,
and the one-time public-key fetch costs about **60 ms once** after process
start. A real-token deployment therefore adds roughly 3 ms to each warm figure
above, and roughly 60 ms once to the first authenticated request after a
restart. Those two numbers are what make the disclosure usable rather than
merely cautious: the exclusion is bounded, and bounded by a measurement rather
than by a guess.

#### The forward read baseline, and the comparison an isolated clone cannot make

**Why the comparison was unperformable rather than skipped.** A checkpoint item
asked a later measurement to confirm that the earlier boundaries' read figures
were unchanged on the database it worked against. From an isolated per-agent
clone that cannot be executed as a comparison at all: each boundary works in
its own clone against its own `*_test` database, which that boundary creates,
migrates, catalogue-loads and seeds itself, so **there is no prior read
measurement on that database to compare against** — no sibling has ever touched
it, and every sibling figure was taken on its own database under its own host
load. Nor is there anywhere to look them up: nothing in this repository layout
publishes earlier read figures where a later boundary could read them, which is
the same absence stated at the head of this subsection.

**What was executed instead, and what it is for.** A write-performance
boundary, working on a different `*_test` database, ran all six read endpoints
again **after its entire write campaign** — 10,928 catalogue foods loaded, and
1,131 grocery rows, 644 plan meals and 39 action rows written — and every one
still answered **200 with the correct shape at stable low latency**. That is a
forward baseline rather than a comparison, and it is published in the form that
makes a comparison possible later: the endpoint, its p50 and its max, beside
the dataset counts above and the conditions it was taken under — the same
shared 12 vCPU host at load averages of 8.7 to 25.3, one untimed warm-up
request then at least five timed ones per endpoint, durations from
`process.hrtime`.

| Read | p50 | max |
| --- | --- | --- |
| `GET /api/macros/:date` (the legacy diary read) | 2.51 ms | 3.17 ms |
| `GET /meal-planning/targets` | 1.15 ms | 1.46 ms |
| `GET /meal-planning/plans/current` | 13.25 ms | 13.75 ms |
| `GET /meal-planning/plans/:planId/days/:date` | 6.15 ms | 6.52 ms |
| `GET /meal-planning/plans/:planId/groceries` | 7.27 ms | 10.47 ms |
| `GET /catalog/foods?q=chicken&limit=25` | 120.97 ms | 136.18 ms |

**One row there is the one a later reader should notice.** The catalogue search
answered in **120.97 ms at p50**, returning 25 of 672 matches — an order of
magnitude above every other read in the table. The boundary that measured it
placed catalogue-search latency **outside its own scope** and raised no finding
on it, so it is recorded here as a figure to compare against and not as a
verdict. It is also not the same measurement as the benchmark's: check 15's p95
of 62.735 ms is the whole query set timed in process against
`catalog.service.searchPublishedFoods`, while this is one query over HTTP under
the load conditions above, so neither figure disposes of the other and they
must not be read as a pair.

**What this record closes, and what it leaves open.** The gap came with two
possible resolutions. This is the second of them — restate the item as *record
read-path figures on this database as a forward baseline* — and that is
**closed** by the table above, published in the comparable form the boundary
supplied it in. The first — publish the earlier read boundaries' figures into a
shared artefact that later boundaries in the same batch can read, so the
comparison becomes performable — **remains open**, and not by choice: nothing
in this repository layout provides such an artefact. The three generated
reports under `data/meal-planning/reports/latest/` cover the catalogue import,
its validation and the search benchmark; none of them records an endpoint
latency, and each clone's own figures exist only in that clone. Closing it
needs a durable shared location for read measurements, which is a decision for
whoever owns the batch rather than something this document can take.

## The seven user-specified rules, clause by clause

Seven rules govern this work — six for the app and one for the API. The table
below is one row per rule, each stating the clauses it was checked against, the
verdict, and the evidence that establishes it: a command whose output was read,
or a file and line that was read. Nothing here is carried from an earlier
report. Where the delivered code departs from a clause's literal words, the row
says so and the note beneath it gives the reason — a rule reported clean by
omitting its awkward cases would be worth nothing.

The rules themselves are summarised in the Agent Action Plan §0.10, which is
what implementers are given, and the clause groupings below follow that
summary. Counts were measured with the repository at the commits named under
[Provenance](#what-was-verified-in-this-environment) plus this documentation.

| # | Rule | Clauses checked | Verdict | Evidence read or command run |
| --- | --- | --- | --- | --- |
| 1 | `mobile-architecture` | TanStack for all server state through `queries/<domain>/` hooks and `queries/api/<domain>/` request functions; io-ts codecs with shared `decoder/` and `converter/`; Zustand for device state only; no direct axios; no Redux; no inline styles; copy from `@constants/strings`; typed navigation params | **PASS**, with one narrow deviation stated in note 1a | 22 hooks under `src/queries/mealPlanning` + `src/queries/catalog`, 21 request functions under `src/queries/api/{mealPlanning,catalog}`, 2 decoder modules and 9 converters. `grep -rn 'style={{' src --include='*.tsx'` → 6 hits, every one in `PreviousWorkoutEntries` or `debug/DebugScreen`, both pre-existing and both recorded in the lint baseline; zero in any file this feature authored. `grep -rln redux src` → 0. `useMealPlanStore` carries no plan, recipe or grocery payload — `grep -cE 'plan:\|recipes:\|groceries:\|items:'` → 0. `src/navigation/types.ts` declares 24 meal-planning route entries and 23 `RouteProp` aliases |
| 2 | `mobile-component-structure` | `interface Props`, never `React.FC`, spread props or nested definitions; one component per file with a co-located styled module; pure `index.util.ts` with a colocated test; the util scope rule; reuse of the base components | **PASS**, with the `Props` shape of two components stated in note 2a | `grep -rn 'React\.FC' src` → **0**. Every `index.util.ts` in the repository has a colocated `__tests__/index.util.test.ts` — checked by iterating all of them, **0 without**. `grep -rn "from '[^']*/\(components\|screens\)/[^']*/index\.util'"` → **0**, so no component imports another's util. Five component directories carry no styled module: four are pre-existing (`TickerText`, `CreateTemplateModal`, `ExerciseOptionsBottomSheet`, `Register`) and the fifth is this feature's `GroceryList/components/GroceryRow`, which is a seven-line dispatcher returning `GroceryFlagRow` or `GroceryItemRow` and declares no style of its own — read in full |
| 3 | `mobile-file-conventions` | PascalCase screen folders; camelCase query files; every key in `queries/keys.ts`; one API function per file; `decoder/` and `converter/` subfolders; the store path; navigation stacks plus `RouteProp` aliases; `__tests__/<name>.test.ts`; tokens under `src/styles` | **PASS** | No API file exports more than one function — checked file by file across both `queries/api` domains, **0 over one**. `grep -rn 'queryKey: \['` outside `keys.ts` → 2 hits, both inside test files constructing a literal key to assert against, which is the only way to assert one. `src/store/mealPlan/useMealPlanStore.ts` is at the prescribed path. `find src -path '*__tests__*' -name '*.ts' ! -name '*.test.ts'` → **0** misnamed test files. Six token modules under `src/styles` |
| 4 | `mobile-helper-functions` | Pure, typed, tested named exports under `src/utility/`; time-dependent helpers take their clock as a parameter; tests under `src/utility/__tests__` with describe-per-function; dependency injection over mocking | **PASS** | All six utilities this feature adds — `ServingsUtility`, `NutritionFormatUtility`, `UnitConversionUtility`, `MealPlanDateUtility`, `IdempotencyUtility`, `RevisionConflictUtility` — exist with a colocated test, **6 of 6**. `grep -rn 'new Date()' src/utility` → 3 hits, all in the pre-existing `RunUtility` and `DateUtility`; none in the six. `MealPlanDateUtility` takes `now` as a parameter and `IdempotencyUtility.mintKey` takes its UUID source, so neither reaches for a global — read at their signatures |
| 5 | `mobile-state-management` | The server/device split; centralized keys; mutations owning cache updates in `onSuccess` while call sites own toasts and navigation; `useInfiniteQuery` driven by the API pagination block; the `PERSISTED_QUERY_KEYS` whitelist; one store per domain with `reset()`; React Context for flow drafts; `useState` for form inputs | **PASS** | 15 mutation option factories with **15** colocated `*.util.test.ts`, which is what makes each `onSuccess` invalidation set assertable without a renderer. `PERSISTED_QUERY_KEYS` holds 7 entries, `mealPlanCurrent` the only one this feature adds. `useMealPlanStore` declares `reset()` and `useAuthStore`'s logout calls it — three references. `MealPlanSetupProvider` is a `createContext` provider, not a store. `getNextPageParam` lives in `useCatalogSearchInfiniteQuery.util.ts:46` and is driven by the response's own `page`/`totalPages`, pinned by `useCatalogSearchInfiniteQuery.test.ts:176-180` |
| 6 | `mobile-styling` | Styles in `index.styled.ts` through `StyleSheet.create`; `@styles` tokens for colour, spacing, radius, shadow, size, stroke, opacity and type metrics; no inline literals; no magic numbers; no hardcoded hex; migrate on touch | **PASS — and clean for the first time at this boundary** | The token gate over the widened scope: `node scripts/token-literal-scan.mjs $(git diff --name-only --diff-filter=ACMR master -- 'src/**/*.styled.*' 'src/**/*.tsx' ':(exclude)src/**/__tests__/**')` → **exit 0 over 213 files**. That scope is itself part of this remediation: the gate previously read only `index.styled.ts` and so could not see a style literal written as a JSX attribute, which is how `activeOpacity={0.7}` survived. Widening it surfaced twelve such literals, all migrated in the same change — one `0.5` to `Opacity.PRESSED_TARGET_ROW`, six `0.6` to `PRESSED` and five `0.7` to `PRESSED_SUBTLE` — changing no rendered value. Across the whole feature diff **17** numeric `activeOpacity` attributes have been replaced by tokens and **0** added, against 61 token-based ones now in place. `grep -rnE "'#[0-9A-Fa-f]{3,8}'"` and `grep -rn 'rgba('` outside `src/styles` → 4 hits, all in pre-existing modules (`GlobalBottomSheet`, `Skeleton`, `RunCountdownOverlay`); none in a file this feature authored |
| 7 | `backend-architecture` | route → controller → service → pure `*.logic.ts` → mapper; `getUserId`, a pure parser, one service call and a typed error mapped to a status; `user_id` in every predicate including updates and deletes; 404 never 403; typed error classes; vendor boundaries as `<domain>.service.ts` with configuration read once and vendor errors wrapped; meter before spend; `ipv4first` before any network module; snake_case Prisma models; a real Jest suite replacing the stub | **PASS**, with the one AAP-frozen predicate stated in note 7a | 11 routers, 10 controllers, 11 pure logic modules with **11 of 11** colocated tests, 4 mappers. `getUserId` is imported by **10 of 10** controllers. `grep -rn 'status(403)'` across `src` → **0**. `mealPlanning.errors.ts` declares 21 typed error classes. The controller boundary is not asserted by inspection but by two suites: `controllerBoundary.test.ts` (37 cases, including "the parse happens at the boundary, before the service is called" and "a well-formed request reaches its service exactly once") and `requestParserWiring.test.ts` (63 cases, one per entry point). Three vendor boundaries exist as services, with `OpenRouterError` and `getOpenRouterConfig` in `openrouter.service.ts`; `scripts/lib/budget.ts` reserves before every model call; `ipv4first` is set in both `src/server.ts` and `scripts/lib/bootstrap.ts`; 32 snake_case Prisma models and **0** PascalCase; `npm test` is `jest --ci --runInBand --coverage`, a real run of 56 suites and 10,720 tests |

**Note 1a — the one axios import in feature code.** `src/queries/api/mealPlanning/fetchNutritionTargets.ts` imports `axios`, and eight other files in the repository do too. Eight are a pre-existing utility and its test, two pre-existing run-domain files, and test fixtures constructing an `AxiosError`. The ninth is this feature's, and it is not a request: the request is `httpGet(Endpoints.MealPlanTargets, TargetsResponse)` on line 31, and `axios.isAxiosError` on line 39 is used only as a type predicate to recognise the bare 404 that AAP §0.7.5 requires be mapped to "no server targets" rather than an error — the case a rolled-back backend produces. The rule forbids issuing requests outside `httpUtil`, which this does not do; narrowing the error `httpUtil` rethrows needs the vendor's own type guard.

**Note 2a — two components declare `Props` as a union of interfaces.** `CatalogSearchField` and `SetupFooter` each declare `interface`s and then `type Props = A | B` rather than a single `interface Props`. Both are genuinely two-shaped: the search field is either the tap target of screen 06 or the controlled input of 06b, and the footer is either the stacked or the split Figma template. A discriminated union is the only way to type that contract, both take an explicitly typed `props: Props`, and neither uses `React.FC` or spreads props into JSX — so the clause's intent (a named props contract, declared, not inline) holds while its literal wording does not.

**Note 7a — one pre-existing write predicate the AAP freezes.** Every write this feature authors carries its owner: the swap's meal update goes through `swapMealWhere` (`swap.logic.ts:937-946`), which returns `{id, user_id, meal_plan_id}`, and `updateMealEntry` was given an owner-bearing `where` during this work. Eleven update or delete calls in `src/services` have no `user_id` within three lines; nine are in pre-existing services this feature does not touch (`exercise`, `food`, `migration`, `run`, `user`, `workout`), one is the grep mis-reading a multi-line statement in `swap.service.ts:1407` whose predicate is the helper above, and the last is `nutrition.service.ts:183` — the `logMealEntry` dedupe branch, which updates by `existing.id` after finding the row through the caller's own `meal_id`. AAP §0.5.1 requires that branch to stay **byte-for-byte unchanged**, so it is frozen by instruction rather than overlooked, and the AAP outranks a rule's suggested treatment.

**One violation was found by this pass and fixed rather than reported.**
`catalog.controller.ts`'s 500 handler called `console.error(fallback, error)`, handing the whole throw to the log formatter — a stack, a Prisma `meta` carrying a failing statement's values, or a vendor response body all render in full, and a message containing newlines can forge a following log line (CWE-532/CWE-117). Its sibling `mealPlanning.controller.ts` had already replaced exactly that pattern with `logSafeEvent` plus `describeErrorSafely`, which emit a name, a machine code and declared scalar fields only; this handler had been left behind. It now takes the same treatment, with the response body unchanged. `grep -rn 'console\.'` across the feature's own files now returns only prose in comments describing what was removed.

## What is unrun or unverified

Each gap below states why it exists and what would close it. Nothing here is
presented as a near-miss.

- **Native iOS build, simulator and visual comparison were unavailable.** This
  work was done in a Linux environment with no macOS, no Xcode and no iOS
  tooling, so the app was never built or run natively and no screen was ever
  compared against its frame. **The physical-device verification checklist is
  therefore unrun** — the word is used deliberately, and it appears at the head
  of that section too. The iOS build secret (the development Firebase property
  list, supplied by path through its documented environment variable) was also
  not provided. Closing this needs a macOS machine with Xcode, that file
  injected as an untracked file, and a human executing the checklist.
- **The Android build is unverified beyond TypeScript.** There is no Android SDK
  in this environment, and the development Firebase configuration file the app
  configuration references was not supplied either. The app's typecheck passes
  for both platforms, which says nothing about whether an Android binary
  assembles. Both files are secret build prerequisites to be injected as
  untracked files and **never committed**. Closing this needs a configured
  Android SDK and that file.
- **No component rendering is asserted anywhere.** The app repository has no
  renderer or component-testing library installed, and adding one was out of
  scope, so screen behaviour is covered through pure functions and mutation
  option factories rather than by rendering a tree. Every visual and interaction
  claim therefore rests on the device checklist. The app repository records the
  same absence from the side the screens live on, and in more detail than
  belongs here: `app: docs/meal-planning.md` § 10 names **six** measurement
  passes as unrun in the strong sense — measured geometry per device class,
  which is the one it marks blocking; the six dynamic-type combinations; the
  VoiceOver and TalkBack passes; native confirmation of the recipe and swap
  states; pixel comparison with the interactive states, gestures and console
  cleanliness; and a regression pass over the shipped screens beside a
  pre-feature build — each with what was run instead and the steps that close
  it. The walkthrough below is deliberately the shorter, API-facing form of the
  same run; where the two describe one step, that section carries the detail.
- **The supplied production database host was unreachable from here**, which is
  correct — development and tests must never touch production data. Schema, API
  and catalogue verification used a local PostgreSQL 16.15 instead, and the
  exact patch version is recorded in the generated benchmark report so the
  evidence stays reproducible. Nothing in this work connected to production.
- **Authenticated endpoint calls were not exercised against a running server,
  and the gap is wider than the token-verification step.** No development
  Firebase account or identity token was available. The boundary itself is
  proven rather than assumed: check 18's unauthenticated request returned 401,
  and a sibling legacy-regression pass then drove that boundary adversarially
  from its own clone — **48 read probes and 8 write probes, every one 401, with
  nothing persisted by any of them**. Every legacy read and write was exercised
  instead **through the real service layer the controllers serialize** rather
  than over HTTP — 22 of 22 response-shape probes plus 40 create, read, update
  and delete steps against a live development database — so the handlers'
  behaviour is evidenced while their HTTP surface, reached with a real
  identity, is not. An earlier revision of this bullet said the gap was "only
  the live token-verification path"; that was too narrow, and it is corrected
  here rather than quietly widened, because every legacy response shape this
  work relies on was recorded one layer below the wire.

  **Why no identity token exists here, in the order the chain fails.** The auth
  path itself runs. A real custom token **mints successfully** through
  `firebase-admin`, and `verifyIdToken` then **refuses it by design**,
  reporting `auth/argument-error` — it expects an ID token and was given a
  custom token — so the middleware genuinely executes and discriminates token
  types, and there is no library incompatibility to chase. Turning that custom
  token into an ID token takes one exchange through Google Identity Toolkit,
  and that exchange needs **the development project's Firebase Web API key,
  which this environment does not hold**: `FIREBASE_API_KEY`,
  `FIREBASE_WEB_API_KEY` and `EXPO_PUBLIC_FIREBASE_API_KEY` are all unset, and
  the platform's `GOOGLE_API_KEY` is a platform credential rather than this
  project's Web API key. The exchange would also **auto-provision a uid in the
  development project's live Firebase directory**, which holds real user
  records and which the environment instructions forbid touching — so it was
  never attempted. That last step is a **policy refusal rather than a
  capability gap**, and no Firebase user was created at any point.

  **What this leaves unverified** is the live token-verification path **and**
  the legacy read and write endpoints' behaviour over real HTTP with a real
  identity — twelve reads and four writes whose shapes are recorded only from
  the service layer, since every handler behind the middleware is exercised in
  process by the `src/__tests__/api/*` suites with the auth middleware mocked.
  **Closing it, precisely:** obtain the development project's Firebase Web API
  key and a development test account; mint a custom token for that account's
  uid and exchange it for an ID token by posting to Google Identity Toolkit's
  `/v1/accounts:signInWithCustomToken` endpoint with that Web API key as its
  `key` query parameter — the parameter is named here and no key value appears
  in this document; then replay those 12 legacy reads and 4 legacy writes with
  the resulting ID token against the running API and compare each response body
  **field by field** against the service-layer shapes recorded above. What
  token verification costs, measured rather than estimated, is recorded with
  [the read figures measured
  elsewhere](#read-figures-measured-elsewhere-and-what-they-exclude).
- **Reaching the published catalogue counts depends on conditions outside this
  checkout** — the vendor's hourly rate limit, model availability during offline
  seeding, and identity evidence passing its checks. The aggregate requirement
  **is** met, at 10,928 items against 10,000; the **per-category plan is not**,
  with 13 of 21 categories short by 2,361 items in total, of which 2,174 exceed
  every row the vendor returned for their category. That shortfall is reported
  exactly by the catalogue report and is to be treated as an **unmet
  requirement, never fabricated** and never smoothed against the categories that
  over-deliver.
- **Search relevance is met**, as measured, and is described
  [above](#the-search-benchmark-is-met-and-what-it-does-not-cover). The
  measurement is sound and reproducible across databases; the four queries that
  still fall outside the top ten are named rather than averaged away, and the
  result stands for the corpus and conditions that report names and no others.
- **Nothing in the run was skipped, and that is stated because a skip is not a
  pass.** The `pg_dump` schema-dump cross-check inside the dual-ledger
  equivalence gate is the assertion this once read as missing: the gate now
  resolves a dump runner whose major version is at least the server's —
  `pg_dump` inside the container publishing the port `DATABASE_URL` names — and
  a dump it cannot produce FAILS the gate instead of skipping it, so the
  comparison is either real evidence or a red build.
- **The CI workflow has not been observed running on a hosted runner** from this
  environment. Each of its steps was executed locally instead, against a local
  PostgreSQL rather than the workflow's service container. Opening the pull
  request is what produces the first real run.
- **A stored weigh-in carries no unit, so the body step's suggestion can be
  read in the wrong one.** `body_weight_entries` has no unit column and never
  gains one here, so a weigh-in is a bare number: the app can only read it in
  the unit selected **today**. The prefill is therefore a labelled suggestion —
  the stored number offered as-is under the caption "From your last weigh-in.
  Edit if it's changed.", only when reading it in the current unit lands inside
  the supported body-weight range (30–300 kg, i.e. about 66–661 lb), and not at
  all when that unit is stone, which the control does not offer. The residual
  risk this leaves, and it is not closed: a number typed under an **earlier**
  unit — 182 entered as pounds, the unit since switched to kilograms — passes
  the range check and is shown as 182 kg. The caption and the **required**
  explicit confirmation are the only safeguards; nothing is converted for the
  user, no weigh-in row is created, modified or rewritten, and no unit
  provenance is added to the history. Closing it properly needs a unit recorded
  against each weigh-in, which is out of scope here. The app-side record of the
  same limitation, written where the screen lives and carrying the device step
  that exercises it, is `app: docs/meal-planning.md` § "The weigh-in prefill,
  and the unit it cannot know" — the two are deliberately the same policy in
  both repositories, because the field is drawn by the app and the column
  belongs to the API. The rule as implemented is
  pinned by `app: src/screens/MealPlanAboutYou/__tests__/index.util.test.ts`
  (`resolveWeighInPrefill`: no weigh-in, the stone suppression, the range gate
  in both units) and the conversions by
  `app: src/utility/__tests__/UnitConversionUtility.test.ts`.
- **No operator action was performed.** Neither pull request was merged, nothing
  was deployed, and no store release was submitted — all three are outside the
  scope of this work and forbidden by it. The procedure an operator follows,
  including the order in which the API precedes the app and the kill switches
  available at each step, is in
  [`release-and-recovery.md`](./release-and-recovery.md).

## Dispositions awaiting a human ruling

Two items below are neither verification gaps nor defects this work may fix.
Each is a **recorded disposition** — the first on a known advisory, the second on
a set of colour pairs that ship below their accessibility thresholds — written
down because the decision belongs to a human and nothing in this work has the
authority to take it. Neither is resolved, and both are stated here rather than
left to `npm audit` output nobody reads or to a code comment no designer opens.

### `uuid@9.0.1` — GHSA-w5hq-g745-h8pq, accepted risk pending a ruling

**The advisory.** `uuid` below 11.1.1 carries GHSA-w5hq-g745-h8pq (moderate,
CWE-787/CWE-1285): *missing buffer bounds check in v3/v5/v6 when `buf` is
provided.* The vulnerable path is the optional output-buffer form — a caller
passing its own `buf` (and offset) to `v3()`, `v5()` or `v6()`, where a buffer
too small for sixteen bytes is written past its end. The package is declared as
`"uuid": "^9.0.1"` in `dependencies`, and `npm audit` reports this advisory
today; a clean audit is not being claimed.

**Why the path is unreachable in this repository, and how that was established.**
Four modules import `uuid` — `src/services/workout.service.ts`,
`record.service.ts`, `exercise.service.ts` and `run.service.ts` — each as
`import { v4 as uuidv4 } from 'uuid'`, and all **seven** call sites are a
zero-argument `uuidv4()`. No module in `src/` or `scripts/` imports `v3`, `v5`
or `v6`, so no `buf` argument exists to overflow; a grep across the installed
tree finds **no** `v3`/`v5`/`v6` call at all, including in the transitive
consumers that resolve to this same copy — `gaxios` 6.7.1, `teeny-request`
9.0.0 and `google-gax` 4.6.1 each call `v4` only, as does
`@google-cloud/storage` 7.16.0 against its own `uuid` 8.3.2, while
`firebase-admin`'s direct copy is `uuid` 11.1.1 and sits past the advisory
range. The exposure is therefore an unreachable code path in an installed
package, not a reachable weakness in this service.

**Why the version is not simply raised.** The AAP freezes it. §0.4.1 lists the
backend's `uuid` at 9.0.1 under versions that stay unchanged, §0.4.2 sanctions
exactly one change to it — moving it from `devDependencies` to `dependencies` at
the same pinned version, with `@types/uuid` staying dev-only — and §0.1.2
forbids upgrading frameworks for this feature. That sanctioned move is what is
delivered (`dependencies.uuid` `^9.0.1`, no `devDependencies.uuid`,
`devDependencies["@types/uuid"]` `^9.0.8`), and check 19 above is the evidence
that it resolves inside the `--omit=dev` production image. A bump to `^11.1.1`
was attempted during this work and **withdrawn** in commit `360c765`, on the
grounds that the AAP outranks a finding's suggested resolution.

**What this disposition is, and what would close it.** It is an accepted risk
awaiting a maintainer's ruling — one of two outcomes, neither of which an agent
may choose: an **AAP amendment** authorising `uuid` at 11.1.1 or later, after
which the bump, a fresh `npm ci` and a full suite run are the work; or a
**recorded acceptance** of the unreachable path at the pinned version, which is
what this section documents in the meantime. Until one of those is on record the
version stays at 9.0.1 and the advisory stays open.

### Eight Figma-exact colour pairs below their WCAG 2.1 thresholds — pending a design ruling

**What ships.** `app: src/styles/theme.ts` carries an accessible-colour register
whose status is recorded in two parts, because the two halves have different
owners: **engineering, complete** and **design, open**. Eight pairs render below
the threshold their use would require. The four text pairs are `white` on
`green` at **2.45:1** where button and pill labels need 4.5:1 (600/16px and
600/13px are not large text), `textFaint` as a placeholder at **3.31:1** on
`inset` and **3.28:1** on `dangerTint`, `textMuted` on `tile` at **4.40:1** —
short by 0.10, the narrowest miss — and `danger` on `dangerTint` at **4.41:1** in
the grocery delta pill. Four more are non-text UI component pairs needing 3:1:
`textDisabled` as a hollow indicator or checkbox outline (2.23:1 on `card`),
`inputBorder` on `inset` (**1.12:1**, so an unfocused field has no identifiable
boundary), the clear-disc glyph pair (1.94:1 and 2.49:1), and `textFaint` /
`textDisabled` as muted row text (3.81:1 and 2.23:1). Every ratio in the register
was recomputed from the token values during this remediation and each one is
exact to the second decimal as written.

**Why they were not raised.** The AAP makes Figma the visual source of truth
(§0.1.2) and orders precedence token compliance, then Figma fidelity, then
accessibility (§0.6.5); every one of these colours is recorded there as an exact
1:1 token match (§0.2.2, §0.6.3), and each pair was re-verified node by node
against Figma file `ZytSsn2tKVpMCSoibMJ274` and is drawn there exactly as the app
renders it. §0.6.5's accessibility rule is explicit about this case: where Figma
specifies a value that computes below the minimum, match Figma **exactly**, emit
the `BLITZY [A11Y]` marker for designer review, and never silently darken or
lighten a rendered colour. Silently raising one would also reach far outside this
feature — this is the app-wide palette, and `green` alone backs `accentGreen`,
`success`, `secondaryLighter` and `barActive`, which paint shipped surfaces
§0.8.2 holds out of scope, including the bottom tab bar.

**What engineering did supply.** The accessibility work that needs no ruling is
applied throughout: an `accessibilityRole` and an `accessibilityLabel` on every
pressable (§0.7.2), 44px touch targets (§0.6.5), and `TextField` forwarding an
`accessibilityLabel` to its input so assistive technology reads a field's purpose
from the label and never from the low-contrast placeholder — which bounds pair 2
to the sighted low-vision case. The register itself makes the ruling cheap rather
than investigative: each entry names the Figma nodes that draw it, the measured
ratio, the threshold it misses and a **pre-computed remedy** given as an existing
palette token wherever one already clears it — `page` on `green` measures 7.67:1
and `greenTint` on `green` 5.52:1 against the accent, `textSecondary` reaches
6.01:1 on `inset`, 5.95:1 on `dangerTint` and 6.40:1 on `tile`, `textMuted` gives
4.75:1 on `card` — so most require no new colour at all. Where only a new value
would do, the register states the target instead: relative luminance at or below
0.183 for text on the accent and 0.300 for glyphs, against the accent's measured
0.3783. The marker is emitted at the register and at every point of use — 30
occurrences across 23 files, listed by `grep -rn 'BLITZY \[A11Y\]' src` in the
app repository — so the debt is findable from the code and not only from a report.

**What this disposition is, and what would close it.** It is accepted, tracked
accessibility debt awaiting a design decision, and the register does not make the
palette compliant — it records the decision that has not been taken. One of two
outcomes closes each entry, neither of which an agent may choose: **accept the
Figma value** with the exception recorded, or **adopt the remedy named with it**,
after which applying it is mechanical. Until one is on record the rendered values
stay exactly as Figma draws them. The full register, with per-entry Figma node
ids, is in `app: src/styles/theme.ts`; the app-side handoff note is `app:
docs/meal-planning.md` § "Three gaps left open", item 3.

## The physical-device checklist — UNRUN

**This checklist has not been run.** No step below has been executed: this
environment has no macOS, no Xcode and no iOS tooling, so nothing here is a
record of an observation. It is written to be executed by someone holding a
device, and it is the only evidence that will ever cover the visual and
interaction dimension of the flows above — every `ready-for-human-review` row
points here.

The drawn failure states are unreachable with healthy inputs, so a
**development-only fault-injection variable** exists to reach them without
breaking anything. Its name, accepted values and per-value effect are documented
in [`README.md`](./README.md) and are not restated here. It is inert when the
environment is production, and it **must never be set in a production
environment** regardless. Set it, exercise the state, then unset it.

### Preconditions

1. The API runs from a development environment against a development database,
   with the catalogue release loaded and the recipes seeded — the command order
   is in [`README.md`](./README.md). The server-side meal-planning capability
   flag must be on; until it is, the planner routes answer with the
   capability-disabled code by design.
2. The remote-configuration flag that gates the feature in the app is true in
   the **development** project and has been fetched at least once. The packaged
   default is off and the app fetches at launch, so flip it and then cold-start
   the app — a foregrounded app keeps its last activated value.
3. The app points at the development API. Confirm this before anything else: the
   app's origin guard prints the resolved origin and refuses a production origin
   in development and test builds. **Do not proceed if the printed origin is not
   the development one.** Reference variables by name from
   [`README.md`](./README.md); never paste a value into a report.
4. Sign in with a development test account. Credentials belong in the secret
   store, never in this document or in a result write-up.

### The walkthrough

1. **Entry and onboarding.** Open the macros screen, switch to the plan segment,
   confirm the no-plan state, and start setup. Walk all eight steps. At each
   step confirm **nothing is preselected** and that entering nothing and
   pressing the primary action produces inline errors on every offending control
   while keeping the values already typed. Check the body step's weigh-in
   suggestion is labelled as a suggestion and must be confirmed — and read it
   against your own last weigh-in before accepting it, because a stored weigh-in
   carries no unit and the suggestion is that bare number read in the unit
   selected today, never a conversion ([the limitation in
   full](#what-is-unrun-or-unverified)). Switch the weight unit and confirm the
   suggestion is withheld once the number falls outside the supported range, and
   that a stone preference is offered no suggestion at all. Take the skip route
   once and confirm it goes to manual targets, skips the activity step, and that
   the step counter reflects the shorter route.
2. **Resume.** Force-quit mid-setup, relaunch, and confirm the plan segment
   offers to continue and resumes at the step last saved.
3. **Targets.** On review, confirm the estimate is shown, edit it, save, and
   then confirm the **same** number appears on the account screen, on the diary
   summary and on the progress target. Confirm the account row opens the
   full-screen editor rather than the legacy dialog once server targets exist.
4. **Generation.** Generate, and confirm the indeterminate progress indicator
   shows no fake percentage. Then reach each failure state: the generic failure
   and the no-compatible-plan state (the latter is also reachable with real data
   by combining a narrow diet, the tightest cooking time and many dislikes).
   Confirm answers are preserved, that retrying uses the same request identity,
   that each edit affordance opens the step it names, and that allergies are
   never proposed for relaxation. Repeat once in the regeneration context and
   confirm the retained plan is untouched.
5. **Plan day and recipe detail.** Confirm the day strip shows the saved week's
   seven dates, that planned totals never use consumed wording and show no ring,
   and that the grocery action is the header's only action. Open a recipe,
   toggle between the planned portion and the full recipe, and confirm only the
   displayed amounts change.
6. **Swap.** Swap a meal through loading, alternatives and preview, and confirm
   only the final confirmation commits. Confirm the success toast. Then reach a
   slot with no alternatives, and the confirmed failure state — confirming it
   says plainly that the meal and the grocery list are unchanged. Finally, put
   the device in airplane mode during a commit and confirm the
   unconfirmed-outcome state appears instead, **without** the "unchanged"
   reassurance, and that retrying resolves to either the committed or the
   unchanged state exactly once.
7. **Groceries.** Open the list, check items, and confirm checks persist across
   navigation. Perform a swap that increases an already-checked ingredient and
   confirm the item **stays checked** and is visibly flagged with the old
   amount, the new amount and the difference. Use the uncheck-all action, and
   confirm it is absent when nothing is checked. Confirm the no-plan and
   empty-list states are different copy.
8. **Logging.** Log a planned meal, exercising the stepper and the fraction
   chips, and confirm they behave and look like the existing food-detail screen.
   Confirm the snack bucket appears only for a schedule that includes one.
   Confirm the displayed addition matches what lands in the diary. Tap the
   primary action twice quickly and confirm **one** entry results. Confirm the
   return to the plan day keeps the segmented control and the tab bar, shows the
   success banner and the logged card, and that the diary link opens the
   entry's own date. In the diary, confirm the planned-meal caption on the row.
   Then edit the servings (the link survives), edit the name (the entry detaches
   and the caption disappears), and delete the entry (the plan shows it as
   unlogged). Swap a slot that has been logged and confirm the replacement is
   not marked as eaten and the earlier entry is named.
9. **Plan settings and regeneration.** Open plan settings from its row. Change
   the diet to one that conflicts with planned meals and confirm the banner and
   the flagged meals appear, that reviewing them lands on the earliest affected
   day, and that the banner clears only when no flagged meal remains. Confirm
   the confirmation dialog's counts are real values for this plan, not
   placeholders. Regenerate and confirm logged food is retained.
10. **Both kill switches.** Set the app's remote flag false and cold-start: the
    diary must look exactly as it did before the feature, with no plan segment
    and no catalogue section, and no planner request issued. Restore it, cold
    start, then switch the **server** capability flag off: the segment remains,
    the plan body shows the unavailable message, the catalogue section keeps
    working because it is not gated, and targets on the account, diary and
    progress screens keep working. Nothing crashes in either case. Restore both.
11. **Layout and accessibility.** Repeat the main flows on a small device and a
    large one, confirm tablet content is width-capped and centred, and confirm
    every screen's content stays reachable above the tab bar or pinned footer.
    Raise the system text size through its larger settings and confirm no
    primary action becomes unreachable. Run a screen-reader pass over the plan
    day, the swap preview, the grocery list and the logging screen, confirming
    every control is reachable and labelled.
12. **Capture.** Take one screenshot per screen state and compare each against
    its frame. Note the typeface deviation: the design names a licensed family
    and the app renders each platform's default, which is a recorded decision
    rather than a defect — sizes, weights, line heights and letter spacing
    should still match.

Record the outcome of each step, including any failure, and attach the
screenshots. A step that is not performed is reported as not performed.

## Cross-repository links

The deliverable is **two pull requests, one per repository, cross-linked in
their descriptions and neither merged**:

| Repository | Holds | Evidence a reviewer finds there |
| --- | --- | --- |
| **API** — `state-of-health-be` | Routes, controllers, the nine service triads and their pure logic modules, the wire types, the additive migration and its reference copy, the CLI scripts, the committed catalogue release and data manifests, the generated reports, the CI workflow, and this folder's six documents | Checks 1–19 above; the 56-suite run with its per-path coverage summary; the schema-drift and dual-ledger gates; the catalogue, validation, benchmark and recipe-coverage reports |
| **App** — `state-of-health-tracker` | The 18 new screen folders and the plan tab, the shared components and icons, the data models, the query and mutation layer, the store, the utilities, the style tokens, and the navigation registration for all 18 routes | Checks 20–23 above; the 124-suite run; the lint comparison against the recorded baseline; the token-literal gate over the styled modules and component screens the change touched |

Read them together: a reviewer checking a planner rule wants the API's logic
suite, and a reviewer checking a screen wants the app's util and option-factory
suites plus this file's device checklist. The release ordering — API first,
because every field added to a shipped response is additive and no released
client calls any of the twenty-two new routes, of which **sixteen answer `503
feature_disabled` until the capability flag is on while six are deliberately
ungated** (the three target operations and the three catalogue reads, so
account, diary, progress and food search keep working while planning is off) —
and the rollback path are in
[`release-and-recovery.md`](./release-and-recovery.md), with the per-route split
in [`api.md`](./api.md).
