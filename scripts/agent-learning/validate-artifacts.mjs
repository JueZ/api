import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

export const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const DEFAULT_ARTIFACTS_DIRECTORY = resolve(REPOSITORY_ROOT, 'docs/agent-learning/artifacts');

export const SOURCE_TYPES = Object.freeze([
  'repair_issue',
  'production_incident',
  'deployment_incident',
  'autonomous_review',
  'user_correction',
  'task_eval_failure',
  'repeated_repair',
  'repository_audit',
]);
export const DISPOSITIONS = Object.freeze([
  'regression-test',
  'agent-task-eval',
  'skill-update',
  'instruction-update',
  'architecture-documentation',
  'project-memory-correction',
  'external-transient',
  'no-durable-artifact',
]);
export const ARTIFACT_STATES = Object.freeze(['candidate', 'implemented', 'verified', 'waived', 'superseded']);

const SEVERITIES = new Set(['low', 'medium', 'high', 'critical']);
const SOURCE_REFERENCE_KINDS = new Set([
  'pull_request',
  'issue',
  'commit',
  'workflow_run',
  'deployment',
  'user_correction',
  'task_eval',
  'audit',
]);
const ARTIFACT_KINDS = new Set([
  'regression-test',
  'agent-task-eval',
  'skill',
  'instruction',
  'architecture-documentation',
  'project-memory',
  'implementation',
  'policy',
  'workflow',
]);
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FINGERPRINT_PATTERN = /^[a-z0-9]+(?:[._:-][a-z0-9]+)*$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SECRET_PATTERNS = Object.freeze([
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
  /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}\b/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/,
  /\b(?:AccountKey|SharedAccessSignature|client_secret|connection_string)\s*[:=]\s*\S+/i,
  /\b(?:GH_TOKEN|GITHUB_TOKEN|OPENAI_API_KEY|AZURE_CLIENT_SECRET|AZURE_TENANT_ID|AZURE_CLIENT_ID)=\S+/,
  /https?:\/\/\S+\?(?:\S*&)?(?:sig|se|sp)=\S+/i,
]);

const TOP_LEVEL_KEYS = new Set([
  'version',
  'id',
  'title',
  'fingerprint',
  'source',
  'classification',
  'disposition',
  'artifacts',
  'counterfactual',
  'status',
  'supersedes',
  'supersededBy',
  'exception',
]);
const REQUIRED_TOP_LEVEL_KEYS = [
  'version',
  'id',
  'title',
  'fingerprint',
  'source',
  'classification',
  'disposition',
  'artifacts',
  'counterfactual',
  'status',
];

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() === value && value.length > 0;
}

function addError(errors, path, message) {
  errors.push(`${path}: ${message}`);
}

function requireRecord(value, path, errors) {
  if (!isRecord(value)) {
    addError(errors, path, 'must be an object');
    return false;
  }
  return true;
}

function requireKeys(value, required, path, errors) {
  for (const key of required) {
    if (!Object.hasOwn(value, key)) addError(errors, `${path}.${key}`, 'is required');
  }
}

function rejectUnknownKeys(value, allowed, path, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) addError(errors, `${path}.${key}`, 'is not an allowed field');
  }
}

function validateString(value, path, errors, { maxLength = 2_000 } = {}) {
  if (!isNonEmptyString(value)) {
    addError(errors, path, 'must be a non-empty, trimmed string');
    return false;
  }
  if (value.length > maxLength) addError(errors, path, `must not exceed ${maxLength} characters`);
  return true;
}

function validateSafeScalar(value, path, errors) {
  if (typeof value !== 'string') return;
  if (SECRET_PATTERNS.some((pattern) => pattern.test(value))) {
    addError(errors, path, 'contains a secret-shaped value, credential, or provider URL');
  }
  const environmentAssignments = value.match(/(?:^|\n)[A-Z][A-Z0-9_]{2,}=\S+/g) ?? [];
  if (environmentAssignments.length > 1) addError(errors, path, 'contains a raw environment dump');
}

function inspectSafeScalars(value, path, errors) {
  if (typeof value === 'string') {
    validateSafeScalar(value, path, errors);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => inspectSafeScalars(entry, `${path}[${index}]`, errors));
    return;
  }
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) inspectSafeScalars(entry, `${path}.${key}`, errors);
  }
}

