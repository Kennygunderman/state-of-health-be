# Meal planning — planning policy

The reviewed policy record for the numbers and rules that decide a user's
nutrition targets, their week of meals, and their grocery list.

This document does not explain the code. The pure `*.logic.ts` modules and their
unit tests do that, and they are the authority on behaviour. What this document
records, for each rule, is **what it is, where it came from, and what it does not
claim** — the three things a reader cannot recover from an implementation, and
the three that matter when someone proposes changing a number.

Three habits keep it useful rather than decorative.

- **Every number is attributed.** Each table carries a `Status` column, and each
  row is one of the three classes below. A number with no attribution is a
  defect in this document.
- **It records the decision and its boundary**, not a paraphrase of a function
  body — the value, which side of it is inside, and what changes if it moves.
  Where a paragraph would only restate code, it is absent on purpose.
- **It points at the contract rather than copying it.** Where a policy surfaces
  on the wire as a stable machine code, the code is named here and its request
  and response shapes stay in [`api.md`](./api.md). A shape duplicated into
  prose drifts silently.

## The three provenance classes

| Status | Meaning |
| --- | --- |
| **Cited literature** | A published equation or figure, reproduced with its citation. |
| **Product policy** | A decision this project made. Where it concerns a nutrition bound it is additionally **for general-wellness use and is not clinical guidance**, and no clinical source is claimed for it. |
| **Inference** | A resolution reached where the design was silent or self-contradictory, recorded so it can be revisited rather than rediscovered. |

Two statements apply to the whole document and are made once.

**Nutrition bounds are product policy, not clinical guidance.** The activity
multipliers, the calorie floors and ceiling, the adult input envelope, the macro
split, the manual-entry ranges, the day tolerances and the budget tiers are this
product's own guardrails. They exist to stop arithmetic producing a number the
app should never show. They do not advise anyone, and nothing here should be read
as a clinical recommendation.

**No policy number in this document is an environment variable.** Every value is
either a named constant in a `*.logic.ts` module or reviewed data in
`data/meal-planning/`. This follows `backend-architecture` §5 — a service must
not read the environment for a business decision — and it is what makes the
rules testable and a change to one of them a reviewable diff rather than a
deployment setting. The environment configures integrations and feature gates
(see [`README.md`](./README.md) and [`api.md`](./api.md)); it never configures a
threshold.

## Status at this commit

<!-- BEGIN POLICY GATE: status-at-this-commit -->

