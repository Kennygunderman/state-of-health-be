# Meal planning — API contract

The endpoint surface meal planning adds to the State of Health API: twenty-two
routes with their request and response shapes, the machine-readable error codes
each can answer with, the feature gate and which routes it spares, the mount
ordering and auth boundary the new routers sit behind, the one deliberate
exception to owner-scoped reads, and the additive-only changes to contracts that
already shipped.

This is a contract document. It does not restate the route → controller →
service → pure-logic layering (`backend-architecture` owns that), it does not
paraphrase handler bodies, and there is no machine-readable specification —
`src/types/{mealPlanning,catalog,recipe,nutrition}.ts` are the normative shapes
and this document names them rather than re-deriving them.

Companion documents, none of which is restated here:

- [`README.md`](./README.md) — the operator commands, in order, that make these
  endpoints answer with data: the catalog load, the recipe seed and the
  environment each requires.
- [`planning-policy.md`](./planning-policy.md) — the target equation, the
  activity factors, the clamp bounds and the planning constraints. Endpoints
  below reference it instead of repeating a formula.
- [`catalog-policy.md`](./catalog-policy.md) — the catalog's provenance model,
  validation checks and search-benchmark thresholds.
- [`release-and-recovery.md`](./release-and-recovery.md) — the switch-on and
  rollback procedure for the feature gate described here.
- [`requirement-evidence-checklist.md`](./requirement-evidence-checklist.md) —
  which of these behaviours has been exercised and how. **No claim about test
  results is made in this document**; it describes the contract only.

## Conventions

Stated once here and not repeated per endpoint.

**Prefix and authentication.** Every route below is mounted under `/api` and
sits after the Firebase auth boundary, so each request carries a bearer token:

```http
GET /api/meal-planning/plans/current HTTP/1.1
Host: api.example.test
Authorization: Bearer <firebase-id-token>
```

The shared `authenticateFirebaseToken` middleware answers `401` before any
handler runs — `{"error": "No token provided"}` when the header is missing or
not a `Bearer` credential, `{"error": "Invalid token"}` when verification
fails. That is a boundary behaviour of every protected route rather than a
per-endpoint outcome, so the tables below omit it. The caller's identity is then
resolved server-side from the verified token's claims; no route reads a user id
from a path, query or body.

**Case.** Wire shapes are camelCase; the database is snake_case (introspected
from the Firestore migration). One mapper per row shape performs the
translation, in one place, so the contract cannot drift from the shapes the
mobile client decodes — its counterparts live in
`mobile/src/queries/api/<domain>/decoder/` (io-ts codecs) and
`mobile/src/queries/api/<domain>/converter/` (response → model mappers). A field
renamed on one side without the other is the failure this arrangement exists to
make loud.

**Nullability is meaning, not omission.** Where a member can be `null` the null
carries a specific fact, and that fact is documented with the endpoint that
returns it — `TargetsResponse.targets`, `source` and `stale`, a meal entry's
`mealPlanMealId` and `nutritionProvenance`, a grocery item's `flag`, a plan's
`previousRecipe`, `CatalogStatusResponse.catalogRelease`. A published catalog
food's `defaultPortion` is the inverse case and is stated as such: it is never
null, because validation quarantines a candidate that has no portion with a
known gram weight.

**Day keys.** Dates on the wire are `YYYY-MM-DD` strings in the user's local
calendar, stored as `@db.Date` exactly as the diary stores them. "Today" is
computed in the IANA `timeZone` held in the user's preferences — the device's
`Intl.DateTimeFormat().resolvedOptions().timeZone`, refreshed on every step
save — and never in server time. The reason is that a bare date and a Firebase
identity cannot establish which calendar day the user is living in: a request
that arrives at 06:00 UTC is yesterday in Los Angeles and today in Auckland, and
every date bound in this contract (the start-date window, whether a plan is
current or upcoming, whether a plan has ended) would land on the wrong day for
one of them. The zone is a stored home zone, not re-derived per request.

**Codes, not prose.** Responses carry stable machine-readable codes —
`category`, `nutritionProvenance`, `constraintKey`, a meal flag's `code`, a
grocery banner's `code`, `iconKey`, badge codes, `clampReason`, `source` — and
never display copy. Food and recipe names are data and travel as data. The
mobile app maps every code to user-facing text through its own strings
constants, which is what lets copy change without a server release.

**Validation failures.** A rejected request is `400` with the offending field
named:

```json
{
  "error": "invalid_request",
  "details": [
    {"field": "startDate", "code": "out_of_range"},
    {"field": "mealTimes.1.time", "code": "invalid_time"}
  ]
}
```

`details` carries every failure the request earned, not just the first, so a
client can mark up a whole form in one pass. The predicates producing these
verdicts are pure parsers in the `*.logic.ts` modules that the controller calls;
they return a verdict rather than throwing, which is why they are unit-testable
without HTTP and why no status code is chosen inside them.

**Missing or someone else's.** Both answer `404`, and the two are never
distinguished. There is no owner-less read of a user-owned resource, so "no such
plan" and "not your plan" are one answer by construction — a client cannot probe
for the existence of another user's plan, meal, grocery item or diary entry.

**Body size.** The global `express.json()` limit (100 KB) bounds every request
here. No per-route body parser is added for meal planning; the largest body in
this contract is a full preferences update, which is orders of magnitude below
the limit.

## Request validation

These parsers run before any Prisma call and before any planning work, so a
malformed request never reaches the database or the generator. Every bound below
is enforced in code; the field codes are the `code` values that appear in
`details`.

