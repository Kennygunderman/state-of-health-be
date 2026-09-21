/**
 * The filesystem-integrity half of `scripts/lib/manifest.ts`: the publication
 * journal, the publication lock, and the path primitives every publishing stage
 * resolves its output through.
 *
 * WHY THESE CASES AND NOT THE HAPPY PATH. Every stage in `backend/scripts/`
 * takes its output directory from a flag, so a publication can be asked to run
 * in a directory another local principal writes to. Three things in that
 * directory are then attacker-controlled input rather than this pipeline's own
 * state — the journal that tells a later run which paths to `rename` and
 * `unlink`, the entries pre-placed at names a stage is about to create, and the
 * lock file a contender decides is abandoned. What the module must do with each
 * is refuse it, and a refusal is only provable by arranging the hostile state
 * and showing that nothing moved.
 *
 * The suite is therefore split in two. The PURE cases exercise the rule sets
 * (`validatePublicationJournal`, `sameArtifactLock`,
 * `artifactLockRecordIsOurs`) as functions, which is the only way to reach
 * every refusal branch — a filesystem fixture can produce a forged journal, but
 * not thirteen differently forged ones cheaply. The FILESYSTEM cases run
 * against real temporary directories, because what is under test there is what
 * the disk is left holding, which a stubbed `fs` would assume rather than prove.
 *
 * It lives here rather than beside the module because Jest's `roots` is
 * `<rootDir>/src` (jest.config.ts), so a test file under `scripts/` would never
 * be collected; the relative imports are the consequence of that. It needs no
 * database of its own: the two stages it drives reach Prisma only through a
 * dynamic import inside their `main()`, so importing them for their publication
 * functions opens no connection and starts no run.
 *
 * IT ALSO OWNS THE OTHER HALF OF THE SAME SUBJECT. The sections at the bottom
 * drive the two stages that PUBLISH into a shared report directory —
 * `catalog-validate.ts::publishValidationReport` and
 * `catalog-generate-ai.ts::writeGenerationReport` — against real temporary
 * directories, because what is under test there is also what the disk is left
 * holding: which of an artefact's sections survive a second writer, whether
 * tens of megabytes of per-item acceptance evidence are carried through without
 * being parsed, and whether a run pointed at another database is refused.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
    ARTIFACT_LOCK_STALE_MS,
    ManifestError,
    acquireArtifactPublicationLock,
    artifactLockRecordIsOurs,
    assertSafeArtifactParent,
    createExclusiveDirectory,
    openArtifactForWriteSync,
    physicalPathIdentity,
    promoteStagedArtifacts,
    readArtifactFileNoFollow,
    recoverInterruptedPublication,
    sameArtifactLock,
    samePhysicalPath,
    stageJsonArtifact,
    stagingPathFor,
    unguessableSuffix,
    validatePublicationJournal,
    withArtifactPublicationLockSync,
    writeJsonFile,
} from '../../../scripts/lib/manifest';
import type { ArtifactLockIdentity, ArtifactPublicationLock } from '../../../scripts/lib/manifest';
import {
    FRESHNESS_OBLIGATIONS_FIELD,
    mergeStageReport,
} from '../../../scripts/lib/manifest';
import {
    VALIDATION_REPORT_NOTE_KEY,
    buildValidationReportPublication,
    publishValidationReport,
    validationReportHeaderPrefix,
} from '../../../scripts/catalog-validate';
import {
    ITEMS_KEY,
    REPORT_STAGE_NAME,
    VALIDATION_REPORT_FILE,
    VALIDATION_REPORT_STALENESS_KEY,
    dischargedValidationReportStaleness,
    mergeOwnedFields,
    readStagedReportDocument,
} from '../../../scripts/catalog-report';
import {
    GENERATION_REPORT_FILE,
    writeGenerationReport,
} from '../../../scripts/catalog-generate-ai';
import {
    CATALOG_ARTIFACT_TARGET_DIGEST_FIELD,
    CATALOG_ARTIFACT_TARGET_IDENTITY_KEY,
    CatalogArtifactTargetError,
} from '../../services/catalog.logic';
import { createLogger } from '../../../scripts/lib/logger';
import type { LogLevel, ScriptLogger } from '../../../scripts/lib/logger';

/**
 * A pid that cannot be live: one past the 32-bit signed maximum is above every
 * platform's pid ceiling, so `process.kill(pid, 0)` reports it as gone without
 * ever naming a real process.
 */
const DEAD_PID = 2_147_483_647;

const JOURNAL_NAME = '.artefact-publication.journal';

/** `nobody` on every distribution this pipeline runs on, and never this process. */
const FOREIGN_UID = 65_534;

/**
 * Makes the journal at `journalPath` one this process's principal does not own
 * — the state a journal forged by another local user in a shared output
 * directory has.
 *
 * Run as root, which is how this suite runs in the pipeline's container, the
 * file is really chowned to `nobody`. Where the suite runs unprivileged `chown`
 * is not available to it at all, so the same inequality is arranged from the
 * other side by reporting a different uid for this process; the branch under
 * test compares the two numbers and cannot tell which of them moved. Either way
 * what is exercised is the real refusal, not a stubbed one.
 */
const asForeignOwnedJournal = (journalPath: string): void => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
        fs.chownSync(journalPath, FOREIGN_UID, FOREIGN_UID);
        return;
    }
    jest.spyOn(process, 'getuid').mockReturnValue(FOREIGN_UID);
};

/**
 * Makes the directory at `directoryPath` one this process's principal does not
 * own, by the same two arrangements as {@link asForeignOwnedJournal} and for
 * the same reason: `chown` when the suite is privileged, and otherwise a
 * different uid reported for this process.
 */
const asForeignOwnedDirectory = (directoryPath: string): void => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
        fs.chownSync(directoryPath, FOREIGN_UID, FOREIGN_UID);
        return;
    }
    jest.spyOn(process, 'getuid').mockReturnValue(FOREIGN_UID);
};

/** A backup name of the shape `backupPathFor` generates, with a fixed nonce. */
const backupNameFor = (artefact: string, nonce = 'a1b2c3d4e5f60718', pid = process.pid): string =>
    `.${artefact}.${pid}.${nonce}.previous`;

interface JournalEntryFixture {
    finalPath: string;
    stagingPath: string;
    backupPath: string;
    finalExisted?: boolean;
}

const journalDocument = (
    directory: string,
    entries: readonly JournalEntryFixture[],
    overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
    journalVersion: 2,
    directory,
    holderPid: process.pid,
    startedAt: new Date().toISOString(),
    entries,
    ...overrides,
});

describe('the publication journal validator (SEC3-manifest-forged-journal)', () => {
    // A fixed directory: the validator is pure, so nothing here has to exist.
    const directory = path.join(os.tmpdir(), 'soh-journal-rules');
    const artefact = 'validation-report.json';
    const finalPath = path.join(directory, artefact);
    const stagingPath = path.join(directory, `.${artefact}.4242.7.0123456789abcdef.tmp`);
    const backupPath = path.join(directory, backupNameFor(artefact, '0123456789abcdef', 4242));

    const entry = (overrides: Partial<JournalEntryFixture> = {}): JournalEntryFixture => ({
        finalPath,
        stagingPath,
        backupPath,
        finalExisted: true,
        ...overrides,
    });

    const refusalFor = (document: unknown): string => {
        const result = validatePublicationJournal(document, directory);
        expect(result.valid).toBe(false);
        return result.valid ? '' : result.reason;
    };

    describe('the documents it accepts', () => {
        it('accepts the version-2 document this build writes', () => {
            const result = validatePublicationJournal(journalDocument(directory, [entry()]), directory);

            expect(result.valid).toBe(true);
            expect(result.valid ? result.entries : []).toEqual([
                { finalPath, stagingPath, backupPath, finalExisted: true },
            ]);
        });

        it('accepts a journal written before the version and directory fields existed', () => {
            // The compatibility case that matters: an operator or an earlier
            // build left `{holderPid, startedAt, entries}` with no
            // `journalVersion`, no `directory` and no `finalExisted`. Refusing
            // it would block the recovery it was written to enable.
            const legacy = {
                holderPid: 4242,
                startedAt: new Date().toISOString(),
                entries: [{ finalPath, stagingPath, backupPath }],
            };

            const result = validatePublicationJournal(legacy, directory);

            expect(result.valid).toBe(true);
            expect(result.valid ? result.entries : []).toEqual([{ finalPath, stagingPath, backupPath }]);
        });

        it('accepts a nonce width other than the one it generates, so an older name is still revertible', () => {
            const eightHex = path.join(directory, backupNameFor(artefact, 'abcdef01', 4242));

            expect(validatePublicationJournal({ entries: [entry({ backupPath: eightHex })] }, directory).valid).toBe(
                true,
            );
        });

        it('accepts either spelling of the same directory, so a trailing separator is not a mismatch', () => {
            const spelled = `${directory}${path.sep}.${path.sep}`;

            expect(validatePublicationJournal(journalDocument(spelled, [entry()]), directory).valid).toBe(true);
        });

        it('accepts an empty entry list, which is a journal with nothing to revert', () => {
            const result = validatePublicationJournal(journalDocument(directory, []), directory);

            expect(result.valid).toBe(true);
            expect(result.valid ? result.entries : ['not empty']).toEqual([]);
        });
    });

    describe('the documents it refuses', () => {
        it('refuses a document that is not a JSON object', () => {
            expect(refusalFor(null)).toContain('not a JSON object');
            expect(refusalFor([])).toContain('not a JSON object');
            expect(refusalFor('{"entries":[]}')).toContain('not a JSON object');
        });

        it('refuses a journal whose entries are not an array', () => {
            expect(refusalFor({ holderPid: 1, startedAt: '', entries: { 0: entry() } })).toContain(
                '"entries" is not an array',
            );
        });

        it('refuses a journal version newer than the one this build reverts', () => {
            const reason = refusalFor(journalDocument(directory, [entry()], { journalVersion: 3 }));

            expect(reason).toContain('"journalVersion" is 3');
            expect(reason).toContain('newer than the version this build');
        });

        it('refuses a journal version that is not an integer', () => {
            expect(refusalFor(journalDocument(directory, [entry()], { journalVersion: '2' }))).toContain(
                'not an integer',
            );
        });

        it('refuses a journal bound to another directory', () => {
            // The case a copied journal produces: every path inside it may look
            // plausible, and none of it describes a publication into the
            // directory being recovered.
            const reason = refusalFor(journalDocument(path.join(os.tmpdir(), 'somewhere-else'), [entry()]));

            expect(reason).toContain('"directory" names');
            expect(reason).toContain('not the directory being recovered');
        });

        it('refuses a directory field that is not a non-empty string', () => {
            expect(refusalFor(journalDocument(directory, [entry()], { directory: 42 }))).toContain(
                '"directory" is present but is not a non-empty string',
            );
        });

        it('refuses an entry that is not an object', () => {
            expect(refusalFor({ entries: [entry(), 'not-an-entry'] })).toContain('entry 1 is not a JSON object');
        });

        it('names the entry index and the field for a missing or empty path', () => {
            expect(refusalFor({ entries: [entry({ finalPath: undefined as unknown as string })] })).toContain(
                'entry 0\'s "finalPath" is not a non-empty string',
            );
            expect(refusalFor({ entries: [entry(), entry({ stagingPath: '' })] })).toContain(
                'entry 1\'s "stagingPath" is not a non-empty string',
            );
        });

        it('refuses a path outside the directory being recovered', () => {
            // The forgery the finding describes: an absolute path elsewhere, and
            // a traversal out of the directory, are one comparison.
            expect(refusalFor({ entries: [entry({ finalPath: '/etc/passwd' })] })).toContain(
                'is not a direct child of the directory being recovered',
            );
            expect(
                refusalFor({ entries: [entry({ backupPath: path.join(directory, '..', backupNameFor(artefact)) })] }),
            ).toContain('entry 0\'s "backupPath"');
        });

        it('refuses a path in a subdirectory, which is not a direct child either', () => {
            expect(refusalFor({ entries: [entry({ finalPath: path.join(directory, 'nested', artefact) })] })).toContain(
                'is not a direct child',
            );
        });

        it('refuses a finalPath that is not a plain artefact name', () => {
            // A leading dot is what a journal, a lock, a staging file and a
            // backup all start with, so this is the check that stops a journal
            // naming the pipeline's own bookkeeping as an artefact.
            const reason = refusalFor({
                entries: [
                    entry({
                        finalPath: path.join(directory, JOURNAL_NAME),
                        stagingPath: path.join(directory, `.${JOURNAL_NAME}.1.1.0123456789abcdef.tmp`),
                        backupPath: path.join(directory, `.${JOURNAL_NAME}.1.0123456789abcdef.previous`),
                    }),
                ],
            });

            expect(reason).toContain('not a plain artefact name');
        });

        it('refuses a staging name this module would not have generated', () => {
            const reason = refusalFor({ entries: [entry({ stagingPath: path.join(directory, 'plain.txt') })] });

            expect(reason).toContain('entry 0\'s "stagingPath"');
            expect(reason).toContain('is not a staging name this module generates for validation-report.json');
        });

        it('refuses a staging name for a different artefact', () => {
            expect(
                refusalFor({
                    entries: [entry({ stagingPath: path.join(directory, '.import-report.json.1.1.0123456789abcdef.tmp') })],
                }),
            ).toContain('is not a staging name this module generates');
        });

        it('refuses a backup name this module would not have generated', () => {
            const reason = refusalFor({
                entries: [entry({ backupPath: path.join(directory, `.${artefact}.previous`) })],
            });

            expect(reason).toContain('entry 0\'s "backupPath"');
            expect(reason).toContain('is not a backup name this module generates for validation-report.json');
        });

        it('refuses a non-hexadecimal nonce, which is how an arbitrary sibling file is named', () => {
            expect(
                refusalFor({ entries: [entry({ backupPath: path.join(directory, backupNameFor(artefact, 'zzzzzzzz')) })] }),
            ).toContain('is not a backup name this module generates');
        });

        it('refuses a finalExisted flag that is not a boolean', () => {
            expect(
                refusalFor({ entries: [entry({ finalExisted: 'true' as unknown as boolean })] }),
            ).toContain('entry 0\'s "finalExisted" is present but is not a boolean');
        });

        it('refuses more entries than a publication in this pipeline can leave behind', () => {
            // Each entry costs `lstat` calls and can rename or unlink a path, so
            // the count is bounded before any of them is settled. The largest
            // real set is a release's six members plus its manifest.
            const reason = refusalFor({
                entries: Array.from({ length: 65 }, () => entry()),
            });

            expect(reason).toContain('65 entries');
            expect(reason).toContain('more than the 64');
        });

        it('accepts the largest entry count a real publication could reach', () => {
            expect(
                validatePublicationJournal({ entries: Array.from({ length: 64 }, () => entry()) }, directory).valid,
            ).toBe(true);
        });
    });
});

