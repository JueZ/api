import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { classifyChangedFiles, parseGitNameStatus } from './path-classifier.mjs';

export const DEFAULT_BASE = 'origin/main';
export const DEFAULT_EVIDENCE_PATH = '.agent-runtime/affected-validation/latest.json';
export const EVIDENCE_SCHEMA_VERSION = 1;

const FORMAT_EXTENSIONS = new Set(['.css', '.html', '.js', '.json', '.md', '.mjs', '.ts', '.yaml', '.yml']);
const PACKAGE_TOOLS = Object.freeze({
  eslint: ['eslint', 'node_modules/eslint/bin/eslint.js'],
  ng: ['@angular/cli', 'node_modules/@angular/cli/bin/ng.js'],
  prettier: ['prettier', 'node_modules/prettier/bin/prettier.cjs'],
  redocly: ['@redocly/cli', 'node_modules/@redocly/cli/bin/cli.js'],
  tsc: ['typescript', 'node_modules/typescript/bin/tsc'],
});

export function assertNode22(version = process.versions.node) {
  if (Number.parseInt(String(version).split('.')[0], 10) !== 22) {
    throw new Error(`Affected validation requires Node.js 22; received ${version || 'unknown'}.`);
  }
}

export function parseArguments(argv) {
  const result = { base: DEFAULT_BASE, evidence: DEFAULT_EVIDENCE_PATH, plan: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--plan') result.plan = true;
    else if (value === '--help') result.help = true;
    else if (value === '--base' || value === '--evidence') {
      const argument = argv[++index];
      if (!argument || argument.startsWith('--')) throw new Error(`${value} requires a value.`);
      result[value.slice(2)] = argument;
    } else throw new Error(`Unknown argument: ${value}`);
  }
  return result;
}

export function inspectCandidate(root, baseRef = DEFAULT_BASE) {
  const baseSha = git(root, ['rev-parse', '--verify', `${baseRef}^{commit}`])
    .toString()
    .trim();
  const headSha = git(root, ['rev-parse', '--verify', 'HEAD^{commit}']).toString().trim();
  assertSha(baseSha, `base ${baseRef}`);
  assertSha(headSha, 'HEAD');
  if (run(root, 'git', ['merge-base', '--is-ancestor', baseSha, headSha], [0, 1]).status !== 0) {
    throw new Error(`Base ${baseRef} (${baseSha}) is not an ancestor of HEAD (${headSha}).`);
  }

  const finalFiles = gitChangedFiles(root, ['diff', '--name-status', '--find-renames', '-z', baseSha, '--']);
  const stagedFiles = gitChangedFiles(root, [
    'diff',
    '--cached',
    '--name-status',
    '--find-renames',
    '-z',
    baseSha,
    '--',
  ]);
  const untracked = splitNull(git(root, ['ls-files', '--others', '--exclude-standard', '-z']));
  const changedFiles = mergeChangedFiles(finalFiles, stagedFiles, untracked);
  const files = changedFiles.map((file) => ({ ...file, input: inspectPath(root, file.filename) }));
  const candidate = {
    baseRef,
    baseSha,
    headSha,
    files,
    patches: {
      baseToWorktree: hash(git(root, ['diff', '--binary', '--full-index', '--no-ext-diff', baseSha, '--'])),
      baseToIndex: hash(git(root, ['diff', '--cached', '--binary', '--full-index', '--no-ext-diff', baseSha, '--'])),
      headToWorktree: hash(git(root, ['diff', '--binary', '--full-index', '--no-ext-diff', 'HEAD', '--'])),
      untracked: hash(stable(files.filter((file) => untracked.includes(file.filename)))),
    },
  };
  return {
    candidate,
    changedFiles,
    classification: classifyChangedFiles(changedFiles),
    inputFingerprint: fingerprintCandidate(candidate),
  };
}

export function fingerprintCandidate(candidate) {
  return hash(stable(candidate));
}

export function assertStableCandidate(before, after) {
  if (before.inputFingerprint !== after.inputFingerprint) {
    throw new Error(
      'Candidate, index, worktree, or protected base changed during validation; no passing evidence recorded.',
    );
  }
}

