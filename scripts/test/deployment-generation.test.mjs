import assert from 'node:assert/strict';
import test from 'node:test';
import { assertCurrentMain, evaluateCurrentMain } from '../assert-current-main.mjs';

const sourceRef = 'a'.repeat(40);

test('deployment mutation guard accepts only the exact current main generation', () => {
  assert.equal(evaluateCurrentMain({ sourceRef, currentMainSha: sourceRef, environmentName: 'test' }).ok, true);
  const stale = evaluateCurrentMain({
    sourceRef,
    currentMainSha: 'b'.repeat(40),
    environmentName: 'prod',
  });
  assert.equal(stale.ok, false);
  assert.match(stale.errors[0], /is not current main/);
});

test('only the dedicated production rollback path may deploy a non-current main ancestor', () => {
  assert.equal(
    evaluateCurrentMain({
      sourceRef,
      currentMainSha: 'b'.repeat(40),
      environmentName: 'prod',
      allowRollback: true,
    }).ok,
    true,
  );
  assert.equal(
    evaluateCurrentMain({
      sourceRef,
      currentMainSha: 'b'.repeat(40),
      environmentName: 'test',
      allowRollback: true,
    }).ok,
    false,
  );
});

test('deployment mutation guard reads the authoritative GitHub main ref without shell interpolation', async () => {
  const calls = [];
  const decision = await assertCurrentMain(
    {
      GITHUB_REPOSITORY: 'JueZ/api',
      GH_TOKEN: 'masked-test-token',
      SOURCE_REF: sourceRef,
      ENVIRONMENT_NAME: 'test',
      ALLOW_ROLLBACK: 'false',
    },
    async (...args) => {
      calls.push(args);
      return { stdout: `${sourceRef}\n`, stderr: '' };
    },
  );

  assert.equal(decision.ok, true);
  assert.deepEqual(calls[0][1], ['api', 'repos/JueZ/api/git/ref/heads/main', '--jq', '.object.sha']);
});
