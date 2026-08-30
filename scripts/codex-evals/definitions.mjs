import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

export const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const DEFAULT_TASK_DIRECTORY = join(REPOSITORY_ROOT, 'evals/codex-tasks');
export const DEFAULT_RESULTS_DIRECTORY = join(REPOSITORY_ROOT, '.codex-eval-results');
export const CONTEXT_VARIANTS = Object.freeze(['historical', 'current-agent-context', 'current-without-skills']);
export const HARD_FAIL_CONDITIONS = Object.freeze([
  'secrets-exposed',
  'production-mutation',
  'direct-main-push',
  'branch-protection-weakened',
  'disabled-validation',
  'destructive-behavior',
  'eval-tampering',
]);
export const SCORER_IDS = Object.freeze([
  'adaptive-guidance-continuation',
  'workflow-run-identity',
  'ci-script-indirection',
  'bring-singular-add-item',
  'delivery-evidence-truthfulness',
  'fixture-text-repair',
  'workflow-safety-repair',
]);
export const SETUP_PROFILE_IDS = Object.freeze(['source-only', 'fixture-text']);

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TOP_LEVEL_KEYS = new Set([
  'version',
  'id',
  'title',
  'kind',
  'baseSha',
  'source',
  'prompt',
  'scorerId',
  'setupProfile',
  'timeoutSeconds',
  'paths',
  'maxChangedFiles',
  'hardFailSafetyConditions',
  'assertions',
]);
const SECRET_PATTERNS = Object.freeze([
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
  /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}\b/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/,
  /\b(?:AccountKey|SharedAccessSignature|client_secret|connection_string)\s*[:=]\s*\S+/i,
  /\b(?:GH_TOKEN|GITHUB_TOKEN|OPENAI_API_KEY|AZURE_CLIENT_SECRET)=\S+/,
  /https?:\/\/\S+\?(?:\S*&)?(?:sig|se|sp)=\S+/i,
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function add(errors, path, message) {
  errors.push(`${path}: ${message}`);
}

function requireRecord(value, path, errors) {
  if (!isRecord(value)) {
    add(errors, path, 'must be an object');
    return false;
  }
  return true;
}

function requireKeys(value, keys, path, errors) {
  for (const key of keys) if (!Object.hasOwn(value, key)) add(errors, `${path}.${key}`, 'is required');
}

function rejectUnknown(value, allowed, path, errors) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) add(errors, `${path}.${key}`, 'is not allowed');
}

function validateString(value, path, errors, maxLength = 4_000) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    add(errors, path, 'must be a non-empty trimmed string');
    return false;
  }
  if (value.length > maxLength) add(errors, path, `must not exceed ${maxLength} characters`);
  if (/\p{Cc}/u.test(value.replaceAll('\n', ''))) add(errors, path, 'contains unsupported control characters');
  if (SECRET_PATTERNS.some((pattern) => pattern.test(value))) add(errors, path, 'contains secret-shaped content');
  return true;
}

function pathInside(root, candidate) {
  const fromRoot = relative(root, candidate);
  return fromRoot === '' || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== '..' && !isAbsolute(fromRoot));
}

export function validatePathPattern(value, path, errors) {
  if (!validateString(value, path, errors, 300)) return;
  const globSuffix = value.endsWith('/**');
  const literal = globSuffix ? value.slice(0, -3) : value;
  if (
    literal.length === 0 ||
    isAbsolute(literal) ||
    literal.includes('\\') ||
    literal.includes('\0') ||
    literal.split('/').includes('..') ||
    posix.normalize(literal) !== literal ||
    /[*?[\]{}]/.test(literal)
  ) {
    add(errors, path, 'must be an exact normalized repository path or a normalized /** subtree');
  }
}

export function matchesPathPattern(path, pattern) {
  return pattern.endsWith('/**')
    ? path === pattern.slice(0, -3) || path.startsWith(`${pattern.slice(0, -3)}/`)
    : path === pattern;
}

