import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EXPECTED_OIDC_SUBJECT_CLAIMS,
  GITHUB_CONTROL_REPOSITORY,
  INCIDENT_DISABLED_WORKFLOWS,
  NONTERMINAL_ACTIONS_STATUSES,
  collectGitHubDeploymentControls,
  deploymentControlEndpoints,
  githubDeploymentControlFindings,
  verifyGitHubDeploymentControls,
} from '../verify-github-deployment-controls.mjs';

function holdPolicy(active = true) {
  return {
    version: 1,
    active,
    incidentId: 'credential-exposure-2026-07-31',
    discoveredAt: '2026-07-31T00:00:00Z',
    reason: 'Potential credentials require external revocation and rotation evidence before deployment resumes.',
    clearance: active
      ? { status: 'pending', verifiedAt: null, verifiedBy: null, evidence: [], approval: null }
      : {
          status: 'verified',
          verifiedAt: '2026-07-31T12:00:00Z',
          verifiedBy: 'JueZ',
          evidence: [
            evidence('github', 'github-inventory-1', 'github-revocation-1', 'github-replacement-1'),
            evidence('azure', 'azure-inventory-1', 'azure-revocation-1', 'azure-replacement-1'),
            evidence('providers', 'provider-inventory-1', 'provider-revocation-1', 'provider-replacement-1'),
          ],
          approval: { pullRequest: 1, evidenceCommit: 'a'.repeat(40), commentId: 1 },
        },
  };
}

function evidence(system, inventoryReference, revocationReference, replacementReference) {
  return {
    system,
    revokedAt: '2026-07-31T10:00:00Z',
    rotatedAt: '2026-07-31T10:05:00Z',
    revokedCount: 1,
    rotatedCount: 1,
    inventoryReference,
    revocationReference,
    replacementReference,
  };
}

function validSnapshot({ includeWorkflows = true } = {}) {
  return {
    environments: {
      test: {
        name: 'test',
        deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
      },
      production: {
        name: 'production',
        deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
      },
    },
    oidcSubject: { use_default: false, include_claim_keys: [...EXPECTED_OIDC_SUBJECT_CLAIMS] },
    actionsPermissions: { enabled: false },
    repository: { allow_auto_merge: false },
    activeRuns: Object.fromEntries(
      NONTERMINAL_ACTIONS_STATUSES.map((status) => [status, { total_count: 0, workflow_runs: [] }]),
    ),
    workflows: includeWorkflows
      ? Object.fromEntries(
          INCIDENT_DISABLED_WORKFLOWS.map((workflow) => [
            workflow,
            { path: `.github/workflows/${workflow}`, state: 'disabled_manually' },
          ]),
        )
      : {},
  };
}

test('deployment control endpoints are fixed to secret-safe structural API families', () => {
  const endpoints = deploymentControlEndpoints({ holdActive: true });
  assert.deepEqual(Object.values(endpoints.environments), [
    'repos/JueZ/api/environments/test',
    'repos/JueZ/api/environments/production',
  ]);
  assert.equal(endpoints.oidcSubject, 'repos/JueZ/api/actions/oidc/customization/sub');
  assert.equal(endpoints.actionsPermissions, 'repos/JueZ/api/actions/permissions');
  assert.equal(endpoints.repository, 'repos/JueZ/api');
  assert.deepEqual(
    endpoints.activeRuns,
    Object.fromEntries(
      NONTERMINAL_ACTIONS_STATUSES.map((status) => [status, `repos/JueZ/api/actions/runs?status=${status}&per_page=1`]),
    ),
  );
  assert.deepEqual(
    Object.values(endpoints.workflows),
    INCIDENT_DISABLED_WORKFLOWS.map((workflow) => `repos/JueZ/api/actions/workflows/${workflow}`),
  );
  assert.throws(
    () => deploymentControlEndpoints({ repository: 'untrusted/repository', holdActive: true }),
    /must be JueZ\/api/,
  );
  assert.throws(() => deploymentControlEndpoints({ holdActive: 'yes' }), /must be a boolean/);
});