describe('lock identity comparison (SEC3-manifest-stale-lock-race)', () => {
    const identity = (overrides: Partial<ArtifactLockIdentity> = {}): ArtifactLockIdentity => ({
        device: 66_306,
        inode: 918_273,
        modifiedAtMs: 1_700_000_000_000,
        size: 214,
        token: '0123456789abcdef',
        pid: 4242,
        startedAt: '2026-09-17T14:12:03.654Z',
        ...overrides,
    });

    describe('sameArtifactLock', () => {
        it('holds for two observations of one unchanged lock', () => {
            expect(sameArtifactLock(identity(), identity())).toBe(true);
        });

        it.each([
            ['inode', { inode: 918_274 }],
            ['device', { device: 66_307 }],
            ['modifiedAtMs', { modifiedAtMs: 1_700_000_000_001 }],
            ['size', { size: 215 }],
            ['token', { token: 'fedcba9876543210' }],
            ['pid', { pid: 4243 }],
            ['startedAt', { startedAt: '2026-09-17T14:12:03.655Z' }],
        ])('fails when %s differs, because that is a different lock', (_field, change) => {
            expect(sameArtifactLock(identity(), identity(change))).toBe(false);
        });

        it('never holds for a missing observation, so a vanished lock is retried rather than unlinked', () => {
            expect(sameArtifactLock(identity(), null)).toBe(false);
            expect(sameArtifactLock(null, identity())).toBe(false);
            expect(sameArtifactLock(null, null)).toBe(false);
        });
    });

    describe('artifactLockRecordIsOurs', () => {
        const ours = { token: '0123456789abcdef', pid: 4242, startedAt: '2026-09-17T14:12:03.654Z' };

        it('answers from the token when the current record carries one', () => {
            expect(artifactLockRecordIsOurs({ ...ours }, ours)).toBe(true);
            // Same pid, same start time, different claim: only the token can
            // tell these apart, which is why it exists.
            expect(artifactLockRecordIsOurs({ ...ours, token: 'fedcba9876543210' }, ours)).toBe(false);
        });

        it('falls back to pid and start time for a record written without a token', () => {
            expect(artifactLockRecordIsOurs({ token: '', pid: 4242, startedAt: ours.startedAt }, ours)).toBe(true);
            expect(artifactLockRecordIsOurs({ token: '', pid: 4243, startedAt: ours.startedAt }, ours)).toBe(false);
            expect(artifactLockRecordIsOurs({ token: '', pid: 4242, startedAt: 'later' }, ours)).toBe(false);
        });
    });
});

describe('the filesystem safety primitives every publishing stage resolves through', () => {
    let workspace: string;

    beforeEach(() => {
        workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'soh-artifact-primitives-'));
    });

    afterEach(() => {
        // `clearMocks` (jest.config.ts) clears calls but keeps implementations,
        // and the unprivileged arrangement in `asForeignOwnedDirectory` replaces
        // `process.getuid` — which every later case in this file compares
        // against.
        jest.restoreAllMocks();
        fs.rmSync(workspace, { recursive: true, force: true });
    });

    describe('physicalPathIdentity', () => {
        it('resolves a symlinked parent, so two spellings of one directory are one identity', () => {
            const real = path.join(workspace, 'real');
            const alias = path.join(workspace, 'alias');
            fs.mkdirSync(real);
            fs.symlinkSync(real, alias);

            expect(physicalPathIdentity(path.join(alias, 'report.json'))).toBe(path.join(real, 'report.json'));
            expect(samePhysicalPath(path.join(alias, 'report.json'), path.join(real, 'report.json'))).toBe(true);
        });

        it('appends a tail that does not exist yet, and creates nothing', () => {
            const real = path.join(workspace, 'real');
            const alias = path.join(workspace, 'alias');
            fs.mkdirSync(real);
            fs.symlinkSync(real, alias);

            const identity = physicalPathIdentity(path.join(alias, 'not-yet', 'report.json'));

            expect(identity).toBe(path.join(real, 'not-yet', 'report.json'));
            // A caller asks whether a path is safe BEFORE creating it, so the
            // primitive must not have made its own answer true.
            expect(fs.existsSync(path.join(real, 'not-yet'))).toBe(false);
        });

        it('collapses a relative component without following it anywhere', () => {
            expect(samePhysicalPath(workspace, path.join(workspace, 'nested', '..'))).toBe(true);
        });

        it('distinguishes two genuinely different directories', () => {
            const other = fs.mkdtempSync(path.join(os.tmpdir(), 'soh-artifact-other-'));
            try {
                expect(samePhysicalPath(workspace, other)).toBe(false);
            } finally {
                fs.rmSync(other, { recursive: true, force: true });
            }
        });
    });

    describe('assertSafeArtifactParent', () => {
        it('accepts a directory only its owner can write to', () => {
            expect(() => assertSafeArtifactParent(path.join(workspace, 'report.json'))).not.toThrow();
        });

        it('refuses a parent other local principals can write to', () => {
            const shared = path.join(workspace, 'shared');
            fs.mkdirSync(shared, { mode: 0o777 });
            fs.chmodSync(shared, 0o777);

            const failure = (() => {
                try {
                    assertSafeArtifactParent(path.join(shared, 'report.json'));
                    return null;
                } catch (error) {
                    return error;
                }
            })();

            expect(failure).toBeInstanceOf(ManifestError);
            expect((failure as ManifestError).code).toBe('unsafe_artifact_directory');
            expect((failure as Error).message).toContain('writable by other local principals');
        });

        it('refuses a parent owned by another local principal, whatever its mode says', () => {
            // The half of SEC3-release-staging-toctou this primitive owns: a
            // `0700` directory belonging to someone else passes every mode rule
            // — nothing is group- or other-writable — and its owner can still
            // list the unguessable staging name a release cuts inside it, unlink
            // it, and put their own entry at that name.
            const theirs = path.join(workspace, 'theirs');
            fs.mkdirSync(theirs, { mode: 0o700 });
            fs.chmodSync(theirs, 0o700);
            asForeignOwnedDirectory(theirs);

            const failure = (() => {
                try {
                    assertSafeArtifactParent(path.join(theirs, 'report.json'));
                    return null;
                } catch (error) {
                    return error;
                }
            })();

            expect(failure).toBeInstanceOf(ManifestError);
            expect((failure as ManifestError).code).toBe('unsafe_artifact_directory');
            expect((failure as Error).message).toContain('is owned by uid');
            expect((failure as Error).message).toContain('Point the output flag at a directory you own');
        });

        it('refuses to create an output directory inside a parent another principal owns', () => {
            const theirs = path.join(workspace, 'theirs-exclusive');
            fs.mkdirSync(theirs, { mode: 0o755 });
            fs.chmodSync(theirs, 0o755);
            asForeignOwnedDirectory(theirs);

            expect(() => createExclusiveDirectory(path.join(theirs, 'release-staging'))).toThrow(/is owned by uid/);
            expect(fs.existsSync(path.join(theirs, 'release-staging'))).toBe(false);
        });

        it('accepts a world-writable parent that is sticky, which is what makes /tmp usable', () => {
            const sticky = path.join(workspace, 'sticky');
            fs.mkdirSync(sticky);
            fs.chmodSync(sticky, 0o1777);

            expect(() => assertSafeArtifactParent(path.join(sticky, 'report.json'))).not.toThrow();
        });

        it('refuses a symlinked parent, whose target can change under the run', () => {
            const real = path.join(workspace, 'real');
            const alias = path.join(workspace, 'alias');
            fs.mkdirSync(real);
            fs.symlinkSync(real, alias);

            expect(() => assertSafeArtifactParent(path.join(alias, 'report.json'))).toThrow(/symbolic link/);
        });

        it('refuses a parent that is a file, and one that does not exist', () => {
            const notADirectory = path.join(workspace, 'file');
            fs.writeFileSync(notADirectory, 'contents\n');

            expect(() => assertSafeArtifactParent(path.join(notADirectory, 'report.json'))).toThrow(
                /is not a directory/,
            );
            expect(() => assertSafeArtifactParent(path.join(workspace, 'missing', 'report.json'))).toThrow(
                /must exist before/,
            );
        });
    });

    describe('createExclusiveDirectory', () => {
        it('creates the directory owner-only and proves it is a real directory', () => {
            const target = path.join(workspace, 'out');

            createExclusiveDirectory(target);

            const stats = fs.lstatSync(target);
            expect(stats.isDirectory()).toBe(true);
            expect(stats.mode & 0o777).toBe(0o700);
        });

        it('refuses a pre-placed symlink instead of adopting it', () => {
            // `mkdir -p` treats an existing entry as success, so a symlink left
            // at the output directory's name would be adopted and every
            // artefact published through it.
            const outside = path.join(workspace, 'outside');
            fs.mkdirSync(outside);
            const target = path.join(workspace, 'out');
            fs.symlinkSync(outside, target);

            const failure = (() => {
                try {
                    createExclusiveDirectory(target);
                    return null;
                } catch (error) {
                    return error;
                }
            })();

            expect(failure).toBeInstanceOf(ManifestError);
            expect((failure as ManifestError).code).toBe('unsafe_artifact_directory');
            expect((failure as Error).message).toContain('already exists');
            // The link is left exactly as it was found, and nothing was written
            // through it.
            expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
            expect(fs.readdirSync(outside)).toEqual([]);
        });

        it('refuses a directory that already exists', () => {
            const target = path.join(workspace, 'out');
            fs.mkdirSync(target);

            expect(() => createExclusiveDirectory(target)).toThrow(/already exists/);
        });

        it('refuses to create inside a parent other principals can write to', () => {
            const shared = path.join(workspace, 'shared');
            fs.mkdirSync(shared);
            fs.chmodSync(shared, 0o777);

            expect(() => createExclusiveDirectory(path.join(shared, 'out'))).toThrow(
                /writable by other local principals/,
            );
        });
    });

    describe('openArtifactForWriteSync', () => {
        it('creates the file exclusively and leaves the descriptor to the caller', () => {
            const target = path.join(workspace, 'report.json');

            const descriptor = openArtifactForWriteSync(target);
            try {
                fs.writeFileSync(descriptor, '{}\n', 'utf-8');
            } finally {
                fs.closeSync(descriptor);
            }

            expect(fs.readFileSync(target, 'utf-8')).toBe('{}\n');
        });

        it('refuses a pre-placed symlink rather than truncating what it points at', () => {
            const outsideTarget = path.join(workspace, 'not-an-artefact.txt');
            fs.writeFileSync(outsideTarget, 'untouched\n');
            const staged = stagingPathFor(path.join(workspace, 'report.json'));
            fs.symlinkSync(outsideTarget, staged);

            expect(() => openArtifactForWriteSync(staged)).toThrow(
                expect.objectContaining({ code: 'EEXIST' }) as unknown as Error,
            );
            expect(fs.readFileSync(outsideTarget, 'utf-8')).toBe('untouched\n');
        });

        it('refuses a name that is already taken by a regular file', () => {
            const target = path.join(workspace, 'report.json');
            fs.writeFileSync(target, 'previous\n');

            expect(() => openArtifactForWriteSync(target)).toThrow(
                expect.objectContaining({ code: 'EEXIST' }) as unknown as Error,
            );
            expect(fs.readFileSync(target, 'utf-8')).toBe('previous\n');
        });
    });

    describe('readArtifactFileNoFollow', () => {
        it('reads a regular file whole', () => {
            const target = path.join(workspace, 'report.json');
            const document = `${JSON.stringify({ generation: 1 }, null, 2)}\n`;
            fs.writeFileSync(target, document, 'utf-8');

            expect(readArtifactFileNoFollow(target).toString('utf-8')).toBe(document);
        });

        it('reads a document larger than one buffer fill', () => {
            const target = path.join(workspace, 'large.json');
            const document = `{"pad":"${'x'.repeat(200_000)}"}\n`;
            fs.writeFileSync(target, document, 'utf-8');

            expect(readArtifactFileNoFollow(target).length).toBe(Buffer.byteLength(document));
        });

        it('refuses a symlink, so a decision is never made from a document this pipeline did not write', () => {
            const real = path.join(workspace, 'real.json');
            fs.writeFileSync(real, '{"planted":true}\n');
            const alias = path.join(workspace, 'alias.json');
            fs.symlinkSync(real, alias);

            expect(() => readArtifactFileNoFollow(alias)).toThrow(
                expect.objectContaining({ code: 'ELOOP' }) as unknown as Error,
            );
        });

        it('refuses a directory, which opens but is not an artefact', () => {
            const failure = (() => {
                try {
                    readArtifactFileNoFollow(workspace);
                    return null;
                } catch (error) {
                    return error;
                }
            })();

            expect(failure).toBeInstanceOf(ManifestError);
            expect((failure as ManifestError).code).toBe('unsafe_artifact_directory');
            expect((failure as Error).message).toContain('not a regular file');
        });
    });
});

