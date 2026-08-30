#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

export const REPAIR_BOUNDS = Object.freeze({
  maxAttemptsPerStrategy: 2,
  maxAttemptsPerRepairGeneration: 3,
  externalRerunsPerFailure: 1,
});

export const LEARNING_RECURRENCE_THRESHOLD = 2;

export const CODEX_CALLBACK = Object.freeze({
  supported: false,
  requested: false,
  reason: 'official-codex-github-integration-supports-review-not-implementation-callbacks',
});

export const TRUSTED_REPAIR_WORKFLOWS = Object.freeze({
  '.github/workflows/pr-gate.yml': Object.freeze({ key: 'pr-gate', displayName: 'PR Gate' }),
  '.github/workflows/security-gate.yml': Object.freeze({ key: 'security-gate', displayName: 'Security Gate' }),
  '.github/workflows/delivery-v2.yml': Object.freeze({ key: 'delivery-v2', displayName: 'Delivery v2' }),
  '.github/workflows/bring-readonly-canary.yml': Object.freeze({
    key: 'bring-readonly-canary',
    displayName: 'Bring Read-Only Canary',
  }),
  '.github/workflows/migrate-private-storage.yml': Object.freeze({
    key: 'private-storage-migration',
    displayName: 'Private Storage Migration',
  }),
  '.github/workflows/verify-azure-oidc.yml': Object.freeze({
    key: 'azure-oidc',
    displayName: 'Verify Azure OIDC',
  }),
});

const REPOSITORY = 'JueZ/api';
const SHA_RE = /^[0-9a-f]{40}$/;
const FINGERPRINT_RE = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const FAILURE_CONCLUSIONS = new Set([
  'action_required',
  'cancelled',
  'failure',
  'stale',
  'startup_failure',
  'timed_out',
]);
const FAILED_JOB_CONCLUSIONS = new Set(['action_required', 'failure', 'stale', 'startup_failure', 'timed_out']);
const TRUSTED_MAIN_EVENTS = new Set(['push', 'repository_dispatch', 'schedule', 'workflow_dispatch']);
const BOT_LOGINS = new Set(['github-actions', 'github-actions[bot]']);
const MAX_EVENT_BYTES = 1024 * 1024;
const MAX_SUMMARY_BYTES = 16 * 1024;
const MAX_ISSUES = 1000;
const MAX_REPAIR_COMMENTS = 1000;
const MAX_PUBLIC_STATE_SOURCE_BYTES = 64 * 1024;
const MAX_PUBLIC_STATE_BYTES = 48 * 1024;
const MAX_REPAIR_PROGRESS_BYTES = 48 * 1024;
const MAX_PUBLIC_STATE_BLOCKS_PER_SOURCE = 8;
const MAX_REPAIR_ATTEMPTS = 100;
const MAX_STRATEGY_FINGERPRINTS = 100;
const REPAIR_ATTEMPT_OUTCOMES = new Set(['effective', 'ineffective', 'in-progress']);
const REDIAGNOSIS_FIELDS = Object.freeze([
  'version',
  'strategyFingerprint',
  'failureClassification',
  'rootCauseHypothesisKey',
  'discriminatingAction',
]);
const STRATEGY_FINGERPRINT_RE = /^strategy-v1\.[0-9a-f]{64}$/;
const DELIVERY_TERMINAL_OUTCOMES = new Set(['verified', 'not_applicable', 'superseded', 'incomplete']);
const DELIVERY_RAW_JOB_RESULTS = new Set(['success', 'cancelled', 'failure', 'skipped']);
const DELIVERY_VERIFICATION_RESULTS = new Set(['passed', 'not_applicable', 'cancelled', 'failure', 'skipped']);
const CONTINUATION_TRIGGERS = Object.freeze([
  'trusted-workflow-completion',
  'new-candidate-head',
  'permission-restored',
  'safe-rerun',
  'next-repository-task',
]);

const LABELS = Object.freeze({
  'codex-repair': Object.freeze({ color: 'b60205', description: 'Actionable autonomous delivery repair queue.' }),
  'delivery-failure': Object.freeze({
    color: 'd93f0b',
    description: 'Trusted delivery or runtime verification failed.',
  }),
  'learning-candidate': Object.freeze({ color: 'fbca04', description: 'Sanitized reusable failure candidate.' }),
  'learning-promotion-required': Object.freeze({
    color: 'd93f0b',
    description: 'Objective learning promotion criteria are satisfied.',
  }),
  'pr-gate-failure': Object.freeze({ color: 'd4c5f9', description: 'Protected pull-request gate failed.' }),
  'security-failure': Object.freeze({ color: 'b60205', description: 'Security-significant validation failed.' }),
});

const SECRET_PATTERNS = Object.freeze([
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\b(?:github_pat_|gh[pousr]_|sk-(?:proj-)?|AKIA)[A-Za-z0-9_-]{8,}/i,
  /\b(?:authorization|connection[_ -]?string|password|sas|secret|token)\s*[:=]\s*[^\s,;]+/i,
  /https?:\/\/[^\s/@:]+:[^\s/@]+@/i,
]);

