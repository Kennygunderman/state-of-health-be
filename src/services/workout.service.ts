import { prisma } from '../prisma/client';
import { WorkoutResponse } from '../types/workout';
import { startOfWeek, subWeeks, format, addDays } from 'date-fns';
import { v4 as uuidv4 } from 'uuid';

interface DailyExerciseWithRelations {
    id: string;
    order: number | null;
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

export const getWorkoutByDate = async (userId: string, date: string): Promise<WorkoutResponse | null> => {
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
                orderBy: {
                    order: 'asc',
                },
            },
        },
    });

    if (!dailyWorkout) return null;

    return {
        id: dailyWorkout.id,
        date: dailyWorkout.date.toISOString(),
        updatedAt: Number(dailyWorkout.updated_at),
        userId: dailyWorkout.user_id,
        dailyExercises: dailyWorkout.daily_exercises.map((de: DailyExerciseWithRelations) => ({
            dailyExerciseId: de.id,
            order: de.order ?? 0,
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
                orderBy: {
                    order: 'asc',
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
            updatedAt: Number(workout.updated_at),
            userId: workout.user_id,
            dailyExercises: workout.daily_exercises.map((de: DailyExerciseWithRelations) => ({
                dailyExerciseId: de.id,
                order: de.order ?? 0,
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

    // Get all workouts for this user to calculate the correct total
    const allWorkouts = await prisma.workout_days.findMany({
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
                    }
                }
            }
        }
    });

    // Calculate total count of workouts with completed sets
    const total = allWorkouts.filter(workout => {
        const totalWeight = workout.daily_exercises.reduce((sum, de) => {
            const exerciseWeight = de.exercise_sets.reduce((setSum, set) => {
                if (set.completed) {
                    return setSum + (set.weight * set.reps);
                }
                return setSum;
            }, 0);
            return sum + exerciseWeight;
        }, 0);
        return totalWeight > 0;
    }).length;

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
                },
                orderBy: {
                    order: 'asc'
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
    date: string;
    updatedAt: number;
    dailyExercises: Array<{
        id: string;
        order: number;
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
    // Check if a workout day for this user/date already exists
    const existing = await prisma.workout_days.findFirst({
        where: { user_id: userId, date: new Date(workoutData.date) }
    });
    if (existing) {
        throw new Error('Workout day already exists for this date. ' + workoutData.date);
    }

    const workoutDayId = uuidv4();

    await prisma.workout_days.create({
        data: {
            id: workoutDayId,
            user_id: userId,
            date: new Date(workoutData.date),
            updated_at: BigInt(workoutData.updatedAt),
            daily_exercises: {
                create: workoutData.dailyExercises.map(de => ({
                    id: de.id,
                    order: de.order,
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

export const getWeeklySummary = async (userId: string, numOfWeeks: number) => {
    // Get today and the start of this week (Monday)
    const today = new Date();
    const weeks: { start: Date; end: Date }[] = [];
    let currentStart = startOfWeek(today, { weekStartsOn: 1 });

    // Build week ranges (from most recent to oldest)
    for (let i = 0; i < numOfWeeks; i++) {
        const start = subWeeks(currentStart, i);
        const end = addDays(start, 6);
        weeks.push({ start, end });
    }

    // Get all workout_days for the user in the last N weeks
    const earliest = weeks[weeks.length - 1].start;
    const workoutDays = await prisma.workout_days.findMany({
        where: {
            user_id: userId,
            date: { gte: earliest }
        },
        include: {
            daily_exercises: {
                include: {
                    exercise_sets: true
                }
            }
        }
    });

    // For each week, count days with at least one completed set
    const summary = weeks.map(({ start }) => {
        const end = addDays(start, 6);

        // Find all workout_days in this week
        const daysInWeek = workoutDays.filter(wd => {
            const workoutDate = wd.date;
            // Use the date directly without timezone conversion
            const workoutDateStr = workoutDate.toISOString().split('T')[0];
            const weekStartStr = start.toISOString().split('T')[0];
            const weekEndStr = end.toISOString().split('T')[0];

            const isInWeek = workoutDateStr >= weekStartStr && workoutDateStr <= weekEndStr;
            return isInWeek;
        });

        // For each day, check if any set is completed (matching client logic)
        const completedDays = daysInWeek.filter(wd => {
            // Calculate total weight for the day (matching client logic)
            const totalWeightForDay = wd.daily_exercises.reduce((daySum, de) => {
                return daySum + de.exercise_sets.reduce((setSum, set) => {
                    return setSum + ((set.weight ?? 0) * (set.reps ?? 0));
                }, 0);
            }, 0);

            const hasCompletedWorkout = totalWeightForDay > 0;
            return hasCompletedWorkout;
        });

        return {
            startOfWeek: format(start, 'M/d'),
            completedWorkouts: completedDays.length
        };
    });

    return summary;
};

export const updateWorkout = async (
    userId: string,
    workoutId: string,
    workoutData: {
        date: string;
        updatedAt: number;
        dailyExercises: Array<{
            id: string;
            order: number;
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
    }
): Promise<{ date: Date } | null> => {
    // Find the workout_day by id and userId
    const existing = await prisma.workout_days.findFirst({
        where: { id: workoutId, user_id: userId }
    });
    if (!existing) return null;

    // Update the workout_day and replace all daily_exercises/sets
    await prisma.workout_days.update({
        where: { id: workoutId },
        data: {
            date: new Date(workoutData.date),
            updated_at: BigInt(workoutData.updatedAt),
            daily_exercises: {
                deleteMany: {},
                create: workoutData.dailyExercises.map(de => ({
                    id: de.id,
                    order: de.order,
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
    return { date: new Date(workoutData.date) };
};