| Input | Rule | Field code on failure |
| --- | --- | --- |
| Any path id (`:planId`, `:mealId`, `:itemId`, `:recipeVersionId`) | v4 UUID | `invalid_id` |
| `idempotencyKey` | v4 UUID | `invalid_id` |
| Any date (`date`, `startDate`) | real `YYYY-MM-DD` calendar day | `invalid_date` |
| `startDate` window | within `[today, max(today + 30 days, activePlan.endDate + 1)]` in the user's zone | `out_of_range` |
| `servings` | number in `[0.25, 10]`, at most two decimals | `below_minimum`, `above_maximum`, `invalid_type` |
| `q` (catalog search) | 2–60 characters after trimming | `invalid` |
| `page` | integer ≥ 1 (and ≤ 100,000) | `invalid`, `out_of_range` |
| `limit` (`/catalog/foods`) | integer in `[1, 50]`, default 25 | `invalid`, `out_of_range` |
| `limit` (`/catalog/foods/suggestions`) | integer in `[1, 30]`, default 12 | `invalid`, `out_of_range` |
| `kind` (suggestions) | exactly `dislike` | `unknown_value` |
| `allergens` | up to 9 distinct values from `milk`, `eggs`, `peanuts`, `tree_nuts`, `soy`, `wheat`, `fish`, `shellfish`, `sesame` — **or** exactly `["none"]` | `unknown_value`, `too_many`, `mutually_exclusive` |
| `dislikedFoodIds`, `dislikedFoodGroups` | up to 100 distinct values; ids must be published catalog foods | `invalid_id`, `too_many` |
| `mealTimes` | exactly one zero-padded `HH:mm` entry per slot of the chosen schedule, in wire order `breakfast, lunch, dinner[, snack]` | `invalid_time`, `slot_mismatch` |
| `timeZone` | an IANA name this runtime accepts, validated by constructing `Intl.DateTimeFormat` and stored canonicalised | `invalid_time_zone` |
| `budget.currency` | exactly `USD` in this version | `unsupported_currency` |
| `budget.amount` | whole dollars, integer in `[1, 10000]` | `not_an_integer`, `below_minimum`, `above_maximum` |
| `goalWeightKg` | on the goal's side of the current weight | `not_below_current_weight`, `not_above_current_weight` |
| Manual targets | `calories` integer in `[800, 6000]`; each macro integer in `[1, 1000]` | `below_minimum`, `above_maximum`, `not_an_integer` |
| Any `expectedRevision` / `expected*Revision` | integer within PostgreSQL's signed 32-bit range | `invalid_type`, `above_maximum` |
| `:step` segment | one of the nine setup steps | `unknown_step` |

Two bounds deserve their reasons, because the number alone reads arbitrary.

`servings` is capped at two decimals because that is the representation the
shipped mobile client already stores for its fraction chips — `⅓` is `0.33` and
`⅔` is `0.66`, not exact thirds. Accepting the same two-decimal value means the
number displayed, the number hashed into an idempotency fingerprint and the
number the server multiplies a snapshot by are the same number, so a retry
cannot produce a different fingerprint than the request it repeats.

The `startDate` upper bound is `max(today + 30, activePlan.endDate + 1)` rather
than a flat thirty days so that the week immediately after the current plan is
always inside the window. A plan generated today for a week starting in four
weeks would otherwise put its own successor out of range, and "plan another
week" would be refused for a reason the user cannot act on.

## The feature gate

`MEAL_PLANNING_ENABLED` is read once, at module load, by
`src/utils/featureFlags.ts`, and the feature is **off unless the variable is
exactly `true`** — absent, empty, `1`, `TRUE` and `yes` all mean off. A gated
route answers:

```json
{"error": "feature_disabled"}
```

with status `503`. The check is a controller concern, not middleware: the two
controllers call it, which is what lets the exemptions below be per-route rather
than per-router.

Of the twenty-two routes, **sixteen are gated and six are not**:

| Gated → `503 feature_disabled` | Never gated |
| --- | --- |
| `/meal-planning/*` except the three target routes (15 routes) | `/meal-planning/targets` and `/meal-planning/targets/estimate` (3 routes) |
| `GET /recipes/:recipeVersionId` (1 route) | all of `/catalog/*` (3 routes) |

The exemptions are load-bearing, and each has a reason that stops a later
tidy-up from removing it.

**The target routes stay available because they are not meal-planning
infrastructure.** Account's target-calories row, the diary's summary card and
the Progress activity tab all read nutrition targets through
`GET /meal-planning/targets`, and the full-screen target editor writes through
`PUT /meal-planning/targets`. Gating them would make three surfaces outside meal
planning fail — or silently fall back to a stale local value — the moment the
kill switch is used, which is the opposite of what a kill switch is for. Turning
meal planning off must leave targets answering normally.

**The catalog reads stay available because Add Food does not depend on
planning.** The catalog section in the food search is a food-library feature
that happens to be populated by the same pipeline; a user searching for a food
to log has nothing to do with a weekly plan. `GET /recipes/:recipeVersionId` is
gated, on the other side of that line, because a recipe is only ever reached
from a plan.

`503 feature_disabled` is deliberately the same code the shipped AI endpoints
already return when their feature is disabled, so the client's existing
error-code handling understands it without a new branch.

## Endpoints

Twenty-two routes, grouped by area. Response types are the interfaces in
`src/types/`; request fields are listed because nothing else names them. Every
entry's error list is complete for that route — the shared `401` and the
unmapped-exception fallback described in the error index are the only outcomes
not repeated per row.

### Preferences

#### `GET /meal-planning/preferences`

Gated. No parameters. `200` → `PreferencesResponse`.

Side-effect free: reading does not create a row. A user who has never started
setup receives `setupStatus: "not_started"`, `revision: 0`, empty arrays for
`allergens`, `dislikedFoods`, `dislikedFoodGroups` and `mealTimes`, and `null`
for **every** other preference field — including `heightUnitPref` and
`weightUnitPref`, because the server owns no unit defaults. The client derives
the first-entry unit toggles from the user's existing weight-unit preference
instead.

`revision` is the optimistic-concurrency counter every write pins, and
`hasActivePlan` is what tells a client whether a preference edit will trigger
incompatibility flagging.

Errors: `503 feature_disabled`.

#### `PUT /meal-planning/preferences/steps/:step`

Gated. `200` → `PreferencesSaveResponse` (`{preferences, affectedMealCount}`).

`:step` is one of `goal`, `body`, `activity`, `diet`, `dislikes`, `schedule`,
`cooking`, `review`, `targets_manual`. The body is the one typed payload for
that step, plus the envelope every step carries:

| `:step` | Body |
| --- | --- |
| `goal` | `goal`, `goalWeightKg?`, `paceLbPerWeek?` |
| `body` | `age`, `heightCm`, `weightKg`, `sexForEstimate`, `heightUnitPref`, `weightUnitPref` — **or** `{skipped: true}` |
| `activity` | `activityLevel` |
| `diet` | `diet`, `allergens` |
| `dislikes` | `dislikedFoodIds` |
| `schedule` | `mealSchedule`, `mealTimes` |
| `cooking` | `cookingTimeLimitMin`, `budget` (or `null`), `noBudgetPreference` |
| `review` | `startDate` — persisted as `reviewStartDate` |
| envelope (all steps) | `timeZone`, `expectedRevision` |

