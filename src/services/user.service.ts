import { prisma } from '../prisma/client';
import { CreateUserRequest, UserResponse } from '../types/user';

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