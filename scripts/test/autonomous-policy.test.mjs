import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  classifyRisk,
  isAutomergeCandidate,
  loadAutonomousPolicy,
  matchesPolicyGlob,
  validateAutonomousPolicy,
} from '../lib/autonomous-policy.mjs';
import {
  calculateReviewBudget,
  evaluatePullRequestState,
  evaluateRequiredChecks,
  mergeGateDecision,
  runRequiredCheckPreflight,
  runReview,
  validateAutonomousReview,
} from '../autonomous-merge-controller.mjs';

const headSha = 'a'.repeat(40);
const policy = loadAutonomousPolicy();
const mainDeliveryWorkflow = readFileSync(
  new URL('../../.github/workflows/codex-main-delivery.yml', import.meta.url),
  'utf8',
);
const codexAutomergeWorkflow = readFileSync(
  new URL('../../.github/workflows/codex-automerge.yml', import.meta.url),
  'utf8',
);
const autonomousControllerSource = readFileSync(new URL('../autonomous-merge-controller.mjs', import.meta.url), 'utf8');
const deployEnvironmentWorkflow = readFileSync(
  new URL('../../.github/workflows/deploy-environment.yml', import.meta.url),
  'utf8',
);
const deployTestWorkflow = readFileSync(new URL('../../.github/workflows/deploy-test.yml', import.meta.url), 'utf8');
const promoteProductionWorkflow = readFileSync(
  new URL('../../.github/workflows/promote-production.yml', import.meta.url),
  'utf8',
);
const rollbackProductionWorkflow = readFileSync(
  new URL('../../.github/workflows/rollback-production.yml', import.meta.url),
  'utf8',
);
const runtimeSettingsPolicy = readFileSync(
  new URL('../validate-deployed-runtime-settings.mjs', import.meta.url),
  'utf8',
);
const mainBicep = readFileSync(new URL('../../infra/main.bicep', import.meta.url), 'utf8');

function pullRequest(overrides = {}) {
  return {
    state: 'open',
    draft: false,
    mergeable: true,
    mergeable_state: 'clean',
    labels: [],
    head: { ref: 'codex/example', sha: headSha, repo: { full_name: 'JueZ/api' } },
    base: { ref: 'main', repo: { full_name: 'JueZ/api' } },
    ...overrides,
  };
}

function successfulChecks() {
  return policy.requiredChecks.map((required, index) => ({
    id: index + 1,
    name: required.name,
    head_sha: headSha,
    status: 'completed',
    conclusion: 'success',
    app: { slug: required.appSlug },
  }));
}

test('canonical autonomous policy is internally valid', () => {
  assert.deepEqual(validateAutonomousPolicy(policy), []);
  assert.equal(policy.merge.allowAdminBypass, false);
  assert.equal(policy.autonomousReview.humanApprovalRequired, false);
  assert.equal(policy.autonomousReview.model, 'gpt-5.6-sol');
  assert.equal(policy.autonomousReview.reasoningEffort, 'high');
  assert.equal(policy.autonomousReview.maxDiffBytes, 40_000);
  assert.equal(policy.autonomousReview.maxOutputTokens, 1_500);
  assert.equal(policy.autonomousReview.maxEstimatedCostUsd, 0.31);
  assert.match(codexAutomergeWorkflow, /Wait for free deterministic exact-head checks/);
  assert.match(codexAutomergeWorkflow, /AUTONOMOUS_REVIEW_LIVE_API_ENABLED: 'true'/);
  assert.doesNotMatch(codexAutomergeWorkflow, /labeled, unlabeled/);
  assert.match(autonomousControllerSource, /maxRetries: 0/);
});

