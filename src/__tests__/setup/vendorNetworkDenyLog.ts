/**
 * THE LOG FORMAT THE VENDOR DENY WRITES, WITHOUT THE DENY.
 *
 * `./vendorNetworkDeny.js` installs itself when it is required — that is what a
 * `--require` hook is — so a harness that imported it merely to learn the name
 * of its environment variable, or to parse the file it wrote, would install the
 * refusal in the TEST process as a side effect of reading a constant. In this
 * process that is wrong twice over: `jestSetup.ts` already makes vendor calls
 * fail closed by removing the keys, and several cases replace `globalThis.fetch`
 * with their own transport to watch the rate limiter wrap it.
 *
 * So the reading half lives here and the installing half lives there. This file
 * holds no state, touches no global and performs no I/O.
 *
 * The installer is dependency-free CommonJS rather than TypeScript because it
 * must be the child's FIRST `--require`, ahead of `ts-node/register` — Node has
 * no loader for `.ts` until ts-node provides one. It therefore cannot import
 * this module, and carries its own copy of the one shared string
 * ({@link VENDOR_NETWORK_DENY_LOG_VAR}) and of the target-describing rule. The
 * suite asserts the two copies agree, so the pair cannot drift apart silently.
 */

/** The environment variable naming the file the deny hook appends to. */
export const VENDOR_NETWORK_DENY_LOG_VAR = 'VENDOR_NETWORK_DENY_LOG';

/** Which request channel an attempt came through. */
export type VendorNetworkChannel = 'fetch' | 'http.request' | 'http.get' | 'https.request' | 'https.get';

/** One line of the log. */
export interface VendorNetworkDenyEvent {
    /** `installed` once, at require time; `attempt` per refused request. */
    readonly event: 'installed' | 'attempt';
    /** Absent on `installed`. */
    readonly channel?: VendorNetworkChannel;
    /**
     * Enough of the target to identify the vendor: `protocol//host` and path.
     *
     * NEVER the query string. A vendor URL carries its credential there —
     * `?api_key=...` is how FoodData Central is addressed — and this log is read
     * by a test and quoted in its failure message. The rule is implemented by
     * the installer (the only place that writes a line) and asserted
     * end-to-end: a child is made to request a URL with `api_key=secret` in it,
     * and the log is checked for the absence of that value.
     */
    readonly target?: string;
}

/** Parses a log the deny hook wrote. */
export const readVendorNetworkDenyLog = (contents: string): VendorNetworkDenyEvent[] =>
    contents
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as VendorNetworkDenyEvent);
