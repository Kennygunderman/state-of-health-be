import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import config, {
    BRANCH_COVERAGE_THRESHOLD,
    COVERED_UTIL_MODULES,
    coverageThresholdFor,
    coverageThresholdPaths,
    coveredSourcePaths,
} from '../../../jest.config';
import { ModelBudgetError, getCatalogModelCallBudget } from '../../../scripts/lib/budget';
import {
    DEFAULT_USDA_IMPORT_RATE_LIMIT_PER_HOUR,
    USDA_VENDOR_CAP_PER_HOUR,
} from '../../../scripts/lib/rateLimiter';
import {
    CATALOG_CHECK_NAMES,
    CATALOG_QUARANTINE_CHECK_NAMES,
    CATALOG_REJECT_CHECK_NAMES,
    CATALOG_REVIEW_CHECK_NAMES,
    PER_100G_BASIS_AMOUNT,
    parseCatalogSearchRequest,
} from '../../services/catalog.logic';
import {
    EVIDENCE_ALLOWED_CONTENT_TYPES,
    EVIDENCE_ALLOWED_PORT,
    EVIDENCE_ALLOWED_SCHEME,
    EVIDENCE_FETCH_TIMEOUT_MS,
    EVIDENCE_HOST_PATTERN,
    EVIDENCE_MAX_BODY_BYTES,
    EVIDENCE_MAX_REDIRECTS,
    EVIDENCE_MAX_SNIPPET_CHARS,
    REVIEWED_RANGE_ROW_COUNT,
    REVIEWED_RANGE_TABLE,
    REVIEWED_REGISTRY_ROW_COUNT,
    REVIEWED_SUPPLEMENTAL_CIDRS,
    REVIEWED_SUPPLEMENTAL_ROW_COUNT,
} from '../../services/evidence.logic';
import { COUNT_DISPLAY_UNIT, GROCERY_EPSILON_G, plannedIngredientGrams } from '../../services/grocery.logic';
import {
    BUDGET_PENALTY_WEIGHT,
    BUDGET_TIER_1_MAX_PER_MEAL,
    BUDGET_TIER_2_MAX_PER_MEAL,
    CALORIE_TOLERANCE_RATIO,
    COOKING_TIME_TIERS,
    MACRO_TOLERANCE_ABSOLUTE_G,
    MACRO_TOLERANCE_RATIO,
    MAIN_SLOT_PORTION_MULTIPLIERS,
    MAX_EVALUATIONS_PER_DAY,
    MAX_EVALUATIONS_PER_PLAN,
    MAX_RECIPE_USES_PER_WEEK,
    MIN_ELIGIBLE_RECIPES_PER_SLOT,
    PLAN_DAY_COUNT,
    PROTEIN_TOLERANCE_OVER_G,
    PROTEIN_TOLERANCE_UNDER_G,
    PlanSeedInputs,
    REUSE_BONUS_CAP,
    REUSE_BONUS_WEIGHT,
    SNACK_PORTION_MULTIPLIERS,
    TARGET_PROXIMITY_WEIGHT,
    THREE_MEAL_CUMULATIVE_SHARES,
    THREE_PLUS_SNACK_CUMULATIVE_SHARES,
    TOLERANCE_EPSILON,
    derivePlanSeed,
    portableCandidateIdentity,
} from '../../services/mealPlan.logic';
import { NoMatchingMealsError } from '../../services/mealPlanning.errors';
import {
    EATEN_SERVINGS_DECIMALS,
    MAX_EATEN_SERVINGS,
    MIN_EATEN_SERVINGS,
    PLANNED_ENTRY_INPUT_METHOD,
    PLANNED_ENTRY_NUTRITION_PROVENANCE,
    PlannedEntryMacros,
    deriveConsumedTotals,
} from '../../services/plannedMealLog.logic';
import {
    BODY_INPUT_RANGES,
    BUDGET_CURRENCY,
    BUDGET_PER_MEAL_THRESHOLDS,
    INCHES_TO_CENTIMETERS,
    NAMED_ALLERGENS,
    POUNDS_TO_KILOGRAMS,
    STONE_TO_KILOGRAMS,
} from '../../services/preferences.logic';
import {
    BUDGET_TIER_1_MAX_COST_SCORE,
    BUDGET_TIER_2_MAX_COST_SCORE,
    HIGH_PROTEIN_MIN_ENERGY_SHARE,
    PREFERENCE_FLAG_CODES,
    QUICK_MAX_TOTAL_MINUTES,
    RecipeDietPreference,
    RecipeIngredientIdentity,
    RecipeIngredientSnapshot,
    SOURCED_CALORIE_DIVERGENCE_THRESHOLD,
    deriveDietTags,
    deriveRecipeNutrition,
    isDietCompatible,
    roundNutritionForDisplay,
    scalePlannedNutrition,
} from '../../services/recipe.logic';
import { MAX_SWAP_ALTERNATIVES } from '../../services/swap.logic';
import {
    ACTIVITY_FACTORS,
    CALORIE_CEILING,
    CALORIE_FLOOR_BY_SEX,
    CalculableEstimateInputs,
    CalculableSex,
    ESTIMATE_INPUT_RANGES,
    EstimateAvailabilityRow,
    FEASIBILITY_THRESHOLDS,
    KCAL_PER_GRAM,
    KCAL_PER_POUND_PER_WEEK_PER_DAY,
    MACRO_ENERGY_SHARES,
    MANUAL_CALORIE_RANGE,
    MANUAL_MACRO_RANGE,
    MANUAL_TARGET_FIELD_CODES,
    applyTargetBounds,
    calculateBmr,
    calculateGoalAdjustment,
    calculateTdee,
    computeTargetEstimate,
    deriveMacroTargets,
    resolveEstimateInputs,
} from '../../services/targets.logic';
import { RECIPE_BADGES, RecipePerServingNutrition } from '../../types/recipe';
import { MAX_LIMIT } from '../../utils/pagination';
import {
    GRAMS_PER_OUNCE,
    GRAMS_PER_POUND,
    MILLILITERS_PER_CUP,
    MILLILITERS_PER_TABLESPOON,
    OUNCES_PER_POUND,
    TABLESPOONS_PER_CUP,
    countPortionItems,
    formatCount,
    formatMass,
    formatQuarters,
    formatVolume,
    pluralizeCount,
    toBaseQuantity,
    unitFamily,
} from '../../utils/units';
import type { ActivityLevel, Goal, PaceLbPerWeek } from '../../types/mealPlanning';

const BACKEND_ROOT = join(__dirname, '..', '..', '..');

const SERVICES_DIRECTORY = join(BACKEND_ROOT, 'src', 'services');

const LOGIC_MODULE_SUFFIX = '.logic.ts';

const TEST_DIRECTORY_NAME = '__tests__';

// The covered utility modules and the two exclusions are spelled out HERE
// rather than imported from the config, and the services directory is read with
// this file's own `readdirSync` rather than by calling `coveredSourcePaths`. A
// test that built its expectation from the derivation it is checking would agree
// with itself no matter what the derivation said — it would stay green while a
// module silently fell out of the gate, which is the one thing this suite
// exists to prevent.
const COVERED_UTILS: readonly string[] = [
    'src/utils/units.ts',
    'src/utils/seededRandom.ts',
    'src/utils/pagination.ts',
    'src/utils/featureFlags.ts',
];

const EXCLUDED_UTILS: readonly string[] = ['src/utils/firebase.ts', 'src/utils/getUserId.ts'];

const INTEGRATION_COVERED_SUFFIXES: readonly string[] = ['.service.ts', '.mapper.ts', '.errors.ts'];

const toRepoRelativePosix = (candidate: string): string => {
    const posixCandidate = candidate.replace(/\\/g, '/').replace(/^<rootDir>\/?/, '');
    const rootPrefix = `${BACKEND_ROOT.replace(/\\/g, '/')}/`;

    return posixCandidate.startsWith(rootPrefix) ? posixCandidate.slice(rootPrefix.length) : posixCandidate;
};

const normalised = (paths: readonly string[]): string[] => paths.map(toRepoRelativePosix).sort();

const servicesDirectoryEntries = (): string[] =>
    readdirSync(SERVICES_DIRECTORY, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name);

const expectedInventory = (): string[] => {
    const logicModules = servicesDirectoryEntries()
        .filter((fileName) => fileName.endsWith(LOGIC_MODULE_SUFFIX))
        .map((fileName) => `src/services/${fileName}`);

    return normalised([...logicModules, ...COVERED_UTILS]);
};

const gatedPaths = (): string[] => normalised(coverageThresholdPaths);

const colocatedTestPathFor = (relativePath: string): string => {
    const lastSeparator = relativePath.lastIndexOf('/');
    const directory = relativePath.slice(0, lastSeparator);
    const fileName = relativePath.slice(lastSeparator + 1);

    return `${directory}/${TEST_DIRECTORY_NAME}/${fileName.replace(/\.ts$/, '.test.ts')}`;
};

const thresholdEntries = (): Record<string, { branches: number }> =>
    (config.coverageThreshold ?? {}) as Record<string, { branches: number }>;

const absentFrom = (candidates: readonly string[], present: readonly string[]): string[] =>
    candidates.filter((candidate) => !present.includes(candidate));

describe('coverage inventory', () => {
    describe('the emitted threshold key set', () => {
        it('gates every src/services/*.logic.ts that is on disk', () => {
            const forgottenModules = absentFrom(expectedInventory(), gatedPaths());

            expect(forgottenModules).toEqual([]);
        });

        it('gates no path that has since been renamed or deleted', () => {
            const orphanedEntries = absentFrom(gatedPaths(), expectedInventory());

            expect(orphanedEntries).toEqual([]);
            for (const relativePath of gatedPaths()) {
                expect(existsSync(join(BACKEND_ROOT, relativePath))).toBe(true);
            }
        });

        it('matches the on-disk inventory exactly', () => {
            expect(gatedPaths()).toEqual(expectedInventory());
        });

        it('is non-empty, so an empty gate cannot pass by matching an empty disk read', () => {
            expect(expectedInventory().length).toBeGreaterThan(0);
            expect(gatedPaths().length).toBeGreaterThan(0);
        });

        it('is the key set Jest is actually handed', () => {
            expect(normalised(Object.keys(thresholdEntries()))).toEqual(gatedPaths());
        });
    });

    describe('the covering test each gated module must have', () => {
        it('gates no module that has no colocated unit test to cover it', () => {
            const modulesWithoutATest = gatedPaths().filter(
                (relativePath) => !existsSync(join(BACKEND_ROOT, colocatedTestPathFor(relativePath))),
            );

            expect(modulesWithoutATest).toEqual([]);
        });

        it('expects the test beside the module it covers', () => {
            expect(colocatedTestPathFor('src/services/targets.logic.ts')).toBe(
                'src/services/__tests__/targets.logic.test.ts',
            );
            expect(colocatedTestPathFor('src/utils/units.ts')).toBe('src/utils/__tests__/units.test.ts');
        });
    });

    describe('the derivation behind it', () => {
        it('lists the same inventory this suite reads from disk', () => {
            expect(normalised(coveredSourcePaths())).toEqual(expectedInventory());
        });

        it('refuses to derive an empty gate when the services directory cannot be read', () => {
            const emptyRoot = mkdtempSync(join(tmpdir(), 'soh-coverage-inventory-'));

            try {
                expect(() => coveredSourcePaths(emptyRoot)).toThrow(/could not be read/);
                expect(() => coveredSourcePaths(emptyRoot)).toThrow(/empty coverage inventory/);
            } finally {
                rmSync(emptyRoot, { recursive: true, force: true });
            }
        });
    });

    describe('the pure utility modules', () => {
        it('gates exactly the ones named, and no others', () => {
            expect(normalised(COVERED_UTIL_MODULES)).toEqual(normalised(COVERED_UTILS));
        });

        it('gates each of them by name, and each is present on disk', () => {
            for (const relativePath of COVERED_UTILS) {
                expect(existsSync(join(BACKEND_ROOT, relativePath))).toBe(true);
                expect(gatedPaths()).toContain(relativePath);
            }
        });
    });

    describe('the modules it deliberately leaves to integration coverage', () => {
        it('gates no orchestration, mapper or error module from src/services', () => {
            const servicesEntries = servicesDirectoryEntries();

            for (const suffix of INTEGRATION_COVERED_SUFFIXES) {
                expect(servicesEntries.some((fileName) => fileName.endsWith(suffix))).toBe(true);
                expect(gatedPaths().filter((relativePath) => relativePath.endsWith(suffix))).toEqual([]);
            }
        });

        it('gates neither src/utils I/O boundary', () => {
            for (const relativePath of EXCLUDED_UTILS) {
                expect(existsSync(join(BACKEND_ROOT, relativePath))).toBe(true);
                expect(gatedPaths()).not.toContain(relativePath);
            }
        });

        it('gates no test file or __tests__ directory', () => {
            const testPaths = gatedPaths().filter(
                (relativePath) => relativePath.includes('__tests__') || relativePath.endsWith('.test.ts'),
            );

            expect(testPaths).toEqual([]);
        });
    });

    describe('the bar each entry enforces', () => {
        it('holds every covered module to the branch threshold on its own', () => {
            const belowTheBar = Object.entries(thresholdEntries())
                .filter(([, entry]) => entry.branches !== BRANCH_COVERAGE_THRESHOLD)
                .map(([relativePath]) => relativePath);

            expect(BRANCH_COVERAGE_THRESHOLD).toBe(80);
            expect(belowTheBar).toEqual([]);
        });

        it('constrains branches and nothing else', () => {
            const withOtherMetrics = Object.entries(thresholdEntries())
                .filter(([, entry]) => Object.keys(entry).length !== 1)
                .map(([relativePath]) => relativePath);

            expect(withOtherMetrics).toEqual([]);
        });

        it('declares no global average for a module to hide behind', () => {
            expect(Object.prototype.hasOwnProperty.call(thresholdEntries(), 'global')).toBe(false);
        });
    });

    describe('collectCoverageFrom', () => {
        it('collects exactly the files the thresholds gate, so every entry is evaluated', () => {
            expect(normalised(config.collectCoverageFrom ?? [])).toEqual(expectedInventory());
        });
    });

    describe('coverageThresholdFor', () => {
        it('emits one branch-only entry per path', () => {
            expect(coverageThresholdFor(['src/a.ts', 'src/b.ts'])).toEqual({
                'src/a.ts': { branches: BRANCH_COVERAGE_THRESHOLD },
                'src/b.ts': { branches: BRANCH_COVERAGE_THRESHOLD },
            });
        });

        it('never synthesises a global entry, whatever it is given', () => {
            expect(Object.keys(coverageThresholdFor([]))).toEqual([]);
            expect(Object.keys(coverageThresholdFor(['src/a.ts']))).toEqual(['src/a.ts']);
        });
    });

    describe('the harness the gate runs under', () => {
        it('runs the database guard from setupFiles, before any application module loads', () => {
            expect(config.setupFiles).toEqual(['<rootDir>/src/__tests__/setup/jestSetup.ts']);
            expect(config.setupFilesAfterEnv).toBeUndefined();
        });
    });
});

/* ===========================================================================
 * THE POLICY-DOCUMENT DRIFT GATE
 *
 * `docs/meal-planning/catalog-policy.md` and `docs/meal-planning/planning-policy.md`
 * are reviewed decision records, and both TRANSCRIBE values that are owned
 * somewhere else: the coverage plan, the benchmark contract, the seeded recipe
 * coverage report, and the named constants of the pure `*.logic.ts` modules. A
 * transcription is only safe while something compares it, and until this gate
 * existed nothing did — catalog-policy.md said its values "are diffed against
 * their JSON sources" while only the evidence attestation was machine-compared,
 * so every table below it could drift silently and the document went on
 * claiming otherwise.
 *
 * The shape follows `src/services/__tests__/evidence.logic.test.ts`, which
 * already parses one block out of catalog-policy.md: each gated region is
 * delimited in the document by `<!-- BEGIN/END POLICY GATE: <id> -->`, the
 * document is read off disk, and the parse is STRICT in every direction. A
 * missing document, an absent marker, a duplicated marker, a claim whose
 * pattern no longer matches, a claim that matches twice where it should match
 * once, an unparsable number, a table that is not where it was or has lost a
 * row — each of those FAILS. None of them degrades to a weaker check, because
 * a cross-check that quietly stops running is the exact state this gate exists
 * to leave behind.
 *
 * Every comparison prints both sides labelled by the file they came from, so a
 * red run names which source disagreed rather than showing two anonymous
 * numbers. Nothing here is mocked and nothing touches a database or the
 * network: the sources are JSON read off disk and the modules' own named
 * exports, and the two constants that live behind a Prisma-importing service
 * module are read out of their source text instead (see
 * `numericConstantInSource`) so this suite stays free of the Prisma client.
 *
 * Marker collision with the sibling test is impossible by construction: that
 * one delimits `EVIDENCE ALLOWLIST ATTESTATION`, these carry the `POLICY GATE`
 * prefix, and `the attestation block carries no POLICY GATE marker` asserts the
 * two never overlap.
 * =========================================================================== */

const CATALOG_POLICY_PATH = 'docs/meal-planning/catalog-policy.md';
const PLANNING_POLICY_PATH = 'docs/meal-planning/planning-policy.md';

const COVERAGE_PLAN_PATH = 'data/meal-planning/coverage-plan.v1.json';
const SEARCH_BENCHMARK_PATH = 'data/meal-planning/search-benchmark.v1.json';
const COVERAGE_REPORT_PATH = 'data/meal-planning/recipes/coverage-report.json';
const RECIPES_DIRECTORY = 'data/meal-planning/recipes';

const CATALOG_LOGIC_PATH = 'src/services/catalog.logic.ts';
const EVIDENCE_LOGIC_PATH = 'src/services/evidence.logic.ts';
const EVIDENCE_SERVICE_PATH = 'src/services/evidence.service.ts';
const GROCERY_LOGIC_PATH = 'src/services/grocery.logic.ts';
const MEAL_PLAN_LOGIC_PATH = 'src/services/mealPlan.logic.ts';
const MEAL_PLAN_SERVICE_PATH = 'src/services/mealPlan.service.ts';
const MEAL_PLANNING_ERRORS_PATH = 'src/services/mealPlanning.errors.ts';
const NUTRITION_SERVICE_PATH = 'src/services/nutrition.service.ts';
const PLANNED_MEAL_LOG_LOGIC_PATH = 'src/services/plannedMealLog.logic.ts';
const PREFERENCES_LOGIC_PATH = 'src/services/preferences.logic.ts';
const RECIPE_LOGIC_PATH = 'src/services/recipe.logic.ts';
const SWAP_LOGIC_PATH = 'src/services/swap.logic.ts';
const TARGETS_LOGIC_PATH = 'src/services/targets.logic.ts';
const USDA_SERVICE_PATH = 'src/services/usda.service.ts';
const CATALOG_CONTROLLER_PATH = 'src/controllers/catalog.controller.ts';
const MEAL_PLANNING_CONTROLLER_PATH = 'src/controllers/mealPlanning.controller.ts';
const CATALOG_TYPES_PATH = 'src/types/catalog.ts';
const MEAL_PLANNING_TYPES_PATH = 'src/types/mealPlanning.ts';
const NUTRITION_TYPES_PATH = 'src/types/nutrition.ts';
const RECIPE_TYPES_PATH = 'src/types/recipe.ts';
const SEED_RERUN_SUITE_PATH = 'src/__tests__/api/seed-rerun.test.ts';
const PAGINATION_PATH = 'src/utils/pagination.ts';
const BUDGET_LIB_PATH = 'scripts/lib/budget.ts';
const CATALOG_GENERATE_SCRIPT_PATH = 'scripts/catalog-generate-ai.ts';
const RATE_LIMITER_PATH = 'scripts/lib/rateLimiter.ts';
const UNITS_PATH = 'src/utils/units.ts';

/** Why a failure here matters, appended to every message this gate raises. */
const gateError = (detail: string): Error =>
    new Error(
        `${detail}. The policy-document drift gate compares every value ` +
            `${CATALOG_POLICY_PATH} and ${PLANNING_POLICY_PATH} transcribe against the file that owns it. ` +
            'It fails rather than skipping: a document that claims its numbers are machine-compared, and ' +
            'whose comparison has silently stopped running, is worse than one that claims nothing.',
    );

const readRepositoryFile = (relativePath: string): string => {
    try {
        return readFileSync(join(BACKEND_ROOT, relativePath), 'utf8');
    } catch (error) {
        throw gateError(`${relativePath} could not be read (${(error as Error).message})`);
    }
};

const readJsonSource = <T>(relativePath: string): T => {
    const text = readRepositoryFile(relativePath);

    try {
        return JSON.parse(text) as T;
    } catch (error) {
        throw gateError(`${relativePath} is not parsable JSON (${(error as Error).message})`);
    }
};

/**
 * A numeric constant read out of a module's SOURCE TEXT rather than imported.
 *
 * Used for exactly three kinds of value: one declared by a module that pulls in
 * the Prisma client at import (`mealPlan.service.ts`, `usda.service.ts`), one
 * that is module-private and therefore unimportable at all, and one declared by
 * a database-backed suite, whose import would run that suite's setup
 * (`seed-rerun.test.ts`'s corpus floor). All three are still values the
 * documents transcribe, so all three are still gated; the read is strict — the
 * declaration must appear exactly once in the exact form below — so a rename
 * fails loudly instead of leaving the value ungated.
 */
const numericConstantInSource = (relativePath: string, name: string): number => {
    const source = readRepositoryFile(relativePath);
    const scan = new RegExp(`\\bconst ${name} = ([0-9_]+(?:\\.[0-9]+)?);`, 'g');
    const found: string[] = [];
    let matched = scan.exec(source);

    while (matched !== null) {
        found.push(matched[1]);
        matched = scan.exec(source);
    }

    if (found.length !== 1) {
        throw gateError(
            `${relativePath} declares "const ${name} = <number>;" ${found.length} times where this gate ` +
                'expects exactly one declaration',
        );
    }

    return Number(found[0].replace(/_/g, ''));
};

/**
 * The members of an exported string-literal union, read out of a module's
 * SOURCE TEXT for the one reason an import cannot do it: a union is a TYPE, and
 * a type has no runtime value to import.
 *
 * The closed wire vocabularies these documents enumerate — the incompatibility
 * flags, the limiting-constraint keys and units, the clamp reasons, the diets,
 * the provenance grades — are declared exactly that way in `src/types/` and in
 * the logic modules. The read is as strict as the two above: exactly one
 * declaration of that name, every member a single-quoted literal, and a
 * non-empty result — so a rename, a member that is not a literal, or a
 * declaration this parser cannot read fails loudly instead of leaving the
 * vocabulary ungated.
 */
const unionMembersInSource = (relativePath: string, name: string): string[] => {
    const source = readRepositoryFile(relativePath);
    const scan = new RegExp(`\\bexport type ${name} =([^;]*);`, 'g');
    const found: string[] = [];
    let matched = scan.exec(source);

    while (matched !== null) {
        found.push(matched[1]);
        matched = scan.exec(source);
    }

    if (found.length !== 1) {
        throw gateError(
            `${relativePath} declares "export type ${name} = <members>;" ${found.length} times where this ` +
                'gate expects exactly one declaration',
        );
    }

    const members = found[0]
        .split('|')
        .map((member) => member.trim())
        .filter((member) => member.length > 0);

    if (members.length === 0) {
        throw gateError(`${relativePath}'s ${name} declares no member this gate can compare`);
    }

    return members.map((member) => {
        const literal = /^'([^']*)'$/.exec(member) ?? /^(-?\d+(?:\.\d+)?)$/.exec(member);

        if (literal === null) {
            throw gateError(
                `${relativePath}'s ${name} carries the member "${member}", which this gate cannot read as a ` +
                    'single-quoted string or a bare numeric literal',
            );
        }

        return literal[1];
    });
};

/**
 * Every string literal assigned to one property in a module's SOURCE TEXT, in
 * the order the module writes them.
 *
 * Used where the document transcribes an ORDER that no export carries: §3.7's
 * priority column is the order `analyseLimitingConstraints` pushes its rows in,
 * which is observable in the source and nowhere else. Each literal must be
 * distinct, so a duplicated row cannot make a reordered document pass.
 */
const literalSequenceInSource = (relativePath: string, property: string): string[] => {
    const source = readRepositoryFile(relativePath);
    const scan = new RegExp(`\\b${property}: '([a-z_]+)'`, 'g');
    const found: string[] = [];
    let matched = scan.exec(source);

    while (matched !== null) {
        found.push(matched[1]);
        matched = scan.exec(source);
    }

    if (found.length === 0) {
        throw gateError(`${relativePath} assigns no string literal to "${property}" for this gate to read`);
    }

    const duplicated = found.filter((literal, index) => found.indexOf(literal) !== index);

    if (duplicated.length > 0) {
        throw gateError(
            `${relativePath} assigns "${property}" the value ${describeSide(duplicated)} more than once, so ` +
                'this gate cannot read one order out of it',
        );
    }

    return found;
};

/**
 * The keys of a module-private string map, read out of its SOURCE TEXT.
 *
 * `PLURAL_EXCEPTIONS` is the case this exists for: §6.2 transcribes the closed
 * exception list, and the map is private, so its key set is observable nowhere
 * else. Strict in the same way as the readers above — one declaration, every
 * entry a `key: 'value'` pair — so a renamed map fails instead of comparing the
 * document against an empty set.
 */
const objectKeysInSource = (relativePath: string, name: string): string[] => {
    const source = readRepositoryFile(relativePath);
    const scan = new RegExp(`\\bconst ${name}(?:: [^=]+)? = \\{([^}]*)\\}`, 'g');
    const found: string[] = [];
    let matched = scan.exec(source);

    while (matched !== null) {
        found.push(matched[1]);
        matched = scan.exec(source);
    }

    if (found.length !== 1) {
        throw gateError(
            `${relativePath} declares "const ${name} = { … }" ${found.length} times where this gate expects ` +
                'exactly one declaration',
        );
    }

    const keys = found[0]
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
        .map((entry) => {
            const pair = /^([A-Za-z_][\w]*): '[^']*'$/.exec(entry);

            if (pair === null) {
                throw gateError(
                    `${relativePath}'s ${name} carries the entry "${entry}", which this gate cannot read as a ` +
                        "key: 'value' pair",
                );
            }

            return pair[1];
        });

    if (keys.length === 0) {
        throw gateError(`${relativePath}'s ${name} declares no entry this gate can compare`);
    }

    return keys;
};

/** The same strict read for a single-quoted string constant. */
const stringConstantInSource = (relativePath: string, name: string): string => {
    const source = readRepositoryFile(relativePath);
    const scan = new RegExp(`\\bconst ${name} = '([^']*)';`, 'g');
    const found: string[] = [];
    let matched = scan.exec(source);

    while (matched !== null) {
        found.push(matched[1]);
        matched = scan.exec(source);
    }

    if (found.length !== 1) {
        throw gateError(
            `${relativePath} declares "const ${name} = '<text>';" ${found.length} times where this gate ` +
                'expects exactly one declaration',
        );
    }

    return found[0];
};

/**
 * How an answered code is spelled: inline as a single-quoted literal, or as one
 * of the SCREAMING_CASE constants a controller declares beside its handlers.
 */
const ANSWERED_CODE_SPELLING = "('[a-z_]+'|[A-Z][A-Z_]+)";

/**
 * The forms an answer takes in a controller's source, as pattern SOURCES
 * compiled per read the way `distinctMatchesInSource` compiles its argument —
 * a shared `/g` regex would carry its `lastIndex` out of a read that threw
 * mid-scan and start the next one halfway down the file.
 *
 * Each captures the status first and the code second. The skip between a shared
 * helper's name and its status argument is bounded by `;` and `{`, so a pattern
 * can neither run past the end of one call into the next nor step over the body
 * literal that carries the code — and the arguments in between are read
 * whatever they are named or however the call is wrapped across lines.
 */
const ANSWERED_CODE_FORMS: readonly string[] = [
    `status\\((\\d{3})\\)\\.json\\(\\{\\s*error:\\s*${ANSWERED_CODE_SPELLING}`,
    `rejectRequest\\([^;{]*?(\\d{3}),\\s*\\{\\s*error:\\s*${ANSWERED_CODE_SPELLING}`,
    `failRequest\\([^;{]*?(\\d{3}),\\s*${ANSWERED_CODE_SPELLING}`,
];

/**
 * The HTTP status a controller answers one error code with, read out of its
 * SOURCE TEXT.
 *
 * The controllers import the Prisma-backed services, so they cannot be imported
 * here — the same reason `mealPlan.service.ts`'s values are read rather than
 * imported. What has to be read is no longer one shape: `mealPlanning.controller.ts`
 * routes its answers through shared helpers, so a status and its code sit
 * beside each other in three forms, and all three are read (`ANSWERED_CODE_FORMS`):
 *
 * - `res.status(<n>).json({ error: <code> … })` — the direct answer;
 * - `rejectRequest(res, context, error, <n>, { error: <code> … })` — the
 *   mapped-outcome helper, whose status is the fourth argument and whose code
 *   is the body literal's own `error` member;
 * - `failRequest(res, context, error, <n>, <code>)` — the server-fault helper,
 *   whose status is followed directly by the code.
 *
 * A code spelled through a named constant (`INVALID_REQUEST`, `INTERNAL_ERROR`)
 * is resolved from the same file by `stringConstantInSource` rather than
 * assumed, so it is gated exactly like an inline one.
 *
 * The read stays strict in both directions: at least one site must answer that
 * code, and every site found for it must agree on ONE status — so a code the
 * controller no longer answers, or answers from two places with two statuses,
 * fails instead of being compared against a guess. A disagreement prints the
 * statuses read and how many sites answered, because that is the whole value of
 * this gate firing.
 *
 * One form is deliberately unread, and is not an oversight:
 * `refuseInvalidRequest` answers `res.status(400).json({ error: verdict.code
 * … })`, where the code is a RUNTIME value carried by the parse verdict. No
 * text in the controller states which codes reach it, so that path contributes
 * no mapping — a gate that guessed one would be comparing a document against
 * this test's assumption instead of against the controller. The refusal code it
 * forwards is still gated through the readable mapping of the same code: the
 * `ReadOnlyFieldError` row answers `INVALID_REQUEST` with its status in form
 * two above.
 */
