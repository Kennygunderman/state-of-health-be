import { prisma } from '../prisma/client';
import { AvatarResponse, CreateUserRequest, UserResponse } from '../types/user';
import { ProfileResponse, UpdateProfileRequest } from '../types/coach';

const mapProfile = (user: {
    sex: string | null;
    birth_date: Date | null;
    height_cm: number | null;
    weight_unit: string | null;
    timezone: string | null;
}): ProfileResponse => ({
    sex: user.sex,
    birthDate: user.birth_date ? user.birth_date.toISOString().slice(0, 10) : null,
    heightCm: user.height_cm,
    weightUnit: user.weight_unit,
    timezone: user.timezone,
});

const PROFILE_SELECT = {
    sex: true,
    birth_date: true,
    height_cm: true,
    weight_unit: true,
    timezone: true,
} as const;

export const getProfile = async (userId: string): Promise<ProfileResponse | null> => {
    const user = await prisma.users.findUnique({ where: { id: userId }, select: PROFILE_SELECT });
    return user ? mapProfile(user) : null;
};

export const updateProfile = async (
    userId: string,
    updates: UpdateProfileRequest,
): Promise<ProfileResponse | null> => {
    const data: Record<string, unknown> = {};
    if (updates.sex !== undefined) data.sex = updates.sex;
    if (updates.birthDate !== undefined) {
        data.birth_date = updates.birthDate ? new Date(`${updates.birthDate}T00:00:00Z`) : null;
    }
    if (updates.heightCm !== undefined) data.height_cm = updates.heightCm;
    if (updates.weightUnit !== undefined) data.weight_unit = updates.weightUnit;
    if (updates.timezone !== undefined) data.timezone = updates.timezone;

    try {
        const user = await prisma.users.update({
            where: { id: userId },
            data,
            select: PROFILE_SELECT,
        });

        // Legacy weigh-ins predate the unit column; stamp them with the user's
        // unit the first time we learn it (decision: tdee-coach-plan.md §8.2).
        if (updates.weightUnit) {
            await prisma.body_weight_entries.updateMany({
                where: { user_id: userId, unit: null },
                data: { unit: updates.weightUnit },
            });
        }

        return mapProfile(user);
    } catch (error) {
        // Prisma P2025 = row not found.
        if ((error as { code?: string }).code === 'P2025') return null;
        throw error;
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