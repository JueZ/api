import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const assets = join(repository, 'evals/codex-tasks/representative-trials');
export const TASKS = Object.freeze({
  ordinary_feature: ['src/catalog.mjs'],
  small_fix: ['src/retry.mjs'],
  provider_shape_mismatch: ['src/provider.mjs', 'evidence/provider.json'],
  permissions_blocker: ['evidence/authorization.json'],
  superseded_deployment: ['evidence/delivery.json'],
});
const digest = (value) => createHash('sha256').update(value).digest('hex');
const text = (path) => readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
const localEnvironment = () =>
  Object.fromEntries(
    ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']
      .filter((key) => process.env[key])
      .map((key) => [key, process.env[key]]),
  );
function inspect(path) {
  let current = parse(path).root;
  let stat;
  for (const part of relative(current, path).split(sep).filter(Boolean)) {
    current = join(current, part);
    stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) throw new Error('Links and junctions are not allowed.');
    if (stat && current !== path && !stat.isDirectory()) throw new Error('Ancestor is not a directory.');
  }
  return stat;
}
function contains(parent, child) {
  const path = relative(parent, child);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}
function destination(path) {
  if (typeof path !== 'string' || !path.trim()) throw new Error('Provide a fixture directory.');
  const root = resolve(path);
  if (contains(repository, root) || contains(root, repository))
    throw new Error('Fixture must be outside the source checkout.');
  inspect(root);
  return root;
}
function asset(path) {
  const source = join(assets, path);
  if (!inspect(source)?.isFile()) throw new Error(`Missing regular asset: ${path}`);
  return text(source);
}

export function fixtureInputs(taskType, variant) {
  if (!Object.hasOwn(TASKS, taskType) || !['baseline', 'revised'].includes(variant))
    throw new Error('Unknown task or variant.');
  const pin = JSON.parse(asset('guidance/pins.json'))[variant];
  const guidance = asset(`guidance/${variant}.md`);
  if (digest(guidance) !== pin.sha256) throw new Error('Guidance digest differs from its reviewed pin.');
  const files = {
    'AGENTS.md': guidance,
    'TASK.md': `${asset('local-rules.md').trim()}\n\n${asset(`${taskType}/prompt.md`)}`,
    'case.json': `${JSON.stringify({ taskType })}\n`,
    'checks.mjs': asset('checks.mjs'),
  };
  for (const path of TASKS[taskType]) files[path] = asset(`${taskType}/${path}`);
  return {
    files,
    identity: {
      taskType,
      variant,
      instructionRevision: `${pin.sourceRevision}:${pin.sha256}`,
      fixtureDigest: digest(JSON.stringify(Object.entries(files).filter(([path]) => path !== 'AGENTS.md'))),
      evidenceLevel: 'local_fixture',
    },
  };
}

export function prepareFixture(taskType, variant, path) {
  const root = destination(path);
  const stat = inspect(root);
  if (stat && (!stat.isDirectory() || readdirSync(root).length))
    throw new Error('Fixture destination must be nonexistent or empty.');
  const { files, identity } = fixtureInputs(taskType, variant);
  mkdirSync(root, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const output = join(root, name);
    inspect(output);
    mkdirSync(dirname(output), { recursive: true });
    inspect(output);
    writeFileSync(output, content, { flag: 'wx' });
  }
  const git = spawnSync('git', ['init', '--quiet', '--template=', '--initial-branch=trial', root], {
    env: localEnvironment(),
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (git.status !== 0) throw new Error('Local git init failed; inspect the partial fixture before retrying.');
  return { ...identity, directory: root, prompt: join(root, 'TASK.md') };
}

function inventory(root, path = '', files = []) {
  if (path.split('/').length > 4) throw new Error('Fixture exceeds the bounded directory depth.');
  for (const entry of readdirSync(join(root, path), { withFileTypes: true })) {
    if (!path && entry.name === '.git') continue;
    const name = path ? `${path}/${entry.name}` : entry.name;
    const stat = inspect(join(root, name));
    if (stat.isDirectory()) inventory(root, name, files);
    else if (stat.isFile() && stat.size <= 128 * 1024) files.push(name);
    else throw new Error('Fixture contains a non-regular or oversized file.');
    if (files.length > 40) throw new Error('Fixture exceeds the bounded file count.');
  }
  return files;
}

export function verifyFixture(taskType, variant, path) {
  const root = destination(path);
  const { files, identity } = fixtureInputs(taskType, variant);
  const allowed =
    taskType === 'permissions_blocker' || taskType === 'superseded_deployment'
      ? ['assessment.json']
      : [TASKS[taskType][0], 'solution.test.mjs'];
  const names = inventory(root);
  for (const name of names) {
    if (!Object.hasOwn(files, name) && !allowed.includes(name)) throw new Error(`Unexpected candidate file: ${name}`);
  }
  for (const [name, content] of Object.entries(files)) {
    if (!inspect(join(root, name))?.isFile()) throw new Error(`Missing fixture input: ${name}`);
    if (!allowed.includes(name) && text(join(root, name)) !== content)
      throw new Error(`Changed immutable fixture input: ${name}`);
  }
  const snapshot = () =>
    digest(
      JSON.stringify(
        inventory(root)
          .sort()
          .map((name) => [name, text(join(root, name))]),
      ),
    );
  const before = snapshot();
  // Execute only Node checks; never invoke a model or the historical Codex adapter.
  const result = spawnSync(process.execPath, [join(assets, 'checks.mjs'), '--root', root], {
    cwd: root,
    env: localEnvironment(),
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  });
  if (snapshot() !== before) throw new Error('Candidate changed while its outcome was being checked.');
  let outcome = null;
  try {
    outcome = JSON.parse(result.stdout);
  } catch {
    /* Missing check receipt is never a pass. */
  }
  const passed =
    result.status === 0 &&
    !result.error &&
    outcome?.status === 'passed' &&
    outcome.taskType === taskType &&
    outcome.evidenceLevel === 'local_fixture';
  return { ...identity, passed, exitCode: result.status, outcome, error: result.error?.code ?? null };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [mode, task, variant, root, ...extra] = process.argv.slice(2);
    if (mode === 'list' && !task)
      console.log(JSON.stringify({ tasks: Object.keys(TASKS), variants: ['baseline', 'revised'] }));
    else if (['prepare', 'verify'].includes(mode) && root && !extra.length) {
      const result = (mode === 'prepare' ? prepareFixture : verifyFixture)(task, variant, root);
      console.log(JSON.stringify(result, null, 2));
      if (result.passed === false) process.exitCode = 1;
    } else
      throw new Error(
        'Usage: representative-trials.mjs list | prepare/verify <taskType> <baseline|revised> <directory>',
      );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
