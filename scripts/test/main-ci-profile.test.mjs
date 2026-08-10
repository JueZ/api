import assert from 'node:assert/strict';
import test from 'node:test';
import { loadAutonomousPolicy } from '../lib/autonomous-policy.mjs';
import { resolveTrustedMainCiProfile } from '../resolve-main-ci-profile.mjs';

const repository = 'JueZ/api';
const mainSha = 'a'.repeat(40);
const prHeadSha = 'b'.repeat(40);
const baseSha = 'c'.repeat(40);
const treeSha = 'd'.repeat(40);
const governanceRunId = 1234;
const prNumber = 42;
const policy = loadAutonomousPolicy();

const governanceEvidence = {
  decision: 'approve',
  verifiedHeadSha: prHeadSha,
  summary: 'Deterministic governance passed.',
  findings: [],
  risk: {
    highRisk: true,
    highRiskPaths: ['docs/agent-learning/program.md'],
    classes: { agentGovernance: ['docs/agent-learning/program.md'] },
  },
  evaluator: 'deterministic-protected-controller-v1',
};

function input(overrides = {}) {
  return { repository, mainSha, prNumber, prHeadSha, governanceRunId, ...overrides };
}

function pullRequest(overrides = {}) {
  return {
    number: prNumber,
    state: 'closed',
    merged: true,
    merge_commit_sha: mainSha,
    changed_files: 1,
    head: { sha: prHeadSha, repo: { full_name: repository } },
    base: { sha: baseSha, ref: 'main', repo: { full_name: repository } },
    ...overrides,
  };
}

function workflowRun(overrides = {}) {
  return {
    id: governanceRunId,
    repository: { full_name: repository },
    path: '.github/workflows/codex-automerge.yml',
    name: 'Codex Auto-Merge',
    event: 'pull_request_target',
    status: 'completed',
    conclusion: 'success',
    head_sha: prHeadSha,
    run_attempt: 1,
    ...overrides,
  };
}

function artifact(overrides = {}) {
  return {
    id: 5678,
    name: `autonomous-governance-${prHeadSha}`,
    expired: false,
    digest: `sha256:${'e'.repeat(64)}`,
    workflow_run: { id: governanceRunId, head_sha: prHeadSha },
    ...overrides,
  };
}

function github(overrides = {}) {
  return {
    getProtectedMainRef: async () => ({ ref: 'refs/heads/main', object: { type: 'commit', sha: mainSha } }),
    getPullRequest: async () => pullRequest(),
    getWorkflowRun: async () => workflowRun(),
    getWorkflowArtifacts: async () => [artifact()],
    downloadArtifact: async () => Buffer.from('fixture archive'),
    getPullRequestFiles: async () => [{ filename: 'docs/agent-learning/program.md', status: 'modified' }],
    getGitCommit: async (sha) => ({ sha, tree: { sha: treeSha } }),
    ...overrides,
  };
}

const runtime = {
  verifyArtifactArchiveDigest: () => undefined,
  readSingleJsonArchive: async () => governanceEvidence,
};

test('trusted exact-main profile reuses validation only for an identical runtime-neutral tree', async () => {
  const calls = [];
  const result = await resolveTrustedMainCiProfile(
    input(),
    github({
      getPullRequestFiles: async (...args) => {
        calls.push(args);
        return [{ filename: 'docs/agent-learning/program.md', status: 'modified' }];
      },
    }),
    policy,
    runtime,
  );
  assert.deepEqual(calls, [[prNumber, prHeadSha, baseSha]]);
  assert.deepEqual(result, {
    profile: 'runtime-neutral-reuse',
    reason: 'trusted-identical-runtime-neutral-tree',
    repository,
    mainSha,
    prNumber,
    prHeadSha,
    governanceRunId,
    treeSha,
    fileCount: 1,
  });
});

