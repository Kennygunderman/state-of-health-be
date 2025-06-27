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
        };
        sets: {
            id: string;
            reps: number;
            weight: number;
            completed: boolean;
        }[];
    }[];
}