export function containsSensitiveText(value) {
  const text = String(value ?? '');
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

export function sanitizeJobName(value) {
  const source = String(value ?? '');
  if (containsSensitiveText(source)) return 'redacted-job';
  const withoutControls = [...source]
    .map((character) => (character.codePointAt(0) <= 31 || character.codePointAt(0) === 127 ? ' ' : character))
    .join('');
  const normalized = withoutControls
    .replace(/[^A-Za-z0-9 ._/-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (normalized || 'workflow-run').slice(0, 96);
}

export function fingerprintPart(value, fallback = 'unknown') {
  const normalized = sanitizeJobName(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return normalized || fallback;
}

export function selectFailedJob(jobs, workflowPath) {
  const failed = Array.isArray(jobs)
    ? jobs.filter((job) => isRecord(job) && FAILED_JOB_CONCLUSIONS.has(String(job.conclusion || '')))
    : [];
  if (failed.length === 0) return { id: 0, name: 'workflow run', conclusion: 'cancelled' };

  const aggregates = new Set(['PR Gate', 'Security Gate', 'delivery summary']);
  const causal = failed.find((job) => !aggregates.has(String(job.name || ''))) || failed[0];
  return {
    id: safeInteger(causal.id),
    name: sanitizeJobName(causal.name),
    conclusion: FAILED_JOB_CONCLUSIONS.has(String(causal.conclusion)) ? String(causal.conclusion) : 'failure',
    workflowPath,
  };
}

export function classifyFailure(workflowPath, jobName, deliverySummary = undefined) {
  const workflow = TRUSTED_REPAIR_WORKFLOWS[workflowPath];
  if (!workflow) throw new Error(`Untrusted repair workflow path: ${workflowPath}`);
  const job = fingerprintPart(jobName);

  if (deliverySummary?.rollback === 'success') {
    return failure('production-regression', 'critical', 'delivery.production', ['production-rollback']);
  }

  if (workflow.key === 'pr-gate') {
    if (/policy|classif|workflow|bicep|aggregate/.test(job)) {
      return failure('deterministic-test-or-policy', 'high', `pull-request.${job}`);
    }
    return failure('candidate-code', 'medium', `pull-request.${job}`);
  }
  if (workflow.key === 'security-gate') {
    return failure('security-significant', 'high', `security.${job}`, ['security-significant-defect']);
  }
  if (workflow.key === 'delivery-v2') {
    if (deliverySummary?.terminalOutcome === 'superseded') {
      return failure('superseded-delivery-generation', 'medium', 'delivery.superseded');
    }
    if (/rollback|recover|known-good/.test(job)) {
      return failure('production-recovery-failure', 'critical', 'delivery.production-recovery', [
        'production-recovery-failure',
      ]);
    }
    if (/production|promote/.test(job) || deliverySummary?.production === 'failure') {
      return failure('production-regression', 'critical', 'delivery.production', ['production-regression']);
    }
    if (/test|deploy/.test(job) || deliverySummary?.test === 'failure') {
      return failure('deployment-failure', 'high', 'delivery.test', ['deployment-failure']);
    }
    if (/build|attest|release/.test(job)) return failure('release-build-failure', 'high', 'delivery.build');
    if (/current-main|supersed/.test(job)) return failure('delivery-policy-failure', 'high', 'delivery.policy');
    return failure('delivery-controller-failure', 'high', `delivery.${job}`, ['deployment-failure']);
  }
  if (workflow.key === 'private-storage-migration' || workflow.key === 'production-private-storage') {
    return failure('data-integrity-or-migration-failure', 'critical', `storage.${job}`, ['data-integrity-defect']);
  }
  if (workflow.key === 'bring-readonly-canary') {
    return failure('integration-regression', 'high', `integration.bring.${job}`);
  }
  return failure('credential-or-permission-blocker', 'high', `delivery.identity.${job}`);
}

export function buildFailureFingerprint(workflowPath, classification, jobName) {
  const workflow = TRUSTED_REPAIR_WORKFLOWS[workflowPath];
  if (!workflow) throw new Error(`Untrusted repair workflow path: ${workflowPath}`);
  const fingerprint = `${workflow.key}.${fingerprintPart(classification)}.${fingerprintPart(jobName)}`;
  if (!FINGERPRINT_RE.test(fingerprint) || fingerprint.length > 160) {
    throw new Error('Generated failure fingerprint is invalid.');
  }
  return fingerprint;
}

export function buildStrategyFingerprint({
  failureClass,
  failingGate,
  rootCauseHypothesis,
  affectedSurface,
  repairMechanism,
}) {
  const canonical = {
    failureClass: strategyKey(failureClass, 'failureClass'),
    failingGate: strategyKey(failingGate, 'failingGate'),
    rootCauseHypothesis: strategyKey(rootCauseHypothesis, 'rootCauseHypothesis'),
    affectedSurface: strategyKey(affectedSurface, 'affectedSurface'),
    repairMechanism: strategyKey(repairMechanism, 'repairMechanism'),
  };
  const digest = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  return `strategy-v1.${digest}`;
}

export function decideRepairAttempt({
  attempts = [],
  exhaustedStrategyFingerprints: priorExhaustedStrategyFingerprints = [],
  proposedStrategy,
  rediagnosis = {},
  priorRediagnosisVersion = 0,
  priorRediagnosisStrategyFingerprint = null,
  priorRootCauseHypothesisKey = null,
}) {
  const strategyFingerprint = buildStrategyFingerprint(proposedStrategy);
  const { exhaustedStrategyFingerprints } = summarizeRepairAttemptHistory(attempts, priorExhaustedStrategyFingerprints);
  const reusesCurrentDiagnosis = priorRediagnosisStrategyFingerprint === strategyFingerprint;
  const requiredRediagnosisVersion = safeInteger(priorRediagnosisVersion) + (reusesCurrentDiagnosis ? 0 : 1);
  const base = {
    taskStatus: 'active',
    strategyFingerprint,
    exhaustedStrategyFingerprints,
    requiredRediagnosis: [...REDIAGNOSIS_FIELDS],
    requiredRediagnosisVersion,
  };
  const missingRediagnosis = rediagnosisBindingFailures({
    rediagnosis,
    proposedStrategy,
    strategyFingerprint,
    requiredRediagnosisVersion,
    priorRootCauseHypothesisKey,
    requireMateriallyDifferentHypothesis: exhaustedStrategyFingerprints.length > 0 && !reusesCurrentDiagnosis,
  });

  if (attempts.length >= REPAIR_BOUNDS.maxAttemptsPerRepairGeneration) {
    return {
      ...base,
      allowed: false,
      action: 'continue-next-generation',
      generationStatus: 'exhausted',
      continuationRequired: true,
      missingRediagnosis,
    };
  }

  if (exhaustedStrategyFingerprints.includes(strategyFingerprint)) {
    return {
      ...base,
      allowed: false,
      action: 'strategy-exhausted',
      generationStatus: 'active',
      continuationRequired: true,
      missingRediagnosis,
    };
  }
  if (missingRediagnosis.length > 0) {
    return {
      ...base,
      allowed: false,
      action: 'rediagnose',
      generationStatus: 'active',
      continuationRequired: true,
      missingRediagnosis,
    };
  }
  return {
    ...base,
    allowed: true,
    action: exhaustedStrategyFingerprints.length > 0 ? 'attempt-different-strategy' : 'attempt',
    generationStatus: 'active',
    continuationRequired: false,
    missingRediagnosis: [],
  };
}

export function validateSourceRun({ run, pullRequest, deliverySummary, repository = REPOSITORY }) {
  if (!isRecord(run)) return ignored('workflow-run-metadata-missing');
  if (repository !== REPOSITORY || run.repository?.full_name !== REPOSITORY) return ignored('repository-mismatch');
  const workflow = TRUSTED_REPAIR_WORKFLOWS[run.path];
  if (!workflow) return ignored('workflow-not-allowlisted');
  if (!SHA_RE.test(String(run.head_sha || ''))) return ignored('invalid-exact-head');
  const acceptedFailure = FAILURE_CONCLUSIONS.has(String(run.conclusion || ''));
  const acceptedSupersession =
    workflow.key === 'delivery-v2' &&
    run.conclusion === 'success' &&
    deliverySummary?.schemaVersion === 2 &&
    deliverySummary.terminalOutcome === 'superseded' &&
    isAcceptedDeliverySummary(deliverySummary, run.head_sha);
  if (!acceptedFailure && !acceptedSupersession) return ignored('workflow-did-not-fail-or-supersede');

  if (run.event === 'pull_request') {
    if (!isRecord(pullRequest)) return ignored('pull-request-metadata-missing');
    if (pullRequest.state !== 'open') return ignored('pull-request-not-open');
    if (pullRequest.base?.ref !== 'main') return ignored('pull-request-base-not-main');
    if (pullRequest.head?.repo?.full_name !== REPOSITORY) return ignored('pull-request-fork-denied');
    if (!String(pullRequest.head?.ref || '').startsWith('codex/')) return ignored('pull-request-branch-not-codex');
    if (pullRequest.head?.sha !== run.head_sha) return ignored('stale-pull-request-head');
    return { accepted: true, scope: 'pull-request', workflow, pullRequestNumber: safeInteger(pullRequest.number) };
  }

  if (!TRUSTED_MAIN_EVENTS.has(String(run.event || ''))) return ignored('unsupported-main-event');
  if (run.head_branch !== 'main') return ignored('trusted-workflow-not-on-main');
  return { accepted: true, scope: 'protected-main', workflow, pullRequestNumber: 0 };
}

export function repairFingerprintMarker(fingerprint) {
  assertFingerprint(fingerprint);
  return `<!-- juez-repair-fingerprint:v1:${fingerprint} -->`;
}

export function repairIncidentMarker(headSha, fingerprint) {
  assertSha(headSha);
  assertFingerprint(fingerprint);
  return `<!-- juez-repair-incident:v1:${headSha}:${fingerprint} -->`;
}

export function extractIncidentMarkers(value) {
  const markers = new Set();
  const source = String(value ?? '');
  const expression = /<!-- juez-repair-incident:v1:([0-9a-f]{40}):([a-z0-9.-]+) -->/g;
  for (const match of source.matchAll(expression)) {
    if (FINGERPRINT_RE.test(match[2]) && match[2].length <= 160) markers.add(match[0]);
  }
  return markers;
}

function latestSanitizedAdvisoryRepairSnapshot(issue, comments, fingerprint) {
  let latest;
  const sources = [{ value: issue, comment: false }, ...comments.map((comment) => ({ value: comment, comment: true }))];
  for (const source of sources) {
    if (!reusableBotSnapshotSource(source.value, source.comment)) continue;
    const allowsExpectedCandidate = immutableProgressSnapshotSource(source.value, source.comment, fingerprint);
    for (const candidate of extractMarkedPublicRepairStates(source.value.body, fingerprint)) {
      latest = allowsExpectedCandidate
        ? candidate
        : {
            ...candidate,
            continuation: { ...candidate.continuation, expectedCandidateSha: null },
          };
    }
  }
  return latest;
}

function extractMarkedPublicRepairStates(value, fingerprint) {
  const source = String(value ?? '');
  if (Buffer.byteLength(source, 'utf8') > MAX_PUBLIC_STATE_SOURCE_BYTES) return [];
  const states = [];
  const markerExpression = /<!-- juez-repair-incident:v1:([0-9a-f]{40}):([a-z0-9.-]+) -->/g;
  let markedBlocks = 0;
  for (const marker of source.matchAll(markerExpression)) {
    if (marker[2] !== fingerprint) continue;
    markedBlocks += 1;
    if (markedBlocks > MAX_PUBLIC_STATE_BLOCKS_PER_SOURCE) break;
    const markerEnd = marker.index + marker[0].length;
    const nextMarker = source.indexOf('<!-- juez-repair-incident:', markerEnd);
    const fenceStart = source.indexOf('```json', markerEnd);
    if (fenceStart < 0 || fenceStart - markerEnd > 4096) continue;
    if (nextMarker >= 0 && nextMarker < fenceStart) continue;
    const jsonStart = fenceStart + '```json'.length;
    const fenceEnd = source.indexOf('```', jsonStart);
    if (fenceEnd < 0) continue;
    const json = source.slice(jsonStart, fenceEnd).trim();
    if (Buffer.byteLength(json, 'utf8') > MAX_PUBLIC_STATE_BYTES || containsSensitiveText(json)) continue;
    try {
      const sanitized = sanitizeParsedPublicRepairState(JSON.parse(json), marker[1], fingerprint);
      if (sanitized) states.push(sanitized);
    } catch {
      // Malformed or non-canonical advisory state is ignored; the recorded incident marker still tracks recurrence.
    }
  }
  return states;
}

function sanitizeParsedPublicRepairState(value, markerHeadSha, fingerprint) {
  if (!isRecord(value) || value.schemaVersion !== 2) return undefined;
  if (value.repository !== REPOSITORY || value.failureFingerprint !== fingerprint) return undefined;
  if (!isRecord(value.task) || !isRecord(value.trigger) || !isRecord(value.diagnosis)) return undefined;
  if (!isRecord(value.repair) || !isRecord(value.continuation)) return undefined;
  if (value.task.status !== 'active' || value.task.completionStatus !== 'unverified') return undefined;
  if (value.task.candidateSha !== markerHeadSha || value.trigger.headSha !== markerHeadSha) return undefined;
  if (!publicTargetRequirementRef(value.task.targetRequirementRef)) return undefined;
  if (!TRUSTED_REPAIR_WORKFLOWS[value.trigger.workflowPath]) return undefined;
  const workflowRunId = safeInteger(value.trigger.workflowRunId);
  if (!workflowRunId) return undefined;
  const workflowRunUrl = `https://github.com/${REPOSITORY}/actions/runs/${workflowRunId}`;
  if (value.trigger.workflowRunUrl !== workflowRunUrl) return undefined;
  if (value.callback?.supported !== false || value.callback?.requested !== false) return undefined;
  if (
    value.persistence?.authority !== 'advisory' ||
    value.persistence?.revalidationRequired !== true ||
    value.persistence?.repairAuthorization !== 'none'
  ) {
    return undefined;
  }
  if (
    value.repairBounds?.maxAttemptsPerStrategy !== REPAIR_BOUNDS.maxAttemptsPerStrategy ||
    value.repairBounds?.maxAttemptsPerRepairGeneration !== REPAIR_BOUNDS.maxAttemptsPerRepairGeneration ||
    value.repairBounds?.externalRerunsPerFailure !== REPAIR_BOUNDS.externalRerunsPerFailure
  ) {
    return undefined;
  }
  return buildPublicRepairState({
    repository: REPOSITORY,
    fingerprint,
    classification: value.diagnosis.failureClassification,
    severity: publicKeyOrNull(value.severity) || 'unknown',
    affectedArea: publicKeyOrNull(value.affectedArea) || 'unknown',
    workflowPath: value.trigger.workflowPath,
    workflowRunId,
    workflowRunUrl,
    failedJob: sanitizeJobName(value.trigger.failedJob),
    failedJobId: safeInteger(value.trigger.failedJobId),
    headSha: markerHeadSha,
    pullRequest: safeInteger(value.trigger.pullRequest),
    observableFailure: publicTextOrNull(value.observableFailure) || 'Schema-sanitized advisory repair continuation.',
    task: value.task,
    diagnosis: value.diagnosis,
    repair: value.repair,
    continuation: value.continuation,
    recurrenceCount: safeInteger(value.recurrenceCount),
    learning: undefined,
    recovery: value.recovery,
  });
}

function carriedRepairContinuation(incident, previousState) {
  if (!previousState) return {};
  const incidentTargetRequirementRef = safeInteger(incident.pullRequest)
    ? `https://github.com/${REPOSITORY}/pull/${safeInteger(incident.pullRequest)}`
    : `https://github.com/${REPOSITORY}/commit/${incident.headSha}`;
  const sameTarget = previousState.task.targetRequirementRef === incidentTargetRequirementRef;
  const exactExpectedCandidate = previousState.continuation.expectedCandidateSha === incident.headSha;
  if (!sameTarget && !exactExpectedCandidate) return {};
  const currentEvidence = {
    kind: 'trusted-workflow-failure',
    summary: incident.observableFailure,
    sourceRef: incident.workflowRunUrl,
  };
  const evidence = [...previousState.diagnosis.evidence, currentEvidence]
    .filter(
      (entry, index, entries) =>
        entries.findIndex(
          (candidate) =>
            candidate.kind === entry.kind &&
            candidate.summary === entry.summary &&
            candidate.sourceRef === entry.sourceRef,
        ) === index,
    )
    .slice(-20);
  return {
    task: { ...previousState.task, candidateSha: incident.headSha },
    diagnosis: { ...previousState.diagnosis, evidence },
    repair: previousState.repair,
    continuation: { ...previousState.continuation, expectedCandidateSha: null },
  };
}

export function learningDecision({ classification, severity, recurrenceCount, learningTriggers = [] }) {
  const triggers = new Set(learningTriggers.filter((value) => typeof value === 'string' && value.length <= 80));
  const significant =
    triggers.size > 0 ||
    ['deployment-failure', 'production-recovery-failure', 'production-regression', 'security-significant'].includes(
      classification,
    );
  if (recurrenceCount >= LEARNING_RECURRENCE_THRESHOLD) triggers.add('recurrence-threshold');
  const promotionRequired = triggers.has('production-rollback') || recurrenceCount >= LEARNING_RECURRENCE_THRESHOLD;
  return {
    status: promotionRequired ? 'promotion-required' : significant ? 'candidate' : 'not-required-yet',
    severity,
    triggers: [...triggers].sort(),
    recurrenceCount,
  };
}

export function planRepairIssue({ incident, issues = [], comments = [] }) {
  const marker = repairFingerprintMarker(incident.fingerprint);
  const matches = issues.filter((issue) => String(issue.body || '').includes(marker));
  if (matches.length > 1) {
    return { action: 'blocked', reason: 'duplicate-repair-issues', incident, issueNumbers: matches.map(issueNumber) };
  }

  const issue = matches[0];
  const boundedComments = Array.isArray(comments) ? comments.slice(-MAX_REPAIR_COMMENTS) : [];
  const recordedMarkers = new Set();
  if (issue && isBotAuthor(issue.author)) {
    for (const value of extractIncidentMarkers(issue.body)) recordedMarkers.add(value);
  }
  for (const comment of boundedComments) {
    if (!reusableBotSnapshotSource(comment, true)) continue;
    for (const value of extractIncidentMarkers(comment.body)) recordedMarkers.add(value);
  }

  const incidentMarker = repairIncidentMarker(incident.headSha, incident.fingerprint);
  if (recordedMarkers.has(incidentMarker)) {
    return {
      action: 'deduplicated',
      reason: 'exact-head-and-fingerprint-already-recorded',
      incident,
      issueNumber: issueNumber(issue),
      recurrenceCount: recordedMarkers.size,
    };
  }

  const recurrenceCount = recordedMarkers.size + 1;
  const learning = learningDecision({
    classification: incident.classification,
    severity: incident.severity,
    recurrenceCount,
    learningTriggers: incident.learningTriggers,
  });
  const previousState = latestSanitizedAdvisoryRepairSnapshot(issue, boundedComments, incident.fingerprint);
  const stateInput = {
    ...incident,
    ...carriedRepairContinuation(incident, previousState),
    recurrenceCount,
    learning,
    callback: CODEX_CALLBACK,
    repairBounds: REPAIR_BOUNDS,
  };
  const normalized = buildPublicRepairState(stateInput);
  const state = {
    ...stateInput,
    task: normalized.task,
    diagnosis: normalized.diagnosis,
    repair: normalized.repair,
    continuation: normalized.continuation,
    recovery: normalized.recovery,
  };
  const labels = desiredLabels(state);
  if (!issue) {
    return {
      action: 'create',
      reason: 'new-fingerprint',
      title: `Repair queue: ${incident.fingerprint}`,
      body: buildRepairIssueBody(state),
      labels,
      state,
    };
  }
  return {
    action: 'append',
    reason: issue.state === 'CLOSED' ? 'recurrence-reopens-issue' : 'new-exact-head-recurrence',
    issueNumber: issueNumber(issue),
    reopen: issue.state === 'CLOSED',
    comment: buildRepairRecurrenceComment(state),
    labels,
    state,
  };
}

function repairProgressFromEnvironment(env) {
  const source = String(env.REPAIR_PROGRESS_JSON || '').trim();
  if (!source) return undefined;
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_EVENT_NAME !== 'workflow_dispatch') {
    throw new Error('Repair progress may be recorded only by an authenticated workflow_dispatch run.');
  }
  if (Buffer.byteLength(source, 'utf8') > MAX_REPAIR_PROGRESS_BYTES) {
    throw new Error('Repair progress input exceeds its public size bound.');
  }
  if (containsSensitiveText(source)) throw new Error('Repair progress input was not public-safe.');
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error('Repair progress input must be valid JSON.');
  }
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.repository !== REPOSITORY ||
    !safeInteger(value.issueNumber) ||
    !safeInteger(value.sourceRunId) ||
    !SHA_RE.test(String(value.candidateSha || '')) ||
    !FINGERPRINT_RE.test(String(value.failureFingerprint || '')) ||
    String(value.failureFingerprint).length > 160 ||
    !isRecord(value.diagnosis) ||
    !isRecord(value.repair) ||
    !isRecord(value.continuation)
  ) {
    throw new Error('Repair progress input does not match the bounded advisory schema.');
  }
  return value;
}

function sameRepairAttemptIdentity(left, right) {
  return (
    left.number === right.number &&
    left.generation === right.generation &&
    left.strategyFingerprint === right.strategyFingerprint &&
    left.candidateSha === right.candidateSha
  );
}

function validateRepairProgressTransition(previousState, progress, candidateState) {
  const previousGeneration = previousState.repair.generation;
  const candidateGeneration = candidateState.repair.generation;
  const nextGeneration = previousState.continuation.nextGeneration;
  const permittedGeneration =
    candidateGeneration === previousGeneration ||
    (nextGeneration?.pending === true &&
      candidateGeneration === nextGeneration.targetGeneration &&
      candidateGeneration === previousGeneration + 1);
  if (!permittedGeneration) {
    throw new Error('Repair progress attempted an unrequested repair-generation transition.');
  }

  const previousAttempts = previousState.repair.attempts;
  const candidateAttempts = candidateState.repair.attempts;
  if (candidateAttempts.length < previousAttempts.length) {
    throw new Error('Repair progress may not erase recorded repair attempts.');
  }
  for (const [index, previousAttempt] of previousAttempts.entries()) {
    const candidateAttempt = candidateAttempts[index];
    if (!sameRepairAttemptIdentity(previousAttempt, candidateAttempt)) {
      throw new Error('Repair progress may not rewrite a recorded repair attempt.');
    }
    if (
      previousAttempt.outcome !== candidateAttempt.outcome &&
      !(previousAttempt.outcome === 'in-progress' && ['effective', 'ineffective'].includes(candidateAttempt.outcome))
    ) {
      throw new Error('Repair progress contains an invalid repair-attempt outcome transition.');
    }
  }

  for (const fingerprint of previousState.repair.exhaustedStrategyFingerprints) {
    if (!candidateState.repair.exhaustedStrategyFingerprints.includes(fingerprint)) {
      throw new Error('Repair progress may not erase an exhausted strategy fingerprint.');
    }
  }
  const expectedExhaustedStrategyFingerprints = summarizeRepairAttemptHistory(
    candidateAttempts,
    previousState.repair.exhaustedStrategyFingerprints,
  ).exhaustedStrategyFingerprints;
  if (
    JSON.stringify(candidateState.repair.exhaustedStrategyFingerprints) !==
    JSON.stringify(expectedExhaustedStrategyFingerprints)
  ) {
    throw new Error('Repair progress may not manufacture an exhausted strategy fingerprint.');
  }

  const rawAttempts = Array.isArray(progress.repair.attempts) ? progress.repair.attempts : [];
  const stagedAttempts = [...candidateAttempts.slice(0, previousAttempts.length)];
  const historicalExhausted = [...previousState.repair.exhaustedStrategyFingerprints];
  for (let index = previousAttempts.length; index < candidateAttempts.length; index += 1) {
    const attempt = candidateAttempts[index];
    const rawAttempt = rawAttempts[index];
    if (!isRecord(rawAttempt?.strategy)) {
      throw new Error('Each newly recorded repair attempt must include its stable strategy inputs.');
    }
    const computedFingerprint = buildStrategyFingerprint(rawAttempt.strategy);
    if (computedFingerprint !== attempt.strategyFingerprint) {
      throw new Error('Repair attempt strategy inputs do not match its strategy fingerprint.');
    }
    if (safeInteger(rawAttempt.number) !== index + 1 || attempt.number !== index + 1) {
      throw new Error('New repair attempts must use unique sequential attempt numbers.');
    }
    if (
      rawAttempt.candidateSha !== candidateState.task.candidateSha ||
      attempt.candidateSha !== candidateState.task.candidateSha
    ) {
      throw new Error('A new repair attempt must bind to the exact current candidate SHA.');
    }
    if (attempt.generation !== candidateGeneration) {
      throw new Error('A new repair attempt must belong to the active repair generation.');
    }
    const decision = decideRepairAttempt({
      attempts: stagedAttempts.filter((entry) => entry.generation === candidateGeneration),
      exhaustedStrategyFingerprints: historicalExhausted,
      proposedStrategy: rawAttempt.strategy,
      rediagnosis: candidateState.diagnosis,
      priorRediagnosisVersion: previousState.diagnosis.version,
      priorRediagnosisStrategyFingerprint: previousState.diagnosis.strategyFingerprint,
      priorRootCauseHypothesisKey: previousState.diagnosis.rootCauseHypothesisKey,
    });
    if (!decision.allowed) {
      throw new Error(`Repair progress violates the strategy policy: ${decision.action}.`);
    }
    stagedAttempts.push(attempt);
    historicalExhausted.splice(0, historicalExhausted.length, ...decision.exhaustedStrategyFingerprints);
  }
}

function planRepairProgressSnapshot({ incident, issues = [], comments = [], progress }) {
  if (
    progress.repository !== incident.repository ||
    progress.sourceRunId !== incident.workflowRunId ||
    progress.candidateSha !== incident.headSha ||
    progress.failureFingerprint !== incident.fingerprint
  ) {
    throw new Error('Repair progress identity does not match the trusted source run.');
  }
  const marker = repairFingerprintMarker(incident.fingerprint);
  const matches = issues.filter((issue) => String(issue.body || '').includes(marker));
  if (matches.length !== 1) {
    throw new Error('Repair progress requires exactly one existing repair issue for the trusted fingerprint.');
  }
  const issue = matches[0];
  if (issueNumber(issue) !== progress.issueNumber || !isBotAuthor(issue.author)) {
    throw new Error('Repair progress issue binding is invalid.');
  }
  const boundedComments = Array.isArray(comments) ? comments.slice(-MAX_REPAIR_COMMENTS) : [];
  const previousState = latestSanitizedAdvisoryRepairSnapshot(issue, boundedComments, incident.fingerprint);
  if (!previousState || previousState.task.candidateSha !== incident.headSha) {
    throw new Error('Repair progress requires a current sanitized advisory snapshot for the exact candidate.');
  }
  const recurrenceCount = Math.max(1, safeInteger(previousState.recurrenceCount));
  const learning = learningDecision({
    classification: incident.classification,
    severity: incident.severity,
    recurrenceCount,
    learningTriggers: incident.learningTriggers,
  });
  if (
    Object.hasOwn(progress.continuation, 'expectedCandidateSha') &&
    progress.continuation.expectedCandidateSha !== null &&
    (!SHA_RE.test(String(progress.continuation.expectedCandidateSha || '')) ||
      progress.continuation.expectedCandidateSha === incident.headSha)
  ) {
    throw new Error('Repair progress expected candidate must be a different full exact SHA.');
  }
  const suppliedEvidence = Array.isArray(progress.diagnosis.evidence) ? progress.diagnosis.evidence : [];
  const candidateState = buildPublicRepairState({
    ...incident,
    task: previousState.task,
    diagnosis: {
      ...previousState.diagnosis,
      ...progress.diagnosis,
      evidence: [...previousState.diagnosis.evidence, ...suppliedEvidence],
    },
    repair: { ...previousState.repair, ...progress.repair },
    continuation: { ...previousState.continuation, ...progress.continuation },
    recurrenceCount,
    learning,
  });
  validateRepairProgressTransition(previousState, progress, candidateState);
  const state = {
    ...incident,
    task: candidateState.task,
    diagnosis: candidateState.diagnosis,
    repair: candidateState.repair,
    continuation: candidateState.continuation,
    recurrenceCount,
    learning,
    recovery: candidateState.recovery,
  };
  return {
    action: 'record-progress',
    reason: 'sanitized-advisory-progress-snapshot',
    issueNumber: issueNumber(issue),
    reopen: issue.state === 'CLOSED',
    comment: buildRepairProgressComment(state),
    labels: desiredLabels(state),
    state,
  };
}

export async function runRepairQueue({ env = process.env, api = defaultApi(), logger = console } = {}) {
  const repository = env.GITHUB_REPOSITORY || REPOSITORY;
  if (repository !== REPOSITORY) throw new Error(`Repair queue is bound to ${REPOSITORY}.`);
  const dryRun = env.DRY_RUN === 'true';
  const repairProgress = repairProgressFromEnvironment(env);
  const sourceRunId = sourceRunIdFromEnvironment(env);
  const run = await api.getRun(repository, sourceRunId);
  const pullRequestNumber = pullRequestNumberFromRun(run);
  const pullRequest = pullRequestNumber ? await api.getPullRequest(repository, pullRequestNumber) : undefined;
  const deliverySummary =
    run.path === '.github/workflows/delivery-v2.yml'
      ? await api.getDeliverySummary(repository, sourceRunId, run.head_sha)
      : undefined;
  const scope = validateSourceRun({ run, pullRequest, deliverySummary, repository });
  if (!scope.accepted) {
    const summary = summaryResult({ action: 'ignored', reason: scope.reason, run, sourceRunId, dryRun });
    publishSummary(summary, env, logger);
    return summary;
  }

  const jobs = await api.getJobs(repository, sourceRunId);
  const failedJob =
    run.conclusion === 'success' && deliverySummary?.terminalOutcome === 'superseded'
      ? {
          id: 0,
          name: `main supersession ${run.head_sha}`,
          conclusion: 'success',
          workflowPath: run.path,
        }
      : selectFailedJob(jobs, run.path);
  const failureClass = classifyFailure(run.path, failedJob.name, deliverySummary);
  const fingerprint = buildFailureFingerprint(run.path, failureClass.classification, failedJob.name);
  const incident = buildIncident({
    run,
    failedJob,
    failureClass,
    fingerprint,
    pullRequestNumber: scope.pullRequestNumber,
    deliverySummary,
  });

  const issues = await api.listRepairIssues(repository, MAX_ISSUES);
  const match = issues.find((issue) => String(issue.body || '').includes(repairFingerprintMarker(fingerprint)));
  const comments = match ? await api.listIssueComments(repository, issueNumber(match)) : [];
  const plan = repairProgress
    ? planRepairProgressSnapshot({ incident, issues, comments, progress: repairProgress })
    : planRepairIssue({ incident, issues, comments });

  let resultingIssueNumber = plan.issueNumber || 0;
  if (!dryRun && plan.action === 'create') {
    await api.ensureLabels(repository, plan.labels, LABELS);
    resultingIssueNumber = await api.createIssue(repository, plan.title, plan.body, plan.labels);
  } else if (!dryRun && ['append', 'record-progress'].includes(plan.action)) {
    await api.ensureLabels(repository, plan.labels, LABELS);
    if (plan.reopen) await api.reopenIssue(repository, plan.issueNumber);
    await api.addLabels(repository, plan.issueNumber, plan.labels);
    await api.commentIssue(repository, plan.issueNumber, plan.comment);
  }

  const summary = summaryResult({
    action:
      dryRun && ['create', 'append', 'record-progress'].includes(plan.action) ? `planned-${plan.action}` : plan.action,
    reason: plan.reason,
    run,
    sourceRunId,
    dryRun,
    failedJob,
    fingerprint,
    issueNumber: resultingIssueNumber,
    recurrenceCount: plan.state?.recurrenceCount || plan.recurrenceCount || 0,
    learning: plan.state?.learning,
  });
  publishSummary(summary, env, logger);
  return summary;
}

function buildIncident({ run, failedJob, failureClass, fingerprint, pullRequestNumber, deliverySummary }) {
  const workflow = TRUSTED_REPAIR_WORKFLOWS[run.path];
  const conclusion =
    run.conclusion === 'success' && deliverySummary?.terminalOutcome === 'superseded'
      ? 'superseded'
      : FAILURE_CONCLUSIONS.has(String(run.conclusion))
        ? String(run.conclusion)
        : 'failure';
  const jobName = sanitizeJobName(failedJob.name);
  const observableFailure = `${workflow.displayName} concluded ${conclusion} at ${jobName}.`;
  if (containsSensitiveText(observableFailure)) throw new Error('Generated observable failure was not public-safe.');
  return {
    schemaVersion: 1,
    repository: REPOSITORY,
    fingerprint,
    classification: failureClass.classification,
    severity: failureClass.severity,
    affectedArea: failureClass.affectedArea,
    workflowPath: run.path,
    workflowRunId: safeInteger(run.id),
    workflowRunUrl: `https://github.com/${REPOSITORY}/actions/runs/${safeInteger(run.id)}`,
    failedJob: jobName,
    failedJobId: safeInteger(failedJob.id),
    headSha: run.head_sha,
    pullRequest: safeInteger(pullRequestNumber),
    observableFailure,
    learningTriggers: [...failureClass.learningTriggers],
    recovery: sanitizeDeliveryRecovery(deliverySummary),
  };
}

export function sanitizeDeliveryRecovery(summary) {
  if (!isRecord(summary)) {
    return {
      state: 'not-reported',
      rollback: 'not-reported',
      terminalOutcome: 'incomplete',
      supersededBy: null,
      rollbackOccurred: 'unknown',
      candidateInProduction: 'unknown',
    };
  }
  const allowed = new Set(['failure', 'skipped', 'success', 'cancelled', 'not-reported', '']);
  const rollback = allowed.has(String(summary.rollback || '')) ? String(summary.rollback || 'not-reported') : 'invalid';
  const state = /^[a-z0-9._-]{0,80}$/.test(String(summary.recovery || ''))
    ? String(summary.recovery || 'not-reported')
    : 'invalid';
  const terminalOutcome = DELIVERY_TERMINAL_OUTCOMES.has(String(summary.terminalOutcome || ''))
    ? String(summary.terminalOutcome)
    : summary.schemaVersion === 1
      ? 'incomplete'
      : 'invalid';
  const supersededBy =
    summary.supersededBy === null || summary.supersededBy === undefined
      ? null
      : SHA_RE.test(String(summary.supersededBy))
        ? String(summary.supersededBy)
        : 'invalid';
  const production = String(summary.production || '');
  const rollbackOccurred = rollback === 'success' ? 'yes' : rollback === 'skipped' ? 'no' : 'unknown';
  let candidateInProduction = 'unknown';
  if (rollback === 'success' || state === 'production-unchanged' || terminalOutcome === 'not_applicable') {
    candidateInProduction = 'no';
  } else if (production === 'passed' || production === 'success' || state === 'failed-release-observed') {
    candidateInProduction = 'yes';
  }
  return {
    state,
    rollback,
    terminalOutcome,
    supersededBy,
    rollbackOccurred,
    candidateInProduction,
  };
}

export function isAcceptedDeliverySummary(summary, headSha) {
  if (!isRecord(summary) || !SHA_RE.test(String(headSha || '')) || summary.sha !== headSha) return false;
  if (summary.schemaVersion === 1) return true;
  if (summary.schemaVersion !== 2) return false;
  if (typeof summary.deploymentRequired !== 'boolean') return false;
  if (!DELIVERY_TERMINAL_OUTCOMES.has(String(summary.terminalOutcome || ''))) return false;
  if (
    !DELIVERY_VERIFICATION_RESULTS.has(String(summary.test || '')) ||
    !DELIVERY_VERIFICATION_RESULTS.has(String(summary.production || ''))
  ) {
    return false;
  }
  if (!isRecord(summary.rawJobs)) return false;
  const rawTest = String(summary.rawJobs.test || '');
  const rawProduction = String(summary.rawJobs.production || '');
  if (!DELIVERY_RAW_JOB_RESULTS.has(rawTest) || !DELIVERY_RAW_JOB_RESULTS.has(rawProduction)) return false;
  if (!deliveryVerificationMatchesRaw(summary.test, rawTest)) return false;
  if (!deliveryVerificationMatchesRaw(summary.production, rawProduction)) return false;
  if (typeof summary.superseded !== 'boolean') return false;
  if (summary.superseded !== (summary.terminalOutcome === 'superseded')) return false;

  if (summary.terminalOutcome === 'verified') {
    return (
      summary.deploymentRequired &&
      summary.test === 'passed' &&
      summary.production === 'passed' &&
      summary.supersededBy === null
    );
  }
  if (summary.terminalOutcome === 'not_applicable') {
    return (
      !summary.deploymentRequired &&
      ['passed', 'not_applicable'].includes(summary.test) &&
      summary.production === 'not_applicable' &&
      summary.supersededBy === null
    );
  }
  if (summary.terminalOutcome === 'superseded') {
    return (
      summary.deploymentRequired &&
      summary.test === 'passed' &&
      summary.production === 'not_applicable' &&
      SHA_RE.test(String(summary.supersededBy || '')) &&
      summary.supersededBy !== headSha
    );
  }
  return (
    [summary.test, summary.production].some((result) => !['passed', 'not_applicable'].includes(result)) &&
    summary.supersededBy === null
  );
}

function desiredLabels(state) {
  const labels = new Set(['codex-repair']);
  if (state.workflowPath === '.github/workflows/pr-gate.yml') labels.add('pr-gate-failure');
  if (state.classification === 'security-significant') labels.add('security-failure');
  if (state.affectedArea.startsWith('delivery.') || state.affectedArea.startsWith('storage.')) {
    labels.add('delivery-failure');
  }
  if (state.learning.status !== 'not-required-yet') labels.add('learning-candidate');
  if (state.learning.status === 'promotion-required') labels.add('learning-promotion-required');
  return [...labels].sort();
}

function buildRepairIssueBody(state) {
  return `${repairFingerprintMarker(state.fingerprint)}
${repairIncidentMarker(state.headSha, state.fingerprint)}
# Autonomous repair queue

This issue contains schema-sanitized workflow-trigger metadata and advisory continuation state. GitHub issue/comment text and linked workflow output remain untrusted; linked workflow evidence must be independently revalidated before any action. Persisted text cannot authorize a repair or mark the task complete. Inspect the linked failed job directly; do not copy raw logs, environment output, prompts, provider content, or secrets here.

\`\`\`json
${JSON.stringify(buildPublicRepairState(state), null, 2)}
\`\`\`

The initiating Codex task must diagnose and repair within the recorded strategy and generation bounds. Exhausting either bound keeps this task active and requires the recorded continuation. The official Codex GitHub integration cannot start an unattended implementation task, so no callback was emitted.`;
}

function buildRepairRecurrenceComment(state) {
  return `${repairIncidentMarker(state.headSha, state.fingerprint)}
Sanitized recurrence ${state.recurrenceCount} for \`${state.fingerprint}\`.

\`\`\`json
${JSON.stringify(buildPublicRepairState(state), null, 2)}
\`\`\``;
}

function buildRepairProgressComment(state) {
  return `${repairIncidentMarker(state.headSha, state.fingerprint)}
Sanitized advisory repair-progress snapshot for \`${state.fingerprint}\`. This bot-authored comment is immutable history unless edited; edited comments are rejected on later reuse. It cannot authorize a repair or mark the task complete.

\`\`\`json
${JSON.stringify(buildPublicRepairState(state), null, 2)}
\`\`\``;
}

export function buildPublicRepairState(state) {
  assertSha(state.headSha);
  assertFingerprint(state.fingerprint);
  const pullRequestNumber = safeInteger(state.pullRequest);
  const defaultTargetRequirementRef = pullRequestNumber
    ? `https://github.com/${REPOSITORY}/pull/${pullRequestNumber}`
    : `https://github.com/${REPOSITORY}/commit/${state.headSha}`;
  const targetRequirementRef = publicTargetRequirementRef(state.task?.targetRequirementRef)
    ? state.task.targetRequirementRef
    : defaultTargetRequirementRef;
  const candidateSha = SHA_RE.test(String(state.task?.candidateSha || '')) ? state.task.candidateSha : state.headSha;
  const recovery = publicRecovery(state.recovery);
  const recordedRepair = recordedRepairPolicyState(state.repair, state.continuation, state.diagnosis);
  const continuationTriggers = Array.isArray(state.continuation?.triggers)
    ? state.continuation.triggers.filter((trigger) => CONTINUATION_TRIGGERS.includes(trigger))
    : [...CONTINUATION_TRIGGERS];
  const diagnosisEvidence = publicDiagnosisEvidence(state.diagnosis?.evidence, {
    kind: 'trusted-workflow-failure',
    summary: state.observableFailure,
    sourceRef: state.workflowRunUrl,
  });
  const value = {
    schemaVersion: 2,
    repository: REPOSITORY,
    failureFingerprint: state.fingerprint,
    severity: state.severity,
    affectedArea: state.affectedArea,
    task: {
      status: 'active',
      targetRequirementRef,
      candidateSha,
      completionStatus: 'unverified',
    },
    trigger: {
      pullRequest: pullRequestNumber || null,
      headSha: state.headSha,
      workflowPath: state.workflowPath,
      workflowRunId: state.workflowRunId,
      workflowRunUrl: state.workflowRunUrl,
      failedJob: state.failedJob,
      failedJobId: state.failedJobId || null,
    },
    observableFailure: state.observableFailure,
    diagnosis: {
      version: safeInteger(state.diagnosis?.version),
      strategyFingerprint: STRATEGY_FINGERPRINT_RE.test(String(state.diagnosis?.strategyFingerprint || ''))
        ? state.diagnosis.strategyFingerprint
        : null,
      failureClassification:
        publicKeyOrNull(state.diagnosis?.failureClassification) ||
        publicKeyOrNull(state.classification) ||
        'unclassified',
      rootCauseHypothesisKey: publicKeyOrNull(state.diagnosis?.rootCauseHypothesisKey),
      rootCauseHypothesis: publicTextOrNull(state.diagnosis?.rootCauseHypothesis),
      evidence: diagnosisEvidence,
      discriminatingAction: publicTextOrNull(state.diagnosis?.discriminatingAction),
    },
    repair: {
      generation: recordedRepair.generation,
      status: recordedRepair.status,
      attempts: recordedRepair.attempts,
      strategyFingerprints: recordedRepair.strategyFingerprints,
      exhaustedStrategyFingerprints: recordedRepair.exhaustedStrategyFingerprints,
      policyDecision: recordedRepair.policyDecision,
      repairedPr: null,
      repairedSha: null,
      preventionPath: null,
    },
    continuation: {
      required: true,
      status: recordedRepair.continuationStatus,
      triggers: continuationTriggers.length > 0 ? [...new Set(continuationTriggers)] : [...CONTINUATION_TRIGGERS],
      blocker: publicTextOrNull(state.continuation?.blocker),
      expectedCandidateSha:
        SHA_RE.test(String(state.continuation?.expectedCandidateSha || '')) &&
        state.continuation.expectedCandidateSha !== candidateSha
          ? state.continuation.expectedCandidateSha
          : null,
      nextGeneration: recordedRepair.nextGeneration,
    },
    recurrenceCount: state.recurrenceCount,
    learning: state.learning,
    recovery,
    callback: CODEX_CALLBACK,
    repairBounds: REPAIR_BOUNDS,
    persistence: {
      authority: 'advisory',
      revalidationRequired: true,
      repairAuthorization: 'none',
    },
  };
  const serialized = JSON.stringify(value);
  if (containsSensitiveText(serialized)) throw new Error('Generated repair state was not public-safe.');
  if (Buffer.byteLength(serialized, 'utf8') > MAX_PUBLIC_STATE_BYTES) {
    throw new Error('Generated repair state exceeds its public size bound.');
  }
  return value;
}

function sourceRunIdFromEnvironment(env) {
  if (env.GITHUB_EVENT_NAME === 'workflow_run') {
    const event = readBoundedJson(env.GITHUB_EVENT_PATH, MAX_EVENT_BYTES);
    const runId = safeInteger(event.workflow_run?.id);
    if (!runId) throw new Error('workflow_run event did not contain a valid source run ID.');
    return runId;
  }
  const runId = safeInteger(env.SOURCE_RUN_ID);
  if (!runId) throw new Error('SOURCE_RUN_ID must be a positive workflow run ID.');
  return runId;
}

function pullRequestNumberFromRun(run) {
  if (run?.event !== 'pull_request') return 0;
  if (!Array.isArray(run.pull_requests) || run.pull_requests.length !== 1) return 0;
  return safeInteger(run.pull_requests[0]?.number);
}

function readBoundedJson(path, maxBytes) {
  if (!path) throw new Error('A JSON input path is required.');
  const stats = statSync(path);
  if (!stats.isFile() || stats.size > maxBytes) throw new Error('JSON input exceeds the trusted size bound.');
  return JSON.parse(readFileSync(path, 'utf8'));
}

function publishSummary(summary, env, logger) {
  const output = `${JSON.stringify(summary, null, 2)}\n`;
  if (env.REPAIR_SUMMARY_PATH) writeFileSync(env.REPAIR_SUMMARY_PATH, output);
  if (env.GITHUB_OUTPUT) {
    appendFileSync(env.GITHUB_OUTPUT, `action=${summary.action}\nissue_number=${summary.issueNumber || ''}\n`);
  }
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      [
        '### Repair and learning queue',
        `- Action: ${summary.action}`,
        `- Reason: ${summary.reason}`,
        `- Exact SHA: ${summary.headSha || 'not-applicable'}`,
        `- Fingerprint: ${summary.fingerprint || 'not-applicable'}`,
        `- Failed job: ${summary.failedJob || 'not-applicable'}`,
        `- Recurrence: ${summary.recurrenceCount || 0}`,
        `- Learning: ${summary.learningStatus || 'not-required-yet'}`,
        `- Callback: unsupported; no request emitted`,
        '',
      ].join('\n'),
    );
  }
  logger.log(output.trim());
}

