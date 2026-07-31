import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parse as parseYaml } from 'yaml';
import {
  classifyRisk,
  isAutomergeCandidate,
  loadAutonomousPolicy,
  matchesPolicyGlob,
  validateAutonomousPolicy,
} from '../lib/autonomous-policy.mjs';
import {
  autonomousMergeExcludedChanges,
  actionsRunCoordinates,
  evaluatePullRequestState,
  evaluateRequiredChecks,
  mergeGateDecision,
  pullRequestFilePaths,
  runReview,
  trustedWorkflowSourceChanges,
  validateAutonomousReview,
} from '../autonomous-merge-controller.mjs';
import { branchProtectionFindings, renderBranchProtection } from '../render-branch-protection.mjs';
import {
  deploymentHoldDecision,
  loadDeploymentHold,
  validateDeploymentHold,
} from '../enforce-security-deployment-hold.mjs';

const headSha = 'a'.repeat(40);
const repository = 'JueZ/api';
const pullRequestNumber = 285;
const policy = loadAutonomousPolicy();
const ciWorkflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
const mainDeliveryWorkflow = readFileSync(
  new URL('../../.github/workflows/codex-main-delivery.yml', import.meta.url),
  'utf8',
);
const autoMergeWorkflow = readFileSync(new URL('../../.github/workflows/codex-automerge.yml', import.meta.url), 'utf8');
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
const migratePrivateStorageWorkflow = readFileSync(
  new URL('../../.github/workflows/migrate-private-storage.yml', import.meta.url),
  'utf8',
);
const bringCanaryWorkflow = readFileSync(
  new URL('../../.github/workflows/bring-readonly-canary.yml', import.meta.url),
  'utf8',
);
const verifyAzureOidcWorkflow = readFileSync(
  new URL('../../.github/workflows/verify-azure-oidc.yml', import.meta.url),
  'utf8',
);
const runtimeSettingsPolicy = readFileSync(
  new URL('../validate-deployed-runtime-settings.mjs', import.meta.url),
  'utf8',
);
const deploymentHoldEnforcer = readFileSync(
  new URL('../enforce-security-deployment-hold.mjs', import.meta.url),
  'utf8',
);
const mainBicep = readFileSync(new URL('../../infra/main.bicep', import.meta.url), 'utf8');
const dependabotConfig = readFileSync(new URL('../../.github/dependabot.yml', import.meta.url), 'utf8');
const releaseArtifactBuilder = readFileSync(new URL('../build-release-artifacts.sh', import.meta.url), 'utf8');
const azureDiagnostics = readFileSync(new URL('../collect-azure-diagnostics.sh', import.meta.url), 'utf8');
const workflowsUrl = new URL('../../.github/workflows/', import.meta.url);
const actionsUrl = new URL('../../.github/actions/', import.meta.url);
const expectedIncidentBlockStep = {
  name: 'Block deployments pending credential rotation',
  shell: 'bash',
  run:
    'set -euo pipefail\n' +
    'echo "::error title=Deployment security hold::Credential incident 2026-07-31 remains unresolved. Revoke and rotate every affected GitHub, Azure, and provider credential, then bootstrap an independently controlled clearance trust root."\n' +
    'exit 1\n',
};
const expectedHoldPolicyStep = {
  name: 'Enforce repository security deployment hold',
  shell: 'bash',
  run: 'node scripts/enforce-security-deployment-hold.mjs',
};

function readYamlTree(directoryUrl, prefix) {
  if (!existsSync(directoryUrl)) return [];
  return readdirSync(directoryUrl, { withFileTypes: true }).flatMap((entry) => {
    const child = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, directoryUrl);
    if (entry.isDirectory()) return readYamlTree(child, `${prefix}${entry.name}/`);
    return /\.ya?ml$/.test(entry.name) ? [[`${prefix}${entry.name}`, readFileSync(child, 'utf8')]] : [];
  });
}

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

const actionsRunIds = { ci: 101, policy: 102, codeql: 103 };
const controllerCheckRunId = 9001;

function successfulChecks() {
  return policy.requiredChecks.map((required, index) => {
    const id = policy.trustedCheckSources[required.source].kind === 'controller' ? controllerCheckRunId : index + 1;
    const runId = actionsRunIds[required.source];
    return {
      id,
      name: required.name,
      head_sha: headSha,
      status: 'completed',
      conclusion: 'success',
      details_url: runId
        ? `https://github.com/${repository}/actions/runs/${runId}/job/${id}`
        : `https://github.com/${repository}/runs/${id}`,
      app: { slug: required.appSlug, id: policy.trustedCheckApps[required.appSlug] },
    };
  });
}

