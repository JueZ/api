#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forbiddenNpmControlPaths } from './check-lockfile-policy.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sensitiveIgnoreProbes = [
  '.codex/environments/environment.toml',
  '.azure/accessTokens.json',
  '.env',
  '.env.local',
  'local.settings.json',
  'apps/api/local.settings.json',
];
const strongSecretSignatures = [
  { id: 'private-key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { id: 'github-token', pattern: /\bgh(?:p|o|u|s|r)_[A-Za-z0-9_]{20,}\b/ },
  { id: 'openai-key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
];

export function repositoryHygieneFindings({
  trackedFiles = [],
  ignoredPaths = new Set(),
  presentFiles = trackedFiles,
} = {}) {
  const findings = [];
  for (const path of trackedFiles) {
    if (isSensitiveRepositoryPath(path)) findings.push(`sensitive local path is tracked: ${path}`);
  }
  for (const path of sensitiveIgnoreProbes) {
    if (!ignoredPaths.has(path)) findings.push(`sensitive local path is not ignored: ${path}`);
  }
  const present = presentFiles instanceof Set ? presentFiles : new Set(presentFiles);
  for (const path of forbiddenNpmControlPaths) {
    if (present.has(path)) findings.push(`forbidden npm install override is present: ${path}`);
  }
  return findings;
}

export function stagedSecretFindings(diff) {
  const added = String(diff)
    .split(/\r?\n/)
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .join('\n');
  return strongSecretSignatures
    .filter(({ pattern }) => pattern.test(added))
    .map(({ id }) => `staged changes contain a ${id} signature`);
}

export function isSensitiveRepositoryPath(path) {
  const normalized = String(path).replaceAll('\\', '/');
  if (normalized === '.env.example' || normalized.endsWith('/.env.example')) return false;
  return (
    normalized.startsWith('.codex/') ||
    normalized.startsWith('.azure/') ||
    /(^|\/)\.env(?:\.|$)/.test(normalized) ||
    /(^|\/)local\.settings\.json$/i.test(normalized)
  );
}

function git(args, { allowFailure = false } = {}) {
  const completed = spawnSync('git', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  if (!allowFailure && completed.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${completed.stderr.trim()}`);
  }
  return completed;
}

function ignoredProbePaths() {
  return new Set(
    sensitiveIgnoreProbes.filter(
      (path) => git(['check-ignore', '--no-index', '--quiet', '--', path], { allowFailure: true }).status === 0,
    ),
  );
}

function localPermissionFindings() {
  if (process.platform === 'win32') return [];
  const findings = [];
  for (const path of sensitiveIgnoreProbes) {
    const absolutePath = resolve(repositoryRoot, path);
    if (!existsSync(absolutePath)) continue;
    const permissions = statSync(absolutePath).mode & 0o777;
    if ((permissions & 0o077) !== 0) findings.push(`${path} must not be readable or writable by group/other users`);
  }
  return findings;
}

function untrackedTextDiff() {
  const paths = git(['ls-files', '--others', '--exclude-standard', '--']).stdout.split(/\r?\n/).filter(Boolean);
  return paths
    .filter((path) => !['package-lock.json', 'apps/api/package-lock.json'].includes(path))
    .flatMap((path) => {
      const absolutePath = resolve(repositoryRoot, path);
      if (!existsSync(absolutePath) || !statSync(absolutePath).isFile() || statSync(absolutePath).size > 1024 * 1024) {
        return [];
      }
      const content = readFileSync(absolutePath);
      if (content.includes(0)) return [];
      return content
        .toString('utf8')
        .split(/\r?\n/)
        .map((line) => `+${line}`);
    })
    .join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const trackedFiles = git(['ls-files', '--']).stdout.split(/\r?\n/).filter(Boolean);
  const presentForbiddenNpmControls = forbiddenNpmControlPaths.filter((path) =>
    existsSync(resolve(repositoryRoot, path)),
  );
  const stagedDiff = git([
    'diff',
    '--cached',
    '--no-ext-diff',
    '--unified=0',
    '--',
    '.',
    ':(exclude)package-lock.json',
    ':(exclude)apps/api/package-lock.json',
  ]).stdout;
  const worktreeDiff = git([
    'diff',
    '--no-ext-diff',
    '--unified=0',
    '--',
    '.',
    ':(exclude)package-lock.json',
    ':(exclude)apps/api/package-lock.json',
  ]).stdout;
  const findings = [
    ...repositoryHygieneFindings({
      trackedFiles,
      ignoredPaths: ignoredProbePaths(),
      presentFiles: [...trackedFiles, ...presentForbiddenNpmControls],
    }),
    ...stagedSecretFindings(`${stagedDiff}\n${worktreeDiff}\n${untrackedTextDiff()}`),
    ...localPermissionFindings(),
  ];
  if (findings.length > 0) {
    console.error(`Repository hygiene check failed:\n- ${findings.join('\n- ')}`);
    process.exit(1);
  }
  console.log(
    'Repository hygiene check passed (tracked paths, ignore rules, changed-file signatures, and local permissions).',
  );
}
