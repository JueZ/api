import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
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

test('supported delivery operations select both applications and retain production mutation guards', () => {
  const steps = environmentWorkflow.jobs.deploy.steps;
  const componentSteps = [
    'Verify complete deployed runtime safety policy',
    'Verify private WLH reference data is present',
    'Prepare exact deployable frontend bundle',
    'Prepare immutable Azure Functions package',
    'Install immutable Azure Functions package',
    'Deploy Angular static site with Azure OIDC',
  ].map((name) => {
    const step = steps.find((entry) => entry.name === name);
    assert.ok(step, name);
    return step;
  });
  const report = steps.find((entry) => entry.name === 'Report production deployment values after smoke tests');
  const selected = (step, inputs, mutationAllowed) => {
    // These step guards use only boolean operators and exact string comparisons.
    // Evaluate that shared subset for successful preceding steps, not an Actions runner emulator.
    const match = step.if.match(/^\$\{\{ (.*) \}\}$/);
    assert.ok(match, step.name);
    return runInNewContext(
      match[1],
      { inputs, steps: { production_guard: { outputs: { mutation_allowed: mutationAllowed } } } },
      { timeout: 100 },
    );
  };
  for (const id of ['deploy-test', 'promote-production', 'rollback-production', 'reconcile-production']) {
    const inputs = workflow.jobs[id].with;
    assert.ok(['test', 'prod'].includes(inputs.environmentName), id);
    for (const mutationAllowed of ['true', 'false', '', undefined]) {
      const expected = inputs.environmentName === 'test' || mutationAllowed === 'true';
      for (const step of componentSteps)
        assert.equal(selected(step, inputs, mutationAllowed), expected, `${id}: ${step.name}: ${mutationAllowed}`);
      assert.equal(
        selected(report, inputs, mutationAllowed),
        id === 'promote-production' && mutationAllowed === 'true',
        `${id}: production reporting: ${mutationAllowed}`,
      );
    }
  }
});

