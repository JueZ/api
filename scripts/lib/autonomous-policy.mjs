import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
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
export const PROFILE_NAMES = Object.freeze([
  'documentation-only',
  'api-backend',
  'frontend',
  'contracts-integrations',
  'infrastructure-delivery',
  'privileged',
]);
const REQUIRED_PRIVILEGED_PATTERNS = Object.freeze([
  'AGENTS.md',
  '**/AGENTS.md',
  '.agents/**',
  '.github/autonomous-policy.yml',
  '.github/workflows/**',
  '.github/actions/**',
  'package.json',
  'package-lock.json',
  'apps/api/package.json',
  'apps/api/package-lock.json',
  'scripts/**',
  'infra/**',
  'apps/api/src/shared/security/**',
  'apps/api/src/shared/config/**',
  'apps/api/src/application/authorization/**',
  'apps/api/src/application/auditing/**',
  'apps/api/src/application/idempotency/**',
]);
const REQUIRED_WORKFLOW_INVARIANTS = Object.freeze([
  'actionsPinnedToFullSha',
  'explicitPermissions',
  'forbidPullRequestTarget',
  'forbidSecretsInherit',
  'forbidDynamicSecrets',
  'forbidAlternateGitHubTokens',
  'forbidUntrustedCodeWithWriteCredentials',
  'forbidCheckRunWriters',
]);

export function loadAutonomousPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const policy = parse(readFileSync(policyPath, 'utf8'));
  const errors = validateAutonomousPolicy(policy);
  if (errors.length > 0) throw new Error(`Invalid autonomous policy:\n- ${errors.join('\n- ')}`);
  return policy;
}

export function validateAutonomousPolicy(policy) {
  const errors = [];
  if (!isRecord(policy)) return ['policy must be an object'];
  if (policy.version !== 2) errors.push('version must be 2');

  if (!Array.isArray(policy.requiredChecks)) {
    errors.push('requiredChecks must be an array');
  } else if (
    policy.requiredChecks.length !== STABLE_REQUIRED_CHECKS.length ||
    STABLE_REQUIRED_CHECKS.some(
      (expected, index) =>
        policy.requiredChecks[index]?.name !== expected.name ||
        policy.requiredChecks[index]?.appSlug !== expected.appSlug,
    )
  ) {
    errors.push(`requiredChecks must contain exactly: ${STABLE_REQUIRED_CHECKS.map(({ name }) => name).join(', ')}`);
  }

  if (!isRecord(policy.profiles)) {
    errors.push('profiles must be a mapping');
  } else {
    const actual = Object.keys(policy.profiles);
    if (actual.length !== PROFILE_NAMES.length || PROFILE_NAMES.some((name, index) => actual[index] !== name)) {
      errors.push(`profiles must contain exactly: ${PROFILE_NAMES.join(', ')}`);
    }
    for (const name of PROFILE_NAMES) validateStringArray(policy.profiles[name], `profiles.${name}`, errors);
  }

  const privileged = new Set(policy.profiles?.privileged ?? []);
  for (const pattern of REQUIRED_PRIVILEGED_PATTERNS) {
    if (!privileged.has(pattern)) errors.push(`profiles.privileged must include ${pattern}`);
  }

  validateStringArray(policy.merge?.allowedBranchPrefixes, 'merge.allowedBranchPrefixes', errors);
  validateStringArray(policy.merge?.blockedLabels, 'merge.blockedLabels', errors);
  if (policy.merge?.method !== 'squash') errors.push('merge.method must be squash');
  if (policy.merge?.nativeAutoMerge !== true) errors.push('merge.nativeAutoMerge must be true');
  if (policy.merge?.exactHeadSha !== true) errors.push('merge.exactHeadSha must be true');
  if (policy.merge?.requireUpToDate !== true) errors.push('merge.requireUpToDate must be true');
  if (policy.merge?.deleteHeadBranch !== true) errors.push('merge.deleteHeadBranch must be true');
  if (policy.merge?.allowAdminBypass !== false) errors.push('merge.allowAdminBypass must be false');
  if (policy.merge?.allowForks !== false) errors.push('merge.allowForks must be false');

  if (policy.repair?.maxAttemptsPerStrategy !== 2) errors.push('repair.maxAttemptsPerStrategy must be 2');
  if (policy.repair?.maxAttemptsPerRepairGeneration !== 3) {
    errors.push('repair.maxAttemptsPerRepairGeneration must be 3');
  }
  if (policy.repair?.externalRerunsPerFailure !== 1) {
    errors.push('repair.externalRerunsPerFailure must be 1');
  }

  if (policy.deployment?.controllerWorkflow !== 'delivery-v2.yml') {
    errors.push('deployment.controllerWorkflow must be delivery-v2.yml');
  }
  if (policy.deployment?.enableVariable !== 'DELIVERY_V2_ENABLED') {
    errors.push('deployment.enableVariable must be DELIVERY_V2_ENABLED');
  }
  if (policy.deployment?.productionConcurrencyGroup !== 'production-deployment') {
    errors.push('deployment.productionConcurrencyGroup must be production-deployment');
  }
  if (policy.deployment?.buildOnce !== true) errors.push('deployment.buildOnce must be true');
  if (policy.deployment?.requireExactArtifactDigest !== true) {
    errors.push('deployment.requireExactArtifactDigest must be true');
  }
  validateStringArray(policy.deployment?.impactPaths, 'deployment.impactPaths', errors);
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

  if (!isRecord(policy.workflowSecurity)) {
    errors.push('workflowSecurity must be a mapping');
  } else {
    for (const invariant of REQUIRED_WORKFLOW_INVARIANTS) {
      if (policy.workflowSecurity[invariant] !== true) errors.push(`workflowSecurity.${invariant} must be true`);
    }
  }

  validateStringArray(policy.authorization?.permissions, 'authorization.permissions', errors);
  validateStringArray(policy.authorization?.destructivePermissions, 'authorization.destructivePermissions', errors);
  validateStringArray(
    policy.authorization?.serviceTokenDeniedPermissions,
    'authorization.serviceTokenDeniedPermissions',
    errors,
  );
  const permissions = new Set(policy.authorization?.permissions ?? []);
  for (const permission of [
    ...(policy.authorization?.destructivePermissions ?? []),
    ...(policy.authorization?.serviceTokenDeniedPermissions ?? []),
  ]) {
    if (!permissions.has(permission)) errors.push(`authorization references undeclared permission: ${permission}`);
  }

  return errors;
}

export function classifyRisk(paths, policy = loadAutonomousPolicy()) {
  const privilegedPaths = pathsMatchingPatterns(paths, policy.profiles.privileged);
  const profiles = Object.fromEntries(
    Object.entries(policy.profiles)
      .map(([name, patterns]) => [name, pathsMatchingPatterns(paths, patterns)])
      .filter(([, matches]) => matches.length > 0),
  );
  return { privileged: privilegedPaths.length > 0, privilegedPaths, profiles };
}

export function classifyDeploymentImpact(files, policy = loadAutonomousPolicy()) {
  return classifyDeploymentImpactWithPatterns(files, policy.deployment.runtimeNeutralPaths);
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
