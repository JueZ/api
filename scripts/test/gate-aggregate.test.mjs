import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { verifyGateAggregate } from '../lib/gate-aggregate.mjs';

const result = (value) => ({ result: value });

test('PR jobs take checkout identity from the immutable event rather than classifier output', () => {
  const workflow = parse(readFileSync(new URL('../../.github/workflows/pr-gate.yml', import.meta.url), 'utf8'));
  for (const [name, job] of Object.entries(workflow.jobs)) {
    const checkout = job.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
    assert.ok(checkout, `${name} must check out an exact event commit`);
    assert.doesNotMatch(checkout.with.ref, /needs\./, `${name} must not trust executable classifier output`);
    assert.equal(
      checkout.with.ref,
      "${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}",
    );
    assert.equal(checkout.with['persist-credentials'], false);
  }
});

test('Security jobs check out the immutable event head rather than classifier output', () => {
  const workflow = parse(readFileSync(new URL('../../.github/workflows/security-gate.yml', import.meta.url), 'utf8'));
  for (const [name, job] of Object.entries(workflow.jobs)) {
    const checkout = job.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
    assert.ok(checkout, `${name} must check out an exact event commit`);
    assert.equal(checkout.with.ref, '${{ github.event.pull_request.head.sha || github.sha }}');
    assert.equal(checkout.with['persist-credentials'], false);
  }
});

test('PR policy runs protected-base checks before installing candidate dependencies', () => {
  const workflow = parse(readFileSync(new URL('../../.github/workflows/pr-gate.yml', import.meta.url), 'utf8'));
  const job = workflow.jobs.policy;
  const candidateCheckout = job.steps.find((step) => step.name === 'Checkout exact candidate');
  assert.equal(candidateCheckout.with.path, '.candidate');
  const trustedCheckout = job.steps.find((step) => step.name === 'Checkout protected base policy');
  assert.ok(trustedCheckout);
  assert.equal(trustedCheckout.if, "github.event_name == 'pull_request'");
  assert.equal(trustedCheckout.with.ref, '${{ github.event.pull_request.base.sha }}');
  assert.equal(trustedCheckout.with.path, '.trusted-base');
  assert.equal(trustedCheckout.with['persist-credentials'], false);

  const nodeSetup = job.steps.find((step) => step.uses?.startsWith('actions/setup-node@'));
  assert.equal(nodeSetup.with['node-version'], '22');
  assert.equal(nodeSetup.with.cache, undefined);
  assert.equal(nodeSetup.with['cache-dependency-path'], undefined);

  const trustedInstall = job.steps.find((step) => step.name === 'Install protected base policy dependencies');
  const trustedVerify = job.steps.find((step) => step.name === 'Verify candidate with protected base policy');
  const candidateInstall = job.steps.find((step) => step.name === 'Install policy and formatting dependencies');
  assert.equal(trustedInstall.if, "github.event_name == 'pull_request'");
  assert.equal(trustedInstall['working-directory'], '.trusted-base');
  assert.equal(trustedInstall.run, 'npm ci --ignore-scripts --workspaces=false');
  assert.equal(trustedVerify.if, "github.event_name == 'pull_request'");
  assert.ok(job.steps.indexOf(trustedInstall) < job.steps.indexOf(trustedVerify));
  assert.ok(job.steps.indexOf(trustedVerify) < job.steps.indexOf(candidateInstall));
  assert.equal(candidateInstall['working-directory'], '.candidate');
  for (const name of [
    'Check exact diff and changed-file formatting',
    'Validate deterministic repository policy',
    'Enforce cost and dependency policy when applicable',
  ]) {
    assert.equal(job.steps.find((step) => step.name === name)['working-directory'], '.candidate');
  }

  assert.deepEqual(trustedVerify.env, {
    BASE_SHA: '${{ github.event.pull_request.base.sha }}',
    CANDIDATE_CLASSIFIER_OUTPUTS: '${{ toJson(needs.classify.outputs) }}',
    CANDIDATE_FLAGS_JSON: '${{ needs.classify.outputs.flags_json }}',
    CANDIDATE_ROOT: '${{ github.workspace }}/.candidate',
    CLASSIFIED_BASE_SHA: '${{ needs.classify.outputs.base_sha }}',
    CLASSIFIED_HEAD_SHA: '${{ needs.classify.outputs.head_sha }}',
    HEAD_SHA: '${{ github.event.pull_request.head.sha }}',
    TRUSTED_ROOT: '${{ github.workspace }}/.trusted-base',
  });
  assert.match(trustedVerify.run, /git -C "\$CANDIDATE_ROOT" rev-parse HEAD/);
  assert.match(trustedVerify.run, /git -C "\$TRUSTED_ROOT" rev-parse HEAD/);
  assert.match(trustedVerify.run, /REPOSITORY_ROOT="\$CANDIDATE_ROOT"/);
  assert.match(trustedVerify.run, /POLICY_ROOT="\$TRUSTED_ROOT"/);
  assert.match(trustedVerify.run, /node "\$TRUSTED_ROOT\/scripts\/policy-guardrails\.mjs"/);
  assert.match(trustedVerify.run, /cd "\$CANDIDATE_ROOT"[\s\S]*policy-guardrails\.mjs/);
  assert.match(trustedVerify.run, /trustedModule\('scripts\/classify-pr-paths\.mjs'\)/);
  assert.match(
    trustedVerify.run,
    /workflowPolicyFindings\(join\(candidateRoot, '\.github\/workflows'\), baselinePolicy\)/,
  );
  assert.match(trustedVerify.run, /candidate classifier diverged from protected base/);
  assert.match(trustedVerify.run, /candidate classifier output \$\{output\} diverged/);
  for (const [flag, output] of [
    ['backend', 'backend'],
    ['frontend', 'frontend'],
    ['contracts', 'contracts'],
    ['dependencies', 'dependencies'],
    ['infrastructure', 'infrastructure'],
    ['workflow', 'workflow'],
    ['learning', 'learning'],
    ['privileged', 'privileged'],
    ['operations', 'operations'],
    ['agentEnvironment', 'agent_environment'],
  ]) {
    assert.match(trustedVerify.run, new RegExp(`\\s+'${flag}',`));
    assert.equal(workflow.jobs.classify.outputs[output], `\${{ steps.classify.outputs.${output} }}`);
  }
  assert.doesNotMatch(trustedVerify.run, /node --test/);
  assert.doesNotMatch(trustedVerify.run, /(?:npm ci|node_modules).*CANDIDATE_ROOT/);
  assert.doesNotMatch(trustedVerify.run, /secrets\./);
  assert.equal(workflow.permissions.contents, 'read');
  assert.ok(workflow.jobs.aggregate.needs.includes('policy'));
});

