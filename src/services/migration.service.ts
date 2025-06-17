import { db } from '../utils/firebase';
import { PrismaClient } from '../generated/prisma';
import { parse } from 'date-fns';

const prisma = new PrismaClient();

interface FirebaseUser {
    id: string;
    account?: {
        email?: string;
        name?: string;
    };
}

interface FirebaseExercise {
    id: string;
    name: string;
    exerciseType: string;
    exerciseBodyPart: string;
}

interface FirebaseUserExercise {
    id: string;
    map: {
        [key: string]: FirebaseExercise;
    };
}

interface FirebaseExerciseSet {
    id: string;
    reps?: number;
    weight?: number;
    completed?: boolean;
}

interface FirebaseDailyExercise {
    id: string;
    exercise: {
        id: string;
    };
    sets: FirebaseExerciseSet[];
}

interface FirebaseDailyExerciseEntry {
    id: string;
    userId: string;
    date: string;
    dailyExercises: FirebaseDailyExercise[];
}

export const migrateAllUserData = async () => {
    try {
        // Fetch all users
        const userSnap = await db.collection('user').get();
        const users = userSnap.docs.map(doc => ({ id: doc.id, ...doc.data() })) as FirebaseUser[];

        // Fetch all user exercises
        const exercisesSnap = await db.collection('userExercises').get();
        const userExercises = exercisesSnap.docs.map(doc => ({ id: doc.id, ...doc.data() })) as FirebaseUserExercise[];

        // Fetch all daily exercise entries
        const dailyEntriesSnap = await db.collection('dailyExerciseEntries').get();
        const dailyExerciseEntries = dailyEntriesSnap.docs.map(doc => ({ id: doc.id, ...doc.data() })) as FirebaseDailyExerciseEntry[];

        const migrationResults = {
            usersProcessed: 0,
            exercisesProcessed: 0,
            workoutsProcessed: 0,
            errors: [] as string[]
        };

        // First, process all users with emails
        for (const user of users) {
            try {
                if (!user.account?.email) {
                    continue;
                }

                // Upsert user
                await prisma.users.upsert({
                    where: { id: user.id },
                    update: {
                        email: user.account.email,
                        first_name: user.account.name?.split(' ')[0] || null,
                        last_name: user.account.name?.split(' ').slice(1).join(' ') || null
                    },
                    create: {
                        id: user.id,
                        email: user.account.email,
                        first_name: user.account.name?.split(' ')[0] || null,
                        last_name: user.account.name?.split(' ').slice(1).join(' ') || null
                    }
                });
                migrationResults.usersProcessed++;

                // Process user's exercises
                const userExercise = userExercises.find(ex => ex.id === user.id);
                if (userExercise?.map) {
                    for (const [_, exercise] of Object.entries(userExercise.map)) {
                        await prisma.user_exercises.upsert({
                            where: { id: exercise.id },
                            update: {
                                name: exercise.name,
                                exercise_type: exercise.exerciseType,
                                exercise_body_part: exercise.exerciseBodyPart,
                                user_id: user.id
                            },
                            create: {
                                id: exercise.id,
                                name: exercise.name,
                                exercise_type: exercise.exerciseType,
                                exercise_body_part: exercise.exerciseBodyPart,
                                user_id: user.id
                            }
                        });
                        migrationResults.exercisesProcessed++;
                    }
                }
            } catch (error) {
                migrationResults.errors.push(`Error processing user ${user.id}: ${error instanceof Error ? error.message : 'Unknown error'}`);
            }
        }

        // Then, process all daily exercise entries independently
        for (const entry of dailyExerciseEntries) {
            try {
                if (!entry.date) continue;

                const workoutDate = parse(entry.date, 'MMMM dd, yyyy', new Date());

                // Upsert workout day
                const workoutDay = await prisma.workout_days.upsert({
                    where: {
                        id: entry.id
                    },
                    update: {
                        has_synced: true
                    },
                    create: {
                        id: entry.id,
                        user_id: entry.userId,
                        date: workoutDate,
                        has_synced: true
                    }
                });

                // Process daily exercises
                for (const dailyExercise of entry.dailyExercises) {
                    // Upsert daily exercise
                    const createdDailyExercise = await prisma.daily_exercises.upsert({
                        where: { id: dailyExercise.id },
                        update: {
                            workout_day_id: workoutDay.id,
                            exercise_id: dailyExercise.exercise.id
                        },
                        create: {
                            id: dailyExercise.id,
                            workout_day_id: workoutDay.id,
                            exercise_id: dailyExercise.exercise.id
                        }
                    });

                    // Delete existing sets and create new ones
                    await prisma.exercise_sets.deleteMany({
                        where: { daily_exercise_id: createdDailyExercise.id }
                    });

                    if (dailyExercise.sets.length > 0) {
                        await prisma.exercise_sets.createMany({
                            data: dailyExercise.sets.map(set => ({
                                id: set.id,
                                daily_exercise_id: createdDailyExercise.id,
                                reps: set.reps || 0,
                                weight: set.weight || 0,
                                completed: set.completed || false
                            }))
                        });
                    }
                }
                migrationResults.workoutsProcessed++;
            } catch (error) {
                migrationResults.errors.push(`Error processing workout ${entry.id}: ${error instanceof Error ? error.message : 'Unknown error'}`);
            }
        }

        return {
            success: true,
            message: 'Migration completed',
            results: migrationResults
        };
    } catch (error) {
        return {
            success: false,
            message: 'Migration failed',
            error: error instanceof Error ? error.message : 'Unknown error'
        };
    }
};
