// The recipe seed: publishes the curated recipe files as versioned recipes.
//
// WHAT THE STAGE DOES. It reads every data/meal-planning/recipes/*.json file,
// resolves each ingredient by the catalog food's stable `source_key` to a
// published, source-backed, allergen-known row with a default gram weight,
// derives the recipe's nutrition, tags, badges and budget tier from that
// ingredient set through src/services/recipe.logic.ts, and fails a file whose
// declared values disagree with the derivation or whose `instructions` name an
// ingredient-vocabulary term its ingredient list does not carry. It is
// idempotent by `slug`: an unchanged recipe is a no-op, while changed content
// or a stale ingredient snapshot publishes a NEW `recipe_versions` row as
// `current`, retires the previous one and moves `recipes.current_version_id` —
// all in one transaction, because a recipe with two current versions or none is
// unplannable. It then derives the diet x allergen x slot x time coverage
// report FROM THE DATABASE and writes it to
// data/meal-planning/recipes/coverage-report.json (Agent Action Plan §0.7.1
// Group 4, §0.7.3).
//
// A CERTIFIED COVERAGE CELL IS A PLANNABLE ONE, NOT MERELY A POPULATED ONE.
// That report's guaranteed and reduced lists are gated on TOLERANCE
// SATISFIABILITY as well as on eligible counts: a cell is certified only when a
// day the planner would accept exists at every sampled calorie target on every
// schedule its slot belongs to, and when enough distinct recipes are usable in
// such a day to fill a week under the repeat rule. A cell §0.7.3 claims that
// fails either test is DEMOTED to `eligibleNotPlannableCells` with the reason
// that refused it. Counting alone certified the vegan cells of an earlier
// corpus — four eligible breakfasts, six lunches, eight dinners — while no
// vegan day anywhere in the calorie band could reach its protein target, so
// every vegan user was refused by a profile the artefact called guaranteed. See
// THE FEASIBILITY GATE beside the derivation.
//
// TWO PASSES, AND THE ORDER MATTERS. Every selected file is parsed, resolved
// and validated BEFORE the first write, and any single failure refuses the whole
// run. A partially seeded corpus is worse than an unseeded one: the planner's
// coverage check would answer from an incomplete set and the committed coverage
// report would describe recipes that are not there.
//
// THE CATALOG MUST NOT MOVE WHILE THIS STAGE PUBLISHES, AND IT IS HELD SHUT
// TWICE. A new `recipe_versions` row cites catalog facts — the per-100 g
// snapshot, the name, the provenance, the allergen and diet tag arrays and both
// version counters — that were read before the transaction it is written in. If
// a `catalog-load` retires that food, re-judges it or moves either counter in
// between, the row that publishes is a plannable recipe built on facts that no
// longer hold, which §0.7.3 forbids. So:
//
//   1. the WHOLE run is wrapped in the catalog graph's stage lock, taken SHARED
//      (see THE BORROWED READER STAGE below), from before the first catalog read
//      through every promotion to the coverage read the report is derived from;
//      and
//   2. every publishing transaction RE-READS its recipe's ingredient rows under
//      `SELECT … FOR SHARE` immediately before it writes, and refuses the
//      publication if any of them is no longer publishable or has moved
//      (`assertIngredientFactsHold`).
//
// Neither half is redundant. The lock keeps an exclusive mutator out for the
// whole run, which the per-transaction check alone cannot do — it would only
// notice drift recipe by recipe, after earlier recipes had already published
// against the older facts. The check covers what the lock cannot: a writer that
// does not take the lock at all, and a caller that injected its own lock seam.
//
// ONE RECIPE-SEED WRITER, AND WHY THE GRAPH HOLD CANNOT BE IT. The graph hold
// above is SHARED, which is the correct mode for a stage that only READS the
// catalog — and it is therefore compatible with itself, so two seeds both take
// it and neither notices the other. Two seeds are not harmless: they write the
// same `recipes`, `recipe_versions` and `recipe_ingredients` rows, they publish
// in separate per-recipe transactions, and they race the whole-corpus coverage
// report, so an interleaving can leave a corpus assembled from two different
// revisions of the files and a committed report that describes neither. The
// run ledger's lease cannot separate them either: its key carries the CORPUS
// FINGERPRINT (see THE RUN LEDGER), so two different corpus revisions address
// two different rows, and an `--only`-narrowed run claims no row at all.
//
// So the stage takes a SECOND lock of its own — the RECIPE-SEED WRITER LOCK
// (see runUnderWriterHold) — exclusive, session-scoped, on its own connection,
// keyed on a CONSTANT that names no corpus and no fingerprint, and held for the
// whole lifetime of every non-dry publication INCLUDING a narrowed one. It is
// additional to the graph hold and never a replacement for it: the graph hold
// is what keeps a catalog MUTATOR out, and the writer lock is what keeps a
// second RECIPE SEED out. A dry run takes neither the writer lock nor a ledger
// row, because it publishes nothing there is anything to own.
//
// ONE RUN ROW, AND WHY THIS STAGE KEEPS ONE. The corpus publishes one
// transaction per recipe, so an interruption after recipe twenty of forty-two
// leaves a half-promoted corpus. Without a ledger row nothing records that: no
// terminal status, no counts, no cursor, and a committed coverage report that
// may describe a different corpus. The stage therefore claims a
// `catalog_import_runs` row of its own (see THE RUN LEDGER) keyed on a
// fingerprint of the corpus it selected, records what it settles as it goes, and
// closes `succeeded` or `failed` — never silently.
//
// AND WHY THE ROW ALSO CARRIES A FENCE. A session lock dies with its session,
// which is exactly the property that makes it safe — but it is also what leaves
// one residue: a process whose LOCK SESSION died while the process itself lived
// on (a network drop, a host suspension, a query that returned after an age)
// still holds a live Prisma pool and can still write. The lock cannot stop that
// process, because it no longer holds the lock; the run row is what stops it.
// Every claim and every takeover stamps an unguessable ATTEMPT TOKEN into the
// run's cursor, and every write this stage makes against that run — each recipe
// publication, each cursor update, the coverage report and the terminal close —
// re-reads the row under `SELECT … FOR UPDATE` in the SAME transaction as the
// write and refuses (`run_attempt_superseded`) when the stored token is no
// longer its own (see assertAttemptOwnsRun). A superseded attempt's write is
// therefore rejected rather than merely improbable, which is what
// lib/checkpoint.ts asks of the layer above it: its own row lock serialises two
// live writers into last-write-wins and states, at writeCursorToRun, that
// lifetime ownership has to be enforced here.
//
// WHAT THE FENCE DOES NOT COVER, STATED SO IT IS NOT MISTAKEN FOR COVERED. An
// `--only`-narrowed run claims no ledger row (see THE CLAIM), so it has nothing
// to be fenced BY: its exclusivity is the writer lock and only the writer lock.
// That is the correct trade rather than a gap left open — claiming a whole-corpus
// row for a narrowed run would let one slug's cursor and counts describe a
// corpus nobody reconciled, and would block the real seed through the lease —
// and it costs nothing against the two races that matter, because a narrowed
// run publishes no coverage report and closes no run row. A narrowed writer
// beside any other live writer is refused by the lock; only a narrowed writer
// whose own lock session died mid-run is unfenced, and what it can then do is
// republish the one slug it was already publishing, idempotently, by slug.
//
// NOTHING IS DERIVED TWICE. `total_minutes`, the four `per_serving_*` values,
// `sourced_calories_note`, `diet_tags`, `allergen_tags`, `allergen_status`,
// `badges`, `budget_tier` and `nutrition_provenance` are all read from
// `recipe.logic.ts`'s derivation and none of them from the file — the file's
// declarations are only ever COMPARED against it (§0.7.3: a file cannot talk
// its way to a "Gluten free" badge). `meal_slots` is the one list the file
// owns, because which meals a dish belongs to is not derivable from its
// ingredients. This file therefore computes no tag, badge, total, provenance or
// tier of its own; what it does own is the two rules that need the recipe
// DIRECTORY and the CATALOG rather than one ingredient set — the
// instruction-completeness check and the coverage matrix — and neither belongs
// in a pure module that may not read `scripts/` or `data/`.
//
// THE CONFIRMATION DOOR IS NOT THIS FILE'S. `recipes-seed` is
// `development_or_confirmed` in scripts/lib/dbGuard.ts: against anything other
// than a development origin the guard demands `--confirm-target <dbname>` at
// module load, before this file's own code runs. The flag is documented in the
// usage block and accepted by the parser, but it is read from process.argv by
// the guard and never interpreted here — one owner for one rule.
//
// The two guard imports are ordered and load-bearing: Rule
// backend-architecture §10's IPv4-first DNS ordering, then that module-load
// classification, both ahead of anything that could reach Prisma or the network.
import './lib/bootstrap';
import './lib/dbGuard';

// Node's own hashing, for the corpus fingerprint the run row is addressed by
// (see THE RUN LEDGER), and its CSPRNG for the attempt token an attempt is
// fenced by (see assertAttemptOwnsRun). Nothing here hashes a secret: the digest
// is taken over the bytes of the committed recipe files, which are reviewed
// content.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

// THE BORROWED READER STAGE, and why this stage adds no stage name of its own.
//
// lib/checkpoint.ts holds ONE advisory lock name for the whole catalog graph;
// the `stage` argument selects the mode and labels the holder in
// pg_stat_activity. `CATALOG_STAGE_LOCK_MODES` in scripts/lib/checkpoint.ts is
// that table: the four MUTATING stages — the `CatalogRunKind` values
// `usda_import`, `ai_generation`, `validation` and `release_load` — take the
// lock EXCLUSIVELY, and the two READ-ONLY labels take it SHARED: `release`, the
// export, and `benchmark`, the search-acceptance measurement in
// scripts/search-benchmark.ts. A shared hold is refused exactly while a mutator
// holds it, and that is the guarantee this stage needs: it reads the whole
// catalog graph and writes only recipe tables, so two seeds, or a seed beside
// an export or a benchmark run, are harmless, while a seed beside an import, a
// generation pass, a validation pass or a release load is the defect.
//
// Of those two read-only labels this stage borrows `release`, and it borrows
// rather than extends. Adding a name is a change to `CATALOG_STAGE_LOCK_MODES`
// — whose exhaustive key set is asserted in
// src/__tests__/scripts/catalog-import.test.ts — and not a change to this file;
// `release` is the existing shared label whose semantics already match this
// stage, which reads the whole graph and writes only outside it; and
// `benchmark` labels the acceptance-evidence measurement run, which a seed is
// not. The mode is passed explicitly all the same, so this stage's hold stays
// shared even if that table were ever re-keyed. What this paragraph claims
// about that table — two read-only labels, both shared, and the four run kinds
// exclusive — is asserted in src/__tests__/scripts/recipes-seed.test.ts against
// the table itself, so it cannot drift from it again.
//
// THE RUN LEDGER. The claim is written here rather than through
// checkpoint.ts's `openOrResumeRun`, for the reason that module states about
// catalog-release.ts: `CatalogRunKind` is closed over the four stages that
// resume THROUGH it, `catalog_import_runs.kind` is TEXT with no CHECK
// constraint, `toCatalogRun` preserves any other value it meets, and every
// ledger reader filters by kind — so `recipe_seed` needs no migration and is
// inert for all of them. What this file does NOT re-implement is the ledger's
// locked read-modify-write: `saveCursor` and `finishRun` are keyed by run id and
// are kind-agnostic, so the cursor, the terminal counts and the guarded close
// are that module's, exactly as they are for the other stages.
//
// Deliberately NOT imported: lib/budget and lib/rateLimiter. This stage makes no
// vendor call, so it meters no model budget and paces no request, and those
// modules' error classes are unreachable here. Importing them to classify a
// failure that cannot happen would tell a reader this stage can exhaust a model
// budget, which it cannot.
import { CheckpointError, RUN_STATUS_SUCCEEDED, appendRunLog, checkpointErrorFields, finishRun, saveCursor, withCatalogStageLock } from './lib/checkpoint';
import type {
    CatalogRunDb,
    CatalogStageLockConnection,
    CatalogStageLockMode,
    CatalogStageName,
} from './lib/checkpoint';
import { classifyDatabaseOrigin, DatabaseOriginError, originLogFields } from './lib/dbGuard';
import {
    UNEXPECTED_FAILURE_REMEDY,
    classifyInfrastructureFailure,
    createFatalLogger,
    createLogger,
    firstPartyMessage,
    formatSafeError,
    isThrownInstanceOf,
    safeError,
    writeLineSync,
} from './lib/logger';
import type { LogFields, LogLevel, SafeErrorFields, ScriptLogger } from './lib/logger';
import { loadCoveragePlan, ManifestError, recipesDir, writeJsonFile } from './lib/manifest';
import type { CoveragePlan } from './lib/manifest';
// The pure derivation layer. Every rule this stage applies to an ingredient set
// comes from here, and this file adds none of its own (see the header).
import { normalizeCanonicalName } from '../src/services/catalog.logic';
// The PLANNING rules, for the feasibility half of the coverage report (see THE
// FEASIBILITY GATE). Every tolerance band, portion multiplier, repetition limit
// and macro split the gate turns on is imported from here rather than restated:
// a second copy of any of them inside this script is exactly the drift the
// report exists to detect.
import {
    buildPlanCandidates,
    CALORIE_TOLERANCE_RATIO,
    candidatesForSlot,
    evaluateDayTolerance,
    MACRO_TOLERANCE_ABSOLUTE_G,
    MACRO_TOLERANCE_RATIO,
    MAX_RECIPE_USES_PER_WEEK,
    PLAN_DAY_COUNT,
    PROTEIN_TOLERANCE_OVER_G,
    PROTEIN_TOLERANCE_UNDER_G,
    scheduleSlots,
    TOLERANCE_EPSILON,
} from '../src/services/mealPlan.logic';
import type { PlanCandidate, PlanRecipeCandidate } from '../src/services/mealPlan.logic';
import {
    deriveDietTags,
    findStaleIngredients,
    isEligibleForPlanning,
    RecipeDerivationError,
    validateRecipeDeclaration,
} from '../src/services/recipe.logic';
import type {
    CatalogIngredientVersions,
    PlanningPreferences,
    PlanningRecipeVersion,
    RecipeAllergenStatus,
    RecipeDietPreference,
    RecipeIngredientNutrientSnapshot,
    RecipeIngredientSnapshot,
    RecipeNutritionBasis,
    RecipePublicationIngredient,
} from '../src/services/recipe.logic';
import { deriveMacroTargets } from '../src/services/targets.logic';
import type { MealPlanMacroTotals, MealSchedule } from '../src/types/mealPlanning';
import { MEAL_SLOTS } from '../src/types/recipe';
import type { MealSlot, RecipePerServingNutrition } from '../src/types/recipe';
import { UnitConversionError } from '../src/utils/units';

const STAGE = 'recipes-seed';

const RECIPE_LOGIC_MODULE = 'src/services/recipe.logic.ts';

const RECIPE_FILE_EXTENSION = '.json';

/**
 * This stage's OUTPUT, and the one file in the recipe directory that is not a
 * recipe — so every reader of the directory skips it by name.
 */
const COVERAGE_REPORT_FILE = 'coverage-report.json';

/** The only `catalog_foods.publication_status` a NEW recipe version may cite. */
const PUBLISHED_STATUS = 'published';

/** The only `nutrition_provenance` planning admits, on the recipe and on every ingredient. */
const SOURCE_BACKED_PROVENANCE = 'source_backed';

/** The only `allergen_status` a plannable ingredient may carry. */
const KNOWN_ALLERGEN_STATUS = 'known';

const CURRENT_VERSION_STATUS = 'current';
const RETIRED_VERSION_STATUS = 'retired';

/** The version number a first publication writes. */
const FIRST_VERSION = 1;

/**
 * The ceiling on one publish transaction, stated here rather than left to the
 * client default (5 s) that another stage might change.
 *
 * A publication writes one version plus up to a dozen ingredient rows, so the
 * work itself needs milliseconds; the generous ceiling is for the host rather
 * than the statement — this stage runs on a developer machine or a CI runner
 * shared with dozens of other jobs, and a transaction aborted by a scheduling
 * stall would report a seed failure that says nothing about the corpus. The
 * per-recipe transaction is still short-lived: it is one of forty-two, each
 * opened and closed in turn, never one transaction around the whole run.
 */
const PUBLISH_TRANSACTION_TIMEOUT_MS = 30_000;

/**
 * The stage name this run's catalog hold is labelled with, and the mode it is
 * taken in — `release`, one of the two read-only labels in
 * `CATALOG_STAGE_LOCK_MODES`, borrowed (see the header's THE BORROWED READER
 * STAGE for why this stage borrows that label instead of adding one, which
 * would be a checkpoint.ts change and not a change to this file).
 *
 * Exported for src/__tests__/scripts/recipes-seed.test.ts, which checks this
 * pair against that table rather than against the same two strings written
 * twice.
 */
export const CATALOG_READER_STAGE: CatalogStageName = 'release';
export const CATALOG_READER_STAGE_MODE: CatalogStageLockMode = 'shared';

/**
 * THE RECIPE-SEED WRITER LOCK'S KEYSPACE, and why it is neither of the two
 * spaces this system already uses.
 *
 * PostgreSQL documents the one-argument (bigint) and two-argument (int, int)
 * advisory spaces as DISTINCT — a lock taken as `pg_advisory_lock(k)` never
 * conflicts with one taken as `pg_advisory_lock(c, k)` — and lib/checkpoint.ts
 * records what already lives in each:
 *
 *  - the ONE-argument space over `hashtext(...)` carries the request path's
 *    per-user meal-planning lock (`hashtext('meal-planning:' || userId)`, Agent
 *    Action Plan §0.5.1 "Lock first") and this file's own run-claim lock
 *    (`hashtext('catalog-run:<kind>:<version>')`). `hashtext` narrows to 32
 *    bits, so two unrelated names CAN collide. For a transaction-scoped lock
 *    that costs milliseconds of waiting; for a lock held on a SESSION for the
 *    whole duration of a stage — which is what this one is — a collision would
 *    block a user's meal-planning request for that entire duration, which is an
 *    outage rather than a delay. That rules the one-argument space out.
 *  - the TWO-argument space under class id `0x434154` ('CAT') carries
 *    lib/checkpoint.ts's catalog-graph stage lock, and that module states that
 *    every catalog stage uses it "and nothing outside this file does". Reusing
 *    it would make this lock contend with stages it has nothing to do with: a
 *    seed would then refuse because an import held the same key, which is
 *    already what the SHARED graph hold expresses correctly and separately.
 *
 * So this lock takes the two-argument space under a class id of its OWN. The
 * value is the ASCII bytes of 'RSD' (recipe seed) — an arbitrary but fixed and
 * documented constant, which is all a class id has to be, chosen the same way
 * 'CAT' was. One name lives under it, so nothing inside the class can collide
 * either.
 */
const RECIPE_SEED_WRITER_LOCK_CLASS_ID = 0x525344;

/**
 * ONE NAME FOR EVERY RECIPE-SEED WRITER, carrying no corpus and no fingerprint.
 *
 * That is the whole point: exclusivity is a property of the RECIPE TABLES, not
 * of a corpus revision. Keying this on the fingerprint — the way the run claim
 * is — would let two different revisions of the files, or an `--only`-narrowed
 * writer beside a whole-corpus one, publish overlapping slugs at the same time,
 * which is exactly the pair this lock exists to separate.
 */
const RECIPE_SEED_WRITER_LOCK_NAME = 'recipe-seed-writer';

/** Ten seconds: a writer lock that cannot reach the database should say so, not hang. */
const WRITER_LOCK_CONNECT_TIMEOUT_MS = 10_000;

/** The lock statements are single function calls; anything slower is a database in trouble. */
const WRITER_LOCK_QUERY_TIMEOUT_MS = 30_000;

/**
 * Names this connection in pg_stat_activity, so an operator who finds the seed
 * refused can attribute the hold to a recipe seed rather than to an anonymous
 * idle session. Distinct from lib/checkpoint.ts's `soh-catalog-stage-lock` for
 * the same reason the class id is: the two holds answer different questions.
 */
const WRITER_LOCK_APPLICATION_NAME = 'soh-recipe-seed-writer-lock';

/**
 * This stage's `catalog_import_runs.kind`.
 *
 * Outside `CatalogRunKind` by design, the way catalog-release.ts's `'release'`
 * is: the column is TEXT with no CHECK constraint, every ledger reader filters
 * by kind, and nothing else in the pipeline claims this value.
 */
export const RECIPE_SEED_RUN_KIND = 'recipe_seed';

/** `catalog_import_runs.status` while a run owns the corpus. */
const RUN_STATUS_RUNNING = 'running';

/**
 * How long a claimed run stays LIVE without a heartbeat, and — since the writer
 * lock landed — how long an interrupted run row stays un-resumable.
 *
 * WHAT THIS IS NOT. It is NOT what separates two seeds; the RECIPE-SEED WRITER
 * LOCK is (see the header's ONE RECIPE-SEED WRITER). The lease cannot be: its
 * row is addressed by the corpus fingerprint, so two different revisions of the
 * files never meet on it at all, and an `--only`-narrowed run claims no row for
 * it to be stored on. A previous revision of this comment claimed the lease was
 * "the whole of this stage's mutual exclusion between two seeds" — it was
 * wrong, and the code above it is why the claim is not re-added.
 *
 * WHAT IT IS. The recovery clock for the ONE exit that leaves a row `running`:
 * the process died, so nothing closed it. A live holder keeps the session-scoped
 * writer lock, so while it lives no second invocation reaches the claim at all
 * and no takeover can happen; the lease is read only by an invocation that
 * ALREADY took the writer lock, i.e. one for which the previous holder's session
 * is provably gone. A lease still in the future then means "that process may
 * only just have died, and its last publications are still settling", and the
 * run is refused (`seed_in_progress`); once it has lapsed the row is taken over,
 * its attempt token is rotated, and the dead attempt is fenced out for good.
 *
 * Two minutes is four times the ceiling on one publish transaction
 * (PUBLISH_TRANSACTION_TIMEOUT_MS), which is the longest a healthy run can go
 * between heartbeats, and it is also how long an operator waits after a `kill
 * -9` before the corpus can be seeded again. Both halves of that trade are why
 * it is neither seconds nor an hour.
 */
export const RECIPE_SEED_RUN_LEASE_MS = 120_000;

const logger = createLogger(STAGE);

/* ---------------------------------------------------------------------------
 * Errors — §8: a typed error carrying the data the caller must report
 * ------------------------------------------------------------------------- */

/**
 * Why the seed refused.
 *
 *  - `recipes_unreadable` — the recipe directory or one of its files could not
 *    be read at all, which is an environment or input fault rather than a
 *    content one.
 *  - `unknown_slug` — `--only`/`--slug` named a recipe with no file, so the run
 *    would silently seed nothing and report success.
 *  - `recipes_invalid` — at least one selected file is not publishable: a
 *    malformed payload, an ingredient that does not resolve or is not
 *    publishable, a declaration the derivation contradicts, or an instruction
 *    naming an unlisted ingredient. Every problem found across every file
 *    travels on the error, because an operator fixing the corpus wants all of
 *    them and not the first.
 *  - `publication_failed` — the validated set was refused by the database. The
 *    per-slug transaction means nothing partial survives it.
 *  - `catalog_locked` — another catalog pipeline stage holds the graph
 *    exclusively, so this run cannot read a catalog that will still be the
 *    catalog when it publishes. Refused before any write, and retryable as soon
 *    as the other stage finishes.
 *  - `catalog_drifted` — an ingredient's catalog row stopped being publishable,
 *    or moved one of its version counters, between the validation pass and the
 *    transaction that was about to cite it. Refused rather than published,
 *    because a plannable recipe may not rest on a retired, non-source-backed or
 *    allergen-unknown ingredient (§0.7.3), and the recipe already published
 *    before it keeps its own committed transaction.
 *  - `seed_in_progress` — a live run of this same corpus already holds the
 *    stage's run row, so publishing beside it would interleave two corpora's
 *    decisions into one ledger.
 *  - `seed_writer_locked` — ANOTHER RECIPE SEED is publishing right now. A
 *    different situation from `catalog_locked` and a different remedy: nothing
 *    is wrong with the catalog, and the operator is waiting for a seed rather
 *    than for an import, a generation pass, a validation pass or a release load.
 *    Refused before any read or write, and retryable the moment the other seed
 *    finishes or its process dies (the lock is session-scoped, so death releases
 *    it with no operator action).
 *  - `seed_writer_lock_unavailable` — the writer lock could not be attempted at
 *    all because no `DATABASE_URL` is resolvable. dbGuard normally refuses that
 *    at module load, so reaching this means a caller bypassed it; refused rather
 *    than publishing with no writer exclusion (§9 — config behind an accessor
 *    that fails loudly).
 *  - `run_attempt_superseded` — this attempt no longer owns its run row: the row
 *    is gone, has been closed, or carries another attempt's token because a
 *    later invocation took the run over after this one's lock session died. The
 *    write is refused rather than landing on a run someone else is finishing
 *    (see assertAttemptOwnsRun).
 *  - `run_ledger_unavailable` — the caller injected a publication client that
 *    cannot reach `catalog_import_runs` and no separate ledger client, so the
 *    run could not be recorded. Refused rather than publishing unrecorded work.
 */
export type RecipeSeedErrorCode =
    | 'recipes_unreadable'
    | 'unknown_slug'
    | 'recipes_invalid'
    | 'publication_failed'
    | 'catalog_locked'
    | 'catalog_drifted'
    | 'seed_in_progress'
    | 'seed_writer_locked'
    | 'seed_writer_lock_unavailable'
    | 'run_attempt_superseded'
    | 'run_ledger_unavailable';

/**
 * The stage's own failure class.
 *
 * `problems` is the list an operator acts on, one entry per defect, each already
 * naming the recipe slug, its file and — where an ingredient explains the
 * defect — that ingredient's `source_key` or snapshot name. The message is the
 * same list rendered for a terminal, so a caller that only logs the message
 * still reports every defect.
 */
export class RecipeSeedError extends Error {
    constructor(
        public readonly code: RecipeSeedErrorCode,
        message: string,
        public readonly problems: readonly string[] = [],
    ) {
        super(problems.length === 0 ? message : `${message}\n  - ${problems.join('\n  - ')}`);
        this.name = 'RecipeSeedError';
    }
}

/* ---------------------------------------------------------------------------
 * Argument parsing — pure (Rule backend-architecture §1.2).
 * ------------------------------------------------------------------------- */

export interface SeedOptions {
    readonly help: boolean;
    /**
     * `--only`, repeatable, with `--slug` as an alias. Empty means every recipe
     * file in the directory. A narrowed run never writes the coverage report:
     * the report is a claim about the WHOLE corpus, and publishing one recipe's
     * view of it would overwrite the committed artefact with partial numbers.
     */
    readonly only: readonly string[];
    /** Validate everything, write nothing — neither a row nor the report. */
    readonly dryRun: boolean;
}

export interface ArgumentError {
    readonly flag: string;
    readonly message: string;
}

export type ParseResult =
    | { readonly ok: true; readonly options: SeedOptions }
    | { readonly ok: false; readonly errors: readonly ArgumentError[] };

export interface PrerequisiteGap {
    readonly code: string;
    readonly requirement: string;
    readonly remedy: string;
    readonly detail?: string;
}

const HELP_FLAGS: readonly string[] = ['--help', '-h'];

/** The canonical narrowing flag, and the alias the file schema's contract names. */
const ONLY_FLAG = '--only';
const SLUG_FLAG = '--slug';

const DRY_RUN_FLAG = '--dry-run';

// Owned by scripts/lib/dbGuard.ts (see the header): consumed with its value so
// it is not mistaken for a positional argument, and deliberately not
// interpreted here.
const CONFIRM_TARGET_FLAG = '--confirm-target';

interface Token {
    readonly flag: string;
    readonly inlineValue: string | null;
}

const splitToken = (token: string): Token => {
    const separator = token.indexOf('=');
    if (!token.startsWith('--') || separator < 0) {
        return { flag: token, inlineValue: null };
    }
    return { flag: token.slice(0, separator), inlineValue: token.slice(separator + 1) };
};