test('required aggregates classify and verify pull requests with protected-base code', () => {
  const cases = [
    {
      path: '../../.github/workflows/pr-gate.yml',
      name: 'PR Gate',
      candidateRef: "${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}",
      output: 'pr-gate-trusted-classification',
    },
    {
      path: '../../.github/workflows/security-gate.yml',
      name: 'Security Gate',
      candidateRef: '${{ github.event.pull_request.head.sha || github.sha }}',
      output: 'security-gate-trusted-classification',
    },
  ];

  for (const expected of cases) {
    const workflow = parse(readFileSync(new URL(expected.path, import.meta.url), 'utf8'));
    const job = workflow.jobs.aggregate;
    assert.equal(workflow.name, expected.name);
    assert.equal(job.name, expected.name);

    const candidateCheckout = job.steps.find((step) => step.name === 'Checkout exact candidate');
    assert.equal(candidateCheckout.with.ref, expected.candidateRef);
    assert.equal(candidateCheckout.with['fetch-depth'], 0);
    assert.equal(candidateCheckout.with.path, '.candidate');
    assert.equal(candidateCheckout.with['persist-credentials'], false);

    const trustedCheckout = job.steps.find((step) => step.name === 'Checkout protected base aggregate');
    assert.equal(trustedCheckout.if, "github.event_name == 'pull_request'");
    assert.equal(trustedCheckout.with.ref, '${{ github.event.pull_request.base.sha }}');
    assert.equal(trustedCheckout.with.path, '.trusted-base');
    assert.equal(trustedCheckout.with['persist-credentials'], false);

    const verify = job.steps.find((step) => step.name === `Verify explicit ${expected.name} dependencies`);
    assert.equal(verify.env.BASE_SHA, '${{ github.event.pull_request.base.sha }}');
    assert.equal(verify.env.CANDIDATE_ROOT, '${{ github.workspace }}/.candidate');
    assert.equal(verify.env.EVENT_NAME, '${{ github.event_name }}');
    assert.equal(verify.env.EXACT_SHA, '${{ github.event.pull_request.head.sha || github.sha }}');
    assert.equal(verify.env.TRUSTED_ROOT, '${{ github.workspace }}/.trusted-base');
    assert.match(verify.run, /if \[ "\$EVENT_NAME" != 'pull_request' \]/);
    assert.match(verify.run, /git -C "\$CANDIDATE_ROOT" rev-parse HEAD/);
    assert.match(verify.run, /git -C "\$TRUSTED_ROOT" rev-parse HEAD/);
    assert.match(verify.run, new RegExp(`RUNNER_TEMP/${expected.output}`));
    assert.match(verify.run, /node "\$TRUSTED_ROOT\/scripts\/classify-pr-paths\.mjs"/);
    assert.match(
      verify.run,
      /FLAGS_JSON="\$trusted_flags_json" node "\$TRUSTED_ROOT\/scripts\/verify-gate-results\.mjs"/,
    );
    assert.doesNotMatch(verify.run, /(?:npm ci|node_modules).*CANDIDATE_ROOT/);
    assert.doesNotMatch(verify.run, /secrets\./);
  }
});

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
