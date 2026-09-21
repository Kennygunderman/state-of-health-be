// The dependency-audit gate: `npm audit --omit=dev` compared against a
// reviewed, dated baseline, failing only on findings the baseline does not
// already carry.
//
// It answers QA finding F05: the CI pipeline this project authored has no
// dependency-audit step (`grep -c "npm audit" .github/workflows/ci.yml` → 0)
// while `npm audit --omit=dev` reports 4 critical and 5 high advisories in the
// production tree. Every one of those was individually proven unreachable at
// runtime and the whole cluster clears only with `firebase-admin@14.4.0`, a
// semver-major this work is not allowed to perform — so a plain
// `npm audit --audit-level=high` would fail every build from the first one and
// be switched off within a week. A baselined gate fails on the NEXT advisory
// instead, which is the control that was actually missing.
//
// WHY IT IS A DEPENDENCY-FREE `.mjs`, and why it mirrors
// `mobile/scripts/lint-baseline-compare.mjs`. This repository already gates the
// mobile lint findings exactly this way — a committed baseline plus a
// comparator that runs the tool and diffs against it — and the two gates are
// deliberately the same shape so an operator who has read one understands the
// other. Every import here is a `node:` builtin, so the gate runs on a checkout
// with no `node_modules`; nothing in `scripts/` type-checks it either
// (`allowJs` is off in all three tsconfigs), which is why it is `.mjs` rather
// than `.ts` and needs no build step.
//
// WHAT A FINDING IS KEYED ON, and what that buys. `npm audit`'s report is
// keyed by PACKAGE, and each package's `via` array holds either advisory
// objects (the root findings) or the names of other packages (this package is
// affected only through them). This gate derives one key per ADVISORY —
// `advisory:<source>:<package>` — plus one key per package that is affected
// only indirectly (`indirect:<package>`). Neither form contains a version
// range, a dependency path, a line number or an absolute path, so the keys
// survive a lockfile refresh, a hoisting change and a different checkout root:
// the baseline stays valid until the SET OF ADVISORIES changes, which is
// exactly when a human should look at it again.
//
// WHAT IT REFUSES TO DO. It never writes the baseline. A refresh is a reviewed
// data change: the gate prints each new finding as the JSON entry it would need,
// and a human pastes it in with a reason and a new review date. It also refuses
// a baseline whose entries carry no reason or whose header carries no review
// date, so "reviewed" cannot decay into "generated".

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SCRIPT_NAME = 'audit-baseline-compare';

const EXIT_OK = 0;
const EXIT_GATE_FAILED = 1;
const EXIT_UNUSABLE = 2;

/** The backend package root: this file's directory's parent. */
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULT_BASELINE_PATH = join('docs', 'meal-planning', 'dependency-audit-baseline.json');

/**
 * The audit this gate is defined over. `--omit=dev` is the whole point: the dev
 * toolchain is not shipped, and auditing it would make the gate fail on the
 * test runner's transitive tree rather than on anything a user can reach.
 */
const AUDIT_ARGUMENTS = ['audit', '--omit=dev', '--json'];

/**
 * The report schema this file's key derivation was written against.
 *
 * A different version is refused rather than parsed hopefully: `npm audit`'s
 * JSON shape is what the keys are derived from, and a schema change could
 * silently produce keys that match nothing in the baseline (every finding
 * "new") or everything (the gate passing blind).
 */
const SUPPORTED_AUDIT_REPORT_VERSION = 2;

/** npm's severity vocabulary, most serious first — the order findings are listed in. */
const SEVERITY_ORDER = ['critical', 'high', 'moderate', 'low', 'info'];

/** Beyond this, the gate prints a note asking for a re-review. It never fails on age. */
const REVIEW_STALE_AFTER_DAYS = 90;