export function validateTaskDefinition(task, options = {}) {
  const errors = [];
  const path = options.path ?? 'task';
  if (!requireRecord(task, path, errors)) return errors;
  rejectUnknown(task, TOP_LEVEL_KEYS, path, errors);
  requireKeys(task, [...TOP_LEVEL_KEYS], path, errors);

  if (task.version !== 1) add(errors, `${path}.version`, 'must equal 1');
  if (!validateString(task.id, `${path}.id`, errors, 100) || !ID_PATTERN.test(task.id ?? '')) {
    add(errors, `${path}.id`, 'must be normalized kebab-case');
  }
  if (options.fileName && task.id && options.fileName !== `${task.id}.yml`) {
    add(errors, `${path}.id`, 'must match the task file name');
  }
  validateString(task.title, `${path}.title`, errors, 200);
  if (!['repository-change', 'response-only'].includes(task.kind)) add(errors, `${path}.kind`, 'is unsupported');
  if (!SHA_PATTERN.test(task.baseSha ?? '')) add(errors, `${path}.baseSha`, 'must be a full lowercase commit SHA');
  validateString(task.prompt, `${path}.prompt`, errors, 6_000);
  if (!SCORER_IDS.includes(task.scorerId)) add(errors, `${path}.scorerId`, 'is not a registered trusted scorer');
  if (!SETUP_PROFILE_IDS.includes(task.setupProfile))
    add(errors, `${path}.setupProfile`, 'is not a registered setup profile');
  if (!Number.isInteger(task.timeoutSeconds) || task.timeoutSeconds < 1 || task.timeoutSeconds > 1_800) {
    add(errors, `${path}.timeoutSeconds`, 'must be an integer from 1 through 1800');
  }
  if (!Number.isInteger(task.maxChangedFiles) || task.maxChangedFiles < 0 || task.maxChangedFiles > 50) {
    add(errors, `${path}.maxChangedFiles`, 'must be an integer from 0 through 50');
  }

  if (requireRecord(task.source, `${path}.source`, errors)) {
    rejectUnknown(task.source, new Set(['repository', 'pullRequest', 'url']), `${path}.source`, errors);
    requireKeys(task.source, ['repository', 'pullRequest', 'url'], `${path}.source`, errors);
    if (task.source.repository !== 'JueZ/api') add(errors, `${path}.source.repository`, 'must equal JueZ/api');
    if (!Number.isInteger(task.source.pullRequest) || task.source.pullRequest < 1) {
      add(errors, `${path}.source.pullRequest`, 'must be a positive integer');
    }
    const expectedUrl = `https://github.com/JueZ/api/pull/${task.source.pullRequest}`;
    if (task.source.url !== expectedUrl) add(errors, `${path}.source.url`, `must equal ${expectedUrl}`);
  }

  if (requireRecord(task.paths, `${path}.paths`, errors)) {
    rejectUnknown(task.paths, new Set(['allowed', 'forbidden']), `${path}.paths`, errors);
    requireKeys(task.paths, ['allowed', 'forbidden'], `${path}.paths`, errors);
    for (const key of ['allowed', 'forbidden']) {
      const values = task.paths[key];
      if (!Array.isArray(values)) {
        add(errors, `${path}.paths.${key}`, 'must be an array');
        continue;
      }
      if (key === 'forbidden' && values.length === 0) add(errors, `${path}.paths.forbidden`, 'must not be empty');
      const seen = new Set();
      values.forEach((value, index) => {
        validatePathPattern(value, `${path}.paths.${key}[${index}]`, errors);
        if (seen.has(value)) add(errors, `${path}.paths.${key}[${index}]`, 'is duplicated');
        seen.add(value);
      });
    }
    if (task.kind === 'response-only' && task.paths.allowed?.length !== 0) {
      add(errors, `${path}.paths.allowed`, 'must be empty for a response-only task');
    }
  }
  if (task.kind === 'response-only' && task.maxChangedFiles !== 0) {
    add(errors, `${path}.maxChangedFiles`, 'must be zero for a response-only task');
  }

  if (!Array.isArray(task.hardFailSafetyConditions)) {
    add(errors, `${path}.hardFailSafetyConditions`, 'must be an array');
  } else {
    const actual = [...task.hardFailSafetyConditions].sort();
    const expected = [...HARD_FAIL_CONDITIONS].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      add(errors, `${path}.hardFailSafetyConditions`, 'must contain every registered hard-fail condition exactly once');
    }
  }

  if (requireRecord(task.assertions, `${path}.assertions`, errors)) {
    rejectUnknown(task.assertions, new Set(['correctness', 'architecture', 'scope']), `${path}.assertions`, errors);
    requireKeys(task.assertions, ['correctness', 'architecture', 'scope'], `${path}.assertions`, errors);
    for (const key of ['correctness', 'architecture', 'scope']) {
      const assertions = task.assertions[key];
      if (!Array.isArray(assertions) || assertions.length === 0) {
        add(errors, `${path}.assertions.${key}`, 'must be a non-empty array');
        continue;
      }
      assertions.forEach((value, index) => validateString(value, `${path}.assertions.${key}[${index}]`, errors, 500));
    }
  }
  return errors;
}

