import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
    createFileUsdaRateLedger,
    createUsdaRateLimiter,
    getUsdaPacedHost,
    RATE_WINDOW_MS,
    RateLimitConfigError,
    USDA_HOST,
    USDA_RATE_LEDGER_STATE_VERSION,
    UsdaRateLedgerError,
    type UsdaRateLedger,
    type UsdaRateReservation,
} from '../../../scripts/lib/rateLimiter';

// What this suite is for.
//
// `scripts/lib/rateLimiter.ts` holds the catalog importer to 900 USDA requests
// per hour so the 100/hour the running API needs on the SAME key survives (AAP
// §0.7.1 Group 1). Two things have to be true for that ceiling to be real, and
// both of them are properties of this module's edges rather than of its
// arithmetic — which is what the arithmetic's own tests already cover.
//
// FIRST, THE DURABLE LEDGER HAS TO BE STATE NOBODY ELSE CHOSE. It lives in one
// host-scoped directory directly beneath `os.tmpdir()`, which is world
// writable, so every path it touches is a name another local principal may have
// created first. A directory somebody else owns or can write, a symbolic link
// standing where the state file or the lock belongs, or a link planted at the
// name the next atomic write will use are all ways to make the ledger say the
// hour is empty — and a ledger that says the hour is empty hands the run the
// vendor's full allowance and pushes a shared key past USDA's 1,000/hour while
// the live feature is using it. Every case below therefore asserts a REFUSAL
// (`UsdaRateLedgerError`, the import stopped) rather than a repair, and where
// something could have been clobbered it asserts that it was not.
//
// SECOND, THE LIMITER HAS TO PACE THE HOST THE TRAFFIC ACTUALLY REACHES.
// `usda.service.ts` sends every request to `USDA_BASE_URL` when it is set, so a
// limiter that paced the compiled-in constant instead would match nothing under
// an override: the requests would go out neither paced nor charged to the
// hourly ledger while the run still reported a ceiling. `getUsdaPacedHost` is
// the rule that decides that host, and the installed-limiter tests at the end
// prove the decision reaches the transport and the ledger.
//
// No network, no database and no real waiting: the clock, `sleep` and the
// transport are injected or stubbed, so an hour of pacing costs microseconds.
// Every ledger here is given a state path inside a per-test temporary directory
// that is removed afterwards, so nothing in this file touches the host-scoped
// default directory that real importers share.

// An arbitrary but fixed instant, so every expectation is a plain number rather
// than something derived from the machine's clock.
const T0 = 1_700_000_000_000;

const TEST_SCOPE = 'rate-ledger.test.invalid';

// A host that cannot resolve (RFC 6761 reserves `.invalid`), so a request that
// somehow escaped the stubbed transport would fail rather than reach anyone.
const OVERRIDE_HOST = 'usda-mirror.invalid';
const OVERRIDE_BASE_URL = `https://${OVERRIDE_HOST}/fdc/v1`;

// What a hostile file holds, so an assertion that it was left alone is an
// assertion about its exact bytes.
const VICTIM_CONTENT = 'the file the planted link pointed at';

interface Clock {
    read: () => number;
    sleep: (ms: number) => Promise<void>;
    sleeps: number[];
}

// A clock the tests own. `sleep` advances it, which makes an hour of pacing
// instant while keeping the module's own loop honest: it still computes the
// wait, and the wait it computes is what moves time.
const createClock = (startMs: number = T0): Clock => {
    let nowMs = startMs;
    const sleeps: number[] = [];

    return {
        read: (): number => nowMs,
        sleep: async (ms: number): Promise<void> => {
            sleeps.push(ms);
            nowMs += ms;
        },
        sleeps,
    };
};

const instantSleep = async (): Promise<void> => undefined;

const reserveOnce = (ledger: UsdaRateLedger, nowMs: number, limit: number): Promise<UsdaRateReservation> =>
    ledger.reserve({ nowMs, limit, windowMs: RATE_WINDOW_MS });

const readStateDocument = (stateFilePath: string): { version: unknown; scope: unknown; attempts: unknown } =>
    JSON.parse(fs.readFileSync(stateFilePath, 'utf8')) as { version: unknown; scope: unknown; attempts: unknown };

const readStamps = (stateFilePath: string): number[] => {
    const document = readStateDocument(stateFilePath);

    expect(document.version).toBe(USDA_RATE_LEDGER_STATE_VERSION);
    expect(Array.isArray(document.attempts)).toBe(true);

    return document.attempts as number[];
};

