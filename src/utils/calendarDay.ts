/**
 * THE calendar-day-key vocabulary: the `YYYY-MM-DD` shape, and the one answer
 * to "does this name a day that exists?".
 *
 * A day key is the unit every meal-planning rule speaks in — a plan's start and
 * end, a plan day, the date an entry is logged against, the `today` a plan's
 * lifecycle is judged by. It is a CALENDAR day rather than a moment: no zone,
 * no clock, no locale (Rule backend-architecture §7). Deriving a key from an
 * instant is a different job, and it stays where it belongs, in
 * `mealPlan.logic.ts::localDayKey`, which needs the user's stored zone.
 *
 * WHY THIS IS ONE MODULE RATHER THAN A HELPER PER SERVICE. The predicate had
 * grown three separate implementations — in `preferences.logic.ts`,
 * `mealPlan.logic.ts` and `plannedMealLog.logic.ts` — and the shape regex five
 * declarations. Three implementations of one rule do not stay equal, and these
 * had already drifted: the two written as a round trip through
 * `Date.UTC(year, month - 1, day)` rejected every year before 0100, because
 * that constructor applies the legacy two-digit-year mapping and quietly reads
 * year 4 as 1904, so the round trip could not match. The table-driven one
 * accepted them. The same date was therefore a real day to
 * `PUT /meal-planning/preferences/steps/review` and not a real day to
 * `POST …/meals/:mealId/log` — one request contradicting another about the
 * calendar. Rule backend-architecture §12 puts a pure helper that several
 * services share here, and §7 wants the rule in one tested place; one
 * implementation is also the only arrangement in which "they agree" is a
 * property rather than a coincidence that has to be re-checked.
 *
 * The implementation is deliberately the table-driven one. It consults no
 * `Date`, so it has no legacy-year mapping, no rollover to trip over and no
 * runtime behaviour to depend on — it is the proleptic Gregorian calendar
 * written out, which is what a bare `YYYY-MM-DD` with no era and no zone
 * actually denotes.
 *
 * NOT in scope here, deliberately: whether a real day is a day the caller may
 * USE. A plan's permitted start window, a log date inside the plan week and a
 * plan's end against today all need today's date in the user's zone, which no
 * pure function can know; each service holds its own bound. This module answers
 * only whether the calendar contains the day.
 */

/**
 * The day-key SHAPE: four digits, two, two, separated by hyphens, and nothing
 * else in the string.
 *
 * Exported because several modules need to judge the shape in a message or a
 * slice, and because a second declaration is how the implementations drifted
 * apart in the first place. Strict on both ends on purpose: `2026-7-11` and
 * `2026-07-11T00:00:00Z` are not day keys, and accepting either would put two
 * spellings of one day into a comparison that sorts keys as strings.
 *
 * Shape alone is never enough — it admits `2026-02-30` and `2026-13-01` — so
 * every caller that can reach the calendar question asks
 * {@link isCalendarDayKey} instead.
 */
export const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Days per month in a common year, January first. February is corrected for leap years. */
const DAYS_IN_MONTH: readonly number[] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * The proleptic Gregorian leap rule: every fourth year, except centuries, except
 * every fourth century.
 *
 * Applied to the written year with no era handling, which is what makes year
 * 0004 a leap year here. That is the same answer the rule gives for 2024, and
 * the point of writing the rule out rather than asking a `Date`.
 */
const isLeapYear = (year: number): boolean =>
    (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

/**
 * Whether a value is a real `YYYY-MM-DD` calendar day.
 *
 * The shape check alone accepts `2026-02-30` and `2026-13-01`, and a plan that
 * silently started on a day that does not exist would put six of its seven days
 * somewhere the user never asked for — while an entry logged against one would
 * sit on a date the user never chose, sorting inside a plan week it is not in.
 * So the month length is computed from the calendar rules: `2026-02-30` is
 * refused, `2024-02-29` and `2000-02-29` are accepted, `1900-02-29` is not.
 *
 * Takes `unknown` and narrows, because every caller is validating input that
 * arrived as JSON or was read from a row written by an older parser.
 */
export const isCalendarDayKey = (value: unknown): value is string => {
    if (typeof value !== 'string' || !DAY_KEY_PATTERN.test(value)) {
        return false;
    }

    const [year, month, day] = value.split('-').map(Number);

    if (month < 1 || month > 12 || day < 1) {
        return false;
    }

    const lastDay = month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1];

    return day <= lastDay;
};