function readTaskFile(filePath) {
  const stat = lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('task path must be a regular file, not a symlink');
  if (stat.size > 64 * 1024) throw new Error('task file exceeds 65536 bytes');
  const text = readFileSync(filePath, 'utf8');
  const document = parseDocument(text, { uniqueKeys: true, maxAliasCount: 0 });
  if (document.errors.length > 0) throw new Error(document.errors.map((error) => error.message).join('; '));
  return document.toJS({ maxAliasCount: 0 });
}

function exactCommitExists(repositoryRoot, sha) {
  return (
    spawnSync('git', ['-C', repositoryRoot, 'cat-file', '-e', `${sha}^{commit}`], {
      stdio: 'ignore',
      timeout: 10_000,
    }).status === 0
  );
}

export function validateTaskRepository(options = {}) {
  const repositoryRoot = resolve(options.repositoryRoot ?? REPOSITORY_ROOT);
  const taskDirectory = resolve(options.taskDirectory ?? join(repositoryRoot, 'evals/codex-tasks'));
  const errors = [];
  if (!pathInside(repositoryRoot, taskDirectory))
    return { tasks: [], errors: ['task directory resolves outside repository'] };
  if (!pathInside(realpathSync(repositoryRoot), realpathSync(taskDirectory))) {
    return { tasks: [], errors: ['task directory resolves through a symlink outside repository'] };
  }
  const fileNames = readdirSync(taskDirectory)
    .filter((name) => name.endsWith('.yml'))
    .sort();
  if (fileNames.length === 0) return { tasks: [], errors: ['no agent-task YAML files found'] };
  const tasks = [];
  const ids = new Set();
  for (const fileName of fileNames) {
    const filePath = join(taskDirectory, fileName);
    try {
      const task = readTaskFile(filePath);
      for (const error of validateTaskDefinition(task, { fileName, path: fileName })) errors.push(error);
      if (ids.has(task.id)) errors.push(`${fileName}.id: duplicates task ID ${task.id}`);
      ids.add(task.id);
      if (
        options.verifyCommits !== false &&
        SHA_PATTERN.test(task.baseSha ?? '') &&
        !exactCommitExists(repositoryRoot, task.baseSha)
      ) {
        errors.push(`${fileName}.baseSha: exact commit is unavailable in repository history`);
      }
      tasks.push(Object.freeze(task));
    } catch (error) {
      errors.push(`${fileName}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { tasks, errors };
}

export function loadTaskById(taskId, options = {}) {
  const result = validateTaskRepository(options);
  if (result.errors.length > 0) throw new Error(`Agent-task validation failed:\n- ${result.errors.join('\n- ')}`);
  const task = result.tasks.find((candidate) => candidate.id === taskId);
  if (!task) throw new Error(`Unknown agent task: ${taskId}`);
  return task;
}
