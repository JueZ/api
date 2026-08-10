import assert from 'node:assert/strict';
import test from 'node:test';
import { assertCurrentMain, evaluateDirectDagGuard } from '../assert-current-main.mjs';

const sourceRef = 'a'.repeat(40);

test('production mutation is caller-bound to the one-shot current-main confirmation', () => {
  assert.equal(
    evaluateDirectDagGuard({
      deploymentControlRef: sourceRef,
      githubSha: sourceRef,
      confirmedMainRef: sourceRef,
      environmentName: 'prod',
    }).ok,
    true,
  );
  const stale = evaluateDirectDagGuard({
    deploymentControlRef: sourceRef,
    githubSha: sourceRef,
    confirmedMainRef: 'b'.repeat(40),
    environmentName: 'prod',
  });
  assert.equal(stale.ok, false);
  assert.match(stale.errors.join('\n'), /one-shot current-main confirmation/);
});

test('test mutation uses the immutable caller without pretending production was confirmed', () => {
  assert.equal(
    evaluateDirectDagGuard({
      deploymentControlRef: sourceRef,
      githubSha: sourceRef,
      confirmedMainRef: '',
      environmentName: 'test',
    }).ok,
    true,
  );
});

test('deployment generation assertion performs no Actions or branch polling', async () => {
  const decision = await assertCurrentMain({
    DEPLOYMENT_CONTROL_REF: sourceRef,
    CURRENT_MAIN_CONFIRMED_REF: sourceRef,
    GITHUB_SHA: sourceRef,
    ENVIRONMENT_NAME: 'prod',
  });
  assert.equal(decision.ok, true);
});

test('rollback changes the application source, never the protected controller identity', () => {
  assert.equal(
    evaluateDirectDagGuard({
      deploymentControlRef: sourceRef,
      githubSha: 'b'.repeat(40),
      confirmedMainRef: sourceRef,
      environmentName: 'prod',
    }).ok,
    false,
  );
});
