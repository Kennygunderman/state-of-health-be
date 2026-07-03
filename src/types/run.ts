import { RunPersonalRecordResponse } from './personalRecord';

export interface RunSplitResponse {
    id: string;
    splitNumber: number;
    distanceMeters: number;
    durationSeconds: number;
    paceSecPerKm?: number | null;
}

export interface RunResponse {
    id: string;
    userId: string;
    startedAt: string;
    endedAt?: string | null;
    updatedAt: number;
    durationSeconds: number;
    distanceMeters: number;
    avgPaceSecPerKm?: number | null;
    elevationGainM?: number | null;
    elevationLossM?: number | null;
    avgHeartRate?: number | null;
    maxHeartRate?: number | null;
    calories?: number | null;
    runType: string;
    source: string;
    routePolyline?: string | null;
    notes?: string | null;
    splits: RunSplitResponse[];
    newRecords?: RunPersonalRecordResponse[];
}

export interface CreateRunSplitPayload {
    splitNumber: number;
    distanceMeters: number;
    durationSeconds: number;
    paceSecPerKm?: number | null;
}

export interface CreateRunPayload {
    startedAt: string;
    endedAt?: string | null;
    updatedAt: number;
    durationSeconds: number;
    distanceMeters: number;
    avgPaceSecPerKm?: number | null;
    elevationGainM?: number | null;
    elevationLossM?: number | null;
    avgHeartRate?: number | null;
    maxHeartRate?: number | null;
    calories?: number | null;
    runType?: string;
    source?: string;
    routePolyline?: string | null;
    notes?: string | null;
    splits?: CreateRunSplitPayload[];
}