test('main profile rejects malformed identifiers and a stale protected-main generation', async () => {
  await assert.rejects(resolveTrustedMainCiProfile(input({ mainSha: 'short' }), github(), policy, runtime), /exact/);
  await assert.rejects(
    resolveTrustedMainCiProfile(
      input(),
      github({
        getProtectedMainRef: async () => ({ ref: 'refs/heads/main', object: { type: 'commit', sha: 'f'.repeat(40) } }),
      }),
      policy,
      runtime,
    ),
    /current protected main/,
  );
});

test('main profile rejects wrong workflow identity, attempt, conclusion, or exact head', async () => {
  for (const change of [
    { path: '.github/workflows/ci.yml' },
    { event: 'workflow_dispatch' },
    { run_attempt: 2 },
    { conclusion: 'failure' },
    { head_sha: 'f'.repeat(40) },
    { repository: { full_name: 'someone/fork' } },
  ]) {
    await assert.rejects(
      resolveTrustedMainCiProfile(
        input(),
        github({ getWorkflowRun: async () => workflowRun(change) }),
        policy,
        runtime,
      ),
      /workflow run identity/,
    );
  }
});

test('main profile rejects wrong merged PR identity, repository, head, or merge SHA', async () => {
  for (const change of [
    { merged: false },
    { state: 'open' },
    { merge_commit_sha: 'f'.repeat(40) },
    { head: { sha: 'f'.repeat(40), repo: { full_name: repository } } },
    { head: { sha: prHeadSha, repo: { full_name: 'someone/fork' } } },
    { base: { sha: baseSha, ref: 'release', repo: { full_name: repository } } },
  ]) {
    await assert.rejects(
      resolveTrustedMainCiProfile(
        input(),
        github({ getPullRequest: async () => pullRequest(change) }),
        policy,
        runtime,
      ),
      /pull-request identity/,
    );
  }
});

test('main profile rejects missing, stale, duplicated, or invalid governance evidence', async () => {
  for (const artifacts of [
    [],
    [artifact(), artifact({ id: 5679 })],
    [artifact({ expired: true })],
    [artifact({ workflow_run: { id: 9999, head_sha: prHeadSha } })],
  ]) {
    await assert.rejects(
      resolveTrustedMainCiProfile(input(), github({ getWorkflowArtifacts: async () => artifacts }), policy, runtime),
      /governance artifact/,
    );
  }
  await assert.rejects(
    resolveTrustedMainCiProfile(input(), github(), policy, {
      ...runtime,
      readSingleJsonArchive: async () => ({ ...governanceEvidence, verifiedHeadSha: 'f'.repeat(40) }),
    }),
    /governance artifact is invalid/,
  );
});

test('main profile rejects runtime-impacting, incomplete, and non-identical trees', async () => {
  await assert.rejects(
    resolveTrustedMainCiProfile(
      input(),
      github({ getPullRequestFiles: async () => [{ filename: 'apps/api/src/index.ts', status: 'modified' }] }),
      policy,
      runtime,
    ),
    /not eligible/,
  );
  await assert.rejects(
    resolveTrustedMainCiProfile(input(), github({ getPullRequestFiles: async () => [] }), policy, runtime),
    /file count changed/,
  );
  await assert.rejects(
    resolveTrustedMainCiProfile(
      input(),
      github({
        getGitCommit: async (sha) => ({ sha, tree: { sha: sha === mainSha ? 'e'.repeat(40) : treeSha } }),
      }),
      policy,
      runtime,
    ),
    /tree differs/,
  );
});

test('main profile rejects main advancing during evidence verification', async () => {
  let reads = 0;
  await assert.rejects(
    resolveTrustedMainCiProfile(
      input(),
      github({
        getProtectedMainRef: async () => {
          reads += 1;
          return {
            ref: 'refs/heads/main',
            object: { type: 'commit', sha: reads === 1 ? mainSha : 'f'.repeat(40) },
          };
        },
      }),
      policy,
      runtime,
    ),
    /changed during/,
  );
});
