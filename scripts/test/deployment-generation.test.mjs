import assert from 'node:assert/strict';
import test from 'node:test';
import { assertCurrentMain, evaluateCurrentMain } from '../assert-current-main.mjs';

const sourceRef = 'a'.repeat(40);

test('deployment mutation guard accepts only the exact current main generation', () => {
  assert.equal(
    evaluateCurrentMain({ deploymentControlRef: sourceRef, currentMainSha: sourceRef, environmentName: 'test' }).ok,
    true,
  );
  const stale = evaluateCurrentMain({
    deploymentControlRef: sourceRef,
    currentMainSha: 'b'.repeat(40),
    environmentName: 'prod',
  });
  assert.equal(stale.ok, false);
  assert.match(stale.errors[0], /is not current main/);
});

test('rollback mode cannot exempt a stale deployment controller from current-main equality', () => {
  const decision = evaluateCurrentMain({
    deploymentControlRef: sourceRef,
    currentMainSha: 'b'.repeat(40),
    environmentName: 'prod',
  });
  assert.equal(decision.ok, false);
  assert.match(decision.errors[0], /Deployment controller/);
});

test('deployment mutation guard reads the authoritative GitHub main ref without shell interpolation', async () => {
  const calls = [];
  const decision = await assertCurrentMain(
    {
      GITHUB_REPOSITORY: 'JueZ/api',
      GH_TOKEN: 'masked-test-token',
      DEPLOYMENT_CONTROL_REF: sourceRef,
      ENVIRONMENT_NAME: 'test',
    },
    async (...args) => {
      calls.push(args);
      return { stdout: `${sourceRef}\n`, stderr: '' };
    },
  );

  assert.equal(decision.ok, true);
  assert.deepEqual(calls[0][1], ['api', 'repos/JueZ/api/git/ref/heads/main', '--jq', '.object.sha']);
});

test('deployment mutation guard never calls a rollback ancestry exception', async () => {
  const calls = [];
  await assertCurrentMain(
    {
      GITHUB_REPOSITORY: 'JueZ/api',
      GH_TOKEN: 'masked-test-token',
      DEPLOYMENT_CONTROL_REF: sourceRef,
      ENVIRONMENT_NAME: 'prod',
    },
    async (...args) => {
      calls.push(args);
      return { stdout: `${sourceRef}\n`, stderr: '' };
    },
  );
  assert.equal(calls.length, 1);
});
