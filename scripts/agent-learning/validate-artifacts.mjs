#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

export const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const ARTIFACT_DIRECTORY = resolve(REPOSITORY_ROOT, 'docs/agent-learning/artifacts');
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FINGERPRINT_RE = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const SEVERITIES = new Set(['low', 'medium', 'high', 'critical']);
const STATUSES = new Set(['active', 'verified', 'superseded']);
const PREVENTION_KINDS = new Set(['regression-test', 'deterministic-guard', 'skill', 'instruction', 'architecture']);
const TOP_LEVEL_KEYS = new Set([
  'version',
  'id',
  'fingerprint',
  'severity',
  'invariant',
  'scope',
  'prevention',
  'broken',
  'fixed',
  'repairPr',
  'recurrenceCount',
  'status',
  'supersededBy',
]);
const PREVENTION_KEYS = new Set(['kind', 'path']);
const SECRET_PATTERNS = Object.freeze([
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\b(?:github_pat_|gh[pousr]_|sk-(?:proj-)?|AKIA)[A-Za-z0-9_-]{8,}/i,
  /\b(?:authorization|connection[_ -]?string|password|sas|secret|token)\s*[:=]\s*[^\s,;]+/i,
  /https?:\/\/[^\s/@:]+:[^\s/@]+@/i,
]);

export function validateLearningArtifact(artifact, { filename = '', repositoryRoot = REPOSITORY_ROOT } = {}) {
  const errors = [];
  if (!isRecord(artifact)) return ['artifact must be an object'];
  rejectUnknownKeys(artifact, TOP_LEVEL_KEYS, 'artifact', errors);

  if (artifact.version !== 2) errors.push('version must be 2');
  if (!ID_RE.test(String(artifact.id || '')) || String(artifact.id || '').length > 96) {
    errors.push('id must be a normalized kebab-case identifier');
  }
  if (filename && basename(filename, '.yml') !== artifact.id) errors.push('id must match the artifact file name');
  if (!FINGERPRINT_RE.test(String(artifact.fingerprint || '')) || String(artifact.fingerprint || '').length > 160) {
    errors.push('fingerprint must be a normalized mechanism identifier');
  }
  if (!SEVERITIES.has(artifact.severity)) errors.push('severity must be low, medium, high, or critical');
  boundedString(artifact.invariant, 'invariant', errors, { min: 12, max: 600 });
  validateScope(artifact.scope, errors);
  validatePrevention(artifact.prevention, repositoryRoot, errors);

  if (!Number.isInteger(artifact.recurrenceCount) || artifact.recurrenceCount < 1 || artifact.recurrenceCount > 999) {
    errors.push('recurrenceCount must be an integer from 1 to 999');
  }
  if (!STATUSES.has(artifact.status)) errors.push('status must be active, verified, or superseded');
  if (artifact.broken !== undefined && !SHA_RE.test(String(artifact.broken)))
    errors.push('broken must be an exact SHA');
  if (artifact.fixed !== undefined && !SHA_RE.test(String(artifact.fixed))) errors.push('fixed must be an exact SHA');
  if (artifact.broken && artifact.fixed && artifact.broken === artifact.fixed)
    errors.push('broken and fixed must differ');
  if (artifact.repairPr !== undefined && !positiveInteger(artifact.repairPr)) {
    errors.push('repairPr must be a positive pull-request number');
  }
  if (artifact.status === 'verified') {
    if (!SHA_RE.test(String(artifact.broken || ''))) errors.push('verified artifacts require broken');
    if (!SHA_RE.test(String(artifact.fixed || ''))) errors.push('verified artifacts require fixed');
    if (!positiveInteger(artifact.repairPr)) errors.push('verified artifacts require repairPr');
  }
  if (artifact.status === 'superseded') {
    if (!ID_RE.test(String(artifact.supersededBy || '')) || artifact.supersededBy === artifact.id) {
      errors.push('superseded artifacts require a different normalized supersededBy id');
    }
  } else if (artifact.supersededBy !== undefined) {
    errors.push('supersededBy is allowed only when status is superseded');
  }

  const secretPath = findSecretLikeValue(artifact);
  if (secretPath) errors.push(`secret-shaped or credential-bearing value is forbidden at ${secretPath}`);
  return errors;
}

export function findSecretLikeValue(value, path = 'artifact') {
  if (typeof value === 'string') return SECRET_PATTERNS.some((pattern) => pattern.test(value)) ? path : '';
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      const found = findSecretLikeValue(entry, `${path}[${index}]`);
      if (found) return found;
    }
    return '';
  }
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      const found = findSecretLikeValue(entry, `${path}.${key}`);
      if (found) return found;
    }
  }
  return '';
}

