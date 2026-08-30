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
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EVIDENCE_SOURCE_RE = /^[a-z0-9]+(?:[._:/#-][a-z0-9]+)*$/;
const SEVERITIES = new Set(['low', 'medium', 'high', 'critical']);
const STATUSES = new Set(['active', 'verified', 'superseded']);
const PREVENTION_KINDS = new Set(['regression-test', 'deterministic-guard', 'skill', 'instruction', 'architecture']);
export const REUSABLE_CLAIM_RELATIONS = new Set(['supports', 'refutes', 'bounds', 'supersedes']);
export const REUSABLE_CLAIM_EVIDENCE_KINDS = new Set([
  'deterministic-reproduction',
  'protected-check',
  'runtime-observation',
  'authoritative-requirement',
  'specialist-review',
  'repeated-application',
  'code-precedent',
  'agent-assertion',
]);
const CHALLENGE_STATES = new Set(['none', 'open', 'resolved', 'accepted-exception']);
const CHALLENGE_SEVERITIES = new Set(['low', 'medium', 'high', 'blocking']);
const ENFORCEMENT_KINDS = new Set(['none', 'test', 'contract', 'policy', 'workflow', 'runtime-check']);
const ENFORCEMENT_REFERENCE_RULES = {
  test: {
    preventionKind: 'regression-test',
    pattern: /\.test\.(?:[cm]?js|ts)$/i,
    error: 'test enforcement must reference a test file',
  },
  contract: {
    preventionKind: 'deterministic-guard',
    pattern: /^contracts\/.+\.(?:json|ya?ml)$/i,
    error: 'contract enforcement must reference a versioned contract file',
  },
  policy: {
    preventionKind: 'deterministic-guard',
    pattern: /(?:^|\/)[^/]*(?:policy|guardrail)[^/]*\.(?:[cm]?js|ts|json|ya?ml)$/i,
    error: 'policy enforcement must reference a policy or guardrail file',
  },
  workflow: {
    preventionKind: 'deterministic-guard',
    pattern: /^\.github\/workflows\/.+\.ya?ml$/i,
    error: 'workflow enforcement must reference a GitHub Actions workflow',
  },
  'runtime-check': {
    preventionKind: 'deterministic-guard',
    pattern: /(?:^|\/)[^/]*(?:runtime|smoke|telemetry|health|observability)[^/]*\.(?:[cm]?js|ts|sh|ps1)$/i,
    error: 'runtime-check enforcement must reference a runtime, smoke, telemetry, health, or observability check',
  },
};
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
  'reusableClaim',
]);
const PREVENTION_KEYS = new Set(['kind', 'path']);
const REUSABLE_CLAIM_KEYS = new Set([
  'id',
  'claim',
  'scope',
  'relation',
  'evidence',
  'lineageId',
  'independenceBasis',
  'applicability',
  'exceptions',
  'challenge',
  'enforcement',
  'supersedes',
  'reviewAfter',
  'retired',
]);
const REUSABLE_CLAIM_REQUIRED_KEYS = [
  'id',
  'claim',
  'scope',
  'relation',
  'evidence',
  'lineageId',
  'independenceBasis',
  'applicability',
  'exceptions',
  'challenge',
  'enforcement',
  'supersedes',
];
const REUSABLE_SCOPE_KEYS = new Set(['paths', 'components', 'conditions']);
const EVIDENCE_KEYS = new Set(['kind', 'source', 'independence', 'derivedFrom']);
const EVIDENCE_INDEPENDENCE = new Set(['independent', 'shared-lineage']);
const EXCEPTION_KEYS = new Set(['scope', 'rationale']);
const CHALLENGE_KEYS = new Set(['state', 'severity', 'summary']);
const ENFORCEMENT_KEYS = new Set(['kind', 'reference']);
const RETIRED_KEYS = new Set(['reason']);
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
  if (artifact.reusableClaim !== undefined) {
    validateReusableClaim(artifact.reusableClaim, artifact, repositoryRoot, errors);
  }

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
  validateReusableClaimRepository(records, errors);
  return { records, errors };
}

