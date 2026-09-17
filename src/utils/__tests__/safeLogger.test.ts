// The safe-logging rules, pinned one at a time.
//
// This suite is the evidence for the edge-logging finding (OBSBE-F01): the
// controller no longer hands a raw error, cause or request value to
// `console.error`, and every value it does log passes through the three
// functions below. A rule that is only stated in a comment is a rule that can
// be lost to a refactor — each case here is one of those rules, with the leak
// it prevents named.
//
// Pure by construction: no database, no Express, no application module. The
// only ambient dependency is `console`, spied per case.

import { describeErrorSafely, logSafeEvent, sanitizeLogText } from '../safeLogger';

/** The bound `sanitizeLogText` applies when the caller names none. */
const DEFAULT_MAX_TEXT_LENGTH = 200;

/** What a truncated value ends with. */
const TRUNCATION_MARKER = '…';

/**
 * Captures the single line one `logSafeEvent` call emits, and proves it WAS a
 * single call to the level's own console method.
 */
const captureEvent = (
    level: 'info' | 'warn' | 'error',
    emit: () => void,
): { line: string; event: string; fields: Record<string, unknown> } => {
    const spy = jest.spyOn(console, level).mockImplementation(() => undefined);

    try {
        emit();

        expect(spy).toHaveBeenCalledTimes(1);

        const line = String(spy.mock.calls[0][0]);
        const match = /^\[meal-planning] (\S+) (\{.*\})$/.exec(line);

        expect(match).not.toBeNull();

        return {
            line,
            event: (match as RegExpExecArray)[1],
            fields: JSON.parse((match as RegExpExecArray)[2]) as Record<string, unknown>,
        };
    } finally {
        spy.mockRestore();
    }
};

describe('sanitizeLogText', () => {
    describe('the credential forms this service configures', () => {
        it('redacts the userinfo of a connection string and keeps the host', () => {
            // DATABASE_URL is the credential most likely to reach a log: pg and
            // Prisma echo the connection string in their own error messages.
            expect(sanitizeLogText('connect failed postgresql://soh:s3cret@127.0.0.1:5433/soh_dev')).toBe(
                'connect failed postgresql://***@127.0.0.1:5433/soh_dev',
            );
        });

        it('treats the LAST @ in the authority as the userinfo delimiter', () => {
            // An unescaped `@` is legal in a Postgres password. Stopping at the
            // first one would print `ss` — the password's suffix — as part of
            // the host.
            expect(sanitizeLogText('postgresql://soh:pa@ss@db.internal:5433/soh')).toBe(
                'postgresql://***@db.internal:5433/soh',
            );
        });

        it('leaves a credential-free URL byte-identical', () => {
            // A bare host is not a credential, and it is the one field that
            // says which host a request reached.
            const url = 'https://api.nal.usda.gov/fdc/v1/foods/search?query=rice&pageSize=20';

            expect(sanitizeLogText(url)).toBe(url);
        });

        it('redacts an @ that belongs to a path rather than an authority', () => {
            expect(sanitizeLogText('https://example.test/path?to=a@b')).toBe('https://example.test/path?to=a@b');
        });

        it.each([
            ['api_key', 'https://api.nal.usda.gov/fdc/v1/food/1?api_key=abcd1234', 'api_key=***'],
            ['apikey', 'GET /fdc?apikey=abcd1234 failed', 'apikey=***'],
            ['token', 'refused token=eyJhbGciOi', 'token=***'],
            ['password', 'PGPASSWORD env password=hunter2', 'password=***'],
            ['secret', 'client_secret=sh-abc123', 'secret=***'],
        ])('redacts the value of %s while keeping the name', (_name, input, expected) => {
            const sanitized = sanitizeLogText(input);

            expect(sanitized).toContain(expected);
            expect(sanitized).not.toContain('abcd1234');
            expect(sanitized).not.toContain('hunter2');
            expect(sanitized).not.toContain('eyJhbGciOi');
            expect(sanitized).not.toContain('sh-abc123');
        });

        it('redacts a Bearer token in any casing and keeps the keyword', () => {
            // OPENROUTER_API_KEY travels as an Authorization header, and
            // OpenRouter's own error bodies can reflect it back.
            expect(sanitizeLogText('upstream said: authorization: bearer sk-or-v1-9f8e7d')).toBe(
                'upstream said: authorization: Bearer ***',
            );
        });

        it('redacts a credential whose value carries a control character, rather than stopping at it', () => {
            // The ordering rule: redaction runs BEFORE control characters
            // collapse to spaces. Collapsing first would end the match at the
            // control character and print the tail.
            expect(sanitizeLogText('api_key=abc\u0001def rest')).toBe('api_key=*** rest');
        });
    });

    describe('one event, one line', () => {
        it('collapses CR and LF so a value cannot forge a second log line', () => {
            expect(sanitizeLogText('first\r\n[meal-planning] forged_event {}')).toBe(
                'first  [meal-planning] forged_event {}',
            );
        });

        it('collapses tabs, DEL, C1 and the Unicode line separators', () => {
            expect(sanitizeLogText('a\tb\u007fc\u0085d\u2028e\u2029f')).toBe('a b c d e f');
        });
    });

    describe('the bound on a value', () => {
        it('truncates to 200 characters and marks that it did', () => {
            const sanitized = sanitizeLogText('x'.repeat(DEFAULT_MAX_TEXT_LENGTH + 50));

            expect(sanitized).toHaveLength(DEFAULT_MAX_TEXT_LENGTH + TRUNCATION_MARKER.length);
            expect(sanitized.endsWith(TRUNCATION_MARKER)).toBe(true);
        });

        it('leaves a value at the bound unmarked', () => {
            const sanitized = sanitizeLogText('x'.repeat(DEFAULT_MAX_TEXT_LENGTH));

            expect(sanitized).toHaveLength(DEFAULT_MAX_TEXT_LENGTH);
            expect(sanitized).not.toContain(TRUNCATION_MARKER);
        });

        it('honours a caller-supplied bound', () => {
            expect(sanitizeLogText('abcdefghij', 4)).toBe(`abcd${TRUNCATION_MARKER}`);
        });

        it('falls back to the default bound for a nonsensical one', () => {
            // A log call must never be the thing that fails a request, so an
            // unusable bound is replaced rather than rejected.
            expect(sanitizeLogText('x'.repeat(250), Number.NaN)).toHaveLength(
                DEFAULT_MAX_TEXT_LENGTH + TRUNCATION_MARKER.length,
            );
            expect(sanitizeLogText('abc', -5)).toBe('abc');
        });
    });

    it('answers a non-string with an empty string rather than throwing', () => {
        expect(sanitizeLogText(undefined as unknown as string)).toBe('');
        expect(sanitizeLogText({ toString: () => 'api_key=leak' } as unknown as string)).toBe('');
    });
});