const statusForErrorCodeInSource = (relativePath: string, errorCode: string): number => {
    const source = readRepositoryFile(relativePath);
    const statuses: string[] = [];
    let sites = 0;

    for (const form of ANSWERED_CODE_FORMS) {
        const scan = new RegExp(form, 'g');
        let matched = scan.exec(source);

        while (matched !== null) {
            // A mapping may spell the code inline or through a named constant; the
            // constant is resolved from the same file rather than assumed, so a
            // code answered through one is gated exactly like an inline one.
            const spelled = matched[2].startsWith("'")
                ? matched[2].slice(1, -1)
                : stringConstantInSource(relativePath, matched[2]);

            if (spelled === errorCode) {
                sites += 1;

                if (!statuses.includes(matched[1])) {
                    statuses.push(matched[1]);
                }
            }
            matched = scan.exec(source);
        }
    }

    if (sites === 0) {
        throw gateError(
            `${relativePath} answers "${errorCode}" from ${sites} places where this gate expects ` +
                'exactly one status mapping for it',
        );
    }

    if (statuses.length !== 1) {
        throw gateError(
            `${relativePath} answers "${errorCode}" with ${statuses.length} distinct statuses from ` +
                `${sites} places where this gate expects exactly one status mapping for it (read: ` +
                `${describeSide(statuses)})`,
        );
    }

    return Number(statuses[0]);
};

/**
 * Every DISTINCT capture this pattern makes in a module's source text, with the
 * number of them asserted.
 *
 * The three readers above each know the shape of one declaration. This one
 * exists for the values that are not declarations at all: an algorithm named
 * inline at its only call site (`createHash('sha256')`), a status answered
 * behind a guard rather than beside a code (`parsed.kind !== 'ok'`), a literal
 * set (`new Set([...])`), and a three-way guard written as an expression. Those
 * are still values the documents transcribe, and none of them can be imported —
 * the modules that hold them reach the Prisma client.
 *
 * `expectedDistinct` is what makes the read strict: a second call site with a
 * different algorithm, a second guard answering a different status, or a member
 * added to a set changes the count and fails here, rather than silently
 * comparing the document against whichever match came first.
 */
const distinctMatchesInSource = (
    relativePath: string,
    pattern: RegExp,
    what: string,
    expectedDistinct: number,
): string[] => {
    const source = readRepositoryFile(relativePath);
    const scan = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    const found: string[] = [];
    let matched = scan.exec(source);

    while (matched !== null) {
        if (matched[1] !== undefined && !found.includes(matched[1])) {
            found.push(matched[1]);
        }
        matched = scan.exec(source);
    }

    if (found.length !== expectedDistinct) {
        throw gateError(
            `${relativePath} states ${found.length} distinct value(s) for ${what} where this gate expects ` +
                `${expectedDistinct}${found.length > 0 ? ` (read: ${describeSide(found)})` : ''}`,
        );
    }

    return found;
};

// ---------------------------------------------------------------------------
// The documents, read once off disk.
// ---------------------------------------------------------------------------

interface PolicyDocument {
    readonly path: string;
    readonly markdown: string;
}

const catalogPolicy: PolicyDocument = {
    path: CATALOG_POLICY_PATH,
    markdown: readRepositoryFile(CATALOG_POLICY_PATH),
};

const planningPolicy: PolicyDocument = {
    path: PLANNING_POLICY_PATH,
    markdown: readRepositoryFile(PLANNING_POLICY_PATH),
};

const GATE_MARKER_PATTERN = /<!-- (BEGIN|END) POLICY GATE: ([a-z0-9-]+) -->/;

const gateBeginMarker = (blockId: string): string => `<!-- BEGIN POLICY GATE: ${blockId} -->`;
const gateEndMarker = (blockId: string): string => `<!-- END POLICY GATE: ${blockId} -->`;

/** One gated region of a document, delimited and unambiguous or not returned at all. */
const gateBlock = (document: PolicyDocument, blockId: string): string => {
    const begin = document.markdown.indexOf(gateBeginMarker(blockId));
    const end = document.markdown.indexOf(gateEndMarker(blockId));

    if (begin === -1 || end === -1) {
        throw gateError(
            `${document.path} carries no ${begin === -1 ? 'BEGIN' : 'END'} POLICY GATE marker for "${blockId}"`,
        );
    }
    if (end < begin) {
        throw gateError(`${document.path} carries the END POLICY GATE marker for "${blockId}" before its BEGIN`);
    }
    if (
        document.markdown.indexOf(gateBeginMarker(blockId), begin + 1) !== -1 ||
        document.markdown.indexOf(gateEndMarker(blockId), end + 1) !== -1
    ) {
        throw gateError(`${document.path} carries more than one POLICY GATE block called "${blockId}"`);
    }

    return document.markdown.slice(begin + gateBeginMarker(blockId).length, end);
};

/** Every marker of one kind present in a document, so the gate can be checked both ways. */
const gateMarkerIds = (document: PolicyDocument, kind: 'BEGIN' | 'END'): string[] => {
    const scan = new RegExp(GATE_MARKER_PATTERN.source, 'g');
    const ids: string[] = [];
    let matched = scan.exec(document.markdown);

    while (matched !== null) {
        if (matched[1] === kind) {
            ids.push(matched[2]);
        }
        matched = scan.exec(document.markdown);
    }

    return ids.sort();
};

// ---------------------------------------------------------------------------
// Reading a value the way a document writes it.
// ---------------------------------------------------------------------------

/**
 * Prose wraps across lines and a claim should not care where. Collapsing the
 * whitespace of a block makes every pattern below a single-line pattern; table
 * rows keep their `|` boundaries, so a capture written as `[^|]*` still cannot
 * run past the end of its own cell.
 */
const flattenBlock = (markdown: string): string => markdown.replace(/\s+/g, ' ').trim();

const stripMarkup = (text: string): string => text.replace(/\*\*/g, '').replace(/`/g, '').trim();

/**
 * A number as these documents write them: thousands separators, digit-group
 * spaces (`0.453 592 37`), a Unicode minus, and a leading comparison or
 * approximation sign. Anything else throws rather than becoming `NaN`, which
 * would otherwise compare unequal to everything and report the wrong cause.
 */
const toNumber = (what: string, text: string): number => {
    const cleaned = text
        .replace(/\u2212/g, '-')
        .replace(/[\s,]/g, '')
        .replace(/^[~\u2248\u2264\u2265<>]+/, '');

    if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/i.test(cleaned)) {
        throw gateError(`"${text}" (${what}) is not a number this gate can compare`);
    }

    return Number(cleaned);
};

/**
 * The number words the prose uses where a figure reads better spelled out. A
 * closed map on purpose: an unknown word fails rather than being skipped.
 */
const WORD_NUMBERS: Readonly<Record<string, number>> = {
    zero: 0,
    half: 0.5,
    one: 1,
    two: 2,
    twice: 2,
    three: 3,
    four: 4,
    five: 5,
    seven: 7,
    eight: 8,
    ten: 10,
    seventeen: 17,
    eighteen: 18,
    nineteenth: 19,
};

const fromWord = (what: string, word: string): number => {
    const value = WORD_NUMBERS[word.toLowerCase()];

    if (value === undefined) {
        throw gateError(`"${word}" (${what}) is not a number word this gate knows`);
    }

    return value;
};

/**
 * A ratio as a percentage, rounded to one decimal.
 *
 * `0.05 * 100` is `5.000000000000001` in IEEE 754, so a document stating "5 %"
 * against a stored ratio of `0.05` would fail an exact comparison for a reason
 * that has nothing to do with drift.
 */
const asPercent = (ratio: number): number => Math.round(ratio * 1000) / 10;

const roundedTo = (value: number, decimals: number): number => {
    const scale = Math.pow(10, decimals);

    return Math.round(value * scale) / scale;
};

// ---------------------------------------------------------------------------
// One transcribed value, and the file that owns it.
// ---------------------------------------------------------------------------

/** How a captured group is read: a bare number, a spelled-out number, or text. */
type ClaimKind = 'number' | 'word' | 'text';

interface GatedClaim {
    /** What the value is, as it appears in a failure message. */
    readonly what: string;
    /** Matched against the flattened block. Every capture group is compared. */
    readonly pattern: RegExp;
    /** The repository-relative path of the file that owns the value. */
    readonly source: string;
    /** One entry per capture group, taken from that owning file — never retyped. */
    readonly expected: readonly (string | number)[];
    /** Per-group override where a group is a spelled-out number. */
    readonly kinds?: readonly ClaimKind[];
    /** How many times the pattern must match. Defaults to exactly once. */
    readonly occurrences?: number;
}

const claimMatches = (flat: string, pattern: RegExp): string[][] => {
    const scan = new RegExp(pattern.source, 'g');
    const found: string[][] = [];
    let matched = scan.exec(flat);

    while (matched !== null) {
        found.push(matched.slice(1));
        matched = scan.exec(flat);
    }

    return found;
};

/** Exactly one match's capture groups, or a failure naming the block and the claim. */
const statedGroups = (document: PolicyDocument, blockId: string, what: string, pattern: RegExp): string[] => {
    const found = claimMatches(flattenBlock(gateBlock(document, blockId)), pattern);

    if (found.length !== 1) {
        throw gateError(
            `${document.path} § ${blockId} states "${what}" ${found.length} times where this gate expects ` +
                `exactly one statement of it (pattern ${String(pattern)})`,
        );
    }

    return found[0];
};

const statedNumbers = (document: PolicyDocument, blockId: string, what: string, pattern: RegExp): number[] =>
    statedGroups(document, blockId, what, pattern).map((group) => toNumber(what, group));

const compareGatedClaim = (document: PolicyDocument, blockId: string, flat: string, claim: GatedClaim): void => {
    const occurrences = claim.occurrences ?? 1;
    const found = claimMatches(flat, claim.pattern);
    const label = `${blockId} — ${claim.what}`;

    if (found.length !== occurrences) {
        throw gateError(
            `${document.path} § ${blockId} states "${claim.what}" ${found.length} times where this gate expects ` +
                `${occurrences}\n    ${document.path} no longer carries it in the form the gate reads ` +
                `(pattern ${String(claim.pattern)})\n    ${claim.source} owns the value: ` +
                `${describeSide(claim.expected)}`,
        );
    }

    for (const groups of found) {
        const stated = groups.map((group, index) => {
            const kind: ClaimKind =
                claim.kinds?.[index] ?? (typeof claim.expected[index] === 'number' ? 'number' : 'text');

            if (kind === 'number') {
                return toNumber(claim.what, group);
            }
            if (kind === 'word') {
                return fromWord(claim.what, group);
            }

            return stripMarkup(group);
        });

        expectAgreement(label, document.path, claim.source, stated, claim.expected.slice());
    }
};

const expectGatedClaims = (document: PolicyDocument, blockId: string, claims: readonly GatedClaim[]): void => {
    const flat = flattenBlock(gateBlock(document, blockId));

    expect(claims.length).toBeGreaterThan(0);

    for (const claim of claims) {
        compareGatedClaim(document, blockId, flat, claim);
    }
};

// ---------------------------------------------------------------------------
// Tables, parsed from the raw block.
//
// Row-wise rather than by pattern, so a DELETED ROW is a failure: every table
// below asserts its row count against the source that owns the rows, and a
// table that agrees on the rows it still has cannot pass by having fewer.
// ---------------------------------------------------------------------------

interface PolicyTable {
    readonly heading: readonly string[];
    readonly rows: readonly (readonly string[])[];
}

const DELIMITER_CELL_PATTERN = /^:?-{3,}:?$/;

/** Splits on unescaped pipes only, so a cell may contain `\|` as it does in §1.8. */
const splitTableRow = (line: string): string[] => {
    const cells: string[] = [];
    let current = '';

    for (let index = 0; index < line.length; index++) {
        if (line[index] === '\\' && line[index + 1] === '|') {
            current += '|';
            index++;
            continue;
        }
        if (line[index] === '|') {
            cells.push(current);
            current = '';
            continue;
        }
        current += line[index];
    }
    cells.push(current);

    return cells.slice(1, cells.length - 1).map(stripMarkup);
};

const parsePolicyTables = (block: string): PolicyTable[] => {
    const lines = block.split('\n').map((line) => line.trim());
    const tables: PolicyTable[] = [];

    for (let index = 0; index < lines.length; index++) {
        const delimiterLine = lines[index + 1];

        if (!lines[index].startsWith('|') || delimiterLine === undefined || !delimiterLine.startsWith('|')) {
            continue;
        }

        const delimiter = splitTableRow(delimiterLine);

        if (delimiter.length === 0 || !delimiter.every((cell) => DELIMITER_CELL_PATTERN.test(cell))) {
            continue;
        }

        const rows: string[][] = [];
        let cursor = index + 2;

        while (cursor < lines.length && lines[cursor].startsWith('|')) {
            rows.push(splitTableRow(lines[cursor]));
            cursor++;
        }

        tables.push({ heading: splitTableRow(lines[index]), rows });
        index = cursor - 1;
    }

    return tables;
};

/** The one table in a block with this exact heading, or a failure saying so. */
const policyTable = (document: PolicyDocument, blockId: string, heading: readonly string[]): PolicyTable => {
    const matching = parsePolicyTables(gateBlock(document, blockId)).filter(
        (table) =>
            table.heading.length === heading.length && table.heading.every((cell, index) => cell === heading[index]),
    );

    if (matching.length !== 1) {
        throw gateError(
            `${document.path} § ${blockId} carries ${matching.length} tables headed ` +
                `[${heading.join(' | ')}] where this gate expects exactly one`,
        );
    }

    const table = matching[0];
    const ragged = table.rows.filter((row) => row.length !== heading.length);

    if (ragged.length > 0) {
        throw gateError(
            `${document.path} § ${blockId}'s [${heading.join(' | ')}] table has ${ragged.length} row(s) whose ` +
                `cell count is not ${heading.length}`,
        );
    }

    return table;
};

/** The row whose first cell is this label, or a failure naming the table. */
const tableRow = (document: PolicyDocument, blockId: string, table: PolicyTable, label: string): readonly string[] => {
    const matching = table.rows.filter((row) => row[0] === label);

    if (matching.length !== 1) {
        throw gateError(
            `${document.path} § ${blockId} carries ${matching.length} rows labelled "${label}" in its ` +
                `[${table.heading.join(' | ')}] table where this gate expects exactly one`,
        );
    }

    return matching[0];
};

/** Every backticked token in a cell or sentence, in the order it is written. */
const backtickedTokens = (text: string): string[] => {
    const scan = /`([^`]+)`/g;
    const tokens: string[] = [];
    let matched = scan.exec(text);

    while (matched !== null) {
        tokens.push(matched[1]);
        matched = scan.exec(text);
    }

    return tokens;
};

/** Every bare number in a cell, in the order it is written. */
const numbersIn = (what: string, text: string): number[] => {
    const scan = /[\d]+(?:\.\d+)?/g;
    const values: number[] = [];
    let matched = scan.exec(text);

    while (matched !== null) {
        values.push(toNumber(what, matched[0]));
        matched = scan.exec(text);
    }

    return values;
};

const MAX_PRINTED_SIDE = 240;

/** One side of a comparison, printed compactly enough to read in a failure. */
const describeSide = (value: unknown): string => {
    const printed = JSON.stringify(value) ?? String(value);

    return printed.length > MAX_PRINTED_SIDE ? `${printed.slice(0, MAX_PRINTED_SIDE)}…` : printed;
};

/**
 * One transcribed value against the file that owns it.
 *
 * The comparison is an object keyed by the two file paths so Jest's own diff
 * points at the side that changed, and the failure is then re-thrown with both
 * sides named on their own lines — a long table's diff hunk can otherwise
 * scroll the labels off the top, and "which source disagreed" is the whole
 * point of the message.
 */
const expectAgreement = (what: string, documentPath: string, source: string, stated: unknown, owned: unknown): void => {
    // The two sides are printed under keys named for the files they came from,
    // so naming ONE file for both would collapse them into a single key and
    // compare the owned value with itself — a comparison that can never fail.
    // A document's internal consistency is checked directly instead.
    if (documentPath === source) {
        throw gateError(
            `this gate was asked to compare ${documentPath} with itself about ${what}; a comparison needs the ` +
                'file that OWNS the value on one side',
        );
    }

    try {
        expect({ value: what, [documentPath]: stated, [source]: owned }).toEqual({
            value: what,
            [documentPath]: owned,
            [source]: owned,
        });
    } catch (error) {
        throw gateError(
            `${documentPath} disagrees with ${source} about ${what}\n` +
                `    ${documentPath} states: ${describeSide(stated)}\n` +
                `    ${source} owns:  ${describeSide(owned)}\n` +
                `  ${(error as Error).message}`,
        );
    }
};

/** A two-sided comparison, labelled by the file each side came from. */
const twoSided = <T>(document: PolicyDocument, what: string, source: string, stated: T, owned: T): void => {
    expectAgreement(what, document.path, source, stated, owned);
};

// ---------------------------------------------------------------------------
// Reading an ALGORITHM the way a document writes it.
//
// Some gated values are not numbers: §3.4 states a reduction (which inputs, in
// which order, joined with what, hashed how, and which bytes of the digest are
// read). A test that restated that algorithm would compare the document with
// the test rather than with the implementation, so nothing below reproduces it.
// The parameters are read out of the document, applied to the fixed inputs
// here, and the result is compared with what the exported function returns for
// the same inputs — so a change on EITHER side moves one number and fails.
// ---------------------------------------------------------------------------

/**
 * The seed inputs, keyed by `keyof PlanSeedInputs`.
 *
 * The key type is the link to the implementation: a sixth seed input cannot be
 * added to `mealPlan.logic.ts` without this map failing to compile, which is
 * what stops §3.4's "exactly five inputs" from being left behind.
 */
const SEED_INPUT_SAMPLE: Readonly<Record<keyof PlanSeedInputs, string>> = {
    userId: 'gate-user-0042',
    startDate: '2026-03-02',
    preferencesRevision: '7',
    targetsRevision: '3',
    generationAttempt: '2',
};

const seedInputSample = (): PlanSeedInputs => ({
    userId: SEED_INPUT_SAMPLE.userId,
    startDate: SEED_INPUT_SAMPLE.startDate,
    preferencesRevision: Number(SEED_INPUT_SAMPLE.preferencesRevision),
    targetsRevision: Number(SEED_INPUT_SAMPLE.targetsRevision),
    generationAttempt: Number(SEED_INPUT_SAMPLE.generationAttempt),
});

const isSeedInputField = (name: string): name is keyof PlanSeedInputs =>
    Object.prototype.hasOwnProperty.call(SEED_INPUT_SAMPLE, name);

/** The seed inputs as the document spells them, in the order it joins them. */
const documentedSeedFields = (spelled: string, separator: string): (keyof PlanSeedInputs)[] =>
    spelled.split(separator).map((field) => {
        const name = field.trim();

        if (!isSeedInputField(name)) {
            throw gateError(
                `${PLANNING_POLICY_PATH} § plan-generation names "${name}" among the seed inputs, and ` +
                    `${MEAL_PLAN_LOGIC_PATH}'s PlanSeedInputs has no such field`,
            );
        }

        return name;
    });

/**
 * A calorie figure the bounds leave alone: inside the envelope, above every
 * floor and below the ceiling. Derived from the bounds themselves, so widening
 * either of them cannot leave this probe outside the band it is meant to be in.
 */
const UNCLAMPED_PROBE_KCAL = Math.round((CALORIE_FLOOR_BY_SEX.female + CALORIE_CEILING) / 2);

/**
 * One probe per bound §1.6 tabulates, keyed by the row label that states it.
 *
 * Each probe drives `applyTargetBounds` into exactly the bound its row names
 * and returns the reason the module reports, so the document's `clampReason`
 * column is compared against behaviour rather than against a second list.
 */
const CLAMP_PROBES: Readonly<Record<string, () => string>> = {
    'Female calorie floor': () => String(applyTargetBounds(CALORIE_FLOOR_BY_SEX.female - 1, 0, 'female').clampReason),
    'Male calorie floor': () => String(applyTargetBounds(CALORIE_FLOOR_BY_SEX.male - 1, 0, 'male').clampReason),
    "The user's own basal rate": () =>
        String(applyTargetBounds(UNCLAMPED_PROBE_KCAL, UNCLAMPED_PROBE_KCAL + 1, 'female').clampReason),
    'Calorie ceiling': () => String(applyTargetBounds(CALORIE_CEILING + 1, 0, 'female').clampReason),
    'Nothing bound the figure': () => String(applyTargetBounds(UNCLAMPED_PROBE_KCAL, 0, 'female').clampReason),
};

/** A row every estimate check accepts, which the probes below then spoil one field at a time. */
const estimateRowSample = (): EstimateAvailabilityRow => ({
    goal: 'lose',
    pace_lb_per_week: 1,
    age: 30,
    height_cm: 170,
    weight_kg: 70,
    sex_for_estimate: 'female',
    activity_level: 'lightly_active',
    target_route: 'estimated',
});

/** One ingredient, so §5.1's arithmetic can be recomputed from the document's own formula. */
const recipeIngredientSample = (fiberG: number | null): RecipeIngredientSnapshot => ({
    catalog_food_id: 'gate-food-1',
    snapshot_name: 'gate ingredient',
    snapshot_provenance: 'source_backed',
    snapshot_allergen_tags: [],
    snapshot_diet_tags: ['vegan', 'vegetarian', 'pescatarian'],
    is_optional: false,
    catalog_nutrition_version: 1,
    catalog_metadata_version: 1,
    snapshot_per_100g: { calories: 120, protein_g: 9, carbs_g: 20, fat_g: 3, fiber_g: fiberG },
    quantity: 250,
    unit: 'g',
    gram_weight: 250,
    display_text: '250 g gate ingredient',
    sort_order: 1,
});

/**
 * One ingredient declaring exactly one diet tag, for the containment probe.
 *
 * Deliberately minimal: the only thing under comparison is which diets the
 * derivation implies FROM that one declaration, so nothing else about the
 * ingredient may influence the answer.
 */
const dietIngredientSample = (dietTag: string): RecipeIngredientIdentity => ({
    catalog_food_id: 'gate-diet-probe',
    snapshot_name: 'gate diet probe',
    snapshot_provenance: 'source_backed',
    snapshot_allergen_tags: [],
    snapshot_diet_tags: [dietTag],
    is_optional: false,
});

const RECIPE_YIELD_SAMPLE = 2;

const RECIPE_FIBER_SAMPLE_G = 2;

const PORTION_MULTIPLIER_SAMPLE = 1.25;

/** The per-serving figures §5.2's steps are applied to. */
const recipePerServingSample = (): RecipePerServingNutrition =>
    deriveRecipeNutrition([recipeIngredientSample(RECIPE_FIBER_SAMPLE_G)], RECIPE_YIELD_SAMPLE).perServing;

/** A stored snapshot and a fractional serving, for §5.2's rounding order. */
const PLANNED_SNAPSHOT_SAMPLE: PlannedEntryMacros = { calories: 517, protein_g: 33, carbs_g: 51, fat_g: 19 };

const EATEN_SERVINGS_SAMPLE = 1.5;

/** The operands §5.1's and §6.1's printed formulas name. */
const RECIPE_FORMULA_SAMPLE: Readonly<Record<string, number>> = {
    gram_weight: 250,
    nutrient_per_100g: 120,
    yield_servings: RECIPE_YIELD_SAMPLE,
};

const GROCERY_FORMULA_SAMPLE: Readonly<Record<string, number>> = {
    gram_weight: 320,
    yield_servings: 4,
    portion_multiplier: PORTION_MULTIPLIER_SAMPLE,
};

/** An amount awkward in every precision §6.2 states, so each row's rounding shows. */
const PRECISION_PROBE_AMOUNT = 1.234567;

/**
 * The code the controllers answer a field-level refusal with, read from the
 * controller's own constant so the gate names it the way the controller does.
 */
const INVALID_REQUEST_CODE = stringConstantInSource(MEAL_PLANNING_CONTROLLER_PATH, 'INVALID_REQUEST');

/** Quarters in one unit, so the glyph set can be sized rather than counted by hand. */
const QUARTERS_PER_DISPLAY_UNIT = 4;

/** A count portion whose head noun is one of §6.2's own examples. */
const COUNT_PORTION_SAMPLE = 'egg';

/** A token no unit family claims, for §6.2's "resolves to nothing" clause. */
const UNRECOGNISED_UNIT_SAMPLE = 'gate-not-a-unit';

/** How each precision §6.2 tabulates must render. An unknown cell fails rather than passing. */
const PRECISION_PATTERNS: Readonly<Record<string, RegExp>> = {
    // Exactly one decimal digit, not "at most one": an optional tail would let
    // a whole-number rendering satisfy a row that claims a decimal, which is
    // the row going ungated rather than the row agreeing.
    'one decimal': /^\d+\.\d$/,
    'whole numbers': /^\d+$/,
    'nearest quarter, rendered with the glyphs ¼ ½ ¾': /^(?:\d+[¼½¾]?|[¼½¾])$/,
};

const DISPLAY_FORMATTERS: Readonly<Record<string, (base: number) => { text: string; unit: string }>> = {
    mass: formatMass,
    volume: formatVolume,
};

/** `amount` of `unit`, formatted by the family that owns the unit. */
const formattedInFamily = (
    document: PolicyDocument,
    blockId: string,
    family: string,
    amount: number,
    unit: string,
): { text: string; unit: string } => {
    const format = DISPLAY_FORMATTERS[family];

    if (format === undefined) {
        throw gateError(
            `${document.path} § ${blockId} tiers the "${family}" family, which this gate has no formatter ` +
                `for — it knows ${describeSide(Object.keys(DISPLAY_FORMATTERS))}`,
        );
    }

    return format(toBaseQuantity(amount, unit).amount);
};

/** The numeral `PRECISION_PROBE_AMOUNT` of one unit renders as, whatever its family. */
const renderedNumeralFor = (document: PolicyDocument, blockId: string, token: string): string => {
    const family = unitFamily(token);

    if (family === null) {
        if (token.indexOf(COUNT_DISPLAY_UNIT) !== 0) {
            throw gateError(
                `${document.path} § ${blockId} states a precision for "${token}", which is neither a unit ` +
                    `${UNITS_PATH} recognises nor the "${COUNT_DISPLAY_UNIT}" family`,
            );
        }

        // The count portion as the structured column now carries it: one item per
        // portion, its label the sample noun.
        return formatCount(PRECISION_PROBE_AMOUNT, { amount: 1, description: COUNT_PORTION_SAMPLE }).text.split(
            ' ',
        )[0];
    }

    return formattedInFamily(document, blockId, family, PRECISION_PROBE_AMOUNT, token).text.split(' ')[0];
};

/** The members of the portable candidate identity, keyed as §3.4 names them. */
const CANDIDATE_IDENTITY_SAMPLE: Readonly<Record<string, string>> = {
    'recipe slug': 'gate-sample-grain-bowl',
    'recipe version': '3',
    'portion multiplier': '1.25',
};

/** `Buffer.readUIntBE` reads at most six bytes, so a wider slice must fail loudly. */
const MAX_READABLE_DIGEST_BYTES = 6;

/**
 * The digest of `material` under the hash the document names.
 *
 * "SHA-1" as prose is `sha1` to node:crypto, and a hash node does not provide
 * fails here rather than further down as an unexplained seed mismatch.
 */
/**
 * One code a document names, against the closed vocabulary that owns it.
 *
 * The comparison is membership rather than equality because the document names
 * ONE member of a set — the version status a plannable recipe must carry, the
 * provenance planning requires — while the set is what drifts. Filtering the
 * owning side keeps both sides derived: a renamed or deleted member empties it,
 * and the failure prints the vocabulary that no longer carries the code.
 */
const expectMembership = (
    document: PolicyDocument,
    what: string,
    source: string,
    stated: readonly string[],
    vocabulary: readonly string[],
): void => {
    twoSided(
        document,
        what,
        source,
        stated.slice().sort(),
        vocabulary.filter((member) => stated.indexOf(member) !== -1).sort(),
    );
};

/**
 * Every `<status> <code>` outcome a region quotes, against the controller that
 * answers it. Written as a scan rather than a list so a newly quoted outcome is
 * gated by being written, and a region that has stopped quoting any fails.
 */
const expectQuotedOutcomes = (document: PolicyDocument, blockId: string, controllerPath: string): void => {
    const quoted = claimMatches(flattenBlock(gateBlock(document, blockId)), /`(\d{3}) ([a-z_]+)`/);

    expect(quoted.length).toBeGreaterThan(0);

    for (const [status, code] of quoted) {
        twoSided(
            document,
            `the status it quotes with \`${code}\``,
            controllerPath,
            toNumber(`the status quoted with ${code}`, status),
            statusForErrorCodeInSource(controllerPath, code),
        );
    }
};

/**
 * The operators a printed formula may use, so a formula can be EVALUATED from
 * the document rather than reproduced in the test.
 *
 * §5.1's and §6.1's formulas are applied left to right over the operands the
 * document names, which is how they read and how the modules compute them. A
 * symbol outside this map fails rather than being skipped.
 */
const FORMULA_OPERATORS: Readonly<Record<string, (left: number, right: number) => number>> = {
    '\u00d7': (left, right) => left * right,
    '\u00f7': (left, right) => left / right,
    '+': (left, right) => left + right,
    '\u2212': (left, right) => left - right,
};

