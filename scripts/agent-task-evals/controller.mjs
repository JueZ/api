import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runAdapter } from './adapters.mjs';
import { overlayCurrentContext } from './context.mjs';
import { DEFAULT_RESULTS_DIRECTORY, REPOSITORY_ROOT, validateTaskDefinition } from './definitions.mjs';
import { scoreCandidate } from './scorers.mjs';
import { applySetupProfile } from './setup.mjs';

const MAX_DIFF_BYTES = 2 * 1024 * 1024;
const MAX_UNTRACKED_FILES = 1_000;
const MAX_UNTRACKED_BYTES = 2 * 1024 * 1024;
// eslint-disable-next-line no-control-regex -- sanitizer deliberately removes ANSI/control bytes.
const ANSI_ESCAPE_PATTERN = new RegExp('\\u001B\\[[0-?]*[ -/]*[@-~]', 'g');
// eslint-disable-next-line no-control-regex -- sanitizer deliberately removes ANSI/control bytes.
const CONTROL_CHARACTER_PATTERN = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]', 'g');
const SECRET_REPLACEMENTS = Object.freeze([
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi, '[redacted-private-key]'],
  [/\bBearer\s+\S+/gi, 'Bearer [redacted]'],
  [/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{12,}\b/g, '[redacted-github-credential]'],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}\b/g, '[redacted-provider-credential]'],
  [/(?:AccountKey|SharedAccessSignature|client_secret|connection_string)\s*[:=]\s*\S+/gi, '[redacted-credential]'],
  [/(?:GH_TOKEN|GITHUB_TOKEN|OPENAI_API_KEY|AZURE_CLIENT_SECRET)=\S+/g, '[redacted-environment-value]'],
]);

function isInside(root, candidate) {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

function git(root, args, options = {}) {
  const result = spawnSync(
    'git',
    ['-c', 'core.filemode=false', '-c', 'core.autocrlf=false', '-c', 'core.eol=lf', '-C', root, ...args],
    {
      encoding: 'utf8',
      maxBuffer: options.maxBuffer ?? 5 * 1024 * 1024,
      timeout: options.timeout ?? 30_000,
      env: options.env ?? process.env,
    },
  );
  if (result.status !== 0) {
    throw new Error(`git ${args[0]} failed in the evaluation controller`);
  }
  return result.stdout;
}

function prepareBaseline({ controllerRoot, worktreePath, task, contextVariant }) {
  const setupPaths = applySetupProfile(task.setupProfile, worktreePath);
  const context = overlayCurrentContext({ variant: contextVariant, controllerRoot, worktreePath });
  const changed = git(worktreePath, ['status', '--porcelain=v1', '-z']).length > 0;
  if (changed || contextVariant !== 'historical' || setupPaths.length > 0) {
    git(worktreePath, ['add', '-A', '--']);
    const environment = {
      ...process.env,
      GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
    };
    git(
      worktreePath,
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'user.name=JueZ Agent Eval',
        '-c',
        'user.email=agent-eval@invalid.local',
        'commit',
        '--allow-empty',
        '--no-gpg-sign',
        '-m',
        `agent-eval baseline: ${contextVariant}`,
      ],
      { env: environment },
    );
  }
  return {
    baselineSha: git(worktreePath, ['rev-parse', 'HEAD']).trim(),
    contextPaths: context.paths,
    contextDigest: context.digest,
    setupPaths,
  };
}

function validateCandidatePath(path) {
  if (
    path.length === 0 ||
    path.includes('\0') ||
    path.includes('\\') ||
    isAbsolute(path) ||
    path.split('/').includes('..')
  ) {
    throw new Error('candidate produced an unsafe changed path');
  }
}

function includeUntrackedFiles(worktreePath) {
  const untracked = git(worktreePath, ['ls-files', '--others', '-z']).split('\0').filter(Boolean);
  if (untracked.length > MAX_UNTRACKED_FILES) throw new Error('candidate produced too many untracked files');
  let total = 0;
  for (const path of untracked) {
    validateCandidatePath(path);
    const candidate = join(worktreePath, path);
    if (!isInside(worktreePath, candidate)) throw new Error('candidate untracked path escaped the worktree');
    const stat = lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('candidate produced a non-regular untracked file');
    total += stat.size;
    if (total > MAX_UNTRACKED_BYTES) throw new Error('candidate untracked files exceed the 2 MiB limit');
  }
  if (untracked.length > 0) git(worktreePath, ['add', '-N', '--', ...untracked]);
}