describe('recovering an interrupted publication', () => {
    let workspace: string;
    let outside: string;

    const artefact = 'validation-report.json';
    let finalPath: string;

    beforeEach(() => {
        workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'soh-artifact-journal-'));
        outside = fs.mkdtempSync(path.join(os.tmpdir(), 'soh-artifact-outside-'));
        finalPath = path.join(workspace, artefact);
    });

    afterEach(() => {
        jest.restoreAllMocks();
        fs.rmSync(workspace, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
    });

    const journalPath = (): string => path.join(workspace, JOURNAL_NAME);

    const writeJournal = (entries: readonly JournalEntryFixture[], overrides: Record<string, unknown> = {}): void => {
        fs.writeFileSync(
            journalPath(),
            `${JSON.stringify(journalDocument(workspace, entries, overrides), null, 2)}\n`,
            'utf-8',
        );
    };

    const generationOf = (absolutePath: string): unknown =>
        (JSON.parse(fs.readFileSync(absolutePath, 'utf-8')) as Record<string, unknown>).generation;

    const visibleEntries = (): string[] => fs.readdirSync(workspace).sort();

    /** A backup holding the previous generation, as the promote sequence leaves one. */
    const leaveBackup = (name: string, generation: number): string => {
        const backupPath = path.join(workspace, backupNameFor(name, unguessableSuffix()));
        fs.writeFileSync(backupPath, `${JSON.stringify({ generation }, null, 2)}\n`, 'utf-8');
        return backupPath;
    };

    const refusal = (): ManifestError => {
        try {
            recoverInterruptedPublication(workspace);
        } catch (error) {
            expect(error).toBeInstanceOf(ManifestError);
            return error as ManifestError;
        }
        throw new Error('expected the recovery to refuse the journal');
    };

    describe('a journal it will not act on (SEC3-manifest-forged-journal)', () => {
        it('refuses one naming a path outside the directory, and touches nothing', () => {
            // The attack the finding describes: a journal written by another
            // local principal into a shared output directory, naming a rename
            // this process has the privileges to perform.
            const victim = path.join(outside, 'authorized_keys');
            fs.writeFileSync(victim, 'the operator\n', 'utf-8');
            const plantedBackup = path.join(workspace, backupNameFor('authorized_keys'));
            fs.writeFileSync(plantedBackup, 'the attacker\n', 'utf-8');
            writeJournal([
                {
                    finalPath: victim,
                    stagingPath: path.join(workspace, '.authorized_keys.1.1.0123456789abcdef.tmp'),
                    backupPath: plantedBackup,
                },
            ]);

            const failure = refusal();

            expect(failure.code).toBe('untrusted_publication_journal');
            expect(failure.message).toContain('is not a direct child of the directory being recovered');
            expect(failure.message).toContain('delete the journal by hand');
            // Nothing was renamed, nothing was unlinked, and the journal is kept
            // as the record an operator reads.
            expect(fs.readFileSync(victim, 'utf-8')).toBe('the operator\n');
            expect(fs.existsSync(plantedBackup)).toBe(true);
            expect(fs.existsSync(journalPath())).toBe(true);
        });

        it('refuses one whose staging or backup name it could not have generated', () => {
            fs.writeFileSync(finalPath, '{\n  "generation": 1\n}\n');
            const plausible = path.join(workspace, 'notes.txt');
            fs.writeFileSync(plausible, 'someone else\n', 'utf-8');
            writeJournal([
                {
                    finalPath,
                    stagingPath: path.join(workspace, `.${artefact}.1.1.0123456789abcdef.tmp`),
                    backupPath: plausible,
                    finalExisted: true,
                },
            ]);

            expect(refusal().message).toContain('is not a backup name this module generates');
            expect(fs.readFileSync(plausible, 'utf-8')).toBe('someone else\n');
            expect(generationOf(finalPath)).toBe(1);
        });

        it('refuses one bound to another directory', () => {
            const backupPath = leaveBackup(artefact, 1);
            fs.writeFileSync(
                journalPath(),
                `${JSON.stringify(
                    journalDocument(outside, [
                        {
                            finalPath,
                            stagingPath: stagingPathFor(finalPath),
                            backupPath,
                            finalExisted: true,
                        },
                    ]),
                    null,
                    2,
                )}\n`,
                'utf-8',
            );

            expect(refusal().message).toContain('not the directory being recovered');
            expect(fs.existsSync(backupPath)).toBe(true);
            expect(fs.existsSync(journalPath())).toBe(true);
        });

        it('refuses an unparsable journal instead of clearing it', () => {
            // The behaviour this replaces treated a journal that does not parse
            // as "no entries", deleted it, and reported a successful recovery —
            // leaving whatever the killed run had published in place.
            fs.writeFileSync(finalPath, '{\n  "generation": 99\n}\n');
            fs.writeFileSync(journalPath(), '{"entries": [', 'utf-8');

            const failure = refusal();

            expect(failure.code).toBe('untrusted_publication_journal');
            expect(failure.message).toContain('does not parse as JSON');
            expect(fs.existsSync(journalPath())).toBe(true);
            expect(generationOf(finalPath)).toBe(99);
        });

        it('refuses a journal that is a symlink', () => {
            const planted = path.join(outside, 'planted-journal.json');
            fs.writeFileSync(
                planted,
                `${JSON.stringify({
                    entries: [
                        {
                            finalPath: path.join(outside, 'victim.json'),
                            stagingPath: path.join(outside, '.victim.json.1.1.0123456789abcdef.tmp'),
                            backupPath: path.join(outside, backupNameFor('victim.json')),
                        },
                    ],
                })}\n`,
                'utf-8',
            );
            fs.symlinkSync(planted, journalPath());

            const failure = refusal();

            expect(failure.message).toContain('not a regular file');
            expect(fs.lstatSync(journalPath()).isSymbolicLink()).toBe(true);
            expect(fs.existsSync(planted)).toBe(true);
        });

        it('refuses a backup that is a symlink, which would publish a link as the artefact', () => {
            fs.writeFileSync(finalPath, '{\n  "generation": 99\n}\n');
            const secret = path.join(outside, 'secret.json');
            fs.writeFileSync(secret, '{"secret":true}\n', 'utf-8');
            const backupPath = path.join(workspace, backupNameFor(artefact, unguessableSuffix()));
            fs.symlinkSync(secret, backupPath);
            writeJournal([{ finalPath, stagingPath: stagingPathFor(finalPath), backupPath, finalExisted: true }]);

            const failure = refusal();

            expect(failure.message).toContain('is not a regular file');
            // The artefact still holds the interrupted run's document rather
            // than becoming a link to someone else's file.
            expect(fs.lstatSync(finalPath).isFile()).toBe(true);
            expect(generationOf(finalPath)).toBe(99);
            expect(fs.existsSync(journalPath())).toBe(true);
        });

        it('refuses a journal whose entry cannot prove what the path held (SEC3-manifest-rollback-incomplete)', () => {
            // No backup and no recorded flag: the document at the path is either
            // this run's new artefact or the only copy of the previous one, and
            // nothing on disk distinguishes them.
            fs.writeFileSync(finalPath, '{\n  "generation": 99\n}\n');
            writeJournal([
                {
                    finalPath,
                    stagingPath: stagingPathFor(finalPath),
                    backupPath: path.join(workspace, backupNameFor(artefact, unguessableSuffix())),
                },
            ]);

            const failure = refusal();

            expect(failure.message).toContain('does not record whether validation-report.json existed');
            expect(failure.message).toContain('indistinguishable');
            expect(generationOf(finalPath)).toBe(99);
            expect(fs.existsSync(journalPath())).toBe(true);
        });

        it('refuses an entry whose artefact existed but is neither backed up nor present', () => {
            writeJournal([
                {
                    finalPath,
                    stagingPath: stagingPathFor(finalPath),
                    backupPath: path.join(workspace, backupNameFor(artefact, unguessableSuffix())),
                    finalExisted: true,
                },
            ]);

            const failure = refusal();

            expect(failure.message).toContain('cannot be shown to be restored');
            expect(fs.existsSync(journalPath())).toBe(true);
        });

        it('refuses the whole journal when only its last entry cannot be settled', () => {
            // The plan is built before anything moves, so a refusal earned by
            // the last entry still leaves the first one's backup in place.
            fs.writeFileSync(finalPath, '{\n  "generation": 99\n}\n');
            const backupPath = leaveBackup(artefact, 1);
            const other = path.join(workspace, 'import-report.json');
            writeJournal([
                { finalPath, stagingPath: stagingPathFor(finalPath), backupPath, finalExisted: true },
                {
                    finalPath: other,
                    stagingPath: stagingPathFor(other),
                    backupPath: path.join(workspace, backupNameFor('import-report.json', unguessableSuffix())),
                    finalExisted: true,
                },
            ]);

            expect(refusal().message).toContain('entry 1');
            expect(generationOf(finalPath)).toBe(99);
            expect(fs.existsSync(backupPath)).toBe(true);
            expect(fs.existsSync(journalPath())).toBe(true);
        });

        it('refuses a journal owned by another local principal, so a forgery cannot make it unlink an artefact', () => {
            // The confused deputy the confinement rules alone do not answer. The
            // directory is world-writable and STICKY — the shape `/tmp` and every
            // shared output directory has, and the one `assertSafeArtifactParent`
            // accepts — so another local user can create the journal name, but
            // sticky rules stop them deleting the artefact they want gone. Every
            // path in their journal is a direct child of the directory and every
            // name has a shape this module generates, so nothing but ownership
            // separates it from a real one.
            const shared = path.join(workspace, 'shared');
            fs.mkdirSync(shared);
            fs.chmodSync(shared, 0o1777);
            const physical = fs.realpathSync(shared);
            const victim = path.join(physical, artefact);
            fs.writeFileSync(victim, '{\n  "generation": 7\n}\n', 'utf-8');
            const victimBytes = fs.readFileSync(victim);
            const forged = path.join(physical, JOURNAL_NAME);
            fs.writeFileSync(
                forged,
                `${JSON.stringify(
                    journalDocument(physical, [
                        {
                            finalPath: victim,
                            // Neither has to exist: `finalExisted: false` with no
                            // backup is exactly what makes the recovery plan
                            // `remove-new-final` and unlink the artefact.
                            stagingPath: path.join(physical, `.${artefact}.1.1.0123456789abcdef.tmp`),
                            backupPath: path.join(physical, backupNameFor(artefact, unguessableSuffix(), 4242)),
                            finalExisted: false,
                        },
                    ]),
                    null,
                    2,
                )}\n`,
                'utf-8',
            );
            asForeignOwnedJournal(forged);

            let failure: ManifestError | null = null;
            try {
                recoverInterruptedPublication(shared);
            } catch (error) {
                failure = error as ManifestError;
            }

            expect(failure).toBeInstanceOf(ManifestError);
            expect((failure as ManifestError).code).toBe('untrusted_publication_journal');
            expect((failure as ManifestError).message).toContain('owned by uid');
            expect((failure as ManifestError).message).toContain('another local principal');
            // The artefact is byte-identical and the journal is still there for
            // the operator the message tells to look at it.
            expect(fs.readFileSync(victim).equals(victimBytes)).toBe(true);
            expect(fs.existsSync(forged)).toBe(true);
        });

        it('refuses a journal a group other than its owner can write to', () => {
            fs.writeFileSync(finalPath, '{\n  "generation": 1\n}\n');
            writeJournal([
                {
                    finalPath,
                    stagingPath: stagingPathFor(finalPath),
                    backupPath: path.join(workspace, backupNameFor(artefact, unguessableSuffix())),
                    finalExisted: false,
                },
            ]);
            fs.chmodSync(journalPath(), 0o660);

            const failure = refusal();

            expect(failure.message).toContain('mode is 660');
            expect(failure.message).toContain('other than its owner write to it');
            expect(generationOf(finalPath)).toBe(1);
            expect(fs.existsSync(journalPath())).toBe(true);
        });

        it('refuses a journal any local principal can write to', () => {
            fs.writeFileSync(finalPath, '{\n  "generation": 1\n}\n');
            writeJournal([
                {
                    finalPath,
                    stagingPath: stagingPathFor(finalPath),
                    backupPath: path.join(workspace, backupNameFor(artefact, unguessableSuffix())),
                    finalExisted: false,
                },
            ]);
            fs.chmodSync(journalPath(), 0o666);

            expect(refusal().message).toContain('mode is 666');
            expect(generationOf(finalPath)).toBe(1);
        });

        it('refuses a journal larger than a real one before reading or parsing it', () => {
            // The document is not valid JSON either, so the refusal naming its
            // SIZE is proof the bytes were never read into memory and parsed:
            // a parse would have produced the other message.
            fs.writeFileSync(finalPath, '{\n  "generation": 1\n}\n');
            fs.writeFileSync(journalPath(), `{"entries": [${'x'.repeat(1024 * 1024)}`, 'utf-8');

            const failure = refusal();

            expect(failure.message).toContain('larger than the 1048576 bytes');
            expect(failure.message).not.toContain('does not parse');
            expect(generationOf(finalPath)).toBe(1);
            expect(fs.existsSync(journalPath())).toBe(true);
        });

        it('refuses a journal carrying more entries than a publication can leave behind', () => {
            fs.writeFileSync(finalPath, '{\n  "generation": 1\n}\n');
            writeJournal(
                Array.from({ length: 65 }, (_unused, index) => {
                    const target = path.join(workspace, `report-${index}.json`);
                    return {
                        finalPath: target,
                        stagingPath: stagingPathFor(target),
                        backupPath: path.join(workspace, backupNameFor(`report-${index}.json`, unguessableSuffix())),
                        finalExisted: false,
                    };
                }),
            );

            expect(refusal().message).toContain('65 entries');
            expect(generationOf(finalPath)).toBe(1);
            expect(fs.existsSync(journalPath())).toBe(true);
        });

        it('leaves the publication lock usable after refusing, so the next run is not blocked by it too', () => {
            fs.writeFileSync(journalPath(), 'not json', 'utf-8');

            expect(() => withArtifactPublicationLockSync(workspace, 'catalog-report:artefacts', () => undefined)).toThrow(
                /untrusted|will not be acted on/,
            );

            // The refusal is about the journal, not about the lock: an operator
            // who clears the journal can run the stage immediately.
            fs.rmSync(journalPath());
            const lock = acquireArtifactPublicationLock(workspace, 'catalog-report:artefacts');
            lock.release();
        });
    });

    describe('a journal it settles (SEC3-manifest-rollback-incomplete)', () => {
        it('restores the previous generation from a backup', () => {
            fs.writeFileSync(finalPath, '{\n  "generation": 99\n}\n');
            const backupPath = leaveBackup(artefact, 1);
            const stagingPath = stagingPathFor(finalPath);
            fs.writeFileSync(stagingPath, '{\n  "generation": 99\n}\n');
            writeJournal([{ finalPath, stagingPath, backupPath, finalExisted: true }]);

            expect(recoverInterruptedPublication(workspace)).toEqual([artefact]);

            expect(generationOf(finalPath)).toBe(1);
            expect(visibleEntries()).toEqual([artefact]);
        });

        it('accepts the legacy journal shape, whose backup is its own proof', () => {
            fs.writeFileSync(finalPath, '{\n  "generation": 99\n}\n');
            const backupPath = path.join(workspace, backupNameFor(artefact, 'abcdef01', 4242));
            fs.writeFileSync(backupPath, '{\n  "generation": 1\n}\n');
            fs.writeFileSync(
                journalPath(),
                `${JSON.stringify(
                    {
                        holderPid: 4242,
                        startedAt: new Date().toISOString(),
                        entries: [{ finalPath, stagingPath: stagingPathFor(finalPath), backupPath }],
                    },
                    null,
                    2,
                )}\n`,
                'utf-8',
            );

            expect(recoverInterruptedPublication(workspace)).toEqual([artefact]);
            expect(generationOf(finalPath)).toBe(1);
        });

        it('acts on a journal of ours that predates the version and finalExisted fields', () => {
            // The authentication added for SEC3-manifest-forged-journal is
            // OWNERSHIP, not a version or a token, precisely so this shape stays
            // revertible: `catalog-import.test.ts` hand-writes a journal with
            // neither field and requires the recovery to act on it and then
            // remove it. The file is group- and other-READABLE (0644, what
            // `writeFileSync` produces under the default umask) and that is
            // accepted — only a WRITE bit for another principal is a refusal.
            fs.writeFileSync(finalPath, '{\n  "generation": 99\n}\n');
            const backupPath = path.join(workspace, backupNameFor(artefact, 'abcdef01', 4242));
            fs.writeFileSync(backupPath, '{\n  "generation": 1\n}\n');
            fs.writeFileSync(
                journalPath(),
                `${JSON.stringify(
                    {
                        holderPid: 4242,
                        startedAt: new Date().toISOString(),
                        entries: [{ finalPath, stagingPath: stagingPathFor(finalPath), backupPath }],
                    },
                    null,
                    2,
                )}\n`,
                'utf-8',
            );
            fs.chmodSync(journalPath(), 0o644);

            expect(recoverInterruptedPublication(workspace)).toEqual([artefact]);

            expect(generationOf(finalPath)).toBe(1);
            expect(fs.existsSync(journalPath())).toBe(false);
        });

        it('removes the new artefact of an interrupted ALL-NEW publication', () => {
            // The F07 case: nothing was at the path, so there is no backup to
            // restore and the previous generation is "no artefact". The old
            // recovery left this run's document in place and reported success.
            fs.writeFileSync(finalPath, '{\n  "generation": 1\n}\n');
            writeJournal([
                {
                    finalPath,
                    stagingPath: stagingPathFor(finalPath),
                    backupPath: path.join(workspace, backupNameFor(artefact, unguessableSuffix())),
                    finalExisted: false,
                },
            ]);

            expect(recoverInterruptedPublication(workspace)).toEqual([artefact]);

            expect(fs.existsSync(finalPath)).toBe(false);
            expect(visibleEntries()).toEqual([]);
        });

        it('settles a MIXED publication, restoring one artefact and removing the other', () => {
            const newPath = path.join(workspace, 'import-report.json');
            fs.writeFileSync(finalPath, '{\n  "generation": 2\n}\n');
            fs.writeFileSync(newPath, '{\n  "generation": 2\n}\n');
            const backupPath = leaveBackup(artefact, 1);
            writeJournal([
                { finalPath, stagingPath: stagingPathFor(finalPath), backupPath, finalExisted: true },
                {
                    finalPath: newPath,
                    stagingPath: stagingPathFor(newPath),
                    backupPath: path.join(workspace, backupNameFor('import-report.json', unguessableSuffix())),
                    finalExisted: false,
                },
            ]);

            expect([...recoverInterruptedPublication(workspace)].sort()).toEqual([
                'import-report.json',
                artefact,
            ]);

            expect(generationOf(finalPath)).toBe(1);
            expect(fs.existsSync(newPath)).toBe(false);
            expect(visibleEntries()).toEqual([artefact]);
        });

        it('does nothing to an artefact the backup loop never reached', () => {
            // `finalExisted: true` with no backup means the interrupted run died
            // before moving this one aside, so what is at the path IS the
            // previous generation.
            fs.writeFileSync(finalPath, '{\n  "generation": 1\n}\n');
            writeJournal([
                {
                    finalPath,
                    stagingPath: stagingPathFor(finalPath),
                    backupPath: path.join(workspace, backupNameFor(artefact, unguessableSuffix())),
                    finalExisted: true,
                },
            ]);

            expect(recoverInterruptedPublication(workspace)).toEqual([]);

            expect(generationOf(finalPath)).toBe(1);
            expect(fs.existsSync(journalPath())).toBe(false);
        });

        it('removes the staged documents of the interrupted run', () => {
            fs.writeFileSync(finalPath, '{\n  "generation": 1\n}\n');
            const stagingPath = stagingPathFor(finalPath);
            fs.writeFileSync(stagingPath, '{\n  "generation": 2\n}\n');
            writeJournal([
                {
                    finalPath,
                    stagingPath,
                    backupPath: path.join(workspace, backupNameFor(artefact, unguessableSuffix())),
                    finalExisted: true,
                },
            ]);

            recoverInterruptedPublication(workspace);

            expect(visibleEntries()).toEqual([artefact]);
        });

        it('does nothing, and does not throw, when no publication was interrupted', () => {
            fs.writeFileSync(finalPath, '{\n  "generation": 1\n}\n');

            expect(recoverInterruptedPublication(workspace)).toEqual([]);
            expect(generationOf(finalPath)).toBe(1);
        });

        it('recovers through a symlinked spelling of the directory', () => {
            const alias = path.join(os.tmpdir(), `soh-artifact-alias-${process.pid}-${unguessableSuffix()}`);
            fs.symlinkSync(workspace, alias);
            try {
                fs.writeFileSync(finalPath, '{\n  "generation": 99\n}\n');
                const backupPath = leaveBackup(artefact, 1);
                writeJournal([
                    { finalPath, stagingPath: stagingPathFor(finalPath), backupPath, finalExisted: true },
                ]);

                // The journal was written for the physical directory, and the
                // recovery reaching it through the alias resolves to the same
                // identity rather than refusing its own journal.
                expect(recoverInterruptedPublication(alias)).toEqual([artefact]);
                expect(generationOf(finalPath)).toBe(1);
            } finally {
                fs.rmSync(alias, { force: true });
            }
        });
    });

    describe('a publication that fails part-way through promoting (SEC3-manifest-rollback-incomplete)', () => {
        /**
         * Fails every `rename` the predicate selects and performs the rest,
         * which is how a failure inside the promote sequence — and, for the
         * cases below, inside the ROLLBACK that follows it — is arranged without
         * a filesystem that can be made to fail on demand.
         */
        const failRenamesWhere = (
            shouldFail: (from: string, to: string) => boolean,
            before: (from: string, to: string) => void = () => undefined,
        ): void => {
            const realRename = fs.renameSync.bind(fs);
            jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
                if (shouldFail(String(from), String(to))) {
                    before(String(from), String(to));
                    throw new Error('injected rename failure');
                }
                return realRename(from as string, to as string);
            });
        };

        const failTheSecondPromotion = (stagingPath: string, finalTarget: string): void => {
            failRenamesWhere((from, to) => from === stagingPath && to === finalTarget);
        };

        const errorFrom = (act: () => void): ManifestError => {
            try {
                act();
            } catch (error) {
                expect(error).toBeInstanceOf(ManifestError);
                return error as ManifestError;
            }
            throw new Error('expected the publication to fail');
        };

        it('removes the new artefact it had already promoted, so an ALL-NEW set leaves nothing', () => {
            const importPath = path.join(workspace, 'import-report.json');
            const staged = [
                stageJsonArtifact(finalPath, { generation: 1 }),
                stageJsonArtifact(importPath, { generation: 1 }),
            ];
            failTheSecondPromotion(staged[1].stagingPath, importPath);

            expect(() => promoteStagedArtifacts(staged)).toThrow(/rolled back/);

            // The first artefact was promoted before the failure. Restoring
            // backups alone would have left it — a new generation at a canonical
            // path, reported as a rollback.
            expect(fs.existsSync(finalPath)).toBe(false);
            expect(fs.existsSync(importPath)).toBe(false);
            expect(visibleEntries()).toEqual([]);
        });

        it('restores the pre-existing artefact and removes the new one in a MIXED set', () => {
            const importPath = path.join(workspace, 'import-report.json');
            fs.writeFileSync(finalPath, '{\n  "generation": 1\n}\n');
            const staged = [
                stageJsonArtifact(finalPath, { generation: 2 }),
                stageJsonArtifact(importPath, { generation: 2 }),
            ];
            failTheSecondPromotion(staged[1].stagingPath, importPath);

            expect(() => promoteStagedArtifacts(staged)).toThrow(/artefact holds the generation it had before/);

            expect(generationOf(finalPath)).toBe(1);
            expect(fs.existsSync(importPath)).toBe(false);
            // No journal, no backup, no staging document: the set is exactly
            // the generation it was before the run.
            expect(visibleEntries()).toEqual([artefact]);
        });

        it('records what each path held before promoting, so a crash is recoverable by proof', () => {
            const importPath = path.join(workspace, 'import-report.json');
            fs.writeFileSync(finalPath, '{\n  "generation": 1\n}\n');
            const staged = [
                stageJsonArtifact(finalPath, { generation: 2 }),
                stageJsonArtifact(importPath, { generation: 2 }),
            ];

            // Read the journal at the one moment it exists: after it is written
            // and before the first rename.
            let journalWhilePromoting: Record<string, unknown> | null = null;
            const realRename = fs.renameSync.bind(fs);
            jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
                if (journalWhilePromoting === null && fs.existsSync(journalPath())) {
                    journalWhilePromoting = JSON.parse(fs.readFileSync(journalPath(), 'utf-8')) as Record<
                        string,
                        unknown
                    >;
                }
                return realRename(from as string, to as string);
            });

            promoteStagedArtifacts(staged);

            expect(journalWhilePromoting).not.toBeNull();
            const document = journalWhilePromoting as unknown as {
                journalVersion: number;
                directory: string;
                entries: { finalPath: string; finalExisted: boolean }[];
            };
            expect(document.journalVersion).toBe(2);
            expect(document.directory).toBe(physicalPathIdentity(workspace));
            expect(
                document.entries.map((entry) => [path.basename(entry.finalPath), entry.finalExisted]),
            ).toEqual([
                [artefact, true],
                ['import-report.json', false],
            ]);
            // And the successful publication clears it.
            expect(fs.existsSync(journalPath())).toBe(false);
        });

        it('keeps the journal and the backup when a restoring rename fails, and claims nothing else', () => {
            // The case the existence predicate got wrong. The restoring rename
            // fails while this run's newly promoted document is still at the
            // canonical path, so "something is at finalPath" is TRUE — and on
            // that inference the journal and the backup holding the ONLY copy of
            // generation 1 were deleted, behind a message saying the set had
            // been rolled back.
            const importPath = path.join(workspace, 'import-report.json');
            fs.writeFileSync(finalPath, '{\n  "generation": 1\n}\n');
            const staged = [
                stageJsonArtifact(finalPath, { generation: 2 }),
                stageJsonArtifact(importPath, { generation: 2 }),
            ];
            failRenamesWhere(
                (from, to) =>
                    (from === staged[1].stagingPath && to === importPath) ||
                    (to === finalPath && from.endsWith('.previous')),
            );

            const failure = errorFrom(() => promoteStagedArtifacts(staged));

            expect(failure.code).toBe('artifact_publication_failed');
            expect(failure.message).toContain('the rollback could not be completed');
            expect(failure.message).toContain('was not restored from');
            expect(failure.message).toContain('were KEPT');
            // One outcome, stated once: nothing in the message says the previous
            // generation is back, because it is not.
            expect(failure.message).not.toContain('holds the generation it had before this run');

            // The previous generation still exists, in the backup the journal
            // names — which is the whole reason neither may be deleted here.
            const survivors = fs.readdirSync(workspace).sort();
            expect(survivors).toContain(JOURNAL_NAME);
            const backups = survivors.filter((name) => name.endsWith('.previous'));
            expect(backups).toHaveLength(1);
            expect(generationOf(path.join(workspace, backups[0]))).toBe(1);
            expect(generationOf(finalPath)).toBe(2);

            // And because both were kept, the next run completes the revert.
            jest.restoreAllMocks();
            expect(recoverInterruptedPublication(workspace)).toEqual([artefact]);
            expect(generationOf(finalPath)).toBe(1);
            expect(visibleEntries()).toEqual([artefact]);
        });

        it('treats a new artefact that is already gone as removed, and completes the rollback', () => {
            const importPath = path.join(workspace, 'import-report.json');
            const staged = [
                stageJsonArtifact(finalPath, { generation: 1 }),
                stageJsonArtifact(importPath, { generation: 1 }),
            ];
            // The first artefact is promoted, then disappears before the
            // rollback reaches it: "no artefact" is exactly the generation the
            // rollback is restoring, so the set is back and the journal goes.
            failRenamesWhere(
                (from, to) => from === staged[1].stagingPath && to === importPath,
                () => fs.unlinkSync(finalPath),
            );

            const failure = errorFrom(() => promoteStagedArtifacts(staged));

            expect(failure.message).toContain('the set was rolled back');
            expect(failure.message).not.toContain('could not be completed');
            expect(visibleEntries()).toEqual([]);
        });

        it('keeps the journal when a new artefact\'s path no longer holds a regular file', () => {
            const importPath = path.join(workspace, 'import-report.json');
            const foreign = path.join(outside, 'someone-elses.json');
            fs.writeFileSync(foreign, '{\n  "generation": 0\n}\n');
            const staged = [
                stageJsonArtifact(finalPath, { generation: 1 }),
                stageJsonArtifact(importPath, { generation: 1 }),
            ];
            // Between the promotion and the rollback the canonical path becomes
            // a symbolic link to someone else's file. Removing it is not this
            // pipeline's to do — unlinking the link would be acting on an entry
            // it did not create — so the rollback is incomplete and says so.
            failRenamesWhere(
                (from, to) => from === staged[1].stagingPath && to === importPath,
                () => {
                    fs.unlinkSync(finalPath);
                    fs.symlinkSync(foreign, finalPath);
                },
            );

            const failure = errorFrom(() => promoteStagedArtifacts(staged));

            expect(failure.message).toContain('not a regular file this pipeline may remove');
            expect(failure.message).toContain('were KEPT');
            expect(failure.message).not.toContain('holds the generation it had before this run');
            expect(fs.existsSync(journalPath())).toBe(true);
            expect(fs.lstatSync(finalPath).isSymbolicLink()).toBe(true);
            expect(fs.readFileSync(foreign, 'utf-8')).toBe('{\n  "generation": 0\n}\n');
        });

        it('writes the journal owner-only, so its contents cannot be copied into a forgery', () => {
            // The recovery authenticates a journal by its ownership and mode, so
            // the document another principal would have to reproduce must not be
            // readable by them in the first place. Sampled at the one moment it
            // exists: after it is written and before the first rename.
            const importPath = path.join(workspace, 'import-report.json');
            const staged = [
                stageJsonArtifact(finalPath, { generation: 1 }),
                stageJsonArtifact(importPath, { generation: 1 }),
            ];

            let journalMode: number | null = null;
            const realRename = fs.renameSync.bind(fs);
            jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
                if (journalMode === null && fs.existsSync(journalPath())) {
                    journalMode = fs.lstatSync(journalPath()).mode & 0o777;
                }
                return realRename(from as string, to as string);
            });

            promoteStagedArtifacts(staged);

            expect(journalMode).toBe(0o600);
        });
    });
});