test('Codex auto-merge completion dispatches exact main CI through one delivery controller', () => {
  assert.match(mainDeliveryWorkflow, /workflows: \[CI, Codex Auto-Merge\]/);
  assert.match(mainDeliveryWorkflow, /run main delivery after Codex auto-merge/);
  assert.match(mainDeliveryWorkflow, /gh run download "\$TRIGGER_RUN_ID"/);
  assert.match(mainDeliveryWorkflow, /\[ "\$pr_head" != "\$reviewed_head" \]/);
  assert.match(mainDeliveryWorkflow, /-f delivery_correlation="\$ci_correlation"/);
  assert.match(mainDeliveryWorkflow, /wait_for_dispatch ci\.yml "\$ci_title" "\$ci_started_at" "\$SOURCE_REF" "CI"/);
  assert.match(mainDeliveryWorkflow, /Dispatch correlation matched more than one/);
  assert.match(mainDeliveryWorkflow, /\.path == \$path/);
  assert.match(mainDeliveryWorkflow, /\(\.name == \$workflow_name or \.name == \$title\)/);
  assert.match(mainDeliveryWorkflow, /github\.run_attempt == 1/);
  assert.match(mainDeliveryWorkflow, /github\.event\.workflow_run\.run_attempt == 1/);
  assert.match(mainDeliveryWorkflow, /A main-delivery run already consumed trigger/);
  assert.match(mainDeliveryWorkflow, /\.path == "\.github\/workflows\/codex-automerge\.yml"/);
  assert.match(mainDeliveryWorkflow, /-f ci_run_id="\$CI_RUN_ID"/);
  assert.match(mainDeliveryWorkflow, /-f ci_delivery_correlation="\$CI_DELIVERY_CORRELATION"/);
  assert.match(mainDeliveryWorkflow, /Pinned Deploy Test run did not emit matching successful provenance/);
  assert.match(mainDeliveryWorkflow, /Pinned production run did not emit matching successful runtime-truth evidence/);
  assert.equal(mainDeliveryWorkflow.match(/^\s+assert_current_main$/gm)?.length, 4);
});