export const parseArgs = (argv: readonly string[]): ParseResult => {
    if (argv.some((token) => HELP_FLAGS.includes(token))) {
        return { ok: true, options: { help: true, only: [], dryRun: false } };
    }

    const errors: ArgumentError[] = [];
    const only: string[] = [];
    let dryRun = false;

    let index = 0;
    const takeValue = (inlineValue: string | null): string | null => {
        if (inlineValue !== null) {
            return inlineValue.length > 0 ? inlineValue : null;
        }
        const next = index < argv.length ? argv[index] : null;
        if (next === null || next.length === 0 || next.startsWith('-')) {
            return null;
        }
        index += 1;
        return next;
    };

    while (index < argv.length) {
        const { flag, inlineValue } = splitToken(argv[index]);
        index += 1;

        if (flag === ONLY_FLAG || flag === SLUG_FLAG) {
            const value = takeValue(inlineValue);
            if (value === null) {
                errors.push({ flag, message: `${flag} requires a recipe slug` });
                continue;
            }
            // Deduplicated rather than repeated: `--only x --only x` names one
            // recipe, and a duplicate would otherwise publish it twice in one
            // run — the second pass seeing content it had just written.
            if (!only.includes(value)) {
                only.push(value);
            }
            continue;
        }

        if (flag === DRY_RUN_FLAG) {
            dryRun = true;
            continue;
        }

        if (flag === CONFIRM_TARGET_FLAG) {
            takeValue(inlineValue);
            continue;
        }

        errors.push({ flag, message: `${flag} is not a flag ${STAGE} accepts` });
    }

    if (errors.length > 0) {
        return { ok: false, errors };
    }

    return { ok: true, options: { help: false, only, dryRun } };
};

// ---------------------------------------------------------------------------
// Usage.
// ---------------------------------------------------------------------------

export const describeUsage = (): string =>
    [
        `Usage: npm run recipes:seed -- [options]   (${STAGE})`,
        '',
        'Publishes data/meal-planning/recipes/*.json as versioned recipes, resolving',
        'every ingredient against the loaded catalog by source_key. Idempotent by slug:',
        'an unchanged recipe is a no-op, while changed content or a stale ingredient',
        'snapshot publishes a new version, retires the previous one and moves',
        'recipes.current_version_id in one transaction. Every selected file is validated',
        'before the first write, so one bad file publishes nothing at all.',
        '',
        'Options:',
        '  --only <slug>               Seed just this recipe slug. Repeatable.',
        '                              Default: every file in the recipes directory.',
        '                              A narrowed run does not write the coverage report,',
        '                              which is a claim about the whole corpus.',
        '  --slug <slug>               Alias for --only.',
        '  --dry-run                   Parse, resolve and validate everything, then stop.',
        '                              No row and no report is written on any path.',
        '  --confirm-target <dbname>   Required by scripts/lib/dbGuard.ts, which owns',
        '                              this flag, unless the database\'s own NAME says',
        '                              development — a _dev suffix, with or without a',
        '                              clone index, on a local host: it must name that',
        '                              URL\'s database exactly. Without it the guard',
        '                              refuses the run at module load with',
        '                              code "confirmation_required". A local database',
        '                              named anything else is development by its host',
        '                              alone, and needs the flag like a test or shadow',
        '                              one; a remote host is unrecognised and no flag',
        '                              reaches it.',
        '  --help, -h                  Print this usage block and exit 0.',
        '',
        'Inputs read:',
        '  data/meal-planning/recipes/*.json   one file per recipe, each ingredient',
        '                                      referencing a catalog food by source_key',
        '  data/meal-planning/coverage-plan.v1.json',
        '                                      the food-group vocabulary the',
        '                                      instruction-completeness check uses',
        '  src/services/recipe.logic.ts        nutrition derivation, tag derivation and',
        '                                      the eligibility rules',
        '',
        'Output written:',
        `  data/meal-planning/recipes/${COVERAGE_REPORT_FILE}`,
        '                                      the diet x allergen x slot x time coverage',
        '                                      table, derived from the seeded rows. Stable',
        '                                      and byte-identical on a no-op rerun.',
        `  catalog_import_runs (kind "${RECIPE_SEED_RUN_KIND}")`,
        '                                      one run row per whole-corpus attempt, keyed on',
        '                                      a fingerprint of the coverage plan version and',
        '                                      the selected files\' bytes. It carries the slug',
        '                                      watermark and the decisions as a cursor, the',
        '                                      committed counts, and a terminal succeeded or',
        '                                      failed status — so an interrupted seed is',
        '                                      visible and resumable. A dry run and an --only',
        '                                      run claim none.',
        '',
        'Concurrency:',
        '  The whole run holds the catalog graph\'s stage lock in SHARED mode, so it is',
        '  refused while an import, a generation pass, a validation pass or a release',
        '  load is rewriting the catalog this corpus resolves against, and every',
        '  publication re-reads and locks its ingredient rows before it writes. Two',
        '  seeds of one corpus do not publish at the same time: the second is refused',
        '  while the first\'s run lease is live, and an abandoned run becomes resumable',
        `  ${RECIPE_SEED_RUN_LEASE_MS / 1000} seconds after its last committed recipe.`,
        '',
        'Environment:',
        '  DATABASE_URL   required; classified by scripts/lib/dbGuard.ts. Ingredients',
        '                 resolve against the catalog loaded in it, so run',
        '                 `npm run catalog:load -- --release <vN>` first. The stage lock',
        '                 and the run ledger are held in the same database.',
    ].join('\n');

const writeUsage = (level: LogLevel): void => {
    writeLineSync(describeUsage(), level);
};

// ---------------------------------------------------------------------------
// Preflight.
// ---------------------------------------------------------------------------

export interface SeedPreflightDeps {
    readonly env: NodeJS.ProcessEnv;
    /** manifest.ts's validated recipes directory, seamed for testability. */
    readonly recipesDir: () => string;
    /**
     * The directory's entries, or `null` when it does not exist. `null` and an
     * empty list are different failures with different remedies, so they are
     * not collapsed.
     */
    readonly listDirectory: (absolutePath: string) => readonly string[] | null;
    /** Repository-relative existence check. */
    readonly fileExists: (repoRelativePath: string) => boolean;
}

const repoFileExists = (repoRelativePath: string): boolean =>
    fs.existsSync(path.resolve(__dirname, '..', repoRelativePath));

const listDirectoryOnDisk = (absolutePath: string): readonly string[] | null => {
    try {
        return fs.readdirSync(absolutePath);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') {
            return null;
        }
        // A permission fault is an environment problem, not a missing input:
        // reporting it as "no recipes directory" would send the operator to the
        // wrong fix, so it reaches main's narrowing catch as itself.
        throw error;
    }
};

const defaultPreflightDeps = (): SeedPreflightDeps => ({
    env: process.env,
    recipesDir,
    listDirectory: listDirectoryOnDisk,
    fileExists: repoFileExists,
});

/**
 * The inputs the seed consumes, checked before a connection is opened.
 *
 * All three are present in this checkout, and this function stays because an
 * input can go missing in a consumer's tree: a partial clone, a stripped
 * container image, or a `data/` directory excluded from a build. Naming the
 * missing input and its remedy is what the operator needs; a Prisma error about
 * an empty result set is not.
 */
export const preflight = (deps: SeedPreflightDeps): readonly PrerequisiteGap[] => {
    const gaps: PrerequisiteGap[] = [];

    const entries = deps.listDirectory(deps.recipesDir());
    if (entries === null) {
        gaps.push({
            code: 'recipes_directory_absent',
            requirement: 'data/meal-planning/recipes/ must exist: it is the seed\'s only source of recipe content',
            remedy: 'Restore data/meal-planning/recipes/ from the repository (42 curated files at this revision, at least 40 per the coverage matrix in AAP §0.7.3).',
        });
    } else {
        const recipeFiles = entries.filter((entry) => isRecipeFileName(entry));
        if (recipeFiles.length === 0) {
            gaps.push({
                code: 'recipes_directory_empty',
                requirement: `data/meal-planning/recipes/ must hold at least one *${RECIPE_FILE_EXTENSION} recipe file`,
                remedy: 'Restore the curated recipe files under data/meal-planning/recipes/ (at least 40, per the coverage matrix in AAP §0.7.3).',
                detail: `the directory exists and holds ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}, none of them a recipe *${RECIPE_FILE_EXTENSION}`,
            });
        }
    }

    if (!deps.fileExists(RECIPE_LOGIC_MODULE)) {
        gaps.push({
            code: 'recipe_logic_absent',
            requirement: `${RECIPE_LOGIC_MODULE} must exist: it derives each recipe's nutrition and tags from its ingredient snapshots and decides what a mismatch means`,
            remedy: `Restore ${RECIPE_LOGIC_MODULE} with its unit suite (AAP §0.7.1 Group 4).`,
        });
    }

    return gaps;
};

/* ---------------------------------------------------------------------------
 * The recipe payload: typed accessors over parsed JSON
 *
 * Every field is read through one of these rather than cast. The files are
 * external data — a hand-authored corpus reviewed as a diff — so a wrong TYPE
 * in one (a string where a DOUBLE PRECISION column waits, a null where the
 * column is NOT NULL) has to be named with its file and field here rather than
 * surfacing from inside Prisma with no slug attached.
 * ------------------------------------------------------------------------- */

const render = (value: unknown): string => (value === undefined ? 'undefined' : String(JSON.stringify(value)));

/** A directory entry that is a recipe: a `*.json` file that is not this stage's own output. */
export const isRecipeFileName = (entry: string): boolean =>
    entry.endsWith(RECIPE_FILE_EXTENSION) && entry !== COVERAGE_REPORT_FILE;

const payloadError = (message: string): RecipeSeedError => new RecipeSeedError('recipes_invalid', message);

const asRecord = (value: unknown, where: string): Record<string, unknown> => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw payloadError(`${where}: expected a JSON object, received ${render(value)}`);
    }

    return value as Record<string, unknown>;
};

const text = (row: Record<string, unknown>, field: string, where: string): string => {
    const value = row[field];
    if (typeof value !== 'string' || value.length === 0) {
        throw payloadError(`${where}: ${field} must be a non-empty string, received ${render(value)}`);
    }

    return value;
};

const decimal = (row: Record<string, unknown>, field: string, where: string): number => {
    const value = row[field];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw payloadError(`${where}: ${field} must be a finite number, received ${render(value)}`);
    }

    return value;
};

const positiveDecimal = (row: Record<string, unknown>, field: string, where: string): number => {
    const value = decimal(row, field, where);
    if (!(value > 0)) {
        throw payloadError(`${where}: ${field} must be greater than zero, received ${render(value)}`);
    }

    return value;
};

const wholeNumber = (row: Record<string, unknown>, field: string, where: string): number => {
    const value = decimal(row, field, where);
    if (!Number.isInteger(value)) {
        throw payloadError(`${where}: ${field} must be an integer, received ${render(value)}`);
    }

    return value;
};

const nonNegativeWholeNumber = (row: Record<string, unknown>, field: string, where: string): number => {
    const value = wholeNumber(row, field, where);
    if (value < 0) {
        throw payloadError(`${where}: ${field} must not be negative, received ${render(value)}`);
    }

    return value;
};

const flag = (row: Record<string, unknown>, field: string, where: string): boolean => {
    const value = row[field];
    if (typeof value !== 'boolean') {
        throw payloadError(`${where}: ${field} must be a boolean, received ${render(value)}`);
    }

    return value;
};

/**
 * A list of strings.
 *
 * An EMPTY list is accepted, and that matters for `dietTags`: a recipe with a
 * meat ingredient derives no diet tag at all, so `[]` is the derivation's own
 * answer for an omnivore dish and never an unset field (§0.7.3).
 */
const textList = (row: Record<string, unknown>, field: string, where: string): string[] => {
    const value = row[field];
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
        throw payloadError(`${where}: ${field} must be an array of strings, received ${render(value)}`);
    }

    return value as string[];
};

const nonEmptyTextList = (row: Record<string, unknown>, field: string, where: string): string[] => {
    const value = textList(row, field, where);
    if (value.length === 0) {
        throw payloadError(`${where}: ${field} must hold at least one entry`);
    }

    return value;
};

const list = (row: Record<string, unknown>, field: string, where: string): unknown[] => {
    const value = row[field];
    if (!Array.isArray(value)) {
        throw payloadError(`${where}: ${field} must be an array, received ${render(value)}`);
    }

    return value as unknown[];
};

/** One `ingredients[]` entry as the file states it, in the file's camelCase. */
export interface RecipeIngredientDeclaration {
    readonly sourceKey: string;
    readonly quantity: number;
    readonly unit: string;
    /** Grams of this ingredient in the WHOLE recipe, which yields `yieldServings` servings. */
    readonly gramWeight: number;
    readonly displayText: string;
    readonly sortOrder: number;
    readonly isOptional: boolean;
}

/**
 * One recipe file.
 *
 * `iconKey`, `mealSlots`, `badges`, `allergenStatus` and `budgetTier` are read
 * as their JSON types here and their CLOSED-SET membership is decided by
 * `recipe.logic.ts::validateRecipeDeclaration`, which owns those sets. Checking
 * them twice would be two places to change one list.
 */
export interface RecipeFilePayload {
    readonly file: string;
    readonly slug: string;
    readonly name: string;
    readonly description: string;
    readonly iconKey: string;
    readonly instructions: readonly string[];
    readonly yieldServings: number;
    readonly servingDescription: string;
    readonly prepMinutes: number;
    readonly cookMinutes: number;
    readonly mealSlots: readonly string[];
    readonly dietTags: readonly string[];
    readonly allergenTags: readonly string[];
    readonly allergenStatus: string;
    readonly budgetTier: number;
    readonly badges: readonly string[];
    readonly ingredients: readonly RecipeIngredientDeclaration[];
}

/**
 * Parses one recipe file's contents.
 *
 * The slug must equal the file's basename. Not cosmetic: the slug is the
 * seed's idempotency key, so a file named for one recipe carrying another's
 * slug would publish under a name no reviewer reading the directory expects,
 * and a later rename would publish a duplicate rather than a new version.
 */
export const parseRecipePayload = (file: string, value: unknown): RecipeFilePayload => {
    const where = `recipes/${file}`;
    const row = asRecord(value, where);
    const slug = text(row, 'slug', where);
    const expectedSlug = path.basename(file, RECIPE_FILE_EXTENSION);

    if (slug !== expectedSlug) {
        throw payloadError(`${where}: slug "${slug}" must equal the file's name "${expectedSlug}"`);
    }

    return {
        file,
        slug,
        name: text(row, 'name', where),
        description: text(row, 'description', where),
        iconKey: text(row, 'iconKey', where),
        instructions: nonEmptyTextList(row, 'instructions', where),
        yieldServings: positiveDecimal(row, 'yieldServings', where),
        servingDescription: text(row, 'servingDescription', where),
        prepMinutes: nonNegativeWholeNumber(row, 'prepMinutes', where),
        cookMinutes: nonNegativeWholeNumber(row, 'cookMinutes', where),
        mealSlots: nonEmptyTextList(row, 'mealSlots', where),
        dietTags: textList(row, 'dietTags', where),
        allergenTags: textList(row, 'allergenTags', where),
        allergenStatus: text(row, 'allergenStatus', where),
        budgetTier: wholeNumber(row, 'budgetTier', where),
        badges: textList(row, 'badges', where),
        ingredients: (() => {
            const entries = list(row, 'ingredients', where);
            if (entries.length === 0) {
                throw payloadError(`${where}: ingredients must hold at least one entry — a recipe with none has no derivable nutrition`);
            }

            return entries.map((entry, index) => {
                const ingredientWhere = `${where} ingredient ${index}`;
                const ingredient = asRecord(entry, ingredientWhere);

                return {
                    sourceKey: text(ingredient, 'sourceKey', ingredientWhere),
                    quantity: positiveDecimal(ingredient, 'quantity', ingredientWhere),
                    unit: text(ingredient, 'unit', ingredientWhere),
                    gramWeight: positiveDecimal(ingredient, 'gramWeight', ingredientWhere),
                    displayText: text(ingredient, 'displayText', ingredientWhere),
                    sortOrder: nonNegativeWholeNumber(ingredient, 'sortOrder', ingredientWhere),
                    isOptional: flag(ingredient, 'isOptional', ingredientWhere),
                };
            });
        })(),
    };
};

/**
 * One selected file's identity in the corpus fingerprint: its name and a digest
 * of the exact bytes this run read.
 *
 * Taken over the BYTES rather than over the parsed payload, and taken for a file
 * that failed to parse too: the fingerprint names the corpus an attempt was
 * asked to publish, and two runs over the same bytes are the same work whatever
 * those bytes turn out to mean.
 */
export interface RecipeFileDigest {
    readonly file: string;
    /** SHA-256 of the file's contents, hex. */
    readonly sha256: string;
}

export interface RecipeFileRead {
    readonly payloads: readonly RecipeFilePayload[];
    /** One entry per file that could not be parsed; the run refuses on any of them. */
    readonly problems: readonly string[];
    /** One entry per selected file, in file-name order — the corpus fingerprint's input. */
    readonly digests: readonly RecipeFileDigest[];
}

/**
 * Reads the selected recipe files, in slug order.
 *
 * A file that cannot be parsed is COLLECTED rather than thrown, because a
 * corpus edit that broke three files should report three problems; the two
 * conditions that do throw — an unreadable directory and an `--only` slug with
 * no file — are faults in the invocation rather than in the content, and
 * continuing past either would seed a set the operator did not ask for.
 */
export const readRecipeFiles = (directory: string, only: readonly string[]): RecipeFileRead => {
    let entries: readonly string[];
    try {
        entries = fs.readdirSync(directory);
    } catch (error) {
        throw new RecipeSeedError(
            'recipes_unreadable',
            `the recipe directory could not be read (${formatSafeError(error)})`,
        );
    }

    const available = entries.filter((entry) => isRecipeFileName(entry)).sort();
    const selected =
        only.length === 0
            ? available
            : only.map((slug) => {
                  const file = `${slug}${RECIPE_FILE_EXTENSION}`;
                  if (!available.includes(file)) {
                      throw new RecipeSeedError(
                          'unknown_slug',
                          `--only named "${slug}", which has no file in the recipe directory`,
                      );
                  }
                  return file;
              });

    const payloads: RecipeFilePayload[] = [];
    const problems: string[] = [];
    const digests: RecipeFileDigest[] = [];

    for (const file of [...selected].sort()) {
        let raw: string;
        try {
            raw = fs.readFileSync(path.join(directory, file), 'utf8');
        } catch (error) {
            throw new RecipeSeedError(
                'recipes_unreadable',
                `recipes/${file} could not be read (${formatSafeError(error)})`,
            );
        }

        // Digested here, from the bytes just read, so the fingerprint describes
        // what this run actually consumed rather than what a second read of the
        // directory would find.
        digests.push({ file, sha256: crypto.createHash('sha256').update(raw).digest('hex') });

        let parsed: unknown;
        try {
            // The parser's own message is not forwarded: since Node 20 it quotes
            // the offending part of the document, and file contents must not
            // reach a log. The position is what an author needs and it is in
            // the file itself.
            parsed = JSON.parse(raw) as unknown;
        } catch {
            problems.push(`recipes/${file}: is not valid JSON`);
            continue;
        }

        try {
            payloads.push(parseRecipePayload(file, parsed));
        } catch (error) {
            if (isThrownInstanceOf(error, RecipeSeedError)) {
                problems.push(...(error.problems.length > 0 ? error.problems : [error.message]));
                continue;
            }
            throw error;
        }
    }

    return { payloads, problems, digests };
};

/* ---------------------------------------------------------------------------
 * Resolving an ingredient against the loaded catalog
 * ------------------------------------------------------------------------- */

/** The `catalog_food_portions` facts the publication gate reads. */
export interface SeedCatalogPortionRow {
    is_default: boolean;
    gram_weight: number;
}

/**
 * The `catalog_foods` row a recipe ingredient resolves to.
 *
 * `food_group`, `allergen_status`, `cost_class`, `nutrition_basis` and
 * `density_g_per_ml` are read from HERE and not from `recipe_ingredients`,
 * which does not snapshot them — the same join `recipe.service.ts` performs at
 * read time (`recipe.service.ts:404,468-491`).
 */
export interface SeedCatalogFoodRow {
    id: string;
    source_key: string;
    canonical_name: string;
    display_name: string;
    food_group: string;
    publication_status: string;
    nutrition_provenance: string;
    allergen_status: string;
    allergen_tags: string[];
    diet_tags: string[];
    nutrition_basis: string;
    density_g_per_ml: number | null;
    calories: number | null;
    protein_g: number | null;
    carbs_g: number | null;
    fat_g: number | null;
    fiber_g: number | null;
    cost_class: number;
    nutrition_version: number;
    metadata_version: number;
    catalog_food_portions: SeedCatalogPortionRow[];
}

/** The identity text the instruction-completeness check matches an ingredient against. */
export interface IngredientIdentityText {
    readonly foodGroup: string;
    readonly canonicalName: string;
    readonly displayName: string;
}

/** A resolved ingredient: what the derivation reads, plus the identity text and the row's id. */
export interface ResolvedIngredient {
    readonly declaration: RecipeIngredientDeclaration;
    readonly food: SeedCatalogFoodRow;
    readonly publication: RecipePublicationIngredient;
    readonly identity: IngredientIdentityText;
}

const isFiniteNonNegative = (value: number | null): value is number =>
    value !== null && Number.isFinite(value) && value >= 0;

/**
 * Every reason a `catalog_foods` row may not back a NEW recipe version.
 *
 * All seven are §0.7.3 preconditions rather than preferences, and each is
 * reported with the offending `source_key` so the operator knows which catalog
 * row to fix rather than which recipe to delete:
 *
 *  - not `published` — a candidate, quarantined, rejected or RETIRED row. A
 *    retired food may keep backing an EXISTING version (that is what makes
 *    historical plans readable), but a new version built on one would be
 *    unplannable from the moment it published.
 *  - not `source_backed` — an estimate never enters planning, so a recipe built
 *    on one could never be planned either.
 *  - `allergen_status` not `known` — a food nobody has reviewed cannot be
 *    certified safe for any user, whatever they selected.
 *  - a missing or negative core macro — a sum missing a term is not a smaller
 *    sum, and `snapshot_per_100g` types all four as required.
 *  - `per_100ml` with no density — millilitres never equal grams (~9 % on oil).
 *  - a nutrition basis that is neither per-100 g nor per-100 ml — a
 *    `per_serving`-only food has no sourced gram basis to scale from.
 *  - no single default portion with a positive gram weight — the one weight
 *    every unit conversion and grocery line is derived from.
 */
const describeUnpublishableFood = (food: SeedCatalogFoodRow): string[] => {
    const problems: string[] = [];

    if (food.publication_status !== PUBLISHED_STATUS) {
        problems.push(`publication_status is "${food.publication_status}", not "${PUBLISHED_STATUS}"`);
    }
    if (food.nutrition_provenance !== SOURCE_BACKED_PROVENANCE) {
        problems.push(`nutrition_provenance is "${food.nutrition_provenance}", not "${SOURCE_BACKED_PROVENANCE}"`);
    }
    if (food.allergen_status !== KNOWN_ALLERGEN_STATUS) {
        problems.push(`allergen_status is "${food.allergen_status}", not "${KNOWN_ALLERGEN_STATUS}"`);
    }

    for (const [field, value] of [
        ['calories', food.calories],
        ['protein_g', food.protein_g],
        ['carbs_g', food.carbs_g],
        ['fat_g', food.fat_g],
    ] as const) {
        if (!isFiniteNonNegative(value)) {
            problems.push(`${field} is ${render(value)}, which is not a finite non-negative number`);
        }
    }

    if (food.nutrition_basis !== 'per_100g' && food.nutrition_basis !== 'per_100ml') {
        problems.push(
            `nutrition_basis is "${food.nutrition_basis}"; a recipe ingredient must be stated per_100g or per_100ml`,
        );
    }
    if (food.nutrition_basis === 'per_100ml' && !isFiniteNonNegative(food.density_g_per_ml)) {
        problems.push('is stated per_100ml with no density_g_per_ml, so it cannot convert to grams');
    }

    const defaults = food.catalog_food_portions.filter((portion) => portion.is_default);
    if (defaults.length !== 1) {
        problems.push(`has ${defaults.length} default catalog_food_portions rows, not exactly one`);
    } else if (!(defaults[0].gram_weight > 0)) {
        problems.push(`its default portion states gram_weight ${render(defaults[0].gram_weight)}, which is not positive`);
    }

    return problems;
};

/**
 * A resolved ingredient in the shape the derivation reads.
 *
 * Called only after `describeUnpublishableFood` accepted the row, which is what
 * makes the four non-null assertions on the core macros sound: each was checked
 * to be a finite non-negative number, and `RecipeIngredientNutrientSnapshot`
 * types all four as required precisely so an unchecked null cannot reach a sum.
 */
const toPublicationIngredient = (
    declaration: RecipeIngredientDeclaration,
    food: SeedCatalogFoodRow,
): RecipePublicationIngredient => ({
    catalog_food_id: food.id,
    snapshot_name: food.display_name,
    snapshot_provenance: SOURCE_BACKED_PROVENANCE,
    snapshot_allergen_tags: food.allergen_tags,
    snapshot_diet_tags: food.diet_tags,
    is_optional: declaration.isOptional,
    food_group: food.food_group,
    allergen_status: KNOWN_ALLERGEN_STATUS as RecipeAllergenStatus,
    cost_class: food.cost_class,
    catalog_nutrition_version: food.nutrition_version,
    catalog_metadata_version: food.metadata_version,
    snapshot_per_100g: {
        calories: food.calories as number,
        protein_g: food.protein_g as number,
        carbs_g: food.carbs_g as number,
        fat_g: food.fat_g as number,
        // Absent and null both mean unknown, and unknown propagates: a recipe
        // one of whose ingredients states no fibre derives a null fibre total
        // rather than a total that quietly counted it as zero.
        fiber_g: food.fiber_g,
    },
    quantity: declaration.quantity,
    unit: declaration.unit,
    gram_weight: declaration.gramWeight,
    display_text: declaration.displayText,
    sort_order: declaration.sortOrder,
    nutrition_basis: food.nutrition_basis as RecipeNutritionBasis,
    density_g_per_ml: food.density_g_per_ml,
});

export interface IngredientResolution {
    readonly resolved: readonly ResolvedIngredient[];
    readonly problems: readonly string[];
}

/**
 * Resolves every ingredient of one payload by `source_key` — never by a
 * database id, so the same files seed identically into any database (§0.7.3).
 *
 * Every failure is collected and prefixed with the recipe slug AND the
 * offending `source_key`, because "an ingredient is missing" without either
 * names neither the file to fix nor the catalog row to load.
 */
export const resolveIngredients = (
    payload: RecipeFilePayload,
    foodsBySourceKey: ReadonlyMap<string, SeedCatalogFoodRow>,
): IngredientResolution => {
    const resolved: ResolvedIngredient[] = [];
    const problems: string[] = [];
    const where = `${payload.slug} (recipes/${payload.file})`;
    const seen = new Set<string>();

    for (const declaration of payload.ingredients) {
        if (seen.has(declaration.sourceKey)) {
            problems.push(
                `${where}: ingredient "${declaration.sourceKey}" is listed twice; one row per catalog food, with the quantity summed`,
            );
            continue;
        }
        seen.add(declaration.sourceKey);

        const food = foodsBySourceKey.get(declaration.sourceKey);
        if (food === undefined) {
            problems.push(
                `${where}: ingredient "${declaration.sourceKey}" resolves to no catalog_foods row; load the catalog release that carries it`,
            );
            continue;
        }

        const refusals = describeUnpublishableFood(food);
        if (refusals.length > 0) {
            for (const refusal of refusals) {
                problems.push(`${where}: ingredient "${declaration.sourceKey}" ${refusal}`);
            }
            continue;
        }

        resolved.push({
            declaration,
            food,
            publication: toPublicationIngredient(declaration, food),
            identity: {
                foodGroup: food.food_group,
                canonicalName: food.canonical_name,
                displayName: food.display_name,
            },
        });
    }

    return { resolved, problems };
};

/* ---------------------------------------------------------------------------
 * Instruction completeness — "every nutritive ingredient is listed"
 *
 * §0.7.3 requires every nutritive ingredient to appear in `ingredients[]`:
 * oils, butter, dressings, sugar and marinades included, because an unlisted
 * tablespoon of oil is ~120 uncounted kcal on a plate the user was told the
 * calories of. The enforceable form of that rule is this: if the prose names a
 * food the ingredient list does not carry, the file fails.
 *
 * The vocabulary is DATA rather than a word list written here — the food-group
 * taxonomy in `coverage-plan.v1.json` plus every published catalog food's
 * canonical name — so it grows with the catalog and cannot go stale against it.
 * Both sides are normalised identically and folded for plurals, so "tomatoes"
 * in a step matches the catalog's "tomato" and neither spelling is privileged.
 *
 * WHY THIS LIVES HERE AND NOT IN `recipe.logic.ts`. The rule needs the coverage
 * plan (a `data/` document) and a table-wide read of `catalog_foods`, neither of
 * which a pure module in `src/services/` may reach; it is also a property of the
 * FILE rather than of a published version, so nothing at request time asks it.
 * ------------------------------------------------------------------------- */