test('canonical active-hold deployment controls pass without exposing response data', () => {
  assert.deepEqual(githubDeploymentControlFindings(validSnapshot(), { holdActive: true }), []);
});

test('environment and OIDC containment drift fails closed', () => {
  const wrong = validSnapshot();
  wrong.environments.test.name = 'production';
  wrong.environments.test.deployment_branch_policy.protected_branches = false;
  wrong.environments.production.deployment_branch_policy.custom_branch_policies = true;
  wrong.oidcSubject.use_default = true;
  wrong.oidcSubject.include_claim_keys = ['repo', 'job_workflow_ref', 'context'];
  const findings = githubDeploymentControlFindings(wrong, { holdActive: true });
  assert.ok(findings.some((finding) => finding.includes('test returned mismatched')));
  assert.ok(findings.some((finding) => finding.includes('test must allow protected branches only')));
  assert.ok(findings.some((finding) => finding.includes('production must disable custom branch policies')));
  assert.ok(findings.some((finding) => finding.includes('disable the default subject')));
  assert.ok(findings.some((finding) => finding.includes('claims must be exactly')));

  const missing = githubDeploymentControlFindings(
    { environments: {}, oidcSubject: null, workflows: {} },
    { holdActive: true },
  );
  assert.ok(missing.some((finding) => finding.includes('environment test metadata is unavailable')));
  assert.ok(missing.some((finding) => finding.includes('OIDC subject customization metadata is unavailable')));
});

test('every incident workflow must be the exact disabled metadata record while the hold is active', () => {
  for (const workflow of INCIDENT_DISABLED_WORKFLOWS) {
    const wrongState = validSnapshot();
    wrongState.workflows[workflow].state = 'active';
    assert.ok(
      githubDeploymentControlFindings(wrongState, { holdActive: true }).some((finding) =>
        finding.includes(`disabled_manually during the deployment hold: ${workflow}`),
      ),
    );

    const wrongPath = validSnapshot();
    wrongPath.workflows[workflow].path = `.github/workflows/other-${workflow}`;
    assert.ok(
      githubDeploymentControlFindings(wrongPath, { holdActive: true }).some((finding) =>
        finding.includes(`mismatched metadata: ${workflow}`),
      ),
    );
  }
});

test('active hold requires repository-wide Actions and auto-merge suspension', () => {
  const actionsEnabled = validSnapshot();
  actionsEnabled.actionsPermissions.enabled = true;
  assert.ok(
    githubDeploymentControlFindings(actionsEnabled, { holdActive: true }).some((finding) =>
      finding.includes('Actions must remain disabled'),
    ),
  );

  const autoMergeEnabled = validSnapshot();
  autoMergeEnabled.repository.allow_auto_merge = true;
  assert.ok(
    githubDeploymentControlFindings(autoMergeEnabled, { holdActive: true }).some((finding) =>
      finding.includes('auto-merge must remain disabled'),
    ),
  );

  const activeRun = validSnapshot();
  activeRun.activeRuns.in_progress = {
    total_count: 1,
    workflow_runs: [{ id: 123, status: 'in_progress' }],
  };
  assert.ok(
    githubDeploymentControlFindings(activeRun, { holdActive: true }).some((finding) =>
      finding.includes('no nonterminal Actions runs with status in_progress'),
    ),
  );

  const missingRunState = validSnapshot();
  delete missingRunState.activeRuns.queued;
  assert.ok(
    githubDeploymentControlFindings(missingRunState, { holdActive: true }).some((finding) =>
      finding.includes('run status metadata is unavailable: queued'),
    ),
  );
});

