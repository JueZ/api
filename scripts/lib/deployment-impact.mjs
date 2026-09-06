export const RUNTIME_NEUTRAL_DEPLOYMENT_PATHS = Object.freeze([
  '*.md',
  'docs/**',
  '.github/**/*.md',
  '.agents/skills/**/*.md',
  'scripts/agent-learning/**',
  'scripts/test/agent-learning-*.test.mjs',
]);

const GITHUB_FILE_STATUSES = new Set(['added', 'changed', 'copied', 'modified', 'removed', 'renamed', 'unchanged']);

export function matchesPolicyGlob(path, pattern) {
  return globToRegExp(pattern).test(normalizePath(path));
}

export function pathsMatchingPatterns(paths, patterns) {
  return paths.filter((path) => patterns.some((pattern) => matchesPolicyGlob(path, pattern)));
}

export function classifyDeploymentImpact(files, runtimeNeutralPaths = RUNTIME_NEUTRAL_DEPLOYMENT_PATHS) {
  return classifyPaths(files, runtimeNeutralPaths, false);
}

export function classifyCumulativeDeploymentImpact(files, runtimeNeutralPaths = RUNTIME_NEUTRAL_DEPLOYMENT_PATHS) {
  return classifyPaths(files, runtimeNeutralPaths, true);
}

function classifyPaths(files, runtimeNeutralPaths, allowEmpty) {
  if (!Array.isArray(files) || files.length === 0) {
    if (allowEmpty && Array.isArray(files)) {
      return deploymentImpactResult({ valid: true, reason: 'no-change-since-accepted' });
    }
    return deploymentImpactResult({ valid: false, reason: 'missing-changed-files' });
  }
  if (!validPatterns(runtimeNeutralPaths)) {
    return deploymentImpactResult({ valid: false, reason: 'invalid-runtime-neutral-policy' });
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

  const impactPaths = paths.filter((path) => !runtimeNeutralPaths.some((pattern) => matchesPolicyGlob(path, pattern)));
  return deploymentImpactResult({
    valid: true,
    reason: impactPaths.length === 0 ? 'runtime-neutral-only' : 'deployment-impacting-paths',
    fileCount: files.length,
    pathCount: paths.length,
    impactPathCount: impactPaths.length,
  });
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

function validPatterns(patterns) {
  return Array.isArray(patterns) && patterns.length > 0 && patterns.every((pattern) => typeof pattern === 'string');
}

function escapeRegExp(value) {
  return value.replace(/[|\\{}()[\]^$+?.-]/g, '\\$&');
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