test('runtime smoke receives the resolved frontend URL without a component switch', () => {
  const root = mkdtempSync(join(tmpdir(), 'paired-runtime-smoke-'));
  const step = environmentWorkflow.jobs.deploy.steps.find((entry) => entry.name === 'Run runtime smoke tests');
  try {
    const result = spawnSync('bash', ['--noprofile', '--norc'], {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      encoding: 'utf8',
      timeout: 15000,
      input: `node() { [ "$1" = 'scripts/smoke-runtime.mjs' ] || return 1; "$TEST_NODE_EXEC" --input-type=module --eval 'import assert from "node:assert/strict"; assert.equal(process.env.FRONTEND_BASE_URL, "https://frontend.example.test"); assert.equal(process.env.EXPECTED_DEPLOYED_COMMIT_SHA, "a".repeat(40)); console.log("frontend-smoke-invoked");'; }\n${step.run}`,
      env: {
        ...process.env,
        TEST_NODE_EXEC: process.execPath.replaceAll('\\', '/'),
        RUNNER_TEMP: root.replaceAll('\\', '/'),
        GITHUB_ENV: join(root, 'environment').replaceAll('\\', '/'),
        GITHUB_STEP_SUMMARY: join(root, 'summary').replaceAll('\\', '/'),
        ENVIRONMENT_NAME: 'prod',
        GITHUB_RUN_ID: '123',
        GITHUB_RUN_ATTEMPT: '1',
        EFFECTIVE_BASE_URL: 'https://api.example.test',
        FRONTEND_BASE_URL: 'https://frontend.example.test',
        SOURCE_REF: 'a'.repeat(40),
        AUTH_ENABLED: 'true',
        WEB_AUTH_REDIRECT_URI: '',
        TEST_WEB_AUTH_REDIRECT_URI: '',
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'frontend-smoke-invoked');
  } finally {
    assert.equal(dirname(root), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('paired-runtime-smoke-'));
    rmSync(root, { recursive: true, force: true });
  }
});

test('the actual classification step honors explicit full delivery without forcing neutral pushes or stale main', () => {
  const cwd = fileURLToPath(new URL('../..', import.meta.url));
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).stdout.trim();
  assert.match(head, /^[0-9a-f]{40}$/);
  const step = workflow.jobs.classify.steps.find((entry) => entry.id === 'classify').run;
  const root = mkdtempSync(join(tmpdir(), 'manual-full-classification-'));
  const run = (name, overrides = {}) => {
    const directory = mkdtempSync(join(root, `${name}-`));
    const output = join(directory, 'github-output');
    // Execute the actual checked-in shell and classifier. Git reads the checkout;
    // the only GitHub call is replaced by a fixed current-main response.
    const result = spawnSync('bash', ['--noprofile', '--norc'], {
      cwd,
      encoding: 'utf8',
      timeout: 15000,
      input: `gh() { printf '%s\\n' "$TEST_CURRENT_MAIN"; }\nnode() { "$TEST_NODE_EXEC" "$@"; }\n${step}`,
      env: {
        ...process.env,
        GH_TOKEN: '',
        GITHUB_TOKEN: '',
        TEST_CURRENT_MAIN: head,
        TEST_NODE_EXEC: process.execPath.replaceAll('\\', '/'),
        GITHUB_REPOSITORY: 'JueZ/api',
        GITHUB_REF: 'refs/heads/main',
        HEAD_SHA: head,
        RUNNER_TEMP: directory.replaceAll('\\', '/'),
        GITHUB_OUTPUT: output.replaceAll('\\', '/'),
        EVENT_NAME: 'workflow_dispatch',
        REQUESTED_MODE: 'full',
        DELIVERY_V2_ENABLED: 'true',
        BASELINE_RESULT: 'success',
        BASELINE_STATUS: 'accepted',
        ACCEPTED_BASE_SHA: head,
        ...overrides,
      },
    });
    const contents = existsSync(output) ? readFileSync(output, 'utf8') : '';
    if (result.status === 0) {
      assert.equal((contents.match(/^deployment_required=/gm) ?? []).length, 1);
      assert.equal((contents.match(/^should_deploy=/gm) ?? []).length, 1);
    }
    return { ...result, output: contents };
  };
  try {
    const explicit = run('explicit');
    assert.equal(explicit.status, 0, explicit.stderr);
    assert.match(explicit.output, /^reason=explicit-protected-main-full-delivery$/m);
    assert.match(explicit.output, /^deployment_required=true$/m);
    assert.match(explicit.output, /^should_deploy=true$/m);
    for (const [name, env] of [
      ['push', { EVENT_NAME: 'push' }],
      ['dry-run', { REQUESTED_MODE: 'dry-run' }],
    ]) {
      const neutral = run(name, env);
      assert.equal(neutral.status, 0, neutral.stderr);
      assert.match(neutral.output, /^deployment_required=false$/m);
      assert.match(neutral.output, /^should_deploy=false$/m);
    }
    for (const [name, env] of [
      ['stale', { TEST_CURRENT_MAIN: 'f'.repeat(40) }],
      ['non-main', { GITHUB_REF: 'refs/heads/codex/example' }],
    ]) {
      const denied = run(name, env);
      assert.notEqual(denied.status, 0);
      assert.equal(denied.output, '');
    }
  } finally {
    assert.equal(dirname(root), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('manual-full-classification-'));
    rmSync(root, { recursive: true, force: true });
  }
});

test('actual archive verifier and signing identity are proven before any production write', () => {
  const steps = environmentWorkflow.jobs.deploy.steps;
  const index = (name) => steps.findIndex((step) => step.name === name);
  const probe = index('Prepare public archive-verifier readiness probe');
  const attest = index('Attest archive-verifier readiness probe');
  const verify = index('Verify actual archive signer and CLI before production mutation');
  const intent = index('Persist production mutation intent before first write');
  const write = index('Record production mutation receipt before infrastructure or application writes');
  assert.ok(probe >= 0 && probe < attest && attest < verify && verify < intent && intent < write);
  for (const position of [probe, attest, verify]) {
    assert.match(steps[position].if, /environmentName == 'prod'/);
    assert.match(steps[position].if, /production_guard.outputs.mutation_allowed == 'true'/);
    assert.equal(steps[position]['continue-on-error'], undefined);
  }
  assert.match(steps[verify].run, /accepted-release-store\.mjs verify/);
  assert.match(steps[verify].run, /archive-verifier-probe\.json/);
  assert.match(
    steps[index('Prepare immutable accepted production archive')].run,
    /accepted-release-store\.mjs prepare/,
  );
  assert.ok(index('Verify and publish accepted production archive') > index('Run telemetry gate'));
});

test('approved package authorization preflight precedes mutation and post-deployment smoke remains required', () => {
  const steps = environmentWorkflow.jobs.deploy.steps;
  const index = (name) => steps.findIndex((step) => step.name === name);
  const verified = index('Verify immutable release bundle');
  const mint = index('Mint smoke identity before environment mutation');
  const preflight = index('Verify smoke identity against the approved package before mutation');
  const intent = index('Persist production mutation intent before first write');
  const firstWrite = index('Record production mutation receipt before infrastructure or application writes');
  const infra = steps.findIndex((step) => step.id === 'infra');
  const smokeMint = index('Mint authenticated smoke token with GitHub OIDC');
  const smoke = index('Run authenticated smoke tests');
  assert.ok(
    verified >= 0 &&
      mint > verified &&
      preflight > mint &&
      intent > preflight &&
      firstWrite > intent &&
      infra > firstWrite,
  );
  assert.ok(smokeMint > infra && smoke > smokeMint);
  assert.match(steps[preflight].run, /release\/functionapp\.zip/);
  assert.match(steps[preflight].run, /--auth-module.*dist\/shared\/security\/auth\.js/);
  assert.match(steps[preflight].run, /ALLOW_ROLLBACK.*true.*reconcileConfiguration/);
  assert.match(steps[preflight].run, /az rest --method post.*\| node scripts\/verify-smoke-identity\.mjs/s);
  assert.match(steps[preflight].run, /--installed-settings-stdin/);
  for (const flag of ['WEATHER_SMOKE_ENABLED', 'YOUTUBE_TRANSCRIPT_SMOKE_ENABLED']) {
    assert.equal(steps[preflight].env[flag], steps[smoke].env[flag]);
  }
  assert.equal(steps[preflight].if, steps[smoke].if);
});

test('application-only deployment keeps one parameter set, production proof, retention and runtime gates', () => {
  const steps = environmentWorkflow.jobs.deploy.steps;
  const index = (name) => steps.findIndex((step) => step.name === name);
  const parameters = index('Prepare one private deployment parameter set');
  const decide = steps.findIndex((step) => step.id === 'configuration_decision');
  const intent = index('Persist production mutation intent before first write');
  const infra = steps.findIndex((step) => step.id === 'infra');
  const capture = index('Record private accepted production configuration');
  const ledger = index('Write release ledger');
  assert.ok(parameters >= 0 && parameters < decide && decide < intent && intent < infra);
  assert.ok(capture > index('Run telemetry gate') && capture < ledger);
  assert.match(steps[parameters].run, /az bicep build[\s\S]*prepare-deployment-parameters\.mjs/);
  assert.match(steps[decide].if, /environmentName == 'prod'/);
  assert.match(steps[decide].if, /production_guard.outputs.mutation_allowed == 'true'/);
  assert.equal(
    steps[decide].env.APPLICATION_ONLY_DEPLOYMENT_ENABLED,
    "${{ vars.APPLICATION_ONLY_DEPLOYMENT_ENABLED || 'false' }}",
  );
  assert.match(steps[infra].run, /application-only[\s\S]*deployment-configuration-store\.mjs update-retention/);
  assert.match(steps[infra].run, /deployment-template\.json[\s\S]*deployment-parameters\.json/);
  assert.match(steps[capture].if, /!inputs.allowRollback/);
  assert.match(steps[capture].run, /\[ -f .*deployment-configuration-pointer\.json/);
  assert.equal(steps[capture]['continue-on-error'], undefined);
});

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

test('accepted baseline requires full protected-main mode before production environment and OIDC', () => {
  const baseline = workflow.jobs.baseline;
  assert.match(baseline.if, /github\.ref == 'refs\/heads\/main'/);
  assert.match(baseline.if, /DEPLOY_PRODUCTION_ENABLED/);
  assert.match(baseline.if, /inputs\.mode == 'full'/);
  assert.equal(baseline.uses, './.github/workflows/deploy-environment.yml');
  assert.equal(baseline.with.baselineOnly, true);
  assert.equal(baseline.steps, undefined);
  const trustedBaseline = environmentWorkflow.jobs.baseline;
  assert.equal(trustedBaseline.environment, 'production');
  assert.match(trustedBaseline.if, /inputs\.baselineOnly/);
  assert.match(trustedBaseline.if, /github\.event\.inputs\.mode == 'full'/);
  assert.match(environmentWorkflow.jobs.preflight.if, /!inputs\.baselineOnly/);
  const currentMainIndex = trustedBaseline.steps.findIndex((step) => step.name.includes('current protected main'));
  const loginIndex = trustedBaseline.steps.findIndex((step) => step.name.includes('Azure OIDC login'));
  assert.ok(currentMainIndex >= 0 && currentMainIndex < loginIndex);
  assert.equal(workflow.jobs.classify.if, "${{ always() && inputs.mode != 'recover-production' }}");
  assert.ok(
    workflow.jobs.classify.steps.some((step) => /accepted-production-baseline-unavailable/.test(step.run ?? '')),
  );
});

test('reusable deployment permissions fit every direct caller and centralize issue writes', () => {
  assert.deepEqual(environmentWorkflow.permissions, {
    contents: 'read',
    'id-token': 'write',
    actions: 'read',
    attestations: 'write',
  });
  for (const jobName of [
    'baseline',
    'deploy-test',
    'promote-production',
    'rollback-production',
    'reconcile-production',
  ]) {
    assert.deepEqual(workflow.jobs[jobName].permissions, environmentWorkflow.permissions, jobName);
  }
  assert.deepEqual(environmentWorkflow.jobs.baseline.permissions, {
    actions: 'read',
    contents: 'read',
    'id-token': 'write',
  });
  assert.deepEqual(environmentWorkflow.jobs.preflight.permissions, { contents: 'read' });
  const attestation = environmentWorkflow.jobs.deploy.steps.find((step) => step.id === 'archive_attestation');
  assert.match(attestation.if, /inputs.environmentName == 'prod'/);
  assert.match(attestation.if, /mutation_allowed == 'true'/);
  assert.match(attestation.if, /success\(\)/);
  assert.doesNotMatch(environmentSource, /issues:\s*write/);
  assert.doesNotMatch(source, /issues:\s*write/);
});

test('production and rollback share one bounded concurrency group and exact known-good recovery', () => {
  assert.equal(workflow.jobs['promote-production'].concurrency.group, 'production-deployment');
  assert.equal(workflow.jobs['rollback-production'].concurrency.group, 'production-deployment');
  assert.equal(workflow.jobs['promote-production'].concurrency['cancel-in-progress'], false);
  assert.equal(workflow.jobs['rollback-production'].concurrency['cancel-in-progress'], false);
  assert.match(
    environmentWorkflow.jobs.baseline.steps.find((step) => step.id === 'select').run,
    /resolve-known-good-release\.mjs/,
  );
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
  assert.deepEqual(Object.keys(environmentWorkflow.jobs), ['baseline', 'preflight', 'deploy']);
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
  const infra = steps.findIndex((step) => step.id === 'infra');
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
  const steps = environmentWorkflow.jobs.deploy.steps;
  const transfer = steps.findIndex((step) => step.id === 'baseline_transfer');
  const release = steps.find((step) => step.name === 'Download exact accepted rendered production release');
  const ledger = steps.find((step) => step.name === 'Download exact accepted production release ledger');
  assert.ok(transfer >= 0 && transfer < steps.indexOf(release) && transfer < steps.indexOf(ledger));
  assert.ok(transfer < steps.findIndex((step) => step.name === 'Azure OIDC login'));
  assert.equal(release.with['run-id'], '${{ steps.baseline_transfer.outputs.accepted_release_run_id }}');
  assert.equal(ledger.with['run-id'], '${{ steps.baseline_transfer.outputs.accepted_ledger_run_id }}');
  assert.equal(
    release.with.name,
    'production-release-${{ steps.baseline_transfer.outputs.accepted_source_ref }}-${{ steps.baseline_transfer.outputs.accepted_release_correlation }}',
  );
  assert.equal(
    ledger.with.name,
    'release-ledger-prod-${{ steps.baseline_transfer.outputs.accepted_source_ref }}-${{ steps.baseline_transfer.outputs.accepted_ledger_correlation }}',
  );
  for (const id of ['promote-production', 'rollback-production'])
    assert.equal(workflow.jobs[id].with.acceptedBaselineArtifact, '${{ needs.baseline.outputs.baseline_artifact }}');
  assert.equal(
    workflow.jobs['reconcile-production'].with.acceptedBaselineArtifact,
    '${{ needs.recovery-context.outputs.acceptedBaselineArtifact }}',
  );
  assert.match(environmentSource, /RECOVERY_ORIGINAL_RUN_ID/);
  assert.match(environmentSource, /DELIVERY_MUTATION_RUN_ID/);
});

test('the baseline handoff rejects missing, mixed-run or malformed artifact coordinates before download', () => {
  const steps = environmentWorkflow.jobs.deploy.steps;
  const guard = steps.find((step) => step.name === 'Validate accepted baseline artifact coordinates');
  assert.ok(
    steps.indexOf(guard) <
      steps.findIndex((step) => step.name === 'Download fully verified accepted baseline identity'),
  );
  assert.equal(guard.env.BASELINE_CONTROLLER_REF, '${{ inputs.failedControllerRef || github.sha }}');
  assert.equal(guard.env.BASELINE_EVIDENCE_RUN_ID, '${{ inputs.evidenceRunId || github.run_id }}');
  for (const [controller, run] of [
    ['a'.repeat(40), '101'],
    ['b'.repeat(40), '100'],
  ]) {
    const env = {
      ...process.env,
      BASELINE_CONTROLLER_REF: controller,
      BASELINE_EVIDENCE_RUN_ID: run,
      BASELINE_ARTIFACT: `accepted-production-baseline-${controller}-${run}`,
    };
    for (const [overrides, expected] of [
      [{}, 0],
      [{ BASELINE_ARTIFACT: '' }, 1],
      [{ BASELINE_CONTROLLER_REF: 'c'.repeat(40) }, 1],
      [{ BASELINE_EVIDENCE_RUN_ID: '102' }, 1],
      [{ BASELINE_EVIDENCE_RUN_ID: `${run}\nOTHER=value` }, 1],
    ]) {
      const result = spawnSync('bash', ['--noprofile', '--norc'], {
        input: guard.run,
        env: { ...env, ...overrides },
        encoding: 'utf8',
        timeout: 10000,
      });
      assert.equal(result.status, expected, result.stderr);
    }
  }
});

test('explicit configuration recovery stays in the trusted controller and cannot bypass fresh state or policy proof', () => {
  assert.ok(workflow.on.workflow_dispatch.inputs.mode.options.includes('recover-production'));
  const context = workflow.jobs['recovery-context'];
  assert.match(context.if, /workflow_dispatch/);
  assert.match(context.if, /refs\/heads\/main/);
  assert.match(context.if, /DEPLOY_PRODUCTION_ENABLED/);
  assert.equal(context.permissions['id-token'], undefined);
  const recovery = workflow.jobs['reconcile-production'];
  assert.equal(recovery.uses, './.github/workflows/deploy-environment.yml');
  assert.equal(recovery.with.reconcileConfiguration, true);
  assert.equal(recovery.with.allowRollback, true);
  assert.equal(recovery.concurrency.group, workflow.jobs['promote-production'].concurrency.group);
  assert.match(workflow.jobs.classify.if, /inputs.mode != 'recover-production'/);
  assert.match(workflow.jobs.summary.if, /inputs.mode != 'recover-production'/);
  const steps = environmentWorkflow.jobs.deploy.steps;
  const guard = steps.find((step) => step.id === 'production_guard').run;
  assert.match(guard, /current_main.*GITHUB_SHA/);
  assert.match(guard, /mutationReceipt.controllerRef == \$controller/);
  assert.match(guard, /mutationReceipt.runId == \$run/);
  assert.match(steps.find((step) => step.id === 'infra').if, /inputs.reconcileConfiguration/);
  const ledger = steps.find((step) => step.name === 'Write release ledger').run;
  assert.match(ledger, /steps.infra.outcome/);
  assert.match(ledger, /steps.runtime_policy.outcome/);
  assert.match(ledger, /RECOVERY_CONFIGURATION_UNCERTAIN=false/);
});