function summaryResult({
  action,
  reason,
  run,
  sourceRunId,
  dryRun,
  failedJob,
  fingerprint,
  issueNumber = 0,
  recurrenceCount = 0,
  learning,
}) {
  return {
    schemaVersion: 1,
    action,
    reason,
    repository: REPOSITORY,
    sourceRunId: safeInteger(sourceRunId),
    workflowPath: TRUSTED_REPAIR_WORKFLOWS[run?.path] ? run.path : '',
    headSha: SHA_RE.test(String(run?.head_sha || '')) ? run.head_sha : '',
    fingerprint: fingerprint || '',
    failedJob: failedJob ? sanitizeJobName(failedJob.name) : '',
    issueNumber: safeInteger(issueNumber),
    recurrenceCount,
    learningStatus: learning?.status || 'not-required-yet',
    callbackSupported: false,
    callbackRequested: false,
    dryRun,
  };
}

function defaultApi() {
  return {
    async getRun(repository, runId) {
      return ghJson(['api', `repos/${repository}/actions/runs/${runId}`]);
    },
    async getJobs(repository, runId) {
      const response = ghJson(['api', `repos/${repository}/actions/runs/${runId}/jobs?filter=latest&per_page=100`]);
      if (!Array.isArray(response.jobs) || Number(response.total_count) > response.jobs.length) {
        throw new Error('Failed-job metadata was incomplete or malformed.');
      }
      return response.jobs;
    },
    async getPullRequest(repository, number) {
      return ghJson(['api', `repos/${repository}/pulls/${number}`]);
    },
    async listRepairIssues(repository, limit) {
      const issues = ghJson([
        'issue',
        'list',
        '--repo',
        repository,
        '--label',
        'codex-repair',
        '--state',
        'all',
        '--limit',
        String(limit),
        '--json',
        'number,title,body,url,state,labels,author,createdAt,updatedAt',
      ]);
      if (!Array.isArray(issues) || issues.length >= limit) {
        throw new Error('Repair issue enumeration reached its fail-closed bound.');
      }
      return issues;
    },
    async listIssueComments(repository, number) {
      const pages = ghJson([
        'api',
        '--paginate',
        '--slurp',
        `repos/${repository}/issues/${number}/comments?per_page=100`,
      ]);
      return Array.isArray(pages) ? pages.flat() : [];
    },
    async ensureLabels(repository, names, definitions) {
      const existing = new Set(
        ghJson(['label', 'list', '--repo', repository, '--limit', '1000', '--json', 'name']).map((label) => label.name),
      );
      for (const name of names) {
        if (existing.has(name)) continue;
        const definition = definitions[name];
        if (!definition) throw new Error(`Unknown repair label: ${name}`);
        gh([
          'label',
          'create',
          name,
          '--repo',
          repository,
          '--color',
          definition.color,
          '--description',
          definition.description,
        ]);
      }
    },
    async createIssue(repository, title, body, labels) {
      const args = ['issue', 'create', '--repo', repository, '--title', title, '--body', body];
      for (const label of labels) args.push('--label', label);
      const output = gh(args).trim();
      const match = output.match(/\/issues\/(\d+)$/);
      if (!match) throw new Error('GitHub did not return a created repair issue number.');
      return Number(match[1]);
    },
    async reopenIssue(repository, number) {
      gh(['issue', 'reopen', String(number), '--repo', repository]);
    },
    async addLabels(repository, number, labels) {
      const args = ['issue', 'edit', String(number), '--repo', repository];
      for (const label of labels) args.push('--add-label', label);
      gh(args);
    },
    async commentIssue(repository, number, body) {
      gh(['issue', 'comment', String(number), '--repo', repository, '--body', body]);
    },
    async getDeliverySummary(repository, runId, headSha) {
      const directory = mkdtempSync(join(tmpdir(), 'juez-delivery-summary-'));
      try {
        const name = `delivery-summary-${headSha}-${runId}`;
        const completed = spawnSync(
          'gh',
          ['run', 'download', String(runId), '--repo', repository, '--name', name, '--dir', directory],
          { encoding: 'utf8', maxBuffer: 1024 * 1024 },
        );
        if (completed.status !== 0) return undefined;
        const files = walkFiles(directory).filter((path) => path.endsWith('delivery-summary.json'));
        if (files.length !== 1) return undefined;
        const summary = readBoundedJson(files[0], MAX_SUMMARY_BYTES);
        if (!isAcceptedDeliverySummary(summary, headSha)) return undefined;
        return summary;
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  };
}

function ghJson(args) {
  return JSON.parse(gh(args));
}

function gh(args) {
  const completed = spawnSync('gh', args, {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    env: process.env,
  });
  if (completed.status !== 0) {
    throw new Error(`GitHub command failed (${args.slice(0, 3).join(' ')}): ${String(completed.stderr || '').trim()}`);
  }
  return completed.stdout;
}

function walkFiles(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? walkFiles(path) : [path];
  });
}

