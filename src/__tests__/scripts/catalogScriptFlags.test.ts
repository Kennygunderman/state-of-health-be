/**
 * The flag policies that span the pipeline's ENTRY POINTS rather than living
 * inside one of them: the no-value switches of the two stages whose flags
 * authorize something expensive (`catalog-release.ts`, `catalog-validate.ts`),
 * and `--help`/`-h` across all nine entry points at once.
 *
 * ── PART ONE: THE NO-VALUE SWITCHES ───────────────────────────────────────
 *
 * WHAT THIS FILE IS FOR. A flag that takes no value has exactly one accepted
 * spelling — the bare token — and the cases below pin that for all four of
 * them: `--force`, `--review`, `--revalidate-quarantined` and `--dry-run`. The
 * bare token turns its own option on and nothing else; an inline value of any
 * kind is a refusal that names the flag; the same switch written twice is a
 * refusal too; and the forms that legitimately carry a value are untouched by
 * the policy.
 *
 * WHY IT EXISTS. Both parsers separated an inline value off the token and then
 * ignored it, so `--force=false` parsed to `force: true` and `--review=false`
 * to `review: true`. Neither failure was recoverable downstream: `--force`
 * authorizes publication over a release directory that already holds a
 * reviewed, checksummed artefact other environments load, and `--review`
 * starts the advisory model pass that spends the shared
 * CATALOG_MODEL_CALL_BUDGET. An operator who typed the safe thing got the
 * expensive one, which is the wrong direction of failure for both. The
 * duplicate cases are here for the same reason: a switch written twice is not
 * a command line anyone meant to write, and these decide what is overwritten
 * and what is spent.
 *
 * WHY IT IS ITS OWN FILE RATHER THAN A BLOCK IN EITHER STAGE'S SUITE. The
 * policy spans two stages and reads identically in both, so asserting it twice
 * against two different sets of fixtures would say less than asserting it once
 * against both parsers. It also needs nothing the stage suites need:
 * `parseArgs` is pure, so importing the two modules is the whole fixture — no
 * database, no filesystem, no vendor, no clock.
 *
 * WHAT IT DELIBERATELY LEAVES ELSEWHERE. What the stages DO with the parsed
 * options belongs to their own suites and stays there:
 * `catalog-release.test.ts` owns the publication overwrite rule `--force`
 * reaches, the staging and ledger behaviour around it, and the release's
 * members; `catalog-validate.test.ts` owns the unit of work, the resume
 * accounting and the advisory-review spend `--review` reaches;
 * `catalog-load.test.ts` owns its own stage's `--dry-run`. The value-taking
 * flags' own grammar — the `--release`/`--version` conflict, `--out`,
 * repeated `--category` — likewise stays with those suites; the two cases here
 * that touch a value-taking flag are about the BOUNDARY of this policy, i.e.
 * that it did not spread to flags that take a value.
 *
 * ── PART TWO: --help, ON EVERY ENTRY POINT ────────────────────────────────
 *
 * WHAT IT SETTLES. `docs/meal-planning/README.md` claims, without
 * qualification, that "Each CLI entry point prints its own authoritative usage
 * … for `npm run <script> -- --help`". That claim was false: `dbGuard.ts`
 * asserts the database origin AT MODULE LOAD, which is before any script's
 * `parseArgs` runs, so every one of the nine printed a `database_origin_refused`
 * line and exited 1 unless `DATABASE_URL` already satisfied that script's
 * policy — the operator least likely to have configured one being exactly the
 * operator reaching for `--help`. The guard now skips its assertion for a help
 * invocation, decided from argv alone, and the block below is what holds that
 * claim true FOR EVERY ENTRY POINT, including a tenth added later: the scripts
 * are enumerated from `SCRIPT_DATABASE_POLICIES` itself rather than listed
 * here, so a new one joins these cases the moment it is given a policy.
 *
 * TWO ASSERTIONS PER SCRIPT, AND THE SECOND IS WHY THE FIRST IS SAFE. Under a
 * `DATABASE_URL` every policy refuses: with a help flag the command prints its
 * own usage block and exits 0, and with no help flag the SAME command against
 * the SAME database still refuses fatally and prints no usage at all. An
 * exemption that had widened past the scripts' own predicate would show up in
 * the second case; the per-token agreement between that predicate and the
 * guard's is asserted in process, just above, over both parsers of every
 * script.
 *
 * WHY PART TWO SPAWNS. `require.main === module` guards every script's `main()`
 * and this file has already imported the modules, so neither the module-load
 * ordering nor an exit status is observable in process — the honest form is a
 * real child per invocation, its status and its two streams read. The children
 * cost about a second each, make no vendor call and need no vendor key: help
 * returns before `preflight` and the refusal happens before `main()` at all.
 * Their `DATABASE_URL` is a fixture no policy accepts AND no server answers, so
 * a regression that let one through fails the case immediately instead of
 * reaching a database.
 *
 * WHAT PART TWO IS NOT. It does not re-derive the origin policies themselves —
 * which class each script accepts, and what `--confirm-target` opens, belong to
 * `dbGuard.test.ts` — and it says nothing about the CONTENT of a usage block
 * beyond its first line naming the command and the stage; each stage's suite
 * owns its own options.
 *
 * Jest's `roots` is `<rootDir>/src` (jest.config.ts), so the relative imports
 * into `scripts/` are a consequence of that rather than a choice. Part one
 * needs nothing but those imports; part two additionally needs `child_process`
 * and the repository path its children run from, and neither part touches a
 * database, a vendor or the clock from this process.
 *
 * Run it with:
 *
 *   NODE_ENV=test ALLOW_DB_TRUNCATE=true \
 *     DATABASE_URL=postgresql://…@127.0.0.1:5433/<name>_test \
 *     npx jest src/__tests__/scripts/catalogScriptFlags.test.ts --runInBand
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { parseArgs as parseGenerateArgs } from '../../../scripts/catalog-generate-ai';
import { parseArgs as parseImportArgs } from '../../../scripts/catalog-import-usda';
import { parseArgs as parseLoadArgs } from '../../../scripts/catalog-load';
import { parseArgs as parseReleaseArgs } from '../../../scripts/catalog-release';
import { parseArgs as parseReportArgs } from '../../../scripts/catalog-report';
import { DEFAULT_CURATOR_DECISIONS_PATH, parseArgs as parseValidateArgs } from '../../../scripts/catalog-validate';
import { HELP_FLAGS, isHelpInvocation, SCRIPT_DATABASE_POLICIES } from '../../../scripts/lib/dbGuard';
import { parseArgs as parseRecipesSeedArgs } from '../../../scripts/recipes-seed';
import { parseArgs as parseBenchmarkArgs } from '../../../scripts/search-benchmark';
import { parseArgs as parseSeedDevArgs } from '../../../scripts/seed-dev';

/**
 * The shape both stages' `ParseResult` unions satisfy, written structurally so
 * one set of helpers reads both without either stage's option interface
 * appearing here — the cases are about WHICH option a token changed, not about
 * either stage's option shape.
 */