/** The reservation's failure, with the assertions every refusal in this file shares. */
const expectLedgerRefusal = async (
    ledger: UsdaRateLedger,
    nowMs: number,
    limit: number,
): Promise<UsdaRateLedgerError> => {
    const thrown = await reserveOnce(ledger, nowMs, limit).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(UsdaRateLedgerError);

    const failure = thrown as UsdaRateLedgerError;

    // The vocabulary an operator acts on: the name, the scope and the sentence
    // about what deleting the file costs are part of every refusal.
    expect(failure.name).toBe('UsdaRateLedgerError');
    expect(failure.scope).toBe(TEST_SCOPE);
    expect(failure.message).toContain(`scope ${TEST_SCOPE}`);

    return failure;
};

/**
 * Pins `crypto.randomBytes` to one repeated byte so the temp file's otherwise
 * unguessable name is knowable inside a test — which is the only way to plant
 * anything at it. Only the ledger's own request size is answered; anything else
 * in the process still gets real random bytes.
 */
const pinRandomBytes = (filler: number): jest.SpyInstance =>
    jest.spyOn(crypto, 'randomBytes').mockImplementation(((size: number) =>
        Buffer.alloc(size, filler)) as unknown as typeof crypto.randomBytes);

/** The temp paths the ledger wrote through, in order, from a `writeFileSync` spy. */
const tempPathsFrom = (spy: jest.SpyInstance): string[] =>
    spy.mock.calls
        .map((call) => call[0])
        .filter((target): target is string => typeof target === 'string' && target.endsWith('.tmp'));

