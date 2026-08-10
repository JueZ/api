import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  buildFailureFingerprint,
  classifyFailure,
  CODEX_CALLBACK,
  containsSensitiveText,
  learningDecision,
  planRepairIssue,
  REPAIR_BOUNDS,
  repairFingerprintMarker,
  repairIncidentMarker,
  runRepairQueue,
  sanitizeJobName,
  selectFailedJob,
  validateSourceRun,
} from '../triage-repair-issues.mjs';

const REPOSITORY = 'JueZ/api';
const HEAD_SHA = 'a'.repeat(40);
const NEXT_SHA = 'b'.repeat(40);
const WORKFLOW = '.github/workflows/pr-gate.yml';

function run(overrides = {}) {
  return {
    id: 101,
    path: WORKFLOW,
    event: 'pull_request',
    conclusion: 'failure',
    head_sha: HEAD_SHA,
    head_branch: 'codex/fix-gate',
    repository: { full_name: REPOSITORY },
    pull_requests: [{ number: 42 }],
    ...overrides,
  };
}

function pullRequest(overrides = {}) {
  return {
    number: 42,
    state: 'open',
    base: { ref: 'main' },
    head: { ref: 'codex/fix-gate', sha: HEAD_SHA, repo: { full_name: REPOSITORY } },
    ...overrides,
  };
}

function incident(overrides = {}) {
  return {
    schemaVersion: 1,
    repository: REPOSITORY,
    fingerprint: 'pr-gate.candidate-code.backend-and-contracts',
    classification: 'candidate-code',
    severity: 'medium',
    affectedArea: 'pull-request.backend-and-contracts',
    workflowPath: WORKFLOW,
    workflowRunId: 101,
    workflowRunUrl: `https://github.com/${REPOSITORY}/actions/runs/101`,
    failedJob: 'backend and contracts',
    failedJobId: 202,
    headSha: HEAD_SHA,
    pullRequest: 42,
    observableFailure: 'PR Gate concluded failure at backend and contracts.',
    learningTriggers: [],
    recovery: { state: 'not-reported', rollback: 'not-reported' },
    ...overrides,
  };
}

test('repair bounds and callback limitation are explicit and finite', () => {
  assert.deepEqual(REPAIR_BOUNDS, {
    maxCommitsPerPullRequest: 3,
    repeatedFingerprintStop: 2,
    externalReruns: 1,
  });
  assert.equal(CODEX_CALLBACK.supported, false);
  assert.equal(CODEX_CALLBACK.requested, false);
});

test('exact-head binding accepts only open same-repository codex pull requests', () => {
  assert.equal(validateSourceRun({ run: run(), pullRequest: pullRequest() }).accepted, true);
  assert.equal(
    validateSourceRun({ run: run(), pullRequest: pullRequest({ head: { ...pullRequest().head, sha: NEXT_SHA } }) })
      .reason,
    'stale-pull-request-head',
  );
  assert.equal(
    validateSourceRun({
      run: run(),
      pullRequest: pullRequest({ head: { ref: 'codex/fork', sha: HEAD_SHA, repo: { full_name: 'fork/api' } } }),
    }).reason,
    'pull-request-fork-denied',
  );
  assert.equal(
    validateSourceRun({
      run: run(),
      pullRequest: pullRequest({ head: { ref: 'feature/human', sha: HEAD_SHA, repo: { full_name: REPOSITORY } } }),
    }).reason,
    'pull-request-branch-not-codex',
  );
});

test('protected-main failures require an allowlisted workflow and main identity', () => {
  const delivery = run({
    path: '.github/workflows/delivery-v2.yml',
    event: 'push',
    head_branch: 'main',
    pull_requests: [],
  });
  assert.equal(validateSourceRun({ run: delivery }).scope, 'protected-main');
  assert.equal(
    validateSourceRun({ run: { ...delivery, head_branch: 'feature' } }).reason,
    'trusted-workflow-not-on-main',
  );
  assert.equal(
    validateSourceRun({ run: { ...delivery, path: '.github/workflows/untrusted.yml' } }).reason,
    'workflow-not-allowlisted',
  );
});

test('causal failed job selection does not treat the aggregate as the root failure', () => {
  const selected = selectFailedJob(
    [
      { id: 1, name: 'PR Gate', conclusion: 'failure' },
      { id: 2, name: 'backend and contracts', conclusion: 'failure' },
    ],
    WORKFLOW,
  );
  assert.deepEqual(selected, {
    id: 2,
    name: 'backend and contracts',
    conclusion: 'failure',
    workflowPath: WORKFLOW,
  });
  const classification = classifyFailure(WORKFLOW, selected.name);
  assert.equal(classification.classification, 'candidate-code');
  assert.equal(
    buildFailureFingerprint(WORKFLOW, classification.classification, selected.name),
    'pr-gate.candidate-code.backend-and-contracts',
  );
});