test('inactive hold preserves environment and OIDC checks without querying workflow metadata', () => {
  const endpoints = deploymentControlEndpoints({ holdActive: false });
  assert.deepEqual(endpoints.workflows, {});
  assert.deepEqual(endpoints.activeRuns, {});
  assert.deepEqual(
    githubDeploymentControlFindings(validSnapshot({ includeWorkflows: false }), { holdActive: false }),
    [],
  );
});

test('collector calls only the allowlisted structural endpoints', () => {
  const expected = deploymentControlEndpoints({ holdActive: true });
  const responses = new Map([
    ...Object.entries(validSnapshot().environments).map(([environment, value]) => [
      expected.environments[environment],
      value,
    ]),
    [expected.oidcSubject, validSnapshot().oidcSubject],
    [expected.actionsPermissions, validSnapshot().actionsPermissions],
    [expected.repository, validSnapshot().repository],
    ...Object.entries(validSnapshot().activeRuns).map(([status, value]) => [expected.activeRuns[status], value]),
    ...Object.entries(validSnapshot().workflows).map(([workflow, value]) => [expected.workflows[workflow], value]),
  ]);
  const calls = [];
  const snapshot = collectGitHubDeploymentControls({
    holdActive: true,
    runGhApi(endpoint) {
      calls.push(endpoint);
      assert.ok(responses.has(endpoint));
      return responses.get(endpoint);
    },
  });
  assert.deepEqual(githubDeploymentControlFindings(snapshot, { holdActive: true }), []);
  assert.deepEqual(calls, [
    ...Object.values(expected.environments),
    expected.oidcSubject,
    expected.actionsPermissions,
    expected.repository,
    ...Object.values(expected.activeRuns),
    ...Object.values(expected.workflows),
  ]);
  assert.ok(calls.every((endpoint) => !/(?:secret|variable|token|credential)/i.test(endpoint)));
});

test('invalid hold policy fails before any GitHub request', () => {
  let calls = 0;
  const invalid = holdPolicy(true);
  invalid.incidentId = 'another-incident';
  const result = verifyGitHubDeploymentControls({
    holdPolicy: invalid,
    now: new Date('2026-07-31T13:00:00Z'),
    runGhApi() {
      calls += 1;
      return {};
    },
  });
  assert.equal(result.ok, false);
  assert.equal(calls, 0);
  assert.ok(result.findings.every((finding) => finding.startsWith('deployment hold policy is invalid:')));
});

test('live verifier reports only structural findings and accepts canonical metadata', () => {
  const endpoints = deploymentControlEndpoints({ repository: GITHUB_CONTROL_REPOSITORY, holdActive: true });
  const snapshot = validSnapshot();
  const responses = new Map([
    [endpoints.environments.test, snapshot.environments.test],
    [endpoints.environments.production, snapshot.environments.production],
    [endpoints.oidcSubject, snapshot.oidcSubject],
    [endpoints.actionsPermissions, snapshot.actionsPermissions],
    [endpoints.repository, snapshot.repository],
    ...NONTERMINAL_ACTIONS_STATUSES.map((status) => [endpoints.activeRuns[status], snapshot.activeRuns[status]]),
    ...INCIDENT_DISABLED_WORKFLOWS.map((workflow) => [endpoints.workflows[workflow], snapshot.workflows[workflow]]),
  ]);
  const result = verifyGitHubDeploymentControls({
    holdPolicy: holdPolicy(true),
    now: new Date('2026-07-31T13:00:00Z'),
    runGhApi: (endpoint) => responses.get(endpoint),
  });
  assert.deepEqual(result, { ok: true, findings: [] });

  const failed = verifyGitHubDeploymentControls({
    holdPolicy: holdPolicy(true),
    now: new Date('2026-07-31T13:00:00Z'),
    runGhApi() {
      throw new Error('GitHub CLI could not read approved structural endpoint');
    },
  });
  assert.deepEqual(failed, {
    ok: false,
    findings: ['GitHub CLI could not read approved structural endpoint'],
  });
});