describe('the USDA rate ledger on a hostile filesystem', () => {
    let workspace: string;

    beforeEach(() => {
        workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'soh-rate-ledger-'));
    });

    afterEach(() => {
        jest.restoreAllMocks();
        fs.rmSync(workspace, { recursive: true, force: true });
    });

    const statePathFor = (directory: string = workspace, name: string = 'ledger.json'): string =>
        path.join(directory, name);

    const fileLedgerOver = (stateFilePath: string): UsdaRateLedger =>
        createFileUsdaRateLedger({
            stateFilePath,
            scope: TEST_SCOPE,
            sleep: instantSleep,
            lockRetryDelayMs: 0,
            lockAttempts: 2,
        });

    // -----------------------------------------------------------------------
    // The directory the hour's record lives in.
    // -----------------------------------------------------------------------

    describe('the ledger directory', () => {
        it('accepts a pre-existing owner-only directory', async () => {
            const directory = path.join(workspace, 'owner-only');
            fs.mkdirSync(directory, { mode: 0o700 });

            const stateFilePath = statePathFor(directory);

            expect((await reserveOnce(fileLedgerOver(stateFilePath), T0, 5)).admitted).toBe(true);
            expect(readStamps(stateFilePath)).toEqual([T0]);
        });

        it('accepts an owner-only directory that also carries the set-group-ID bit', async () => {
            // Not a curiosity: `/tmp` is set-group-ID on many distributions and
            // Linux gives every directory created beneath such a root the same
            // bit, so the ledger directory this module itself creates with mode
            // 0700 legitimately reads back as 02700. With no group or other
            // permission granted the bit confers no access, which is why the
            // check masks the permission bits rather than comparing modes.
            const directory = path.join(workspace, 'setgid');
            fs.mkdirSync(directory, { mode: 0o700 });
            fs.chmodSync(directory, 0o2700);

            const stateFilePath = statePathFor(directory);

            expect((await reserveOnce(fileLedgerOver(stateFilePath), T0, 5)).admitted).toBe(true);
            expect((fs.lstatSync(directory).mode & 0o7777).toString(8)).toBe('2700');
        });

        it('refuses a directory that grants group or other access', async () => {
            const directory = path.join(workspace, 'group-readable');
            fs.mkdirSync(directory, { mode: 0o700 });
            // The mode a second principal needs to see, or rewrite, the record
            // of what the shared key spent this hour.
            fs.chmodSync(directory, 0o750);

            const stateFilePath = statePathFor(directory);
            const failure = await expectLedgerRefusal(fileLedgerOver(stateFilePath), T0, 5);

            expect(failure.code).toBe('state_directory_unusable');
            expect(failure.message).toContain('group or other access');
            expect(failure.stateFilePath).toBe(stateFilePath);
            // Nothing was written into a directory the ledger would not trust.
            expect(fs.readdirSync(directory)).toEqual([]);
        });

        it('refuses a world-writable directory', async () => {
            const directory = path.join(workspace, 'world-writable');
            fs.mkdirSync(directory, { mode: 0o700 });
            fs.chmodSync(directory, 0o777);

            const failure = await expectLedgerRefusal(fileLedgerOver(statePathFor(directory)), T0, 5);

            expect(failure.code).toBe('state_directory_unusable');
            expect(fs.readdirSync(directory)).toEqual([]);
        });

        it('refuses a symbolic link standing where the ledger directory belongs, rather than following it', async () => {
            // `mkdirSync({recursive: true})` is satisfied by a link to a
            // directory, so creating the directory is exactly what does NOT
            // establish that the ledger owns it.
            const real = path.join(workspace, 'attacker-owned');
            fs.mkdirSync(real, { mode: 0o700 });
            const link = path.join(workspace, 'ledger-dir');
            fs.symlinkSync(real, link, 'dir');

            const failure = await expectLedgerRefusal(fileLedgerOver(statePathFor(link)), T0, 5);

            expect(failure.code).toBe('state_directory_unusable');
            expect(failure.message).toContain('symbolic link');
            // The link was not followed: nothing reached the directory it
            // addressed, and the link itself is left for the operator to see.
            expect(fs.readdirSync(real)).toEqual([]);
            expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
        });

        it('refuses a directory owned by another OS user', async () => {
            // Simulated through `lstat` rather than by `chown`, which needs
            // privileges the test runner may not have: what is under test is
            // the comparison against this process's uid, and a reported owner
            // is exactly what that comparison reads.
            const directory = path.join(workspace, 'other-user');
            fs.mkdirSync(directory, { mode: 0o700 });

            const processUid = process.getuid === undefined ? 0 : process.getuid();
            const actualLstatSync = fs.lstatSync;
            jest.spyOn(fs, 'lstatSync').mockImplementation(((
                target: Parameters<typeof fs.lstatSync>[0],
                options?: Parameters<typeof fs.lstatSync>[1],
            ) => {
                const observed = actualLstatSync(target, options) as fs.Stats;

                if (target === directory) {
                    return { ...observed, uid: processUid + 1, isDirectory: () => true, isSymbolicLink: () => false };
                }

                return observed;
            }) as typeof fs.lstatSync);

            const failure = await expectLedgerRefusal(fileLedgerOver(statePathFor(directory)), T0, 5);

            expect(failure.code).toBe('state_directory_unusable');
            expect(failure.message).toContain(`owned by uid ${processUid + 1}`);
            expect(failure.message).toContain(`runs as uid ${processUid}`);
        });
    });

    // -----------------------------------------------------------------------
    // The atomic write, and the name it goes through.
    // -----------------------------------------------------------------------

    describe('the state file\u2019s temp file', () => {
        it('names it from crypto.randomBytes rather than from anything derivable', async () => {
            const stateFilePath = statePathFor();
            const randomBytes = pinRandomBytes(0xab);
            const writeFile = jest.spyOn(fs, 'writeFileSync');

            expect((await reserveOnce(fileLedgerOver(stateFilePath), T0, 5)).admitted).toBe(true);

            const [tempFilePath] = tempPathsFrom(writeFile);
            expect(tempFilePath).toBeDefined();
            expect(randomBytes).toHaveBeenCalled();

            const randomSegment = path
                .basename(String(tempFilePath))
                .replace(`${path.basename(stateFilePath)}.`, '')
                .replace('.tmp', '');

            // Every byte came from the pinned source, and there are at least 96
            // bits of them — nothing a process list or a counter could supply.
            expect(randomSegment).toMatch(/^(ab)+$/);
            expect(randomSegment.length).toBeGreaterThanOrEqual(24);
            // And nothing derivable is in the name: the previous scheme was
            // `<state file>.<pid>.<sequence>.tmp`.
            expect(randomSegment).not.toContain(`${process.pid}`);
        });

        it('uses a different name for every write', async () => {
            const stateFilePath = statePathFor();
            const ledger = fileLedgerOver(stateFilePath);
            const writeFile = jest.spyOn(fs, 'writeFileSync');

            expect((await reserveOnce(ledger, T0, 5)).admitted).toBe(true);
            expect((await reserveOnce(ledger, T0 + 1, 5)).admitted).toBe(true);

            const [first, second] = tempPathsFrom(writeFile);

            expect(first).toBeDefined();
            expect(second).toBeDefined();
            expect(first).not.toBe(second);
        });

        it('refuses a symbolic link planted at the temp name instead of truncating its target', async () => {
            const stateFilePath = statePathFor();
            const ledger = fileLedgerOver(stateFilePath);
            pinRandomBytes(0xcd);
            const writeFile = jest.spyOn(fs, 'writeFileSync');

            // One ordinary reservation, only to learn the name the pinned
            // random source produces — which is what an attacker would have to
            // predict and is why the real name is random.
            expect((await reserveOnce(ledger, T0, 5)).admitted).toBe(true);
            const [tempFilePath] = tempPathsFrom(writeFile);
            expect(tempFilePath).toBeDefined();

            const victim = path.join(workspace, 'victim');
            fs.writeFileSync(victim, VICTIM_CONTENT, 'utf8');
            fs.rmSync(stateFilePath);
            fs.symlinkSync(victim, String(tempFilePath));

            const failure = await expectLedgerRefusal(ledger, T0 + 1, 5);

            // The write refused the existing name (`O_CREAT | O_EXCL`) instead
            // of following the link, so the attacker's target still holds its
            // own bytes and nothing was recorded as admitted.
            expect(failure.code).toBe('state_write_failed');
            expect(fs.readFileSync(victim, 'utf8')).toBe(VICTIM_CONTENT);
            expect(fs.existsSync(stateFilePath)).toBe(false);
            // And the reservation still gave its lock back, so the next run is
            // not wedged behind a refusal.
            expect(fs.existsSync(`${stateFilePath}.lock`)).toBe(false);
        });
    });

    // -----------------------------------------------------------------------
    // The reads that decide the hour.
    // -----------------------------------------------------------------------

    describe('the reads that decide the hour', () => {
        it('refuses a symbolic link standing at the state file rather than reading through it', async () => {
            const stateFilePath = statePathFor();
            const elsewhere = path.join(workspace, 'elsewhere.json');
            // An empty hour, which is what an attacker wants the ledger to
            // believe: it is the difference between a paced run and one that
            // spends the vendor's whole allowance.
            fs.writeFileSync(
                elsewhere,
                `${JSON.stringify({ version: USDA_RATE_LEDGER_STATE_VERSION, scope: TEST_SCOPE, attempts: [] })}\n`,
                'utf8',
            );
            fs.symlinkSync(elsewhere, stateFilePath);

            const failure = await expectLedgerRefusal(fileLedgerOver(stateFilePath), T0, 5);

            expect(failure.code).toBe('state_unreadable');
            expect(failure.message).toContain('symbolic link');
            // Neither read nor written through: the link's target is untouched
            // and still holds the document it held.
            expect(readStamps(elsewhere)).toEqual([]);
            expect(fs.lstatSync(stateFilePath).isSymbolicLink()).toBe(true);
        });

        it('refuses anything at the state file\u2019s name that is not a regular file', async () => {
            const stateFilePath = statePathFor();
            fs.mkdirSync(stateFilePath);

            const failure = await expectLedgerRefusal(fileLedgerOver(stateFilePath), T0, 5);

            expect(failure.code).toBe('state_unreadable');
            expect(failure.message).toContain('not a regular file');
        });

        it('refuses a symbolic link standing at the lock file rather than treating it as a lock', async () => {
            const stateFilePath = statePathFor();
            const lockFilePath = `${stateFilePath}.lock`;
            const elsewhere = path.join(workspace, 'not-a-lock');
            fs.writeFileSync(elsewhere, 'somebody else\u2019s file\n', 'utf8');
            fs.symlinkSync(elsewhere, lockFilePath);

            const failure = await expectLedgerRefusal(fileLedgerOver(stateFilePath), T0, 5);

            // The exclusive create refuses the name, and the lock is then
            // refused as an object this ledger cannot reason about — rather
            // than its token being read out of, or its staleness measured on, a
            // file somebody else chose.
            expect(failure.code).toBe('lock_unavailable');
            expect(failure.message).toContain('symbolic link');
            expect(fs.readFileSync(elsewhere, 'utf8')).toBe('somebody else\u2019s file\n');
            expect(fs.existsSync(stateFilePath)).toBe(false);
        });
    });

    // -----------------------------------------------------------------------
    // The hardening changed how the document is written. It did not change
    // what is written, and this is what says so.
    // -----------------------------------------------------------------------

    describe('the document the hardened write leaves behind', () => {
        it('records an admitted attempt, renames it into place and reads back byte-identically', async () => {
            const stateFilePath = statePathFor();
            const ledger = fileLedgerOver(stateFilePath);
            const rename = jest.spyOn(fs, 'renameSync');

            // `reserve` reports an admission only after reading the document
            // back and finding the exact bytes it wrote (`requireRecorded`), so
            // an admitted reservation IS the round trip having succeeded.
            const first = await reserveOnce(ledger, T0, 5);

            expect(first).toEqual({ admitted: true, waitMs: 0, attemptsInWindow: 1 });
            expect(rename.mock.calls).toHaveLength(1);
            expect(rename.mock.calls[0]?.[1]).toBe(stateFilePath);

            expect(readStateDocument(stateFilePath)).toEqual({
                version: USDA_RATE_LEDGER_STATE_VERSION,
                scope: TEST_SCOPE,
                attempts: [T0],
            });
            // Owner-only, and a regular file — not the link or the descriptor
            // the hardening refuses.
            expect((fs.lstatSync(stateFilePath).mode & 0o777).toString(8)).toBe('600');
            expect(fs.lstatSync(stateFilePath).isFile()).toBe(true);

            // The second reservation sees the first one's stamp, which is the
            // property the durable ledger exists for, and no temp file survives
            // either write.
            expect((await reserveOnce(ledger, T0 + 5, 5)).attemptsInWindow).toBe(2);
            expect(readStamps(stateFilePath)).toEqual([T0, T0 + 5]);
            expect(fs.readdirSync(workspace)).toEqual([path.basename(stateFilePath)]);
        });

        it('still holds the hourly ceiling across a fresh ledger over the same file', async () => {
            const stateFilePath = statePathFor();
            const limit = 2;

            expect((await reserveOnce(fileLedgerOver(stateFilePath), T0, limit)).admitted).toBe(true);
            expect((await reserveOnce(fileLedgerOver(stateFilePath), T0 + 1, limit)).admitted).toBe(true);

            // What a restarted importer meets: a new instance, the same file,
            // and an hour that is already spent.
            const refused = await reserveOnce(fileLedgerOver(stateFilePath), T0 + 2, limit);

            expect(refused.admitted).toBe(false);
            expect(refused.attemptsInWindow).toBe(limit);
            expect(refused.waitMs).toBe(RATE_WINDOW_MS - 2);
        });
    });
});

