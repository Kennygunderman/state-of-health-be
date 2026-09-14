# Meal planning — operator commands

The entry point for running the meal-planning backend: the command order from a
fresh checkout to a verified environment, the nine CLI entry points the feature
has, the database guards those commands answer to, and the environment variables
an operator sets.

Every command below is run from the `backend/` package root. Each CLI entry point
prints its own authoritative usage — options, the inputs it reads and the
environment it requires — for `npm run <script> -- --help`, and each checks its
inputs before it acts, exiting non-zero and naming the unsatisfied input and its
remedy rather than starting partial work.

Companion documents, none of which is restated here:

- [`release-and-recovery.md`](./release-and-recovery.md) — the release, switch-on
  and rollback procedure, and the record of which of the things these commands
  name are present in the tree at a given commit.
- [`catalog-policy.md`](./catalog-policy.md) — the reviewed catalogue policy: the
  identity-evidence (SSRF) policy and its address-table attestation, the
  provenance model, and where the coverage plan, the validation checks and the
  search-benchmark thresholds are authoritatively recorded.
- [`expected-schema-diff.sql`](./expected-schema-diff.sql) — the committed
  schema-drift evidence for the meal-planning migration.

## Command order — setup to verification

```bash
npm ci
npx prisma generate
npx prisma migrate deploy
npm run catalog:load -- --release v1
npm run recipes:seed
npm run search:benchmark
npm run typecheck
npm run build
npm test                     # see "Running the test suite" for its required environment
npm run dev
```

- `DATABASE_URL` must be set for every step from `prisma generate` onward. The
  CLI entry points import `scripts/lib/bootstrap.ts` first, which calls
  `dotenv.config()`, so `backend/.env` supplies it; a value already in the
  environment is never overwritten.
- `npx prisma generate` writes the Prisma client to `src/generated/prisma`, and
  `npx prisma migrate deploy` applies `prisma/migrations/` —
  `20260706000000_init` and `20260908000000_meal_planning`.
- `npm run catalog:load -- --release v1` loads the reviewed, checksummed release
  committed at `data/meal-planning/catalog/releases/v1/`: it verifies the
  SHA-256, row count and size that `manifest.json` records for each of its five
  JSONL members (`foods.jsonl`, `aliases.jsonl`, `portions.jsonl`,
  `components.jsonl`, `validation-records.jsonl`) before writing anything, so a
  truncated or hand-edited member is refused instead of half-loaded. Loading
  makes no USDA or model call.
