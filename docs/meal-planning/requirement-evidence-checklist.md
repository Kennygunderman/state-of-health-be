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
| 3 | Repeatable USDA import and AI-assisted catalogue expansion producing the required published count, each item with a machine-readable validation record, searchable inside the existing Add Food screen. | tested; **one requirement unmet** | API `src/services/__tests__/catalog.logic.test.ts` pins the check tiers, the per-category bounds, canonical-name normalisation, the deterministic `source_key`, identity de-duplication and brand-pattern rejection. `src/services/__tests__/evidence.logic.test.ts` pins the retrieval policy row by row against the committed address table. `src/__tests__/scripts/catalog-import.test.ts` and `catalog-generate.test.ts` pin interruption, checkpoint and budget resume, and an identical rerun producing no duplicate `source_key`; `catalog-load.test.ts` pins load, no-op rerun, recovery after partial progress and a release upgrade. `src/__tests__/api/catalog.test.ts` pins the publication filter, one row per canonical food however many aliases matched, and the catalogue body accepted by the existing diary endpoint. Reports: `data/meal-planning/reports/latest/validation-report.json` and `import-report.json`. | **Aggregate met:** 11,046 published foods against a requirement of 10,000, and 11,046 of 11,046 carry a validation record with none missing. **Unmet:** 12 of the 21 categories sit below their per-category target, 2,344 items short in total — reported exactly in the report's `coverageGaps`, never smoothed against the categories that over-deliver. Search relevance over the loaded release is **met** and measured — see [the search benchmark](#the-search-benchmark-is-met-and-what-it-does-not-cover). The Add Food surface itself is `ready-for-human-review`. |
| 4 | Seeded recipe catalogue whose ingredients are all imported catalogue foods, with instructions, yield, serving description, times, diet and allergen metadata, and a documented budget tier. | tested | API `src/services/__tests__/recipe.logic.test.ts` pins nutrition derived from stored gram weights, the derivation of allergen tags, allergen status and diet tags from the full ingredient set, badge derivation, and ingredient-snapshot staleness across both the nutrition and metadata versions. `src/__tests__/api/seed-rerun.test.ts` pins the committed corpus, referential closure inside the database, the planning preconditions every ingredient must satisfy, recipe nutrition recomputed from the stored rows, and the declarations the corpus makes about itself. `src/__tests__/scripts/recipes-seed.test.ts` pins the no-op rerun, version promotion on changed content, a declared-versus-derived tag mismatch failing the run, and an unknown ingredient key failing it. Report: `data/meal-planning/recipes/coverage-report.json`. | 42 recipes against a floor of 40, with 269 ingredient rows. The seed is idempotent and its report is reproducible: re-running it here rewrote the coverage report **byte-identically** to the committed one. The report states its own boundary — combinations outside the guaranteed and reduced cells are supported at runtime but not guaranteed, and the planner answers such a user with a limiting-constraint code rather than an empty plan. |
| 5 | Persisted seven-day plan with explicit local dates, slots, recipe versions and portion multipliers; the app reopens the saved plan. | tested + ready-for-human-review | API `src/services/__tests__/mealPlan.logic.test.ts` pins the seed derivation, candidate construction and its portable pre-order, the repetition rule, the scoring terms, the tie-break fixture (`compareCandidateMoves`) and day-tolerance evaluation. `src/__tests__/api/plans.test.ts` pins every field the plan mapper derives, current-versus-upcoming resolution, the day read and regeneration. `src/__tests__/api/concurrency.test.ts` pins the per-user advisory lock, a superseded plan addressed by its old id and revision, and two parallel requests carrying one idempotency key. `app: src/screens/Macros/components/MealPlanTab/__tests__/index.util.test.ts` pins plan selection, rollover and stale-selection reset. | Determinism is a property of candidate generation, and the tie fixture is what pins it. Reopening the saved plan is exercised at the query layer; that the saved week *appears* on reopening a real app is a device check. |
| 6 | Recipe detail with the portion display toggle, ingredient quantities, serving size and planned daily totals. | tested + ready-for-human-review | API `src/services/__tests__/recipe.logic.test.ts` pins ingredient scaling as a pure function, so the toggle cannot alter stored data; `src/__tests__/api/recipes.test.ts` pins the response shape, the frozen ingredient snapshot, the closed code sets, and that a retired version is caller-scoped while a current one is shared reference data. `app: src/screens/RecipeDetail/__tests__/index.util.test.ts` pins the toggle's derived quantities and the planned-context composition. | The requirement that the toggle changes displayed amounts only is enforced structurally: the scaling function is pure and no write path exists from this screen. Layout fidelity is visual. |
| 7 | Swap flow across its states, plus the editable consumed portion at logging time. | tested + ready-for-human-review | API `src/services/__tests__/swap.logic.test.ts` pins one candidate selector shared by the list, preview and commit, portion selection, ranking, the empty-alternatives outcome, the bound-portion requirement, and a logged meal swapped twice. `src/__tests__/api/swaps.test.ts` pins the commit gates, the grocery consequences, the idempotency ledger and a grocery rebuild failing after the meal was written. `src/__tests__/api/fault.test.ts` pins the injected swap fault and a swap whose response is lost after it commits. `app: src/screens/SwapMeal/__tests__/index.util.test.ts`, `index.orchestration.test.ts`, `app: src/screens/SwapPreview/__tests__/index.util.test.ts` and `app: src/queries/mealPlanning/__tests__/useSwapMealMutation.util.test.ts` pin the four screen states and the cache contract. | The drawn loading, empty and failure states are reachable on a device only through the development-only fault-injection variable, whose values are documented in [`README.md`](./README.md). The unconfirmed-outcome variant is distinct from the drawn failure and is pinned by the fault suite. |
| 8 | Weekly grocery checklist: aggregation, aisle grouping, persisted checks, uncheck-all, flagged increases on already-checked items, and the distinct no-plan versus empty-plan states. | tested + ready-for-human-review | API `src/services/__tests__/grocery.logic.test.ts` pins planned grams per ingredient, aggregation by food and state, the epsilon at which two quantities are equal, change classification, unit-family stability, display construction and row building. `src/__tests__/api/grocery.test.ts` pins the list aggregated from planned portions, a single check mark, uncheck-all, and ownership with the capability gate. `src/__tests__/api/concurrency.test.ts` pins a toggle racing the rebuild a swap performs. `app: src/screens/GroceryList/__tests__/index.util.test.ts` pins the row variants, the two empty states and the presence rule for the uncheck-all action; the two grocery mutation option-factory tests pin the optimistic write and its rollback. | The flagged-increase rule is the subtle one and the logic suite pins it: an increase on a checked row keeps the check and compares against the **last acknowledged** amount, a sub-epsilon change is neither an increase nor a decrease, and a decrease produces no flag. |
| 9 | Planned-meal logging into the current diary bucket with the server-derived snapshot, idempotent under retries, carrying the provenance caption. | tested + ready-for-human-review | API `src/services/__tests__/plannedMealLog.logic.test.ts` pins the facts a planned entry carries, the portion and snapshot derivation, consumed totals and the diary-meal acceptability rules. `src/__tests__/api/log.test.ts` pins the bucket a planned log targets, the rounding contract, the idempotency ledger and the logged state derived from the diary. `src/services/__tests__/nutrition.logic.test.ts` pins the payload discrimination and the edit that detaches an entry from its plan. `src/__tests__/api/fault.test.ts` pins a planned log whose response is lost after it commits, replaying the stored response rather than writing twice. `app: src/data/models/__tests__/MealEntry.test.ts` pins every provenance caption, and `app: src/queries/api/macros/__tests__/MacrosDecoder.test.ts` pins the absent, null and populated forms of the new fields. | The caption *string* is pinned by the app model test; the caption *as rendered* under a diary row is visual. Deleting or editing the diary entry changing the plan's logged state is covered by the two diary mutation option-factory tests. |
| 10 | The API surface — routes, controllers, services, types, the additive migration, a real Jest suite replacing the stub, the CLI scripts, the data manifests, the handoff documents, and a PostgreSQL service in CI. | tested, with one named gap | Routes and controllers are mounted and covered by the `src/__tests__/api/*` suites; `src/__tests__/api/ownership.test.ts` pins the route inventory it is built from. The migration is evidenced by two committed artefacts and the one gate that polices both — [`expected-schema-diff.sql`](./expected-schema-diff.sql), the captured `prisma migrate diff --script` output compared as a whole file, and [`schema-catalog-evidence.sql`](./schema-catalog-evidence.sql), the `pg_catalog` extraction and expected result for the expression index, partial-index predicates and array `NOT NULL` that command cannot see — plus the dual-ledger equivalence check in `src/__tests__/api/compat.test.ts`. The stub is gone: `npm test` is a real Jest run of 51 suites, its coverage gate derived from disk by `jest.config.ts` and pinned by `src/__tests__/setup/coverageInventory.test.ts`. `src/__tests__/setup/testDb.test.ts` proves the database guard from outside the process it protects. Scripts are covered by `src/__tests__/scripts/*`. CI declares the PostgreSQL service and every gate. Both repositories' handoff documents are present: this folder's six here, and `app: docs/meal-planning.md` in the app repository, which `app: README.md` links. | **The gap:** the CI workflow has not been observed running on a hosted runner from here; each of its steps was executed locally instead, and the results are in [What was verified](#what-was-verified-in-this-environment). |

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

#### The per-category catalogue plan is unmet

The aggregate requirement is met with room to spare — 11,046 published foods
against 10,000, every one carrying a validation record. The per-category plan is
not: 12 of 21 categories are below target, 2,344 items short in total. Both
statements are true at once because a surplus in one category cannot substitute
for a shortfall in another, and recipe eligibility draws on specific categories.
`validation-report.json` and `import-report.json` carry the per-category figures
and the exact gaps; the plan and its bounds are in
[`catalog-policy.md`](./catalog-policy.md).

Both of those artefacts record the import, generation and validation run that
built the catalogue, and they are what that run measured — including its
`checkVocabulary` of **21 names**, which is the vocabulary the validator carried
when it judged those rows. The vocabulary is now **23**: `unknown_tag_code` and
`inconsistent_tag_set` judge the two safety tag lists, and the stage that judges
a stored row supplies both lists from the row, so a re-validation records both on
every item. Refreshing these two artefacts means re-running the import and
generation stages that produced the corpus they describe — a run that reaches
USDA and the model provider — so they are left as the measurement they are
rather than half-rewritten, and `catalog-report.ts` reports an item whose record
predates a check as an **unexplained gap** (a row to re-validate) rather than
explaining the absence away.

#### The search benchmark is met, and what it does not cover

`npm run search:benchmark` **fails closed and exits non-zero** on any threshold
it does not meet. Run here against the loaded release it met all four: a top-3
hit rate of 0.948 (404 of 426 queries) and a top-10 hit rate of 0.991 (422 of
426) against the bounds of 0.9 and 0.97, a zero-result rate of 0, and a p95
latency of 80.5 ms over 1,278 timed samples. The committed
`data/meal-planning/reports/latest/benchmark-report.json` records that verdict
and the per-query detail behind it, and the pagination check passed with no
repeated and no dropped row.

That report is the acceptance evidence for search quality, and it is evidence
for exactly the corpus and conditions it names — release v1 at 11,046 published
foods, measured in process against
`catalog.service.searchPublishedFoods` — and for no others. Four queries still
sit outside the top ten and are named in the report rather than averaged away:
q023 `crackers` (rank 35 of 109 matches), q236 `mushrooms` and q237 `mushroom`
(13 of 100), and q382 `chicken` (12 of 674). A pass at 0.991 is not a claim that
every common-food search is answered well.

The Jest suite `src/__tests__/api/benchmark.test.ts` exercises the same
mechanics over a synthetic corpus and is **explicitly not acceptance
evidence**: a synthetic corpus can show that ranking, paging and the zero-result
path behave, but it cannot show that real common-food searches find real foods.
A green run of it must never be cited as though the bar were met.

The run also established release determinism. All 426 queries returned the same
rank and the same match-set total on all three timed passes, and the release was
then loaded into a second, independently created database and measured there.
Handing that peer report back to the runner
(`npm run search:benchmark -- --compare-with <peer-report.json>`) recorded the
comparison machine-readably: **426 of 426 per-query ranks identical, 20 of 20
portable page sequences identical, the two `determinismFingerprint` digests
equal**, and the two databases positively established as `distinct` from the
PostgreSQL system identifier and database oid each run read back — with latency
the only figure that differed. That is the reproducibility property the release
ordering was designed for, and it is what makes the figures above a property of
the release rather than of one load. The committed artefact is the single-run
report, so its own `crossDatabaseReproduction` block records
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
in [the next section](#what-is-unrun-or-unverified) instead.

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

Provenance: the delivered tree — the API submodule at `8da2223` plus the
documentation and drift-gate changes in this change set — measured on
2026-09-17. Environment: Linux container, Node 22.23.2 with npm 11.18.0,
TypeScript 5.8.3, and a local PostgreSQL 16.15 reached over loopback. Database
roles follow the guard's own rule: a `*_test` database for the suite, a separate
development database for the migration, load, seed and benchmark runs, and a
disposable shadow database for the schema diff. No value of `DATABASE_URL` or of
any credential appears in this document.

| # | Check | Command | Outcome |
| --- | --- | --- | --- |
| 1 | Prisma client generation | `npx prisma generate` | **exit 0** |
| 2 | API typecheck (production config) | `npm run typecheck` | **exit 0**, no errors |
| 3 | API typecheck (tests config) | `npm run typecheck:test` | **exit 0** |
| 4 | API typecheck (scripts config) | `npm run typecheck:scripts` | **exit 0** |
| 5 | API build | `npm run build` | **exit 0** |
| 6 | Migration ledger applied | `npx prisma migrate deploy` on two freshly created databases | **exit 0** on both; `20260706000000_init`, `20260908000000_meal_planning` and `20260909000000_usda_cache_http_status` applied in that order |
| 7 | API suite with coverage | `NODE_ENV=test ALLOW_DB_TRUNCATE=true npm test` (the gate's own invocation: `jest --ci --runInBand --coverage`) | **51 of 51 suites passed.** 9,451 tests passed, 9,451 total, in 572 s, **nothing skipped** — a skip is not a pass, so the run carrying none is stated rather than left to be counted. **No coverage threshold was violated** — the per-file figures are [below](#per-file-branch-coverage-from-check-7) |
| 8 | Test-database guard, wrong `NODE_ENV` | `NODE_ENV=development npm test` | **Refused, exit 1**, before any application module or Prisma client was imported: the guard reports that `NODE_ENV` must be exactly `test` |
| 9 | Test-database guard, wrong database | `npm test` pointed at the development database | **Refused, exit 1**: the guard reports that the database name must end in `_test` or be exactly `ci` |
| 10 | Schema-drift evidence gate | the workflow's own gate script, run locally against the migrated database | **PASS.** `prisma migrate diff` exited 2 as the gate requires, 1 statement compared and identical to the committed evidence; the catalogue extraction matched on 21 lines — 1 generated column, 7 hand-managed indexes, 12 NOT NULL array columns |
| 11 | Dual-ledger equivalence | included in check 7 (`src/__tests__/api/compat.test.ts`) | **113 of 113 passed, nothing skipped.** Both ledgers produce the same catalogue and preserve every legacy row unchanged, and the normalised `pg_dump --schema-only` comparison RAN: the suite resolves a dump runner whose major version is at least the server's — here `pg_dump` inside the container publishing the port `DATABASE_URL` names, reporting PostgreSQL 16.15 — and a dump it cannot produce fails the gate rather than skipping it. The gate also holds the third migration: the additive `usda_api_cache.http_status` column is excluded from the legacy row hashes and asserted un-backfilled on both ledgers |
| 12 | Catalogue release load | `npm run catalog:load -- --release v1` | **exit 0.** 11,046 foods, 15,939 aliases, 31,899 portions, 0 compositions, 11,046 validation records written; all five files verified against the manifest before anything was written |
| 13 | Catalogue load idempotency | the same command again | **exit 0.** 0 inserted, 0 updated, 11,046 unchanged — idempotent |
| 14 | Recipe seed | `npm run recipes:seed` | **exit 0.** 42 recipes created with 269 ingredient rows, and the regenerated `coverage-report.json` was **byte-identical** to the committed one (the working tree stayed clean) |
| 15 | Search benchmark | `npm run search:benchmark` | **exit 0 — all four bounds met.** Top-3 0.948 (404 of 426), top-10 0.991 (422 of 426) against bounds of 0.9 and 0.97; zero-result rate 0 and p95 80.5 ms, both within bound. 426 of 426 queries rank-stable across the timed passes, and — measured against a second, independently loaded database and recorded by `--compare-with` — 426 of 426 ranks and 20 of 20 page sequences identical with equal determinism fingerprints. Recorded as [met, with its limits](#the-search-benchmark-is-met-and-what-it-does-not-cover) |
| 16 | Release determinism | the release loaded into a second, independently created database, measured there, and the peer report handed back with `npm run search:benchmark -- --compare-with <peer-report.json>` | **`crossDatabaseReproduction.outcome: identical`** — 426 of 426 per-query ranks identical, 20 of 20 portable page sequences identical, the two `determinismFingerprint` digests equal, release checksum identical, and the two databases established as `distinct` from the system identifier and database oid each run read back; latency the only difference |
| 17 | Service health | `npm run dev`, then the unauthenticated health endpoint | `{"status":"ok","version":"unknown"}` — the database round-trip succeeded. The reported version is `unknown` outside a built image, which is expected |
| 18 | Auth boundary | the catalogue status endpoint with no token | **401** with a "no token provided" body, confirming the route sits behind authentication — and confirming why authenticated calls could not be exercised here |
| 19 | Production image build | `docker build -t soh-be-w050 .` from the API repository root (the tag is arbitrary; CI uses `-t soh-be-ci`) | **exit 0**, image 458 MB. The `npm ci`, `npx prisma generate` and `npm ci --omit=dev` layers were served from the local layer cache — `package*.json` and `prisma/` are unchanged, so those layers' inputs are identical — while `COPY src` and `npm run build` executed. The claim this row exists for was then checked directly rather than inferred from a green build: `docker run --rm --entrypoint node -w /app soh-be-w050 -e "…require.resolve…"` resolved `express`, `@prisma/client`, `firebase-admin`, `uuid`, `date-fns`, `dotenv` and `pg` inside the pruned install, with `dist/app.js` and `dist/generated` present. `uuid` is the one that matters: this work moves it from `devDependencies` to `dependencies`, and this image installs with `--omit=dev` |
| 20 | App typecheck | `npx tsc --noEmit` | **exit 0** |
| 21 | App suite | `CI=true npx jest --runInBand --ci` | **111 of 111 suites passed, 5,218 of 5,218 tests**, exit 0 (the pre-feature baseline was 42 suites and 577 tests) |
| 22 | App lint against the recorded baseline | `npx eslint --no-fix -f json .` then the baseline comparison script | **Comparison exit 0 — 0 new findings** over the after report's 861 results. 44 findings remain in 26 files against a baseline of 49 in 31 files, so the pre-existing count fell and nothing was added. `eslint .` itself still exits non-zero while baseline findings remain, which is expected and is not this gate |
| 23 | App token-literal gate | `node scripts/token-literal-scan.mjs $(git diff --name-only --diff-filter=ACMR master -- 'src/**/index.styled.ts')` | **exit 0 — 88 stylesheet files scanned, no hardcoded style value found.** The gate's scope is the stylesheets a change touches, which is why the file list is derived rather than fixed; every value in them resolves through a named token |

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
— executed on the delivered tree (the API submodule at `8da2223` plus the
documentation and drift-gate changes in this change set) on 2026-09-17, in the
environment stated at the top of this section, against the `*_test` database.
Re-running that one command on that tree is what checks this table; the
`coverage/` directory it writes is not committed. It was run twice on this tree
while the work was finished, and every figure below is identical in both runs —
these modules are covered by their own logic suites, so adding tests elsewhere
moved the test count without moving the coverage.

Two deliberate differences from the reporter's own output: the branch counts
each percentage is computed from are added as a column, because a percentage
alone cannot be compared against a fresh run; and the reporter's
`Uncovered Line #s` column is dropped, because those line numbers move with any
edit to a module while the percentages and counts do not depend on them.

```text
File                          | % Stmts | % Branch |    Branches | % Funcs | % Lines
------------------------------|---------|----------|-------------|---------|---------
All files                     |   99.67 |    98.67 | 2,754/2,791 |     100 |   99.64
 services                     |   99.64 |    98.64 | 2,623/2,659 |     100 |   99.61
  catalog.logic.ts            |   99.84 |    98.52 |     402/408 |     100 |   99.83
  evidence.logic.ts           |   98.25 |    97.03 |     393/405 |     100 |   98.13
  grocery.logic.ts            |     100 |     99.40 |     166/167 |     100 |     100
  mealPlan.logic.ts           |     100 |    98.07 |     356/363 |     100 |     100
  mealPlanningAction.logic.ts |     100 |      100 |     105/105 |     100 |     100
  nutrition.logic.ts          |     100 |      100 |       92/92 |     100 |     100
  plannedMealLog.logic.ts     |     100 |      100 |       94/94 |     100 |     100
  preferences.logic.ts        |   99.87 |    98.90 |     630/637 |     100 |   99.86
  recipe.logic.ts             |     100 |    98.36 |     180/183 |     100 |     100
  swap.logic.ts               |     100 |      100 |       79/79 |     100 |     100
  targets.logic.ts            |     100 |      100 |     126/126 |     100 |     100
 utils                        |     100 |    99.24 |     131/132 |     100 |     100
  featureFlags.ts             |     100 |      100 |       11/11 |     100 |     100
  pagination.ts               |     100 |      100 |       39/39 |     100 |     100
  seededRandom.ts             |     100 |      100 |         0/0 |     100 |     100
  units.ts                    |     100 |    98.78 |       81/82 |     100 |     100
```

Three things a reader comparing this against a fresh run needs, because each one
reads as a disagreement when it is not:

- **The two aggregate rows are different numbers.** `All files` is 98.67 % over
  2,754 of 2,791 branches; the `services` group on its own is 98.64 % over 2,623
  of 2,659, the difference being the four utilities. Quoting the group's
  percentage against the whole run's denominator is the easy mistake here, which
  is why both rows and both counts are printed.
- **Istanbul floors its percentages at two decimals** rather than rounding them:
  2,754/2,791 is 98.6742 %, and it prints as `98.67`. A reader who rounds
  instead computes 98.68 and sees a mismatch that does not exist. The same
  applies per file — 630/637 is 98.9010 %, printed `98.90`.
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
  claim therefore rests on the device checklist.
- **The supplied production database host was unreachable from here**, which is
  correct — development and tests must never touch production data. Schema, API
  and catalogue verification used a local PostgreSQL 16.15 instead, and the
  exact patch version is recorded in the generated benchmark report so the
  evidence stays reproducible. Nothing in this work connected to production.
- **Authenticated endpoint calls were not exercised against a running server.**
  No development Firebase account or identity token was available; the
  unauthenticated request in check 18 returned 401, which is the correct
  behaviour and also the reason. What this leaves unverified is only the live
  token-verification path, since every handler behind it is exercised in process
  by the `src/__tests__/api/*` suites with the auth middleware mocked. Closing
  it needs a development Firebase project account and an identity token from it.
- **Reaching the full published catalogue count depends on conditions outside
  this checkout** — the vendor's hourly rate limit, model availability during
  offline seeding, and identity evidence passing its checks. The aggregate
  requirement is met at 11,046 items, but 12 of 21 categories are short by 2,344
  items in total. That shortfall is reported exactly by the catalogue report and
  is to be treated as an **unmet requirement, never fabricated** and never
  smoothed against the categories that over-deliver.
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
| **API** — `state-of-health-be` | Routes, controllers, the nine service triads and their pure logic modules, the wire types, the additive migration and its reference copy, the CLI scripts, the committed catalogue release and data manifests, the generated reports, the CI workflow, and this folder's six documents | Checks 1–19 above; the 51-suite run with its per-path coverage summary; the schema-drift and dual-ledger gates; the catalogue, validation, benchmark and recipe-coverage reports |
| **App** — `state-of-health-tracker` | The 18 new screen folders and the plan tab, the shared components and icons, the data models, the query and mutation layer, the store, the utilities, the style tokens, and the navigation registration for all 18 routes | Checks 20–23 above; the 111-suite run; the lint comparison against the recorded baseline; the token-literal gate over the stylesheets the change touched |

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