test('untrusted job names are sanitized and secret-shaped content is never copied', () => {
  const secret = ['github_pat_', 'synthetic123456789'].join('');
  assert.equal(containsSensitiveText(`Authorization=${secret}`), true);
  assert.equal(sanitizeJobName(`backend ${secret}`), 'redacted-job');
  const plan = planRepairIssue({ incident: incident({ failedJob: sanitizeJobName(secret) }) });
  assert.equal(plan.action, 'create');
  assert.doesNotMatch(plan.body, new RegExp(secret));
  assert.doesNotMatch(plan.body, /raw stack|environment dump|prompt text/i);
  assert.match(plan.body, /sanitized trusted metadata only/i);
});

test('same exact head and fingerprint deduplicates without another callback or issue', () => {
  const value = incident();
  const issue = {
    number: 9,
    state: 'OPEN',
    author: { login: 'github-actions[bot]' },
    body: `${repairFingerprintMarker(value.fingerprint)}\n${repairIncidentMarker(value.headSha, value.fingerprint)}`,
  };
  const plan = planRepairIssue({ incident: value, issues: [issue] });
  assert.equal(plan.action, 'deduplicated');
  assert.equal(plan.reason, 'exact-head-and-fingerprint-already-recorded');
  assert.equal(plan.issueNumber, 9);
});

test('new exact head increments recurrence and objectively requires learning promotion', () => {
  const value = incident({ headSha: NEXT_SHA });
  const issue = {
    number: 9,
    state: 'CLOSED',
    author: { login: 'github-actions[bot]' },
    body: `${repairFingerprintMarker(value.fingerprint)}\n${repairIncidentMarker(HEAD_SHA, value.fingerprint)}`,
  };
  const plan = planRepairIssue({ incident: value, issues: [issue] });
  assert.equal(plan.action, 'append');
  assert.equal(plan.reopen, true);
  assert.equal(plan.state.recurrenceCount, 2);
  assert.equal(plan.state.learning.status, 'promotion-required');
  assert.ok(plan.labels.includes('learning-promotion-required'));
});

test('production rollback requires promotion on its first occurrence', () => {
  assert.deepEqual(
    learningDecision({
      classification: 'production-regression',
      severity: 'critical',
      recurrenceCount: 1,
      learningTriggers: ['production-rollback'],
    }),
    {
      status: 'promotion-required',
      severity: 'critical',
      triggers: ['production-rollback'],
      recurrenceCount: 1,
    },
  );
});

test('duplicate repair issues fail closed instead of multiplying queue mutations', () => {
  const value = incident();
  const marker = repairFingerprintMarker(value.fingerprint);
  const plan = planRepairIssue({
    incident: value,
    issues: [
      { number: 7, body: marker },
      { number: 8, body: marker },
    ],
  });
  assert.equal(plan.action, 'blocked');
  assert.deepEqual(plan.issueNumbers, [7, 8]);
});

test('queue runtime is idempotent and mutates only the planned issue surface', async () => {
  const mutations = [];
  const api = {
    async getRun() {
      return run();
    },
    async getPullRequest() {
      return pullRequest();
    },
    async getJobs() {
      return [{ id: 202, name: 'backend and contracts', conclusion: 'failure' }];
    },
    async listRepairIssues() {
      return [];
    },
    async listIssueComments() {
      throw new Error('comments are not needed for a new fingerprint');
    },
    async ensureLabels(_repository, labels) {
      mutations.push(['labels', labels]);
    },
    async createIssue(_repository, title, body, labels) {
      mutations.push(['create', title, body, labels]);
      return 77;
    },
  };
  const result = await runRepairQueue({
    api,
    env: { GITHUB_REPOSITORY: REPOSITORY, SOURCE_RUN_ID: '101', DRY_RUN: 'false' },
    logger: { log() {} },
  });
  assert.equal(result.action, 'create');
  assert.equal(result.issueNumber, 77);
  assert.deepEqual(
    mutations.map(([action]) => action),
    ['labels', 'create'],
  );
});

test('workflow callback is bounded, trusted-main checked out, and cannot self-trigger', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/repair-triage.yml', import.meta.url), 'utf8');
  assert.match(workflow, /^name: Repair and Learning Queue/m);
  assert.match(workflow, /ref: main/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /retention-days: 30/);
  assert.doesNotMatch(workflow, /schedule:/);
  assert.doesNotMatch(workflow, /cache:\s*false|npm ci/);
  assert.doesNotMatch(workflow, /Repair and Learning Queue\n\s+-/);
  assert.doesNotMatch(workflow, /secrets:\s*inherit|OPENAI_API_KEY|@codex/i);
});