function successfulActionsRuns() {
  return new Map(
    Object.entries(actionsRunIds).map(([sourceName, runId]) => {
      const source = policy.trustedCheckSources[sourceName];
      return [
        runId,
        {
          id: runId,
          workflow_id: source.workflowId,
          path: source.workflowPath,
          event: source.event,
          run_attempt: source.runAttempt,
          head_sha: headSha,
          head_repository: { full_name: repository },
          pull_requests: [{ number: pullRequestNumber, head: { sha: headSha }, base: { ref: 'main' } }],
        },
      ];
    }),
  );
}

function evaluateChecks(checkRuns, overrides = {}) {
  return evaluateRequiredChecks(
    checkRuns,
    headSha,
    policy.requiredChecks,
    policy.trustedCheckApps,
    policy.trustedCheckSources,
    {
      repository,
      actionsRuns: successfulActionsRuns(),
      expectedControllerCheckRunId: controllerCheckRunId,
      expectedPrNumber: pullRequestNumber,
      ...overrides,
    },
  );
}

test('canonical autonomous policy is internally valid', () => {
  assert.deepEqual(validateAutonomousPolicy(policy), []);
  assert.equal(policy.trustedCheckApps['github-actions'], 15368);
  assert.equal(policy.trustedCheckSources.ci.workflowId, 276132079);
  assert.equal(policy.merge.allowAdminBypass, false);
  assert.equal(policy.autonomousReview.humanApprovalRequired, false);
  assert.ok(policy.merge.autonomousExcludedPaths.includes('.github/workflows/**'));
  assert.ok(policy.merge.autonomousExcludedPaths.includes('npm-shrinkwrap.json'));
  assert.ok(policy.merge.autonomousExcludedPaths.includes('ops/release-ledger/**'));
  assert.equal(classifyRisk(['npm-shrinkwrap.json'], policy).highRisk, true);
  assert.deepEqual(
    autonomousMergeExcludedChanges(
      [{ filename: 'ops/release-ledger/schema.json' }],
      policy.merge.autonomousExcludedPaths,
    ),
    ['ops/release-ledger/schema.json'],
  );
  assert.deepEqual(
    autonomousMergeExcludedChanges(
      [{ filename: '.github/security-deployment-hold.json' }, { filename: 'apps/api/src/index.ts' }],
      policy.merge.autonomousExcludedPaths,
    ),
    ['.github/security-deployment-hold.json'],
  );
  const renamedTrustRoot = [
    {
      filename: 'docs/incident-record.json',
      previous_filename: '.github/security-deployment-hold.json',
      status: 'renamed',
    },
  ];
  assert.deepEqual(pullRequestFilePaths(renamedTrustRoot), [
    'docs/incident-record.json',
    '.github/security-deployment-hold.json',
  ]);
  assert.deepEqual(autonomousMergeExcludedChanges(renamedTrustRoot, policy.merge.autonomousExcludedPaths), [
    '.github/security-deployment-hold.json',
  ]);
  assert.ok(policy.autonomousReview.maxDiffBytes >= 1_200_000);
  const missingAppMapping = structuredClone(policy);
  delete missingAppMapping.trustedCheckApps['github-actions'];
  assert.ok(validateAutonomousPolicy(missingAppMapping).some((error) => error.includes('unknown trusted app')));

  for (const invalidAppId of [0, -1, 1.5, '15368', null, Number.MAX_SAFE_INTEGER + 1]) {
    const invalid = structuredClone(policy);
    invalid.trustedCheckApps['github-actions'] = invalidAppId;
    assert.ok(validateAutonomousPolicy(invalid).some((error) => error.includes('positive integer GitHub App ID')));
  }

  const unusedApp = structuredClone(policy);
  unusedApp.trustedCheckApps.unused = 42;
  assert.ok(validateAutonomousPolicy(unusedApp).some((error) => error.includes('unused')));

  const duplicateAppId = structuredClone(policy);
  duplicateAppId.trustedCheckApps.alias = duplicateAppId.trustedCheckApps['github-actions'];
  duplicateAppId.requiredChecks[0].appSlug = 'alias';
  assert.ok(validateAutonomousPolicy(duplicateAppId).some((error) => error.includes('duplicate GitHub App ID')));

  const wrongWorkflowId = structuredClone(policy);
  wrongWorkflowId.trustedCheckSources.ci.workflowId = -1;
  assert.ok(validateAutonomousPolicy(wrongWorkflowId).some((error) => error.includes('workflowId')));
  const unknownSource = structuredClone(policy);
  unknownSource.requiredChecks[0].source = 'untrusted';
  assert.ok(validateAutonomousPolicy(unknownSource).some((error) => error.includes('unknown trusted source')));

  const missingSecurityExclusion = structuredClone(policy);
  missingSecurityExclusion.merge.autonomousExcludedPaths =
    missingSecurityExclusion.merge.autonomousExcludedPaths.filter(
      (path) => path !== '.github/security-deployment-hold.json',
    );
  assert.ok(
    validateAutonomousPolicy(missingSecurityExclusion).some((error) =>
      error.includes('must include .github/security-deployment-hold.json'),
    ),
  );
});

