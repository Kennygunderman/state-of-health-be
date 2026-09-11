/**
 * `src/utils/featureFlags.ts` reads the environment ONCE, at import — that is
 * the module's stated contract, so the only honest way to test it is to
 * re-import it per case. Every test therefore goes through `loadFlags`, which
 * resets the module registry, writes the environment, and requires the module
 * fresh.
 *
 * The environment is saved and restored around each case because
 * `src/__tests__/setup/jestSetup.ts` sets `MEAL_PLANNING_ENABLED` and
 * `MEAL_PLANNING_FAULT` for the whole run, and `NODE_ENV=test` is what the
 * database guard requires: a case that left any of the three rewritten would
 * change the meaning of every later suite in the file.
 */

type FeatureFlagsModule = typeof import('../featureFlags');

/** Only the variables this module reads. */
interface FlagEnv {
    MEAL_PLANNING_ENABLED?: string;
    MEAL_PLANNING_FAULT?: string;
    NODE_ENV?: string;
}

const MANAGED_KEYS: (keyof FlagEnv)[] = ['MEAL_PLANNING_ENABLED', 'MEAL_PLANNING_FAULT', 'NODE_ENV'];

const applyEnv = (env: FlagEnv): void => {
    for (const key of MANAGED_KEYS) {
        const value = env[key];
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }
};

/**
 * Re-imports the module under the given environment. `NODE_ENV` defaults to
 * `test`, the value the suite actually runs under, so a case only states the
 * environment it is about.
 */
const loadFlags = (env: FlagEnv): FeatureFlagsModule => {
    jest.resetModules();
    applyEnv({ NODE_ENV: 'test', ...env });

    // eslint-disable-next-line @typescript-eslint/no-var-requires -- the module reads env at import; that is what is under test
    return require('../featureFlags') as FeatureFlagsModule;
};

/** Requires the module and returns whatever it threw, for the failure cases. */
const loadFlagsExpectingThrow = (env: FlagEnv): unknown => {
    try {
        loadFlags(env);
    } catch (error) {
        return error;
    }
    return undefined;
};

const savedEnv: FlagEnv = {};

beforeAll(() => {
    for (const key of MANAGED_KEYS) {
        savedEnv[key] = process.env[key];
    }
});

afterEach(() => {
    applyEnv(savedEnv);
    jest.resetModules();
});

describe('isMealPlanningEnabled', () => {
    it('is true for the exact string "true"', () => {
        expect(loadFlags({ MEAL_PLANNING_ENABLED: 'true' }).isMealPlanningEnabled()).toBe(true);
    });

    it.each([
        ['unset', undefined],
        ['blank', ''],
        ['an explicit false', 'false'],
        ['upper case', 'TRUE'],
        ['mixed case', 'True'],
        ['padded', ' true'],
        ['numeric', '1'],
        ['yes', 'yes'],
    ])('is false when %s', (_case, value) => {
        // The polarity is deliberate and the inverse of AI_FEATURES_ENABLED: a
        // release boots with planning OFF and turns it on only once the catalog
        // has been loaded, so anything other than the exact opt-in means off.
        expect(loadFlags({ MEAL_PLANNING_ENABLED: value }).isMealPlanningEnabled()).toBe(false);
    });
});

describe('mealPlanningFault', () => {
    it.each([
        ['unset', undefined],
        ['blank', ''],
    ])('resolves to off when %s', (_case, value) => {
        expect(loadFlags({ MEAL_PLANNING_FAULT: value }).mealPlanningFault()).toBe('off');
    });

    it.each(['off', 'generation', 'swap', 'log'])('accepts %s', (value) => {
        expect(loadFlags({ MEAL_PLANNING_FAULT: value }).mealPlanningFault()).toBe(value);
    });

    it.each([
        ['an unrecognised value', 'bogus'],
        ['the right value in the wrong case', 'OFF'],
        ['a trailing space', 'log '],
        ['a leading space', ' swap'],
        ['a list', 'off,log'],
    ])('throws FeatureFlagError at import for %s', (_case, value) => {
        const error = loadFlagsExpectingThrow({ MEAL_PLANNING_FAULT: value });

        // At import, not at first use: a misspelled switch must fail the run it
        // was set for, not the first request that happens to read it.
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).name).toBe('FeatureFlagError');
        expect((error as Error).message).toContain('off | generation | swap | log');
        expect((error as Error).message).toContain(`received "${value}"`);
    });

    it.each([
        ['a bogus value', 'bogus'],
        ['a real fault', 'log'],
        ['a blank value', ''],
    ])('is forced to an inert off in production, without throwing, for %s', (_case, value) => {
        // Failing startup over a development-only switch would take the service
        // down, so production ignores the variable entirely. This check runs
        // BEFORE validation in the module, which is why "bogus" does not throw.
        const flags = loadFlags({ MEAL_PLANNING_FAULT: value, NODE_ENV: 'production' });

        expect(flags.mealPlanningFault()).toBe('off');
    });

    it('still validates the value in development', () => {
        const error = loadFlagsExpectingThrow({ MEAL_PLANNING_FAULT: 'bogus', NODE_ENV: 'development' });

        expect((error as Error).name).toBe('FeatureFlagError');
    });

    it('still validates the value when NODE_ENV is unset', () => {
        const error = loadFlagsExpectingThrow({ MEAL_PLANNING_FAULT: 'bogus', NODE_ENV: undefined });

        expect((error as Error).name).toBe('FeatureFlagError');
    });
});