- `npm run catalog:load` and `npm run recipes:seed` additionally require
  `--confirm-target <dbname>` whenever `DATABASE_URL` is not a development
  origin — see [the database-origin guard](#the-database-origin-guard).
- `npm run search:benchmark` runs the fixed query set in
  `data/meal-planning/search-benchmark.v1.json` against the catalog loaded in
  `DATABASE_URL` and writes its report to
  `data/meal-planning/reports/latest/benchmark-report.json`. The report belongs
  to the run that produced it; its numbers are recorded nowhere else.
- `npm run dev` serves the API with `ts-node-dev`; `npm run build` then
  `npm start` is the compiled form.

## Building a new catalog release (development machine only)

A catalog version is produced on a development machine and reviewed as a pull
request. A target environment never regenerates a catalog — it loads a release.

```bash
npm run catalog:import
npm run catalog:generate
npm run catalog:validate
npm run catalog:report
npm run catalog:release -- --release v2      # the next unused release id
```

The reviewed output of these five stages is one versioned directory,
`data/meal-planning/catalog/releases/v<N>/`, carrying the five JSONL members and
a `manifest.json` recording each of their SHA-256 digests, row counts and sizes
measured from the bytes on disk. That directory — committed and reviewed — is
what every environment then loads with `npm run catalog:load -- --release <vN>`.
`catalog:release` refuses an existing release directory unless `--force` is
passed, because overwriting one would replace a checksummed artefact another
environment may already have loaded.

Live vendor and model credentials are used only here:
`catalog:import` calls USDA FoodData Central with `USDA_API_KEY`, and
`catalog:generate` calls OpenRouter with `OPENROUTER_API_KEY` under the
`CATALOG_MODEL_CALL_BUDGET` cap that `catalog:validate`'s advisory review call
shares. No other entry point makes a vendor or model call, and neither does
loading a release.

## The nine CLI entry points

These nine npm scripts are the complete set of CLI entry points for this
feature; there is no tenth. Everything under `scripts/lib/` is a library the
entry points import, not a command.

| npm script | Runs | What it is for | Requires |
| --- | --- | --- | --- |
| `catalog:import` | `scripts/catalog-import-usda.ts` | Stage 1 — imports USDA FoodData Central records as catalog **candidates** (it publishes nothing), upserting each on its source key with its aliases, portions and validation record, batched under the hourly rate limit and checkpointed as it goes | `DATABASE_URL`, `USDA_API_KEY`; optional `USDA_IMPORT_RATE_LIMIT_PER_HOUR` (1–1000, default 900); reads `data/meal-planning/usda-manifest.v1.json` and `coverage-plan.v1.json` |
| `catalog:generate` | `scripts/catalog-generate-ai.ts` | Stage 2 — AI-assisted candidate expansion for the categories the coverage plan still needs, metered per batch against the model-call cap | `DATABASE_URL`, `OPENROUTER_API_KEY`, `CATALOG_MODEL_CALL_BUDGET` (required positive integer, no default); optional `CATALOG_BATCH_SIZE` (default 25); reads `coverage-plan.v1.json` and `evidence-allowlist.v1.json` |
| `catalog:validate` | `scripts/catalog-validate.ts` | Stage 3 — resolves duplicate identities across the whole non-rejected table, runs the deterministic checks, and publishes, quarantines or rejects each row, writing one validation record per judged food | `DATABASE_URL`, `CATALOG_MODEL_CALL_BUDGET` (shared with `catalog:generate`); `OPENROUTER_API_KEY` only for the advisory review call; reads `coverage-plan.v1.json` and `evidence-allowlist.v1.json` |
| `catalog:report` | `scripts/catalog-report.ts` | Stage 4 — the coverage and quality report: published, candidate and quarantined counts, duplicate identities, quarantine reasons and the exact per-category shortfall, written to `data/meal-planning/reports/latest/validation-report.json` (`--out` overrides) | `DATABASE_URL`; reads `coverage-plan.v1.json` |
| `catalog:release` | `scripts/catalog-release.ts` | Stage 5 — exports the published catalog as a versioned, checksummed release under `data/meal-planning/catalog/releases/<vN>/`. `--release <vN>` is required; `--force` is needed to overwrite an existing release directory | `DATABASE_URL`; reads `coverage-plan.v1.json` |
| `catalog:load` | `scripts/catalog-load.ts` | Loads a reviewed release into an environment, verifying every manifest digest before writing. `--release <vN>` is required | `DATABASE_URL`; `--confirm-target <dbname>` off a development origin; reads `data/meal-planning/catalog/releases/<vN>/` |
| `recipes:seed` | `scripts/recipes-seed.ts` | Publishes the curated recipe files as versioned recipes, resolving each ingredient against the loaded catalog by `source_key`; idempotent by recipe slug. Every selected file is validated before the first write, so one bad file publishes nothing. `--only <slug>` (repeatable; `--slug` is an alias) narrows it and `--dry-run` validates without writing — neither rewrites `recipes/coverage-report.json`, which a full run derives from the seeded rows | `DATABASE_URL` with a loaded catalog; `--confirm-target <dbname>` off a development origin; reads `data/meal-planning/recipes/*.json` and `coverage-plan.v1.json`; writes `data/meal-planning/recipes/coverage-report.json` |
| `search:benchmark` | `scripts/search-benchmark.ts` | Measures the in-process catalog search against the committed query set and writes `data/meal-planning/reports/latest/benchmark-report.json` (`--out` overrides; `--passes <n>` defaults to 3, so a cold first pass can be separated from the steady state) | `DATABASE_URL` with a loaded catalog; reads `data/meal-planning/search-benchmark.v1.json` |
| `db:seed:dev` | `scripts/seed-dev.ts` | Seeds a development database with one user, its meal-planning preferences row in the `not_started` state, and the four diary buckets for one day. Idempotent: a second run with the same flags creates nothing. `--email`, `--user-id` and `--date` override the defaults | `DATABASE_URL` that is a **development** origin — there is no confirmation flag that overrides this |

## The database-origin guard

`scripts/lib/dbGuard.ts` is imported by every CLI entry point immediately after
`bootstrap.ts` and before anything can reach Prisma. It classifies `DATABASE_URL`
as `development`, `test`, `shadow` or `unknown` and refuses an unknown origin
outright. Every recognised origin is on host `localhost`, `127.0.0.1` or
`postgres`: a `_dev`, `_test` or `_shadow` name does not make a remote database
one.

| Policy | Scripts | Rule |
| --- | --- | --- |
| `development_or_confirmed` | `catalog:load`, `recipes:seed` | Against anything other than a development origin the run is refused at module load with code `confirmation_required` unless `--confirm-target <dbname>` names that URL's database exactly. Never needed against a development origin |
| `development_only` | `db:seed:dev` | Only a development origin is accepted; a test, shadow or unrecognised database is refused and no flag opens the door, because this is the one script that writes user-scoped rows |
| `any_recognised` | `catalog:import`, `catalog:generate`, `catalog:validate`, `catalog:report`, `catalog:release`, `search:benchmark` | Any origin the guard can classify is accepted; an unrecognised one is still refused |

`SHADOW_DATABASE_URL` is needed only by `npx prisma migrate dev --create-only`
and `npx prisma migrate diff`, both of which reset the database they point at.
Give development, test and shadow three separate local databases.

## Running the test suite

The suite truncates the meal-planning tables plus `meal_entries`, `meals` and
`users` between suites, so `assertTestDatabase` in
`src/__tests__/setup/testDb.ts` refuses to run at all unless all three of its
conditions hold:

> 1. `NODE_ENV === 'test'` — exactly, so `development` or an unset value
>    refuses rather than being coerced.
> 2. `ALLOW_DB_TRUNCATE === 'true'` — exactly, so `TRUE`, `1` and a blank
>    value refuse. Truncation is not something to enable by accident.
> 3. `DATABASE_URL` names a `_test` database (with or without a clone index)
>    or exactly `ci`, on a host in `LOCAL_HOSTS`.

`LOCAL_HOSTS` is `localhost`, `127.0.0.1`, `postgres`. So the suite is invoked
with that environment on the command itself — nothing in the test harness loads
`.env`, and the guard reads the process environment directly:

```bash
NODE_ENV=test ALLOW_DB_TRUNCATE=true \
  DATABASE_URL=postgresql://user:password@127.0.0.1:5432/state_of_health_test \
  npm test
```

The name rule holds regardless of the other two, so `ALLOW_DB_TRUNCATE` can
never authorise a truncate of a development, shadow or production database, and
a `_test` name on a remote host is refused as well. A `DATABASE_URL` that does
not determine its own target is refused rather than classified: libpq connection
parameters in the query string (`?host=`, `?dbname=`, `?service=`), a
percent-encoded database name, or no authority at all.

A second guard, `assertSchemaFreshness`, then checks that the database is the
schema the code expects, so run `npx prisma migrate deploy` against the test
database before the first run. `npm run check:test-db` runs both guards on their
own and is what `pretest` runs before every `npm test`.

## Environment variables

`.env.example` is the full list; these are the meal-planning ones.

| Variable | Value | Notes |
| --- | --- | --- |
| `MEAL_PLANNING_ENABLED` | `false` | The server kill switch, read once at import by `src/utils/featureFlags.ts` and matched against the exact string `true`, so absent, blank and misspelled all mean off. A release boots with planning off — gated handlers answer 503 — and turns it on only after the catalog, the recipes and the search benchmark have been loaded and verified |
| `MEAL_PLANNING_FAULT` | `off` | Development and test fault injection (`off \| generation \| swap \| log`), read once at startup by `src/utils/featureFlags.ts`. It is forced to `off` whenever `NODE_ENV` is `production`, and it is never set in production; outside production an unrecognised value fails startup |
| `USDA_API_KEY` | — | Keeps its runtime role for `/api/macros/search-branded-foods`, and is additionally required by `catalog:import` |
| `OPENROUTER_API_KEY` | — | Keeps its runtime role for `/api/macros/estimate` and `/api/macros/label-scan`, and is additionally required by `catalog:generate` and by `catalog:validate`'s advisory review |
| `CATALOG_MODEL_CALL_BUDGET` | `1500` | Required positive integer: the hard cap on OpenRouter calls for one `catalog:generate` or `catalog:validate` run, shared by the generation and the review call. The scripts fail closed at startup when it is missing, non-numeric, zero or negative |
| `CATALOG_BATCH_SIZE` | `25` | Candidates per generation batch, read by `scripts/lib/budget.ts`; `catalog:generate --batch-size <n>` overrides it for one run |
| `USDA_IMPORT_RATE_LIMIT_PER_HOUR` | `900` | Read by `scripts/lib/rateLimiter.ts`; an integer between 1 and the vendor's 1000-per-hour cap. 900 leaves headroom on the same key for the running API's estimate and branded-search traffic, and the import pauses when the bucket empties rather than failing |
| `EVIDENCE_FETCH_TIMEOUT_MS` | `10000` | Total timeout for one identity-evidence fetch |
| `ALLOW_DB_TRUNCATE` | `true`, on the test command only | Deliberately commented out in `.env.example`: the guard reads the process environment directly, so a value written to `.env` is never seen by `npm test` |

Once the catalog and recipes are loaded, plan generation, swaps, grocery
aggregation, recipe viewing and internal catalog search make no live USDA or
model calls.
