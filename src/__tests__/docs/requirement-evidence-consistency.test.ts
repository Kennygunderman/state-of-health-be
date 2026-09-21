/**
 * The requirement-evidence checklist against the artefacts it quotes.
 *
 * WHAT THIS FILE IS FOR. `docs/meal-planning/requirement-evidence-checklist.md`
 * is the delivery's acceptance record: a reviewer reads its figures instead of
 * re-running every gate. That makes a stale figure in it a defect of the same
 * class as a broken endpoint — it was found as one at the final boundary, where
 * the document still claimed 42 recipes against a corpus of 121, four
 * migrations against a ledger of five, and a test inventory two remediations
 * old. Prose cannot be held to a corpus by review alone, so these cases parse
 * the figures OUT OF THE DOCUMENT and compare each one against the
 * machine-readable artefact it describes. A corpus, ledger, manifest or report
 * that moves without the document moving with it fails here.
 *
 * THE DIRECTION OF EVERY ASSERTION IS DOCUMENT AGAINST ARTEFACT. Each case
 * reads the number the document states and compares it with the number the
 * artefact holds; no figure is asserted against a literal written here, because
 * a literal would only pin this file to the artefact and would leave the
 * document free to drift — which is the failure being prevented. The parses are
 * deliberately anchored on the document's own phrasing and every one of them
 * fails loudly when it matches nothing, so rewording a row is a red build (with
 * a message naming the row) rather than a silently skipped check.
 *
 * WHY IT NEEDS NO DATABASE (Rule backend-architecture §1.2/§11). Every input is
 * a committed file: the checklist, the recipe corpus and its coverage report,
 * `prisma/migrations/`, the catalogue release manifest, the benchmark report and
 * the two schema-evidence captures. Nothing here opens a connection, reads an
 * environment variable, starts a script or makes a vendor call, so it runs in
 * milliseconds anywhere the repository is checked out. The behaviour behind
 * those artefacts is covered by the suites that produce them —
 * `scripts/catalog-load.test.ts`, `scripts/recipes-seed.test.ts`,
 * `scripts/search-benchmark.test.ts`, `api/seed-rerun.test.ts` and
 * `setup/testDb.test.ts`; what belongs here is the agreement between the
 * document and those files.
 *
 * TWO FIGURES ARE DELIBERATELY NOT ASSERTED, AND THE REASONS ARE DIFFERENT.
 *
 *  1. The suite inventory itself — "65 of 65 suites passed, 12,033 tests" in
 *     check 7 — is SELF-REFERENTIAL: this file is a suite, and its cases are
 *     tests, so adding or extending it changes the very numbers an assertion
 *     here would check, which makes such an assertion wrong the moment it is
 *     written (and wrong again after every future test). The document's own
 *     rule covers it instead: check 7 is re-measured by running
 *     `NODE_ENV=test ALLOW_DB_TRUNCATE=true npm test` and reading the run's
 *     summary, which is the only honest source for a suite's own size.
 *
 *  2. The app-side figures — the two screens without an `index.util.ts`, the
 *     app suite and lint counts, and the token-literal gate's scanned-file
 *     count — live in the OTHER repository. This suite reads backend-owned
 *     artefacts only: reaching across into the app submodule would make a
 *     backend gate fail for a reason that has nothing to do with the backend,
 *     and would pass vacuously wherever that submodule is not checked out.
 *     Those figures are corrected in prose and evidenced by the app's own
 *     gates, which check 20 to 23 record.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** The backend package root, three levels above `src/__tests__/docs/`. */
const BACKEND_ROOT = join(__dirname, '..', '..', '..');