export function loadLearningArtifacts({
  artifactDirectory = ARTIFACT_DIRECTORY,
  repositoryRoot = REPOSITORY_ROOT,
} = {}) {
  const records = [];
  const errors = [];
  const filenames = readdirSync(artifactDirectory)
    .filter((name) => name.endsWith('.yml'))
    .sort();
  for (const filename of filenames) {
    const path = resolve(artifactDirectory, filename);
    const stats = statSync(path);
    if (!stats.isFile() || stats.size > 32 * 1024) {
      errors.push(`${filename}: artifact must be a file no larger than 32 KiB`);
      continue;
    }
    const document = parseDocument(readFileSync(path, 'utf8'), { prettyErrors: false, uniqueKeys: true });
    if (document.errors.length > 0) {
      errors.push(...document.errors.map((error) => `${filename}: invalid YAML: ${error.message}`));
      continue;
    }
    const artifact = document.toJS({ maxAliasCount: 0 });
    errors.push(
      ...validateLearningArtifact(artifact, { filename, repositoryRoot }).map((error) => `${filename}: ${error}`),
    );
    records.push({ filename, path, artifact });
  }

  const ids = new Map();
  const fingerprints = new Map();
  for (const { filename, artifact } of records) {
    duplicateFinding(ids, artifact.id, filename, 'id', errors);
    duplicateFinding(fingerprints, artifact.fingerprint, filename, 'fingerprint', errors);
  }
  return { records, errors };
}

function validateScope(scope, errors) {
  if (!Array.isArray(scope) || scope.length === 0 || scope.length > 12) {
    errors.push('scope must contain 1 to 12 repository paths or globs');
    return;
  }
  const seen = new Set();
  for (const [index, value] of scope.entries()) {
    if (!safeRepositoryPattern(value) || String(value).length > 180) errors.push(`scope[${index}] is invalid`);
    if (seen.has(value)) errors.push(`scope contains duplicate value: ${value}`);
    seen.add(value);
  }
}

function validatePrevention(prevention, repositoryRoot, errors) {
  if (!Array.isArray(prevention) || prevention.length === 0 || prevention.length > 8) {
    errors.push('prevention must contain 1 to 8 durable paths');
    return;
  }
  const seen = new Set();
  for (const [index, item] of prevention.entries()) {
    if (!isRecord(item)) {
      errors.push(`prevention[${index}] must be an object`);
      continue;
    }
    rejectUnknownKeys(item, PREVENTION_KEYS, `prevention[${index}]`, errors);
    if (!PREVENTION_KINDS.has(item.kind)) errors.push(`prevention[${index}].kind is invalid`);
    if (!safeRepositoryPath(item.path)) {
      errors.push(`prevention[${index}].path is invalid`);
      continue;
    }
    if (seen.has(item.path)) errors.push(`prevention contains duplicate path: ${item.path}`);
    seen.add(item.path);
    const resolved = resolve(repositoryRoot, item.path);
    if (!within(repositoryRoot, resolved) || !existsSync(resolved) || !statSync(resolved).isFile()) {
      errors.push(`prevention path does not exist: ${item.path}`);
    }
  }
}

function boundedString(value, name, errors, { min, max }) {
  if (typeof value !== 'string' || value.trim() !== value || value.length < min || value.length > max) {
    errors.push(`${name} must be a trimmed string from ${min} to ${max} characters`);
  }
}

function rejectUnknownKeys(value, allowed, path, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${path} contains unknown field: ${key}`);
  }
}

function safeRepositoryPath(value) {
  return safeRepositoryPattern(value) && !String(value).includes('*');
}

function safeRepositoryPattern(value) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim() || value.includes('\\')) return false;
  if (value.startsWith('/') || value.startsWith('./') || /^[A-Za-z]:/.test(value)) return false;
  if ([...value].some((character) => character.codePointAt(0) <= 31 || character.codePointAt(0) === 127)) return false;
  return !value.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..');
}

function within(root, path) {
  const value = relative(root, path);
  return value !== '' && !value.startsWith('..') && !value.startsWith('/');
}

function duplicateFinding(map, value, filename, label, errors) {
  if (!value) return;
  if (map.has(value)) errors.push(`${filename}: duplicate ${label} also used by ${map.get(value)}`);
  else map.set(value, filename);
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = loadLearningArtifacts();
  if (result.errors.length > 0) {
    console.error(`Learning artifact validation failed:\n- ${result.errors.join('\n- ')}`);
    process.exit(1);
  }
  const counts = Object.fromEntries(
    [...STATUSES].map((status) => [status, result.records.filter(({ artifact }) => artifact.status === status).length]),
  );
  console.log(`Validated ${result.records.length} concise learning artifacts: ${JSON.stringify(counts)}.`);
}