function failure(classification, severity, affectedArea, learningTriggers = []) {
  return { classification, severity, affectedArea, learningTriggers };
}

function ignored(reason) {
  return { accepted: false, reason };
}

function safeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function issueNumber(issue) {
  return safeInteger(issue?.number);
}

function isBotAuthor(author) {
  return BOT_LOGINS.has(String(author?.login || ''));
}

function reusableBotSnapshotSource(source, comment) {
  if (!source || !isBotAuthor(source.user || source.author)) return false;
  if (!comment) return true;
  const createdAt = source.created_at || source.createdAt;
  const updatedAt = source.updated_at || source.updatedAt;
  return !createdAt || !updatedAt || createdAt === updatedAt;
}

function immutableProgressSnapshotSource(source, comment, fingerprint) {
  if (!comment || !source) return false;
  const createdAt = source.created_at || source.createdAt;
  const updatedAt = source.updated_at || source.updatedAt;
  return (
    Boolean(createdAt) &&
    createdAt === updatedAt &&
    String(source.body || '').includes(`Sanitized advisory repair-progress snapshot for \`${fingerprint}\`.`)
  );
}

function assertSha(value) {
  if (!SHA_RE.test(String(value || ''))) throw new Error('A full lowercase exact SHA is required.');
}

function assertFingerprint(value) {
  if (!FINGERPRINT_RE.test(String(value || '')) || String(value).length > 160) {
    throw new Error('A normalized failure fingerprint is required.');
  }
}