describe('the publication lock under takeover (SEC3-manifest-stale-lock-race)', () => {
    let workspace: string;
    let lockPath: string;
    const held: ArtifactPublicationLock[] = [];

    beforeEach(() => {
        workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'soh-artifact-lock-'));
        const probe = acquireArtifactPublicationLock(workspace, 'probe');
        lockPath = probe.lockPath;
        probe.release();
    });

    afterEach(() => {
        jest.restoreAllMocks();
        while (held.length > 0) {
            held.pop()?.release();
        }
        fs.rmSync(lockPath, { force: true });
        fs.rmSync(workspace, { recursive: true, force: true });
    });

    const writeRecord = (record: Record<string, unknown>): void => {
        fs.rmSync(lockPath, { force: true });
        fs.writeFileSync(lockPath, `${JSON.stringify(record, null, 2)}\n`, 'utf-8');
    };

    const take = (holder: string): ArtifactPublicationLock => {
        const lock = acquireArtifactPublicationLock(workspace, holder);
        held.push(lock);
        return lock;
    };

    const currentRecord = (): Record<string, unknown> =>
        JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as Record<string, unknown>;

    it('takes over a tokenless record whose holder process is gone', () => {
        writeRecord({
            holder: 'catalog-import-usda:report',
            pid: DEAD_PID,
            startedAt: new Date().toISOString(),
            directory: workspace,
        });

        expect(currentRecord().holder).toBe('catalog-import-usda:report');
        take('catalog-report:artefacts');
        expect(currentRecord().holder).toBe('catalog-report:artefacts');
    });

    it('takes over a tokenless record older than the stale bound even when its pid is live', () => {
        writeRecord({
            holder: 'catalog-validate:report',
            pid: process.pid,
            startedAt: new Date(Date.now() - ARTIFACT_LOCK_STALE_MS - 1_000).toISOString(),
            directory: workspace,
        });

        take('catalog-report:artefacts');
        expect(currentRecord().holder).toBe('catalog-report:artefacts');
    });

    it('takes over an unreadable record once it is older than the settling window', () => {
        fs.rmSync(lockPath, { force: true });
        fs.writeFileSync(lockPath, '');
        const longAgo = new Date(Date.now() - 10 * 60 * 1000);
        fs.utimesSync(lockPath, longAgo, longAgo);

        take('contender');
        expect(currentRecord().holder).toBe('contender');
    });

    it('mints a distinct token per claim, so two claims by one process are distinguishable', () => {
        const first = acquireArtifactPublicationLock(workspace, 'catalog-report:artefacts');
        const firstToken = currentRecord().token;
        first.release();
        const second = acquireArtifactPublicationLock(workspace, 'catalog-report:artefacts');
        const secondToken = currentRecord().token;
        second.release();

        expect(typeof firstToken).toBe('string');
        expect(String(firstToken)).toHaveLength(16);
        expect(firstToken).not.toBe(secondToken);
    });

    it('does not delete a lock re-claimed between the staleness verdict and the takeover', () => {
        // The CWE-367 window: the verdict is taken about the file as it was
        // read, and unlinking by pathname afterwards deletes whatever now has
        // that name — including a live holder's fresh claim.
        writeRecord({
            holder: 'catalog-import-usda:report',
            pid: DEAD_PID,
            startedAt: new Date().toISOString(),
            directory: workspace,
        });

        const freshClaim = {
            holder: 'a-different-publisher',
            pid: process.pid,
            startedAt: new Date().toISOString(),
            directory: workspace,
            token: unguessableSuffix(),
        };

        // The seam is the second observation: the lock is re-claimed by another
        // publisher immediately before it would have been unlinked.
        let observations = 0;
        const realLstat = fs.lstatSync.bind(fs);
        jest.spyOn(fs, 'lstatSync').mockImplementation(((target: fs.PathLike, options?: unknown) => {
            if (String(target) === lockPath) {
                observations += 1;
                if (observations === 2) {
                    writeRecord(freshClaim);
                }
            }
            return (realLstat as (t: fs.PathLike, o?: unknown) => fs.Stats)(target, options);
        }) as typeof fs.lstatSync);

        const failure = (() => {
            try {
                take('contender');
                return null;
            } catch (error) {
                return error;
            }
        })();

        // The contender retried the claim, found a live holder, and stopped.
        expect(failure).toBeInstanceOf(ManifestError);
        expect((failure as ManifestError).code).toBe('artifact_publication_locked');
        expect((failure as Error).message).toContain('a-different-publisher');
        // And the new holder's lock is still there.
        expect(currentRecord()).toMatchObject({ holder: 'a-different-publisher', token: freshClaim.token });
    });

    it('leaves a lock another publisher took over while this stage held it', () => {
        const ours = take('catalog-report:artefacts');
        const takenOver = {
            holder: 'catalog-import-usda:report',
            pid: process.pid,
            startedAt: new Date().toISOString(),
            directory: workspace,
            token: unguessableSuffix(),
        };
        writeRecord(takenOver);

        ours.release();
        held.pop();

        // Releasing it would hand the directory to a third writer while the
        // second is publishing. The token is what makes this decidable when the
        // same process is the new holder.
        expect(currentRecord()).toMatchObject({ holder: 'catalog-import-usda:report', token: takenOver.token });
    });

    it('releases a tokenless record that matches this stage by pid and start time', () => {
        const ours = take('catalog-report:artefacts');
        const record = currentRecord();
        writeRecord({
            holder: String(record.holder),
            pid: record.pid,
            startedAt: record.startedAt,
            directory: workspace,
        });

        ours.release();
        held.pop();

        expect(fs.existsSync(lockPath)).toBe(false);
    });

    it('reports the physical directory it keyed on, so a holder writes where it locked', () => {
        const alias = path.join(os.tmpdir(), `soh-artifact-lock-alias-${process.pid}-${unguessableSuffix()}`);
        fs.symlinkSync(workspace, alias);
        try {
            const lock = take('catalog-report:artefacts');

            expect(lock.physicalDirectory).toBe(fs.realpathSync(workspace));
            expect(samePhysicalPath(lock.physicalDirectory, alias)).toBe(true);
        } finally {
            fs.rmSync(alias, { force: true });
        }
    });

    it('reverts an interrupted publication under the lock it keyed on', () => {
        const artefact = 'validation-report.json';
        const finalPath = path.join(workspace, artefact);
        fs.writeFileSync(finalPath, '{\n  "generation": 99\n}\n');
        const backupPath = path.join(workspace, backupNameFor(artefact, unguessableSuffix()));
        fs.writeFileSync(backupPath, '{\n  "generation": 1\n}\n');
        fs.writeFileSync(
            path.join(workspace, JOURNAL_NAME),
            `${JSON.stringify(
                journalDocument(physicalPathIdentity(workspace), [
                    { finalPath, stagingPath: stagingPathFor(finalPath), backupPath, finalExisted: true },
                ]),
                null,
                2,
            )}\n`,
            'utf-8',
        );

        const published = withArtifactPublicationLockSync(workspace, 'catalog-report:artefacts', () => {
            writeJsonFile(path.join(workspace, 'import-report.json'), { generation: 2 });
            return 'published';
        });

        expect(published).toBe('published');
        expect(
            (JSON.parse(fs.readFileSync(finalPath, 'utf-8')) as Record<string, unknown>).generation,
        ).toBe(1);
        expect(fs.existsSync(path.join(workspace, JOURNAL_NAME))).toBe(false);
    });
});

