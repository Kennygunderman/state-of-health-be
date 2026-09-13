import { isCalendarDayKey as preferencesIsCalendarDayKey } from '../../services/preferences.logic';
import { isDayKey as mealPlanIsDayKey } from '../../services/mealPlan.logic';
import { isCalendarDayKey as plannedMealLogIsCalendarDayKey } from '../../services/plannedMealLog.logic';
import { DAY_KEY_PATTERN, isCalendarDayKey } from '../calendarDay';

/**
 * Day keys that name a day the calendar contains, with the reason each one is
 * here. Every entry must be accepted.
 */
const REAL_DAYS: readonly string[] = [
    '0000-01-01', // year zero exists in the proleptic Gregorian calendar this module writes out
    '0001-01-01',
    '0004-02-29', // a leap year by the rule, and the input the three implementations disagreed on
    '0050-06-15',
    '0099-12-31', // the last day before the band the round-trip implementations could reach
    '0100-01-01', // the first day they could reach: the two answers met here and nowhere below
    '0999-12-31',
    '1000-01-01',
    '1970-01-01', // the epoch, which is not special to a calendar rule and must not be
    '2000-02-29', // a century divisible by 400
    '2024-02-29',
    '2026-07-11',
    '2026-12-31',
    '9999-12-31',
];

/** Well-shaped keys naming a day that does not exist. Every entry must be refused. */
const IMPOSSIBLE_DAYS: readonly string[] = [
    '1900-02-29', // a century NOT divisible by 400, so not a leap year
    '2023-02-29',
    '2026-02-30',
    '2026-04-31',
    '2026-06-31',
    '2026-09-31',
    '2026-11-31',
    '2026-13-01', // month above the year
    '2026-00-10', // month below it
    '2026-01-00', // day below the month
    '2026-01-32',
    '2026-12-32',
];

/** Strings that are not the day-key shape at all. Every entry must be refused. */
const MALFORMED_SHAPES: readonly string[] = [
    '2026-7-11', // unpadded month
    '2026-07-1', // unpadded day
    '26-07-11', // two-digit year
    '2026/07/11',
    '2026-07-11 ', // trailing space
    ' 2026-07-11', // leading space
    '2026-07-11T00:00:00Z', // an instant, not a day
    '2026-07-111',
    '20260711',
    '11-07-2026', // day first
    '+2026-07-11',
    '-0001-01-01', // the expanded ISO form for a year before zero
    '2026-ab-11',
    '2026-07-1a',
    'today',
    '',
];

/** Values that are not strings. Every entry must be refused rather than coerced. */
const NON_STRINGS: readonly unknown[] = [null, undefined, 20260711, Number.NaN, {}, [], true, new Date()];

describe('DAY_KEY_PATTERN', () => {
    it('matches the day-key shape and nothing around it', () => {
        expect(DAY_KEY_PATTERN.test('2026-07-11')).toBe(true);
        expect(DAY_KEY_PATTERN.test('2026-07-11T00:00:00Z')).toBe(false);
        expect(DAY_KEY_PATTERN.test(' 2026-07-11')).toBe(false);
    });

    it('is anchored at both ends, so it cannot match a fragment of a longer string', () => {
        expect(DAY_KEY_PATTERN.source.startsWith('^')).toBe(true);
        expect(DAY_KEY_PATTERN.source.endsWith('$')).toBe(true);
    });

    it('carries no global flag, so repeated tests cannot depend on lastIndex', () => {
        // A shared exported regex with /g would answer differently on its second
        // call for the same input, which is the kind of fault a single shared
        // declaration is supposed to remove rather than introduce.
        expect(DAY_KEY_PATTERN.global).toBe(false);
        expect(DAY_KEY_PATTERN.test('2026-07-11')).toBe(true);
        expect(DAY_KEY_PATTERN.test('2026-07-11')).toBe(true);
    });

    it('accepts a shape whose day the calendar does not contain', () => {
        // The reason every caller asks the predicate instead: shape and calendar
        // are two different questions.
        expect(DAY_KEY_PATTERN.test('2026-02-30')).toBe(true);
        expect(isCalendarDayKey('2026-02-30')).toBe(false);
    });
});