type ParseOutcome =
    | { readonly ok: true; readonly options: unknown }
    | { readonly ok: false; readonly errors: readonly { readonly flag: string; readonly message: string }[] };

/** One no-value switch, and the minimal command line its parser accepts. */
interface SwitchUnderTest {
    /** The npm script an operator runs, for the test names. */
    readonly stage: string;
    /** The token exactly as it is typed. */
    readonly flag: string;
    /** The accepted command line WITHOUT this switch: its own baseline. */
    readonly baseArgv: readonly string[];
    /** The option key this switch — and only this switch — sets. */
    readonly optionKey: string;
    readonly parse: (argv: readonly string[]) => ParseOutcome;
}

const SWITCHES: readonly SwitchUnderTest[] = [
    {
        stage: 'catalog:release',
        flag: '--force',
        baseArgv: ['--release', 'v1'],
        optionKey: 'force',
        parse: parseReleaseArgs,
    },
    {
        stage: 'catalog:validate',
        flag: '--review',
        baseArgv: [],
        optionKey: 'review',
        parse: parseValidateArgs,
    },
    {
        stage: 'catalog:validate',
        flag: '--revalidate-quarantined',
        baseArgv: [],
        optionKey: 'revalidateQuarantined',
        parse: parseValidateArgs,
    },
    {
        stage: 'catalog:validate',
        flag: '--dry-run',
        baseArgv: [],
        optionKey: 'dryRun',
        parse: parseValidateArgs,
    },
];