/* ---------------------------------------------------------------------------
 * ONE DOCUMENT, TWO WRITERS, NOTHING LOST (CATREP-artefact-overwrite).
 *
 * THE DEFECT THESE PIN. `data/meal-planning/reports/latest/validation-report.json`
 * is written by `catalog-validate.ts` (the judgement half, sixteen keys) and by
 * `catalog-report.ts` (the aggregate half AND the per-item records AAP §0.9.3
 * names as the acceptance evidence). The validate stage published with a bare
 * `writeJsonFile`, so its sixteen keys replaced the whole file: QA ran a report
 * against one database and a validate pass against another and watched the
 * committed artefact go from twenty-four sections to sixteen, with
 * `'items' in doc` → False, while the sibling `import-report.json` went on
 * asserting agreement with it.
 *
 * The fourteen sections named in FOURTEEN_REPORT_OWNED_SECTIONS are exactly the
 * ones QA measured as lost. They are asserted by NAME and by VALUE, on a real
 * file, because "the merge preserves what it is not given" is a claim about the
 * bytes left on disk and nothing short of reading them back can make it.
 * ------------------------------------------------------------------------- */

/**
 * The sections a validate write destroyed, in the order QA listed them.
 *
 * `items` and `itemRecords` are the acceptance evidence; the other twelve are
 * the aggregate half a reviewer reads the catalog's shape out of.
 */