| Referenced thing | State |
| --- | --- |
| `src/services/targets.logic.ts`, `mealPlan.logic.ts`, `swap.logic.ts`, `grocery.logic.ts`, `recipe.logic.ts`, `plannedMealLog.logic.ts`, `preferences.logic.ts` | present; every number below is a named export or a named constant in one of them |
| `src/utils/units.ts`, `src/utils/seededRandom.ts` | present |
| `src/types/mealPlanning.ts`, `src/types/recipe.ts`, `src/types/nutrition.ts` | present; every stable code named here is spelled there |
| `data/meal-planning/recipes/coverage-report.json` | present, generated from the seeded recipe set; §5 quotes it and nothing else |
| The 121 authored recipe files in `data/meal-planning/recipes/` | present, against a required minimum of 40 |
| Per-run acceptance evidence — published catalogue counts, benchmark hit rates and latencies | **operator-produced, and committed** under `data/meal-planning/reports/latest/` as `import-report.json`, `validation-report.json` and `benchmark-report.json`; the last declares itself the acceptance evidence for search quality. Each figure is owned by the report that measured it — a measurement of one database at one moment — so it is read there and **nothing here states a measured result.** Which runs happened and what each returned is one table, in [`requirement-evidence-checklist.md`](./requirement-evidence-checklist.md#what-was-verified-in-this-environment); see also [`catalog-policy.md`](./catalog-policy.md) and [`README.md`](./README.md). |

<!-- END POLICY GATE: status-at-this-commit -->

---

# 1. Nutrition targets

Implemented by `src/services/targets.logic.ts`, pinned by
`src/services/__tests__/targets.logic.test.ts`. The wire semantics of
`TargetsResponse` — what each field means to a client — are in
[`api.md`](./api.md#get-meal-planningtargets) and are not restated here.

## 1.1 The energy equation

**Status: cited literature.** Mifflin MD, St Jeor ST, Hill LA, Scott BJ,
Daugherty SA, Koh YO. "A new predictive equation for resting energy expenditure
in healthy individuals." *American Journal of Clinical Nutrition*
1990;51(2):241–247.

Resting energy expenditure, in kcal/day, with weight in kilograms, height in
centimetres and age in years:

```text
male    BMR = 10·weight + 6.25·height − 5·age + 5
female  BMR = 10·weight + 6.25·height − 5·age − 161
```

`sexForEstimate` has a third answer, `prefer_not_to_say`, and the equation has no
coefficient for it. It produces **no estimate at all** rather than a guessed sex
or an average of the two forms; the user takes the manual-entry route instead.
That is a deliberate refusal, not a gap: the type `CalculableSex` narrows the
value out, so `computeTargetEstimate` cannot be handed it.

<!-- BEGIN POLICY GATE: nutrition-targets -->

## 1.2 The activity factor

| Level | Factor | Status |
| --- | --- | --- |
| `not_very_active` | 1.2 | Product policy — general-wellness use, not clinical guidance |
| `lightly_active` | 1.375 | Product policy — general-wellness use, not clinical guidance |
| `active` | 1.55 | Product policy — general-wellness use, not clinical guidance |
| `very_active` | 1.725 | Product policy — general-wellness use, not clinical guidance |

**The provenance here is easy to overstate, so it is stated precisely.** The
*physical-activity-level concept* — expressing total daily expenditure as a
multiple of the resting rate — comes from FAO/WHO/UNU, *Human Energy
Requirements: Report of a Joint FAO/WHO/UNU Expert Consultation*, Rome, 2001
(FAO Food and Nutrition Technical Report Series 1). That report publishes
activity-level **ranges** per lifestyle category. **It does not publish these
four numbers.** The four factors are the Harris–Benedict-era multipliers
reproduced by common dietetic calculators, adopted here as product policy so
that four on-screen options map to four stable factors.

FAO/WHO/UNU is therefore cited for the concept only. Do not "correct" these
values against that report — it does not contain them.

## 1.3 The activity model — one model, stated once

Activity level describes the user's **habitual overall activity, including how
often they usually train.** That is what the on-screen option sub-copy anchors
describe ("1–2 workouts a week", "3–5 workouts a week", "6+ workouts a week").

Three consequences follow, and together they are the whole model:

1. The factor multiplies the basal rate **exactly once**.
2. Workouts and runs logged in the app are **never added on top** of the result.
3. There is **no automatic workout-calorie adjustment** anywhere, so training is
   never counted twice.

**Status: inference.** This resolves a contradiction in the design rather than
restating it. One onboarding info card's copy read "Outside of workouts you log
in the app.", which describes the opposite model — a baseline that excludes
training, to which logged activity would then have to be added. That copy was
replaced. The replacement sentence is the user-facing policy string, and this
document and that string must agree:

> Include your usual training. Workouts and runs you log are tracked separately
> and never added to your targets.

The same sentence is also the helper text on the plan-settings activity row. If
one of the three is ever edited, all three change together.

## 1.4 The weight-change adjustment

**Status: cited literature, treated as an approximation.**

The energy equivalent of a pound of body mass is taken as ≈3,500 kcal:
Wishnofsky M. "Caloric equivalents of gained or lost weight." *American Journal
of Clinical Nutrition* 1958;6(5):542–546.

It is treated as an approximation rather than a conversion law, following
Hall KD. "What is the required energy deficit per unit weight loss?"
*International Journal of Obesity* 2008;32(3):573–576, which shows the constant
misstates longer-run change. That is precisely why the result is presented as a
starting estimate the user can edit, and never as a prediction of what their
body will do.

3,500 ÷ 7 = **500 kcal/day per pound-per-week** of intended change, applied as
−500·pace for loss and +500·pace for gain:

| Goal | Pace (lb/week) | Daily adjustment | Copy | Status |
| --- | --- | --- | --- | --- |
| `lose` | 0.5 | −250 kcal | "About 250 cal under maintenance" | Cited literature (derived) |
| `lose` | 1 | −500 kcal | "About 500 cal under maintenance · recommended" | Cited literature (derived) |
| `lose` | 1.5 | −750 kcal | "About 750 cal under maintenance" | Cited literature (derived) |
| `gain` | 0.5 | +250 kcal | "About 250 cal over maintenance" | Cited literature (derived) |
| `gain` | 1 | +500 kcal | "About 500 cal over maintenance" | Cited literature (derived) |
| `gain` | 1.5 | +750 kcal | "About 750 cal over maintenance" | Cited literature (derived) |
| `maintain` | — | 0 | — | Product policy |

Loss and gain share the same three paces, so the magnitudes are identical and
only the sign differs. **The sign is the decision**: inverting it would turn
every weight-loss plan into a gain plan and every gain plan into a loss plan,
which is why both directions are pinned at all three paces rather than one
direction being assumed to follow from the other.

`maintain` carries no pace by contract. A stored pace on a `maintain` row is
ignored rather than treated as a contradiction — the goal alone decides the
adjustment is zero. The inverse is not tolerated: a `lose` or `gain` row with no
usable pace is **unusable**, reported as `missing_inputs`, because reading it as
maintenance would show a maintenance target on a weight-loss plan.

## 1.5 Input ranges

| Input | Supported range | Status |
| --- | --- | --- |
| `age` | 18–100, integer | Product policy — general-wellness use, not clinical guidance |
| `heightCm` | 120–250 | Product policy — general-wellness use, not clinical guidance |
| `weightKg` | 30–300 | Product policy — general-wellness use, not clinical guidance |
| `sexForEstimate` | `female`, `male`; `prefer_not_to_say` takes the manual route | Product policy |
| `activityLevel` | the four levels in §1.2 | Product policy |
| `goal` | `lose`, `maintain`, `gain` | Product policy |
| `paceLbPerWeek` | 0.5, 1, 1.5; absent for `maintain` | Product policy |
| `goalWeightKg` | optional; must lie on the goal's side of current weight | Product policy |

**Out-of-range input produces a field-level validation error and never an
extreme target.** The boundary matters in both directions. `preferences.logic.ts`
rejects an out-of-envelope value with a `400` at write time, so by the time the
estimate runs, a stored value outside these ranges is a corrupt row rather than
something a user typed. The estimate then **refuses** it — reporting
`missing_inputs` — instead of clamping it into range, because clamping would
present a figure the user's own details do not support. A non-integer age is
refused for the same reason.

**Inputs are stored metric; the client converts for display.** The conversion
factors, used by the mobile app and never by the server:

| Conversion | Factor | Status |
| --- | --- | --- |
| pound → kilogram | 0.453 592 37 | Cited literature (international avoirdupois) |
| inch → centimetre | 2.54 | Cited literature (international inch) |
| stone → kilogram | 6.350 293 18 | Cited literature (14 lb) |

The stone unit is **display-only**. The app's weight-unit preference admits it,
but the onboarding body-details control offers pounds and kilograms only, so a
stone-preferring user sees the kilogram toggle. Height and weight cross the wire
in metric in every case (`HeightUnitPref` and `WeightUnitPref` are presentation
preferences, nothing more).

## 1.6 Bounds

**Status: product policy — general-wellness use, not clinical guidance.** No
clinical source is claimed for any of these four numbers.

| Bound | Value | `clampReason` when it decides the figure |
| --- | --- | --- |
| Female calorie floor | 1,200 kcal | `floor` |
| Male calorie floor | 1,500 kcal | `floor` |
| The user's own basal rate | the computed BMR | `below_bmr` |
| Calorie ceiling | 5,000 kcal | `ceiling` |
| Nothing bound the figure | — | `null` |

The figure presented is `min(ceiling, max(adjusted, sex floor, BMR))`. Two
properties of that expression are counter-intuitive enough to state outright.

**The floor applies to every goal, not only to weight loss.** It is tempting to
gate it on `lose`, because that is where it usually binds. But a `maintain` plan
at the low corner of the supported envelope binds it too, and a loss-only floor
would then present a target far below the app's own published minimum.

**Both corners of the supported envelope bind a bound**, so the clamps are
reachable in ordinary use rather than only under pathological input:

| Corner | Inputs | Derivation | Result |
| --- | --- | --- | --- |
| Low | 30 kg, 120 cm, 100 y, female, `not_very_active`, `maintain` | BMR 389 → TDEE 467 → adjusted 467 | clamped to **1,200 kcal**, `clampReason: 'floor'` |
| High | 300 kg, 250 cm, 18 y, male, `very_active`, `gain` at 1.5 | BMR 4,478 → TDEE 7,724 → adjusted 8,474 | clamped to **5,000 kcal**, `clampReason: 'ceiling'` |

Both rows quote the figures as reported, which are rounded for presentation; the
derivation itself used the unrounded values throughout (§1.7).

Three boundary decisions sit inside the clamp, each pinned by a test:

- **Both lower bounds are applied and the higher wins**, and the reason names
  whichever it was: `below_bmr` when the user's basal rate exceeds the sex
  floor, `floor` otherwise. **On an exact tie the reason is `floor`**, because
  the sex floor is the app's own published minimum and attributing the clamp to
  policy rather than to the user's physiology is the claim that always holds.
- **The ceiling is applied last** and its reason wins whatever raised the figure,
  so the reported reason is always the bound that actually decided the presented
  number. Within the supported envelope the highest possible basal rate is
  4,477.5 kcal, so the ceiling and a lower bound cannot both bind today;
  applying it last keeps the rule total if that ever changes.
- **Every bound is compared at full precision and the rounding is last.** A
  pre-rounded comparison would let a 1,199.6 kcal result read as satisfying a
  1,200 kcal floor it does not satisfy. The rule is uniform: a shortfall of a
  fraction of a kcal is still a bound deciding the number, so 1,199.6 against
  the female floor reports `floor`, and 1,606 against a 1,606.25 kcal basal rate
  reports `below_bmr`. No bound gets a visibility threshold the other two do
  not.

When a bound decided the figure, the user sees:

> Adjusted to the app's minimum for your details

**Status: product policy.** The wording is deliberately product-bound. It says
*the app's* minimum, so it makes no clinical claim about what the user needs, and
it claims only that a bound rather than their details decided the number — which
is exactly what `clamped` means. It has never claimed the difference is large
enough to see.

## 1.7 The macro split

| Macro | Share of energy | Grams from kcal | Status |
| --- | --- | --- | --- |
| Protein | 30 % | ÷ 4 | Product policy — general-wellness use, not clinical guidance |
| Carbohydrate | 40 % | ÷ 4 | Product policy — general-wellness use, not clinical guidance |
| Fat | 30 % | ÷ 9 | Product policy — general-wellness use, not clinical guidance |

The divisors are the Atwater energy factors. A conventional balanced split, not
a prescription.

**Rounding order is part of the contract.** The basal rate and the
activity-adjusted rate are carried at **full precision** through the whole
derivation; the calorie figure is rounded **exactly once**, after the goal
adjustment and after the bounds; and the macro grams are then derived from that
single rounded, bounded integer. So the four numbers a user sees always describe
one consistent target.

Rounding earlier changes the answer, which is why the order is pinned rather
than assumed. In the worked example below, a full-precision basal rate of
1,606.25 kcal yields a 2,209 kcal maintenance rate, where a pre-rounded 1,606
would yield 2,208. And grams come from the **final** figure: a target clamped up
to 1,200 kcal must produce 1,200 kcal worth of macros — 90 g / 120 g / 40 g —
not the macros of the number the arithmetic first produced.

### Worked example, end to end

Inputs: female, 34 years, 177.8 cm, 82.6 kg, `lightly_active`, `lose` at
1 lb/week.

| Step | Arithmetic | Value |
| --- | --- | --- |
| BMR | 10(82.6) + 6.25(177.8) − 5(34) − 161 | 1,606.25 (reported as **1,606**) |
| TDEE | 1,606.25 × 1.375 | 2,208.593 75 (reported as **2,209**) |
| Adjustment | −500 × 1 | **−500** |
| Adjusted | 2,208.593 75 − 500 | 1,708.593 75 |
| Bounds | max(1,708.59, 1,200, 1,606.25) = 1,708.59; ≤ 5,000 | nothing bound → `clampReason: null` |
| Calories | round(1,708.593 75) | **1,709 kcal** |
| Protein | round(1,709 × 0.30 ÷ 4) | **128 g** |
| Carbohydrate | round(1,709 × 0.40 ÷ 4) | **171 g** |
| Fat | round(1,709 × 0.30 ÷ 9) | **57 g** |

`bmr` and `tdee` are rounded only where they are reported; the derivation used
the unrounded values throughout.

## 1.8 Manual targets

**Status: product policy — general-wellness use, not clinical guidance.**

| Field | Range | Status |
| --- | --- | --- |
| `calories` | 800–6,000, integer | Product policy — general-wellness use, not clinical guidance |
| `protein`, `carbs`, `fat` | 1–1,000 g each, integer | Product policy — general-wellness use, not clinical guidance |

**Hand-entered values are stored exactly as entered, with no rebalancing.** The
edit screen promises in so many words that macros need not add up to the calorie
target and that the app will not adjust them, so the server does not.

**The macro minimum is 1 g, not 0.** The boundary is the decision: the edit
screen's own error copy is "Enter a carb target above 0 g", so a zero must fail
validation rather than save as a real target of nothing. A zero is reported with
the field code `below_minimum`, which is what that message renders.

Three assessments accompany a successful save. **None of them blocks it.**

| Warning | Condition | Status |
| --- | --- | --- |
| `macro_energy_mismatch` | \|4·protein + 4·carbs + 9·fat − calories\| > 25 % of calories | Product policy — general-wellness use, not clinical guidance |
| `below_catalog_min` | calories < 1,000 | Product policy |
| `above_catalog_max` | calories > 4,500 | Product policy |

These return `200` with the values stored, and the client shows them as
guidance. `ok: false` means "we have something to tell you about these numbers",
never "we refused them" — there is no rejection on this route. The two calorie
warnings are mutually exclusive by construction, and warnings are emitted in
declaration order so the array is deterministic.

The two calorie thresholds are not health bounds. They are the range the recipe
catalogue can realistically build a week within, which is why they are named for
the catalogue and not for the user.

<!-- END POLICY GATE: nutrition-targets -->

## 1.9 Persistence, precedence and staleness

**One canonical writer.** For a user who has opted into meal planning,
`PUT /meal-planning/targets` is the only path that writes the four target
values. The legacy `PUT /api/user/targets` stays untouched for API
compatibility and gains no new caller.

**Server targets win wherever they exist.** Every surface that shows a target —
plan review, plan settings, the account row, the progress tab, the diary —
resolves to the same stored values, so the numbers agree by construction rather
than by each screen being remembered.

**A user who never opted in keeps today's behaviour exactly.** Their stored
target columns stay null, the client falls back to its own local value, and
**nothing is migrated or overwritten.** Opting in is the only thing that creates
server targets.

The stored source is one of three codes. `estimated` and `manual` are the two
routes a user can confirm through; `legacy` is **derived, never stored**, and is
explained at the end of this section.

**A confirmed `estimated` target is fixed once confirmed.** Later changes to
goal, body, activity or pace never silently rewrite it. Instead:

- the response's staleness flag turns true;
- the review and settings surfaces offer a recalculate affordance beside the
  confirmed value;
- generation and regeneration keep using the **confirmed** values until the user
  reconfirms.

**Status: product policy.** The alternative — recomputing silently — would move
a user's targets underneath them because they corrected their height. Staleness
is judged as an ancestry check: the preferences revision the confirmed figure was
computed at, against the preferences revision the row is at now. An estimate
confirmed without recording the inputs it came from is stale by that comparison,
and rightly so — it cannot be shown to still match them, so the honest answer to
"does this still describe your details?" is "ask again".

The `legacy` source exists for the same honesty reason. Because the untouched
legacy route never bumps the targets revision, an older client or an existing
integration can change the stored values after a confirmation without leaving
any other trace. The snapshot written at confirmation time is the only record of
what was confirmed, so the canonical read compares against it. **It detects; it
never migrates or overwrites.** The planner refuses to build on `legacy` or
incomplete targets rather than guessing which numbers the user meant.

Field-by-field semantics of `TargetsResponse` — `targets`, `complete`, `source`,
`stale`, `revision` — are in
[`api.md`](./api.md#get-meal-planningtargets).

---

# 2. Nutrition classes and labelling

Three **independent** facts are stored and labelled separately. Conflating any
two of them is what produces a dishonest label, so the separation is the policy.

| Fact | What it answers | Values |
| --- | --- | --- |
| **Nutrition provenance** | What supports these numbers? | `source_backed`, `ingredient_derived`, `ai_estimated`, `user_entered` |
| **Calculation method** | How were they arrived at? | recorded in prose on the validation record and the recipe version |
| **Meal origin** | Where did this diary entry come from? | `input_method`, of which `meal_plan` is the planned-meal value |

**Status: product policy**, and it implements the prompt's nutrition-integrity
requirement.

## 2.1 Nutrition provenance — what supports the numbers

`source_backed` means a USDA record or a product label supports the stated
values. `ai_estimated` means a model produced them. `user_entered` means a
client supplied them and the server cannot verify them.

`ingredient_derived` deserves its own sentence, because it is the one that looks
like it should be trustworthy and is not. **It is an estimate even though its
components are sourced, because its *quantities* are assumed.** A composed food
whose ingredient list is known but whose proportions were inferred is a guess
about the proportions, however well sourced each component is — so it is
labelled as an estimate and, per §3.1, it never enters planning.

Allergen knowledge is a separate column again (`allergen_status`, whose
reviewed value is `known`), because "we do not know" must never render as
"none".

The four catalogue columns that carry these facts on a food row —
`identity_source`, `identity_status`, `nutrition_provenance` and
`publication_status` — are the catalogue's own contract and are recorded in
[`catalog-policy.md`](./catalog-policy.md#provenance-model--four-independent-facts).
They are not restated here.

## 2.2 Calculation method — why recipe nutrition is source-backed

Recipe nutrition is **calculated** from the exact stored gram weights of
source-backed ingredients against each ingredient's frozen per-100 g snapshot.
Nothing in that arithmetic is assumed: the gram weights are authored data, the
per-100 g values are sourced, and the multiplication is exact.

That is why a recipe's rolled-up provenance is `source_backed` rather than
`ingredient_derived`, and it is the distinction that makes the label honest. A
recipe is never `user_entered` — no client supplies a recipe's numbers.

This is also the prompt's mandated method, stated as policy: meal-planner recipe
nutrition is computed from stored ingredient quantities and source-backed
nutrition records, never from a model's opinion of the finished dish.

## 2.3 Meal origin — an independent fact, not a nutrition claim

`input_method = 'meal_plan'` records that an entry came from the plan. It is
**not** a provenance value and makes no claim about where the numbers came from;
the provenance column answers that separately. The origin fact is what earns a
diary row its "From meal plan" caption.

The server alone ever writes it. The request-body vocabulary deliberately
excludes `meal_plan` (`ClientInputMethod` in `src/types/nutrition.ts` is
`EntryInputMethod` minus that member), because the caption it drives claims the
entry came from a plan built out of source-backed ingredients, and a legacy body
carries none of that — no plan link, no recipe version, and macros the server
cannot verify. A body naming it is not rejected; it is simply not honoured, and
resolves like any other unrecognised value.

## 2.4 What each surface shows

| Surface | Label |
| --- | --- |
| Catalogue row in food search | one of "Source-backed", "Estimated from ingredients", "AI estimate" |
| The user's own foods in search | no label — its absence is the user-entered marker |
| Recipe detail and swap preview | "Calculated from source-backed ingredients" |
| Diary row | exactly one of "From meal plan", "Source-backed", "Estimated from ingredients", "Estimated", or nothing |

Two rules are hard and admit no exception:

1. **An AI estimate is labelled as an estimate wherever it appears** — in
   search, in detail, and in the diary.
2. **An AI-generated value, and an AI plausibility review, is never presented as
   verified nutrition.** A second-model review is advisory: it records flags and
   it cannot promote a value. Nothing a model produced is ever shown as
   source-backed.

## 2.5 Snapshots the server cannot verify

An entry written through the legacy client-supplied path arrives with macros the
server has no way to check — whatever the body's declared source or input
method. From this release such an entry is stored as **`user_entered`**.

Rows written before the provenance column existed keep **null**, which is
classified as **unknown**.

**Both classes render no source label.** That is what makes the treatment
honest without any backfill: a legacy row is not claimed to be source-backed, it
is not claimed to be an estimate, and **no client-supplied value is ever
presented as source-backed.** Existing AI-logged entries are a separate case —
their input method is a server-known fact, so they do earn the "Estimated"
caption.

## 2.6 The consequence for planning

Every ingredient of a planned recipe must be `source_backed` **and** carry
`allergen_status = 'known'` (§3.1). A planned meal is therefore **never an
estimate**, which is exactly why its "From meal plan" caption needs no class
qualifier: the origin label carries no nutrition claim, and the nutrition behind
it is source-backed by construction rather than by inspection.

---

# 3. Plan generation

<!-- BEGIN POLICY GATE: plan-generation -->

Implemented by `src/services/mealPlan.logic.ts`, pinned by
`src/services/__tests__/mealPlan.logic.test.ts`. A plan is always exactly one
week: `start_date` through `start_date + 6`.

## 3.1 Hard eligibility

A candidate either qualifies for a slot or it does not. There is no partial
credit and no score that can buy a way past any clause below.

| Clause | Requirement | Status |
| --- | --- | --- |
| Version status | the recipe version is `current` | Product policy |
| Nutrition provenance | `source_backed`, on the recipe **and** on every ingredient | Product policy |
| Allergen review | `allergen_status = 'known'` for **every** ingredient, optional ones included, **regardless of what the user selected** | Product policy |
| Allergens | no overlap between the user's allergens and the **union of every ingredient's snapshot allergen tags** | Product policy |
| Diet | compatible, derived from the ingredient snapshots | Product policy |
| Dislikes | no ingredient whose food **or food group** is disliked | Product policy |
| Time | `total_minutes ≤ cooking_time_limit_min`; no limit answered means no limit | Product policy |
| Slot | the requested slot is one the recipe declares | Product policy |

Four of these carry a boundary worth naming.

**Allergen review is unconditional.** Not "eligible unless the user selected
that allergen", and not "eligible if the recipe's rollup says known". A food
whose composition nobody reviewed cannot be certified safe for *anyone*, and an
ingredient that states no review at all counts as unreviewed. The two estimate
grades — `ingredient_derived` and `ai_estimated` — likewise never enter
planning, which is the nutrition-integrity requirement made structural rather
than documented.

**Diet containment is closed into the tags**: `vegan ⊂ vegetarian ⊂
pescatarian`, read as "a dish admissible for this diet is also admissible for
these". A vegan dish suits a vegetarian and a pescatarian; a vegetarian dish
suits a pescatarian, because the pescatarian set is the vegetarian set plus fish
and seafood. `none` is never emitted as a tag — it is the absence of a
restriction rather than a property of a food — and it admits everything at
comparison time.

**Dislikes match on the food id or its food group.** The group half is what
makes disliking one mushroom exclude the whole `mushroom` group without touching
an unrelated one.

**The recipe-level diet and allergen tag columns are a summary, never an
independent claim.** Eligibility is derived from the ingredient snapshots every
time. The summary columns are a record of that derivation, and the seed
**rejects** a recipe file whose declared tags disagree with it (§5.4) — so the
two can never drift into a state where a recipe passes one gate and fails
another for the same user.

**One implementation, three callers.** Plan generation, swap alternatives and
incompatibility flagging all route through the same eligibility function, because
three copies of this rule is how one of them starts serving an allergen. Every
refusal is collected rather than short-circuited, so the limiting-constraint
analysis can see that relaxing one constraint alone would not help.

## 3.2 Repetition is a hard rule only

| Rule | Value | Status |
| --- | --- | --- |
| Maximum uses of one recipe per week | 2 | Product policy |
| Uses on consecutive days | never | Product policy |

A candidate that would violate either is **ineligible for that slot**. There is
**no soft penalty** anywhere in the scoring for repetition.

**Why that distinction matters:** a score can be traded away. Making repetition
a scoring term would mean a sufficiently well-fitting recipe could appear four
times, or twice in a row, whenever the arithmetic favoured it. Making it
eligibility means it cannot. It is a correctness rule, not a preference.

This rule is also what fixes the coverage arithmetic in §3.10 and §5.6: seven
days of one slot, at most two uses each and never adjacent, **cannot** be filled
by three recipes and can be filled by four.

**Two uses may fall on the same day, and a third clause would be wrong.** The
rule counts uses per week and forbids adjacent days; it says nothing about two
slots of one day, because a lunch and a dinner that both serve a dish are two
distinct meals. A clause refusing that would refuse weeks this policy allows: a
tight pool can need one dish twice on one day while **every** slot holds plenty
of recipes, so the clause would answer a feasible week with
`422 no_matching_meals`.

**Same-day variety is a preference, delivered in the order rather than the
rule.** Left at the two clauses alone the generator took the legal pair readily —
measured against the seeded corpus, two thirds of planned weeks served one
recipe at two slots of a day — which is permitted and still poor. Two mechanisms
in §3.5 fix it without narrowing what is legal: within a slot, a recipe already
on today's plate is tried **after** every recipe that is not, and each day is
solved in two passes, the first offering no repeat at all and the second
reopening it. The property that buys is statable: **a day serves one dish twice
only when, given the days before it, it cannot be filled any other way.** A rule
refuses weeks; an order only chooses between them, and only the second can
prefer variety without ever costing a week.

**The week has the same preference, and there it is also a feasibility
mechanism.** Behind the same-day tier, a recipe the week has not used yet is
tried before one it has. This is the least-constraining choice, and the reason it
is not merely cosmetic is that the two weekly uses are a **scarce resource** —
one the scoring actively rewards spending, since `reuseBonus` (§3.3) scores a
recipe already on the grocery list better, so the assignment that scored best
today scores best again tomorrow. Left to the score alone the generator produced
a week whose third day copied its first and whose fourth copied its second, four
days spending both uses of every recipe able to carry a large target, after which
the remaining days had nothing left to reach the band with and the week was
refused as though the targets were impossible. Deferring reuse instead of
front-loading it keeps the later days solvable. Measured against a slot holding
seven or more interchangeable recipes, the week now serves seven different
dishes where the scored order served four twice — and with only four available it
still serves three of them twice, because an order cannot invent a fifth dish and
is not permitted to refuse the week.

## 3.3 Scoring

```text
score = 1.0 · targetProximity + 0.5 · budgetPenalty − 0.25 · reuseBonus
```

Lower is better. The weights are fixed.

| Term | What it measures | Weight | Status |
| --- | --- | --- | --- |
| `targetProximity` | how far the day built so far sits from its cumulative guidance share of the day target, summed over calories and the three macros as relative distances | 1.0 | Product policy |
| `budgetPenalty` | `max(0, recipeTier − userTier)` — how far above the user's cost band the recipe sits, and zero when it is at or below | 0.5 | Product policy |
| `reuseBonus` | ingredients already on the week's grocery list, **capped at 4** | −0.25 | Product policy |

**What scoring is for, and what it is not.** Scoring decides **the order
candidates are tried in**. It is **not an acceptance test** — no candidate is
ever accepted or rejected because of its score. The only acceptance test is the
day tolerance in §3.6, applied to a completed day. Confusing the two is the
mistake this paragraph exists to prevent: a change to a weight changes which
valid week you get, never whether the week is valid.

The reuse cap is the one boundary here. Beyond four shared ingredients, more
sharing stops earning score, so a recipe cannot win a slot purely by overlapping
heavily with the rest of the week.

## 3.4 Determinism

Identical inputs must produce an identical plan, and the same infeasibility
verdict. Three mechanisms deliver that.

**A portable candidate pre-order.** Candidates are ordered by the triple
`(recipe slug, recipe version, portion multiplier)` — **never** by database id,
insertion order or query order. The reason is the requirement: two databases
loaded from the same catalogue release hold the same recipes under different
ids, so an id-based order would give the same user a different week on each. The
triple means the same thing in both.

**A seeded shuffle over that pre-order.** The seed is derived from exactly five
inputs, joined with `|` in a fixed order, hashed with SHA-1, and read as the
first four bytes of the digest as an unsigned big-endian integer:

```text
userId | startDate | preferencesRevision | targetsRevision | generationAttempt
```

**The reduction is part of the contract.** A different field order, a different
separator, a different slice of the digest, or parsing the hex differently is a
*different seed*, and a different seed is a different plan for every user in the
system. SHA-1 is used for distribution, not security — nothing here
authenticates anything and the digest never leaves the process. `|` is safe as a
separator because none of the five fields can contain one.

**A single tie-break.** Candidates are tried in order of `(score, shuffleRank)`.
Equal scores order by shuffle rank, and **there is no lexical fallback.** That
omission is deliberate: a lexical fallback would make the seed irrelevant for
ties, which is the common case in a catalogue of interchangeable recipes, and two
users with identical answers would then receive identical weeks. Scores are
compared within a tolerance so two candidates whose scores are mathematically
equal but summed by different paths still tie into the shuffle rather than being
separated by a rounding artefact. Shuffle ranks are positions in a permutation,
so they are distinct and the order is total.

Two consequences follow, and both are stated outright because they are easy to
assume the other way.

**The idempotency key is deduplication only and never enters the seed.** The seed
input type gives it nowhere to live. So a retry under a fresh key replays the
same search and reaches the same verdict: "no meals match" **cannot** be shaken
off by trying again, and only a preference, a target or the catalogue changing can
change the answer. A regeneration varies because the generation attempt counter
does, not because the key does.

**Determinism is a property of candidate generation, not of committed plans.**
Replaying a committed action returns the **stored response**, never a
recomputation. The two are different guarantees and the replay one is the
stronger: see [`api.md`](./api.md#idempotency-and-replay).

## 3.5 The search

Depth-first with backtracking. Days in **date** order, slots in **schedule**
order, candidates in **move** order (§3.3).

**What one evaluation is.** One candidate **placed** in one slot is one
evaluation, and so is proving a whole day unfillable before any candidate is
placed — the two things the search can spend time on. Charging both is what
makes the two budgets below bound the *search* rather than merely bound its
placements. Work that proves nothing about the arithmetic is free: a candidate
the admissibility bound rules out is never placed and costs nothing, and a day
impossible because some slot holds **no** candidate at all costs nothing either,
since there was no search to charge for — that is coverage rather than
arithmetic, and §3.7 answers it with `slot_coverage` alone.

**Guidance shares shape the order, and constrain nothing.** Each slot carries a
cumulative share of the day target, stored cumulatively so the final entry is
exactly 1:

| Schedule | Per-slot intent | Cumulative shares | Status |
| --- | --- | --- | --- |
| Three meals | 25 / 35 / 40 % | 0.25, 0.60, 1 | Product policy |
| Three meals + snack | 22 / 30 / 35 / 13 % | 0.22, 0.52, 0.87, 1 | Product policy |

A candidate is **never rejected for missing its share.** The share decides which
candidates are tried first; the day tolerance decides what is acceptable. Storing
the shares cumulatively is itself a decision — summing 0.25 + 0.35 + 0.40 in
floating point does not give exactly 1.

**The objective is "best-first move order, first feasible" — not a global
optimum.** That is a deliberate choice rather than an approximation awaiting
improvement. A globally optimal week would have to compare whole weeks, which
has no deterministic tie-break (two weeks scoring identically would be separated
by nothing, so the plan would depend on enumeration order) and no bound on work
(it could not stop at the first solution). Trying candidates in score order and
accepting the first feasible week keeps both properties: same inputs, same plan;
and the search always terminates inside its budget.

The recursion, clause by clause:

- a day is accepted only when its **last** slot is filled **and** the completed
  day passes the tolerance;
- a candidate whose branch **provably cannot** finish inside the day's bands is
  not placed at all — the admissibility bound below;
- within one slot, a recipe **not** yet on today's plate is tried before one that
  is, and among the rest a recipe the **week** has not yet used is tried before
  one it has. Two tiers of move order, never a rule (§3.2);
- a day no assignment can close is recognised **before** its first placement and
  dead-ends for the price of one evaluation — the day-feasibility test below;
- filling the **penultimate** slot asks the exact question rather than the
  bounded one: does any candidate in the final slot's pool actually close this
  day? A prefix no final meal completes is not placed;
- a slot with no candidate left backtracks to the previous slot's next
  candidate;
- **a day that dead-ends backtracks into the previous day.** This is what
  preserves the week-wide repetition rule without a second pass: day 6
  discovering that days 1 to 5 have used up every eligible dinner is recoverable
  precisely because day 5 can take its next assignment instead;
- each day is solved in **two passes** — the first offering no same-day repeat,
  the second reopening the legal pair — and the second runs only when the first
  has been explored to exhaustion, every distinct assignment of the day tried
  with the rest of the week tried on top of each.

**The admissibility bound, and why it removes no week.** Before a candidate is
placed, the search asks whether the day could still land inside its bands with
that candidate taken: it adds the running totals to the widest and narrowest each
remaining slot could still contribute, and cuts the branch when even the most
favourable completion overshoots a band or the most generous one still undershoots
it. The bounds are taken over each remaining slot's **whole** pool, which is a
superset of what the repetition rule will actually leave available, so the test
is **optimistic** — when it says no, no assignment of the remaining slots could
have closed the day, and the branch held no solution to remove. The move order,
the scoring and "first feasible wins" are untouched: the week the search returns
is the week it would have returned without the bound. What changes is only how
much work it does to get there, and the bounds are recomputed on entry to each
day so that the exclusions the week has already accumulated are reflected in
them. At the last slot nothing remains to place, the bounds are zero, and the
test **is** the day tolerance — asked one step before a placement that would have
had to be undone.

**Why that matters to the answer and not just the cost.** Without the bound the
search spent its day allowance placing and unwinding branches that could never
close, and ran out before reaching the assignments that do. The refusal that
followed named the day tolerance as the reason for weeks that satisfy it — and
because how much allowance a target happened to waste is not monotonic in the
target, neighbouring targets could differ in verdict. Two things follow from
fixing it. Feasible weeks at ordinary maintain- and gain-sized targets are now
found, well inside one day's allowance. And a refusal that **does** come back
from a settled search is a demonstrated one: the search explored every assignment
the rule allows, so "no combination met the day bands" is proved rather than
guessed — which is the distinction §3.7 depends on.

**The exact test at the penultimate slot.** The bound above treats each nutrient
independently, so it admits a remainder no single meal actually has: "some dinner
supplies between 300 and 900 kcal, and some dinner supplies between 20 and 60 g
of fat" does not mean one dinner supplies both at once. One slot from the end
that relaxation is unnecessary, because nothing follows the last slot to bound —
the day's final total is the running total plus exactly one candidate's
nutrition, so asking whether **any** candidate in the final pool closes the day
is an exact question over a finite pool, answered in one pass over it. That is
where the day allowance was going: every lunch the intervals let through was
placed, and charged, only for the exact test one slot later to find nothing able
to follow it. The test is taken over the final slot's whole pool, a superset of
what remains available, so a negative answer removes nothing reachable.

**The day-feasibility test, and why a doomed day must not spend an allowance.**
On entry to a day, before any placement, the search asks whether **any**
assignment of that day's slots lands the day inside its bands — walking the
slots, pruning each prefix with the bound above, settling the final slot with the
exact test, and serving no recipe more often than the week's remaining allowance
permits. It answers "does a witness exist" and nothing else: no score is
computed and no order imposed, so it cannot influence *which* week is returned.
It earns its place because running an allowance out **ends the search** rather
than unwinding it: one genuinely unfillable day — days before it having spent the
two permitted uses of the recipes it needed — would otherwise consume the whole
day allowance proving itself impossible, and take with it every week reachable by
changing an earlier day. Answered on entry, that becomes an ordinary dead end:
one evaluation, the frontier records the day, and the recursion unwinds into the
previous day's next candidate. The budgets are unchanged; what changes is that
they are spent on days that can close.

**The walk is bounded, and the bound is a trade rather than a free win.** That
feasibility walk is itself a search, and on a pool where no assignment closes the
day it enumerates prefixes to prove it — measured at around 150,000 steps for one
such proof against the shipped corpus, which unbounded would spend the whole
wall-clock limit on a few hundred of them and return a `502` where the truthful
answer is a `422`. It therefore stops after a fixed amount of work and reports
"explore this day the ordinary way". Stopping keeps the test **sound** — it never
denies a day that has a feasible assignment, so no week legal under §3.2 is made
unreachable — but it does cost the shortcut: a doomed day it declines to judge is
discovered the expensive way, by the search spending evaluations on it, and a
search that then runs out of allowance refuses. The figure is set from
measurement in both directions, the pools that need the proof in order to plan at
all concluding well inside it while the pools that cost orders of magnitude more
are refusals regardless. It is not a policy threshold and is deliberately not
published as one: it names an amount of work, changes no rule, and appears in no
response.

| Budget | Value | Status |
| --- | --- | --- |
| Evaluations per day | 2,000 | Product policy |
| Evaluations per plan | 14,000 | Product policy |
| Wall-clock limit | 5 s | Product policy |

**The per-day counter accumulates across re-entries.** A day re-entered by
backtracking keeps spending the same 2,000, so a pathological week cannot spend
2,000 per visit and run indefinitely.

**Budget exhaustion and the wall-clock abort are different outcomes, and the
asymmetry is the decision.** Exhaustion ends the search and is **reported as
infeasible** — `422 no_matching_meals`, with the limiting constraint naming the
first day the search could not close. A timeout is a **server error** —
`502 plan_generation_failed`. The reason: exhausting a stated, deterministic
budget is a fact about the user's preferences against this catalogue, and the
same inputs will exhaust it again, so telling the user which preference to change
is the correct and reproducible answer. A wall-clock abort is a fact about the
machine that day; it is not reproducible and it says nothing about the user's
preferences, so presenting it as "no meals match your preferences" would be a
lie. The two guards are evaluated separately and the outcome names which fired.

## 3.6 Portions and tolerances

| Slot | Permitted multipliers | Status |
| --- | --- | --- |
| Main slots | 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2 | Product policy |
| Snack | 0.5, 0.75, 1, 1.25, 1.5 | Product policy |

**Each `(recipe, multiplier)` pair is its own candidate**, which is what lets the
search reach a day target without editing a recipe. The snack set is a strict
subset of the main set, which is why one global pre-order can be built from the
main set and filtered per slot.

**The day tolerance is the only hard nutrition acceptance test**, and it is
applied to a **completed** day — never to a partial one, and never to an
individual meal.

A partial day is read in one narrower sense and no other: the admissibility
bound in §3.5 asks whether the slots still to be filled could carry the day into
**these same bands**, and cuts the branch when they provably cannot. That is a
reachability test over the identical intervals — derived once, from the table
below, and read by both — never a verdict on the partial totals themselves. The
guidance shares of §3.5 remain the only thing with an opinion about how a
half-built day ought to look, and they only order moves.

| Quantity | Accepted band | Status |
| --- | --- | --- |
| Calories | within ±10 % of the day target | Product policy — general-wellness use, not clinical guidance |
| Protein | from target − 15 g to target + 25 g | Product policy — general-wellness use, not clinical guidance |
| Carbohydrate | within ±15 g **or** ±15 %, whichever is larger | Product policy — general-wellness use, not clinical guidance |
| Fat | within ±15 g **or** ±15 %, whichever is larger | Product policy — general-wellness use, not clinical guidance |

The protein band is deliberately asymmetric — more room above the target than
below — because overshooting protein is the benign direction for the goals this
product serves.

**The bands are inclusive**, and a day landing exactly on a bound must be
accepted. Since summing seven floating-point values rarely produces the exact
bound, every comparison carries a slack of 1e−9 in the unit being compared. That
is far too small to admit a day that is genuinely outside the band, and large
enough to stop a rounding error in the fifteenth digit rejecting a day that is
mathematically inside it.

A day that cannot satisfy the bands within the evaluation budget fails the plan
with `422 no_matching_meals`.

## 3.7 Limiting-constraint analysis

When no week can be built, the failure names what to change. Rows come back
most-limiting first, and every row is typed data the client formats itself.

| Order | `constraintKey` | Condition | Status |
| --- | --- | --- | --- |
| 1 | `slot_coverage` | a slot has **zero** eligible recipes | Product policy |
| 2 | `catalog_coverage` | a slot has fewer than **4** eligible recipes | Product policy |
| 3 | `cooking_time` | relaxing the limit to the next tier up makes the week feasible | Product policy |
| 3 | `dislikes` | ignoring dislikes makes the week feasible | Product policy |
| 3 | `diet` | dropping the diet restriction makes the week feasible | Product policy |
| 4 | `nutrition_tolerance` | eligibility held but no combination met the day bands, or the search ran out of evaluations | Product policy |
| 5 | `portion_limits` | a wider portion set would have closed the week | Product policy |

**The four-recipe threshold is evaluated on the user's real diet ∩ allergen ∩
dislike intersection, and never assumed.** The seed's coverage matrix (§5.6)
guarantees four only for the profiles it names, so assuming it for everyone would
report the catalogue as adequate for a user for whom it is not. Four is
arithmetic, not taste — it is the repetition rule of §3.2 applied to a seven-day
week.

**Relaxations are evaluated one at a time**, so each row is a claim about that
preference alone: "changing this one thing would open up the week."

**Allergies are never relaxed and never suggested for relaxation.** This is not
an omission awaiting completion — the analysis has **no branch** that could
produce an allergen row, because the screens promise in so many words that
allergies stay in place and the only way that promise cannot be broken is for the
code to be unable to break it. Every such response carries `allergiesKept: true`
for the same reason.

Two smaller decisions. First, `nutrition_tolerance` reports the tolerance
**band** (10, `percent`) rather than the day's calorie target. The unit
vocabulary is exactly `minutes`, `foods`, `percent` and `recipes` — it has **no
energy member** — and the contract requires a unit whenever a value is present,
so the band is the only honest number this row can carry. It is also the
actionable one, since the client already holds the targets. Its slot list is
empty, because the shortfall belongs to a day rather than to a slot. Second,
**the list is never empty**: a search that failed for
no reason the analysis can name still gets the `nutrition_tolerance` row, because
"no meals match" with nothing to act on is not an answer.

Response shape and the `editStep` each row carries:
[`api.md`](./api.md#post-meal-planningplans).

## 3.8 Incompatibility flags

Four codes, spelled `diet`, `allergen`, `dislike` and `cooking_time` — the
preference-conflict subset of the eligibility vocabulary, so a flag and a refusal
can never disagree about why a recipe does not fit.

The lifecycle, in full:

- **Every preference save** — a single onboarding step or a full update —
  recomputes flags for every meal of every active plan, **in the same
  transaction** as the save. A save cannot half-apply.
- **A swap to a compatible recipe** clears that meal's flags.
- **A later save that restores compatibility** clears them on recomputation.
- **A regenerated plan has none**, because it was built against the current
  preferences.

Flagging is deliberately **not** resolved by relaxing anything: a flagged meal
stays flagged and visible until the user swaps it or changes the preference.
Addressing one flagged meal never hides the rest.

**This recomputation is the one write to an active plan that carries no
idempotency key.** It is not a user action with a result to replay — it is a
derived consequence of a save that already has its own concurrency control, and
it is idempotent by construction (recomputing from the same preferences yields
the same flags).

## 3.9 Publish semantics

The candidate week is built **in memory**, before any transaction. Then one short
transaction inserts the plan, its days, its meals and its grocery items
together.

**A failure persists nothing, and no failed plan rows exist.** There is no
`failed` status and no partially built week to clean up, which is why a retry is
a clean attempt rather than a repair.

Regeneration supersedes the old plan **in the same transaction**, copies grocery
check state for items whose quantity did not change (§6.4), and leaves diary
links to the old plan's meals intact — food already logged stays logged.

The conflict codes that guard all of this — stale revisions, overlapping plans,
a superseded or ended plan — are the wire contract and are in
[`api.md`](./api.md#plans) and
[`api.md`](./api.md#idempotency-and-replay).

## 3.10 Budget tiers

**Status: product policy, calibrated to a single currency.** No price is shown
anywhere in the product; the tier is an explainable **relative** preference only.

A recipe's cost score, from its ingredients' cost classes weighted by mass:

```text
costScore = Σ(gram_weight × cost_class) ÷ Σ gram_weight
```

| Recipe cost score | `budget_tier` | Status |
| --- | --- | --- |
| ≤ 1.5 | 1 | Product policy |
| ≤ 2.5 | 2 | Product policy |
| > 2.5 | 3 | Product policy |

The user's own tier is derived from their weekly amount, reduced to a per-meal
figure first:

```text
perMeal = amount ÷ (meals per day × 7)
```

| Per-meal amount | User tier | Status |
| --- | --- | --- |
| < 3 | 1 | Product policy |
| 3 to 6 inclusive | 2 | Product policy |
| > 6 | 3 | Product policy |

**Per-meal rather than weekly is the decision**: the same weekly amount buys
more per meal on a three-meal schedule than on a four-meal one, so comparing
weekly amounts would band two users differently for the same real budget. **Both
boundaries fall in tier 2** — exactly 3 and exactly 6 are the middle band.

**"No budget preference" gives tier 3, which carries no penalty.** A null,
non-positive or non-finite amount does the same. The absence of an answer must
never narrow the week, and tier 3 is the only band that cannot (the penalty is
`max(0, recipeTier − userTier)`, which is zero for every recipe when the user is
at the top band).

**The currency calibration.** The amount is **USD**, the only currency this
version accepts, so these thresholds are calibrated to that currency and no
conversion appears anywhere in the derivation. A second currency would need its
own thresholds — the numbers 3 and 6 are not currency-neutral, and reusing them
for a currency with a different scale would band every user in that market
wrongly. That is the reason the wire contract pins the currency to a single
value rather than accepting any code.

## 3.11 What the time limit means

```text
total_minutes = prep_minutes + cook_minutes
```

**One definition, four callers.** Badge derivation (§5.3), planning eligibility
(§3.1), swap candidate selection (§4) and incompatibility flagging (§3.8) all
compare against this same value. A second spelling of it — cook time alone, or a
sum that forgot prep — would let a recipe pass one gate and fail another for the
same user, which is the specific bug this single definition exists to prevent.
The stored `total_minutes` column holds the result; it is not an independently
authoritative field.

The limits the user may choose are 15, 30, 45 and 60 minutes, ascending — which
is also the relaxation ladder `cooking_time` steps up in §3.7.

<!-- END POLICY GATE: plan-generation -->

---

# 4. Swaps

Implemented by `src/services/swap.logic.ts`, pinned by
`src/services/__tests__/swap.logic.test.ts`.

**The single-function rule.** The alternatives list, the preview and the commit
all call **one** candidate-selection function and **one** portion-selection
function.

That is the whole design, and the reason is what it prevents: three
implementations of "which recipes may replace this meal, and at what portion"
would drift, and the user would see a row in the list that the preview scored
differently and the commit refused. One implementation makes the three
structurally incapable of disagreeing. Eligibility (§3.1) is shared with plan
generation for the same reason.

**Repetition is evaluated against the week with the current meal removed.** A
meal does not count against itself — it is being replaced — but every other
day's uses still do. Counting the outgoing meal would make a recipe used twice
elsewhere in the week look like a third use and hide a legitimate alternative;
ignoring the other days would let a swap break the repetition rule of §3.2.

**The portion is chosen, not assumed.** For each eligible recipe, the portion is
the permitted multiplier that minimises the day's distance from its calorie
target **subject to the full day tolerance** (§3.6) with that candidate in
place. Two boundaries:

- A recipe for which **no** permitted portion satisfies the tolerance is
  **excluded**. Offering its least-bad portion would put a row in front of the
  user that would leave the day outside tolerance, which they have no way to
  evaluate from the row.
- Where two portions are mathematically equidistant, **the smaller multiplier
  wins.** Fixed rather than arbitrary: the list and the commit must pick
  identically for the same inputs, and the smaller portion is the more
  conservative choice.

<!-- BEGIN POLICY GATE: swap-offer -->

A swap is judged against the **whole** day, with a share of 1 — never against a
slot's cumulative guidance share. The generator scores a partial day because it
is still filling it; a swap replaces one meal of an already complete day, so the
only meaningful comparison is the finished day against the finished target.

**An empty result is a legitimate outcome, not an error.** It means the slot has
nothing to offer under the user's own restrictions, and the client has a state
that says so. It is never reported as a failure.

**Ranking is deterministic and PRNG-free**, ordered by the resulting day's
proximity bucket, then recipe slug, then version. No seed and no shuffle are
involved, so the list is stable across refetches — a user who scrolls away and
back sees the same rows in the same order. This is the one place the planner's
seeded tie-break (§3.4) is deliberately *not* used: a list the user is reading
must not reorder itself.

**The offer is bounded at 8 alternatives**, truncated **after** ranking, so the
eight rows are the eight best rather than the first eight the catalogue yielded.
The bound applies to the offer and not merely to the sheet: the preview and the
commit pick from these same eight, so a recipe the list did not show cannot be
committed.

<!-- END POLICY GATE: swap-offer -->

**The commit recomputes the portion with the same function and rejects a stale
preview** with `409 preview_stale` when the recomputed multiplier differs from
the one the request carried. The preview binds the **portion**, not the targets:
a target change that leaves the recomputed multiplier unchanged still commits.
See [`api.md`](./api.md#post-meal-planningplansplanidmealsmealidswap).

---

# 5. Recipes

Implemented by `src/services/recipe.logic.ts`, pinned by
`src/services/__tests__/recipe.logic.test.ts`. Seeded by
`scripts/recipes-seed.ts`.

<!-- BEGIN POLICY GATE: recipe-rules -->

## 5.1 Nutrition derivation

Per nutrient, summed over the ingredients:

```text
recipe total  = Σ (gram_weight × nutrient_per_100g ÷ 100)
per serving   = recipe total ÷ yield_servings
```

Each ingredient contributes against **its own frozen per-100 g snapshot**, taken
at the moment the recipe version was published — never against the live
catalogue row. That is what makes a published recipe version immutable in
practice: a catalogue refresh cannot silently change the nutrition of a plan a
user is already shopping for. Section 5.5 covers what happens instead.

A `per_100ml` ingredient is converted through its **stored density**, and a
**missing density fails the seed.** The reason is not fastidiousness:
millilitres never equal grams, so a volume basis with no density has no
defensible conversion, and defaulting to 1 g/ml would silently misstate every
oil and syrup in the recipe. The failure is loud and names the ingredient.

Per-serving values are kept as **floats**, not rounded. Rounding happens once,
later, and §5.2 is where.

Fibre is `null` when **any** ingredient's fibre is unknown. A sum missing a term
is not a smaller sum, and `0` would claim the recipe contains no fibre — a claim
no source made.

**Disclosure rather than correction when the two calorie totals disagree.** The
sourced energy total is compared against the 4/4/9 Atwater estimate of the same
macros, and where they diverge by more than **5 %** the divergence is recorded
on the recipe version as a note. Neither figure is adjusted to match the other:
the sourced value stands, and the discrepancy is disclosed. Correcting one
toward the other would fabricate a number no source produced.

## 5.2 The rounding contract

**Status: product policy**, constrained by the shipped diary's existing
arithmetic — see the end of this section.

**State this one exactly, because the client and the server must agree to the
integer.** There is **exactly one rounding step** in the whole path.

| Step | Operation | Precision |
| --- | --- | --- |
| 1 | per-serving × `portion_multiplier` | **full precision — nothing is rounded** |
| 2 | the per-serving diary snapshot | **the single rounding**: each of the four values rounded exactly once |
| 3 | consumed total, and the live "this adds" figure | `round(snapshot × eatenServings)` per value, from the **rounded** snapshot |

Recipe detail and the plan cards round for **display** only, through a separate
display helper that never reaches storage.

**Why the order is the contract.** The client cannot see full-precision planned
values — it holds the stored snapshot. A server that rounded only after
multiplying by the servings eaten would disagree with the client's "this adds"
card by a calorie or two on every fractional serving, and the numbers on screen
would not add up. Rounding once, at the snapshot, makes the agreement
**structural instead of coincidental**. Never round the same number twice, and
never re-round a snapshot.

**This mirrors the shipped diary, which is why the two agree.** The diary has
been shipping for two versions and its arithmetic is the reference:
`nutrition.service.ts` rounds each per-serving value once as it writes an entry,
multiplies that stored value by the servings eaten and rounds the product once,
and its daily and history aggregates do the same in SQL as
`SUM(FLOOR((x * servings)::numeric + 0.5))::int`. Step 3 above is that same
arithmetic applied to the same snapshot, so the server's totals, the SQL
aggregates and the client's card agree by construction.

**Why `FLOOR(… ::numeric + 0.5)` and not `ROUND`.** This paragraph used to name
`SUM(ROUND(x * servings))::int`, and that claim was not true — which is the
whole of the defect it now records. PostgreSQL's `round(double precision)` is
**half-to-even**, while JavaScript's `Math.round` is **half-up**, so the daily
read (which rounds in JS) and the history read and meal breakdown (which round
in SQL) disagreed by 1 on every value landing exactly on `.5`. Measured: one
entry at `servings = 0.5` over the snapshot `145/145/153/57` gave the day read
`73/73/77/29` and both SQL readers `72/72/76/28`, and `DayBreakdownCard` prints
those numbers verbatim, so Macros History showed a different figure than the
Diary for the same day.

Casting to `numeric` alone does **not** fix it. `round(numeric)` is half-up for
positive values but rounds half **away from zero** for negative ones, where
`Math.round` rounds half **towards positive infinity**: `-0.5`, `-1.5` and
`-2.5` become `-1`, `-2`, `-3` under `round(::numeric)` and `0`, `-1`, `-2`
under `Math.round`. Negative macros are storable — the legacy entry parser
requires only that each value be finite — so that difference is reachable.
`FLOOR(x::numeric + 0.5)` is `Math.round`'s definition rather than an
approximation of it, and it agreed with `Math.round` on every probed value,
positive, negative and half-integer alike. The form is therefore the contract:
all ten aggregate sites in `nutrition.service.ts` — four in `getMealBreakdowns`,
four in `getHistory`'s page query and the `HAVING` clause of both the page query
and its count subquery — use it, and none may go back to bare `ROUND`.

The user-visible guarantee this buys: **"1 serving" in the diary equals the
planned portion exactly.**

## 5.3 Badges

Five closed codes. **Status: product policy.** Badges are derived from the
ingredient set and the derived nutrition — **never** accepted from a recipe
file's declared list.

| Badge | Derivation | Safe default |
| --- | --- | --- |
| `high_protein` | protein supplies ≥ 30 % of the energy | omitted when energy is 0 — there is no share of nothing |
| `gluten_free` | **every** ingredient reviewed **and** every ingredient carries the reviewed `gluten_free` tag **and** no gluten-bearing allergen tag anywhere | omitted |
| `dairy_free` | **every** ingredient reviewed **and** no `milk` tag anywhere | omitted |
| `vegan` | the `vegan` tag on **every** ingredient | omitted |
| `quick` | `total_minutes ≤ 15` | — |

**The two conservative ones are conservative on purpose.** `gluten_free` and
`dairy_free` are claims a user with coeliac disease or a milk allergy acts on, so
an unreviewed ingredient **omits** the badge rather than being assumed benign.
An uncertified oat needs no special case: the reviewer withholds the
`gluten_free` tag, the intersection over all ingredients loses it, and the badge
drops. Certified oats carry the tag and keep it. A food asserting `gluten_free`
while also carrying a gluten-bearing allergen tag has contradictory metadata, and
the badge is **withheld** rather than resolved in the claim's favour.

`quick` is the one badge an ingredient's metadata cannot block — it is a fact
about the clock, not a composition claim.

**The seed rejects a file that declares a badge the derivation does not
produce.** Declaration is only ever checked against derivation; it can never
substitute for it. Badges are emitted in a stable declaration order, because the
column is a string array and a reshuffled array is a spurious diff and, at seed
time, a spurious new recipe version (§5.5).

Recipe detail carries this caption whenever any badge is shown:

> Based on ingredients only, not a cross-contact guarantee.

**Status: inference.** No frame specified it. It is included because every badge
above is derived from *composition*, and composition says nothing about a shared
fryer or a shared production line — so the badge would otherwise imply a safety
assurance the derivation cannot support.

<!-- END POLICY GATE: recipe-rules -->

## 5.4 Seed-time eligibility

`scripts/recipes-seed.ts` refuses to publish anything that fails any of these.

- **Ingredients are referenced by the catalogue food's stable key, never by a
  database id.** This is what makes the same recipe files seed identically into
  any database; an id-based reference would only be valid in the database it was
  authored against.
- Every ingredient must resolve to a **published, source-backed,
  allergen-reviewed** catalogue food **with a gram weight.**
- **Every nutritive ingredient must be listed** — cooking oils, butter,
  dressings, sugar and marinades included. The seed additionally **fails a file
  whose instructions name an ingredient-vocabulary term absent from its
  ingredient list**, which is the check that catches the common authoring error:
  a recipe that says "sear in olive oil" without listing the oil understates its
  own fat and calories, and every plan built on it inherits the understatement.
- Declared diet and allergen tags must **equal** the derivation from the full
  ingredient set (§3.1).
- `iconKey` and every badge code must be members of their closed sets.

**The failure mode is loud.** The seed fails naming the offending recipe and the
offending ingredient, and **nothing is published** — not the valid files
alongside it. A partial seed would leave a catalogue whose coverage report
describes a set that was never loaded.

## 5.5 Versioning

Seeding is **idempotent by slug**. An unchanged file is a no-op.

A changed file, **or a stale ingredient snapshot** — stale in either the
nutrition version **or** the metadata version — publishes a **new** recipe
version, promotes it to the recipe's single `current` version, and retires the
previous one, **all in one transaction.**

Two invariants hold throughout:

- **An existing version is never edited.** This is what §5.1's frozen snapshots
  are for.
- **Retired versions stay readable** for the plans and diary entries that
  reference them. A retired version is never planned again (§3.1) and never
  deleted, so a user's history keeps rendering exactly what they were served.

Tracking the metadata version alongside the nutrition version matters because a
change to an ingredient's allergen or diet tags changes a recipe's *safety*
metadata without changing a single number — and a recipe whose allergen
derivation is out of date is the more dangerous of the two staleness cases.

<!-- BEGIN POLICY GATE: recipe-coverage-matrix -->

## 5.6 The coverage matrix, and its boundary

Figures below are read from
[`data/meal-planning/recipes/coverage-report.json`](../../data/meal-planning/recipes/coverage-report.json),
generated from the seeded set. That report is the authority; nothing here is
restated from anywhere else.

**Status: measured, read from that report** for every count below —
the two promise thresholds (4 and 2) are **product policy**, and the composition
floors are product policy read from the same report.

**Recipe count: 121**, against a required minimum of 40. 49 of them are
cross-listed across more than one slot.

Composition per slot, with the floors policy requires:

| Slot | Vegan | Further vegetarian | Further pescatarian | Further omnivore | Eligible | Authored to this slot |
| --- | --- | --- | --- | --- | --- | --- |
| Breakfast | 18 (floor 4) | 9 (floor 3) | 4 (floor 2) | 9 (floor 3) | 40 | 40 |
| Lunch | 25 (floor 4) | 8 (floor 3) | 9 (floor 2) | 13 (floor 3) | 55 | 6 |
| Dinner | 30 (floor 4) | 9 (floor 3) | 10 (floor 2) | 15 (floor 3) | 64 | 15 |
| Snack | 6 (floor 4) | 3 (floor 2) | 1 (no floor) | 1 (no floor) | 11 | 11 |

The four strata **partition** the recipes eligible for the slot with no allergen
excluded at the loosest time tier, and they sum to the eligible count. "Eligible"
exceeds "authored to this slot" for lunch and dinner because a cross-listed
recipe declares both slots and is eligible in each; the authored figure is the
auditable floor. A floor of "no floor" is not a floor of zero — policy states
none for that stratum at that slot.

The report tabulates 640 cells across 4 diets × 10 allergen values × 4 slots ×
4 cumulative time tiers. Three tiers of promise come out of it, and **keeping
them apart is the honest part of this document.** The cell counts are read from
the report; the two thresholds are **product policy** — 4 is the repetition
arithmetic of §3.2 and 2 is the coverage floor §3.7 reports against.

| Tier | Promise | Cells |
| --- | --- | --- |
| **Guaranteed** | **≥ 4** eligible recipes per slot — what the repetition rule of §3.2 needs to fill a seven-day week | **140** |
| **Reduced** | **≥ 2** eligible per main slot — asserted, and **explicitly not sufficient** to fill a week | **124** |
| **Everything else** | supported at runtime, **not guaranteed** | the remainder |

### Which profiles those cells are

An aggregate count says how many cells are promised and not *which*, so the two
promised sets are enumerated as the axis values they are built from. Each row
below is one cross product of `dimensions` in the report, the four rows are
pairwise disjoint, and the products are written out so a reviewer can re-add
them:

| Tier | Diet | Excluded allergen | Slot | Cooking-time tier (min) | Cells |
| --- | --- | --- | --- | --- | --- |
| **Guaranteed** | `none`, `vegetarian`, `vegan`, `pescatarian` | `none` | `breakfast`, `lunch`, `dinner`, `snack` | 45, 60 | 4 × 1 × 4 × 2 = **32** |
| **Guaranteed** | `none` | `milk`, `eggs`, `peanuts`, `tree_nuts`, `soy`, `wheat`, `fish`, `shellfish`, `sesame` | `breakfast`, `lunch`, `dinner` | 15, 30, 45, 60 | 1 × 9 × 3 × 4 = **108** |
| **Reduced** | `vegan`, `vegetarian` | `milk`, `eggs`, `peanuts`, `tree_nuts`, `soy`, `wheat`, `fish`, `shellfish`, `sesame` | `breakfast`, `lunch`, `dinner` | 45, 60 | 2 × 9 × 3 × 2 = **108** |
| **Reduced** | `none`, `vegetarian`, `vegan`, `pescatarian` | `none` | `breakfast`, `lunch`, `dinner`, `snack` | 30 | 4 × 1 × 4 × 1 = **16** |

32 + 108 = **140** guaranteed cells and 108 + 16 = **124** reduced cells, which
is the whole of both columns above.

In words, because that is how a reader will look for their own profile.
**Guaranteed** is every diet with **no** excluded allergen at a cooking-time
tier of **45 minutes or looser**, for **every** slot including snack; plus the
unrestricted `none` diet with **any single** excluded allergen at **any** time
tier, for every **main** slot. **Reduced** is vegan or vegetarian with any
single excluded allergen at 45 minutes or looser, plus any diet with no excluded
allergen at the **30-minute** tier — main slots only in the first case, and a
count of two rather than a week in both.

Two boundaries of the enumeration are worth naming, because they are the ones a
reader would otherwise assume the other way. **A tighter tier is not implied by
a looser one**: tiers are cumulative ceilings, so a cell promised at 45 minutes
says nothing about the same profile at 30 or 15, and the 15-minute tier is
guaranteed only for the `none` diet. **Snack is promised only where no allergen
is excluded** — the snack column of every single-allergen cell is in
"everything else", because the seeded snack set is the smallest of the four.

**A reduced cell is not a working week.** Two eligible recipes cannot fill seven
days at most twice each without falling on consecutive days. The reduced tier is
recorded because it is a meaningfully better position than nothing — a swap has
somewhere to go — not because a plan will build.

**Everything else** covers two or more excluded allergens, a narrow diet
combined with an allergen at the tightest time tier, and dislikes that remove a
recipe a guaranteed cell counted. For those profiles the planner evaluates the
user's **real** diet ∩ allergen ∩ dislike intersection (§3.7) and answers
`422 no_matching_meals` with a limiting constraint and an `editStep` naming what
to change — so such a user is told which preference is narrowing the week rather
than shown an empty plan.

**The conclusion, plainly: the coverage report is the documented boundary of what
the seed set promises. It is not a claim that every profile can be planned.**
Dislikes are not an axis of the table at all, because they are per-user and
remove recipes at request time; dislike-driven shortfalls surface only through
the planner's own coverage check.

<!-- END POLICY GATE: recipe-coverage-matrix -->

---

# 6. The grocery contract

Implemented by `src/services/grocery.logic.ts` and `src/utils/units.ts`, pinned
by their tests. **Quantities are measured**, and the design intent behind the
whole of §6.2 is that **container units are never generated** — the list never
invents "1 bottle", because nothing in the data says how large a bottle is.

<!-- BEGIN POLICY GATE: grocery-contract -->

## 6.1 The numeric contract

Planned grams per ingredient, per planned meal:

```text
planned grams = gram_weight ÷ yield_servings × portion_multiplier
```

Summed by **(catalogue food, food state)**. The state is part of the key, so
**raw, dry and cooked never merge** — a kitchen buys them as different things and
their masses are not interchangeable. Totals are stored at two decimal places.

| Rule | Value | Status |
| --- | --- | --- |
| Equality epsilon | 0.5 g | Product policy |

**Two quantities are equal when they differ by less than half a gram.** The
boundary is the decision, and its purpose is trust in flags: re-aggregating the
week after a swap of an *unrelated* meal can shift a total by a floating-point
hair, and flagging a checked item over that would teach the user to ignore
flags. Half a gram is below the resolution of anything a shopper buys, so
sub-epsilon drift is **neither an increase nor a decrease** (§6.4).

## 6.2 The display contract

**The unit family is chosen once per row, at plan generation**, from the food's
default portion — and read from the row's own stored unit on every update
thereafter.

That is the invariant that makes comparison meaningful. A later update may move
within a family (ounces to pounds) but **never across families** (mass to
count), so every "now X, was Y" comparison is between two amounts in the same
family. Every recognised unit token belongs to exactly **one** family, and an
unrecognised token resolves to nothing rather than a guess — guessing `count`
for an unrecognised token is precisely how a mass quantity would merge into a
count.

**A count-family token is not on its own enough to count a row.** `each` is the
generic token the catalogue gives every non-metric portion, so a portion
describing a *container* ("1 can, drained", "container (6 oz)", "regular
microwave bag"), a *serving reference* ("serving 1/2 cup", "RACC", "1 item",
"kids meal order", "Swanson Salisbury Steak Dinner (11 oz)", "KFC Bowl") or a
*dose* ("scoop", "recipe yield", "small/individual") arrives in the count
family and would otherwise have its own free text printed as the shopping unit.
Those portions are **measured instead** — volume when the food can state a
density, grams otherwise — which is where §6's "container units are never
generated" is actually enforced, rather than merely intended.

The disqualifying forms are **two closed lists** in `grocery.logic.ts`, both
read by `describesContainerOrServing`: `CONTAINER_PORTION_WORDS`, the words, and
`CONTAINER_PORTION_PHRASES`, the contiguous whole-word runs. The scan covers
**every word of the description**, not its head noun, because the catalogue
routinely puts the disqualifying word somewhere else in the text — before the
noun, inside a parenthesis, or in the word the description *excludes*
("package without flavor packet"). An ambiguous description errs toward a
measure: "227 g" is a plainer line than "1 tub", and it is the amount that was
actually measured.

**The boundary between the two lists and the rest of the catalogue is drawn
deliberately, and it is this.** 776 of the 3,454 count-family default portions
in the committed release match; the other 2,678 keep counting:

- **A vessel, a tabulation unit or a dose is measured.** Cans, jars,
  containers, packages, packets, bags, pouches, envelopes and serving bowls;
  servings, `RACC`, `NLEA serving`, portions, orders, meals and packaged
  dinners, items and units; scoops, single-serve "individual" references and a
  "recipe yield". None of them says how much food it holds.
- **A bare size or grade label with no item noun keeps counting** — "regular"
  (104 rows), "miniature" (75), "miniature/bite size" (67), "slice, any size"
  (29), "cubic inch" (14), "whole" (13), "bite size" (2). Every one of those
  shapes is shipped by at least one row of the committed release, which is the
  point: the boundary is drawn against descriptions the catalogue actually
  wrote, not against invented ones. These are terse labels the catalogue wrote
  on a countable item, not containers and not serving references, so counting
  them prints the thing the shopper buys a number of. Measuring them would be a
  different decision from the one this rule makes, and it would move hundreds of
  truthful count lines onto the scales.
- **A description whose head noun is a real item keeps counting** — slice,
  piece, sandwich, fillet, patty, chop, rib, steak, link, egg, clove, apple,
  cookie, cracker, waffle, muffin, roll, bar, cone, cube, wedge, pod, ear,
  leaf, fruit, berry, cake, pie, pizza, taco, tortilla, pita, pickle, ball,
  tablet and the rest of the release's item vocabulary.
- **`yield` and `refuse` are words in neither list**, because 52 counting rows
  are real items USDA happens to describe through their yield ("rib (yield
  after cooking, bone removed)", "steak (yield from 181 g raw meat)", "pod,
  yields"). The one yield form that is not an item, "recipe yield", is matched
  as a **phrase** instead — which is the whole reason the phrase list exists.

`grocery.logic.test.ts` pins this boundary as a corpus: one case per form family
the release actually ships, on both sides, each quoted verbatim with its row
count, plus a sweep that re-derives the 3,454 / 776 / 2,678 split from
`data/meal-planning/catalog/releases/v1/portions.jsonl`. Adding a word carelessly
and leaving a form family out both fail it.

The family is still decided **once, at generation** — a row already stored keeps
the family its own `display_unit` records, exactly as this section's invariant
requires.

**Within a family, the largest unit that keeps the value ≥ 1 is used:**

| Family | Tiers, largest first | Promotes at | Status |
| --- | --- | --- | --- |
| Mass | lb → oz → g | 16 oz → lb; 28.35 g → oz | Product policy |
| Volume | cup → tbsp → ml | 16 tbsp → cup; 14.79 ml → tbsp | Product policy |
| Count | counts stay counts | — | Product policy |

Unit selection and rounding interact, and the boundary is handled explicitly:
15.96 oz rounds to 16.0 oz and 15.9 tbsp rounds to 16 tbsp, and both have
thereby *reached* the next unit — so the value is promoted once and re-rounded.
"16.0 oz" and "16 tbsp" are impossible outputs. One promotion always suffices,
because the promoted value is at most 1 of the larger unit.

| Unit | Precision | Status |
| --- | --- | --- |
| lb, oz | one decimal | Product policy |
| cup, tbsp | nearest quarter, rendered with the glyphs ¼ ½ ¾ | Product policy |
| g, ml | whole numbers | Product policy |
| counts | whole numbers | Product policy |

A quarter renders adjacent to its whole number with no space ("1¼"), and a bare
fraction renders alone ("¾").

**Counts are pluralised, and two of the rules there are about words rather than
numbers**, because a portion description is data the catalogue wrote rather than
a label this code chose:

- **The cardinality is the structured `catalog_food_portions.amount`, and the
  description is only a label.** "5 sprigs" is one portion *of five sprigs*, and
  the five comes from the column rather than from the text: 139 of the shipped
  default count portions state an amount other than 1 and 138 of those disagree
  with the number their description happens to begin with (`{amount: 3,
  description: 'cookies'}` is three cookies per 44 g, whatever the text says).
  Items are therefore `grams ÷ gram_weight × amount`. The label drops a leading
  amount it repeats, so a row reads "9 cookies" and "6 eggs, large" rather than
  "9 5 sprigs" or "6 1 egg, larges". An `amount` that is not a positive finite
  number behaves as 1 — validation should have quarantined such a food long
  before it reached a list, and counting portions is the reading that still puts
  a truthful line in front of the shopper.
- **The item is the head noun.** "egg, large" pluralises to "eggs, large" — the
  qualifier after the comma is not the thing being counted. Inflecting the last
  word instead would produce "larges".

Irregular plurals are a closed exception list — `egg`, `tomato`, `potato`,
`leaf`, `loaf`, `half`, `cookie`, `pierogi`, `goldfish` — **closed against the
catalogue rather than against English**, and read in both directions from the
one table so the pair cannot drift. The last three are the ones the general
rules got wrong in the singular or invariant direction: the `-ies` rule turns
"cookies" into "cooky" and "pierogies" into "pierogy" unless the table says
otherwise, and the `-sh` rule turns "goldfish" into "goldfishes". Of the head
nouns the shipped count portions use, those are the ones
the general rules inflect incorrectly; every other `-o` noun in that set takes a
plain `s` (avocados, burritos, tacos), which is why there is deliberately no
`-o` rule. A description already written in the plural must not be inflected a
second time into "sprigses", which is what distinguishes a singular `-s` ending
("glass", "hummus", "iris") from a plural one.

Only "cup" carries a plural form; g, ml, oz, lb and tbsp are invariant
abbreviations.

**The food state is shown as a name suffix** whenever it is not `raw`, or
whenever two states of one food coexist on the list — "Rice, dry" beside "Rice,
cooked". `raw` alone earns no suffix, because it is the unmarked case, and
`as_purchased` earns one like every other non-`raw` state ("Olive oil, as
purchased").

**The only exception is literal duplication.** A name whose own qualifiers — the
text after its first comma — already contain the state's words as a contiguous
run of whole words keeps its name: "Brown rice, cooked" and "Peas, cooked in
water" already say `cooked`. Nothing else suppresses the suffix, and in
particular a preparation word the catalogue happened to choose is **not** read
as a way of saying the state: "Black beans, canned" on a `cooked` row becomes
"Black beans, canned, cooked", which keeps the catalogue's qualifier *and*
states the stored state. Reading "canned" as "cooked", or "sliced" as
"prepared", is a substitution that hides the state behind a synonym, and the
qualifiers-only scan is what keeps a food whose noun resembles a state ("Dry-aged
beef" on a `dry` row) from losing its suffix.

**Coexistence qualifies every row that does not already say its own state, and
de-duplication still applies to the one that does.** That is what keeps two rows
of one base name from ever rendering the same string — the shopper would read
one line and buy half of what the week needs — while still stating each row's
state exactly once. A "Peas, cooked" food on the list in both `cooked` and `raw`
therefore reads "Peas, cooked" and "Peas, cooked, raw": two distinct lines,
neither of them "Peas, cooked, cooked".

**Coexistence has one exception of its own: a name that literally states *both*
states.** It is a collision guard rather than a style choice: "Beans, cooked and dry"
says `cooked` and `dry`, so de-duplicating both rows would render one identical
string twice — the collapse the coexistence rule exists to prevent. Both are
suffixed instead ("Beans, cooked and dry, cooked" and "Beans, cooked and dry,
dry"), and the repeated word is the price of two distinguishable lines. At most
one row of a coexisting name can ever de-duplicate, because two rows of one base
name share their qualifiers: if each stated its own state, those shared
qualifiers would state both, and the guard would fire for both.

<!-- END POLICY GATE: grocery-contract -->

## 6.3 Aisle categories

Five codes, in the order the list renders them:

| Order | `category` | Catalogue categories mapped | Status |
| --- | --- | --- | --- |
| 1 | `produce` | the produce categories | Product policy |
| 2 | `protein` | the protein categories | Product policy |
| 3 | `dairy_alternatives` | dairy and dairy alternatives | Product policy |
| 4 | `grains_bread` | grains, bread and bakery | Product policy |
| 5 | `pantry_other` | **everything else** | Product policy |

**`pantry_other` closes the list**, and that is a rule a test pins rather than
the order someone happened to write a literal in. It is the catch-all by design,
so a new catalogue category always has somewhere to go and never silently
disappears from a shopping list.

## 6.4 The diff, verdict by verdict

**Status: product policy** for every verdict in the table below.

When the week changes — a swap or a regeneration — the stored list is reconciled
row by row.

| Verdict | Quantity | Check | Flag | Text |
| --- | --- | --- | --- | --- |
| **Unchanged** (within epsilon) | left alone | kept | untouched | left alone |
| **Increased, checked** | updated | **kept** | **raised** | updated |
| **Increased, display text unchanged** | updated | kept | **not raised** | unchanged |
| **Increased, unchecked** | updated | unchecked | none | updated |
| **Decreased** | updated | **kept** | **cleared** | updated |
| **New** | inserted | **unchecked** | none | rendered |
| **Removed** | deleted | — | — | — |

Six of these carry a decision worth naming.

**Unchanged leaves the stored text alone, not merely the check.** Noise must not
rewrite a line the shopper is currently reading.

**An increase on a checked row keeps the check.** Nothing may disappear from the
list — the shopper has already bought it — so the row is flagged instead of
being silently reopened.

**An increase whose rendered text does not move raises no flag.** The boundary is
*visibility*: an increase that leaves "2.9 lb" reading "2.9 lb" has nothing for
the user to see, and a flag they cannot verify against the row is noise. A flag
that already stands **survives** such an increase, though — retracting a warning
the user is looking at, over a change they cannot see, would be the same noise in
reverse.

**A decrease raises no flag and clears any standing one.** The amount the shopper
was warned about has gone away, so the warning goes with it — even when the new
amount is still above what they acknowledged. **A decrease never reopens or
removes an item.**

**A new row arrives unchecked**, never inheriting a check from anything.

**A removal is deleted and counted**, checked or not, so the change summary can
report it.

**The acknowledged baseline** is what every "was Y" is measured against: the
amount at the moment the user checked the item, or last cleared its flag.

Its purpose in one sentence: **repeated swaps keep comparing against what the
user actually saw, so "was Y" never drifts to an intermediate amount they were
never shown.** A decrease keeps the baseline for exactly this reason — the next
increase is still measured from the amount they saw, not from the dip in
between.

Two interactions complete the lifecycle: **toggling a row clears its flag and
resets the acknowledged baseline** (interacting with a row acknowledges whatever
it now says), and **unchecking all clears every check and every flag.**

One deliberate omission: **a check state is never part of a recomputation's
update.** Re-deriving the week is not a statement about what the user has
shopped for.

## 6.5 Banner codes

| Code | Condition | Status |
| --- | --- | --- |
| `updated_after_swap` | the last swap changed the list | Product policy |
| `amount_increased` | at least one flag stands | Product policy |

The copy **pluralises by flag count** — one flagged amount and several read
differently — because a banner that says "one amount went up" above three
flagged rows is wrong in the way a user notices immediately.

---

# 7. Planned-meal logging

Implemented by `src/services/plannedMealLog.logic.ts`, pinned by
`src/services/__tests__/plannedMealLog.logic.test.ts`.

**The diary bucket is resolved client-side** through the existing daily-macros
read — which self-heals the four buckets for any date — and sent as an existing
diary meal id. The server then verifies that **the meal belongs to the caller
and to that date**, and that the date lies within the plan's week. A foreign or
mismatched meal is a `404`, never a corrected guess.

**The per-serving snapshot is the planned-portion nutrition rounded to
integers** — step 2 of §5.2, the single rounding step — so **one serving in the
diary equals the planned portion exactly.**

<!-- BEGIN POLICY GATE: planned-meal-logging -->

**The eaten fraction comes from the stepper**, within 0.25 to 10 servings at two
decimal places.

| Rule | Value | Status |
| --- | --- | --- |
| Minimum servings eaten | 0.25 | Product policy |
| Maximum servings eaten | 10 | Product policy |
| Decimal places | 2 | Product policy |

**Two decimals is not a rounding preference — it is the representation the
shipped app already stores.** The existing fraction chips hold ⅓ as 0.33 and ⅔
as 0.66, and the displayed card, the request fingerprint and the server's
arithmetic must all use the identical number. "Improving" this to a third
decimal would desynchronise the client's card from the server's snapshot and
change every request fingerprint.

**The entry carries three independent facts and two links** (§2): the origin
(`input_method = 'meal_plan'`), the provenance (`source_backed`, a fact of the
domain rather than a column copied off a row — planning admits only
source-backed, allergen-reviewed recipes, so a planned meal cannot be an
estimate), and the plan-meal and recipe-version links that let the plan card
derive its own logged state and the diary derive its caption.

<!-- END POLICY GATE: planned-meal-logging -->

**Double taps and retries return the first result.** The mechanism is the shared
keyed-write sequence in [`api.md`](./api.md#idempotency-and-replay); the policy
is simply that logging the same intent twice logs one meal.

**Logged status is derived live from the non-deleted linked entries** — never
stored as a flag on the planned meal. Three consequences follow, and all three
are the point of deriving it:

1. **Deleting the diary entry clears the logged state.** No stale "logged" badge
   survives a deletion.
2. **Editing the servings changes only the consumed total** and keeps the link.
3. **Editing the name or a macro detaches the entry** — the plan links and the
   provenance are cleared and the entry becomes an ordinary user-entered row.
   The boundary is *what was edited*: a portion correction is still the planned
   meal, whereas edited numbers are no longer the numbers the plan produced, so
   neither the "From meal plan" caption nor a source-backed label may survive
   them (§2.5).

**A swap after logging never marks the replacement as eaten.** The outgoing
recipe is recorded on the meal as an audit value, while the
logged-then-swapped presentation is derived **from the entries themselves** — so
any number of successive swaps after a log is represented correctly, and the
diary snapshot of what was actually eaten is never rewritten.

---

# Where these rules are pinned

Every number in this document is a named constant or a named export, and each
has a test that fixes its boundary. This document is the prose companion to
those tests, not a substitute for them.

| Policy area | Implementation | Test |
| --- | --- | --- |
| §1 Targets | `src/services/targets.logic.ts` | `src/services/__tests__/targets.logic.test.ts` |
| §2 Classes and labelling | `src/services/recipe.logic.ts`, `plannedMealLog.logic.ts`, `nutrition.logic.ts` | the matching `*.logic.test.ts` files |
| §3 Plan generation | `src/services/mealPlan.logic.ts`, `src/utils/seededRandom.ts` | `src/services/__tests__/mealPlan.logic.test.ts` |
| §3.8 Flags | `src/services/preferences.logic.ts` | `src/services/__tests__/preferences.logic.test.ts` |
| §4 Swaps | `src/services/swap.logic.ts` | `src/services/__tests__/swap.logic.test.ts` |
| §5 Recipes | `src/services/recipe.logic.ts`, `scripts/recipes-seed.ts` | `src/services/__tests__/recipe.logic.test.ts` |
| §6 Grocery | `src/services/grocery.logic.ts`, `src/utils/units.ts` | `src/services/__tests__/grocery.logic.test.ts`, `src/utils/__tests__/units.test.ts` |
| §7 Logging | `src/services/plannedMealLog.logic.ts` | `src/services/__tests__/plannedMealLog.logic.test.ts` |

**Why every one of these is a pure module.** Each rule above is a decision
someone could get wrong in a way a unit test catches — a bound applied on the
wrong side, a sign inverted, a rounding step inserted, a family crossed. None of
them needs a database to evaluate, and that is deliberate: a rule that can only
be tested through I/O is in the wrong layer
(`backend-architecture` §1.2 and §11). It is also what lets this document
describe the tolerances, the seed derivation, the grocery epsilon and the
rounding contract without mentioning a query, a transaction or a request.

The orchestration around them — the transactions, the per-user lock, the keyed
writes and their replay — is the service layer's concern and is documented in
[`api.md`](./api.md) and [`release-and-recovery.md`](./release-and-recovery.md).

# Keeping this document true

Every number here must equal its implementation. When one changes, this document
changes in the same review — and for most of them the review is not the only
thing enforcing it.

**What is machine-compared.** `src/__tests__/setup/coverageInventory.test.ts`
(its `policy-document drift gate` block) reads this file off disk, parses the
regions delimited by `<!-- BEGIN POLICY GATE: <id> -->` and
`<!-- END POLICY GATE: <id> -->` comments, and compares every value in them with
the file that owns it. Three kinds of thing inside a marked region count as a
value, and all three are compared:

- **a number** — a bound, a threshold, a count, a factor, a share, a budget or a
  precision;
- **a closed code vocabulary** — the members the region enumerates, and their
  order where it states one, against the array or the union that declares them;
- **an algorithm parameter** — a field order, a separator, a digest reduction, a
  printed formula's operators and operands, a rounding mode. These are compared
  by *behaviour*: the gate reads the parameters out of this file, applies them to
  a fixed input set, and compares the result with what the exported function
  returns for the same input. Nothing restates the algorithm in the test, so a
  change on either side moves exactly one of the two numbers it prints.

| Gated block | What is compared | Source of truth |
| --- | --- | --- |
| `status-at-this-commit` | the authored recipe count, and the corpus floor the table measures it against | `data/meal-planning/recipes/coverage-report.json`, `src/__tests__/api/seed-rerun.test.ts` (the floor) |
| `nutrition-targets` (§1.2–§1.8) | the four activity factors; the daily adjustment per pound-per-week and every goal-and-pace row including its on-screen copy; the adult input envelope, against *both* logic modules that declare it, and the code vocabularies its input table admits — the sexes, the goals, the paces and how many activity levels it defers to; the three display conversions; the two floors and the ceiling; the `clampReason` at **every** bound it tabulates, and at each of the three the prose names, driven there by `applyTargetBounds`; the unavailability code the resolver returns for a paceless loss or gain row, for an out-of-envelope row, and the status a write-time refusal carries; the macro shares and Atwater divisors, including the divisors inside the mismatch condition; the manual ranges, the zero-macro field code, the three feasibility warnings and their thresholds; the highest basal rate the envelope allows; the macros a floor-clamped target must produce; and both worked derivations — the end-to-end example and the two envelope corners — recomputed by `targets.logic.ts` and compared figure for figure | `src/services/targets.logic.ts`, `src/services/preferences.logic.ts`, `src/types/mealPlanning.ts` (the vocabularies), `src/controllers/mealPlanning.controller.ts` (the write-time status) |
| `plan-generation` (§3) | the week length; §3.1's clause count, the version status, provenance and allergen status a plannable recipe must carry, the two estimate grades it refuses and the whole diet vocabulary its containment chain closes; the repetition rule and the arithmetic behind the coverage floor; the three scoring weights, in the printed formula **and** in the table, and the reuse cap; §3.4's seed reduction — its five inputs, their order, the separator, the hash and the digest slice — and the candidate identity triple, both recomputed and compared against `derivePlanSeed` and `portableCandidateIdentity`; both schedules' cumulative shares and the per-slot intents they imply; the evaluation budgets and the wall-clock abort; both portion sets; the four day tolerances and the comparison slack; §3.7's whole constraint table — its keys, the order the analysis emits them in, its rank column and its unit vocabulary — the two coverage thresholds, the allergies-kept promise the error carries, and the keys its prose restates; §3.8's four incompatibility flags, in declaration order; the plan status §3.9 says does not exist; the cost-score and per-meal budget bands, against both modules that declare them; the currency; the cooking-time tiers; and every `<status> <code>` outcome it quotes | `src/services/mealPlan.logic.ts`, `mealPlan.service.ts` (the wall-clock abort), `recipe.logic.ts` (the eligibility vocabularies, the flags and the cost-score bands), `preferences.logic.ts` (the currency and the per-meal thresholds), `mealPlanning.errors.ts` (the allergies-kept promise), `src/types/{mealPlanning,nutrition}.ts` (the vocabularies), `src/controllers/mealPlanning.controller.ts` (the quoted statuses) |
| `swap-offer` (§4) | the share of the day a candidate is judged against; the bound on the alternatives offered, in each place it is stated | `src/services/swap.logic.ts` |
| `recipe-rules` (§5.1–§5.3) | §5.1's printed derivation — its basis amount, its operators and the per-serving division — recomputed and compared against `deriveRecipeNutrition`, the volume basis converted through a density, the unknown-fibre rule and the zero it refuses, the Atwater divisors, and the sourced-versus-Atwater divergence; §5.2's single rounding step, the values it covers, the full precision before it, the consumed-total arithmetic it prints and the SQL aggregate it cites; §5.3's five badge codes in declaration order with its own count of them, the badges its prose names, the reviewed tag the gluten-free badge reads and the allergen tag the dairy-free badge is withheld by; the high-protein energy share; the quick-badge ceiling | `src/services/recipe.logic.ts`, `src/types/recipe.ts` (the badge set), `catalog.logic.ts` (the basis amount), `plannedMealLog.logic.ts` (the consumed total), `targets.logic.ts` (the Atwater divisors), `preferences.logic.ts` (the allergen tags), `nutrition.service.ts` (the SQL aggregate) |
| `recipe-coverage-matrix` (§5.6) | the recipe count, against the report *and* the files on disk, and the corpus floor it is measured against; the cross-listed count; the per-slot composition with its floors, and that the four strata sum to the eligible count; the matrix dimensioning; both promise thresholds and both cell counts; the enumerated guaranteed and reduced **profile definitions**, expanded and compared with the report's own promised cells; the tier boundaries, slots and diets the same promises are restated with **in words**; the two boundary sentences, read out of this file rather than quoted in the test; and the outcome it quotes for a profile it does not promise | `data/meal-planning/recipes/coverage-report.json`, `src/__tests__/api/seed-rerun.test.ts` (the floor), `src/services/preferences.logic.ts` (the named allergens), `src/controllers/mealPlanning.controller.ts` (the quoted status) |
| `grocery-contract` (§6.1–§6.2) | §6.1's printed formula, recomputed and compared against `plannedIngredientGrams`, the decimals a stored total carries and the equality epsilon; §6.2's three display families, each family's tiers with their order and the unit one of each renders in, the mass and volume promotion thresholds, every precision it tabulates rendered through `units.ts`, the quarter glyphs and both rendered examples, the closed irregular-plural list with the plain-`s` nouns it contrasts, the head-noun rule, the already-plural case, the singular-`-s` endings, the portion that states its own amount, and the unmarked food state | `src/services/grocery.logic.ts`, `src/utils/units.ts` |
| `planned-meal-logging` (§7) | the eaten-servings envelope and its precision, the input method and the provenance | `src/services/plannedMealLog.logic.ts` |

The gate runs **both ways**: every marker in this file must be claimed by that
test and every block it expects must be present, and each table's row count is
compared as well — so a deleted row, a dropped marker or a renamed one fails
rather than quietly shrinking what is checked. Every failure prints both sides
labelled by the file they came from.

**What is prose rather than gated**, recorded so the claim above is exactly
true. Only two things qualify: text that sits **outside** every marker, and text
inside one that states **no duplicated value** by the definition above. Nothing
else is exempt — a value inside a marked region is compared or it is moved out,
and moving it out is not available to a value that is duplicated.

Outside every marker, and gated nowhere here:

- §1.1's cited equation, whose coefficients are reproduced from the paper rather
  than from a source file. A change to the *implementation's* coefficients turns
  §1.7's worked example red, so the arithmetic is still pinned; the equation's
  own text is a citation.
- §2's nutrition-provenance, calculation-method and meal-origin vocabularies,
  §6.3's aisle categories, §6.4's per-row verdicts and §6.5's banner codes. All
  four sections lie between marked regions, not inside them; `src/types/` spells
  those vocabularies and the matching `*.logic.test.ts` files pin them.

Inside a marked region, and not a duplicated value:

- **The names of things.** A column (`total_minutes`, `budget_tier`), a field
  (`editStep`, `ok`), a type (`HeightUnitPref`, `WeightUnitPref`), a JSON key
  (`dimensions`), a function, a path (`data/meal-planning/reports/latest/`) or a
  file (`benchmark-report.json`) names a thing; it carries no value. So do the
  formulas written entirely in those names — `min(ceiling, max(adjusted, sex
  floor, BMR))`, `max(0, recipeTier − userTier)`, `costScore`, `perMeal`,
  `total_minutes` — whose numeric members are gated wherever they appear, and
  whose behaviour the probes above exercise.
- **Statements about order rather than value**, where the order has no operands
  to compare: §3.4's `(score, shuffleRank)` tie-break and §5.3's stable
  emission order. §3.4's seed reduction and candidate triple are *not* in this
  class and are compared behaviourally; §5.2's rounding order is not either,
  and its step table, its value count and its arithmetic are compared.
- **Cited external figures**, labelled as such where they appear: §1.3's FAO
  report, §1.4's ≈ 3,500 kcal equivalence with both citations, and the journal
  volumes and page numbers beside them.
- **Copy owned by the mobile app**: §1.3's on-screen activity anchors and §7's
  fraction chips. No backend file states them, so there is nothing here to
  compare them with; `mobile/` owns both.
- **Illustrative examples that name no contract value**: §5.6's nouns for its
  own strata, §6.2's `-o` argument, and the varieties behind a food group — the
  group itself is compared against the taxonomy, in §3.1 as in §6.2.
- §1.8's `200`. Every error status this document quotes is compared against the
  controller mapping that answers it; the success status is Express's default and
  no source file states it.
- **Every sentence that argues for a rule** rather than stating a number.

| If you change… | Also update |
| --- | --- |
| A constant in any `*.logic.ts` above | the matching table in this document |
| A stable wire code | `src/types/{mealPlanning,recipe,nutrition,catalog}.ts`, this document, and [`api.md`](./api.md) |
| The seeded recipe set | regenerate `data/meal-planning/recipes/coverage-report.json` and re-read §5.6 from it |
| The activity-model sentence in §1.3 | the user-facing policy string and the settings helper text — all three must agree |
| A catalogue provenance column | [`catalog-policy.md`](./catalog-policy.md), which owns them |

Two standing prohibitions for this document:

- **Never assert an unverified result.** Measured outcomes — published
  catalogue counts, benchmark hit rates, latencies — belong to the run report
  that produced them and are never restated here.
- **Never include a secret, a connection string, a real host or a key.** Nothing
  here needs one.