test('environment deployment rechecks current main at mutation and acceptance boundaries', () => {
  assert.ok((deployEnvironmentWorkflow.match(/node scripts\/assert-current-main\.mjs/g) ?? []).length >= 9);
  assert.match(deployEnvironmentWorkflow, /name: Verify complete deployed runtime safety policy/);
  assert.match(deployEnvironmentWorkflow, /node scripts\/validate-deployed-runtime-settings\.mjs --arm-response/);
  assert.doesNotMatch(deployEnvironmentWorkflow, /runtime-setting-names\.json|runtime-safety-settings\.json/);
  assert.match(deployEnvironmentWorkflow, /resolve_single_resource_by_type Microsoft\.Insights\/components/);
  assert.match(deployEnvironmentWorkflow, /resolve_key_vault_by_purpose/);
  assert.match(deployEnvironmentWorkflow, /--query properties\.ConnectionString/);
  assert.match(deployEnvironmentWorkflow, /--query properties\.secretUriWithVersion/);
  assert.match(deployEnvironmentWorkflow, /EXPECTED_REDDIT_CLIENT_SECRET_REFERENCE=/);
  assert.match(deployEnvironmentWorkflow, /EXPECTED_OPENAI_API_KEY_REFERENCE=/);
  assert.doesNotMatch(deployEnvironmentWorkflow, /az keyvault secret show/);
  assert.match(runtimeSettingsPolicy, /APPLICATIONINSIGHTS_CONNECTION_STRING: requiredValue/);
  assert.match(runtimeSettingsPolicy, /REDDIT_CLIENT_SECRET: requiredValue/);
  assert.match(runtimeSettingsPolicy, /OPENAI_API_KEY: openAiReference/);
  assert.match(deployEnvironmentWorkflow, /actions\/runs\/\$\{CI_RUN_ID\}/);
  assert.match(deployEnvironmentWorkflow, /expected_ci_title="CI \$deployment_ref \$CI_DELIVERY_CORRELATION"/);
  assert.match(deployEnvironmentWorkflow, /\(\.name == \$workflow_name or \.name == \$title\)/);
  assert.doesNotMatch(deployEnvironmentWorkflow, /actions\/workflows\/ci\.yml\/runs\?branch=main/);
  assert.match(deployEnvironmentWorkflow, /effective_web_api_base_url="\$EFFECTIVE_BASE_URL"/);
  assert.match(deployEnvironmentWorkflow, /name: Checkout current deployment controller/);
  assert.match(deployEnvironmentWorkflow, /ref: \$\{\{ inputs\.controllerRef \}\}/);
  assert.match(deployEnvironmentWorkflow, /CONTROLLER_WORKFLOW_SHA/);
  assert.match(deployEnvironmentWorkflow, /actions\/runs\/\$\{GITHUB_RUN_ID\}/);
  assert.match(deployEnvironmentWorkflow, /\.head_sha == \$controller_ref/);
  assert.doesNotMatch(deployEnvironmentWorkflow, /ref: main/);
  assert.match(deployEnvironmentWorkflow, /Historical production ledger is missing exact successful release evidence/);
  assert.match(
    deployEnvironmentWorkflow,
    /EXPECTED_DELIVERY_CORRELATION="\$ROLLBACK_RELEASE_CORRELATION"[\s\\]+node scripts\/validate-release-ledger\.mjs/,
  );
  assert.match(deployEnvironmentWorkflow, /\.deliveryCorrelation == \$correlation/);
  assert.match(deployEnvironmentWorkflow, /actions\/runs\/\$\{TEST_DELIVERY_RUN_ID\}/);
  assert.match(deployEnvironmentWorkflow, /name: Download exact accepted production release bundle/);
  assert.match(deployEnvironmentWorkflow, /run-id: \$\{\{ inputs\.rollbackReleaseRunId \}\}/);
  assert.match(deployEnvironmentWorkflow, /name: Preserve exact accepted production release bundle/);
  assert.doesNotMatch(deployEnvironmentWorkflow, /successful_test_run_ids/);
  assert.doesNotMatch(deployEnvironmentWorkflow, /ROLLBACK_PROVENANCE_VERIFIED/);
  assert.match(deployEnvironmentWorkflow, /deliveryCorrelation: \$deliveryCorrelation/);
  assert.match(deployEnvironmentWorkflow, /\[ "\$GITHUB_RUN_ATTEMPT" != "1" \]/);
  assert.match(deployEnvironmentWorkflow, /\.run_attempt == 1/);
  assert.match(deployEnvironmentWorkflow, /\.runAttempt == "1"/);
  assert.ok(
    deployEnvironmentWorkflow.includes(
      'name: release-ledger-${{ inputs.environmentName }}-${{ inputs.sourceRef || github.sha }}-${{ inputs.deliveryCorrelation }}',
    ),
  );
  assert.ok(mainDeliveryWorkflow.includes('--name "deploy-test-provenance-$SOURCE_REF-$test_correlation"'));
  assert.ok(mainDeliveryWorkflow.includes('--name "release-ledger-prod-$SOURCE_REF-$production_correlation"'));
  assert.match(mainDeliveryWorkflow, /-f test_delivery_correlation="\$test_correlation"/);
  assert.match(mainDeliveryWorkflow, /-f test_run_id="\$test_run_id"/);
  assert.match(deployTestWorkflow, /ciRunId: \$\{\{ inputs\.ci_run_id \}\}/);
  assert.match(deployTestWorkflow, /ciDeliveryCorrelation: \$\{\{ inputs\.ci_delivery_correlation \}\}/);
  assert.match(promoteProductionWorkflow, /ciRunId: \$\{\{ inputs\.ci_run_id \}\}/);
  assert.match(promoteProductionWorkflow, /ciDeliveryCorrelation: \$\{\{ inputs\.ci_delivery_correlation \}\}/);
  for (const workflow of [deployTestWorkflow, promoteProductionWorkflow, rollbackProductionWorkflow]) {
    assert.match(workflow, /controllerRef: \$\{\{ github\.sha \}\}/);
    assert.match(workflow, /controllerWorkflowSha: \$\{\{ github\.workflow_sha \}\}/);
  }
  assert.doesNotMatch(promoteProductionWorkflow, /inputs\.deploy_frontend|inputs\.deploy_functions/);
  assert.match(promoteProductionWorkflow, /deployFrontend: true/);
  assert.match(promoteProductionWorkflow, /deployFunctions: true/);
});

