import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

export const DEFAULT_POLICY_PATH = fileURLToPath(new URL('../../.github/autonomous-policy.yml', import.meta.url));
export const STABLE_REQUIRED_CHECKS = Object.freeze([
  Object.freeze({ name: 'CI complete', appSlug: 'github-actions' }),
  Object.freeze({ name: 'Policy complete', appSlug: 'github-actions' }),
  Object.freeze({ name: 'CodeQL complete', appSlug: 'github-actions' }),
  Object.freeze({ name: 'Autonomous review complete', appSlug: 'github-actions' }),
]);
export const RUNTIME_NEUTRAL_DEPLOYMENT_PATHS = Object.freeze([
  '*.md',
  'docs/**',
  '.github/**/*.md',
  '.agents/skills/**/*.md',
  'evals/agent-tasks/**',
  'scripts/agent-learning/**',
  'scripts/agent-task-evals/**',
  'scripts/test/agent-learning-*.test.mjs',
]);
export const AGENT_LEARNING_ROLLOUT_TIMESTAMP = '2026-08-09T20:24:47Z';
const GITHUB_FILE_STATUSES = new Set(['added', 'changed', 'copied', 'modified', 'removed', 'renamed', 'unchanged']);
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
  if (policy.autonomousGovernance?.evaluator !== 'deterministic-protected-controller-v1') {
    errors.push('autonomousGovernance.evaluator must be "deterministic-protected-controller-v1"');
  }
  if (policy.autonomousGovernance?.humanApprovalRequired !== false) {
    errors.push('autonomousGovernance.humanApprovalRequired must be false for the selected autonomous policy');
  }
  if (policy.agentLearning?.rolloutTimestamp !== AGENT_LEARNING_ROLLOUT_TIMESTAMP) {
    errors.push(`agentLearning.rolloutTimestamp must be ${AGENT_LEARNING_ROLLOUT_TIMESTAMP}`);
  }
  if (policy.merge?.exactHeadSha !== true) errors.push('merge.exactHeadSha must be true');
  if (policy.merge?.requireUpToDate !== true) errors.push('merge.requireUpToDate must be true');
  if (policy.merge?.allowAdminBypass !== false) errors.push('merge.allowAdminBypass must be false');
  if (policy.merge?.allowForks !== false) errors.push('merge.allowForks must be false');
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

export function matchesPolicyGlob(path, pattern) {
  const regex = globToRegExp(pattern);
  return regex.test(normalizePath(path));
}

export function pathsMatchingPatterns(paths, patterns) {
  return paths.filter((path) => patterns.some((pattern) => matchesPolicyGlob(path, pattern)));
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
  if (!Array.isArray(files) || files.length === 0) {
    return deploymentImpactResult({ valid: false, reason: 'missing-changed-files' });
  }

  const paths = [];
  for (const file of files) {
    if (!isRecord(file) || !GITHUB_FILE_STATUSES.has(file.status)) {
      return deploymentImpactResult({ valid: false, reason: 'invalid-changed-file-metadata' });
    }
    const filename = strictRepositoryPath(file.filename);
    if (!filename) {
      return deploymentImpactResult({ valid: false, reason: 'invalid-changed-file-path' });
    }
    paths.push(filename);

    if (file.status === 'renamed') {
      const previousFilename = strictRepositoryPath(file.previous_filename);
      if (!previousFilename) {
        return deploymentImpactResult({ valid: false, reason: 'invalid-renamed-file-path' });
      }
      paths.push(previousFilename);
    } else if (file.previous_filename !== undefined) {
      return deploymentImpactResult({ valid: false, reason: 'unexpected-previous-file-path' });
    }
  }

  if (new Set(paths).size !== paths.length) {
    return deploymentImpactResult({ valid: false, reason: 'duplicate-changed-file-path' });
  }

  const impactPaths = paths.filter(
    (path) => !policy.deployment.runtimeNeutralPaths.some((pattern) => matchesPolicyGlob(path, pattern)),
  );
  return deploymentImpactResult({
    valid: true,
    reason: impactPaths.length === 0 ? 'runtime-neutral-only' : 'deployment-impacting-paths',
    fileCount: files.length,
    pathCount: paths.length,
    impactPathCount: impactPaths.length,
  });
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

function globToRegExp(pattern) {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    const next = pattern[index + 1];
    if (character === '*' && next === '*') {
      const followedBySlash = pattern[index + 2] === '/';
      source += followedBySlash ? '(?:.*/)?' : '.*';
      index += followedBySlash ? 2 : 1;
    } else if (character === '*') {
      source += '[^/]*';
    } else if (character === '?') {
      source += '[^/]';
    } else {
      source += escapeRegExp(character);
    }
  }
  return new RegExp(`${source}$`);
}

function normalizePath(path) {
  return String(path).replaceAll('\\', '/').replace(/^\.\//, '');
}

function strictRepositoryPath(path) {
  if (typeof path !== 'string' || path.length === 0 || path !== path.trim() || path.includes('\\')) return '';
  if (path.startsWith('/') || path.startsWith('./') || /^[A-Za-z]:/.test(path)) return '';
  const segments = path.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) return '';
  return path;
}

function deploymentImpactResult({ valid, reason, fileCount = 0, pathCount = 0, impactPathCount = 0 }) {
  return {
    valid,
    deploymentRequired: !valid || impactPathCount > 0,
    reason,
    fileCount,
    pathCount,
    impactPathCount,
  };
}

function escapeRegExp(value) {
  return value.replace(/[|\\{}()[\]^$+?.-]/g, '\\$&');
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
