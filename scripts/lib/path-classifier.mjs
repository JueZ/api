const FILE_STATUSES = new Set(['added', 'changed', 'copied', 'modified', 'removed', 'renamed', 'unchanged']);

export const VALIDATION_FLAGS = Object.freeze([
  'documentation',
  'backend',
  'frontend',
  'contracts',
  'infrastructure',
  'workflow',
  'dependencies',
  'learning',
  'privileged',
  'codeqlJavascript',
  'codeqlActions',
  'trivy',
]);

export function classifyChangedFiles(files) {
  if (!Array.isArray(files) || files.length === 0) {
    return broadFallback('missing-changed-files');
  }

  const paths = [];
  for (const file of files) {
    if (!isRecord(file) || !FILE_STATUSES.has(file.status)) {
      return broadFallback('invalid-changed-file-metadata');
    }
    const filename = strictRepositoryPath(file.filename);
    if (!filename) return broadFallback('invalid-changed-file-path');
    paths.push(filename);

    if (file.status === 'renamed' || file.status === 'copied') {
      const previousFilename = strictRepositoryPath(file.previous_filename);
      if (!previousFilename) return broadFallback('invalid-previous-file-path');
      paths.push(previousFilename);
    } else if (file.previous_filename !== undefined) {
      return broadFallback('unexpected-previous-file-path');
    }
  }

  if (new Set(paths).size !== paths.length) return broadFallback('duplicate-changed-file-path');

  const flags = emptyFlags();
  const profiles = new Set();
  const unknownPaths = [];
  for (const path of paths) {
    const matched = classifyPath(path, flags, profiles);
    if (!matched) unknownPaths.push(path);
  }

  if (unknownPaths.length > 0) {
    applyPrivileged(flags, profiles);
  }
  deriveSecurityFlags(flags);

  return {
    valid: true,
    mode: unknownPaths.length > 0 ? 'broad-fallback' : 'classified',
    reason: unknownPaths.length > 0 ? 'unknown-paths' : 'changed-paths-classified',
    profiles: orderedProfiles(profiles),
    flags,
    fileCount: files.length,
    pathCount: paths.length,
    unknownPathCount: unknownPaths.length,
  };
}

export function fullValidation(reason = 'explicit-full-validation') {
  const result = broadFallback(reason);
  return { ...result, valid: true };
}

export function parseGitNameStatus(buffer) {
  const values = String(buffer).split('\0');
  if (values.at(-1) === '') values.pop();
  const files = [];
  for (let index = 0; index < values.length;) {
    const rawStatus = values[index++];
    const status = gitStatus(rawStatus);
    const filename = values[index++];
    if (!status || filename === undefined) return null;
    if (status === 'renamed' || status === 'copied') {
      const destination = values[index++];
      if (destination === undefined) return null;
      files.push({ filename: destination, previous_filename: filename, status });
    } else {
      files.push({ filename, status });
    }
  }
  return files;
}

function classifyPath(path, flags, profiles) {
  if (isLearningPath(path)) {
    flags.learning = true;
    profiles.add('learning-governance');
    if (path.startsWith('scripts/agent-learning/')) {
      applyPrivileged(flags, profiles);
    } else {
      flags.documentation = true;
    }
    return true;
  }
  if (isPrivilegedPath(path)) {
    applyPrivileged(flags, profiles);
    if (isWorkflowPath(path)) flags.workflow = true;
    if (isDependencyPath(path)) flags.dependencies = true;
    if (isBackendPath(path)) flags.backend = true;
    if (isFrontendPath(path)) flags.frontend = true;
    return true;
  }
  if (isDocumentationPath(path)) {
    flags.documentation = true;
    profiles.add('documentation-only');
    return true;
  }
  if (isBackendPath(path)) {
    flags.backend = true;
    profiles.add('api-backend');
    return true;
  }
  if (isFrontendPath(path)) {
    flags.frontend = true;
    profiles.add('frontend');
    return true;
  }
  if (path.startsWith('contracts/')) {
    flags.contracts = true;
    profiles.add('contracts-integrations');
    return true;
  }
  if (path.startsWith('infra/') || path === 'bicepconfig.json') {
    flags.infrastructure = true;
    profiles.add('infrastructure-delivery');
    return true;
  }
  if (isWorkflowPath(path)) {
    flags.workflow = true;
    profiles.add('infrastructure-delivery');
    return true;
  }
  return false;
}