test('rollback changes only accepted application packages and leaves infrastructure configuration unchanged', () => {
  assert.match(
    deployEnvironmentWorkflow,
    /- name: Deploy Bicep infrastructure\n\s+if: \$\{\{ !inputs\.allowRollback \}\}/,
  );
  assert.match(
    deployEnvironmentWorkflow,
    /- name: Verify complete deployed runtime safety policy\n\s+if: \$\{\{ inputs\.deployFunctions \}\}/,
  );
  assert.match(deployEnvironmentWorkflow, /resolve_storage_by_purpose immutable-release-packages/);
  assert.match(deployEnvironmentWorkflow, /resolve_storage_by_purpose public-static-site/);
  assert.match(deployEnvironmentWorkflow, /resolve_storage_by_purpose private-integration-state/);
  assert.match(deployEnvironmentWorkflow, /resolve_storage_by_purpose function-host/);
  assert.match(
    deployEnvironmentWorkflow,
    /if \[ "\$ALLOW_ROLLBACK" != "true" \]; then[\s\S]*?az storage container create/,
  );
  assert.match(
    deployEnvironmentWorkflow,
    /if \[ "\$ALLOW_ROLLBACK" != "true" \]; then[\s\S]*?az storage blob service-properties update/,
  );
  assert.match(
    deployEnvironmentWorkflow,
    /Rollback requires the accepted digest-addressed Function package to already exist/,
  );
  const functionIndex = deployEnvironmentWorkflow.indexOf('- name: Package and deploy Azure Functions');
  const staticIndex = deployEnvironmentWorkflow.indexOf('- name: Deploy Angular static site with Azure OIDC');
  const functionDeployment = deployEnvironmentWorkflow.slice(functionIndex, staticIndex);
  assert.match(mainBicep, /resource releaseBlobService[\s\S]*?isVersioningEnabled: true/);
  assert.match(functionDeployment, /--query versionId/);
  assert.match(functionDeployment, /--version-id "\$release_version_id"/);
  assert.match(functionDeployment, /\?versionid=\$encoded_release_version_id/);
  assert.match(functionDeployment, /Function App did not retain the exact immutable package-version pointer/);
  assert.ok(
    functionDeployment.indexOf('--version-id "$release_version_id"') <
      functionDeployment.indexOf('WEBSITE_RUN_FROM_PACKAGE=$package_url'),
  );
  assert.match(runtimeSettingsPolicy, /required managed setting is missing/);
  assert.match(runtimeSettingsPolicy, /unmanaged app setting is present/);
  assert.match(
    deployEnvironmentWorkflow,
    /Production promotion and rollback require both Function and frontend packages/,
  );
  assert.match(deployEnvironmentWorkflow, /name: Verify current generation before evidence publication/);
  const telemetryIndex = deployEnvironmentWorkflow.indexOf('- name: Run telemetry gate');
  const finalGenerationIndex = deployEnvironmentWorkflow.indexOf(
    '- name: Verify current generation before evidence publication',
  );
  const ledgerIndex = deployEnvironmentWorkflow.indexOf('- name: Write release ledger');
  assert.ok(telemetryIndex < finalGenerationIndex && finalGenerationIndex < ledgerIndex);
  assert.equal(functionDeployment.match(/DEPLOYED_ENVIRONMENT_NAME=/g)?.length, 1);
  assert.match(
    functionDeployment,
    /if \[ "\$ALLOW_ROLLBACK" != "true" \]; then\n\s+package_settings\+=\("DEPLOYED_ENVIRONMENT_NAME=\$ENVIRONMENT_NAME"\)/,
  );
});