/** Tokens at or below this length are left alone: "oats" is not "oat" plus an s. */
const MIN_PLURAL_FOLD_LENGTH = 4;

/**
 * One token with its English plural folded away.
 *
 * Deliberately crude and deliberately SYMMETRIC: it is applied to the
 * vocabulary and to the instructions through the same function, so the only
 * property that matters is that the two sides agree. "berries" and "berry" fold
 * together, "tomatoes" folds to "tomato", "oils" to "oil"; a `ss` ending is
 * left alone so "glass" does not become "gla".
 */
export const foldPluralToken = (token: string): string => {
    if (token.length < MIN_PLURAL_FOLD_LENGTH) {
        return token;
    }
    if (token.endsWith('ies')) {
        return `${token.slice(0, -3)}y`;
    }
    if (token.endsWith('es')) {
        return token.slice(0, -2);
    }
    if (token.endsWith('s') && !token.endsWith('ss')) {
        return token.slice(0, -1);
    }

    return token;
};

/**
 * Text as this check compares it: `normalizeCanonicalName`'s accent folding,
 * lower-casing and non-alphanumeric collapse — the catalog's own identity
 * normalisation, reused rather than re-derived — with plural folding per token
 * on top, which that function deliberately does not do (two catalog foods may
 * differ only in plurality, so its identity key must keep them apart).
 */
export const normalizeVocabularyText = (value: string): string =>
    normalizeCanonicalName(value)
        .split(' ')
        .filter((token) => token.length > 0)
        .map(foldPluralToken)
        .join(' ');

/**
 * The ingredient vocabulary, split by shape because the two shapes are matched
 * differently.
 *
 * A MULTI-WORD term matches as a substring: "olive oil" is named by "extra
 * virgin olive oil" and by "olive oil, refined". A SINGLE-WORD term matches only
 * as a whole token, because a substring test on one would fire on "oat" inside
 * "coat" and "rice" inside "price" — the false positives that make a gate get
 * switched off.
 */
export interface IngredientVocabulary {
    readonly singleWordTerms: ReadonlySet<string>;
    readonly multiWordTerms: readonly string[];
}

export const buildIngredientVocabulary = (
    foodGroups: readonly string[],
    canonicalNames: readonly string[],
): IngredientVocabulary => {
    const terms = new Set<string>();

    for (const foodGroup of foodGroups) {
        // The taxonomy spells its groups `nut_seed`, `olive_oil`: underscores
        // are word separators there, and the normaliser collapses them to
        // spaces, which is what makes `olive_oil` a two-word term.
        terms.add(normalizeVocabularyText(foodGroup));
    }
    for (const canonicalName of canonicalNames) {
        terms.add(normalizeVocabularyText(canonicalName));
    }
    terms.delete('');

    const singleWordTerms = new Set<string>();
    const multiWordTerms: string[] = [];
    for (const term of terms) {
        if (term.includes(' ')) {
            multiWordTerms.push(term);
        } else {
            singleWordTerms.add(term);
        }
    }

    return { singleWordTerms, multiWordTerms: multiWordTerms.sort() };
};

/** A vocabulary term a step names that no listed ingredient accounts for. */
export interface UnlistedInstructionTerm {
    readonly term: string;
    readonly instruction: string;
}

/**
 * Whether a listed ingredient accounts for a term.
 *
 * Substring matching in BOTH directions, which is what makes the check hold
 * without a synonym table: the step's "rice" is accounted for by the
 * ingredient "brown rice, cooked" (term inside name), and the step's "canola
 * oil" by the ingredient "oil" if the catalog ever named one that plainly (name
 * inside term). The food group answers the remaining case, where the prose uses
 * the category word — "cheese" for "Feta cheese" through the `cheese` group.
 */
const termIsAccounted = (term: string, identities: readonly IngredientIdentityText[]): boolean =>
    identities.some((identity) => {
        if (normalizeVocabularyText(identity.foodGroup) === term) {
            return true;
        }

        return [identity.canonicalName, identity.displayName]
            .map((value) => normalizeVocabularyText(value))
            .some((name) => name.length > 0 && (name.includes(term) || term.includes(name)));
    });

/**
 * Every ingredient-vocabulary term the instructions name that the ingredient
 * list does not account for, with the step that named it.
 *
 * Each step is matched on its own so the refusal can quote it: an operator
 * fixing "Heat the canola oil" needs the sentence, not the whole method.
 */
export const findUnlistedInstructionTerms = (
    instructions: readonly string[],
    identities: readonly IngredientIdentityText[],
    vocabulary: IngredientVocabulary,
): UnlistedInstructionTerm[] => {
    const unlisted: UnlistedInstructionTerm[] = [];
    const reported = new Set<string>();

    for (const instruction of instructions) {
        const normalized = normalizeVocabularyText(instruction);
        if (normalized.length === 0) {
            continue;
        }

        const hits = new Set<string>();
        for (const token of new Set(normalized.split(' '))) {
            if (vocabulary.singleWordTerms.has(token)) {
                hits.add(token);
            }
        }
        for (const term of vocabulary.multiWordTerms) {
            if (normalized.includes(term)) {
                hits.add(term);
            }
        }

        for (const term of [...hits].sort()) {
            // Reported once per recipe rather than once per step: the fix is one
            // ingredient row, and repeating it per sentence buries the others.
            if (reported.has(term) || termIsAccounted(term, identities)) {
                continue;
            }
            reported.add(term);
            unlisted.push({ term, instruction });
        }
    }

    return unlisted;
};

/* ---------------------------------------------------------------------------
 * Planning one publication: the columns a version write holds
 * ------------------------------------------------------------------------- */

/**
 * The `recipe_versions` columns one publication of a payload writes.
 *
 * `version`, `status`, `published_at` and `retired_at` are NOT here: they are
 * decided by the transaction from what is already stored, and including them
 * would make the content comparison below answer "changed" for a recipe whose
 * content is identical and whose version number is simply higher.
 */
export interface PlannedRecipeVersion {
    readonly name: string;
    readonly description: string;
    readonly icon_key: string;
    readonly instructions: readonly string[];
    readonly yield_servings: number;
    readonly serving_description: string;
    readonly prep_minutes: number;
    readonly cook_minutes: number;
    readonly total_minutes: number;
    readonly meal_slots: readonly string[];
    readonly diet_tags: readonly string[];
    readonly allergen_tags: readonly string[];
    readonly allergen_status: string;
    readonly budget_tier: number;
    readonly badges: readonly string[];
    readonly nutrition_provenance: string;
    readonly per_serving_calories: number;
    readonly per_serving_protein_g: number;
    readonly per_serving_carbs_g: number;
    readonly per_serving_fat_g: number;
    readonly sourced_calories_note: string | null;
}

/** One `recipe_ingredients` row, snapshot columns included. */
export interface PlannedRecipeIngredient {
    readonly catalog_food_id: string;
    readonly catalog_nutrition_version: number;
    readonly catalog_metadata_version: number;
    readonly snapshot_per_100g: RecipeIngredientNutrientSnapshot;
    readonly snapshot_name: string;
    readonly snapshot_provenance: string;
    readonly snapshot_allergen_tags: readonly string[];
    readonly snapshot_diet_tags: readonly string[];
    readonly quantity: number;
    readonly unit: string;
    readonly gram_weight: number;
    readonly display_text: string;
    readonly sort_order: number;
    readonly is_optional: boolean;
}

export interface RecipePublicationPlan {
    readonly slug: string;
    readonly file: string;
    readonly version: PlannedRecipeVersion;
    /** Ordered by `sort_order`, so the stored set and this one compare index by index. */
    readonly ingredients: readonly PlannedRecipeIngredient[];
    /** The resolved ingredients, kept for staleness detection and the coverage report. */
    readonly publicationIngredients: readonly RecipePublicationIngredient[];
}

export interface RecipeValidation {
    readonly slug: string;
    readonly file: string;
    /** `null` whenever `problems` is non-empty: an invalid file has no publication. */
    readonly plan: RecipePublicationPlan | null;
    readonly problems: readonly string[];
}

const bySortOrder = <T extends { readonly sort_order: number }>(left: T, right: T): number =>
    left.sort_order - right.sort_order;

/**
 * Parses, resolves and validates one payload, answering with its publication or
 * with every reason it has none.
 *
 * The three gates, in order, because each needs the previous one's output:
 * ingredient resolution (the catalog facts), the declared-versus-derived gate
 * (`recipe.logic.ts::validateRecipeDeclaration`, which returns the derivation
 * this publication is built FROM), and instruction completeness.
 *
 * `RecipeDerivationError` and `UnitConversionError` are caught and reported as
 * problems rather than propagated: both mean this file's numbers are
 * meaningless — an impossible nutrient, a non-positive yield, a volume with no
 * density — which is a defect in this recipe and not a reason to abandon the
 * validation of the other forty-one.
 */
export const validateRecipeFile = (
    payload: RecipeFilePayload,
    foodsBySourceKey: ReadonlyMap<string, SeedCatalogFoodRow>,
    vocabulary: IngredientVocabulary,
): RecipeValidation => {
    const where = `${payload.slug} (recipes/${payload.file})`;
    const { resolved, problems: resolutionProblems } = resolveIngredients(payload, foodsBySourceKey);

    if (resolutionProblems.length > 0) {
        return { slug: payload.slug, file: payload.file, plan: null, problems: resolutionProblems };
    }

    const publicationIngredients = resolved.map((ingredient) => ingredient.publication);
    const problems: string[] = [];

    let verdict;
    try {
        verdict = validateRecipeDeclaration(
            {
                icon_key: payload.iconKey,
                meal_slots: payload.mealSlots,
                badges: payload.badges,
                diet_tags: payload.dietTags,
                allergen_tags: payload.allergenTags,
                prep_minutes: payload.prepMinutes,
                cook_minutes: payload.cookMinutes,
                yield_servings: payload.yieldServings,
                allergen_status: payload.allergenStatus,
                budget_tier: payload.budgetTier,
            },
            publicationIngredients,
        );
    } catch (error) {
        if (isThrownInstanceOf(error, RecipeDerivationError) || isThrownInstanceOf(error, UnitConversionError)) {
            return {
                slug: payload.slug,
                file: payload.file,
                plan: null,
                problems: [`${where}: ${error.name}: ${error.message}`],
            };
        }
        throw error;
    }

    for (const mismatch of verdict.mismatches) {
        // The tag-set messages already name their offending ingredients, so the
        // list is appended only for a single-value mismatch — `allergen_status`
        // is the one that carries ingredients without naming them in its
        // sentence — and a doubled list is avoided.
        const named =
            mismatch.code !== 'mismatch' || mismatch.ingredients.length === 0
                ? ''
                : ` Ingredients: ${mismatch.ingredients.join(', ')}.`;
        problems.push(`${where}: ${mismatch.message}${named}`);
    }

    for (const unlisted of findUnlistedInstructionTerms(
        payload.instructions,
        resolved.map((ingredient) => ingredient.identity),
        vocabulary,
    )) {
        problems.push(
            `${where}: instructions name "${unlisted.term}", which no listed ingredient accounts for — ` +
                'every nutritive ingredient must be listed (AAP §0.7.3), because an unlisted tablespoon of oil ' +
                `is ~120 uncounted kcal. Step: "${unlisted.instruction}"`,
        );
    }

    if (problems.length > 0) {
        return { slug: payload.slug, file: payload.file, plan: null, problems };
    }

    const derived = verdict.derived;

    return {
        slug: payload.slug,
        file: payload.file,
        problems: [],
        plan: {
            slug: payload.slug,
            file: payload.file,
            version: {
                name: payload.name,
                description: payload.description,
                icon_key: payload.iconKey,
                instructions: [...payload.instructions],
                yield_servings: payload.yieldServings,
                serving_description: payload.servingDescription,
                prep_minutes: payload.prepMinutes,
                cook_minutes: payload.cookMinutes,
                // Every value below is the DERIVATION's, never the file's.
                total_minutes: derived.totalMinutes,
                // The one list the file owns: which meals a dish belongs to is
                // not derivable from its ingredients.
                meal_slots: [...payload.mealSlots],
                diet_tags: derived.dietTags,
                allergen_tags: derived.allergenTags,
                allergen_status: derived.allergenStatus,
                budget_tier: derived.budgetTier,
                badges: derived.badges,
                nutrition_provenance: derived.nutritionProvenance,
                per_serving_calories: derived.perServing.calories,
                per_serving_protein_g: derived.perServing.protein,
                per_serving_carbs_g: derived.perServing.carbs,
                per_serving_fat_g: derived.perServing.fat,
                sourced_calories_note: derived.sourcedCaloriesNote,
            },
            ingredients: publicationIngredients
                .map((ingredient) => ({
                    catalog_food_id: ingredient.catalog_food_id,
                    catalog_nutrition_version: ingredient.catalog_nutrition_version,
                    catalog_metadata_version: ingredient.catalog_metadata_version,
                    snapshot_per_100g: ingredient.snapshot_per_100g,
                    snapshot_name: ingredient.snapshot_name,
                    snapshot_provenance: ingredient.snapshot_provenance,
                    snapshot_allergen_tags: [...ingredient.snapshot_allergen_tags],
                    snapshot_diet_tags: [...ingredient.snapshot_diet_tags],
                    quantity: ingredient.quantity,
                    unit: ingredient.unit,
                    gram_weight: ingredient.gram_weight,
                    display_text: ingredient.display_text,
                    sort_order: ingredient.sort_order,
                    is_optional: ingredient.is_optional,
                }))
                .sort(bySortOrder),
            publicationIngredients,
        },
    };
};

/* ---------------------------------------------------------------------------
 * Is what is stored already what we would publish?
 * ------------------------------------------------------------------------- */

/**
 * How close a `DOUBLE PRECISION` column read back has to be to the double that
 * was written, as a RELATIVE difference.
 *
 * Not a softened comparison — a measured property of the write path, recorded
 * with its probe in `src/__tests__/api/seed-rerun.test.ts:176-201`: the Prisma
 * client encodes a float parameter to fifteen significant digits, so a derived
 * value such as `177.79299999999998` is stored as the neighbouring double
 * `177.793` and no comparison on this stack can be bit for bit. Without this
 * tolerance every rerun would read its own rounding as a content change and
 * publish a new version of all forty-two recipes, which is exactly the
 * churn idempotency is for. The observed gaps are ~1e-16 relative; this bound
 * is four orders above that and ten below the one decimal place any of these
 * numbers is displayed at, so a real arithmetic error is still caught by many
 * orders of magnitude.
 */
export const FLOAT8_ROUND_TRIP_TOLERANCE = 1e-12;

export const sameStoredNumber = (stored: number, written: number): boolean => {
    if (stored === written) {
        return true;
    }
    if (!Number.isFinite(stored) || !Number.isFinite(written)) {
        return false;
    }

    const scale = Math.max(Math.abs(stored), Math.abs(written));
    return Math.abs(stored - written) <= scale * FLOAT8_ROUND_TRIP_TOLERANCE;
};

/**
 * Deep equivalence between a value read back from the database and the value
 * that was written.
 *
 * Two deliberate differences from `JSON.stringify` equality. Numbers go through
 * {@link sameStoredNumber}, for the reason above. And objects are compared by
 * KEY rather than by serialised order, because `jsonb` does not preserve
 * insertion order — PostgreSQL stores object keys sorted, so `snapshot_per_100g`
 * returns as `{fat_g, carbs_g, fiber_g, calories, protein_g}` however it was
 * written, which is the same object and a different string.
 */
export const equivalentContent = (stored: unknown, written: unknown): boolean => {
    if (typeof stored === 'number' && typeof written === 'number') {
        return sameStoredNumber(stored, written);
    }

    if (Array.isArray(stored) && Array.isArray(written)) {
        return (
            stored.length === written.length && stored.every((entry, index) => equivalentContent(entry, written[index]))
        );
    }

    if (
        typeof stored === 'object' &&
        stored !== null &&
        typeof written === 'object' &&
        written !== null &&
        !Array.isArray(stored) &&
        !Array.isArray(written)
    ) {
        const storedRecord = stored as Record<string, unknown>;
        const writtenRecord = written as Record<string, unknown>;
        const keys = new Set([...Object.keys(storedRecord), ...Object.keys(writtenRecord)]);

        return [...keys].every((key) => equivalentContent(storedRecord[key], writtenRecord[key]));
    }

    return stored === written;
};

/** One content difference between the stored current version and the planned one. */
export interface ContentDifference {
    readonly field: string;
    readonly stored: string;
    readonly planned: string;
}

/**
 * Every field in which the stored current version differs from what would be
 * published now.
 *
 * The ingredient set is compared as ONE field rather than row by row: a changed
 * gram weight, a re-ordered list and a removed ingredient are all "the
 * ingredients changed", and one new version answers all three.
 */
export const compareStoredContent = (
    stored: { readonly version: PlannedRecipeVersion; readonly ingredients: readonly PlannedRecipeIngredient[] },
    planned: RecipePublicationPlan,
): ContentDifference[] => {
    const differences: ContentDifference[] = [];

    for (const [field, plannedValue] of Object.entries(planned.version)) {
        const storedValue = stored.version[field as keyof PlannedRecipeVersion];
        if (!equivalentContent(storedValue, plannedValue)) {
            differences.push({ field, stored: render(storedValue), planned: render(plannedValue) });
        }
    }

    if (!equivalentContent(stored.ingredients, planned.ingredients)) {
        differences.push({
            field: 'recipe_ingredients',
            stored: render(stored.ingredients),
            planned: render(planned.ingredients),
        });
    }

    return differences;
};

/* ---------------------------------------------------------------------------
 * Persistence.
 * ------------------------------------------------------------------------- */

/** A stored `recipe_ingredients` row. */
export interface StoredIngredientRow {
    id: string;
    catalog_food_id: string;
    catalog_nutrition_version: number;
    catalog_metadata_version: number;
    snapshot_per_100g: unknown;
    snapshot_name: string;
    snapshot_provenance: string;
    snapshot_allergen_tags: string[];
    snapshot_diet_tags: string[];
    quantity: number;
    unit: string;
    gram_weight: number;
    display_text: string;
    sort_order: number;
    is_optional: boolean;
}

/** A stored `recipe_versions` row with its ingredient rows. */
export interface StoredVersionRow {
    id: string;
    version: number;
    name: string;
    description: string | null;
    icon_key: string;
    instructions: unknown;
    yield_servings: number;
    serving_description: string;
    prep_minutes: number;
    cook_minutes: number;
    total_minutes: number;
    meal_slots: string[];
    diet_tags: string[];
    allergen_tags: string[];
    allergen_status: string;
    budget_tier: number;
    badges: string[];
    nutrition_provenance: string;
    per_serving_calories: number;
    per_serving_protein_g: number;
    per_serving_carbs_g: number;
    per_serving_fat_g: number;
    sourced_calories_note: string | null;
    status: string;
    recipe_ingredients: StoredIngredientRow[];
}

/** A stored `recipes` row with its current version and the version numbers it has used. */
export interface StoredRecipeRow {
    id: string;
    slug: string;
    current_version_id: string | null;
    current_version: StoredVersionRow | null;
    recipe_versions: { version: number }[];
}

/** An ingredient row joined to the catalog facts `recipe_ingredients` does not snapshot. */
export interface JoinedIngredientRow extends StoredIngredientRow {
    catalog_foods: {
        food_group: string;
        allergen_status: string;
        cost_class: number;
        nutrition_basis: string;
        density_g_per_ml: number | null;
    };
}

/** A recipe read back for the coverage report: its current version, ingredients and their foods. */
export interface JoinedRecipeRow {
    slug: string;
    current_version: (Omit<StoredVersionRow, 'recipe_ingredients'> & {
        recipe_ingredients: JoinedIngredientRow[];
    }) | null;
}

/**
 * The narrow slice of the Prisma client this stage goes through.
 *
 * Declared structurally, like `catalog-import-usda.ts`'s `ImportDb`, so the
 * script-level suite can drive `runSeed` against any client that satisfies it
 * and so this file never depends on the generated client's shape beyond the
 * three models it touches. `findMany`/`findUnique` carry the row type as a
 * parameter because the same method serves three different selects here — the
 * full food row, its two version counters, and canonical names alone — and one
 * fixed return type for all three would be a fiction.
 */
// WHY THESE WRITES CARRY NO OWNER PREDICATE. Rule backend-architecture §5.1
// requires `user_id` in every `where`, including updates and deletes, because a
// write found by id alone is a cross-user write waiting to happen. The recipe
// and catalog tables are the sanctioned exception, and prisma/schema.prisma and
// AAP §0.5.1 both say so at the model: `recipes`, `recipe_versions`,
// `recipe_ingredients` and the two `catalog_*` tables read here hold SHARED
// REFERENCE DATA with no `user_id` BY DESIGN — every user plans from the same
// recipe corpus — so there is no tenant to scope to, and adding an owner column
// would be a mistake rather than a fix. No request-scoped identity can reach
// this file either: it runs only from an operator CLI, never behind
// `authenticateFirebaseToken`, so there is no verified token to scope by.
//
// The compensating controls are therefore about WHICH DATABASE and WHICH ROW
// rather than which user. scripts/lib/dbGuard.ts classifies `DATABASE_URL`
// before any client exists and, because `recipes-seed` is registered
// `development_or_confirmed`, demands `--confirm-target <dbname>` unless the
// database's own name says development — so a deployment database reached over
// loopback is named aloud like a test or shadow one; `slug` (unique) selects the
// recipe and `source_key` selects each ingredient's food, so no write here is
// found by a bare id.
export interface SeedDb {
    catalog_foods: {
        findMany<Row = SeedCatalogFoodRow>(args: unknown): Promise<Row[]>;
    };
    recipes: {
        findUnique<Row = StoredRecipeRow>(args: unknown): Promise<Row | null>;
        findMany<Row = JoinedRecipeRow>(args: unknown): Promise<Row[]>;
        create(args: unknown): Promise<{ id: string }>;
        update(args: unknown): Promise<{ id: string }>;
    };
    recipe_versions: {
        create(args: unknown): Promise<{ id: string; version: number }>;
        update(args: unknown): Promise<{ id: string }>;
    };
    /**
     * Raw SQL, because Prisma cannot express `FOR SHARE` and the row lock is not
     * optional in a publishing transaction (see `lockIngredientFoods`).
     * Declared with the ROW ARRAY as the type parameter and the template form as
     * the argument, which is how lib/checkpoint.ts's `lockRunForUpdate` and
     * catalog-validate.ts's `ValidateDb` declare the same seam, so every raw
     * reader in this pipeline reads the same way.
     */
    $queryRaw<TRows = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<TRows>;
    $transaction<T>(work: (tx: SeedDb) => Promise<T>, options?: { timeout?: number }): Promise<T>;
}

/** What publishing one recipe did. */
export type PublishAction = 'created' | 'promoted' | 'unchanged';

export interface PublishResult {
    readonly slug: string;
    readonly action: PublishAction;
    /** The version number that is `current` after this call. */
    readonly version: number;
    readonly ingredientRows: number;
    /** Why a new version was published; `null` for a no-op. */
    readonly reason: string | null;
}

/**
 * The stored current version in the shape the planned one is compared against.
 *
 * `description` reads `?? ''` because the column is nullable and the payload's
 * is not: a null stored description and an empty planned one are the same
 * absence, and treating them as different would republish on every run.
 */
const toStoredContent = (
    version: StoredVersionRow,
): { version: PlannedRecipeVersion; ingredients: PlannedRecipeIngredient[] } => ({
    version: {
        name: version.name,
        description: version.description ?? '',
        icon_key: version.icon_key,
        instructions: version.instructions as string[],
        yield_servings: version.yield_servings,
        serving_description: version.serving_description,
        prep_minutes: version.prep_minutes,
        cook_minutes: version.cook_minutes,
        total_minutes: version.total_minutes,
        meal_slots: version.meal_slots,
        diet_tags: version.diet_tags,
        allergen_tags: version.allergen_tags,
        allergen_status: version.allergen_status,
        budget_tier: version.budget_tier,
        badges: version.badges,
        nutrition_provenance: version.nutrition_provenance,
        per_serving_calories: version.per_serving_calories,
        per_serving_protein_g: version.per_serving_protein_g,
        per_serving_carbs_g: version.per_serving_carbs_g,
        per_serving_fat_g: version.per_serving_fat_g,
        sourced_calories_note: version.sourced_calories_note,
    },
    ingredients: [...version.recipe_ingredients]
        .map((row) => ({
            catalog_food_id: row.catalog_food_id,
            catalog_nutrition_version: row.catalog_nutrition_version,
            catalog_metadata_version: row.catalog_metadata_version,
            snapshot_per_100g: row.snapshot_per_100g as RecipeIngredientNutrientSnapshot,
            snapshot_name: row.snapshot_name,
            snapshot_provenance: row.snapshot_provenance,
            snapshot_allergen_tags: row.snapshot_allergen_tags,
            snapshot_diet_tags: row.snapshot_diet_tags,
            quantity: row.quantity,
            unit: row.unit,
            gram_weight: row.gram_weight,
            display_text: row.display_text,
            sort_order: row.sort_order,
            is_optional: row.is_optional,
        }))
        .sort(bySortOrder),
});

/** A stored ingredient row in the shape `findStaleIngredients` reads. */
const toSnapshotForStaleness = (row: StoredIngredientRow): RecipeIngredientSnapshot => ({
    catalog_food_id: row.catalog_food_id,
    snapshot_name: row.snapshot_name,
    snapshot_provenance: row.snapshot_provenance as RecipePublicationIngredient['snapshot_provenance'],
    snapshot_allergen_tags: row.snapshot_allergen_tags,
    snapshot_diet_tags: row.snapshot_diet_tags,
    is_optional: row.is_optional,
    catalog_nutrition_version: row.catalog_nutrition_version,
    catalog_metadata_version: row.catalog_metadata_version,
    snapshot_per_100g: row.snapshot_per_100g as RecipeIngredientNutrientSnapshot,
    quantity: row.quantity,
    unit: row.unit,
    gram_weight: row.gram_weight,
    display_text: row.display_text,
    sort_order: row.sort_order,
});

/** The `recipe_versions` create payload, with its ingredient rows nested. */
const versionCreateData = (
    plan: RecipePublicationPlan,
    recipeId: string,
    version: number,
    now: Date,
): Record<string, unknown> => ({
    recipe_id: recipeId,
    version,
    name: plan.version.name,
    description: plan.version.description,
    icon_key: plan.version.icon_key,
    instructions: [...plan.version.instructions],
    yield_servings: plan.version.yield_servings,
    serving_description: plan.version.serving_description,
    prep_minutes: plan.version.prep_minutes,
    cook_minutes: plan.version.cook_minutes,
    total_minutes: plan.version.total_minutes,
    meal_slots: [...plan.version.meal_slots],
    diet_tags: [...plan.version.diet_tags],
    allergen_tags: [...plan.version.allergen_tags],
    allergen_status: plan.version.allergen_status,
    budget_tier: plan.version.budget_tier,
    badges: [...plan.version.badges],
    nutrition_provenance: plan.version.nutrition_provenance,
    per_serving_calories: plan.version.per_serving_calories,
    per_serving_protein_g: plan.version.per_serving_protein_g,
    per_serving_carbs_g: plan.version.per_serving_carbs_g,
    per_serving_fat_g: plan.version.per_serving_fat_g,
    sourced_calories_note: plan.version.sourced_calories_note,
    status: CURRENT_VERSION_STATUS,
    published_at: now,
    recipe_ingredients: {
        create: plan.ingredients.map((ingredient) => ({
            catalog_food_id: ingredient.catalog_food_id,
            catalog_nutrition_version: ingredient.catalog_nutrition_version,
            catalog_metadata_version: ingredient.catalog_metadata_version,
            snapshot_per_100g: ingredient.snapshot_per_100g,
            snapshot_name: ingredient.snapshot_name,
            snapshot_provenance: ingredient.snapshot_provenance,
            snapshot_allergen_tags: [...ingredient.snapshot_allergen_tags],
            snapshot_diet_tags: [...ingredient.snapshot_diet_tags],
            quantity: ingredient.quantity,
            unit: ingredient.unit,
            gram_weight: ingredient.gram_weight,
            display_text: ingredient.display_text,
            sort_order: ingredient.sort_order,
            is_optional: ingredient.is_optional,
        })),
    },
});

