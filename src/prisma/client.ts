import { Prisma, PrismaClient } from '../generated/prisma';

/**
 * The database boundary: the single `PrismaClient` for the whole process, with
 * its connection pool sized here and nowhere else.
 *
 * Two things in this file are load-bearing rather than conventional.
 *
 *  1. THE POOL IS BOUNDED EXPLICITLY. Prisma's default pool size is
 *     `physical_cores * 2 + 1`, computed from the machine the client runs on
 *     and unaware of the server it connects to. On a 56-core host that is 113
 *     connections against a PostgreSQL whose `max_connections` is 100, so a
 *     burst of concurrent requests opens more backends than the database
 *     permits and the surplus requests fail with Prisma P2037 ("Too many
 *     database connections opened") — an HTTP 500 caused entirely by
 *     configuration. Bounding the pool converts that into the queueing the
 *     pool exists to provide: requests wait for a connection instead of
 *     demanding a new one.
 *
 *     Size it deliberately, because throughput is `pool / p95_latency` and the
 *     pool is shared by nothing else in the process: a pool of 3 caps a 150 ms
 *     endpoint at ~20 rps, a pool of 10 at ~65 rps. The right number is the
 *     server's `max_connections` divided by the number of processes that talk
 *     to it (API replicas, operator scripts, `psql`), which is why it is an
 *     environment variable documented in `.env.example` rather than a constant
 *     someone has to edit and redeploy.
 *
 *  2. AN OPERATOR'S OWN `connection_limit` WINS. A `DATABASE_URL` that already
 *     carries the parameter is passed through untouched, so tuning the pool
 *     from the connection string keeps working and this module never silently
 *     overrides a deployment that has already made the decision.
 */

/** The Prisma datasource parameter that sizes the pool. */
export const CONNECTION_LIMIT_PARAMETER = 'connection_limit';

/** The environment variable that overrides {@link DEFAULT_CONNECTION_LIMIT}. */
export const CONNECTION_LIMIT_ENV_VAR = 'DATABASE_CONNECTION_LIMIT';

/**
 * The pool size used when neither the URL nor the environment names one.
 *
 * Ten leaves ~90 of a default PostgreSQL's 100 connections for other API
 * replicas, the operator scripts and `psql`, while still serving ~65 rps on a
 * 150 ms endpoint — the sizing recorded in `.env.example`.
 */
export const DEFAULT_CONNECTION_LIMIT = 10;

/**
 * The configured pool size: {@link CONNECTION_LIMIT_ENV_VAR} when it is set,
 * {@link DEFAULT_CONNECTION_LIMIT} otherwise.
 *
 * A variable that IS set but is not a positive integer throws rather than
 * falling back, because silently ignoring it would leave the deployment with a
 * pool nobody chose — the failure mode this whole file exists to remove.
 */
export const resolveConnectionLimit = (env: NodeJS.ProcessEnv = process.env): number => {
    const configured = env[CONNECTION_LIMIT_ENV_VAR];

    if (configured === undefined || configured.trim().length === 0) {
        return DEFAULT_CONNECTION_LIMIT;
    }

    const parsed = Number(configured.trim());

    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(
            `${CONNECTION_LIMIT_ENV_VAR} must be a positive integer (the Prisma connection pool size); ` +
                `received "${configured}". Leave it unset to use the default of ${DEFAULT_CONNECTION_LIMIT}.`,
        );
    }

    return parsed;
};

/**
 * The datasource URL the client is constructed with: `databaseUrl` carrying
 * `connection_limit`, or `undefined` when there is no URL to bound.
 *
 * Pure, and total over its input. `undefined` in means `undefined` out, so an
 * absent `DATABASE_URL` still produces exactly the client this file produced
 * before the pool was bounded and Prisma reports the missing configuration
 * itself, in its own words, on first use. A URL that cannot be parsed is
 * returned unchanged for the same reason: this function's job is to size a
 * pool, not to validate a connection string, and Prisma's own error names the
 * problem better than a rethrow from here would.
 */
export const boundedDatasourceUrl = (
    databaseUrl: string | undefined,
    connectionLimit: number,
): string | undefined => {
    if (databaseUrl === undefined || databaseUrl.length === 0) {
        return undefined;
    }

    let parsed: URL;

    try {
        parsed = new URL(databaseUrl);
    } catch {
        // Deliberately not logged with the URL: it carries the password.
        console.warn(
            'DATABASE_URL could not be parsed, so no connection pool bound was applied. ' +
                'Prisma will report the malformed connection string on first use.',
        );

        return databaseUrl;
    }

    if (parsed.searchParams.has(CONNECTION_LIMIT_PARAMETER)) {
        return databaseUrl;
    }

    parsed.searchParams.set(CONNECTION_LIMIT_PARAMETER, String(connectionLimit));

    return parsed.toString();
};

const datasourceUrl = boundedDatasourceUrl(process.env.DATABASE_URL, resolveConnectionLimit());

// Annotated as `Prisma.PrismaClientOptions` rather than inferred, so that
// `ClientOptions` resolves to its own default and `prisma` keeps EXACTLY the
// type `new PrismaClient()` gave it here before — the pool is the only thing
// this file changes for the forty-odd modules that import it. The empty object
// is the no-argument case: with no `datasourceUrl` key, the client reads the
// datasource from the schema and the environment, as it always has.
const clientOptions: Prisma.PrismaClientOptions = datasourceUrl === undefined ? {} : { datasourceUrl };

export const prisma = new PrismaClient(clientOptions);