test('frontend rendering is finalized, hashed, and preserved before either application package is deployed', () => {
  const prepareIndex = deployEnvironmentWorkflow.indexOf('- name: Prepare exact deployable frontend bundle');
  const functionIndex = deployEnvironmentWorkflow.indexOf('- name: Package and deploy Azure Functions');
  const staticIndex = deployEnvironmentWorkflow.indexOf('- name: Deploy Angular static site with Azure OIDC');
  const acceptanceIndex = deployEnvironmentWorkflow.indexOf(
    '- name: Verify current generation before runtime acceptance',
  );
  assert.ok(prepareIndex > 0 && prepareIndex < functionIndex && functionIndex < staticIndex);
  assert.match(deployEnvironmentWorkflow, /FRONTEND_SOURCE_ARTIFACT_SHA256=\$frontend_digest/);
  assert.match(deployEnvironmentWorkflow, /sourceFrontendSha256: \$sourceFrontendSha256/);
  assert.match(
    deployEnvironmentWorkflow,
    /Rollback preserves the previously accepted production frontend archive byte-for-byte/,
  );
  assert.match(
    deployEnvironmentWorkflow,
    /Accepted rollback frontend metadata does not match the selected production release/,
  );
  assert.match(deployEnvironmentWorkflow, /sha256sum functionapp\.zip frontend\.tar\.gz sbom\.cdx\.json > SHA256SUMS/);
  assert.match(deployEnvironmentWorkflow, /release-manifest-rendered\.json/);
  const staticDeployment = deployEnvironmentWorkflow.slice(staticIndex, acceptanceIndex);
  assert.doesNotMatch(staticDeployment, /API_CATALOGUE_CONFIG/);
  assert.doesNotMatch(staticDeployment, /> "\$output_dir\/assets\/build-info\.json"/);
  assert.match(staticDeployment, /Exact frontend release lacks assets\/config\.js/);
  assert.match(staticDeployment, /Exact frontend build metadata does not match the selected release/);
  assert.match(staticDeployment, /frontend-inventory\.mjs create "\$output_dir" "\$frontend_inventory"/);
  assert.match(staticDeployment, /frontend-inventory\.mjs plan-stale/);
  assert.match(
    staticDeployment,
    /while IFS= read -r stale_blob; do\n\s+node scripts\/assert-current-main\.mjs[\s\S]*?az storage blob delete/,
  );
  assert.doesNotMatch(staticDeployment, /az storage blob delete-batch/);
  assert.equal(staticDeployment.match(/frontend-inventory\.mjs compare-names/g)?.length, 2);
  assert.equal(staticDeployment.match(/frontend-inventory\.mjs compare-directory/g)?.length, 2);
  assert.equal(staticDeployment.match(/verify_expected_frontend_content \\/g)?.length, 2);
  assert.match(staticDeployment, /az storage blob download-batch/);
  assert.match(staticDeployment, /mv "\$output_dir\/index\.html" "\$entrypoint_file"/);
  assert.match(staticDeployment, /--name index\.html/);
  assert.match(staticDeployment, /--content-cache-control no-cache/);
  const inventoryIndex = staticDeployment.indexOf('frontend-inventory.mjs create');
  const uploadIndex = staticDeployment.indexOf('az storage blob upload-batch');
  const dependencyVerificationIndex = staticDeployment.indexOf('verify_expected_frontend_content \\', uploadIndex);
  const entrypointUploadIndex = staticDeployment.indexOf('--name index.html');
  const completeReplacementVerificationIndex = staticDeployment.indexOf(
    'verify_expected_frontend_content \\',
    dependencyVerificationIndex + 1,
  );
  const staleDeleteIndex = staticDeployment.indexOf('az storage blob delete');
  const finalContentVerificationIndex = staticDeployment.lastIndexOf('frontend-inventory.mjs compare-directory');
  const finalNameVerificationIndex = staticDeployment.lastIndexOf('frontend-inventory.mjs compare-names');
  assert.ok(
    inventoryIndex < uploadIndex &&
      uploadIndex < dependencyVerificationIndex &&
      dependencyVerificationIndex < entrypointUploadIndex &&
      entrypointUploadIndex < completeReplacementVerificationIndex &&
      completeReplacementVerificationIndex < staleDeleteIndex &&
      staleDeleteIndex < finalContentVerificationIndex &&
      finalContentVerificationIndex < finalNameVerificationIndex,
  );
});

test('policy glob matcher handles recursive and exact AGENTS paths', () => {
  assert.equal(matchesPolicyGlob('apps/api/src/mcp/server.ts', 'apps/api/src/mcp/**'), true);
  assert.equal(matchesPolicyGlob('apps/api/AGENTS.md', '**/AGENTS.md'), true);
  assert.equal(matchesPolicyGlob('README.md', '**/AGENTS.md'), false);
});

test('risk classification covers workflow, MCP, Bring, contracts, and agent skills', () => {
  const paths = [
    '.github/workflows/ci.yml',
    'apps/api/src/mcp/server.ts',
    'apps/api/src/shared/bring/client.ts',
    'contracts/openapi.yaml',
    '.agents/skills/example/SKILL.md',
  ];
  const risk = classifyRisk(paths, policy);
  assert.equal(risk.highRisk, true);
  assert.deepEqual(risk.highRiskPaths, paths);
});

test('auto-merge candidates are scoped and blocked labels fail closed', () => {
  assert.equal(isAutomergeCandidate(pullRequest(), policy), true);
  assert.equal(
    isAutomergeCandidate(pullRequest({ head: { ...pullRequest().head, ref: 'feature/example' } }), policy),
    false,
  );
  assert.equal(isAutomergeCandidate(pullRequest({ labels: [{ name: 'do-not-merge' }] }), policy), false);
});