/** A printed formula's operands and operators, evaluated left to right. */
const evaluateFormula = (
    document: PolicyDocument,
    blockId: string,
    operands: readonly number[],
    operators: readonly string[],
): number => {
    if (operands.length !== operators.length + 1) {
        throw gateError(
            `${document.path} § ${blockId} prints ${operands.length} operands and ${operators.length} ` +
                'operators, which is not a formula this gate can evaluate',
        );
    }

    return operators.reduce((carried, symbol, index) => {
        const operator = FORMULA_OPERATORS[symbol];

        if (operator === undefined) {
            throw gateError(
                `${document.path} § ${blockId} prints the operator "${symbol}", which is not one of ` +
                    `${describeSide(Object.keys(FORMULA_OPERATORS))}`,
            );
        }

        return operator(carried, operands[index + 1]);
    }, operands[0]);
};

/** One operand of a printed formula, by the name the document gives it. */
const operandNamed = (
    document: PolicyDocument,
    blockId: string,
    sample: Readonly<Record<string, number>>,
    name: string,
): number => {
    if (!Object.prototype.hasOwnProperty.call(sample, name)) {
        throw gateError(
            `${document.path} § ${blockId} names "${name}" in a printed formula, which this gate has no ` +
                `sample value for — it knows ${describeSide(Object.keys(sample))}`,
        );
    }

    return sample[name];
};

/** The rounding a document may name, so "round" is read rather than assumed. */
const ROUNDING_MODES: Readonly<Record<string, (value: number) => number>> = {
    round: Math.round,
    floor: Math.floor,
    ceil: Math.ceil,
};

const roundingNamedBy = (document: PolicyDocument, blockId: string, name: string): ((value: number) => number) => {
    const mode = ROUNDING_MODES[name];

    if (mode === undefined) {
        throw gateError(
            `${document.path} § ${blockId} names "${name}" as its rounding, which is not one of ` +
                `${describeSide(Object.keys(ROUNDING_MODES))}`,
        );
    }

    return mode;
};

const digestNamedBy = (document: PolicyDocument, blockId: string, hashName: string, material: string): Buffer => {
    const algorithm = hashName.toLowerCase().replace(/-/g, '');

    try {
        return createHash(algorithm).update(material, 'utf8').digest();
    } catch (error) {
        throw gateError(
            `${document.path} § ${blockId} names "${hashName}" as its hash, which node:crypto does not ` +
                `provide as "${algorithm}" (${(error as Error).message})`,
        );
    }
};


// ---------------------------------------------------------------------------
// The sources of truth.
// ---------------------------------------------------------------------------

interface KcalRange {
    readonly min: number;
    readonly max: number;
}

interface CoveragePlanCategory {
    readonly category: string;
    readonly publishedTarget: number;
    readonly candidateVolume: number;
    readonly kcalReviewRange: KcalRange;
    readonly kcalReviewRangeByFoodState?: Readonly<Record<string, KcalRange>>;
    readonly energyMacroTolerancePercent: number;
}

interface CoveragePlan {
    readonly coveragePlanVersion: string;
    readonly batchKeyFormat: string;
    readonly batchIndexPadWidth: number;
    readonly modelCallsPerBatch: number;
    readonly defaultBatchSize: number;
    readonly candidateVolumeMultiplier: number;
    readonly candidateVolumeRounding: string;
    readonly publishedTargetTotal: number;
    readonly candidateVolumeTotal: number;
    readonly categories: readonly CoveragePlanCategory[];
    readonly validationBounds: {
        readonly maxKcalPer100g: number;
        readonly macroMassToleranceFactor: number;
        readonly energyMacroAbsoluteToleranceKcal: number;
        readonly portionConversionTolerancePercent: number;
    };
    readonly nutritionBasisRule: {
        readonly publishableBases: readonly string[];
        readonly volumeBasisRequiresDensity: boolean;
        readonly requiredDefaultPortionCount: number;
        readonly defaultPortionRequiresSourcedGramWeight: boolean;
        readonly perServingOnlyWithoutGramWeightCheck: string;
        readonly requiredNutrients: readonly string[];
        readonly nullNutrientMeansUnknown: boolean;
    };
    readonly quarantineChecks: readonly string[];
    readonly foodGroupCount: number;
    readonly foodGroups: readonly {
        readonly foodGroup: string;
        readonly category: string;
        readonly isCommonDislikeGroup?: boolean;
    }[];
}

interface SearchBenchmark {
    readonly thresholds: {
        readonly topThreeHitRate: number;
        readonly topTenHitRate: number;
        readonly maxZeroResultRate: number;
        readonly p95LatencyMs: number;
        readonly latencyLimit: number;
    };
    readonly protocol: {
        readonly warmupPasses: number;
        readonly timedPasses: number;
        readonly sequential: boolean;
        readonly connections: number;
    };
    readonly paginationCheck: {
        readonly limit: number;
        readonly pages: number;
        readonly singlePageLimit: number;
    };
}

interface CoverageCell {
    readonly diet: string;
    readonly allergen: string;
    readonly slot: string;
    readonly timeTier: number;
    readonly threshold?: number;
    readonly count: number;
}

interface SlotStratum {
    readonly floor: number | null;
    readonly count: number;
}

interface SlotComposition {
    readonly dedicatedToSlot: number;
    readonly totalEligible: number;
    readonly composition: {
        readonly vegan: SlotStratum;
        readonly furtherVegetarian: SlotStratum;
        readonly furtherPescatarian: SlotStratum;
        readonly furtherOmnivore: SlotStratum;
    };
}

interface CoverageReport {
    readonly recipeCount: number;
    readonly crossListedRecipeCount: number;
    readonly dimensions: {
        readonly diets: readonly string[];
        readonly allergens: readonly string[];
        readonly slots: readonly string[];
        readonly mainSlots: readonly string[];
        readonly timeTiers: readonly number[];
    };
    readonly repeatRule: {
        readonly maxUsesPerWeek: number;
        readonly minEligiblePerSlotForFullWeek: number;
    };
    readonly slotComposition: Readonly<Record<string, SlotComposition>>;
    readonly eligibleCounts: readonly CoverageCell[];
    readonly guaranteedCells: readonly CoverageCell[];
    readonly reducedCells: readonly CoverageCell[];
}

const coveragePlan = readJsonSource<CoveragePlan>(COVERAGE_PLAN_PATH);
const searchBenchmark = readJsonSource<SearchBenchmark>(SEARCH_BENCHMARK_PATH);
const coverageReport = readJsonSource<CoverageReport>(COVERAGE_REPORT_PATH);

const planCategory = (name: string): CoveragePlanCategory => {
    const matching = coveragePlan.categories.filter((category) => category.category === name);

    if (matching.length !== 1) {
        throw gateError(`${COVERAGE_PLAN_PATH} carries ${matching.length} categories called "${name}"`);
    }

    return matching[0];
};

const sumOf = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);

const distinct = <T>(values: readonly T[]): T[] => values.filter((value, index) => values.indexOf(value) === index);

/**
 * The one threshold a promise tier's cells all carry.
 *
 * Read off the report rather than retyped, so the document's "≥ 4" and "≥ 2"
 * are compared with what the seed actually asserted. A tier whose cells carry
 * more than one threshold is a report this gate refuses to interpret.
 */
const cellThreshold = (tier: string, cells: readonly CoverageCell[]): number => {
    const thresholds = distinct(cells.map((cell) => cell.threshold));

    if (thresholds.length !== 1 || typeof thresholds[0] !== 'number') {
        throw gateError(
            `${COVERAGE_REPORT_PATH}'s ${tier} carry ${thresholds.length} distinct thresholds where this gate ` +
                'expects exactly one',
        );
    }

    return thresholds[0];
};

const GUARANTEED_CELL_THRESHOLD = cellThreshold('guaranteedCells', coverageReport.guaranteedCells);
const REDUCED_CELL_THRESHOLD = cellThreshold('reducedCells', coverageReport.reducedCells);

/** A cell as a single comparable key, so two sets of them can be compared as sets. */
const cellKey = (cell: { diet: string; allergen: string; slot: string; timeTier: number }): string =>
    `${cell.diet} | ${cell.allergen} | ${cell.slot} | ${cell.timeTier}`;

/**
 * The share of a day a swap candidate is scored against.
 *
 * `WHOLE_DAY_SHARE` is module-private in `swap.logic.ts` — deliberately, since
 * nothing outside the swap selection has a use for it — so it is read from the
 * source text rather than imported, the same way the service constants below
 * are.
 */
const WHOLE_DAY_SHARE = numericConstantInSource(SWAP_LOGIC_PATH, 'WHOLE_DAY_SHARE');

/**
 * The corpus floor both recipe-count statements are measured against.
 *
 * `seed-rerun.test.ts` is the suite that enforces it, and it is database-backed
 * — importing it would run its setup — so the constant is read from its source
 * text for the same reason the private and Prisma-bound ones are.
 */
const MINIMUM_RECIPE_COUNT = numericConstantInSource(SEED_RERUN_SUITE_PATH, 'MINIMUM_RECIPE_COUNT');

/** The wall-clock abort and the USDA request shapes, read from source text (see above). */
const PLAN_GENERATION_DEADLINE_MS = numericConstantInSource(MEAL_PLAN_SERVICE_PATH, 'PLAN_GENERATION_DEADLINE_MS');
const MAX_BATCH_FDC_IDS = numericConstantInSource(USDA_SERVICE_PATH, 'MAX_BATCH_FDC_IDS');
const MAX_LIST_PAGE_SIZE = numericConstantInSource(USDA_SERVICE_PATH, 'MAX_LIST_PAGE_SIZE');
const USDA_MAX_ATTEMPTS = numericConstantInSource(USDA_SERVICE_PATH, 'MAX_ATTEMPTS');
const USDA_NUTRIENT_NUMBERS: readonly string[] = [
    stringConstantInSource(USDA_SERVICE_PATH, 'NUTRIENT_PROTEIN'),
    stringConstantInSource(USDA_SERVICE_PATH, 'NUTRIENT_FAT'),
    stringConstantInSource(USDA_SERVICE_PATH, 'NUTRIENT_CARBS'),
    stringConstantInSource(USDA_SERVICE_PATH, 'NUTRIENT_CALORIES'),
];

/**
 * The registry split the attestation prose states, derived rather than retyped.
 *
 * The reviewed table carries no family column — a row's family is the form of
 * its CIDR — and the supplemental rows are excluded, which is exactly the
 * distinction the prose exists to draw: the supplemental `::/96` is an IPv6
 * block that no registry page lists, so counting it among the IPv6 registry
 * rows is the off-by-one the document warns about.
 */
const registryDerivedRows = (family: 4 | 6): number =>
    REVIEWED_RANGE_TABLE.filter(
        (row) =>
            (family === 6) === (row.cidr.indexOf(':') !== -1) &&
            REVIEWED_SUPPLEMENTAL_CIDRS.indexOf(row.cidr) === -1,
    ).length;

// ---------------------------------------------------------------------------
// The gated blocks of catalog-policy.md.
// ---------------------------------------------------------------------------

const EVIDENCE_RETRIEVAL_CLAIMS: readonly GatedClaim[] = [
    {
        what: 'the only scheme an evidence URL may use',
        pattern: /\| Scheme \| `([a-z]+)` only \|/,
        source: EVIDENCE_LOGIC_PATH,
        expected: [EVIDENCE_ALLOWED_SCHEME],
    },
    {
        what: 'the only port an evidence URL may reach',
        pattern: /\| Port \| (\d+) only; an explicit `:(\d+)` is accepted/,
        source: EVIDENCE_LOGIC_PATH,
        expected: [EVIDENCE_ALLOWED_PORT, EVIDENCE_ALLOWED_PORT],
    },
    {
        what: 'the redirect ceiling',
        pattern: /\| Redirects \| at most (\d+), each re-validated/,
        source: EVIDENCE_LOGIC_PATH,
        expected: [EVIDENCE_MAX_REDIRECTS],
    },
    {
        what: 'the whole-retrieval deadline, in seconds',
        pattern: /\| Deadline \| (\d+) s for the whole retrieval/,
        source: EVIDENCE_LOGIC_PATH,
        expected: [EVIDENCE_FETCH_TIMEOUT_MS / 1000],
    },
    {
        what: 'the decompressed body cap, in MiB',
        pattern: /\| Body cap \| (\d+) MiB measured on the \*\*decompressed\*\* body/,
        source: EVIDENCE_LOGIC_PATH,
        expected: [EVIDENCE_MAX_BODY_BYTES / 1024 / 1024],
    },
    {
        what: 'the permitted content types',
        pattern: /\| Content types \| `([^`]+)`, `([^`]+)`, `([^`]+)` \|/,
        source: EVIDENCE_LOGIC_PATH,
        expected: EVIDENCE_ALLOWED_CONTENT_TYPES,
    },
    {
        what: 'the matched-snippet cap, in characters',
        pattern: /the matched snippet \(\u2264 (\d+) characters/,
        source: EVIDENCE_LOGIC_PATH,
        expected: [EVIDENCE_MAX_SNIPPET_CHARS],
    },
];

const REGISTRY_ROW_SPLIT_CLAIMS: readonly GatedClaim[] = [
    {
        what: 'every row the reviewed address table carries',
        pattern: /(\d+) is every row the reviewed table carries/,
        source: EVIDENCE_LOGIC_PATH,
        expected: [REVIEWED_RANGE_ROW_COUNT],
    },
    {
        what: 'the registry-derived rows, and their split by registry',
        pattern: /(\d+) of them are transcriptions of the two IANA special-purpose registries \((\d+) IPv4 rows and (\d+) IPv6 rows\)/,
        source: EVIDENCE_LOGIC_PATH,
        expected: [REVIEWED_REGISTRY_ROW_COUNT, registryDerivedRows(4), registryDerivedRows(6)],
    },
    {
        what: 'the supplemental block carried for hardening',
        pattern: /and (\w+) \u2014 `([^`]+)` \u2014 is carried for hardening/,
        source: EVIDENCE_LOGIC_PATH,
        expected: [REVIEWED_SUPPLEMENTAL_ROW_COUNT, REVIEWED_SUPPLEMENTAL_CIDRS[0]],
        kinds: ['word', 'text'],
    },
    {
        what: 'the total, restated as the figure a registry count must not be presented as',
        pattern: /Presenting (\d+) as a registry-row count would misstate/,
        source: EVIDENCE_LOGIC_PATH,
        expected: [REVIEWED_RANGE_ROW_COUNT],
    },
    {
        what: 'how far a registry count would be wrong if the total were presented as one',
        pattern: /would be wrong by (\w+)\./,
        source: EVIDENCE_LOGIC_PATH,
        expected: [REVIEWED_SUPPLEMENTAL_ROW_COUNT],
        kinds: ['word'],
    },
];

const COVERAGE_TOTALS_CLAIMS: readonly GatedClaim[] = [
    {
        what: 'the published-target total',
        pattern: /\| \*\*Published target\*\* \| \*\*([\d,]+)\*\* \(product policy\) \|/,
        source: COVERAGE_PLAN_PATH,
        expected: [coveragePlan.publishedTargetTotal],
    },
    {
        what: 'the candidate-volume total',
        pattern: /\| \*\*Candidate volume\*\* \| \*\*([\d,]+)\*\* \(product policy\) \|/,
        source: COVERAGE_PLAN_PATH,
        expected: [coveragePlan.candidateVolumeTotal],
    },
    {
        what: 'the candidate-volume rule',
        pattern: /`(ceil)\(([\d.]+) \u00d7 publishedTarget\)`/,
        source: COVERAGE_PLAN_PATH,
        expected: [coveragePlan.candidateVolumeRounding, coveragePlan.candidateVolumeMultiplier],
        occurrences: 2,
    },
    {
        what: 'the acceptance rate the candidate volume is sized against',
        pattern: /sized against a historical acceptance rate of roughly (\d+) %/,
        source: COVERAGE_PLAN_PATH,
        expected: [asPercent(1 / coveragePlan.candidateVolumeMultiplier)],
    },
    {
        what: 'the acceptance rate below which the shortfall is reported',
        pattern: /if acceptance runs below (\d+) % the shortfall is reported/,
        source: COVERAGE_PLAN_PATH,
        expected: [asPercent(1 / coveragePlan.candidateVolumeMultiplier)],
    },
    {
        what: 'the per-category total row',
        pattern: /\| \*\*Total\*\* \| \*\*([\d,]+)\*\* \| \*\*([\d,]+)\*\* \|/,
        source: COVERAGE_PLAN_PATH,
        expected: [coveragePlan.publishedTargetTotal, coveragePlan.candidateVolumeTotal],
    },
];

