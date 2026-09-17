/**
 * A CHILD-PROCESS HOOK THAT REFUSES EVERY VENDOR REQUEST, AND RECORDS THAT IT
 * REFUSED.
 *
 * WHY THIS EXISTS. `jestSetup.ts` makes the test process fail closed by
 * DELETING `USDA_API_KEY` and `OPENROUTER_API_KEY`: both vendor boundaries read
 * their key through an accessor that throws a typed "not configured" error when
 * it is absent, so no request is ever built. That is the whole of the parent's
 * protection, and it does not extend to a child process that must carry keys.
 *
 * The script suites launch real CLI entry points as children, and those
 * children need the keys PRESENT: every stage runs a `preflight` before it
 * takes any lock, and a missing vendor key is reported there as a prerequisite
 * gap — so without the keys the child exits on `stage_prerequisites_unmet` and
 * never reaches the behaviour under test. The keys those harnesses set are
 * deliberately unusable placeholders, and the stage is expected to refuse
 * before opening a request. "Expected to" was the problem: nothing in the child
 * enforced it, so a regression in the very refusal being tested — a lock that
 * is not taken, a prerequisite that stops being checked — would let a real
 * `catalog:import` begin against `api.nal.usda.gov` from a unit test, spending
 * a rate budget the suite does not own and, with a real key in the environment
 * instead of a placeholder, spending money.
 *
 * WHY THIS FILE IS PLAIN COMMONJS JAVASCRIPT AND NOT TYPESCRIPT. It has to be
 * the FIRST `--require` the child loads, ahead of `ts-node/register`. A
 * TypeScript hook cannot be: Node has no loader for `.ts` until ts-node
 * registers one, so a `.ts` hook must come second and every line ts-node runs
 * while registering — and anything a future entry point might do before the
 * hook lands — would execute unprotected, with the keys already in the
 * environment. Being dependency-free (Node built-ins only) is what allows
 * first position; that property is asserted by the suite, not merely intended.
 * It also means this hook protects a child running COMPILED js just as well as
 * one running TypeScript.
 *
 * WHAT IT DOES. Required into the child before anything else, it replaces the
 * request channels a vendor call can leave through — `globalThis.fetch` and
 * `http`/`https` `request` and `get` — with functions that record the attempt
 * and then refuse. Nothing is sent. `installRateLimiter` replaces
 * `globalThis.fetch` with a paced wrapper around whatever it finds there, so a
 * limiter installed after this hook wraps the refusal rather than escaping it.
 *
 * WHAT IT DELIBERATELY DOES NOT TOUCH: `net`, `tls` and DNS resolution. These
 * children connect to PostgreSQL, which reaches the transport through `net` and
 * resolves its host through `dns`; denying either would break the child for a
 * reason that has nothing to do with vendors, and a vendor request cannot be
 * made without one of the channels above. A hostname reaching a resolver with
 * no request following it is therefore possible, and is not what this guards.
 *
 * WHY IT WRITES A FILE. "No vendor request was attempted" is satisfied just as
 * well by a hook that never loaded — the exact vacuity this module exists to
 * remove. So it appends one line at require time saying it is installed, and
 * one line per attempt. A caller asserts BOTH: the install line proves the hook
 * was live in that child, and the absence of an attempt line then means
 * something. Writes are synchronous because the process is expected to die
 * moments later and a buffered write would be lost.
 *
 * Requiring this module IS the installation, so it exports nothing. The log's
 * variable name, its event types and its parser live in the side-effect-free
 * `./vendorNetworkDenyLog.ts`, which callers import for the reading half; the
 * one string the two files share is asserted equal by the suite so the pair
 * cannot drift apart.
 */
'use strict';

const { appendFileSync } = require('fs');
const http = require('http');
const https = require('https');

/** Must equal `VENDOR_NETWORK_DENY_LOG_VAR` in `./vendorNetworkDenyLog.ts`. */
const LOG_VAR = 'VENDOR_NETWORK_DENY_LOG';

const logPath = process.env[LOG_VAR];

const record = (event) => {
    if (logPath === undefined || logPath.length === 0) {
        return;
    }
    try {
        appendFileSync(logPath, `${JSON.stringify(event)}\n`);
    } catch {
        // A log that cannot be written must not become the reason a child
        // fails: the refusal below is the protection and the line is evidence
        // about it. Swallowed deliberately — the missing `installed` line is
        // what tells the caller the evidence is unavailable.
    }
};

/**
 * Origin and path only, NEVER the query string: a vendor URL carries its
 * credential there (`?api_key=...`), and this value is written to a file and
 * quoted in failure messages. Anything unparsable is reported by its shape
 * rather than its content, for the same reason.
 */
const describeTarget = (value) => {
    if (typeof value === 'string') {
        try {
            const url = new URL(value);

            return `${url.protocol}//${url.host}${url.pathname}`;
        } catch {
            return '<unparsable>';
        }
    }
    if (value instanceof URL) {
        return `${value.protocol}//${value.host}${value.pathname}`;
    }
    if (typeof value === 'object' && value !== null) {
        const host = value.hostname ?? value.host ?? '<no-host>';
        const requestPath = (value.path ?? '/').split('?')[0];

        return `${host}${requestPath}`;
    }

    return '<unknown>';
};

const refusal = (channel, target) => {
    const described = describeTarget(target);
    // Recorded before the refusal is handed back, and synchronously, so the
    // line exists whether or not anything ever looks at the error.
    record({ event: 'attempt', channel, target: described });

    return new Error(
        `vendor network denied: ${channel} to ${described}. This process is a test child and must not ` +
            'reach a vendor endpoint; the stage under test is expected to refuse before opening a request.',
    );
};

const deny = (channel, target) => {
    throw refusal(channel, target);
};

// A REJECTED PROMISE, NOT A SYNCHRONOUS THROW. `fetch` does not throw
// synchronously for a network failure, and a hook that did would skip the
// stage's own `catch` and surface as an uncaught error instead of the typed
// vendor failure the stage reports. Rejecting makes the refusal arrive through
// the channel a real outage arrives through, so what the child prints is what
// it would print if the vendor were unreachable — and a caller cannot mistake
// the refusal for the request having worked.
globalThis.fetch = (input) => Promise.reject(refusal('fetch', input));

// Assigned rather than proxied: neither namespace is frozen, and a direct
// assignment is what a `require('https').get` caller and an
// `import https from 'https'` caller both see, since the interop hands out the
// same namespace object.
http.request = (options) => deny('http.request', options);
http.get = (options) => deny('http.get', options);
https.request = (options) => deny('https.request', options);
https.get = (options) => deny('https.get', options);

record({ event: 'installed' });
