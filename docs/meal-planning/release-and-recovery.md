# Meal planning — release and recovery

The operator procedure for putting the meal-planning schema and API into an
environment, verifying it, switching it on, and getting back out again. The API
ships **before** the app: every new response field is additive and every new
route is gated, so an older client is unaffected, while a newer client against
an older API is not.

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
| `npm run catalog:load`, `npm run recipes:seed`, `npm run search:benchmark` | present as commands, each already checking its own inputs — `catalog:load -- --release v1` finds and accepts the manifest above — but **none of them writes to a database yet**: each ends by reporting `stage_pipeline_pending`, or `stage_prerequisites_unmet` for an input it cannot see (`recipes:seed` reports `gap_recipes_directory_absent` while `data/meal-planning/recipes/` is absent), and exits non-zero without touching the database. The loading, seeding and measurement bodies land with this branch's catalog commits. |
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

Backend first, app second, feature flags last.

1. **Back up.** `pg_dump` the target database before anything else. Everything
   below is additive, but a backup is the only thing that makes step 6
   recoverable without thought.
2. **Switch the feature off before the code arrives.** Set
   `MEAL_PLANNING_ENABLED=false` (or leave it unset — it is on only for the
   exact string `true`) and confirm the Firebase Remote Config parameter
   `meal_planning_enabled` exists with value `false`. Both gates being closed
   before the deploy is what makes the deploy itself uneventful.
3. **Deploy the backend.** The image's final command is
   `npx prisma migrate deploy && node dist/server.js`, so
   `20260908000000_meal_planning` is applied at boot: sixteen new tables, four
   nullable columns on `meal_entries`, and indexes and foreign keys over them.
   Nothing is dropped or rewritten, so existing users, diary history, custom
   foods, workouts, runs and weigh-ins are untouched. Confirm `GET /health`
   reports `status: ok` and the `GIT_SHA` you expect. The copy under
   `prisma/manual-migrations/meal-planning/` is *not* executed — see that
   folder's README.
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
   batch keys and a budget of its own. The catalog data itself stays idempotent
   throughout, because foods upsert on `source_key` and recipes on `slug`.
5. **Verify before switching on.** `GET /api/catalog/status` must report the
   expected release with at least 10,000 published foods and at least 40
   recipes; the benchmark report must meet its thresholds; per-table row counts
   must match the release manifest. Only then set `MEAL_PLANNING_ENABLED=true`
   and restart, and confirm `GET /api/meal-planning/preferences` answers 200
   instead of 503.
6. **Release the app,** then flip Remote Config `meal_planning_enabled` to
   `true`. The client's packaged default is `false` and it fetches Remote Config
   once per cold start, so devices pick the feature up on their next launch —
   deliberately fail-closed.

## Kill switches

Two independent gates, both reversible without a deploy:

- **Remote Config `meal_planning_enabled=false`** — the app stops rendering the
  Diary / Meal Plan control and the Add Food catalog section and stops issuing
  gated requests. It takes effect on a device's next cold start, so it is not a
  bounded-time switch on its own.
- **`MEAL_PLANNING_ENABLED=false` on the server** — `/api/meal-planning/*` and
  `/api/recipes/*` answer `503 feature_disabled` immediately. `/api/catalog/*`
  and `/api/meal-planning/targets*` are never gated, so Account, Diary and
  Progress keep reading and writing nutrition targets while planning is off.
  This is the switch that stops a device already in the foreground.

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
   stop arriving. Stragglers get a bare `404` from every meal-planning route,
   including `/api/meal-planning/targets*`, which the client treats as "the
   feature is unavailable": the Meal Plan segment shows its unavailable card and
   the target surfaces fall back to the device's last local value rather than
   clearing anything. No client crashes.

Forward recovery is the release order above from step 3, with the flag still
`false` until step 5 passes. `catalog:load` is idempotent, so a failed or
partial load is repaired by re-running it.

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

Today the backup is also the *only* route back to either kind of data: as this
commit stands, `catalog:load` and `recipes:seed` both stop before any database
write — the status table above is where that is tracked — so plan a removal
around the backup, and check the state of the load path rather than assuming it
has changed.

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
