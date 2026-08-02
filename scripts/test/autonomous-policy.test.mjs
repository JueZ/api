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
  buildReviewDiffCapsule,
  calculateReviewBudget,
  claimAutonomousReview,
  evaluateCompleteCheckRollup,
  evaluatePullRequestState,
  evaluateRequiredChecks,
  mergeGateDecision,
  reviewClaimExternalId,
  reviewClaimName,
  reviewRequestIdempotencyKey,
  runRequiredCheckPreflight,
  runReview,
  validateAutonomousReview,
} from '../autonomous-merge-controller.mjs';

const headSha = 'a'.repeat(40);
const highRiskDiff = `diff --git a/.github/workflows/example.yml b/.github/workflows/example.yml
index 1111111..2222222 100644
--- a/.github/workflows/example.yml
+++ b/.github/workflows/example.yml
@@ -1,2 +1,2 @@
-permissions: write-all
+permissions:
   contents: read
`;
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
const prepareProductionPrivateStorageWorkflow = readFileSync(
  new URL('../../.github/workflows/prepare-production-private-storage.yml', import.meta.url),
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
const preparePrivateStorageBicep = readFileSync(
  new URL('../../infra/prepare-private-storage.bicep', import.meta.url),
  'utf8',
);
const privateStorageModule = readFileSync(
  new URL('../../infra/modules/private-storage.bicep', import.meta.url),
  'utf8',
);

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

function successfulFreeChecks() {
  return successfulChecks().filter((check) => check.name !== policy.autonomousReview.checkName);
}

function currentControllerMergeCheck(runId = 1234, overrides = {}) {
  return {
    id: 10_000,
    name: 'merge exact PR head',
    head_sha: headSha,
    status: 'in_progress',
    conclusion: null,
    details_url: `https://github.com/JueZ/api/actions/runs/${runId}/job/5678`,
    app: { id: 15368, slug: 'github-actions' },
    ...overrides,
  };
}

function withFreeChecks(github) {
  let claimMarker;
  return {
    ...github,
    async getCheckRuns() {
      return [...successfulFreeChecks(), ...(claimMarker ? [claimMarker] : [])];
    },
    async createReviewClaim(claim) {
      claimMarker = {
        id: 777,
        name: claim.name,
        head_sha: claim.headSha,
        external_id: claim.externalId,
        details_url: 'https://github.com/JueZ/api/runs/777',
        status: 'completed',
        conclusion: 'neutral',
        app: { slug: 'github-actions' },
      };
      return claimMarker;
    },
  };
}

function withInputTokenCounter(client, { inputTokens = 1_000, requests = [] } = {}) {
  return {
    ...client,
    responses: {
      ...client.responses,
      inputTokens: {
        async count(request) {
          requests.push(request);
          return { object: 'response.input_tokens', input_tokens: inputTokens };
        },
      },
    },
  };
}

test('canonical autonomous policy is internally valid', () => {
  assert.deepEqual(validateAutonomousPolicy(policy), []);
  assert.equal(policy.merge.allowAdminBypass, false);
  assert.equal(policy.autonomousReview.humanApprovalRequired, false);
  assert.equal(policy.autonomousReview.model, 'gpt-5.6-sol');
  assert.equal(policy.autonomousReview.reasoningEffort, 'medium');
  assert.equal(policy.autonomousReview.maxDiffBytes, 200_000);
  assert.equal(policy.autonomousReview.maxOutputTokens, 3_500);
  assert.equal(policy.autonomousReview.maxEstimatedCostUsd, 0.31);
  assert.match(codexAutomergeWorkflow, /Wait for free deterministic exact-head checks/);
  assert.match(codexAutomergeWorkflow, /AUTONOMOUS_REVIEW_LIVE_API_ENABLED: 'true'/);
  assert.match(codexAutomergeWorkflow, /ready_for_review, labeled, unlabeled/);
  assert.match(codexAutomergeWorkflow, /cancel-in-progress: false/);
  assert.match(
    codexAutomergeWorkflow,
    /group: codex-automerge-\$\{\{ github\.event\.pull_request\.number \|\| inputs\.pr_number \}\}/,
  );
  assert.match(codexAutomergeWorkflow, /Claim exact head and run deterministic classification/);
  assert.doesNotMatch(codexAutomergeWorkflow, /autonomous-merge-controller\.mjs claim/);
  assert.equal(codexAutomergeWorkflow.match(/autonomous-merge-controller\.mjs review/g)?.length, 1);
  assert.match(
    codexAutomergeWorkflow,
    /claim_state_valid=false[\s\S]*gh api[\s\S]*if \[ "\$conclusion" != "success" \]/,
  );
  assert.ok(
    autonomousControllerSource.indexOf('const reviewClaim = await claimAutonomousReview') <
      autonomousControllerSource.indexOf('response = await client.responses.create'),
  );
  assert.ok(
    autonomousControllerSource.indexOf(
      "assertReviewClaimOwnership(options, github, reviewClaim, 'paid-call boundary')",
    ) < autonomousControllerSource.indexOf('response = await client.responses.create'),
  );
  assert.ok(
    autonomousControllerSource.indexOf('await client.responses.inputTokens.count') <
      autonomousControllerSource.indexOf('response = await client.responses.create'),
  );
  assert.ok(
    autonomousControllerSource.indexOf(
      "assertReviewClaimOwnership(options, github, reviewClaim, 'generation boundary')",
    ) < autonomousControllerSource.indexOf('response = await client.responses.create'),
  );
  assert.match(autonomousControllerSource, /enforceGitHubActions: !openAIClient/);
  assert.match(autonomousControllerSource, /maxRetries: 0/);
  assert.match(codexAutomergeWorkflow, /ref: \$\{\{ github\.workflow_sha \}\}/);
  assert.doesNotMatch(codexAutomergeWorkflow, /source-run-id|Reuse approved exact-head review evidence/);
  assert.doesNotMatch(autonomousControllerSource, /releaseReviewClaim|method: 'PATCH'[\s\S]*check-runs/);
});

test('Codex auto-merge completion dispatches exact main CI through one delivery controller', () => {
  assert.match(mainDeliveryWorkflow, /workflows: \[CI, Codex Auto-Merge\]/);
  assert.match(mainDeliveryWorkflow, /run main delivery after Codex auto-merge/);
  assert.match(mainDeliveryWorkflow, /github\.event\.workflow_run\.path == '\.github\/workflows\/ci\.yml'/);
  assert.match(
    mainDeliveryWorkflow,
    /github\.event\.workflow_run\.path == '\.github\/workflows\/codex-automerge\.yml'/,
  );
  assert.match(mainDeliveryWorkflow, /TRIGGER_WORKFLOW_PATH: \$\{\{ github\.event\.workflow_run\.path \}\}/);
  assert.doesNotMatch(mainDeliveryWorkflow, /github\.event\.workflow_run\.name/);
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
  assert.match(deployEnvironmentWorkflow, /Microsoft\.Consumption\/budgets\/budget-api-catalogue-/);
  assert.match(deployEnvironmentWorkflow, /node scripts\/resolve-budget-start-date\.mjs/);
  assert.match(deployEnvironmentWorkflow, /budgetStartDate="\$budget_start_date"/);
  assert.ok(
    deployEnvironmentWorkflow.indexOf('node scripts/resolve-budget-start-date.mjs') <
      deployEnvironmentWorkflow.indexOf('az deployment group create'),
  );
  assert.match(mainBicep, /deployment callers preserve an existing value/);
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
  assert.doesNotMatch(deployEnvironmentWorkflow, /uses: actions\/checkout/);
  assert.doesNotMatch(deployEnvironmentWorkflow, /git clone .*--branch main/);
  assert.match(deployEnvironmentWorkflow, /\^\[0-9a-f\]\{40\}\$/);
  assert.match(
    deployEnvironmentWorkflow,
    /git fetch --no-tags --prune origin "\+refs\/heads\/main:refs\/remotes\/origin\/main"/,
  );
  assert.equal(
    deployEnvironmentWorkflow.match(/CHECKOUT_CONTROLLER_REF: \$\{\{ inputs\.controllerRef \}\}/g)?.length,
    2,
  );
  assert.equal(
    deployEnvironmentWorkflow.match(/controllerRef must equal the immutable caller SHA before repository fetch/g)
      ?.length,
    2,
  );
  assert.equal(
    deployEnvironmentWorkflow.match(/fetched_main="\$\(git rev-parse refs\/remotes\/origin\/main\)"/g)?.length,
    2,
  );
  assert.equal(deployEnvironmentWorkflow.match(/\[ "\$fetched_main" != "\$immutable_controller_ref" \]/g)?.length, 2);
  assert.match(deployEnvironmentWorkflow, /\[ "\$\(pwd -P\)" != "\$\(realpath "\$GITHUB_WORKSPACE"\)" \]/);
  assert.match(deployEnvironmentWorkflow, /find \. -mindepth 1 -maxdepth 1 -print -quit/);
  assert.equal(deployEnvironmentWorkflow.match(/git checkout --detach "\$immutable_controller_ref"/g)?.length, 2);
  assert.equal(deployEnvironmentWorkflow.match(/git reset --hard "\$immutable_controller_ref"/g)?.length, 2);
  assert.equal(deployEnvironmentWorkflow.match(/git rev-parse HEAD\)" != "\$immutable_controller_ref"/g)?.length, 2);
  assert.match(deployEnvironmentWorkflow, /checked_out_controller="\$\(git rev-parse HEAD\)"/);
  assert.match(deployEnvironmentWorkflow, /\[ "\$controller_ref" != "\$checked_out_controller" \]/);
  assert.match(deployEnvironmentWorkflow, /git status --porcelain=v1 --untracked-files=all --ignored=matching/);
  assert.match(deployEnvironmentWorkflow, /git clean -ndx/);
  assert.match(deployEnvironmentWorkflow, /path: \$\{\{ runner\.temp \}\}\/rollback-ledger/);
  assert.equal(deployEnvironmentWorkflow.match(/path: \$\{\{ runner\.temp \}\}\/deploy-test-provenance/g)?.length, 2);
  assert.equal(
    deployEnvironmentWorkflow.match(/actions\/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093/g)?.length,
    5,
  );
  assert.doesNotMatch(deployEnvironmentWorkflow, /gh run download/);
  assert.match(
    deployEnvironmentWorkflow,
    /INFRA_FUNCTION_APP_NAME: \$\{\{ steps\.infra\.outputs\.function_app_name \}\}[\s\S]*?effective_functionapp_name="\$INFRA_FUNCTION_APP_NAME"/,
  );
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

test('production private-storage preparation is isolated, exact-source, and digest pinned', () => {
  assert.match(deployEnvironmentWorkflow, /deploy:\n\s+if: \$\{\{ !inputs\.preparePrivateStorageOnly \}\}/);
  assert.match(prepareProductionPrivateStorageWorkflow, /uses: \.\/\.github\/workflows\/deploy-environment\.yml/);
  assert.match(prepareProductionPrivateStorageWorkflow, /githubEnvironment: production/);
  assert.match(prepareProductionPrivateStorageWorkflow, /deployFrontend: false/);
  assert.match(prepareProductionPrivateStorageWorkflow, /deployFunctions: false/);
  assert.match(prepareProductionPrivateStorageWorkflow, /preparePrivateStorageOnly: true/);
  assert.doesNotMatch(prepareProductionPrivateStorageWorkflow, /inputs\.commit_sha|inputs\.ci_run_id/);
  assert.match(prepareProductionPrivateStorageWorkflow, /sourceRef: \$\{\{ github\.sha \}\}/);
  assert.match(prepareProductionPrivateStorageWorkflow, /ciRunId: \$\{\{ vars\.PREP_CI_RUN_ID \}\}/);
  assert.match(prepareProductionPrivateStorageWorkflow, /testDeliveryRunId: \$\{\{ vars\.PREP_TEST_RUN_ID \}\}/);
  assert.match(prepareProductionPrivateStorageWorkflow, /controllerRef: \$\{\{ github\.sha \}\}/);
  assert.match(prepareProductionPrivateStorageWorkflow, /controllerWorkflowSha: \$\{\{ github\.workflow_sha \}\}/);
  assert.match(prepareProductionPrivateStorageWorkflow, /migrationSourceStorageAccount: stapicatalogueprodbfjsts/);
  assert.match(prepareProductionPrivateStorageWorkflow, /migrationTargetStorageAccount: stapicatalogueprodpbfjst/);
  assert.match(
    prepareProductionPrivateStorageWorkflow,
    /migrationExpectedSha256: 4b2651b8d842854716b4fb2e20ecd9482f59f2ea6ee2352401bec5d42e8c6ed0/,
  );
  assert.match(prepareProductionPrivateStorageWorkflow, /PREPARE_PRODUCTION_PRIVATE_STORAGE/);

  const preparationIndex = deployEnvironmentWorkflow.indexOf('  prepare-private-storage:');
  assert.ok(preparationIndex > 0);
  const preparationJob = deployEnvironmentWorkflow.slice(preparationIndex);
  assert.match(preparationJob, /name: Checkout current preparation controller/);
  assert.doesNotMatch(preparationJob, /uses: actions\/checkout/);
  assert.match(preparationJob, /Preparation controller checkout requires the exact empty GitHub workspace/);
  assert.match(preparationJob, /git checkout --detach "\$immutable_controller_ref"/);
  assert.match(preparationJob, /git reset --hard "\$immutable_controller_ref"/);
  assert.match(preparationJob, /git clean -ndx/);
  assert.match(preparationJob, /if: \$\{\{ inputs\.preparePrivateStorageOnly \}\}/);
  assert.match(preparationJob, /\.path == "\.github\/workflows\/prepare-production-private-storage\.yml"/);
  assert.match(preparationJob, /and \.run_attempt == 1/);
  assert.match(preparationJob, /Pinned test provenance is not acceptable for production preparation/);
  assert.match(preparationJob, /name: Preview bounded private-storage preparation/);
  const verifiedCurrentMainIndex = preparationJob.indexOf('[ "$controller_ref" = "$(git rev-parse origin/main)" ]');
  const exportCurrentMainIndex = preparationJob.indexOf(
    'echo "DEPLOYMENT_CONTROL_REF=$controller_ref" >> "$GITHUB_ENV"',
  );
  const previewPreparationIndex = preparationJob.indexOf('name: Preview bounded private-storage preparation');
  assert.ok(
    verifiedCurrentMainIndex >= 0 &&
      verifiedCurrentMainIndex < exportCurrentMainIndex &&
      exportCurrentMainIndex < previewPreparationIndex,
  );
  assert.equal(preparationJob.match(/DEPLOYMENT_CONTROL_REF=\$controller_ref/g)?.length, 1);
  assert.match(preparationJob, /--template-file infra\/prepare-private-storage\.bicep/);
  assert.match(preparationJob, /--result-format ResourceIdOnly \\\n\s+--no-pretty-print \\\n\s+-o json/);
  assert.match(preparationJob, /--name "prepare-private-storage-prod-preview-\$\{GITHUB_RUN_ID\}"/);
  assert.match(preparationJob, /--name "prepare-private-storage-prod-\$\{GITHUB_RUN_ID\}"/);
  assert.equal(preparationJob.match(/--name "prepare-private-storage-prod[^\n]+\$\{GITHUB_RUN_ID\}"/g)?.length, 2);
  assert.match(preparationJob, /changeType != "Delete"/);
  assert.match(preparationJob, /name: Migrate one digest-pinned WLH reference blob/);
  assert.match(preparationJob, /--overwrite false/);
  assert.equal(preparationJob.match(/source_digest.*MIGRATION_EXPECTED_SHA256/g)?.length, 1);
  assert.equal(preparationJob.match(/target_digest.*MIGRATION_EXPECTED_SHA256/g)?.length, 1);
  assert.ok(
    preparationJob.indexOf('node scripts/assert-current-main.mjs\n            az storage blob upload') <
      preparationJob.indexOf('--overwrite false'),
  );
  assert.match(preparationJob, /production-health-before\.json/);
  assert.match(preparationJob, /production-health-after\.json/);
  assert.match(preparationJob, /productionRuntime:[\s\S]*status: "unchanged"/);
  assert.doesNotMatch(preparationJob, /infra\/main\.bicep/);
  assert.doesNotMatch(preparationJob, /az functionapp deployment/);
  assert.doesNotMatch(preparationJob, /az storage blob upload-batch/);

  assert.match(mainBicep, /module privateStorageDeployment '\.\/modules\/private-storage\.bicep'/);
  assert.equal(mainBicep.match(/dependsOn:\s*\[\s*privateStorageDeployment\s*\]/g)?.length, 4);
  assert.match(preparePrivateStorageBicep, /module privateStorage '\.\/modules\/private-storage\.bicep'/);
  assert.match(privateStorageModule, /allowBlobPublicAccess: false/);
  assert.match(privateStorageModule, /allowSharedKeyAccess: false/);
  assert.match(privateStorageModule, /defaultToOAuthAuthentication: true/);
  assert.match(privateStorageModule, /isVersioningEnabled: true/);
  assert.match(privateStorageModule, /daysAfterModificationGreaterThan: 365/);
  assert.match(privateStorageModule, /deployment-wlh-writer/);
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

test('complete check rollup permits only the current trusted merge job to remain pending', () => {
  const currentRunId = 1234;
  const accepted = evaluateCompleteCheckRollup(
    [...successfulChecks(), currentControllerMergeCheck(currentRunId)],
    [],
    headSha,
    currentRunId,
    'JueZ/api',
  );
  assert.equal(accepted.ok, true);
  assert.equal(accepted.explainsControllerUnstable, true);

  const unrelatedPending = evaluateCompleteCheckRollup(
    [
      ...successfulChecks(),
      currentControllerMergeCheck(currentRunId),
      currentControllerMergeCheck(9999, { id: 10_001, name: 'unlisted pending check' }),
    ],
    [],
    headSha,
    currentRunId,
    'JueZ/api',
  );
  assert.equal(unrelatedPending.ok, false);
  assert.deepEqual(unrelatedPending.pending, [{ check: 'unlisted pending check', reason: 'in_progress' }]);

  const unrelatedFailure = evaluateCompleteCheckRollup(
    [
      ...successfulChecks(),
      currentControllerMergeCheck(currentRunId),
      currentControllerMergeCheck(9999, {
        id: 10_002,
        name: 'unlisted failing check',
        status: 'completed',
        conclusion: 'failure',
      }),
    ],
    [],
    headSha,
    currentRunId,
    'JueZ/api',
  );
  assert.equal(unrelatedFailure.ok, false);
  assert.deepEqual(unrelatedFailure.failures, [{ check: 'unlisted failing check', reason: 'failure' }]);

  const legacyFailure = evaluateCompleteCheckRollup(
    [...successfulChecks(), currentControllerMergeCheck(currentRunId)],
    [{ id: 1, context: 'legacy external check', state: 'failure', sha: headSha }],
    headSha,
    currentRunId,
    'JueZ/api',
  );
  assert.equal(legacyFailure.ok, false);
  assert.deepEqual(legacyFailure.failures, [{ check: 'legacy external check', reason: 'failure' }]);

  const wrongRepository = evaluateCompleteCheckRollup(
    [
      ...successfulChecks(),
      currentControllerMergeCheck(currentRunId, {
        details_url: `https://github.com/attacker/repository/actions/runs/${currentRunId}/job/5678`,
      }),
    ],
    [],
    headSha,
    currentRunId,
    'JueZ/api',
  );
  assert.equal(wrongRepository.ok, false);
  assert.deepEqual(wrongRepository.pending, [{ check: 'merge exact PR head', reason: 'in_progress' }]);
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

test('high-risk autonomous review uses one cost-bounded generation and records sanitized usage', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'autonomous-review-bounded-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const requests = [];
  const requestOptions = [];
  const github = withFreeChecks({
    async getPullRequest() {
      return {
        ...pullRequest({ mergeable_state: 'blocked' }),
        title: 'High-risk change',
        body: 'Review this change.',
      };
    },
    async getPullRequestFiles() {
      return [{ filename: '.github/workflows/example.yml', status: 'modified', additions: 1, deletions: 0 }];
    },
    async getPullRequestDiff() {
      return highRiskDiff;
    },
  });
  const tokenCountRequests = [];
  const client = withInputTokenCounter(
    {
      responses: {
        async create(request, options) {
          requests.push(request);
          requestOptions.push(options);
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
    },
    { inputTokens: 1_250, requests: tokenCountRequests },
  );

  const review = await runReview(
    {
      repository: 'JueZ/api',
      prNumber: 1,
      headSha,
      runId: 12345,
      reviewFile: join(directory, 'review.json'),
    },
    policy,
    github,
    client,
  );

  assert.equal(review.decision, 'approve');
  assert.equal(review.responseId, 'resp_complete');
  assert.deepEqual(review.reviewClaim, { status: 'new', checkRunId: 777, runId: 12345 });
  assert.equal(requests.length, 1);
  assert.equal(tokenCountRequests.length, 1);
  assert.deepEqual(tokenCountRequests[0], {
    model: 'gpt-5.6-sol',
    reasoning: { effort: 'medium' },
    text: requests[0].text,
    input: requests[0].input,
  });
  assert.equal(requests[0].model, 'gpt-5.6-sol');
  assert.deepEqual(requests[0].reasoning, { effort: 'medium' });
  assert.equal(requests[0].text.verbosity, 'low');
  assert.equal(requests[0].max_output_tokens, 3500);
  assert.match(requests[0].input[0].content, /reserve at least 512 output tokens/);
  assert.doesNotMatch(JSON.stringify(requests[0].input), /Review this change\./);
  const reviewPayload = JSON.parse(requests[0].input[1].content);
  assert.deepEqual(reviewPayload.changedFiles, [{ filename: '.github/workflows/example.yml', status: 'modified' }]);
  assert.equal(reviewPayload.risk.highRisk, true);
  assert.equal(reviewPayload.policy.highRiskPaths, undefined);
  assert.ok(reviewPayload.policy.authorization);
  assert.ok(reviewPayload.policy.merge);
  assert.equal(typeof reviewPayload.untrustedReviewDiff, 'string');
  assert.equal(reviewPayload.untrustedNonDocumentationDiff, undefined);
  const expectedIdempotencyKey = reviewRequestIdempotencyKey('JueZ/api', 1, headSha);
  assert.equal(requestOptions[0].idempotencyKey, expectedIdempotencyKey);
  assert.equal(requestOptions[0].headers['Idempotency-Key'], expectedIdempotencyKey);
  assert.equal(expectedIdempotencyKey, reviewRequestIdempotencyKey('JueZ/api', 1, headSha));
  assert.notEqual(expectedIdempotencyKey, reviewRequestIdempotencyKey('JueZ/api', 2, headSha));
  assert.equal(review.reviewBudget.exactInputTokens, 1_250);
  assert.equal(review.reviewBudget.inputTokenCountRequestLimit, 1);
  assert.equal(review.reviewBudget.modelGenerationRequestLimit, 1);
  assert.equal(review.reviewBudget.totalOpenAIRequestLimit, 2);
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
  const github = withFreeChecks({
    async getPullRequest() {
      return { ...pullRequest(), title: 'High-risk change', body: 'Review this change.' };
    },
    async getPullRequestFiles() {
      return [{ filename: '.github/workflows/example.yml', status: 'modified', additions: 1, deletions: 0 }];
    },
    async getPullRequestDiff() {
      return highRiskDiff;
    },
  });
  const client = withInputTokenCounter({
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
  });

  await assert.rejects(
    runReview(
      {
        repository: 'JueZ/api',
        prNumber: 1,
        headSha,
        runId: 12345,
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
  const github = withFreeChecks({
    async getPullRequest() {
      return { ...pullRequest(), title: 'High-risk change', body: 'Review this change.' };
    },
    async getPullRequestFiles() {
      return [{ filename: '.github/workflows/example.yml', status: 'modified', additions: 1, deletions: 0 }];
    },
    async getPullRequestDiff() {
      return highRiskDiff;
    },
  });
  const client = withInputTokenCounter({
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
  });

  await assert.rejects(
    runReview(
      {
        repository: 'JueZ/api',
        prNumber: 1,
        headSha,
        runId: 12345,
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
  const github = withFreeChecks({
    async getPullRequest() {
      return { ...pullRequest(), title: 'High-risk change', body: 'Review this change.' };
    },
    async getPullRequestFiles() {
      return [{ filename: '.github/workflows/example.yml', status: 'modified', additions: 1, deletions: 0 }];
    },
    async getPullRequestDiff() {
      return highRiskDiff;
    },
  });
  const client = withInputTokenCounter({
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
  });

  await assert.rejects(
    runReview(
      {
        repository: 'JueZ/api',
        prNumber: 1,
        headSha,
        runId: 12345,
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

test('autonomous review cost ceiling blocks after exact counting and before model generation', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'autonomous-review-cost-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const reviewFile = join(directory, 'review.json');
  let attempts = 0;
  const github = withFreeChecks({
    async getPullRequest() {
      return { ...pullRequest(), title: 'High-risk change', body: 'Review this change.' };
    },
    async getPullRequestFiles() {
      return [{ filename: '.github/workflows/example.yml', status: 'modified', additions: 1, deletions: 0 }];
    },
    async getPullRequestDiff() {
      return highRiskDiff;
    },
  });
  const tokenCountRequests = [];
  const client = withInputTokenCounter(
    {
      responses: {
        async create() {
          attempts += 1;
        },
      },
    },
    { requests: tokenCountRequests },
  );
  const strictCostPolicy = {
    ...policy,
    autonomousReview: { ...policy.autonomousReview, maxEstimatedCostUsd: 0.000001 },
  };

  await assert.rejects(
    runReview(
      { repository: 'JueZ/api', prNumber: 1, headSha, runId: 12345, reviewFile },
      strictCostPolicy,
      github,
      client,
    ),
    /cost_ceiling_exceeded/,
  );

  const review = JSON.parse(await readFile(reviewFile, 'utf8'));
  assert.equal(attempts, 0);
  assert.equal(tokenCountRequests.length, 1);
  assert.equal(review.modelInvoked, false);
  assert.equal(review.tokenCountInvoked, true);
  assert.equal(review.reviewBudget.status, 'blocked_before_generation');
  assert.equal(review.reviewClaim.status, 'new');
});

test('autonomous review fails closed without generation when exact token counting is unavailable', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'autonomous-review-token-count-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const reviewFile = join(directory, 'review.json');
  let generationAttempts = 0;
  let tokenCountAttempts = 0;
  const github = withFreeChecks({
    async getPullRequest() {
      return { ...pullRequest(), title: 'High-risk change' };
    },
    async getPullRequestFiles() {
      return [{ filename: '.github/workflows/example.yml', status: 'modified' }];
    },
    async getPullRequestDiff() {
      return highRiskDiff;
    },
  });
  const client = {
    responses: {
      inputTokens: {
        async count() {
          tokenCountAttempts += 1;
          throw new Error('untrusted provider detail');
        },
      },
      async create() {
        generationAttempts += 1;
      },
    },
  };

  await assert.rejects(
    runReview({ repository: 'JueZ/api', prNumber: 1, headSha, runId: 12345, reviewFile }, policy, github, client),
    /input_token_count_unavailable/,
  );

  const review = JSON.parse(await readFile(reviewFile, 'utf8'));
  assert.equal(tokenCountAttempts, 1);
  assert.equal(generationAttempts, 0);
  assert.equal(review.modelInvoked, false);
  assert.equal(review.tokenCountInvoked, true);
  assert.equal(review.modelFailure.kind, 'input_token_count_unavailable');
  assert.doesNotMatch(JSON.stringify(review), /untrusted provider detail/);
  assert.equal(review.reviewClaim.status, 'new');
});

test('paid review revalidates every free check after token counting and immediately before generation', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'autonomous-review-boundary-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  let attempts = 0;
  let marker;
  let checkReads = 0;
  const github = {
    async getPullRequest() {
      return { ...pullRequest(), title: 'High-risk change', body: 'Review this change.' };
    },
    async getPullRequestFiles() {
      return [{ filename: '.github/workflows/example.yml', status: 'modified', additions: 1, deletions: 0 }];
    },
    async getPullRequestDiff() {
      return highRiskDiff;
    },
    async getCheckRuns() {
      checkReads += 1;
      const freeChecks = successfulFreeChecks().map((check) =>
        checkReads >= 5 && check.name === 'lint' ? { ...check, conclusion: 'failure' } : check,
      );
      return [...freeChecks, ...(marker ? [marker] : [])];
    },
    async createReviewClaim(claim) {
      marker = {
        id: 77,
        name: claim.name,
        head_sha: claim.headSha,
        external_id: claim.externalId,
        details_url: 'https://github.com/JueZ/api/runs/77',
        status: 'completed',
        conclusion: 'neutral',
        app: { slug: 'github-actions' },
      };
      return marker;
    },
  };
  const tokenCountRequests = [];
  const client = withInputTokenCounter(
    {
      responses: {
        async create() {
          attempts += 1;
        },
      },
    },
    { requests: tokenCountRequests },
  );

  await assert.rejects(
    runReview(
      {
        repository: 'JueZ/api',
        prNumber: 1,
        headSha,
        runId: 12345,
        reviewFile: join(directory, 'review.json'),
      },
      policy,
      github,
      client,
    ),
    /generation boundary: lint: failure/,
  );
  assert.equal(attempts, 0);
  assert.equal(tokenCountRequests.length, 1);
});

test('paid review cannot invoke the API unless its exact run owns one canonical claim', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'autonomous-review-claim-boundary-'));
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
      return highRiskDiff;
    },
    async getCheckRuns() {
      return successfulFreeChecks();
    },
    async createReviewClaim() {
      return { id: 77 };
    },
  };
  const client = {
    responses: {
      async create() {
        attempts += 1;
      },
    },
  };

  await assert.rejects(
    runReview(
      {
        repository: 'JueZ/api',
        prNumber: 1,
        headSha,
        runId: 12345,
        reviewFile: join(directory, 'review.json'),
      },
      policy,
      github,
      client,
    ),
    /claim ownership failed at post-create claim verification/,
  );
  assert.equal(attempts, 0);
});

test('paid review preflight excludes its own check and requires every free exact-head check', async () => {
  const requiredWithoutReview = policy.requiredChecks.filter(
    (required) => required.name !== policy.autonomousReview.checkName,
  );
  const github = {
    async getPullRequest() {
      return pullRequest({ mergeable_state: 'blocked' });
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

test('permanent exact-head marker is created once and any existing marker consumes the paid call', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'autonomous-review-claim-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const reviewFile = join(directory, 'review.json');
  const createdClaims = [];
  const decisionChecks = [];
  let marker;
  const github = {
    async getPullRequest() {
      return pullRequest();
    },
    async getCheckRuns() {
      return [...successfulFreeChecks(), ...(marker ? [marker] : [])];
    },
    async createReviewClaim(claim) {
      createdClaims.push(claim);
      marker = {
        id: 77,
        name: claim.name,
        head_sha: claim.headSha,
        external_id: claim.externalId,
        details_url: 'https://github.com/JueZ/api/runs/77',
        status: 'completed',
        conclusion: 'neutral',
        app: { slug: 'github-actions' },
      };
      return marker;
    },
    async createReviewDecisionCheck(check) {
      decisionChecks.push(check);
      return { id: 88 };
    },
  };
  const options = {
    repository: 'JueZ/api',
    prNumber: 42,
    headSha,
    runId: 12345,
    reviewFile,
  };

  const testRuntime = { enforceGitHubActions: false };
  const created = await claimAutonomousReview(options, policy, github, testRuntime);
  assert.deepEqual(created, { status: 'new', checkRunId: 77, runId: 12345 });
  assert.equal(createdClaims.length, 1);
  assert.equal(createdClaims[0].name, reviewClaimName(42));
  assert.equal(createdClaims[0].externalId, reviewClaimExternalId('JueZ/api', 42, headSha, 12345));
  assert.equal(createdClaims[0].detailsUrl, 'https://github.com/JueZ/api/actions/runs/12345');

  const alreadyConsumed = await claimAutonomousReview(options, policy, github, testRuntime);
  assert.equal(alreadyConsumed.status, 'consumed');
  assert.equal(alreadyConsumed.reason, 'exact_head_claim_exists');

  marker = { ...marker, details_url: 'https://example.com/runs/77' };
  const consumed = await claimAutonomousReview(options, policy, github, testRuntime);
  assert.equal(consumed.status, 'consumed');
  assert.equal(consumed.checkRunId, 77);
  assert.equal(consumed.decisionCheckRunId, 88);
  assert.equal(consumed.reason, 'invalid_or_multiple_exact_head_claims');

  marker = {
    ...marker,
    details_url: 'https://github.com/JueZ/api/runs/77',
    external_id: 'fields-may-change-without-restoring-the-paid-call',
  };
  const consumedExternalId = await claimAutonomousReview(options, policy, github, testRuntime);
  assert.equal(consumedExternalId.status, 'consumed');
  assert.equal(consumedExternalId.reason, 'invalid_or_multiple_exact_head_claims');
  assert.equal(createdClaims.length, 1);
  assert.equal(decisionChecks.length, 3);
  assert.equal(decisionChecks.at(-1).conclusion, 'failure');
  const rejection = JSON.parse(await readFile(reviewFile, 'utf8'));
  assert.equal(rejection.decision, 'reject');
  assert.equal(rejection.modelInvoked, false);
  assert.equal(rejection.reviewClaim.reason, 'invalid_or_multiple_exact_head_claims');
});

test('review claims enforce trusted GitHub Actions identity by default', async () => {
  const originalGitHubActions = process.env.GITHUB_ACTIONS;
  process.env.GITHUB_ACTIONS = 'false';

  try {
    await assert.rejects(
      claimAutonomousReview(
        {
          repository: 'JueZ/api',
          prNumber: 42,
          headSha,
          runId: 12345,
        },
        policy,
        {},
      ),
      /must execute in the trusted GitHub Actions workflow/,
    );
  } finally {
    if (originalGitHubActions === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = originalGitHubActions;
  }
});

test('review budget uses the exact count and caps counting and generation to one request each', () => {
  const budget = calculateReviewBudget(
    { input: [{ role: 'user', content: 'small diff' }], text: { verbosity: 'low' } },
    policy,
    1_234,
  );
  assert.equal(budget.exactInputTokens, 1_234);
  assert.equal(budget.inputTokenCountRequestLimit, 1);
  assert.equal(budget.modelGenerationRequestLimit, 1);
  assert.equal(budget.totalOpenAIRequestLimit, 2);
  assert.equal(budget.maximumOutputTokens, 3500);
  assert.ok(budget.estimatedMaximumCostUsd < 0.31);
  const completeDiffBudget = calculateReviewBudget(
    { input: [{ role: 'user', content: 'complete diff' }], text: { verbosity: 'low' } },
    policy,
    32_304,
  );
  assert.equal(completeDiffBudget.estimatedMaximumCostUsd, 0.26652);
  assert.throws(
    () => calculateReviewBudget({ input: [], text: {} }, policy),
    /exact positive input-token count is required/,
  );
});

test('review capsule keeps every executable and high-risk documentation change with context', () => {
  const policyHelperDiff = `diff --git a/scripts/lib/policy-helper.mjs b/scripts/lib/policy-helper.mjs
index 5555555..6666666 100644
--- a/scripts/lib/policy-helper.mjs
+++ b/scripts/lib/policy-helper.mjs
@@ -1,2 +1,2 @@
 const trustedContext = true;
-export const enabled = false;
+export const enabled = trustedContext;
`;
  const sourceDiff = `${highRiskDiff}${policyHelperDiff}diff --git a/docs/security/example.md b/docs/security/example.md
index 3333333..4444444 100644
--- a/docs/security/example.md
+++ b/docs/security/example.md
@@ -1 +1 @@
-Old documentation.
+New documentation.
diff --git a/docs/reference.md b/docs/reference.md
index 7777777..8888888 100644
--- a/docs/reference.md
+++ b/docs/reference.md
@@ -1 +1 @@
-Old reference.
+New reference.
`;
  const capsule = buildReviewDiffCapsule(
    sourceDiff,
    {
      highRiskPaths: ['.github/workflows/example.yml', 'docs/security/example.md'],
    },
    ['.github/workflows/example.yml', 'scripts/lib/policy-helper.mjs', 'docs/security/example.md', 'docs/reference.md'],
  );
  assert.deepEqual(capsule.reviewedPaths, [
    '.github/workflows/example.yml',
    'scripts/lib/policy-helper.mjs',
    'docs/security/example.md',
  ]);
  assert.deepEqual(capsule.omittedDocumentationPaths, ['docs/reference.md']);
  assert.match(capsule.diff, /\+permissions:/);
  assert.match(capsule.diff, /^ {3}contents: read$/m);
  assert.match(capsule.diff, /scripts\/lib\/policy-helper\.mjs/);
  assert.match(capsule.diff, /^ const trustedContext = true;$/m);
  assert.match(capsule.diff, /New documentation/);
  assert.doesNotMatch(capsule.diff, /New reference/);
});

test('review capsule includes documentation when it is the only change and fails on missing paths', () => {
  const documentationDiff = `diff --git a/docs/security/example.md b/docs/security/example.md
--- a/docs/security/example.md
+++ b/docs/security/example.md
@@ -1 +1 @@
-Old documentation.
+New documentation.
`;
  const capsule = buildReviewDiffCapsule(
    documentationDiff,
    {
      highRiskPaths: ['docs/security/example.md'],
    },
    ['docs/security/example.md'],
  );
  assert.deepEqual(capsule.reviewedPaths, ['docs/security/example.md']);
  assert.deepEqual(capsule.omittedDocumentationPaths, []);
  assert.match(capsule.diff, /\+New documentation\./);
  assert.throws(
    () =>
      buildReviewDiffCapsule(documentationDiff, { highRiskPaths: ['docs/security/example.md'] }, [
        'docs/security/example.md',
        'scripts/missing.mjs',
      ]),
    /missing changed paths/,
  );
  assert.throws(
    () =>
      buildReviewDiffCapsule(documentationDiff, { highRiskPaths: ['docs/security/example.md'] }, [
        'docs/security/example.md',
        'docs/security/example.md',
      ]),
    /contains duplicates/,
  );
  assert.throws(
    () =>
      buildReviewDiffCapsule(documentationDiff, { highRiskPaths: ['docs/security/missing.md'] }, [
        'docs/security/example.md',
      ]),
    /classifier returned unlisted paths/,
  );
  assert.throws(
    () =>
      buildReviewDiffCapsule(`${documentationDiff}${highRiskDiff}`, { highRiskPaths: ['docs/security/example.md'] }, [
        'docs/security/example.md',
      ]),
    /diff section count 2 does not match changed-path count 1/,
  );
});

test('review capsule includes deleted executable files from the authoritative changed-path list', () => {
  const deletedDiff = `diff --git a/scripts/deprecated.sh b/scripts/deprecated.sh
deleted file mode 100755
index 1111111..0000000
--- a/scripts/deprecated.sh
+++ /dev/null
@@ -1 +0,0 @@
-echo deprecated
`;
  const capsule = buildReviewDiffCapsule(deletedDiff, { highRiskPaths: ['scripts/deprecated.sh'] }, [
    'scripts/deprecated.sh',
  ]);
  assert.deepEqual(capsule.reviewedPaths, ['scripts/deprecated.sh']);
  assert.match(capsule.diff, /deleted file mode 100755/);
  assert.match(capsule.diff, /-echo deprecated/);
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
  assert.equal(evaluatePullRequestState(pullRequest({ mergeable_state: 'unstable' }), headSha, policy).ok, false);
  assert.equal(evaluatePullRequestState(pullRequest({ mergeable_state: 'dirty' }), headSha, policy).ok, false);
  assert.equal(evaluatePullRequestState(pullRequest({ mergeable_state: 'blocked' }), headSha, policy).ok, false);
  assert.equal(
    evaluatePullRequestState(pullRequest({ mergeable_state: 'unstable' }), headSha, policy, {
      allowBlockedBeforeOwnReview: true,
    }).ok,
    true,
  );
  assert.equal(
    evaluatePullRequestState(pullRequest({ mergeable_state: 'blocked' }), headSha, policy, {
      allowBlockedBeforeOwnReview: true,
    }).ok,
    true,
  );
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
      pullRequest: pullRequest({ mergeable_state: 'unstable' }),
      expectedHeadSha: headSha,
      checkEvaluation,
      review,
      policy,
    }).ok,
    false,
  );

  const currentRunId = 1234;
  const aggregateCheckEvaluation = evaluateCompleteCheckRollup(
    [...successfulChecks(), currentControllerMergeCheck(currentRunId)],
    [],
    headSha,
    currentRunId,
    'JueZ/api',
  );
  assert.equal(
    mergeGateDecision({
      pullRequest: pullRequest({ mergeable_state: 'unstable' }),
      expectedHeadSha: headSha,
      checkEvaluation,
      aggregateCheckEvaluation,
      review,
      policy,
    }).ok,
    true,
  );

  assert.equal(
    mergeGateDecision({
      pullRequest: pullRequest({ mergeable_state: 'blocked' }),
      expectedHeadSha: headSha,
      checkEvaluation,
      review,
      policy,
    }).ok,
    false,
  );

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

  assert.equal(
    mergeGateDecision({
      pullRequest: pullRequest(),
      expectedHeadSha: headSha,
      checkEvaluation,
      aggregateCheckEvaluation: {
        ...aggregateCheckEvaluation,
        ok: false,
        pending: [{ check: 'unlisted pending check', reason: 'in_progress' }],
      },
      review,
      policy,
    }).ok,
    false,
  );
});