function validateReusableClaim(claim, artifact, repositoryRoot, errors) {
  if (!isRecord(claim)) {
    errors.push('reusableClaim must be an object');
    return;
  }
  rejectUnknownKeys(claim, REUSABLE_CLAIM_KEYS, 'reusableClaim', errors);
  requireKeys(claim, REUSABLE_CLAIM_REQUIRED_KEYS, 'reusableClaim', errors);
  if (!ID_RE.test(String(claim.id || '')) || String(claim.id || '').length > 96) {
    errors.push('reusableClaim.id must be a normalized kebab-case identifier');
  }
  boundedString(claim.claim, 'reusableClaim.claim', errors, { min: 12, max: 600 });
  validateReusableScope(claim.scope, errors);
  if (!REUSABLE_CLAIM_RELATIONS.has(claim.relation)) errors.push('reusableClaim.relation is invalid');
  validateReusableEvidence(claim.evidence, errors);
  if (!FINGERPRINT_RE.test(String(claim.lineageId || '')) || String(claim.lineageId || '').length > 160) {
    errors.push('reusableClaim.lineageId must be a normalized evidence-lineage identifier');
  }
  boundedString(claim.independenceBasis, 'reusableClaim.independenceBasis', errors, { min: 12, max: 800 });
  boundedString(claim.applicability, 'reusableClaim.applicability', errors, { min: 12, max: 800 });
  validateReusableExceptions(claim.exceptions, errors);
  validateReusableChallenge(claim.challenge, claim.exceptions, errors);
  validateReusableEnforcement(claim.enforcement, artifact, repositoryRoot, errors);
  validateIdArray(claim.supersedes, 'reusableClaim.supersedes', claim.id, errors);
  if (claim.relation === 'supersedes' && Array.isArray(claim.supersedes) && claim.supersedes.length === 0) {
    errors.push('reusableClaim relation supersedes requires at least one superseded claim ID');
  }
  if (claim.relation !== 'supersedes' && Array.isArray(claim.supersedes) && claim.supersedes.length > 0) {
    errors.push('reusableClaim.supersedes is allowed only when relation is supersedes');
  }
  if (claim.reviewAfter !== undefined && !validDate(claim.reviewAfter)) {
    errors.push('reusableClaim.reviewAfter must be a valid YYYY-MM-DD date');
  }
  if (claim.retired !== undefined) validateRetiredClaim(claim.retired, artifact, errors);
}

function validateReusableScope(scope, errors) {
  if (!isRecord(scope)) {
    errors.push('reusableClaim.scope must be an object');
    return;
  }
  rejectUnknownKeys(scope, REUSABLE_SCOPE_KEYS, 'reusableClaim.scope', errors);
  requireKeys(scope, [...REUSABLE_SCOPE_KEYS], 'reusableClaim.scope', errors);
  validateStringArray(scope.paths, 'reusableClaim.scope.paths', errors, {
    maxItems: 12,
    maxLength: 180,
    validate: safeRepositoryPattern,
  });
  validateStringArray(scope.components, 'reusableClaim.scope.components', errors, { maxItems: 12, maxLength: 120 });
  validateStringArray(scope.conditions, 'reusableClaim.scope.conditions', errors, { maxItems: 12, maxLength: 240 });
  if (
    Array.isArray(scope.paths) &&
    Array.isArray(scope.components) &&
    Array.isArray(scope.conditions) &&
    scope.paths.length + scope.components.length + scope.conditions.length === 0
  ) {
    errors.push('reusableClaim.scope must contain at least one path, component, or condition');
  }
}

function validateReusableEvidence(evidence, errors) {
  if (!isRecord(evidence)) {
    errors.push('reusableClaim.evidence must be an object');
    return;
  }
  rejectUnknownKeys(evidence, EVIDENCE_KEYS, 'reusableClaim.evidence', errors);
  requireKeys(evidence, ['kind', 'source', 'independence'], 'reusableClaim.evidence', errors);
  if (!REUSABLE_CLAIM_EVIDENCE_KINDS.has(evidence.kind)) errors.push('reusableClaim.evidence.kind is invalid');
  if (!EVIDENCE_SOURCE_RE.test(String(evidence.source || '')) || String(evidence.source || '').length > 240) {
    errors.push('reusableClaim.evidence.source must be a normalized stable source locator');
  }
  if (!EVIDENCE_INDEPENDENCE.has(evidence.independence)) {
    errors.push('reusableClaim.evidence.independence is invalid');
  }
  if (evidence.independence === 'shared-lineage') {
    if (
      !EVIDENCE_SOURCE_RE.test(String(evidence.derivedFrom || '')) ||
      String(evidence.derivedFrom || '').length > 240
    ) {
      errors.push('shared-lineage reusableClaim evidence requires a normalized derivedFrom source');
    }
  } else if (evidence.derivedFrom !== undefined) {
    errors.push('independent reusableClaim evidence must not declare derivedFrom');
  }
}