const CHECKLIST_PATH = join(BACKEND_ROOT, 'docs', 'meal-planning', 'requirement-evidence-checklist.md');
const RECIPES_DIRECTORY = join(BACKEND_ROOT, 'data', 'meal-planning', 'recipes');
const COVERAGE_REPORT_PATH = join(RECIPES_DIRECTORY, 'coverage-report.json');
const MIGRATIONS_DIRECTORY = join(BACKEND_ROOT, 'prisma', 'migrations');
const RELEASE_MANIFEST_PATH = join(
    BACKEND_ROOT,
    'data',
    'meal-planning',
    'catalog',
    'releases',
    'v1',
    'manifest.json',
);
const BENCHMARK_REPORT_PATH = join(
    BACKEND_ROOT,
    'data',
    'meal-planning',
    'reports',
    'latest',
    'benchmark-report.json',
);
const EXPECTED_SCHEMA_DIFF_PATH = join(BACKEND_ROOT, 'docs', 'meal-planning', 'expected-schema-diff.sql');
const SCHEMA_CATALOG_EVIDENCE_PATH = join(BACKEND_ROOT, 'docs', 'meal-planning', 'schema-catalog-evidence.sql');

/** The one file every case reads, loaded once rather than per assertion. */
const checklist = readFileSync(CHECKLIST_PATH, 'utf8');

/**
 * The same document with every run of whitespace collapsed to one space.
 *
 * Prose in this document is hard-wrapped, so a figure and the words around it
 * are routinely split across lines and a re-wrap moves the break. Matching
 * prose against the collapsed form makes these parses survive re-wrapping,
 * which is a formatting change rather than a factual one. Table rows are
 * matched against the raw text instead, because a row is one line by
 * construction and the line anchor is what keeps a row parse from wandering
 * into a neighbouring row.
 */
const prose = checklist.replace(/\s+/g, ' ');

/**
 * Reads a number the document states, whether or not it carries thousands
 * separators (`10,928` and `10928` are the same figure to a reviewer, and the
 * document uses the separated form in prose).
 */
const statedNumber = (text: string): number => {
    const digits = text.replace(/,/g, '');
    const value = Number(digits);
    if (!Number.isFinite(value)) {
        throw new Error(`the checklist states "${text}" where a number was expected`);
    }
    return value;
};

/**
 * Applies a parse to the document and fails with the row or section it was
 * aimed at when it matches nothing.
 *
 * A regex that silently fails to match would turn a real comparison into a
 * no-op, which is the one failure mode a consistency gate must not have: the
 * gate would keep passing while the figure it is meant to hold drifted freely.
 * So a miss throws, and the message says WHICH part of the document to look at
 * and WHY the parse exists, so whoever reworded it knows what to re-point.
 */
const parseFigures = (source: string, pattern: RegExp, documentLocation: string): string[] => {
    const match = source.match(pattern);
    if (match === null) {
        throw new Error(
            `requirement-evidence-checklist.md no longer states its figures where this gate reads them: ` +
                `${documentLocation}. The parse ${String(pattern)} matched nothing. Re-point this case at the ` +
                'current wording, or restore the figures — do not delete the case, which is what keeps the ' +
                'document and the artefacts from drifting apart.',
        );
    }
    return match.slice(1).map(group => group ?? '');
};

/** Every capture of a repeated parse, failing when the parse matches nothing. */
const parseAllFigures = (source: string, pattern: RegExp, documentLocation: string): string[][] => {
    const matches = [...source.matchAll(pattern)];
    if (matches.length === 0) {
        throw new Error(
            `requirement-evidence-checklist.md no longer carries the rows this gate reads: ${documentLocation}. ` +
                `The parse ${String(pattern)} matched nothing.`,
        );
    }
    return matches.map(match => match.slice(1).map(group => group ?? ''));
};

/**
 * The run index of "What was verified in this environment", as its own lines.
 *
 * Scoped to that one table rather than matched across the document, because the
 * requirement-areas table numbers its rows 1 to 10 as well: a bare `| 6 |`
 * parse would read requirement area 6 and compare the wrong row's numbers.
 */
const checkTableRows: readonly string[] = (() => {
    const lines = checklist.split('\n');
    const header = lines.findIndex(line => line.startsWith('| # | Check | Command | Outcome |'));
    if (header === -1) {
        throw new Error(
            'requirement-evidence-checklist.md no longer carries the "| # | Check | Command | Outcome |" run ' +
                'index; this gate reads several of its figures out of that table.',
        );
    }
    const rows: string[] = [];
    for (let index = header + 1; index < lines.length; index += 1) {
        const line = lines[index] ?? '';
        if (!line.startsWith('|')) {
            break;
        }
        rows.push(line);
    }
    return rows;
})();

