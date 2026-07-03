import { PersonalRecordResponse } from './personalRecord';

export interface WorkoutResponse {
    id: string;
    date: string;
    updatedAt: number;
    userId: string;
    dailyExercises: {
        dailyExerciseId: string;
        order: number;
        exercise: {
            id: string;
            name: string;
            exerciseType: string;
            exerciseBodyPart: string;
            loggingType: string;
        };
        sets: {
            id: string;
            reps: number;
            weight: number;
            completed: boolean;
            addedWeight?: number | null;
            durationSeconds?: number | null;
            distanceMeters?: number | null;
            rpe?: number | null;
            isWarmup?: boolean;
        }[];
    }[];
    // Only populated on create/update responses — new PRs unlocked by this write.
    newRecords?: PersonalRecordResponse[];
}
