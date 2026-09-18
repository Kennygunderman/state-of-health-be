/**
 * The switch-parsing policy of the two catalog stages whose no-value flags
 * authorize something expensive: `catalog-release.ts` and `catalog-validate.ts`.
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
 * Jest's `roots` is `<rootDir>/src` (jest.config.ts), so the relative imports
 * into `scripts/` are a consequence of that rather than a choice.
 *
 * Run it with:
 *
 *   NODE_ENV=test ALLOW_DB_TRUNCATE=true \
 *     DATABASE_URL=postgresql://…@127.0.0.1:5433/<name>_test \
 *     npx jest src/__tests__/scripts/catalogScriptFlags.test.ts --runInBand
 */
import { parseArgs as parseReleaseArgs } from '../../../scripts/catalog-release';
import { DEFAULT_CURATOR_DECISIONS_PATH, parseArgs as parseValidateArgs } from '../../../scripts/catalog-validate';

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
