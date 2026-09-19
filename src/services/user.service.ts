import { Prisma } from '../generated/prisma';
import { prisma } from '../prisma/client';
import { AvatarResponse, CreateUserRequest, UserResponse } from '../types/user';

/**
 * A Firebase identity authenticated, but no `users` row exists for it.
 *
 * Firebase authentication and the `users` table are two separate records, and
 * only `POST /api/user` creates the second one. An identity that skipped it —
 * a sign-up abandoned between the two calls, a token minted for a deleted
 * account, an operator's test credential — is a real, permanent state, not a
 * transient fault, and every table keyed by `user_id` carries a foreign key to
 * `users`. Without this guard the first INSERT for such a caller raises
 * PostgreSQL 23503, surfaces as Prisma P2003 (or P2010 inside a transaction),
 * reaches an unmapped handler and answers `500`.
 *
 * Two things make that 500 worse than untidy. `PUT /api/user/targets` has
 * always answered `404 "User not found"` for exactly this caller, so the API
 * contradicted itself route by route. And a mobile client reads a 5xx without a
 * recognised machine code as an UNKNOWN outcome (AAP §0.2.5), so it retries the
 * write and then shows "We couldn't confirm that" for a condition that is
 * permanent and wrote nothing.
 *
 * It lives here rather than in `mealPlanning.errors.ts` because the condition
 * belongs to the user domain and predates meal planning: the legacy diary and
 * food services raise it too, and neither should have to import a
 * meal-planning module to say "this caller has no account".
 */
export class UserNotProvisionedError extends Error {
    constructor(public readonly userId: string) {
        super(`No users row exists for the authenticated identity ${userId}`);
        this.name = 'UserNotProvisionedError';
    }
}

/**
 * Does a `users` row exist for this identity?
 *
 * The one owner-existence check the whole API shares. Callers use it to refuse
 * before inserting rather than to decide what to insert, so it answers a
 * boolean and never returns the row: nothing downstream should be tempted to
 * read user columns through a guard.
 *
 * `db` defaults to the shared client and accepts a transaction client, because
 * the meal-planning writes ask this question inside the transaction that holds
 * the per-user advisory lock — the only place where the answer cannot be
 * overtaken by a concurrent write before the INSERT it protects.
 *
 * `select: { id: true }` keeps the read to the primary-key index; the row's
 * columns are never needed.
 */
export const userExists = async (
    userId: string,
    db: Prisma.TransactionClient = prisma,
): Promise<boolean> => {
    const row = await db.users.findUnique({ where: { id: userId }, select: { id: true } });

    return row !== null;
};

/**
 * {@link userExists}, as a refusal.
 *
 * The form every guarded write actually wants: proceed, or reject with the
 * typed error its controller already maps. Keeping the throw here means the
 * four guarded call sites cannot disagree about what "missing owner" means.
 */
export const assertUserProvisioned = async (
    userId: string,
    db: Prisma.TransactionClient = prisma,
): Promise<void> => {
    if (!(await userExists(userId, db))) {
        throw new UserNotProvisionedError(userId);
    }
};

export const createUser = async (userData: CreateUserRequest): Promise<UserResponse> => {
    // Check if user already exists
    const existingUser = await prisma.users.findUnique({
        where: {
            id: userData.userId
        }
    });

    if (existingUser) {
        throw new Error('User already exists');
    }

    // Check if email is already taken
    const existingEmail = await prisma.users.findUnique({
        where: {
            email: userData.email
        }
    });

    if (existingEmail) {
        throw new Error('Email already exists');
    }

    // Create new user
    const user = await prisma.users.create({
        data: {
            id: userData.userId,
            email: userData.email,
            first_name: userData.firstName || null,
            last_name: userData.lastName || null,
        }
    });

    return {
        id: user.id,
        email: user.email,
        firstName: user.first_name || undefined,
        lastName: user.last_name || undefined,
    };
};

export const updateAvatar = async (userId: string, avatarBase64: string | null): Promise<AvatarResponse> => {
    const user = await prisma.users.update({
        where: { id: userId },
        data: { avatar_base64: avatarBase64 },
    });

    return { avatarBase64: user.avatar_base64 };
};

export const getAvatar = async (userId: string): Promise<AvatarResponse> => {
    const user = await prisma.users.findUnique({
        where: { id: userId },
        select: { avatar_base64: true },
    });

    return { avatarBase64: user?.avatar_base64 ?? null };
}; 