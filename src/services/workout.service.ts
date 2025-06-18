import { prisma } from '../prisma/client';
import { WorkoutResponse } from '../types/workout';

interface DailyExerciseWithRelations {
    id: string;
    user_exercises: {
        id: string;
        name: string;
        exercise_type: string;
        exercise_body_part: string;
    };
    exercise_sets: Array<{
        id: string;
        daily_exercise_id: string;
        reps: number;
        weight: number;
        completed: boolean | null;
    }>;
}

export const getWorkoutByDate = async (userId: string, date: string): Promise<WorkoutResponse> => {
    const dailyWorkout = await prisma.workout_days.findFirst({
        where: {
            user_id: userId,
            date: new Date(date),
        },
        include: {
            daily_exercises: {
                include: {
                    exercise_sets: true,
                    user_exercises: true,
                },
            },
        },
    });

    if (!dailyWorkout) throw new Error('No workout found');

    return {
        id: dailyWorkout.id,
        date: dailyWorkout.date.toISOString(),
        dailyExercises: dailyWorkout.daily_exercises.map((de: DailyExerciseWithRelations) => ({
            dailyExerciseId: de.id,
            exercise: {
                id: de.user_exercises.id,
                name: de.user_exercises.name,
                exerciseType: de.user_exercises.exercise_type,
                exerciseBodyPart: de.user_exercises.exercise_body_part,
            },
            sets: de.exercise_sets.map((s) => ({
                id: s.id,
                reps: s.reps ?? 0,
                weight: s.weight ?? 0,
                completed: s.completed ?? false,
            })),
        })),
    };
};

export const getAllWorkoutsForUser = async (userId: string, page: number = 1, limit: number = 10): Promise<{ workouts: WorkoutResponse[], total: number }> => {
    // Calculate skip value for pagination
    const skip = (page - 1) * limit;

    // Get total count of workouts for this user
    const total = await prisma.workout_days.count({
        where: {
            user_id: userId,
        }
    });

    // Get paginated workouts
    const workouts = await prisma.workout_days.findMany({
        where: {
            user_id: userId,
        },
        include: {
            daily_exercises: {
                include: {
                    exercise_sets: true,
                    user_exercises: true,
                },
            },
        },
        orderBy: {
            date: 'desc',
        },
        skip,
        take: limit,
    });

    return {
        workouts: workouts.map(workout => ({
            id: workout.id,
            date: workout.date.toISOString(),
            dailyExercises: workout.daily_exercises.map((de: DailyExerciseWithRelations) => ({
                dailyExerciseId: de.id,
                exercise: {
                    id: de.user_exercises.id,
                    name: de.user_exercises.name,
                    exerciseType: de.user_exercises.exercise_type,
                    exerciseBodyPart: de.user_exercises.exercise_body_part,
                },
                sets: de.exercise_sets.map((s) => ({
                    id: s.id,
                    reps: s.reps ?? 0,
                    weight: s.weight ?? 0,
                    completed: s.completed ?? false,
                })),
            })),
        })),
        total
    };
};

export const getWorkoutSummary = async (userId: string, page: number = 1, limit: number = 10): Promise<{ summaries: Array<{
    workoutDayId: string;
    day: string;
    totalWeight: number;
    exercises: Array<{
        setsCompleted: number;
        bestSet?: {
            weight: number;
            reps: number;
        };
        exercise: {
            name: string;
        };
    }>;
}>, total: number }> => {
    // Calculate skip value for pagination
    const skip = (page - 1) * limit;

    // Get total count of workouts for this user
    const total = await prisma.workout_days.count({
        where: {
            user_id: userId,
        }
    });

    // Get paginated workouts with completed sets
    const workouts = await prisma.workout_days.findMany({
        where: {
            user_id: userId,
        },
        include: {
            daily_exercises: {
                include: {
                    exercise_sets: {
                        where: {
                            completed: true
                        }
                    },
                    user_exercises: true
                }
            }
        },
        orderBy: {
            date: 'desc'
        },
        skip,
        take: limit
    });

    const summaries = workouts.map(workout => {
        // Calculate total weight first
        const totalWeight = workout.daily_exercises.reduce((sum, de) => {
            const exerciseWeight = de.exercise_sets.reduce((setSum, set) => {
                if (set.completed) {
                    return setSum + (set.weight * set.reps);
                }
                return setSum;
            }, 0);
            return sum + exerciseWeight;
        }, 0);

        // Skip days with no weight lifted
        if (totalWeight === 0) {
            return null;
        }

        const exercises = workout.daily_exercises
            .map(de => {
                const completedSets = de.exercise_sets.filter(set => set.completed);
                // Skip exercises with no completed sets
                if (completedSets.length === 0) return null;

                const bestSet = completedSets.reduce((best, current) => {
                    const currentTotal = current.weight * current.reps;
                    const bestTotal = best ? best.weight * best.reps : 0;
                    return currentTotal > bestTotal ? current : best;
                }, null as { weight: number; reps: number } | null);

                return {
                    setsCompleted: completedSets.length,
                    bestSet: bestSet ? {
                        weight: bestSet.weight,
                        reps: bestSet.reps
                    } : undefined,
                    exercise: {
                        name: de.user_exercises.name
                    }
                };
            })
            .filter((exercise): exercise is NonNullable<typeof exercise> => exercise !== null);

        return {
            workoutDayId: workout.id,
            day: workout.date.toISOString(),
            totalWeight,
            exercises
        };
    }).filter((summary): summary is NonNullable<typeof summary> => summary !== null);

    return {
        summaries,
        total
    };
};

export const createWorkout = async (userId: string, workoutData: {
    id: string;
    date: string;
    dailyExercises: Array<{
        id: string;
        exercise: {
            id: string;
            name: string;
            exerciseType: string;
            exerciseBodyPart: string;
        };
        sets: Array<{
            id: string;
            reps?: number;
            weight?: number;
            setNumber?: number | null;
            completedAt?: string | null;
            completed: boolean;
        }>;
    }>;
}): Promise<void> => {
    await prisma.workout_days.upsert({
        where: { id: workoutData.id },
        update: {
            date: new Date(workoutData.date),
            daily_exercises: {
                deleteMany: {}, // Delete existing daily exercises and their sets
                create: workoutData.dailyExercises.map(de => ({
                    id: de.id,
                    user_exercises: {
                        connect: {
                            id: de.exercise.id
                        }
                    },
                    exercise_sets: {
                        create: de.sets.map(set => ({
                            id: set.id,
                            reps: set.reps ?? 0,
                            weight: set.weight ?? 0,
                            set_number: set.setNumber ?? null,
                            completed_at: set.completedAt ? new Date(set.completedAt) : null,
                            completed: set.completed
                        }))
                    }
                }))
            }
        },
        create: {
            id: workoutData.id,
            user_id: userId,
            date: new Date(workoutData.date),
            daily_exercises: {
                create: workoutData.dailyExercises.map(de => ({
                    id: de.id,
                    user_exercises: {
                        connect: {
                            id: de.exercise.id
                        }
                    },
                    exercise_sets: {
                        create: de.sets.map(set => ({
                            id: set.id,
                            reps: set.reps ?? 0,
                            weight: set.weight ?? 0,
                            set_number: set.setNumber ?? null,
                            completed_at: set.completedAt ? new Date(set.completedAt) : null,
                            completed: set.completed
                        }))
                    }
                }))
            }
        }
    });
};