test('branch-protection bootstrap is rendered from canonical required checks', () => {
  const protection = renderBranchProtection(policy);
  assert.deepEqual(
    protection.required_status_checks.checks,
    policy.requiredChecks.map(({ name, appSlug }) => ({
      context: name,
      app_id: policy.trustedCheckApps[appSlug],
    })),
  );
  assert.equal(Object.hasOwn(protection.required_status_checks, 'contexts'), false);
  assert.equal(protection.required_status_checks.strict, true);
  assert.equal(protection.allow_force_pushes, false);
  assert.equal(protection.allow_deletions, false);
  assert.equal(protection.allow_fork_syncing, false);
  assert.equal(protection.required_linear_history, true);
  assert.equal(protection.required_conversation_resolution, true);
});

test('branch-protection verification rejects drift and wrong app bindings', () => {
  const rendered = renderBranchProtection(policy);
  const liveShape = {
    required_status_checks: {
      ...structuredClone(rendered.required_status_checks),
      contexts: rendered.required_status_checks.checks.map(({ context }) => context),
      contexts_url: 'https://api.github.test/required_status_checks/contexts',
      url: 'https://api.github.test/required_status_checks',
    },
    enforce_admins: { enabled: rendered.enforce_admins },
    required_pull_request_reviews: {
      ...structuredClone(rendered.required_pull_request_reviews),
      url: 'https://api.github.test/required_pull_request_reviews',
    },
    required_linear_history: { enabled: rendered.required_linear_history },
    allow_force_pushes: { enabled: rendered.allow_force_pushes },
    allow_deletions: { enabled: rendered.allow_deletions },
    block_creations: { enabled: rendered.block_creations },
    required_conversation_resolution: { enabled: rendered.required_conversation_resolution },
    lock_branch: { enabled: rendered.lock_branch },
    allow_fork_syncing: { enabled: rendered.allow_fork_syncing },
  };
  assert.deepEqual(branchProtectionFindings(liveShape, policy), []);

  const wrongApp = structuredClone(liveShape);
  wrongApp.required_status_checks.checks[0].app_id = null;
  assert.ok(branchProtectionFindings(wrongApp, policy).some((finding) => finding.includes('wrong GitHub App')));

  const missing = structuredClone(liveShape);
  missing.required_status_checks.checks.pop();
  assert.ok(branchProtectionFindings(missing, policy).some((finding) => finding.includes('is missing')));

  const extra = structuredClone(liveShape);
  extra.required_status_checks.checks.push({ context: 'untrusted check', app_id: 15368 });
  assert.ok(branchProtectionFindings(extra, policy).some((finding) => finding.includes('unexpected')));

  const duplicate = structuredClone(liveShape);
  duplicate.required_status_checks.checks.push(structuredClone(duplicate.required_status_checks.checks[0]));
  assert.ok(branchProtectionFindings(duplicate, policy).some((finding) => finding.includes('wrong GitHub App')));

  const nonStrict = structuredClone(liveShape);
  nonStrict.required_status_checks.strict = false;
  assert.ok(branchProtectionFindings(nonStrict, policy).some((finding) => finding.includes('strict')));

  const bypass = structuredClone(liveShape);
  bypass.required_pull_request_reviews.bypass_pull_request_allowances = {
    apps: [{ slug: 'example' }],
    teams: [],
    users: [],
  };
  assert.ok(branchProtectionFindings(bypass, policy).some((finding) => finding.includes('bypass allowances')));
});

test('trusted auto-merge workflow binds the controller review check to its exact created ID', () => {
  assert.match(autoMergeWorkflow, /review_check_run_id: \$\{\{ steps\.resolve\.outputs\.review_check_run_id \}\}/);
  assert.match(autoMergeWorkflow, /--review-check-run-id "\$\{\{ needs\.resolve\.outputs\.review_check_run_id \}\}"/);
  assert.match(autoMergeWorkflow, /-f name='Autonomous review complete'/);
});

