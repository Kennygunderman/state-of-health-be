import dns from 'dns';
// This VPS has broken IPv6 egress — Node otherwise prefers AAAA records and
// outbound HTTPS (Firebase cert fetch, OpenRouter, USDA) hangs until timeout
// on fresh processes. Must run before any network module is loaded.
dns.setDefaultResultOrder('ipv4first');

import dotenv from 'dotenv';
dotenv.config();

import app from './app';
import { prisma } from './prisma/client';

const PORT = process.env.PORT || 3000;

/**
 * How long start-up waits for the database before serving anyway.
 *
 * The warm-up is an optimisation, never a readiness gate: a database that is
 * slow or down must not keep the process from binding its port, because
 * `/health` is what reports reachability and it can only answer once the server
 * is listening.
 */
const WARM_UP_TIMEOUT_MS = 5_000;

/**
 * Completes Prisma's engine and connection initialisation before the first
 * request is served.
 *
 * Prisma does that work lazily, on the first query, so without this the first
 * real request after every deploy or restart pays it: measured at 12.9x the
 * warm latency on the heaviest read (89.94 ms against a 6.99 ms warm p50) and
 * 21.6x on `/health` (63.70 ms against 2.95 ms), with identical statement
 * counts cold and warm — it is initialisation, not extra queries. One trivial
 * `SELECT 1` here moves that cost off the first user and into start-up.
 *
 * Bounded and non-fatal by construction. Every failure — an unreachable
 * database, a refused connection, a timeout — is logged and swallowed, so boot
 * proceeds and the deployment degrades exactly as it did before: `/health`
 * answers 503 until the database returns.
 */
const warmUpDatabase = async (): Promise<void> => {
    const startedAt = Date.now();
    let timer: NodeJS.Timeout | undefined;

    try {
        await Promise.race([
            prisma.$queryRaw`SELECT 1`,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                    () => reject(new Error(`warm-up timed out after ${WARM_UP_TIMEOUT_MS} ms`)),
                    WARM_UP_TIMEOUT_MS,
                );
                // Never hold the event loop open on account of the warm-up.
                timer.unref();
            }),
        ]);

        console.log(`Database connection warm after ${Date.now() - startedAt} ms`);
    } catch (error) {
        console.warn(
            `Database warm-up did not complete (${error instanceof Error ? error.message : String(error)}); ` +
                'starting anyway — /health reports database reachability.',
        );
    } finally {
        if (timer !== undefined) {
            clearTimeout(timer);
        }
    }
};

void warmUpDatabase().finally(() => {
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
});
