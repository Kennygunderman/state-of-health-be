import { prisma } from '../prisma/client';
import { WorkoutResponse } from '../types/workout';

interface DailyExerciseWithRelations {
    id: string;
    exercises: {
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
    const dailyWorkout = await prisma.workout_days.findUnique({
        where: {
            user_id_date: {
                user_id: userId,
                date: new Date(date),
            },
        },
        include: {
            daily_exercises: {
                include: {
                    exercise_sets: true,
                    exercises: true,
                },
            },
        },
    });

    if (!dailyWorkout) throw new Error('No workout found');

    return {
        date: dailyWorkout.date.toISOString(),
        dailyExercises: dailyWorkout.daily_exercises.map((de: DailyExerciseWithRelations) => ({
            dailyExerciseId: de.id,
            exercise: {
                id: de.exercises.id,
                name: de.exercises.name,
                exerciseType: de.exercises.exercise_type,
                exerciseBodyPart: de.exercises.exercise_body_part,
            },
            sets: de.exercise_sets.map((s) => ({
                id: s.id,
                reps: s.reps,
                weight: s.weight,
                completed: s.completed ?? false,
            })),
        })),
    };
};

export const getAllWorkoutsForUser = async (userId: string): Promise<WorkoutResponse[]> => {
    const workouts = await prisma.workout_days.findMany({
        where: {
            user_id: userId,
        },
        include: {
            daily_exercises: {
                include: {
                    exercise_sets: true,
                    exercises: true,
                },
            },
        },
        orderBy: {
            date: 'desc',
        },
    });

    return workouts.map(workout => ({
        date: workout.date.toISOString(),
        dailyExercises: workout.daily_exercises.map((de: DailyExerciseWithRelations) => ({
            dailyExerciseId: de.id,
            exercise: {
                id: de.exercises.id,
                name: de.exercises.name,
                exerciseType: de.exercises.exercise_type,
                exerciseBodyPart: de.exercises.exercise_body_part,
            },
            sets: de.exercise_sets.map((s) => ({
                id: s.id,
                reps: s.reps,
                weight: s.weight,
                completed: s.completed ?? false,
            })),
        })),
    }));
};

export const getAllExercisesForUser = async (userId: string) => {
    const workouts = await prisma.workout_days.findMany({
        where: {
            user_id: userId,
        },
        include: {
            daily_exercises: {
                include: {
                    exercises: true,
                },
            },
        },
        orderBy: {
            date: 'desc',
        },
    });

    // Create a Set to track unique exercises
    const uniqueExercises = new Set<string>();
    const exercises = [];

    // Iterate through workouts and collect unique exercises
    for (const workout of workouts) {
        for (const dailyExercise of workout.daily_exercises) {
            const exercise = dailyExercise.exercises;
            if (!uniqueExercises.has(exercise.id)) {
                uniqueExercises.add(exercise.id);
                exercises.push({
                    id: exercise.id,
                    name: exercise.name,
                    exerciseType: exercise.exercise_type,
                    exerciseBodyPart: exercise.exercise_body_part,
                });
            }
        }
    }

    return exercises;
};