export function createValidationPlan(classification, changedFiles, root) {
  const flags = classification?.flags ?? {};
  const steps = [];
  const ids = new Set();
  const add = (step) => {
    if (!ids.has(step.id)) {
      ids.add(step.id);
      steps.push({ outputs: [], ...step });
    }
  };
  const node = (id, description, tool, args, outputs = []) =>
    add({ id, description, commands: [{ tool, args }], outputs });
  const tests = (id, description, paths, requires = []) => {
    if (paths.length === 0) throw new Error(`No tests found for ${id}.`);
    add({ id, description, commands: [{ tool: 'node-test', args: paths }], outputs: [], requires });
  };

  add({
    id: 'diff-check',
    description: 'Reject protected-base worktree whitespace errors',
    commands: [{ tool: 'git', args: ['diff', '--check', classification.baseSha ?? DEFAULT_BASE, '--'] }],
  });
  const formatPaths = changedFiles
    .filter((file) => file.status !== 'removed' && FORMAT_EXTENSIONS.has(extension(file.filename)))
    .map((file) => file.filename)
    .filter((path) => existsSync(repositoryPath(root, path)));
  if (formatPaths.length) node('format', 'Check changed-file formatting', 'prettier', ['--check', ...formatPaths]);

  const sensitive = capability(classification, ['sensitive', 'sensitivity'], Boolean(flags.privileged));
  const agentEnvironment = capability(classification, ['agentEnvironment', 'environment'], Boolean(flags.privileged));
  if (sensitive) {
    node('policy', 'Validate repository policy', 'node', ['scripts/policy-guardrails.mjs']);
    node('architecture', 'Validate architecture boundaries', 'node', ['scripts/check-architecture.mjs']);
    node('agent-skills', 'Validate repository agent skills', 'node', ['scripts/validate-agent-skills.mjs']);
  }
  if (flags.dependencies) {
    tests('dependency-tests', 'Test dependency policy', ['scripts/test/dependency-supply-chain.test.mjs']);
    node('lockfile-policy', 'Validate lockfile co-changes', 'node', ['scripts/check-lockfile-policy.mjs']);
  }
  if (flags.learning) {
    node('learning-artifacts', 'Validate learning artifacts', 'node', [
      'scripts/agent-learning/validate-artifacts.mjs',
    ]);
    node('learning-index', 'Check learning index', 'node', ['scripts/agent-learning/generate-index.mjs', '--check']);
    tests('learning-tests', 'Test learning artifacts', ['scripts/test/agent-learning-artifacts.test.mjs']);
  }

  if (flags.backend) node('lint-api', 'Lint API sources', 'eslint', ['apps/api', '--max-warnings', '0']);
  if (flags.backend || flags.contracts || flags.operations) {
    node('build-api', 'Compile API once', 'tsc', ['-p', 'apps/api/tsconfig.json'], ['apps/api/dist']);
  }
  if (flags.backend) tests('test-api', 'Run API tests', immediateTests(root, 'apps/api/test'));
  if (flags.backend || flags.contracts) {
    node('contracts-lint', 'Lint OpenAPI contracts', 'redocly', [
      'lint',
      ...findFiles(root, 'contracts', (path) => /openapi.*\.(json|ya?ml)$/i.test(path)),
    ]);
    node('openapi-drift', 'Check route and OpenAPI drift', 'node', ['scripts/check-openapi-route-drift.mjs']);
    node('operation-drift', 'Check operation contract drift', 'node', ['scripts/check-operation-contract-drift.mjs']);
  }
  if (flags.frontend) {
    node('lint-web', 'Lint frontend sources', 'eslint', ['apps/web', '--max-warnings', '0']);
    tests('test-web', 'Run frontend tests', immediateTests(root, 'apps/web/test'));
    node(
      'build-web',
      'Compile production frontend once',
      'ng',
      ['build', '--configuration', 'production', '--no-progress'],
      ['dist/apps/web'],
    );
  }

  if (flags.operations) {
    tests('test-operations', 'Run operation-script tests', immediateTests(root, 'scripts/test'), ['bash']);
  }
  if (agentEnvironment) {
    const paths = immediateTests(root, 'scripts/agent-env/test');
    if (!flags.operations) {
      paths.push(
        ...[
          'scripts/test/maintain-codex-env.test.mjs',
          'scripts/test/run-tests.test.mjs',
          'scripts/test/setup-codex-env.test.mjs',
        ].filter((path) => existsSync(repositoryPath(root, path))),
      );
    }
    tests('test-agent-environment', 'Run environment and maintenance tests', paths, ['bash']);
  }
  if (flags.infrastructure) {
    for (const path of findFiles(root, 'infra', (file) => file.endsWith('.bicep'))) {
      add({
        id: `bicep-${slug(path)}`,
        description: `Compile ${path}`,
        commands: [{ tool: 'az', args: ['bicep', 'build', '--file', path, '--stdout'], quiet: true }],
      });
    }
  }
  if (flags.workflow) addWorkflowSteps(add, root);
  return steps;
}

