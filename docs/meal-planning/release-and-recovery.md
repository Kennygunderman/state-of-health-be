# Meal planning — release and recovery

The operator procedure for putting the meal-planning schema and API into an
environment, verifying it, switching it on, and getting back out again. The API
ships **before** the app: every new response field is additive and every new
route is gated, so an older client is unaffected, while a newer client against
an older API is not.

## Status at this commit

This document is the release runbook for the whole feature, and parts of the
feature arrive across several commits on this branch. What it references falls
into three groups, so nothing here reads as a claim about code that is not yet
present:

| Referenced thing | State |
| --- | --- |
| `prisma/migrations/20260908000000_meal_planning` (the schema), `prisma/manual-migrations/meal-planning/*`, `docs/meal-planning/expected-schema-diff.sql`, `.github/workflows/ci.yml`, `src/utils/featureFlags.ts`, `MEAL_PLANNING_ENABLED` | present |
| `npm run catalog:load`, `npm run recipes:seed`, `npm run search:benchmark`, `GET /api/catalog/status`, `data/meal-planning/catalog/releases/v1/` | declared in `package.json`; the scripts, routes and release artefact land with the catalog and API commits of this branch. Verify with `--help`/`GET /api/catalog/status` before relying on a step below. |
| Firebase Remote Config `meal_planning_enabled`, the mobile store build | outside this repository |

`npm test` fails until the Jest configuration and suites land — that is the test
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

Afterwards, `_prisma_migrations` still records `20260908000000_meal_planning` as
applied, so `migrate deploy` would report nothing pending and leave the database
without the schema. Delete that single ledger row
(`DELETE FROM _prisma_migrations WHERE migration_name =
'20260908000000_meal_planning';`) and `npx prisma migrate deploy` re-applies the
migration whenever the feature is wanted back. `prisma migrate resolve
--rolled-back` is not the step here: Prisma 6 accepts it only for a migration in
a failed state and returns `P3012` for one that applied cleanly. That folder's
README carries the full procedure.

## Schema drift

`docs/meal-planning/expected-schema-diff.sql` is the committed record of every
construct in the migration that `prisma/schema.prisma` cannot express: the
`STORED` generated `search_vector` expression, the `lower(alias)` expression
index, the five partial indexes, and `NOT NULL` on the twelve required array
columns. `prisma migrate diff` is blind to the last three groups — measured, with
the tamper matrix, in that file's header — which is why the file has a second
section read straight back out of the database.

CI re-derives both sections against the freshly migrated service database in its
`Schema-drift evidence gate` step and fails on any difference in either
direction. The same two commands are in the evidence file's header for local
use. To prove the ledger and its operator copy still agree, follow the
equivalence procedure in
`prisma/manual-migrations/meal-planning/README.md`.
