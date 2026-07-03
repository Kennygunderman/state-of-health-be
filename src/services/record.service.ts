import { prisma } from '../prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { PersonalRecordResponse, RunPersonalRecordResponse } from '../types/personalRecord';

// BEST_PACE is the only record type where a lower value is the improvement.
const LOWER_IS_BETTER = new Set(['BEST_PACE']);

interface SetForRecords {
    weight: number | null;
    addedWeight: number | null;
    reps: number | null;
    durationSeconds: number | null;
    distanceMeters: number | null;
    completedAt: Date;
}

interface RecordCandidate {
    recordType: string;
    value: number;
    unit: string;
    repsAtRecord?: number | null;
}

const isBetter = (recordType: string, candidateValue: number, currentValue: number): boolean =>
    LOWER_IS_BETTER.has(recordType) ? candidateValue < currentValue : candidateValue > currentValue;

// Driven entirely by which fields are present on the set, not by the exercise's
// logging_type — keeps this correct even if a set's shape and its exercise's
// declared logging type ever drift apart.
const computeSetCandidates = (set: SetForRecords): RecordCandidate[] => {
    const candidates: RecordCandidate[] = [];
    const effectiveWeight = set.weight ?? set.addedWeight ?? null;

    if (effectiveWeight !== null && effectiveWeight > 0 && set.reps !== null && set.reps > 0) {
        candidates.push({ recordType: 'MAX_WEIGHT', value: effectiveWeight, unit: 'lb', repsAtRecord: set.reps });
        candidates.push({ recordType: 'MAX_VOLUME', value: effectiveWeight * set.reps, unit: 'lb', repsAtRecord: set.reps });
        candidates.push({
            recordType: 'MAX_ESTIMATED_1RM',
            value: effectiveWeight * (1 + set.reps / 30),
            unit: 'lb',
            repsAtRecord: set.reps
        });
    } else if (set.reps !== null && set.reps > 0) {
        candidates.push({ recordType: 'MAX_REPS', value: set.reps, unit: 'reps' });
    } else if (effectiveWeight !== null && effectiveWeight > 0 && set.durationSeconds !== null && set.durationSeconds > 0) {
        // Weight-for-time sets (WEIGHT_TIME, e.g. farmers carries): the heaviest
        // load carried is still a weight record; volume/1RM need reps to mean anything.
        candidates.push({ recordType: 'MAX_WEIGHT', value: effectiveWeight, unit: 'lb' });
    }

    if (set.durationSeconds !== null && set.durationSeconds > 0) {
        candidates.push({ recordType: 'MAX_DURATION', value: set.durationSeconds, unit: 'sec' });
    }

    if (set.distanceMeters !== null && set.distanceMeters > 0) {
        candidates.push({ recordType: 'MAX_DISTANCE', value: set.distanceMeters, unit: 'm' });
    }

    return candidates;
};

export const evaluateAndUpsertExerciseRecords = async (
    userId: string,
    exerciseId: string,
    sets: SetForRecords[]
): Promise<PersonalRecordResponse[]> => {
    // Collapse to the single best candidate per record_type within this batch of sets,
    // so a workout with multiple PR-breaking sets for the same lift only writes once.
    const bestByType = new Map<string, { candidate: RecordCandidate; achievedAt: Date }>();
    for (const set of sets) {
        for (const candidate of computeSetCandidates(set)) {
            const existing = bestByType.get(candidate.recordType);
            if (!existing || isBetter(candidate.recordType, candidate.value, existing.candidate.value)) {
                bestByType.set(candidate.recordType, { candidate, achievedAt: set.completedAt });
            }
        }
    }

    const newRecords: PersonalRecordResponse[] = [];

    for (const [recordType, { candidate, achievedAt }] of bestByType) {
        const current = await prisma.personal_records.findUnique({
            where: { user_id_exercise_id_record_type: { user_id: userId, exercise_id: exerciseId, record_type: recordType } }
        });

        if (current && !isBetter(recordType, candidate.value, current.value)) {
            continue;
        }

        const saved = await prisma.personal_records.upsert({
            where: { user_id_exercise_id_record_type: { user_id: userId, exercise_id: exerciseId, record_type: recordType } },
            update: {
                value: candidate.value,
                unit: candidate.unit,
                reps_at_record: candidate.repsAtRecord ?? null,
                achieved_at: achievedAt
            },
            create: {
                id: uuidv4(),
                user_id: userId,
                exercise_id: exerciseId,
                record_type: recordType,
                value: candidate.value,
                unit: candidate.unit,
                reps_at_record: candidate.repsAtRecord ?? null,
                achieved_at: achievedAt
            }
        });

        newRecords.push({
            id: saved.id,
            exerciseId: saved.exercise_id,
            recordType: saved.record_type,
            value: saved.value,
            unit: saved.unit,
            repsAtRecord: saved.reps_at_record,
            achievedAt: saved.achieved_at.toISOString()
        });
    }

    return newRecords;
};