function collectCandidate(worktreePath, baselineSha) {
  includeUntrackedFiles(worktreePath);
  const changedPaths = git(worktreePath, ['diff', '--name-only', '--no-renames', '-z', baselineSha, '--'])
    .split('\0')
    .filter(Boolean);
  for (const path of changedPaths) validateCandidatePath(path);
  const diff = git(worktreePath, ['diff', '--no-renames', '--binary', '--full-index', baselineSha, '--'], {
    maxBuffer: MAX_DIFF_BYTES,
  });
  return { changedPaths: [...new Set(changedPaths)].sort(), diff };
}

function readFinalOutput(path) {
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function sanitizeText(value, temporaryRoot, maximum = 200_000) {
  let sanitized = String(value ?? '')
    .replaceAll(temporaryRoot, '[temporary-evaluation-root]')
    .replace(ANSI_ESCAPE_PATTERN, '')
    .replace(CONTROL_CHARACTER_PATTERN, '')
    .replace(/https?:\/\/[^\s?#]+\?[^\s#]*/g, (url) => `${url.slice(0, url.indexOf('?'))}?[redacted-query]`);
  for (const [pattern, replacement] of SECRET_REPLACEMENTS) sanitized = sanitized.replace(pattern, replacement);
  return sanitized.slice(0, maximum);
}

function sanitizeValue(value, temporaryRoot, depth = 0) {
  if (depth > 8) return '[truncated-depth]';
  if (typeof value === 'string') return sanitizeText(value, temporaryRoot, 4_000);
  if (Array.isArray(value)) return value.slice(0, 100).map((entry) => sanitizeValue(entry, temporaryRoot, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 100)
        .map(([key, entry]) => [key, sanitizeValue(entry, temporaryRoot, depth + 1)]),
    );
  }
  return value;
}

function cleanupWorktree(controllerRoot, temporaryRoot, worktreePath) {
  let gitRemoved;
  try {
    const result = spawnSync('git', ['-C', controllerRoot, 'worktree', 'remove', '--force', worktreePath], {
      stdio: 'ignore',
      timeout: 30_000,
    });
    gitRemoved = result.status === 0;
  } catch {
    gitRemoved = false;
  }
  try {
    if (existsSync(worktreePath)) rmSync(worktreePath, { recursive: true, force: true });
  } catch {
    // The cleanup result below remains false and makes the evaluation fail.
  }
  spawnSync('git', ['-C', controllerRoot, 'worktree', 'prune'], { stdio: 'ignore', timeout: 30_000 });
  try {
    if (existsSync(temporaryRoot)) rmSync(temporaryRoot, { recursive: true, force: true });
  } catch {
    // The cleanup result below remains false and makes the evaluation fail.
  }
  return {
    gitRegistrationRemoved: gitRemoved,
    worktreeRemoved: !existsSync(worktreePath),
    temporaryRootRemoved: !existsSync(temporaryRoot),
  };
}

function resultFileName(startedAt, task, contextVariant, adapterId) {
  const timestamp = startedAt.replace(/[-:.TZ]/g, '').slice(0, 14);
  return `${timestamp}-${task.id}-${contextVariant}-${adapterId}-${randomUUID().slice(0, 8)}.json`;
}

function writeResult(report, resultsDirectory, fileName) {
  const directory = resolve(resultsDirectory);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, fileName);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return path;
}

export async function runTaskEvaluation(options) {
  const controllerRoot = resolve(options.controllerRoot ?? REPOSITORY_ROOT);
  const errors = validateTaskDefinition(options.task, { path: options.task.id ?? 'task' });
  if (errors.length > 0) throw new Error(`Task is invalid:\n- ${errors.join('\n- ')}`);
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'juez-agent-eval-'));
  const worktreePath = join(temporaryRoot, 'worktree');
  const finalOutputPath = join(temporaryRoot, 'final-output.json');
  const fakePidPath = join(temporaryRoot, 'fake-child.pid');
  const shellHomePath = join(worktreePath, '.agent-eval-home');
  const shellTempPath = join(worktreePath, '.agent-eval-tmp');

  let report;
  let collectionError = null;
  try {
    if (isInside(controllerRoot, temporaryRoot) || isInside(temporaryRoot, controllerRoot)) {
      throw new Error('temporary evaluation root overlaps the primary checkout');
    }
    git(controllerRoot, ['worktree', 'add', '--detach', worktreePath, options.task.baseSha], { timeout: 60_000 });
    const baseline = prepareBaseline({
      controllerRoot,
      worktreePath,
      task: options.task,
      contextVariant: options.contextVariant,
    });
    mkdirSync(shellHomePath, { recursive: true, mode: 0o700 });
    mkdirSync(shellTempPath, { recursive: true, mode: 0o700 });
    const adapterResult = await runAdapter({
      adapterId: options.adapterId,
      task: options.task,
      worktreePath,
      finalOutputPath,
      fakePidPath,
      shellHomePath,
      shellTempPath,
      timeoutMs: (options.timeoutSecondsOverride ?? options.task.timeoutSeconds) * 1_000,
      confirmPaid: options.confirmPaid,
      fakeMode: options.fakeMode,
      codexExecutable: options.codexExecutable,
      parentEnvironment: options.parentEnvironment,
    });
    rmSync(shellHomePath, { recursive: true, force: true });
    rmSync(shellTempPath, { recursive: true, force: true });
    let candidate = { changedPaths: [], diff: '' };
    try {
      candidate = collectCandidate(worktreePath, baseline.baselineSha);
    } catch (error) {
      collectionError = error instanceof Error ? error.message : String(error);
    }
    const finalOutput = readFinalOutput(finalOutputPath);
    const scoring = scoreCandidate({
      task: options.task,
      worktreePath,
      baselineSha: baseline.baselineSha,
      changedPaths: candidate.changedPaths,
      diff: candidate.diff,
      finalOutput,
      adapterResult,
    });
    if (collectionError) scoring.passed = false;
    report = {
      schemaVersion: 1,
      taskId: options.task.id,
      taskTitle: options.task.title,
      contextVariant: options.contextVariant,
      adapter: options.adapterId,
      cliVersion: adapterResult.cliVersion,
      source: options.task.source,
      baseSha: options.task.baseSha,
      baselineSha: baseline.baselineSha,
      contextDigest: baseline.contextDigest,
      contextPaths: baseline.contextPaths,
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedMs,
      adapterResult: {
        exitCode: adapterResult.exitCode,
        signal: adapterResult.signal,
        timedOut: adapterResult.timedOut,
        blocked: adapterResult.blocked,
        durationMs: adapterResult.durationMs,
        stderrSummary: sanitizeText(adapterResult.stderrSummary, temporaryRoot, 4_000),
        descendantTerminated: adapterResult.descendantTerminated ?? null,
      },
      changedFiles: candidate.changedPaths,
      candidateDiff: sanitizeText(candidate.diff, temporaryRoot),
      collectionError: collectionError ? sanitizeText(collectionError, temporaryRoot, 2_000) : null,
      finalOutput: sanitizeValue(finalOutput, temporaryRoot),
      scoring,
      passed: scoring.passed,
      transcriptArchived: false,
      externalMutationAllowed: false,
    };
  } catch (error) {
    report = {
      schemaVersion: 1,
      taskId: options.task.id,
      taskTitle: options.task.title,
      contextVariant: options.contextVariant,
      adapter: options.adapterId,
      cliVersion: null,
      source: options.task.source,
      baseSha: options.task.baseSha,
      baselineSha: null,
      contextDigest: null,
      contextPaths: [],
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedMs,
      error: sanitizeText(error instanceof Error ? error.message : String(error), temporaryRoot, 2_000),
      changedFiles: [],
      candidateDiff: '',
      finalOutput: null,
      passed: false,
      transcriptArchived: false,
      externalMutationAllowed: false,
    };
  } finally {
    const cleanup = cleanupWorktree(controllerRoot, temporaryRoot, worktreePath);
    report.cleanup = cleanup;
    if (!cleanup.worktreeRemoved || !cleanup.temporaryRootRemoved) report.passed = false;
  }

  let resultPath = null;
  if (options.writeResult !== false) {
    resultPath = writeResult(
      report,
      options.resultsDirectory ?? DEFAULT_RESULTS_DIRECTORY,
      resultFileName(startedAt, options.task, options.contextVariant, options.adapterId),
    );
  }
  return { report, resultPath };
}