describe('describeErrorSafely', () => {
    it('reports the class name and nothing from the message, stack or cause', () => {
        const cause = new Error('inner: postgresql://soh:s3cret@db/soh');
        const error = new Error('outer: SELECT * FROM users WHERE id = $1');

        (error as Error & { cause?: unknown }).cause = cause;

        const described = describeErrorSafely(error);

        expect(described).toEqual({ errorName: 'Error' });

        const serialized = JSON.stringify(described);

        expect(serialized).not.toContain('SELECT');
        expect(serialized).not.toContain('s3cret');
        expect(serialized).not.toContain('safeLogger.test');
        expect(serialized).not.toContain('at ');
    });

    it('keeps a typed error distinguishable by its name', () => {
        class StaleRevisionError extends Error {
            constructor() {
                super('Preferences changed since this request was prepared');
                this.name = 'StaleRevisionError';
            }
        }

        expect(describeErrorSafely(new StaleRevisionError())).toEqual({ errorName: 'StaleRevisionError' });
    });

    it('carries a Prisma-shaped machine code, which is what makes a fault actionable', () => {
        const error = Object.assign(new Error('Unique constraint failed on the fields: (`idempotency_key`)'), {
            code: 'P2002',
            meta: { target: ['user_id', 'idempotency_key'] },
        });

        expect(describeErrorSafely(error)).toEqual({ errorName: 'Error', errorCode: 'P2002' });
        expect(JSON.stringify(describeErrorSafely(error))).not.toContain('idempotency_key');
    });

    it('drops a `code` that is really a message, a path or a statement', () => {
        expect(describeErrorSafely(Object.assign(new Error('x'), { code: 'connect ECONNREFUSED 127.0.0.1:5433' })))
            .toEqual({ errorName: 'Error' });
        expect(describeErrorSafely(Object.assign(new Error('x'), { code: 42 }))).toEqual({ errorName: 'Error' });
    });

    it('names a thrown non-Error without printing it', () => {
        expect(describeErrorSafely('postgresql://soh:s3cret@db/soh')).toEqual({ errorName: 'NonError' });
        expect(describeErrorSafely(undefined)).toEqual({ errorName: 'NonError' });
        expect(describeErrorSafely({ code: 'P1001' })).toEqual({ errorName: 'NonError', errorCode: 'P1001' });
    });

    it('names an Error whose name was blanked', () => {
        const error = new Error('boom');

        error.name = '';

        expect(describeErrorSafely(error)).toEqual({ errorName: 'Error' });
    });
});