function strategyKey(value, name) {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  if (!FINGERPRINT_RE.test(normalized) || normalized.length > 96) {
    throw new Error(`${name} must be a stable normalized strategy key.`);
  }
  return normalized;
}

function rediagnosisBindingFailures({
  rediagnosis,
  proposedStrategy,
  strategyFingerprint,
  requiredRediagnosisVersion,
  priorRootCauseHypothesisKey,
  requireMateriallyDifferentHypothesis,
}) {
  const failures = [];
  if (safeInteger(rediagnosis.version) !== requiredRediagnosisVersion) failures.push('version');
  if (rediagnosis.strategyFingerprint !== strategyFingerprint) failures.push('strategyFingerprint');
  if (
    publicKeyOrNull(rediagnosis.failureClassification) !== strategyKey(proposedStrategy.failureClass, 'failureClass')
  ) {
    failures.push('failureClassification');
  }
  if (
    publicKeyOrNull(rediagnosis.rootCauseHypothesisKey) !==
    strategyKey(proposedStrategy.rootCauseHypothesis, 'rootCauseHypothesis')
  ) {
    failures.push('rootCauseHypothesisKey');
  }
  if (
    requireMateriallyDifferentHypothesis &&
    (!publicKeyOrNull(priorRootCauseHypothesisKey) ||
      publicKeyOrNull(priorRootCauseHypothesisKey) ===
        strategyKey(proposedStrategy.rootCauseHypothesis, 'rootCauseHypothesis')) &&
    !failures.includes('rootCauseHypothesisKey')
  ) {
    failures.push('rootCauseHypothesisKey');
  }
  if (!nonEmptyPublicText(rediagnosis.discriminatingAction)) failures.push('discriminatingAction');
  return failures;
}