export function collectProvenance(root, steps, environment = process.env) {
  const dependencies = [
    'package.json',
    'package-lock.json',
    'node_modules/.package-lock.json',
    'apps/api/package.json',
    'apps/api/package-lock.json',
    'apps/api/node_modules/.package-lock.json',
  ].map((path) => ({ path, ...inspectPath(root, path) }));
  const toolNames = [
    ...new Set([
      'node',
      ...steps.flatMap((step) => step.commands.map((command) => command.tool)),
      ...steps.flatMap((step) => step.requires ?? []),
    ]),
  ].sort();
  const tools = Object.fromEntries(toolNames.map((tool) => [tool, inspectTool(root, tool)]));
  const environmentFingerprint = hash(
    stable(
      Object.fromEntries(
        ['CI', 'LANG', 'LC_ALL', 'NODE_ENV', 'NODE_OPTIONS', 'PATH', 'TEMP', 'TMP', 'TZ']
          .filter((name) => environment[name] !== undefined)
          .map((name) => [name, environment[name]]),
      ),
    ),
  );
  const metadata = { dependencies, tools, environmentFingerprint };
  return {
    ...metadata,
    fingerprint: fingerprintProvenance(metadata),
    scope: 'advisory declared and installed-lock metadata; installed package bytes are not exhaustively hashed',
  };
}

export function fingerprintProvenance({ dependencies, tools, environmentFingerprint }) {
  return hash(stable({ dependencies, tools, environmentFingerprint }));
}

export function unavailableTools(provenance) {
  return Object.entries(provenance.tools)
    .filter(([, tool]) => !tool.available)
    .map(([name]) => name);
}

export function outputState(root, steps) {
  return [...new Set(steps.flatMap((step) => step.outputs))]
    .sort()
    .map((path) => ({ path, ...inspectTree(root, path) }));
}

export function planFingerprint(steps) {
  return hash(stable(steps));
}

export function createEvidence({
  inspection,
  postInspection,
  steps,
  provenance,
  results,
  outputs,
  outcome,
  startedAt,
  finishedAt,
}) {
  const body = {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    reusePolicy: 'none',
    priorMetadata: 'advisory only',
    repeatGuidance: 'Run again after any candidate, base, dependency, toolchain, environment, or output change.',
    remoteChecksRequired: true,
    base: { ref: inspection.candidate.baseRef, sha: inspection.candidate.baseSha },
    candidate: inspection.candidate,
    postExecutionCandidate: postInspection?.candidate ?? postInspection ?? null,
    classification: inspection.classification,
    inputFingerprint: inspection.inputFingerprint,
    planFingerprint: planFingerprint(steps),
    provenance,
    outputs,
    outcome,
    startedAt,
    finishedAt,
    results,
  };
  return { ...body, evidenceDigest: hash(stable(body)) };
}