`expectedRevision` is **optional only while no preferences row exists** — that
is, on the very first `goal` save, which is also what creates the row as
`in_progress`. Once a row exists it is required and must match exactly;
anything else is `409 stale_revision` carrying `currentRevision`, and the client
resolves by re-reading and comparing against its own draft. Two clients editing
concurrently therefore lose exactly one update rather than interleaving.

A save advances `setupStep`, sets `targetRoute` to `manual` after a `skipped`
body step or a `prefer_not_to_say` sex, and moves `setupStatus` to
`ready_for_review` once the route's steps are complete. The same endpoint serves
edit mode, where it **never moves `setupStatus` backwards**; and when a plan is
active it recomputes that plan's incompatibility flags in the same transaction.
`affectedMealCount` is the result of that recomputation and is what drives the
plan-settings banner — it is not a count of what changed in the request.

Errors: `400 invalid_request` (including `unknown_step`),
`409 stale_revision`, `503 feature_disabled`.

#### `PUT /meal-planning/preferences`

Gated. `200` → `PreferencesSaveResponse`.

The body is a partial update drawn only from the closed editable set, plus the
required `timeZone` and `expectedRevision`: `goal`, `goalWeightKg`,
`paceLbPerWeek`, `age`, `heightCm`, `weightKg`, `sexForEstimate`,
`heightUnitPref`, `weightUnitPref`, `activityLevel`, `diet`, `allergens`,
`dislikedFoodIds`, `dislikedFoodGroups`, `mealSchedule`, `mealTimes`,
`cookingTimeLimitMin`, `budget`, `noBudgetPreference`.

Any other key is refused rather than ignored — `setupStatus`, `setupStep`,
`revision`, `budgetTier`, `hasActivePlan`, `targetRoute` and any unrecognised
name all produce `400 invalid_request` with `details: [{field, code:
"read_only_field"}]`. Silently dropping a server-owned key would let a client
believe it had written something it had not.

One transaction bumps `revision` and, for every active plan, recomputes
`meal_plan_meals.flags` and the plan's incompatibility summary.

Errors: `400 invalid_request` (including `read_only_field`),
`409 stale_revision`, `503 feature_disabled`.

### Targets

