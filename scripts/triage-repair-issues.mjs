#!/usr/bin/env node
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

export const REPAIR_BOUNDS = Object.freeze({
  maxCommitsPerPullRequest: 3,
  repeatedFingerprintStop: 2,
  externalReruns: 1,
});

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
  '.github/workflows/prepare-production-private-storage.yml': Object.freeze({
    key: 'production-private-storage',
    displayName: 'Prepare Production Private Storage',
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

export function validateSourceRun({ run, pullRequest, repository = REPOSITORY }) {
  if (!isRecord(run)) return ignored('workflow-run-metadata-missing');
  if (repository !== REPOSITORY || run.repository?.full_name !== REPOSITORY) return ignored('repository-mismatch');
  const workflow = TRUSTED_REPAIR_WORKFLOWS[run.path];
  if (!workflow) return ignored('workflow-not-allowlisted');
  if (!SHA_RE.test(String(run.head_sha || ''))) return ignored('invalid-exact-head');
  if (!FAILURE_CONCLUSIONS.has(String(run.conclusion || ''))) return ignored('workflow-did-not-fail');

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

export function learningDecision({ classification, severity, recurrenceCount, learningTriggers = [] }) {
  const triggers = new Set(learningTriggers.filter((value) => typeof value === 'string' && value.length <= 80));
  const significant =
    triggers.size > 0 ||
    ['deployment-failure', 'production-recovery-failure', 'production-regression', 'security-significant'].includes(
      classification,
    );
  if (recurrenceCount >= REPAIR_BOUNDS.repeatedFingerprintStop) triggers.add('recurrence-threshold');
  const promotionRequired =
    triggers.has('production-rollback') || recurrenceCount >= REPAIR_BOUNDS.repeatedFingerprintStop;
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
  const trustedMarkers = new Set();
  if (issue && isBotAuthor(issue.author)) {
    for (const value of extractIncidentMarkers(issue.body)) trustedMarkers.add(value);
  }
  for (const comment of comments) {
    if (!isBotAuthor(comment.user || comment.author)) continue;
    for (const value of extractIncidentMarkers(comment.body)) trustedMarkers.add(value);
  }

  const incidentMarker = repairIncidentMarker(incident.headSha, incident.fingerprint);
  if (trustedMarkers.has(incidentMarker)) {
    return {
      action: 'deduplicated',
      reason: 'exact-head-and-fingerprint-already-recorded',
      incident,
      issueNumber: issueNumber(issue),
      recurrenceCount: trustedMarkers.size,
    };
  }

  const recurrenceCount = trustedMarkers.size + 1;
  const learning = learningDecision({
    classification: incident.classification,
    severity: incident.severity,
    recurrenceCount,
    learningTriggers: incident.learningTriggers,
  });
  const state = { ...incident, recurrenceCount, learning, callback: CODEX_CALLBACK, repairBounds: REPAIR_BOUNDS };
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

export async function runRepairQueue({ env = process.env, api = defaultApi(), logger = console } = {}) {
  const repository = env.GITHUB_REPOSITORY || REPOSITORY;
  if (repository !== REPOSITORY) throw new Error(`Repair queue is bound to ${REPOSITORY}.`);
  const dryRun = env.DRY_RUN === 'true';
  const sourceRunId = sourceRunIdFromEnvironment(env);
  const run = await api.getRun(repository, sourceRunId);
  const pullRequestNumber = pullRequestNumberFromRun(run);
  const pullRequest = pullRequestNumber ? await api.getPullRequest(repository, pullRequestNumber) : undefined;
  const scope = validateSourceRun({ run, pullRequest, repository });
  if (!scope.accepted) {
    const summary = summaryResult({ action: 'ignored', reason: scope.reason, run, sourceRunId, dryRun });
    publishSummary(summary, env, logger);
    return summary;
  }

  const jobs = await api.getJobs(repository, sourceRunId);
  const failedJob = selectFailedJob(jobs, run.path);
  const deliverySummary =
    run.path === '.github/workflows/delivery-v2.yml'
      ? await api.getDeliverySummary(repository, sourceRunId, run.head_sha)
      : undefined;
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
  const plan = planRepairIssue({ incident, issues, comments });

  let resultingIssueNumber = plan.issueNumber || 0;
  if (!dryRun && plan.action === 'create') {
    await api.ensureLabels(repository, plan.labels, LABELS);
    resultingIssueNumber = await api.createIssue(repository, plan.title, plan.body, plan.labels);
  } else if (!dryRun && plan.action === 'append') {
    await api.ensureLabels(repository, plan.labels, LABELS);
    if (plan.reopen) await api.reopenIssue(repository, plan.issueNumber);
    await api.addLabels(repository, plan.issueNumber, plan.labels);
    await api.commentIssue(repository, plan.issueNumber, plan.comment);
  }

  const summary = summaryResult({
    action: dryRun && ['create', 'append'].includes(plan.action) ? `planned-${plan.action}` : plan.action,
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
  const conclusion = FAILURE_CONCLUSIONS.has(String(run.conclusion)) ? String(run.conclusion) : 'failure';
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
    recovery: sanitizedRecovery(deliverySummary),
  };
}

function sanitizedRecovery(summary) {
  if (!isRecord(summary)) return { state: 'not-reported', rollback: 'not-reported' };
  const allowed = new Set(['failure', 'skipped', 'success', 'cancelled', 'not-reported', '']);
  const rollback = allowed.has(String(summary.rollback || '')) ? String(summary.rollback || 'not-reported') : 'invalid';
  const state = /^[a-z0-9._-]{0,80}$/.test(String(summary.recovery || ''))
    ? String(summary.recovery || 'not-reported')
    : 'invalid';
  return { state, rollback };
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

This issue contains sanitized trusted metadata only. Inspect the linked failed job directly; do not copy raw logs, environment output, prompts, provider content, or secrets here.

\`\`\`json
${JSON.stringify(publicState(state), null, 2)}
\`\`\`

The initiating Codex task must diagnose and repair within the recorded bounds. The official Codex GitHub integration cannot start an unattended implementation task, so no callback was emitted.`;
}

function buildRepairRecurrenceComment(state) {
  return `${repairIncidentMarker(state.headSha, state.fingerprint)}
Sanitized recurrence ${state.recurrenceCount} for \`${state.fingerprint}\`.

\`\`\`json
${JSON.stringify(publicState(state), null, 2)}
\`\`\``;
}

function publicState(state) {
  const value = {
    schemaVersion: 1,
    repository: state.repository,
    fingerprint: state.fingerprint,
    severity: state.severity,
    affectedArea: state.affectedArea,
    classification: state.classification,
    trigger: {
      pullRequest: state.pullRequest || null,
      headSha: state.headSha,
      workflowPath: state.workflowPath,
      workflowRunId: state.workflowRunId,
      workflowRunUrl: state.workflowRunUrl,
      failedJob: state.failedJob,
      failedJobId: state.failedJobId || null,
    },
    observableFailure: state.observableFailure,
    rootCause: null,
    repair: {
      status: 'queued',
      repairedPr: null,
      repairedSha: null,
      preventionPath: null,
    },
    recurrenceCount: state.recurrenceCount,
    learning: state.learning,
    recovery: state.recovery,
    callback: state.callback,
    repairBounds: state.repairBounds,
  };
  const serialized = JSON.stringify(value);
  if (containsSensitiveText(serialized)) throw new Error('Generated repair state was not public-safe.');
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
        'number,title,body,url,state,labels,author',
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
        if (summary.schemaVersion !== 1 || summary.sha !== headSha) return undefined;
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

function assertSha(value) {
  if (!SHA_RE.test(String(value || ''))) throw new Error('A full lowercase exact SHA is required.');
}

function assertFingerprint(value) {
  if (!FINGERPRINT_RE.test(String(value || '')) || String(value).length > 160) {
    throw new Error('A normalized failure fingerprint is required.');
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runRepairQueue();
}
