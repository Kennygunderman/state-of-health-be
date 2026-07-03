import { prisma } from '../prisma/client';
import { WorkoutResponse } from '../types/workout';
import { PersonalRecordResponse } from '../types/personalRecord';
import { startOfWeek, subWeeks, format, addDays } from 'date-fns';
import { v4 as uuidv4 } from 'uuid';
import { evaluateAndUpsertExerciseRecords } from './record.service';

interface DailyExerciseWithRelations {
    id: string;
    order: number | null;
    user_exercises: {
        id: string;
        name: string;
        exercise_type: string;
        exercise_body_part: string;
        logging_type: string;
    };
    exercise_sets: Array<{
        id: string;
        daily_exercise_id: string;
        reps: number | null;
        weight: number | null;
        added_weight: number | null;
        duration_seconds: number | null;
        distance_meters: number | null;
        rpe: number | null;
        is_warmup: boolean | null;
        completed: boolean | null;
    }>;
}

const mapDailyExercises = (dailyExercises: DailyExerciseWithRelations[]) =>
    dailyExercises.map((de) => ({
        dailyExerciseId: de.id,
        order: de.order ?? 0,
        exercise: {
            id: de.user_exercises.id,
            name: de.user_exercises.name,
            exerciseType: de.user_exercises.exercise_type,
            exerciseBodyPart: de.user_exercises.exercise_body_part,
            loggingType: de.user_exercises.logging_type,
        },
        sets: de.exercise_sets.map((s) => ({
            id: s.id,
            reps: s.reps ?? 0,
            weight: s.weight ?? 0,
            completed: s.completed ?? false,
            addedWeight: s.added_weight,
            durationSeconds: s.duration_seconds,
            distanceMeters: s.distance_meters,
            rpe: s.rpe,
            isWarmup: s.is_warmup ?? false,
        })),
    }));

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
        dailyExercises: mapDailyExercises(dailyWorkout.daily_exercises as DailyExerciseWithRelations[]),
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
            dailyExercises: mapDailyExercises(workout.daily_exercises as DailyExerciseWithRelations[]),
        })),
        total
    };
};

interface BestSetFields {
    weight: number | null;
    added_weight: number | null;
    reps: number | null;
    duration_seconds: number | null;
}

// What makes a set the "best" of an exercise depends on how it's logged:
// weight x reps for loaded lifts, most reps for bodyweight, longest hold for
// timed work, heaviest carry (duration as tiebreak) for weighted-timed.
// Returns [primary, tiebreak] so callers can compare lexicographically.
const bestSetScore = (loggingType: string, set: BestSetFields): [number, number] => {
    const weight = set.weight ?? 0;
    const addedWeight = set.added_weight ?? 0;
    const reps = set.reps ?? 0;
    const duration = set.duration_seconds ?? 0;

    switch (loggingType) {
        case 'BODYWEIGHT_REPS':
            return [reps, 0];
        case 'WEIGHTED_BODYWEIGHT':
            return [addedWeight * reps, reps];
        case 'TIME_ONLY':
            return [duration, 0];
        case 'WEIGHT_TIME':
            return [weight, duration];
        case 'TIME_REPS':
            return [duration * reps, duration];
        default:
            return [weight * reps, reps];
    }
};

const isBetterSet = (loggingType: string, candidate: BestSetFields, current: BestSetFields): boolean => {
    const [candidatePrimary, candidateTiebreak] = bestSetScore(loggingType, candidate);
    const [currentPrimary, currentTiebreak] = bestSetScore(loggingType, current);

    return candidatePrimary !== currentPrimary
        ? candidatePrimary > currentPrimary
        : candidateTiebreak > currentTiebreak;
};

