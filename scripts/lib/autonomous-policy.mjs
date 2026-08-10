import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { AUTONOMOUS_GOVERNANCE_EVALUATOR } from './autonomous-governance-evidence.mjs';
import {
  classifyDeploymentImpact as classifyDeploymentImpactWithPatterns,
  matchesPolicyGlob,
  pathsMatchingPatterns,
  RUNTIME_NEUTRAL_DEPLOYMENT_PATHS,
} from './deployment-impact.mjs';

export { matchesPolicyGlob, pathsMatchingPatterns, RUNTIME_NEUTRAL_DEPLOYMENT_PATHS };

export const DEFAULT_POLICY_PATH = fileURLToPath(new URL('../../.github/autonomous-policy.yml', import.meta.url));
export const STABLE_REQUIRED_CHECKS = Object.freeze([
  Object.freeze({ name: 'PR Gate', appSlug: 'github-actions' }),
  Object.freeze({ name: 'Security Gate', appSlug: 'github-actions' }),
]);
export const AGENT_LEARNING_ROLLOUT_TIMESTAMP = '2026-08-09T20:24:47Z';
const REQUIRED_EXECUTABLE_HIGH_RISK_PATTERNS = Object.freeze([
  'package.json',
  'package-lock.json',
  'angular.json',
  'tsconfig.json',
  'eslint.config.js',
  '.prettierignore',
  '.prettierrc.json',
  'apps/**',
  'scripts/**',
]);
const REQUIRED_AGENT_GOVERNANCE_PATTERNS = Object.freeze([
  'AGENTS.md',
  '**/AGENTS.md',
  '.agents/skills/**',
  'evals/agent-tasks/**',
  'docs/agent-learning/**',
  'scripts/agent-learning/**',
  'scripts/agent-task-evals/**',
]);

export function loadAutonomousPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const policy = parse(readFileSync(policyPath, 'utf8'));
  const errors = validateAutonomousPolicy(policy);
  if (errors.length > 0) {
    throw new Error(`Invalid autonomous policy:\n- ${errors.join('\n- ')}`);
  }
  return policy;
}