const RECIPE_READ_INCLUDE = {
    current_version: { include: { recipe_ingredients: true } },
    recipe_versions: { select: { version: true } },
};

/**
 * The catalog facts a publishing transaction re-reads, and the only ones it can
 * compare: a `recipe_ingredients` row snapshots the nutrients, the name, the
 * provenance and both counters, so those are what "unchanged" is measured
 * against, while `publication_status` and `allergen_status` are the live
 * eligibility clauses §0.7.3 states for a NEW version.
 */
const INGREDIENT_FACT_SELECT = {
    id: true,
    source_key: true,
    publication_status: true,
    nutrition_provenance: true,
    allergen_status: true,
    nutrition_version: true,
    metadata_version: true,
};

interface IngredientFactRow {
    id: string;
    source_key: string;
    publication_status: string;
    nutrition_provenance: string;
    allergen_status: string;
    nutrition_version: number;
    metadata_version: number;
}

/**
 * Takes a SHARED row lock on every catalog food this publication cites.
 *
 * Raw SQL because Prisma cannot express `FOR SHARE`, and the in-repo pattern for
 * "lock the row, then re-read it through the selection object" is
 * catalog-validate.ts's per-food compare-and-set — down to binding the ids and
 * casting them in the statement text rather than interpolating them.
 *
 * SHARED rather than exclusive: this stage does not write `catalog_foods`, and
 * two seeds (or a seed and a release export) holding the same food are
 * harmless. What the lock buys is the half-second that matters — a catalog
 * mutator wanting to retire or re-version one of these rows must now wait for
 * this transaction to commit, so the facts verified on the next line cannot
 * change between the verification and the insert that cites them.
 *
 * `ORDER BY id` makes the locking order deterministic rather than plan-dependent,
 * which is the cheap half of deadlock avoidance; the expensive half is the
 * graph-wide stage lock the whole run is held under, which keeps the exclusive
 * mutators out entirely.
 *
 * An id absent from the result is a food that is no longer in the table at all,
 * and the re-read below reports it as such — retirement is a status change, so a
 * genuinely absent row means someone deleted it by hand.
 */