describe('logSafeEvent', () => {
    it('emits one prefixed line through the level own console method', () => {
        const { line, event, fields } = captureEvent('warn', () =>
            logSafeEvent('warn', 'request_refused', { action: 'plans.generate', status: 400 }),
        );

        expect(line).toBe('[meal-planning] request_refused {"action":"plans.generate","status":400}');
        expect(event).toBe('request_refused');
        expect(fields).toEqual({ action: 'plans.generate', status: 400 });
    });

    it.each(['info', 'warn', 'error'] as const)('writes a %s event to that level and no other', (level) => {
        const others = (['info', 'warn', 'error'] as const).filter((candidate) => candidate !== level);
        const spies = others.map((candidate) => jest.spyOn(console, candidate).mockImplementation(() => undefined));

        try {
            captureEvent(level, () => logSafeEvent(level, 'keyed_write_answered', { status: 201 }));

            for (const spy of spies) {
                expect(spy).not.toHaveBeenCalled();
            }
        } finally {
            for (const spy of spies) {
                spy.mockRestore();
            }
        }
    });

    it('drops an undefined field instead of emitting it', () => {
        // Correlation ids are optional at the edge: a handler that has not
        // parsed a planId yet passes `undefined` rather than branching.
        const { fields } = captureEvent('info', () =>
            logSafeEvent('info', 'keyed_write_answered', { planId: undefined, mealId: 'meal-1' }),
        );

        expect(fields).toEqual({ mealId: 'meal-1' });
        expect(Object.prototype.hasOwnProperty.call(fields, 'planId')).toBe(false);
    });

    it('sanitizes a field value, so a client-supplied id cannot forge a line or carry a secret', () => {
        const { line, fields } = captureEvent('warn', () =>
            logSafeEvent('warn', 'request_refused', {
                planId: 'not-a-uuid\n[meal-planning] forged_event {"status":200}',
                dsn: 'postgresql://soh:s3cret@db/soh',
            }),
        );

        expect(fields.planId).toBe('not-a-uuid [meal-planning] forged_event {"status":200}');
        expect(fields.dsn).toBe('postgresql://***@db/soh');
        expect(line.split('\n')).toHaveLength(1);
        expect(line).not.toContain('s3cret');
    });

    it('emits a non-finite number as null', () => {
        const { fields } = captureEvent('info', () =>
            logSafeEvent('info', 'keyed_write_answered', {
                planRevision: Number.NaN,
                status: Number.POSITIVE_INFINITY,
                detailCount: 0,
            }),
        );

        expect(fields).toEqual({ planRevision: null, status: null, detailCount: 0 });
    });

    it('replaces a value that is not one of the four primitives with a fixed marker', () => {
        // The guarantee the finding asks for: no Error, Prisma payload, request
        // body or vendor response can be serialized through a field, even when
        // a cast or a future edit puts one there.
        const smuggled = {
            error: new Error('boom: postgresql://soh:s3cret@db/soh'),
            body: { idempotencyKey: 'k', servings: 2 },
            meta: ['user_id', 'idempotency_key'],
            render: () => 'leak',
            big: BigInt(7),
        } as unknown as Record<string, string>;

        const { line, fields } = captureEvent('error', () => logSafeEvent('error', 'request_failed', smuggled));

        expect(fields).toEqual({
            error: '[unloggable]',
            body: '[unloggable]',
            meta: '[unloggable]',
            render: '[unloggable]',
            big: '[unloggable]',
        });
        expect(line).not.toContain('s3cret');
        expect(line).not.toContain('boom');
        expect(line).not.toContain('idempotency_key');
    });

    it('keeps null, which means "known to be absent"', () => {
        const { fields } = captureEvent('warn', () =>
            logSafeEvent('warn', 'request_rejected', { exhaustedBy: null, replayed: false }),
        );

        expect(fields).toEqual({ exhaustedBy: null, replayed: false });
    });

    it.each([
        ['an uppercase name', 'Request_Refused'],
        ['a dotted name', 'request.refused'],
        ['a leading digit', '1request'],
        ['an empty name', ''],
        ['an over-long name', `a${'b'.repeat(64)}`],
        ['a name carrying a newline', 'request_refused\nforged'],
    ])('replaces %s with a marker, so an alert keyed on a literal cannot be broken quietly', (_case, event) => {
        expect(captureEvent('warn', () => logSafeEvent('warn', event, {})).event).toBe('unnamed_event');
    });

    it('bounds a field key as well as its value', () => {
        const { fields } = captureEvent('info', () =>
            logSafeEvent('info', 'keyed_write_answered', { [`k${'e'.repeat(80)}y`]: 1 }),
        );

        const [key] = Object.keys(fields);

        expect(key.length).toBeLessThanOrEqual(65);
        expect(key.endsWith(TRUNCATION_MARKER)).toBe(true);
    });

    it('emits an empty field object rather than failing on a missing one', () => {
        const { fields } = captureEvent('error', () =>
            logSafeEvent('error', 'request_failed', undefined as unknown as Record<string, never>),
        );

        expect(fields).toEqual({});
    });

    it('sends an unrecognised level to console.error rather than indexing console with it', () => {
        const { fields } = captureEvent('error', () =>
            logSafeEvent('trace' as unknown as 'error', 'request_failed', { status: 500 }),
        );

        expect(fields).toEqual({ status: 500 });
    });
});
