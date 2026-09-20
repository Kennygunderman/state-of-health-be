import { Request, Response } from 'express';
import { createWeighIn, deleteWeighIn, getWeighInsForUser } from '../services/weighIn.service';
import { ParsedWeighInBody, parseWeighInBody, parseWeighInPath } from '../services/weighIn.logic';
import { getUserId } from '../utils/getUserId';
import { describeErrorSafely, logSafeEvent } from '../utils/safeLogger';

/**
 * The route descriptors the safe server events below carry, in the spelling
 * `food.controller.ts` and `nutrition.controller.ts` use, so an operator greps
 * one stream across the legacy families. The dots live in this field and never
 * in an event NAME — `safeLogger`'s `EVENT_NAME_PATTERN` admits no `.` and
 * rewrites a dotted name to `unnamed_event`.
 */
const ACTIONS = {
    list: 'weighIn.list',
    create: 'weighIn.create',
    delete: 'weighIn.delete',
} as const;

/**
 * Records one server fault on a weigh-in route: the route, the status, and a
 * SAFE description of the throw — its class name and, when the runtime supplies
 * one, its machine code.
 *
 * This replaced `console.error('…', error)` on all three sites in this file,
 * and it is the fix for a measured leak of the same class the food routes had.
 * One `DELETE /api/weigh-in/not-a-uuid` printed: a `PrismaClientKnownRequestError`
 * carrying four absolute filesystem paths, a four-line source excerpt of
 * `weighIn.service.ts`, four frames inside `src/generated/prisma/runtime/library.js`,
 * the connector's message quoting the offending segment, and
 * `clientVersion: '6.9.0'`. `describeErrorSafely` cannot express any of it —
 * `message`, `stack`, `cause` and `meta` are unreachable through it — which is
 * what Rule backend-architecture §8 asks for and what AAP §0.3.2/§0.7.1 require.
 * No response changed: every status and body these paths answer with is the one
 * shipped clients already read.
 */
const logRouteFailure = (action: string, status: number, error: unknown): void => {
    logSafeEvent('error', 'request_failed', {
        action,
        status,
        ...describeErrorSafely(error),
    });
};

/**
 * The 400 body a refused weigh-in answers with, chosen from the parser's
 * verdict.
 *
 * Two renderings, for the reason `nutrition.controller.ts::logEntryErrorBody`
 * gives at length: the frozen sentence is the response every shipped client has
 * read for a missing or unusable weight and carries no code, while the bound
 * this release adds is a refusal no shipped client can have seen and is
 * therefore rendered as §0.5.2's machine-readable envelope. Exhaustive by
 * construction — a new verdict code fails the build rather than inheriting a
 * body it was not written for.
 */
const weighInErrorBody = (
    verdict: Extract<ParsedWeighInBody, { kind: 'error' }>,
): Record<string, unknown> => {
    switch (verdict.code) {
        case 'weigh_in_fields_required':
            return { error: verdict.message };
        case 'invalid_request':
            return { error: verdict.code, details: verdict.details };
    }
};

export const getWeighIns = async (req: Request, res: Response) => {
    try {
        const userId = getUserId(req);
        const weighIns = await getWeighInsForUser(userId);
        return res.json({ weighIns });
    } catch (error) {
        logRouteFailure(ACTIONS.list, 500, error);
        res.status(500).json({ error: 'Failed to get weigh-ins' });
    }
};

export const createWeighInController = async (req: Request, res: Response) => {
    try {
        const userId = getUserId(req);

        // The predicate is `weighIn.logic.ts`'s rather than inline here, which
        // is what makes the weight bound testable without a database (Rule
        // backend-architecture §4 — "validation lives at this boundary, but the
        // predicate is pure logic"). Two verdicts, two bodies: the guard the
        // endpoint shipped with keeps its frozen message, and a weight outside
        // the stored contract earns the `400 invalid_request` envelope §0.5.2
        // specifies. An out-of-range weight was accepted and stored before this.
        const parsed = parseWeighInBody(req.body);
        if (parsed.kind === 'error') {
            return res.status(400).json(weighInErrorBody(parsed));
        }

        const weighIn = await createWeighIn(userId, {
            weight: parsed.weight,
            loggedAt: parsed.loggedAt.toISOString(),
        });
        return res.status(201).json(weighIn);
    } catch (error) {
        logRouteFailure(ACTIONS.create, 500, error);
        res.status(500).json({ error: 'Failed to create weigh-in' });
    }
};

export const deleteWeighInController = async (req: Request, res: Response) => {
    try {
        const userId = getUserId(req);

        // The path id is judged before the query, so a segment the database
        // cannot parse as a UUID earns §0.5.2's `400 invalid_request` rather
        // than reaching the connector and surfacing as a 500 — the behaviour
        // the diary's entry routes and the food routes already have. The
        // predicate is `weighIn.logic.ts`'s, so it is tested without a
        // database (Rule backend-architecture §4).
        const path = parseWeighInPath(req.params.id);
        if (path.kind === 'error') {
            logSafeEvent('warn', 'request_rejected', {
                action: ACTIONS.delete,
                status: 400,
                code: path.code,
            });
            return res.status(400).json({ error: path.code, details: path.details });
        }

        const deleted = await deleteWeighIn(userId, path.id);
        if (!deleted) {
            return res.status(404).json({ error: 'Weigh-in not found' });
        }
        return res.json({ success: true });
    } catch (error) {
        logRouteFailure(ACTIONS.delete, 500, error);
        res.status(500).json({ error: 'Failed to delete weigh-in' });
    }
};