function validateRepairAttempts(attempts) {
  if (!Array.isArray(attempts)) throw new Error('Repair attempts must be an array.');
  if (attempts.length > MAX_REPAIR_ATTEMPTS) throw new Error('Repair attempt history exceeds its bound.');
  for (const attempt of attempts) {
    if (!isRecord(attempt)) throw new Error('Each repair attempt must be an object.');
    if (!STRATEGY_FINGERPRINT_RE.test(String(attempt.strategyFingerprint || ''))) {
      throw new Error('Each repair attempt must use a strategy fingerprint.');
    }
    if (!REPAIR_ATTEMPT_OUTCOMES.has(attempt.outcome)) {
      throw new Error('Repair attempt outcome must be effective, ineffective, or in-progress.');
    }
  }
}

function validateExhaustedStrategyFingerprints(value) {
  if (!Array.isArray(value)) throw new Error('Exhausted strategy history must be an array.');
  if (value.length > MAX_STRATEGY_FINGERPRINTS) {
    throw new Error('Exhausted strategy history exceeds its bound.');
  }
  for (const fingerprint of value) {
    if (!STRATEGY_FINGERPRINT_RE.test(String(fingerprint || ''))) {
      throw new Error('Exhausted strategy history must contain only strategy fingerprints.');
    }
  }
}