function validatePublicUrl(value, path, errors) {
  if (!validateString(value, path, errors, { maxLength: 500 })) return;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      addError(errors, path, 'must be a public-safe HTTPS URL without credentials, query parameters, or fragments');
    }
  } catch {
    addError(errors, path, 'must be a valid URL');
  }
}

function validateSource(source, path, errors) {
  if (!requireRecord(source, path, errors)) return;
  rejectUnknownKeys(source, new Set(['type', 'references']), path, errors);
  requireKeys(source, ['type', 'references'], path, errors);
  if (!SOURCE_TYPES.includes(source.type)) addError(errors, `${path}.type`, 'is not a supported source type');
  if (!Array.isArray(source.references) || source.references.length === 0) {
    addError(errors, `${path}.references`, 'must be a non-empty array');
    return;
  }
  source.references.forEach((reference, index) => {
    const referencePath = `${path}.references[${index}]`;
    if (!requireRecord(reference, referencePath, errors)) return;
    rejectUnknownKeys(reference, new Set(['kind', 'locator', 'url']), referencePath, errors);
    requireKeys(reference, ['kind', 'locator'], referencePath, errors);
    if (!SOURCE_REFERENCE_KINDS.has(reference.kind)) {
      addError(errors, `${referencePath}.kind`, 'is not a supported reference kind');
    }
    validateString(reference.locator, `${referencePath}.locator`, errors, { maxLength: 300 });
    if (Object.hasOwn(reference, 'url')) validatePublicUrl(reference.url, `${referencePath}.url`, errors);
  });
}

function validateClassification(classification, path, errors) {
  if (!requireRecord(classification, path, errors)) return;
  rejectUnknownKeys(classification, new Set(['failureArea', 'severity', 'symptom', 'rootCause']), path, errors);
  requireKeys(classification, ['failureArea', 'severity', 'symptom', 'rootCause'], path, errors);
  if (!isNonEmptyString(classification.failureArea) || !ID_PATTERN.test(classification.failureArea)) {
    addError(errors, `${path}.failureArea`, 'must be a normalized kebab-case identifier');
  }
  if (!SEVERITIES.has(classification.severity)) addError(errors, `${path}.severity`, 'is not supported');
  validateString(classification.symptom, `${path}.symptom`, errors);
  validateString(classification.rootCause, `${path}.rootCause`, errors);
}

function validateDisposition(disposition, path, errors) {
  if (!requireRecord(disposition, path, errors)) return;
  rejectUnknownKeys(disposition, new Set(['primary', 'rationale']), path, errors);
  requireKeys(disposition, ['primary', 'rationale'], path, errors);
  if (!DISPOSITIONS.includes(disposition.primary)) addError(errors, `${path}.primary`, 'is not supported');
  validateString(disposition.rationale, `${path}.rationale`, errors);
}

function isPathInside(root, candidate) {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === '' || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..' && !isAbsolute(pathFromRoot))
  );
}

function validateRepositoryPath(value, path, errors, repositoryRoot) {
  if (!validateString(value, path, errors, { maxLength: 500 })) return;
  if (
    isAbsolute(value) ||
    value.includes('\\') ||
    value.includes('\0') ||
    value.split('/').includes('..') ||
    posix.normalize(value) !== value ||
    value === '.'
  ) {
    addError(errors, path, 'must be a normalized repository-relative path without traversal');
    return;
  }
  const resolvedPath = resolve(repositoryRoot, value);
  if (!isPathInside(repositoryRoot, resolvedPath)) {
    addError(errors, path, 'resolves outside the repository');
    return;
  }
  try {
    const realPath = realpathSync(resolvedPath);
    if (!isPathInside(realpathSync(repositoryRoot), realPath)) {
      addError(errors, path, 'resolves through a symlink outside the repository');
      return;
    }
    if (!lstatSync(realPath).isFile()) addError(errors, path, 'must reference an existing file');
  } catch {
    addError(errors, path, 'must reference an existing file');
  }
}