function validateReusableExceptions(exceptions, errors) {
  if (!Array.isArray(exceptions) || exceptions.length > 8) {
    errors.push('reusableClaim.exceptions must be an array of at most 8 scoped exceptions');
    return;
  }
  for (const [index, exception] of exceptions.entries()) {
    const path = `reusableClaim.exceptions[${index}]`;
    if (!isRecord(exception)) {
      errors.push(`${path} must be an object`);
      continue;
    }
    rejectUnknownKeys(exception, EXCEPTION_KEYS, path, errors);
    requireKeys(exception, [...EXCEPTION_KEYS], path, errors);
    boundedString(exception.scope, `${path}.scope`, errors, { min: 3, max: 240 });
    boundedString(exception.rationale, `${path}.rationale`, errors, { min: 12, max: 600 });
  }
}

function validateReusableChallenge(challenge, exceptions, errors) {
  if (!isRecord(challenge)) {
    errors.push('reusableClaim.challenge must be an object');
    return;
  }
  rejectUnknownKeys(challenge, CHALLENGE_KEYS, 'reusableClaim.challenge', errors);
  requireKeys(challenge, ['state', 'severity'], 'reusableClaim.challenge', errors);
  if (!CHALLENGE_STATES.has(challenge.state)) errors.push('reusableClaim.challenge.state is invalid');
  if (!CHALLENGE_SEVERITIES.has(challenge.severity)) errors.push('reusableClaim.challenge.severity is invalid');
  if (challenge.state === 'none' && challenge.summary !== undefined) {
    errors.push('reusableClaim.challenge.summary is allowed only for a non-none challenge');
  }
  if (challenge.state !== undefined && challenge.state !== 'none') {
    boundedString(challenge.summary, 'reusableClaim.challenge.summary', errors, { min: 12, max: 600 });
  }
  if (challenge.state === 'accepted-exception' && (!Array.isArray(exceptions) || exceptions.length === 0)) {
    errors.push('accepted-exception challenge requires at least one reusableClaim exception');
  }
}

function validateReusableEnforcement(enforcement, artifact, repositoryRoot, errors) {
  if (!isRecord(enforcement)) {
    errors.push('reusableClaim.enforcement must be an object');
    return;
  }
  rejectUnknownKeys(enforcement, ENFORCEMENT_KEYS, 'reusableClaim.enforcement', errors);
  requireKeys(enforcement, ['kind'], 'reusableClaim.enforcement', errors);
  if (!ENFORCEMENT_KINDS.has(enforcement.kind)) errors.push('reusableClaim.enforcement.kind is invalid');
  if (enforcement.kind === 'none') {
    if (enforcement.reference !== undefined) {
      errors.push('reusableClaim.enforcement.reference is forbidden when kind is none');
    }
    return;
  }
  if (!safeRepositoryPath(enforcement.reference)) {
    errors.push('reusableClaim.enforcement.reference must be a repository-relative file path');
    return;
  }
  const resolved = resolve(repositoryRoot, enforcement.reference);
  if (!within(repositoryRoot, resolved) || !existsSync(resolved) || !statSync(resolved).isFile()) {
    errors.push(`reusableClaim enforcement reference does not exist: ${enforcement.reference}`);
  }
  const prevention = Array.isArray(artifact.prevention)
    ? artifact.prevention.find((item) => item?.path === enforcement.reference)
    : undefined;
  if (!prevention) {
    errors.push('reusableClaim.enforcement.reference must match an existing prevention path');
    return;
  }
  if (!['regression-test', 'deterministic-guard'].includes(prevention.kind)) {
    errors.push('reusableClaim enforcement must use an executable prevention path');
  }
  if (
    enforcement.reference.startsWith('docs/') ||
    enforcement.reference.startsWith('.agents/') ||
    /\.md$/i.test(enforcement.reference)
  ) {
    errors.push('reusableClaim enforcement cannot reference prose or a skill');
  }
  const referenceRule = ENFORCEMENT_REFERENCE_RULES[enforcement.kind];
  if (referenceRule && prevention.kind !== referenceRule.preventionKind) {
    errors.push(`${enforcement.kind} enforcement requires a ${referenceRule.preventionKind} prevention entry`);
  }
  if (referenceRule && !referenceRule.pattern.test(enforcement.reference)) {
    errors.push(referenceRule.error);
  }
}

function validateRetiredClaim(retired, artifact, errors) {
  if (!isRecord(retired)) {
    errors.push('reusableClaim.retired must be an object');
    return;
  }
  rejectUnknownKeys(retired, RETIRED_KEYS, 'reusableClaim.retired', errors);
  requireKeys(retired, ['reason'], 'reusableClaim.retired', errors);
  boundedString(retired.reason, 'reusableClaim.retired.reason', errors, { min: 12, max: 600 });
  if (artifact.status === 'superseded') errors.push('a reusable claim cannot be both retired and superseded');
}