const lockIngredientFoods = async (tx: SeedDb, foodIds: readonly string[]): Promise<void> => {
    await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM catalog_foods WHERE id = ANY(${[...foodIds]}::uuid[]) ORDER BY id FOR SHARE
    `;
};

/**
 * Refuses a publication whose ingredient facts moved since validation.
 *
 * WHY THIS EXISTS EVEN THOUGH THE RUN HOLDS THE GRAPH LOCK. The validation pass
 * reads the catalog once, for the whole corpus, and the publications then happen
 * one transaction at a time. Between the two, a writer that did not take the
 * stage lock — or a caller that injected its own lock seam — can retire a food,
 * flip it to `ai_estimated`, drop its allergen review or bump either counter,
 * and the snapshot this stage was about to write would then describe a row that
 * no longer exists in that shape. §0.7.3 forbids exactly that: a plannable
 * recipe may not rest on a retired, non-source-backed or allergen-unknown
 * ingredient, and a `current` version citing a stale counter is what
 * `findStaleIngredients` exists to catch rather than to create.
 *
 * Every offending ingredient is reported, not the first, because an operator
 * who ran a load beside a seed wants the whole list; each entry names the
 * recipe, the ingredient's `source_key` and what moved.
 *
 * Called immediately before the first write of each publishing path and NEVER
 * on the `unchanged` path: a rerun that publishes nothing must stay a read, and
 * a retired food may legitimately keep backing the version it was already
 * published into.
 */
const assertIngredientFactsHold = async (tx: SeedDb, plan: RecipePublicationPlan): Promise<void> => {
    const foodIds = [...new Set(plan.ingredients.map((ingredient) => ingredient.catalog_food_id))].sort();
    if (foodIds.length === 0) {
        return;
    }

    await lockIngredientFoods(tx, foodIds);

    const rows = await tx.catalog_foods.findMany<IngredientFactRow>({
        where: { id: { in: foodIds } },
        select: INGREDIENT_FACT_SELECT,
        orderBy: { source_key: 'asc' },
    });
    const factsById = new Map(rows.map((row) => [row.id, row]));

    const problems: string[] = [];
    for (const ingredient of plan.ingredients) {
        const facts = factsById.get(ingredient.catalog_food_id);
        const named = `${plan.slug}: ingredient "${ingredient.snapshot_name}"`;

        if (facts === undefined) {
            problems.push(`${named} is no longer in the catalog at all`);
            continue;
        }
        if (facts.publication_status !== PUBLISHED_STATUS) {
            problems.push(
                `${named} (${facts.source_key}) is now publication_status "${facts.publication_status}", ` +
                    `not "${PUBLISHED_STATUS}"`,
            );
        }
        if (facts.nutrition_provenance !== SOURCE_BACKED_PROVENANCE) {
            problems.push(
                `${named} (${facts.source_key}) is now nutrition_provenance "${facts.nutrition_provenance}", ` +
                    `not "${SOURCE_BACKED_PROVENANCE}"`,
            );
        }
        if (facts.allergen_status !== KNOWN_ALLERGEN_STATUS) {
            problems.push(
                `${named} (${facts.source_key}) is now allergen_status "${facts.allergen_status}", ` +
                    `not "${KNOWN_ALLERGEN_STATUS}"`,
            );
        }
        if (facts.nutrition_version !== ingredient.catalog_nutrition_version) {
            problems.push(
                `${named} (${facts.source_key}) moved nutrition_version ` +
                    `${ingredient.catalog_nutrition_version} -> ${facts.nutrition_version} since it was resolved`,
            );
        }
        if (facts.metadata_version !== ingredient.catalog_metadata_version) {
            problems.push(
                `${named} (${facts.source_key}) moved metadata_version ` +
                    `${ingredient.catalog_metadata_version} -> ${facts.metadata_version} since it was resolved`,
            );
        }
    }

    if (problems.length > 0) {
        throw new RecipeSeedError(
            'catalog_drifted',
            `${plan.slug} was not published: the catalog moved under it between validation and publication. ` +
                'Run the seed again once the catalog stage that changed these rows has finished',
            problems,
        );
    }
};

/**
 * Publishes one validated recipe, or leaves it alone.
 *
 * ONE TRANSACTION, and inside it the order is load-bearing:
 * `prisma/migrations/20260908000000_meal_planning/migration.sql:505` creates the
 * NON-DEFERRABLE partial unique index `unique_current_recipe_version ON
 * recipe_versions(recipe_id) WHERE status = 'current'`, so inserting the new
 * current row before retiring the old one fails the statement. Retire, insert,
 * then move `recipes.current_version_id` — and because it is one transaction,
 * a failure anywhere leaves the recipe exactly as current as it was.
 *
 * An existing version is NEVER edited. A version is the record of what a plan
 * was built from and what a diary entry logged, so its content is immutable and
 * `status`/`retired_at` are the only columns a later run may touch.
 *
 * The decision is taken INSIDE the transaction, from the rows it reads there:
 * deciding outside it would let a concurrent run publish between the read and
 * the write, and the loser would insert a second `current` row.
 *
 * The CATALOG FACTS are verified inside it too, immediately before either
 * writing path's first statement and under a shared row lock
 * (`assertIngredientFactsHold`). `plan` carries facts the validation pass read
 * for the whole corpus; a food retired, re-judged or re-versioned since then
 * refuses this recipe rather than publishing a `current` version that cites
 * facts which no longer hold. The no-op path never reaches the check, so a
 * rerun over an unchanged corpus still writes nothing at all.
 *
 * THE ATTEMPT'S OWNERSHIP is verified inside it as the FIRST statement, when a
 * run was claimed (`assertAttemptOwnsRun`). Two reasons it is first rather than
 * beside the catalog check: the row lock it takes must be held for the whole
 * transaction for the verification to be atomic with the publication, and a
 * fenced-out attempt must not even take the shared ingredient locks a real
 * publication takes. It runs on the no-op path too — an attempt that no longer
 * owns the run may not report a slug as reconciled either, and the fence's own
 * `SELECT … FOR UPDATE` leaves the recipe tables exactly as it found them, so
 * "an unchanged rerun writes nothing" still holds.
 *
 * `owner` is `null` for the two paths that claim no run — a dry run, which never
 * reaches here, and an `--only`-narrowed run, whose exclusivity comes from the
 * writer lock alone because there is no row for a second attempt to take over.
 */
export const publishRecipe = async (
    db: SeedDb,
    plan: RecipePublicationPlan,
    now: Date,
    currentCatalogVersions: ReadonlyMap<string, CatalogIngredientVersions>,
    owner: SeedRunOwner | null,
): Promise<PublishResult> =>
    db.$transaction(
        async (tx) => {
            if (owner !== null) {
                await assertAttemptOwnsRun(tx, owner);
            }

            const stored = await tx.recipes.findUnique<StoredRecipeRow>({
                where: { slug: plan.slug },
                include: RECIPE_READ_INCLUDE,
            });

            if (stored === null) {
                // The facts, re-read and held, before the first write of this
                // path (see assertIngredientFactsHold).
                await assertIngredientFactsHold(tx, plan);

                const recipe = await tx.recipes.create({ data: { slug: plan.slug } });
                const version = await tx.recipe_versions.create({
                    data: versionCreateData(plan, recipe.id, FIRST_VERSION, now),
                });
                await tx.recipes.update({
                    where: { id: recipe.id },
                    data: { current_version_id: version.id },
                });

                return {
                    slug: plan.slug,
                    action: 'created' as const,
                    version: FIRST_VERSION,
                    ingredientRows: plan.ingredients.length,
                    reason: 'no recipes row existed',
                };
            }

            const current = stored.current_version;
            const reasons: string[] = [];

            if (current === null) {
                // A recipes row whose current version is gone — a version
                // retired by hand, or a `SetNull` from a deleted version. It is
                // unplannable until a version is current again, so republishing
                // is the repair rather than a no-op.
                reasons.push('no current version was stored');
            } else {
                const differences = compareStoredContent(toStoredContent(current), plan);
                if (differences.length > 0) {
                    reasons.push(
                        `content changed in ${differences.map((difference) => difference.field).join(', ')}`,
                    );
                }

                const stale = findStaleIngredients(
                    current.recipe_ingredients.map(toSnapshotForStaleness),
                    currentCatalogVersions,
                );
                if (stale.length > 0) {
                    reasons.push(
                        `stale ingredient snapshot: ${stale
                            .map((ingredient) => `${ingredient.name} (${ingredient.changed.join(', ')})`)
                            .join('; ')}`,
                    );
                }
            }

            if (reasons.length === 0 && current !== null) {
                return {
                    slug: plan.slug,
                    action: 'unchanged' as const,
                    version: current.version,
                    ingredientRows: current.recipe_ingredients.length,
                    reason: null,
                };
            }

            // A new version WILL be written from here on, so the facts it cites
            // are re-read and held first — after the no-op return above, which
            // must stay a read (see assertIngredientFactsHold).
            await assertIngredientFactsHold(tx, plan);

            const highestVersion = stored.recipe_versions.reduce(
                (highest, row) => Math.max(highest, row.version),
                0,
            );
            const nextVersion = highestVersion + 1;

            if (current !== null) {
                await tx.recipe_versions.update({
                    where: { id: current.id },
                    data: { status: RETIRED_VERSION_STATUS, retired_at: now },
                });
            }

            const version = await tx.recipe_versions.create({
                data: versionCreateData(plan, stored.id, nextVersion, now),
            });
            await tx.recipes.update({ where: { id: stored.id }, data: { current_version_id: version.id } });

            return {
                slug: plan.slug,
                action: 'promoted' as const,
                version: nextVersion,
                ingredientRows: plan.ingredients.length,
                reason: reasons.join(' | '),
            };
        },
        { timeout: PUBLISH_TRANSACTION_TIMEOUT_MS },
    );

/* ---------------------------------------------------------------------------
 * The coverage report
 *
 * §0.7.3's diet x single-allergen x slot x time-tier table, and the documented
 * boundary of what the seed set promises. Every cell is decided by
 * `recipe.logic.ts::isEligibleForPlanning` — the same function plan generation,
 * swap alternatives and incompatibility flagging come through — so the report
 * cannot promise a profile the planner would refuse.
 *
 * It is derived FROM THE DATABASE, after the writes: a table computed from the
 * files would describe a corpus that may not be what is stored, which is the
 * one thing this artefact exists to rule out.
 * ------------------------------------------------------------------------- */

/** The schema version of the emitted document, bumped when its shape changes. */
const COVERAGE_REPORT_SCHEMA_VERSION = 2;

/** `none` is the mutually exclusive "no allergy" answer, not a tag any food carries. */
const NO_ALLERGEN = 'none';

const COVERAGE_DIETS: readonly RecipeDietPreference[] = ['none', 'vegetarian', 'vegan', 'pescatarian'];

/** The nine named allergens of the preference list, with the no-allergen column first. */
const COVERAGE_ALLERGENS: readonly string[] = [
    NO_ALLERGEN,
    'milk',
    'eggs',
    'peanuts',
    'tree_nuts',
    'soy',
    'wheat',
    'fish',
    'shellfish',
    'sesame',
];

const COVERAGE_SLOTS: readonly MealSlot[] = MEAL_SLOTS;

/** Breakfast, lunch and dinner: the slots §0.7.3 states a guaranteed profile for. */
const COVERAGE_MAIN_SLOTS: readonly MealSlot[] = COVERAGE_SLOTS.slice(0, 3);

/** The four `cooking_time_limit_min` answers, as cumulative ceilings. */
const COVERAGE_TIME_TIERS: readonly number[] = [15, 30, 45, 60];

/** The loosest tier: the one the slot-composition strata are measured at. */
const LOOSEST_TIME_TIER = COVERAGE_TIME_TIERS[COVERAGE_TIME_TIERS.length - 1];

/**
 * The distinct recipes ONE SLOT needs to fill a seven-day week, derived from
 * the production repeat rule rather than restated: a recipe may be used at most
 * {@link MAX_RECIPE_USES_PER_WEEK} times, so {@link PLAN_DAY_COUNT} days need
 * at least ceil(7 / 2) = 4 of them. Fewer is arithmetically unplannable however
 * many recipes are eligible, which is precisely the failure §0.7.3's counting
 * clause could not see.
 */
const WEEK_FILL_MIN_RECIPES_PER_SLOT = Math.ceil(PLAN_DAY_COUNT / MAX_RECIPE_USES_PER_WEEK);

/** A guaranteed cell holds at least this many recipes — what the repeat rule needs for a week. */
const GUARANTEED_THRESHOLD = WEEK_FILL_MIN_RECIPES_PER_SLOT;

/** A reduced cell holds at least this many, which is explicitly NOT enough for a week. */
const REDUCED_THRESHOLD = 2;

/**
 * The two meal schedules a day can be composed for, in the order the report
 * probes them.
 *
 * A DAY is what the tolerance is judged on, and a day is a whole schedule's
 * worth of slots — so feasibility is a property of the schedule and not of one
 * slot. Both are probed because the user picks either: a cell certified on
 * three meals while the same profile cannot be planned with a snack would be a
 * guarantee that half the users it names do not get.
 */
const COVERAGE_SCHEDULES: readonly MealSchedule[] = ['three', 'three_plus_snack'];

/**
 * The day calorie targets the feasibility probe samples, ascending.
 *
 * A POLICY CHOICE, and this is what it represents: THE WHOLE BAND
 * `targets.logic.ts` CAN EMIT, floor to ceiling. Its estimate route floors a day
 * at `CALORIE_FLOOR_BY_SEX` — 1,200 kcal female, 1,500 male — and admits
 * everything up to `CALORIE_CEILING`, 5,000. The band is sampled rather than
 * swept because the derivation runs on every seed: eleven points reach both
 * floors, the middle and the ceiling, and a cell that fails at any of them is
 * not a cell the seed can promise.
 *
 * THE TOP OF THE BAND IS NOT OPTIONAL, and the earlier seven-point set that
 * stopped at 3,000 is the mistake to not make again. It rested on the premise
 * that the estimate "tops out around 3,000 for a large, very active adult
 * gaining weight", which is simply not what the equation does: run
 * `computeTargetEstimate` for a 24-year-old 191 cm 104 kg very active male
 * gaining 1.5 lb a week and it returns 4,405 kcal — a legitimate user of this
 * app, and one every cell was certified without ever being asked about. A
 * sampled band that stops below what the product can hand the planner certifies
 * a promise for some users and silently declines to test it for the rest.
 *
 * Steps are 300 kcal to 3,000 and 500 kcal above it. The coarser upper steps are
 * deliberate rather than lazy: the probe cost grows with the window (a higher
 * target admits more portions of more recipes), the bands widen with the target
 * — carbs and fat are `max(15 g, 15 %)`, so a proportional test does the work —
 * and every added point is paid for on every seed. Eleven points cost about
 * half again what seven did.
 *
 * Fixed and ascending so a rerun samples exactly the same band in exactly the
 * same order — a sampled set derived from anything mutable would make the
 * artefact non-reproducible. The MACRO SPLIT at each point is deliberately not
 * stated here: `deriveMacroTargets` owns it (30/40/30 of energy) and the probe
 * calls it, so the protein floor a day is judged against is the one the product
 * would really set.
 */
const FEASIBILITY_CALORIE_TARGETS: readonly number[] = [
    1200, 1500, 1800, 2100, 2400, 2700, 3000, 3500, 4000, 4500, 5000,
];

/**
 * Candidate PLACEMENTS one cell probe may spend, across every search it runs —
 * one plannability search per sampled target, then one per distinct recipe per
 * slot for the recipes no earlier feasible day has already exhibited.
 *
 * A placement, not a completed day, for the same reason `mealPlan.logic.ts`
 * counts its own budget that way: the walk spends nearly all of its time on
 * prefixes the macro bands cut before they reach a fourth meal, so a cap on
 * completed days would leave the real work unbounded. Measured over the whole
 * cell space, completed days are under a thousandth of the placements.
 *
 * The bound exists because the search space is the product of the slot pools,
 * so it grows steeply with the corpus. Measured end to end on this machine,
 * with the whole 168-probe derivation run to completion:
 *
 *   |  recipes | derivation | placements | worst probe |
 *   |       42 |      3.0 s |      23.9M |       1.27M |
 *   |       84 |     13.3 s |     248.1M |       17.3M |
 *   |      126 |     48.5 s |    1046.3M |       82.6M |
 *
 * 50 million is therefore roughly three times the worst probe of a corpus twice
 * the size of the one this was written against — no realistic corpus trips it —
 * while still bounding the pathological case, where 168 probes each spending
 * the cap is minutes rather than unbounded.
 *
 * A PROBE THAT TRIPS IT REPORTS `searchExhausted` AND CERTIFIES NOTHING. An
 * exhausted search and a proven impossibility are different facts: the first
 * says the derivation does not know, the second says the corpus cannot. Neither
 * certifies a cell, but only the second is a statement about the recipes, and
 * conflating them would let a slow probe read as a thin corpus.
 */
const MAX_FEASIBILITY_EVALUATIONS_PER_PROBE = 50_000_000;

/**
 * The shuffle seed handed to `buildPlanCandidates`.
 *
 * Immaterial to every number this report emits and fixed all the same. That
 * seed only permutes candidates that SCORE equally, which is a property of the
 * generator's move order; the probe never reads `shuffleRank` and orders each
 * slot pool itself (ascending calories, then portable identity). Fixed rather
 * than arbitrary so the call is reproducible on its face.
 */
const FEASIBILITY_CANDIDATE_SHUFFLE_SEED = 1;

/** The tier from which a profile counts as guaranteed with no allergen excluded. */
const GUARANTEED_MIN_TIME_TIER = 45;

/** The tier the reduced clause measures every diet at with no allergen excluded. */
const REDUCED_TIME_TIER = 30;

/** The diets §0.7.3's reduced clause names beside a single allergen. */
const REDUCED_DIETS: readonly RecipeDietPreference[] = ['vegetarian', 'vegan'];

/** §0.7.3's repeat rule: at most two uses a week, never on consecutive days. */
const REPEAT_RULE = {
    maxUsesPerWeek: MAX_RECIPE_USES_PER_WEEK,
    consecutiveDaysAllowed: false,
    minEligiblePerSlotForFullWeek: GUARANTEED_THRESHOLD,
    note:
        'A recipe may be used at most twice in a week and never on consecutive days, so filling seven days of one slot needs at least four eligible recipes. A cell that only meets the reduced threshold of two is NOT sufficient to fill a week for that slot.',
} as const;

/**
 * What every cell means, carried in the artefact so it stays self-describing:
 * a reader of the committed file can check a count by hand without this source.
 */
const ELIGIBILITY_RULE = {
    mirrors: 'src/services/recipe.logic.ts::isEligibleForPlanning',
    clauses: [
        { axis: 'slot', rule: 'the recipe\'s mealSlots contains the slot' },
        { axis: 'diet', rule: 'the diet is \'none\', or the recipe\'s diet tags contain the diet code' },
        { axis: 'allergen', rule: 'the allergen is \'none\', or the recipe\'s allergen tags do not contain it' },
        {
            axis: 'allergenStatus',
            rule: 'the recipe\'s allergenStatus is \'known\' and every ingredient\'s allergen review is \'known\'',
        },
        { axis: 'time', rule: 'prepMinutes + cookMinutes <= timeTier' },
    ],
    dietTagMatching:
        'The diet code is matched against the recipe\'s derived diet tags by exact normalised tag, with no hierarchy re-derivation at count time: containment is already closed into the tags themselves (vegan implies vegetarian implies pescatarian). Seafood admissibility is carried by that same \'pescatarian\' tag and by no other spelling. An earlier revision of the catalog release spelled it \'pescatarian_ok\', which the \'pescatarian\' diet code does not match, so every fish and seafood recipe - having no vegetarian tag for the implication closure to rescue - counted under \'none\' alone and the furtherPescatarian stratum of every main slot read zero. The release, the manifest vocabulary it is imported under and the authored recipe dietTags have since been aligned to \'pescatarian\', so a seafood recipe now counts for the pescatarian diet as intended.',
    recipeTagsAreDerived:
        'Each recipe\'s diet and allergen tags were verified equal to the values derived from its ingredient snapshots, so counting from the declared arrays and counting from the derivation give the same answer.',
    dislikesExcluded:
        'Dislikes are per-user and remove recipes at request time, so they are not an axis of this table; dislike-driven shortfalls surface in the planner\'s catalog_coverage check.',
    timeTiersCumulative:
        'Tiers are cumulative ceilings, so counts are monotonically non-decreasing across 15, 30, 45 and 60 for every diet, allergen and slot triple.',
} as const;

/**
 * THE FEASIBILITY GATE, carried in the artefact for the same reason the
 * eligibility rule is: a reader of the committed file must be able to see what
 * a certified cell claims without this source.
 */
const FEASIBILITY_RULE = {
    mirrors: 'src/services/mealPlan.logic.ts::evaluateDayTolerance + buildPlanCandidates/candidatesForSlot',
    why:
        'Counting eligible recipes cannot tell a plannable cell from an unplannable one. A cell may hold well over the threshold of eligible recipes while NO assignment of one of them per slot lands a day inside the production tolerance - the vegan cells of an earlier corpus held 4 eligible breakfasts, 6 lunches and 8 dinners and yet no vegan day existed at ANY sampled calorie target, the best day inside the smallest calorie window reaching 77 g of protein against a 90 g target, so every vegan user was answered 422 no_matching_meals by a report that called their profile guaranteed. Certification therefore requires a tolerance-satisfying day to EXIST and enough recipes to be USABLE in one, on top of the eligible count.',
    day:
        'A day is one eligible recipe at one allowed portion multiplier per slot of the schedule. Its four totals are summed at full precision and judged by evaluateDayTolerance - the planner\'s own bands, imported rather than restated. The pools, the multiplier grid per slot and the scaling all come from buildPlanCandidates and candidatesForSlot, so a day this report calls feasible is a day the generator could place.',
    usable:
        'A recipe is USABLE for a slot when it appears in at least one feasible day for that slot, which is strictly stronger than eligible: an eligible recipe whose every portion breaches the day bands can never be planned. usable is the minimum over the plannable sampled targets, so it is what holds across the band rather than at its most generous point.',
    week:
        'Seven days need at least ceil(PLAN_DAY_COUNT / MAX_RECIPE_USES_PER_WEEK) = 4 distinct USABLE recipes per slot, because a recipe may be used at most twice a week. A guaranteed cell is measured against that floor; a reduced cell against its own threshold of 2, which §0.7.3 already states is not sufficient for a week.',
    certification:
        'guaranteedCells and reducedCells contain ONLY cells that pass: at least `threshold` eligible recipes, a feasible day at EVERY sampled calorie target on EVERY schedule that contains the slot, and at least `threshold` usable recipes for the slot on each of them. A cell §0.7.3 claims that fails any part is demoted to eligibleNotPlannableCells with the reason, so a reader and the seed suite can trust the two certified lists without re-deriving them.',
    schedules:
        'Both schedules are probed for a main slot because the user picks either; the snack slot exists only in three_plus_snack and is judged there alone.',
    searchBound:
        'Each probe walks its day search depth-first over candidates ordered by ascending calories, pruning any partial day whose greatest remaining amount of a macro cannot reach that macro\'s lower band or whose least remaining amount already exceeds its upper band - all four macros, not calories alone - and entering each slot at the first candidate large enough to close the day rather than stepping over the rest. The walk stops at the first feasible day, and every day it finds counts towards the usable set of every slot at once, so a recipe already exhibited in one needs no search of its own. A probe may spend a bounded number of candidate placements; one that exhausts its budget reports searchExhausted and certifies nothing, because a search that ran out is not a proof that the corpus cannot.',
} as const;

const SLOT_COMPOSITION_NOTES = {
    strata:
        'The four strata partition the recipes eligible for the slot with no allergen excluded at the loosest time tier: vegan; vegetarian but not vegan; pescatarian but not vegetarian; eligible under no diet restriction but not pescatarian. They sum to totalEligible.',
    floors:
        'A floor of null means AAP 0.7.3 states no floor for that stratum at that slot, which is not the same as a floor of zero.',
    crossListing:
        'totalEligible exceeds dedicatedToSlot for lunch and dinner because cross-listed recipes declare both slots and are eligible in each. Cross-listing only adds eligibility; dedicatedToSlot is the auditable floor of recipes authored to that slot alone.',
} as const;

/**
 * The boundary statement §0.7.3 requires the artefact to carry: the table is
 * what the seed PROMISES, and a profile outside it is still served — by the
 * planner's own coverage check, which answers `no_matching_meals` with the
 * limiting-constraint `editStep` rather than an empty plan.
 */
const BOUNDARY_STATEMENT =
    'This report is the documented boundary of what the seed set promises, not a claim that every user profile can be planned. Combinations outside guaranteedCells and reducedCells — two or more excluded allergens, a narrow diet combined with an allergen at the tightest time tier, or dislikes that remove a recipe a guaranteed cell counted — are supported at runtime but not guaranteed. The planner evaluates the user\'s real diet, allergen and dislike intersection and answers 422 no_matching_meals with a limiting-constraint editStep naming what to change, so such a user is told which preference is narrowing the week rather than shown an empty plan.';

/** §0.7.3's per-stratum floors for a main slot: 4 vegan, 3 further vegetarian, 2 further pescatarian, 3 further omnivore. */
const MAIN_SLOT_FLOORS = {
    vegan: 4,
    furtherVegetarian: 3,
    furtherPescatarian: 2,
    furtherOmnivore: 3,
} as const;

/** §0.7.3 states two floors for snacks and none for the other two strata. */
const SNACK_FLOORS = {
    vegan: 4,
    furtherVegetarian: 2,
    furtherPescatarian: null,
    furtherOmnivore: null,
} as const;

export interface CoverageCell {
    readonly diet: string;
    readonly allergen: string;
    readonly slot: string;
    readonly timeTier: number;
    readonly count: number;
}

export interface CoverageThresholdCell extends CoverageCell {
    readonly threshold: number;
    /**
     * Distinct recipes that can actually APPEAR in a feasible day for this
     * slot, minimised over every schedule containing it and every plannable
     * sampled target. Always <= `count`, and the number certification turns on.
     */
    readonly usable: number;
}

/** Why a cell §0.7.3 claims is not certified. */
export type CoverageDemotionReason = 'no_feasible_day' | 'insufficient_usable_recipes' | 'search_exhausted';

/**
 * A claimed cell the feasibility gate refused, with the fact that refused it.
 *
 * `threshold` is the one it would have been certified at, so the demoted list
 * reads as the complement of `guaranteedCells` and `reducedCells` rather than as
 * a separate vocabulary.
 */
export interface CoverageUncertifiedCell extends CoverageThresholdCell {
    readonly reason: CoverageDemotionReason;
    /** The first failing fact, named: which schedule, which target, which count. */
    readonly detail: string;
}

/** One sampled day target, with the macros `deriveMacroTargets` sets for it. */
export interface CoverageSampledTarget {
    readonly calories: number;
    readonly protein: number;
    readonly carbs: number;
    readonly fat: number;
}

/** What one slot of a probed schedule holds: eligible recipes, and usable ones. */
export interface CoverageProbeSlot {
    readonly slot: string;
    readonly eligible: number;
    /** Minimum over the plannable sampled targets; 0 when none of them is plannable. */
    readonly usable: number;
}

/**
 * One (diet, allergen, time tier, schedule) feasibility probe.
 *
 * Keyed on the schedule rather than the slot because a day is a whole
 * schedule's worth of slots, so several cells of the table share one probe —
 * which is also what keeps the derivation affordable.
 */
export interface CoverageFeasibilityProbe {
    readonly diet: string;
    readonly allergen: string;
    readonly timeTier: number;
    readonly schedule: string;
    /** The sampled calorie targets a tolerance-satisfying day was FOUND at, ascending. */
    readonly plannableTargets: readonly number[];
    /** The sampled calorie targets no day was found at, ascending. */
    readonly unplannableTargets: readonly number[];
    /**
     * true when the probe spent its evaluation budget. A target in
     * `unplannableTargets` of an exhausted probe was NOT proven unplannable.
     */
    readonly searchExhausted: boolean;
    /** Candidate placements spent, so a slow probe is visible in the diff. */
    readonly evaluations: number;
    readonly slots: readonly CoverageProbeSlot[];
}

/** How many of §0.7.3's claimed cells survived the gate. */
export interface CoverageCertificationSummary {
    readonly guaranteedClaimed: number;
    readonly guaranteedCertified: number;
    readonly reducedClaimed: number;
    readonly reducedCertified: number;
}

/**
 * The one knob on the derivation, and it exists for ONE reason.
 *
 * Production passes nothing and gets {@link MAX_FEASIBILITY_EVALUATIONS_PER_PROBE}.
 * A suite needs to be able to prove the exhaustion branch — that a probe out of
 * budget reports `searchExhausted` and certifies nothing, instead of reporting a
 * plannable cell as unplannable — and the only honest way to reach that branch
 * without a corpus large enough to make the suite unusable is to lower the
 * budget. The artefact records the cap it ran under, so a report derived at a
 * lowered one says so on its face.
 */
export interface CoverageDerivationOptions {
    readonly maxEvaluationsPerProbe?: number;
}

export interface CoverageFeasibility {
    readonly rule: typeof FEASIBILITY_RULE;
    readonly schedules: readonly string[];
    readonly sampledTargets: readonly CoverageSampledTarget[];
    /** ceil(PLAN_DAY_COUNT / MAX_RECIPE_USES_PER_WEEK) — the week-fill floor. */
    readonly weekFillMinUsableRecipesPerSlot: number;
    readonly evaluationCapPerProbe: number;
    readonly certification: CoverageCertificationSummary;
    readonly probes: readonly CoverageFeasibilityProbe[];
}

export interface CoverageStratum {
    readonly floor: number | null;
    readonly count: number;
}

export interface SlotComposition {
    readonly dedicatedToSlot: number;
    readonly totalEligible: number;
    readonly composition: {
        readonly vegan: CoverageStratum;
        readonly furtherVegetarian: CoverageStratum;
        readonly furtherPescatarian: CoverageStratum;
        readonly furtherOmnivore: CoverageStratum;
    };
}

export interface CoverageReport {
    readonly schemaVersion: number;
    readonly recipeCount: number;
    readonly crossListedRecipeCount: number;
    readonly dimensions: {
        readonly diets: readonly string[];
        readonly allergens: readonly string[];
        readonly slots: readonly string[];
        readonly mainSlots: readonly string[];
        readonly timeTiers: readonly number[];
    };
    readonly eligibilityRule: typeof ELIGIBILITY_RULE;
    readonly repeatRule: typeof REPEAT_RULE;
    readonly slotComposition: Readonly<Record<string, SlotComposition>>;
    readonly slotCompositionNotes: typeof SLOT_COMPOSITION_NOTES;
    readonly eligibleCounts: readonly CoverageCell[];
    readonly feasibility: CoverageFeasibility;
    readonly guaranteedCells: readonly CoverageThresholdCell[];
    readonly reducedCells: readonly CoverageThresholdCell[];
    /**
     * The cells §0.7.3 claims that the feasibility gate refused. EMPTY is what
     * a corpus satisfying §0.7.3 looks like; a non-empty list names every
     * profile the seed promises and cannot serve.
     */
    readonly eligibleNotPlannableCells: readonly CoverageUncertifiedCell[];
    readonly boundary: string;
}

/** One seeded recipe as the report counts it. */
export interface CoverageRecipe {
    readonly slug: string;
    readonly mealSlots: readonly string[];
    /** The DERIVED diet tags, which is what the stratum split reads. */
    readonly dietTags: readonly string[];
    /**
     * `recipe_versions.version` — the other half of the portable identity the
     * feasibility probe orders candidates by. Never a database id: the report
     * identifies a recipe by slug, which is stable across independent loads.
     */
    readonly versionNumber: number;
    /** `recipe_versions.budget_tier`, 1 (cheapest) to 3, as the planner reads it. */
    readonly budgetTier: number;
    /**
     * `recipe_versions.per_serving_*` at full precision.
     *
     * The COUNTING half of the report never needed nutrition; the feasibility
     * half cannot work without it, because what a day sums is these four
     * numbers scaled by the slot's portion multiplier.
     */
    readonly perServing: RecipePerServingNutrition;
    readonly version: PlanningRecipeVersion;
}

const coveragePreferences = (
    diet: RecipeDietPreference,
    allergen: string,
    timeTier: number,
): PlanningPreferences => ({
    diet,
    // `none` means "no allergen excluded", which is an EMPTY list and never the
    // literal tag: matching `none` against a food's tags would exclude every
    // food for the user who declared no allergy at all.
    allergens: allergen === NO_ALLERGEN ? [] : [allergen],
    // Dislikes are per-user and are not an axis of this table.
    disliked_food_ids: [],
    disliked_food_groups: [],
    cooking_time_limit_min: timeTier,
});

const carriesDietTag = (recipe: CoverageRecipe, tag: string): boolean => {
    const target = normalizeCanonicalName(tag);
    return recipe.dietTags.some((candidate) => normalizeCanonicalName(candidate) === target);
};

const eligibleForSlot = (
    recipes: readonly CoverageRecipe[],
    diet: RecipeDietPreference,
    allergen: string,
    slot: MealSlot,
    timeTier: number,
): CoverageRecipe[] =>
    recipes.filter((recipe) =>
        isEligibleForPlanning(recipe.version, coveragePreferences(diet, allergen, timeTier), slot),
    );

const stratumOf = (recipe: CoverageRecipe): keyof typeof MAIN_SLOT_FLOORS => {
    if (carriesDietTag(recipe, 'vegan')) {
        return 'vegan';
    }
    if (carriesDietTag(recipe, 'vegetarian')) {
        return 'furtherVegetarian';
    }
    if (carriesDietTag(recipe, 'pescatarian')) {
        return 'furtherPescatarian';
    }

    return 'furtherOmnivore';
};

/* ---------------------------------------------------------------------------
 * The feasibility half — can a cell the table certifies actually be planned?
 *
 * Everything below answers ONE question per cell: does a day the planner would
 * accept exist, and are enough recipes usable in one to fill a week. It asks it
 * through the production rules and adds none of its own, for the reason the
 * eligibility half is derived rather than declared — a second copy of a
 * tolerance band, a multiplier grid or the repeat limit is the drift this
 * artefact exists to catch.
 * ------------------------------------------------------------------------- */

/**
 * One coverage recipe in the shape the planning rules take.
 *
 * `recipe_id` and `recipe_version_id` carry the PORTABLE identity — the slug,
 * and the slug with its version number — rather than database ids, for two
 * reasons. The report identifies a recipe by slug everywhere else, because that
 * is what is stable across independent catalog loads; and the probe counts a
 * slot's recipes by distinct slug, which is a distinct-RECIPE count exactly as
 * it is against the real rows.
 */
const toPlanningCandidate = (recipe: CoverageRecipe): PlanRecipeCandidate => ({
    ...recipe.version,
    recipe_version_id: `${recipe.slug}@${recipe.versionNumber}`,
    recipe_id: recipe.slug,
    slug: recipe.slug,
    version: recipe.versionNumber,
    budget_tier: recipe.budgetTier,
    per_serving: recipe.perServing,
});

/** One slot's draw for one probe, ordered so the pruned walk is deterministic. */
interface FeasibilitySlotPool {
    readonly slot: MealSlot;
    /** Distinct recipes eligible for the slot — the counting half's number, over the same candidates. */
    readonly eligible: number;
    /** Ascending by calories, then by portable identity and multiplier. */
    readonly candidates: readonly PlanCandidate[];
    /**
     * `candidates[i].nutrition.calories`, extracted so the walk can binary-search
     * its entry point rather than walking past every candidate too small to
     * close the day (see {@link firstCandidateAtLeast}).
     */
    readonly calories: readonly number[];
    /** The distinct recipe slugs in the pool, ascending. */
    readonly slugs: readonly string[];
}

/**
 * The index of the first candidate with at least this many calories.
 *
 * The walk's entry point into an ascending pool. Without it every level starts
 * at the pool's smallest candidate and steps over each one too small to reach
 * the day's lower calorie bound, which on a corpus of a hundred-odd recipes is
 * most of the pool at most levels and was, measured, the bulk of the whole
 * derivation's cost. Returns `candidates.length` when none qualifies, which
 * ends the level without a placement.
 *
 * The threshold handed in is the lower calorie band rearranged, and rearranging
 * it in floating point can move it by an ULP — around 1e-13 at day-sized
 * numbers. That cannot hide a feasible day, because the band it is rearranged
 * from already carries {@link TOLERANCE_EPSILON} of slack in the same
 * direction, four orders of magnitude larger.
 */
const firstCandidateAtLeast = (calories: readonly number[], atLeast: number): number => {
    let low = 0;
    let high = calories.length;

    while (low < high) {
        const middle = (low + high) >>> 1;
        if (calories[middle] < atLeast) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }

    return low;
};

const compareSlug = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

/**
 * Ascending calories first, which is what makes the walk's upper-bound cut a
 * `break` rather than a `continue`; then the portable identity and the
 * multiplier, so two candidates of identical calories still have ONE order.
 * Without that last tie-break the pool order would depend on the input order
 * and a rerun could emit a different `evaluations` figure for the same corpus.
 */
const byCaloriesThenIdentity = (left: PlanCandidate, right: PlanCandidate): number =>
    left.nutrition.calories - right.nutrition.calories ||
    compareSlug(left.recipe.slug, right.recipe.slug) ||
    left.recipe.version - right.recipe.version ||
    left.portionMultiplier - right.portionMultiplier;

/**
 * The four bands a day must land in, widened by {@link TOLERANCE_EPSILON} on
 * both sides.
 *
 * DERIVED FROM THE PRODUCTION CONSTANTS AND DELIBERATELY WEAKER THAN THE
 * VERDICT. Every band here is at least as wide as the one
 * {@link evaluateDayTolerance} applies, so a prefix this window rules out is one
 * the verdict would have rejected too — a prune can therefore only save work
 * and can never hide a feasible day. Exported so
 * `src/__tests__/scripts/recipes-seed.test.ts` can pin it against
 * `evaluateDayTolerance` itself: the one way this could go wrong is the band
 * SHAPE changing in `mealPlan.logic.ts` while these two lines stay as they are,
 * and that test is what would fail the moment it did.
 */
export interface FeasibilityWindow {
    readonly low: MealPlanMacroTotals;
    readonly high: MealPlanMacroTotals;
}

export const feasibilityWindow = (targets: MealPlanMacroTotals): FeasibilityWindow => {
    const carbsBand = Math.max(MACRO_TOLERANCE_ABSOLUTE_G, MACRO_TOLERANCE_RATIO * targets.carbs);
    const fatBand = Math.max(MACRO_TOLERANCE_ABSOLUTE_G, MACRO_TOLERANCE_RATIO * targets.fat);

    return {
        low: {
            calories: targets.calories * (1 - CALORIE_TOLERANCE_RATIO) - TOLERANCE_EPSILON,
            protein: targets.protein - PROTEIN_TOLERANCE_UNDER_G - TOLERANCE_EPSILON,
            carbs: targets.carbs - carbsBand - TOLERANCE_EPSILON,
            fat: targets.fat - fatBand - TOLERANCE_EPSILON,
        },
        high: {
            calories: targets.calories * (1 + CALORIE_TOLERANCE_RATIO) + TOLERANCE_EPSILON,
            protein: targets.protein + PROTEIN_TOLERANCE_OVER_G + TOLERANCE_EPSILON,
            carbs: targets.carbs + carbsBand + TOLERANCE_EPSILON,
            fat: targets.fat + fatBand + TOLERANCE_EPSILON,
        },
    };
};

/**
 * Suffix bounds over the slot pools: the least and greatest of each of the four
 * macros still reachable from slot `index` onwards.
 *
 * These are what turn an intractable product into a search, and all FOUR macros
 * are bounded rather than calories and protein alone. Bounding two of them
 * leaves the walk exploring every prefix that is calorie-plausible but already
 * carb- or fat-doomed, which on a corpus of eighty-odd recipes is the bulk of
 * the tree: measured over the whole cell space, bounding all four cut the
 * derivation from ninety seconds to a few and stopped the evaluation cap being
 * reached at all.
 *
 * An EMPTY pool yields `Infinity` / `-Infinity` deliberately: every prune then
 * fires, which is the correct answer for a schedule one of whose slots has
 * nothing to draw from.
 */
interface FeasibilityBounds {
    readonly low: readonly MealPlanMacroTotals[];
    readonly high: readonly MealPlanMacroTotals[];
}

const suffixBounds = (pools: readonly FeasibilitySlotPool[]): FeasibilityBounds => {
    const zero = (): MealPlanMacroTotals => ({ calories: 0, protein: 0, carbs: 0, fat: 0 });
    const low: MealPlanMacroTotals[] = Array.from({ length: pools.length + 1 }, zero);
    const high: MealPlanMacroTotals[] = Array.from({ length: pools.length + 1 }, zero);

    for (let index = pools.length - 1; index >= 0; index -= 1) {
        const least: MealPlanMacroTotals = {
            calories: Number.POSITIVE_INFINITY,
            protein: Number.POSITIVE_INFINITY,
            carbs: Number.POSITIVE_INFINITY,
            fat: Number.POSITIVE_INFINITY,
        };
        const greatest: MealPlanMacroTotals = {
            calories: Number.NEGATIVE_INFINITY,
            protein: Number.NEGATIVE_INFINITY,
            carbs: Number.NEGATIVE_INFINITY,
            fat: Number.NEGATIVE_INFINITY,
        };

        for (const candidate of pools[index].candidates) {
            least.calories = Math.min(least.calories, candidate.nutrition.calories);
            least.protein = Math.min(least.protein, candidate.nutrition.protein);
            least.carbs = Math.min(least.carbs, candidate.nutrition.carbs);
            least.fat = Math.min(least.fat, candidate.nutrition.fat);
            greatest.calories = Math.max(greatest.calories, candidate.nutrition.calories);
            greatest.protein = Math.max(greatest.protein, candidate.nutrition.protein);
            greatest.carbs = Math.max(greatest.carbs, candidate.nutrition.carbs);
            greatest.fat = Math.max(greatest.fat, candidate.nutrition.fat);
        }

        low[index] = {
            calories: least.calories + low[index + 1].calories,
            protein: least.protein + low[index + 1].protein,
            carbs: least.carbs + low[index + 1].carbs,
            fat: least.fat + low[index + 1].fat,
        };
        high[index] = {
            calories: greatest.calories + high[index + 1].calories,
            protein: greatest.protein + high[index + 1].protein,
            carbs: greatest.carbs + high[index + 1].carbs,
            fat: greatest.fat + high[index + 1].fat,
        };
    }

    return { low, high };
};

/** The completed-day evaluations one probe may spend, and what it has spent. */
interface FeasibilityBudget {
    remaining: number;
    spent: number;
    exhausted: boolean;
}

/**
 * The first assignment of one candidate per slot that satisfies the day
 * tolerance, optionally with one slot pinned to one recipe — or `null` when
 * none exists.
 *
 * Depth-first, first feasible, and pruned on two facts per macro, each of which
 * can only cut assignments {@link evaluateDayTolerance} would reject anyway:
 *
 *  - a prefix whose GREATEST remaining amount of some macro cannot reach that
 *    macro's lower band can never close — skip it and try a larger candidate;
 *  - a prefix whose LEAST remaining amount already exceeds the upper band can
 *    never close either, and for CALORIES that also settles every candidate
 *    after it, because the pool is ascending in calories — so the calorie cut
 *    stops the slot where the other three skip one candidate.
 *
 * The bands come from {@link feasibilityWindow}, which is deliberately wider
 * than the verdict's, so the prune is strictly weaker than the verdict and
 * cannot cut a day the verdict accepts. The VERDICT itself is always
 * `evaluateDayTolerance` on the full four totals: nothing here decides that a
 * day passes.
 *
 * IT RETURNS THE DAY RATHER THAN A BOOLEAN, and that is what makes the usable
 * count affordable. Every feasible day found names one recipe per slot, so a
 * search run to answer "can THIS breakfast appear in a day" simultaneously
 * proves the lunch and the dinner it used can too — and those slots then need
 * no search of their own for those recipes. On a corpus where most recipes are
 * usable that collapses the per-recipe searches by roughly the number of slots.
 *
 * `required` is what makes a recipe's USABILITY answerable in the first place —
 * pinning a slot to one recipe asks "can this recipe appear in any feasible
 * day", which counting eligible recipes cannot answer.
 */
const searchFeasibleDay = (
    pools: readonly FeasibilitySlotPool[],
    bounds: FeasibilityBounds,
    targets: MealPlanMacroTotals,
    budget: FeasibilityBudget,
    required?: { readonly slotIndex: number; readonly slug: string },
): readonly PlanCandidate[] | null => {
    if (budget.exhausted) {
        return null;
    }

    const { low, high } = feasibilityWindow(targets);
    const chosen: PlanCandidate[] = [];
    let day: readonly PlanCandidate[] | null = null;

    const walk = (index: number, running: MealPlanMacroTotals): void => {
        if (day !== null || budget.exhausted) {
            return;
        }

        if (index === pools.length) {
            if (evaluateDayTolerance(running, targets).withinTolerance) {
                day = [...chosen];
            }

            return;
        }

        const pool = pools[index];
        const reachableLow = bounds.low[index + 1];
        const reachableHigh = bounds.high[index + 1];
        // Everything below this is too small to reach the day's lower calorie
        // bound even with the largest remainder, so the level starts here
        // rather than stepping over it.
        const from = firstCandidateAtLeast(pool.calories, low.calories - running.calories - reachableHigh.calories);

        for (let position = from; position < pool.candidates.length; position += 1) {
            const candidate = pool.candidates[position];
            if (required !== undefined && index === required.slotIndex && candidate.recipe.slug !== required.slug) {
                continue;
            }

            // CHARGED HERE, per placement considered, which is what
            // `mealPlan.logic.ts` means by an evaluation too. Charging per
            // completed day instead would leave the real cost unbounded: the
            // walk spends nearly all of its time on prefixes the bands cut,
            // and a corpus can have any number of those per day it completes.
            if (budget.remaining <= 0) {
                budget.exhausted = true;

                return;
            }
            budget.remaining -= 1;
            budget.spent += 1;

            const next: MealPlanMacroTotals = {
                calories: running.calories + candidate.nutrition.calories,
                protein: running.protein + candidate.nutrition.protein,
                carbs: running.carbs + candidate.nutrition.carbs,
                fat: running.fat + candidate.nutrition.fat,
            };

            // The one cut that settles the rest of the slot, and the reason the
            // pool is ordered by calories at all.
            if (next.calories + reachableLow.calories > high.calories) {
                break;
            }
            if (
                next.protein + reachableHigh.protein < low.protein ||
                next.protein + reachableLow.protein > high.protein ||
                next.carbs + reachableHigh.carbs < low.carbs ||
                next.carbs + reachableLow.carbs > high.carbs ||
                next.fat + reachableHigh.fat < low.fat ||
                next.fat + reachableLow.fat > high.fat
            ) {
                continue;
            }

            chosen.push(candidate);
            walk(index + 1, next);
            chosen.pop();

            if (day !== null || budget.exhausted) {
                return;
            }
        }
    };

    walk(0, { calories: 0, protein: 0, carbs: 0, fat: 0 });

    return day;
};

/**
 * The distinct recipes of each slot that can appear in a feasible day at this
 * target, or `null` when the budget ran out before the question was settled.
 *
 * EXACT, not a sample: a recipe is counted only once a day containing it has
 * been exhibited, and it is ruled out only once its own pinned search has run
 * to completion. The incidental marking above is purely an ordering: it changes
 * which searches are needed, never the answer they add up to.
 */
const usableRecipesBySlot = (
    pools: readonly FeasibilitySlotPool[],
    bounds: FeasibilityBounds,
    targets: MealPlanMacroTotals,
    budget: FeasibilityBudget,
    firstDay: readonly PlanCandidate[],
): readonly number[] | null => {
    const usable = pools.map(() => new Set<string>());
    const mark = (day: readonly PlanCandidate[]): void => {
        day.forEach((candidate, slotIndex) => {
            usable[slotIndex].add(candidate.recipe.slug);
        });
    };

    mark(firstDay);

    for (let slotIndex = 0; slotIndex < pools.length; slotIndex += 1) {
        for (const slug of pools[slotIndex].slugs) {
            if (usable[slotIndex].has(slug)) {
                continue;
            }

            const day = searchFeasibleDay(pools, bounds, targets, budget, { slotIndex, slug });
            if (budget.exhausted) {
                return null;
            }
            if (day !== null) {
                mark(day);
            }
        }
    }

    return usable.map((slugs) => slugs.size);
};

/** The schedules whose slot list contains this slot — both, or `three_plus_snack` alone. */
const schedulesForSlot = (slot: MealSlot): readonly MealSchedule[] =>
    COVERAGE_SCHEDULES.filter((schedule) => scheduleSlots(schedule).includes(slot));

const probeKey = (diet: string, allergen: string, timeTier: number, schedule: string): string =>
    `${diet}|${allergen}|${timeTier}|${schedule}`;

/**
 * One (diet, allergen, tier, schedule) probe: which sampled targets are
 * plannable, and how many recipes per slot are usable in a feasible day.
 *
 * The budget is per PROBE and shared by every search it runs, so the bound is
 * on the work one row of the table costs rather than on one search — a probe
 * that answers its plannability question cheaply and then spends everything
 * counting usable recipes is exactly as bounded as one that does the reverse.
 * Spending order matters and is deliberate: plannability for the target first
 * (cheap, and the answer certification needs most), then the per-recipe counts.
 * A budget that runs out mid-count DISCARDS that target's partial counts rather
 * than minimising a half-finished number into the report.
 */
const probeFeasibility = (
    candidates: readonly PlanCandidate[],
    preferences: PlanningPreferences,
    diet: string,
    allergen: string,
    timeTier: number,
    schedule: MealSchedule,
    evaluationCap: number,
): CoverageFeasibilityProbe => {
    const pools: FeasibilitySlotPool[] = scheduleSlots(schedule).map((slot) => {
        const forSlot = [...candidatesForSlot(candidates, preferences, slot)].sort(byCaloriesThenIdentity);
        const slugs = [...new Set(forSlot.map((candidate) => candidate.recipe.slug))].sort(compareSlug);

        return {
            slot,
            // The distinct recipes of the pool ARE what
            // `eligibleRecipeCountForSlot` counts, over the same candidates
            // from the same helper — so the count is taken from the pool rather
            // than by calling it, which would re-run `isEligibleForPlanning`
            // over every candidate a second time and is the single most
            // expensive thing this derivation could do twice. The test
            // `agrees with the counting half on how many recipes a slot holds`
            // pins this figure against `eligibleCounts`, which reaches it by a
            // different route.
            eligible: slugs.length,
            candidates: forSlot,
            calories: forSlot.map((candidate) => candidate.nutrition.calories),
            slugs,
        };
    });

    const bounds = suffixBounds(pools);
    const budget: FeasibilityBudget = { remaining: evaluationCap, spent: 0, exhausted: false };

    const plannableTargets: number[] = [];
    const unplannableTargets: number[] = [];
    const usable = pools.map(() => Number.POSITIVE_INFINITY);

    for (const calories of FEASIBILITY_CALORIE_TARGETS) {
        const targets = deriveMacroTargets(calories);
        const firstDay = searchFeasibleDay(pools, bounds, targets, budget);

        if (budget.exhausted) {
            break;
        }
        if (firstDay === null) {
            unplannableTargets.push(calories);
            continue;
        }

        const counts = usableRecipesBySlot(pools, bounds, targets, budget, firstDay);
        if (counts === null) {
            break;
        }

        plannableTargets.push(calories);
        counts.forEach((count, slotIndex) => {
            usable[slotIndex] = Math.min(usable[slotIndex], count);
        });
    }

    return {
        diet,
        allergen,
        timeTier,
        schedule,
        plannableTargets,
        unplannableTargets,
        searchExhausted: budget.exhausted,
        evaluations: budget.spent,
        slots: pools.map((pool, slotIndex) => ({
            slot: pool.slot,
            eligible: pool.eligible,
            // Infinity survives only when no target was plannable, and nothing
            // is usable in a day that does not exist.
            usable: Number.isFinite(usable[slotIndex]) ? usable[slotIndex] : 0,
        })),
    };
};

/** One cell §0.7.3 claims, before the gate has decided whether it holds. */
interface CoverageClaim {
    /** Which of §0.7.3's two promises this cell is made under. */
    readonly tier: 'guaranteed' | 'reduced';
    readonly diet: RecipeDietPreference;
    readonly allergen: string;
    readonly slot: MealSlot;
    readonly timeTier: number;
    readonly threshold: number;
}

/**
 * The gate's verdict on one claimed cell, over every schedule the slot lives in.
 *
 * REFUSED IN PRECEDENCE ORDER, because the three refusals are different facts
 * and the strongest claim the report can make is the one it actually
 * established: an exhausted search first (the derivation does not know), then a
 * target with no feasible day (the corpus cannot serve the band), then too few
 * usable recipes (the corpus can serve a day but not a week).
 */
interface CoverageVerdict {
    readonly usable: number;
    readonly reason: CoverageDemotionReason | null;
    readonly detail: string;
}

const certifyClaim = (
    claim: CoverageClaim,
    probes: ReadonlyMap<string, CoverageFeasibilityProbe>,
    eligibleCount: number,
    evaluationCap: number,
): CoverageVerdict => {
    const relevant = schedulesForSlot(claim.slot).map((schedule) => {
        const probe = probes.get(probeKey(claim.diet, claim.allergen, claim.timeTier, schedule));
        if (probe === undefined) {
            // Unreachable by construction — the probe set is derived FROM the
            // claims — and thrown rather than defaulted because a missing probe
            // would otherwise certify a cell nothing measured.
            throw new RecipeSeedError(
                'publication_failed',
                `no feasibility probe for ${claim.diet}/${claim.allergen}/${claim.timeTier}min/${schedule}, ` +
                    `so the ${claim.slot} cell cannot be certified`,
            );
        }

        return { schedule, probe, slot: probe.slots.find((entry) => entry.slot === claim.slot) };
    });

    const usable = Math.min(...relevant.map(({ slot }) => slot?.usable ?? 0));

    const exhausted = relevant.find(({ probe }) => probe.searchExhausted);
    if (exhausted !== undefined) {
        return {
            usable,
            reason: 'search_exhausted',
            detail:
                `the ${exhausted.schedule} probe spent its budget of ${evaluationCap} ` +
                'day evaluations before the cell was decided, so the corpus was neither proven able nor unable to serve it',
        };
    }

    const unplannable = relevant.find(({ probe }) => probe.unplannableTargets.length > 0);
    if (unplannable !== undefined) {
        return {
            usable,
            reason: 'no_feasible_day',
            detail:
                `no ${unplannable.schedule} day satisfies the tolerance at a ` +
                `${unplannable.probe.unplannableTargets[0]} kcal target, one of the ` +
                `${FEASIBILITY_CALORIE_TARGETS.length} sampled targets`,
        };
    }

    const short = relevant.find(({ slot }) => (slot?.usable ?? 0) < claim.threshold);
    if (short !== undefined) {
        return {
            usable,
            reason: 'insufficient_usable_recipes',
            detail:
                `${short.slot?.usable ?? 0} of ${eligibleCount} eligible ${claim.slot} recipes can appear in a ` +
                `feasible ${short.schedule} day, short of the ${claim.threshold} this cell is measured against`,
        };
    }

    return { usable, reason: null, detail: '' };
};

/**
 * The §0.7.3 coverage table, derived from the seeded recipes.
 *
 * Pure and exported: the report is the artefact reviewers read and
 * `seed-rerun.test.ts` asserts against, so the derivation is unit-testable from
 * plain objects with no database in the way. Key and array order are fixed by
 * the loops below rather than by any map iteration, which is what makes a rerun
 * byte-identical.
 */
export const deriveCoverageReport = (
    recipes: readonly CoverageRecipe[],
    options: CoverageDerivationOptions = {},
): CoverageReport => {
    const evaluationCap = options.maxEvaluationsPerProbe ?? MAX_FEASIBILITY_EVALUATIONS_PER_PROBE;
    if (!Number.isInteger(evaluationCap) || evaluationCap < 1) {
        throw new RecipeSeedError(
            'publication_failed',
            `maxEvaluationsPerProbe must be a whole number of at least 1 for the feasibility gate to decide anything, received ${render(options.maxEvaluationsPerProbe)}`,
        );
    }

    const eligibleCounts: CoverageCell[] = [];
    for (const diet of COVERAGE_DIETS) {
        for (const allergen of COVERAGE_ALLERGENS) {
            for (const slot of COVERAGE_SLOTS) {
                for (const timeTier of COVERAGE_TIME_TIERS) {
                    eligibleCounts.push({
                        diet,
                        allergen,
                        slot,
                        timeTier,
                        count: eligibleForSlot(recipes, diet, allergen, slot, timeTier).length,
                    });
                }
            }
        }
    }

    const countOf = new Map(
        eligibleCounts.map((cell) => [`${cell.diet}|${cell.allergen}|${cell.slot}|${cell.timeTier}`, cell.count]),
    );

    // GUARANTEED (>= 4 eligible, which is what the repeat rule needs for a
    // seven-day week): every diet with no allergen at 45 minutes or looser, for
    // every slot; and the `none` diet with any single allergen at any tier, for
    // every main slot.
    const guaranteedClaims: CoverageClaim[] = [];
    for (const diet of COVERAGE_DIETS) {
        for (const slot of COVERAGE_SLOTS) {
            for (const timeTier of COVERAGE_TIME_TIERS) {
                if (timeTier >= GUARANTEED_MIN_TIME_TIER) {
                    guaranteedClaims.push({
                        tier: 'guaranteed',
                        diet,
                        allergen: NO_ALLERGEN,
                        slot,
                        timeTier,
                        threshold: GUARANTEED_THRESHOLD,
                    });
                }
            }
        }
    }
    for (const allergen of COVERAGE_ALLERGENS) {
        if (allergen === NO_ALLERGEN) {
            continue;
        }
        for (const slot of COVERAGE_MAIN_SLOTS) {
            for (const timeTier of COVERAGE_TIME_TIERS) {
                guaranteedClaims.push({
                    tier: 'guaranteed',
                    diet: 'none',
                    allergen,
                    slot,
                    timeTier,
                    threshold: GUARANTEED_THRESHOLD,
                });
            }
        }
    }

    // REDUCED (>= 2 eligible, asserted and explicitly NOT sufficient for the
    // repeat rule): vegan or vegetarian with any single allergen at 45 minutes
    // or looser, for every main slot; and every diet with no allergen at the
    // 30-minute tier, for every slot. Disjoint from the guaranteed set by
    // construction — the first clause excludes the `none` diet and the second
    // sits below the guaranteed tier.
    const reducedClaims: CoverageClaim[] = [];
    for (const diet of COVERAGE_DIETS) {
        if (!REDUCED_DIETS.includes(diet)) {
            continue;
        }
        for (const allergen of COVERAGE_ALLERGENS) {
            if (allergen === NO_ALLERGEN) {
                continue;
            }
            for (const slot of COVERAGE_MAIN_SLOTS) {
                for (const timeTier of COVERAGE_TIME_TIERS) {
                    if (timeTier >= GUARANTEED_MIN_TIME_TIER) {
                        reducedClaims.push({
                            tier: 'reduced',
                            diet,
                            allergen,
                            slot,
                            timeTier,
                            threshold: REDUCED_THRESHOLD,
                        });
                    }
                }
            }
        }
    }
    for (const diet of COVERAGE_DIETS) {
        for (const slot of COVERAGE_SLOTS) {
            reducedClaims.push({
                tier: 'reduced',
                diet,
                allergen: NO_ALLERGEN,
                slot,
                timeTier: REDUCED_TIME_TIER,
                threshold: REDUCED_THRESHOLD,
            });
        }
    }

    // THE FEASIBILITY PROBES, derived FROM the claims and not from the whole
    // dimension product: the gate exists to decide the cells §0.7.3 promises,
    // so those are what is measured, and measuring the rest would multiply the
    // cost of every seed for numbers nothing reads. Several cells share one
    // probe — every slot of one (diet, allergen, tier, schedule) triple is
    // answered by the same day search — which is what keeps the whole
    // derivation to the order of a hundred and sixty searches rather than a
    // thousand. Ordered by the dimensions themselves rather than by claim
    // discovery, so the emitted list is stable under a reordering of the
    // clauses above.
    const planningCandidates = recipes.map(toPlanningCandidate);
    const probeOrder: { diet: RecipeDietPreference; allergen: string; timeTier: number; schedule: MealSchedule }[] = [];
    const wanted = new Set<string>();
    for (const claim of [...guaranteedClaims, ...reducedClaims]) {
        for (const schedule of schedulesForSlot(claim.slot)) {
            wanted.add(probeKey(claim.diet, claim.allergen, claim.timeTier, schedule));
        }
    }
    for (const diet of COVERAGE_DIETS) {
        for (const allergen of COVERAGE_ALLERGENS) {
            for (const timeTier of COVERAGE_TIME_TIERS) {
                for (const schedule of COVERAGE_SCHEDULES) {
                    if (wanted.has(probeKey(diet, allergen, timeTier, schedule))) {
                        probeOrder.push({ diet, allergen, timeTier, schedule });
                    }
                }
            }
        }
    }

    const probes: CoverageFeasibilityProbe[] = [];
    const probesByKey = new Map<string, CoverageFeasibilityProbe>();
    // `buildPlanCandidates` is the expensive step and is shared by both
    // schedules of one (diet, allergen, tier) triple, so it is built once per
    // triple rather than once per probe. A ONE-ENTRY cache is enough precisely
    // because `probeOrder` loops the schedule innermost, so a triple's probes
    // are always consecutive; it is keyed all the same, so a reordering of
    // those loops would cost a rebuild rather than silently reuse the wrong
    // pool.
    let builtKey = '';
    let built: readonly PlanCandidate[] = [];
    for (const { diet, allergen, timeTier, schedule } of probeOrder) {
        const preferences = coveragePreferences(diet, allergen, timeTier);
        const key = `${diet}|${allergen}|${timeTier}`;
        if (key !== builtKey) {
            built = buildPlanCandidates(planningCandidates, preferences, FEASIBILITY_CANDIDATE_SHUFFLE_SEED);
            builtKey = key;
        }

        const probe = probeFeasibility(built, preferences, diet, allergen, timeTier, schedule, evaluationCap);
        probes.push(probe);
        probesByKey.set(probeKey(diet, allergen, timeTier, schedule), probe);
    }

    // CERTIFICATION. `guaranteedCells` and `reducedCells` hold only what passed
    // the gate; every claim that failed is demoted to
    // `eligibleNotPlannableCells` with the fact that refused it, so the two
    // certified lists can be trusted without re-deriving them and nothing
    // §0.7.3 claims disappears silently.
    const guaranteedCells: CoverageThresholdCell[] = [];
    const reducedCells: CoverageThresholdCell[] = [];
    const eligibleNotPlannableCells: CoverageUncertifiedCell[] = [];

    for (const claim of [...guaranteedClaims, ...reducedClaims]) {
        const count = countOf.get(`${claim.diet}|${claim.allergen}|${claim.slot}|${claim.timeTier}`) ?? 0;
        const verdict = certifyClaim(claim, probesByKey, count, evaluationCap);
        const cell: CoverageThresholdCell = {
            diet: claim.diet,
            allergen: claim.allergen,
            slot: claim.slot,
            timeTier: claim.timeTier,
            threshold: claim.threshold,
            count,
            usable: verdict.usable,
        };

        if (count < claim.threshold) {
            // The counting clause is still a clause: a cell too thin to reach
            // its threshold is refused here, and the feasibility verdict
            // explains why it is also unplannable when it is.
            eligibleNotPlannableCells.push({
                ...cell,
                reason: verdict.reason ?? 'insufficient_usable_recipes',
                detail:
                    `${count} eligible ${claim.slot} recipes, short of the threshold of ${claim.threshold}` +
                    (verdict.detail === '' ? '' : `; ${verdict.detail}`),
            });
            continue;
        }

        if (verdict.reason !== null) {
            eligibleNotPlannableCells.push({ ...cell, reason: verdict.reason, detail: verdict.detail });
            continue;
        }

        if (claim.tier === 'guaranteed') {
            guaranteedCells.push(cell);
        } else {
            reducedCells.push(cell);
        }
    }

    const slotComposition: Record<string, SlotComposition> = {};
    for (const slot of COVERAGE_SLOTS) {
        const eligible = eligibleForSlot(recipes, 'none', NO_ALLERGEN, slot, LOOSEST_TIME_TIER);
        const floors = slot === 'snack' ? SNACK_FLOORS : MAIN_SLOT_FLOORS;
        const counted: Record<keyof typeof MAIN_SLOT_FLOORS, number> = {
            vegan: 0,
            furtherVegetarian: 0,
            furtherPescatarian: 0,
            furtherOmnivore: 0,
        };
        for (const recipe of eligible) {
            counted[stratumOf(recipe)] += 1;
        }

        slotComposition[slot] = {
            dedicatedToSlot: recipes.filter(
                (recipe) => recipe.mealSlots.length === 1 && recipe.mealSlots[0] === slot,
            ).length,
            totalEligible: eligible.length,
            composition: {
                vegan: { floor: floors.vegan, count: counted.vegan },
                furtherVegetarian: { floor: floors.furtherVegetarian, count: counted.furtherVegetarian },
                furtherPescatarian: { floor: floors.furtherPescatarian, count: counted.furtherPescatarian },
                furtherOmnivore: { floor: floors.furtherOmnivore, count: counted.furtherOmnivore },
            },
        };
    }

    return {
        schemaVersion: COVERAGE_REPORT_SCHEMA_VERSION,
        recipeCount: recipes.length,
        crossListedRecipeCount: recipes.filter((recipe) => recipe.mealSlots.length > 1).length,
        dimensions: {
            diets: COVERAGE_DIETS,
            allergens: COVERAGE_ALLERGENS,
            slots: COVERAGE_SLOTS,
            mainSlots: COVERAGE_MAIN_SLOTS,
            timeTiers: COVERAGE_TIME_TIERS,
        },
        eligibilityRule: ELIGIBILITY_RULE,
        repeatRule: REPEAT_RULE,
        slotComposition,
        slotCompositionNotes: SLOT_COMPOSITION_NOTES,
        eligibleCounts,
        feasibility: {
            rule: FEASIBILITY_RULE,
            schedules: COVERAGE_SCHEDULES,
            sampledTargets: FEASIBILITY_CALORIE_TARGETS.map((calories) => deriveMacroTargets(calories)),
            weekFillMinUsableRecipesPerSlot: WEEK_FILL_MIN_RECIPES_PER_SLOT,
            evaluationCapPerProbe: evaluationCap,
            certification: {
                guaranteedClaimed: guaranteedClaims.length,
                guaranteedCertified: guaranteedCells.length,
                reducedClaimed: reducedClaims.length,
                reducedCertified: reducedCells.length,
            },
            probes,
        },
        guaranteedCells,
        reducedCells,
        eligibleNotPlannableCells,
        boundary: BOUNDARY_STATEMENT,
    };
};

/**
 * A recipe read back from the database in the shape the report counts.
 *
 * `allergen_status`, `food_group`, the nutrition basis and its density come
 * from the JOINED `catalog_foods` row because `recipe_ingredients` does not
 * snapshot them — the same join `recipe.service.ts` performs at read time — and
 * the eligibility rule reads all four.
 */
export const toCoverageRecipe = (row: JoinedRecipeRow): CoverageRecipe => {
    const version = row.current_version;
    if (version === null) {
        throw new RecipeSeedError(
            'publication_failed',
            `${row.slug}: no current version is stored, so the coverage report cannot count it`,
        );
    }

    const ingredients: RecipePublicationIngredient[] = version.recipe_ingredients.map((ingredient) => ({
        catalog_food_id: ingredient.catalog_food_id,
        snapshot_name: ingredient.snapshot_name,
        snapshot_provenance: ingredient.snapshot_provenance as RecipePublicationIngredient['snapshot_provenance'],
        snapshot_allergen_tags: ingredient.snapshot_allergen_tags,
        snapshot_diet_tags: ingredient.snapshot_diet_tags,
        is_optional: ingredient.is_optional,
        food_group: ingredient.catalog_foods.food_group,
        allergen_status: ingredient.catalog_foods.allergen_status as RecipeAllergenStatus,
        cost_class: ingredient.catalog_foods.cost_class,
        catalog_nutrition_version: ingredient.catalog_nutrition_version,
        catalog_metadata_version: ingredient.catalog_metadata_version,
        snapshot_per_100g: ingredient.snapshot_per_100g as RecipeIngredientNutrientSnapshot,
        quantity: ingredient.quantity,
        unit: ingredient.unit,
        gram_weight: ingredient.gram_weight,
        display_text: ingredient.display_text,
        sort_order: ingredient.sort_order,
        nutrition_basis: ingredient.catalog_foods.nutrition_basis as RecipeNutritionBasis,
        density_g_per_ml: ingredient.catalog_foods.density_g_per_ml,
    }));

    return {
        slug: row.slug,
        mealSlots: version.meal_slots,
        // DERIVED from the snapshots rather than read from the summary column,
        // exactly as the eligibility rule derives them: the column is a record
        // of that derivation and the two must never be able to disagree.
        dietTags: deriveDietTags(ingredients),
        versionNumber: version.version,
        budgetTier: version.budget_tier,
        // Read from the STORED per-serving columns rather than recomputed from
        // the ingredient set: the validation pass has already proved the two
        // agree for every file it published (`validateRecipeFile`), and the
        // planner plans from these columns, so the feasibility probe has to
        // judge the same four numbers a real plan would sum.
        perServing: {
            calories: version.per_serving_calories,
            protein: version.per_serving_protein_g,
            carbs: version.per_serving_carbs_g,
            fat: version.per_serving_fat_g,
        },
        version: {
            status: version.status === CURRENT_VERSION_STATUS ? 'current' : 'retired',
            nutrition_provenance:
                version.nutrition_provenance as PlanningRecipeVersion['nutrition_provenance'],
            allergen_status: version.allergen_status as RecipeAllergenStatus,
            total_minutes: version.total_minutes,
            meal_slots: version.meal_slots,
            ingredients,
        },
    };
};

const COVERAGE_READ_INCLUDE = {
    current_version: {
        include: {
            recipe_ingredients: {
                include: {
                    catalog_foods: {
                        select: {
                            food_group: true,
                            allergen_status: true,
                            cost_class: true,
                            nutrition_basis: true,
                            density_g_per_ml: true,
                        },
                    },
                },
                orderBy: { sort_order: 'asc' },
            },
        },
    },
};

/* ---------------------------------------------------------------------------
 * The stage.
 * ------------------------------------------------------------------------- */

export interface SeedDeps {
    /** The narrow client slice this stage writes through. */
    readonly prisma: SeedDb;
    /** Absolute path to the recipe directory; injected so a suite seeds a temporary corpus. */
    readonly recipesDir: string;
    /** The publication clock. Injected so `published_at` is an assertable value in a suite. */
    readonly now: () => Date;
    readonly options: SeedOptions;
    readonly logger: ScriptLogger;
    /** The food-group taxonomy half of the instruction vocabulary. */
    readonly coveragePlan: CoveragePlan;
    /**
     * Absolute path the coverage report is written to. Injected for the same
     * reason as the directory: a suite must be able to produce the artefact
     * without overwriting the committed one.
     */
    readonly reportPath: string;
    readonly writeReport: (absolutePath: string, value: unknown) => void;
    /**
     * The client the RUN LEDGER is written through — `catalog_import_runs` and
     * nothing else.
     *
     * Optional, and it defaults to `prisma`: in production `main` hands the one
     * singleton to both, and so does every suite that drives this stage. It is
     * separable for the one case where the two must not be the same object — a
     * suite that faults the publication client to prove a rollback would
     * otherwise fault the ledger write that records that failure. When it is
     * omitted the publication client is probed for the ledger delegate, and a
     * client that cannot reach it refuses the run (`run_ledger_unavailable`)
     * rather than publishing work that nothing records.
     *
     * Typed as checkpoint.ts's own `CatalogRunDb` because the cursor and the
     * terminal close go through that module's locked writers, which take
     * exactly that client.
     */
    readonly runDb?: CatalogRunDb;
    /**
     * Runs the whole stage while the catalog graph is held, and releases it
     * afterwards however the stage ended.
     *
     * Optional, defaulting to the real shared hold on the graph's stage lock
     * (see the header's THE CATALOG MUST NOT MOVE WHILE THIS STAGE PUBLISHES).
     * It is a seam rather than a fixed call for the two things a suite needs and
     * cannot get otherwise: driving the stage with no second connection to
     * PostgreSQL, and asserting that the hold is actually taken around the whole
     * run rather than around part of it. Production never passes it, so the lock
     * is not something the stage opts into.
     */
    readonly runUnderCatalogLock?: <T>(work: () => Promise<T>) => Promise<T>;
    /**
     * Runs the whole publishing stage as the one recipe-seed writer, and
     * releases that exclusivity afterwards however the stage ended.
     *
     * Optional, defaulting to the real exclusive, session-scoped hold (see
     * runUnderWriterHold), and bypassed entirely for a dry run, which publishes
     * nothing to own. Production never passes it, so the lock is not something
     * the stage opts into.
     *
     * It is a seam for the one thing a suite cannot otherwise produce: a
     * ZOMBIE. The lock's whole value is that it dies with its session, and the
     * case that leaves — a process whose lock session died while the process
     * kept running and kept a usable connection pool — is unreachable from a
     * test that can only kill whole processes. A pass-through injected here IS
     * that process, which is how the attempt fence (`assertAttemptOwnsRun`) is
     * driven deterministically rather than hoped for.
     */
    readonly runUnderWriterLock?: <T>(work: () => Promise<T>) => Promise<T>;
}

/** What this invocation recorded in `catalog_import_runs`. */
export interface SeedRunRecord {
    readonly runId: string;
    /** The corpus fingerprint the run is addressed by, stored as `manifest_version`. */
    readonly manifestVersion: string;
    /** True when this invocation continued a run an earlier attempt left open. */
    readonly resumed: boolean;
    /** Which attempt at this run's corpus this invocation is; 1 for a fresh run. */
    readonly attempt: number;
    /**
     * The newest run that had already SUCCEEDED for this same corpus, or `null`
     * when there was none. Recorded rather than turned into a no-op — see
     * `claimRecipeSeedRun`.
     */
    readonly previousSucceededRunId: string | null;
}

export interface SeedOutcome {
    readonly selected: readonly string[];
    readonly created: readonly string[];
    readonly promoted: readonly string[];
    readonly unchanged: readonly string[];
    /** Ingredient rows the run wrote; zero for a no-op rerun and for a dry run. */
    readonly ingredientRows: number;
    readonly dryRun: boolean;
    readonly report: CoverageReport | null;
    readonly reportPath: string | null;
    /** Why no report was written, or `null` when one was. */
    readonly reportSkippedReason: string | null;
    /**
     * The ledger row this invocation owned, or `null` for a dry run and for an
     * `--only`-narrowed run: neither is an attempt at the whole corpus, so
     * neither claims one.
     */
    readonly run: SeedRunRecord | null;
    /** Why no run was claimed, or `null` when one was. */
    readonly runSkippedReason: string | null;
}

/* ---------------------------------------------------------------------------
 * THE RUN LEDGER
 *
 * §0.7.1's interruption-and-recovery requirement, for a stage that publishes
 * one transaction per recipe. A run row makes three questions answerable after
 * the fact that are unanswerable without one: did the last attempt finish, how
 * far did it get, and was it working on THIS corpus.
 *
 * The identity is the corpus, not the clock: `manifest_version` is a
 * fingerprint of the coverage plan version plus every selected file's bytes, so
 * a rerun of the same corpus addresses the same run and an edited corpus is new
 * work by construction.
 * ------------------------------------------------------------------------- */

/**
 * The corpus fingerprint, stored as the run's `manifest_version`.
 *
 * Formatted exactly like checkpoint.ts's `canonicalValidationRunKey` — the
 * policy version, `@`, and twelve hex characters of a SHA-256 — and for the same
 * reason: `manifest_version` is a column an operator reads in a terminal, so the
 * readable half stays readable and the input is hashed rather than embedded.
 * Twelve hex characters distinguish every corpus a database will ever hold.
 *
 * The coverage plan version is part of it because the plan supplies the
 * food-group vocabulary the instruction-completeness check refuses files with:
 * the same files under a new vocabulary are a different judgement and therefore
 * different work.
 */
export const deriveCorpusFingerprint = (
    coveragePlanVersion: string,
    digests: readonly RecipeFileDigest[],
): string => {
    // Sorted by file name rather than trusted to arrive ordered, so the
    // fingerprint is a function of the corpus's CONTENT and not of directory
    // iteration order — the same rule catalogInputIdentity follows.
    const canonical = [...digests]
        .sort((left, right) => (left.file < right.file ? -1 : left.file > right.file ? 1 : 0))
        .map((digest) => `${digest.file}\t${digest.sha256}`)
        .join('\n');

    return `${coveragePlanVersion}@${crypto
        .createHash('sha256')
        .update(`${digests.length}\n${canonical}`)
        .digest('hex')
        .slice(0, 12)}`;
};

/**
 * The run's stored cursor: what this attempt has settled, and the lease that
 * makes the attempt recognisable as live.
 *
 * Per ATTEMPT rather than cumulative across attempts. A resumed run's tallies
 * would otherwise count a slug twice — once as the created row an interrupted
 * attempt committed and once as the unchanged row the resuming attempt read —
 * and `settledSlugs` would exceed `corpusSlugs`, which is the kind of number
 * nobody can act on. The interrupted attempt's own watermark is not lost: the
 * claim appends it to the run's `log` before it overwrites the cursor.
 */
export interface RecipeSeedCursor {
    /** 1 for a fresh run, incremented each time an attempt takes over an open one. */
    readonly attempt: number;
    /** Recipes this attempt was asked to reconcile. */
    readonly corpusSlugs: number;
    /** Recipes whose transaction has COMMITTED in this attempt. */
    readonly settledSlugs: number;
    /** The slug watermark: the last recipe this attempt settled. */
    readonly lastSlug: string | null;
    readonly lastAction: PublishAction | null;
    readonly created: number;
    readonly promoted: number;
    readonly unchanged: number;
    readonly ingredientRows: number;
    /**
     * ISO instant. While it is in the future another invocation treats this run
     * as live and refuses; once it has lapsed the run is resumable (see
     * RECIPE_SEED_RUN_LEASE_MS).
     */
    readonly leaseUntil: string;
    /**
     * THE FENCE. An unguessable token identifying the attempt that owns this run
     * right now, minted on the fresh claim and ROTATED on every takeover.
     *
     * It lives in the cursor rather than in a column of its own because
     * `catalog_import_runs` has no such column and this stage does not get to
     * add one — prisma/schema.prisma is a shared surface and the cursor is the
     * JSONB shape this file already owns end to end (`cursorFrom` composes it,
     * nothing else reads it). Every write this attempt makes against the run
     * compares its own token with the stored one under a row lock, so a
     * superseded attempt is refused rather than merely unlikely (see
     * assertAttemptOwnsRun).
     */
    readonly attemptToken: string;
}

/** The attempt's running tally, which the cursor and the terminal counts are both written from. */
interface SeedRunProgress {
    attempt: number;
    settled: number;
    created: number;
    promoted: number;
    unchanged: number;
    ingredientRows: number;
    lastSlug: string | null;
    lastAction: PublishAction | null;
}

const newRunProgress = (attempt: number): SeedRunProgress => ({
    attempt,
    settled: 0,
    created: 0,
    promoted: 0,
    unchanged: 0,
    ingredientRows: 0,
    lastSlug: null,
    lastAction: null,
});

/**
 * A fresh attempt token.
 *
 * `randomUUID` rather than a counter, a timestamp or the attempt number,
 * because the token's only job is to be UNGUESSABLE: a superseded attempt must
 * not be able to reconstruct the value that would let its write through, and a
 * value derived from anything it already knows (its run id, its attempt number,
 * the clock) is exactly that. It is a CSPRNG value from Node's own crypto, so
 * nothing new is depended on.
 */
const newAttemptToken = (): string => crypto.randomUUID();

const cursorFrom = (
    progress: SeedRunProgress,
    corpusSlugs: number,
    leaseUntil: Date,
    attemptToken: string,
): RecipeSeedCursor => ({
    attempt: progress.attempt,
    corpusSlugs,
    settledSlugs: progress.settled,
    lastSlug: progress.lastSlug,
    lastAction: progress.lastAction,
    created: progress.created,
    promoted: progress.promoted,
    unchanged: progress.unchanged,
    ingredientRows: progress.ingredientRows,
    leaseUntil: leaseUntil.toISOString(),
    attemptToken,
});

/**
 * The attempt's tallies as the ledger's `counts` map.
 *
 * Snake_case keys, like every other stage's counters, because they are read
 * beside them in one column.
 */
const countsFrom = (progress: SeedRunProgress): Record<string, number> => ({
    recipes_settled: progress.settled,
    recipes_created: progress.created,
    recipes_promoted: progress.promoted,
    recipes_unchanged: progress.unchanged,
    ingredient_rows: progress.ingredientRows,
});

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A stored cursor's lease, or `null` when the column carries no readable one.
 *
 * Defensive on purpose: a run row can predate this cursor shape, can have been
 * written by hand, or can hold a malformed instant, and every one of those means
 * the same thing — there is no evidence this run is live, so it is resumable.
 * Treating an unreadable lease as live would be worse: it would refuse every
 * future seed of this corpus with no way to clear it short of editing the table.
 */
const leaseUntilOf = (cursor: unknown): Date | null => {
    if (!isPlainRecord(cursor)) {
        return null;
    }
    const leaseUntil = cursor.leaseUntil;
    if (typeof leaseUntil !== 'string') {
        return null;
    }
    const parsed = new Date(leaseUntil);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
};

/** A stored cursor's attempt number, defaulting to the first attempt for any unreadable value. */
const attemptOf = (cursor: unknown): number => {
    if (!isPlainRecord(cursor)) {
        return 1;
    }
    const attempt = cursor.attempt;
    return typeof attempt === 'number' && Number.isInteger(attempt) && attempt > 0 ? attempt : 1;
};

/**
 * A stored cursor's attempt token, or `null` when the column carries none.
 *
 * `null` is NOT treated as "any attempt may write", the way `leaseUntilOf`
 * treats an unreadable lease as "not live". The asymmetry is deliberate and it
 * is the safe direction for each: an unreadable lease must not lock a corpus out
 * for ever, while a missing token means the row is not the row this attempt
 * claimed — a hand-edited cursor, or one overwritten by something that does not
 * speak this protocol — and letting a write through on that basis would defeat
 * the fence entirely. Every claim and takeover writes a token before this
 * attempt publishes anything, so a missing one at verification time is always
 * someone else's doing.
 */
const attemptTokenOf = (cursor: unknown): string | null => {
    if (!isPlainRecord(cursor)) {
        return null;
    }
    const token = cursor.attemptToken;
    return typeof token === 'string' && token.length > 0 ? token : null;
};

/**
 * Everything one attempt needs to write to its own ledger row, including the
 * token that proves the row is still its own.
 *
 * Carried as one object rather than as three correlated values so that no call
 * site can pass the client and the run id of an attempt and forget its fence.
 * Exported because `publishRecipe` — the stage's one exported write — names it.
 */
export interface SeedRunOwner {
    /** The client the RUN LEDGER is written through (`SeedDeps.runDb`, or `prisma`). */
    readonly db: CatalogRunDb;
    readonly record: SeedRunRecord;
    /**
     * This attempt's fence. Deliberately NOT a member of `SeedRunRecord`, which
     * travels out on `SeedOutcome.run` and into the stage's log lines: a token
     * that appears in an operator's terminal is a token a later reader of that
     * terminal can replay.
     */
    readonly attemptToken: string;
}

/** The ledger rows the claim reads. Structural, so the generated row type satisfies it. */
interface StoredRunRow {
    readonly id: string;
    readonly cursor: unknown;
}

/**
 * The one call the fence makes: a LOCKING read of the run row.
 *
 * Declared as its own one-method shape because the fence runs against both of
 * this stage's clients — the publication client inside a per-recipe transaction
 * (`SeedDb`) and the ledger client inside its own (`CatalogRunDb`) — and both
 * satisfy exactly this. The template form matches how lib/checkpoint.ts's
 * `lockRunForUpdate` and this file's `lockIngredientFoods` declare the same
 * seam, so every raw reader in this pipeline reads the same way.
 */
interface FenceDb {
    $queryRaw<TRows = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<TRows>;
}

/** What the fence reads under the row lock. JSONB comes back already parsed. */
interface FencedRunRow {
    status: string;
    cursor: unknown;
}

/**
 * Refuses a write whose attempt no longer owns the run — THE FENCE.
 *
 * WHY IT EXISTS EVEN THOUGH THE STAGE HOLDS A SESSION LOCK. The writer lock
 * makes two LIVE writers impossible, and while a holder lives no takeover can
 * occur. What it cannot cover is the process whose lock SESSION died while the
 * process kept running: a dropped connection, a suspended host, a statement
 * that returned after an age. That process holds no lock, so a second
 * invocation legitimately takes the writer lock, finds the row's lease lapsed
 * and takes the run over — and the first process can then wake up with a
 * perfectly usable Prisma pool and continue publishing, move the cursor
 * backwards or close a row the new attempt is still working. This is the
 * residue the finding names, and it is what this function refuses.
 *
 * WHY IT IS ATOMIC. `SELECT … FOR UPDATE` is taken in the SAME transaction as
 * the write it guards — the per-recipe publication transaction, the cursor
 * write's transaction, the report's, the close's — so the row cannot be taken
 * over between the verification and the write. That is only possible because
 * lib/checkpoint.ts declares `CatalogRunDb = PrismaClient |
 * Prisma.TransactionClient`: `saveCursor` and `finishRun` accept a transaction
 * client and run in place inside it, so verify-then-write is one transaction
 * without changing that module.
 *
 * THREE WAYS TO FAIL, one code. An absent row, a row no longer `running`, and a
 * row carrying a different token all mean the same thing to the caller — this
 * attempt does not own this run — and all three are situations a takeover
 * produces. The message distinguishes them for the operator.
 */
const assertAttemptOwnsRun = async (tx: FenceDb, owner: SeedRunOwner): Promise<void> => {
    const runId = owner.record.runId;
    const rows = await tx.$queryRaw<FencedRunRow[]>`
        SELECT status, cursor FROM catalog_import_runs WHERE id = ${runId}::uuid FOR UPDATE
    `;

    if (rows.length === 0) {
        throw new RecipeSeedError(
            'run_attempt_superseded',
            `${STAGE} stopped: its run row (${runId}) is no longer in catalog_import_runs, so this attempt ` +
                'has nothing to record against and must not keep publishing. Run the seed again.',
        );
    }

    const row = rows[0];

    if (row.status !== RUN_STATUS_RUNNING) {
        throw new RecipeSeedError(
            'run_attempt_superseded',
            `${STAGE} stopped: its run row (${runId}) has already been closed as "${row.status}" by another ` +
                'attempt, so this one is no longer the writer. Run the seed again to reconcile the corpus.',
        );
    }

    const stored = attemptTokenOf(row.cursor);

    if (stored !== owner.attemptToken) {
        throw new RecipeSeedError(
            'run_attempt_superseded',
            `${STAGE} stopped: its run row (${runId}) was taken over by a later attempt (now attempt ` +
                `${attemptOf(row.cursor)}), so this attempt's writes are fenced out. This happens when a seed's ` +
                'lock session is lost while its process keeps running; the later attempt owns the corpus, and ' +
                'nothing this one had already committed is lost — it is reconciled by the attempt that took over.',
        );
    }
};

/**
 * The one shape the claim needs beyond `CatalogRunDb`: its own transaction.
 *
 * Probed rather than required, exactly as checkpoint.ts's `transactionRunnerOf`
 * probes it — a Prisma transaction client is the client with `$transaction`
 * removed, so its absence means the caller already owns a transaction and the
 * claim must run in place rather than nest.
 */
interface LedgerTransactionRunner {
    $transaction<T>(work: (tx: CatalogRunDb) => Promise<T>, options?: { timeout?: number }): Promise<T>;
}

/**
 * `options` is passed through for the ONE ledger transaction that wraps
 * something slower than two statements — the coverage report's file write (see
 * publishCoverageReport). Everything else leaves it out and takes the client's
 * own default, which is what the claim, the cursor writes and the closes have
 * always used.
 */
const inLedgerTransaction = async <T>(
    db: CatalogRunDb,
    work: (tx: CatalogRunDb) => Promise<T>,
    options?: { timeout?: number },
): Promise<T> => {
    const runner = db as unknown as Partial<LedgerTransactionRunner>;
    return typeof runner.$transaction === 'function' ? runner.$transaction(work, options) : work(db);
};

/** What `deps.prisma` must expose for the ledger, when no separate ledger client was injected. */
interface LedgerDelegateProbe {
    readonly catalog_import_runs?: unknown;
    readonly $executeRaw?: unknown;
}

/**
 * The client the run row is written through.
 *
 * Probed rather than cast blindly: `SeedDeps.prisma` is a narrow structural
 * slice that a suite may satisfy with a wrapper, and a wrapper that cannot reach
 * `catalog_import_runs` would otherwise fail deep inside the claim with a
 * TypeError instead of telling the caller which dependency to inject (§9 —
 * config resolved behind an accessor that fails loudly).
 */
const resolveRunLedgerDb = (deps: SeedDeps): CatalogRunDb => {
    if (deps.runDb !== undefined) {
        return deps.runDb;
    }

    const candidate = deps.prisma as unknown as LedgerDelegateProbe;
    if (candidate.catalog_import_runs === undefined || typeof candidate.$executeRaw !== 'function') {
        throw new RecipeSeedError(
            'run_ledger_unavailable',
            `${STAGE} cannot record its run: the injected publication client cannot reach ` +
                'catalog_import_runs, and no separate runDb was supplied. Pass SeedDeps.runDb (the Prisma ' +
                'singleton) so the run row, its cursor and its terminal counts are written somewhere.',
        );
    }

    return deps.prisma as unknown as CatalogRunDb;
};

/**
 * Claims this corpus's run: resumes the open one, or opens a new row.
 *
 * SERIALISED ON THE IDENTITY, because there is no row to lock before the claim —
 * two invocations would both find nothing open and both insert, after which two
 * processes publish the same corpus and interleave their decisions in two
 * ledgers. The lock follows checkpoint.ts's documented one-argument convention
 * for a claim (`pg_advisory_xact_lock(hashtext('catalog-run:<kind>:<version>'))`,
 * the same idiom AAP §0.5.1 uses for a user's meal-planning writes), composed as
 * ONE bound string so the whole value is a parameter, and released when this
 * transaction ends.
 *
 * IT IS REACHED ONLY BY THE WRITER, which is why the lease means what it does.
 * `runSeed` holds the exclusive, session-scoped RECIPE-SEED WRITER LOCK before
 * this function is called on any publishing path, so a second LIVE seed never
 * arrives here at all. Every outcome below is therefore about a run whose
 * previous holder's session is provably gone — and the advisory lock above is
 * still not redundant, because it serialises the read-then-insert against an
 * invocation racing this one through the same writer lock's release.
 *
 * THE THREE OUTCOMES.
 *
 *  - An open run whose LEASE IS STILL LIVE: refused (`seed_in_progress`). The
 *    previous holder died moments ago and its last publications may still be
 *    settling, so the corpus is left alone until the lease lapses.
 *  - An open run whose lease has LAPSED: taken over as the same row — a process
 *    killed before its finalizer ran leaves exactly this, and the run it opened
 *    is the run that should finish. Its watermark is appended to the log before
 *    the cursor is overwritten, so the interrupted attempt's progress survives.
 *    THE TAKEOVER ROTATES THE ATTEMPT TOKEN, and that rotation is what fences
 *    the previous attempt out: if its process is not in fact dead — only its
 *    lock session was — every write it still tries against this row is refused
 *    (see assertAttemptOwnsRun).
 *  - Nothing open: a NEW row, even when a previous run for this same corpus
 *    already SUCCEEDED. That is deliberate and it is the one place this claim
 *    departs from `openOrResumeRun`'s completed-run no-op: the fingerprint names
 *    the CORPUS, and this stage's other input is the CATALOG. A catalog refresh
 *    makes a stored ingredient snapshot stale under unchanged files, and §0.5.1
 *    requires the seed to publish a new version then — so a no-op keyed on the
 *    corpus alone would refuse that work for ever, which is precisely the trap
 *    checkpoint.ts documents for a validation key that names only its policy.
 *    Reconciling again is cheap and idempotent: an unchanged recipe is a read.
 *    The previous succeeded run is reported on the outcome so a caller can still
 *    tell "this corpus had already been published" from "this is the first time".
 */
const claimRecipeSeedRun = async (input: {
    readonly db: CatalogRunDb;
    readonly manifestVersion: string;
    readonly corpusSlugs: number;
    readonly now: () => Date;
    readonly logger: ScriptLogger;
}): Promise<{ readonly owner: SeedRunOwner; readonly progress: SeedRunProgress }> => {
    const claimKey = `catalog-run:${RECIPE_SEED_RUN_KIND}:${input.manifestVersion}`;

    const claimed = await inLedgerTransaction(input.db, async (tx) => {
        // $executeRaw, not $queryRaw: pg_advisory_xact_lock returns void and
        // Prisma's query path cannot deserialise a void column (P2010) — the
        // same note checkpoint.ts's acquireRunClaimLock carries.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${claimKey}))`;

        const open: StoredRunRow | null = await tx.catalog_import_runs.findFirst({
            where: {
                kind: RECIPE_SEED_RUN_KIND,
                manifest_version: input.manifestVersion,
                status: RUN_STATUS_RUNNING,
            },
            orderBy: { started_at: 'desc' },
            select: { id: true, cursor: true },
        });

        if (open !== null) {
            const leaseUntil = leaseUntilOf(open.cursor);
            const at = input.now();

            if (leaseUntil !== null && leaseUntil.getTime() > at.getTime()) {
                throw new RecipeSeedError(
                    'seed_in_progress',
                    `another ${STAGE} run (${open.id}) is publishing this same corpus and holds it until ` +
                        `${leaseUntil.toISOString()}. Wait for it to finish, or — if its process is gone — run ` +
                        'the seed again once that moment has passed.',
                );
            }

            const progress = newRunProgress(attemptOf(open.cursor) + 1);
            // ROTATED, not carried over: the token the previous attempt was
            // using is replaced in the same transaction that takes the row over,
            // which is the single write that fences that attempt out of every
            // future publication, cursor move, report and close.
            const attemptToken = newAttemptToken();
            // The interrupted attempt's watermark, kept before the cursor that
            // holds it is overwritten. Appended through checkpoint.ts so it is
            // capped and scrubbed by the same rules as every other run log
            // entry. `interruptedCursor` carries the superseded token with it —
            // by then it is a value nothing will accept again, and an operator
            // reconstructing the handover needs to see which attempt was fenced.
            await appendRunLog(
                tx,
                open.id,
                {
                    event: 'recipe_seed_attempt_taken_over',
                    attempt: progress.attempt,
                    interruptedCursor: JSON.stringify(open.cursor ?? null),
                    leaseLapsedAt: leaseUntil === null ? 'none' : leaseUntil.toISOString(),
                },
                input.now,
            );
            await saveCursor(
                tx,
                open.id,
                cursorFrom(
                    progress,
                    input.corpusSlugs,
                    new Date(at.getTime() + RECIPE_SEED_RUN_LEASE_MS),
                    attemptToken,
                ),
            );

            return {
                owner: {
                    db: input.db,
                    record: {
                        runId: open.id,
                        manifestVersion: input.manifestVersion,
                        resumed: true,
                        attempt: progress.attempt,
                        previousSucceededRunId: null,
                    },
                    attemptToken,
                },
                progress,
            };
        }

        const succeeded = await tx.catalog_import_runs.findFirst({
            where: {
                kind: RECIPE_SEED_RUN_KIND,
                manifest_version: input.manifestVersion,
                status: RUN_STATUS_SUCCEEDED,
            },
            orderBy: { started_at: 'desc' },
            select: { id: true },
        });

        // started_at is left to the column default, like openRun's, so a run's
        // clock never depends on the script host's. counts and log are written
        // as an empty map and an empty array rather than left NULL so no reader
        // needs a null branch.
        const opened = await tx.catalog_import_runs.create({
            data: {
                kind: RECIPE_SEED_RUN_KIND,
                manifest_version: input.manifestVersion,
                status: RUN_STATUS_RUNNING,
                counts: {},
                log: [],
            },
            select: { id: true },
        });
        const progress = newRunProgress(1);
        const attemptToken = newAttemptToken();
        await saveCursor(
            tx,
            opened.id,
            cursorFrom(
                progress,
                input.corpusSlugs,
                new Date(input.now().getTime() + RECIPE_SEED_RUN_LEASE_MS),
                attemptToken,
            ),
        );

        return {
            owner: {
                db: input.db,
                record: {
                    runId: opened.id,
                    manifestVersion: input.manifestVersion,
                    resumed: false,
                    attempt: 1,
                    previousSucceededRunId: succeeded?.id ?? null,
                },
                attemptToken,
            },
            progress,
        };
    });

    // After the commit, never before: a line claiming a run exists must not
    // describe a claim that rolled back (checkpoint.ts's openOrResumeRun states
    // the same rule for the same reason).
    // The attempt token is NOT among these fields, and never becomes one: the
    // fence is only worth having while the value it compares stays out of the
    // logs an operator pastes into a ticket.
    input.logger.info(claimed.owner.record.resumed ? 'run_resumed' : 'run_opened', {
        stage: STAGE,
        runId: claimed.owner.record.runId,
        kind: RECIPE_SEED_RUN_KIND,
        manifestVersion: claimed.owner.record.manifestVersion,
        attempt: claimed.owner.record.attempt,
        corpusSlugs: input.corpusSlugs,
        previousSucceededRunId: claimed.owner.record.previousSucceededRunId,
    });

    return claimed;
};