const FOURTEEN_REPORT_OWNED_SECTIONS: readonly string[] = [
    'policy',
    'checkVocabulary',
    'boundsMeasuredAgainst',
    'observationLegend',
    'checksOverPublishedItems',
    'categoriesLegend',
    'categories',
    'nutritionMethodBreakdown',
    'identityEvidenceSummary',
    'advisoryReview',
    'integrityReconciliation',
    'measurementGaps',
    'itemRecords',
    'items',
];

const TARGET_DIGEST = '1661b5560863';
const OTHER_DIGEST = 'ffeeddccbbaa';

/** A logger that captures its lines, so a case can assert what the run said. */
const capturingLogger = (): { logger: ScriptLogger; entries: () => Record<string, unknown>[] } => {
    const lines: { level: LogLevel; line: string }[] = [];
    return {
        logger: createLogger('catalog-validate', {
            level: 'debug',
            write: (line, level) => {
                lines.push({ line, level });
            },
            now: () => new Date('2026-09-19T00:00:00.000Z'),
        }),
        entries: () => lines.map((entry) => JSON.parse(entry.line) as Record<string, unknown>),
    };
};

/**
 * The document a `catalog:report` run leaves: its own twelve aggregate sections,
 * `itemRecords`, the streamed `items` map LAST, and a database identity.
 *
 * Written through `writeJsonFile` rather than assembled by hand, because that is
 * the function every artefact in this pipeline is serialised by — so the
 * `"items"` member lands at exactly the indentation the bounded reader looks
 * for, and a case that passed against a hand-rolled shape would prove nothing
 * about the real file.
 */