function validateArtifacts(artifacts, path, errors, repositoryRoot, status, primaryDisposition) {
  if (!Array.isArray(artifacts)) {
    addError(errors, path, 'must be an array');
    return;
  }
  const mayBeEmpty =
    status === 'candidate' ||
    status === 'waived' ||
    primaryDisposition === 'external-transient' ||
    primaryDisposition === 'no-durable-artifact';
  if (artifacts.length === 0 && !mayBeEmpty) addError(errors, path, 'must contain at least one durable artifact');
  const seenPaths = new Set();
  artifacts.forEach((artifact, index) => {
    const artifactPath = `${path}[${index}]`;
    if (!requireRecord(artifact, artifactPath, errors)) return;
    rejectUnknownKeys(artifact, new Set(['path', 'kind']), artifactPath, errors);
    requireKeys(artifact, ['path', 'kind'], artifactPath, errors);
    if (!ARTIFACT_KINDS.has(artifact.kind)) addError(errors, `${artifactPath}.kind`, 'is not supported');
    validateRepositoryPath(artifact.path, `${artifactPath}.path`, errors, repositoryRoot);
    if (seenPaths.has(artifact.path)) addError(errors, `${artifactPath}.path`, 'is duplicated in this artifact');
    seenPaths.add(artifact.path);
  });
}

function validateCommitResult(value, path, errors) {
  if (!requireRecord(value, path, errors)) return;
  rejectUnknownKeys(value, new Set(['commit', 'expectedResult']), path, errors);
  requireKeys(value, ['commit', 'expectedResult'], path, errors);
  if (!SHA_PATTERN.test(value.commit ?? ''))
    addError(errors, `${path}.commit`, 'must be an exact 40-character lowercase SHA');
  validateString(value.expectedResult, `${path}.expectedResult`, errors);
}

function validateVerification(value, path, errors) {
  if (!requireRecord(value, path, errors)) return;
  rejectUnknownKeys(value, new Set(['commands', 'trustedScorers']), path, errors);
  const commands = value.commands;
  const scorers = value.trustedScorers;
  if (commands !== undefined) {
    if (!Array.isArray(commands) || commands.length === 0) {
      addError(errors, `${path}.commands`, 'must be a non-empty array when present');
    } else {
      commands.forEach((command, index) => {
        if (
          validateString(command, `${path}.commands[${index}]`, errors, { maxLength: 500 }) &&
          /[\r\n\0]/.test(command)
        ) {
          addError(errors, `${path}.commands[${index}]`, 'must be a single command line');
        }
      });
    }
  }
  if (scorers !== undefined) {
    if (!Array.isArray(scorers) || scorers.length === 0) {
      addError(errors, `${path}.trustedScorers`, 'must be a non-empty array when present');
    } else {
      scorers.forEach((scorer, index) => {
        if (!isNonEmptyString(scorer) || !FINGERPRINT_PATTERN.test(scorer)) {
          addError(errors, `${path}.trustedScorers[${index}]`, 'must be a normalized trusted scorer ID');
        }
      });
    }
  }
  if ((!Array.isArray(commands) || commands.length === 0) && (!Array.isArray(scorers) || scorers.length === 0)) {
    addError(errors, path, 'must contain at least one verification command or trusted scorer');
  }
}

function validateImplementationPr(value, path, errors) {
  if (!requireRecord(value, path, errors)) return;
  rejectUnknownKeys(value, new Set(['repository', 'number', 'url']), path, errors);
  requireKeys(value, ['repository', 'number', 'url'], path, errors);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.repository ?? '')) {
    addError(errors, `${path}.repository`, 'must be an owner/repository identifier');
  }
  if (!Number.isInteger(value.number) || value.number < 1)
    addError(errors, `${path}.number`, 'must be a positive integer');
  validatePublicUrl(value.url, `${path}.url`, errors);
  if (typeof value.url === 'string' && Number.isInteger(value.number)) {
    try {
      const url = new URL(value.url);
      if (url.hostname !== 'github.com' || url.pathname !== `/${value.repository}/pull/${value.number}`) {
        addError(errors, `${path}.url`, 'must identify the declared GitHub implementation pull request');
      }
    } catch {
      // validatePublicUrl reports the malformed URL.
    }
  }
}