test('required checks pass only for exact head and expected GitHub app', () => {
  assert.equal(evaluateRequiredChecks(successfulChecks(), headSha, policy.requiredChecks).ok, true);

  const wrongApp = successfulChecks();
  wrongApp[0] = { ...wrongApp[0], app: { slug: 'untrusted-app' } };
  assert.equal(evaluateRequiredChecks(wrongApp, headSha, policy.requiredChecks).failures[0].reason, 'wrong_app');

  const wrongHead = successfulChecks();
  wrongHead[0] = { ...wrongHead[0], head_sha: 'b'.repeat(40) };
  const evaluation = evaluateRequiredChecks(wrongHead, headSha, policy.requiredChecks);
  assert.ok(evaluation.failures.some((failure) => failure.reason === 'wrong_head_sha'));
  assert.ok(evaluation.pending.some((pending) => pending.reason === 'missing'));
});

test('required checks treat pending and failed checks as non-passing', () => {
  const pending = successfulChecks();
  pending[2] = { ...pending[2], status: 'in_progress', conclusion: null };
  assert.equal(evaluateRequiredChecks(pending, headSha, policy.requiredChecks).ok, false);

  const failed = successfulChecks();
  failed[3] = { ...failed[3], conclusion: 'failure' };
  assert.equal(evaluateRequiredChecks(failed, headSha, policy.requiredChecks).failures[0].reason, 'failure');
});

test('autonomous review is bound to the exact head and rejects blocking findings', () => {
  const approved = { decision: 'approve', reviewedHeadSha: headSha, summary: 'Approved.', findings: [] };
  assert.equal(validateAutonomousReview(approved, headSha, policy).ok, true);
  assert.equal(validateAutonomousReview({ ...approved, reviewedHeadSha: 'b'.repeat(40) }, headSha, policy).ok, false);
  assert.equal(
    validateAutonomousReview(
      {
        ...approved,
        findings: [{ severity: 'high', title: 'Blocked', evidence: 'Unsafe.', remediation: 'Repair it.' }],
      },
      headSha,
      policy,
    ).ok,
    false,
  );
});

test('autonomous review rechecks the mutable pull-request head after loading files', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'autonomous-review-race-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  let pullRequestRead = 0;
  const github = {
    async getPullRequest() {
      pullRequestRead += 1;
      return pullRequest(pullRequestRead === 1 ? {} : { head: { ...pullRequest().head, sha: 'b'.repeat(40) } });
    },
    async getPullRequestFiles() {
      return [{ filename: 'README.md' }];
    },
  };

  await assert.rejects(
    runReview(
      {
        repository: 'JueZ/api',
        prNumber: 1,
        headSha,
        reviewFile: join(directory, 'review.json'),
      },
      policy,
      github,
    ),
    /Pull request head changed/,
  );
});

test('high-risk autonomous review uses one cost-bounded call and records sanitized usage', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'autonomous-review-bounded-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const requests = [];
  const github = {
    async getPullRequest() {
      return { ...pullRequest(), title: 'High-risk change', body: 'Review this change.' };
    },
    async getPullRequestFiles() {
      return [{ filename: '.github/workflows/example.yml', status: 'modified', additions: 1, deletions: 0 }];
    },
    async getPullRequestDiff() {
      return 'diff --git a/example b/example';
    },
  };
  const client = {
    responses: {
      async create(request) {
        requests.push(request);
        return {
          id: 'resp_complete',
          status: 'completed',
          usage: {
            input_tokens: 750,
            input_tokens_details: { cached_tokens: 100 },
            output_tokens: 250,
            output_tokens_details: { reasoning_tokens: 100 },
            total_tokens: 1000,
          },
          output_text: JSON.stringify({
            decision: 'approve',
            reviewedHeadSha: headSha,
            summary: 'No blocking findings.',
            findings: [],
          }),
        };
      },
    },
  };

  const review = await runReview(
    {
      repository: 'JueZ/api',
      prNumber: 1,
      headSha,
      reviewFile: join(directory, 'review.json'),
    },
    policy,
    github,
    client,
  );

  assert.equal(review.decision, 'approve');
  assert.equal(review.responseId, 'resp_complete');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].model, 'gpt-5.6-sol');
  assert.deepEqual(requests[0].reasoning, { effort: 'high' });
  assert.equal(requests[0].text.verbosity, 'low');
  assert.equal(requests[0].max_output_tokens, 1500);
  assert.equal(review.reviewBudget.apiCallLimit, 1);
  assert.ok(review.reviewBudget.estimatedMaximumCostUsd <= policy.autonomousReview.maxEstimatedCostUsd);
  assert.deepEqual(review.modelUsage, {
    inputTokens: 750,
    cachedInputTokens: 100,
    outputTokens: 250,
    reasoningTokens: 100,
    totalTokens: 1000,
    estimatedUpperBoundCostUsd: 0.01125,
  });
});