const writeReportStageArtefact = (
    target: string,
    options: { readonly targetDigest?: string; readonly items?: Record<string, unknown> } = {},
): Record<string, unknown> => {
    const items = options.items ?? {
        'usda:1': { sourceKey: 'usda:1', checks: [{ name: 'kcal_ceiling', pass: true, observed: 52, bound: 900 }] },
        'usda:2': { sourceKey: 'usda:2', checks: [{ name: 'kcal_ceiling', pass: true, observed: 322, bound: 900 }] },
    };

    const document: Record<string, unknown> = {
        // Two keys the validate stage owns as well, so the case can show they
        // are REPLACED while everything else is preserved.
        stage: 'catalog-report-predecessor',
        generatedAt: '2026-09-01T00:00:00.000Z',
        reportVersion: 'v1',
        reportKind: 'catalog-validation-evidence',
        purpose: 'Acceptance evidence for every published catalog food.',
        producedBy: { aggregateFieldsCommand: 'npm run catalog:report' },
        scope: { stage: 'catalog-report', rowsScanned: 744 },
        requirement: { publishedItems: 424, requirementMet: false },
        policy: { coveragePlanVersion: 'v1' },
        checkVocabulary: { vocabularySize: 23 },
        boundsMeasuredAgainst: { maxKcalPer100g: 900 },
        observationLegend: { pass: 'Whether the record satisfied the bound.' },
        tierRollup: { itemsMeasured: 424 },
        checksOverPublishedItems: { checkEntriesRecorded: 7695 },
        categoriesLegend: { published: 'Rows the catalog publishes.' },
        categories: [{ category: 'produce_fruit', published: 12 }],
        quarantine: { total: 253, perCategory: { produce_fruit: 3 } },
        withheldIdentityAudit: { identities: { rejected: [] } },
        provenance: { usdaPublicDomain: true },
        nutritionMethodBreakdown: { 'read per 100 g': 424 },
        identityEvidenceSummary: { retrievalRecords: 424 },
        advisoryReview: { promotions: 0 },
        integrityReconciliation: { publishedItemsWithoutValidationRecord: 0 },
        measurementGaps: [{ field: 'the cause of any per-category shortfall', value: null, reason: 'not measured' }],
        itemRecords: { oneRecordPerPublishedFood: true, recordedChecksPerItem: { 18: 424 } },
    };

    if (options.targetDigest !== undefined) {
        document[CATALOG_ARTIFACT_TARGET_IDENTITY_KEY] = {
            [CATALOG_ARTIFACT_TARGET_DIGEST_FIELD]: options.targetDigest,
            digestBasis: 'A one-way digest of the database this artefact describes.',
        };
    }

    // LAST, like the streamed write puts it.
    document[ITEMS_KEY] = items;

    writeJsonFile(target, document);
    return document;
};

/** The sixteen-key document a validate pass publishes. */
const validateReport = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    stage: 'catalog-validate',
    generatedAt: '2026-09-19T00:00:00.000Z',
    runId: 'run-1',
    coveragePlanVersion: 'v1',
    options: { dryRun: false, review: false },
    curatorDecisions: { source: 'none', decisions: [] },
    counts: { judged: 2, published: 2 },
    failedChecks: {},
    reviewFlags: {},
    duplicateIdentities: 0,
    duplicateIdentityAccounting: { lostIdentitiesTotal: 0 },
    invocation: { resumed: false, judged: 2 },
    skipped: { vanished: [], raced: [], identityGroupMoved: [] },
    coverage: { publishedActualTotal: 2, shortfallTotal: 0 },
    modelCalls: { reserved: 0, used: 0 },
    dryRun: null,
    ...overrides,
});

describe('a validate write preserves the report stage`s half of validation-report.json', () => {
    let workspace: string;
    let target: string;

    beforeEach(() => {
        workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'soh-validate-publish-'));
        target = path.join(workspace, VALIDATION_REPORT_FILE);
    });

    afterEach(() => {
        fs.rmSync(workspace, { recursive: true, force: true });
    });

    const readPublished = (): Record<string, unknown> =>
        JSON.parse(fs.readFileSync(target, 'utf-8')) as Record<string, unknown>;

    it('leaves all fourteen report-owned sections in place, byte for byte', () => {
        const before = writeReportStageArtefact(target, { targetDigest: TARGET_DIGEST });
        const { logger } = capturingLogger();

        publishValidationReport({ target, report: validateReport(), targetDigest: TARGET_DIGEST, logger });

        const after = readPublished();
        // THE ASSERTION THE FINDING IS ABOUT: every one of the fourteen is
        // still there, and still holds what the report stage measured.
        for (const section of FOURTEEN_REPORT_OWNED_SECTIONS) {
            expect(Object.prototype.hasOwnProperty.call(after, section)).toBe(true);
            expect(after[section]).toEqual(before[section]);
        }
        // And the per-item acceptance records specifically, by identity.
        expect(Object.keys(after[ITEMS_KEY] as Record<string, unknown>).sort()).toEqual(['usda:1', 'usda:2']);

        // This write's own sixteen keys replaced the predecessor's, which is
        // the half it does own.
        expect(after.stage).toBe('catalog-validate');
        expect(after.runId).toBe('run-1');
        expect(after.counts).toEqual({ judged: 2, published: 2 });

        // The document is still one parseable artefact ending in the
        // terminator every artefact here ends with.
        expect(fs.readFileSync(target, 'utf-8').endsWith('}\n')).toBe(true);
    });

    it('carries the item map through without parsing it, byte-identical to what was there', () => {
        // A map big enough that "it was copied, not rebuilt" is a measurable
        // claim: the bytes are compared, and the copy runs in 1 MiB chunks, so
        // this crosses the chunk boundary.
        const items: Record<string, unknown> = {};
        for (let index = 0; index < 4000; index += 1) {
            items[`usda:${index}`] = {
                sourceKey: `usda:${index}`,
                checks: [{ name: 'kcal_ceiling', pass: true, observed: index, bound: 900 }],
                notApplicableChecks: [{ name: 'missing_density', applicable: false, reason: 'not a volume basis' }],
            };
        }
        writeReportStageArtefact(target, { targetDigest: TARGET_DIGEST, items });

        const original = readStagedReportDocument(target);
        expect(original).not.toBeNull();
        expect(original?.itemsOffset).not.toBeNull();
        const originalTail = fs.readFileSync(target).subarray(original?.itemsOffset ?? 0);
        expect(originalTail.length).toBeGreaterThan(1024 * 1024);

        const { logger, entries } = capturingLogger();
        publishValidationReport({ target, report: validateReport(), targetDigest: TARGET_DIGEST, logger });

        const republished = readStagedReportDocument(target);
        const republishedTail = fs.readFileSync(target).subarray(republished?.itemsOffset ?? 0);
        expect(republishedTail.equals(originalTail)).toBe(true);
        expect(Object.keys(readPublished()[ITEMS_KEY] as Record<string, unknown>)).toHaveLength(4000);

        const written = entries().filter((entry) => entry.event === 'report_written');
        expect(written).toHaveLength(1);
        expect(written[0].itemRecordsPreserved).toBe(true);
        expect(Number(written[0].itemBytesPreserved)).toBe(originalTail.length);
    });

    it('records the freshness obligation catalog-report still owes, naming the sections', () => {
        writeReportStageArtefact(target, { targetDigest: TARGET_DIGEST });
        const { logger, entries } = capturingLogger();

        publishValidationReport({ target, report: validateReport(), targetDigest: TARGET_DIGEST, logger });

        const marker = readPublished()[VALIDATION_REPORT_STALENESS_KEY] as Record<string, unknown>;
        expect(marker[FRESHNESS_OBLIGATIONS_FIELD]).toEqual([REPORT_STAGE_NAME]);
        // A PRESERVED SECTION MUST NOT POSE AS FRESH: the marker names every
        // one of them, including the carried item records.
        for (const section of FOURTEEN_REPORT_OWNED_SECTIONS) {
            expect(marker.sectionsOutstanding).toContain(section);
        }
        expect(marker.command).toBe('npm run catalog:report');

        // The note says what was preserved and what was carried rather than
        // measured, so a reader can tell the two apart.
        const note = readPublished()[VALIDATION_REPORT_NOTE_KEY] as Record<string, unknown>;
        expect(note.stage).toBe('catalog-validate');
        expect(note.itemRecordsPreserved).toBe(true);
        expect(note.carriedAggregateAssertions).toEqual(['measurementGaps']);
        expect(note.preservedKeys).toContain('policy');
        expect(note.preservedKeys).not.toContain('measurementGaps');
        expect(entries().filter((entry) => entry.event === 'report_written')).toHaveLength(1);
    });

    it('is discharged by the next report-stage write, which takes the marker away', () => {
        writeReportStageArtefact(target, { targetDigest: TARGET_DIGEST });
        const { logger } = capturingLogger();
        publishValidationReport({ target, report: validateReport(), targetDigest: TARGET_DIGEST, logger });
        expect(readPublished()).toHaveProperty(VALIDATION_REPORT_STALENESS_KEY);

        // The report stage's half of the same mechanism, applied to the
        // document the validate write left.
        const onDisk = readStagedReportDocument(target);
        const republished = mergeOwnedFields(onDisk?.header ?? null, [
            ['policy', { coveragePlanVersion: 'v1', remeasured: true }],
            [VALIDATION_REPORT_STALENESS_KEY, dischargedValidationReportStaleness(onDisk?.header ?? null)],
        ]);

        expect(republished).not.toHaveProperty(VALIDATION_REPORT_STALENESS_KEY);
        // And the validate half it does not own is still there.
        expect(republished.counts).toEqual({ judged: 2, published: 2 });
    });

    it('writes the whole document when the path holds nothing, and when it holds no item map', () => {
        const { logger, entries } = capturingLogger();

        publishValidationReport({ target, report: validateReport(), targetDigest: TARGET_DIGEST, logger });
        expect(readPublished().stage).toBe('catalog-validate');
        // Nothing to preserve, so nothing is claimed as outstanding.
        expect(readPublished()).not.toHaveProperty(VALIDATION_REPORT_STALENESS_KEY);
        expect(entries().filter((entry) => entry.event === 'report_written')[0].itemRecordsPreserved).toBe(false);

        // A document with sections but no `items` key: the header still merges.
        writeJsonFile(target, { policy: { coveragePlanVersion: 'v1' }, [CATALOG_ARTIFACT_TARGET_IDENTITY_KEY]: { [CATALOG_ARTIFACT_TARGET_DIGEST_FIELD]: TARGET_DIGEST } });
        publishValidationReport({ target, report: validateReport({ runId: 'run-2' }), targetDigest: TARGET_DIGEST, logger });
        expect(readPublished().policy).toEqual({ coveragePlanVersion: 'v1' });
        expect(readPublished().runId).toBe('run-2');
    });

    it('refuses a document describing another database and leaves it byte-identical', () => {
        writeReportStageArtefact(target, { targetDigest: OTHER_DIGEST });
        const before = fs.readFileSync(target);
        const { logger } = capturingLogger();

        let thrown: unknown = null;
        try {
            publishValidationReport({ target, report: validateReport(), targetDigest: TARGET_DIGEST, logger });
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toBeInstanceOf(CatalogArtifactTargetError);
        expect((thrown as CatalogArtifactTargetError).code).toBe('artefact_target_mismatch');
        expect((thrown as CatalogArtifactTargetError).context).toEqual({
            file: VALIDATION_REPORT_FILE,
            recordedDigest: OTHER_DIGEST,
            runDigest: TARGET_DIGEST,
        });
        expect(fs.readFileSync(target).equals(before)).toBe(true);
        // Nothing staged, and the publication lock released.
        expect(fs.readdirSync(workspace)).toEqual([VALIDATION_REPORT_FILE]);
    });

    it('adopts a document that records no database at all, loudly, and stamps its own', () => {
        // The state of every artefact committed before the field existed. A
        // refusal here would break the legitimate pipeline until someone
        // re-published, and would mean editing a committed file to accommodate
        // a code change.
        writeReportStageArtefact(target);
        const { logger, entries } = capturingLogger();

        publishValidationReport({ target, report: validateReport(), targetDigest: TARGET_DIGEST, logger });

        const adopted = entries().filter((entry) => entry.event === 'artefact_target_adopted');
        expect(adopted).toHaveLength(1);
        expect(adopted[0].level).toBe('warn');
        expect(adopted[0].recordedDigest).toBe('none');
        expect(adopted[0].targetDigest).toBe(TARGET_DIGEST);
        expect(String(adopted[0].basis)).toContain('adopted rather than refused');

        // Stamped, so the next write against another database is refused
        // instead of adopted a second time.
        expect(readPublished()[CATALOG_ARTIFACT_TARGET_IDENTITY_KEY]).toMatchObject({
            [CATALOG_ARTIFACT_TARGET_DIGEST_FIELD]: TARGET_DIGEST,
        });
        expect(FOURTEEN_REPORT_OWNED_SECTIONS.every((section) => section in readPublished())).toBe(true);

        const { logger: second } = capturingLogger();
        expect(() =>
            publishValidationReport({ target, report: validateReport(), targetDigest: OTHER_DIGEST, logger: second }),
        ).toThrow(CatalogArtifactTargetError);
    });

    it('refuses to publish while another stage holds the report directory`s lock', () => {
        writeReportStageArtefact(target, { targetDigest: TARGET_DIGEST });
        const before = fs.readFileSync(target);
        const held = acquireArtifactPublicationLock(workspace, 'catalog-report:artefacts');
        const { logger } = capturingLogger();

        try {
            expect(() =>
                publishValidationReport({ target, report: validateReport(), targetDigest: TARGET_DIGEST, logger }),
            ).toThrow(ManifestError);
            expect(fs.readFileSync(target).equals(before)).toBe(true);
        } finally {
            held.release();
        }
    });
});

