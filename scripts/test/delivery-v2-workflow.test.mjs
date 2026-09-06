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
  assert.match(environmentSource, /DEPLOY_PRODUCTION_ENABLED/);
  assert.doesNotMatch(source, /deployRequested|deploymentRequested|explicitApproval|productionApproval/i);
  assert.doesNotMatch(environmentSource, /deployRequested|deploymentRequested|explicitApproval|productionApproval/i);
  assert.doesNotMatch(source, /workflow_run|repository_dispatch|gh run list|sleep [0-9]/);
  assert.equal(loadAutonomousPolicy().deployment.controllerWorkflow, 'delivery-v2.yml');
});

test('delivery DAG resolves accepted production before cumulative classification and promotion', () => {
  assert.deepEqual(needs(workflow.jobs.classify), ['baseline']);
  assert.deepEqual(needs(workflow.jobs.build), ['classify']);
  assert.deepEqual(needs(workflow.jobs.attest), ['build']);
  assert.deepEqual(needs(workflow.jobs['deploy-test']), ['classify', 'build', 'attest']);
  assert.deepEqual(needs(workflow.jobs['current-main']), ['baseline', 'classify', 'deploy-test']);
  assert.deepEqual(needs(workflow.jobs['promote-production']), [
    'baseline',
    'classify',
    'build',
    'deploy-test',
    'current-main',
  ]);
  assert.equal((source.match(/build-release-artifacts\.sh/g) ?? []).length, 1);
  assert.equal((source.match(/git\/ref\/heads\/main/g) ?? []).length, 3);
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

test('accepted baseline requires full protected-main mode before production environment and OIDC', () => {
  const baseline = workflow.jobs.baseline;
  assert.match(baseline.if, /github\.ref == 'refs\/heads\/main'/);
  assert.match(baseline.if, /DEPLOY_PRODUCTION_ENABLED/);
  assert.match(baseline.if, /inputs\.mode == 'full'/);
  assert.equal(baseline.environment, 'production');
  const currentMainIndex = baseline.steps.findIndex((step) => step.name.includes('current protected main'));
  const loginIndex = baseline.steps.findIndex((step) => step.name.includes('Azure OIDC login'));
  assert.ok(currentMainIndex >= 0 && currentMainIndex < loginIndex);
  assert.equal(workflow.jobs.classify.if, 'always()');
  assert.ok(
    workflow.jobs.classify.steps.some((step) => /accepted-production-baseline-unavailable/.test(step.run ?? '')),
  );
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
  assert.match(source, /production-mutation-intent-/);
  assert.match(source, /production-mutation-prepared-/);
  assert.equal(
    workflow.jobs['rollback-production'].with.failedMutationArtifact,
    '${{ needs.resolve-rollback.outputs.mutation_artifact }}',
  );
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
  assert.deepEqual(Object.keys(environmentWorkflow.jobs), ['preflight', 'deploy']);
  assert.equal(environmentWorkflow.jobs.deploy.needs, 'preflight');
  assert.equal(environmentWorkflow.jobs.deploy.if, "${{ needs.preflight.outputs.proceed == 'true' }}");
  const preflight = environmentWorkflow.jobs.preflight.steps[0];
  assert.match(preflight.name, /before production environment and OIDC/);
  assert.match(preflight.run, /guard_state=superseded/);
});

test('normal environment deployment disables and deletes every retired scheduled-query alert', () => {
  const cleanup = environmentWorkflow.jobs.deploy.steps.find(
    (step) => step.name === 'Remove retired scheduled-query alerts',
  );

  assert.equal(
    cleanup.if,
    "${{ !inputs.allowRollback && (inputs.environmentName != 'prod' || steps.production_guard.outputs.mutation_allowed == 'true') }}",
  );
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
    'Superseded by:',
    'Terminal outcome:',
    'Recovery state:',
    'Rollback verification:',
    'Repair attempts:',
  ]) {
    assert.match(summary, new RegExp(field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(summary, /test_verification="not_applicable"/);
  assert.match(summary, /test_verification="passed"/);
  assert.match(summary, /production_verification="not_applicable"/);
  assert.match(summary, /terminal_outcome="superseded"/);
  assert.match(summary, /terminal_outcome="incomplete"/);
  assert.match(summary, /Deployment applicability output is missing or invalid/);
  assert.match(summary, /Runtime-neutral delivery unexpectedly reached production/);
  assert.match(summary, /schemaVersion:2/);
  assert.match(summary, /deploymentRequired:/);
  assert.match(summary, /supersededBy/);
  assert.match(summary, /rawJobs:/);
  assert.match(summary, /mutation:\{guard:/);
  assert.match(summary, /started:\(\$mutationStarted=="true"\)/);
  assert.equal(workflow.jobs.summary.steps[1].with['retention-days'], 30);
});

test('production recovery is fully prepared and durably recorded before mutating application identity', () => {
  const steps = environmentWorkflow.jobs.deploy.steps;
  const index = (name) => steps.findIndex((step) => step.name === name);
  const verifyRecovery = index('Verify complete recovery bundle before production mutation');
  const observe = index('Capture production state inside mutation lock');
  const guard = index('Decide production mutation inside lock');
  const intent = index('Upload pre-write production mutation intent');
  const receipt = index('Record production mutation receipt before infrastructure or application writes');
  const infra = index('Deploy Bicep infrastructure');
  const frontendIdentity = index('Bind rendered frontend identity before application writes');
  const preparePackage = index('Prepare immutable Azure Functions package');
  const checkpoint = index('Upload application-ready production mutation checkpoint');
  const installPackage = index('Install immutable Azure Functions package');
  const installFrontend = index('Deploy Angular static site with Azure OIDC');
  for (const value of [
    verifyRecovery,
    observe,
    guard,
    intent,
    receipt,
    infra,
    frontendIdentity,
    preparePackage,
    checkpoint,
    installPackage,
    installFrontend,
  ]) {
    assert.ok(value >= 0);
  }
  assert.ok(verifyRecovery < observe && observe < guard && guard < intent && intent < receipt && receipt < infra);
  assert.match(steps[receipt].run, /--name "\$AZURE_FUNCTIONAPP_NAME"/);
  assert.doesNotMatch(steps[receipt].run, /\$EFFECTIVE_FUNCTIONAPP_NAME/);
  assert.ok(frontendIdentity < preparePackage && preparePackage < checkpoint);
  assert.ok(checkpoint < installPackage && checkpoint < installFrontend);
  assert.match(steps[checkpoint].with.name, /production-mutation-prepared-/);
});

test('production capture resolves existing deployment resources instead of stale repository storage settings', () => {
  const capture = readFileSync(new URL('../capture-production-state.sh', import.meta.url), 'utf8');
  assert.match(capture, /deployment group show[^\n]*--name main-prod/);
  assert.match(capture, /staticWebStorageAccountResourceName/);
  assert.match(capture, /releaseStorageAccountResourceName/);
  assert.match(capture, /--query primaryEndpoints\.web/);
  assert.doesNotMatch(capture, /\$AZURE_STATIC_WEB_STORAGE_ACCOUNT/);
  assert.equal(workflow.jobs['resolve-rollback'].steps[0].env.GH_TOKEN, '${{ github.token }}');
});

test('baseline and rollback keep original bundle provenance separate from current acceptance evidence', () => {
  assert.equal(workflow.jobs['promote-production'].with.acceptedReleaseRunId, '${{ needs.baseline.outputs.run_id }}');
  assert.equal(
    workflow.jobs['promote-production'].with.acceptedLedgerRunId,
    '${{ needs.baseline.outputs.acceptance_run_id }}',
  );
  assert.equal(
    workflow.jobs['rollback-production'].with.rollbackReleaseRunId,
    '${{ needs.resolve-rollback.outputs.rollback_run_id }}',
  );
  assert.match(environmentSource, /RECOVERY_ORIGINAL_RUN_ID/);
  assert.match(environmentSource, /DELIVERY_MUTATION_RUN_ID/);
});
