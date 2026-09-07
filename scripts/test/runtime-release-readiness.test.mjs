import assert from 'node:assert/strict';
import test from 'node:test';
import { runRuntimeSmoke } from '../smoke-runtime.mjs';

const oldSha = 'a'.repeat(40);
const newSha = 'b'.repeat(40);
const env = {
  API_BASE_URL: 'https://api.example.test',
  ENVIRONMENT_NAME: 'test',
  EXPECTED_DEPLOYED_COMMIT_SHA: newSha,
  AUTH_ENABLED: 'true',
  RUNTIME_HEALTH_RETRY_ATTEMPTS: '3',
  RUNTIME_HEALTH_RETRY_DELAY_MS: '0',
};

function fixture(t, healthResponses, helloStatus = 401) {
  const calls = [];
  let index = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    const path = new URL(url).pathname;
    calls.push(path);
    if (path === '/health') {
      const response = healthResponses[Math.min(index++, healthResponses.length - 1)];
      return Response.json(response.body, { status: response.status ?? 200 });
    }
    if (path === '/api/hello') return new Response('', { status: helloStatus });
    throw new Error(`Unexpected request: ${path}`);
  });
  return calls;
}
const healthy = (deployedCommitSha, environmentName = 'test') => ({
  body: { status: 'ok', environmentName, deployedCommitSha },
});

test('runtime readiness waits for the exact release after an older worker responds successfully', async (t) => {
  const calls = fixture(t, [{ status: 503, body: {} }, healthy(oldSha), healthy(newSha)]);
  const smoke = await runRuntimeSmoke({ env });
  assert.equal(smoke.exitCode, 0);
  assert.equal(smoke.result.checks[0].deployedCommitSha, newSha);
  assert.deepEqual(calls, ['/health', '/health', '/health', '/api/hello']);
});

test('a permanently stale release exhausts the existing budget without claiming success', async (t) => {
  const calls = fixture(t, [healthy(oldSha)]);
  const smoke = await runRuntimeSmoke({ env });
  assert.equal(smoke.exitCode, 1);
  assert.match(smoke.result.error, /deployedCommitSha expected/);
  assert.deepEqual(smoke.result.checks, []);
  assert.deepEqual(calls, ['/health', '/health', '/health']);
});

test('wrong environments and missing release identities are not treated as older healthy workers', async (t) => {
  for (const response of [healthy(oldSha, 'prod'), healthy(undefined)]) {
    const calls = fixture(t, [response, healthy(newSha)]);
    const smoke = await runRuntimeSmoke({ env });
    assert.equal(smoke.exitCode, 1);
    assert.deepEqual(calls, ['/health']);
    t.mock.restoreAll();
  }
});

test('release readiness cannot replace the unauthenticated access denial check', async (t) => {
  fixture(t, [healthy(oldSha), healthy(newSha)], 200);
  const smoke = await runRuntimeSmoke({ env });
  assert.equal(smoke.exitCode, 1);
  assert.match(smoke.result.error, /unauthenticated \/api\/hello status expected 401, got 200/);
});
