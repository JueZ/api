import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import {
  classifyRisk,
  loadAutonomousPolicy,
  matchesPolicyGlob,
  PROFILE_NAMES,
  STABLE_REQUIRED_CHECKS,
  validateAutonomousPolicy,
} from '../lib/autonomous-policy.mjs';

const policy = loadAutonomousPolicy();

test('canonical policy is small, internally valid, and names only stable native gates', () => {
  assert.deepEqual(validateAutonomousPolicy(policy), []);
  assert.equal(policy.version, 2);
  assert.deepEqual(policy.requiredChecks, STABLE_REQUIRED_CHECKS);
  assert.deepEqual(Object.keys(policy.profiles), PROFILE_NAMES);
  assert.equal('trustedWorkflowSha256' in policy, false);
  assert.equal('autonomousGovernance' in policy, false);
  assert.equal('agentLearning' in policy, false);
});

test('policy validation rejects changed gate, profile, repair, and workflow-security invariants', () => {
  assert.match(
    validateAutonomousPolicy({ ...policy, requiredChecks: [{ name: 'optional', appSlug: 'github-actions' }] }).join(
      '\n',
    ),
    /requiredChecks must contain exactly/,
  );
  assert.match(
    validateAutonomousPolicy({ ...policy, profiles: { ...policy.profiles, privileged: ['README.md'] } }).join('\n'),
    /profiles\.privileged must include/,
  );
  assert.match(
    validateAutonomousPolicy({ ...policy, repair: { ...policy.repair, maxCommitsPerPullRequest: 30 } }).join('\n'),
    /maxCommitsPerPullRequest must be 3/,
  );
  assert.match(
    validateAutonomousPolicy({
      ...policy,
      workflowSecurity: { ...policy.workflowSecurity, forbidSecretsInherit: false },
    }).join('\n'),
    /forbidSecretsInherit must be true/,
  );
});

test('privileged path matching is deterministic and unknown risk is not silently downgraded', () => {
  const risk = classifyRisk(['README.md', 'scripts/policy-guardrails.mjs', 'apps/api/src/shared/security/auth.ts']);
  assert.equal(risk.privileged, true);
  assert.deepEqual(risk.privilegedPaths, ['scripts/policy-guardrails.mjs', 'apps/api/src/shared/security/auth.ts']);
  assert.deepEqual(Object.keys(risk.profiles), ['documentation-only', 'api-backend', 'privileged']);
  assert.equal(matchesPolicyGlob('apps/api/src/functions/hello.ts', 'apps/**'), true);
  assert.equal(matchesPolicyGlob('../apps/api/src/index.ts', 'apps/**'), false);
});

test('native merge and delivery contract contains no polling or bypass policy', () => {
  assert.deepEqual(policy.merge, {
    method: 'squash',
    nativeAutoMerge: true,
    exactHeadSha: true,
    requireUpToDate: true,
    deleteHeadBranch: true,
    allowedBranchPrefixes: ['codex/'],
    blockedLabels: ['do-not-merge', 'security-hold'],
    allowForks: false,
    allowAdminBypass: false,
  });
  assert.equal(policy.deployment.controllerWorkflow, 'delivery-v2.yml');
  assert.equal(policy.deployment.buildOnce, true);
  assert.equal(policy.deployment.requireExactArtifactDigest, true);
  assert.equal('pollSeconds' in policy.merge, false);
  assert.equal('waitSeconds' in policy.merge, false);
});

test('legacy delivery and governance workflow files are absent', () => {
  const workflows = readdirSync(new URL('../../.github/workflows', import.meta.url)).sort();
  for (const removed of [
    'agent-learning-status.yml',
    'ci.yml',
    'codeql.yml',
    'codex-automerge.yml',
    'codex-main-delivery.yml',
    'deploy-test.yml',
    'policy-check.yml',
    'promote-production.yml',
    'rollback-production.yml',
  ]) {
    assert.equal(workflows.includes(removed), false, removed);
  }
  for (const current of ['pr-gate.yml', 'security-gate.yml', 'delivery-v2.yml', 'repair-triage.yml']) {
    assert.equal(workflows.includes(current), true, current);
  }
  const source = readFileSync(new URL('../../.github/autonomous-policy.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /Autonomous review complete|trustedWorkflowSha256|programEvidence/);
});
