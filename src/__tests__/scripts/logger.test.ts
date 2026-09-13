// The redaction contract of scripts/lib/logger.ts.
//
// The module is the single chokepoint every meal-planning CLI script, plus
// checkpoint.ts's persisted run log and dbGuard.ts's refusal path, routes
// caller strings through, so what is asserted here is what reaches an
// operator's terminal, a CI log and the `catalog_import_runs.log` JSONB column.
//
// It lives here rather than beside the module because Jest's `roots` is
// `<rootDir>/src` (jest.config.ts), so a test file under `scripts/` would never
// be collected. The relative import is the consequence of that, not a choice.
import {
    createLogger,
    redactUrlUserinfo,
    safeError,
    sanitizeLogFields,
    scrubSecrets,
    type LogLevel,
} from '../../../scripts/lib/logger';

const REDACTED = '***';

// The DSN shape the whole suite turns on: an unescaped `@` inside the password,
// which is legal in a Postgres URL and common in generated credentials. The
// userinfo ends at the LAST `@` in the authority, so the password is `pa@ss`
// and the host is `localhost` — a rule that stops at the first `@` publishes
// the suffix `ss`.
const DSN_WITH_AT_IN_PASSWORD = 'postgresql://user:pa@ss@localhost:5433/db';
const DSN_REDACTED = 'postgresql://***@localhost:5433/db';

// Every fragment of the credential above. `pa`, `ss` and `pa@ss` must not
// survive anywhere in any output; `user` is the username half of the same
// userinfo and is equally gone.
const PASSWORD_FRAGMENTS: readonly string[] = ['pa@ss', 'pa', 'ss', 'user:', 'user'];

const expectNoCredentialFragment = (rendered: string): void => {
    for (const fragment of PASSWORD_FRAGMENTS) {
        expect(rendered).not.toContain(fragment);
    }
};

describe('redactUrlUserinfo', () => {
    describe('the userinfo boundary', () => {
        it('redacts through the last @ of the authority, not the first', () => {
            expect(redactUrlUserinfo(DSN_WITH_AT_IN_PASSWORD)).toBe(DSN_REDACTED);
        });

        it('keeps the host, port, path, query and fragment', () => {
            expect(redactUrlUserinfo('postgresql://u:p@host:5433/db?sslmode=require#note')).toBe(
                'postgresql://***@host:5433/db?sslmode=require#note',
            );
        });

        it('returns a URL whose authority holds no @ byte-identical', () => {
            const bareHost = 'postgresql://localhost:5433/soh_dev';

            expect(redactUrlUserinfo(bareHost)).toBe(bareHost);
        });

        it('redacts an empty userinfo, because the @ is what declares one', () => {
            expect(redactUrlUserinfo('postgresql://@host/db')).toBe('postgresql://***@host/db');
        });
    });

    describe('what is not a URL', () => {
        it('leaves a `://` with no scheme in front of it alone', () => {
            expect(redactUrlUserinfo('://u:p@host/db')).toBe('://u:p@host/db');
        });

        it('leaves a `://` whose left-hand run has no letter alone', () => {
            expect(redactUrlUserinfo('1.2://u:p@host/db')).toBe('1.2://u:p@host/db');
        });

        it('accepts a scheme of digits, +, - and . after its leading letter', () => {
            expect(redactUrlUserinfo('a+b-c.1://u:p@host/db')).toBe('a+b-c.1://***@host/db');
        });

        // The 41-character bound limits how far left the walk looks, not what it
        // recognises: a run longer than the window is still a scheme as long as
        // a letter falls inside the window, which is what keeps a credential
        // redacted behind an unusually long scheme.
        it('redacts a scheme run longer than the walk-back window', () => {
            expect(redactUrlUserinfo(`${'s'.repeat(42)}://u:p@host/db`)).toBe(`${'s'.repeat(42)}://${REDACTED}@host/db`);
        });

        it('redacts when the scheme letter sits at the far edge of the window', () => {
            const scheme = `a${'1'.repeat(40)}`;

            expect(redactUrlUserinfo(`${scheme}://u:p@host/db`)).toBe(`${scheme}://${REDACTED}@host/db`);
        });

        it('leaves a `://` whose whole walk-back window holds no letter alone', () => {
            const notAScheme = `a${'1'.repeat(41)}`;

            expect(redactUrlUserinfo(`${notAScheme}://u:p@host/db`)).toBe(`${notAScheme}://u:p@host/db`);
        });

        it('leaves an @ that belongs to a path alone', () => {
            expect(redactUrlUserinfo('a://host://u:p@h')).toBe('a://host://u:p@h');
        });
    });

    describe('the non-string guard', () => {
        it('yields an empty string for a non-string, like scrubSecrets', () => {
            expect(redactUrlUserinfo(undefined as unknown as string)).toBe('');
            expect(redactUrlUserinfo(null as unknown as string)).toBe('');
            expect(redactUrlUserinfo(42 as unknown as string)).toBe('');
        });
    });
});