function validateCounterfactual(counterfactual, path, errors, status) {
  if (!requireRecord(counterfactual, path, errors)) return;
  rejectUnknownKeys(
    counterfactual,
    new Set(['hypothesis', 'broken', 'fixed', 'verification', 'implementationPr']),
    path,
    errors,
  );
  requireKeys(counterfactual, ['hypothesis'], path, errors);
  validateString(counterfactual.hypothesis, `${path}.hypothesis`, errors);
  if (Object.hasOwn(counterfactual, 'broken')) validateCommitResult(counterfactual.broken, `${path}.broken`, errors);
  if (Object.hasOwn(counterfactual, 'fixed')) validateCommitResult(counterfactual.fixed, `${path}.fixed`, errors);
  if (Object.hasOwn(counterfactual, 'verification')) {
    validateVerification(counterfactual.verification, `${path}.verification`, errors);
  }
  if (Object.hasOwn(counterfactual, 'implementationPr')) {
    validateImplementationPr(counterfactual.implementationPr, `${path}.implementationPr`, errors);
  }
  if (status === 'verified') {
    for (const field of ['broken', 'fixed', 'verification', 'implementationPr']) {
      if (!Object.hasOwn(counterfactual, field))
        addError(errors, `${path}.${field}`, 'is required for verified status');
    }
  }
  if (
    typeof counterfactual.broken?.commit === 'string' &&
    counterfactual.broken.commit === counterfactual.fixed?.commit
  ) {
    addError(errors, path, 'broken and fixed commits must be different');
  }
}

function validateDate(value, path, errors, asOfDate) {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    !DATE_PATTERN.test(value ?? '') ||
    Number.isNaN(parsed.valueOf()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    addError(errors, path, 'must be a valid YYYY-MM-DD date');
    return;
  }
  if (value < asOfDate) addError(errors, path, `is stale relative to ${asOfDate}`);
}

function validateException(exception, path, errors, asOfDate) {
  if (!requireRecord(exception, path, errors)) return;
  rejectUnknownKeys(
    exception,
    new Set(['rationale', 'owner', 'reviewDate', 'expiry', 'recurrenceFingerprint']),
    path,
    errors,
  );
  requireKeys(exception, ['rationale', 'owner', 'recurrenceFingerprint'], path, errors);
  validateString(exception.rationale, `${path}.rationale`, errors);
  validateString(exception.owner, `${path}.owner`, errors, { maxLength: 200 });
  if (
    !isNonEmptyString(exception.recurrenceFingerprint) ||
    !FINGERPRINT_PATTERN.test(exception.recurrenceFingerprint)
  ) {
    addError(errors, `${path}.recurrenceFingerprint`, 'must be a normalized recurrence fingerprint');
  }
  const hasReviewDate = Object.hasOwn(exception, 'reviewDate');
  const hasExpiry = Object.hasOwn(exception, 'expiry');
  if (hasReviewDate === hasExpiry) addError(errors, path, 'must contain exactly one of reviewDate or expiry');
  if (hasReviewDate) validateDate(exception.reviewDate, `${path}.reviewDate`, errors, asOfDate);
  if (hasExpiry) validateDate(exception.expiry, `${path}.expiry`, errors, asOfDate);
}

