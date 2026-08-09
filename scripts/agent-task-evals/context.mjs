import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { CONTEXT_VARIANTS, REPOSITORY_ROOT } from './definitions.mjs';

const GUIDANCE_PATHS = Object.freeze([
  'docs/autonomous-delivery.md',
  'docs/security/autonomous-guardrails.md',
  'docs/agent-learning/README.md',
]);
const MAX_CONTEXT_BYTES = 4 * 1024 * 1024;

function git(root, args, options = {}) {
  const result = spawnSync(
    'git',
    ['-c', 'core.filemode=false', '-c', 'core.autocrlf=false', '-c', 'core.eol=lf', '-C', root, ...args],
    {
      encoding: 'utf8',
      maxBuffer: 5 * 1024 * 1024,
      timeout: 20_000,
      ...options,
    },
  );
  if (result.status !== 0) throw new Error(`git ${args[0]} failed while preparing evaluation context`);
  return result.stdout;
}

function isInside(root, candidate) {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..');
}

function trackedContextPaths(controllerRoot, includeSkills) {
  const tracked = git(controllerRoot, ['ls-files', '-z']).split('\0').filter(Boolean);
  const agents = tracked.filter((path) => path === 'AGENTS.md' || path.endsWith('/AGENTS.md'));
  const skills = includeSkills ? tracked.filter((path) => path.startsWith('.agents/skills/')) : [];
  const selected = [...new Set([...agents, ...GUIDANCE_PATHS, ...skills])].sort();
  for (const required of [...agents, ...GUIDANCE_PATHS]) {
    if (!tracked.includes(required)) throw new Error(`reviewed context path is not tracked: ${required}`);
  }
  return selected;
}

export function contextPathsForVariant(variant, controllerRoot = REPOSITORY_ROOT) {
  if (!CONTEXT_VARIANTS.includes(variant)) throw new Error(`Unsupported context variant: ${variant}`);
  if (variant === 'historical') return [];
  return trackedContextPaths(controllerRoot, variant === 'current-agent-context');
}

export function overlayCurrentContext({ variant, controllerRoot = REPOSITORY_ROOT, worktreePath }) {
  const controller = resolve(controllerRoot);
  const worktree = resolve(worktreePath);
  if (controller === worktree || isInside(controller, worktree) || isInside(worktree, controller)) {
    throw new Error('evaluation context must not be overlaid in or around the primary checkout');
  }
  const paths = contextPathsForVariant(variant, controller);
  if (variant === 'historical') return { paths, digest: null };

  const historicalSkills = join(worktree, '.agents/skills');
  if (lstatExists(historicalSkills)) rmSync(historicalSkills, { recursive: true, force: true });

  let totalBytes = 0;
  const hash = createHash('sha256');
  for (const path of paths) {
    const source = join(controller, path);
    const destination = join(worktree, path);
    if (!isInside(controller, source) || !isInside(worktree, destination))
      throw new Error('context path escaped a checkout');
    const stat = lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`context path is not a regular file: ${path}`);
    totalBytes += stat.size;
    if (totalBytes > MAX_CONTEXT_BYTES) throw new Error('reviewed context bundle exceeds the 4 MiB limit');
    const content = readFileSync(source);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, content, { mode: 0o644 });
    hash.update(path).update('\0').update(content).update('\0');
  }
  if (variant === 'current-without-skills') hash.update('skills=excluded\0');
  return { paths, digest: hash.digest('hex') };
}

function lstatExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}
