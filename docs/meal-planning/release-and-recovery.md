# Meal planning — release and recovery

The operator procedure for putting the meal-planning schema and API into an
environment, verifying it, switching it on, and getting back out again. The API
ships **before** the app: every new response field is additive and every new
route is gated, so an older client is unaffected, while a newer client against
an older API is not.

## What this work delivers — and what it does not

The deliverable is **two pull requests, one per repository** — one here, one in
the app repository — opened from feature branches against each repository's
default branch and cross-linked in their descriptions. Each carries the complete
implementation and its real validation results: command output, the coverage
summary, the catalog and benchmark reports, and the physical-device checklist,
which is included **unrun** because this work had no macOS or Xcode environment.
Each links its own repository's meal-planning documentation entry point — this
folder's [`README.md`](./README.md) here, `docs/meal-planning.md` in the app
repository. Which parts of the feature are in this tree at this commit is a
separate question, and [the table below](#status-at-this-commit) is the answer to
it.

**The pull requests are not merged.**

Everything from [Release order](#release-order) onward is **later operator work
that has not been performed.** Merging either pull request, deploying to the VPS
and submitting an app-store release are outside the scope of this work and were
not done — see [Forbidden operations](#forbidden-operations). Read the rest of
this document as the procedure an operator follows, never as a record of a
release that happened.

## Status at this commit

This document is the release runbook for the whole feature, and parts of the
feature arrive across several commits on this branch. Every step below is
therefore written as an instruction to an operator, never as a record of
something already done — and this table says which of the things those steps
name are in the tree yet, so nothing here reads as a claim about code that is
not present. It is the one place that tracks that; the removal script and its
folder README point here rather than repeating it.

| Referenced thing | State |
| --- | --- |
| `prisma/migrations/20260908000000_meal_planning` (the schema), `prisma/manual-migrations/meal-planning/*`, `docs/meal-planning/expected-schema-diff.sql`, `.github/workflows/ci.yml`, `src/utils/featureFlags.ts`, `MEAL_PLANNING_ENABLED` | present |
| `data/meal-planning/catalog/releases/v1/` — the reviewed release artefact, with a `manifest.json` carrying a SHA-256 and a row count for each of its five files (11,046 foods, 15,939 aliases, 31,899 portions, 0 components, 11,046 validation records) | present. This is the input a release loads, not loaded data: committing it puts no row in any database. |
| `npm run catalog:load` | present **and writing**. `catalog:load -- --release v1` finds and accepts the manifest above, verifies all five files against their declared SHA-256, byte length and row count before it writes anything, reconciles the release into `catalog_foods` and its aliases, portions, compositions and validation records — each food's four child sets replaced wholesale inside that food's own transaction — retires a published food the release no longer carries, re-compares the bytes it actually applied against the manifest, verifies the loaded counts against it, and only then records the run that makes it the active release. A rerun of a release already loaded reports 0 inserts and 0 updates. `--dry-run` reports the same reconciliation — the foods it would insert, update, retire and leave unchanged, and the alias, portion, composition and validation-record rows it would write and remove — and writes nothing at all, not even a run row. |
| `npm run recipes:seed` | present **and writing**. Publishes the 42 committed recipe files as `recipe_versions` rows with their immutable ingredient snapshots against the catalog loaded in `DATABASE_URL`, is idempotent by slug (an unchanged recipe is a no-op; changed content or a stale ingredient snapshot publishes a new version, retires the previous one and moves `recipes.current_version_id` in one transaction), refuses the whole run — publishing nothing — if any file fails validation, and rewrites `data/meal-planning/recipes/coverage-report.json` from the seeded rows on a full run (`--dry-run` and `--only <slug>` both leave it alone). |
| `npm run search:benchmark` | present as a command, already checking its own inputs, but **it does not write to a database yet**: it ends by reporting `stage_pipeline_pending`, or `stage_prerequisites_unmet` for an input it cannot see, and exits non-zero without touching the database. The measurement body lands with this branch's catalog commits. |
| `GET /api/catalog/status` | `catalog.service.getStatus` is present; the `/api/catalog` route and controller land with this branch's API commits, so the endpoint is not yet reachable. |
| Firebase Remote Config `meal_planning_enabled`, the mobile store build | outside this repository |

Run a stage before depending on it, and re-read this table after pulling. Each
stage names its own unmet inputs on stderr and exits non-zero rather than
half-loading, so "did this environment's catalog actually load?" is answered by
running the command and by `GET /api/catalog/status` once it is reachable —
never by this table alone.

`npm test` is a real Jest run: `jest.config.ts`, `tsconfig.test.json` and the
suites under `src/**/__tests__/` are present. What it reports is the test
toolchain's own milestone, not a release blocker introduced here.

## Release order

Backend first, app second, feature flags last. Three of these steps are this
project's own operational policy rather than anything the platform imposes —
closing both gates before the code arrives (step 2), the verify-before-enable
gate (step 5), and the fail-closed client default (step 6). They are the steps
to keep if the rest of the procedure is ever adapted.

1. **Back up.** `pg_dump` the target database before anything else. Everything
   below is additive, but a backup is the only thing that makes every step after
   it reversible without thought.
2. **Switch the feature off before the code arrives.** Set
   `MEAL_PLANNING_ENABLED=false` (or leave it unset — it is on only for the
   exact string `true`) and confirm the Firebase Remote Config parameter
   `meal_planning_enabled` exists with value `false`. Both gates being closed
   before the deploy is what makes the deploy itself uneventful.
3. **Merge the backend pull request,** which deploys it: Coolify builds and
   deploys the image on push. That is the platform's own behaviour, not a step
   anyone runs by hand. The image's final command is
   `npx prisma migrate deploy && node dist/server.js`, so
   `20260908000000_meal_planning` is applied at boot: sixteen new tables, four
   nullable columns on `meal_entries`, and indexes and foreign keys over them.
   Nothing is dropped or rewritten, so existing users, diary history, custom
   foods, workouts, runs and weigh-ins are untouched. Confirm `GET /health`
   reports `status: ok` and the `GIT_SHA` you expect — that route is
   unauthenticated by design so health checks and post-deploy verification can
   reach it, and it pings the database before answering `ok`, which is why it is
   the probe here rather than any new endpoint. The copy under
   `prisma/manual-migrations/meal-planning/` is *not* executed — it is excluded
   from the image and run by no tooling; see
   [Migration ledger](#migration-ledger).
4. **Load the data.** From an operator checkout of the deployed commit, against
   the target `DATABASE_URL`:

   ```bash
   npm run catalog:load -- --release v1 --confirm-target <database-name>
   npm run recipes:seed
   npm run search:benchmark
   ```

   `catalog:load` applies the reviewed, checksummed catalog release committed in
   the repository — no live USDA or model calls. Regenerating a catalog from
   vendor output is never part of a release: a new version is produced on a
   development machine, reviewed as `data/meal-planning/catalog/releases/v<N+1>/`
   in a pull request, and loaded the same way. Both writers refuse a database
   they cannot classify as development unless `--confirm-target` names it.

   Repeating a catalog stage on that development machine is safe, and what it
   does depends on how the previous attempt ended. An interrupted stage resumes
   its own run from its stored cursor and spends what is left of that run's
   model-call budget. A stage that failed is retried on that same run, so its
   generation batches stay addressable and the calls the failed attempt already
   paid for are not handed back as fresh budget. A stage that already succeeded
   reports that it is complete and writes nothing at all — producing new
   candidates is not a rerun, it is a new `coveragePlanVersion`, which brings
   batch keys and a budget of its own. `catalog:load` is the deliberate
   exception to that last case: a release is a statement of desired state rather
   than a one-shot action, so loading one that already succeeded reconciles
   every food again under a run row of its own and reports 0 inserts and 0
   updates, leaving the settled run's evidence untouched. The catalog data
   itself stays idempotent throughout, because foods upsert on `source_key` and
   recipes on `slug`.

   Two refusals are worth recognising on sight, because both leave the active
   release exactly where it was. `release_file_digest_mismatch` (or its size and
   row-count siblings) means the artefact on disk is not the one the manifest
   describes, and it is raised before anything is written — reproduce or restore
   the release. `release_file_changed_during_load` means a release file changed
   while the load was running, which is what happens when a second operator
   regenerates it or a copy is still in flight: the load refuses rather than
   applying bytes nobody reviewed, records the run `failed`, and does not move
   the pointer. Re-run the load once the directory is settled. A load that ends
   any other way than `succeeded` is likewise repaired by re-running it: a food
   whose composition points at another food in the same release is written whole
   or not at all, and the run's cursor only ever names foods that finished, so a
   rerun re-reconciles from the last completed one and everything it re-reads is
   a no-op.
5. **Verify before switching on** — the gate the whole order exists to reach.
   `GET /api/catalog/status` must report the expected release with at least
   10,000 published foods and at least 40 recipes; the benchmark report must
   meet its thresholds; per-table row counts must match the release manifest.
   Only then set `MEAL_PLANNING_ENABLED=true` and restart, and confirm
   `GET /api/meal-planning/preferences` answers 200 instead of 503.
6. **Merge the app pull request only once the backend is live and switched on.**
   The ordering is not a preference: every contract change is additive and older
   clients decode the new responses unchanged, so a new API serves an old app
   safely while a new app against an old API does not. Then release the build,
   and flip Remote Config `meal_planning_enabled` to `true` once it is approved.

   Two things about that client release are worth stating plainly. There is no
   over-the-air path, so the app reaches users only through a store release. And
   the version and build bump in the app manifest, and the submission itself,
   are **not part of this work** — the manifest is left untouched, and both
   remain manual steps for whoever cuts the release. Neither was the app
   verified on a device here: this work had no macOS, Xcode or Android SDK, so
   there was no native iOS build, no simulator run and no visual comparison, and
   the Android build is unverified beyond a TypeScript check. The **unrun**
   physical-device checklist shipped with the app pull request is the list to
   work through before submitting.

   The rollout is deliberately **fail-closed** — a policy choice of this
   project, not a platform default. The client's packaged value for the flag is
   `false`, so a device shows the feature only after one successful fetch of the
   console value, with the server flag standing as a second, independent gate.

## Migration ledger

Two copies of this feature's DDL exist, and only one of them runs.

The **executed, authoritative ledger is the Prisma migration**,
`prisma/migrations/20260908000000_meal_planning/migration.sql`. The proof is the
image's final command — `npx prisma migrate deploy && node dist/server.js` — so
every deploy applies it at boot, and CI's `Apply the migration ledger` step
applies the same ledger before its schema gate and test suite. That is what
"this repository's deployment practice" means concretely, and it is why the
release order above has no schema step of its own.

The copy under `prisma/manual-migrations/meal-planning/` exists because the
feature request asked for additive SQL in that folder. It is the same DDL
written idempotently — `IF NOT EXISTS` on tables, columns and indexes, and a
guarded `DO $$` block per foreign key, since `ADD CONSTRAINT` has no
`IF NOT EXISTS` form — under a header stating that it is an operator reference
copy, that Docker and CI apply the Prisma migration automatically, and that
anyone applying it by hand must immediately follow it with:

```bash
npx prisma migrate resolve --applied 20260908000000_meal_planning
```

Without that, the copy has changed the schema without writing Prisma's
bookkeeping row, and the next `migrate deploy` would attempt the same DDL a
second time. The companion `001_meal_planning.down.sql` is reference-only, and
part of no deploy and no rollback.

Either order is consequently safe: running the copy after Prisma is a no-op
because every statement is guarded, and running Prisma after the copy is
prevented by the `resolve` step above. Neither folder introduces a second
migration system.

That equivalence is **proven, not asserted**. `describe('migration ledgers')` in
`src/__tests__/api/compat.test.ts` migrates two disposable databases — one
Prisma-then-copy, the other copy-then-`resolve`-then-`deploy` — each preloaded
with `data/meal-planning/fixtures/legacy-upgrade.fixture.json`, a representative
pre-feature dataset, and compares what it gets. Run it rather than taking this
paragraph's word for it; what it asserts is its own business, and
[`prisma/manual-migrations/meal-planning/README.md`](../../prisma/manual-migrations/meal-planning/README.md)
carries the by-hand procedure.

One operator note that is not about SQL: this repository ignores the generated
Prisma client and regenerates it, so `npx prisma generate` is a required step in
any checkout — the image runs it during the build — and no generated file
appears in either pull request.

## Kill switches

Two independent gates, both reversible without a deploy. Which routes each one
covers is settled in [`api.md`](./api.md#the-feature-gate) and is not repeated
here.

- **Remote Config `meal_planning_enabled=false`** — the app stops rendering the
  Diary / Meal Plan control and the Add Food catalog section and stops issuing
  gated requests. The nutrition-target query and mutation are the deliberate
  exemption: they keep running, because the target routes are ungated and
  Account, Progress and the Diary target editor all depend on them.

  Its reach is limited, and that limit is what orders the rollback below. The
  app fetches Remote Config once at launch and the SDK throttles fetches to one
  per fifteen minutes — its behaviour, not ours — and there is no foreground
  refresh, nor was one added. A console change therefore reaches a device on its
  **next cold start**, and a device kept in the foreground keeps its last
  activated value until then. There is **no bounded propagation window** for
  this switch.
- **`MEAL_PLANNING_ENABLED=false` on the server** — `/api/meal-planning/*` and
  `/api/recipes/*` answer `503 feature_disabled` immediately, which a client
  that has not yet picked up the Remote Config change renders as its unavailable
  card. `/api/catalog/*` and `/api/meal-planning/targets*` are never gated, so
  Account, Diary and Progress keep reading and writing nutrition targets while
  planning is off. This takes effect on the next request rather than the next
  launch, so it is the switch that actually stops a device already in the
  foreground.

`MEAL_PLANNING_FAULT` is a development and test switch only. It is forced to
`off` whenever `NODE_ENV=production`, and an unrecognised value fails startup
everywhere else, so it can neither be used in production nor silently ignored.

## Replaying a lost response

Generate, regenerate, swap and log each carry an idempotency key. A client whose
response never arrived retries with the same key, and the `meal_plan_actions`
ledger answers that retry from the row it already wrote rather than doing the
work a second time: the same status, the same plan revision and the same body the
first response carried, for as long as the row exists. To produce that case
deliberately, set `MEAL_PLANNING_FAULT=log` in a development or test environment
and log a planned meal — the write commits and the response is dropped at the
socket — then repeat the request with the same key and the same body. The
`generation` and `swap` values are decoded failures instead: they persist
nothing, so there is no ledger row and nothing to replay.

Expect the two bodies to be **identical byte for byte**, which is what §0.9.2
asks for read literally. `response_snapshot` is a `jsonb` column and PostgreSQL
does keep a stored object's keys in its own order — by UTF-8 byte length, then
by bytes — so the ledger stores the body in exactly that order before the column
can impose it (`canonicalizeResponseBody` in
`src/services/mealPlanningAction.logic.ts`). The first response is served from
that same canonically ordered value, so the column has nothing left to reorder
and the two texts agree. Compare them directly — `cmp first.json replay.json`,
or `diff` on the raw text — and read any difference as a **regression to
investigate**, not as an artefact of the column; `diff <(jq -S . first.json)
<(jq -S . replay.json)` remains a useful second check that isolates a value
difference from an ordering one. The column can be read the same way:
`SELECT jsonb_object_keys(response_snapshot) FROM meal_plan_actions WHERE
idempotency_key = '<key>'` returns the keys in the order the response carried
them. Confirm the other half against the database: exactly one row for that key
(`SELECT count(*) FROM meal_plan_actions WHERE user_id = '<uuid>' AND
idempotency_key = '<key>'` returns 1) with `response_status` and
`plan_revision_after` both filled. A repeated key with a *different* body is not
a replay — it answers `409 idempotency_conflict` and writes nothing.

Both checks need the `/api/meal-planning/*` routes, which land with this
branch's API commits — the same commits the status table above tracks for
`/api/catalog`. The ledger service itself is in the tree; the HTTP surface in
front of it is not, so run this check once those routes are reachable rather
than assuming it passes.

## Rollback

The migration is additive, so redeploying the previous backend commit leaves
every row intact and older clients keep working. Order matters, because a rolled
back backend has neither the new routes nor the server flag:

1. Publish Remote Config `meal_planning_enabled=false` first.
2. Redeploy the previous backend commit.
3. Watch the API logs until `/api/meal-planning/*` and `/api/catalog/*` requests
   stop arriving. Step 1 cannot be assumed to have reached every device by then
   — that is what "no bounded propagation window" above means — which is exactly
   why this step exists and why it comes last.

Stragglers are the case worth understanding, because it is the one that could
look like a crash and is not. A rolled-back backend has neither the new routes
nor the server flag, so those requests get a bare `404` — including
`/api/meal-planning/targets*`, which that backend simply does not have, flag or
no flag. The client reads it deliberately: a `404` carrying **no decodable error
code**, from one of the three reads that name no resource — preferences, the
current plan, and targets — is treated exactly as `503 feature_disabled` is, so
the Meal Plan segment shows its unavailable card. The targets read resolves to
"no server targets" **without clearing anything**, so Account, Progress and the
Diary summary card fall back to the device's local value and the legacy target
editor, precisely as they behave for a user who never opted in. The values those
surfaces show are the last local ones, **never a blank**, and no user sees a
crash.

What carries that meaning is **which route answered, not the status code.** A
`404` from a *resource* route — a plan, a day, a recipe, a diary entry — is the
ordinary "not found, or not yours" answer this API gives by design, since it
never confirms that someone else's row exists; it must never be read as the
feature being unavailable. Only the three resource-less reads above mean that.

Forward recovery is the release order above from the merge in step 3, with the
flag still `false` until step 5 passes. Data repair needs nothing else:
`catalog:load` verifies every checksum before it writes anything and a run that
does not reach `succeeded` never moves the active release pointer, so a failed
or partial load is repaired by re-running it.

Removing the schema is not part of rollback and should not be done to recover
from an application fault — the tables are inert while both gates are closed.
If a database must genuinely be returned to the pre-feature schema, that is a
reviewed maintenance window of its own: take a fresh backup, confirm it restores,
then run the reference removal script
`prisma/manual-migrations/meal-planning/001_meal_planning.down.sql`, which drops
the sixteen tables, the four `meal_entries` columns and the three indexes on that
table in dependency order. Diary history is kept — the columns are nullable
links, so planned and catalog-logged entries are detached rather than deleted —
while everything the dropped tables held is destroyed.

That script names no database and reads no ambient variable. It refuses to drop
anything unless the session running it declares the target on purpose
(`SET meal_planning.removal_target = '<database name>';`) and that name is the
database the connection is actually on — deliberate, because the development
environment here exports a production `DATABASE_URL` into every new shell. The
procedure in its header, and in that folder's README, uses one explicitly named
URL for the read-back, the backup, the guarded run and the ledger step below.
Re-populating afterwards and restoring afterwards are two different things, and
the removal is only recoverable if you keep both in view:

- A **fresh load** — `catalog:load` of a reviewed release, then `recipes:seed` —
  rebuilds catalog and recipe content from the artefact committed in this
  repository, which is the same route step 4 of the release order uses. It
  writes new rows with new identifiers, so nothing that referenced the old ones
  finds them again, and it rebuilds **only** that shared content. Plans, grocery
  state and its check marks, preferences, confirmed-target bookkeeping and the
  `meal_plan_actions` ledger are user data: no release contains them, so a load
  does not bring them back and detached diary entries stay detached.
- The **pre-removal backup** is the only thing that returns those exact rows —
  same ids, same plan and shopping history, same stored responses. That is why
  the `pg_dump` in the script's step 3 is a precondition and not a precaution.

Both halves of a fresh load are available now: `catalog:load` writes the
reviewed release and `recipes:seed` publishes the committed recipe corpus
against it — the status table above is where that is tracked. The backup is
therefore no longer the only route back to that shared content, but it remains
the only route back to user data, so plan a removal around the backup and check
the state of both paths rather than assuming either has changed.

Afterwards, `_prisma_migrations` still records `20260908000000_meal_planning` as
applied, so `migrate deploy` would report nothing pending and leave the database
without the schema. Delete that single ledger row
(`DELETE FROM _prisma_migrations WHERE migration_name =
'20260908000000_meal_planning';`) against that same URL, and `npx prisma migrate
deploy` re-applies the migration whenever the feature is wanted back. `prisma
migrate resolve --rolled-back` is not the step here: Prisma 6 accepts it only for
a migration in a failed state and returns `P3012` for one that applied cleanly.
That folder's README carries the full procedure.

## Schema drift

`docs/meal-planning/expected-schema-diff.sql` is the committed evidence that
the migration ledger and `prisma/schema.prisma` have not drifted apart
unnoticed. It carries **three sections**, each delimited by its own
`-- >>> BEGIN <name>` / `-- >>> END <name>` marker, and the file's header
records the exact command that regenerates each one:

- `prisma-migrate-diff` — the reviewed output of one `prisma migrate diff
  --script` run between the ledger and the datamodel. Its single statement is
  what that command reports for the `STORED` generated `search_vector`
  expression, which the datamodel can only carry as `Unsupported("tsvector")?`.
- `pg-catalog-query` — a read-only `pg_catalog` query, scoped to generated
  columns, hand-managed indexes and array columns.
- `pg-catalog-expected` — that query's expected result: the generated column's
  expression, and every hand-managed index's access method, uniqueness, key
  expressions and predicate, and every array column's `NOT NULL` and default.

The migration writes three things by hand that `prisma migrate diff` does not
report at all — the `lower(alias)` expression index, the five partial indexes,
and `NOT NULL` on the twelve required array columns. Prisma 6.9 still emits
only the generated column, and the evidence file's header records that as an
AAP-versus-tool divergence with the measurements behind it. What closes the two
classes the tool omits is the second and third sections: deleting the
`lower(alias)` index, changing a partial index's predicate, or dropping
`NOT NULL` from a required array column each change the `pg_catalog` result and
fail the gate.

Those sections read the database `npx prisma migrate deploy` builds from
`prisma/migrations` — the authoritative ledger, as applied. They say nothing
about the operator copy under `prisma/manual-migrations/meal-planning/`, which
the gate never applies. What holds that copy to the authoritative migration is
the ledger-equivalence gate (`describe('migration ledgers')` in
`src/__tests__/api/compat.test.ts`), which applies both ledgers and compares the
resulting columns, indexes and constraints. The two are complementary: the
equivalence gate compares one ledger against the other and so cannot see a
construct dropped from both, which is precisely what the `pg_catalog` sections
catch.

CI's `Schema-drift evidence gate` step runs all three. It runs the migrate-diff
command against a throwaway shadow database of its own, requires its exit code
2, and compares `prisma-migrate-diff` with the output after stripping comment
and blank lines from both sides — failing on any difference in either direction.
It then executes `pg-catalog-query` read-only against the database the
`Apply the migration ledger` step migrated and compares `pg-catalog-expected`
with the result. It also requires that section to keep at least one generated
column, seven hand-managed indexes and twelve `NOT NULL` array columns, so
deleting evidence lines cannot buy a pass either. Every command is in the
evidence file's header for local use. To prove the ledger and its operator copy
still agree, follow the equivalence procedure in
`prisma/manual-migrations/meal-planning/README.md`.

## Forbidden operations

Off-limits for this work, and **none of them was performed**:

- Connecting development or test runs to production data.
- Resetting, truncating or otherwise destroying a database that holds user data.
- Merging either pull request.
- Deploying to the VPS.
- Submitting an app-store release.

The procedure above is written for whoever holds that authority; this work stops
at two reviewable pull requests. The two habits that keep the first two items
honest during ordinary development are the database-origin guard described in
[`README.md`](./README.md) — which refuses any database it cannot classify, and
makes the two data writers demand the target's name aloud — and naming the
target URL explicitly in any command that writes, because this project's
development environment supplies a production `DATABASE_URL` to every new shell
that does not override it.
