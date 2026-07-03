export interface PersonalRecordResponse {
    id: string;
    exerciseId: string;
    exerciseName?: string;
    recordType: string;
    value: number;
    unit: string;
    repsAtRecord?: number | null;
    achievedAt: string;
}

export interface RunPersonalRecordResponse {
    id: string;
    recordType: string;
    value: number;
    unit: string;
    runId?: string | null;
    achievedAt: string;
}
