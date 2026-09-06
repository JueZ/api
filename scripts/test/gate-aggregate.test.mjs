import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyGateAggregate } from '../lib/gate-aggregate.mjs';

const result = (value) => ({ result: value });

test('PR aggregate accepts only classifier-authorized documentation skips', () => {
  const flags = { backend: false, contracts: false, frontend: false, infrastructure: false, workflow: false };
  const needs = {
    classify: result('success'),
    policy: result('success'),
    backend: result('skipped'),
    frontend: result('skipped'),
    portability: result('skipped'),
    infrastructure: result('skipped'),
    workflow: result('skipped'),
  };
  assert.deepEqual(verifyGateAggregate('pr', flags, needs), {
    passed: true,
    applicable: ['classify', 'policy'],
    skipped: ['backend', 'frontend', 'portability', 'infrastructure', 'workflow'],
    failures: [],
  });
});

test('PR aggregate rejects a failed applicable job and an unexplained skip', () => {
  const flags = { backend: true, contracts: false, frontend: false, infrastructure: false, workflow: false };
  const needs = {
    classify: result('success'),
    policy: result('success'),
    backend: result('failure'),
    frontend: result('success'),
    portability: result('skipped'),
    infrastructure: result('skipped'),
    workflow: result('skipped'),
  };
  const aggregate = verifyGateAggregate('pr', flags, needs);
  assert.equal(aggregate.passed, false);
  assert.match(aggregate.failures.join('\n'), /backend expected success/);
  assert.match(aggregate.failures.join('\n'), /frontend expected skipped/);
});

test('Security aggregate enforces Gitleaks and each path-selected scan', () => {
  const flags = { dependencies: true, codeqlJavascript: true, codeqlActions: false, trivy: true };
  const needs = {
    classify: result('success'),
    gitleaks: result('success'),
    dependencyAudit: result('success'),
    codeqlJavascript: result('success'),
    codeqlActions: result('skipped'),
    trivy: result('success'),
  };
  assert.equal(verifyGateAggregate('security', flags, needs).passed, true);
  needs.gitleaks = result('failure');
  assert.equal(verifyGateAggregate('security', flags, needs).passed, false);
});

test('PR aggregate requires successful portability coverage for privileged changes', () => {
  const flags = { privileged: true };
  const needs = {
    classify: result('success'),
    policy: result('success'),
    backend: result('skipped'),
    frontend: result('skipped'),
    portability: result('success'),
    infrastructure: result('skipped'),
    workflow: result('skipped'),
  };
  assert.equal(verifyGateAggregate('pr', flags, needs).passed, true);
  for (const status of ['failure', 'cancelled', 'skipped', undefined]) {
    needs.portability = result(status);
    const aggregate = verifyGateAggregate('pr', flags, needs);
    assert.equal(aggregate.passed, false);
    assert.match(aggregate.failures.join('\n'), /portability expected success/);
  }
});

test('aggregate rejects missing and undeclared dependencies', () => {
  const flags = { backend: false, contracts: false, frontend: false, infrastructure: false, workflow: false };
  const needs = {
    classify: result('success'),
    policy: result('success'),
    backend: result('skipped'),
    frontend: result('skipped'),
    portability: result('skipped'),
    infrastructure: result('skipped'),
    workflow: result('skipped'),
    surprise: result('success'),
  };
  const aggregate = verifyGateAggregate('pr', flags, needs);
  assert.equal(aggregate.passed, false);
  assert.match(aggregate.failures.join('\n'), /unexpected aggregate dependencies/);
});
