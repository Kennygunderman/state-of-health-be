import { prisma } from '../prisma/client';

interface ExerciseWithRelations {
    id: string;
    name: string;
    exercise_type: string;
    exercise_body_part: string;
    user_id: string | null;
    deleted_at: Date | null;
    daily_exercises: {
        id: string;
        workout_day_id: string;
        exercise_id: string;
        exercise_sets: {
            id: string;
            daily_exercise_id: string;
            reps: number;
            weight: number;
            completed: boolean | null;
            set_number: number | null;
            completed_at: Date | null;
        }[];
        workout_days: {
            id: string;
            user_id: string;
            date: Date;
            has_synced: boolean | null;
        };
    }[];
}

export const getUserExercises = async (userId: string) => {
    const exercises = await prisma.user_exercises.findMany({
        where: {
            user_id: userId,
            deleted_at: null
        },
        include: {
            daily_exercises: {
                include: {
                    exercise_sets: {
                        where: {
                            completed: true
                        },
                        orderBy: {
                            completed_at: 'desc'
                        }
                    },
                    workout_days: true
                }
            }
        },
        orderBy: {
            name: 'asc'
        }
    }) as ExerciseWithRelations[];

    return exercises.map(exercise => {
        // Get all sets from the most recently completed exercise
        const dailyExercisesWithCompletedSets = exercise.daily_exercises
            .filter(de => de.exercise_sets.some(set => set.completed && set.completed_at))
            .sort((a, b) => {
                const aLatestSet = a.exercise_sets
                    .filter(set => set.completed && set.completed_at)
                    .sort((x, y) => new Date(y.completed_at!).getTime() - new Date(x.completed_at!).getTime())[0];
                const bLatestSet = b.exercise_sets
                    .filter(set => set.completed && set.completed_at)
                    .sort((x, y) => new Date(y.completed_at!).getTime() - new Date(x.completed_at!).getTime())[0];

                if (!aLatestSet || !bLatestSet) return 0;
                return new Date(bLatestSet.completed_at!).getTime() - new Date(aLatestSet.completed_at!).getTime();
            });

        const mostRecentExercise = dailyExercisesWithCompletedSets[0];
        const latestSets = mostRecentExercise?.exercise_sets
            .filter(set => set.completed && set.completed_at)
            .sort((a, b) => (a.set_number ?? 0) - (b.set_number ?? 0));

        return {
            id: exercise.id,
            name: exercise.name,
            exerciseType: exercise.exercise_type,
            exerciseBodyPart: exercise.exercise_body_part,
            latestCompletedSets: latestSets?.map(set => ({
                id: set.id,
                reps: set.reps,
                weight: set.weight,
                setNumber: set.set_number,
                completedAt: set.completed_at?.toISOString()
            })) ?? []
        };
    });
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
