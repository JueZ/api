#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { loadDeploymentHold, validateDeploymentHold } from './enforce-security-deployment-hold.mjs';

export const GITHUB_CONTROL_REPOSITORY = 'JueZ/api';
export const PROTECTED_DEPLOYMENT_ENVIRONMENTS = ['test', 'production'];
export const EXPECTED_OIDC_SUBJECT_CLAIMS = ['repo', 'context', 'job_workflow_ref'];
export const NONTERMINAL_ACTIONS_STATUSES = ['requested', 'waiting', 'pending', 'queued', 'in_progress'];
export const INCIDENT_DISABLED_WORKFLOWS = [
  'bring-readonly-canary.yml',
  'codex-main-delivery.yml',
  'deploy-test.yml',
  'promote-production.yml',
  'rollback-production.yml',
  'migrate-private-storage.yml',
  'verify-azure-oidc.yml',
];

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function arraysEqual(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

export function deploymentControlEndpoints({ repository = GITHUB_CONTROL_REPOSITORY, holdActive } = {}) {
  if (repository !== GITHUB_CONTROL_REPOSITORY) {
    throw new Error(`deployment control repository must be ${GITHUB_CONTROL_REPOSITORY}`);
  }
  if (typeof holdActive !== 'boolean') throw new Error('holdActive must be a boolean');

  return {
    environments: Object.fromEntries(
      PROTECTED_DEPLOYMENT_ENVIRONMENTS.map((environment) => [
        environment,
        `repos/${repository}/environments/${environment}`,
      ]),
    ),
    oidcSubject: `repos/${repository}/actions/oidc/customization/sub`,
    actionsPermissions: `repos/${repository}/actions/permissions`,
    repository: `repos/${repository}`,
    activeRuns: holdActive
      ? Object.fromEntries(
          NONTERMINAL_ACTIONS_STATUSES.map((status) => [
            status,
            `repos/${repository}/actions/runs?status=${status}&per_page=1`,
          ]),
        )
      : {},
    workflows: holdActive
      ? Object.fromEntries(
          INCIDENT_DISABLED_WORKFLOWS.map((workflow) => [
            workflow,
            `repos/${repository}/actions/workflows/${workflow}`,
          ]),
        )
      : {},
  };
}

export function githubDeploymentControlFindings(snapshot, { holdActive } = {}) {
  const findings = [];
  if (!isRecord(snapshot)) return ['GitHub deployment control snapshot must be an object'];
  if (typeof holdActive !== 'boolean') return ['holdActive must be a boolean'];

  for (const environment of PROTECTED_DEPLOYMENT_ENVIRONMENTS) {
    const actual = snapshot.environments?.[environment];
    if (!isRecord(actual)) {
      findings.push(`GitHub environment ${environment} metadata is unavailable`);
      continue;
    }
    if (actual.name !== environment) {
      findings.push(`GitHub environment ${environment} returned mismatched metadata`);
    }
    if (actual.deployment_branch_policy?.protected_branches !== true) {
      findings.push(`GitHub environment ${environment} must allow protected branches only`);
    }
    if (actual.deployment_branch_policy?.custom_branch_policies !== false) {
      findings.push(`GitHub environment ${environment} must disable custom branch policies`);
    }
  }

  if (!isRecord(snapshot.oidcSubject)) {
    findings.push('repository OIDC subject customization metadata is unavailable');
  } else {
    if (snapshot.oidcSubject.use_default !== false) {
      findings.push('repository OIDC subject customization must disable the default subject');
    }
    if (!arraysEqual(snapshot.oidcSubject.include_claim_keys, EXPECTED_OIDC_SUBJECT_CLAIMS)) {
      findings.push(`repository OIDC subject claims must be exactly ${EXPECTED_OIDC_SUBJECT_CLAIMS.join(',')}`);
    }
  }

  if (holdActive) {
    if (snapshot.actionsPermissions?.enabled !== false) {
      findings.push('repository Actions must remain disabled during the deployment hold');
    }
    if (snapshot.repository?.allow_auto_merge !== false) {
      findings.push('repository auto-merge must remain disabled during the deployment hold');
    }
    for (const status of NONTERMINAL_ACTIONS_STATUSES) {
      const actual = snapshot.activeRuns?.[status];
      if (
        !isRecord(actual) ||
        !Number.isSafeInteger(actual.total_count) ||
        actual.total_count < 0 ||
        !Array.isArray(actual.workflow_runs)
      ) {
        findings.push(`repository Actions run status metadata is unavailable: ${status}`);
        continue;
      }
      if (actual.total_count !== 0 || actual.workflow_runs.length !== 0) {
        findings.push(`repository must have no nonterminal Actions runs with status ${status}`);
      }
    }
    for (const workflow of INCIDENT_DISABLED_WORKFLOWS) {
      const actual = snapshot.workflows?.[workflow];
      if (!isRecord(actual)) {
        findings.push(`incident-disabled workflow metadata is unavailable: ${workflow}`);
        continue;
      }
      if (actual.path !== `.github/workflows/${workflow}`) {
        findings.push(`incident-disabled workflow returned mismatched metadata: ${workflow}`);
      }
      if (actual.state !== 'disabled_manually') {
        findings.push(`workflow must remain disabled_manually during the deployment hold: ${workflow}`);
      }
    }
  }

  return findings;
}

function ghApi(endpoint) {
  const completed = spawnSync('gh', ['api', '--method', 'GET', endpoint], {
    encoding: 'utf8',
    env: { ...process.env, GH_PROMPT_DISABLED: '1' },
    maxBuffer: 2 * 1024 * 1024,
    timeout: 30_000,
  });
  if (completed.error || completed.status !== 0) {
    throw new Error(`GitHub CLI could not read approved structural endpoint ${endpoint}`);
  }
  try {
    return JSON.parse(completed.stdout);
  } catch {
    throw new Error(`GitHub CLI returned invalid JSON for approved structural endpoint ${endpoint}`);
  }
}

export function collectGitHubDeploymentControls({
  repository = GITHUB_CONTROL_REPOSITORY,
  holdActive,
  runGhApi = ghApi,
} = {}) {
  if (typeof runGhApi !== 'function') throw new Error('runGhApi must be a function');
  const endpoints = deploymentControlEndpoints({ repository, holdActive });
  return {
    environments: Object.fromEntries(
      Object.entries(endpoints.environments).map(([environment, endpoint]) => [environment, runGhApi(endpoint)]),
    ),
    oidcSubject: runGhApi(endpoints.oidcSubject),
    actionsPermissions: holdActive ? runGhApi(endpoints.actionsPermissions) : null,
    repository: holdActive ? runGhApi(endpoints.repository) : null,
    activeRuns: Object.fromEntries(
      Object.entries(endpoints.activeRuns).map(([status, endpoint]) => [status, runGhApi(endpoint)]),
    ),
    workflows: Object.fromEntries(
      Object.entries(endpoints.workflows).map(([workflow, endpoint]) => [workflow, runGhApi(endpoint)]),
    ),
  };
}

export function verifyGitHubDeploymentControls({
  holdPolicy = loadDeploymentHold(),
  repository = GITHUB_CONTROL_REPOSITORY,
  runGhApi = ghApi,
  now = new Date(),
} = {}) {
  const holdFindings = validateDeploymentHold(holdPolicy, { now }).map(
    (finding) => `deployment hold policy is invalid: ${finding}`,
  );
  if (holdFindings.length > 0) return { ok: false, findings: holdFindings };

  let snapshot;
  try {
    snapshot = collectGitHubDeploymentControls({
      repository,
      holdActive: holdPolicy.active,
      runGhApi,
    });
  } catch (error) {
    return {
      ok: false,
      findings: [error instanceof Error ? error.message : 'GitHub deployment control collection failed'],
    };
  }
  const findings = githubDeploymentControlFindings(snapshot, { holdActive: holdPolicy.active });
  return { ok: findings.length === 0, findings };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.length !== 2) {
    console.error('Usage: verify-github-deployment-controls.mjs');
    process.exit(2);
  }
  const result = verifyGitHubDeploymentControls();
  if (!result.ok) {
    console.error(`GitHub deployment containment verification failed:\n- ${result.findings.join('\n- ')}`);
    process.exit(1);
  }
  console.log(
    'GitHub deployment containment matches protected-environment, workflow-state, no-active-run, and workflow-bound OIDC policy.',
  );
}