export function assessEvidence(evidence, { inspection, steps, provenance, outputs }) {
  if (!evidence || evidence.schemaVersion !== EVIDENCE_SCHEMA_VERSION)
    return advisory(false, 'missing-or-unsupported-evidence');
  const { evidenceDigest, ...body } = evidence;
  if (evidenceDigest !== hash(stable(body))) return advisory(false, 'evidence-digest-mismatch');
  if (evidence.outcome !== 'passed') return advisory(false, 'prior-run-did-not-pass');
  if (evidence.inputFingerprint !== inspection.inputFingerprint) return advisory(false, 'candidate-inputs-changed');
  if (evidence.planFingerprint !== planFingerprint(steps)) return advisory(false, 'validation-plan-changed');
  if (evidence.provenance?.fingerprint !== provenance.fingerprint)
    return advisory(false, 'dependencies-or-toolchain-changed');
  if (stable(evidence.outputs) !== stable(outputs)) return advisory(false, 'outputs-changed');
  return advisory(true, 'metadata matches; automatic reuse is disabled');
}

export function executePlan(root, steps, environment = process.env) {
  const results = [];
  for (const step of steps) {
    const started = Date.now();
    try {
      for (const command of step.commands) execute(root, command, environment);
      results.push({ id: step.id, status: 'passed', durationMs: Date.now() - started });
    } catch (error) {
      results.push({ id: step.id, status: 'failed', durationMs: Date.now() - started, error: error.message });
      error.results = results;
      throw error;
    }
  }
  return results;
}