/**
 * Every inline value a no-value switch is refused with, and what each one
 * represents. `false` and `0` are the two spellings of the request the old
 * parsers honoured as its opposite; `true` is refused as well, because reading
 * it would make the grammar look like it has an off switch when `=false` is
 * precisely what cannot be honoured.
 */
const REFUSED_INLINE_VALUES: readonly { readonly value: string; readonly meaning: string }[] = [
    { value: 'false', meaning: 'the word an operator reaches for to turn a switch off' },
    { value: '0', meaning: 'the numeric spelling of that same request' },
    { value: 'true', meaning: 'a value agreeing with the switch, still outside its grammar' },
    { value: 'garbage', meaning: 'a value with no boolean reading at all' },
    { value: '', meaning: 'a trailing = with nothing after it' },
];

/**
 * The accepted options, as a string-keyed record, or a failure naming what the
 * parser refused and the command line it refused.
 *
 * The one cast in this file. The two stages' option shapes are two unrelated
 * interfaces and these cases assert which KEY changed between two parses of
 * the same parser, so the options are read as records rather than through
 * either interface; a wrong key name therefore surfaces as an `undefined`
 * comparison in the case that names it, not as a silent pass.
 */
const optionsOf = (outcome: ParseOutcome, argv: readonly string[]): Readonly<Record<string, unknown>> => {
    if (!outcome.ok) {
        throw new Error(
            `parseArgs refused "${argv.join(' ')}", which this case needs it to accept: ` +
                outcome.errors.map((error) => `${error.flag}: ${error.message}`).join('; '),
        );
    }
    return outcome.options as Readonly<Record<string, unknown>>;
};

/** The flags a refusal names, or a failure saying the parse was accepted. */
const refusedFlags = (outcome: ParseOutcome, argv: readonly string[]): readonly string[] => {
    if (outcome.ok) {
        throw new Error(`parseArgs accepted "${argv.join(' ')}", which this case needs it to refuse`);
    }
    return outcome.errors.map((error) => error.flag);
};

/** The messages a refusal carries, in the order the parser accumulated them. */
const refusalMessages = (outcome: ParseOutcome, argv: readonly string[]): readonly string[] => {
    if (outcome.ok) {
        throw new Error(`parseArgs accepted "${argv.join(' ')}", which this case needs it to refuse`);
    }
    return outcome.errors.map((error) => error.message);
};

for (const subject of SWITCHES) {
    describe(`${subject.stage} ${subject.flag}`, () => {
        it('is off when the switch is not written', () => {
            const options = optionsOf(subject.parse(subject.baseArgv), subject.baseArgv);

            expect(options[subject.optionKey]).toBe(false);
        });

        it('turns on its own option and no other, from the bare token', () => {
            const argv = [...subject.baseArgv, subject.flag];
            const withoutSwitch = optionsOf(subject.parse(subject.baseArgv), subject.baseArgv);
            const withSwitch = optionsOf(subject.parse(argv), argv);

            // Compared against the same parser's own baseline rather than a
            // hand-written option shape: this asserts that ONE key moved and
            // that it is this switch's, whatever else the stage's options hold.
            expect(withSwitch).toEqual({ ...withoutSwitch, [subject.optionKey]: true });
        });

        for (const { value, meaning } of REFUSED_INLINE_VALUES) {
            it(`refuses ${subject.flag}=${value} — ${meaning}`, () => {
                const argv = [...subject.baseArgv, `${subject.flag}=${value}`];
                const outcome = subject.parse(argv);

                expect(outcome.ok).toBe(false);
                expect(refusedFlags(outcome, argv)).toEqual([subject.flag]);
                expect(refusalMessages(outcome, argv)[0]).toContain(`${subject.flag} takes no value`);
                // The refusal carries no options at all, so there is no value
                // of this switch for a caller to read: the rejected token
                // cannot enable what it named, which is the whole point of
                // refusing it rather than ignoring the inline value.
                expect('options' in outcome).toBe(false);
            });
        }

        it('refuses the same switch given twice', () => {
            const argv = [...subject.baseArgv, subject.flag, subject.flag];
            const outcome = subject.parse(argv);

            expect(refusedFlags(outcome, argv)).toEqual([subject.flag]);
            expect(refusalMessages(outcome, argv)[0]).toContain('more than once');
            expect('options' in outcome).toBe(false);
        });
    });
}

