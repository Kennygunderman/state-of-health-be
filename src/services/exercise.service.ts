import { prisma } from '../prisma/client';

export const getUserExercises = async (userId: string) => {
    const exercises = await prisma.user_exercises.findMany({
        where: {
            user_id: userId
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