export function validateArtifact(artifact, options) {
  const { repositoryRoot, fileName, asOfDate } = options;
  const errors = [];
  const rootPath = fileName;
  if (!requireRecord(artifact, rootPath, errors)) return errors;
  rejectUnknownKeys(artifact, TOP_LEVEL_KEYS, rootPath, errors);
  requireKeys(artifact, REQUIRED_TOP_LEVEL_KEYS, rootPath, errors);
  if (artifact.version !== 1) addError(errors, `${rootPath}.version`, 'must equal 1');
  if (!isNonEmptyString(artifact.id) || !ID_PATTERN.test(artifact.id)) {
    addError(errors, `${rootPath}.id`, 'must be a normalized kebab-case ID');
  } else if (fileName !== `${artifact.id}.yml`) {
    addError(errors, `${rootPath}.id`, `must match file name ${fileName}`);
  }
  validateString(artifact.title, `${rootPath}.title`, errors, { maxLength: 200 });
  if (!isNonEmptyString(artifact.fingerprint) || !FINGERPRINT_PATTERN.test(artifact.fingerprint)) {
    addError(errors, `${rootPath}.fingerprint`, 'must be a normalized, non-empty recurrence fingerprint');
  }
  if (!ARTIFACT_STATES.includes(artifact.status)) addError(errors, `${rootPath}.status`, 'is not supported');
  validateSource(artifact.source, `${rootPath}.source`, errors);
  validateClassification(artifact.classification, `${rootPath}.classification`, errors);
  validateDisposition(artifact.disposition, `${rootPath}.disposition`, errors);
  validateArtifacts(
    artifact.artifacts,
    `${rootPath}.artifacts`,
    errors,
    repositoryRoot,
    artifact.status,
    artifact.disposition?.primary,
  );
  validateCounterfactual(artifact.counterfactual, `${rootPath}.counterfactual`, errors, artifact.status);

  const needsException =
    artifact.status === 'waived' ||
    artifact.disposition?.primary === 'external-transient' ||
    artifact.disposition?.primary === 'no-durable-artifact';
  if (needsException && !Object.hasOwn(artifact, 'exception')) {
    addError(
      errors,
      `${rootPath}.exception`,
      'is required for waived, external-transient, and no-durable-artifact records',
    );
  }
  if (Object.hasOwn(artifact, 'exception')) {
    validateException(artifact.exception, `${rootPath}.exception`, errors, asOfDate);
    if (artifact.exception?.recurrenceFingerprint !== artifact.fingerprint) {
      addError(errors, `${rootPath}.exception.recurrenceFingerprint`, 'must match the artifact fingerprint');
    }
    if (!needsException) {
      addError(
        errors,
        `${rootPath}.exception`,
        'is only allowed for waived, external-transient, or no-durable-artifact records',
      );
    }
  }
  if (artifact.status === 'verified' && needsException) {
    addError(errors, `${rootPath}.status`, 'verified cannot be used for a waiver or non-proof disposition');
  }
  if (artifact.status === 'superseded') {
    if (!isNonEmptyString(artifact.supersededBy) || !ID_PATTERN.test(artifact.supersededBy)) {
      addError(errors, `${rootPath}.supersededBy`, 'is required for superseded status');
    }
  } else if (Object.hasOwn(artifact, 'supersededBy')) {
    addError(errors, `${rootPath}.supersededBy`, 'is only allowed for superseded status');
  }
  if (Object.hasOwn(artifact, 'supersedes')) {
    if (!Array.isArray(artifact.supersedes) || artifact.supersedes.length === 0) {
      addError(errors, `${rootPath}.supersedes`, 'must be a non-empty ID array when present');
    } else {
      const seen = new Set();
      artifact.supersedes.forEach((id, index) => {
        if (!isNonEmptyString(id) || !ID_PATTERN.test(id)) {
          addError(errors, `${rootPath}.supersedes[${index}]`, 'must be a normalized artifact ID');
        }
        if (seen.has(id)) addError(errors, `${rootPath}.supersedes[${index}]`, 'is duplicated');
        seen.add(id);
      });
    }
  }
  inspectSafeScalars(artifact, rootPath, errors);
  return errors;
}