All three target routes are **ungated** (see [the feature gate](#the-feature-gate)).

#### `GET /meal-planning/targets/estimate`

Ungated. No parameters. `200` → `TargetEstimateResponse`.

Recomputed from the stored preferences on every call, never cached on the wire:
`source: "estimated"`, `estimateRevision` (equal to the preferences `revision`
the inputs came from), the `inputs` used, `bmr`, `tdee`, `adjustment`, the four
target values, `clamped` and `clampReason` (`floor`, `below_bmr`, `ceiling`, or
`null` when nothing bound). The equation, the activity factors and the clamp
bounds are in [`planning-policy.md`](./planning-policy.md) and are not repeated
here.

`estimateRevision` exists so a later confirmation can prove it is confirming the
numbers that were actually shown.

Errors: `409 estimate_unavailable` with `reason` — `prefer_not_to_say` (an
answer that cannot be calculated from) or `missing_inputs` (the measurements are
not in yet). Both are forks to manual target entry rather than failures.

#### `GET /meal-planning/targets`

Ungated. No parameters. `200` → `TargetsResponse`.

This response's nullability is the subtlest part of the contract, so each member
is specified exactly:

| Member | Meaning |
| --- | --- |
| `targets` | `null` **only** when all four stored target columns are null. Otherwise it carries the raw per-field values, each **independently nullable** — a calories-only legacy account is `{"calories": 1900, "protein": null, "carbs": null, "fat": null}`. |
| `complete` | `true` only when all four values are set. |
| `source` | `estimated` or `manual` when a preferences row exists **and** its confirmed snapshot equals the four stored values; `legacy` whenever any value is set but there is no preferences row, or the stored values differ from the confirmed snapshot; `null` when `targets` is `null`. |
| `stale` | `true` when `source` is `estimated` and the confirmed estimate's input revision no longer matches the current preferences revision — the goal, body, activity or pace changed after the estimate was confirmed. |
| `revision` | The targets revision a write must pin; `0` when no preferences row exists. |

`legacy` is how the read stays truthful without breaking old clients. The
untouched `PUT /api/user/targets` writes the same columns and never bumps the
targets revision, so a write from that route makes the stored values differ from
the confirmed snapshot — and this read reports `legacy` rather than presenting
unreviewed numbers as confirmed.

What each consumer does with it: the planner requires `complete && source !==
"legacy"` and refuses to build a week otherwise; Account, Progress and the
review screen display `targets.calories` whenever it is non-null and treat
`legacy` or `stale` as "review your targets"; the diary continues to resolve
targets per field from the macros responses, which read the same columns.

Errors: none beyond the shared boundary. A user with no targets is a `200` with
`targets: null`, not a `404`.

#### `PUT /meal-planning/targets`

Ungated. `200` → `SaveTargetsResponse` (`{targets, feasibility}`).

This is the **single canonical target writer** for users who have opted into
meal planning. One transaction, under the per-user lock, reuses the existing
`updateTargets` to write the four user columns and records the confirmed
snapshot, the source and the incremented revision — so there is one writer and
one read, and Account, the diary and the planner cannot disagree.

Two discriminated bodies:

```json
{"source": "estimated", "estimateRevision": 7, "expectedTargetsRevision": 2}
```

```json
{"source": "manual", "calories": 1940, "protein": 146, "carbs": 194, "fat": 65, "expectedTargetsRevision": 2}
```

`expectedTargetsRevision` is required whenever the current `TargetsResponse.revision`
is greater than `0`, and it is **a different counter from `estimateRevision`**:
the former pins the targets row being replaced, the latter pins the *inputs* the
estimate was computed from. Confusing them is the mistake this paragraph exists
to prevent.

For `source: "estimated"` the server recomputes the estimate from stored
preferences and compares — a client never self-declares arbitrary numbers as an
estimate, and a mismatched `estimateRevision` is `409 estimate_stale`. For
`source: "manual"` the four values are validated and stored exactly as entered,
with no 4/4/9 rebalancing.

The transaction **upserts** the preferences row when none exists, so a
pre-existing user editing targets from Account gets a row with `setupStatus:
"not_started"`, `revision: 1` and nothing else set. That is a targets record,
**not** onboarding progress, and the client must not read it as a resumable
setup.

Manual targets that are valid but nutritionally awkward return `200` with
`feasibility.warnings` — `macro_energy_mismatch`, `below_catalog_min`,
`above_catalog_max` — shown as an inline note. Saving is never blocked for
feasibility, and **there is no `422` on this route**.

Errors: `400 invalid_request`, `409 stale_targets` (with `currentRevision`),
`409 estimate_stale`, `409 estimate_unavailable` (the estimated branch, when the
inputs it must recompute from are missing or unusable).


### Plans

#### `POST /meal-planning/plans`

Gated. Body: `startDate`, `idempotencyKey`, `expectedPreferencesRevision`,
`expectedTargetsRevision`. `201` → `MealPlanResponse`.

The candidate week is computed in memory from a snapshot of the preferences and
targets, then published in one transaction; a failure at any point persists
nothing, so no half-built or failed plan rows exist. Success also moves
`setupStatus` to `completed`.

`MealPlanResponse` distinguishes two sets of target values that are easy to
conflate: `targets` is the user's **current** confirmed targets — the same
numbers Account and the diary show — while `generationTargets` is the snapshot
the plan was actually built against, and `targetsStale` is their inequality.
Nothing regenerates automatically when they diverge; the client shows a neutral
caption and the user decides.

| Status | Code | Payload and meaning |
| --- | --- | --- |
| `400` | `invalid_request` | `details` names the field — most often `startDate` `out_of_range`. |
| `409` | `idempotency_conflict` | The key was used before with a different body. |
| `409` | `preferences_incomplete` | Setup has not reached `ready_for_review` or `completed`. |
| `409` | `targets_unconfirmed` | Targets are complete but `source` is `legacy` — nobody confirmed them here. |
| `409` | `stale_revision` | `{preferencesRevision, targetsRevision}` — both counters travel, because either may have moved and the client re-runs from whichever is fresh. |
| `409` | `plan_overlap` | `{conflictingPlanId}` — the requested week collides with an existing active plan. |
| `409` | `upcoming_exists` | At most one plan may start after today, and one already does. |
| `422` | `targets_missing` | `{missing}` — names the unset target fields so the client can ask for exactly those. |
| `422` | `no_matching_meals` | A feasibility verdict, not a failure. See below. |
| `502` | `plan_generation_failed` | The search could not complete. Nothing was persisted. |
| `503` | `feature_disabled` | |

`422 no_matching_meals` carries **typed values only**, never display copy:

```json
{
  "error": "no_matching_meals",
  "limitingConstraints": [
    {"constraintKey": "cooking_time", "value": 15, "unit": "minutes", "slots": ["dinner"], "editStep": "cooking"},
    {"constraintKey": "dislikes", "value": 9, "unit": "foods", "slots": [], "editStep": "dislikes"}
  ],
  "allergiesKept": true
}
```

`constraintKey` is one of `cooking_time`, `dislikes`, `diet`,
`nutrition_tolerance`, `portion_limits`, `slot_coverage`, `catalog_coverage`;
`unit` is one of `minutes`, `foods`, `percent`, `recipes`, or `null`;
`editStep` names the setup step that would open the week up again, which is what
lets each row render as a working "Edit" affordance. Constraints are ordered
most-limiting first. `allergiesKept` is always `true` and is owned by the error
rather than added by the response layer: allergies are never relaxed to find
more meals, so the promise is an invariant of the failure itself.

#### `GET /meal-planning/plans/current`

Gated. No parameters. `200` → `CurrentMealPlanResponse`.

`{current, upcoming}`, both independently nullable: `current` is the active plan
containing today, `upcoming` is one starting after today. Both `null` is the
ordinary no-plan state and is a `200`, not a `404` — it is what the empty state
renders from. Which plan is which is decided in the user's stored zone, so
rollover needs no client timer: the same request answered after midnight moves
the former `upcoming` into `current`.

Errors: `503 feature_disabled`.

#### `GET /meal-planning/plans/:planId/days/:date`

Gated. `200` → `MealPlanDayEnvelopeResponse`.

One day with fresh logged state, and **readable for superseded and ended plans
too** so history stays available after a regeneration. This is the query the
recipe-detail, swap and planned-log screens compose with for a meal's planned
context — portion, planned nutrition, slot and time, logged entries and the
plan revision — rather than carrying that context through navigation.

The envelope reports the plan's writability alongside its identity:
`planStatus` is the stored `active` or `superseded`, while `planLifecycle`
resolves the third state the status column cannot express — `ended`, a plan
still stored as active whose last date has passed — and `isWritable` is the
single boolean a screen should disable its actions on. A plan that is readable
is not necessarily writable, and that distinction is why both members exist.

Each meal's `loggedEntries` is a **list**, because a deliberate second serving
is a distinct diary entry. A meal reads as logged when any non-deleted entry
references its *current* recipe version; when entries exist but all reference a
different version, the meal was swapped after being logged and the card says so
instead of claiming the new recipe was eaten. `previousRecipe` is the last
swap's audit value, not a substitute for that derivation.

Errors: `400 invalid_request` (`invalid_id`, `invalid_date`), `404` when the
plan is not the caller's or the date is outside it, `503 feature_disabled`.

#### `POST /meal-planning/plans/:planId/regenerate`

Gated. Body: `idempotencyKey`, `expectedPlanRevision`,
`expectedPreferencesRevision`, `expectedTargetsRevision`. `201` →
`MealPlanResponse` (the new plan).

One transaction supersedes the old plan, links it as the replaced plan, rebuilds
the grocery list while copying check state for items whose quantity did not
change, and leaves every diary entry and its link to the old plan's meals
intact. Logged food is never rewritten by a regeneration.

Errors: everything `POST /meal-planning/plans` can answer with, plus
`409 stale_plan` (`{currentRevision}`) when the pinned revision has moved and
`409 plan_not_active` when the plan is already superseded (`{replacementPlanId}`)
or has ended (`{reason: "ended"}`), and `404` when the plan is not the
caller's. On any error the old plan is left exactly as it was.

#### `GET /meal-planning/plans/:planId/affected-meals`

Gated. `200` → `AffectedMealsResponse` — `{meals: [{mealId, date, slot,
recipeName, flags}]}`, each flag a `{code, detail}` pair whose `code` is `diet`,
`allergen`, `dislike` or `cooking_time`.

The list is what the plan-settings banner expands into, so it stays populated
until every flagged meal has been swapped; addressing one meal never hides the
rest.

Errors: `400 invalid_request`, `404`, `503 feature_disabled`.

### Swaps

The three swap routes share one candidate-selection function, so the list, the
preview and the commit cannot disagree about what is eligible or at which
portion.

#### `GET /meal-planning/plans/:planId/meals/:mealId/alternatives`

Gated. `200` → `SwapAlternativesResponse` — `{current, alternatives}`.

At most **8** alternatives, in a deterministic PRNG-free order, so the list is
stable across refetches. **An empty `alternatives` array is a success, not an
error**: it is the honest answer that nothing else matches this user's targets,
cooking time and dislikes for this slot, and the client renders its own
no-alternatives state from it. A failure to *load* alternatives is a different
outcome and must not be rendered as an empty result.

This is a read, so the plan's lifecycle is not consulted — alternatives for a
superseded plan still resolve.

Errors: `400 invalid_request`, `404`, `503 feature_disabled`.

#### `GET …/meals/:mealId/alternatives/:recipeVersionId/preview`

Gated. `200` → `SwapPreviewResponse` — `{alternative, dayTotalsIfSwapped,
targets, calorieDelta, planRevision}`.

The portion in `alternative` is the one the commit will recompute and must
agree with; `planRevision` is the value the client sends with the commit. Also a
read: the plan's lifecycle is not consulted here.

Errors: `400 invalid_request`, `404`, `422 recipe_ineligible` when the candidate
no longer passes eligibility for the slot, `503 feature_disabled`.

#### `POST /meal-planning/plans/:planId/meals/:mealId/swap`

Gated. Body: `recipeVersionId`, `portionMultiplier`, `expectedPlanRevision`,
`idempotencyKey`. `200` → `SwapMealResponse` — `{meal, day, planRevision,
groceryChangeSummary}`.

The commit is the one swap route that requires a writable plan. It recomputes
the portion with the same function the preview used and refuses when the result
differs, because committing a portion the user never saw is worse than asking
them to look again. The grocery list is diffed in the same transaction:
increases on already-checked items stay checked and are flagged rather than
folded in silently.

| Status | Code | Meaning |
| --- | --- | --- |
| `400` | `invalid_request` | |
| `404` | — | The plan or meal is not the caller's. |
| `409` | `preview_stale` | The server-recomputed portion differs from the request. |
| `409` | `stale_plan` | `{currentRevision}` |
| `409` | `plan_not_active` | `{replacementPlanId}` or `{reason: "ended"}` |
| `409` | `idempotency_conflict` | Same key, different body. |
| `422` | `recipe_ineligible` | The candidate no longer fits this slot. |
| `502` | `swap_failed` | **Nothing was persisted** — the original meal stands and the grocery list was not touched. This code is raised only when that is actually true, because it is the assurance the client displays. |
| `503` | `feature_disabled` | |


### Groceries

All three grocery routes are **state-setting rather than keyed**: the request
names the desired state, so repeating it is harmless by construction. They
therefore carry **no idempotency key and no revision**, they require the plan to
be writable, and **they do not bump the plan revision** — a check mark is not a
change to the plan. Last write wins. They still take the per-user lock, so a
toggle can never interleave with a swap's list rebuild.

#### `GET /meal-planning/plans/:planId/groceries`

Gated. `200` → `GroceryListResponse`.

Sections are ordered by store aisle with the five stable category codes
(`produce`, `protein`, `dairy_alternatives`, `grains_bread`, `pantry_other`),
and `checkedItems` is a separate list so the client can render a "checked"
section without re-filtering. `banner` is `null` or one of two codes —
`updated_after_swap` when the last swap changed the list, `amount_increased`
when any item is flagged. An item's `flag` is non-null only for an increase on
an already-checked item, and it carries the display strings for both amounts and
the delta so the row can say what changed without the client doing unit maths.

An empty list is a `200` with empty sections, distinct from the no-plan state,
which is the absence of a plan rather than an answer from this route.

Errors: `400 invalid_request`, `404`, `503 feature_disabled`.

#### `PUT /meal-planning/plans/:planId/groceries/:itemId`

Gated. Body: `{isChecked}`. `200` → `ToggleGroceryItemResponse` — `{item,
checkedCount}`.

Checking *or* unchecking clears the item's `flag` and resets the baseline that
later "was X, now Y" comparisons are made against, so repeated swaps keep
comparing with the amount the user actually saw.

Errors: `400 invalid_request`, `404`, `409 plan_not_active`,
`503 feature_disabled`.

#### `POST /meal-planning/plans/:planId/groceries/uncheck-all`

Gated. No body. `200` → `UncheckAllGroceriesResponse` — `{checkedCount: 0}`.

Clears every check and every flag.

Errors: `400 invalid_request`, `404`, `409 plan_not_active`,
`503 feature_disabled`.

### Planned logging

#### `POST /meal-planning/plans/:planId/meals/:mealId/log`

Gated. Body: `servings`, `date`, `diaryMealId`, `expectedPlanRevision`,
`idempotencyKey`. `201` → `LogPlannedMealResponse` — `{entry, mealPlanMeal,
planRevision}`.

`diaryMealId` must be an existing diary meal owned by the caller **whose own
date equals the `date` in the body**; clients obtain it from
`GET /api/macros/:date`, which backfills the four default buckets for any date.
`date` must fall inside the plan's week. **No `mealName` is accepted** — the
server will not create or rename a diary bucket, because the diary's meals are a
fixed per-day set.

The entry the server writes is derived server-side: the planned portion's
nutrition rounded once into a per-serving snapshot, multiplied by the eaten
`servings`, with the plan link, the recipe-version link and a `source_backed`
provenance set. The client's numbers are not trusted for a planned meal, and the
legacy dedupe-by-food path is never entered.

Logged state is derived live from non-deleted linked entries, which is what makes
the diary the single source of truth: deleting the diary entry clears the meal's
logged state, and editing its servings changes consumed totals without unlinking
it.

Errors: `400 invalid_request`, `404` (the plan, the meal, or a `diaryMealId`
that is not the caller's or whose date does not match), `409 stale_plan`,
`409 plan_not_active`, `409 idempotency_conflict`, `503 feature_disabled`.

### Catalog

Never gated. These are shared reference reads — see
[user scoping](#user-scoping-and-its-one-exception).

#### `GET /catalog/foods`

Ungated. Query: `q` (2–60 characters after trimming), `page` (default 1),
`limit` (default 25, maximum 50). `200` → `CatalogSearchResponse` — `{items,
pagination}`.

`pagination` is `{page, limit, total, totalPages}` — the same block the existing
`GET /api/foods` returns, so a client pages both endpoints with one
implementation. Offset pagination is the **single scheme** every paginated
endpoint here uses, and it is owned by one shared helper rather than re-derived
per route: `parsePaginationStrict` reads the request at the controller boundary
and `toPaginationBlock` builds the response envelope from the pair it returned,
so the request and the block it is answered with cannot disagree. Pagination is
a controller concern throughout — the request `page`/`limit` never reach a
service unparsed, and no service invents a block of its own.

Published items only. **One row per food however many of its aliases match**: a
food's rank is the best contribution from its own name or any alias, so an alias
hit promotes a food rather than duplicating it.

The order is `ts_rank` descending, then the food's display name, then its import
source key — all three are storage-side columns and **none of them is exposed on
the wire**, so a client paginates with `page` and `limit` alone and does not need
to reproduce the sort. That last key is the point of the whole ordering: primary
keys are randomly generated, so two databases independently loaded from the same
catalog release would otherwise break ties differently, and a client paging one
of them could see a row twice or miss it entirely. The source key is
deterministic, which makes pages stable within a database and identical across
them — the property the search benchmark relies on when it checks that pages 1
to 3 concatenate to one reference page.

`defaultPortion` is non-null on every item, because validation quarantines a
candidate with no portion of known gram weight rather than publishing one a
client would have to guess a serving for.

Errors: `400 invalid_request` — a malformed or out-of-range `q`, `page` or
`limit` is refused with the field named, not silently rewritten into a valid
request and answered `200`.

#### `GET /catalog/foods/suggestions`

Ungated. Query: `kind` (exactly `dislike`), `limit` (default 12, maximum 30).
`200` → `CatalogSuggestionsResponse` — `{items: [{id, name, foodGroup}]}`.

Published foods flagged as common dislikes in the coverage plan, in a stable
order. `foodGroup` travels with each item because selecting a dislike stores
both the food and its group.

Errors: `400 invalid_request`.

#### `GET /catalog/status`

Ungated. No parameters. `200` → `CatalogStatusResponse` — `{catalogRelease,
publishedCount, quarantinedCount, rejectedCount, recipeCount, lastLoadedAt}`.

**Operator and acceptance evidence; there is no mobile consumer.** It is what an
operator checks after a catalog load and before switching the feature on.
`catalogRelease` and `lastLoadedAt` are read from the most recent release-load
run that succeeded, and are `null` before any release has been loaded — which is
itself the answer to "is this environment seeded?".

Errors: none beyond the shared boundary.

### Recipes

#### `GET /recipes/:recipeVersionId`

Gated. `200` → `RecipeVersionResponse`.

Visibility has two branches, and the difference matters:

- A version whose `status` is `current` resolves for **any** authenticated
  caller. Published recipes are shared reference data — the same catalog for
  everybody — so this branch needs no owner-scoped query at all.
- A `retired` version resolves **only** when this caller references it: a meal
  of theirs whose recipe is that version, a meal whose *previous* recipe is that
  version (so the logged-then-swapped caption can open the recipe it names), or
  a non-deleted diary entry of theirs logged from it (so "view in diary" cannot
  strand a meal the user actually ate). A deleted entry is not a reference — the
  user removed it, and the visibility it granted goes with it. Both reference
  checks are owner-scoped.

Everything else is `404`: no such id, a retired version nobody the caller owns
references, and another user's reference all produce the same answer, so the
route cannot be used to discover which recipe versions exist.

The response carries **no planned-meal context**. Portion, planned nutrition,
slot and time, logged state and the plan revision come from
`GET /meal-planning/plans/:planId/days/:date` and are composed on the client;
`status` is on the response so a client knows it is looking at a retired version.

Errors: `400 invalid_request` (`invalid_id`), `404`, `503 feature_disabled`.

## Idempotency and replay

Four writes are **keyed**: plan generation, regeneration, swap commit and
planned logging. Each carries an `idempotencyKey` (v4 UUID) minted by the client
when the user first presses the button, and that key is the feature's
exactly-once guarantee.

The rules, in the order they apply:

1. A key never seen before is reserved and the write proceeds.
2. A repeated key whose **request fingerprint matches** replays the stored first
   response — its **status and body, verbatim**. The status is persisted with the
   response, never inferred at replay time, and there is deliberately no "this
   was a replay" flag in the response, so a client cannot distinguish a replay
   from the original and does not need to. The distinction IS recorded
   server-side: the `keyed_write_answered` event (and, on the abort seam,
   `response_aborted_after_commit`) carries a `replayed` field, because an
   operator reading two identical `201`s under one key otherwise cannot tell a
   duplicate the ledger absorbed from a single commit whose first response was
   lost. It is a log field only and never reaches a body, a header or a status.
3. A repeated key with a **different** body is `409 idempotency_conflict`. That
   is a genuinely different write wearing a used key, never a retry.

The replayed statuses are `201` for generate, regenerate and log — each creates
a resource — and `200` for swap, which changes one.

**A replay is answered before any revision or status check.** A committed action
therefore still replays after the plan has moved on, which is precisely the case
that matters: a client whose response was lost retries with the same key, and it
must receive what it already achieved rather than `409 stale_plan` for a write it
successfully made. Conversely, any change to the payload or the pinned revisions
means the client must mint a **new** key, because reusing the old one with a
different body is the conflict in rule 3.

The grocery routes carry no key at all — they are state-setting (see
[Groceries](#groceries)), so a repeat is naturally idempotent.

The whole sequence — per-user lock, reserve, replay, complete — is implemented
once in `mealPlanningAction.service.ts` and called by the four writes rather
than re-implemented per endpoint. A second implementation would be a second
replay policy.

## Mount order and the auth boundary

`src/app.ts` is the only place that knows about mounting, and two of its
existing orderings are real constraints. This section records what the new
routers add to that list, because a load-bearing ordering has to be written down
to survive the next person who tidies the file.

**The new mount order is not load-bearing, and that is the finding.**
`catalogRoutes` and `mealPlanningRoutes` mount with `app.use('/api', …)` after
`nutritionRoutes`, but they could mount anywhere after the auth boundary: they
own the first path segments `/catalog`, `/recipes` and `/meal-planning`, which no
route above them shares. The one parameterised path that could swallow a sibling
is nutrition's `/macros/:date` — the reason `foodRoutes` must still mount before
`nutritionRoutes`, since it owns the literal `/macros/search-branded-foods` and
`/macros/branded-food/:foodId` that `:date` would otherwise match — and it
cannot reach a different first segment. So **no new literal-before-parameterised
constraint is introduced at the app level**.

Inside the two new routers, literal paths are still declared before their
parameterised siblings — `/meal-planning/plans/current` before the
`/meal-planning/plans/:planId/…` family, and
`…/alternatives/:recipeVersionId/preview` before `…/alternatives`. Today those
pairs differ in segment count and cannot cross-match, so the ordering is
defensive rather than required. It is kept, and worth keeping, because the
hazard it forecloses is concrete: adding a `GET /meal-planning/plans/:planId`
later would capture `/plans/current` with `planId = "current"` unless the
literal still comes first.

**Auth is a mount-order boundary, and both new routers are on the protected side
of it.** They mount after `app.use(authenticateFirebaseToken)`, so every one of
the twenty-two routes requires a verified token and every handler resolves the
caller from its claims. Moving a router across that line does not fail loudly —
it silently changes the security posture of every path in it — which is why the
boundary is named here as a boundary rather than left to be inferred from
ordering.

**No new body parser, and no reordering of the existing ones.** The per-route
parsers must stay registered before the global `express.json()`, because the
first JSON parser to run wins: the AI endpoints' 10 MB limit and the avatar
route's 1 MB limit would otherwise never be reached, with the global parser
rejecting a large payload first. Every request in this contract fits the global
100 KB limit, so meal planning adds nothing here.

**No new middleware.** `authenticateFirebaseToken` and the token-claims helpers
are reused unchanged, and the feature-gate check is a controller concern — which
is what makes the per-route exemptions in [the feature gate](#the-feature-gate)
expressible at all. `/health` remains unauthenticated by design, ahead of the
boundary: Coolify health checks, uptime monitoring and post-deploy verification
all hit it, and it pings the database and reports the build's commit SHA.

## User scoping and its one exception

Every user-owned read and write carries the owner key, and where a resource is
nested it carries the parent chain too — `{id, user_id}` for a plan or a
preferences row, `{id, user_id, meal_plan_id}` for a meal — together with the
expected `revision` where one exists. The expected revision travels **in the
write's own predicate**, not merely in a check that precedes it, so a row that
moved between the check and the write is refused by the statement that writes
rather than by an assumption. There is no id-only update after a separate
ownership read: that pattern is a cross-user write waiting for a race.

This is also why cross-user access is `404` and never `403`. A scoped predicate
simply finds nothing, so "no such plan" and "not your plan" arrive at the same
answer without a branch that could leak the difference.

**The exception, which is deliberate:** `catalog_foods` and the recipe tables
carry no `user_id` at all. They are shared reference data — the same catalog and
the same recipes for every user — so there is no owner to scope to and no
cross-user row to leak. The three `/catalog/*` reads and the `current`-version
branch of `GET /recipes/:recipeVersionId` are therefore the only authenticated
reads in this feature without a tenant predicate. They are still authenticated,
and the caller is still resolved in every handler; the resolved id simply has
nothing to scope.

The exception is narrower than "recipes are public". The one per-user question
these routes ask — may this caller see a **retired** recipe version? — is
answered by owner-scoped reference checks, as described under
[`GET /recipes/:recipeVersionId`](#get-recipesrecipeversionid).


## Changes to the shipped contract

Every change to an endpoint that already shipped is additive. Nothing is removed,
nothing is renamed, and no existing field changes type.

**`MealEntryResponse` gains two members.** `mealPlanMealId` and
`nutritionProvenance` are **always present** and are `null` on rows that predate
them. The null is not an absence to be shrugged at — it is a specific class:

- `mealPlanMealId` is non-null only when the entry was logged from a planned
  meal. Its presence is what drives the "from meal plan" caption and the plan
  card's logged state.
- `nutritionProvenance` is `null` **only** for rows written before the column
  existed, which the client reads as unknown. A client-supplied snapshot logged
  through the legacy entries path carries `user_entered` instead, because the
  server cannot vouch for numbers it did not derive. Neither class earns a source
  label in the diary; `source_backed`, `ingredient_derived` and `ai_estimated`
  are values only a server-derived snapshot can receive.

The mobile codec models both as absent-or-null-or-value rather than as plain
optionals, because the mapper emits an explicit `null` and a codec written for
"optional string" would reject it.

**`inputMethod` may now be `meal_plan`.** It is typed as a string on the wire and
older clients fall back for values they do not recognise, so an older build
decodes a planned entry unchanged — it simply does not render the new caption.

**`POST /api/macros/meal/:mealId/entries` accepts a second body shape.** Beside
the unchanged legacy macro-bearing body there is now a catalog body:

```json
{"catalogFoodId": "8f1c…", "servings": 1.5, "servingText": "1 cup", "inputMethod": "search"}
```

The branch is chosen by a pure parser before either writer runs:

- The **legacy** branch's guard and service call are unchanged, byte for byte,
  including its dedupe-by-food behaviour. A malformed legacy body still earns the
  exact 400 message shipped clients already read, rather than being re-shaped
  into the newer coded body.
- The **catalog** branch derives the snapshot server-side from the published
  catalog food, ignores any macros in the body, and sets the input method to
  `search` regardless of what was sent. `servingText` is accepted only when it
  matches one of that food's stored portion descriptions — otherwise
  `400 invalid_serving` — and the food row is never touched, so no personal food
  is created. **The legacy `food_id` dedupe path is never entered** for a catalog
  or a planned entry.
- A body carrying **both** `foodId` and `catalogFoodId`, or matching neither
  shape, is `400 invalid_payload` with the field named. An unknown or unpublished
  catalog id is `404 catalog_food_not_found`.

**`PUT /api/macros/entry/:id` gains detachment semantics.** An edit that changes
only `servings` keeps the plan and catalog links, the input method and the
provenance — the user ate a different amount of the same thing. An edit that
changes the `name` or any macro value **detaches** the entry: the plan, recipe
and catalog links are cleared, the input method becomes the existing default
`library` (no new method value is introduced, so older clients decode it
unchanged) and the provenance becomes `user_entered`. The reason is that neither
the "from meal plan" origin nor any source label may survive on numbers the plan
did not produce; the planned meal reverts to unlogged, which is the truthful
state once the entry no longer describes it.

**`PUT /api/user/targets` is untouched** and deliberately never bumps the targets
revision. That is not an oversight — it is how the canonical read stays truthful
without breaking old clients: a write from that route leaves the stored values
differing from the confirmed snapshot, and
[`GET /meal-planning/targets`](#get-meal-planningtargets) reports `source:
"legacy"` so the planner refuses to build a week on numbers nobody confirmed.

**The ordering consequence: the backend must ship before the client.** Every
change above is additive for an old client but required by the new one — a client
that expects `mealPlanMealId`, `meal_plan` input methods or the catalog body
against an older backend has no contract to talk to.

## Error-code index

Services throw typed errors carrying the data the client acts on, and the two
controllers are the only places that turn a class into a status. That is why
`mealPlanning.errors.ts` declares no status codes at all: a service that picked
one would be speaking HTTP from the wrong layer.

Error bodies use the `{"error": "<code>"}` envelope the client's existing code
reader already understands, with any payload members alongside the code.
Failures are logged server-side with `console.error`; **the raw error object is
never part of the body**.

All twenty-one meal-planning error classes, each with exactly one status:

| Code | Status | Routes that can return it | Class |
| --- | --- | --- | --- |
| `preferences_incomplete` | `409` | plan generate, regenerate | `PreferencesIncompleteError` |
| `stale_revision` | `409` | preferences step save, preferences save, plan generate, regenerate | `StaleRevisionError` |
| `invalid_request` + `read_only_field` detail | `400` | preferences save, preferences step save | `ReadOnlyFieldError` |
| `estimate_unavailable` | `409` | target estimate, target save | `EstimateUnavailableError` |
| `estimate_stale` | `409` | target save | `EstimateStaleError` |
| `stale_targets` | `409` | target save | `StaleTargetsError` |
| `targets_missing` | `422` | plan generate, regenerate | `TargetsMissingError` |
| `targets_unconfirmed` | `409` | plan generate, regenerate | `TargetsUnconfirmedError` |
| `plan_overlap` | `409` | plan generate, regenerate | `PlanOverlapError` |
| `upcoming_exists` | `409` | plan generate, regenerate | `UpcomingExistsError` |
| `stale_plan` | `409` | regenerate, swap commit, planned log | `StalePlanError` |
| `plan_not_active` | `409` | regenerate, swap commit, planned log, grocery toggle, uncheck-all | `PlanNotActiveError` |
| `idempotency_conflict` | `409` | the four keyed writes | `IdempotencyConflictError` |
| `no_matching_meals` | `422` | plan generate, regenerate | `NoMatchingMealsError` |
| `plan_generation_failed` | `502` | plan generate, regenerate | `PlanGenerationError` |
| `preview_stale` | `409` | swap commit | `PreviewStaleError` |
| `recipe_ineligible` | `422` | swap preview, swap commit | `RecipeIneligibleError` |
| `swap_failed` | `502` | swap commit | `SwapFailedError` |
| `Plan not found` | `404` | every `/meal-planning/plans/…` route | `PlanNotFoundError` |
| `catalog_food_not_found` | `404` | `POST /api/macros/meal/:mealId/entries` (catalog body) | `CatalogFoodNotFoundError` |
| `feature_disabled` | `503` | the sixteen gated routes | `MealPlanningDisabledError` |

Four more outcomes are absent from `mealPlanning.errors.ts`, by design. Three of
them are produced without any error class; the fourth has one, in the diary
domain:

| Code | Status | Routes | Why it is not in `mealPlanning.errors.ts` |
| --- | --- | --- | --- |
| `invalid_request` | `400` | every route with a parser | No class: field validation returns a verdict rather than throwing, which is what keeps the parsers testable without exceptions. The `read_only_field` variant in the table above is the one thrown case. |
| `invalid_payload` | `400` | `POST /api/macros/meal/:mealId/entries` | No class, same reason — a body matching neither shape is a parser verdict. |
| `invalid_serving` | `400` | `POST /api/macros/meal/:mealId/entries` (catalog body) | Has a class, but not this file's: `InvalidServingError` is declared in `nutrition.logic.ts` beside the catalog writer that raises it and mapped to this status by `nutrition.controller.ts`, because a failure belongs to the module that raises it — the same boundary that keeps `EstimateFailedError` in `estimate.service.ts`. |
| `Recipe not found` | `404` | `GET /recipes/:recipeVersionId` | The service returns `null` and the controller maps it, so "no such version" and "not visible to you" cannot diverge. |

Two bodies across the two tables above carry a human string rather than a
machine code (`Plan not found` from the class table, `Recipe not found` from the
table just above), matching the existing diary routes' `Meal not found` and
`Entry not found`. New client code should branch on the status for these, not on
the string.

The four codes the client already maps from shipped endpoints, included so the
whole vocabulary is visible in one place — none of them is a meal-planning route:

| Code | Status | Route |
| --- | --- | --- |
| `feature_disabled` | `503` | AI estimate and label scan (the same code meal planning reuses) |
| `quota_exceeded` | `429` | AI estimate and label scan |
| `estimation_failed` | `502` | AI estimate and label scan |
| `branded_search_failed` | `502` | branded food search |

Finally, two statuses sit outside the contract vocabulary above and are named
here so their absence from the per-endpoint lists is not read as an omission.
`401` is the shared auth middleware's answer for a missing or invalid bearer
token, ahead of every handler. **`500` is each controller's residual
unmapped-exception fallback** — it is not a contract code, and no client should
branch on it. On the meal-planning controller that fallback now answers one
stable body, `{"error": "internal_error"}`, for every route it serves, rather
than a per-handler sentence: the route that failed is recorded in the server
event instead, where a description is useful and where it is not something a
client can come to depend on. It is still not a contract code — `internal_error`
means "the server faulted", carries nothing to act on, and a client that
branches on it is branching on a bug. The other controllers (`catalog`,
`nutrition`, `workout`, and the rest of the shipped diary surface) keep their
existing prose fallbacks unchanged.

Internal data-integrity classes (`MealPlanDataError`,
`SwapDataError`, `GroceryDataError`, `PlannedMealLogWriteError`,
`RecipeMappingError`) are deliberately kept out of the vocabulary and land
there: they mean a stored row contradicts an invariant, which is an operator
problem to read in the logs rather than a condition a client can act on.
