type FeatureFlagsModule = typeof import('../featureFlags');

type MealPlanningActionType = Parameters<FeatureFlagsModule['postCommitAbort']>[0];

interface FlagEnv {
    MEAL_PLANNING_ENABLED?: string;
    MEAL_PLANNING_FAULT?: string;
    NODE_ENV?: string;
}

const MANAGED_KEYS: (keyof FlagEnv)[] = ['MEAL_PLANNING_ENABLED', 'MEAL_PLANNING_FAULT', 'NODE_ENV'];

const ACTION_TYPES: MealPlanningActionType[] = ['generate', 'regenerate', 'swap', 'log'];

const INVALID_FAULT_MESSAGE = 'MEAL_PLANNING_FAULT must be one of off | generation | swap | log; received';

// Every case below rewrites the environment this module reads at import, and
// Jest hands a test file its own copy of `process.env` but never restores it
// between cases — so an abandoned value would change the meaning of every later
// case in this file, including the `NODE_ENV` the abort predicate branches on.
// The environment is therefore captured once here and put back after each case,
// and `afterAll` re-checks the baseline rather than trusting that it held.
const ORIGINAL_ENV: NodeJS.ProcessEnv = { ...process.env };

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

const restoreEnv = (): void => {
    for (const key of Object.keys(process.env)) {
        if (!(key in ORIGINAL_ENV)) {
            delete process.env[key];
        }
    }

    for (const key of Object.keys(ORIGINAL_ENV)) {
        const value = ORIGINAL_ENV[key];

        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }
};

// A module-registry reset, not a dependency mock: featureFlags.ts resolves its
// two variables and NODE_ENV once at import, which is the contract it exists to
// satisfy, so a scenario's environment can only be observed by re-evaluating the
// module. All three governed variables are cleared before the overrides land and
// NODE_ENV defaults to the value the suite really runs under, leaving every case
// independent of the ambient environment `setup/jestSetup.ts` establishes.
const loadFlags = (env: FlagEnv): FeatureFlagsModule => {
    applyEnv({ NODE_ENV: 'test', ...env });
    jest.resetModules();

    return require('../featureFlags') as FeatureFlagsModule;
};

afterEach(() => {
    restoreEnv();
    jest.resetModules();
});

afterAll(() => {
    restoreEnv();

    expect(process.env.NODE_ENV).toBe('test');
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
        ['numeric', '1'],
        ['yes', 'yes'],
        ['the name of a fault', 'off'],
    ])('is false when %s, because the opt-in is matched exactly', (_case, value) => {
        expect(loadFlags({ MEAL_PLANNING_ENABLED: value }).isMealPlanningEnabled()).toBe(false);
    });

    it('is false for "true" wrapped in whitespace, because the comparison does not trim', () => {
        expect(loadFlags({ MEAL_PLANNING_ENABLED: ' true ' }).isMealPlanningEnabled()).toBe(false);
    });

    it.each(['production', 'development'])(
        'is true for the exact opt-in under NODE_ENV=%s, because only the fault switch is production-gated',
        (nodeEnv) => {
            const flags = loadFlags({ MEAL_PLANNING_ENABLED: 'true', NODE_ENV: nodeEnv });

            expect(flags.isMealPlanningEnabled()).toBe(true);
        },
    );
});

describe('mealPlanningFault', () => {
    it.each(['off', 'generation', 'swap', 'log'])('accepts %s', (value) => {
        expect(loadFlags({ MEAL_PLANNING_FAULT: value }).mealPlanningFault()).toBe(value);
    });

    it.each([
        ['unset', undefined],
        ['blank', ''],
    ])('resolves to off when %s', (_case, value) => {
        expect(loadFlags({ MEAL_PLANNING_FAULT: value }).mealPlanningFault()).toBe('off');
    });

    it.each([
        ['an unrecognised value', 'bogus'],
        ['the right value in the wrong case', 'OFF'],
        ['a trailing space', 'log '],
        ['a leading space', ' swap'],
        ['a list', 'off,log'],
    ])('rejects %s at import rather than coercing it to a working default', (_case, value) => {
        expect(() => loadFlags({ MEAL_PLANNING_FAULT: value })).toThrow(
            `${INVALID_FAULT_MESSAGE} "${value}"`,
        );
    });

    it('rejects an unrecognised value with an error named FeatureFlagError', () => {
        let caught: unknown;

        try {
            loadFlags({ MEAL_PLANNING_FAULT: 'bogus' });
        } catch (error) {
            caught = error;
        }

        expect(caught).toBeInstanceOf(Error);
        expect((caught as Error).name).toBe('FeatureFlagError');
    });

    it.each(['development', 'test'])('still rejects an unrecognised value under NODE_ENV=%s', (nodeEnv) => {
        expect(() => loadFlags({ MEAL_PLANNING_FAULT: 'bogus', NODE_ENV: nodeEnv })).toThrow(
            INVALID_FAULT_MESSAGE,
        );
    });

    it('still rejects an unrecognised value when NODE_ENV is unset', () => {
        expect(() => loadFlags({ MEAL_PLANNING_FAULT: 'bogus', NODE_ENV: undefined })).toThrow(
            INVALID_FAULT_MESSAGE,
        );
    });

    it.each([
        ['a value it rejects everywhere else', 'bogus'],
        ['a real fault', 'log'],
        ['a blank value', ''],
    ])(
        'is inert in production for %s: forced to off, and never thrown over',
        (_case, value) => {
            expect(() => loadFlags({ MEAL_PLANNING_FAULT: value, NODE_ENV: 'production' })).not.toThrow();

            const flags = loadFlags({ MEAL_PLANNING_FAULT: value, NODE_ENV: 'production' });

            expect(flags.mealPlanningFault()).toBe('off');
        },
    );
});

