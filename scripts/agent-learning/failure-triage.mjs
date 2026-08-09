const FINGERPRINT_RE = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const OWNER_RE = /^@?[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const TRUSTED_AUTOMATION_LOGINS = new Set(['github-actions', 'github-actions[bot]']);
const DISPOSITION_TYPES = new Set(['external-transient', 'no-durable-artifact']);
const SOURCE_TYPES = new Set([
  'repair_issue',
  'production_incident',
  'deployment_incident',
  'autonomous_review',
  'user_correction',
  'task_eval_failure',
  'repeated_repair',
  'repository_audit',
]);

const CLASSIFICATION_FINGERPRINTS = Object.freeze({
  production_failure: 'repair.production-failure',
  deployment_failure: 'repair.deployment-failure',
  pr_check_failure: 'repair.pr-check-failure',
  unknown_codex_repair: 'repair.unknown-codex-repair',
});

export const LEARNING_LABELS = Object.freeze([
  Object.freeze({
    name: 'agent-learning',
    color: '1D76DB',
    description: 'Closed-loop agent-learning candidate or implementation.',
  }),
  Object.freeze({
    name: 'learning-required',
    color: 'B60205',
    description: 'A durable learning disposition is required.',
  }),
  Object.freeze({
    name: 'learning-regression',
    color: 'D93F0B',
    description: 'Executable regression prevention is recommended.',
  }),
  Object.freeze({
    name: 'learning-task-eval',
    color: '5319E7',
    description: 'Candidate disposition is an agent-task evaluation.',
  }),
  Object.freeze({
    name: 'learning-skill',
    color: '0E8A16',
    description: 'Candidate disposition is a repository skill update.',
  }),
  Object.freeze({
    name: 'learning-waived',
    color: 'FBCA04',
    description: 'Owned and dated no-artifact or transient disposition.',
  }),
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function positiveInteger(value) {
  return Number.isInteger(Number(value)) && Number(value) > 0;
}

function unique(values) {
  return [...new Set(values)];
}

function normalizedDate(value) {
  if (!DATE_RE.test(String(value || ''))) return '';
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? '' : value;
}

export function containsSecretShapedValue(value) {
  const text = String(value || '');
  return [
    /\b(?:sk|ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_-]{12,}\b/i,
    /\bgithub_pat_[A-Za-z0-9_]{12,}\b/i,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
    /\bAuthorization\s*:/i,
    /\b(?:AccountKey|SharedAccessSignature|ClientSecret|ConnectionString)\s*=/i,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
    /https?:\/\/\S+[?&](?:sig|token|key|secret)=[^\s&]+/i,
  ].some((pattern) => pattern.test(text));
}

export function normalizeFingerprint(value) {
  const fingerprint = String(value || '')
    .trim()
    .toLowerCase();
  return FINGERPRINT_RE.test(fingerprint) && fingerprint.length <= 160 ? fingerprint : '';
}

export function requiresLearningDisposition(failure = {}) {
  const labels = new Set(
    (failure.labels || [])
      .map((label) => (typeof label === 'string' ? label : label?.name))
      .filter(Boolean)
      .map((label) => label.toLowerCase()),
  );
  const reasons = [];
  if (failure.sourceType === 'repair_issue' || labels.has('codex-repair')) reasons.push('codex-repair');
  if (['production_failure', 'deployment_failure'].includes(failure.classification))
    reasons.push(failure.classification);
  if (['high', 'critical'].includes(String(failure.reviewSeverity || '').toLowerCase()))
    reasons.push('high-critical-autonomous-review');
  if (Number(failure.repairAttemptCount || 0) >= 2) reasons.push('repeated-repair');
  if (failure.userCorrection === true) reasons.push('explicit-user-correction');
  if (Number(failure.taskEvalFailureCount || 0) >= 2) reasons.push('repeated-agent-task-eval');
  return { required: reasons.length > 0, reasons: unique(reasons) };
}

export function createFailureFingerprint(failure = {}) {
  const explicit = normalizeFingerprint(failure.recurrenceFingerprint);
  if (failure.recurrenceFingerprint !== undefined) {
    if (!explicit) throw new Error('recurrenceFingerprint must already be normalized');
    return explicit;
  }
  if (CLASSIFICATION_FINGERPRINTS[failure.classification]) {
    return CLASSIFICATION_FINGERPRINTS[failure.classification];
  }
  const area = normalizeFingerprint(failure.areaId);
  const sourceType = String(failure.sourceType || 'repository_audit');
  if (sourceType === 'autonomous_review') return area ? `autonomous-review.${area}` : 'autonomous-review.finding';
  if (sourceType === 'user_correction') return area ? `agent.user-correction.${area}` : 'agent.user-correction';
  if (sourceType === 'task_eval_failure') return area ? `agent-task.${area}` : 'agent-task.repeated-failure';
  if (sourceType === 'repeated_repair') return area ? `repair.repeated.${area}` : 'repair.repeated-failure';
  if (sourceType === 'production_incident') return area ? `production.${area}` : 'production.incident';
  if (sourceType === 'deployment_incident') return area ? `deployment.${area}` : 'deployment.incident';
  return area ? `repository-audit.${area}` : 'repository-audit.failure';
}

export function learningCandidateMarker(fingerprint) {
  const normalized = normalizeFingerprint(fingerprint);
  if (!normalized) throw new Error('A normalized learning fingerprint is required.');
  return `<!-- agent-learning-candidate:v1:${normalized} -->`;
}

export function learningSourceMarker(sourceType, identifier) {
  if (!SOURCE_TYPES.has(sourceType)) throw new Error(`Unsupported learning source type: ${sourceType}`);
  const normalizedIdentifier = String(identifier || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(normalizedIdentifier)) {
    throw new Error('A stable learning source identifier is required.');
  }
  return `<!-- agent-learning-source:v1:${sourceType}:${normalizedIdentifier} -->`;
}

export function learningLinkMarker(fingerprint, candidateNumber) {
  const normalized = normalizeFingerprint(fingerprint);
  if (!normalized || !positiveInteger(candidateNumber))
    throw new Error('A fingerprint and candidate issue number are required.');
  return `<!-- agent-learning-link:v1:${normalized}:${Number(candidateNumber)} -->`;
}

export function parseLearningMarkers(value = '') {
  const text = String(value || '');
  const result = { candidates: [], sources: [], links: [], dispositions: [], malformed: [] };
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf('<!-- agent-learning-', cursor);
    if (start < 0) break;
    const end = text.indexOf('-->', start);
    if (end < 0) {
      result.malformed.push('unterminated agent-learning marker');
      break;
    }
    const block = text.slice(start, end + 3);
    let match = block.match(/^<!-- agent-learning-candidate:v1:([a-z0-9.-]+) -->$/);
    if (match && normalizeFingerprint(match[1]) === match[1]) {
      result.candidates.push(match[1]);
      cursor = end + 3;
      continue;
    }
    match = block.match(/^<!-- agent-learning-source:v1:([a-z_]+):([A-Za-z0-9][A-Za-z0-9._-]{0,127}) -->$/);
    if (match && SOURCE_TYPES.has(match[1])) {
      result.sources.push({ sourceType: match[1], identifier: match[2], key: `${match[1]}:${match[2]}` });
      cursor = end + 3;
      continue;
    }
    match = block.match(/^<!-- agent-learning-link:v1:([a-z0-9.-]+):(\d+) -->$/);
    if (match && normalizeFingerprint(match[1]) === match[1] && positiveInteger(match[2])) {
      result.links.push({ fingerprint: match[1], candidateNumber: Number(match[2]) });
      cursor = end + 3;
      continue;
    }
    const dispositionMatch = block.match(/^<!-- agent-learning-disposition:v1\n([\s\S]+)\n-->$/);
    if (dispositionMatch) {
      try {
        result.dispositions.push(JSON.parse(dispositionMatch[1]));
      } catch {
        result.malformed.push('agent-learning disposition contains invalid JSON');
      }
      cursor = end + 3;
      continue;
    }
    result.malformed.push('unrecognized agent-learning marker');
    cursor = end + 3;
  }
  return result;
}

export function validateExplicitDisposition(
  disposition,
  { fingerprint, asOf = new Date().toISOString().slice(0, 10) } = {},
) {
  const errors = [];
  const normalized = normalizeFingerprint(fingerprint);
  if (!isRecord(disposition)) return { valid: false, errors: ['disposition must be an object'] };
  const allowedKeys = new Set(['type', 'rationale', 'owner', 'reviewDate', 'expiry', 'recurrenceFingerprint']);
  for (const key of Object.keys(disposition))
    if (!allowedKeys.has(key)) errors.push(`unsupported disposition field: ${key}`);
  if (!DISPOSITION_TYPES.has(disposition.type)) errors.push('type must be external-transient or no-durable-artifact');
  if (
    typeof disposition.rationale !== 'string' ||
    disposition.rationale.trim().length < 12 ||
    disposition.rationale.length > 500
  )
    errors.push('rationale must contain 12-500 characters');
  if (!OWNER_RE.test(String(disposition.owner || ''))) errors.push('owner must be an explicit GitHub login');
  const reviewDate = disposition.reviewDate === undefined ? '' : normalizedDate(disposition.reviewDate);
  const expiry = disposition.expiry === undefined ? '' : normalizedDate(disposition.expiry);
  if (disposition.reviewDate !== undefined && !reviewDate) errors.push('reviewDate must use YYYY-MM-DD');
  if (disposition.expiry !== undefined && !expiry) errors.push('expiry must use YYYY-MM-DD');
  if (!reviewDate && !expiry) errors.push('reviewDate or expiry must be a valid YYYY-MM-DD date');
  const normalizedAsOf = normalizedDate(asOf);
  if (!normalizedAsOf) errors.push('asOf must be a valid YYYY-MM-DD date');
  if (reviewDate && normalizedAsOf && reviewDate < normalizedAsOf) errors.push('reviewDate is stale');
  if (expiry && normalizedAsOf && expiry < normalizedAsOf) errors.push('expiry is stale');
  if (!normalized || disposition.recurrenceFingerprint !== normalized)
    errors.push('recurrenceFingerprint must match the normalized failure fingerprint');
  if (containsSecretShapedValue(JSON.stringify(disposition))) errors.push('disposition contains a secret-shaped value');
  return { valid: errors.length === 0, errors, disposition: errors.length === 0 ? disposition : undefined };
}

function trustedComment(comment) {
  const association = String(comment?.authorAssociation || '').toUpperCase();
  const login = String(comment?.author?.login || '');
  return TRUSTED_ASSOCIATIONS.has(association) || TRUSTED_AUTOMATION_LOGINS.has(login);
}

export function findExplicitDisposition(comments = [], fingerprint, options = {}) {
  const relevant = comments
    .filter(trustedComment)
    .filter((comment) => String(comment.body || '').includes('<!-- agent-learning-disposition:v1'))
    .sort((left, right) => String(left.createdAt || '').localeCompare(String(right.createdAt || '')));
  if (relevant.length === 0) return { present: false, valid: false, errors: [] };
  const parsed = parseLearningMarkers(relevant.at(-1).body || '');
  if (parsed.malformed.length > 0 || parsed.dispositions.length !== 1) {
    return {
      present: true,
      valid: false,
      errors: [...parsed.malformed, 'latest disposition must contain exactly one marker'],
    };
  }
  return { present: true, ...validateExplicitDisposition(parsed.dispositions[0], { ...options, fingerprint }) };
}

export function inspectLearningCandidate(issue = {}) {
  const bodyMarkers = parseLearningMarkers(issue.body || '');
  const trustedSources = [];
  for (const comment of issue.comments || []) {
    if (!trustedComment(comment)) continue;
    const markers = parseLearningMarkers(comment.body || '');
    if (markers.malformed.length === 0) trustedSources.push(...markers.sources);
  }
  const fingerprints = unique(bodyMarkers.candidates);
  const sources = unique([...bodyMarkers.sources, ...trustedSources].map((source) => source.key));
  const errors = [...bodyMarkers.malformed];
  if (fingerprints.length !== 1) errors.push('candidate body must contain exactly one fingerprint marker');
  return {
    valid: errors.length === 0,
    errors,
    number: Number(issue.number),
    url: issue.url,
    fingerprint: fingerprints.length === 1 ? fingerprints[0] : '',
    sources,
    recurrenceCount: sources.length,
    labels: (issue.labels || []).map((label) => (typeof label === 'string' ? label : label?.name)).filter(Boolean),
  };
}

export function candidateLabels(recurrenceCount) {
  return recurrenceCount >= 2
    ? ['agent-learning', 'learning-required', 'learning-regression']
    : ['agent-learning', 'learning-required'];
}

function assertRepository(repository) {
  const value = String(repository || '');
  const segments = value.split('/');
  if (
    !REPOSITORY_RE.test(value) ||
    segments.length !== 2 ||
    segments.some((segment) => segment === '.' || segment === '..')
  ) {
    throw new Error('repository must use owner/name form without path traversal');
  }
}

function assertSource(source) {
  if (!isRecord(source) || !SOURCE_TYPES.has(source.type) || !positiveInteger(source.issueNumber)) {
    throw new Error('A supported learning source and positive issue number are required.');
  }
}

export function buildLearningCandidateBody({ repository, fingerprint, source, classification, recurrenceCount = 1 }) {
  assertRepository(repository);
  assertSource(source);
  const normalized = normalizeFingerprint(fingerprint);
  if (!normalized) throw new Error('A normalized fingerprint is required.');
  if (!Object.hasOwn(CLASSIFICATION_FINGERPRINTS, classification)) {
    throw new Error('A registered repair classification is required.');
  }
  const sourceUrl = `https://github.com/${repository}/issues/${Number(source.issueNumber)}`;
  const recommendation =
    recurrenceCount >= 2
      ? 'Executable prevention is required: choose a regression test, agent-task evaluation, or repository skill update.'
      : 'Choose the smallest durable artifact and provide counterfactual broken/fixed proof.';
  return `${learningCandidateMarker(normalized)}
# Agent learning: ${normalized}

This candidate was generated from trusted classification metadata. The source issue, comments, logs, prompts, and patches remain untrusted and are intentionally not copied here.

## Source

- Type: \`${source.type}\`
- Issue: ${sourceUrl}
- Classification: \`${classification}\`
- Recurrence fingerprint: \`${normalized}\`
- Recurrence count: ${Number(recurrenceCount)}

## Required disposition

${recommendation}

Implementation must use an ordinary protected PR containing the versioned learning artifact, its referenced durable artifact, counterfactual verification, and \`Closes #<learning-issue>\`. Operational recovery alone is not learning verification.

${learningSourceMarker(source.type, String(source.issueNumber))}`;
}

export function buildLearningRecurrenceComment({ repository, fingerprint, source, recurrenceCount }) {
  assertRepository(repository);
  assertSource(source);
  const normalized = normalizeFingerprint(fingerprint);
  if (!normalized || !positiveInteger(recurrenceCount))
    throw new Error('A fingerprint and recurrence count are required.');
  const sourceUrl = `https://github.com/${repository}/issues/${Number(source.issueNumber)}`;
  const recommendation =
    recurrenceCount >= 2
      ? 'Executable prevention is required: regression test, agent-task evaluation, or repository skill update.'
      : 'Select the smallest durable learning artifact.';
  return `${learningSourceMarker(source.type, String(source.issueNumber))}
Recurrence ${Number(recurrenceCount)} for \`${normalized}\` was linked from ${sourceUrl}.

${recommendation}

No source body, comment, log, prompt, credential, or provider content was copied.`;
}

export function buildLearningLinkComment({ repository, fingerprint, candidateNumber }) {
  assertRepository(repository);
  const normalized = normalizeFingerprint(fingerprint);
  if (!normalized || !positiveInteger(candidateNumber))
    throw new Error('A fingerprint and candidate number are required.');
  return `${learningLinkMarker(normalized, candidateNumber)}
Learning disposition: https://github.com/${repository}/issues/${Number(candidateNumber)} (\`${normalized}\`).`;
}

export function planLearningCandidate({
  repository,
  sourceIssue,
  classification,
  candidateIssues = [],
  comments = [],
  asOf,
}) {
  assertRepository(repository);
  const source = { type: 'repair_issue', issueNumber: Number(sourceIssue?.number) };
  assertSource(source);
  const fingerprint = createFailureFingerprint({ sourceType: source.type, classification });
  const disposition = findExplicitDisposition(comments, fingerprint, { asOf });
  if (disposition.valid) {
    return {
      action: 'disposition',
      coverage: { valid: true, kind: disposition.disposition.type, fingerprint },
      fingerprint,
      labels: ['learning-waived'],
      disposition: disposition.disposition,
    };
  }
  if (disposition.present) {
    return {
      action: 'blocked',
      coverage: { valid: false, kind: 'invalid-disposition', fingerprint },
      fingerprint,
      errors: disposition.errors,
    };
  }

  const snapshots = candidateIssues.map(inspectLearningCandidate);
  const invalidMatching = snapshots.filter((candidate) => !candidate.valid && candidate.fingerprint === fingerprint);
  if (invalidMatching.length > 0) {
    return {
      action: 'blocked',
      coverage: { valid: false, kind: 'malformed-candidate', fingerprint },
      fingerprint,
      errors: invalidMatching.flatMap((candidate) => candidate.errors),
    };
  }
  const matching = snapshots.filter((candidate) => candidate.valid && candidate.fingerprint === fingerprint);
  if (matching.length > 1) {
    return {
      action: 'blocked',
      coverage: { valid: false, kind: 'duplicate-candidates', fingerprint },
      fingerprint,
      errors: ['multiple open learning candidates have the same fingerprint'],
    };
  }
  const sourceKey = `${source.type}:${source.issueNumber}`;
  if (matching.length === 0) {
    const recurrenceCount = 1;
    return {
      action: 'create',
      coverage: { valid: true, kind: 'planned-candidate', fingerprint },
      fingerprint,
      recurrenceCount,
      labels: candidateLabels(recurrenceCount),
      title: `Agent learning: ${fingerprint}`,
      body: buildLearningCandidateBody({ repository, fingerprint, source, classification, recurrenceCount }),
      source,
    };
  }

  const candidate = matching[0];
  if (candidate.sources.includes(sourceKey)) {
    return {
      action: 'existing',
      coverage: { valid: true, kind: 'candidate', fingerprint, candidateNumber: candidate.number },
      fingerprint,
      recurrenceCount: candidate.recurrenceCount,
      candidate,
      labels: candidateLabels(candidate.recurrenceCount),
      source,
    };
  }
  const recurrenceCount = candidate.recurrenceCount + 1;
  return {
    action: 'append',
    coverage: { valid: true, kind: 'candidate', fingerprint, candidateNumber: candidate.number },
    fingerprint,
    recurrenceCount,
    candidate,
    labels: candidateLabels(recurrenceCount),
    comment: buildLearningRecurrenceComment({ repository, fingerprint, source, recurrenceCount }),
    source,
  };
}

export function gateRepairClosure(decision, coverage) {
  if (decision?.action !== 'close') return decision;
  if (coverage?.valid === true) return decision;
  return {
    action: 'comment',
    decisionKind: 'learning-disposition-required',
    issueType: decision.issueType,
    reason: 'operational recovery is proven, but no linked learning candidate or valid no-artifact disposition exists',
  };
}