function validateReusableClaimRepository(records, errors) {
  const sourceLineages = new Map();
  const claimDefinitions = new Map();
  const claims = new Set();
  const supersessionEdges = new Map();
  for (const { filename, artifact } of records) {
    const claim = artifact?.reusableClaim;
    if (!isRecord(claim)) continue;
    claims.add(claim.id);
    if (claim.relation === 'supersedes' && Array.isArray(claim.supersedes)) {
      const targets = supersessionEdges.get(claim.id) ?? new Set();
      for (const target of claim.supersedes) targets.add(target);
      supersessionEdges.set(claim.id, targets);
    }
    const sources = [claim.evidence?.source, claim.evidence?.derivedFrom].filter(
      (source) => typeof source === 'string',
    );
    if (typeof claim.lineageId === 'string') {
      for (const source of sources) {
        const previous = sourceLineages.get(source);
        if (previous && previous.lineageId !== claim.lineageId) {
          errors.push(
            `${filename}: reusableClaim evidence source ${source} is assigned to lineage ${claim.lineageId} but ${previous.filename} assigns it to ${previous.lineageId}`,
          );
        } else if (!previous) {
          sourceLineages.set(source, { lineageId: claim.lineageId, filename });
        }
      }
    }
    if (typeof claim.id === 'string') {
      const signature = canonicalClaimSignature(claim);
      const previous = claimDefinitions.get(claim.id);
      if (previous && previous.signature !== signature) {
        errors.push(`${filename}: reusableClaim ${claim.id} conflicts with its definition in ${previous.filename}`);
      } else if (!previous) {
        claimDefinitions.set(claim.id, { signature, filename });
      }
    }
  }
  for (const { filename, artifact } of records) {
    const claim = artifact?.reusableClaim;
    if (!isRecord(claim) || !Array.isArray(claim.supersedes)) continue;
    for (const superseded of claim.supersedes) {
      if (typeof superseded === 'string' && !claims.has(superseded)) {
        errors.push(`${filename}: reusableClaim.supersedes references unknown claim ${superseded}`);
      }
    }
  }
  validateSupersessionCycles(supersessionEdges, errors);
}

function validateSupersessionCycles(edges, errors) {
  const visited = new Set();
  const visiting = new Set();
  const path = [];
  const reported = new Set();
  const visit = (claimId) => {
    if (visiting.has(claimId)) {
      const start = path.indexOf(claimId);
      const cycle = [...path.slice(start), claimId];
      const signature = [...new Set(cycle)].sort().join('|');
      if (!reported.has(signature)) {
        errors.push(`reusableClaim supersession cycle is forbidden: ${cycle.join(' -> ')}`);
        reported.add(signature);
      }
      return;
    }
    if (visited.has(claimId)) return;
    visiting.add(claimId);
    path.push(claimId);
    for (const target of edges.get(claimId) ?? []) visit(target);
    path.pop();
    visiting.delete(claimId);
    visited.add(claimId);
  };
  for (const claimId of edges.keys()) visit(claimId);
}

function canonicalClaimSignature(claim) {
  return JSON.stringify({
    claim: claim.claim,
    scope: claim.scope,
    applicability: claim.applicability,
  });
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

function validateStringArray(values, name, errors, { maxItems, maxLength, validate } = {}) {
  if (!Array.isArray(values) || values.length > maxItems) {
    errors.push(`${name} must be an array of at most ${maxItems} values`);
    return;
  }
  const seen = new Set();
  for (const [index, value] of values.entries()) {
    if (
      typeof value !== 'string' ||
      value.trim() !== value ||
      value.length === 0 ||
      value.length > maxLength ||
      (validate && !validate(value))
    ) {
      errors.push(`${name}[${index}] is invalid`);
    }
    if (seen.has(value)) errors.push(`${name} contains duplicate value: ${value}`);
    seen.add(value);
  }
}

function validateIdArray(values, name, ownId, errors) {
  if (!Array.isArray(values) || values.length > 8) {
    errors.push(`${name} must be an array of at most 8 claim IDs`);
    return;
  }
  const seen = new Set();
  for (const [index, value] of values.entries()) {
    if (!ID_RE.test(String(value || '')) || String(value || '').length > 96 || value === ownId) {
      errors.push(`${name}[${index}] must be a different normalized claim ID`);
    }
    if (seen.has(value)) errors.push(`${name} contains duplicate value: ${value}`);
    seen.add(value);
  }
}

function validDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function requireKeys(value, required, path, errors) {
  for (const key of required) {
    if (!Object.hasOwn(value, key)) errors.push(`${path} requires field: ${key}`);
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