describe('getUsdaPacedHost', () => {
    // ONE AGREEMENT, TWO SIDES. `usda.service.ts` builds every request as
    // `process.env.USDA_BASE_URL || DEFAULT_BASE_URL` concatenated with the
    // path and hands the result to `fetch` unresolved
    // (src/services/usda.service.ts:162). So that line decides both halves of
    // this function's contract — which values are SET, and which of those can
    // actually produce a request — and the request builder is the
    // authoritative side. A value the two modules read differently is either a
    // host paced while nothing is sent to it, or an import refused over a
    // value the request path would have used perfectly well; the cases below
    // pin each half to the line that owns it.

    /**
     * The refusal of `raw`, with the assertions every rejection here shares.
     * The echoed-value check is per-case rather than shared: the messages are
     * prose that legitimately contains the remedy's shape
     * (`https://<host>/fdc/v1`), so a value that is only whitespace or only a
     * scheme prefix cannot be substring-checked without asserting against the
     * remedy instead of against an echo.
     */
    const expectBaseUrlRefusal = (raw: string): RateLimitConfigError => {
        const thrown = ((): unknown => {
            try {
                return getUsdaPacedHost({ USDA_BASE_URL: raw });
            } catch (error) {
                return error;
            }
        })();

        expect(thrown).toBeInstanceOf(RateLimitConfigError);

        const failure = thrown as RateLimitConfigError;

        // Refused rather than ignored, and the operator is told which variable
        // to fix: falling back to the constant host would leave the traffic
        // unpaced and the run reporting a ceiling it was never held to.
        expect(failure.message).toContain('USDA_BASE_URL');

        return failure;
    };

    it('is the documented USDA host when USDA_BASE_URL is unset', () => {
        expect(getUsdaPacedHost({})).toBe(USDA_HOST);
    });

    it('is the documented USDA host when USDA_BASE_URL is present and empty', () => {
        // The empty string is the one present value the request path reads as
        // unset — `||` tests truthiness — so it must read as unset here too: a
        // stray `USDA_BASE_URL=` line must not stop an import the request path
        // would have run against the documented default.
        expect(getUsdaPacedHost({ USDA_BASE_URL: '' })).toBe(USDA_HOST);
    });

    it('reduces a full base URL to its host', () => {
        expect(getUsdaPacedHost({ USDA_BASE_URL: OVERRIDE_BASE_URL })).toBe(OVERRIDE_HOST);
        expect(getUsdaPacedHost({ USDA_BASE_URL: `http://${OVERRIDE_HOST}:3010/fdc/v1` })).toBe(OVERRIDE_HOST);
    });

    it('accepts padding around an absolute base URL, which the request path also tolerates', () => {
        // The WHATWG parser strips leading and trailing spaces from a `fetch`
        // argument, so a padded value still sends its requests to this host.
        // Reading it any other way would refuse a run that works.
        expect(getUsdaPacedHost({ USDA_BASE_URL: `  ${OVERRIDE_BASE_URL}  ` })).toBe(OVERRIDE_HOST);
    });

    it('canonicalises a fully qualified name and an upper-case one to the form host matching uses', () => {
        // The DNS root's trailing dot and letter case both name the same host;
        // an outgoing request URL is compared in this canonical form, so a
        // configured host that kept either would match nothing and leave every
        // request unpaced.
        expect(getUsdaPacedHost({ USDA_BASE_URL: `https://${OVERRIDE_HOST}./fdc/v1` })).toBe(OVERRIDE_HOST);
        expect(getUsdaPacedHost({ USDA_BASE_URL: 'HTTPS://USDA-Mirror.INVALID/fdc/v1' })).toBe(OVERRIDE_HOST);
    });

    it('refuses a present-but-whitespace-only value instead of reading it as unset', () => {
        // The divergence this case exists for: `||` sees a non-empty string,
        // so the request path treats a run of spaces as the base URL and
        // builds `"   /foods/search?..."`, which `fetch` cannot parse. Reading
        // it as unset here would report a ceiling on the documented host for a
        // run that never reaches any host at all.
        for (const raw of [' ', '   ', '\t', '\n  ']) {
            expect(expectBaseUrlRefusal(raw).message).toContain('whitespace');
        }
    });

    it('refuses a bare hostname, which the request path cannot concatenate into a URL', () => {
        // Accepted before this agreement was pinned, and the reason the two
        // modules could be pointed at different hosts: a hostname reduces to a
        // host a resolver is happy with, while `usda.service.ts` concatenates
        // it into `api.example.com/foods/search?...` — a relative URL `fetch`
        // rejects, so not one request is made.
        for (const raw of [OVERRIDE_HOST, `${OVERRIDE_HOST}.`, `${OVERRIDE_HOST}/fdc/v1`, 'api.example.com']) {
            const failure = expectBaseUrlRefusal(raw);

            expect(failure.message).toContain('absolute');
            expect(failure.message).not.toContain(raw);
        }
    });

    it('refuses anything else that is not an absolute URL', () => {
        // A protocol-relative authority, a path, an authority-less scheme and
        // prose all share the bare hostname's defect: there is no base URL for
        // `fetch` to resolve them against.
        for (const raw of ['not a url at all', '//usda-mirror.invalid/fdc/v1', '/fdc/v1', 'https://', 'http://:3010', '://usda']) {
            expect(expectBaseUrlRefusal(raw).message).toContain('absolute');
        }
    });

    it('refuses a scheme other than http or https', () => {
        // Each of these parses — some even carry an authority — but
        // `usda.service.ts` speaks HTTP to a REST API, so no vendor request
        // comes out of such a base and there is no vendor allowance to pace.
        for (const raw of ['file:///tmp/usda', `ftp://${OVERRIDE_HOST}/fdc/v1`, `javascript:fetch('//${OVERRIDE_HOST}')`]) {
            const failure = expectBaseUrlRefusal(raw);

            expect(failure.message).toContain('scheme');
            expect(failure.message).not.toContain(raw);
        }
    });

    it('refuses an absolute URL whose authority canonicalises to no host', () => {
        // `https://./fdc/v1` parses with a hostname of `.`, which canonicalises
        // to nothing: an empty paced host matches no request, which is the
        // silent no-pacing every refusal here exists to prevent.
        expect(expectBaseUrlRefusal('https://./fdc/v1').message).toContain('no host');
    });

    it('rejects a value carrying credentials without echoing it', () => {
        const secret = 's3cr3t-usda-key';

        for (const raw of [`https://usda:${secret}@${OVERRIDE_HOST}/fdc/v1`, `https://${secret}@${OVERRIDE_HOST}/fdc/v1`]) {
            const failure = expectBaseUrlRefusal(raw);

            // A credentialed URL is refused rather than reduced to its host,
            // because `https://api.nal.usda.gov@elsewhere.test` addresses
            // `elsewhere.test` — and because the value is then a secret.
            expect(failure.message).toContain('userinfo');
            expect(failure.message).not.toContain(secret);
            expect(failure.message).not.toContain(raw);
        }
    });

    it('names no configured value in any refusal, whichever refusal it is', () => {
        // One assertion over every rejecting branch at once, because the value
        // is a possible secret in all of them: a credential can be written
        // into the variable in a spelling that is refused for some other
        // reason — `secret@host` is a bare hostname to the URL parser — and
        // the message must still not carry it.
        const secret = 's3cr3t-usda-key';

        for (const raw of [
            `${secret}@${OVERRIDE_HOST}`,
            `${OVERRIDE_HOST}?api_key=${secret}`,
            `ftp://usda:${secret}@${OVERRIDE_HOST}/fdc/v1`,
            `file:///tmp/${secret}`,
            `//usda:${secret}@${OVERRIDE_HOST}/fdc/v1`,
            `https://usda:${secret}@${OVERRIDE_HOST}/fdc/v1`,
            `  ${secret}  `,
        ]) {
            const failure = expectBaseUrlRefusal(raw);

            expect(failure.message).not.toContain(secret);
            expect(failure.message).not.toContain(raw);
            expect(failure.message).not.toContain(raw.trim());
        }
    });

    it('reads the environment only when it is called', () => {
        const snapshot = process.env.USDA_BASE_URL;

        try {
            // Importing this module must not have captured anything: the
            // process's own variable is consulted at call time, which is what
            // lets a caller pass an environment in at all.
            process.env.USDA_BASE_URL = OVERRIDE_BASE_URL;
            expect(getUsdaPacedHost()).toBe(OVERRIDE_HOST);

            delete process.env.USDA_BASE_URL;
            expect(getUsdaPacedHost()).toBe(USDA_HOST);
        } finally {
            if (snapshot === undefined) {
                delete process.env.USDA_BASE_URL;
            } else {
                process.env.USDA_BASE_URL = snapshot;
            }
        }
    });
});