test('high-risk autonomous review does not retry or accept an incomplete response', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'autonomous-review-incomplete-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const requests = [];
  const approvedOutput = JSON.stringify({
    decision: 'approve',
    reviewedHeadSha: headSha,
    summary: 'No blocking findings.',
    findings: [],
  });
  const github = {
    async getPullRequest() {
      return { ...pullRequest(), title: 'High-risk change', body: 'Review this change.' };
    },
    async getPullRequestFiles() {
      return [{ filename: '.github/workflows/example.yml', status: 'modified', additions: 1, deletions: 0 }];
    },
    async getPullRequestDiff() {
      return 'diff --git a/example b/example';
    },
  };
  const client = {
    responses: {
      async create(request) {
        requests.push(request);
        return {
          id: 'resp_incomplete',
          status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
          output_text: approvedOutput,
        };
      },
    },
  };

  await assert.rejects(
    runReview(
      {
        repository: 'JueZ/api',
        prNumber: 1,
        headSha,
        reviewFile: join(directory, 'review.json'),
      },
      policy,
      github,
      client,
    ),
    /Autonomous review unavailable: incomplete_response/,
  );

  assert.equal(requests.length, 1);
});

test('high-risk autonomous review fails closed after one structurally invalid decision', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'autonomous-review-invalid-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  let attempts = 0;
  const github = {
    async getPullRequest() {
      return { ...pullRequest(), title: 'High-risk change', body: 'Review this change.' };
    },
    async getPullRequestFiles() {
      return [{ filename: '.github/workflows/example.yml', status: 'modified', additions: 1, deletions: 0 }];
    },
    async getPullRequestDiff() {
      return 'diff --git a/example b/example';
    },
  };
  const client = {
    responses: {
      async create() {
        attempts += 1;
        return {
          id: `resp_${attempts}`,
          status: 'completed',
          output_text: JSON.stringify({
            decision: 'approve',
            reviewedHeadSha: headSha,
            summary: 'Review result.',
            findings: [{ severity: 'high', title: 'Blocked', evidence: 'Unsafe.', remediation: 'Repair it.' }],
          }),
        };
      },
    },
  };

  await assert.rejects(
    runReview(
      {
        repository: 'JueZ/api',
        prNumber: 1,
        headSha,
        reviewFile: join(directory, 'review.json'),
      },
      policy,
      github,
      client,
    ),
    /Autonomous review unavailable: invalid_review_decision/,
  );

  assert.equal(attempts, 1);
});

test('persistent empty model output fails closed with sanitized review evidence', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'autonomous-review-empty-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const reviewFile = join(directory, 'review.json');
  const github = {
    async getPullRequest() {
      return { ...pullRequest(), title: 'High-risk change', body: 'Review this change.' };
    },
    async getPullRequestFiles() {
      return [{ filename: '.github/workflows/example.yml', status: 'modified', additions: 1, deletions: 0 }];
    },
    async getPullRequestDiff() {
      return 'diff --git a/example b/example';
    },
  };
  const client = {
    responses: {
      async create() {
        return {
          id: 'resp_incomplete',
          status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
          output_text: '',
        };
      },
    },
  };

  await assert.rejects(
    runReview(
      {
        repository: 'JueZ/api',
        prNumber: 1,
        headSha,
        reviewFile,
      },
      policy,
      github,
      client,
    ),
    /Autonomous review unavailable: empty_output/,
  );

  const review = JSON.parse(await readFile(reviewFile, 'utf8'));
  assert.equal(review.decision, 'reject');
  assert.equal(review.reviewedHeadSha, headSha);
  assert.equal(review.modelFailure.kind, 'empty_output');
  assert.equal(review.modelFailure.attempts, 1);
  assert.equal(review.modelFailure.incompleteReason, 'max_output_tokens');
  assert.equal(review.findings[0].severity, 'high');
});

