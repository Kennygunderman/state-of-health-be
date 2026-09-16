# Meal planning — operator commands

The entry point for running the meal-planning backend: the prerequisites, the
command order from a fresh checkout to a verified environment, the separate order
in which the feature is switched on, the nine CLI entry points the feature has,
the database guards those commands answer to, and the environment variables an
operator sets.

It documents only what the code cannot carry — the orders that are contracts and
the reasons behind them. It is not an architecture overview: the layering, the
error mapping and the ownership rules live in the backend architecture guide, and
the subject documents below own their own subjects.

Every command below is run from the `backend/` package root. Each CLI entry point
prints its own authoritative usage — options, the inputs it reads and the
environment it requires — for `npm run <script> -- --help`, and each checks its
inputs before it acts, exiting non-zero and naming the unsatisfied input and its
remedy rather than starting partial work.

Companion documents, none of which is restated here:

- [`api.md`](./api.md) — the endpoint surface: request and response shapes, the
  machine-readable error codes, and which routes the feature gate spares.
- [`planning-policy.md`](./planning-policy.md) — the reviewed numbers and rules
  behind nutrition targets, plan generation, swaps and grocery aggregation.
- [`catalog-policy.md`](./catalog-policy.md) — the reviewed catalogue policy: the
  identity-evidence (SSRF) policy and its address-table attestation, the
  provenance model, and where the coverage plan, the validation checks and the
  search-benchmark thresholds are authoritatively recorded.
- [`release-and-recovery.md`](./release-and-recovery.md) — the release, switch-on
  and rollback procedure, and the record of which of the things these commands
  name are present in the tree at a given commit.
- [`requirement-evidence-checklist.md`](./requirement-evidence-checklist.md) —
  each requirement mapped to where it is implemented and what evidence covers it.
- [`expected-schema-diff.sql`](./expected-schema-diff.sql) — the committed
  schema-drift evidence for the meal-planning migration.

## Prerequisites

- **Node 22.** The package declares no `engines` field and the repository has no
  `.nvmrc`, so the line is fixed by the two places that pin it: `FROM
  node:22-alpine` in the `Dockerfile` and `node-version: 22` in
  `.github/workflows/ci.yml`. A current 22.x with its bundled npm is what these
  commands were run against. If you select it with nvm, note that activation is
  **per shell** — every one of the command blocks below needs `nvm use 22` first,
  or it silently runs on whatever `node` the shell already had.
- **PostgreSQL 16, on a host that is not production.** The repository documents no
  server version; 16 is the major chosen here and the one CI runs
  (`postgres:16-alpine`). The exact patch level is recorded in each
  validation and benchmark report, so a measurement stays reproducible against
  the server that produced it.
- **Firebase development credentials.** `FIREBASE_SERVICE_ACCOUNT` holds the
  **base64** of the development project's service-account JSON
  (`base64 -i serviceAccountKey.json`); locally it may be omitted, in which case
  the code falls back to an untracked `./serviceAccountKey.json` in the package
  root. Either form is a secret: inject it, never commit it. Only authenticated
  requests need it — `/health` and the guards below do not.
- **`USDA_API_KEY` and `OPENROUTER_API_KEY`** keep the runtime roles they already
  had — `/api/macros/estimate` and `/api/macros/label-scan` call OpenRouter,
  `/api/macros/search-branded-foods` calls USDA — and are **additionally**
  required by the offline catalog scripts. The new guarantee is narrower than
  "no vendor calls": once the catalog and recipes are loaded, plan generation,
  swaps, grocery aggregation, recipe viewing and internal catalog search make no
  live USDA or model call.

## The three local databases

Three separate databases, because two of the commands here destroy the database
they point at and one refuses to run unless it may:

| Database | Set as | Used by | Note |
| --- | --- | --- | --- |
| `soh_dev` | `DATABASE_URL` | `npm run dev`, and the catalog, recipe and dev-seed scripts | Of the three, the only one `db:seed:dev` accepts, and the only one where `catalog:load` and `recipes:seed` need no confirmation flag |
| `soh_test` | `DATABASE_URL` on the test command | `npm test` | **The name must end in `_test`** (a clone index after it is fine, as in `soh_test_7`). The guard also accepts a database named exactly `ci` on a local host, which is CI's shape. It additionally requires `NODE_ENV=test` and `ALLOW_DB_TRUNCATE=true` — see [Running the test suite](#running-the-test-suite) |
| `soh_shadow` | `SHADOW_DATABASE_URL` | `npx prisma migrate dev --create-only`, `npx prisma migrate diff` | **Both reset it.** Nothing of value may live here, and no other command reads it |

```bash
createdb soh_dev soh_test soh_shadow
```

**Never point any of these three at production.** That is not only a convention:
the origin guard classifies `DATABASE_URL` before any script can open a client
and refuses an origin it does not recognise, and the test guard refuses to
truncate anything whose name does not say test. A production URL satisfies
neither, so the failure is a refusal rather than a loss — but the refusal is the
backstop, not the plan.

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

The sequence is the contract, and each step below says what would break if it
moved:

- `DATABASE_URL` must be set for every step from `prisma generate` onward. The
  CLI entry points import `scripts/lib/bootstrap.ts` first, which calls
  `dotenv.config()`, so `backend/.env` supplies it; a value already in the
  environment is never overwritten.
- `npx prisma generate` is **required, not optional**, and it is the step most
  often skipped. It writes the client to `src/generated/prisma`, which this
  repository git-ignores and regenerates in CI and in the Docker build stage —
  so on a fresh checkout nothing that imports Prisma compiles or runs until it
  has been run, and `typecheck`, `build`, `test` and every script fail on a
  missing module rather than on anything they are actually about. (The
  architecture guide's §12 describes that client as committed build output while
  the repository ignores it; the repository's practice is the one followed here,
  so no generated file appears in a pull request.)
- `npx prisma migrate deploy` applies `prisma/migrations/` —
  `20260706000000_init` and `20260908000000_meal_planning`. The meal-planning
  migration is **additive**: it creates new tables and adds nullable columns, and
  changes no existing column or constraint. The identical command also runs at
  container boot from the `Dockerfile` `CMD`, which is why `prisma/migrations/`
  is the executed, authoritative ledger and
  `prisma/manual-migrations/meal-planning/` is a reference copy for operators
  rather than something to run — [`release-and-recovery.md`](./release-and-recovery.md)
  carries that reasoning and the `migrate resolve` step anyone running the copy
  by hand owes afterwards.
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
- `npm run typecheck` is the fast gate — run it before `build`, because it
  reports the same errors in less time. It covers the production sources only;
  the tests and the scripts are separate projects with their own compiler
  settings, so `npm run typecheck:test` and `npm run typecheck:scripts` are the
  other two thirds of the same check and CI runs all three.