describe('the accepted command lines the policy must not have narrowed', () => {
    it('parses catalog:release --release v1 with the overwrite switch at its default', () => {
        const argv = ['--release', 'v1'];
        const options = optionsOf(parseReleaseArgs(argv), argv);

        expect(options).toEqual({ help: false, release: 'v1', force: false, outRoot: null });
    });

    it('still accepts --release=v1, the inline form of a flag that does take a value', () => {
        const argv = ['--release=v1', '--force'];
        const options = optionsOf(parseReleaseArgs(argv), argv);

        // The policy is about no-value switches only: refusing `--force=false`
        // must not make `=` itself suspect on a flag whose grammar includes it.
        expect(options).toEqual({ help: false, release: 'v1', force: true, outRoot: null });
    });

    it('parses --out beside the overwrite switch, so the two still compose', () => {
        const argv = ['--release', 'v1', '--out', '/tmp/releases', '--force'];
        const options = optionsOf(parseReleaseArgs(argv), argv);

        expect(options).toEqual({ help: false, release: 'v1', force: true, outRoot: '/tmp/releases' });
    });

    it('parses catalog:validate --category <name> alone with every switch off', () => {
        const argv = ['--category', 'produce_vegetable'];
        const options = optionsOf(parseValidateArgs(argv), argv);

        expect(options).toEqual({
            help: false,
            categories: ['produce_vegetable'],
            revalidateQuarantined: false,
            review: false,
            dryRun: false,
            // Not a switch this policy governs: the reviewed curator-decisions
            // artefact is read by default, and `--no-curator-decisions` is what
            // declines it, so every accepted command line carries this path.
            curatorDecisionsPath: DEFAULT_CURATOR_DECISIONS_PATH,
        });
    });

    it('parses catalog:validate with all three switches written once each', () => {
        const argv = ['--revalidate-quarantined', '--review', '--dry-run'];
        const options = optionsOf(parseValidateArgs(argv), argv);

        expect(options).toEqual({
            help: false,
            categories: [],
            revalidateQuarantined: true,
            review: true,
            dryRun: true,
            curatorDecisionsPath: DEFAULT_CURATOR_DECISIONS_PATH,
        });
    });
});

/* ===========================================================================
 * PART TWO: --help, on every entry point
 * ========================================================================= */

/**
 * Every entry point's `parseArgs`, keyed by the module name the guard's policy
 * table uses.
 *
 * Written out rather than derived, because a dynamic import cannot be typed and
 * a name typed twice is what the first case below catches: the key set is
 * compared with `SCRIPT_DATABASE_POLICIES`, so a tenth script — which must have
 * a policy to run at all — cannot join the pipeline without joining these
 * cases.
 */
const ENTRY_POINT_PARSERS: Readonly<Record<string, (argv: readonly string[]) => ParseOutcome>> = {
    'catalog-import-usda': parseImportArgs,
    'catalog-generate-ai': parseGenerateArgs,
    'catalog-validate': parseValidateArgs,
    'catalog-report': parseReportArgs,
    'catalog-release': parseReleaseArgs,
    'catalog-load': parseLoadArgs,
    'recipes-seed': parseRecipesSeedArgs,
    'search-benchmark': parseBenchmarkArgs,
    'seed-dev': parseSeedDevArgs,
};

/** The nine, in the order the policy table declares them. */
const ENTRY_POINTS: readonly string[] = Object.keys(SCRIPT_DATABASE_POLICIES);

/**
 * Whether a parse answered HELP — false for a refusal, which is the reading
 * that matters here: a script that refused the command line did not print a
 * usage block and exit 0, so for the purposes of the exemption it is not help.
 */
const helpOf = (outcome: ParseOutcome): boolean =>
    outcome.ok && (outcome.options as { readonly help?: unknown }).help === true;

/**
 * Every spelling the exemption is measured against, and what each one is doing
 * there. The two predicates — each script's own and the guard's — have to
 * return the same answer for every row, in both directions: a row the guard
 * exempts and a script does not would reach that script's stage with no
 * assertion behind it, and a row a script answers as help and the guard does
 * not is the unreachable usage block this part exists to prevent.
 */