/**
 * One line of the check table, by its leading check number.
 *
 * Each case parses the figures it needs out of a single row rather than out of
 * the whole document, so a figure repeated elsewhere cannot satisfy a parse
 * aimed at this table.
 */
const checkTableRow = (checkNumber: number): string => {
    const row = checkTableRows.find(line => line.startsWith(`| ${checkNumber} |`));
    if (row === undefined) {
        throw new Error(
            `requirement-evidence-checklist.md has no check ${checkNumber} row in ` +
                '"What was verified in this environment"; this gate reads its figures from that row.',
        );
    }
    return row;
};

interface CoverageReport {
    readonly schemaVersion: number;
    readonly recipeCount: number;
    readonly crossListedRecipeCount: number;
}

interface RecipeIngredient {
    readonly sourceKey: string;
}

interface RecipeFile {
    readonly slug: string;
    readonly ingredients: readonly RecipeIngredient[];
}

interface ReleaseManifestCounts {
    readonly published_foods: number;
    readonly aliases: number;
    readonly portions: number;
    readonly components: number;
    readonly validation_records: number;
    readonly published_ingredient_derived: number;
}

interface ReleaseManifestAcceptance {
    readonly requirement_met: boolean;
    readonly required_published_items: number;
    readonly published_items: number;
    readonly shortfall_against_requirement: number;
    readonly categories_below_target: number;
    readonly per_category_shortfall_total: number;
    readonly every_category_meets_its_target: boolean;
}

interface ReleaseManifestCategory {
    readonly category: string;
    readonly published_target: number;
    readonly published: number;
    readonly shortfall: number;
}

interface ReleaseManifestCoverage {
    readonly published_target_total: number;
    readonly published_total: number;
    readonly shortfall_total: number;
    readonly published_gap_to_total: number;
    readonly by_category: readonly ReleaseManifestCategory[];
}

interface ReleaseManifest {
    readonly counts: ReleaseManifestCounts;
    readonly acceptance: ReleaseManifestAcceptance;
    readonly coverage: ReleaseManifestCoverage;
    readonly model_versions: { readonly ai_generated_foods: number; readonly reviewed_foods: number };
}

interface BenchmarkResult {
    readonly id: string;
    readonly rank: number | null;
    readonly matchSetTotal: number;
}

interface BenchmarkReport {
    readonly generatedAt: string;
    readonly rollups: {
        readonly queriesScored: number;
        readonly topThreeHitRate: number;
        readonly topTenHitRate: number;
        readonly topThreeHitCount: number;
        readonly topTenHitCount: number;
        readonly zeroResultRate: number;
    };
    readonly latency: {
        readonly p95LatencyMs: number;
        readonly samples: number;
        readonly measuredAtLimit: number;
    };
    readonly results: readonly BenchmarkResult[];
}

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;

const coverageReport = readJson<CoverageReport>(COVERAGE_REPORT_PATH);
const releaseManifest = readJson<ReleaseManifest>(RELEASE_MANIFEST_PATH);
const benchmarkReport = readJson<BenchmarkReport>(BENCHMARK_REPORT_PATH);

/** Every file the committed recipe directory holds, the coverage report included. */
const recipeDirectoryFiles = readdirSync(RECIPES_DIRECTORY).filter(name => name.endsWith('.json'));

/** The recipe files alone — the directory less the report the seed writes into it. */
const recipeFileNames = recipeDirectoryFiles.filter(name => name !== 'coverage-report.json');

const recipeFiles: readonly RecipeFile[] = recipeFileNames.map(name =>
    readJson<RecipeFile>(join(RECIPES_DIRECTORY, name)),
);

/** The ingredient rows the seed writes: one per ingredient entry in the corpus. */
const committedIngredientRows = recipeFiles.reduce((total, recipe) => total + recipe.ingredients.length, 0);

/** The catalogue foods the corpus draws on, by the stable `source_key` it references them with. */
const committedDistinctIngredientFoods = new Set(
    recipeFiles.flatMap(recipe => recipe.ingredients.map(ingredient => ingredient.sourceKey)),
).size;