/**
 * Records one settled recipe: the watermark, the decision and a refreshed lease.
 *
 * Written AFTER the publishing transaction committed and never before it — a
 * cursor or a count written for a transaction that then rolled back is the
 * phantom-progress defect this ledger exists to rule out. One write per recipe
 * rather than a cursor write and a counts write: the counters are derived from
 * the same tally at close, so the hot path stays a single locked
 * read-modify-write, which is what keeps an audit trail from costing more round
 * trips than the publications it describes.
 *
 * FENCED IN THE SAME TRANSACTION AS THE WRITE. `saveCursor` takes a
 * `CatalogRunDb`, which lib/checkpoint.ts declares to include a transaction
 * client — so the ownership check and the cursor write are one transaction and a
 * superseded attempt cannot move a cursor that now belongs to the attempt which
 * took the run over.
 */
const saveRunProgress = async (input: {
    readonly owner: SeedRunOwner | null;
    readonly progress: SeedRunProgress;
    readonly corpusSlugs: number;
    readonly now: () => Date;
}): Promise<void> => {
    const owner = input.owner;
    if (owner === null) {
        return;
    }

    await inLedgerTransaction(owner.db, async (tx) => {
        await assertAttemptOwnsRun(tx, owner);
        await saveCursor(
            tx,
            owner.record.runId,
            cursorFrom(
                input.progress,
                input.corpusSlugs,
                new Date(input.now().getTime() + RECIPE_SEED_RUN_LEASE_MS),
                owner.attemptToken,
            ),
        );
    });
};