- `npm test` **is a real test suite now.** It was `echo "no tests yet"` before
  this feature; it is `jest --ci --runInBand --coverage`, and the coverage gate
  is derived from the files on disk — one 80 %-branch threshold per
  `src/services/*.logic.ts` and per covered `src/utils/` module, so a new pure
  logic module joins the gate the moment it is added and cannot hide behind a
  global average. It needs its own database and two acknowledgements; see
  [Running the test suite](#running-the-test-suite) for the exact invocation.
- `npm run dev` serves the API with `ts-node-dev`; `npm run build` then
  `npm start` is the compiled form. Verify either the same way:

  ```bash
  curl http://localhost:3000/health
  ```

  `/health` is unauthenticated by design — Coolify's health check, uptime
  monitoring and post-deploy verification all use it. It answers
  `{"status":"ok","version":"<commit>"}` only after a real `SELECT 1` against
  `DATABASE_URL`, so `status: ok` is a statement about the database and not just
  the process. `version` carries `GIT_SHA`, which is injected at image build
  time, so outside Docker it reads `"unknown"` and that is correct rather than a
  fault.

## Switch-on order — why the flag comes last

A second sequence, with a different reason for its order: the feature must not be
reachable before the data it needs is present and verified. Planning off is
therefore the starting state, not a fallback.

1. **Migrate with `MEAL_PLANNING_ENABLED` unset.** The flag being off — not the
   tables being empty — is what makes every gated `/meal-planning/*` handler and
   `/recipes/*` answer `503 feature_disabled`, which is why this step is safe to
   deploy before any data exists. `/meal-planning/targets*` and `/catalog/*` are
   deliberately **not** gated, so Account, Diary and Progress keep reading and
   writing nutrition targets throughout — [`api.md`](./api.md) has the per-route
   detail.
2. `npm run catalog:load -- --release v1`
3. `npm run recipes:seed`
4. **Verify before enabling**, with the flag still off:

   ```bash
   curl -H "Authorization: Bearer $ID_TOKEN" \
     http://localhost:3000/api/catalog/status
   ```

   It reports the loaded release id and the published, quarantined, rejected and
   recipe counts. Confirm they are the release you intended and that
   `search:benchmark`'s report met its thresholds. The route carries no user
   data, but it still sits behind the API's auth boundary — without a Firebase
   ID token it answers `401`, not the status — so it needs a token the way every
   other `/api` route does. `/health` is the only unauthenticated endpoint.
5. **Only then** set `MEAL_PLANNING_ENABLED=true` and restart. The flag is read
   once at import, so a running process never picks up a change to it.

A development **device** needs one more thing that no backend command can
supply: the development Firebase project's Remote Config `meal_planning_enabled`
must be `true` and must have been fetched at least once. The client ships with
that default set to `false` and fetches at launch, so until then the Meal Plan
segment is hidden — by design, not as a failure. Cold-start the app after
changing it.

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

`development` is the widest class and the one to understand before pointing a
script anywhere: it is satisfied by **host alone** on `localhost` or
`127.0.0.1`, or by a `_dev` name on any of the three hosts. So an arbitrarily
named local database is development, while the same name on `postgres` — a
container-network service that in CI or a compose stack need not be anyone's
development box — is `unknown` and refused. `test` and `shadow` have no
host-only arm: they are reached by name only, so nothing becomes a test database
by being local.

| Policy | Scripts | Rule |
| --- | --- | --- |
| `development_or_confirmed` | `catalog:load`, `recipes:seed` | Against anything other than a development origin the run is refused at module load with code `confirmation_required` unless `--confirm-target <dbname>` names that URL's database exactly. Never needed against a development origin |
| `development_only` | `db:seed:dev` | Only a development origin is accepted; a test, shadow or unrecognised database is refused and no flag opens the door, because this is the one script that writes user-scoped rows |
| `any_recognised` | `catalog:import`, `catalog:generate`, `catalog:validate`, `catalog:report`, `catalog:release`, `search:benchmark` | Any origin the guard can classify is accepted; an unrecognised one is still refused |

Against a development origin the flag is never needed and is accepted and
ignored. Everywhere else, the database's own name is what unlocks the run:

```bash
npm run catalog:load -- --release v1 --confirm-target soh_test
```

A name that does not match the one in `DATABASE_URL` is refused
(`confirmation_mismatch`) just as firmly as a missing flag
(`confirmation_required`), so the flag cannot be satisfied by habit — it has to
be the name of the database actually being written.

`SHADOW_DATABASE_URL` is needed only by `npx prisma migrate dev --create-only`
and `npx prisma migrate diff`, both of which reset the database they point at.
Give development, test and shadow three separate local databases.

The guard's siblings under `scripts/lib/` are libraries the entry points import,
not commands:

| Module | What it owns |
| --- | --- |
| `bootstrap.ts` | The DNS ordering and `dotenv.config()` — see below |
| `dbGuard.ts` | The origin classification and the policies above |
| `manifest.ts` | Loading the versioned data files under `data/meal-planning/`, resolved from the repository root rather than the working directory |
| `rateLimiter.ts` | Pacing USDA requests under `USDA_IMPORT_RATE_LIMIT_PER_HOUR`; it pauses when the bucket empties instead of failing |
| `checkpoint.ts` | Run state in `catalog_import_runs`, so an interrupted stage resumes instead of restarting |
| `budget.ts` | The model-call ledger — reserve before spending, never released on failure ([`catalog-policy.md`](./catalog-policy.md)) |
| `logger.ts` | Structured output that never prints a secret — not `DATABASE_URL`'s password, not USDA's `api_key` query parameter, not OpenRouter's bearer token |

## `bootstrap.ts` and the DNS ordering

Every CLI entry point imports `scripts/lib/bootstrap.ts` as its **literal first
statement**, before any other import. It exports nothing — importing it is the
whole API — and it does two things in this order:

1. `dns.setDefaultResultOrder('ipv4first')`, **before any network module loads.**
2. `dotenv.config()`, which never overwrites a variable already in the
   environment, so a CI-injected or command-line value wins over `.env`.

The first line is the one that matters and the reason is not visible from the
code: the VPS this service runs on has broken IPv6 egress. Node otherwise
prefers AAAA records, and outbound HTTPS — the Firebase certificate download,
OpenRouter, USDA — hangs until timeout on a fresh process rather than failing
fast. `src/server.ts` does the same thing for the server process, and the
architecture guide's §10 says not to move or remove that ordering; this module
is its one sanctioned mirror, for processes that never load `server.ts`.

So the import order in a script is not style. A script that imports a service,
Prisma or anything else network-touching **above** `bootstrap` reintroduces the
hang, and it reintroduces it as an intermittent timeout on a fresh process
rather than as an error anyone can read.

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

Every key in `.env.example`, with the module that reads it. **The values below
are development placeholders.** Production values live in Coolify, not in any
checked-in file, and nothing real — no host, key, token or service account —
belongs in this repository.

| Variable | Development value | Read by, and what it means |
| --- | --- | --- |
| `DATABASE_URL` | `postgresql://user:password@localhost:5432/soh_dev` | `src/prisma/client.ts` for the server; classified by `scripts/lib/dbGuard.ts` before any script can open a client, and by the test guard before the suite may truncate. The password sits in the URL's userinfo, which is why `logger.ts` never prints the URL itself |
| `USDA_API_KEY` | *(a development FoodData Central key)* | `src/services/usda.service.ts` behind an accessor that throws when it is absent. Keeps its runtime role for `/api/macros/search-branded-foods`, and is additionally required by `catalog:import` |
| `OPENROUTER_API_KEY` | *(a development OpenRouter key)* | `src/services/openrouter.service.ts`, same accessor pattern. Keeps its runtime role for `/api/macros/estimate` and `/api/macros/label-scan`, and is additionally required by `catalog:generate` and by `catalog:validate`'s advisory review |
| `FIREBASE_SERVICE_ACCOUNT` | *(base64 of the development service-account JSON)* | `src/utils/firebase.ts` at import. Optional locally — it falls back to an untracked `./serviceAccountKey.json` — and required in any deployed environment |
| `NODE_ENV` | `development` | The image sets `production`; CI sets `test`. Three behaviours key off it: the fault switch below is forced off in production, the test guard demands exactly `test`, and the post-commit abort header is read only under `test` |
| `PORT` | `3000` | `src/server.ts`, which already falls back to 3000, so it is optional either way |
| `MEAL_PLANNING_ENABLED` | `false` | `src/utils/featureFlags.ts`, read once at import and matched against the exact string `true` — so absent, blank and misspelled all mean **off**. Gates `/meal-planning/*` and `/recipes/*`, and deliberately spares `/meal-planning/targets*` and `/catalog/*` ([`api.md`](./api.md)). A release boots with planning off and turns it on only after the catalog, the recipes and the benchmark are loaded and verified |
| `MEAL_PLANNING_FAULT` | `off` | `src/utils/featureFlags.ts`, read once at startup. See the note below the table |
| `CATALOG_GENERATION_MODEL` | *(blank)* | `catalog:generate`. Blank inherits `OPENROUTER_MODEL` |
| `CATALOG_REVIEW_MODEL` | *(blank)* | `catalog:validate`'s advisory review. Blank inherits `ESTIMATE_JUDGE_MODEL` |
| `USDA_IMPORT_RATE_LIMIT_PER_HOUR` | `900` | `scripts/lib/rateLimiter.ts`; an integer between 1 and the vendor's 1000-per-hour cap. 900 leaves headroom on the same key for the running API's estimate and branded-search traffic, and the import pauses when the bucket empties rather than failing |
| `CATALOG_BATCH_SIZE` | `25` | Candidates per generation batch; `catalog:generate --batch-size <n>` overrides it for one run |
| `CATALOG_MODEL_CALL_BUDGET` | `1500` | `scripts/lib/budget.ts`. A **required positive integer** — the hard cap on OpenRouter calls for one `catalog:generate` or `catalog:validate` run, shared by the generation and the review call. The scripts fail closed at startup when it is missing, non-numeric, zero or negative. The reserve-before-spend ledger it drives is described in [`catalog-policy.md`](./catalog-policy.md) |
| `EVIDENCE_FETCH_TIMEOUT_MS` | `10000` | `src/services/evidence.service.ts`; the total timeout for one identity-evidence fetch |

Two variables an operator will look for and not find as keys:

- `SHADOW_DATABASE_URL` — used only by the two Prisma commands that reset the
  database they point at, so `.env.example` names it in a comment rather than
  offering a value to copy.
- `ALLOW_DB_TRUNCATE` — deliberately commented out. Not because an active value
  would be dangerous (the name rule below means it can never authorise a
  development, shadow or production database on its own), but because it would
  not work: the guard runs as Jest's first setup statement and reads the process
  environment directly, and nothing in the test harness loads `.env`. It belongs
  on the test command itself.

### `MEAL_PLANNING_FAULT`

Fault injection, `off | generation | swap | log`, default `off`, for development
and test only. It exists so the failure states the design draws are reachable
from a device without breaking anything: each value makes one write path fail in
a specific, documented way.

| Value | Effect |
| --- | --- |
| `generation` | `POST /plans` and `/regenerate` throw **before** their transaction, so nothing is written and the same idempotency key retried without the fault succeeds |
| `swap` | The swap commit throws before its transaction, with the same property |
| `log` | The post-commit transport-loss seam: the `/log` transaction **commits**, then the handler drops the response socket instead of writing a body — the client sees a network error over a durable write, which is the one case a retry must resolve by replay rather than by writing again |

It is **forced to `off` whenever `NODE_ENV` is `production`**, and that check
runs before the value is validated, so a stray or misspelled value in production
is ignored rather than failing startup. Outside production an unrecognised value
fails startup loudly instead of being coerced to a working default that hides the
typo. **Never set it in production.**

## Known environment limitations

What was not verified, recorded here rather than left to be assumed:

- **The physical-iPhone checklist is unrun.** A native iOS build, a simulator
  and visual comparison were unavailable in the Linux environment this work was
  done in. Nothing in this document, and no passing JavaScript check, is
  evidence that the native app behaves as described.
- **Android is unverified beyond TypeScript.** There is no Android SDK in that
  environment and the development `google-services.json` the app configuration
  references was not supplied, so compilation past the type check was never
  attempted.
- **The supplied production `DATABASE_URL` was unreachable** from that
  environment (Prisma `P1001` — the host is internal to the deployment
  platform), so everything here was exercised against a local PostgreSQL 16
  instead. That is also why the exact patch level travels with each report
  rather than being assumed.
- **What was exercised, and what was not.** `prisma generate`, `prisma migrate
  deploy`, the three typechecks, `check:test-db` and its refusals, the
  `--confirm-target` and `development_only` refusals, and `npm run dev` with its
  `/health` response were all run as written. A full `catalog:load`,
  `recipes:seed` and `search:benchmark` were **not** run end to end here — only
  their guard paths — so treat their step descriptions as the contract they
  implement rather than as a recorded measurement. `search:benchmark`'s numbers
  only ever mean something for the environment and release that produced them.
- **The mobile repository's `npm ci` fails** with a pre-existing `ERESOLVE`
  (`jest-expo`'s peer range against the installed React Native), and needs
  `npm ci --legacy-peer-deps`. That is documented, not fixed: changing either
  version would be a framework upgrade, which this work does not do.