const HELP_SPELLINGS: readonly { readonly tail: readonly string[]; readonly meaning: string }[] = [
    { tail: ['--help'], meaning: 'the long flag, alone' },
    { tail: ['-h'], meaning: 'the short flag, alone' },
    { tail: ['--help', '--dry-run'], meaning: 'help written first, with another flag after it' },
    { tail: ['--dry-run', '--help'], meaning: 'help written last' },
    { tail: ['--release', 'v1', '-h'], meaning: 'help after a flag that takes a value' },
    { tail: ['--confirm-target', '-h'], meaning: "help where the guard's own flag would take its value" },
    { tail: ['--confirm-target', 'soh_test', '--help'], meaning: 'help after a complete confirmation' },
    { tail: ['--help=x'], meaning: 'an inline value on the long flag, which is not a help request' },
    { tail: ['--help='], meaning: 'a trailing = with nothing after it' },
    { tail: ['-h=1'], meaning: 'an inline value on the short flag' },
    { tail: ['--helper'], meaning: 'a longer token that merely starts the same way' },
    { tail: ['-help'], meaning: 'a single-dash spelling of the long flag' },
    { tail: ['--HELP'], meaning: 'an upper-case spelling nothing folds' },
    { tail: [], meaning: 'no arguments at all' },
];

describe('the help flag, across every entry point', () => {
    it('has a parser here for every script the guard has a policy for', () => {
        // The guard's policy table is the pipeline's own register of entry
        // points, so it — not a list in this file — decides what "every entry
        // point" means.
        expect(Object.keys(ENTRY_POINT_PARSERS).sort()).toEqual([...ENTRY_POINTS].sort());
        expect(ENTRY_POINTS).toHaveLength(9);
    });

    describe.each(ENTRY_POINTS)('%s', (script) => {
        const parse = ENTRY_POINT_PARSERS[script];

        it.each(HELP_SPELLINGS.map(({ tail, meaning }) => [meaning, tail] as const))(
            'agrees with the guard about %s',
            (_meaning, tail) => {
                // The guard reads a full `process.argv`; a script reads
                // `process.argv.slice(2)`. The same tail is therefore handed to
                // both, in the two shapes each of them is given at runtime, and
                // the answers must be identical.
                expect(helpOf(parse(tail))).toBe(isHelpInvocation(['/usr/bin/node', `/repo/scripts/${script}.ts`, ...tail]));
            },
        );

        it('answers help ahead of every argument error the same line would otherwise produce', () => {
            // Why the exemption cannot need a valid command line first: the
            // help branch is the first statement of each parser, so a line that
            // is nonsense in every other respect is still a usage request.
            const nonsense = ['--not-a-flag', 'value', '--help'];

            expect(helpOf(parse(nonsense))).toBe(true);
            expect(isHelpInvocation(['/usr/bin/node', `/repo/scripts/${script}.ts`, ...nonsense])).toBe(true);
            // And without the help token the same line is a refusal, which is
            // what makes the assertion above about help rather than about the
            // parser being lenient.
            expect(parse(['--not-a-flag', 'value']).ok).toBe(false);
        });

        it('declares the same two tokens the guard exempts', () => {
            // Read off the parser rather than off the script's source: each
            // script's `HELP_FLAGS` is private, so the observable form of "the
            // same two tokens" is that each of them, alone, answers help and
            // nothing else does.
            for (const flag of HELP_FLAGS) {
                expect(helpOf(parse([flag]))).toBe(true);
            }
            expect(helpOf(parse(['--usage']))).toBe(false);
            expect(helpOf(parse(['-?']))).toBe(false);
        });
    });
});

/* ---------------------------------------------------------------------------
 * The usage block, reached out of process under a refused database
 * ------------------------------------------------------------------------- */

/** The backend package root: `<repo>/backend`, three levels above this file. */
const BACKEND_ROOT = path.resolve(__dirname, '..', '..', '..');

/** One child compiles a whole stage through ts-node; a minute is generous. */
const CHILD_TIMEOUT_MS = 60_000;

/** Two children per case, plus Jest's own overhead. */
const CASE_TIMEOUT_MS = 180_000;

/**
 * A `DATABASE_URL` every policy refuses and no server answers.
 *
 * `127.0.0.2` is deliberate on both counts. It is outside `LOCAL_HOSTS`, so the
 * origin classifies `unknown` and is refused by all four policies — one fixture
 * therefore covers the read-only stages and the writers alike, and the refusal
 * is the same `unrecognised_origin` for every child. And it is a loopback
 * address nothing listens on, so a regression that let a real run past the
 * guard fails on a refused connection in milliseconds instead of reaching a
 * database or hanging on DNS. The userinfo is a placeholder: nothing here ever
 * opens a connection, so a real credential would be a committed secret for no
 * gain.
 */
