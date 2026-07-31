import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  localSecurityControllerFindings,
  verifyCurrentSecurityController,
} from '../assert-current-security-controller.mjs';

const headSha = 'a'.repeat(40);
const activeHold = JSON.parse(
  readFileSync(new URL('../../.github/security-deployment-hold.json', import.meta.url), 'utf8'),
);
const baseContext = {
  repository: 'JueZ/api',
  ref: 'refs/heads/main',
  runAttempt: '1',
  workflowSha: headSha,
  checkoutSha: headSha,
};

function githubFixture({ mainSha = headSha, hold = activeHold, status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (status !== 200) return new Response('{}', { status });
    if (url.endsWith('/git/ref/heads/main')) {
      return new Response(JSON.stringify({ object: { sha: mainSha } }), { status: 200 });
    }
    if (url.includes('/contents/.github/security-deployment-hold.json?ref=')) {
      return new Response(
        JSON.stringify({ encoding: 'base64', content: Buffer.from(JSON.stringify(hold)).toString('base64') }),
        { status: 200 },
      );
    }
    return new Response('{}', { status: 404 });
  };
  return { calls, fetchImpl };
}

test('local security controller accepts only first-attempt current main coordinates', () => {
  assert.deepEqual(localSecurityControllerFindings(baseContext, headSha), []);
  assert.ok(
    localSecurityControllerFindings({ ...baseContext, runAttempt: '2' }, headSha).includes('run_attempt_not_one'),
  );
  assert.ok(
    localSecurityControllerFindings({ ...baseContext, ref: 'refs/heads/feature' }, headSha).includes('not_main_ref'),
  );
  assert.ok(localSecurityControllerFindings(baseContext, 'b'.repeat(40)).includes('workflow_sha_not_current_main'));
});

test('live security controller fails closed for the active incident hold', async () => {
  const fixture = githubFixture();
  const result = await verifyCurrentSecurityController({
    ...baseContext,
    token: 'test-token',
    fetchImpl: fixture.fetchImpl,
    now: new Date('2026-08-01T00:00:00Z'),
  });
  assert.deepEqual(result, { ok: false, findings: ['active_security_hold'] });
  assert.equal(fixture.calls.length, 2);
});

test('main drift and retried runs fail before the live hold can be used', async () => {
  const drift = githubFixture({ mainSha: 'b'.repeat(40) });
  const driftResult = await verifyCurrentSecurityController({
    ...baseContext,
    token: 'test-token',
    fetchImpl: drift.fetchImpl,
  });
  assert.equal(driftResult.ok, false);
  assert.ok(driftResult.findings.includes('workflow_sha_not_current_main'));
  assert.equal(drift.calls.length, 1);

  const retry = githubFixture();
  const retryResult = await verifyCurrentSecurityController({
    ...baseContext,
    runAttempt: '2',
    token: 'test-token',
    fetchImpl: retry.fetchImpl,
  });
  assert.equal(retryResult.ok, false);
  assert.ok(retryResult.findings.includes('run_attempt_not_one'));
  assert.equal(retry.calls.length, 1);
});

test('GitHub API failures and malformed live hold content fail closed', async () => {
  const unavailable = githubFixture({ status: 404 });
  assert.deepEqual(
    await verifyCurrentSecurityController({
      ...baseContext,
      token: 'test-token',
      fetchImpl: unavailable.fetchImpl,
    }),
    { ok: false, findings: ['github_api_http_404'] },
  );

  const malformed = githubFixture({ hold: 'not-an-object' });
  const malformedResult = await verifyCurrentSecurityController({
    ...baseContext,
    token: 'test-token',
    fetchImpl: malformed.fetchImpl,
  });
  assert.deepEqual(malformedResult, { ok: false, findings: ['invalid_live_hold_policy'] });
});
