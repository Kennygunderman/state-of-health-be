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