/**
 * Closes the run as succeeded, with the attempt's committed counts.
 *
 * Fenced like every other ledger write: a `succeeded` row is the evidence the
 * corpus and the committed report describe each other, so an attempt that no
 * longer owns the run must not be the one to state it.
 */
const closeSucceededRun = async (
    owner: SeedRunOwner | null,
    progress: SeedRunProgress,
    stageLogger: ScriptLogger,
): Promise<void> => {
    if (owner === null) {
        return;
    }

    await inLedgerTransaction(owner.db, async (tx) => {
        await assertAttemptOwnsRun(tx, owner);
        await finishRun(tx, owner.record.runId, 'succeeded', {
            counts: countsFrom(progress),
            logger: stageLogger,
        });
    });
};

/**
 * Closes the run as failed, and NEVER replaces the failure that got us here.
 *
 * Guarded because it runs on a path that is already failing: if the ledger write
 * itself cannot land — the database is gone, the row was deleted, someone closed
 * the run under us — reporting that instead of the original error would hide the
 * reason the stage stopped. The ledger failure is logged with its own event so
 * it is not lost either, and the original error propagates untouched.
 *
 * A FENCED-OUT CLOSE GETS ITS OWN EVENT. `run_close_refused` is not a failure of
 * the ledger, it is the fence working: this attempt was superseded, the attempt
 * that took the run over owns its terminal status, and overwriting it would
 * replace a live run — or a `succeeded` one — with a stale `failed`. Reported
 * separately from `run_close_failed` so an operator reading the line is not sent
 * looking for a database fault that did not happen.
 */
const closeFailedRun = async (
    owner: SeedRunOwner | null,
    progress: SeedRunProgress,
    error: unknown,
    stageLogger: ScriptLogger,
): Promise<void> => {
    if (owner === null) {
        return;
    }

    try {
        await inLedgerTransaction(owner.db, async (tx) => {
            await assertAttemptOwnsRun(tx, owner);
            await finishRun(tx, owner.record.runId, 'failed', {
                counts: countsFrom(progress),
                error,
                logger: stageLogger,
            });
        });
    } catch (closeError) {
        const fenced = isThrownInstanceOf(closeError, RecipeSeedError) && closeError.code === 'run_attempt_superseded';

        stageLogger.error(fenced ? 'run_close_refused' : 'run_close_failed', {
            stage: STAGE,
            runId: owner.record.runId,
            attempt: owner.record.attempt,
            settled: progress.settled,
            error: safeError(closeError),
        });
    }
};

/**
 * Reads the two catalog facts the run needs: the full row for every ingredient
 * the corpus names, and the version counters of every food an already-stored
 * version points at.
 *
 * The second read is what lets `findStaleIngredients` tell "this food's
 * metadata moved" from "this food is gone", rather than reporting a food it
 * simply never asked about as absent.
 */
const readCatalogFacts = async (
    db: SeedDb,
    sourceKeys: readonly string[],
): Promise<Map<string, SeedCatalogFoodRow>> => {
    if (sourceKeys.length === 0) {
        return new Map();
    }

    const foods = await db.catalog_foods.findMany<SeedCatalogFoodRow>({
        where: { source_key: { in: [...sourceKeys] } },
        orderBy: { source_key: 'asc' },
        include: { catalog_food_portions: { select: { is_default: true, gram_weight: true } } },
    });

    return new Map(foods.map((food) => [food.source_key, food]));
};

/** The two acquisition failures the stage lock raises, as this stage reports them. */
const STAGE_LOCK_REFUSAL_CODES: readonly string[] = ['catalog_stage_locked', 'catalog_stage_lock_unavailable'];

/**
 * The production catalog hold: the graph's stage lock, taken SHARED for the
 * whole run.
 *
 * `withCatalogStageLock` opens its own dedicated connection, tries the lock
 * once, and releases it in a `finally` — so the window this covers is exactly
 * the stage's own lifetime, and a refusal costs nothing because it happens
 * before the stage reads or writes anything. There is no waiting branch on
 * purpose: the other four stages take the same lock the same way, and a seed
 * that blocked for the hours an import takes would be indistinguishable from a
 * seed that hung.
 */
const defaultCatalogLockRunner =
    (stageLogger: ScriptLogger) =>
    <T>(work: () => Promise<T>): Promise<T> =>
        withCatalogStageLock(
            { stage: CATALOG_READER_STAGE, mode: CATALOG_READER_STAGE_MODE, logger: stageLogger },
            () => work(),
        );

/* ---------------------------------------------------------------------------
 * THE RECIPE-SEED WRITER LOCK
 *
 * One recipe seed at a time, for the whole lifetime of a publishing process.
 * The graph hold above cannot be this — it is SHARED, so it is compatible with
 * itself — and neither can the run ledger's lease, whose row is addressed by the
 * corpus fingerprint and is not claimed at all by a narrowed run. See the
 * header's ONE RECIPE-SEED WRITER for the races that leaves open.
 *
 * It is implemented HERE rather than added to lib/checkpoint.ts's stage-lock
 * table on purpose: `CATALOG_STAGE_LOCK_MODES` is a
 * `Record<CatalogStageName, …>` over a closed union of stage names, whose
 * exhaustive key set is asserted in
 * src/__tests__/scripts/catalog-import.test.ts, so one more stage name is a
 * change to that module and its suite rather than to this file — the same
 * reason this stage BORROWS `release` for its graph hold. The construction
 * below follows `acquireCatalogStageLock` step for step (dedicated `pg`
 * connection, try-lock, release-then-close in a `finally` that never throws),
 * because the property being bought is identical: a SESSION-scoped lock that
 * the operating system releases for us when the process dies, which is what
 * lets this stage hold exclusivity for its whole lifetime with no heartbeat and
 * no background timer (excluded by AAP §0.8.2).
 * ------------------------------------------------------------------------- */

/**
 * The `pg` surface this file uses — three calls, declared narrowly because
 * `@types/pg` is deliberately absent from this repo (lib/checkpoint.ts and the
 * test-setup modules all declare their own the same way).
 */
interface WriterLockPgModule {
    Client: new (config: {
        connectionString: string;
        application_name?: string;
        connectionTimeoutMillis?: number;
        query_timeout?: number;
        keepAlive?: boolean;
    }) => CatalogStageLockConnection;
}

const resolveWriterLockConnectionString = (): string => {
    const candidate = process.env.DATABASE_URL;

    if (typeof candidate !== 'string' || candidate.trim().length === 0) {
        // Typed rather than left to the driver: `new Client({connectionString:
        // undefined})` reads the libpq environment instead and can connect
        // somewhere nobody named (§9 — config resolved behind an accessor that
        // fails loudly). dbGuard refuses this at module load, so reaching here
        // means a caller bypassed it.
        throw new RecipeSeedError(
            'seed_writer_lock_unavailable',
            `${STAGE} did not run: no DATABASE_URL is set, so the recipe-seed writer lock could not be taken ` +
                'and nothing would stop a second seed publishing beside this one. Set DATABASE_URL (see ' +
                'backend/.env.example) and run the seed again.',
        );
    }

    return candidate;
};

const openWriterLockConnection = (connectionString: string): CatalogStageLockConnection => {
    // Required lazily, exactly as lib/checkpoint.ts does it: importing this
    // module must stay side-effect-free, so a suite that only reads the pure
    // derivations never loads a database driver. `pg` is already a runtime
    // dependency of this service (Prisma's own driver) and needs no addition.
    const pg = require('pg') as WriterLockPgModule;

    return new pg.Client({
        connectionString,
        application_name: WRITER_LOCK_APPLICATION_NAME,
        connectionTimeoutMillis: WRITER_LOCK_CONNECT_TIMEOUT_MS,
        query_timeout: WRITER_LOCK_QUERY_TIMEOUT_MS,
        // The session sits idle for as long as the seed runs and the lock lives
        // in that session: without keepalive probes an idle connection can be
        // dropped by the network and the lock released with nobody informed.
        // That case is not merely tolerated — it is what the attempt fence
        // exists for (see assertAttemptOwnsRun).
        keepAlive: true,
    });
};

/**
 * Runs `work` as the one recipe-seed writer, and releases the lock afterwards
 * however `work` ended.
 *
 * REFUSES RATHER THAN BLOCKS. `pg_try_advisory_lock` is attempted exactly once
 * and a refusal is this stage's own `seed_writer_locked`, with no waiting
 * branch — the same philosophy the graph hold already states for the same
 * reason: a seed that blocked for however long another seed takes would be
 * indistinguishable, from the outside, from a seed that hung.
 *
 * ON ITS OWN CONNECTION. A session lock must not be taken through the injected
 * Prisma client, which hands out POOLED connections and routes each statement to
 * whichever is free — the lock would be held by an arbitrary connection and
 * could never be released deterministically. This is the same reasoning
 * lib/checkpoint.ts records for the catalog stage lock, and the same remedy.
 */
const runUnderWriterHold = async <T>(stageLogger: ScriptLogger, work: () => Promise<T>): Promise<T> => {
    const connection = openWriterLockConnection(resolveWriterLockConnectionString());

    // Closes without raising, on paths that are already failing: a teardown
    // error here would replace the reason the stage stopped with a reason
    // nobody asked about.
    const closeQuietly = async (): Promise<void> => {
        try {
            await connection.end();
        } catch (error) {
            stageLogger.warn('seed_writer_lock_close_failed', { stage: STAGE, error: safeError(error) });
        }
    };

    try {
        await connection.connect();

        // Two-integer keyspace under this stage's own class id, and the object
        // id is hashtext() computed in PostgreSQL. Both values are BOUND, not
        // interpolated, so the statement text is constant. See
        // RECIPE_SEED_WRITER_LOCK_CLASS_ID for why this is neither the
        // one-argument space nor checkpoint.ts's 'CAT' class.
        const attempt = await connection.query<{ locked: boolean | null }>(
            'SELECT pg_try_advisory_lock($1::int4, hashtext($2::text)) AS locked',
            [RECIPE_SEED_WRITER_LOCK_CLASS_ID, RECIPE_SEED_WRITER_LOCK_NAME],
        );

        if (attempt.rows[0]?.locked !== true) {
            throw new RecipeSeedError(
                'seed_writer_locked',
                `${STAGE} did not run: another recipe seed is publishing against this database and holds the ` +
                    'recipe-seed writer lock. Wait for it to finish and run the seed again — the lock is held on ' +
                    'that process\'s own session, so it is released the moment that process ends, with nothing ' +
                    'for an operator to clear.',
            );
        }
    } catch (error) {
        await closeQuietly();
        throw error;
    }

    stageLogger.info('seed_writer_lock_acquired', { stage: STAGE, lock: RECIPE_SEED_WRITER_LOCK_NAME });

    try {
        return await work();
    } finally {
        // Unlock first, then close. The close alone would release the lock, but
        // an explicit unlock is what keeps a pooled or reused connection from
        // carrying the hold past this stage, and neither statement is allowed to
        // raise over the stage's own outcome.
        try {
            await connection.query('SELECT pg_advisory_unlock($1::int4, hashtext($2::text))', [
                RECIPE_SEED_WRITER_LOCK_CLASS_ID,
                RECIPE_SEED_WRITER_LOCK_NAME,
            ]);
        } catch (error) {
            stageLogger.warn('seed_writer_unlock_failed', { stage: STAGE, error: safeError(error) });
        }
        await closeQuietly();
        stageLogger.info('seed_writer_lock_released', { stage: STAGE, lock: RECIPE_SEED_WRITER_LOCK_NAME });
    }
};

/**
 * The production writer hold, shaped like `defaultCatalogLockRunner` so the two
 * seams read identically at the call site.
 */
const defaultWriterLockRunner =
    (stageLogger: ScriptLogger) =>
    <T>(work: () => Promise<T>): Promise<T> =>
        runUnderWriterHold(stageLogger, work);

/** Runs `work` with no writer lock at all — the dry-run path, which publishes nothing to own. */
const withoutWriterHold = <T>(work: () => Promise<T>): Promise<T> => work();