function summarizeRepairAttemptHistory(attempts, priorExhaustedStrategyFingerprints = []) {
  validateRepairAttempts(attempts);
  validateExhaustedStrategyFingerprints(priorExhaustedStrategyFingerprints);
  const ineffectiveByStrategy = new Map();
  for (const attempt of attempts) {
    if (attempt.outcome !== 'ineffective') continue;
    ineffectiveByStrategy.set(
      attempt.strategyFingerprint,
      (ineffectiveByStrategy.get(attempt.strategyFingerprint) || 0) + 1,
    );
  }
  const exhaustedStrategyFingerprints = new Set(priorExhaustedStrategyFingerprints);
  for (const [fingerprint, count] of ineffectiveByStrategy) {
    if (count >= REPAIR_BOUNDS.maxAttemptsPerStrategy) exhaustedStrategyFingerprints.add(fingerprint);
  }
  if (exhaustedStrategyFingerprints.size > MAX_STRATEGY_FINGERPRINTS) {
    throw new Error('Exhausted strategy history exceeds its bound.');
  }
  return { exhaustedStrategyFingerprints: [...exhaustedStrategyFingerprints].sort() };
}

function nonEmptyPublicText(value) {
  return typeof value === 'string' && value.trim().length > 0 && !containsSensitiveText(value);
}