describe('the limiter\u2019s paced host', () => {
    const REAL_FETCH = globalThis.fetch;
    const BASE_URL_SNAPSHOT = process.env.USDA_BASE_URL;

    let workspace: string;
    let requested: string[];

    beforeEach(() => {
        workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'soh-rate-ledger-host-'));
        requested = [];
        // A transport that answers without leaving the process. The limiter
        // reads one header field (`status`) off whatever the delegate resolved
        // and never touches the body, so an object with a status is the whole
        // of what it needs.
        globalThis.fetch = (async (input: unknown): Promise<Response> => {
            requested.push(String((input as { url?: string }).url ?? input));

            return { status: 200 } as unknown as Response;
        }) as typeof globalThis.fetch;
    });

    afterEach(() => {
        globalThis.fetch = REAL_FETCH;

        if (BASE_URL_SNAPSHOT === undefined) {
            delete process.env.USDA_BASE_URL;
        } else {
            process.env.USDA_BASE_URL = BASE_URL_SNAPSHOT;
        }

        fs.rmSync(workspace, { recursive: true, force: true });
    });

    /** A limiter with no `host` and no `ledgerScope` — the importer's own wiring. */
    const limiterOverDefaults = (
        clock: Clock,
        stateFilePath: string,
    ): ReturnType<typeof createUsdaRateLimiter> =>
        createUsdaRateLimiter({
            requestsPerHour: 900,
            // One token, so the second request has to be paced by the bucket
            // and the pause is a single, exact wait.
            burstCapacity: 1,
            now: clock.read,
            sleep: clock.sleep,
            ledgerStateFilePath: stateFilePath,
        });

    it('paces and charges the effective USDA_BASE_URL host when the caller passed none', async () => {
        process.env.USDA_BASE_URL = OVERRIDE_BASE_URL;

        const clock = createClock();
        const stateFilePath = path.join(workspace, 'ledger.json');
        const limiter = limiterOverDefaults(clock, stateFilePath);

        // The durable hour is accounted under the host the requests will
        // actually reach, not under a constant nothing is sent to.
        expect(limiter.stats().ledgerScope).toBe(OVERRIDE_HOST);
        expect(limiter.stats().ledgerKind).toBe('file');

        const restore = limiter.install();

        try {
            await globalThis.fetch(`${OVERRIDE_BASE_URL}/foods/list?dataType=Branded&pageNumber=1`);

            expect(requested).toHaveLength(1);
            expect(limiter.stats().attempts).toBe(1);
            expect(limiter.stats().statusClassCounts.ok2xx).toBe(1);
            // Charged to the DURABLE ledger, under that host's scope, so a
            // restart inside the hour is paced by it.
            expect(readStamps(stateFilePath)).toEqual([T0]);
            expect(readStateDocument(stateFilePath).scope).toBe(OVERRIDE_HOST);

            // And it is really paced: the second request waits out the bucket
            // (900/hour is one token every 4,000ms) before it goes out.
            await globalThis.fetch(`${OVERRIDE_BASE_URL}/foods/list?dataType=Branded&pageNumber=2`);

            expect(clock.sleeps).toEqual([4_000]);
            expect(limiter.stats().pauses).toBe(1);
            expect(limiter.stats().attempts).toBe(2);
            expect(readStamps(stateFilePath)).toEqual([T0, T0 + 4_000]);
        } finally {
            restore();
        }
    });

    it('leaves the compiled-in host alone while USDA_BASE_URL points elsewhere', async () => {
        process.env.USDA_BASE_URL = OVERRIDE_BASE_URL;

        const clock = createClock();
        const stateFilePath = path.join(workspace, 'ledger.json');
        const limiter = limiterOverDefaults(clock, stateFilePath);
        const restore = limiter.install();

        try {
            // Traffic to a host this run does not use is not this run's hour to
            // spend: a vendor's allowance is per service, so charging it here
            // would pace the run by requests it never made.
            await globalThis.fetch(`https://${USDA_HOST}/fdc/v1/foods/list?dataType=Branded`);

            expect(requested).toHaveLength(1);
            expect(limiter.stats().attempts).toBe(0);
            expect(clock.sleeps).toEqual([]);
            expect(fs.existsSync(stateFilePath)).toBe(false);
        } finally {
            restore();
        }
    });

    it('still paces the documented USDA host when USDA_BASE_URL is unset', async () => {
        delete process.env.USDA_BASE_URL;

        const clock = createClock();
        const stateFilePath = path.join(workspace, 'ledger.json');
        const limiter = limiterOverDefaults(clock, stateFilePath);

        expect(limiter.stats().ledgerScope).toBe(USDA_HOST);

        const restore = limiter.install();

        try {
            await globalThis.fetch(`https://${USDA_HOST}/fdc/v1/foods/list?dataType=Branded`);

            expect(limiter.stats().attempts).toBe(1);
            expect(readStateDocument(stateFilePath).scope).toBe(USDA_HOST);
        } finally {
            restore();
        }
    });

    it('refuses to build a limiter against an unusable USDA_BASE_URL rather than pacing nothing', () => {
        // The importer's own wiring: `catalog-import-usda.ts` passes no `host`,
        // so this constructor is where a configuration the request path cannot
        // use has to stop the run. A bare hostname and a whitespace-only value
        // are in the list because both used to resolve to a host here while
        // `usda.service.ts` could build no request from either.
        for (const raw of ['not a url at all', OVERRIDE_HOST, '   ', `file:///tmp/${OVERRIDE_HOST}`]) {
            process.env.USDA_BASE_URL = raw;

            expect(() =>
                createUsdaRateLimiter({
                    requestsPerHour: 900,
                    ledgerStateFilePath: path.join(workspace, 'ledger.json'),
                }),
            ).toThrow(RateLimitConfigError);
        }
    });

    it('keeps an explicitly passed host authoritative over the environment', async () => {
        process.env.USDA_BASE_URL = OVERRIDE_BASE_URL;

        const clock = createClock();
        const stateFilePath = path.join(workspace, 'ledger.json');
        // The case the option exists for: a caller whose transport this module
        // cannot infer from the environment.
        const limiter = createUsdaRateLimiter({
            requestsPerHour: 900,
            burstCapacity: 1,
            host: `https://stub.usda.test:8080/fdc/v1`,
            now: clock.read,
            sleep: clock.sleep,
            ledgerStateFilePath: stateFilePath,
        });

        expect(limiter.stats().ledgerScope).toBe('stub.usda.test');

        const restore = limiter.install();

        try {
            await globalThis.fetch('https://stub.usda.test:8080/fdc/v1/foods/list?dataType=Branded');
            await globalThis.fetch(`${OVERRIDE_BASE_URL}/foods/list?dataType=Branded`);

            expect(requested).toHaveLength(2);
            expect(limiter.stats().attempts).toBe(1);
            expect(readStateDocument(stateFilePath).scope).toBe('stub.usda.test');
        } finally {
            restore();
        }
    });
});
