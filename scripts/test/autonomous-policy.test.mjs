import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  classifyRisk,
  isAutomergeCandidate,
  loadAutonomousPolicy,
  matchesPolicyGlob,
  validateAutonomousPolicy,
} from '../lib/autonomous-policy.mjs';
import {
  evaluatePullRequestState,
  evaluateRequiredChecks,
  mergeGateDecision,
  runReview,
  validateAutonomousReview,
} from '../autonomous-merge-controller.mjs';

const headSha = 'a'.repeat(40);
const policy = loadAutonomousPolicy();

function pullRequest(overrides = {}) {
  return {
    state: 'open',
    draft: false,
    mergeable: true,
    mergeable_state: 'clean',
    labels: [],
    head: { ref: 'codex/example', sha: headSha, repo: { full_name: 'JueZ/api' } },
    base: { ref: 'main', repo: { full_name: 'JueZ/api' } },
    ...overrides,
  };
}

function successfulChecks() {
  return policy.requiredChecks.map((required, index) => ({
    id: index + 1,
    name: required.name,
    head_sha: headSha,
    status: 'completed',
    conclusion: 'success',
    app: { slug: required.appSlug },
  }));
}

test('canonical autonomous policy is internally valid', () => {
  assert.deepEqual(validateAutonomousPolicy(policy), []);
  assert.equal(policy.merge.allowAdminBypass, false);
  assert.equal(policy.autonomousReview.humanApprovalRequired, false);
  assert.ok(policy.autonomousReview.maxDiffBytes >= 1_200_000);
});

test('policy glob matcher handles recursive and exact AGENTS paths', () => {
  assert.equal(matchesPolicyGlob('apps/api/src/mcp/server.ts', 'apps/api/src/mcp/**'), true);
  assert.equal(matchesPolicyGlob('apps/api/AGENTS.md', '**/AGENTS.md'), true);
  assert.equal(matchesPolicyGlob('README.md', '**/AGENTS.md'), false);
});

test('risk classification covers workflow, MCP, Bring, contracts, and agent skills', () => {
  const paths = [
    '.github/workflows/ci.yml',
    'apps/api/src/mcp/server.ts',
    'apps/api/src/shared/bring/client.ts',
    'contracts/openapi.yaml',
    '.agents/skills/example/SKILL.md',
  ];
  const risk = classifyRisk(paths, policy);
  assert.equal(risk.highRisk, true);
  assert.deepEqual(risk.highRiskPaths, paths);
});

test('auto-merge candidates are scoped and blocked labels fail closed', () => {
  assert.equal(isAutomergeCandidate(pullRequest(), policy), true);
  assert.equal(
    isAutomergeCandidate(pullRequest({ head: { ...pullRequest().head, ref: 'feature/example' } }), policy),
    false,
  );
  assert.equal(isAutomergeCandidate(pullRequest({ labels: [{ name: 'do-not-merge' }] }), policy), false);
});

test('required checks pass only for exact head and expected GitHub app', () => {
  assert.equal(evaluateRequiredChecks(successfulChecks(), headSha, policy.requiredChecks).ok, true);

  const wrongApp = successfulChecks();
  wrongApp[0] = { ...wrongApp[0], app: { slug: 'untrusted-app' } };
  assert.equal(evaluateRequiredChecks(wrongApp, headSha, policy.requiredChecks).failures[0].reason, 'wrong_app');

  const wrongHead = successfulChecks();
  wrongHead[0] = { ...wrongHead[0], head_sha: 'b'.repeat(40) };
  const evaluation = evaluateRequiredChecks(wrongHead, headSha, policy.requiredChecks);
  assert.ok(evaluation.failures.some((failure) => failure.reason === 'wrong_head_sha'));
  assert.ok(evaluation.pending.some((pending) => pending.reason === 'missing'));
});

test('required checks treat pending and failed checks as non-passing', () => {
  const pending = successfulChecks();
  pending[2] = { ...pending[2], status: 'in_progress', conclusion: null };
  assert.equal(evaluateRequiredChecks(pending, headSha, policy.requiredChecks).ok, false);

  const failed = successfulChecks();
  failed[3] = { ...failed[3], conclusion: 'failure' };
  assert.equal(evaluateRequiredChecks(failed, headSha, policy.requiredChecks).failures[0].reason, 'failure');
});

test('autonomous review is bound to the exact head and rejects blocking findings', () => {
  const approved = { decision: 'approve', reviewedHeadSha: headSha, findings: [] };
  assert.equal(validateAutonomousReview(approved, headSha, policy).ok, true);
  assert.equal(validateAutonomousReview({ ...approved, reviewedHeadSha: 'b'.repeat(40) }, headSha, policy).ok, false);
  assert.equal(
    validateAutonomousReview(
      {
        ...approved,
        findings: [{ severity: 'high' }],
      },
      headSha,
      policy,
    ).ok,
    false,
  );
});

test('autonomous review rechecks the mutable pull-request head after loading files', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'autonomous-review-race-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  let pullRequestRead = 0;
  const github = {
    async getPullRequest() {
      pullRequestRead += 1;
      return pullRequest(pullRequestRead === 1 ? {} : { head: { ...pullRequest().head, sha: 'b'.repeat(40) } });
    },
    async getPullRequestFiles() {
      return [{ filename: 'README.md' }];
    },
  };

  await assert.rejects(
    runReview(
      {
        repository: 'JueZ/api',
        prNumber: 1,
        headSha,
        reviewFile: join(directory, 'review.json'),
      },
      policy,
      github,
    ),
    /Pull request head changed/,
  );
});

test('pull request state rejects forks, stale heads, and behind branches', () => {
  assert.equal(evaluatePullRequestState(pullRequest(), headSha, policy).ok, true);
  assert.equal(
    evaluatePullRequestState(
      pullRequest({
        head: { ...pullRequest().head, repo: { full_name: 'someone/fork' } },
      }),
      headSha,
      policy,
    ).ok,
    false,
  );
  assert.equal(evaluatePullRequestState(pullRequest({ mergeable_state: 'behind' }), headSha, policy).ok, false);
  assert.equal(evaluatePullRequestState(pullRequest({ mergeable_state: 'unstable' }), headSha, policy).ok, true);
  assert.equal(evaluatePullRequestState(pullRequest({ mergeable_state: 'dirty' }), headSha, policy).ok, false);
  assert.equal(evaluatePullRequestState(pullRequest({ mergeable_state: 'blocked' }), headSha, policy).ok, false);
  assert.equal(
    evaluatePullRequestState(pullRequest({ mergeable: null, mergeable_state: 'unknown' }), headSha, policy).ok,
    false,
  );
  assert.equal(evaluatePullRequestState(pullRequest({ mergeable: false }), headSha, policy).ok, false);
});

test('merge decision requires pull request state, checks, and review to all pass', () => {
  const checkEvaluation = evaluateRequiredChecks(successfulChecks(), headSha, policy.requiredChecks);
  const review = { decision: 'approve', reviewedHeadSha: headSha, findings: [] };
  assert.equal(
    mergeGateDecision({
      pullRequest: pullRequest(),
      expectedHeadSha: headSha,
      checkEvaluation,
      review,
      policy,
    }).ok,
    true,
  );

  assert.equal(
    mergeGateDecision({
      pullRequest: pullRequest(),
      expectedHeadSha: headSha,
      checkEvaluation: { ...checkEvaluation, pending: [{ check: 'lint', reason: 'missing' }], ok: false },
      review,
      policy,
    }).ok,
    false,
  );
});
