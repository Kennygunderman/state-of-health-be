import { prisma } from '../prisma/client';

export const getUserExercises = async (userId: string) => {
    const exercises = await prisma.user_exercises.findMany({
        where: {
            user_id: userId,
            deleted_at: null
        },
        orderBy: {
            name: 'asc'
        }
    });

    return exercises.map(exercise => ({
        id: exercise.id,
        name: exercise.name,
        exerciseType: exercise.exercise_type,
        exerciseBodyPart: exercise.exercise_body_part
    }));
};

export const deleteUserExercise = async (userId: string, exerciseId: string) => {
    const exercise = await prisma.user_exercises.findFirst({
        where: {
            id: exerciseId,
            user_id: userId
        }
    });

    if (!exercise) {
        throw new Error('Exercise not found or does not belong to user');
    }

    // Soft delete by setting deleted_at timestamp
    return prisma.user_exercises.update({
        where: {
            id: exerciseId
        },
        data: {
            deleted_at: new Date()
        }
    });
};