const MILLISECONDS_PER_DAY = 86_400_000;

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const USAGE = [
    `Usage: node scripts/${SCRIPT_NAME}.mjs [--baseline <file>] [--report <file>]`,
    '',
    'Runs `npm audit --omit=dev --json` and compares it with the reviewed baseline at',
    `${DEFAULT_BASELINE_PATH}, failing only on findings the baseline does not carry.`,
    '',
    'Findings are keyed as advisory:<source>:<package> for each advisory in the report, and',
    'indirect:<package> for a package the report lists only as affected through others. A key',
    'carries no version range, no dependency path and no file path, so a lockfile refresh or a',
    'different checkout root does not invalidate the baseline.',
    '',
    '`npm audit` itself exits non-zero whenever any advisory exists, so its status is captured and',
    'ignored; what is NOT ignored is a report that cannot be produced or parsed at all, which fails',
    'the gate rather than passing it.',
    '',
    '--report <file> compares a captured report instead of running npm. It is how the gate is',
    'exercised against a report that is not this checkout\'s — including proving that a new advisory',
    'is actually caught.',
    '',
    'The gate never writes the baseline. When it fails it prints each new finding as the entry that',
    'would accept it; a human pastes it in with a reason and a new reviewedOn date, in a reviewed',
    'commit. A baseline whose entries carry no reason, or whose header carries no review date, is',
    'refused as unusable.',
    '',
    'Exit codes:',
    `  ${EXIT_OK}  the gate passed — every finding in the report is accepted by the baseline`,
    `  ${EXIT_GATE_FAILED}  the gate failed — at least one finding is not in the baseline`,
    `  ${EXIT_UNUSABLE}  unusable input — bad arguments, an unreadable or malformed baseline or report, a`,
    '     report schema this comparator was not written against, or npm audit producing no report',
].join('\n');

/** One line of output, so the transport is in one place. */
const say = (line = '') => {
    process.stdout.write(`${line}\n`);
};

/** Stops with a reason on stderr, for every condition that makes an answer impossible. */
const refuse = (reason, detail) => {
    process.stderr.write(`${SCRIPT_NAME}: ${reason}\n`);
    if (detail !== undefined && detail !== '') {
        process.stderr.write(`${detail}\n`);
    }
    process.exit(EXIT_UNUSABLE);
};

const parseArguments = (argv) => {
    const options = { baseline: join(REPOSITORY_ROOT, DEFAULT_BASELINE_PATH), report: undefined };

    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];

        if (argument === '--help' || argument === '-h') {
            say(USAGE);
            process.exit(EXIT_OK);
        }

        const value = argv[index + 1];

        if (argument === '--baseline' || argument === '--report') {
            if (value === undefined || value.startsWith('--')) {
                refuse(`${argument} needs a file path.`, USAGE);
            }

            options[argument === '--baseline' ? 'baseline' : 'report'] = resolve(value);
            index += 1;
            continue;
        }

        refuse(`unrecognised argument "${argument}".`, USAGE);
    }

    return options;
};

const readJsonFile = (path, description) => {
    let text;

    try {
        text = readFileSync(path, 'utf8');
    } catch (error) {
        refuse(`${description} could not be read at ${path}.`, error instanceof Error ? error.message : String(error));
    }

    try {
        return JSON.parse(text);
    } catch (error) {
        refuse(`${description} at ${path} is not valid JSON.`, error instanceof Error ? error.message : String(error));
    }

    // Unreachable: both branches above exit. Present so every path returns.
    return undefined;
};

/**
 * Runs the audit and returns its parsed report.
 *
 * THE EXIT STATUS IS DELIBERATELY NOT A VERDICT. `npm audit` exits 1 whenever
 * any advisory exists at or above its audit level, which is the normal state of
 * this tree; treating that as failure is the gate this project cannot keep. What
 * IS a failure is producing no usable report — a missing npm, a registry that
 * cannot be reached, a crash — because a gate that cannot see the advisories
 * must not report that there are none.
 */
const runAudit = () => {
    const result = spawnSync('npm', AUDIT_ARGUMENTS, {
        cwd: REPOSITORY_ROOT,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
    });

    if (result.error !== undefined && result.error !== null) {
        refuse(
            `\`npm ${AUDIT_ARGUMENTS.join(' ')}\` could not be run, so the dependency audit produced no report.`,
            result.error.message,
        );
    }

    if (result.signal !== null && result.signal !== undefined) {
        refuse(`\`npm ${AUDIT_ARGUMENTS.join(' ')}\` was killed by ${result.signal} before it produced a report.`);
    }

    const stdout = typeof result.stdout === 'string' ? result.stdout.trim() : '';

    if (stdout.length === 0) {
        refuse(
            `\`npm ${AUDIT_ARGUMENTS.join(' ')}\` printed no report (exit ${result.status}).`,
            typeof result.stderr === 'string' ? result.stderr.trim() : undefined,
        );
    }

    try {
        return { report: JSON.parse(stdout), status: result.status };
    } catch (error) {
        refuse(
            `\`npm ${AUDIT_ARGUMENTS.join(' ')}\` printed something that is not JSON, so the report cannot be read.`,
            error instanceof Error ? error.message : String(error),
        );
    }

    return undefined;
};

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Validates the report's shape before anything is derived from it. */
const requireAuditReport = (report, origin) => {
    if (!isPlainObject(report)) {
        refuse(`the audit report from ${origin} is not an object.`);
    }

    if (report.auditReportVersion !== SUPPORTED_AUDIT_REPORT_VERSION) {
        refuse(
            `the audit report from ${origin} declares auditReportVersion ` +
                `${JSON.stringify(report.auditReportVersion)}; this gate derives its keys from version ` +
                `${SUPPORTED_AUDIT_REPORT_VERSION}.`,
            'Re-read the report shape and update the key derivation in this file before trusting the gate again.',
        );
    }

    if (!isPlainObject(report.vulnerabilities)) {
        refuse(`the audit report from ${origin} carries no "vulnerabilities" object.`);
    }

    return report;
};

