import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { verifyGateAggregate } from '../lib/gate-aggregate.mjs';

const result = (value) => ({ result: value });

test('portability runtime executes candidate code without saving a shared dependency cache', () => {
  const workflow = parse(readFileSync(new URL('../../.github/workflows/pr-gate.yml', import.meta.url), 'utf8'));
  const job = workflow.jobs.portability;
  assert.equal(job.if, "needs.classify.outputs.agent_environment == 'true'");
  assert.equal(workflow.jobs.classify.outputs.agent_environment, '${{ steps.classify.outputs.agent_environment }}');
  assert.equal(workflow.jobs.classify.outputs.operations, '${{ steps.classify.outputs.operations }}');
  assert.deepEqual(job.strategy.matrix.os, ['ubuntu-latest', 'windows-latest']);
  const nodeSetup = job.steps.find((step) => step.uses?.startsWith('actions/setup-node@'));
  assert.ok(nodeSetup);
  const checkout = job.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
  assert.equal(
    checkout.with.ref,
    "${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}",
  );
  const identity = job.steps.find((step) => step.name === 'Verify classified candidate identity');
  assert.equal(identity.env.EXPECTED_SHA, '${{ needs.classify.outputs.head_sha }}');
  assert.equal(identity.run, 'test "$(git rev-parse HEAD)" = "$EXPECTED_SHA"');
  assert.equal(nodeSetup.with.cache, undefined);
  assert.equal(
    job.steps.some((step) => step.uses?.startsWith('actions/cache')),
    false,
  );
  assert.equal(job.steps.find((step) => step.run === 'npm run agent:env:stop').if, 'always()');

  const operations = workflow.jobs.operations;
  assert.equal(operations.if, "needs.classify.outputs.operations == 'true'");
  const commands = operations.steps.find(
    (step) => step.name === 'Compile API prerequisites once and validate repository operations',
  ).run;
  assert.match(commands, /typescript\/bin\/tsc -p apps\/api\/tsconfig.json/);
  assert.match(commands, /node scripts\/run-tests.mjs scripts\/test/);
  assert.ok(workflow.jobs.aggregate.needs.includes('operations'));
});

test('PR aggregate accepts only classifier-authorized documentation skips', () => {
  const flags = {
    backend: false,
    contracts: false,
    operations: false,
    frontend: false,
    agentEnvironment: false,
    infrastructure: false,
    workflow: false,
  };
  const needs = {
    classify: result('success'),
    policy: result('success'),
    backend: result('skipped'),
    operations: result('skipped'),
    frontend: result('skipped'),
    portability: result('skipped'),
    infrastructure: result('skipped'),
    workflow: result('skipped'),
  };
  assert.deepEqual(verifyGateAggregate('pr', flags, needs), {
    passed: true,
    applicable: ['classify', 'policy'],
    skipped: ['backend', 'operations', 'frontend', 'portability', 'infrastructure', 'workflow'],
    failures: [],
  });
});

test('PR aggregate rejects a failed applicable job and an unexplained skip', () => {
  const flags = {
    backend: true,
    contracts: false,
    operations: false,
    frontend: false,
    agentEnvironment: false,
    infrastructure: false,
    workflow: false,
  };
  const needs = {
    classify: result('success'),
    policy: result('success'),
    backend: result('failure'),
    operations: result('skipped'),
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

test('PR aggregate requires successful portability coverage for agent environment changes', () => {
  const flags = {
    backend: false,
    contracts: false,
    operations: false,
    frontend: false,
    agentEnvironment: true,
    infrastructure: false,
    workflow: false,
  };
  const needs = {
    classify: result('success'),
    policy: result('success'),
    backend: result('skipped'),
    operations: result('skipped'),
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

test('PR aggregate separates sensitive policy scrutiny from operations and environment work', () => {
  const flags = {
    backend: false,
    contracts: false,
    operations: false,
    frontend: false,
    agentEnvironment: false,
    infrastructure: false,
    workflow: false,
  };
  const needs = {
    classify: result('success'),
    policy: result('success'),
    backend: result('skipped'),
    operations: result('skipped'),
    frontend: result('skipped'),
    portability: result('skipped'),
    infrastructure: result('skipped'),
    workflow: result('skipped'),
  };
  assert.equal(verifyGateAggregate('pr', flags, needs).passed, true);

  needs.operations = result('success');
  assert.match(verifyGateAggregate('pr', flags, needs).failures.join('\n'), /operations expected skipped/);
});

test('PR aggregate requires successful operations coverage for executable scripts', () => {
  const flags = {
    backend: false,
    contracts: false,
    operations: true,
    frontend: false,
    agentEnvironment: false,
    infrastructure: false,
    workflow: false,
  };
  const needs = {
    classify: result('success'),
    policy: result('success'),
    backend: result('skipped'),
    operations: result('success'),
    frontend: result('skipped'),
    portability: result('skipped'),
    infrastructure: result('skipped'),
    workflow: result('skipped'),
  };
  assert.equal(verifyGateAggregate('pr', flags, needs).passed, true);
  needs.operations = result('skipped');
  assert.match(verifyGateAggregate('pr', flags, needs).failures.join('\n'), /operations expected success/);
});

test('aggregate rejects missing and undeclared dependencies', () => {
  const flags = {
    backend: false,
    contracts: false,
    operations: false,
    frontend: false,
    agentEnvironment: false,
    infrastructure: false,
    workflow: false,
  };
  const needs = {
    classify: result('success'),
    policy: result('success'),
    backend: result('skipped'),
    operations: result('skipped'),
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

test('aggregate fails closed when a conditional applicability flag is missing or malformed', () => {
  const flags = {
    backend: false,
    contracts: false,
    operations: false,
    frontend: false,
    agentEnvironment: false,
    infrastructure: false,
    workflow: 'false',
  };
  const needs = {
    classify: result('success'),
    policy: result('success'),
    backend: result('skipped'),
    operations: result('skipped'),
    frontend: result('skipped'),
    portability: result('skipped'),
    infrastructure: result('skipped'),
    workflow: result('skipped'),
  };
  assert.match(verifyGateAggregate('pr', flags, needs).failures.join('\n'), /workflow applicability flag/);
  delete flags.operations;
  assert.match(verifyGateAggregate('pr', flags, needs).failures.join('\n'), /operations applicability flag/);
});