export function readEvidence(root, path = DEFAULT_EVIDENCE_PATH) {
  const file = validateEvidencePath(root, path);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function writeEvidence(root, evidence, path = DEFAULT_EVIDENCE_PATH) {
  const file = validateEvidencePath(root, path);
  mkdirSync(dirname(file), { recursive: true });
  validateEvidencePath(root, path);
  const temporary = `${file}.${randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, `${JSON.stringify(evidence, null, 2)}\n`);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, file);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
  return file;
}

export function validateEvidencePath(root, path = DEFAULT_EVIDENCE_PATH) {
  const prefix = '.agent-runtime/affected-validation/';
  if (
    typeof path !== 'string' ||
    path !== path.trim() ||
    path.includes('\\') ||
    !path.startsWith(prefix) ||
    path.length === prefix.length
  ) {
    throw new Error(`Evidence path must be a repository-relative file under ${prefix}.`);
  }
  const segments = path.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('Evidence path contains an invalid segment.');
  }
  const file = repositoryPath(root, path);
  for (let index = 1; index <= segments.length; index += 1) {
    const ancestor = join(resolve(root), ...segments.slice(0, index));
    const stat = lstatIfExists(ancestor);
    if (!stat) continue;
    if (stat.isSymbolicLink() || comparablePath(realpathSync.native(ancestor)) !== comparablePath(ancestor)) {
      throw new Error(`Evidence path traverses a symbolic link or reparse point: ${relative(root, ancestor)}.`);
    }
  }
  const destination = lstatIfExists(file);
  if (destination && !destination.isFile()) throw new Error('Evidence destination must be a regular file.');
  if (run(root, 'git', ['ls-files', '--error-unmatch', '--', path], [0, 1]).status === 0) {
    throw new Error('Evidence destination is tracked by Git.');
  }
  if (git(root, ['log', '--all', '--format=%H', '--', path]).toString().trim()) {
    throw new Error('Evidence destination has tracked Git history.');
  }
  if (run(root, 'git', ['check-ignore', '--quiet', '--', path], [0, 1]).status !== 0) {
    throw new Error('Evidence destination is not ignored by Git.');
  }
  return file;
}

export function printablePlan(root, inspection, steps, provenance, priorEvidence) {
  const outputs = outputState(root, steps);
  return {
    mode: 'plan',
    base: { ref: inspection.candidate.baseRef, sha: inspection.candidate.baseSha },
    candidate: { ...inspection.candidate, inputFingerprint: inspection.inputFingerprint },
    classification: inspection.classification,
    provenance,
    unavailableTools: unavailableTools(provenance),
    priorEvidence: assessEvidence(priorEvidence, { inspection, steps, provenance, outputs }),
    reusePolicy: 'none; every selected check runs',
    remoteChecksRequired: true,
    steps: steps.map((step) => ({ ...step, commands: step.commands.map(printCommand) })),
  };
}

function addWorkflowSteps(add, root) {
  const workflows = findFiles(root, '.github/workflows', (path) => /\.ya?ml$/i.test(path));
  const ordinary = workflows.filter((path) => path !== '.github/workflows/repair-triage.yml');
  if (ordinary.length) {
    add({
      id: 'actionlint',
      description: 'Validate workflows without its shell subprocess',
      commands: [{ tool: 'actionlint', args: ['-shellcheck=', ...ordinary] }],
    });
  }
  if (workflows.includes('.github/workflows/repair-triage.yml')) {
    add({
      id: 'actionlint-repair-triage',
      description: 'Validate repair workflow with pinned compatibility exception',
      commands: [
        {
          tool: 'actionlint',
          args: [
            '-shellcheck=',
            '-ignore',
            '^unexpected key "queue" for "concurrency" section\\.',
            '.github/workflows/repair-triage.yml',
          ],
        },
      ],
    });
  }
  const shellFiles = findFiles(root, 'scripts', (path) => path.endsWith('.sh'));
  if (shellFiles.length) {
    add({
      id: 'shellcheck',
      description: 'Validate all shell scripts',
      commands: [{ tool: 'shellcheck', args: shellFiles }],
    });
  }
}

function inspectTool(root, tool) {
  if (tool === 'node' || tool === 'node-test')
    return { available: true, path: process.execPath, version: process.version };
  const packageTool = PACKAGE_TOOLS[tool];
  if (packageTool) {
    const [packageName, script] = packageTool;
    const manifest = join(root, 'node_modules', ...packageName.split('/'), 'package.json');
    if (!existsSync(manifest) || !existsSync(repositoryPath(root, script)))
      return { available: false, package: packageName };
    return {
      available: true,
      package: packageName,
      version: JSON.parse(readFileSync(manifest, 'utf8')).version,
      script,
    };
  }
  const executable = resolveCommand(root, tool);
  if (!executable) return { available: false, error: 'not-found' };
  const args = tool === 'az' ? ['version', '--output', 'json'] : ['--version'];
  const completed = spawnExecutable(root, executable, args, { encoding: 'utf8', timeout: 30_000 });
  if (completed.error || completed.status !== 0)
    return { available: false, path: executable, error: completed.error?.code ?? completed.status };
  return { available: true, path: executable, version: `${completed.stdout}${completed.stderr}`.trim() };
}

function execute(root, command, environment) {
  let executable;
  let args = command.args;
  if (command.tool === 'node') executable = process.execPath;
  else if (command.tool === 'node-test') {
    executable = process.execPath;
    args = ['--test', ...args];
  } else if (PACKAGE_TOOLS[command.tool]) {
    executable = process.execPath;
    args = [repositoryPath(root, PACKAGE_TOOLS[command.tool][1]), ...args];
  } else executable = resolveCommand(root, command.tool);
  if (!executable) throw new Error(`${command.tool} is unavailable.`);
  console.log(`> ${printCommand(command)}`);
  const completed = spawnExecutable(root, executable, args, {
    env: environment,
    stdio: command.quiet ? ['ignore', 'ignore', 'inherit'] : 'inherit',
  });
  if (completed.error) throw completed.error;
  if (completed.status !== 0) throw new Error(`${command.tool} exited with status ${completed.status}.`);
}

export function resolveCommand(root, command) {
  if (isAbsolute(command) && existsSync(command)) return command;
  const locator = process.platform === 'win32' ? ['where.exe', [command]] : ['which', [command]];
  const found = spawnSync(locator[0], locator[1], { cwd: root, encoding: 'utf8', windowsHide: true });
  if (found.status !== 0) return '';
  return process.platform === 'win32' ? selectWindowsCommand(found.stdout) : found.stdout.split(/\r?\n/, 1)[0].trim();
}

export function selectWindowsCommand(output) {
  return (
    output
      .split(/\r?\n/)
      .map((path) => path.trim())
      .find((path) => /\.(exe|com|cmd|bat)$/i.test(path)) ?? ''
  );
}

function spawnExecutable(root, executable, args, options) {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable)) {
    if (args.some((arg) => /[\r\n&|<>^%!]/.test(arg))) return { error: new Error('Unsafe command-shim argument.') };
    const line = `""${executable.replaceAll('"', '""')}" ${args.map(cmdQuote).join(' ')}"`;
    return spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', line], {
      cwd: root,
      windowsHide: true,
      windowsVerbatimArguments: true,
      ...options,
    });
  }
  return spawnSync(executable, args, { cwd: root, windowsHide: true, ...options });
}

function cmdQuote(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function mergeChangedFiles(finalFiles, stagedFiles, untracked) {
  const records = new Map();
  for (const file of [...finalFiles, ...stagedFiles, ...untracked.map((filename) => ({ filename, status: 'added' }))]) {
    const prior = records.get(file.filename);
    if (!prior || file.previous_filename || prior.status !== 'renamed') records.set(file.filename, file);
  }
  return [...records.values()].sort((left, right) => left.filename.localeCompare(right.filename));
}

function gitChangedFiles(root, args) {
  const parsed = parseGitNameStatus(git(root, args).toString());
  if (parsed === null) throw new Error('Git returned malformed changed-file metadata.');
  return parsed;
}

function inspectPath(root, path) {
  const file = repositoryPath(root, path);
  if (!existsSync(file)) return { exists: false };
  const stat = lstatSync(file);
  if (stat.isSymbolicLink()) return { exists: true, type: 'symlink', target: readlinkSync(file) };
  if (!stat.isFile()) return { exists: true, type: stat.isDirectory() ? 'directory' : 'other' };
  const content = readFileSync(file);
  return { exists: true, type: 'file', bytes: content.length, digest: hash(content) };
}

function inspectTree(root, path) {
  const directory = repositoryPath(root, path);
  if (!existsSync(directory)) return { exists: false, digest: hash('missing') };
  const entries = findFiles(root, path, () => true).map((file) => ({ file, ...inspectPath(root, file) }));
  return { exists: true, files: entries.length, digest: hash(stable(entries)) };
}

function immediateTests(root, directory) {
  const path = repositoryPath(root, directory);
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.mjs'))
    .map((entry) => `${directory}/${entry.name}`)
    .sort();
}

function findFiles(root, directory, predicate) {
  const start = repositoryPath(root, directory);
  if (!existsSync(start)) return [];
  const files = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() || entry.isSymbolicLink()) {
        const repositoryFile = relative(root, path).split(sep).join('/');
        if (predicate(repositoryFile)) files.push(repositoryFile);
      }
    }
  };
  visit(start);
  return files;
}

function capability(classification, names, fallback) {
  for (const container of [classification?.capabilities, classification?.flags]) {
    for (const name of names) if (typeof container?.[name] === 'boolean') return container[name];
  }
  return fallback;
}

function repositoryPath(root, path) {
  if (isAbsolute(path)) throw new Error(`Expected repository-relative path: ${path}`);
  const repositoryRoot = resolve(root);
  const resolved = resolve(repositoryRoot, path);
  if (resolved !== repositoryRoot && !resolved.startsWith(`${repositoryRoot}${sep}`))
    throw new Error(`Path escapes repository: ${path}`);
  return resolved;
}

function comparablePath(path) {
  const normalized = resolve(path);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function lstatIfExists(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function git(root, args) {
  return run(root, 'git', args).stdout;
}

function run(root, command, args, allowed = [0]) {
  const completed = spawnSync(command, args, {
    cwd: root,
    encoding: null,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  if (completed.error) throw completed.error;
  if (!allowed.includes(completed.status))
    throw new Error(`${command} failed: ${completed.stderr?.toString().trim() || completed.status}`);
  return completed;
}

function splitNull(buffer) {
  const values = buffer.toString().split('\0');
  if (values.at(-1) === '') values.pop();
  return values;
}

function extension(path) {
  return /\.[^./]+$/.exec(path)?.[0].toLowerCase() ?? '';
}

function assertSha(value, name) {
  if (!/^[0-9a-f]{40}$/.test(value)) throw new Error(`${name} did not resolve to a full lowercase commit SHA.`);
}

function printCommand(command) {
  const tool = command.tool === 'node-test' ? 'node --test' : command.tool;
  return [tool, ...command.args]
    .map((value) => (/^[A-Za-z0-9_./:@=-]+$/.test(value) ? value : JSON.stringify(value)))
    .join(' ');
}

function slug(value) {
  return value
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

function advisory(matches, reason) {
  return { advisory: true, matches, reusable: false, reason };
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}