/**
 * Publishes the curated recipe files as versioned recipes, as the one recipe-seed
 * writer and with the catalog graph held for the whole attempt.
 *
 * TWO HOLDS, AND THEY ANSWER DIFFERENT QUESTIONS. The RECIPE-SEED WRITER LOCK
 * (exclusive, this stage's own key) is what stops a SECOND SEED; the CATALOG
 * GRAPH HOLD (shared, borrowed from the graph's `release` reader label) is what
 * stops a catalog MUTATOR. Neither substitutes for the other, and both are
 * refusals rather than waits.
 *
 * Both live HERE rather than in `main` because `runSeed` is the entry point AAP
 * §0.9.2 names — the one the API-level concurrency suite drives and the one any
 * future caller would reach for — so a hold that only `main` took would protect
 * the command and not the stage. A refused graph hold is translated into this
 * stage's own error class before it reaches an operator: the message
 * checkpoint.ts writes already names the stage, the mode and the remedy, and
 * `describeFailure` reports it under `catalog_locked` rather than under a
 * checkpoint code, because from the outside this is "the seed refused", not "a
 * checkpoint failed". A refused writer hold is already this stage's own error
 * (`seed_writer_locked`) and needs no translation — and it is deliberately NOT
 * `catalog_locked`, because "another seed is publishing" and "a catalog stage
 * owns the graph" send an operator to different places.
 */
export const runSeed = async (deps: SeedDeps): Promise<SeedOutcome> => {
    const runUnderCatalogLock = deps.runUnderCatalogLock ?? defaultCatalogLockRunner(deps.logger);
    // THE WRITER LOCK IS OUTERMOST, and a dry run takes none.
    //
    // Outermost because a second seed should be refused before it contends for
    // anything else: it then reports "another recipe seed is publishing" rather
    // than queueing behind a graph hold it was never going to be allowed to use,
    // and the refusal costs one connection and one statement.
    //
    // Taken for EVERY non-dry run, `--only` included. A narrowed writer publishes
    // real `recipe_versions` rows for the slugs it names, so a narrowed run
    // beside a whole-corpus one is two writers on overlapping rows — exactly the
    // pair the lock exists to separate — even though the narrowed one claims no
    // ledger row and writes no coverage report. A dry run, by contrast, writes
    // nothing at all on any path, so it owns nothing and waits for nobody; the
    // seam is bypassed rather than defaulted for it, so a caller cannot opt a dry
    // run into a hold it has no use for.
    const runUnderWriterLock = deps.options.dryRun
        ? withoutWriterHold
        : (deps.runUnderWriterLock ?? defaultWriterLockRunner(deps.logger));

    try {
        return await runUnderWriterLock(() => runUnderCatalogLock(() => seedUnderCatalogHold(deps)));
    } catch (error) {
        if (isThrownInstanceOf(error, CheckpointError) && STAGE_LOCK_REFUSAL_CODES.includes(error.code)) {
            throw new RecipeSeedError(
                'catalog_locked',
                `${STAGE} did not run: ${error.message}`,
            );
        }
        throw error;
    }
};

/**
 * The stage itself, running with the catalog graph already held.
 *
 * The stage in one function, in the order §0.7.3 requires: read, resolve,
 * validate EVERYTHING, then write, then derive the report from what was
 * written. The validation pass is complete before the first write because a
 * partially seeded corpus is worse than an unseeded one — the planner's
 * coverage check would answer from an incomplete set.
 *
 * Wrapped, from the claim onwards, in the run lifecycle: every path out of this
 * function closes the run row it claimed — `succeeded` at the end, `failed` in
 * the guarded finalizer — so there is no exit through which a run stays
 * `running` other than the process dying, which is the one case the lease and
 * the cursor exist for.
 */
const seedUnderCatalogHold = async (deps: SeedDeps): Promise<SeedOutcome> => {
    const { logger, options, prisma } = deps;

    const { payloads, problems: payloadProblems, digests } = readRecipeFiles(deps.recipesDir, options.only);
    logger.info('recipes_read', {
        stage: STAGE,
        files: payloads.length,
        unparsable: payloadProblems.length,
        only: [...options.only],
        dryRun: options.dryRun,
    });

    // THE CLAIM, AND WHAT IS DELIBERATELY NOT CLAIMED. A dry run writes nothing
    // and an `--only`-narrowed run is one recipe's slice of the corpus, so
    // neither is an attempt at the corpus the fingerprint names: claiming a
    // whole-corpus run for either would let a narrowed run's cursor and counts
    // describe work nobody asked for, and would let it block the real seed
    // through the lease. This is the same rule the coverage report already
    // follows, for the same reason, and the two are kept in step.
    const wholeCorpusRun = !options.dryRun && options.only.length === 0;
    const manifestVersion = deriveCorpusFingerprint(deps.coveragePlan.coveragePlanVersion, digests);
    const runSkippedReason = wholeCorpusRun
        ? null
        : options.dryRun
          ? 'dry run: no run was claimed, because nothing is published on this path'
          : `run narrowed to ${options.only.length} slug${options.only.length === 1 ? '' : 's'}, so no whole-corpus run was claimed`;
    const ledgerDb = wholeCorpusRun ? resolveRunLedgerDb(deps) : null;
    const claim =
        ledgerDb === null
            ? null
            : await claimRecipeSeedRun({
                  db: ledgerDb,
                  manifestVersion,
                  corpusSlugs: payloads.length,
                  now: deps.now,
                  logger,
              });
    const owner = claim?.owner ?? null;
    const progress = claim?.progress ?? newRunProgress(1);

    if (owner === null) {
        logger.info('run_not_claimed', { stage: STAGE, manifestVersion, note: runSkippedReason });
    }

    try {
        return await publishClaimedCorpus({
            deps,
            payloads,
            payloadProblems,
            owner,
            progress,
            runSkippedReason,
        });
    } catch (error) {
        // The terminal record of an interrupted attempt: the status, the counts
        // it really committed and the scrubbed failure, written by a finalizer
        // that cannot replace the error it is reporting — and that is itself
        // fenced, so an attempt which has been superseded cannot close a run the
        // attempt that took it over is still working.
        await closeFailedRun(owner, progress, error, logger);
        throw error;
    }
};

/** Everything the claimed attempt does, and the arguments it needs to report itself. */
interface PublishCorpusInput {
    readonly deps: SeedDeps;
    readonly payloads: readonly RecipeFilePayload[];
    readonly payloadProblems: readonly string[];
    /**
     * The ledger row this attempt owns and the token that proves it, or `null`
     * for a dry run and an `--only`-narrowed run, neither of which claims one.
     */
    readonly owner: SeedRunOwner | null;
    readonly progress: SeedRunProgress;
    readonly runSkippedReason: string | null;
}

/**
 * Writes the whole-corpus coverage report, fenced against a takeover.
 *
 * WHY THE FILE WRITE IS INSIDE A TRANSACTION. The artefact is the run's promise:
 * a `succeeded` row means the corpus and the committed report describe each
 * other. A superseded attempt that overwrote the report would therefore replace
 * the owning attempt's evidence with a table derived from a read it took before
 * it lost the run — and verifying ownership and then writing outside the lock
 * would leave exactly the window this fence exists to close. So the row lock is
 * taken, the token is compared, and the file is written while that lock is held;
 * a refusal aborts before `writeReport` is reached and the previous artefact
 * survives untouched. The write is a synchronous few hundred kilobytes, so the
 * lock is held for a moment rather than for a stage.
 *
 * With no claimed run there is nothing to fence: only a whole-corpus, non-dry
 * run reaches the report, and that run always owns a row — the `null` branch is
 * the guarantee itself rather than a case that occurs.
 */
const publishCoverageReport = async (input: {
    readonly owner: SeedRunOwner | null;
    readonly report: CoverageReport;
    readonly reportPath: string;
    readonly writeReport: (absolutePath: string, value: unknown) => void;
}): Promise<void> => {
    const owner = input.owner;

    if (owner === null) {
        input.writeReport(input.reportPath, input.report);
        return;
    }

    await inLedgerTransaction(
        owner.db,
        async (tx) => {
            await assertAttemptOwnsRun(tx, owner);
            input.writeReport(input.reportPath, input.report);
        },
        // The same generous ceiling the publication transactions take, and for
        // the same reason: the work is one synchronous write of ~130 KB, so the
        // headroom is for a CI runner's scheduler rather than for the statement.
        // Without it this transaction would take the client's 5 s default and a
        // scheduling stall would report a seed failure that says nothing about
        // the corpus.
        { timeout: PUBLISH_TRANSACTION_TIMEOUT_MS },
    );
};

/**
 * Validates the read corpus and publishes it, recording progress as it goes.
 *
 * Separated from the claim only so the claim's finalizer can wrap EVERY exit
 * from it — including the validation refusal, which is a real attempt that
 * failed and belongs in the ledger as one.
 */
const publishClaimedCorpus = async (input: PublishCorpusInput): Promise<SeedOutcome> => {
    const { deps, payloads, payloadProblems, owner, progress, runSkippedReason } = input;
    const { logger, options, prisma } = deps;
    const run = owner?.record ?? null;

    const sourceKeys = [...new Set(payloads.flatMap((payload) => payload.ingredients.map((i) => i.sourceKey)))].sort();
    const foodsBySourceKey = await readCatalogFacts(prisma, sourceKeys);

    // The whole published table's canonical names, one column wide: the
    // instruction-completeness vocabulary is only as good as the catalog behind
    // it, and a narrowed read would let a term pass because this run happened
    // not to select the recipe that names it.
    const publishedNames = await prisma.catalog_foods.findMany<{ canonical_name: string }>({
        where: { publication_status: PUBLISHED_STATUS },
        select: { canonical_name: true },
        orderBy: { canonical_name: 'asc' },
    });
    const vocabulary = buildIngredientVocabulary(
        deps.coveragePlan.foodGroups.map((entry) => entry.foodGroup),
        publishedNames.map((row) => row.canonical_name),
    );
    logger.info('vocabulary_built', {
        stage: STAGE,
        foodGroups: deps.coveragePlan.foodGroups.length,
        publishedCanonicalNames: publishedNames.length,
        singleWordTerms: vocabulary.singleWordTerms.size,
        multiWordTerms: vocabulary.multiWordTerms.length,
        resolvableIngredients: foodsBySourceKey.size,
        referencedIngredients: sourceKeys.length,
    });

    const plans: RecipePublicationPlan[] = [];
    const problems: string[] = [...payloadProblems];
    for (const payload of payloads) {
        const validation = validateRecipeFile(payload, foodsBySourceKey, vocabulary);
        if (validation.plan === null) {
            problems.push(...validation.problems);
            continue;
        }
        plans.push(validation.plan);
    }

    if (problems.length > 0) {
        // Loudly, with every defect, and before any write: §0.7.3's "fails
        // loudly and nothing is published".
        logger.error('recipes_rejected', {
            stage: STAGE,
            files: payloads.length,
            problemCount: problems.length,
            problems,
        });
        throw new RecipeSeedError(
            'recipes_invalid',
            `${problems.length} problem${problems.length === 1 ? '' : 's'} in the selected recipe files; nothing was published`,
            problems,
        );
    }

    logger.info('recipes_validated', {
        stage: STAGE,
        recipes: plans.length,
        ingredientRows: plans.reduce((total, plan) => total + plan.ingredients.length, 0),
    });

    if (options.dryRun) {
        const reason = 'dry run: every file was validated and nothing was written';
        logger.info('dry_run_completed', { stage: STAGE, recipes: plans.length, note: reason });

        return {
            selected: plans.map((plan) => plan.slug),
            created: [],
            promoted: [],
            unchanged: [],
            ingredientRows: 0,
            dryRun: true,
            report: null,
            reportPath: null,
            reportSkippedReason: reason,
            run: null,
            runSkippedReason,
        };
    }

    const currentCatalogVersions = new Map<string, CatalogIngredientVersions>(
        [...foodsBySourceKey.values()].map((food) => [
            food.id,
            {
                catalog_nutrition_version: food.nutrition_version,
                catalog_metadata_version: food.metadata_version,
            },
        ]),
    );
    // Every food a STORED version points at, whether or not the corpus still
    // names it, so a food that is present but unreferenced is not mistaken for
    // one that is gone. A retired food is included deliberately: it may keep
    // backing the version it was published into, and only `describeUnpublishable
    // Food` refuses it for a NEW one.
    //
    // ONE READ FOR THE WHOLE CORPUS, not one per slug. This read exists only to
    // discover which catalog foods the stored versions point at, and the answer
    // is the same whether it is assembled in forty-two round trips or one — so
    // it is one, keyed on the slugs this run selected.
    //
    // It does NOT replace the re-read each publishing transaction performs.
    // That one is a CORRECTNESS requirement rather than a duplicate of this
    // one: it happens inside the transaction, under a row lock, against the
    // facts the transaction is about to cite (see assertIngredientFactsHold).
    // Collapsing the two would put the verification back outside the
    // transaction, which is the defect this stage was refused for.
    const storedRecipes = await prisma.recipes.findMany<StoredRecipeRow>({
        where: { slug: { in: plans.map((plan) => plan.slug) } },
        include: RECIPE_READ_INCLUDE,
    });
    const storedFoodIds = new Set<string>();
    for (const stored of storedRecipes) {
        for (const ingredient of stored.current_version?.recipe_ingredients ?? []) {
            if (!currentCatalogVersions.has(ingredient.catalog_food_id)) {
                storedFoodIds.add(ingredient.catalog_food_id);
            }
        }
    }
    if (storedFoodIds.size > 0) {
        const storedFoods = await prisma.catalog_foods.findMany<{
            id: string;
            nutrition_version: number;
            metadata_version: number;
        }>({
            where: { id: { in: [...storedFoodIds] } },
            select: { id: true, nutrition_version: true, metadata_version: true },
        });
        for (const food of storedFoods) {
            currentCatalogVersions.set(food.id, {
                catalog_nutrition_version: food.nutrition_version,
                catalog_metadata_version: food.metadata_version,
            });
        }
    }

    const now = deps.now();
    const created: string[] = [];
    const promoted: string[] = [];
    const unchanged: string[] = [];
    let ingredientRows = 0;

    for (const plan of plans) {
        const result = await publishRecipe(prisma, plan, now, currentCatalogVersions, owner);

        if (result.action === 'created') {
            created.push(result.slug);
            ingredientRows += result.ingredientRows;
            progress.created += 1;
            progress.ingredientRows += result.ingredientRows;
            logger.info('recipe_published', {
                stage: STAGE,
                slug: result.slug,
                version: result.version,
                ingredientRows: result.ingredientRows,
            });
        } else if (result.action === 'promoted') {
            promoted.push(result.slug);
            ingredientRows += result.ingredientRows;
            progress.promoted += 1;
            progress.ingredientRows += result.ingredientRows;
            logger.info('recipe_version_promoted', {
                stage: STAGE,
                slug: result.slug,
                version: result.version,
                ingredientRows: result.ingredientRows,
                reason: result.reason,
            });
        } else {
            unchanged.push(result.slug);
            progress.unchanged += 1;
            logger.debug('recipe_unchanged', { stage: STAGE, slug: result.slug, version: result.version });
        }

        // The watermark moves only for a COMMITTED transaction: `publishRecipe`
        // has returned, so whatever it decided is durable, and a cursor written
        // here can never describe work that rolled back.
        progress.settled += 1;
        progress.lastSlug = result.slug;
        progress.lastAction = result.action;
        await saveRunProgress({
            owner,
            progress,
            corpusSlugs: plans.length,
            now: deps.now,
        });
    }

    logger.info('recipes_published', {
        stage: STAGE,
        created: created.length,
        promoted: promoted.length,
        unchanged: unchanged.length,
        ingredientRows,
    });

    // A NARROWED RUN MUST NOT WRITE THE REPORT. The table is a claim about the
    // whole corpus, and the committed artefact is reviewed as a diff, so
    // emitting one recipe's view of it would replace forty-two recipes' numbers
    // with one's.
    if (options.only.length > 0) {
        const reason = `run narrowed to ${options.only.length} slug${options.only.length === 1 ? '' : 's'}, so the whole-corpus coverage report was not rewritten`;
        logger.warn('coverage_report_skipped', { stage: STAGE, note: reason, only: [...options.only] });

        await closeSucceededRun(owner, progress, logger);

        return {
            selected: plans.map((plan) => plan.slug),
            created,
            promoted,
            unchanged,
            ingredientRows,
            dryRun: false,
            report: null,
            reportPath: null,
            reportSkippedReason: reason,
            run,
            runSkippedReason,
        };
    }

    const seeded = await prisma.recipes.findMany<JoinedRecipeRow>({
        orderBy: { slug: 'asc' },
        include: COVERAGE_READ_INCLUDE,
    });
    const report = deriveCoverageReport(seeded.map(toCoverageRecipe));
    await publishCoverageReport({ owner, report, reportPath: deps.reportPath, writeReport: deps.writeReport });
    logger.info('coverage_report_written', {
        stage: STAGE,
        recipeCount: report.recipeCount,
        crossListedRecipeCount: report.crossListedRecipeCount,
        cells: report.eligibleCounts.length,
        guaranteedCells: report.guaranteedCells.length,
        reducedCells: report.reducedCells.length,
    });

    // Closed LAST, after the report the run promises has been written: the run
    // row and the committed artefact describe the same corpus, so a `succeeded`
    // row is evidence that both landed.
    await closeSucceededRun(owner, progress, logger);

    return {
        selected: plans.map((plan) => plan.slug),
        created,
        promoted,
        unchanged,
        ingredientRows,
        dryRun: false,
        report,
        reportPath: deps.reportPath,
        reportSkippedReason: null,
        run,
        runSkippedReason,
    };
};

// ---------------------------------------------------------------------------
// Reporting.
// ---------------------------------------------------------------------------

const gapFields = (gaps: readonly PrerequisiteGap[]): LogFields => {
    const fields: LogFields = { stage: STAGE, gapCount: gaps.length };
    for (const gap of gaps) {
        fields[`gap_${gap.code}`] =
            gap.detail === undefined
                ? `${gap.requirement}. ${gap.remedy}`
                : `${gap.requirement}. ${gap.remedy} [${gap.detail}]`;
    }
    return fields;
};

/**
 * The message of an error THIS REPOSITORY composed, as a log field.
 *
 * Only called from a branch that has already narrowed the value to a
 * first-party class — that narrowing is what makes reading a message legitimate
 * at all, and `firstPartyMessage` documents the obligation it discharges. The
 * field is named for its PROVENANCE, matching `scripts/seed-dev.ts` and
 * `scripts/catalog-import-usda.ts`, so a reader of a line can tell at a glance
 * that the sentence was written here and not quoted from a driver, a vendor or
 * the document that failed.
 */
const firstPartyMessageField = (error: unknown): LogFields => {
    const message = firstPartyMessage(error);

    return message === undefined ? {} : { firstPartyMessage: message };
};

/**
 * How many defects a corpus refusal found, when it found any.
 *
 * The `problems` list itself is deliberately NOT repeated here. The class
 * renders the whole list into its own message (see RecipeSeedError), the stage
 * has already written it as the `problems` array of its `recipes_rejected`
 * line, and `firstPartyMessage` caps the forwarded sentence — so the count is
 * the member that survives a truncated list and tells an operator how many
 * further defects the corpus holds.
 */
const recipeSeedErrorFields = (error: RecipeSeedError): LogFields =>
    error.problems.length === 0 ? {} : { problemCount: error.problems.length };

/**
 * What the classifier's remedy leaves out for THIS stage — and it is
 * deliberately not `catalog-import-usda.ts`'s `--resume` clause, which would be
 * false here.
 *
 * This stage has no `--resume` and needs none: it publishes one transaction per
 * recipe and is idempotent by `slug`, so re-running the same command reconciles
 * whatever the interrupted attempt committed and an already-current recipe is a
 * read (see the header, and claimRecipeSeedRun's third outcome). The one thing
 * that can delay that re-run is the interrupted attempt's own ledger row, so
 * the wait is named rather than left for an operator to meet as a second
 * refusal.
 */
const RERUN_CLAUSE =
    ' A run interrupted this way needs no --resume: the stage publishes one transaction per recipe and is idempotent by slug, so re-running the same command reconciles whatever the interrupted attempt committed and rewrites nothing that is already current.' +
    ` If that attempt had already claimed its run row, the re-run is refused as seed_in_progress until the row's lease lapses, ${RECIPE_SEED_RUN_LEASE_MS / 1000} seconds after its last committed recipe.`;

// Every error class this file can observe gets its own reported code; anything
// unrecognised is reported through safeError under `unexpected_error` rather
// than swallowed or printed raw.
// The reported `error` is `SafeErrorFields` — a scrubbed name plus an optional
// machine code and status, and deliberately no `message`: this value reaches the
// durable run log and the operator console, where foreign prose can carry a
// connection URL, a key or a fragment of the document that failed (CWE-532).
// What an operator acts on travels beside it in `detail` instead, where each
// member's provenance is stated by the field that carries it: this
// repository's own sentence under `firstPartyMessage`, typed facts under their
// own names, and fixed in-repo prose under `remedy`.
export const describeFailure = (error: unknown): { code: string; error: SafeErrorFields; detail?: LogFields } => {
    if (isThrownInstanceOf(error, RecipeSeedError)) {
        // First-party, and the arm that most needs its sentence: a seed refusal
        // names the recipe file, the declared field that disagreed with the
        // derivation and the ingredient `source_key` that could not be resolved
        // — §0.7.3's "fails loudly with the offending recipe and ingredient" —
        // and none of that survives in a code. The prose is this file's own,
        // composed against `problems` from data it validated, so forwarding it
        // echoes no driver, vendor or model text.
        return {
            code: error.code,
            error: safeError(error),
            detail: { ...recipeSeedErrorFields(error), ...firstPartyMessageField(error) },
        };
    }
    if (isThrownInstanceOf(error, DatabaseOriginError)) {
        // Deliberately WITHOUT its message, unlike the first-party arms around
        // it: a `DatabaseOriginError` explains itself by naming the host and
        // database it refused, and dbGuard reports that refusal itself with the
        // target reduced to a digest. Forwarding the sentence here would publish
        // the topology the guard's own line takes care to withhold.
        return { code: error.code, error: safeError(error) };
    }
    if (isThrownInstanceOf(error, ManifestError)) {
        // First-party: a manifest refusal names the file, the field and the two
        // values that disagree, which is the whole remedy and survives in no
        // code.
        return { code: error.code, error: safeError(error), detail: firstPartyMessageField(error) };
    }
    // Reachable for the ledger's own refusals — a run row that vanished or was
    // closed under this invocation — rather than for the stage lock, which
    // `runSeed` translates into `catalog_locked` before it gets here. Reported
    // under checkpoint.ts's code for the same reason every other stage does: a
    // new code in that module reaches operator terminals under its own name with
    // no change here.
    // The one branch that reports TYPED CONTEXT beside the code. A stage-lock
    // refusal names the stage holding the catalog graph and the mode it asked
    // for, and those are what an operator acts on — see checkpointErrorFields
    // for why they travel as data rather than inside the rendered sentence.
    if (isThrownInstanceOf(error, CheckpointError)) {
        return { code: error.code, error: safeError(error), detail: checkpointErrorFields(error) };
    }
    if (isThrownInstanceOf(error, RecipeDerivationError)) {
        return { code: 'recipe_derivation_failed', error: safeError(error) };
    }
    if (isThrownInstanceOf(error, UnitConversionError)) {
        return { code: 'unit_conversion_failed', error: safeError(error) };
    }
    // THE DATABASE, which used to be reported as a surprise.
    //
    // The stage takes its writer lock and the catalog graph hold through
    // checkpoint.ts's own raw `pg` session before it writes anything, so a
    // database that will not serve the run fails HERE — before Prisma exists to
    // translate it — as a node-postgres `DatabaseError` whose `name` is the
    // literal `'error'`. It matched none of the classes above and was reported
    // as `{"code":"unexpected_error","error":{"name":"error"}}`: no class, no
    // SQLSTATE, no remedy, for the most ordinary failure a stage has, which is
    // what made triage of a host at `max_connections` guesswork. The taxonomy
    // lives in logger.ts so every stage answers the same way, and `safeError`
    // carries the SQLSTATE beside this code.
    //
    // Immediately before the fallback and after every arm above it, so a class
    // this stage owns is never reclassified: a Prisma `P2002` is a seed-data
    // defect wearing a database code and `classifyInfrastructureFailure`
    // returns `null` for it, leaving it `unexpected_error`.
    const infrastructure = classifyInfrastructureFailure(error);
    if (infrastructure !== null) {
        return {
            code: infrastructure.code,
            error: safeError(error),
            detail: { remedy: `${infrastructure.remedy}${RERUN_CLAUSE}` },
        };
    }
    // Genuinely unclassified, and it says so with something to do about it
    // rather than with an empty hand.
    return { code: 'unexpected_error', error: safeError(error), detail: { remedy: UNEXPECTED_FAILURE_REMEDY } };
};

const main = async (): Promise<number> => {
    const parsed = parseArgs(process.argv.slice(2));

    if (!parsed.ok) {
        for (const failure of parsed.errors) {
            logger.error('argument_rejected', { stage: STAGE, flag: failure.flag, problem: failure.message });
        }
        writeUsage('error');
        return 1;
    }

    if (parsed.options.help) {
        writeUsage('info');
        return 0;
    }

    // Reaching this line means dbGuard already accepted the origin — including,
    // for a non-development one, the --confirm-target it owns.
    const origin = classifyDatabaseOrigin(process.env.DATABASE_URL);
    logger.info('database_origin_accepted', {
        stage: STAGE,
        ...originLogFields(origin),
    });
    logger.info('stage_invoked', { stage: STAGE, only: parsed.options.only, dryRun: parsed.options.dryRun });

    const gaps = preflight(defaultPreflightDeps());
    if (gaps.length > 0) {
        logger.error('stage_prerequisites_unmet', gapFields(gaps));
        return 1;
    }

    // Every input is present, so the stage runs. The Prisma client is reached
    // HERE rather than at module load: `src/prisma/client.ts` constructs the
    // client on import, and the suites that read parseArgs, preflight and the
    // pure derivations above must be able to do so without one.
    const { prisma } = await import('../src/prisma/client');

    try {
        const outcome = await runSeed({
            prisma: prisma as unknown as SeedDb,
            // The same singleton, named for both roles rather than left to the
            // publication client's default: in production the recipe writes and
            // the run row go to one database through one pool, and saying so
            // here is what makes the seam visible to a reader.
            runDb: prisma,
            recipesDir: recipesDir(),
            now: () => new Date(),
            options: parsed.options,
            logger,
            coveragePlan: loadCoveragePlan(),
            reportPath: path.join(recipesDir(), COVERAGE_REPORT_FILE),
            writeReport: writeJsonFile,
        });

        logger.info('stage_completed', {
            stage: STAGE,
            selected: outcome.selected.length,
            created: outcome.created.length,
            promoted: outcome.promoted.length,
            unchanged: outcome.unchanged.length,
            ingredientRows: outcome.ingredientRows,
            dryRun: outcome.dryRun,
            reportSkippedReason: outcome.reportSkippedReason,
            runId: outcome.run?.runId ?? null,
            manifestVersion: outcome.run?.manifestVersion ?? null,
            runAttempt: outcome.run?.attempt ?? null,
            runResumed: outcome.run?.resumed ?? false,
            runSkippedReason: outcome.runSkippedReason,
        });

        return 0;
    } finally {
        // In a `finally` so a refusal disconnects too: an open pool keeps the
        // process alive and a CI step that hangs after reporting its failure
        // reads as a timeout rather than as the refusal it is.
        await prisma.$disconnect();
    }
};

// Guarded so importing this module for parseArgs, preflight, describeUsage, the
// pure helpers or runSeed never runs the stage.
if (require.main === module) {
    main()
        .then((exitCode) => {
            process.exit(exitCode);
        })
        .catch((error: unknown) => {
            // createFatalLogger, not `logger`: the next statement discards
            // whatever is still buffered on process.stderr.
            const failure = describeFailure(error);
            createFatalLogger(STAGE).error('stage_failed', {
                stage: STAGE,
                code: failure.code,
                error: failure.error,
                // Spread, not nested: these are typed facts about the failure
                // (a run id, the stage holding the catalog graph, the mode it
                // asked for), and they read as fields of the failure rather
                // than as one opaque member. Absent for every failure that is
                // not a stage-lock refusal, which is the only branch that
                // supplies them.
                ...failure.detail,
            });
            process.exit(1);
        });
}