/** The tracked migration ledger: directory names only, never `migration_lock.toml`. */
const migrationDirectories = readdirSync(MIGRATIONS_DIRECTORY, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();

/**
 * The count words this document writes its small counts with.
 *
 * The migration row states its count twice — once as a word ("all five of") and
 * once as the list of names — and both are checked, because a sixth migration
 * added to the list without the word moving reads as deliberate and is not.
 */
const COUNT_WORDS: readonly string[] = [
    'zero',
    'one',
    'two',
    'three',
    'four',
    'five',
    'six',
    'seven',
    'eight',
    'nine',
    'ten',
];

describe('the recipe corpus the checklist states', () => {
    it('states the recipe and ingredient-row counts the committed corpus holds', () => {
        const [statedRecipes, statedFloor, statedIngredientRows] = parseFigures(
            prose,
            /\| ([\d,]+) recipes against a floor of (\d+), with ([\d,]+) ingredient rows\./,
            'requirement area 4\'s notes cell ("N recipes against a floor of 40, with N ingredient rows")',
        );

        expect(statedNumber(statedRecipes)).toBe(recipeFileNames.length);
        expect(statedNumber(statedRecipes)).toBe(coverageReport.recipeCount);
        expect(statedNumber(statedIngredientRows)).toBe(committedIngredientRows);
        // The floor is the AAP's requirement (§0.7.3 / §0.9.3), not a measurement,
        // so it is pinned as the bound the corpus must clear rather than compared.
        expect(statedNumber(statedFloor)).toBe(40);
        expect(statedNumber(statedRecipes)).toBeGreaterThanOrEqual(statedNumber(statedFloor));
    });

    it('quotes the seed event the corpus would produce', () => {
        const [created, ingredientRows] = parseFigures(
            checkTableRow(14),
            /`created: ([\d,]+), promoted: \d+, unchanged: \d+, ingredientRows: ([\d,]+)`/,
            'check 14\'s quoted `recipes_published` event',
        );

        expect(statedNumber(created)).toBe(recipeFileNames.length);
        expect(statedNumber(ingredientRows)).toBe(committedIngredientRows);
    });

    it('states the coverage report\'s own counts and the directory\'s file inventory', () => {
        const [schemaVersion, recipeCount, crossListed] = parseFigures(
            checkTableRow(14),
            /`schemaVersion` (\d+), `recipeCount` ([\d,]+) and `crossListedRecipeCount` ([\d,]+)/,
            'check 14\'s coverage-report figures',
        );
        const [statedFiles, statedRecipesInDirectory] = parseFigures(
            checkTableRow(14),
            /holds ([\d,]+) files, the ([\d,]+) recipes and that report/,
            'check 14\'s recipe-directory inventory',
        );

        expect(statedNumber(schemaVersion)).toBe(coverageReport.schemaVersion);
        expect(statedNumber(recipeCount)).toBe(coverageReport.recipeCount);
        expect(statedNumber(crossListed)).toBe(coverageReport.crossListedRecipeCount);
        expect(statedNumber(statedFiles)).toBe(recipeDirectoryFiles.length);
        expect(statedNumber(statedRecipesInDirectory)).toBe(recipeFileNames.length);
        expect(statedNumber(statedFiles)).toBe(statedNumber(statedRecipesInDirectory) + 1);
    });

    it('states the database shape and the distinct catalogue foods the corpus references', () => {
        const [recipes, versions] = parseFigures(
            checkTableRow(14),
            /([\d,]+) `recipes`, ([\d,]+) `recipe_versions`/,
            'check 14\'s database read-back',
        );
        const [ingredientRows, distinctFoods] = parseFigures(
            checkTableRow(14),
            /([\d,]+) `recipe_ingredients` rows drawing on \*\*([\d,]+)\*\* distinct catalogue foods/,
            'check 14\'s ingredient-row and distinct-food figures',
        );

        expect(statedNumber(recipes)).toBe(recipeFileNames.length);
        // One current version per recipe on a first seed: the corpus is the count.
        expect(statedNumber(versions)).toBe(recipeFileNames.length);
        expect(statedNumber(ingredientRows)).toBe(committedIngredientRows);
        expect(statedNumber(distinctFoods)).toBe(committedDistinctIngredientFoods);
    });
});

describe('the migration ledger the checklist lists', () => {
    it('names every tracked migration, and only those', () => {
        const names = parseAllFigures(
            checkTableRow(6),
            /`(\d{14}_[a-z0-9_]+)`/g,
            'check 6\'s list of applied migrations',
        ).map(([name]) => name);

        expect([...names].sort()).toEqual(migrationDirectories);
        expect(new Set(names).size).toBe(names.length);
    });

    it('states the ledger\'s size in words as well as in names', () => {
        const expectedWord = COUNT_WORDS[migrationDirectories.length];
        if (expectedWord === undefined) {
            throw new Error(
                `prisma/migrations now holds ${migrationDirectories.length} migrations, more than this gate ` +
                    'knows a count word for. Extend COUNT_WORDS and update check 6.',
            );
        }

        expect(checkTableRow(6)).toContain(`all ${expectedWord} of`);
        expect(checkTableRow(6)).toContain(`(${expectedWord} directories beside \`migration_lock.toml\`)`);
    });
});

describe('the catalogue counts the checklist states', () => {
    it('states the release manifest\'s counts block', () => {
        const [foods, aliases, portions, components, validationRecords] = parseFigures(
            checkTableRow(12),
            /\*\*exit 0\.\*\* ([\d,]+) foods, ([\d,]+) aliases, ([\d,]+) portions, ([\d,]+) compositions, ([\d,]+) validation records written/,
            'check 12\'s loaded-count figures',
        );
        const { counts } = releaseManifest;

        expect(statedNumber(foods)).toBe(counts.published_foods);
        expect(statedNumber(aliases)).toBe(counts.aliases);
        expect(statedNumber(portions)).toBe(counts.portions);
        expect(statedNumber(components)).toBe(counts.components);
        expect(statedNumber(validationRecords)).toBe(counts.validation_records);
    });

    it('states that the release publishes no ingredient-derived row', () => {
        const [publishedIngredientDerived] = parseFigures(
            prose,
            /`published_ingredient_derived` is (\d+)/,
            'the catalogue section\'s statement about generated rows',
        );

        expect(statedNumber(publishedIngredientDerived)).toBe(releaseManifest.counts.published_ingredient_derived);
    });
});

describe('the per-category shortfall the checklist reports', () => {
    const { acceptance, coverage } = releaseManifest;
    const shortCategories = coverage.by_category.filter(category => category.shortfall > 0);

    it('tabulates every category below its target, with that category\'s own numbers', () => {
        const rows = parseAllFigures(
            checklist,
            /^\| `([a-z_]+)` \| (\d+) \| (\d+) \| (\d+) \|$/gm,
            'the per-category shortfall table under "The thirteen categories, and the disposition taken on them"',
        );

        const tabulated = rows.map(([category, target, published, shortfall]) => ({
            category,
            published_target: statedNumber(target ?? ''),
            published: statedNumber(published ?? ''),
            shortfall: statedNumber(shortfall ?? ''),
        }));
        const expected = [...shortCategories]
            .map(({ category, published_target, published, shortfall }) => ({
                category,
                published_target,
                published,
                shortfall,
            }))
            .sort((left, right) => right.shortfall - left.shortfall);

        expect(tabulated).toEqual(expected);
        expect(tabulated).toHaveLength(acceptance.categories_below_target);
        expect(tabulated.reduce((total, row) => total + row.shortfall, 0)).toBe(
            acceptance.per_category_shortfall_total,
        );
    });

    it('states the acceptance block that makes the aggregate requirement met', () => {
        const [requirementMet] = parseFigures(
            prose,
            /`requirement_met: (true|false)`/,
            'the per-category section\'s acceptance figures',
        );
        const [requiredItems] = parseFigures(
            prose,
            /`required_published_items: (\d+)`/,
            'the per-category section\'s required-count figure',
        );
        const [publishedItems] = parseFigures(
            prose,
            /`published_items: (\d+)`/,
            'the per-category section\'s published-count figure',
        );
        const [shortfallAgainstRequirement] = parseFigures(
            prose,
            /`shortfall_against_requirement: (\d+)`/,
            'the per-category section\'s requirement-shortfall figure',
        );

        expect(requirementMet).toBe(String(acceptance.requirement_met));
        expect(statedNumber(requiredItems)).toBe(acceptance.required_published_items);
        expect(statedNumber(publishedItems)).toBe(acceptance.published_items);
        expect(statedNumber(shortfallAgainstRequirement)).toBe(acceptance.shortfall_against_requirement);
    });

    it('states the planned total and the gap to it, which is not the requirement', () => {
        const [plannedTotal, publishedTotal] = parseFigures(
            prose,
            /targets sum to ([\d,]+), so ([\d,]+) leaves/,
            'the per-category section\'s planned-total sentence',
        );
        const [gapToTotal] = parseFigures(
            prose,
            /`coverage\.published_gap_to_total: (\d+)`/,
            'the per-category section\'s gap-to-planned-total figure',
        );

        expect(statedNumber(plannedTotal)).toBe(coverage.published_target_total);
        expect(statedNumber(publishedTotal)).toBe(coverage.published_total);
        expect(statedNumber(gapToTotal)).toBe(coverage.published_gap_to_total);
        expect(statedNumber(gapToTotal)).toBe(coverage.published_target_total - coverage.published_total);
    });

    it('states the shortfall total and the per-category verdict the manifest records', () => {
        const [shortfallTotal] = parseFigures(
            prose,
            /sum to the \*\*([\d,]+)\*\* the manifest records as `acceptance\.per_category_shortfall_total`/,
            'the per-category section\'s shortfall-total sentence',
        );
        const [categoriesBelowTarget] = parseFigures(
            prose,
            /`categories_below_target: (\d+)`/,
            'the per-category section\'s below-target count',
        );
        const [everyCategoryMeetsItsTarget] = parseFigures(
            prose,
            /`every_category_meets_its_target: (true|false)`/,
            'the per-category section\'s per-category verdict',
        );

        expect(statedNumber(shortfallTotal)).toBe(acceptance.per_category_shortfall_total);
        expect(statedNumber(shortfallTotal)).toBe(coverage.shortfall_total);
        expect(statedNumber(categoriesBelowTarget)).toBe(acceptance.categories_below_target);
        expect(everyCategoryMeetsItsTarget).toBe(String(acceptance.every_category_meets_its_target));
    });

    it('states that no AI-generated or reviewed row is in the release to close the gap with', () => {
        const [aiGenerated, reviewed] = parseFigures(
            prose,
            /`model_versions\.ai_generated_foods` is \*\*(\d+)\*\* and `reviewed_foods` is \*\*(\d+)\*\*/,
            'the disposition\'s statement about generated and reviewed rows',
        );

        expect(statedNumber(aiGenerated)).toBe(releaseManifest.model_versions.ai_generated_foods);
        expect(statedNumber(reviewed)).toBe(releaseManifest.model_versions.reviewed_foods);
    });
});

describe('the search benchmark figures the checklist quotes', () => {
    it('states the committed report\'s relevance rollups', () => {
        const [topThreeRate, topThreeCount, scoredForTopThree, topTenRate, topTenCount, scoredForTopTen] =
            parseFigures(
                prose,
                /top-3 ([\d.]+) \(([\d,]+) of ([\d,]+)\), top-10 ([\d.]+) \(([\d,]+) of ([\d,]+)\)/,
                'check 15\'s hit-rate figures',
            );
        const { rollups } = benchmarkReport;

        expect(statedNumber(topThreeRate)).toBe(rollups.topThreeHitRate);
        expect(statedNumber(topThreeCount)).toBe(rollups.topThreeHitCount);
        expect(statedNumber(topTenRate)).toBe(rollups.topTenHitRate);
        expect(statedNumber(topTenCount)).toBe(rollups.topTenHitCount);
        expect(statedNumber(scoredForTopThree)).toBe(rollups.queriesScored);
        expect(statedNumber(scoredForTopTen)).toBe(rollups.queriesScored);
    });

    it('states the committed report\'s zero-result rate, p95 and sample conditions', () => {
        const [zeroResultRate, p95] = parseFigures(
            prose,
            /zero-result rate (\d+) and p95 ([\d.]+) ms/,
            'check 15\'s zero-result and latency figures',
        );
        const [samples, limit] = parseFigures(
            prose,
            /over ([\d,]+) timed samples at limit (\d+)/,
            'check 15\'s sample count and page limit',
        );

        expect(statedNumber(zeroResultRate)).toBe(benchmarkReport.rollups.zeroResultRate);
        expect(statedNumber(p95)).toBe(benchmarkReport.latency.p95LatencyMs);
        expect(statedNumber(samples)).toBe(benchmarkReport.latency.samples);
        expect(statedNumber(limit)).toBe(benchmarkReport.latency.measuredAtLimit);
    });

    it('dates the figures by the committed report\'s own `generatedAt`', () => {
        const [generatedAt] = parseFigures(
            prose,
            /`generatedAt` (\d{4}-\d{2}-\d{2}T[\d:.]+Z)/,
            'check 15\'s `generatedAt` citation',
        );

        expect(generatedAt).toBe(benchmarkReport.generatedAt);
    });

    it('names exactly the queries that fall outside the top ten', () => {
        const [section] = parseFigures(
            checklist,
            /#### The search benchmark is met, and what it does not cover\n([\s\S]*?)\n## /,
            'the section "The search benchmark is met, and what it does not cover"',
        );
        const namedQueryIds = new Set([...(section ?? '').matchAll(/\bq\d{3}\b/g)].map(match => match[0]));
        const missedQueryIds = new Set(
            benchmarkReport.results
                .filter(result => result.rank === null || result.rank > 10)
                .map(result => result.id),
        );

        expect([...namedQueryIds].sort()).toEqual([...missedQueryIds].sort());
    });
});

describe('the schema-evidence figures the checklist quotes', () => {
    /** A capture's payload: everything that is neither a line comment nor blank. */
    const payloadLines = (text: string): string[] =>
        text
            .split('\n')
            .map(line => line.trimEnd())
            .filter(line => line !== '' && !line.startsWith('--'));

    it('states how many statements the committed migrate-diff capture holds', () => {
        const [statements] = parseFigures(
            checkTableRow(10),
            /\*\*(\d+) statements?\*\* compared/,
            'check 10\'s migrate-diff statement count',
        );

        expect(statedNumber(statements)).toBe(payloadLines(readFileSync(EXPECTED_SCHEMA_DIFF_PATH, 'utf8')).length);
    });

    it('states the composition of the committed `pg-catalog-expected` payload', () => {
        const evidence = readFileSync(SCHEMA_CATALOG_EVIDENCE_PATH, 'utf8');
        const [expectedSection] = parseFigures(
            evidence,
            /^-- >>> BEGIN pg-catalog-expected$([\s\S]*?)^-- >>> END pg-catalog-expected$/m,
            'the `pg-catalog-expected` section of schema-catalog-evidence.sql',
        );
        const lines = payloadLines(expectedSection ?? '');
        const startingWith = (prefix: string): string[] => lines.filter(line => line.startsWith(`${prefix} `));

        const [statedLines] = parseFigures(
            checkTableRow(10),
            /all \*\*(\d+) lines\*\* of the `pg-catalog-expected` payload/,
            'check 10\'s payload line count',
        );
        const [generatedColumns, indexRows, arrayColumnRows, notNullArrayRows] = parseFigures(
            checkTableRow(10),
            /(\d+) generated columns?, (\d+) index rows and (\d+) `array_column` rows, (\d+) of which carry `not_null=true`/,
            'check 10\'s payload composition',
        );

        expect(statedNumber(statedLines)).toBe(lines.length);
        expect(statedNumber(generatedColumns)).toBe(startingWith('generated_column').length);
        expect(statedNumber(indexRows)).toBe(startingWith('index').length);
        expect(statedNumber(arrayColumnRows)).toBe(startingWith('array_column').length);
        expect(statedNumber(notNullArrayRows)).toBe(
            startingWith('array_column').filter(line => line.includes('not_null=true')).length,
        );
    });
});