test('autonomous review cost ceiling blocks before any API request', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'autonomous-review-cost-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const reviewFile = join(directory, 'review.json');
  let attempts = 0;
  const github = {
    async getPullRequest() {
      return { ...pullRequest(), title: 'High-risk change', body: 'Review this change.' };
    },
    async getPullRequestFiles() {
      return [{ filename: '.github/workflows/example.yml', status: 'modified', additions: 1, deletions: 0 }];
    },
    async getPullRequestDiff() {
      return 'diff --git a/example b/example';
    },
  };
  const client = {
    responses: {
      async create() {
        attempts += 1;
      },
    },
  };
  const strictCostPolicy = {
    ...policy,
    autonomousReview: { ...policy.autonomousReview, maxEstimatedCostUsd: 0.000001 },
  };

  await assert.rejects(
    runReview({ repository: 'JueZ/api', prNumber: 1, headSha, reviewFile }, strictCostPolicy, github, client),
    /cost_ceiling_exceeded/,
  );

  const review = JSON.parse(await readFile(reviewFile, 'utf8'));
  assert.equal(attempts, 0);
  assert.equal(review.modelInvoked, false);
  assert.equal(review.reviewBudget.status, 'blocked_before_api');
});

test('paid review preflight excludes its own check and requires every free exact-head check', async () => {
  const requiredWithoutReview = policy.requiredChecks.filter(
    (required) => required.name !== policy.autonomousReview.checkName,
  );
  const github = {
    async getPullRequest() {
      return pullRequest();
    },
    async getCheckRuns() {
      return successfulChecks().filter((check) => check.name !== policy.autonomousReview.checkName);
    },
  };

  const result = await runRequiredCheckPreflight(
    { prNumber: 1, headSha, waitSeconds: 0, pollSeconds: 0 },
    policy,
    github,
  );
  assert.equal(result.ok, true);
  assert.equal(result.passed.length, requiredWithoutReview.length);

  github.getCheckRuns = async () =>
    successfulChecks()
      .filter((check) => check.name !== policy.autonomousReview.checkName)
      .map((check) => (check.name === 'lint' ? { ...check, conclusion: 'failure' } : check));
  await assert.rejects(
    runRequiredCheckPreflight({ prNumber: 1, headSha, waitSeconds: 0, pollSeconds: 0 }, policy, github),
    /lint: failure/,
  );
});

test('review budget uses conservative byte-token accounting and a one-call cap', () => {
  const budget = calculateReviewBudget(
    { input: [{ role: 'user', content: 'small diff' }], text: { verbosity: 'low' } },
    policy,
  );
  assert.equal(budget.apiCallLimit, 1);
  assert.equal(budget.maximumOutputTokens, 1500);
  assert.ok(budget.estimatedMaximumInputTokens > budget.serializedInputBytes);
  assert.ok(budget.estimatedMaximumCostUsd < 0.31);
});

test('pull request state rejects forks, stale heads, and behind branches', () => {
  assert.equal(evaluatePullRequestState(pullRequest(), headSha, policy).ok, true);
  assert.equal(
    evaluatePullRequestState(
      pullRequest({
        head: { ...pullRequest().head, repo: { full_name: 'someone/fork' } },
      }),
      headSha,
      policy,
    ).ok,
    false,
  );
  assert.equal(evaluatePullRequestState(pullRequest({ mergeable_state: 'behind' }), headSha, policy).ok, false);
  assert.equal(evaluatePullRequestState(pullRequest({ mergeable_state: 'unstable' }), headSha, policy).ok, true);
  assert.equal(evaluatePullRequestState(pullRequest({ mergeable_state: 'dirty' }), headSha, policy).ok, false);
  assert.equal(evaluatePullRequestState(pullRequest({ mergeable_state: 'blocked' }), headSha, policy).ok, false);
  assert.equal(
    evaluatePullRequestState(pullRequest({ mergeable: null, mergeable_state: 'unknown' }), headSha, policy).ok,
    false,
  );
  assert.equal(evaluatePullRequestState(pullRequest({ mergeable: false }), headSha, policy).ok, false);
});

test('merge decision requires pull request state, checks, and review to all pass', () => {
  const checkEvaluation = evaluateRequiredChecks(successfulChecks(), headSha, policy.requiredChecks);
  const review = { decision: 'approve', reviewedHeadSha: headSha, summary: 'Approved.', findings: [] };
  assert.equal(
    mergeGateDecision({
      pullRequest: pullRequest(),
      expectedHeadSha: headSha,
      checkEvaluation,
      review,
      policy,
    }).ok,
    true,
  );

  assert.equal(
    mergeGateDecision({
      pullRequest: pullRequest(),
      expectedHeadSha: headSha,
      checkEvaluation: { ...checkEvaluation, pending: [{ check: 'lint', reason: 'missing' }], ok: false },
      review,
      policy,
    }).ok,
    false,
  );
});