describe('scrubSecrets — URL userinfo', () => {
    it('redacts through the last @ so no fragment of the password survives', () => {
        const scrubbed = scrubSecrets(DSN_WITH_AT_IN_PASSWORD);

        expect(scrubbed).toBe(DSN_REDACTED);
        expectNoCredentialFragment(scrubbed);
    });

    it('redacts a percent-encoded @ inside the password', () => {
        expect(scrubSecrets('postgresql://user:pa%40ss@host/db')).toBe('postgresql://***@host/db');
    });

    it('redacts a 600-character password rather than failing to match it', () => {
        const password = 'P'.repeat(600);

        const scrubbed = scrubSecrets(`postgresql://u:${password}@h/db`);

        expect(scrubbed).toBe('postgresql://***@h/db');
        expect(scrubbed).not.toContain('P');
    });

    it('redacts the userinfo of a bracketed IPv6 authority', () => {
        expect(scrubSecrets('postgresql://u:p@[::1]:5432/db')).toBe('postgresql://***@[::1]:5432/db');
    });

    it('leaves a bracketed IPv6 authority with no userinfo alone', () => {
        expect(scrubSecrets('postgresql://[::1]:5432/db')).toBe('postgresql://[::1]:5432/db');
    });

    it('handles an uppercase scheme', () => {
        expect(scrubSecrets('POSTGRESQL://U:P@H/db')).toBe('POSTGRESQL://***@H/db');
    });

    it('handles a mixed-case scheme', () => {
        expect(scrubSecrets('PostgreSQL://U:P@H/db')).toBe('PostgreSQL://***@H/db');
    });

    it('leaves a scheme separator at the end of the string alone', () => {
        expect(scrubSecrets('postgresql://')).toBe('postgresql://');
    });

    it('redacts every URL in a string, not just the first', () => {
        expect(scrubSecrets('a://u:p@h b://x:y@z c://q:r@s')).toBe(`a://${REDACTED}@h b://${REDACTED}@z c://${REDACTED}@s`);
    });

    it('ends an authority at a tab, a carriage return or a newline', () => {
        expect(scrubSecrets('postgresql://u:p@h\tpostgresql://u2:p2@h2\rpostgresql://u3:p3@h3\nrest')).toBe(
            'postgresql://***@h\tpostgresql://***@h2\rpostgresql://***@h3\nrest',
        );
    });

    it('ends an authority at a non-breaking space, so the next URL is still found', () => {
        expect(scrubSecrets('postgresql://u:p@h\u00a0postgresql://u2:pw2@h2')).toBe(
            'postgresql://***@h\u00a0postgresql://***@h2',
        );
    });

    it('redacts a URL embedded in surrounding prose', () => {
        const scrubbed = scrubSecrets(`connect failed: ${DSN_WITH_AT_IN_PASSWORD} - retrying`);

        expect(scrubbed).toBe(`connect failed: ${DSN_REDACTED} - retrying`);
        expectNoCredentialFragment(scrubbed);
    });

    it('leaves an @ in a query string alone — it is not userinfo', () => {
        expect(scrubSecrets('https://example.com/path?a=b@c')).toBe('https://example.com/path?a=b@c');
    });

    it('leaves a bare email address with no scheme alone', () => {
        expect(scrubSecrets('reported by ops@example.com')).toBe('reported by ops@example.com');
    });

    it('leaves a bare host alone, so a log still says which database a run used', () => {
        expect(scrubSecrets('postgresql://127.0.0.1:5433/soh_dev')).toBe('postgresql://127.0.0.1:5433/soh_dev');
    });
});

