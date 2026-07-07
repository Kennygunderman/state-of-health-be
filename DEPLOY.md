# Deploying state-of-health-be

Target state: **merge to `main` → prod auto-deploys; push to `dev` → dev API
auto-deploys.** Coolify on the VPS is the deploy engine (builds the
Dockerfile, injects env vars, health-checks `/health`, handles TLS); GitHub
Actions runs CI (typecheck, tests, prisma validate, docker build) on every
push/PR. Full background: `../INFRA_PLAN.md`.

## How deploys work once set up

- Container boot runs `prisma migrate deploy && node dist/server.js` — pending
  migrations in `prisma/migrations/` apply automatically on every deploy.
- New schema change flow: edit `schema.prisma` → `npx prisma migrate dev
  --name <change>` against your local/dev DB → commit the generated migration
  folder → push. That's it; deploys apply it everywhere else.
- `prisma/manual-migrations/` is the pre-pipeline, hand-applied SQL — kept for
  reference only, never run by tooling.
- `GET /health` returns `{ status: 'ok', version: <git sha> }`; Coolify and
  uptime monitoring both use it.

## One-time VPS setup (in order)

### 0. Before anything: firewall + backup (2 min)

```sh
pg_dump state_of_health > ~/soh-backup-$(date +%F).sql
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw enable
```

Ports 3000 and 5432 are currently open to the internet (see INFRA_PLAN
security findings). For direct DB access from home afterwards, use an SSH
tunnel: `ssh -L 5432:localhost:5432 kenny@31.97.139.7`.

### 1. Install Coolify

```sh
curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash
```

VPS has 8GB RAM — plenty. Coolify UI comes up on port 8000 (allow it in ufw
or reach it via SSH tunnel; tunnel is safer).

### 2. Baseline the prod database (critical, one-time)

The migration history starts from `20260706000000_init`, generated from the
current `schema.prisma`. Prod already has (most of) these tables, so the init
migration must be marked as applied — otherwise the first deploy tries to
re-create every table and fails.

From your machine (SSH tunnel to prod Postgres):

```sh
DATABASE_URL=postgresql://...localhost:5432/state_of_health \
  npx prisma migrate resolve --applied 20260706000000_init
```

Sanity check: `npx prisma migrate status` should report "Database schema is
up to date".

Note: the shelved `coach-tdee-shelved` branch changes the schema via
hand-written SQL that was never applied to prod. When reviving it, convert
those changes into a real migration (`npx prisma migrate dev --name coach`)
on top of this baseline before merging.

Do the same against the dev DB later, or just let migrate deploy build it
from scratch (fresh DB needs no resolve — the init migration creates
everything).

### 3. Production app in Coolify

- Project `state-of-health`, environments `production` + `dev`.
- Add the GitHub App integration → select `Kennygunderman/state-of-health-be`.
- Production app: branch `main`, **Build Pack: Dockerfile**, port 3000,
  domain `stateofhealthapi.com`, health check path `/health`.
- Env vars (Settings → Environment Variables, marked as build-time not
  needed — all runtime):
  - `DATABASE_URL` → the Coolify-managed prod Postgres (step 4)
  - `USDA_API_KEY`, `OPENROUTER_API_KEY` → copy from current `/…/.env` on VPS
  - `FIREBASE_SERVICE_ACCOUNT` → `base64 -i serviceAccountKey.json | pbcopy`

### 4. Databases + backups

- Create Coolify Postgres resources `soh-prod` and `soh-dev`.
- Migrate data: `pg_dump state_of_health | psql <soh-prod connection>`.
- Enable Coolify scheduled backups on `soh-prod` (there are currently NO
  backups anywhere).
- Keep the old system Postgres untouched until cutover is verified.

### 5. Cutover

1. Deploy the app in Coolify while nginx still owns the domain — verify via
   the container logs + `curl <coolify preview url>/health`.
2. Stop nginx + pm2 app (`pm2 stop state-of-health`), let Coolify's proxy
   take 80/443, re-check `https://stateofhealthapi.com/health`.
3. Verify from the iOS app (login, log a meal, weigh-in).
4. After a quiet day or two: `pm2 delete state-of-health`, disable certbot
   timer, drop the old DB, rotate the VPS root password, set
   `PasswordAuthentication no`.

### 6. Dev environment

- `git checkout -b dev && git push -u origin dev`
- DNS: A record `dev.stateofhealthapi.com` → 31.97.139.7.
- Second Coolify app: branch `dev`, domain `dev.stateofhealthapi.com`, same
  env vars except `DATABASE_URL` → `soh-dev`.

## Day-to-day after setup

```
feature work → push to dev → dev API auto-deploys → test
merge dev → main (PR, CI green) → prod auto-deploys, migrations included
```

Rollback = redeploy the previous commit from Coolify's deployments list
(migrations don't auto-revert; write a follow-up migration instead).

Optional hardening once comfortable: GitHub branch protection on `main`
requiring CI, and switch Coolify to deploy via webhook from a final CI step
so a red build can never deploy.