const REFUSED_DATABASE_URL = 'postgresql://flag_fixture:fixture-only@127.0.0.2:5432/state_of_health';

interface CliOutcome {
    readonly status: number | null;
    readonly stdout: string;
    readonly stderr: string;
}

/**
 * Runs one entry point as a real CLI process with `REFUSED_DATABASE_URL` in its
 * environment.
 *
 * The environment is built rather than inherited, for two reasons. `DATABASE_URL`
 * must be SET: `lib/bootstrap.ts` calls `dotenv.config()` without override, so
 * a child without one would silently fall back to `backend/.env` — the test
 * database, which several policies accept, and the case would assert nothing.
 * And no vendor key is passed, because none is needed: a help invocation
 * returns before `preflight` reads one, and a refused invocation never reaches
 * `main()`, so neither child can open a vendor request. `PATH`/`HOME` are
 * forwarded because ts-node resolves through them.
 */
const runEntryPoint = (script: string, args: readonly string[]): CliOutcome => {
    const child = spawnSync(
        process.execPath,
        ['--require', 'ts-node/register/transpile-only', path.join(BACKEND_ROOT, 'scripts', `${script}.ts`), ...args],
        {
            cwd: BACKEND_ROOT,
            encoding: 'utf8',
            timeout: CHILD_TIMEOUT_MS,
            env: {
                PATH: process.env.PATH,
                HOME: process.env.HOME,
                DATABASE_URL: REFUSED_DATABASE_URL,
                TS_NODE_PROJECT: 'tsconfig.scripts.json',
                TS_NODE_TRANSPILE_ONLY: '1',
            },
        },
    );

    expect(child.error).toBeUndefined();

    return { status: child.status, stdout: child.stdout, stderr: child.stderr };
};

describe('every entry point under a database its policy refuses', () => {
    describe.each(ENTRY_POINTS)('%s', (script) => {
        it.each([['--help'], ['-h']])('prints its own usage block and exits 0 for %s', (flag) => {
            const outcome = runEntryPoint(script, [flag]);

            expect(outcome.status).toBe(0);
            // The first line names the npm script an operator types and the
            // stage that answered, so the usage block is provably THIS script's
            // rather than any usage text at all.
            const firstLine = outcome.stdout.split('\n')[0];
            expect(firstLine).toMatch(/^Usage: npm run \S+ -- /);
            expect(firstLine).toContain(`(${script})`);
            // Nothing else reaches either stream: the usage block is the whole
            // artefact of this path, and a `database_origin_refused` line on it
            // would mean the guard had run and reported anyway.
            expect(outcome.stdout).not.toContain('database_origin_refused');
            expect(outcome.stderr).toBe('');
        }, CASE_TIMEOUT_MS);

        it('still refuses that database fatally, before main(), when no help flag is written', () => {
            const outcome = runEntryPoint(script, []);

            expect(outcome.status).toBe(1);
            expect(outcome.stderr).toContain('"event":"database_origin_refused"');
            expect(outcome.stderr).toContain(`"script":"${script}"`);
            expect(outcome.stderr).toContain('"code":"unrecognised_origin"');
            // The refusal precedes `parseArgs`, so a stage whose required flags
            // are missing reports the DATABASE and not the flags: no usage
            // block on either stream, and no argument error either.
            expect(outcome.stdout).toBe('');
            expect(outcome.stderr).not.toContain('Usage: npm run');
            expect(outcome.stderr).not.toContain('argument_rejected');
        }, CASE_TIMEOUT_MS);

        it('is refused for --help=x, which no script reads as help', () => {
            // The one direction a widened exemption would open, asserted
            // end to end: an inline value makes the token an ordinary flag, so
            // the guard must still refuse rather than hand the line to a parser
            // that would reject it anyway.
            const outcome = runEntryPoint(script, ['--help=x']);

            expect(outcome.status).toBe(1);
            expect(outcome.stderr).toContain('"event":"database_origin_refused"');
            expect(outcome.stdout).toBe('');
        }, CASE_TIMEOUT_MS);
    });
});
