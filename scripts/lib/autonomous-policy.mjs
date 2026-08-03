import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

export const DEFAULT_POLICY_PATH = fileURLToPath(new URL('../../.github/autonomous-policy.yml', import.meta.url));
export const AUTONOMOUS_REVIEW_MODEL_PRICING = Object.freeze({
  'gpt-5.6-sol': Object.freeze({
    inputUsdPerMillionTokens: 5,
    outputUsdPerMillionTokens: 30,
  }),
});
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
  }

  validateStringArray(policy.highRiskPaths, 'highRiskPaths', errors);
  const highRiskPatterns = new Set(Array.isArray(policy.highRiskPaths) ? policy.highRiskPaths : []);
  for (const pattern of REQUIRED_EXECUTABLE_HIGH_RISK_PATTERNS) {
    if (!highRiskPatterns.has(pattern)) {
      errors.push(`highRiskPaths must include executable control pattern: ${pattern}`);
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

  if (policy.autonomousReview?.checkName !== 'Autonomous review complete') {
    errors.push('autonomousReview.checkName must be "Autonomous review complete"');
  }
  if (!Object.hasOwn(AUTONOMOUS_REVIEW_MODEL_PRICING, policy.autonomousReview?.model)) {
    errors.push('autonomousReview.model must use an approved cost-bounded model');
  }
  if (policy.autonomousReview?.reasoningEffort !== 'medium') {
    errors.push('autonomousReview.reasoningEffort must be medium');
  }
  if (
    !Number.isInteger(policy.autonomousReview?.maxOutputTokens) ||
    policy.autonomousReview.maxOutputTokens < 200 ||
    policy.autonomousReview.maxOutputTokens > 3_500
  ) {
    errors.push('autonomousReview.maxOutputTokens must be an integer from 200 to 3500');
  }
  if (policy.autonomousReview?.requiredForHighRisk !== true) {
    errors.push('autonomousReview.requiredForHighRisk must be true');
  }
  if (policy.autonomousReview?.store !== false) {
    errors.push('autonomousReview.store must be false');
  }
  if (policy.autonomousReview?.humanApprovalRequired !== false) {
    errors.push('autonomousReview.humanApprovalRequired must be false for the selected autonomous policy');
  }
  if (policy.merge?.exactHeadSha !== true) errors.push('merge.exactHeadSha must be true');
  if (policy.merge?.requireUpToDate !== true) errors.push('merge.requireUpToDate must be true');
  if (policy.merge?.allowAdminBypass !== false) errors.push('merge.allowAdminBypass must be false');
  if (policy.merge?.allowForks !== false) errors.push('merge.allowForks must be false');
  if (policy.deployment?.productionEnabledByDefault !== false) {
    errors.push('deployment.productionEnabledByDefault must be false');
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