describe('postCommitAbort — the log fault', () => {
    it.each(['test', 'development'])('aborts a log write whenever the fault is log (NODE_ENV=%s)', (nodeEnv) => {
        const flags = loadFlags({ MEAL_PLANNING_FAULT: 'log', NODE_ENV: nodeEnv });

        // The device path: a developer drives this from a phone against a dev
        // backend, so it is not gated on NODE_ENV.
        expect(flags.postCommitAbort('log', undefined)).toBe(true);
    });

    it('is inert in production even when the fault says log', () => {
        const flags = loadFlags({ MEAL_PLANNING_FAULT: 'log', NODE_ENV: 'production' });

        expect(flags.postCommitAbort('log', undefined)).toBe(false);
    });

    it.each<['generate' | 'regenerate' | 'swap']>([['generate'], ['regenerate'], ['swap']])(
        'leaves the %s action alone under the log fault',
        (actionType) => {
            const flags = loadFlags({ MEAL_PLANNING_FAULT: 'log', NODE_ENV: 'test' });

            expect(flags.postCommitAbort(actionType, undefined)).toBe(false);
        },
    );

    it('does not abort a log write when another fault is selected', () => {
        const flags = loadFlags({ MEAL_PLANNING_FAULT: 'generation', NODE_ENV: 'test' });

        expect(flags.postCommitAbort('log', undefined)).toBe(false);
    });
});

describe('postCommitAbort — the request header', () => {
    it('exports the header name so the controller and the suite share one spelling', () => {
        expect(loadFlags({}).POST_COMMIT_ABORT_HEADER).toBe('x-test-abort-after-commit');
    });

    it.each([
        ['the action name', 'log', 'log'],
        ['a swap', 'swap', 'swap'],
        ['a padded value', 'log', '  log  '],
    ])('honours %s under NODE_ENV=test', (_case, actionType, headerValue) => {
        const flags = loadFlags({ MEAL_PLANNING_FAULT: 'off', NODE_ENV: 'test' });

        expect(flags.postCommitAbort(actionType as 'log' | 'swap', headerValue)).toBe(true);
    });

    it.each([
        ['names a different action', 'log', 'swap'],
        ['is in the wrong case', 'log', 'LOG'],
        ['is blank', 'log', ''],
        ['is whitespace only', 'log', '   '],
    ])('refuses a header that %s, even under NODE_ENV=test', (_case, actionType, headerValue) => {
        const flags = loadFlags({ MEAL_PLANNING_FAULT: 'off', NODE_ENV: 'test' });

        expect(flags.postCommitAbort(actionType as 'log' | 'swap', headerValue)).toBe(false);
    });

    it.each([
        ['a repeated header, which Express yields as an array', ['log', 'log']],
        ['a missing header', undefined],
        ['a null value', null],
        ['a number', 1],
        ['an object', { value: 'log' }],
    ])('ignores %s', (_case, headerValue) => {
        const flags = loadFlags({ MEAL_PLANNING_FAULT: 'off', NODE_ENV: 'test' });

        // `unknown` is the parameter type precisely so these cannot reach the
        // comparison: a repeated `x-test-abort-after-commit` must not abort.
        expect(flags.postCommitAbort('log', headerValue)).toBe(false);
    });

    it.each(['development', 'production'])('ignores the header entirely under NODE_ENV=%s', (nodeEnv) => {
        const flags = loadFlags({ MEAL_PLANNING_FAULT: 'off', NODE_ENV: nodeEnv });

        expect(flags.postCommitAbort('log', 'log')).toBe(false);
        expect(flags.postCommitAbort('swap', 'swap')).toBe(false);
    });

    it('ignores the header when NODE_ENV is unset', () => {
        const flags = loadFlags({ MEAL_PLANNING_FAULT: 'off', NODE_ENV: undefined });

        expect(flags.postCommitAbort('log', 'log')).toBe(false);
    });
});

describe('the environment snapshot', () => {
    it('does not re-read the environment after import', () => {
        const flags = loadFlags({ MEAL_PLANNING_ENABLED: 'true', MEAL_PLANNING_FAULT: 'log' });

        process.env.MEAL_PLANNING_ENABLED = 'false';
        process.env.MEAL_PLANNING_FAULT = 'off';

        // A mid-flight environment change must not flip a flag under a running
        // request; the whole point of reading once is that the answer is stable.
        expect(flags.isMealPlanningEnabled()).toBe(true);
        expect(flags.mealPlanningFault()).toBe('log');
    });
});
