export interface WorkoutResponse {
    date: string;
    dailyExercises: {
        dailyExerciseId: string;
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