export const getWorkoutSummary = async (userId: string, page: number = 1, limit: number = 10): Promise<{ summaries: Array<{
    workoutDayId: string;
    day: string;
    totalWeight: number;
    totalDurationSeconds: number;
    totalBodyweightReps: number;
    exercises: Array<{
        setsCompleted: number;
        loggingType: string;
        bestSet?: {
            weight: number | null;
            addedWeight: number | null;
            reps: number | null;
            durationSeconds: number | null;
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

    // Calculate total count of workouts with completed sets (the query above
    // already narrows exercise_sets to completed ones)
    const total = allWorkouts.filter(workout =>
        workout.daily_exercises.some(de => de.exercise_sets.length > 0)
    ).length;

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
        const completedSetsOf = (sets: typeof workout.daily_exercises[number]['exercise_sets']) =>
            sets.filter(set => set.completed);

        const totalWeight = workout.daily_exercises.reduce((sum, de) =>
            sum + completedSetsOf(de.exercise_sets).reduce((setSum, set) =>
                setSum + ((set.weight ?? 0) * (set.reps ?? 0)), 0), 0);

        const totalDurationSeconds = workout.daily_exercises.reduce((sum, de) =>
            sum + completedSetsOf(de.exercise_sets).reduce((setSum, set) =>
                setSum + (set.duration_seconds ?? 0), 0), 0);

        // Reps done against bodyweight (with or without added load) — the
        // volume chip can't represent these, so they get their own count
        const totalBodyweightReps = workout.daily_exercises.reduce((sum, de) => {
            const loggingType = de.user_exercises.logging_type;
            if (loggingType !== 'BODYWEIGHT_REPS' && loggingType !== 'WEIGHTED_BODYWEIGHT') return sum;

            return sum + completedSetsOf(de.exercise_sets).reduce((setSum, set) => setSum + (set.reps ?? 0), 0);
        }, 0);

        const exercises = workout.daily_exercises
            .map(de => {
                const completedSets = completedSetsOf(de.exercise_sets);
                // Skip exercises with no completed sets
                if (completedSets.length === 0) return null;

                const loggingType = de.user_exercises.logging_type;
                const best = completedSets.reduce((currentBest, candidate) =>
                    currentBest === null || isBetterSet(loggingType, candidate, currentBest) ? candidate : currentBest,
                null as (typeof completedSets)[number] | null);

                return {
                    setsCompleted: completedSets.length,
                    loggingType,
                    bestSet: best
                        ? {
                            weight: best.weight ?? null,
                            addedWeight: best.added_weight ?? null,
                            reps: best.reps ?? null,
                            durationSeconds: best.duration_seconds ?? null
                        }
                        : undefined,
                    exercise: {
                        name: de.user_exercises.name
                    }
                };
            })
            .filter((exercise): exercise is NonNullable<typeof exercise> => exercise !== null);

        // Skip days where nothing was completed — any completed set counts,
        // regardless of whether it moved external weight
        if (exercises.length === 0) {
            return null;
        }

        return {
            workoutDayId: workout.id,
            day: workout.date.toISOString(),
            totalWeight,
            totalDurationSeconds,
            totalBodyweightReps,
            exercises
        };
    }).filter((summary): summary is NonNullable<typeof summary> => summary !== null);

    return {
        summaries,
        total
    };
};

interface CreateOrUpdateSetPayload {
    id: string;
    reps?: number | null;
    weight?: number | null;
    addedWeight?: number | null;
    durationSeconds?: number | null;
    distanceMeters?: number | null;
    rpe?: number | null;
    isWarmup?: boolean;
    setNumber?: number | null;
    completedAt?: string | null;
    completed: boolean;
}

interface CreateOrUpdateDailyExercisePayload {
    id: string;
    order: number;
    exercise: {
        id: string;
        name: string;
        exerciseType: string;
        exerciseBodyPart: string;
    };
    sets: CreateOrUpdateSetPayload[];
}

// Diffs each exercise's completed sets against its current-best personal records
// and upserts anything improved. Returns only the records that actually changed.
const evaluateWorkoutRecords = async (
    userId: string,
    dailyExercises: CreateOrUpdateDailyExercisePayload[]
): Promise<PersonalRecordResponse[]> => {
    const newRecords: PersonalRecordResponse[] = [];

    for (const de of dailyExercises) {
        const completedSets = de.sets.filter((s) => s.completed);
        if (completedSets.length === 0) continue;

        const records = await evaluateAndUpsertExerciseRecords(
            userId,
            de.exercise.id,
            completedSets.map((s) => ({
                weight: s.weight ?? null,
                addedWeight: s.addedWeight ?? null,
                reps: s.reps ?? null,
                durationSeconds: s.durationSeconds ?? null,
                distanceMeters: s.distanceMeters ?? null,
                completedAt: s.completedAt ? new Date(s.completedAt) : new Date(),
            }))
        );
        newRecords.push(...records);
    }

    return newRecords;
};

export const createWorkout = async (userId: string, workoutData: {
    date: string;
    updatedAt: number;
    dailyExercises: CreateOrUpdateDailyExercisePayload[];
}): Promise<{ newRecords: PersonalRecordResponse[] }> => {
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
                            reps: set.reps ?? null,
                            weight: set.weight ?? null,
                            added_weight: set.addedWeight ?? null,
                            duration_seconds: set.durationSeconds ?? null,
                            distance_meters: set.distanceMeters ?? null,
                            rpe: set.rpe ?? null,
                            is_warmup: set.isWarmup ?? false,
                            set_number: set.setNumber ?? null,
                            completed_at: set.completedAt ? new Date(set.completedAt) : null,
                            completed: set.completed
                        }))
                    }
                }))
            }
        }
    });

    const newRecords = await evaluateWorkoutRecords(userId, workoutData.dailyExercises);
    return { newRecords };
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

        // A day counts as a workout when any set was completed — bodyweight
        // and timed sets count even though they move no external weight
        const completedDays = daysInWeek.filter(wd =>
            wd.daily_exercises.some(de => de.exercise_sets.some(set => set.completed === true))
        );

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
        dailyExercises: CreateOrUpdateDailyExercisePayload[];
    }
): Promise<{ date: Date; newRecords: PersonalRecordResponse[] } | null> => {
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
                            reps: set.reps ?? null,
                            weight: set.weight ?? null,
                            added_weight: set.addedWeight ?? null,
                            duration_seconds: set.durationSeconds ?? null,
                            distance_meters: set.distanceMeters ?? null,
                            rpe: set.rpe ?? null,
                            is_warmup: set.isWarmup ?? false,
                            set_number: set.setNumber ?? null,
                            completed_at: set.completedAt ? new Date(set.completedAt) : null,
                            completed: set.completed
                        }))
                    }
                }))
            }
        }
    });

    const newRecords = await evaluateWorkoutRecords(userId, workoutData.dailyExercises);
    return { date: new Date(workoutData.date), newRecords };
};