function isPrivilegedPath(path) {
  return (
    path === 'AGENTS.md' ||
    path.endsWith('/AGENTS.md') ||
    path === 'SECURITY.md' ||
    path.startsWith('.agents/') ||
    path.startsWith('.github/workflows/') ||
    path.startsWith('.github/actions/') ||
    path === '.github/autonomous-policy.yml' ||
    path === '.github/dependabot.yml' ||
    path.startsWith('apps/api/src/shared/security/') ||
    path.startsWith('apps/api/src/shared/config/') ||
    path.startsWith('docs/security/') ||
    path.startsWith('docs/cost/') ||
    path.startsWith('evals/agent-tasks/') ||
    path.startsWith('scripts/') ||
    isDependencyPath(path) ||
    ['angular.json', 'eslint.config.js', 'tsconfig.json', '.prettierignore', '.prettierrc.json'].includes(path)
  );
}

function isDocumentationPath(path) {
  return path === 'README.md' || path.startsWith('docs/') || /^\.github\/.*\.md$/i.test(path);
}

function isLearningPath(path) {
  return path.startsWith('docs/agent-learning/') || path.startsWith('scripts/agent-learning/');
}

function isBackendPath(path) {
  return path.startsWith('apps/api/');
}

function isFrontendPath(path) {
  return path.startsWith('apps/web/');
}

function isWorkflowPath(path) {
  return path.startsWith('.github/workflows/') || path.startsWith('.github/actions/') || path.endsWith('.sh');
}

function isDependencyPath(path) {
  return path === 'package.json' || path === 'package-lock.json' || path === '.github/dependabot.yml';
}

function applyPrivileged(flags, profiles) {
  flags.backend = true;
  flags.frontend = true;
  flags.contracts = true;
  flags.infrastructure = true;
  flags.workflow = true;
  flags.dependencies = true;
  flags.privileged = true;
  profiles.add('privileged');
}

function deriveSecurityFlags(flags) {
  flags.codeqlJavascript = flags.backend || flags.frontend || flags.contracts || flags.dependencies || flags.privileged;
  flags.codeqlActions = flags.workflow || flags.privileged;
  flags.trivy = flags.backend || flags.frontend || flags.infrastructure || flags.dependencies || flags.privileged;
}

function broadFallback(reason) {
  const flags = emptyFlags();
  const profiles = new Set();
  applyPrivileged(flags, profiles);
  deriveSecurityFlags(flags);
  return {
    valid: false,
    mode: 'broad-fallback',
    reason,
    profiles: orderedProfiles(profiles),
    flags,
    fileCount: 0,
    pathCount: 0,
    unknownPathCount: 0,
  };
}

function emptyFlags() {
  return Object.fromEntries(VALIDATION_FLAGS.map((flag) => [flag, false]));
}

function orderedProfiles(profiles) {
  const order = [
    'documentation-only',
    'api-backend',
    'frontend',
    'contracts-integrations',
    'infrastructure-delivery',
    'learning-governance',
    'privileged',
  ];
  return order.filter((profile) => profiles.has(profile));
}

function gitStatus(rawStatus) {
  if (rawStatus === 'A') return 'added';
  if (rawStatus === 'M' || rawStatus === 'T') return 'modified';
  if (rawStatus === 'D') return 'removed';
  if (/^R\d{1,3}$/.test(rawStatus)) return 'renamed';
  if (/^C\d{1,3}$/.test(rawStatus)) return 'copied';
  return '';
}

function strictRepositoryPath(path) {
  if (
    typeof path !== 'string' ||
    path.length === 0 ||
    path !== path.trim() ||
    path.includes('\\') ||
    [...path].some((character) => character.codePointAt(0) <= 31 || character.codePointAt(0) === 127)
  ) {
    return '';
  }
  if (path.startsWith('/') || path.startsWith('./') || /^[A-Za-z]:/.test(path)) return '';
  const segments = path.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) return '';
  return path;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
