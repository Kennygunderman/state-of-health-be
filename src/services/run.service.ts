import { prisma } from '../prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { startOfWeek, subWeeks, addDays, format } from 'date-fns';
import { CreateRunPayload, RunResponse } from '../types/run';
import { RunPersonalRecordResponse } from '../types/personalRecord';
import { evaluateAndUpsertRunRecords } from './record.service';

interface RunWithSplits {
    id: string;
    user_id: string;
    started_at: Date;
    ended_at: Date | null;
    updated_at: bigint;
    duration_seconds: number;
    distance_meters: number;
    avg_pace_sec_per_km: number | null;
    elevation_gain_m: number | null;
    elevation_loss_m: number | null;
    avg_heart_rate: number | null;
    max_heart_rate: number | null;
    calories: number | null;
    run_type: string;
    source: string;
    route_polyline: string | null;
    notes: string | null;
    run_splits: {
        id: string;
        split_number: number;
        distance_meters: number;
        duration_seconds: number;
        pace_sec_per_km: number | null;
    }[];
}

const mapRun = (run: RunWithSplits): RunResponse => ({
    id: run.id,
    userId: run.user_id,
    startedAt: run.started_at.toISOString(),
    endedAt: run.ended_at?.toISOString() ?? null,
    updatedAt: Number(run.updated_at),
    durationSeconds: run.duration_seconds,
    distanceMeters: run.distance_meters,
    avgPaceSecPerKm: run.avg_pace_sec_per_km,
    elevationGainM: run.elevation_gain_m,
    elevationLossM: run.elevation_loss_m,
    avgHeartRate: run.avg_heart_rate,
    maxHeartRate: run.max_heart_rate,
    calories: run.calories,
    runType: run.run_type,
    source: run.source,
    routePolyline: run.route_polyline,
    notes: run.notes,
    splits: run.run_splits
        .sort((a, b) => a.split_number - b.split_number)
        .map((split) => ({
            id: split.id,
            splitNumber: split.split_number,
            distanceMeters: split.distance_meters,
            durationSeconds: split.duration_seconds,
            paceSecPerKm: split.pace_sec_per_km,
        })),
});

export const getRunById = async (userId: string, runId: string): Promise<RunResponse | null> => {
    const run = await prisma.runs.findFirst({
        where: { id: runId, user_id: userId },
        include: { run_splits: true },
    });
    if (!run) return null;
    return mapRun(run);
};

export const getAllRunsForUser = async (
    userId: string,
    page: number = 1,
    limit: number = 10
): Promise<{ runs: RunResponse[]; total: number }> => {
    const skip = (page - 1) * limit;

    const [total, runs] = await Promise.all([
        prisma.runs.count({ where: { user_id: userId } }),
        prisma.runs.findMany({
            where: { user_id: userId },
            include: { run_splits: true },
            orderBy: { started_at: 'desc' },
            skip,
            take: limit,
        }),
    ]);

    return { runs: runs.map(mapRun), total };
};

export const getWeeklyRunSummary = async (userId: string, numOfWeeks: number) => {
    const today = new Date();
    const weeks: { start: Date; end: Date }[] = [];
    const currentStart = startOfWeek(today, { weekStartsOn: 1 });

    for (let i = 0; i < numOfWeeks; i++) {
        const start = subWeeks(currentStart, i);
        weeks.push({ start, end: addDays(start, 6) });
    }

    const earliest = weeks[weeks.length - 1].start;
    const runs = await prisma.runs.findMany({
        where: { user_id: userId, started_at: { gte: earliest } },
    });

    return weeks.map(({ start, end }) => {
        const runsInWeek = runs.filter((run) => run.started_at >= start && run.started_at <= end);
        return {
            startOfWeek: format(start, 'M/d'),
            totalRuns: runsInWeek.length,
            totalDistanceMeters: runsInWeek.reduce((sum, run) => sum + run.distance_meters, 0),
        };
    });
};

const buildSplitsCreate = (splits: CreateRunPayload['splits']) =>
    (splits ?? []).map((split) => ({
        id: uuidv4(),
        split_number: split.splitNumber,
        distance_meters: split.distanceMeters,
        duration_seconds: split.durationSeconds,
        pace_sec_per_km: split.paceSecPerKm ?? null,
    }));

export const createRun = async (
    userId: string,
    payload: CreateRunPayload
): Promise<{ run: RunResponse; newRecords: RunPersonalRecordResponse[] }> => {
    const runId = uuidv4();

    const created = await prisma.runs.create({
        data: {
            id: runId,
            user_id: userId,
            started_at: new Date(payload.startedAt),
            ended_at: payload.endedAt ? new Date(payload.endedAt) : null,
            updated_at: BigInt(payload.updatedAt),
            duration_seconds: payload.durationSeconds,
            distance_meters: payload.distanceMeters,
            avg_pace_sec_per_km: payload.avgPaceSecPerKm ?? null,
            elevation_gain_m: payload.elevationGainM ?? null,
            elevation_loss_m: payload.elevationLossM ?? null,
            avg_heart_rate: payload.avgHeartRate ?? null,
            max_heart_rate: payload.maxHeartRate ?? null,
            calories: payload.calories ?? null,
            run_type: payload.runType ?? 'OUTDOOR',
            source: payload.source ?? 'MANUAL',
            route_polyline: payload.routePolyline ?? null,
            notes: payload.notes ?? null,
            run_splits: { create: buildSplitsCreate(payload.splits) },
        },
        include: { run_splits: true },
    });

    const newRecords = await evaluateAndUpsertRunRecords(userId, {
        id: created.id,
        distanceMeters: created.distance_meters,
        durationSeconds: created.duration_seconds,
        avgPaceSecPerKm: created.avg_pace_sec_per_km,
        startedAt: created.started_at,
    });

    return { run: mapRun(created), newRecords };
};

export const updateRun = async (
    userId: string,
    runId: string,
    payload: CreateRunPayload
): Promise<{ run: RunResponse; newRecords: RunPersonalRecordResponse[] } | null> => {
    const existing = await prisma.runs.findFirst({ where: { id: runId, user_id: userId } });
    if (!existing) return null;

    const updated = await prisma.runs.update({
        where: { id: runId },
        data: {
            started_at: new Date(payload.startedAt),
            ended_at: payload.endedAt ? new Date(payload.endedAt) : null,
            updated_at: BigInt(payload.updatedAt),
            duration_seconds: payload.durationSeconds,
            distance_meters: payload.distanceMeters,
            avg_pace_sec_per_km: payload.avgPaceSecPerKm ?? null,
            elevation_gain_m: payload.elevationGainM ?? null,
            elevation_loss_m: payload.elevationLossM ?? null,
            avg_heart_rate: payload.avgHeartRate ?? null,
            max_heart_rate: payload.maxHeartRate ?? null,
            calories: payload.calories ?? null,
            run_type: payload.runType ?? 'OUTDOOR',
            source: payload.source ?? 'MANUAL',
            route_polyline: payload.routePolyline ?? null,
            notes: payload.notes ?? null,
            run_splits: {
                deleteMany: {},
                create: buildSplitsCreate(payload.splits),
            },
        },
        include: { run_splits: true },
    });

    const newRecords = await evaluateAndUpsertRunRecords(userId, {
        id: updated.id,
        distanceMeters: updated.distance_meters,
        durationSeconds: updated.duration_seconds,
        avgPaceSecPerKm: updated.avg_pace_sec_per_km,
        startedAt: updated.started_at,
    });

    return { run: mapRun(updated), newRecords };
};