describe('postCommitAbort — the log fault', () => {
    it.each(['test', 'development'])(
        'aborts a log write whenever the fault is log, including under NODE_ENV=%s',
        (nodeEnv) => {
            const flags = loadFlags({ MEAL_PLANNING_FAULT: 'log', NODE_ENV: nodeEnv });

            expect(flags.postCommitAbort('log', undefined)).toBe(true);
        },
    );

    it('is inert in production even when the fault says log', () => {
        const flags = loadFlags({ MEAL_PLANNING_FAULT: 'log', NODE_ENV: 'production' });

        expect(flags.postCommitAbort('log', undefined)).toBe(false);
    });

    it.each<[MealPlanningActionType]>([['generate'], ['regenerate'], ['swap']])(
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
    it.each(ACTION_TYPES)('honours a header naming the %s action under NODE_ENV=test', (actionType) => {
        const flags = loadFlags({ MEAL_PLANNING_FAULT: 'off', NODE_ENV: 'test' });

        expect(flags.postCommitAbort(actionType, actionType)).toBe(true);
    });

    it('trims the header before comparing it, unlike the MEAL_PLANNING_ENABLED opt-in', () => {
        const flags = loadFlags({ MEAL_PLANNING_FAULT: 'off', NODE_ENV: 'test' });

        expect(flags.postCommitAbort('log', ' log ')).toBe(true);
    });

    it.each<[string, MealPlanningActionType, string]>([
        ['names a different action', 'swap', 'log'],
        ['is in the wrong case', 'log', 'LOG'],
        ['is blank', 'log', ''],
        ['is whitespace only', 'log', '   '],
    ])('refuses a header that %s, even under NODE_ENV=test', (_case, actionType, headerValue) => {
        const flags = loadFlags({ MEAL_PLANNING_FAULT: 'off', NODE_ENV: 'test' });

        expect(flags.postCommitAbort(actionType, headerValue)).toBe(false);
    });

    it.each([
        ['a repeated header, which Express yields as an array', ['log', 'log']],
        ['a missing header', undefined],
        ['a null value', null],
        ['a number', 42],
        ['a boolean', true],
        ['an object carrying the action', { value: 'log' }],
    ])('ignores %s, so only a string can trip the seam', (_case, headerValue) => {
        const flags = loadFlags({ MEAL_PLANNING_FAULT: 'off', NODE_ENV: 'test' });

        expect(flags.postCommitAbort('log', headerValue)).toBe(false);
    });

    it.each(['development', 'production'])(
        'never reads the header under NODE_ENV=%s, so a client cannot reach the seam',
        (nodeEnv) => {
            const flags = loadFlags({ MEAL_PLANNING_FAULT: 'off', NODE_ENV: nodeEnv });

            expect(flags.postCommitAbort('log', 'log')).toBe(false);
            expect(flags.postCommitAbort('swap', 'swap')).toBe(false);
        },
    );

    it('never reads the header when NODE_ENV is unset', () => {
        const flags = loadFlags({ MEAL_PLANNING_FAULT: 'off', NODE_ENV: undefined });

        expect(flags.postCommitAbort('log', 'log')).toBe(false);
    });
});

describe('POST_COMMIT_ABORT_HEADER', () => {
    it('is the exact header name the controller and the fault suite both spell', () => {
        expect(loadFlags({}).POST_COMMIT_ABORT_HEADER).toBe('x-test-abort-after-commit');
    });
});

describe('the environment snapshot', () => {
    it('does not re-read the environment after import, so a flag cannot flip mid-request', () => {
        const flags = loadFlags({ MEAL_PLANNING_ENABLED: 'true', MEAL_PLANNING_FAULT: 'log' });

        process.env.MEAL_PLANNING_ENABLED = 'false';
        process.env.MEAL_PLANNING_FAULT = 'off';

        expect(flags.isMealPlanningEnabled()).toBe(true);
        expect(flags.mealPlanningFault()).toBe('log');
    });
});