const advisoryKey = (source, packageName) => `advisory:${source}:${packageName}`;

const indirectKey = (packageName) => `indirect:${packageName}`;

/**
 * Every finding in one report, as a stable key plus the facts a reviewer needs.
 *
 * An advisory with no `source` is keyed on its URL instead — `source` is npm's
 * own identifier and has always been present, but a key derived from nothing is
 * worse than a slightly longer one, and a finding that could not be keyed at all
 * would silently disappear from the comparison.
 */
const findingsIn = (report) => {
    const findings = new Map();

    for (const [packageName, entry] of Object.entries(report.vulnerabilities)) {
        if (!isPlainObject(entry)) {
            continue;
        }

        const via = Array.isArray(entry.via) ? entry.via : [];
        const advisories = via.filter(isPlainObject);

        for (const advisory of advisories) {
            const affected = typeof advisory.name === 'string' && advisory.name.length > 0 ? advisory.name : packageName;
            const identity =
                advisory.source !== undefined && advisory.source !== null
                    ? String(advisory.source)
                    : String(advisory.url ?? advisory.title ?? 'unidentified');
            const key = advisoryKey(identity, affected);

            if (!findings.has(key)) {
                findings.set(key, {
                    key,
                    package: affected,
                    severity: typeof advisory.severity === 'string' ? advisory.severity : String(entry.severity),
                    title: typeof advisory.title === 'string' ? advisory.title : '',
                    url: typeof advisory.url === 'string' ? advisory.url : '',
                });
            }
        }

        if (advisories.length === 0) {
            // Affected only through other packages. Keyed so that a package
            // NEWLY entering the vulnerable set is caught even when the root
            // advisory behind it is already accepted.
            const key = indirectKey(packageName);

            findings.set(key, {
                key,
                package: packageName,
                severity: typeof entry.severity === 'string' ? entry.severity : 'unknown',
                title: `affected through ${via.filter((item) => typeof item === 'string').join(', ') || 'another package'}`,
                url: '',
            });
        }
    }

    return findings;
};

/**
 * Validates the baseline and returns its accepted keys.
 *
 * The reason and the review date are REQUIRED, and that is the mechanism behind
 * "a refresh is a reviewed data change": a generated baseline cannot satisfy
 * them, so an entry can only arrive with a human's account of why it is
 * accepted.
 */
const requireBaseline = (baseline, path) => {
    if (!isPlainObject(baseline)) {
        refuse(`the baseline at ${path} is not an object.`);
    }

    if (typeof baseline.reviewedOn !== 'string' || !ISO_DATE_PATTERN.test(baseline.reviewedOn)) {
        refuse(
            `the baseline at ${path} carries no "reviewedOn" date in YYYY-MM-DD form.`,
            'The date is what makes the baseline reviewed rather than generated; add it in the same commit as the entries.',
        );
    }

    if (!Array.isArray(baseline.findings)) {
        refuse(`the baseline at ${path} carries no "findings" array.`);
    }

    const accepted = new Map();

    for (const [index, entry] of baseline.findings.entries()) {
        if (!isPlainObject(entry)) {
            refuse(`baseline finding #${index + 1} in ${path} is not an object.`);
        }

        if (typeof entry.key !== 'string' || entry.key.length === 0) {
            refuse(`baseline finding #${index + 1} in ${path} carries no "key".`);
        }

        if (typeof entry.reason !== 'string' || entry.reason.trim().length === 0) {
            refuse(
                `baseline finding "${entry.key}" in ${path} carries no "reason".`,
                'Every accepted advisory states why it is accepted, so the list cannot grow without a decision.',
            );
        }

        if (accepted.has(entry.key)) {
            refuse(`baseline finding "${entry.key}" in ${path} is listed twice.`);
        }

        accepted.set(entry.key, entry);
    }

    return { reviewedOn: baseline.reviewedOn, accepted };
};