describe('buildValidationReportPublication', () => {
    it('states which sections it preserved, which it carried, and which are outstanding', () => {
        const publication = buildValidationReportPublication({
            file: VALIDATION_REPORT_FILE,
            existing: {
                stage: 'catalog-report-predecessor',
                policy: { coveragePlanVersion: 'v1' },
                measurementGaps: [{ field: 'a gap', value: null, reason: 'not measured' }],
                aggregatedAt: '2026-09-01T00:00:00.000Z',
                [VALIDATION_REPORT_NOTE_KEY]: { stage: 'catalog-validate' },
            },
            report: validateReport(),
            itemRecordsPreserved: true,
            targetDigest: TARGET_DIGEST,
        });

        expect(publication.preservedKeys).toEqual(['policy']);
        // Both aggregate-owned assertions the document carried are kept rather
        // than dropped: this write changes nothing either describes, and one of
        // them (`measurementGaps`) is one of the fourteen sections.
        expect(publication.carriedAggregateAssertions).toEqual(['aggregatedAt', 'measurementGaps']);
        expect(publication.sectionsAwaitingReportStage).toEqual([
            'aggregatedAt',
            'items',
            'measurementGaps',
            'policy',
        ]);
        expect(publication.targetDecision.verdict).toBe('adopted');
        // This write's own note is not claimed as a key it preserved from
        // another stage — it is its own previous bookkeeping.
        expect(publication.preservedKeys).not.toContain(VALIDATION_REPORT_NOTE_KEY);
        expect(publication.sectionsAwaitingReportStage).not.toContain(VALIDATION_REPORT_NOTE_KEY);
    });

    it('claims nothing outstanding on a first write, and names no compound block', () => {
        const publication = buildValidationReportPublication({
            file: VALIDATION_REPORT_FILE,
            existing: null,
            report: validateReport(),
            itemRecordsPreserved: false,
            targetDigest: TARGET_DIGEST,
        });

        expect(publication.preservedKeys).toEqual([]);
        expect(publication.carriedAggregateAssertions).toEqual([]);
        expect(publication.sectionsAwaitingReportStage).toEqual([]);
        expect(publication.document).not.toHaveProperty(VALIDATION_REPORT_STALENESS_KEY);
        expect(publication.targetDecision.verdict).toBe('first_write');
        // The two writers of this document own disjoint top-level keys, so
        // there is no co-written block to merge by sub-key — stated rather than
        // inherited from the import report's default.
        expect((publication.document[VALIDATION_REPORT_NOTE_KEY] as Record<string, unknown>).compoundBlocks).toEqual([]);
    });
});

describe('validationReportHeaderPrefix', () => {
    it('ends where the copied item map begins, so the two compose into one document', () => {
        const prefix = validationReportHeaderPrefix({ a: 1, b: { c: 2 } });
        const tail = `\n  ${JSON.stringify(ITEMS_KEY)}: {\n    "usda:1": {}\n  }\n}\n`;

        expect(prefix.endsWith(',')).toBe(true);
        expect(JSON.parse(`${prefix}${tail}`)).toEqual({ a: 1, b: { c: 2 }, [ITEMS_KEY]: { 'usda:1': {} } });
        // Identical in shape to a single stringify at the same indent, so a
        // rerun of the other writer diffs as changed fields rather than a
        // reformat of the whole file.
        expect(`${prefix}${tail}`).toBe(
            `${JSON.stringify({ a: 1, b: { c: 2 }, [ITEMS_KEY]: { 'usda:1': {} } }, null, 2)}\n`,
        );
    });

    it('takes no separator for an empty header, so the composition stays valid', () => {
        expect(validationReportHeaderPrefix({})).toBe('{');
        expect(JSON.parse(`${validationReportHeaderPrefix({})}\n  "${ITEMS_KEY}": {}\n}\n`)).toEqual({ [ITEMS_KEY]: {} });
    });
});

describe('the generation stage`s canonical write', () => {
    let workspace: string;
    let target: string;

    beforeEach(() => {
        workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'soh-generation-publish-'));
        target = path.join(workspace, GENERATION_REPORT_FILE);
    });

    afterEach(() => {
        fs.rmSync(workspace, { recursive: true, force: true });
    });

    const readPublished = (): Record<string, unknown> =>
        JSON.parse(fs.readFileSync(target, 'utf-8')) as Record<string, unknown>;

    it('stamps its target and keeps the sibling stages` sections', () => {
        writeJsonFile(target, {
            stage: 'catalog-import-usda',
            counts: { planned: 12057 },
            usdaRequests: { attempts: 583 },
        });
        const { logger, entries } = capturingLogger();

        writeGenerationReport(target, { stage: 'catalog-generate-ai', aiGenerationCounts: { executedBatches: 2 } }, TARGET_DIGEST, logger);

        const after = readPublished();
        expect(after.counts).toEqual({ planned: 12057 });
        expect(after.usdaRequests).toEqual({ attempts: 583 });
        expect(after.stage).toBe('catalog-generate-ai');
        expect(after[CATALOG_ARTIFACT_TARGET_IDENTITY_KEY]).toMatchObject({
            [CATALOG_ARTIFACT_TARGET_DIGEST_FIELD]: TARGET_DIGEST,
        });
        // Adopted, because the document it merged into recorded no identity.
        expect(entries().filter((entry) => entry.event === 'artefact_target_adopted')).toHaveLength(1);
    });

    it('refuses a document describing another database, leaving it byte-identical', () => {
        writeJsonFile(target, {
            stage: 'catalog-import-usda',
            counts: { planned: 12057 },
            [CATALOG_ARTIFACT_TARGET_IDENTITY_KEY]: { [CATALOG_ARTIFACT_TARGET_DIGEST_FIELD]: OTHER_DIGEST },
        });
        const before = fs.readFileSync(target);
        const { logger } = capturingLogger();

        expect(() => writeGenerationReport(target, { stage: 'catalog-generate-ai' }, TARGET_DIGEST, logger)).toThrow(
            CatalogArtifactTargetError,
        );
        expect(fs.readFileSync(target).equals(before)).toBe(true);
    });

    it('agrees with a document it already stamped, and says so without warning', () => {
        const { logger, entries } = capturingLogger();
        writeGenerationReport(target, { stage: 'catalog-generate-ai', aiGenerationCounts: {} }, TARGET_DIGEST, logger);
        writeGenerationReport(target, { stage: 'catalog-generate-ai', aiGenerationCounts: {} }, TARGET_DIGEST, logger);

        const checked = entries().filter((entry) => entry.event === 'artefact_target_checked');
        expect(checked).toHaveLength(1);
        expect(checked[0].verdict).toBe('agrees');
        expect(entries().filter((entry) => entry.event === 'artefact_target_adopted')).toHaveLength(1);
    });

    it('replaces a document it cannot parse rather than refusing it, and says which', () => {
        // An unparseable file records no identity, so the rule reads it as the
        // adoption case — the run must not be stopped by a half-written report
        // when its work is already committed to the database.
        fs.writeFileSync(target, '{ not json', 'utf-8');
        const { logger, entries } = capturingLogger();

        writeGenerationReport(target, { stage: 'catalog-generate-ai' }, TARGET_DIGEST, logger);

        expect(readPublished().stage).toBe('catalog-generate-ai');
        expect(entries().filter((entry) => entry.event === 'report_replaced')).toHaveLength(1);
        expect(entries().filter((entry) => entry.event === 'artefact_target_adopted')).toHaveLength(1);
    });
});

describe('the merge the two report writers share', () => {
    it('discharges only the writing stage`s own obligation, whichever writer calls it', () => {
        // `mergeStageReport` is the import report's path and
        // `dischargedValidationReportStaleness` the validation report's; both
        // must remove one stage and leave the rest, or a marker would be
        // cleared by a stage that measured nothing.
        const marker = {
            [VALIDATION_REPORT_STALENESS_KEY]: {
                [FRESHNESS_OBLIGATIONS_FIELD]: [REPORT_STAGE_NAME, 'catalog-import-usda'],
            },
        };

        const viaMerge = mergeStageReport(marker, { counts: 1 }, { noteKey: 'reportStageWrite', stage: REPORT_STAGE_NAME });
        expect(
            (viaMerge.document[VALIDATION_REPORT_STALENESS_KEY] as Record<string, unknown>)[FRESHNESS_OBLIGATIONS_FIELD],
        ).toEqual(['catalog-import-usda']);

        expect(dischargedValidationReportStaleness(marker)).toEqual({
            [FRESHNESS_OBLIGATIONS_FIELD]: ['catalog-import-usda'],
        });
    });
});
