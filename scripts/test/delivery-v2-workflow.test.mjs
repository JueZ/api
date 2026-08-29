import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse as parseYaml } from 'yaml';
import { loadAutonomousPolicy } from '../lib/autonomous-policy.mjs';

const source = readFileSync(new URL('../../.github/workflows/delivery-v2.yml', import.meta.url), 'utf8');
const workflow = parseYaml(source);
const environmentSource = readFileSync(
  new URL('../../.github/workflows/deploy-environment.yml', import.meta.url),
  'utf8',
);
const environmentWorkflow = parseYaml(environmentSource);

function needs(job) {
  return Array.isArray(job.needs) ? job.needs : job.needs ? [job.needs] : [];
}

test('delivery v2 is a protected-main push DAG with a guarded manual cutover surface', () => {
  assert.deepEqual(workflow.on.push.branches, ['main']);
  assert.ok(workflow.on.workflow_dispatch.inputs.mode.options.includes('dry-run'));
  assert.ok(workflow.on.workflow_dispatch.inputs.mode.options.includes('test-only'));
  assert.ok(workflow.on.workflow_dispatch.inputs.mode.options.includes('full'));
  assert.match(source, /DELIVERY_V2_ENABLED: \$\{\{ vars\.DELIVERY_V2_ENABLED \}\}/);
  assert.doesNotMatch(source, /workflow_run|repository_dispatch|gh run list|sleep [0-9]/);
  assert.equal(loadAutonomousPolicy().deployment.controllerWorkflow, 'delivery-v2.yml');
});

test('delivery DAG builds and attests once before test, then reads main once before production', () => {
  assert.deepEqual(needs(workflow.jobs.build), ['classify']);
  assert.deepEqual(needs(workflow.jobs.attest), ['build']);
  assert.deepEqual(needs(workflow.jobs['deploy-test']), ['classify', 'build', 'attest']);
  assert.deepEqual(needs(workflow.jobs['current-main']), ['classify', 'deploy-test']);
  assert.deepEqual(needs(workflow.jobs['promote-production']), ['classify', 'build', 'deploy-test', 'current-main']);
  assert.equal((source.match(/build-release-artifacts\.sh/g) ?? []).length, 1);
  assert.equal((source.match(/git\/ref\/heads\/main/g) ?? []).length, 2);
  assert.match(workflow.jobs['current-main'].steps[0].name, /Read current main once/);
  assert.equal(workflow.jobs['deploy-test'].with.expectedFunctionDigest, '${{ needs.build.outputs.function_digest }}');
  assert.equal(
    workflow.jobs['promote-production'].with.expectedFunctionDigest,
    '${{ needs.build.outputs.function_digest }}',
  );
  assert.equal(workflow.jobs['deploy-test'].with.expectedFrontendDigest, '${{ needs.build.outputs.frontend_digest }}');
  assert.equal(
    workflow.jobs['promote-production'].with.expectedFrontendDigest,
    '${{ needs.build.outputs.frontend_digest }}',
  );
  assert.equal(workflow.jobs['deploy-test'].with.expectedSbomDigest, '${{ needs.build.outputs.sbom_digest }}');
  assert.equal(workflow.jobs['promote-production'].with.expectedSbomDigest, '${{ needs.build.outputs.sbom_digest }}');
});

test('reusable deployment permissions fit every direct caller and centralize issue writes', () => {
  assert.deepEqual(environmentWorkflow.permissions, {
    contents: 'read',
    'id-token': 'write',
    actions: 'read',
  });
  for (const jobName of ['deploy-test', 'promote-production', 'rollback-production']) {
    assert.deepEqual(workflow.jobs[jobName].permissions, environmentWorkflow.permissions, jobName);
  }
  assert.doesNotMatch(environmentSource, /issues:\s*write/);
  assert.doesNotMatch(source, /issues:\s*write/);
});

test('production and rollback share one bounded concurrency group and exact known-good recovery', () => {
  assert.equal(workflow.jobs['promote-production'].concurrency.group, 'production-deployment');
  assert.equal(workflow.jobs['rollback-production'].concurrency.group, 'production-deployment');
  assert.equal(workflow.jobs['promote-production'].concurrency['cancel-in-progress'], false);
  assert.equal(workflow.jobs['rollback-production'].concurrency['cancel-in-progress'], false);
  assert.match(source, /resolve-known-good-release\.mjs/);
  assert.match(source, /previous_production_sha/);
  assert.equal(workflow.jobs['rollback-production'].with.allowRollback, true);
  assert.doesNotMatch(source, /secrets:\s*inherit/);
});

test('direct environment mode preserves OIDC, exact artifact, smoke, telemetry, and ledger controls', () => {
  for (const required of [
    'Azure OIDC login',
    'Verify immutable release bundle',
    'Run runtime smoke tests',
    'Run authenticated smoke tests',
    'Run telemetry gate',
    'Write release ledger',
  ]) {
    assert.match(environmentSource, new RegExp(required));
  }
  assert.match(environmentSource, /CURRENT_MAIN_CONFIRMED_REF/);
  assert.match(environmentSource, /\.github\/workflows\/delivery-v2\.yml/);
  assert.doesNotMatch(environmentSource, /repository_dispatch|deliveryMode|deploy-test-provenance/);
  assert.match(environmentSource, /expectedFunctionDigest/);
});

test('normal environment deployment disables and deletes every retired scheduled-query alert', () => {
  const cleanup = environmentWorkflow.jobs.deploy.steps.find(
    (step) => step.name === 'Remove retired scheduled-query alerts',
  );

  assert.equal(cleanup.if, '${{ !inputs.allowRollback }}');
  for (const suffix of ['function-5xx', 'auth-spike', 'bring-protocol']) {
    assert.match(cleanup.run, new RegExp(`alert-api-catalogue-\\$\\{ENVIRONMENT_NAME\\}-${suffix}`));
  }
  assert.match(cleanup.run, /--set properties\.enabled=false/);
  assert.match(cleanup.run, /az resource delete --ids/);
  assert.match(cleanup.run, /Microsoft\.Insights\/scheduledQueryRules/);
  assert.match(cleanup.run, /Expected no scheduled-query alerts/);
});

test('delivery summary reports classification, duration, skips, identity, environments, and recovery', () => {
  const summary = workflow.jobs.summary.steps.find((step) => step.name === 'Write concise delivery summary').run;
  for (const field of [
    'Classification:',
    'Exact SHA:',
    'Duration:',
    'Artifact manifest digest:',
    'Test deployment, smoke, authenticated smoke, telemetry, SHA and digest:',
    'Production deployment, smoke, authenticated smoke, telemetry, SHA and digest:',
    'Superseded before production:',
    'Recovery state:',
    'Rollback verification:',
    'Repair attempts:',
  ]) {
    assert.match(summary, new RegExp(field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.equal(workflow.jobs.summary.steps[1].with['retention-days'], 30);
});