const bySeverityThenKey = (left, right) => {
    const leftRank = SEVERITY_ORDER.indexOf(left.severity);
    const rightRank = SEVERITY_ORDER.indexOf(right.severity);
    const leftOrder = leftRank === -1 ? SEVERITY_ORDER.length : leftRank;
    const rightOrder = rightRank === -1 ? SEVERITY_ORDER.length : rightRank;

    return leftOrder === rightOrder ? left.key.localeCompare(right.key) : leftOrder - rightOrder;
};

/** The counts npm itself reports, echoed so the gate's output is self-describing. */
const describeTotals = (report) => {
    const totals = isPlainObject(report.metadata) && isPlainObject(report.metadata.vulnerabilities)
        ? report.metadata.vulnerabilities
        : {};

    return SEVERITY_ORDER.filter((severity) => typeof totals[severity] === 'number' && totals[severity] > 0)
        .map((severity) => `${totals[severity]} ${severity}`)
        .join(', ');
};

const daysSince = (isoDate, nowMs) => Math.floor((nowMs - Date.parse(`${isoDate}T00:00:00Z`)) / MILLISECONDS_PER_DAY);

const main = () => {
    const options = parseArguments(process.argv.slice(2));
    const baselinePath = options.baseline;
    const { reviewedOn, accepted } = requireBaseline(
        readJsonFile(baselinePath, 'the dependency-audit baseline'),
        baselinePath,
    );

    const origin = options.report === undefined ? `npm ${AUDIT_ARGUMENTS.join(' ')}` : options.report;
    const report = requireAuditReport(
        options.report === undefined ? runAudit().report : readJsonFile(options.report, 'the captured audit report'),
        origin,
    );

    const findings = findingsIn(report);
    const unaccepted = [...findings.values()].filter((finding) => !accepted.has(finding.key)).sort(bySeverityThenKey);
    const resolved = [...accepted.keys()].filter((key) => !findings.has(key));
    const reviewAge = daysSince(reviewedOn, Date.now());

    say(`${SCRIPT_NAME}: ${findings.size} finding(s) in the production tree (${origin}).`);
    const totals = describeTotals(report);
    if (totals !== '') {
        say(`  npm reports: ${totals}.`);
    }
    say(`  baseline: ${accepted.size} accepted finding(s), reviewed ${reviewedOn} (${reviewAge} day(s) ago).`);

    if (reviewAge > REVIEW_STALE_AFTER_DAYS) {
        // A note, never a failure: an expiring baseline would break a build
        // that changed nothing, which is how a gate gets switched off. The
        // reason to look again is that a fix may have shipped, not that the
        // acceptance has expired.
        say(
            `  NOTE: the review is older than ${REVIEW_STALE_AFTER_DAYS} days — check whether any accepted finding now has a fix.`,
        );
    }

    if (resolved.length > 0) {
        say('');
        say(`  ${resolved.length} baselined finding(s) no longer appear in the report and can be pruned:`);
        for (const key of resolved.sort()) {
            say(`    - ${key}`);
        }
        say('  Pruning is optional and never fails this gate: a finding that is gone cannot be a regression.');
    }

    if (unaccepted.length === 0) {
        say('');
        say('Dependency audit gate: PASS — every finding in the report is accepted by the reviewed baseline.');
        say('`npm audit` itself still exits non-zero while those advisories remain; that exit code is not this gate.');
        process.exit(EXIT_OK);
    }

    process.stdout.write('\n');
    say(`Dependency audit gate: FAIL — ${unaccepted.length} finding(s) are not in the baseline:`);
    for (const finding of unaccepted) {
        say('');
        say(`  ${finding.severity.toUpperCase()}  ${finding.package}  (${finding.key})`);
        if (finding.title !== '') {
            say(`    ${finding.title}`);
        }
        if (finding.url !== '') {
            say(`    ${finding.url}`);
        }
    }

    say('');
    say('Fix the dependency, or accept the finding in a reviewed commit by adding its entry to');
    say(`${baselinePath} with a reason and a new reviewedOn date:`);
    say('');
    for (const finding of unaccepted) {
        say(
            `    ${JSON.stringify({
                key: finding.key,
                package: finding.package,
                severity: finding.severity,
                title: finding.title,
                url: finding.url,
                reason: '<why this is accepted, and until when>',
            })},`,
        );
    }

    process.exit(EXIT_GATE_FAILED);
};

main();