describe('scrubSecrets — idempotence', () => {
    // `scrubSecrets` legitimately runs on already-scrubbed strings: a caller
    // passes a message through it and the logger scrubs the fields again on the
    // way to the line. Every rule's output must therefore be a fixed point of
    // that rule, and an already-redacted DSN in particular must come back
    // unchanged rather than accumulating markers.
    const cases: readonly string[] = [
        DSN_WITH_AT_IN_PASSWORD,
        DSN_REDACTED,
        'postgresql://user:pa%40ss@host/db',
        'postgresql://u:p@[::1]:5432/db',
        'postgresql://[::1]:5432/db',
        'postgresql://@host/db',
        'POSTGRESQL://U:P@H/db',
        'postgresql://',
        'a://u:p@h b://x:y@z',
        'https://example.com/path?a=b@c',
        'reported by ops@example.com',
        'DATABASE_URL=postgresql://user:pa@ss@localhost/db',
        'Authorization: Bearer sk-test-123',
        'USDA_API_KEY=abc123 retry',
    ];

    it.each(cases)('is a fixed point of itself for %j', (value) => {
        const once = scrubSecrets(value);

        expect(scrubSecrets(once)).toBe(once);
    });

    it('leaves an already-redacted authority untouched', () => {
        expect(scrubSecrets(DSN_REDACTED)).toBe(DSN_REDACTED);
    });
});

describe('scrubSecrets — linear time on adversarial input', () => {
    // The rule this file replaced was a regex, and a regex form of it either
    // rescans from every offset (measured in the module's own comments at
    // 19,758 ms for an unbounded scheme body on this length) or pays ~60 ms for
    // one global pass. The scan measures single-digit milliseconds on all three
    // inputs below. The assertion is deliberately two orders of magnitude
    // looser than the measurement so a loaded CI runner cannot make it flap
    // while a return to a rescanning form — seconds, not milliseconds — still
    // fails it.
    const BUDGET_MS = 2_000;
    const LENGTH = 200_000;

    const measure = (input: string): number => {
        const startedAt = process.hrtime.bigint();
        scrubSecrets(input);
        return Number(process.hrtime.bigint() - startedAt) / 1e6;
    };

    it('scrubs 200,000 characters of repeated scheme separators within budget', () => {
        expect(measure('a://'.repeat(LENGTH / 4))).toBeLessThan(BUDGET_MS);
    });

    it('scrubs one scheme followed by a 200,000-character delimiter-free run within budget', () => {
        expect(measure(`a://${'x'.repeat(LENGTH)}`)).toBeLessThan(BUDGET_MS);
    });

    it('scrubs 200,000 characters of scheme-legal runs within budget', () => {
        expect(measure('A-KEY-'.repeat(LENGTH / 6))).toBeLessThan(BUDGET_MS);
    });

    it('still finds a DSN at the end of a 200,000-character line', () => {
        // The filler is spaced so the last rule (any run of 40 or more opaque
        // characters) does not claim it and hide what this case is about.
        const filler = 'x '.repeat(LENGTH / 2);

        const scrubbed = scrubSecrets(`${filler}${DSN_WITH_AT_IN_PASSWORD}`);

        expect(scrubbed).toBe(`${filler}${DSN_REDACTED}`);
    });
});