function deliveryVerificationMatchesRaw(verification, rawResult) {
  if (verification === 'not_applicable') return rawResult === 'skipped';
  return verification === (rawResult === 'success' ? 'passed' : rawResult);
}

function publicRepairAttempts(value, defaultGeneration) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_REPAIR_ATTEMPTS).flatMap((attempt, index) => {
    if (
      !isRecord(attempt) ||
      !STRATEGY_FINGERPRINT_RE.test(String(attempt.strategyFingerprint || '')) ||
      !REPAIR_ATTEMPT_OUTCOMES.has(attempt.outcome)
    ) {
      return [];
    }
    return [
      {
        number: safeInteger(attempt.number) || index + 1,
        generation: safeInteger(attempt.generation) || defaultGeneration,
        strategyFingerprint: attempt.strategyFingerprint,
        outcome: attempt.outcome,
        candidateSha: SHA_RE.test(String(attempt.candidateSha || '')) ? attempt.candidateSha : null,
      },
    ];
  });
}

function publicStrategyFingerprints(value, fallback = []) {
  const supplied = [...(Array.isArray(value) ? value : []), ...fallback];
  return [...new Set(supplied.filter((fingerprint) => STRATEGY_FINGERPRINT_RE.test(String(fingerprint || ''))))].slice(
    0,
    MAX_STRATEGY_FINGERPRINTS,
  );
}

function recordedRepairPolicyState(repair, continuation, diagnosis) {
  const generation = safeInteger(repair?.generation) || 1;
  const attempts = publicRepairAttempts(repair?.attempts, generation);
  const currentGenerationAttempts = attempts.filter((attempt) => attempt.generation === generation);
  const priorExhaustedStrategyFingerprints = publicStrategyFingerprints(repair?.exhaustedStrategyFingerprints);
  const { exhaustedStrategyFingerprints } = summarizeRepairAttemptHistory(
    currentGenerationAttempts,
    priorExhaustedStrategyFingerprints,
  );
  const strategyFingerprints = publicStrategyFingerprints(repair?.strategyFingerprints, [
    ...attempts.map((attempt) => attempt.strategyFingerprint),
    ...exhaustedStrategyFingerprints,
  ]);
  const attemptsInGeneration = currentGenerationAttempts.length;
  const generationExhausted = attemptsInGeneration >= REPAIR_BOUNDS.maxAttemptsPerRepairGeneration;
  const blocker = publicTextOrNull(continuation?.blocker);
  const missingRediagnosis = REDIAGNOSIS_FIELDS.filter((field) => {
    if (field === 'version') return !safeInteger(diagnosis?.version);
    if (field === 'strategyFingerprint') {
      return !STRATEGY_FINGERPRINT_RE.test(String(diagnosis?.strategyFingerprint || ''));
    }
    if (['failureClassification', 'rootCauseHypothesisKey'].includes(field)) {
      return !publicKeyOrNull(diagnosis?.[field]);
    }
    return !publicTextOrNull(diagnosis?.[field]);
  });
  const policyAction = generationExhausted
    ? 'continue-next-generation'
    : exhaustedStrategyFingerprints.length > 0
      ? missingRediagnosis.length > 0
        ? 'rediagnose-before-different-strategy'
        : 'await-materially-different-strategy'
      : 'await-strategy';
  const status = generationExhausted
    ? 'generation-exhausted'
    : attempts.length > 0
      ? 'active'
      : ['queued', 'blocked'].includes(repair?.status)
        ? repair.status
        : 'queued';
  const continuationStatus = blocker
    ? 'blocked'
    : generationExhausted
      ? 'next-generation'
      : exhaustedStrategyFingerprints.length > 0
        ? 'waiting'
        : ['queued', 'waiting', 'next-generation'].includes(continuation?.status)
          ? continuation.status
          : 'queued';
  return {
    generation,
    status,
    attempts,
    strategyFingerprints,
    exhaustedStrategyFingerprints,
    continuationStatus,
    nextGeneration: {
      pending: generationExhausted,
      fromGeneration: generationExhausted ? generation : null,
      targetGeneration: generationExhausted ? generation + 1 : null,
      automatic: false,
    },
    policyDecision: {
      action: policyAction,
      authorization: 'none',
      attemptsInGeneration,
      remainingAttemptsInGeneration: Math.max(0, REPAIR_BOUNDS.maxAttemptsPerRepairGeneration - attemptsInGeneration),
      requiredRediagnosis: exhaustedStrategyFingerprints.length > 0 ? [...REDIAGNOSIS_FIELDS] : [],
      missingRediagnosis: exhaustedStrategyFingerprints.length > 0 ? missingRediagnosis : [],
    },
  };
}

function publicTextOrNull(value) {
  if (!nonEmptyPublicText(value)) return null;
  const normalized = [...value]
    .map((character) => (character.codePointAt(0) <= 31 || character.codePointAt(0) === 127 ? ' ' : character))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized ? normalized.slice(0, 500) : null;
}

function publicKeyOrNull(value) {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  return FINGERPRINT_RE.test(normalized) && normalized.length <= 96 ? normalized : null;
}

function publicDiagnosisEvidence(value, fallback) {
  const supplied = Array.isArray(value) ? value : [];
  const evidence = supplied.slice(0, 20).flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const kind = publicKeyOrNull(entry.kind);
    const summary = publicTextOrNull(entry.summary);
    const sourceRef = publicTextOrNull(entry.sourceRef);
    if (!kind || (!summary && !sourceRef)) return [];
    return [{ kind, summary, sourceRef }];
  });
  if (evidence.length > 0) return evidence;
  return [
    {
      kind: fallback.kind,
      summary: publicTextOrNull(fallback.summary),
      sourceRef: publicTextOrNull(fallback.sourceRef),
    },
  ];
}

function publicRecovery(value) {
  const state = /^[a-z0-9._-]{1,80}$/.test(String(value?.state || '')) ? value.state : 'not-reported';
  const rollback = ['success', 'failure', 'cancelled', 'skipped', 'not-reported', 'invalid'].includes(value?.rollback)
    ? value.rollback
    : 'not-reported';
  const terminalOutcome = [...DELIVERY_TERMINAL_OUTCOMES, 'invalid'].includes(value?.terminalOutcome)
    ? value.terminalOutcome
    : 'incomplete';
  const supersededBy = SHA_RE.test(String(value?.supersededBy || '')) ? value.supersededBy : null;
  const rollbackOccurred = ['yes', 'no', 'unknown'].includes(value?.rollbackOccurred)
    ? value.rollbackOccurred
    : 'unknown';
  const candidateInProduction = ['yes', 'no', 'unknown'].includes(value?.candidateInProduction)
    ? value.candidateInProduction
    : 'unknown';
  return { state, rollback, terminalOutcome, supersededBy, rollbackOccurred, candidateInProduction };
}

function publicTargetRequirementRef(value) {
  return new RegExp(
    `^https://github\\.com/${REPOSITORY.replace('/', '\\/')}/(?:pull/[1-9][0-9]*|commit/[0-9a-f]{40})$`,
  ).test(String(value || ''));
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runRepairQueue();
}