test('credential incident hold blocks every cloud mutation and has no repository-local clearance path', () => {
  const hold = loadDeploymentHold();
  assert.deepEqual(validateDeploymentHold(hold), []);
  assert.deepEqual(deploymentHoldDecision(hold), { blocked: true, reason: 'active_incident', errors: [] });

  const deployDocument = parseYaml(deployEnvironmentWorkflow);
  const deploySteps = deployDocument.jobs.deploy.steps;
  assert.deepEqual(deploySteps[0], expectedIncidentBlockStep);
  assert.deepEqual(deploySteps[2], expectedHoldPolicyStep);
  assert.ok(deploySteps.findIndex((step) => String(step.uses ?? '').startsWith('azure/login@')) > 2);

  for (const workflow of [deployTestWorkflow, promoteProductionWorkflow, rollbackProductionWorkflow]) {
    const reusableJobs = Object.values(parseYaml(workflow).jobs).filter((job) => job.uses);
    assert.equal(reusableJobs.length, 1);
    assert.equal(reusableJobs[0].uses, './.github/workflows/deploy-environment.yml');
  }

  const migrationSteps = parseYaml(migratePrivateStorageWorkflow).jobs.migrate.steps;
  assert.equal(parseYaml(migratePrivateStorageWorkflow).concurrency['cancel-in-progress'], true);
  assert.deepEqual(migrationSteps[0], expectedIncidentBlockStep);
  assert.deepEqual(migrationSteps[1], {
    name: 'Checkout current security controller',
    uses: 'actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10',
    with: { ref: 'main', 'fetch-depth': 1, 'persist-credentials': false },
  });
  assert.deepEqual(migrationSteps[2], {
    name: 'Require the current main workflow generation',
    shell: 'bash',
    env: { GH_TOKEN: '${{ github.token }}' },
    run:
      'set -euo pipefail\n' +
      'current_main="$(gh api "repos/${GITHUB_REPOSITORY}/git/ref/heads/main" --jq \'.object.sha\')"\n' +
      'checked_out="$(git rev-parse HEAD)"\n' +
      'if [ "$GITHUB_REF" != "refs/heads/main" ] ||\n' +
      '   [ "$GITHUB_WORKFLOW_SHA" != "$current_main" ] ||\n' +
      '   [ "$checked_out" != "$current_main" ]; then\n' +
      '  echo "Private storage migration requires the current main workflow generation." >&2\n' +
      '  exit 1\n' +
      'fi\n',
  });
  assert.deepEqual(migrationSteps[3], expectedHoldPolicyStep);
  const migrationValidationIndex = migrationSteps.findIndex(
    (step) => step.name === 'Validate bounded migration request',
  );
  const migrationPreLoginGuardIndex = migrationSteps.findIndex(
    (step) => step.name === 'Revalidate current security controller before Azure login',
  );
  const migrationLoginIndex = migrationSteps.findIndex((step) => String(step.uses ?? '').startsWith('azure/login@'));
  const migrationCopyIndex = migrationSteps.findIndex(
    (step) => step.name === 'Copy one digest-verified reference blob',
  );
  assert.ok(
    migrationValidationIndex < migrationPreLoginGuardIndex &&
      migrationPreLoginGuardIndex < migrationLoginIndex &&
      migrationLoginIndex < migrationCopyIndex,
  );
  assert.equal(migrationSteps[migrationPreLoginGuardIndex].run, 'node scripts/assert-current-security-controller.mjs');
  const migrationCopy = migrationSteps[migrationCopyIndex].run;
  assert.match(migrationCopy, /node scripts\/assert-current-security-controller\.mjs\n\s*az storage blob upload \\/);
  assert.match(
    migrationCopy,
    /az storage blob upload[\s\S]*?--overwrite false \\\n\s*-o none\n\s*node scripts\/assert-current-security-controller\.mjs/,
  );
  assert.equal(
    (migratePrivateStorageWorkflow.match(/node scripts\/assert-current-security-controller\.mjs/g) ?? []).length,
    3,
  );

  assert.deepEqual(parseYaml(bringCanaryWorkflow).jobs['read-contract'].steps[0], expectedIncidentBlockStep);
  assert.deepEqual(parseYaml(verifyAzureOidcWorkflow).jobs.verify.steps[0], expectedIncidentBlockStep);

  const workflowSources = readdirSync(workflowsUrl)
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => [name, readFileSync(new URL(name, workflowsUrl), 'utf8')]);
  const idTokenWorkflows = workflowSources
    .filter(([, source]) => /id-token:\s*write/.test(source))
    .map(([name]) => name)
    .sort();
  assert.deepEqual(idTokenWorkflows, [
    'bring-readonly-canary.yml',
    'ci.yml',
    'deploy-environment.yml',
    'deploy-test.yml',
    'migrate-private-storage.yml',
    'promote-production.yml',
    'rollback-production.yml',
    'verify-azure-oidc.yml',
  ]);
  const environmentWorkflows = workflowSources
    .filter(([, source]) => /^\s+environment:/m.test(source))
    .map(([name]) => name)
    .sort();
  assert.deepEqual(environmentWorkflows, [
    'bring-readonly-canary.yml',
    'deploy-environment.yml',
    'migrate-private-storage.yml',
  ]);
  const cloudCapabilityPattern =
    /azure\/login@|ACTIONS_ID_TOKEN_REQUEST|az\s+(?:account\s+get-access-token|rest\b|deployment\b|storage\b|functionapp\b|webapp\b|resource\b|role\b|ad\b)/i;
  const cloudYamlSources = [...workflowSources, ...readYamlTree(actionsUrl, '.github/actions/')];
  const cloudCapableWorkflows = cloudYamlSources
    .filter(([, source]) => cloudCapabilityPattern.test(source))
    .map(([name]) => name)
    .sort();
  assert.deepEqual(cloudCapableWorkflows, [
    'deploy-environment.yml',
    'migrate-private-storage.yml',
    'verify-azure-oidc.yml',
  ]);
  const privilegedScriptPaths = [
    ...new Set(
      workflowSources
        .filter(([name]) => idTokenWorkflows.includes(name))
        .flatMap(([, source]) => source.match(/scripts\/[A-Za-z0-9_./-]+\.(?:mjs|sh)/g) ?? []),
    ),
  ].sort();
  for (const scriptPath of privilegedScriptPaths) {
    assert.ok(
      policy.merge.autonomousExcludedPaths.includes(scriptPath),
      `${scriptPath} executes from an id-token workflow and must be excluded from autonomous merge`,
    );
  }
  for (const [name, source] of workflowSources.filter(([, candidate]) => candidate.includes('azure/login@'))) {
    if (name === 'verify-azure-oidc.yml') {
      assert.doesNotMatch(
        source,
        /\baz\s+(?:deployment\s+group\s+(?:create|delete)|storage\s+blob\s+upload|functionapp\s+(?:config|deployment|restart|delete))/i,
      );
      continue;
    }
    const jobs = Object.values(parseYaml(source).jobs);
    assert.ok(
      jobs.some(
        (job) => Array.isArray(job.steps) && JSON.stringify(job.steps[0]) === JSON.stringify(expectedIncidentBlockStep),
      ),
    );
  }

  const evidence = ['github', 'azure', 'providers'].map((system, index) => ({
    system,
    revokedAt: `2026-08-01T10:${String(index).padStart(2, '0')}:00Z`,
    rotatedAt: `2026-08-01T10:${String(index + 10).padStart(2, '0')}:00Z`,
    revokedCount: index + 1,
    rotatedCount: index + 1,
    inventoryReference: `audit/${system}-inventory-2026-001`,
    revocationReference: `audit/${system}-revocation-2026-001`,
    replacementReference: `audit/${system}-replacement-2026-001`,
  }));
  const evidenceCommit = 'b'.repeat(40);
  const evidencePolicy = {
    ...hold,
    clearance: {
      status: 'evidence-recorded',
      verifiedAt: null,
      verifiedBy: null,
      evidence,
      approval: null,
    },
  };
  const now = new Date('2026-08-02T00:00:00Z');
  assert.deepEqual(validateDeploymentHold(evidencePolicy, { now }), []);

  const attemptedRepositoryClearance = {
    ...hold,
    active: false,
    clearance: {
      status: 'verified',
      verifiedAt: '2026-08-01T12:00:00Z',
      verifiedBy: 'JueZ',
      evidence,
      approval: { pullRequest: 321, evidenceCommit, commentId: 654 },
    },
  };
  const attemptedDecision = deploymentHoldDecision(attemptedRepositoryClearance, { now });
  assert.equal(attemptedDecision.blocked, true);
  assert.equal(attemptedDecision.reason, 'invalid_policy');
  assert.ok(attemptedDecision.errors.some((error) => error.includes('out-of-band trust root')));
  assert.doesNotMatch(deploymentHoldEnforcer, /issues\/comments|comment\.user|verified_clearance/);

  const duplicateReference = structuredClone(evidencePolicy);
  duplicateReference.clearance.evidence[1].inventoryReference = evidence[0].inventoryReference;
  assert.equal(deploymentHoldDecision(duplicateReference, { now }).blocked, true);
  const invalidDate = structuredClone(evidencePolicy);
  invalidDate.clearance.evidence[0].revokedAt = '2026-02-31T10:00:00Z';
  assert.equal(deploymentHoldDecision(invalidDate, { now }).blocked, true);
  const wrongIncident = { ...evidencePolicy, incidentId: 'credential-exposure-other' };
  assert.equal(deploymentHoldDecision(wrongIncident, { now }).blocked, true);
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
  assert.match(deployEnvironmentWorkflow, /TELEMETRY_EVALUATION_START=\$telemetry_evaluation_start/);
  assert.match(deployEnvironmentWorkflow, /export TELEMETRY_EVALUATION_START="\$\{TELEMETRY_EVALUATION_START:-\}"/);
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

test('infrastructure deployment validates and previews the exact create parameters without sensitive output', () => {
  const start = deployEnvironmentWorkflow.indexOf('deployment_parameters=(');
  const end = deployEnvironmentWorkflow.indexOf('echo "function_app_name=', start);
  const infrastructureDeployment = deployEnvironmentWorkflow.slice(start, end);
  const validateIndex = infrastructureDeployment.indexOf('az deployment group validate');
  const whatIfIndex = infrastructureDeployment.indexOf('az deployment group what-if');
  const generationIndex = infrastructureDeployment.indexOf('node scripts/assert-current-main.mjs');
  const createIndex = infrastructureDeployment.indexOf('az deployment group create');

  assert.ok(start > 0 && validateIndex < whatIfIndex && whatIfIndex < generationIndex && generationIndex < createIndex);
  assert.equal(infrastructureDeployment.match(/--parameters "\$\{deployment_parameters\[@\]\}"/g)?.length, 3);
  assert.match(infrastructureDeployment, /az deployment group what-if[\s\S]*?--result-format ResourceIdOnly/);
  assert.equal(infrastructureDeployment.match(/--output none/g)?.length, 2);
});

test('deployment verifies dependencies and artifacts before cloud login and scopes workflow secrets', () => {
  const installIndex = deployEnvironmentWorkflow.indexOf('- name: Install dependencies');
  const verificationIndex = deployEnvironmentWorkflow.indexOf('- name: Verify immutable release bundle');
  const loginIndex = deployEnvironmentWorkflow.indexOf('- name: Azure OIDC login');
  const bicepIndex = deployEnvironmentWorkflow.indexOf('- name: Deploy Bicep infrastructure');
  assert.ok(installIndex < verificationIndex && verificationIndex < loginIndex && loginIndex < bicepIndex);
  assert.match(deployEnvironmentWorkflow.slice(installIndex, verificationIndex), /npm ci --ignore-scripts/);
  const verificationBlock = deployEnvironmentWorkflow.slice(verificationIndex, loginIndex);
  assert.match(verificationBlock, /gh attestation verify "\$release_dir\/\$artifact"/);
  assert.match(verificationBlock, /--signer-workflow "github\.com\/\$GITHUB_REPOSITORY\/\.github\/workflows\/ci\.yml"/);
  assert.match(verificationBlock, /--source-digest "\$\{SOURCE_REF:-\$\{GITHUB_SHA\}\}"/);
  assert.match(verificationBlock, /--source-ref refs\/heads\/main/);
  assert.match(verificationBlock, /--deny-self-hosted-runners/);

  const jobEnvironment = deployEnvironmentWorkflow.slice(
    deployEnvironmentWorkflow.indexOf('    env:\n'),
    deployEnvironmentWorkflow.indexOf('    steps:\n'),
  );
  assert.doesNotMatch(jobEnvironment, /WLH_BASE_URL|GH_TOKEN/);
  assert.match(
    deployEnvironmentWorkflow,
    /name: Validate deployment configuration[\s\S]*?WLH_BASE_URL: \$\{\{ secrets\.WLH_BASE_URL \}\}/,
  );
  assert.match(
    deployEnvironmentWorkflow,
    /name: Deploy Bicep infrastructure[\s\S]*?WLH_BASE_URL: \$\{\{ secrets\.WLH_BASE_URL \}\}/,
  );
});

test('Function supply-chain policy covers the independently locked deployed package', () => {
  assert.match(dependabotConfig, /directory: '\/apps\/api'/);
  assert.match(ciWorkflow, /cache-dependency-path: \|\n\s+package-lock\.json\n\s+apps\/api\/package-lock\.json/);
  assert.match(ciWorkflow, /npm --prefix apps\/api audit --audit-level=high/);
  assert.match(
    ciWorkflow,
    /if: github\.ref == 'refs\/heads\/main' && \(github\.event_name == 'push' \|\| github\.event_name == 'workflow_dispatch'\)/,
  );
  const sbomBlock = releaseArtifactBuilder.slice(
    releaseArtifactBuilder.lastIndexOf('(\n', releaseArtifactBuilder.indexOf('npm sbom')),
    releaseArtifactBuilder.indexOf('\n)\n', releaseArtifactBuilder.indexOf('npm sbom')) + 3,
  );
  assert.match(sbomBlock, /cd "\$function_stage"/);
  assert.match(sbomBlock, /npm sbom --omit=dev --sbom-format cyclonedx/);
  assert.doesNotMatch(sbomBlock, /repository_root/);
  assert.match(releaseArtifactBuilder, /node "\$function_stage\/dist\/index\.js"/);
  assert.match(releaseArtifactBuilder, /OIDC_ALLOWED_OBJECT_IDS=[0-9a-f-]+-0000-0000-[0-9a-f-]+ \\/i);
  assert.match(releaseArtifactBuilder, /OIDC_ALLOWED_TENANTS=[0-9a-f-]+-0000-0000-[0-9a-f-]+ \\/i);
  assert.ok(
    releaseArtifactBuilder.indexOf('npm ci --omit=dev --ignore-scripts --prefix "$function_stage"') <
      releaseArtifactBuilder.indexOf('node "$function_stage/dist/index.js"'),
  );
});

test('service smoke tokens prove least-privilege application roles before use', () => {
  assert.match(deployEnvironmentWorkflow, /SERVICE_AUTH_REQUIRED_ROLES='catalogue\.read,reddit\.read'/);
  assert.match(bringCanaryWorkflow, /SERVICE_AUTH_REQUIRED_ROLES: bring\.read/);
});

test('Azure diagnostics select architecture-tagged storage and emit only aggregate telemetry', () => {
  assert.match(azureDiagnostics, /tags\.purpose=='immutable-release-packages'/);
  assert.match(azureDiagnostics, /expected exactly one Storage account tagged purpose=immutable-release-packages/);
  assert.doesNotMatch(azureDiagnostics, /head -n 1/);

  const queryStart = azureDiagnostics.indexOf("aggregate_query=$(cat <<'KQL'");
  const queryEnd = azureDiagnostics.indexOf('\nKQL\n', queryStart);
  const aggregateQuery = azureDiagnostics.slice(queryStart, queryEnd);
  assert.match(aggregateQuery, /requestCount=/);
  assert.match(aggregateQuery, /exceptionCount=/);
  assert.doesNotMatch(aggregateQuery, /message|payload|customDimensions/i);
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

test('risk classification covers workflow, supply-chain, deployment, application, and agent controls', () => {
  const paths = [
    '.github/workflows/ci.yml',
    'package-lock.json',
    'apps/api/package-lock.json',
    'scripts/build-release-artifacts.sh',
    'scripts/assert-current-main.mjs',
    'apps/api/src/mcp/server.ts',
    'apps/api/src/shared/bring/client.ts',
    'contracts/openapi.yaml',
    '.agents/skills/example/SKILL.md',
  ];
  const risk = classifyRisk(paths, policy);
  assert.equal(risk.highRisk, true);
  assert.deepEqual(risk.highRiskPaths, paths);
  assert.deepEqual(risk.classes.softwareSupplyChain, [
    'package-lock.json',
    'apps/api/package-lock.json',
    'scripts/build-release-artifacts.sh',
  ]);
  assert.deepEqual(risk.classes.deploymentRuntime, ['scripts/assert-current-main.mjs']);
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
  assert.equal(evaluateChecks(successfulChecks()).ok, true);

  const wrongApp = successfulChecks();
  wrongApp[0] = { ...wrongApp[0], app: { slug: 'untrusted-app' } };
  assert.equal(evaluateChecks(wrongApp).failures[0].reason, 'wrong_app');

  const wrongAppId = successfulChecks();
  wrongAppId[0] = { ...wrongAppId[0], app: { slug: 'github-actions', id: 1 } };
  assert.equal(evaluateChecks(wrongAppId).failures[0].reason, 'wrong_app');

  const wrongHead = successfulChecks();
  wrongHead[0] = { ...wrongHead[0], head_sha: 'b'.repeat(40) };
  const evaluation = evaluateChecks(wrongHead);
  assert.ok(evaluation.failures.some((failure) => failure.reason === 'wrong_head_sha'));
  assert.ok(evaluation.pending.some((pending) => pending.reason === 'missing'));
});

test('required checks bind Actions workflow identity, event, PR, attempt, and controller check ID', () => {
  assert.deepEqual(actionsRunCoordinates('https://github.com/JueZ/api/actions/runs/101/job/1', repository), {
    runId: 101,
    jobId: 1,
  });
  assert.equal(actionsRunCoordinates('https://github.com/Other/api/actions/runs/101/job/1', repository), null);
  assert.equal(actionsRunCoordinates('https://attacker@github.com/JueZ/api/actions/runs/101/job/1', repository), null);
  assert.equal(actionsRunCoordinates('https://github.com/JueZ/api/actions/runs/101/job/1?x=1', repository), null);

  const wrongDetails = successfulChecks();
  wrongDetails[0] = {
    ...wrongDetails[0],
    details_url: 'https://github.com/JueZ/api/actions/runs/101/job/999',
  };
  assert.equal(evaluateChecks(wrongDetails).failures[0].reason, 'wrong_source');

  for (const [field, value] of [
    ['workflow_id', 1],
    ['path', '.github/workflows/untrusted.yml'],
    ['event', 'pull_request_target'],
    ['run_attempt', 2],
    ['head_sha', 'b'.repeat(40)],
  ]) {
    const actionsRuns = successfulActionsRuns();
    actionsRuns.set(actionsRunIds.ci, { ...actionsRuns.get(actionsRunIds.ci), [field]: value });
    assert.equal(evaluateChecks(successfulChecks(), { actionsRuns }).failures[0].reason, 'wrong_source');
  }

  const wrongPullRequest = successfulActionsRuns();
  wrongPullRequest.get(actionsRunIds.ci).pull_requests[0].number = 999;
  assert.equal(
    evaluateChecks(successfulChecks(), { actionsRuns: wrongPullRequest }).failures[0].reason,
    'wrong_source',
  );

  const controllerIndex = policy.requiredChecks.findIndex(
    (required) => policy.trustedCheckSources[required.source].kind === 'controller',
  );
  const wrongController = successfulChecks();
  wrongController[controllerIndex] = {
    ...wrongController[controllerIndex],
    id: controllerCheckRunId + 1,
    details_url: `https://github.com/${repository}/runs/${controllerCheckRunId + 1}`,
  };
  assert.equal(evaluateChecks(wrongController).failures.at(-1).reason, 'wrong_source');

  assert.deepEqual(
    trustedWorkflowSourceChanges(
      [{ filename: '.github/workflows/ci.yml' }, { filename: 'README.md' }],
      policy.trustedCheckSources,
    ),
    ['.github/workflows/ci.yml'],
  );
  assert.deepEqual(
    trustedWorkflowSourceChanges(
      [
        {
          filename: 'docs/retired-ci.yml',
          previous_filename: '.github/workflows/ci.yml',
          status: 'renamed',
        },
      ],
      policy.trustedCheckSources,
    ),
    ['.github/workflows/ci.yml'],
  );
});

test('required checks treat pending and failed checks as non-passing', () => {
  const pending = successfulChecks();
  pending[2] = { ...pending[2], status: 'in_progress', conclusion: null };
  assert.equal(evaluateChecks(pending).ok, false);

  const failed = successfulChecks();
  failed[3] = { ...failed[3], conclusion: 'failure' };
  assert.equal(evaluateChecks(failed).failures[0].reason, 'failure');
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

test('autonomous review rejects trust-root changes without invoking the model', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'autonomous-review-trust-root-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const reviewFile = join(directory, 'review.json');
  let modelCalls = 0;
  const github = {
    async getPullRequest() {
      return { ...pullRequest(), title: 'Change deployment trust root', body: '' };
    },
    async getPullRequestFiles() {
      return [
        {
          filename: 'docs/retired-deploy-test.yml',
          previous_filename: '.github/workflows/deploy-test.yml',
          status: 'renamed',
          additions: 1,
          deletions: 0,
        },
      ];
    },
  };
  const client = {
    responses: {
      async create() {
        modelCalls += 1;
        return {};
      },
    },
  };

  await assert.rejects(
    runReview({ repository, prNumber: pullRequestNumber, headSha, reviewFile }, policy, github, client),
    /refused security-control changes/,
  );
  assert.equal(modelCalls, 0);
  const review = JSON.parse(await readFile(reviewFile, 'utf8'));
  assert.equal(review.decision, 'reject');
  assert.equal(review.findings[0].severity, 'high');
  assert.match(review.findings[0].evidence, /deploy-test\.yml/);
});

test('high-risk autonomous review retries an empty response with a larger output budget', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'autonomous-review-retry-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const requests = [];
  const github = {
    async getPullRequest() {
      return { ...pullRequest(), title: 'High-risk change', body: 'Review this change.' };
    },
    async getPullRequestFiles() {
      return [{ filename: 'apps/api/src/shared/security/example.ts', status: 'modified', additions: 1, deletions: 0 }];
    },
    async getPullRequestDiff() {
      return 'diff --git a/example b/example';
    },
  };
  const client = {
    responses: {
      async create(request) {
        requests.push(request);
        if (requests.length === 1) {
          return {
            id: 'resp_incomplete',
            status: 'incomplete',
            incomplete_details: { reason: 'max_output_tokens' },
            output_text: '',
          };
        }
        return {
          id: 'resp_complete',
          status: 'completed',
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
  assert.deepEqual(
    requests.map((request) => request.max_output_tokens),
    [6000, 12000],
  );
});

test('high-risk autonomous review does not accept structured output from an incomplete response', async (context) => {
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
      return [{ filename: 'apps/api/src/shared/security/example.ts', status: 'modified', additions: 1, deletions: 0 }];
    },
    async getPullRequestDiff() {
      return 'diff --git a/example b/example';
    },
  };
  const client = {
    responses: {
      async create(request) {
        requests.push(request);
        return requests.length === 1
          ? {
              id: 'resp_incomplete',
              status: 'incomplete',
              incomplete_details: { reason: 'max_output_tokens' },
              output_text: approvedOutput,
            }
          : { id: 'resp_complete', status: 'completed', output_text: approvedOutput };
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
  assert.equal(requests.length, 2);
});

test('high-risk autonomous review retries a structurally invalid decision', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'autonomous-review-invalid-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  let attempts = 0;
  const github = {
    async getPullRequest() {
      return { ...pullRequest(), title: 'High-risk change', body: 'Review this change.' };
    },
    async getPullRequestFiles() {
      return [{ filename: 'apps/api/src/shared/security/example.ts', status: 'modified', additions: 1, deletions: 0 }];
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
            findings:
              attempts === 1
                ? [{ severity: 'high', title: 'Blocked', evidence: 'Unsafe.', remediation: 'Repair it.' }]
                : [],
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
  assert.equal(review.responseId, 'resp_2');
  assert.equal(attempts, 2);
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
      return [{ filename: 'apps/api/src/shared/security/example.ts', status: 'modified', additions: 1, deletions: 0 }];
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
  assert.equal(review.modelFailure.attempts, 2);
  assert.equal(review.modelFailure.incompleteReason, 'max_output_tokens');
  assert.equal(review.findings[0].severity, 'high');
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
  const checkEvaluation = evaluateChecks(successfulChecks());
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