const BATCHING_CLAIMS: readonly GatedClaim[] = [
    {
        what: 'the default batch size',
        pattern: /`defaultBatchSize` of (\d+) \(product policy\)/,
        source: COVERAGE_PLAN_PATH,
        expected: [coveragePlan.defaultBatchSize],
    },
    {
        what: 'the batch-key format',
        pattern: /\*\*Batch key\*\* = `([^`]+)`/,
        source: COVERAGE_PLAN_PATH,
        expected: [coveragePlan.batchKeyFormat],
    },
    {
        what: 'the batch-index pad width',
        pattern: /zero-based and zero-padded to (\w+) digits/,
        source: COVERAGE_PLAN_PATH,
        expected: [coveragePlan.batchIndexPadWidth],
        kinds: ['word'],
    },
];

const MODEL_BUDGET_CLAIMS: readonly GatedClaim[] = [
    {
        what: 'the model calls one batch costs',
        pattern: /share it \(`modelCallsPerBatch` is (\d+)\)/,
        source: COVERAGE_PLAN_PATH,
        expected: [coveragePlan.modelCallsPerBatch],
    },
    {
        what: 'the startup cost estimate',
        pattern: /the planned cost \(`(\d+) \u00d7 \u03a3 batches`\)/,
        source: COVERAGE_PLAN_PATH,
        expected: [coveragePlan.modelCallsPerBatch],
    },
];

/**
 * A publishable basis, split into the amount and the unit the document prints.
 *
 * `nutritionBasisRule.publishableBases` stores them as `per_100g` / `per_100ml`
 * while the document writes "per 100 g" and "per 100 ml", so the two sides are
 * compared through this split rather than by retyping either form: a basis
 * changed to a different amount in the plan then fails against the prose.
 */
const publishableBasis = (basis: string): readonly [number, string] => {
    const matched = /^per_(\d+)([a-z]+)$/.exec(basis);

    if (matched === null) {
        throw gateError(
            `${COVERAGE_PLAN_PATH} states the publishable basis "${basis}", which is not a per-amount basis ` +
                `this gate can compare against the prose form in ${CATALOG_POLICY_PATH}`,
        );
    }

    return [Number(matched[1]), matched[2]];
};

const NUTRITION_BASIS_CLAIMS: readonly GatedClaim[] = [
    {
        what: 'the two bases a publishable food may state its nutrients on',
        pattern: /states its nutrients \*\*per (\d+) ([a-z]+)\*\*, or \*\*per (\d+) ([a-z]+) together with a density\*\*/,
        source: COVERAGE_PLAN_PATH,
        expected: [
            ...publishableBasis(coveragePlan.nutritionBasisRule.publishableBases[0]),
            ...publishableBasis(coveragePlan.nutritionBasisRule.publishableBases[1]),
        ],
    },
    {
        what: 'the check a volume basis without a stored density is quarantined with',
        pattern: /a volume basis without a stored density is not convertible and is quarantined with `([a-z_]+)`/,
        source: CATALOG_LOGIC_PATH,
        expected: [CATALOG_CHECK_NAMES.MISSING_DENSITY],
    },
    {
        what: 'the number of default portions a publishable food carries',
        pattern: /It also carries \*\*exactly ([a-z]+)\*\* default portion/,
        source: COVERAGE_PLAN_PATH,
        kinds: ['word'],
        expected: [coveragePlan.nutritionBasisRule.requiredDefaultPortionCount],
    },
    {
        what: 'the check a per-serving-only record without a sourced gram weight is quarantined with',
        pattern: /no sourced gram weight is therefore \*\*quarantined\*\* with `([a-z_]+)`/,
        source: COVERAGE_PLAN_PATH,
        expected: [coveragePlan.nutritionBasisRule.perServingOnlyWithoutGramWeightCheck],
    },
    {
        what: 'the basis amount an unconvertible serving cannot be expressed on',
        pattern: /cannot be converted to the per-(\d+) g basis the recipe arithmetic/,
        source: CATALOG_LOGIC_PATH,
        expected: [PER_100G_BASIS_AMOUNT],
    },
    {
        what: 'the number of required nutrients the rule names',
        pattern: /including the ([a-z]+) required nutrients \(calories, protein, carbohydrate, fat\)/,
        source: COVERAGE_PLAN_PATH,
        kinds: ['word'],
        expected: [coveragePlan.nutritionBasisRule.requiredNutrients.length],
    },
    {
        what: 'the core-nutrient count, and the check an unknown one is quarantined with',
        pattern: /The ([a-z]+) core nutrients being unknown quarantines the row with `([a-z_]+)`/,
        source: CATALOG_LOGIC_PATH,
        kinds: ['word', 'text'],
        expected: [coveragePlan.nutritionBasisRule.requiredNutrients.length, CATALOG_CHECK_NAMES.MISSING_CORE_NUTRIENT],
    },
];

const FOOD_GROUP_CLAIMS: readonly GatedClaim[] = [
    {
        what: 'the size of the controlled food-group taxonomy',
        pattern: /controlled taxonomy of \*\*(\d+)\*\* `foodGroup` values \(product policy\)/,
        source: COVERAGE_PLAN_PATH,
        expected: [coveragePlan.foodGroupCount],
    },
    {
        what: 'the food groups that seed the suggested dislikes',
        pattern: /(\d+) are marked `isCommonDislikeGroup`/,
        source: COVERAGE_PLAN_PATH,
        expected: [coveragePlan.foodGroups.filter((group) => group.isCommonDislikeGroup === true).length],
    },
];

const USDA_VENDOR_CLAIMS: readonly GatedClaim[] = [
    {
        what: 'the basis the nutrient array the import reads is stated on',
        pattern: /the per-(\d+) g `foodNutrients` array is what this import reads/,
        source: CATALOG_LOGIC_PATH,
        expected: [PER_100G_BASIS_AMOUNT],
    },
    {
        what: "the vendor's hourly request cap",
        pattern: /USDA allows \*\*([\d,]+) requests per hour per key \(vendor\)\*\*/,
        source: RATE_LIMITER_PATH,
        expected: [USDA_VENDOR_CAP_PER_HOUR],
    },
    {
        what: "the import's default share of that cap",
        pattern: /`USDA_IMPORT_RATE_LIMIT_PER_HOUR` defaults to \*\*(\d+) \(product policy\)\*\*/,
        source: RATE_LIMITER_PATH,
        expected: [DEFAULT_USDA_IMPORT_RATE_LIMIT_PER_HOUR],
    },
    {
        what: 'the hourly headroom left for the live API',
        pattern: /leaving (\d+) an hour on the same key/,
        source: RATE_LIMITER_PATH,
        expected: [USDA_VENDOR_CAP_PER_HOUR - DEFAULT_USDA_IMPORT_RATE_LIMIT_PER_HOUR],
    },
    {
        what: 'the physical attempts one logical USDA call may cost',
        pattern: /retry behaviour of up to (\w+) physical attempts/,
        source: USDA_SERVICE_PATH,
        expected: [USDA_MAX_ATTEMPTS],
        kinds: ['word'],
    },
    {
        what: 'the two vendor request shapes that bound the import',
        pattern: /batch detail fetches take at most \*\*(\d+) FDC ids\*\* and list pages at most \*\*(\d+) rows\*\* \(both vendor\)/,
        source: USDA_SERVICE_PATH,
        expected: [MAX_BATCH_FDC_IDS, MAX_LIST_PAGE_SIZE],
    },
    {
        what: "the nutrient numbers read from USDA's data dictionary",
        pattern: /\*\*(\d+)\*\* protein, \*\*(\d+)\*\* fat, \*\*(\d+)\*\* carbohydrate, \*\*(\d+)\*\* energy in kcal \(vendor\)/,
        source: USDA_SERVICE_PATH,
        expected: USDA_NUTRIENT_NUMBERS,
        kinds: ['text', 'text', 'text', 'text'],
    },
];

const USDA_RATE_LIMIT_RECAP_CLAIMS: readonly GatedClaim[] = [
    {
        what: 'the USDA rate limit, restated among the things this policy cannot guarantee',
        pattern: /\*\*the USDA rate limit\*\* \u2014 ([\d,]+) requests an hour per key \(vendor\), of which the import uses at most (\d+)/,
        source: RATE_LIMITER_PATH,
        expected: [USDA_VENDOR_CAP_PER_HOUR, DEFAULT_USDA_IMPORT_RATE_LIMIT_PER_HOUR],
    },
];

const VALIDATION_BOUNDS_CLAIMS: readonly GatedClaim[] = [
    {
        what: 'the energy ceiling, in kcal per 100 g',
        pattern: /\| Energy ceiling \| (\d+) kcal per (\d+) g \|/,
        source: COVERAGE_PLAN_PATH,
        expected: [coveragePlan.validationBounds.maxKcalPer100g, PER_100G_BASIS_AMOUNT],
    },
    {
        what: 'the basis the cited pure-fat comparison is stated on',
        pattern: /Pure fat is about \d+ kcal per (\d+) g/,
        source: CATALOG_LOGIC_PATH,
        expected: [PER_100G_BASIS_AMOUNT],
    },
    {
        what: 'the basis a portion conversion is checked against',
        pattern: /Per-(\d+) g values and the stated portion values disagree by more/,
        source: CATALOG_LOGIC_PATH,
        expected: [PER_100G_BASIS_AMOUNT],
    },
    {
        what: 'the Atwater divisors the tolerance paragraph says fibre defeats',
        pattern: /contribute energy that `(\d+)\/(\d+)\/(\d+)` arithmetic does not predict/,
        source: TARGETS_LOGIC_PATH,
        expected: [KCAL_PER_GRAM.protein, KCAL_PER_GRAM.carbs, KCAL_PER_GRAM.fat],
    },
    {
        what: 'the macro-mass tolerance factor',
        pattern: /\| Macro-mass tolerance factor \| ([\d.]+) \|/,
        source: COVERAGE_PLAN_PATH,
        expected: [coveragePlan.validationBounds.macroMassToleranceFactor],
    },
    {
        what: 'the macro-mass tolerance as the percentage it allows',
        pattern: /allowing (\d+) % for rounding in the source/,
        source: COVERAGE_PLAN_PATH,
        expected: [asPercent(coveragePlan.validationBounds.macroMassToleranceFactor - 1)],
    },
    {
        what: 'the absolute energy tolerance, in kcal',
        pattern: /\| Absolute energy tolerance \| (\d+) kcal \|/,
        source: COVERAGE_PLAN_PATH,
        expected: [coveragePlan.validationBounds.energyMacroAbsoluteToleranceKcal],
    },
    {
        what: 'the absolute energy tolerance as the rule applies it',
        pattern: /`max\((\d+) kcal, T %\)`/,
        source: COVERAGE_PLAN_PATH,
        expected: [coveragePlan.validationBounds.energyMacroAbsoluteToleranceKcal],
    },
    {
        what: 'the portion-conversion tolerance, as a percentage',
        pattern: /\| Portion-conversion tolerance \| (\d+) % \|/,
        source: COVERAGE_PLAN_PATH,
        expected: [coveragePlan.validationBounds.portionConversionTolerancePercent],
    },
    {
        what: "protein_egg's review range, restated beside the two cases it must admit",
        pattern: /both inside `protein_egg`'s (\d+)\u2013(\d+)/,
        source: COVERAGE_PLAN_PATH,
        expected: [planCategory('protein_egg').kcalReviewRange.min, planCategory('protein_egg').kcalReviewRange.max],
    },
    {
        what: "oil_fat's energy-versus-macro tolerance",
        pattern: /so `oil_fat` gets (\d+) %/,
        source: COVERAGE_PLAN_PATH,
        expected: [planCategory('oil_fat').energyMacroTolerancePercent],
    },
    {
        what: 'the tolerance band produce and spices sit in',
        pattern: /so produce and spices get (\d+)\u2013(\d+) %/,
        source: COVERAGE_PLAN_PATH,
        expected: [
            Math.min(
                planCategory('produce_vegetable').energyMacroTolerancePercent,
                planCategory('produce_fruit').energyMacroTolerancePercent,
                planCategory('spice_herb').energyMacroTolerancePercent,
            ),
            Math.max(
                planCategory('produce_vegetable').energyMacroTolerancePercent,
                planCategory('produce_fruit').energyMacroTolerancePercent,
                planCategory('spice_herb').energyMacroTolerancePercent,
            ),
        ],
    },
];

const BENCHMARK_CLAIMS: readonly GatedClaim[] = [
    {
        what: 'the top-3 hit-rate bound',
        pattern: /\| Top-3 hit rate \| \u2265 ([\d.]+) \|/,
        source: SEARCH_BENCHMARK_PATH,
        expected: [searchBenchmark.thresholds.topThreeHitRate],
    },
    {
        what: 'the top-10 hit-rate bound',
        pattern: /\| Top-10 hit rate \| \u2265 ([\d.]+) \|/,
        source: SEARCH_BENCHMARK_PATH,
        expected: [searchBenchmark.thresholds.topTenHitRate],
    },
    {
        what: 'the zero-result ceiling',
        pattern: /\| Zero-result rate \| \u2264 ([\d.]+) \|/,
        source: SEARCH_BENCHMARK_PATH,
        expected: [searchBenchmark.thresholds.maxZeroResultRate],
    },
    {
        what: 'the p95 latency limit and the page limit it is measured at',
        pattern: /\| p95 latency \| \u2264 (\d+) ms, measured at a page limit of (\d+) \|/,
        source: SEARCH_BENCHMARK_PATH,
        expected: [searchBenchmark.thresholds.p95LatencyMs, searchBenchmark.thresholds.latencyLimit],
    },
    {
        what: 'the warm-up and timed pass counts',
        pattern: /\*\*(\w+) untimed warm-up pass\*\*, then \*\*(\w+) timed passes\*\*/,
        source: SEARCH_BENCHMARK_PATH,
        expected: [searchBenchmark.protocol.warmupPasses, searchBenchmark.protocol.timedPasses],
        kinds: ['word', 'word'],
    },
    {
        what: 'the connection count the passes run on',
        pattern: /on \*\*(\w+) connection\*\*/,
        source: SEARCH_BENCHMARK_PATH,
        expected: [searchBenchmark.protocol.connections],
        kinds: ['word'],
    },
    {
        what: 'the pagination check: pages, limit and offsets',
        pattern: /pages 1\u2013(\d+) fetched at limit (\d+) \(offsets (\d+), (\d+) and (\d+)\)/,
        source: SEARCH_BENCHMARK_PATH,
        expected: [
            searchBenchmark.paginationCheck.pages,
            searchBenchmark.paginationCheck.limit,
            0,
            searchBenchmark.paginationCheck.limit,
            searchBenchmark.paginationCheck.limit * 2,
        ],
    },
    {
        what: 'the single wide fetch the pages are compared against',
        pattern: /must concatenate to the first (\d+) food ids/,
        source: SEARCH_BENCHMARK_PATH,
        expected: [searchBenchmark.paginationCheck.singlePageLimit],
    },
    {
        what: 'the wide fetch, restated as the reason it is read in process',
        pattern: /that (\d+)-row reference is read \*\*in process\*\*/,
        source: SEARCH_BENCHMARK_PATH,
        expected: [searchBenchmark.paginationCheck.singlePageLimit],
    },
    {
        what: "the HTTP endpoint's limit floor and ceiling",
        pattern: /validates `limit` as (\d+)\u2013(\d+)/,
        source: PAGINATION_PATH,
        expected: [numericConstantInSource(PAGINATION_PATH, 'MIN_LIMIT'), MAX_LIMIT],
    },
    {
        what: 'what lowering the reference to the endpoint ceiling would cost',
        pattern: /lowering the reference to (\d+) weakens the invariant to (\w+) pages/,
        source: PAGINATION_PATH,
        expected: [MAX_LIMIT, MAX_LIMIT / searchBenchmark.paginationCheck.limit],
        kinds: ['number', 'word'],
    },
];

// ---------------------------------------------------------------------------
// The gated blocks of planning-policy.md.
// ---------------------------------------------------------------------------

const STATUS_CLAIMS: readonly GatedClaim[] = [
    {
        what: 'the authored recipe files, as the status table counts them',
        pattern: /The (\d+) authored recipe files in `data\/meal-planning\/recipes\/` \| present, against a required minimum of \d+/,
        source: COVERAGE_REPORT_PATH,
        expected: [coverageReport.recipeCount],
    },
    {
        what: 'the corpus floor that count is measured against',
        pattern: /authored recipe files in `data\/meal-planning\/recipes\/` \| present, against a required minimum of (\d+)/,
        source: SEED_RERUN_SUITE_PATH,
        expected: [MINIMUM_RECIPE_COUNT],
    },
];

const TARGET_CLAIMS: readonly GatedClaim[] = [
    {
        what: 'the daily adjustment per pound-per-week, applied in both directions',
        pattern: /applied as \u2212(\d+)\u00b7pace for loss and \+(\d+)\u00b7pace for gain/,
        source: TARGETS_LOGIC_PATH,
        expected: [KCAL_PER_POUND_PER_WEEK_PER_DAY, KCAL_PER_POUND_PER_WEEK_PER_DAY],
    },
    {
        what: 'the female calorie floor',
        pattern: /\| Female calorie floor \| ([\d,]+) kcal \|/,
        source: TARGETS_LOGIC_PATH,
        expected: [CALORIE_FLOOR_BY_SEX.female],
    },
    {
        what: 'the male calorie floor',
        pattern: /\| Male calorie floor \| ([\d,]+) kcal \|/,
        source: TARGETS_LOGIC_PATH,
        expected: [CALORIE_FLOOR_BY_SEX.male],
    },
    {
        what: 'the calorie ceiling',
        pattern: /\| Calorie ceiling \| ([\d,]+) kcal \|/,
        source: TARGETS_LOGIC_PATH,
        expected: [CALORIE_CEILING],
    },
    {
        what: 'the hand-entered calorie range',
        pattern: /\| `calories` \| ([\d,]+)\u2013([\d,]+), integer \|/,
        source: TARGETS_LOGIC_PATH,
        expected: [MANUAL_CALORIE_RANGE.min, MANUAL_CALORIE_RANGE.max],
    },
    {
        what: 'the hand-entered macro range',
        pattern: /\| `protein`, `carbs`, `fat` \| (\d+)\u2013([\d,]+) g each, integer \|/,
        source: TARGETS_LOGIC_PATH,
        expected: [MANUAL_MACRO_RANGE.min, MANUAL_MACRO_RANGE.max],
    },
    {
        what: 'the macro minimum, stated as the boundary it is',
        pattern: /\*\*The macro minimum is (\d+) g, not 0\.\*\*/,
        source: TARGETS_LOGIC_PATH,
        expected: [MANUAL_MACRO_RANGE.min],
    },
    {
        what: 'the macro-energy mismatch warning threshold',
        pattern: /> (\d+) % of calories \|/,
        source: TARGETS_LOGIC_PATH,
        expected: [asPercent(FEASIBILITY_THRESHOLDS.macroEnergyMismatchRatio)],
    },
    {
        what: 'the below-catalogue-minimum warning threshold',
        pattern: /\| `below_catalog_min` \| calories < ([\d,]+) \|/,
        source: TARGETS_LOGIC_PATH,
        expected: [FEASIBILITY_THRESHOLDS.calorieMin],
    },
    {
        what: 'the above-catalogue-maximum warning threshold',
        pattern: /\| `above_catalog_max` \| calories > ([\d,]+) \|/,
        source: TARGETS_LOGIC_PATH,
        expected: [FEASIBILITY_THRESHOLDS.calorieMax],
    },
];

const PLAN_CLAIMS: readonly GatedClaim[] = [
    {
        what: "the last day of a plan's week, as an offset from its start",
        pattern: /exactly one week: `start_date` through `start_date \+ (\d+)`/,
        source: MEAL_PLAN_LOGIC_PATH,
        expected: [PLAN_DAY_COUNT - 1],
    },
    {
        what: 'the maximum uses of one recipe in a week',
        pattern: /\| Maximum uses of one recipe per week \| (\d+) \|/,
        source: MEAL_PLAN_LOGIC_PATH,
        expected: [MAX_RECIPE_USES_PER_WEEK],
    },
    {
        what: 'the repetition arithmetic behind the coverage floor',
        pattern: /at most (\w+) uses each and never adjacent, \*\*cannot\*\* be filled by (\w+) recipes and can be filled by (\w+)\./,
        source: MEAL_PLAN_LOGIC_PATH,
        expected: [MAX_RECIPE_USES_PER_WEEK, MIN_ELIGIBLE_RECIPES_PER_SLOT - 1, MIN_ELIGIBLE_RECIPES_PER_SLOT],
        kinds: ['word', 'word', 'word'],
    },
    {
        what: 'the scoring weights',
        pattern: /score = ([\d.]+) \u00b7 targetProximity \+ ([\d.]+) \u00b7 budgetPenalty \u2212 ([\d.]+) \u00b7 reuseBonus/,
        source: MEAL_PLAN_LOGIC_PATH,
        expected: [TARGET_PROXIMITY_WEIGHT, BUDGET_PENALTY_WEIGHT, REUSE_BONUS_WEIGHT],
    },
    {
        what: "the target-proximity term's weight",
        pattern: /\| `targetProximity` \|[^|]+\| ([\d.]+) \|/,
        source: MEAL_PLAN_LOGIC_PATH,
        expected: [TARGET_PROXIMITY_WEIGHT],
    },
    {
        what: "the budget-penalty term's weight",
        pattern: /\| `budgetPenalty` \|[^|]+\| ([\d.]+) \|/,
        source: MEAL_PLAN_LOGIC_PATH,
        expected: [BUDGET_PENALTY_WEIGHT],
    },
    {
        what: "the reuse-bonus cap and the term's weight",
        pattern: /\| `reuseBonus` \| ingredients already on the week's grocery list, \*\*capped at (\d+)\*\* \| \u2212([\d.]+) \|/,
        source: MEAL_PLAN_LOGIC_PATH,
        expected: [REUSE_BONUS_CAP, REUSE_BONUS_WEIGHT],
    },
    {
        what: 'the three scoring weights, as the printed formula applies them',
        pattern:
            /```text score = ([\d.]+) · targetProximity \+ ([\d.]+) · budgetPenalty − ([\d.]+) · reuseBonus ```/,
        source: MEAL_PLAN_LOGIC_PATH,
        expected: [TARGET_PROXIMITY_WEIGHT, BUDGET_PENALTY_WEIGHT, REUSE_BONUS_WEIGHT],
    },
    {
        what: 'the reuse-bonus cap, restated as the boundary it is',
        pattern: /Beyond (\w+) shared ingredients/,
        source: MEAL_PLAN_LOGIC_PATH,
        expected: [REUSE_BONUS_CAP],
        kinds: ['word'],
    },
    {
        what: 'the evaluation budget per day',
        pattern: /\| Evaluations per day \| ([\d,]+) \|/,
        source: MEAL_PLAN_LOGIC_PATH,
        expected: [MAX_EVALUATIONS_PER_DAY],
    },
    {
        what: 'the evaluation budget per plan',
        pattern: /\| Evaluations per plan \| ([\d,]+) \|/,
        source: MEAL_PLAN_LOGIC_PATH,
        expected: [MAX_EVALUATIONS_PER_PLAN],
    },
    {
        what: 'the wall-clock abort, in seconds',
        pattern: /\| Wall-clock limit \| (\d+) s \|/,
        source: MEAL_PLAN_SERVICE_PATH,
        expected: [PLAN_GENERATION_DEADLINE_MS / 1000],
    },
    {
        what: 'the per-day budget, restated as what a re-entered day keeps spending',
        pattern: /keeps spending the same ([\d,]+), so a pathological week cannot spend ([\d,]+) per visit/,
        source: MEAL_PLAN_LOGIC_PATH,
        expected: [MAX_EVALUATIONS_PER_DAY, MAX_EVALUATIONS_PER_DAY],
    },
    {
        what: 'the day calorie tolerance, as a percentage',
        pattern: /\| Calories \| within \u00b1(\d+) % of the day target \|/,
        source: MEAL_PLAN_LOGIC_PATH,
        expected: [asPercent(CALORIE_TOLERANCE_RATIO)],
    },
    {
        what: 'the asymmetric protein band',
        pattern: /\| Protein \| from target \u2212 (\d+) g to target \+ (\d+) g \|/,
        source: MEAL_PLAN_LOGIC_PATH,
        expected: [PROTEIN_TOLERANCE_UNDER_G, PROTEIN_TOLERANCE_OVER_G],
    },
    {
        what: 'the carbohydrate band',
        pattern: /\| Carbohydrate \| within \u00b1(\d+) g \*\*or\*\* \u00b1(\d+) %, whichever is larger \|/,
        source: MEAL_PLAN_LOGIC_PATH,
        expected: [MACRO_TOLERANCE_ABSOLUTE_G, asPercent(MACRO_TOLERANCE_RATIO)],
    },
    {
        what: 'the fat band',
        pattern: /\| Fat \| within \u00b1(\d+) g \*\*or\*\* \u00b1(\d+) %, whichever is larger \|/,
        source: MEAL_PLAN_LOGIC_PATH,
        expected: [MACRO_TOLERANCE_ABSOLUTE_G, asPercent(MACRO_TOLERANCE_RATIO)],
    },
    {
        what: 'the comparison slack the inclusive bands carry',
        pattern: /every comparison carries a slack of (\S+) in the unit being compared/,
        source: MEAL_PLAN_LOGIC_PATH,
        expected: [TOLERANCE_EPSILON],
    },
    {
        what: 'the slot-coverage constraint',
        pattern: /`slot_coverage` \| a slot has \*\*(\w+)\*\* eligible recipes \|/,
        source: MEAL_PLAN_LOGIC_PATH,
        expected: [0],
        kinds: ['word'],
    },
    {
        what: 'the catalogue-coverage constraint',
        pattern: /`catalog_coverage` \| a slot has fewer than \*\*(\d+)\*\* eligible recipes \|/,
        source: MEAL_PLAN_LOGIC_PATH,
        expected: [MIN_ELIGIBLE_RECIPES_PER_SLOT],
    },
    {
        what: 'the coverage floor, named in the paragraph that qualifies it',
        pattern: /\*\*The (\w+)-recipe threshold is evaluated on/,
        source: MEAL_PLAN_LOGIC_PATH,
        expected: [MIN_ELIGIBLE_RECIPES_PER_SLOT],
        kinds: ['word'],
    },
    {
        what: 'the coverage floor the seed matrix guarantees only where it says so',
        pattern: /guarantees (\w+) only for the profiles it names/,
        source: MEAL_PLAN_LOGIC_PATH,
        expected: [MIN_ELIGIBLE_RECIPES_PER_SLOT],
        kinds: ['word'],
    },
    {
        what: 'the tolerance band the nutrition_tolerance row carries',
        pattern: /reports the tolerance \*\*band\*\* \((\d+), `percent`\)/,
        source: MEAL_PLAN_LOGIC_PATH,
        expected: [asPercent(CALORIE_TOLERANCE_RATIO)],
    },
    {
        what: 'the tier-1 recipe cost-score ceiling',
        pattern: /\| \u2264 (\d+\.\d+) \| 1 \|/,
        source: RECIPE_LOGIC_PATH,
        expected: [BUDGET_TIER_1_MAX_COST_SCORE],
    },
    {
        what: 'the tier-2 recipe cost-score ceiling',
        pattern: /\| \u2264 (\d+\.\d+) \| 2 \|/,
        source: RECIPE_LOGIC_PATH,
        expected: [BUDGET_TIER_2_MAX_COST_SCORE],
    },
    {
        what: 'the cost score above which a recipe is tier 3',
        pattern: /\| > (\d+\.\d+) \| 3 \|/,
        source: RECIPE_LOGIC_PATH,
        expected: [BUDGET_TIER_2_MAX_COST_SCORE],
    },
    {
        what: 'the days a weekly budget is spread over',
        pattern: /perMeal = amount \u00f7 \(meals per day \u00d7 (\d+)\)/,
        source: MEAL_PLAN_LOGIC_PATH,
        expected: [PLAN_DAY_COUNT],
    },
    {
        what: 'the per-meal amount below which the user is tier 1',
        pattern: /\| < (\d+) \| 1 \|/,
        source: MEAL_PLAN_LOGIC_PATH,
        expected: [BUDGET_TIER_1_MAX_PER_MEAL],
    },
    {
        what: 'the inclusive per-meal band of tier 2',
        pattern: /\| (\d+) to (\d+) inclusive \| 2 \|/,
        source: MEAL_PLAN_LOGIC_PATH,
        expected: [BUDGET_TIER_1_MAX_PER_MEAL, BUDGET_TIER_2_MAX_PER_MEAL],
    },
    {
        what: 'the per-meal amount above which the user is tier 3',
        pattern: /\| > (\d+) \| 3 \|/,
        source: MEAL_PLAN_LOGIC_PATH,
        expected: [BUDGET_TIER_2_MAX_PER_MEAL],
    },
    {
        what: 'the two per-meal boundaries, stated as belonging to the middle band',
        pattern: /exactly (\d+) and exactly (\d+) are the middle band/,
        source: MEAL_PLAN_LOGIC_PATH,
        expected: [BUDGET_TIER_1_MAX_PER_MEAL, BUDGET_TIER_2_MAX_PER_MEAL],
    },
    {
        what: 'the two per-meal boundaries, stated as currency-bound',
        pattern: /the numbers (\d+) and (\d+) are not currency-neutral/,
        source: MEAL_PLAN_LOGIC_PATH,
        expected: [BUDGET_TIER_1_MAX_PER_MEAL, BUDGET_TIER_2_MAX_PER_MEAL],
    },
    {
        what: 'the only currency a budget amount may name',
        pattern: /The amount is \*\*(\w+)\*\*/,
        source: PREFERENCES_LOGIC_PATH,
        expected: [BUDGET_CURRENCY],
    },
    {
        what: 'the cooking-time tiers a user may choose',
        pattern: /limits the user may choose are (\d+), (\d+), (\d+) and (\d+) minutes, ascending/,
        source: MEAL_PLAN_LOGIC_PATH,
        expected: COOKING_TIME_TIERS,
    },
];

const SWAP_CLAIMS: readonly GatedClaim[] = [
    {
        what: 'the share of the day a swap candidate is judged against',
        pattern: /A swap is judged against the \*\*whole\*\* day, with a share of (\d+)/,
        source: SWAP_LOGIC_PATH,
        expected: [WHOLE_DAY_SHARE],
    },
    {
        what: 'the bound on the alternatives offered',
        pattern: /\*\*The offer is bounded at (\d+) alternatives\*\*/,
        source: SWAP_LOGIC_PATH,
        expected: [MAX_SWAP_ALTERNATIVES],
    },
    {
        what: 'the bound, restated as what truncating after ranking buys',
        pattern: /so the (\w+) rows are the (\w+) best rather than the first (\w+) the catalogue yielded/,
        source: SWAP_LOGIC_PATH,
        expected: [MAX_SWAP_ALTERNATIVES, MAX_SWAP_ALTERNATIVES, MAX_SWAP_ALTERNATIVES],
        kinds: ['word', 'word', 'word'],
    },
    {
        what: 'the bound, restated as what the preview and the commit pick from',
        pattern: /the preview and the commit pick from these same (\w+)/,
        source: SWAP_LOGIC_PATH,
        expected: [MAX_SWAP_ALTERNATIVES],
        kinds: ['word'],
    },
];

const RECIPE_CLAIMS: readonly GatedClaim[] = [
    {
        what: 'the sourced-versus-Atwater divergence that is disclosed',
        pattern: /where they diverge by more than \*\*(\d+) %\*\*/,
        source: RECIPE_LOGIC_PATH,
        expected: [asPercent(SOURCED_CALORIE_DIVERGENCE_THRESHOLD)],
    },
    {
        what: 'the energy share protein must supply for the high_protein badge',
        pattern: /protein supplies \u2265 (\d+) % of the energy/,
        source: RECIPE_LOGIC_PATH,
        expected: [asPercent(HIGH_PROTEIN_MIN_ENERGY_SHARE)],
    },
    {
        what: 'the total minutes at or below which a recipe is quick',
        pattern: /`total_minutes \u2264 (\d+)`/,
        source: RECIPE_LOGIC_PATH,
        expected: [QUICK_MAX_TOTAL_MINUTES],
    },
];

const GROCERY_CLAIMS: readonly GatedClaim[] = [
    {
        what: 'the quantity-equality epsilon, in grams',
        pattern: /\| Equality epsilon \| ([\d.]+) g \|/,
        source: GROCERY_LOGIC_PATH,
        expected: [GROCERY_EPSILON_G],
    },
    {
        what: 'the epsilon, restated in words',
        pattern: /differ by less than (\w+) a gram/,
        source: GROCERY_LOGIC_PATH,
        expected: [GROCERY_EPSILON_G],
        kinds: ['word'],
    },
    {
        what: 'the mass promotion thresholds',
        pattern: /\| Mass \| lb \u2192 oz \u2192 g \| (\d+) oz \u2192 lb; ([\d.]+) g \u2192 oz \|/,
        source: UNITS_PATH,
        expected: [OUNCES_PER_POUND, roundedTo(GRAMS_PER_OUNCE, 2)],
    },
    {
        what: 'the volume promotion thresholds',
        pattern: /\| Volume \| cup \u2192 tbsp \u2192 ml \| (\d+) tbsp \u2192 cup; ([\d.]+) ml \u2192 tbsp \|/,
        source: UNITS_PATH,
        expected: [TABLESPOONS_PER_CUP, roundedTo(MILLILITERS_PER_TABLESPOON, 2)],
    },
    {
        what: 'the two outputs unit promotion makes impossible',
        pattern: /"([\d.]+) oz" and "(\d+) tbsp" are impossible outputs/,
        source: UNITS_PATH,
        expected: [OUNCES_PER_POUND, TABLESPOONS_PER_CUP],
    },
];

const LOG_CLAIMS: readonly GatedClaim[] = [
    {
        what: 'the eaten-servings envelope and its precision, stated in prose',
        pattern: /within ([\d.]+) to (\d+) servings at (\w+) decimal places/,
        source: PLANNED_MEAL_LOG_LOGIC_PATH,
        expected: [MIN_EATEN_SERVINGS, MAX_EATEN_SERVINGS, EATEN_SERVINGS_DECIMALS],
        kinds: ['number', 'number', 'word'],
    },
    {
        what: 'the minimum servings eaten',
        pattern: /\| Minimum servings eaten \| ([\d.]+) \|/,
        source: PLANNED_MEAL_LOG_LOGIC_PATH,
        expected: [MIN_EATEN_SERVINGS],
    },
    {
        what: 'the maximum servings eaten',
        pattern: /\| Maximum servings eaten \| (\d+) \|/,
        source: PLANNED_MEAL_LOG_LOGIC_PATH,
        expected: [MAX_EATEN_SERVINGS],
    },
    {
        what: 'the decimal places an eaten fraction is stored at',
        pattern: /\| Decimal places \| (\d+) \|/,
        source: PLANNED_MEAL_LOG_LOGIC_PATH,
        expected: [EATEN_SERVINGS_DECIMALS],
    },
    {
        what: "the diary entry's input method",
        pattern: /the origin \(`input_method = '([a-z_]+)'`\)/,
        source: PLANNED_MEAL_LOG_LOGIC_PATH,
        expected: [PLANNED_ENTRY_INPUT_METHOD],
    },
    {
        what: "the diary entry's nutrition provenance",
        pattern: /the provenance \(`([a-z_]+)`/,
        source: PLANNED_MEAL_LOG_LOGIC_PATH,
        expected: [PLANNED_ENTRY_NUTRITION_PROVENANCE],
    },
];

const COVERAGE_MATRIX_CLAIMS: readonly GatedClaim[] = [
    {
        what: 'the seeded recipe count',
        pattern: /\*\*Recipe count: (\d+)\*\*, against a required minimum of \d+/,
        source: COVERAGE_REPORT_PATH,
        expected: [coverageReport.recipeCount],
    },
    {
        what: 'the corpus floor §5.6 measures that count against',
        pattern: /\*\*Recipe count: \d+\*\*, against a required minimum of (\d+)/,
        source: SEED_RERUN_SUITE_PATH,
        expected: [MINIMUM_RECIPE_COUNT],
    },
    {
        what: 'the cross-listed recipes',
        pattern: /(\w+) of them are cross-listed across more than one slot/,
        source: COVERAGE_REPORT_PATH,
        expected: [coverageReport.crossListedRecipeCount],
        kinds: ['word'],
    },
    {
        what: 'the dimensioning of the tabulated matrix',
        pattern: /tabulates (\d+) cells across (\d+) diets \u00d7 (\d+) allergen values \u00d7 (\d+) slots \u00d7 (\d+) cumulative time tiers/,
        source: COVERAGE_REPORT_PATH,
        expected: [
            coverageReport.eligibleCounts.length,
            coverageReport.dimensions.diets.length,
            coverageReport.dimensions.allergens.length,
            coverageReport.dimensions.slots.length,
            coverageReport.dimensions.timeTiers.length,
        ],
    },
    {
        what: 'the two promise thresholds',
        pattern: /the two promise thresholds \((\d+) and (\d+)\)/,
        source: COVERAGE_REPORT_PATH,
        expected: [coverageReport.repeatRule.minEligiblePerSlotForFullWeek, REDUCED_CELL_THRESHOLD],
    },
    {
        what: 'the two promise thresholds, attributed to the rules they come from',
        pattern: /\u2014 (\d+) is the repetition arithmetic of \u00a73\.2 and (\d+) is the coverage floor \u00a73\.7 reports against/,
        source: COVERAGE_REPORT_PATH,
        expected: [coverageReport.repeatRule.minEligiblePerSlotForFullWeek, REDUCED_CELL_THRESHOLD],
    },
    {
        what: 'why two eligible recipes are not a week',
        pattern: /(\w+) eligible recipes cannot fill (\w+) days at most (\w+) each/,
        source: COVERAGE_REPORT_PATH,
        expected: [REDUCED_CELL_THRESHOLD, PLAN_DAY_COUNT, coverageReport.repeatRule.maxUsesPerWeek],
        kinds: ['word', 'word', 'word'],
    },
    {
        what: 'the tightest tier, and the only diet guaranteed at it',
        pattern: /the (\d+)-minute tier is guaranteed only for the `none` diet/,
        source: COVERAGE_REPORT_PATH,
        expected: [coverageReport.dimensions.timeTiers[0]],
    },
    {
        what: 'the tiers a looser promise says nothing about',
        pattern: /a cell promised at (\d+) minutes says nothing about the same profile at (\d+) or (\d+)/,
        source: COVERAGE_REPORT_PATH,
        expected: [
            coverageReport.dimensions.timeTiers[2],
            coverageReport.dimensions.timeTiers[1],
            coverageReport.dimensions.timeTiers[0],
        ],
    },
];


/**
 * Every block the gate below claims, per document.
 *
 * The bidirectional check reads this: a marker in a document that is not here
 * fails (a region nobody gates while the document says it is gated), and an
 * entry here whose marker is gone fails inside `gateBlock` (a gate that would
 * otherwise quietly stop running).
 */
const CATALOG_POLICY_BLOCKS: readonly string[] = [
    'batching-contract',
    'benchmark-contract',
    'catalog-check-tiers',
    'coverage-totals-and-targets',
    'evidence-retrieval-limits',
    'food-group-taxonomy',
    'model-call-budget',
    'nutrition-basis-rule',
    'registry-row-split',
    'usda-rate-limit-recap',
    'usda-vendor-limits',
    'validation-bounds-and-review-ranges',
];

const PLANNING_POLICY_BLOCKS: readonly string[] = [
    'grocery-contract',
    'nutrition-targets',
    'plan-generation',
    'planned-meal-logging',
    'recipe-coverage-matrix',
    'recipe-rules',
    'status-at-this-commit',
    'swap-offer',
];

describe('policy-document drift gate', () => {
    describe('the markers that delimit it', () => {
        it('claims every POLICY GATE block catalog-policy.md carries, and every one it claims is there', () => {
            const declared = CATALOG_POLICY_BLOCKS.slice().sort();

            expect(gateMarkerIds(catalogPolicy, 'BEGIN')).toEqual(declared);
            expect(gateMarkerIds(catalogPolicy, 'END')).toEqual(declared);
            for (const blockId of declared) {
                expect(gateBlock(catalogPolicy, blockId).trim().length).toBeGreaterThan(0);
            }
        });

        it('claims every POLICY GATE block planning-policy.md carries, and every one it claims is there', () => {
            const declared = PLANNING_POLICY_BLOCKS.slice().sort();

            expect(gateMarkerIds(planningPolicy, 'BEGIN')).toEqual(declared);
            expect(gateMarkerIds(planningPolicy, 'END')).toEqual(declared);
            for (const blockId of declared) {
                expect(gateBlock(planningPolicy, blockId).trim().length).toBeGreaterThan(0);
            }
        });

        it('gates a non-empty set of blocks, so an empty declaration cannot pass by matching an empty document', () => {
            expect(CATALOG_POLICY_BLOCKS.length).toBeGreaterThan(0);
            expect(PLANNING_POLICY_BLOCKS.length).toBeGreaterThan(0);
        });

        it('leaves the evidence attestation block to its own suite, and cannot collide with it', () => {
            const attestationBegin = '<!-- BEGIN EVIDENCE ALLOWLIST ATTESTATION -->';
            const attestationEnd = '<!-- END EVIDENCE ALLOWLIST ATTESTATION -->';
            const begin = catalogPolicy.markdown.indexOf(attestationBegin);
            const end = catalogPolicy.markdown.indexOf(attestationEnd);

            expect(begin).toBeGreaterThan(-1);
            expect(end).toBeGreaterThan(begin);
            expect(catalogPolicy.markdown.slice(begin, end)).not.toContain('POLICY GATE');
        });

        it('fails loudly on a block it cannot find, rather than gating nothing', () => {
            expect(() => gateBlock(catalogPolicy, 'no-such-block')).toThrow(/carries no BEGIN POLICY GATE marker/);
            expect(() => gateBlock(catalogPolicy, 'no-such-block')).toThrow(/drift gate/);
        });

        it('fails loudly on a document it cannot read, rather than skipping the comparison', () => {
            expect(() => readRepositoryFile('docs/meal-planning/not-a-document.md')).toThrow(/could not be read/);
        });
    });

    describe('catalog-policy.md — the values it transcribes', () => {
        it('states the identity-evidence retrieval limits evidence.logic.ts enforces', () => {
            expectGatedClaims(catalogPolicy, 'evidence-retrieval-limits', EVIDENCE_RETRIEVAL_CLAIMS);

            // The normalized-host form is a regex, so it is compared as the
            // pattern's own source rather than as prose about it: a character
            // added to either side changes one of the two strings printed.
            const [statedHostForm] = statedGroups(
                catalogPolicy,
                'evidence-retrieval-limits',
                'the normalized host form a host must match',
                /and must then match `(\^[^`]+\$)`/,
            );

            twoSided(
                catalogPolicy,
                'the normalized host form',
                EVIDENCE_LOGIC_PATH,
                statedHostForm,
                EVIDENCE_HOST_PATTERN.source,
            );

            // The digest is named at exactly one call site, and the document
            // prints the algorithm in its published spelling; the printed form
            // is folded to the call site's spelling rather than either side
            // being retyped in the other's.
            const [statedDigest] = statedGroups(
                catalogPolicy,
                'evidence-retrieval-limits',
                'the digest a retrieval records the body under',
                /the (SHA-\d+) of the body/,
            );

            twoSided(
                catalogPolicy,
                'the recorded body digest',
                EVIDENCE_SERVICE_PATH,
                statedDigest.toLowerCase().replace(/-/g, ''),
                distinctMatchesInSource(
                    EVIDENCE_SERVICE_PATH,
                    /createHash\('([a-z0-9]+)'\)/,
                    'the digest algorithm a retrieval records',
                    1,
                )[0],
            );
        });

        it('states the reachability vocabulary the reviewed table is read with', () => {
            // `GloballyReachable` is `boolean | 'n/a'`, so the vocabulary has no
            // union of string literals to read and no runtime value to import.
            // The guard that accepts it is the one place all three are spelled,
            // and reading it there is what makes the document's "three values"
            // a comparison rather than an assertion about itself.
            const recognised = distinctMatchesInSource(
                EVIDENCE_LOGIC_PATH,
                /reachable !== (true|false|'n\/a')/,
                'the reachability values the reviewed table may carry',
                3,
            ).map((value) => value.replace(/'/g, ''));

            const [statedCount] = statedGroups(
                catalogPolicy,
                'evidence-retrieval-limits',
                'how many reachability values are kept',
                /which is why the (\w+) values are never collapsed into a boolean/,
            );

            twoSided(
                catalogPolicy,
                'the number of reachability values',
                EVIDENCE_LOGIC_PATH,
                fromWord('the reachability values', statedCount),
                recognised.length,
            );

            expectMembership(
                catalogPolicy,
                'the reachability value that is neither true nor false',
                EVIDENCE_LOGIC_PATH,
                statedGroups(
                    catalogPolicy,
                    'evidence-retrieval-limits',
                    'the non-boolean reachability value the registries state',
                    /state them, including `([a-z/]+)`/,
                ),
                recognised,
            );

            // Both places the document names the refusing values name the same
            // two, and they are exactly the recognised set minus the one value
            // that permits a fetch — so a fourth value, or a renamed one, fails
            // here instead of leaving the prose describing a vocabulary that
            // has moved on.
            const refusing = claimMatches(
                flattenBlock(gateBlock(catalogPolicy, 'evidence-retrieval-limits')),
                /reachability\s+is `([a-z/]+)` or `([a-z/]+)`/,
            );

            if (refusing.length !== 2) {
                throw gateError(
                    `${CATALOG_POLICY_PATH} § evidence-retrieval-limits names the refusing reachability values ` +
                        `${refusing.length} times where this gate expects both statements of them`,
                );
            }

            for (const stated of refusing) {
                twoSided(
                    catalogPolicy,
                    'the reachability values that refuse a fetch',
                    EVIDENCE_LOGIC_PATH,
                    [stated[0], stated[1]].slice().sort(),
                    recognised.filter((value) => value !== 'true').slice().sort(),
                );
            }
        });

        it('names the two refusals of the policy document as rejection reasons the module declares', () => {
            const stated = statedGroups(
                catalogPolicy,
                'evidence-retrieval-limits',
                'the two codes a refusal of the policy is recorded as',
                /refusal of the \*policy\* \(`([a-z_]+)`, `([a-z_]+)`\)/,
            );

            expectMembership(
                catalogPolicy,
                'the codes a refusal of the policy is recorded as',
                EVIDENCE_LOGIC_PATH,
                stated,
                unionMembersInSource(EVIDENCE_LOGIC_PATH, 'EvidenceRejectionReason'),
            );

            // The prose calls them "those two codes", so the count is compared
            // as well: a third policy-level refusal must reach the sentence.
            const [statedCount] = statedGroups(
                catalogPolicy,
                'evidence-retrieval-limits',
                'how many policy-level refusal codes there are',
                /an operator reading those (\w+) codes knows/,
            );

            const countedByWord = fromWord('the policy-level refusal codes', statedCount);

            if (countedByWord !== stated.length) {
                throw gateError(
                    `${CATALOG_POLICY_PATH} § evidence-retrieval-limits lists ${stated.length} policy-level ` +
                        `refusal code(s) and then calls them "${statedCount}", so a third one has reached the ` +
                        'list without reaching the sentence that reads it',
                );
            }
        });

        it('splits the reviewed address rows the way the reviewed table does', () => {
            expectGatedClaims(catalogPolicy, 'registry-row-split', REGISTRY_ROW_SPLIT_CLAIMS);

            // The prose's whole point is that the two counts differ by the
            // supplemental rows; assert that here so the three claims above
            // cannot agree on figures that do not add up.
            expect(REVIEWED_REGISTRY_ROW_COUNT + REVIEWED_SUPPLEMENTAL_ROW_COUNT).toBe(REVIEWED_RANGE_ROW_COUNT);
            expect(registryDerivedRows(4) + registryDerivedRows(6)).toBe(REVIEWED_REGISTRY_ROW_COUNT);
        });

        it('states the two coverage-plan totals and the rule that relates them', () => {
            expectGatedClaims(catalogPolicy, 'coverage-totals-and-targets', COVERAGE_TOTALS_CLAIMS);
        });

        it('transcribes every coverage-plan category, in the plan’s own order, and no others', () => {
            const table = policyTable(catalogPolicy, 'coverage-totals-and-targets', [
                'Category',
                'Published target',
                'Candidate volume',
            ]);
            const categoryRows = table.rows.filter((row) => row[0] !== 'Total');

            // The row count is asserted first: a table that lost a row would
            // otherwise agree on every row it still has.
            twoSided(
                catalogPolicy,
                'the number of transcribed categories',
                COVERAGE_PLAN_PATH,
                categoryRows.length,
                coveragePlan.categories.length,
            );

            twoSided(
                catalogPolicy,
                'the per-category published targets and candidate volumes',
                COVERAGE_PLAN_PATH,
                categoryRows.map((row) => ({
                    category: row[0],
                    publishedTarget: toNumber(`${row[0]} published target`, row[1]),
                    candidateVolume: toNumber(`${row[0]} candidate volume`, row[2]),
                })),
                coveragePlan.categories.map((category) => ({
                    category: category.category,
                    publishedTarget: category.publishedTarget,
                    candidateVolume: category.candidateVolume,
                })),
            );
        });

        it('states totals its own columns add up to, under its own candidate-volume rule', () => {
            twoSided(
                catalogPolicy,
                'the published-target total as the sum of its categories',
                COVERAGE_PLAN_PATH,
                coveragePlan.publishedTargetTotal,
                sumOf(coveragePlan.categories.map((category) => category.publishedTarget)),
            );
            twoSided(
                catalogPolicy,
                'the candidate-volume total as the sum of its categories',
                COVERAGE_PLAN_PATH,
                coveragePlan.candidateVolumeTotal,
                sumOf(coveragePlan.categories.map((category) => category.candidateVolume)),
            );

            const [statedRequirement, statedSlack] = statedNumbers(
                catalogPolicy,
                'coverage-totals-and-targets',
                'the slack above the requirement',
                /Above the ([\d,]+) requirement by ([\d,]+), deliberately/,
            );

            expect(coveragePlan.publishedTargetTotal - statedRequirement).toBe(statedSlack);
            expect(coveragePlan.categories.map((category) => category.candidateVolume)).toEqual(
                coveragePlan.categories.map((category) =>
                    Math.ceil(coveragePlan.candidateVolumeMultiplier * category.publishedTarget),
                ),
            );
        });

        it('states the batching contract, and a worked example its own plan produces', () => {
            expectGatedClaims(catalogPolicy, 'batching-contract', BATCHING_CLAIMS);

            // The category the example is worked through is READ from the
            // document, so the plan decides whether it exists: a renamed
            // category fails in planCategory rather than passing against a
            // literal typed into this test.
            const [statedCategory] = statedGroups(
                catalogPolicy,
                'batching-contract',
                'the category the batching example is worked through',
                /Worked example \u2014 `([a-z_]+)`, in the case where USDA contributed nothing/,
            );
            const worked = planCategory(statedCategory);
            const batches = Math.ceil(worked.candidateVolume / coveragePlan.defaultBatchSize);
            const fullBatches = batches - 1;
            const lastIndex = String(batches - 1);
            const paddedLastIndex = `${'0'.repeat(coveragePlan.batchIndexPadWidth - lastIndex.length)}${lastIndex}`;

            expect(
                statedNumbers(
                    catalogPolicy,
                    'batching-contract',
                    "the worked example's AI candidate count",
                    /AI candidates = ([\d,]+) \u2212 0 = ([\d,]+);/,
                ),
            ).toEqual([worked.candidateVolume, worked.candidateVolume]);

            expect(
                statedNumbers(
                    catalogPolicy,
                    'batching-contract',
                    "the worked example's batch count",
                    /batches = `ceil\(([\d,]+) \/ (\d+)\)` = \*\*(\d+)\*\*, indexed `0`\u2013`(\d+)`/,
                ),
            ).toEqual([worked.candidateVolume, coveragePlan.defaultBatchSize, batches, batches - 1]);

            const [statedFullBatches, statedBatchSize] = statedGroups(
                catalogPolicy,
                'batching-contract',
                "the worked example's full batches",
                /the first (\w+) hold (\d+) candidates each/,
            );

            expect(fromWord('full batches', statedFullBatches)).toBe(fullBatches);
            expect(toNumber('batch size', statedBatchSize)).toBe(coveragePlan.defaultBatchSize);

            expect(
                statedNumbers(
                    catalogPolicy,
                    'batching-contract',
                    "the worked example's tail batch",
                    /the tail batch holds `([\d,]+) \u2212 (\d+) \u00d7 (\d+)` = \*\*(\d+)\*\*/,
                ),
            ).toEqual([
                worked.candidateVolume,
                fullBatches,
                coveragePlan.defaultBatchSize,
                worked.candidateVolume - fullBatches * coveragePlan.defaultBatchSize,
            ]);

            expect(
                statedGroups(
                    catalogPolicy,
                    'batching-contract',
                    "the worked example's batch key",
                    /Its key is `([^:`]+):([^:`]+):(\d+)`/,
                ),
            ).toEqual([coveragePlan.coveragePlanVersion, worked.category, paddedLastIndex]);

            const [statedResumed, statedNext] = statedGroups(
                catalogPolicy,
                'batching-contract',
                'the batches a resume addresses',
                /continues the same (\w+) batches instead of starting a (\w+)/,
            );

            expect(fromWord('resumed batches', statedResumed)).toBe(batches);
            expect(fromWord('the batch a restart would add', statedNext)).toBe(batches + 1);
        });

        it('states what one batch costs against the model-call budget', () => {
            expectGatedClaims(catalogPolicy, 'model-call-budget', MODEL_BUDGET_CLAIMS);

            // The stop reason a crossed cap ends the run with is a wire value,
            // so it is checked against the union the script declares rather
            // than left as prose. `GenerationStopReason` is a type, so it is
            // read from the script's source text.
            expectMembership(
                catalogPolicy,
                'the stop reason a crossed budget ends the run with',
                CATALOG_GENERATE_SCRIPT_PATH,
                statedGroups(
                    catalogPolicy,
                    'model-call-budget',
                    'the stop reason a reservation past the cap produces',
                    /stops the run with\s+`([a-z_]+)`/,
                ),
                unionMembersInSource(CATALOG_GENERATE_SCRIPT_PATH, 'GenerationStopReason'),
            );
        });

        it('refuses exactly the budget values it says fail the run closed', () => {
            // The cap's admissible range is an algorithm parameter, so it is
            // compared by BEHAVIOUR: the variable name and the bound are read
            // out of the document and handed to the resolver, which decides.
            // Nothing here restates the guard — a renamed variable, a relaxed
            // bound or a default quietly added all turn one of these red.
            const [statedVariable] = statedGroups(
                catalogPolicy,
                'model-call-budget',
                'the environment variable that carries the hard cap',
                /`([A-Z_]+)` is the hard cap/,
            );
            const [statedBound] = statedNumbers(
                catalogPolicy,
                'model-call-budget',
                'the budget value at or below which the run fails closed',
                /missing, blank, non-numeric or \u2264 (\d+) fails the run closed at startup/,
            );

            const resolve = (value: string | undefined): number =>
                getCatalogModelCallBudget(value === undefined ? {} : { [statedVariable]: value });

            // "missing, blank, non-numeric or ≤ the bound" — one probe per form
            // the sentence names, each expected to fail closed.
            const refused: readonly { readonly form: string; readonly value: string | undefined }[] = [
                { form: 'missing', value: undefined },
                { form: 'blank', value: '   ' },
                { form: 'non-numeric', value: 'not-a-number' },
                { form: 'at the stated bound', value: String(statedBound) },
                { form: 'below the stated bound', value: String(statedBound - 1) },
            ];

            for (const probe of refused) {
                let thrown: unknown;

                try {
                    resolve(probe.value);
                } catch (error) {
                    thrown = error;
                }

                if (!(thrown instanceof ModelBudgetError)) {
                    throw gateError(
                        `${CATALOG_POLICY_PATH} § model-call-budget says a ${probe.form} ${statedVariable} fails ` +
                            `the run closed, but ${BUDGET_LIB_PATH} accepted it`,
                    );
                }

                twoSided(
                    catalogPolicy,
                    `the refusal of a ${probe.form} ${statedVariable}`,
                    BUDGET_LIB_PATH,
                    'budget_misconfigured',
                    thrown.code,
                );
            }

            // And the other side of the same bound: the smallest value the
            // document leaves admissible is admitted, so a document that moved
            // the bound up would fail here rather than only there.
            twoSided(
                catalogPolicy,
                `the smallest ${statedVariable} the stated bound admits`,
                BUDGET_LIB_PATH,
                statedBound + 1,
                resolve(String(statedBound + 1)),
            );
        });

        it('states the nutrition basis rule as the plan and the check names carry it', () => {
            expectGatedClaims(catalogPolicy, 'nutrition-basis-rule', NUTRITION_BASIS_CLAIMS);

            // The prose states two bases and no more, so a third basis added to
            // the plan must not pass as agreement with a document that lists two.
            twoSided(
                catalogPolicy,
                'the number of publishable bases',
                COVERAGE_PLAN_PATH,
                2,
                coveragePlan.nutritionBasisRule.publishableBases.length,
            );

            // The basis the rule EXCLUDES is a value too, and it is the one the
            // document names by hand. It is compared as the remainder: every
            // basis the type admits, less the ones the plan publishes. A basis
            // added to the type, or promoted to publishable, then fails here
            // rather than leaving the prose naming a stale exclusion.
            const publishable = coveragePlan.nutritionBasisRule.publishableBases;

            twoSided(
                catalogPolicy,
                'the basis a publishable record may not state its nutrients on',
                CATALOG_TYPES_PATH,
                statedGroups(
                    catalogPolicy,
                    'nutrition-basis-rule',
                    'the basis that is quarantined without a sourced gram weight',
                    /A `([a-z_]+)`-only record whose serving has no sourced gram weight/,
                ),
                unionMembersInSource(CATALOG_TYPES_PATH, 'CatalogNutritionBasis').filter(
                    (basis) => !publishable.includes(basis),
                ),
            );
        });

        it('states each requirement of the basis rule only while the plan still requires it', () => {
            // These three are requirements rather than values: the document
            // argues each one, so a plan that relaxed one would leave the
            // argument standing with nothing behind it. Each sentence is read
            // out of the block (absent or duplicated is a failure) and paired
            // with the flag that makes it true.
            const requirements: readonly { readonly what: string; readonly sentence: RegExp; readonly required: boolean }[] =
                [
                    {
                        what: 'that a volume basis is unusable without a stored density',
                        sentence: /millilitres never equal grams, so a volume basis without a stored density is not convertible/,
                        required: coveragePlan.nutritionBasisRule.volumeBasisRequiresDensity,
                    },
                    {
                        what: "that the default portion's gram weight is sourced",
                        sentence: /default portion, whose gram weight is \*\*sourced\*\*/,
                        required: coveragePlan.nutritionBasisRule.defaultPortionRequiresSourcedGramWeight,
                    },
                    {
                        what: 'that an unknown nutrient is never coerced to zero',
                        sentence: /A nutrient that is `NULL` means \*\*unknown\*\*, and is \*\*never coerced to 0\*\*/,
                        required: coveragePlan.nutritionBasisRule.nullNutrientMeansUnknown,
                    },
                ];

            for (const requirement of requirements) {
                statedGroups(catalogPolicy, 'nutrition-basis-rule', requirement.what, requirement.sentence);
                twoSided(catalogPolicy, requirement.what, COVERAGE_PLAN_PATH, true, requirement.required);
            }
        });

        it('states the size of the food-group taxonomy and the dislike groups in it', () => {
            expectGatedClaims(catalogPolicy, 'food-group-taxonomy', FOOD_GROUP_CLAIMS);

            twoSided(
                catalogPolicy,
                "the taxonomy's declared count against the taxonomy itself",
                COVERAGE_PLAN_PATH,
                coveragePlan.foodGroupCount,
                coveragePlan.foodGroups.length,
            );

            // The group the worked behaviour names is a member of the taxonomy,
            // not an illustration: a renamed group would leave the paragraph
            // describing an exclusion nothing can perform.
            expectMembership(
                catalogPolicy,
                'the food group the dislike behaviour is worked through',
                COVERAGE_PLAN_PATH,
                statedGroups(
                    catalogPolicy,
                    'food-group-taxonomy',
                    'the group a dislike excludes every food in',
                    /planning excludes every food in the `([a-z_]+)` group/,
                ),
                coveragePlan.foodGroups.map((group) => group.foodGroup),
            );
        });

        it('states the USDA vendor limits the import is paced and shaped by', () => {
            expectGatedClaims(catalogPolicy, 'usda-vendor-limits', USDA_VENDOR_CLAIMS);
            expectGatedClaims(catalogPolicy, 'usda-rate-limit-recap', USDA_RATE_LIMIT_RECAP_CLAIMS);

            // The status the paragraph names as a retried attempt is one of the
            // statuses the service actually retries. `RETRYABLE_STATUSES` is
            // module-private in a Prisma-bound service, so the set is read from
            // its source text with its size asserted — a status dropped from it
            // fails here rather than leaving the prose citing a retry that no
            // longer happens.
            const retryableStatuses = distinctMatchesInSource(
                USDA_SERVICE_PATH,
                /const RETRYABLE_STATUSES = new Set\(\[([^\]]+)\]\)/,
                'the vendor statuses the USDA boundary retries',
                1,
            )[0]
                .split(',')
                .map((status) => status.trim())
                .filter((status) => status.length > 0);

            expectMembership(
                catalogPolicy,
                'the vendor status a retried physical attempt follows',
                USDA_SERVICE_PATH,
                statedGroups(
                    catalogPolicy,
                    'usda-vendor-limits',
                    'the vendor status a retry follows',
                    /including retries after a (\d+) or a 5xx/,
                ),
                retryableStatuses,
            );
        });

        it('lists each validation tier as catalog.logic.ts derives it', () => {
            const flat = flattenBlock(gateBlock(catalogPolicy, 'catalog-check-tiers'));
            const tiers: readonly { readonly tier: string; readonly owned: readonly string[] }[] = [
                { tier: 'reject', owned: CATALOG_REJECT_CHECK_NAMES },
                { tier: 'quarantine', owned: CATALOG_QUARANTINE_CHECK_NAMES },
                { tier: 'review', owned: CATALOG_REVIEW_CHECK_NAMES },
            ];

            // The tier NAMES are a closed vocabulary of their own, so the set
            // this block is about is compared with the union that declares it
            // before any tier's contents are: a fourth tier, or a renamed one,
            // must reach the document rather than being silently unlisted here.
            twoSided(
                catalogPolicy,
                'the validation tiers a check can carry',
                CATALOG_TYPES_PATH,
                tiers.map(({ tier }) => tier).slice().sort(),
                unionMembersInSource(CATALOG_TYPES_PATH, 'CatalogCheckTier').slice().sort(),
            );

            for (const { tier, owned } of tiers) {
                const listed = claimMatches(flat, new RegExp(`\\*\\*\`${tier}\`\\*\\* \u2014 ([^.]+)\\.`));

                if (listed.length !== 1) {
                    throw gateError(
                        `${CATALOG_POLICY_PATH} § catalog-check-tiers states the ${tier} tier ${listed.length} ` +
                            'times where this gate expects exactly one list of it',
                    );
                }

                twoSided(
                    catalogPolicy,
                    `the ${tier}-tier checks`,
                    CATALOG_LOGIC_PATH,
                    backtickedTokens(listed[0][0]).slice().sort(),
                    owned.slice().sort(),
                );
            }

            // The quarantine tier is reviewed data as well as code, and the
            // document says so — so the third transcription is checked too.
            twoSided(
                catalogPolicy,
                'the quarantine-tier checks as reviewed data',
                COVERAGE_PLAN_PATH,
                CATALOG_QUARANTINE_CHECK_NAMES.slice().sort(),
                coveragePlan.quarantineChecks.slice().sort(),
            );
        });

        it('states the global validation bounds and the tolerances derived from them', () => {
            expectGatedClaims(catalogPolicy, 'validation-bounds-and-review-ranges', VALIDATION_BOUNDS_CLAIMS);
        });

        it('transcribes every per-category review range and tolerance, and no others', () => {
            // The heading carries the basis amount, so it is built from the
            // owned value rather than retyped: a basis change fails the heading
            // match instead of passing against a hard-coded column name.
            const table = policyTable(catalogPolicy, 'validation-bounds-and-review-ranges', [
                'Category',
                `kcal/${PER_100G_BASIS_AMOUNT} g review range`,
                'T',
            ]);

            twoSided(
                catalogPolicy,
                'the number of transcribed review ranges',
                COVERAGE_PLAN_PATH,
                table.rows.length,
                coveragePlan.categories.length,
            );

            const stated = table.rows.map((row) => {
                const rangeCell = /^(\d+)\u2013(\d+)(?: \u2014 by food state: (.+))?$/.exec(row[1]);

                if (rangeCell === null) {
                    throw gateError(
                        `${CATALOG_POLICY_PATH} § validation-bounds-and-review-ranges states the unreadable ` +
                            `review range "${row[1]}" for ${row[0]}`,
                    );
                }

                const byFoodState: Record<string, KcalRange> = {};
                const states = rangeCell[3];

                if (states !== undefined) {
                    const scan = /(\w+) (\d+)\u2013(\d+)/g;
                    let matched = scan.exec(states);

                    while (matched !== null) {
                        byFoodState[matched[1]] = { min: Number(matched[2]), max: Number(matched[3]) };
                        matched = scan.exec(states);
                    }
                }

                return {
                    category: row[0],
                    kcalReviewRange: { min: Number(rangeCell[1]), max: Number(rangeCell[2]) },
                    byFoodState,
                    energyMacroTolerancePercent: toNumber(`${row[0]} tolerance`, row[2].replace(' %', '')),
                };
            });

            twoSided(
                catalogPolicy,
                'the per-category review ranges, per-food-state bands and tolerances',
                COVERAGE_PLAN_PATH,
                stated,
                coveragePlan.categories.map((category) => ({
                    category: category.category,
                    kcalReviewRange: { min: category.kcalReviewRange.min, max: category.kcalReviewRange.max },
                    byFoodState: category.kcalReviewRangeByFoodState ?? {},
                    energyMacroTolerancePercent: category.energyMacroTolerancePercent,
                })),
            );
        });

        it('names exactly the categories whose review range the plan splits by food state', () => {
            const [statedCount] = statedGroups(
                catalogPolicy,
                'validation-bounds-and-review-ranges',
                'how many categories carry a per-food-state range',
                /are the (\w+) categories whose range is split by `food_state`/,
            );

            const split = coveragePlan.categories
                .filter((category) => category.kcalReviewRangeByFoodState !== undefined)
                .map((category) => category.category);

            twoSided(
                catalogPolicy,
                'the number of categories split by food state',
                COVERAGE_PLAN_PATH,
                fromWord('the split categories', statedCount),
                split.length,
            );

            twoSided(
                catalogPolicy,
                'the categories split by food state',
                COVERAGE_PLAN_PATH,
                statedGroups(
                    catalogPolicy,
                    'validation-bounds-and-review-ranges',
                    'the categories whose range is split by food state',
                    /`([a-z_]+)` and `([a-z_]+)` are the \w+ categories whose range is split/,
                )
                    .slice()
                    .sort(),
                split.slice().sort(),
            );

            // The same paragraph works its argument through one of them, and
            // names the two food states by name, so the category and its states
            // are compared together: membership alone would let the sentence
            // name the OTHER split category and still pass.
            const [firstState, firstFood, secondState, secondFood, workedCategory] = statedGroups(
                catalogPolicy,
                'validation-bounds-and-review-ranges',
                'the category, food and two food states the per-state argument is worked through',
                /\*\*(\w+) (\w+)\*\* and \*\*(\w+) (\w+)\*\*, each inside its own `([a-z_]+)` per-state band/,
            );

            if (firstFood !== secondFood) {
                throw gateError(
                    `${CATALOG_POLICY_PATH} § validation-bounds-and-review-ranges contrasts "${firstFood}" with ` +
                        `"${secondFood}", where this gate expects two states of one food`,
                );
            }

            expectMembership(
                catalogPolicy,
                'the category the per-state argument is worked through',
                COVERAGE_PLAN_PATH,
                [workedCategory],
                split,
            );

            // Naming the right category is load-bearing: the food the argument
            // is worked through belongs to exactly that category in the
            // taxonomy, so naming the OTHER split category fails here rather
            // than passing because both happen to split on the same states.
            const foodGroupsForFood = coveragePlan.foodGroups.filter((group) => group.foodGroup === firstFood);

            if (foodGroupsForFood.length !== 1) {
                throw gateError(
                    `${COVERAGE_PLAN_PATH} carries ${foodGroupsForFood.length} food groups called "${firstFood}", ` +
                        `which ${CATALOG_POLICY_PATH} § validation-bounds-and-review-ranges works its ` +
                        'per-state argument through',
                );
            }

            twoSided(
                catalogPolicy,
                `the category "${firstFood}" belongs to`,
                COVERAGE_PLAN_PATH,
                workedCategory,
                foodGroupsForFood[0].category,
            );
            twoSided(
                catalogPolicy,
                `the food states ${workedCategory}'s range is split into`,
                COVERAGE_PLAN_PATH,
                [firstState, secondState].slice().sort(),
                Object.keys(planCategory(workedCategory).kcalReviewRangeByFoodState ?? {})
                    .slice()
                    .sort(),
            );

            // Both cases the paragraph names must sit inside the per-state band
            // they are attributed to, which is what makes naming the right
            // category load-bearing rather than decorative.
            for (const state of [firstState, secondState]) {
                const band = (planCategory(workedCategory).kcalReviewRangeByFoodState ?? {})[state];

                if (band === undefined) {
                    throw gateError(
                        `${COVERAGE_PLAN_PATH} states no "${state}" band for ${workedCategory}, which ` +
                            `${CATALOG_POLICY_PATH} § validation-bounds-and-review-ranges names as one of its two`,
                    );
                }

                expect(band.max).toBeGreaterThan(band.min);
            }
        });

        it('states two USDA cases that must publish, and they fall inside the band it transcribes', () => {
            const [eggWhite, eggYolk] = statedNumbers(
                catalogPolicy,
                'validation-bounds-and-review-ranges',
                'the two protein_egg cases that must publish',
                /\*\*egg white\*\* \(around (\d+) kcal\) and \*\*egg yolk\*\* \(around (\d+) kcal\)/,
            );
            const band = planCategory('protein_egg').kcalReviewRange;

            expect({ eggWhite, eggYolk, band }).toEqual({
                eggWhite: Math.min(Math.max(eggWhite, band.min), band.max),
                eggYolk: Math.min(Math.max(eggYolk, band.min), band.max),
                band,
            });
        });

        it('states the outcome the endpoint answers an over-cap page limit with', () => {
            const [statedStatus, statedCode] = statedGroups(
                catalogPolicy,
                'benchmark-contract',
                'the outcome an over-cap page limit is answered with',
                /and would answer `(\d{3}) ([a-z_]+)`/,
            );

            // The code is compared by BEHAVIOUR — the request parser is pure,
            // so the reference limit the document says the endpoint would
            // refuse is handed to it and its verdict is read.
            const overCap = parseCatalogSearchRequest({
                q: 'gate probe',
                limit: String(searchBenchmark.paginationCheck.singlePageLimit),
            });

            if (overCap.kind === 'ok') {
                throw gateError(
                    `${CATALOG_POLICY_PATH} § benchmark-contract says a page limit of ` +
                        `${searchBenchmark.paginationCheck.singlePageLimit} is refused by the endpoint, but ` +
                        `${CATALOG_LOGIC_PATH} parsed it as a valid request`,
                );
            }

            twoSided(catalogPolicy, 'the error code an over-cap page limit yields', CATALOG_LOGIC_PATH, statedCode, overCap.code);

            // The status is the controller's, and the controller imports the
            // Prisma-backed services, so the one status it answers a rejected
            // parse with is read from its source text with the count asserted.
            twoSided(
                catalogPolicy,
                'the status an over-cap page limit is answered with',
                CATALOG_CONTROLLER_PATH,
                toNumber('the stated refusal status', statedStatus),
                Number(
                    distinctMatchesInSource(
                        CATALOG_CONTROLLER_PATH,
                        /parsed\.kind !== 'ok'\)\s*\{\s*return res\.status\((\d{3})\)/,
                        'the status a rejected request parse is answered with',
                        1,
                    )[0],
                ),
            );
        });

        it('states the benchmark thresholds, protocol and pagination check the contract defines', () => {
            expectGatedClaims(catalogPolicy, 'benchmark-contract', BENCHMARK_CLAIMS);

            const flat = flattenBlock(gateBlock(catalogPolicy, 'benchmark-contract'));

            // The protocol's sequential flag has no number to compare, so the
            // document's word and the contract's boolean are compared instead.
            twoSided(
                catalogPolicy,
                'the protocol running sequentially',
                SEARCH_BENCHMARK_PATH,
                flat.indexOf('**sequential**') !== -1,
                searchBenchmark.protocol.sequential,
            );
        });
    });

    describe('planning-policy.md — the values it transcribes', () => {
        it('states the recipe count its own status table reports', () => {
            expectGatedClaims(planningPolicy, 'status-at-this-commit', STATUS_CLAIMS);
        });

        it('states the nutrition-target bounds and ranges targets.logic.ts declares', () => {
            expectGatedClaims(planningPolicy, 'nutrition-targets', TARGET_CLAIMS);
        });

        it('transcribes the four activity factors, and no others', () => {
            const table = policyTable(planningPolicy, 'nutrition-targets', ['Level', 'Factor', 'Status']);
            const owned = Object.keys(ACTIVITY_FACTORS) as ActivityLevel[];

            twoSided(
                planningPolicy,
                'the number of transcribed activity levels',
                TARGETS_LOGIC_PATH,
                table.rows.length,
                owned.length,
            );

            twoSided(
                planningPolicy,
                'the activity levels and their factors',
                TARGETS_LOGIC_PATH,
                table.rows.map((row) => ({ level: row[0], factor: toNumber(`${row[0]} factor`, row[1]) })).sort(),
                owned.map((level) => ({ level, factor: ACTIVITY_FACTORS[level] })).sort(),
            );
        });

        it('derives the daily adjustment from the pound-per-week equivalence it cites', () => {
            expect(
                statedNumbers(
                    planningPolicy,
                    'nutrition-targets',
                    'the daily energy per pound-per-week',
                    /([\d,]+) \u00f7 (\d+) = \*\*(\d+) kcal\/day per pound-per-week\*\*/,
                ),
            ).toEqual([
                KCAL_PER_POUND_PER_WEEK_PER_DAY * PLAN_DAY_COUNT,
                PLAN_DAY_COUNT,
                KCAL_PER_POUND_PER_WEEK_PER_DAY,
            ]);
        });

        it('transcribes every goal and pace with the adjustment targets.logic.ts computes', () => {
            const table = policyTable(planningPolicy, 'nutrition-targets', [
                'Goal',
                'Pace (lb/week)',
                'Daily adjustment',
                'Copy',
                'Status',
            ]);

            expect(table.rows.length).toBeGreaterThan(0);

            for (const row of table.rows) {
                const goal = row[0] as Goal;
                const pace = row[1] === '\u2014' ? null : (toNumber(`${goal} pace`, row[1]) as PaceLbPerWeek);
                const stated = toNumber(`${goal} adjustment`, row[2].replace(' kcal', ''));

                twoSided(
                    planningPolicy,
                    `the daily adjustment for ${goal} at pace ${String(pace)}`,
                    TARGETS_LOGIC_PATH,
                    stated,
                    calculateGoalAdjustment(goal, pace),
                );

                const copy = /About (\d+) cal/.exec(row[3]);

                if (copy !== null) {
                    twoSided(
                        planningPolicy,
                        `the on-screen copy for ${goal} at pace ${String(pace)}`,
                        TARGETS_LOGIC_PATH,
                        toNumber('copy', copy[1]),
                        Math.abs(calculateGoalAdjustment(goal, pace)),
                    );
                }
            }
        });

        it('transcribes the supported adult envelope both logic modules declare', () => {
            const table = policyTable(planningPolicy, 'nutrition-targets', ['Input', 'Supported range', 'Status']);
            const envelope: readonly ('age' | 'heightCm' | 'weightKg')[] = ['age', 'heightCm', 'weightKg'];

            for (const input of envelope) {
                const row = tableRow(planningPolicy, 'nutrition-targets', table, input);
                const bounds = /^(\d+)\u2013(\d+)/.exec(row[1]);

                if (bounds === null) {
                    throw gateError(
                        `${PLANNING_POLICY_PATH} § nutrition-targets states the unreadable range "${row[1]}" ` +
                            `for ${input}`,
                    );
                }

                const stated = { min: Number(bounds[1]), max: Number(bounds[2]) };

                expect({
                    value: `the supported range of ${input}`,
                    [PLANNING_POLICY_PATH]: stated,
                    [TARGETS_LOGIC_PATH]: ESTIMATE_INPUT_RANGES[input],
                    [PREFERENCES_LOGIC_PATH]: BODY_INPUT_RANGES[input],
                }).toEqual({
                    value: `the supported range of ${input}`,
                    [PLANNING_POLICY_PATH]: ESTIMATE_INPUT_RANGES[input],
                    [TARGETS_LOGIC_PATH]: ESTIMATE_INPUT_RANGES[input],
                    [PREFERENCES_LOGIC_PATH]: ESTIMATE_INPUT_RANGES[input],
                });
            }
        });

        it('§1.5 — admits exactly the code vocabularies its input table lists', () => {
            // Read from the raw block rather than the parsed table: a parsed
            // cell has had its backticks stripped, and the codes are what is
            // being compared.
            const [statedSexes] = statedGroups(
                planningPolicy,
                'nutrition-targets',
                'the sexes its input table admits',
                /\| `sexForEstimate` \| ([^|]*) \|/,
            );
            const [statedGoals] = statedGroups(
                planningPolicy,
                'nutrition-targets',
                'the goals its input table admits',
                /\| `goal` \| ([^|]*) \|/,
            );
            const [statedPaces] = statedGroups(
                planningPolicy,
                'nutrition-targets',
                'the paces its input table admits',
                /\| `paceLbPerWeek` \| ([^|]*) \|/,
            );
            const [activityCountWord] = statedGroups(
                planningPolicy,
                'nutrition-targets',
                'the number of activity levels its input table defers to',
                /\| `activityLevel` \| the (\w+) levels in/,
            );
            const ascending = (first: number, second: number): number => first - second;

            twoSided(
                planningPolicy,
                'the sexes an estimate accepts',
                MEAL_PLANNING_TYPES_PATH,
                backtickedTokens(statedSexes).sort(),
                unionMembersInSource(MEAL_PLANNING_TYPES_PATH, 'SexForEstimate').sort(),
            );
            twoSided(
                planningPolicy,
                'the goals an estimate accepts',
                MEAL_PLANNING_TYPES_PATH,
                backtickedTokens(statedGoals).sort(),
                unionMembersInSource(MEAL_PLANNING_TYPES_PATH, 'Goal').sort(),
            );
            twoSided(
                planningPolicy,
                'the paces an estimate accepts',
                MEAL_PLANNING_TYPES_PATH,
                numbersIn('the supported paces', statedPaces).sort(ascending),
                unionMembersInSource(MEAL_PLANNING_TYPES_PATH, 'PaceLbPerWeek')
                    .map((pace) => toNumber('a declared pace', pace))
                    .sort(ascending),
            );
            expectMembership(
                planningPolicy,
                'the goal the pace column says carries no pace',
                MEAL_PLANNING_TYPES_PATH,
                backtickedTokens(statedPaces),
                unionMembersInSource(MEAL_PLANNING_TYPES_PATH, 'Goal'),
            );
            twoSided(
                planningPolicy,
                'the number of activity levels its input table defers to',
                TARGETS_LOGIC_PATH,
                fromWord('the activity levels', activityCountWord),
                Object.keys(ACTIVITY_FACTORS).length,
            );
            twoSided(
                planningPolicy,
                'the number of activity levels the wire vocabulary declares',
                MEAL_PLANNING_TYPES_PATH,
                fromWord('the activity levels', activityCountWord),
                unionMembersInSource(MEAL_PLANNING_TYPES_PATH, 'ActivityLevel').length,
            );

            const [writeTimeStatus] = statedNumbers(
                planningPolicy,
                'nutrition-targets',
                'the status an out-of-envelope write is rejected with',
                /rejects an out-of-envelope value with a `(\d{3})` at write time/,
            );

            twoSided(
                planningPolicy,
                'the status an out-of-envelope write is rejected with',
                MEAL_PLANNING_CONTROLLER_PATH,
                writeTimeStatus,
                statusForErrorCodeInSource(MEAL_PLANNING_CONTROLLER_PATH, INVALID_REQUEST_CODE),
            );
        });

        it('§1.4/§1.5 — reports the unavailability the resolver reports, for the rows it names', () => {
            const [lossGoal, gainGoal, pacelessCode] = statedGroups(
                planningPolicy,
                'nutrition-targets',
                'the paceless row that is unusable',
                /a `(\w+)` or `(\w+)` row with no usable pace is \*\*unusable\*\*, reported as `(\w+)`/,
            );
            const [maintainGoal] = statedGroups(
                planningPolicy,
                'nutrition-targets',
                'the goal that carries no pace',
                /`(\w+)` carries no pace by contract/,
            );
            const [envelopeCode] = statedGroups(
                planningPolicy,
                'nutrition-targets',
                'the refusal an out-of-envelope row earns',
                /The estimate then \*\*refuses\*\* it — reporting\s+`(\w+)` — instead of clamping/,
            );

            expectMembership(
                planningPolicy,
                'the goals a paceless row is refused for',
                MEAL_PLANNING_TYPES_PATH,
                [lossGoal, gainGoal, maintainGoal],
                unionMembersInSource(MEAL_PLANNING_TYPES_PATH, 'Goal'),
            );

            for (const goal of [lossGoal, gainGoal]) {
                const resolved = resolveEstimateInputs({
                    ...estimateRowSample(),
                    goal,
                    pace_lb_per_week: null,
                });

                twoSided(
                    planningPolicy,
                    `the reason a paceless ${goal} row reports`,
                    TARGETS_LOGIC_PATH,
                    pacelessCode,
                    resolved.kind === 'unavailable' ? resolved.reason : `resolved as ${resolved.kind}`,
                );
            }

            const outsideEnvelope = resolveEstimateInputs({
                ...estimateRowSample(),
                age: ESTIMATE_INPUT_RANGES.age.max + 1,
            });

            twoSided(
                planningPolicy,
                'the reason an out-of-envelope row reports instead of being clamped',
                TARGETS_LOGIC_PATH,
                envelopeCode,
                outsideEnvelope.kind === 'unavailable' ? outsideEnvelope.reason : `resolved as ${outsideEnvelope.kind}`,
            );

            // "A stored pace on a `maintain` row is ignored rather than treated
            // as a contradiction" — the row resolves, and it resolves without one.
            const maintained = resolveEstimateInputs({
                ...estimateRowSample(),
                goal: maintainGoal,
                pace_lb_per_week: 1,
            });

            expect(maintained.kind).toBe('ready');
            expect(maintained.kind === 'ready' ? maintained.inputs.paceLbPerWeek : 'unavailable').toBeNull();
        });

        it('lists the same paces in its input table as in its adjustment table', () => {
            const ranges = policyTable(planningPolicy, 'nutrition-targets', ['Input', 'Supported range', 'Status']);
            const paces = policyTable(planningPolicy, 'nutrition-targets', [
                'Goal',
                'Pace (lb/week)',
                'Daily adjustment',
                'Copy',
                'Status',
            ]);
            const paceRow = tableRow(planningPolicy, 'nutrition-targets', ranges, 'paceLbPerWeek');
            const statedPaces = numbersIn('the supported paces', paceRow[1].split(';')[0]);
            const adjustmentPaces = distinct(
                paces.rows.filter((row) => row[1] !== '\u2014').map((row) => toNumber('pace', row[1])),
            ).sort();

            twoSided(
                planningPolicy,
                'the paces the estimate accepts',
                `${PLANNING_POLICY_PATH} §1.4`,
                statedPaces.slice().sort(),
                adjustmentPaces,
            );
            for (const pace of statedPaces) {
                expect(calculateGoalAdjustment('lose', pace as PaceLbPerWeek)).toBe(
                    -KCAL_PER_POUND_PER_WEEK_PER_DAY * pace,
                );
            }
        });

        it('transcribes the three display conversions preferences.logic.ts declares', () => {
            const table = policyTable(planningPolicy, 'nutrition-targets', ['Conversion', 'Factor', 'Status']);
            const owned: Readonly<Record<string, number>> = {
                'pound \u2192 kilogram': POUNDS_TO_KILOGRAMS,
                'inch \u2192 centimetre': INCHES_TO_CENTIMETERS,
                'stone \u2192 kilogram': STONE_TO_KILOGRAMS,
            };

            twoSided(
                planningPolicy,
                'the number of transcribed conversions',
                PREFERENCES_LOGIC_PATH,
                table.rows.length,
                Object.keys(owned).length,
            );

            for (const row of table.rows) {
                const factor = owned[row[0]];

                if (factor === undefined) {
                    throw gateError(
                        `${PLANNING_POLICY_PATH} § nutrition-targets states the conversion "${row[0]}", which ` +
                            `${PREFERENCES_LOGIC_PATH} does not declare a factor for`,
                    );
                }

                twoSided(
                    planningPolicy,
                    `the ${row[0]} factor`,
                    PREFERENCES_LOGIC_PATH,
                    toNumber(row[0], row[1]),
                    factor,
                );
            }
        });

        it('transcribes the macro split and the Atwater divisors it derives grams with', () => {
            const table = policyTable(planningPolicy, 'nutrition-targets', [
                'Macro',
                'Share of energy',
                'Grams from kcal',
                'Status',
            ]);
            const owned: readonly { readonly label: string; readonly key: 'protein' | 'carbs' | 'fat' }[] = [
                { label: 'Protein', key: 'protein' },
                { label: 'Carbohydrate', key: 'carbs' },
                { label: 'Fat', key: 'fat' },
            ];

            twoSided(
                planningPolicy,
                'the number of transcribed macros',
                TARGETS_LOGIC_PATH,
                table.rows.length,
                owned.length,
            );

            for (const { label, key } of owned) {
                const row = tableRow(planningPolicy, 'nutrition-targets', table, label);

                twoSided(
                    planningPolicy,
                    `the energy share of ${key}`,
                    TARGETS_LOGIC_PATH,
                    toNumber(`${key} share`, row[1].replace(' %', '')),
                    asPercent(MACRO_ENERGY_SHARES[key]),
                );
                twoSided(
                    planningPolicy,
                    `the Atwater divisor of ${key}`,
                    TARGETS_LOGIC_PATH,
                    toNumber(`${key} divisor`, row[2].replace('\u00f7 ', '')),
                    KCAL_PER_GRAM[key],
                );
            }
        });

        it('states a worked example targets.logic.ts reproduces figure for figure', () => {
            const [sex, age, heightCm, weightKg, activityLevel, goal, pace] = statedGroups(
                planningPolicy,
                'nutrition-targets',
                "the worked example's inputs",
                /Inputs: (\w+), (\d+) years, ([\d.]+) cm, ([\d.]+) kg, `(\w+)`, `(\w+)` at ([\d.]+) lb\/week/,
            );
            const inputs: CalculableEstimateInputs = {
                age: toNumber('age', age),
                heightCm: toNumber('heightCm', heightCm),
                weightKg: toNumber('weightKg', weightKg),
                sexForEstimate: sex as CalculableSex,
                activityLevel: activityLevel as ActivityLevel,
                goal: goal as Goal,
                paceLbPerWeek: toNumber('pace', pace) as PaceLbPerWeek,
            };
            const estimate = computeTargetEstimate(inputs, 1);
            const unroundedBmr = calculateBmr(
                inputs.sexForEstimate,
                inputs.weightKg,
                inputs.heightCm,
                inputs.age,
            );
            const unroundedTdee = calculateTdee(unroundedBmr, inputs.activityLevel);
            const table = policyTable(planningPolicy, 'nutrition-targets', ['Step', 'Arithmetic', 'Value']);

            const reported = (label: string): { readonly full: number | null; readonly shown: number } => {
                const cell = tableRow(planningPolicy, 'nutrition-targets', table, label)[2];
                const both = /^([\d,.\s]+?) \(reported as ([\d,]+)\)$/.exec(cell);

                if (both !== null) {
                    return { full: toNumber(label, both[1]), shown: toNumber(label, both[2]) };
                }

                return { full: null, shown: toNumber(label, cell.replace(/ (?:kcal|g)$/, '')) };
            };

            twoSided(planningPolicy, "the example's basal rate", TARGETS_LOGIC_PATH, reported('BMR').full, unroundedBmr);
            twoSided(planningPolicy, "the example's reported basal rate", TARGETS_LOGIC_PATH, reported('BMR').shown, estimate.bmr);
            twoSided(planningPolicy, "the example's total expenditure", TARGETS_LOGIC_PATH, reported('TDEE').full, unroundedTdee);
            twoSided(
                planningPolicy,
                "the example's reported total expenditure",
                TARGETS_LOGIC_PATH,
                reported('TDEE').shown,
                estimate.tdee,
            );
            twoSided(
                planningPolicy,
                "the example's goal adjustment",
                TARGETS_LOGIC_PATH,
                reported('Adjustment').shown,
                estimate.adjustment,
            );
            twoSided(
                planningPolicy,
                "the example's adjusted rate",
                TARGETS_LOGIC_PATH,
                reported('Adjusted').shown,
                unroundedTdee + estimate.adjustment,
            );
            twoSided(
                planningPolicy,
                "the example's calorie target",
                TARGETS_LOGIC_PATH,
                reported('Calories').shown,
                estimate.calories,
            );
            twoSided(
                planningPolicy,
                "the example's protein target",
                TARGETS_LOGIC_PATH,
                reported('Protein').shown,
                estimate.protein,
            );
            twoSided(
                planningPolicy,
                "the example's carbohydrate target",
                TARGETS_LOGIC_PATH,
                reported('Carbohydrate').shown,
                estimate.carbs,
            );
            twoSided(planningPolicy, "the example's fat target", TARGETS_LOGIC_PATH, reported('Fat').shown, estimate.fat);
            expect(tableRow(planningPolicy, 'nutrition-targets', table, 'Bounds')[2]).toContain('clampReason: null');
            expect(estimate.clampReason).toBeNull();
        });

        it('states the rounding order its own worked example depends on', () => {
            const [full, rounded, preRounded, preRoundedResult] = statedNumbers(
                planningPolicy,
                'nutrition-targets',
                'what rounding the basal rate early would change',
                /a full-precision basal rate of ([\d,.]+) kcal yields a ([\d,]+) kcal maintenance rate, where a pre-rounded ([\d,]+) would yield ([\d,]+)/,
            );

            expect(Math.round(calculateTdee(full, 'lightly_active'))).toBe(rounded);
            expect(Math.round(calculateTdee(preRounded, 'lightly_active'))).toBe(preRoundedResult);
            expect(Math.round(full)).toBe(preRounded);
        });

        it('states both envelope corners, and the clamps targets.logic.ts reaches at them', () => {
            const table = policyTable(planningPolicy, 'nutrition-targets', [
                'Corner',
                'Inputs',
                'Derivation',
                'Result',
            ]);

            twoSided(planningPolicy, 'the number of transcribed corners', TARGETS_LOGIC_PATH, table.rows.length, 2);

            for (const row of table.rows) {
                const parsedInputs =
                    /^(\d+) kg, (\d+) cm, (\d+) y, (\w+), (\w+), (\w+)(?: at ([\d.]+))?$/.exec(row[1]);
                const derivation = /^BMR ([\d,]+) \u2192 TDEE ([\d,]+) \u2192 adjusted ([\d,]+)$/.exec(row[2]);
                const result = /^clamped to ([\d,]+) kcal, clampReason: '(\w+)'$/.exec(row[3]);

                if (parsedInputs === null || derivation === null || result === null) {
                    throw gateError(
                        `${PLANNING_POLICY_PATH} § nutrition-targets states the ${row[0]} corner in a form this ` +
                            'gate cannot read',
                    );
                }

                const inputs: CalculableEstimateInputs = {
                    weightKg: toNumber('weightKg', parsedInputs[1]),
                    heightCm: toNumber('heightCm', parsedInputs[2]),
                    age: toNumber('age', parsedInputs[3]),
                    sexForEstimate: parsedInputs[4] as CalculableSex,
                    activityLevel: parsedInputs[5] as ActivityLevel,
                    goal: parsedInputs[6] as Goal,
                    paceLbPerWeek:
                        parsedInputs[7] === undefined ? null : (toNumber('pace', parsedInputs[7]) as PaceLbPerWeek),
                };
                const estimate = computeTargetEstimate(inputs, 1);

                twoSided(
                    planningPolicy,
                    `the ${row[0]} corner's derivation and clamp`,
                    TARGETS_LOGIC_PATH,
                    {
                        bmr: toNumber('bmr', derivation[1]),
                        tdee: toNumber('tdee', derivation[2]),
                        adjusted: toNumber('adjusted', derivation[3]),
                        calories: toNumber('calories', result[1]),
                        clampReason: result[2],
                    },
                    {
                        bmr: estimate.bmr,
                        tdee: estimate.tdee,
                        adjusted: estimate.tdee + estimate.adjustment,
                        calories: estimate.calories,
                        clampReason: estimate.clampReason,
                    },
                );
            }
        });

        it('states the highest basal rate its own supported envelope allows', () => {
            const [stated] = statedNumbers(
                planningPolicy,
                'nutrition-targets',
                'the highest basal rate inside the envelope',
                /the highest possible basal rate is ([\d,.]+) kcal/,
            );

            twoSided(
                planningPolicy,
                'the highest basal rate inside the envelope',
                TARGETS_LOGIC_PATH,
                stated,
                calculateBmr(
                    'male',
                    ESTIMATE_INPUT_RANGES.weightKg.max,
                    ESTIMATE_INPUT_RANGES.heightCm.max,
                    ESTIMATE_INPUT_RANGES.age.min,
                ),
            );
        });

        it('states the macros a floor-clamped target must produce', () => {
            const [clampedTo, worthOf, protein, carbs, fat] = statedNumbers(
                planningPolicy,
                'nutrition-targets',
                'the macros derived from a clamped target',
                /a target clamped up to ([\d,]+) kcal must produce ([\d,]+) kcal worth of macros \u2014 (\d+) g \/ (\d+) g \/ (\d+) g/,
            );

            expect(clampedTo).toBe(CALORIE_FLOOR_BY_SEX.female);
            expect(worthOf).toBe(CALORIE_FLOOR_BY_SEX.female);
            twoSided(
                planningPolicy,
                'the macros of the female floor',
                TARGETS_LOGIC_PATH,
                { protein, carbs, fat },
                {
                    protein: deriveMacroTargets(CALORIE_FLOOR_BY_SEX.female).protein,
                    carbs: deriveMacroTargets(CALORIE_FLOOR_BY_SEX.female).carbs,
                    fat: deriveMacroTargets(CALORIE_FLOOR_BY_SEX.female).fat,
                },
            );
        });

        it('states two sub-kcal boundary cases the bounds resolve as it says', () => {
            const [belowFloor, floorReason, atBmr, bmr, bmrReason] = statedGroups(
                planningPolicy,
                'nutrition-targets',
                'the two full-precision boundary cases',
                /so ([\d,.]+) against the female floor reports `(\w+)`, and ([\d,.]+) against a ([\d,.]+) kcal basal rate reports `(\w+)`/,
            );

            twoSided(
                planningPolicy,
                'the clamp reason just below the female floor',
                TARGETS_LOGIC_PATH,
                floorReason,
                applyTargetBounds(toNumber('below floor', belowFloor), 0, 'female').clampReason,
            );
            twoSided(
                planningPolicy,
                'the clamp reason just below the basal rate',
                TARGETS_LOGIC_PATH,
                bmrReason,
                applyTargetBounds(toNumber('at bmr', atBmr), toNumber('bmr', bmr), 'female').clampReason,
            );
        });

        it('§1.6 — names the clamp reason applyTargetBounds reaches at each bound it tabulates', () => {
            const table = policyTable(planningPolicy, 'nutrition-targets', [
                'Bound',
                'Value',
                'clampReason when it decides the figure',
            ]);

            twoSided(
                planningPolicy,
                'the number of tabulated bounds',
                TARGETS_LOGIC_PATH,
                table.rows.length,
                Object.keys(CLAMP_PROBES).length,
            );

            for (const row of table.rows) {
                const probe = CLAMP_PROBES[row[0]];

                if (probe === undefined) {
                    throw gateError(
                        `${PLANNING_POLICY_PATH} § nutrition-targets tabulates the bound "${row[0]}", which ` +
                            'this gate has no probe for — add one rather than leaving the row ungated',
                    );
                }

                twoSided(planningPolicy, `the clamp reason at "${row[0]}"`, TARGETS_LOGIC_PATH, row[2], probe());
            }

            twoSided(
                planningPolicy,
                'the clamp reasons the vocabulary declares',
                MEAL_PLANNING_TYPES_PATH,
                distinct(table.rows.map((row) => row[2]))
                    .filter((reason) => reason !== String(null))
                    .sort(),
                unionMembersInSource(MEAL_PLANNING_TYPES_PATH, 'ClampReason').sort(),
            );

            const [gatedGoal, boundGoal] = statedGroups(
                planningPolicy,
                'nutrition-targets',
                'the goals the floor paragraph names',
                /It is tempting to gate it on `(\w+)`, because that is where it usually binds\. But a `(\w+)` plan/,
            );

            expectMembership(
                planningPolicy,
                'the goals the floor paragraph names',
                MEAL_PLANNING_TYPES_PATH,
                [gatedGoal, boundGoal],
                unionMembersInSource(MEAL_PLANNING_TYPES_PATH, 'Goal'),
            );

            const [aboveFloorReason, otherwiseReason] = statedGroups(
                planningPolicy,
                'nutrition-targets',
                'the reason each of the two lower bounds reports',
                /the reason names whichever it was: `(\w+)` when the user's basal rate exceeds the sex floor, `(\w+)` otherwise/,
            );
            const [tieReason] = statedGroups(
                planningPolicy,
                'nutrition-targets',
                'the reason an exact tie reports',
                /\*\*On an exact tie the reason is `(\w+)`\*\*/,
            );
            const belowEveryFloor = CALORIE_FLOOR_BY_SEX.female - 1;

            twoSided(
                planningPolicy,
                'the reason a basal rate above the sex floor reports',
                TARGETS_LOGIC_PATH,
                aboveFloorReason,
                String(applyTargetBounds(belowEveryFloor, UNCLAMPED_PROBE_KCAL, 'female').clampReason),
            );
            twoSided(
                planningPolicy,
                'the reason the sex floor reports when it is the higher bound',
                TARGETS_LOGIC_PATH,
                otherwiseReason,
                String(applyTargetBounds(belowEveryFloor, 0, 'female').clampReason),
            );
            twoSided(
                planningPolicy,
                'the reason an exact tie between the two lower bounds reports',
                TARGETS_LOGIC_PATH,
                tieReason,
                String(
                    applyTargetBounds(belowEveryFloor, CALORIE_FLOOR_BY_SEX.female, 'female').clampReason,
                ),
            );
        });

        it('§1.8 — states the field code a zero macro earns and the warnings a save may carry', () => {
            const [zeroCode] = statedGroups(
                planningPolicy,
                'nutrition-targets',
                'the field code a zero macro target is reported with',
                /A zero is reported with the field code `(\w+)`/,
            );

            twoSided(
                planningPolicy,
                'the field code a zero macro target is reported with',
                TARGETS_LOGIC_PATH,
                zeroCode,
                MANUAL_TARGET_FIELD_CODES.BELOW_MINIMUM,
            );

            const table = policyTable(planningPolicy, 'nutrition-targets', ['Warning', 'Condition', 'Status']);
            const declared = unionMembersInSource(MEAL_PLANNING_TYPES_PATH, 'FeasibilityWarning');
            const [countWord] = statedGroups(
                planningPolicy,
                'nutrition-targets',
                'the number of assessments a successful save carries',
                /(\w+) assessments accompany a successful save/,
            );

            twoSided(
                planningPolicy,
                'the number of assessments a save may carry',
                MEAL_PLANNING_TYPES_PATH,
                fromWord('the assessments', countWord),
                declared.length,
            );
            twoSided(
                planningPolicy,
                'the number of tabulated warnings',
                MEAL_PLANNING_TYPES_PATH,
                table.rows.length,
                declared.length,
            );
            twoSided(
                planningPolicy,
                'the feasibility warnings, in declaration order',
                MEAL_PLANNING_TYPES_PATH,
                table.rows.map((row) => row[0]),
                declared,
            );

            // "warnings are emitted in declaration order" is itself a claim
            // about the code, so the order the module PUSHES them in is
            // compared with the order the union declares them in. Without this
            // the table could agree with the union while the resolver emitted
            // them in some other order, which is exactly what the sentence
            // promises does not happen.
            statedGroups(
                planningPolicy,
                'nutrition-targets',
                'that warnings are emitted in declaration order',
                /warnings are emitted in\s+declaration order so the array is deterministic/,
            );
            twoSided(
                planningPolicy,
                'the order the resolver emits the feasibility warnings in',
                TARGETS_LOGIC_PATH,
                declared,
                distinctMatchesInSource(
                    TARGETS_LOGIC_PATH,
                    /warnings\.push\('([a-z_]+)'\)/,
                    'the feasibility warnings the resolver emits',
                    declared.length,
                ),
            );

            const divisors = statedNumbers(
                planningPolicy,
                'nutrition-targets',
                'the Atwater divisors in the mismatch condition',
                /\\\|(\d)·protein \+ (\d)·carbs \+ (\d)·fat − calories\\\|/,
            );

            twoSided(planningPolicy, 'the Atwater divisors in the mismatch condition', TARGETS_LOGIC_PATH, divisors, [
                KCAL_PER_GRAM.protein,
                KCAL_PER_GRAM.carbs,
                KCAL_PER_GRAM.fat,
            ]);
        });

        it('states the plan-generation constants mealPlan.logic.ts declares', () => {
            expectGatedClaims(planningPolicy, 'plan-generation', PLAN_CLAIMS);
        });

        it('§3.4 — reduces the seed by the algorithm it spells out, applied to a fixed input set', () => {
            const [countWord, separator, hashName, sliceWord, spelledFields] = statedGroups(
                planningPolicy,
                'plan-generation',
                'the seed reduction',
                /derived from exactly (\w+) inputs, joined with `([^`]+)` in a fixed order, hashed with ([\w-]+), and read as the first (\w+) bytes of the digest as an unsigned big-endian integer: ```text ([^`]+) ```/,
            );
            const fields = documentedSeedFields(spelledFields, separator);
            const digestBytes = fromWord('the digest slice', sliceWord);

            twoSided(
                planningPolicy,
                'the number of seed inputs',
                MEAL_PLAN_LOGIC_PATH,
                fromWord('the seed input count', countWord),
                Object.keys(SEED_INPUT_SAMPLE).length,
            );
            twoSided(
                planningPolicy,
                'the seed inputs themselves',
                MEAL_PLAN_LOGIC_PATH,
                fields.slice().sort(),
                Object.keys(SEED_INPUT_SAMPLE).sort(),
            );

            const [restatedSeparator] = statedGroups(
                planningPolicy,
                'plan-generation',
                'the separator, restated as what makes it safe',
                /`([^`]+)` is safe as a separator because none of the five fields can contain one/,
            );

            for (const spelling of [separator, restatedSeparator]) {
                twoSided(
                    planningPolicy,
                    'the separator the seed material is joined with',
                    MEAL_PLAN_LOGIC_PATH,
                    spelling,
                    stringConstantInSource(MEAL_PLAN_LOGIC_PATH, 'SEED_FIELD_SEPARATOR'),
                );
            }

            if (digestBytes < 1 || digestBytes > MAX_READABLE_DIGEST_BYTES) {
                throw gateError(
                    `${PLANNING_POLICY_PATH} § plan-generation reads the first ${digestBytes} bytes of the ` +
                        `digest, which is outside the 1\u2013${MAX_READABLE_DIGEST_BYTES} bytes this gate can read ` +
                        'as one unsigned big-endian integer',
                );
            }

            // The whole reduction, rebuilt from the document alone: its field
            // order, its separator, its hash and its slice. A change to any of
            // them here, or to any of them in derivePlanSeed, moves exactly one
            // of the two numbers below.
            const material = fields.map((field) => SEED_INPUT_SAMPLE[field]).join(separator);
            const digest = digestNamedBy(planningPolicy, 'plan-generation', hashName, material);

            twoSided(
                planningPolicy,
                'the seed its own reduction produces for a fixed input set',
                MEAL_PLAN_LOGIC_PATH,
                digest.readUIntBE(0, digestBytes),
                derivePlanSeed(seedInputSample()),
            );
        });

        it('§3.4 — orders candidates by the triple it names, in the order it names them', () => {
            const [spelledTriple] = statedGroups(
                planningPolicy,
                'plan-generation',
                'the portable candidate pre-order',
                /Candidates are ordered by the triple `\(([^`)]+)\)`/,
            );
            const [, separator] = statedGroups(
                planningPolicy,
                'plan-generation',
                'the separator the seed material is joined with',
                /derived from exactly (\w+) inputs, joined with `([^`]+)` in a fixed order/,
            );
            const members = spelledTriple.split(',').map((member) => {
                const name = member.trim();

                if (!Object.prototype.hasOwnProperty.call(CANDIDATE_IDENTITY_SAMPLE, name)) {
                    throw gateError(
                        `${PLANNING_POLICY_PATH} § plan-generation names "${name}" in the candidate triple, ` +
                            `which this gate has no sample value for \u2014 ${MEAL_PLAN_LOGIC_PATH}'s ` +
                            'portableCandidateIdentity takes a slug, a version and a portion multiplier',
                    );
                }

                return name;
            });

            twoSided(
                planningPolicy,
                'the number of members in the candidate identity',
                MEAL_PLAN_LOGIC_PATH,
                members.length,
                Object.keys(CANDIDATE_IDENTITY_SAMPLE).length,
            );
            twoSided(
                planningPolicy,
                'the candidate identity its own triple produces, in its own order',
                MEAL_PLAN_LOGIC_PATH,
                members.map((member) => CANDIDATE_IDENTITY_SAMPLE[member]).join(separator),
                portableCandidateIdentity(
                    CANDIDATE_IDENTITY_SAMPLE['recipe slug'],
                    Number(CANDIDATE_IDENTITY_SAMPLE['recipe version']),
                    Number(CANDIDATE_IDENTITY_SAMPLE['portion multiplier']),
                ),
            );
        });

        it('§3.1 — gates eligibility on the values the recipe vocabularies declare', () => {
            const table = policyTable(planningPolicy, 'plan-generation', ['Clause', 'Requirement', 'Status']);

            // The food group the dislike clause is worked through is a member
            // of the catalogue taxonomy, not an illustration — the same
            // comparison `catalog-policy.md` makes of its own statement of it.
            expectMembership(
                planningPolicy,
                'the food group the dislike clause is worked through',
                COVERAGE_PLAN_PATH,
                statedGroups(
                    planningPolicy,
                    'plan-generation',
                    'the group a single disliked food excludes',
                    /exclude the whole `([a-z_]+)` group without touching/,
                ),
                coveragePlan.foodGroups.map((group) => group.foodGroup),
            );
            const [statedStatus] = statedGroups(
                planningPolicy,
                'plan-generation',
                'the version status a plannable recipe must carry',
                /\| Version status \| the recipe version is `(\w+)` \|/,
            );
            const [statedProvenance] = statedGroups(
                planningPolicy,
                'plan-generation',
                'the provenance planning requires',
                /\| Nutrition provenance \| `(\w+)`, on the recipe/,
            );
            const [statedAllergenStatus] = statedGroups(
                planningPolicy,
                'plan-generation',
                'the allergen status every ingredient must carry',
                /\| Allergen review \| `allergen_status = '(\w+)'` for/,
            );
            const [gradeCountWord, firstGrade, secondGrade] = statedGroups(
                planningPolicy,
                'plan-generation',
                'the estimate grades planning refuses',
                /The (\w+) estimate grades — `(\w+)` and\s+`(\w+)` — likewise never enter\s+planning/,
            );
            const grades = [firstGrade, secondGrade];

            twoSided(
                planningPolicy,
                'the number of hard eligibility clauses',
                RECIPE_LOGIC_PATH,
                table.rows.length,
                unionMembersInSource(RECIPE_LOGIC_PATH, 'PlanningEligibilityCode').length,
            );
            expectMembership(
                planningPolicy,
                'the version status a plannable recipe must carry',
                RECIPE_LOGIC_PATH,
                [statedStatus],
                unionMembersInSource(RECIPE_LOGIC_PATH, 'RecipeVersionStatus'),
            );
            expectMembership(
                planningPolicy,
                'the provenance planning requires',
                NUTRITION_TYPES_PATH,
                [statedProvenance],
                unionMembersInSource(NUTRITION_TYPES_PATH, 'NutritionProvenance'),
            );
            expectMembership(
                planningPolicy,
                'the allergen status every ingredient must carry',
                RECIPE_LOGIC_PATH,
                [statedAllergenStatus],
                unionMembersInSource(RECIPE_LOGIC_PATH, 'RecipeAllergenStatus'),
            );
            expectMembership(
                planningPolicy,
                'the estimate grades planning refuses',
                NUTRITION_TYPES_PATH,
                grades,
                unionMembersInSource(NUTRITION_TYPES_PATH, 'NutritionProvenance'),
            );
            expect(grades.length).toBe(fromWord('the estimate grades', gradeCountWord));
            expect(grades.indexOf(statedProvenance)).toBe(-1);
        });

        it('§3.1 — closes the diet vocabulary into the containment chain and the unrestricted answer', () => {
            const [chain] = statedGroups(
                planningPolicy,
                'plan-generation',
                'the diet containment chain',
                /\*\*Diet containment is closed into the tags\*\*: `([^`]+)`/,
            );
            const [unrestricted] = statedGroups(
                planningPolicy,
                'plan-generation',
                'the diet that is never emitted as a tag',
                /`(\w+)` is never emitted as a tag/,
            );
            const contained = chain.split('⊂').map((diet) => diet.trim());
            const stated = contained.concat([unrestricted]);

            twoSided(
                planningPolicy,
                'the diet vocabulary',
                MEAL_PLANNING_TYPES_PATH,
                stated.slice().sort(),
                unionMembersInSource(MEAL_PLANNING_TYPES_PATH, 'Diet').sort(),
            );
            twoSided(
                planningPolicy,
                'the diet vocabulary the eligibility rules read',
                RECIPE_LOGIC_PATH,
                stated.slice().sort(),
                unionMembersInSource(RECIPE_LOGIC_PATH, 'RecipeDietPreference').sort(),
            );

            // "it admits everything at comparison time", against the comparison.
            expect(isDietCompatible(unrestricted as RecipeDietPreference, [])).toBe(true);
            for (const diet of contained) {
                expect(isDietCompatible(diet as RecipeDietPreference, [])).toBe(false);
            }

            // The chain's DIRECTION is a value too, and the set comparison above
            // cannot see it. It is compared by behaviour: a dish whose only
            // ingredient declares the narrowest diet in the document's own chain
            // must derive exactly that diet and everything to its right, in the
            // order this file writes them. Reverse the chain here and the
            // derived tags no longer match it.
            for (let position = 0; position < contained.length; position += 1) {
                const declared = contained[position];
                const impliedByDocument = contained.slice(position);

                twoSided(
                    planningPolicy,
                    `the diets a ‘${declared}’ dish is admissible for`,
                    RECIPE_LOGIC_PATH,
                    impliedByDocument.slice().sort(),
                    deriveDietTags([dietIngredientSample(declared)]).slice().sort(),
                );

                // And each dish must satisfy every diet its position implies,
                // while a narrower preference than the dish's own declaration
                // is refused — which is the containment read as the document
                // words it, "a dish admissible for this diet is also
                // admissible for these".
                for (const preference of contained) {
                    twoSided(
                        planningPolicy,
                        `whether a ‘${declared}’ dish suits a ‘${preference}’ user`,
                        RECIPE_LOGIC_PATH,
                        impliedByDocument.includes(preference),
                        isDietCompatible(
                            preference as RecipeDietPreference,
                            deriveDietTags([dietIngredientSample(declared)]),
                        ),
                    );
                }
            }
        });

        it('transcribes both slot schedules with the cumulative shares and the intents they imply', () => {
            const table = policyTable(planningPolicy, 'plan-generation', [
                'Schedule',
                'Per-slot intent',
                'Cumulative shares',
                'Status',
            ]);
            const owned: readonly { readonly label: string; readonly shares: readonly number[] }[] = [
                { label: 'Three meals', shares: THREE_MEAL_CUMULATIVE_SHARES },
                { label: 'Three meals + snack', shares: THREE_PLUS_SNACK_CUMULATIVE_SHARES },
            ];

            twoSided(
                planningPolicy,
                'the number of transcribed schedules',
                MEAL_PLAN_LOGIC_PATH,
                table.rows.length,
                owned.length,
            );

            for (const { label, shares } of owned) {
                const row = tableRow(planningPolicy, 'plan-generation', table, label);

                twoSided(
                    planningPolicy,
                    `the cumulative shares of the ${label} schedule`,
                    MEAL_PLAN_LOGIC_PATH,
                    numbersIn(label, row[2]),
                    shares.slice(),
                );
                twoSided(
                    planningPolicy,
                    `the per-slot intents of the ${label} schedule`,
                    MEAL_PLAN_LOGIC_PATH,
                    numbersIn(label, row[1]),
                    shares.map((share, index) => asPercent(share - (index === 0 ? 0 : shares[index - 1]))),
                );
            }

            expect(
                statedNumbers(
                    planningPolicy,
                    'plan-generation',
                    'the three shares that do not sum to one in floating point',
                    /summing ([\d.]+) \+ ([\d.]+) \+ ([\d.]+) in floating point/,
                ),
            ).toEqual(
                THREE_MEAL_CUMULATIVE_SHARES.map(
                    (share, index) =>
                        asPercent(share - (index === 0 ? 0 : THREE_MEAL_CUMULATIVE_SHARES[index - 1])) / 100,
                ),
            );
        });

        it('transcribes both portion sets mealPlan.logic.ts permits', () => {
            const table = policyTable(planningPolicy, 'plan-generation', ['Slot', 'Permitted multipliers', 'Status']);
            const owned: readonly { readonly label: string; readonly multipliers: readonly number[] }[] = [
                { label: 'Main slots', multipliers: MAIN_SLOT_PORTION_MULTIPLIERS },
                { label: 'Snack', multipliers: SNACK_PORTION_MULTIPLIERS },
            ];

            twoSided(
                planningPolicy,
                'the number of transcribed portion sets',
                MEAL_PLAN_LOGIC_PATH,
                table.rows.length,
                owned.length,
            );

            for (const { label, multipliers } of owned) {
                const row = tableRow(planningPolicy, 'plan-generation', table, label);

                twoSided(
                    planningPolicy,
                    `the permitted multipliers for ${label}`,
                    MEAL_PLAN_LOGIC_PATH,
                    numbersIn(label, row[1]),
                    multipliers.slice(),
                );
            }
        });

        it('§3.7 — tabulates the limiting constraints in the order the analysis emits them', () => {
            const table = policyTable(planningPolicy, 'plan-generation', [
                'Order',
                'constraintKey',
                'Condition',
                'Status',
            ]);
            const emitted = literalSequenceInSource(MEAL_PLAN_LOGIC_PATH, 'constraintKey');
            const declared = unionMembersInSource(MEAL_PLANNING_TYPES_PATH, 'LimitingConstraintKey');

            twoSided(
                planningPolicy,
                'the number of tabulated limiting constraints',
                MEAL_PLAN_LOGIC_PATH,
                table.rows.length,
                emitted.length,
            );
            twoSided(
                planningPolicy,
                'the limiting-constraint keys, in the order the rows come back',
                MEAL_PLAN_LOGIC_PATH,
                table.rows.map((row) => row[1]),
                emitted,
            );
            twoSided(
                planningPolicy,
                'the limiting-constraint vocabulary',
                MEAL_PLANNING_TYPES_PATH,
                table.rows.map((row) => row[1]).sort(),
                declared.slice().sort(),
            );

            // The Order column is the claim "most-limiting first": it must
            // never decrease down the table, and rows that share a rank are the
            // relaxations the document presents as alternatives to each other.
            const ranks = table.rows.map((row) => toNumber('the constraint rank', row[0]));

            expect(ranks).toEqual(ranks.slice().sort((first, second) => first - second));
            expect(ranks[0]).toBe(1);
            expect(ranks.filter((rank, index) => index > 0 && rank - ranks[index - 1] > 1)).toEqual([]);

            const [fallbackKey] = statedGroups(
                planningPolicy,
                'plan-generation',
                'the row a search with nothing else to say still gets',
                /still gets the `(\w+)` row, because "no meals match"/,
            );
            const [ladderKey] = statedGroups(
                planningPolicy,
                'plan-generation',
                'the relaxation ladder the cooking-time limits climb',
                /which is also the relaxation ladder `(\w+)` steps up/,
            );

            expectMembership(
                planningPolicy,
                'the constraint keys its prose restates',
                MEAL_PLANNING_TYPES_PATH,
                [fallbackKey, ladderKey],
                declared,
            );
        });

        it('§3.7 — states the unit vocabulary a constraint row may carry, and no energy member', () => {
            const [spelled] = statedGroups(
                planningPolicy,
                'plan-generation',
                'the limiting-constraint unit vocabulary',
                /The unit vocabulary is exactly ((?:`[a-z_]+`(?:, | and )?)+) \u2014 it has \*\*no energy member\*\*/,
            );
            const declared = unionMembersInSource(MEAL_PLANNING_TYPES_PATH, 'LimitingConstraintUnit');

            twoSided(
                planningPolicy,
                'the units a limiting constraint may report',
                MEAL_PLANNING_TYPES_PATH,
                backtickedTokens(spelled),
                declared,
            );
            expect(declared.filter((unit) => unit === 'kcal' || unit === 'calories')).toEqual([]);
        });

        it('§3.7 — states the allergies-kept promise the error itself carries', () => {
            const [stated] = statedGroups(
                planningPolicy,
                'plan-generation',
                'the allergies-kept promise',
                /Every such response carries `allergiesKept: (\w+)`/,
            );

            twoSided(
                planningPolicy,
                'the allergies-kept promise on a no-matching-meals failure',
                MEAL_PLANNING_ERRORS_PATH,
                stated,
                String(new NoMatchingMealsError([]).allergiesKept),
            );
        });

        it('§3.8 — spells the incompatibility flags recipe.logic.ts exports as the preference subset', () => {
            const [countWord, spelled] = statedGroups(
                planningPolicy,
                'plan-generation',
                'the incompatibility flag codes',
                /(\w+) codes, spelled ((?:`[a-z_]+`(?:, | and )?)+) \u2014 the preference-conflict subset/,
            );
            const stated = backtickedTokens(spelled);

            twoSided(
                planningPolicy,
                'the number of incompatibility flags',
                RECIPE_LOGIC_PATH,
                fromWord('the incompatibility flag count', countWord),
                PREFERENCE_FLAG_CODES.length,
            );
            twoSided(
                planningPolicy,
                'the incompatibility flags, in declaration order',
                RECIPE_LOGIC_PATH,
                stated,
                PREFERENCE_FLAG_CODES.slice(),
            );
            twoSided(
                planningPolicy,
                'the incompatibility flags as the wire vocabulary declares them',
                MEAL_PLANNING_TYPES_PATH,
                stated.slice().sort(),
                unionMembersInSource(MEAL_PLANNING_TYPES_PATH, 'MealFlagCode').sort(),
            );
        });

        it('§3.9 — names a plan status the wire vocabulary does not carry', () => {
            const [absent] = statedGroups(
                planningPolicy,
                'plan-generation',
                'the plan status it says does not exist',
                /There is no `(\w+)` status and no partially built week/,
            );

            for (const vocabulary of ['PlanStatus', 'PlanLifecycle']) {
                twoSided(
                    planningPolicy,
                    `"${absent}" among the ${vocabulary} members`,
                    MEAL_PLANNING_TYPES_PATH,
                    [],
                    unionMembersInSource(MEAL_PLANNING_TYPES_PATH, vocabulary).filter((member) => member === absent),
                );
            }
        });

        it('§3.5/§3.6 — quotes the statuses the controller actually answers with', () => {
            expectQuotedOutcomes(planningPolicy, 'plan-generation', MEAL_PLANNING_CONTROLLER_PATH);
        });

        it('states one set of per-meal budget boundaries across both logic modules', () => {
            const [tier1, tier2] = statedNumbers(
                planningPolicy,
                'plan-generation',
                'the per-meal budget boundaries',
                /exactly (\d+) and exactly (\d+) are the middle band/,
            );

            expect({
                value: 'the per-meal budget boundaries',
                [PLANNING_POLICY_PATH]: { tier1Below: tier1, tier2Max: tier2 },
                [MEAL_PLAN_LOGIC_PATH]: {
                    tier1Below: BUDGET_TIER_1_MAX_PER_MEAL,
                    tier2Max: BUDGET_TIER_2_MAX_PER_MEAL,
                },
                [PREFERENCES_LOGIC_PATH]: BUDGET_PER_MEAL_THRESHOLDS,
            }).toEqual({
                value: 'the per-meal budget boundaries',
                [PLANNING_POLICY_PATH]: BUDGET_PER_MEAL_THRESHOLDS,
                [MEAL_PLAN_LOGIC_PATH]: BUDGET_PER_MEAL_THRESHOLDS,
                [PREFERENCES_LOGIC_PATH]: BUDGET_PER_MEAL_THRESHOLDS,
            });
        });

        it('states the swap offer bound swap.logic.ts declares', () => {
            expectGatedClaims(planningPolicy, 'swap-offer', SWAP_CLAIMS);
        });

        it('states the recipe thresholds recipe.logic.ts declares', () => {
            expectGatedClaims(planningPolicy, 'recipe-rules', RECIPE_CLAIMS);
        });

        it('§5.1 — derives nutrition by the formula it prints, and leaves unknown fibre unknown', () => {
            const [gramWeightName, firstOperator, nutrientName, secondOperator, basisAmount, servingOperator, yieldName] =
                statedGroups(
                    planningPolicy,
                    'recipe-rules',
                    'the per-100 g derivation',
                    /```text recipe total = Σ \((\w+) (\S) (\w+) (\S) (\d+)\) per serving = recipe total (\S) (\w+) ```/,
                );
            const ingredient = recipeIngredientSample(RECIPE_FIBER_SAMPLE_G);
            const operand = (name: string): number =>
                operandNamed(planningPolicy, 'recipe-rules', RECIPE_FORMULA_SAMPLE, name);

            twoSided(
                planningPolicy,
                'the basis amount a snapshot states its values on',
                CATALOG_LOGIC_PATH,
                toNumber('the basis amount', basisAmount),
                PER_100G_BASIS_AMOUNT,
            );

            const total = evaluateFormula(
                planningPolicy,
                'recipe-rules',
                [operand(gramWeightName), operand(nutrientName), toNumber('the basis amount', basisAmount)],
                [firstOperator, secondOperator],
            );
            const derived = deriveRecipeNutrition([ingredient], RECIPE_YIELD_SAMPLE);

            twoSided(
                planningPolicy,
                'the whole-recipe total its own formula produces',
                RECIPE_LOGIC_PATH,
                total,
                derived.total.calories,
            );
            twoSided(
                planningPolicy,
                'the per-serving figure its own formula produces',
                RECIPE_LOGIC_PATH,
                evaluateFormula(planningPolicy, 'recipe-rules', [total, operand(yieldName)], [servingOperator]),
                derived.perServing.calories,
            );

            const [unknownFibre] = statedGroups(
                planningPolicy,
                'recipe-rules',
                'what an unknown fibre sums to',
                /Fibre is `(\w+)` when \*\*any\*\* ingredient's fibre is unknown/,
            );
            const [refusedFibre] = statedGroups(
                planningPolicy,
                'recipe-rules',
                'the fibre value that would claim a source it has not got',
                /and `(\d)` would claim the recipe contains no fibre/,
            );
            const withUnknown = deriveRecipeNutrition(
                [recipeIngredientSample(null), recipeIngredientSample(RECIPE_FIBER_SAMPLE_G)],
                RECIPE_YIELD_SAMPLE,
            );

            twoSided(
                planningPolicy,
                'the fibre of a recipe with one unknown fibre',
                RECIPE_LOGIC_PATH,
                unknownFibre,
                String(withUnknown.perServingFiber),
            );
            expect(String(withUnknown.perServingFiber)).not.toBe(refusedFibre);
            expect(derived.perServingFiber).not.toBeNull();

            const [volumeBasis] = statedGroups(
                planningPolicy,
                'recipe-rules',
                'the basis that is converted through a stored density',
                /A `(\w+)` ingredient is converted through its \*\*stored density\*\*/,
            );

            expectMembership(
                planningPolicy,
                'the basis converted through a stored density',
                RECIPE_LOGIC_PATH,
                [volumeBasis],
                unionMembersInSource(RECIPE_LOGIC_PATH, 'RecipeNutritionBasis'),
            );

            const divisors = statedNumbers(
                planningPolicy,
                'recipe-rules',
                'the Atwater divisors the sourced total is compared against',
                /compared against the (\d)\/(\d)\/(\d) Atwater estimate/,
            );

            twoSided(planningPolicy, 'the Atwater divisors', TARGETS_LOGIC_PATH, divisors, [
                KCAL_PER_GRAM.protein,
                KCAL_PER_GRAM.carbs,
                KCAL_PER_GRAM.fat,
            ]);
        });

        it('§5.2 — rounds once, over the values and by the arithmetic its table states', () => {
            const table = policyTable(planningPolicy, 'recipe-rules', ['Step', 'Operation', 'Precision']);
            const [stepCountWord] = statedGroups(
                planningPolicy,
                'recipe-rules',
                'the number of rounding steps in the path',
                /There is \*\*exactly (\w+) rounding step\*\* in the whole path/,
            );
            const [valueCountWord] = statedGroups(
                planningPolicy,
                'recipe-rules',
                'the values the single rounding covers',
                /each of the (\w+) values rounded exactly once/,
            );
            const rounding = table.rows.filter((row) => row[2].indexOf('the single rounding') !== -1);

            expect(rounding.length).toBe(fromWord('the rounding steps', stepCountWord));
            twoSided(
                planningPolicy,
                'the values one rounding step covers',
                RECIPE_LOGIC_PATH,
                fromWord('the rounded values', valueCountWord),
                Object.keys(roundNutritionForDisplay(recipePerServingSample())).length,
            );

            // Step 1's precision cell is READ, so a cell that claimed a
            // rounding would fail here rather than leaving the probe below
            // testing a claim the document no longer makes. The probe then
            // proves the claim: scaling a per-serving figure by a fractional
            // multiplier keeps its tail.
            statedGroups(
                planningPolicy,
                'recipe-rules',
                "step 1's precision",
                /\| 1 \| per-serving × `portion_multiplier` \| \*\*full precision — nothing is rounded\*\* \|/,
            );

            const scaled = scalePlannedNutrition(recipePerServingSample(), PORTION_MULTIPLIER_SAMPLE);

            twoSided(
                planningPolicy,
                "step 1's full-precision claim, against the scaling it describes",
                RECIPE_LOGIC_PATH,
                false,
                Number.isInteger(scaled.calories),
            );

            const [modeName, leftName, rightName] = statedGroups(
                planningPolicy,
                'recipe-rules',
                'the consumed-total arithmetic',
                /`(\w+)\((\w+) × (\w+)\)` per value, from the \*\*rounded\*\* snapshot/,
            );
            const consumedSample: Readonly<Record<string, number>> = {
                snapshot: PLANNED_SNAPSHOT_SAMPLE.calories,
                eatenServings: EATEN_SERVINGS_SAMPLE,
            };

            twoSided(
                planningPolicy,
                'the consumed total its own arithmetic produces',
                PLANNED_MEAL_LOG_LOGIC_PATH,
                roundingNamedBy(
                    planningPolicy,
                    'recipe-rules',
                    modeName,
                )(
                    operandNamed(planningPolicy, 'recipe-rules', consumedSample, leftName) *
                        operandNamed(planningPolicy, 'recipe-rules', consumedSample, rightName),
                ),
                deriveConsumedTotals(PLANNED_SNAPSHOT_SAMPLE, EATEN_SERVINGS_SAMPLE).calories,
            );

            const [aggregateColumn, aggregateFactor] = statedGroups(
                planningPolicy,
                'recipe-rules',
                'the SQL aggregate the diary already uses',
                /aggregates do the same in SQL as `SUM\(ROUND\((\w+) \* (\w+)\)\)::int`/,
            );
            const aggregates = claimMatches(
                readRepositoryFile(NUTRITION_SERVICE_PATH),
                new RegExp(`SUM\\(ROUND\\(([\\w.]+) \\* ${aggregateFactor}\\)\\)::int`),
            );

            expect(aggregateColumn.length).toBeGreaterThan(0);
            expect(aggregates.length).toBeGreaterThan(0);
        });

        it('§5.3 — tabulates the closed badge set types/recipe.ts declares', () => {
            const table = policyTable(planningPolicy, 'recipe-rules', ['Badge', 'Derivation', 'Safe default']);
            const [countWord] = statedGroups(
                planningPolicy,
                'recipe-rules',
                'the number of badge codes',
                /(\w+) closed codes\./,
            );
            const [dairyTag] = statedGroups(
                planningPolicy,
                'recipe-rules',
                'the allergen tag the dairy-free badge is withheld by',
                /\| `dairy_free` \| \*\*every\*\* ingredient reviewed \*\*and\*\* no `(\w+)` tag anywhere \|/,
            );

            twoSided(
                planningPolicy,
                'the number of badges',
                RECIPE_TYPES_PATH,
                fromWord('the badge count', countWord),
                RECIPE_BADGES.length,
            );
            twoSided(
                planningPolicy,
                'the badge codes, in declaration order',
                RECIPE_TYPES_PATH,
                table.rows.map((row) => row[0]),
                RECIPE_BADGES.slice(),
            );
            expectMembership(
                planningPolicy,
                'the allergen tag the dairy-free badge is withheld by',
                PREFERENCES_LOGIC_PATH,
                [dairyTag],
                NAMED_ALLERGENS,
            );

            const [firstConservative, secondConservative] = statedGroups(
                planningPolicy,
                'recipe-rules',
                'the two conservative badges',
                /\*\*The two conservative ones are conservative on purpose\.\*\* `(\w+)` and `(\w+)` are claims a user/,
            );
            const [unblockableBadge] = statedGroups(
                planningPolicy,
                'recipe-rules',
                'the badge no ingredient metadata can block',
                /`(\w+)` is the one badge an ingredient's metadata cannot block/,
            );

            expectMembership(
                planningPolicy,
                'the badge codes its prose names',
                RECIPE_TYPES_PATH,
                [firstConservative, secondConservative, unblockableBadge],
                RECIPE_BADGES.slice(),
            );

            const [withheldTag] = statedGroups(
                planningPolicy,
                'recipe-rules',
                'the reviewed tag the gluten-free badge reads',
                /the reviewer withholds the\s+`(\w+)` tag/,
            );

            const [tabulatedTag] = statedGroups(
                planningPolicy,
                'recipe-rules',
                'the reviewed tag the gluten-free row requires',
                /every ingredient carries the reviewed `(\w+)` tag/,
            );

            twoSided(
                planningPolicy,
                'the reviewed tag the gluten-free row requires',
                RECIPE_LOGIC_PATH,
                tabulatedTag,
                stringConstantInSource(RECIPE_LOGIC_PATH, 'GLUTEN_FREE_DIET_TAG'),
            );
            twoSided(
                planningPolicy,
                'the reviewed tag the gluten-free badge reads',
                RECIPE_LOGIC_PATH,
                withheldTag,
                stringConstantInSource(RECIPE_LOGIC_PATH, 'GLUTEN_FREE_DIET_TAG'),
            );
        });

        it('states the grocery epsilon and the unit promotions units.ts derives', () => {
            expectGatedClaims(planningPolicy, 'grocery-contract', GROCERY_CLAIMS);

            const [beforeOunces, promotedOunces, beforeTablespoons, promotedTablespoons] = statedNumbers(
                planningPolicy,
                'grocery-contract',
                'the rounding cases that reach the next unit',
                /([\d.]+) oz rounds to ([\d.]+) oz and ([\d.]+) tbsp rounds to (\d+) tbsp/,
            );

            expect(roundedTo(beforeOunces, 1)).toBe(promotedOunces);
            expect(Math.round(beforeTablespoons * 4) / 4).toBe(promotedTablespoons);
            expect(promotedOunces).toBe(OUNCES_PER_POUND);
            expect(promotedTablespoons).toBe(TABLESPOONS_PER_CUP);
        });

        it('§6.1 — sums planned grams by the formula it prints, at the precision the column stores', () => {
            const [gramWeightName, firstOperator, yieldName, secondOperator, multiplierName] = statedGroups(
                planningPolicy,
                'grocery-contract',
                'the planned-grams formula',
                /```text planned grams = (\w+) (\S) (\w+) (\S) (\w+) ```/,
            );
            const operand = (name: string): number =>
                operandNamed(planningPolicy, 'grocery-contract', GROCERY_FORMULA_SAMPLE, name);
            const [decimalsWord] = statedGroups(
                planningPolicy,
                'grocery-contract',
                'the precision a stored total carries',
                /Totals are stored at (\w+) decimal places/,
            );

            twoSided(
                planningPolicy,
                'the planned grams its own formula produces',
                GROCERY_LOGIC_PATH,
                evaluateFormula(
                    planningPolicy,
                    'grocery-contract',
                    [operand(gramWeightName), operand(yieldName), operand(multiplierName)],
                    [firstOperator, secondOperator],
                ),
                plannedIngredientGrams(operand(gramWeightName), operand(yieldName), operand(multiplierName)),
            );
            twoSided(
                planningPolicy,
                'the decimals a stored total carries',
                GROCERY_LOGIC_PATH,
                fromWord('the stored decimals', decimalsWord),
                numericConstantInSource(GROCERY_LOGIC_PATH, 'STORED_GRAM_DECIMALS'),
            );
        });

        it('§6.2 — tiers each family and renders each precision the way units.ts does', () => {
            const families = policyTable(planningPolicy, 'grocery-contract', [
                'Family',
                'Tiers, largest first',
                'Promotes at',
                'Status',
            ]);
            const [familyCountWord] = statedGroups(
                planningPolicy,
                'grocery-contract',
                'the number of families a unit token belongs to',
                /belongs to exactly \*\*(\w+)\*\* family/,
            );

            twoSided(
                planningPolicy,
                'the display families',
                UNITS_PATH,
                families.rows.map((row) => row[0].toLowerCase()).sort(),
                unionMembersInSource(UNITS_PATH, 'UnitFamily').sort(),
            );
            expect(fromWord('the families a unit belongs to', familyCountWord)).toBe(1);
            expect(unitFamily(UNRECOGNISED_UNIT_SAMPLE)).toBeNull();

            const [guessedFamily] = statedGroups(
                planningPolicy,
                'grocery-contract',
                'the family a guess would produce',
                /guessing `(\w+)` for an unrecognised token/,
            );

            expectMembership(
                planningPolicy,
                'the family a guess would produce',
                UNITS_PATH,
                [guessedFamily],
                unionMembersInSource(UNITS_PATH, 'UnitFamily'),
            );

            for (const row of families.rows) {
                const family = row[0].toLowerCase();
                const tiers = row[1].split('→').map((tier) => tier.trim());

                if (tiers.length === 1) {
                    // The count family tiers nothing, so what it claims is that
                    // a stored count is still a count.
                    twoSided(
                        planningPolicy,
                        'the family a stored count unit belongs to',
                        UNITS_PATH,
                        family,
                        String(unitFamily(COUNT_DISPLAY_UNIT)),
                    );
                    continue;
                }

                twoSided(
                    planningPolicy,
                    `the tiers the ${family} family names`,
                    UNITS_PATH,
                    tiers,
                    tiers.map((tier) => (unitFamily(tier) === family ? tier : `${tier} (${String(unitFamily(tier))})`)),
                );

                // "largest first", read as the base amount one of each holds.
                const sizes = tiers.map((tier) => toBaseQuantity(1, tier).amount);

                expect(sizes).toEqual(sizes.slice().sort((first, second) => second - first));

                // "the largest unit that keeps the value >= 1 is used": exactly
                // one of a tier must render in that tier.
                for (const tier of tiers) {
                    twoSided(
                        planningPolicy,
                        `the unit one ${tier} renders in`,
                        UNITS_PATH,
                        tier,
                        formattedInFamily(planningPolicy, 'grocery-contract', family, 1, tier).unit,
                    );
                }
            }

            const precision = policyTable(planningPolicy, 'grocery-contract', ['Unit', 'Precision', 'Status']);
            const tokensWithPrecision = precision.rows.flatMap((row) =>
                row[0].split(',').map((unit) => unit.trim()),
            );

            // Every unit the tiers table lists must carry a precision. Both
            // tables are this document's, so this is an internal-consistency
            // check rather than a comparison — a unit added to a family cannot
            // arrive without a stated precision, and the units themselves are
            // compared against `units.ts` by the render probes below.
            const tieredTokens = families.rows.flatMap((row) =>
                row[1]
                    .split('\u2192')
                    .map((tier) => tier.trim())
                    .filter((tier) => unitFamily(tier) !== null),
            );
            const withoutPrecision = tieredTokens.filter((token) => tokensWithPrecision.indexOf(token) === -1);

            if (withoutPrecision.length > 0) {
                throw gateError(
                    `${PLANNING_POLICY_PATH} § grocery-contract tiers ${describeSide(withoutPrecision)} in a ` +
                        'family and states no precision for it, so that unit would render ungated',
                );
            }

            for (const row of precision.rows) {
                const pattern = PRECISION_PATTERNS[row[1]];

                if (pattern === undefined) {
                    throw gateError(
                        `${PLANNING_POLICY_PATH} § grocery-contract states the precision "${row[1]}", which ` +
                            'this gate has no probe for — add one rather than leaving the row ungated',
                    );
                }

                for (const token of row[0].split(',').map((unit) => unit.trim())) {
                    const rendered = renderedNumeralFor(planningPolicy, 'grocery-contract', token);

                    twoSided(
                        planningPolicy,
                        `the precision "${token}" renders at`,
                        UNITS_PATH,
                        row[1],
                        pattern.test(rendered) ? row[1] : `"${rendered}", which is not ${row[1]}`,
                    );
                }
            }

            const [glyphList] = statedGroups(
                planningPolicy,
                'grocery-contract',
                'the quarter glyphs',
                /nearest quarter, rendered with the glyphs ([^|]+?) \|/,
            );
            const glyphs = glyphList.trim().split(/\s+/);
            const [adjacent, alone] = statedGroups(
                planningPolicy,
                'grocery-contract',
                'the rendered quarter examples',
                /A quarter renders adjacent to its whole number with no space \("([^"]+)"\), and a bare fraction renders alone \("([^"]+)"\)/,
            );
            const quarterValueOf = (rendered: string): number => {
                const glyphIndex = glyphs.findIndex((glyph) => rendered.indexOf(glyph) !== -1);
                const whole = rendered.replace(/[^\d]/g, '');

                if (glyphIndex === -1) {
                    throw gateError(
                        `${PLANNING_POLICY_PATH} § grocery-contract renders "${rendered}" with no glyph from ` +
                            `${describeSide(glyphs)}`,
                    );
                }

                return (
                    (whole === '' ? 0 : toNumber('the whole part', whole)) +
                    (glyphIndex + 1) / QUARTERS_PER_DISPLAY_UNIT
                );
            };

            twoSided(
                planningPolicy,
                'the number of quarter glyphs',
                UNITS_PATH,
                glyphs.length,
                QUARTERS_PER_DISPLAY_UNIT - 1,
            );
            glyphs.forEach((glyph, index) => {
                twoSided(
                    planningPolicy,
                    `the glyph ${String(index + 1)} quarter(s) renders as`,
                    UNITS_PATH,
                    glyph,
                    formatQuarters((index + 1) / QUARTERS_PER_DISPLAY_UNIT),
                );
            });
            for (const rendered of [adjacent, alone]) {
                twoSided(
                    planningPolicy,
                    `the quarter rendering of "${rendered}"`,
                    UNITS_PATH,
                    rendered,
                    formatQuarters(quarterValueOf(rendered)),
                );
            }
        });

        it('§6.2 — pluralises counts and marks food states the way units.ts does', () => {
            const [exceptionList] = statedGroups(
                planningPolicy,
                'grocery-contract',
                'the irregular plural exceptions',
                /Irregular plurals are a closed exception list — ([^—]+) —/,
            );
            const [plainS] = statedGroups(
                planningPolicy,
                'grocery-contract',
                'the nouns that take a plain s',
                /every other `-o` noun in that set takes a plain `s` \(([^)]+)\)/,
            );
            const [headSingular, headPlural] = statedGroups(
                planningPolicy,
                'grocery-contract',
                'the head noun a count portion pluralises',
                /"([^"]+)" pluralises to "([^"]+)"/,
            );
            const [inflectedQualifier] = statedGroups(
                planningPolicy,
                'grocery-contract',
                'the word inflecting the last word would produce',
                /Inflecting the last word instead would produce "(\w+)"/,
            );
            const [doubleInflected] = statedGroups(
                planningPolicy,
                'grocery-contract',
                'the double inflection a plural description must not earn',
                /must not be inflected a second time into "(\w+)"/,
            );
            const [singularSEndings] = statedGroups(
                planningPolicy,
                'grocery-contract',
                'the singular -s endings',
                /distinguishes a singular `-s` ending \(([^)]+)\) from a plural one/,
            );
            const [statedAmount, statedNoun, statedAmountWord] = statedGroups(
                planningPolicy,
                'grocery-contract',
                'the portion that states its own amount',
                /"(\d+) (\w+)" is one portion \*of (\w+) \2\*/,
            );
            const [unmarkedState] = statedGroups(
                planningPolicy,
                'grocery-contract',
                'the food state that earns no suffix',
                /`(\w+)` alone earns no suffix, because it is the unmarked case/,
            );

            twoSided(
                planningPolicy,
                'the irregular plural exceptions',
                UNITS_PATH,
                backtickedTokens(exceptionList).sort(),
                objectKeysInSource(UNITS_PATH, 'PLURAL_EXCEPTIONS').sort(),
            );

            for (const plural of plainS.split(',').map((word) => word.trim())) {
                twoSided(
                    planningPolicy,
                    `the plural of "${plural.slice(0, -1)}"`,
                    UNITS_PATH,
                    plural,
                    pluralizeCount(2, plural.slice(0, -1)),
                );
            }

            twoSided(
                planningPolicy,
                `the plural of "${headSingular}"`,
                UNITS_PATH,
                headPlural,
                pluralizeCount(2, headSingular),
            );
            expect(pluralizeCount(2, headSingular)).not.toContain(inflectedQualifier);

            // The description the document says must not be inflected again is
            // that word without the ending it must not gain.
            const alreadyPlural = doubleInflected.slice(0, doubleInflected.length - 2);

            twoSided(
                planningPolicy,
                `the plural of the already-plural "${alreadyPlural}"`,
                UNITS_PATH,
                alreadyPlural,
                pluralizeCount(2, alreadyPlural),
            );

            for (const word of singularSEndings.split(',').map((ending) => ending.trim().replace(/"/g, ''))) {
                twoSided(
                    planningPolicy,
                    `"${word}" read as a singular rather than a plural`,
                    UNITS_PATH,
                    'inflected',
                    pluralizeCount(2, word) === word ? 'left alone' : 'inflected',
                );
            }

            twoSided(
                planningPolicy,
                'the items one portion of a stated amount holds',
                UNITS_PATH,
                toNumber('the stated portion amount', statedAmount),
                countPortionItems(1, {
                    amount: toNumber('the stated portion amount', statedAmount),
                    description: statedNoun,
                }),
            );
            expect(fromWord('the stated amount in words', statedAmountWord)).toBe(
                toNumber('the stated portion amount', statedAmount),
            );
            const [suffixedState] = statedGroups(
                planningPolicy,
                'grocery-contract',
                'the food state a name carries no suffix for',
                /\*\*The food state is shown as a name suffix\*\* whenever it is not `(\w+)`,/,
            );

            for (const state of [unmarkedState, suffixedState]) {
                twoSided(
                    planningPolicy,
                    'the unmarked food state',
                    GROCERY_LOGIC_PATH,
                    state,
                    stringConstantInSource(GROCERY_LOGIC_PATH, 'RAW_FOOD_STATE'),
                );
            }
        });

        it('states the planned-meal logging envelope plannedMealLog.logic.ts declares', () => {
            expectGatedClaims(planningPolicy, 'planned-meal-logging', LOG_CLAIMS);
        });
    });

    describe('planning-policy.md §5.6 — the coverage matrix and the profiles it promises', () => {
        it('states the counts and thresholds the coverage report carries', () => {
            expectGatedClaims(planningPolicy, 'recipe-coverage-matrix', COVERAGE_MATRIX_CLAIMS);
        });

        it('counts the recipes that are actually on disk, against the minimum it states', () => {
            const [minimum] = statedNumbers(
                planningPolicy,
                'recipe-coverage-matrix',
                'the required minimum recipe count',
                /against a required minimum of (\d+)/,
            );
            const authored = readdirSync(join(BACKEND_ROOT, RECIPES_DIRECTORY)).filter(
                (fileName) => fileName.endsWith('.json') && fileName !== 'coverage-report.json',
            );

            twoSided(
                planningPolicy,
                'the authored recipe files',
                COVERAGE_REPORT_PATH,
                authored.length,
                coverageReport.recipeCount,
            );
            expect(coverageReport.recipeCount).toBeGreaterThanOrEqual(minimum);
        });

        it('dimensions the matrix the way the report tabulates it', () => {
            const { diets, allergens, slots, timeTiers } = coverageReport.dimensions;

            expect(diets.length * allergens.length * slots.length * timeTiers.length).toBe(
                coverageReport.eligibleCounts.length,
            );
            expect(distinct(coverageReport.eligibleCounts.map(cellKey)).length).toBe(
                coverageReport.eligibleCounts.length,
            );
        });

        it('transcribes the per-slot composition and its floors, slot for slot', () => {
            const table = policyTable(planningPolicy, 'recipe-coverage-matrix', [
                'Slot',
                'Vegan',
                'Further vegetarian',
                'Further pescatarian',
                'Further omnivore',
                'Eligible',
                'Authored to this slot',
            ]);
            const strata: readonly ('vegan' | 'furtherVegetarian' | 'furtherPescatarian' | 'furtherOmnivore')[] = [
                'vegan',
                'furtherVegetarian',
                'furtherPescatarian',
                'furtherOmnivore',
            ];

            twoSided(
                planningPolicy,
                'the number of composed slots',
                COVERAGE_REPORT_PATH,
                table.rows.length,
                Object.keys(coverageReport.slotComposition).length,
            );

            for (const row of table.rows) {
                const slot = row[0].toLowerCase();
                const owned = coverageReport.slotComposition[slot];

                if (owned === undefined) {
                    throw gateError(
                        `${PLANNING_POLICY_PATH} § recipe-coverage-matrix composes the slot "${row[0]}", which ` +
                            `${COVERAGE_REPORT_PATH} does not carry`,
                    );
                }

                const stated = strata.map((stratum, index) => {
                    const cell = /^(\d+) \((?:floor (\d+)|no floor)\)$/.exec(row[index + 1]);

                    if (cell === null) {
                        throw gateError(
                            `${PLANNING_POLICY_PATH} § recipe-coverage-matrix states the unreadable composition ` +
                                `cell "${row[index + 1]}" for ${slot}`,
                        );
                    }

                    return {
                        stratum,
                        count: Number(cell[1]),
                        floor: cell[2] === undefined ? null : Number(cell[2]),
                    };
                });

                twoSided(
                    planningPolicy,
                    `the composition of ${slot}`,
                    COVERAGE_REPORT_PATH,
                    {
                        strata: stated,
                        totalEligible: toNumber(`${slot} eligible`, row[5]),
                        dedicatedToSlot: toNumber(`${slot} authored`, row[6]),
                    },
                    {
                        strata: strata.map((stratum) => ({
                            stratum,
                            count: owned.composition[stratum].count,
                            floor: owned.composition[stratum].floor,
                        })),
                        totalEligible: owned.totalEligible,
                        dedicatedToSlot: owned.dedicatedToSlot,
                    },
                );

                // The document's claim that the four strata partition the slot.
                expect(sumOf(stated.map((stratum) => stratum.count))).toBe(owned.totalEligible);
            }
        });

        it('transcribes the promise tiers with the thresholds and cell counts the report carries', () => {
            const table = policyTable(planningPolicy, 'recipe-coverage-matrix', ['Tier', 'Promise', 'Cells']);
            const guaranteed = tableRow(planningPolicy, 'recipe-coverage-matrix', table, 'Guaranteed');
            const reduced = tableRow(planningPolicy, 'recipe-coverage-matrix', table, 'Reduced');

            expect(table.rows.length).toBe(3);
            twoSided(
                planningPolicy,
                'the guaranteed tier: its threshold and its cells',
                COVERAGE_REPORT_PATH,
                {
                    threshold: numbersIn('guaranteed threshold', guaranteed[1])[0],
                    cells: toNumber('guaranteed cells', guaranteed[2]),
                },
                { threshold: GUARANTEED_CELL_THRESHOLD, cells: coverageReport.guaranteedCells.length },
            );
            twoSided(
                planningPolicy,
                'the reduced tier: its threshold and its cells',
                COVERAGE_REPORT_PATH,
                {
                    threshold: numbersIn('reduced threshold', reduced[1])[0],
                    cells: toNumber('reduced cells', reduced[2]),
                },
                { threshold: REDUCED_CELL_THRESHOLD, cells: coverageReport.reducedCells.length },
            );
            expect(tableRow(planningPolicy, 'recipe-coverage-matrix', table, 'Everything else')[2]).toBe(
                'the remainder',
            );
        });

        it('enumerates exactly the profiles the report promises, tier by tier', () => {
            const table = policyTable(planningPolicy, 'recipe-coverage-matrix', [
                'Tier',
                'Diet',
                'Excluded allergen',
                'Slot',
                'Cooking-time tier (min)',
                'Cells',
            ]);

            expect(table.rows.length).toBeGreaterThan(0);

            const enumerated: Record<string, string[]> = { Guaranteed: [], Reduced: [] };

            for (const row of table.rows) {
                const diets = row[1].split(',').map((value) => value.trim());
                const allergens = row[2].split(',').map((value) => value.trim());
                const slots = row[3].split(',').map((value) => value.trim());
                const tiers = numbersIn('time tiers', row[4]);
                const product = /^(\d+) \u00d7 (\d+) \u00d7 (\d+) \u00d7 (\d+) = (\d+)$/.exec(row[5]);

                if (product === null || enumerated[row[0]] === undefined) {
                    throw gateError(
                        `${PLANNING_POLICY_PATH} § recipe-coverage-matrix states a ${row[0]} enumeration row this ` +
                            `gate cannot read ("${row[5]}")`,
                    );
                }

                // The row writes its own arithmetic out, so the factors are
                // compared with the axis values beside them before the cells
                // they expand to are compared with the report.
                twoSided(
                    planningPolicy,
                    `the arithmetic of the ${row[0]} row [${row[1]}] × [${row[2]}]`,
                    `${PLANNING_POLICY_PATH} (its own axis values)`,
                    [
                        Number(product[1]),
                        Number(product[2]),
                        Number(product[3]),
                        Number(product[4]),
                        Number(product[5]),
                    ],
                    [
                        diets.length,
                        allergens.length,
                        slots.length,
                        tiers.length,
                        diets.length * allergens.length * slots.length * tiers.length,
                    ],
                );

                for (const diet of diets) {
                    for (const allergen of allergens) {
                        for (const slot of slots) {
                            for (const timeTier of tiers) {
                                enumerated[row[0]].push(cellKey({ diet, allergen, slot, timeTier }));
                            }
                        }
                    }
                }
            }

            twoSided(
                planningPolicy,
                'the guaranteed profiles',
                COVERAGE_REPORT_PATH,
                distinct(enumerated.Guaranteed).sort(),
                coverageReport.guaranteedCells.map(cellKey).sort(),
            );
            twoSided(
                planningPolicy,
                'the reduced profiles',
                COVERAGE_REPORT_PATH,
                distinct(enumerated.Reduced).sort(),
                coverageReport.reducedCells.map(cellKey).sort(),
            );
            // Enumerated rows that overlapped would still union correctly while
            // the stated per-row cell counts added up to more than the tier.
            expect(enumerated.Guaranteed.length).toBe(coverageReport.guaranteedCells.length);
            expect(enumerated.Reduced.length).toBe(coverageReport.reducedCells.length);
        });

        it('§5.6 — quotes the status the controller answers an unpromised profile with', () => {
            expectQuotedOutcomes(planningPolicy, 'recipe-coverage-matrix', MEAL_PLANNING_CONTROLLER_PATH);
        });

        it('adds the enumerated rows up to the tier totals it states', () => {
            const [guaranteedFirst, guaranteedSecond, guaranteedTotal, reducedFirst, reducedSecond, reducedTotal] =
                statedNumbers(
                    planningPolicy,
                    'recipe-coverage-matrix',
                    'the two tier sums',
                    /(\d+) \+ (\d+) = \*\*(\d+)\*\* guaranteed cells and (\d+) \+ (\d+) = \*\*(\d+)\*\* reduced cells/,
                );
            const table = policyTable(planningPolicy, 'recipe-coverage-matrix', [
                'Tier',
                'Diet',
                'Excluded allergen',
                'Slot',
                'Cooking-time tier (min)',
                'Cells',
            ]);
            const cellsOf = (tier: string): number[] =>
                table.rows.filter((row) => row[0] === tier).map((row) => numbersIn(`${tier} cells`, row[5]).pop() ?? 0);

            twoSided(
                planningPolicy,
                'the guaranteed rows and their total',
                COVERAGE_REPORT_PATH,
                { rows: [guaranteedFirst, guaranteedSecond], total: guaranteedTotal },
                { rows: cellsOf('Guaranteed'), total: coverageReport.guaranteedCells.length },
            );
            twoSided(
                planningPolicy,
                'the reduced rows and their total',
                COVERAGE_REPORT_PATH,
                { rows: [reducedFirst, reducedSecond], total: reducedTotal },
                { rows: cellsOf('Reduced'), total: coverageReport.reducedCells.length },
            );
            expect(guaranteedFirst + guaranteedSecond).toBe(guaranteedTotal);
            expect(reducedFirst + reducedSecond).toBe(reducedTotal);
        });

        it('§5.6 — states in words the tier boundaries its enumerated cells carry', () => {
            const [guaranteedTier] = statedNumbers(
                planningPolicy,
                'recipe-coverage-matrix',
                'the loosest-tier boundary of the guaranteed tier',
                /\*\*Guaranteed\*\* is every diet with \*\*no\*\* excluded allergen at a cooking-time tier of \*\*(\d+) minutes or looser\*\*/,
            );
            const [unrestrictedDiet] = statedGroups(
                planningPolicy,
                'recipe-coverage-matrix',
                'the diet guaranteed at any time tier with one excluded allergen',
                /plus the unrestricted `(\w+)` diet with \*\*any single\*\* excluded allergen at \*\*any\*\* time tier/,
            );
            const [reducedFirstDiet, reducedSecondDiet, reducedTier] = statedGroups(
                planningPolicy,
                'recipe-coverage-matrix',
                'the reduced tier with one excluded allergen',
                /\*\*Reduced\*\* is (\w+) or (\w+) with any single excluded allergen at (\d+) minutes or looser/,
            );
            const [reducedNoAllergenTier] = statedNumbers(
                planningPolicy,
                'recipe-coverage-matrix',
                'the reduced tier with no excluded allergen',
                /plus any diet with no excluded allergen at the \*\*(\d+)-minute\*\* tier/,
            );

            // The axis value that means "no allergen excluded" is the one the
            // report tabulates that is not a named allergen, so it is derived
            // rather than retyped here.
            const unexcluded = coverageReport.dimensions.allergens.filter(
                (allergen) => NAMED_ALLERGENS.indexOf(allergen) === -1,
            );

            expect(unexcluded.length).toBe(1);

            // The allergen codes this section enumerates have TWO owners — the
            // report tabulates them and `preferences.logic.ts` declares them —
            // and the enumeration is compared against the report above. So the
            // two owners are compared with each other here: an allergen added
            // to the code without regenerating the report would otherwise leave
            // the document's nine-value list agreeing with one owner and
            // silently disagreeing with the other.
            twoSided(
                planningPolicy,
                'the named allergens the report tabulates, against the ones the code declares',
                PREFERENCES_LOGIC_PATH,
                coverageReport.dimensions.allergens
                    .filter((allergen) => allergen !== unexcluded[0])
                    .slice()
                    .sort(),
                NAMED_ALLERGENS.slice().sort(),
            );

            const guaranteedWithout = coverageReport.guaranteedCells.filter(
                (cell) => cell.allergen === unexcluded[0],
            );
            const guaranteedWith = coverageReport.guaranteedCells.filter((cell) => cell.allergen !== unexcluded[0]);
            const reducedWith = coverageReport.reducedCells.filter((cell) => cell.allergen !== unexcluded[0]);
            const reducedWithout = coverageReport.reducedCells.filter((cell) => cell.allergen === unexcluded[0]);

            twoSided(
                planningPolicy,
                'the tightest tier guaranteed with no excluded allergen',
                COVERAGE_REPORT_PATH,
                guaranteedTier,
                Math.min(...guaranteedWithout.map((cell) => cell.timeTier)),
            );
            twoSided(
                planningPolicy,
                'the slots guaranteed with no excluded allergen',
                COVERAGE_REPORT_PATH,
                coverageReport.dimensions.slots.slice().sort(),
                distinct(guaranteedWithout.map((cell) => cell.slot)).sort(),
            );
            twoSided(
                planningPolicy,
                'the diet guaranteed with one excluded allergen',
                COVERAGE_REPORT_PATH,
                [unrestrictedDiet],
                distinct(guaranteedWith.map((cell) => cell.diet)),
            );
            twoSided(
                planningPolicy,
                'the tiers guaranteed with one excluded allergen',
                COVERAGE_REPORT_PATH,
                coverageReport.dimensions.timeTiers.slice().sort(),
                distinct(guaranteedWith.map((cell) => String(cell.timeTier)))
                    .map((tier) => toNumber('a guaranteed tier', tier))
                    .sort(),
            );
            twoSided(
                planningPolicy,
                'the diets reduced with one excluded allergen',
                COVERAGE_REPORT_PATH,
                [reducedFirstDiet, reducedSecondDiet].sort(),
                distinct(reducedWith.map((cell) => cell.diet)).sort(),
            );
            twoSided(
                planningPolicy,
                'the tightest tier reduced with one excluded allergen',
                COVERAGE_REPORT_PATH,
                toNumber('the reduced tier', reducedTier),
                Math.min(...reducedWith.map((cell) => cell.timeTier)),
            );
            twoSided(
                planningPolicy,
                'the tier reduced with no excluded allergen',
                COVERAGE_REPORT_PATH,
                [reducedNoAllergenTier],
                distinct(reducedWithout.map((cell) => String(cell.timeTier))).map((tier) =>
                    toNumber('a reduced tier', tier),
                ),
            );
        });

        it('states two boundaries of the enumeration the report bears out', () => {
            const promised = coverageReport.guaranteedCells.concat(coverageReport.reducedCells);
            const tightestTier = coverageReport.dimensions.timeTiers[0];

            // Both sentences are read out of the document rather than retyped
            // here: a gate that quoted them in a comment could not notice the
            // document changing its mind about either one.
            const [statedTightestTier, statedTightestDiet] = statedGroups(
                planningPolicy,
                'recipe-coverage-matrix',
                'the diet the tightest tier is guaranteed for',
                /the (\d+)-minute tier is guaranteed only for the `(\w+)` diet/,
            );
            const [statedSlot] = statedGroups(
                planningPolicy,
                'recipe-coverage-matrix',
                'the slot promised only where no allergen is excluded',
                /\*\*(\w+) is promised only where no allergen is excluded\*\*/,
            );

            twoSided(
                planningPolicy,
                'the tightest cooking-time tier the matrix tabulates',
                COVERAGE_REPORT_PATH,
                toNumber('the tightest tier', statedTightestTier),
                tightestTier,
            );
            twoSided(
                planningPolicy,
                `the diets guaranteed at the ${tightestTier}-minute tier`,
                COVERAGE_REPORT_PATH,
                [statedTightestDiet],
                distinct(
                    coverageReport.guaranteedCells
                        .filter((cell) => cell.timeTier === tightestTier)
                        .map((cell) => cell.diet),
                ).sort(),
            );

            twoSided(
                planningPolicy,
                'the slot promised only where no allergen is excluded',
                COVERAGE_REPORT_PATH,
                [statedSlot.toLowerCase()],
                coverageReport.dimensions.slots.filter(
                    (slot) => coverageReport.dimensions.mainSlots.indexOf(slot) === -1,
                ),
            );
            twoSided(
                planningPolicy,
                'the slots promised for a single excluded allergen',
                COVERAGE_REPORT_PATH,
                coverageReport.dimensions.mainSlots.slice().sort(),
                distinct(promised.filter((cell) => cell.allergen !== 'none').map((cell) => cell.slot)).sort(),
            );

            // The two tiers are disjoint, which is what lets the document
            // present them as separate promises rather than nested ones.
            const guaranteedKeys = coverageReport.guaranteedCells.map(cellKey);

            expect(coverageReport.reducedCells.map(cellKey).filter((key) => guaranteedKeys.indexOf(key) !== -1)).toEqual(
                [],
            );
        });
    });
});