interface RunForRecords {
    id: string;
    distanceMeters: number;
    durationSeconds: number;
    avgPaceSecPerKm: number | null;
    startedAt: Date;
}

export const evaluateAndUpsertRunRecords = async (userId: string, run: RunForRecords): Promise<RunPersonalRecordResponse[]> => {
    const candidates: RecordCandidate[] = [
        { recordType: 'MAX_DISTANCE', value: run.distanceMeters, unit: 'm' },
        { recordType: 'MAX_DURATION', value: run.durationSeconds, unit: 'sec' }
    ];
    if (run.avgPaceSecPerKm !== null && run.avgPaceSecPerKm > 0) {
        candidates.push({ recordType: 'BEST_PACE', value: run.avgPaceSecPerKm, unit: 'sec_per_km' });
    }

    const newRecords: RunPersonalRecordResponse[] = [];

    for (const candidate of candidates) {
        const current = await prisma.run_personal_records.findUnique({
            where: { user_id_record_type: { user_id: userId, record_type: candidate.recordType } }
        });

        if (current && !isBetter(candidate.recordType, candidate.value, current.value)) {
            continue;
        }

        const saved = await prisma.run_personal_records.upsert({
            where: { user_id_record_type: { user_id: userId, record_type: candidate.recordType } },
            update: { value: candidate.value, unit: candidate.unit, run_id: run.id, achieved_at: run.startedAt },
            create: {
                id: uuidv4(),
                user_id: userId,
                record_type: candidate.recordType,
                value: candidate.value,
                unit: candidate.unit,
                run_id: run.id,
                achieved_at: run.startedAt
            }
        });

        newRecords.push({
            id: saved.id,
            recordType: saved.record_type,
            value: saved.value,
            unit: saved.unit,
            runId: saved.run_id,
            achievedAt: saved.achieved_at.toISOString()
        });
    }

    return newRecords;
};

export const getPersonalRecordsForUser = async (
    userId: string
): Promise<{ exerciseRecords: PersonalRecordResponse[]; runRecords: RunPersonalRecordResponse[] }> => {
    const [exerciseRecords, runRecords] = await Promise.all([
        prisma.personal_records.findMany({
            where: { user_id: userId },
            include: { user_exercises: true },
            orderBy: { achieved_at: 'desc' }
        }),
        prisma.run_personal_records.findMany({
            where: { user_id: userId },
            orderBy: { achieved_at: 'desc' }
        })
    ]);

    return {
        exerciseRecords: exerciseRecords.map((record) => ({
            id: record.id,
            exerciseId: record.exercise_id,
            exerciseName: record.user_exercises.name,
            recordType: record.record_type,
            value: record.value,
            unit: record.unit,
            repsAtRecord: record.reps_at_record,
            achievedAt: record.achieved_at.toISOString()
        })),
        runRecords: runRecords.map((record) => ({
            id: record.id,
            recordType: record.record_type,
            value: record.value,
            unit: record.unit,
            runId: record.run_id,
            achievedAt: record.achieved_at.toISOString()
        }))
    };
};

export const getExerciseHistory = async (userId: string, exerciseId: string, page: number = 1, limit: number = 20) => {
    const skip = (page - 1) * limit;

    const where = {
        completed: true,
        daily_exercises: {
            exercise_id: exerciseId,
            workout_days: { user_id: userId }
        }
    };

    const [sets, total] = await Promise.all([
        prisma.exercise_sets.findMany({
            where,
            include: { daily_exercises: { include: { workout_days: true } } },
            orderBy: { completed_at: 'desc' },
            skip,
            take: limit
        }),
        prisma.exercise_sets.count({ where })
    ]);

    return {
        history: sets.map((set) => ({
            setId: set.id,
            date: set.daily_exercises.workout_days.date.toISOString(),
            reps: set.reps,
            weight: set.weight,
            addedWeight: set.added_weight,
            durationSeconds: set.duration_seconds,
            distanceMeters: set.distance_meters,
            rpe: set.rpe
        })),
        total
    };
};