export function validateArtifactRepository(options = {}) {
  const repositoryRoot = realpathSync(resolve(options.repositoryRoot ?? REPOSITORY_ROOT));
  const artifactsDirectory = resolve(
    options.artifactsDirectory ?? resolve(repositoryRoot, 'docs/agent-learning/artifacts'),
  );
  const asOfDate = options.asOfDate ?? new Date().toISOString().slice(0, 10);
  const errors = [];
  const artifacts = [];
  const entries = readdirSync(artifactsDirectory, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  for (const entry of entries) {
    const fileName = entry.name;
    if (!entry.isFile() || !fileName.endsWith('.yml')) {
      addError(errors, fileName, 'artifact directory may contain only .yml files');
      continue;
    }
    const filePath = resolve(artifactsDirectory, fileName);
    let artifact;
    try {
      const document = parseDocument(readFileSync(filePath, 'utf8'), {
        prettyErrors: true,
        strict: true,
        uniqueKeys: true,
      });
      if (document.errors.length > 0) {
        for (const error of document.errors) addError(errors, fileName, `invalid YAML: ${error.message}`);
        continue;
      }
      artifact = document.toJS({ maxAliasCount: 0 });
    } catch (error) {
      addError(errors, fileName, `could not be parsed: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    errors.push(...validateArtifact(artifact, { repositoryRoot, fileName, asOfDate }));
    artifacts.push({ fileName, filePath, artifact });
  }

  const byId = new Map();
  const activeByFingerprint = new Map();
  for (const entry of artifacts) {
    const id = entry.artifact?.id;
    if (typeof id !== 'string') continue;
    if (byId.has(id)) addError(errors, entry.fileName, `duplicates artifact ID ${id} from ${byId.get(id).fileName}`);
    else byId.set(id, entry);
    const fingerprint = entry.artifact?.fingerprint;
    if (typeof fingerprint === 'string' && entry.artifact?.status !== 'superseded') {
      if (activeByFingerprint.has(fingerprint)) {
        addError(
          errors,
          entry.fileName,
          `duplicates active fingerprint ${fingerprint} from ${activeByFingerprint.get(fingerprint).fileName}`,
        );
      } else {
        activeByFingerprint.set(fingerprint, entry);
      }
    }
  }
  for (const entry of artifacts) {
    const artifact = entry.artifact;
    for (const supersededId of artifact?.supersedes ?? []) {
      const superseded = byId.get(supersededId);
      if (!superseded) addError(errors, `${entry.fileName}.supersedes`, `references unknown artifact ${supersededId}`);
      if (supersededId === artifact.id) addError(errors, `${entry.fileName}.supersedes`, 'must not reference itself');
      if (superseded && superseded.artifact.status !== 'superseded') {
        addError(errors, `${entry.fileName}.supersedes`, `${supersededId} must have superseded status`);
      }
      if (superseded && superseded.artifact.supersededBy !== artifact.id) {
        addError(errors, `${entry.fileName}.supersedes`, `${supersededId} must point back through supersededBy`);
      }
      if (superseded && superseded.artifact.fingerprint !== artifact.fingerprint) {
        addError(errors, `${entry.fileName}.supersedes`, `${supersededId} must use the same recurrence fingerprint`);
      }
    }
    if (artifact?.supersededBy) {
      const replacement = byId.get(artifact.supersededBy);
      if (!replacement) {
        addError(errors, `${entry.fileName}.supersededBy`, `references unknown artifact ${artifact.supersededBy}`);
      }
      if (artifact.supersededBy === artifact.id)
        addError(errors, `${entry.fileName}.supersededBy`, 'must not reference itself');
      if (replacement && !replacement.artifact.supersedes?.includes(artifact.id)) {
        addError(
          errors,
          `${entry.fileName}.supersededBy`,
          `${artifact.supersededBy} must point back through supersedes`,
        );
      }
      if (replacement && replacement.artifact.fingerprint !== artifact.fingerprint) {
        addError(
          errors,
          `${entry.fileName}.supersededBy`,
          `${artifact.supersededBy} must use the same recurrence fingerprint`,
        );
      }
    }
  }

  return { repositoryRoot, artifactsDirectory, artifacts, errors };
}

export function artifactStatusCounts(artifacts) {
  return Object.fromEntries(
    ARTIFACT_STATES.map((status) => [status, artifacts.filter(({ artifact }) => artifact.status === status).length]),
  );
}

function runCli() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--status')) {
    throw new Error(`Unsupported arguments: ${args.filter((arg) => arg !== '--status').join(' ')}`);
  }
  const result = validateArtifactRepository();
  if (result.errors.length > 0) {
    console.error(`Learning artifact validation failed:\n- ${result.errors.join('\n- ')}`);
    process.exitCode = 1;
    return;
  }
  if (args.includes('--status')) {
    const counts = artifactStatusCounts(result.artifacts);
    console.log(`Learning artifacts: ${result.artifacts.length}`);
    for (const status of ARTIFACT_STATES) console.log(`${status}: ${counts[status]}`);
    return;
  }
  console.log(`Validated ${result.artifacts.length} learning artifacts.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