describe('isCalendarDayKey', () => {
    describe('days the calendar contains', () => {
        it.each(REAL_DAYS)('accepts %s', (value) => {
            expect(isCalendarDayKey(value)).toBe(true);
        });

        it('accepts the last day of every month of a common year', () => {
            const lastDays = [
                '2026-01-31',
                '2026-02-28',
                '2026-03-31',
                '2026-04-30',
                '2026-05-31',
                '2026-06-30',
                '2026-07-31',
                '2026-08-31',
                '2026-09-30',
                '2026-10-31',
                '2026-11-30',
                '2026-12-31',
            ];

            expect(lastDays.filter((day) => !isCalendarDayKey(day))).toEqual([]);
        });
    });

    describe('the leap rule, written out rather than asked of a Date', () => {
        it('accepts 29 February in a year divisible by 4 but not 100', () => {
            expect(isCalendarDayKey('2024-02-29')).toBe(true);
        });

        it('refuses 29 February in a year not divisible by 4', () => {
            expect(isCalendarDayKey('2023-02-29')).toBe(false);
        });

        it('refuses 29 February in a century not divisible by 400', () => {
            expect(isCalendarDayKey('1900-02-29')).toBe(false);
            expect(isCalendarDayKey('2100-02-29')).toBe(false);
        });

        it('accepts 29 February in a century divisible by 400', () => {
            expect(isCalendarDayKey('2000-02-29')).toBe(true);
            expect(isCalendarDayKey('1600-02-29')).toBe(true);
        });

        it('applies the same rule below year 100, where a Date-based check cannot', () => {
            // Date.UTC(4, 1, 29) means 1904, not year 4 — the legacy two-digit-year
            // mapping that made two of the three former implementations refuse this
            // whole band. The rule itself has no such special case: year 4 is
            // divisible by 4 and not by 100, exactly like 2024.
            expect(isCalendarDayKey('0004-02-29')).toBe(true);
            expect(isCalendarDayKey('0003-02-29')).toBe(false);
            expect(isCalendarDayKey('0100-02-29')).toBe(false);
            expect(isCalendarDayKey('0000-02-29')).toBe(true);
        });
    });

    describe('days the calendar does not contain', () => {
        it.each(IMPOSSIBLE_DAYS)('refuses %s', (value) => {
            expect(isCalendarDayKey(value)).toBe(false);
        });

        it('refuses a day that a Date would roll forward instead of rejecting', () => {
            // new Date('2026-02-30') is 2 March. A rolled-over date is the failure
            // mode this predicate exists to prevent: it is well shaped, it sorts
            // inside a late-February plan week, and nothing downstream would notice.
            expect(new Date('2026-02-30').toISOString().startsWith('2026-03')).toBe(true);
            expect(isCalendarDayKey('2026-02-30')).toBe(false);
        });
    });

    describe('values that are not day keys', () => {
        it.each(MALFORMED_SHAPES)('refuses the malformed shape %p', (value) => {
            expect(isCalendarDayKey(value)).toBe(false);
        });

        it.each(NON_STRINGS)('refuses the non-string %p', (value) => {
            expect(isCalendarDayKey(value)).toBe(false);
        });

        it('refuses a Date, rather than reading a day key out of it', () => {
            // A caller holding a Date wants localDayKey, which needs a zone. Coercing
            // one here would silently answer in whatever zone the runtime is in.
            expect(isCalendarDayKey(new Date('2026-07-11T00:00:00.000Z'))).toBe(false);
        });
    });

    describe('narrowing', () => {
        it('narrows unknown to string for the caller', () => {
            const value: unknown = '2026-07-11';

            if (!isCalendarDayKey(value)) {
                throw new Error('expected the fixture to be a day key');
            }

            // Reached only if the guard narrowed: .slice is not available on unknown.
            expect(value.slice(0, 4)).toBe('2026');
        });
    });
});

/**
 * The three service-level predicates are this module's predicate.
 *
 * Asserted by IDENTITY rather than by comparing answers over a matrix, because
 * identity is the only form that cannot drift: a future edit that gives any of
 * them its own body again fails here immediately, which is the whole point of
 * collapsing them. The matrix is still run once below, through the shared
 * predicate, on the band where they used to disagree.
 */
describe('the services share this predicate', () => {
    it('preferences.logic.isCalendarDayKey IS this predicate', () => {
        expect(preferencesIsCalendarDayKey).toBe(isCalendarDayKey);
    });

    it('mealPlan.logic.isDayKey IS this predicate', () => {
        expect(mealPlanIsDayKey).toBe(isCalendarDayKey);
    });

    it('plannedMealLog.logic.isCalendarDayKey IS this predicate', () => {
        expect(plannedMealLogIsCalendarDayKey).toBe(isCalendarDayKey);
    });

    it.each(['0000-01-01', '0001-01-01', '0004-02-29', '0050-06-15', '0099-12-31'])(
        'answers %s identically everywhere, where the three used to disagree',
        (value) => {
            const answers = [
                isCalendarDayKey(value),
                preferencesIsCalendarDayKey(value),
                mealPlanIsDayKey(value),
                plannedMealLogIsCalendarDayKey(value),
            ];

            expect(new Set(answers).size).toBe(1);
            expect(answers[0]).toBe(true);
        },
    );
});
