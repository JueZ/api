import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

export const DEFAULT_POLICY_PATH = fileURLToPath(new URL('../../.github/autonomous-policy.yml', import.meta.url));
export const REQUIRED_AUTONOMOUS_EXCLUSIONS = [
  '.github/autonomous-policy.yml',
  '.github/security-deployment-hold.json',
  '.github/workflows/**',
  '.github/actions/**',
  'package.json',
  'package-lock.json',
  '.npmrc',
  'npm-shrinkwrap.json',
  'apps/api/.npmrc',
  'apps/api/npm-shrinkwrap.json',
  'scripts/autonomous-merge-controller.mjs',
  'scripts/lib/autonomous-policy.mjs',
  'scripts/lib/smoke-utils.mjs',
  'scripts/render-branch-protection.mjs',
  'scripts/assert-current-main.mjs',
  'scripts/enforce-security-deployment-hold.mjs',
  'scripts/assert-current-security-controller.mjs',
  'scripts/verify-github-deployment-controls.mjs',
  'scripts/build-release-artifacts.sh',
  'scripts/verify-release-artifacts.mjs',
  'scripts/frontend-inventory.mjs',
  'scripts/validate-deployed-runtime-settings.mjs',
  'scripts/mint-smoke-token.mjs',
  'scripts/smoke-runtime.mjs',
  'scripts/smoke-auth.mjs',
  'scripts/check-telemetry.mjs',
  'scripts/write-release-ledger.mjs',
  'scripts/validate-release-ledger.mjs',
  'ops/release-ledger/**',
];

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

  const trustedCheckApps = isRecord(policy.trustedCheckApps) ? policy.trustedCheckApps : null;
  if (!trustedCheckApps || Object.keys(trustedCheckApps).length === 0) {
    errors.push('trustedCheckApps must map app slugs to positive integer GitHub App IDs');
  } else {
    const appIds = new Set();
    for (const [slug, appId] of Object.entries(trustedCheckApps)) {
      if (!nonEmptyString(slug) || !Number.isSafeInteger(appId) || appId < 1) {
        errors.push(`trustedCheckApps.${slug || '<empty>'} must be a positive integer GitHub App ID`);
      } else if (appIds.has(appId)) {
        errors.push(`trustedCheckApps contains duplicate GitHub App ID: ${appId}`);
      }
      appIds.add(appId);
    }
  }

  const trustedCheckSources = isRecord(policy.trustedCheckSources) ? policy.trustedCheckSources : null;
  if (!trustedCheckSources || Object.keys(trustedCheckSources).length === 0) {
    errors.push('trustedCheckSources must define trusted Actions workflows and the controller check');
  } else {
    const workflowIds = new Set();
    const workflowPaths = new Set();
    let controllerSources = 0;
    for (const [name, source] of Object.entries(trustedCheckSources)) {
      if (!nonEmptyString(name) || !isRecord(source)) {
        errors.push(`trustedCheckSources.${name || '<empty>'} must be an object`);
        continue;
      }
      if (source.kind === 'controller') {
        controllerSources += 1;
        if (Object.keys(source).some((key) => key !== 'kind')) {
          errors.push(`controller check source ${name} may contain only kind`);
        }
        continue;
      }
      if (source.kind !== 'actions') {
        errors.push(`trusted check source ${name} must use kind actions or controller`);
        continue;
      }
      if (!Number.isSafeInteger(source.workflowId) || source.workflowId < 1) {
        errors.push(`trusted check source ${name} must pin a positive workflowId`);
      } else if (workflowIds.has(source.workflowId)) {
        errors.push(`trusted check source workflowId is duplicated: ${source.workflowId}`);
      }
      if (!/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(source.workflowPath ?? '')) {
        errors.push(`trusted check source ${name} must pin a repository workflowPath`);
      } else if (workflowPaths.has(source.workflowPath)) {
        errors.push(`trusted check source workflowPath is duplicated: ${source.workflowPath}`);
      }
      if (source.event !== 'pull_request') {
        errors.push(`trusted check source ${name} event must be pull_request`);
      }
      if (source.runAttempt !== 1) {
        errors.push(`trusted check source ${name} runAttempt must be 1`);
      }
      const allowedFields = new Set(['kind', 'workflowId', 'workflowPath', 'event', 'runAttempt']);
      if (Object.keys(source).some((key) => !allowedFields.has(key))) {
        errors.push(`trusted check source ${name} contains unsupported fields`);
      }
      workflowIds.add(source.workflowId);
      workflowPaths.add(source.workflowPath);
    }
    if (controllerSources !== 1) errors.push('trustedCheckSources must contain exactly one controller source');
  }

  if (!Array.isArray(policy.requiredChecks) || policy.requiredChecks.length === 0) {
    errors.push('requiredChecks must be a non-empty array');
  } else {
    const names = new Set();
    for (const [index, check] of policy.requiredChecks.entries()) {
      if (
        !isRecord(check) ||
        !nonEmptyString(check.name) ||
        !nonEmptyString(check.appSlug) ||
        !nonEmptyString(check.source)
      ) {
        errors.push(`requiredChecks[${index}] must contain non-empty name, appSlug, and source`);
        continue;
      }
      if (names.has(check.name)) errors.push(`required check name is duplicated: ${check.name}`);
      if (!trustedCheckApps || !Object.hasOwn(trustedCheckApps, check.appSlug)) {
        errors.push(`required check ${check.name} references unknown trusted app ${check.appSlug}`);
      }
      if (!trustedCheckSources || !Object.hasOwn(trustedCheckSources, check.source)) {
        errors.push(`required check ${check.name} references unknown trusted source ${check.source}`);
      }
      if (Object.keys(check).some((key) => !['name', 'appSlug', 'source'].includes(key))) {
        errors.push(`required check ${check.name} contains unsupported fields`);
      }
      names.add(check.name);
    }
    if (trustedCheckApps) {
      const usedAppSlugs = new Set(policy.requiredChecks.map((check) => check?.appSlug).filter(nonEmptyString));
      for (const slug of Object.keys(trustedCheckApps)) {
        if (!usedAppSlugs.has(slug)) errors.push(`trusted check app is unused: ${slug}`);
      }
    }
    if (trustedCheckSources) {
      const usedSources = new Set(policy.requiredChecks.map((check) => check?.source).filter(nonEmptyString));
      for (const name of Object.keys(trustedCheckSources)) {
        if (!usedSources.has(name)) errors.push(`trusted check source is unused: ${name}`);
      }
      for (const check of policy.requiredChecks) {
        const source = trustedCheckSources[check?.source];
        if (source?.kind === 'controller' && check?.name !== policy.autonomousReview?.checkName) {
          errors.push(`controller source may only provide ${policy.autonomousReview?.checkName}`);
        }
        if (check?.name === policy.autonomousReview?.checkName && source?.kind !== 'controller') {
          errors.push(`${policy.autonomousReview?.checkName} must use the controller source`);
        }
      }
    }
  }

  validateStringArray(policy.highRiskPaths, 'highRiskPaths', errors);
  validateStringArray(policy.merge?.allowedBranchPrefixes, 'merge.allowedBranchPrefixes', errors);
  validateStringArray(policy.merge?.allowedLabels, 'merge.allowedLabels', errors);
  validateStringArray(policy.merge?.blockedLabels, 'merge.blockedLabels', errors);
  validateStringArray(policy.merge?.autonomousExcludedPaths, 'merge.autonomousExcludedPaths', errors);
  validateStringArray(policy.authorization?.permissions, 'authorization.permissions', errors);
  validateStringArray(
    policy.authorization?.serviceTokenDeniedPermissions,
    'authorization.serviceTokenDeniedPermissions',
    errors,
  );

  if (policy.autonomousReview?.checkName !== 'Autonomous review complete') {
    errors.push('autonomousReview.checkName must be "Autonomous review complete"');
  }
  if (!nonEmptyString(policy.autonomousReview?.model)) {
    errors.push('autonomousReview.model must be configured');
  }
  if (
    !Number.isInteger(policy.autonomousReview?.maxDiffBytes) ||
    policy.autonomousReview.maxDiffBytes < 1 ||
    policy.autonomousReview.maxDiffBytes > 2_000_000
  ) {
    errors.push('autonomousReview.maxDiffBytes must be an integer from 1 to 2000000');
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
  if (Array.isArray(policy.merge?.autonomousExcludedPaths)) {
    for (const requiredPath of REQUIRED_AUTONOMOUS_EXCLUSIONS) {
      if (!policy.merge.autonomousExcludedPaths.includes(requiredPath)) {
        errors.push(`merge.autonomousExcludedPaths must include ${requiredPath}`);
      }
    }
  }
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
