import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { loadAutonomousPolicy, STABLE_REQUIRED_CHECKS } from '../lib/autonomous-policy.mjs';

const agents = readFileSync(new URL('../../AGENTS.md', import.meta.url), 'utf8');
const policy = loadAutonomousPolicy();

test('protected policy exposes only the two stable GitHub Actions gates', () => {
  assert.deepEqual(STABLE_REQUIRED_CHECKS, [
    { name: 'PR Gate', appSlug: 'github-actions' },
    { name: 'Security Gate', appSlug: 'github-actions' },
  ]);
  assert.deepEqual(policy.requiredChecks, STABLE_REQUIRED_CHECKS);
});

test('native exact-head squash auto-merge replaces polling policy', () => {
  assert.equal(policy.merge.nativeAutoMerge, true);
  assert.equal(policy.merge.method, 'squash');
  assert.equal(policy.merge.exactHeadSha, true);
  assert.equal(policy.merge.deleteHeadBranch, true);
  assert.equal(policy.merge.allowAdminBypass, false);
  assert.equal('waitSeconds' in policy.merge, false);
  assert.equal('pollSeconds' in policy.merge, false);
  assert.match(agents, /gh pr merge <number>/);
  assert.match(agents, /--auto/);
  assert.match(agents, /--squash/);
  assert.match(agents, /--delete-branch/);
  assert.match(agents, /--match-head-commit <exact-head-sha>/);
});

test('bounded repair policy stops repeated non-progress', () => {
  assert.deepEqual(policy.repair, {
    maxCommitsPerPullRequest: 3,
    repeatedFingerprintStop: 2,
    externalReruns: 1,
  });
});