export function validateAutonomousPolicy(policy) {
  const errors = [];
  if (!isRecord(policy)) return ['policy must be an object'];
  if (policy.version !== 1) errors.push('version must be 1');

  if (!isRecord(policy.trustedWorkflowSha256) || Object.keys(policy.trustedWorkflowSha256).length === 0) {
    errors.push('trustedWorkflowSha256 must be a non-empty mapping');
  } else {
    for (const [workflowName, digest] of Object.entries(policy.trustedWorkflowSha256)) {
      if (!/^[A-Za-z0-9._-]+\.ya?ml$/.test(workflowName) || !/^[0-9a-f]{64}$/.test(digest)) {
        errors.push(`trustedWorkflowSha256 contains an invalid entry: ${workflowName}`);
      }
    }
  }

  if (!Array.isArray(policy.requiredChecks) || policy.requiredChecks.length === 0) {
    errors.push('requiredChecks must be a non-empty array');
  } else {
    const names = new Set();
    for (const [index, check] of policy.requiredChecks.entries()) {
      if (!isRecord(check) || !nonEmptyString(check.name) || !nonEmptyString(check.appSlug)) {
        errors.push(`requiredChecks[${index}] must contain non-empty name and appSlug`);
        continue;
      }
      if (names.has(check.name)) errors.push(`required check name is duplicated: ${check.name}`);
      names.add(check.name);
    }
    if (
      policy.requiredChecks.length !== STABLE_REQUIRED_CHECKS.length ||
      STABLE_REQUIRED_CHECKS.some(
        (expected, index) =>
          policy.requiredChecks[index]?.name !== expected.name ||
          policy.requiredChecks[index]?.appSlug !== expected.appSlug,
      )
    ) {
      errors.push(
        `requiredChecks must contain exactly the stable aggregate checks: ${STABLE_REQUIRED_CHECKS.map((check) => check.name).join(', ')}`,
      );
    }
  }

  validateStringArray(policy.highRiskPaths, 'highRiskPaths', errors);
  const highRiskPatterns = new Set(Array.isArray(policy.highRiskPaths) ? policy.highRiskPaths : []);
  for (const pattern of REQUIRED_EXECUTABLE_HIGH_RISK_PATTERNS) {
    if (!highRiskPatterns.has(pattern)) {
      errors.push(`highRiskPaths must include executable control pattern: ${pattern}`);
    }
  }
  validateStringArray(policy.riskClasses?.agentGovernance, 'riskClasses.agentGovernance', errors);
  const agentGovernancePatterns = new Set(
    Array.isArray(policy.riskClasses?.agentGovernance) ? policy.riskClasses.agentGovernance : [],
  );
  for (const pattern of REQUIRED_AGENT_GOVERNANCE_PATTERNS) {
    if (!highRiskPatterns.has(pattern)) {
      errors.push(`highRiskPaths must include agent-governance pattern: ${pattern}`);
    }
    if (!agentGovernancePatterns.has(pattern)) {
      errors.push(`riskClasses.agentGovernance must include pattern: ${pattern}`);
    }
  }
  validateStringArray(policy.merge?.allowedBranchPrefixes, 'merge.allowedBranchPrefixes', errors);
  validateStringArray(policy.merge?.allowedLabels, 'merge.allowedLabels', errors);
  validateStringArray(policy.merge?.blockedLabels, 'merge.blockedLabels', errors);
  validateStringArray(policy.authorization?.permissions, 'authorization.permissions', errors);
  validateStringArray(
    policy.authorization?.serviceTokenDeniedPermissions,
    'authorization.serviceTokenDeniedPermissions',
    errors,
  );

  if (policy.autonomousGovernance?.checkName !== 'Autonomous review complete') {
    errors.push('autonomousGovernance.checkName must be "Autonomous review complete"');
  }
  if (policy.autonomousGovernance?.evaluator !== AUTONOMOUS_GOVERNANCE_EVALUATOR) {
    errors.push(`autonomousGovernance.evaluator must be "${AUTONOMOUS_GOVERNANCE_EVALUATOR}"`);
  }
  if (policy.autonomousGovernance?.humanApprovalRequired !== false) {
    errors.push('autonomousGovernance.humanApprovalRequired must be false for the selected autonomous policy');
  }
  if (policy.agentLearning?.rolloutTimestamp !== AGENT_LEARNING_ROLLOUT_TIMESTAMP) {
    errors.push(`agentLearning.rolloutTimestamp must be ${AGENT_LEARNING_ROLLOUT_TIMESTAMP}`);
  }
  if (policy.merge?.exactHeadSha !== true) errors.push('merge.exactHeadSha must be true');
  if (policy.merge?.nativeAutoMerge !== true) errors.push('merge.nativeAutoMerge must be true');
  if (policy.merge?.requireUpToDate !== true) errors.push('merge.requireUpToDate must be true');
  if (policy.merge?.allowAdminBypass !== false) errors.push('merge.allowAdminBypass must be false');
  if (policy.merge?.allowForks !== false) errors.push('merge.allowForks must be false');
  if (policy.repair?.maxCommitsPerPullRequest !== 3) {
    errors.push('repair.maxCommitsPerPullRequest must be 3');
  }
  if (policy.repair?.repeatedFingerprintStop !== 2) {
    errors.push('repair.repeatedFingerprintStop must be 2');
  }
  if (policy.repair?.externalReruns !== 1) errors.push('repair.externalReruns must be 1');
  if (policy.deployment?.productionEnabledByDefault !== false) {
    errors.push('deployment.productionEnabledByDefault must be false');
  }
  validateStringArray(policy.deployment?.runtimeNeutralPaths, 'deployment.runtimeNeutralPaths', errors);
  if (
    !Array.isArray(policy.deployment?.runtimeNeutralPaths) ||
    policy.deployment.runtimeNeutralPaths.length !== RUNTIME_NEUTRAL_DEPLOYMENT_PATHS.length ||
    RUNTIME_NEUTRAL_DEPLOYMENT_PATHS.some(
      (expected, index) => policy.deployment.runtimeNeutralPaths[index] !== expected,
    )
  ) {
    errors.push(`deployment.runtimeNeutralPaths must contain exactly: ${RUNTIME_NEUTRAL_DEPLOYMENT_PATHS.join(', ')}`);
  }

  const permissions = new Set(policy.authorization?.permissions ?? []);
  for (const permission of policy.authorization?.serviceTokenDeniedPermissions ?? []) {
    if (!permissions.has(permission)) {
      errors.push(`service-token denied permission is not declared: ${permission}`);
    }
  }

  return errors;
}

export function classifyRisk(paths, policy = loadAutonomousPolicy()) {
  const highRiskPaths = pathsMatchingPatterns(paths, policy.highRiskPaths);
  const classes = Object.fromEntries(
    Object.entries(policy.riskClasses ?? {})
      .map(([name, patterns]) => [name, pathsMatchingPatterns(paths, patterns)])
      .filter(([, matches]) => matches.length > 0),
  );

  return {
    highRisk: highRiskPaths.length > 0,
    highRiskPaths,
    classes,
  };
}

export function classifyDeploymentImpact(files, policy = loadAutonomousPolicy()) {
  return classifyDeploymentImpactWithPatterns(files, policy.deployment.runtimeNeutralPaths);
}

export function isAutomergeCandidate(pullRequest, policy = loadAutonomousPolicy()) {
  if (!isRecord(pullRequest) || pullRequest.draft === true) return false;
  const ref = pullRequest.head?.ref;
  const labels = Array.isArray(pullRequest.labels)
    ? pullRequest.labels.map((label) => (typeof label === 'string' ? label : label?.name)).filter(Boolean)
    : [];

  if (labels.some((label) => policy.merge.blockedLabels.includes(label))) return false;
  return (
    policy.merge.allowedBranchPrefixes.some((prefix) => typeof ref === 'string' && ref.startsWith(prefix)) ||
    labels.some((label) => policy.merge.allowedLabels.includes(label))
  );
}

function validateStringArray(value, name, errors) {
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => !nonEmptyString(entry))) {
    errors.push(`${name} must be a non-empty string array`);
  }
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