describe('the credential never reaches a log line or a persisted entry', () => {
    it('scrubs a DSN held in a log field value', () => {
        const sanitized = sanitizeLogFields({ dsn: DSN_WITH_AT_IN_PASSWORD });

        expect(sanitized).toEqual({ dsn: DSN_REDACTED });
        expectNoCredentialFragment(JSON.stringify(sanitized));
    });

    it('scrubs a DSN nested inside a log field structure', () => {
        const sanitized = sanitizeLogFields({ target: { origin: { url: DSN_WITH_AT_IN_PASSWORD } } });

        expect(sanitized).toEqual({ target: { origin: { url: DSN_REDACTED } } });
        expectNoCredentialFragment(JSON.stringify(sanitized));
    });

    it('scrubs a DSN quoted by an error message', () => {
        const rendered = safeError(new Error(`connect failed for ${DSN_WITH_AT_IN_PASSWORD}`));

        expect(rendered).toEqual({ name: 'Error', message: `connect failed for ${DSN_REDACTED}` });
        // The rendered VALUES, not a serialization of them: the field name
        // `message` itself contains the two-character fragment `ss`.
        expectNoCredentialFragment(`${rendered.name} ${rendered.message}`);
    });

    it('scrubs a DSN on its way to a serialized log line', () => {
        const lines: Array<{ line: string; level: LogLevel }> = [];
        const logger = createLogger('catalog-import', {
            write: (line, level): void => {
                lines.push({ line, level });
            },
            now: (): Date => new Date(0),
        });

        logger.error('database_unreachable', { dsn: DSN_WITH_AT_IN_PASSWORD });

        expect(lines).toHaveLength(1);
        expect(JSON.parse(lines[0].line)).toEqual({
            ts: '1970-01-01T00:00:00.000Z',
            level: 'error',
            scope: 'catalog-import',
            event: 'database_unreachable',
            dsn: DSN_REDACTED,
        });
        expectNoCredentialFragment(lines[0].line);
    });
});

describe('scrubSecrets — the rules beside the URL rule', () => {
    // The URL rule is one of five applied in order, and the order is part of
    // the contract. These four exist so a change to that list cannot silently
    // stop redacting a key, a token or a private key.
    it('collapses a PEM block, body and markers together', () => {
        const pem = `-----BEGIN PRIVATE KEY-----\n${'A'.repeat(64)}\n-----END PRIVATE KEY-----`;

        expect(scrubSecrets(pem)).toBe(REDACTED);
    });

    it('collapses the PEM block before the long-base64 rule can claim its body', () => {
        // If the base64 rule ran first the markers would survive around a
        // redacted body, which names the file and the key type in the log.
        const scrubbed = scrubSecrets(`key: -----BEGIN RSA PRIVATE KEY-----\n${'B'.repeat(80)}\n-----END RSA PRIVATE KEY-----`);

        expect(scrubbed).toBe(`key: ${REDACTED}`);
        expect(scrubbed).not.toContain('BEGIN');
    });

    it('redacts a Bearer token and keeps the scheme word', () => {
        expect(scrubSecrets('Authorization: Bearer sk-test-123')).toBe(`Authorization: Bearer ${REDACTED}`);
    });

    it('redacts a credential-bearing KEY=value and keeps the name', () => {
        expect(scrubSecrets('USDA_API_KEY=abc123 retry')).toBe(`USDA_API_KEY=${REDACTED} retry`);
        expect(scrubSecrets('OPENROUTER_API_KEY=sk-or-v1-xyz')).toBe(`OPENROUTER_API_KEY=${REDACTED}`);
    });

    it('leaves a harmless NAME=value alone', () => {
        expect(scrubSecrets('pageSize=20 and monkey=1')).toBe('pageSize=20 and monkey=1');
    });

    it('redacts a long opaque run and keeps a short checksum prefix', () => {
        expect(scrubSecrets(`digest ${'a'.repeat(44)}`)).toBe(`digest ${REDACTED}`);
        expect(scrubSecrets('digest 0123456789ab')).toBe('digest 0123456789ab');
    });

    it('redacts a DSN whose variable name no KEY=value alternative matches', () => {
        // `DATABASE_URL` is not in the KEY=value vocabulary — `url` is not a
        // credential name — so the URL rule is the only thing standing between
        // this string and the log.
        const scrubbed = scrubSecrets(`DATABASE_URL=${DSN_WITH_AT_IN_PASSWORD}`);

        expect(scrubbed).toBe(`DATABASE_URL=${DSN_REDACTED}`);
        expectNoCredentialFragment(scrubbed);
    });

    it('still redacts a DSN stored under a credential-bearing name', () => {
        expect(scrubSecrets('password=postgresql://u:p@h/db')).toBe(`password=${REDACTED}`);
    });
});
