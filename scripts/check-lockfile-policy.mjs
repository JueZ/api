#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const dependencyFilePairs = [
  { packagePath: 'package.json', lockfilePath: 'package-lock.json' },
  { packagePath: 'apps/api/package.json', lockfilePath: 'apps/api/package-lock.json' },
];
export const forbiddenNpmControlPaths = [
  '.npmrc',
  'npm-shrinkwrap.json',
  'apps/api/.npmrc',
  'apps/api/npm-shrinkwrap.json',
];

const lockfileRelevantManifestKeys = [
  'name',
  'version',
  'engines',
  'os',
  'cpu',
  'libc',
  'bin',
  'workspaces',
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
  'peerDependenciesMeta',
  'bundleDependencies',
  'bundledDependencies',
  'overrides',
];

export function lockfileRelevantManifest(packageJson) {
  return Object.fromEntries(
    lockfileRelevantManifestKeys.filter((key) => Object.hasOwn(packageJson, key)).map((key) => [key, packageJson[key]]),
  );
}

export function dependencyManifestChangesLockfile(before, after) {
  return !isDeepStrictEqual(lockfileRelevantManifest(before), lockfileRelevantManifest(after));
}

export function dependencyPairingFindings(
  changedPaths,
  pairs = dependencyFilePairs,
  lockfileRelevantChanges = changedPaths,
) {
  const changed = changedPaths instanceof Set ? changedPaths : new Set(changedPaths);
  const relevant = lockfileRelevantChanges instanceof Set ? lockfileRelevantChanges : new Set(lockfileRelevantChanges);
  return pairs
    .filter(({ packagePath, lockfilePath }) => {
      const packageChanged = changed.has(packagePath);
      const lockfileChanged = changed.has(lockfilePath);
      return (lockfileChanged && !packageChanged) || (packageChanged && !lockfileChanged && relevant.has(packagePath));
    })
    .map(({ packagePath, lockfilePath }) => `${packagePath} and ${lockfilePath} must change together`);
}

export function forbiddenNpmControlFindings(paths) {
  const present = paths instanceof Set ? paths : new Set(paths);
  return forbiddenNpmControlPaths
    .filter((path) => present.has(path))
    .map((path) => `${path} is forbidden because it can override the reviewed npm lock/install policy`);
}

export function inspectDependencyFiles(packageJson, lockfile, scope = 'root') {
  const findings = [];
  if (lockfile.lockfileVersion !== 3) {
    findings.push(`${scope} package-lock.json must use lockfileVersion 3`);
  }
  for (const lifecycle of ['preinstall', 'install', 'postinstall']) {
    if (packageJson.scripts?.[lifecycle]) {
      findings.push(`${scope} lifecycle script ${lifecycle} is not allowed`);
    }
  }
  for (const [name, specifier] of Object.entries({
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
    ...packageJson.optionalDependencies,
  })) {
    if (/^(?:git(?:\+|:)|github:|https?:|file:|link:|workspace:)/i.test(specifier)) {
      findings.push(`${name} uses non-registry dependency specifier ${specifier}`);
    }
  }
  for (const [path, entry] of Object.entries(lockfile.packages ?? {})) {
    if (typeof entry.resolved === 'string' && !entry.resolved.startsWith('https://registry.npmjs.org/')) {
      findings.push(`${path || '<root>'} resolves outside the npm registry`);
    }
  }
  const lockfileRoot = lockfile.packages?.[''];
  if (!lockfileRoot || typeof lockfileRoot !== 'object') {
    findings.push(`${scope} package-lock.json is missing its root package entry`);
  } else {
    for (const key of [
      'name',
      'version',
      'engines',
      'bin',
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
      'peerDependenciesMeta',
    ]) {
      if (!isDeepStrictEqual(packageJson[key] ?? null, lockfileRoot[key] ?? null)) {
        findings.push(`${scope} ${key} does not match the package-lock.json root entry`);
      }
    }
  }
  return findings;
}

function changedFiles(baseRef) {
  const completed = spawnSync('git', ['diff', '--name-only', baseRef, 'HEAD'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  if (completed.status !== 0) throw new Error(completed.stderr.trim());
  return completed.stdout.trim().split('\n').filter(Boolean);
}

function readPackageAtRef(reference, packagePath, root = repositoryRoot) {
  const completed = spawnSync('git', ['show', `${reference}:${packagePath}`], {
    cwd: root,
    encoding: 'utf8',
  });
  if (completed.status !== 0) return null;
  return JSON.parse(completed.stdout);
}

export function lockfileRelevantManifestChanges(
  baseRef,
  changedPaths,
  root = repositoryRoot,
  pairs = dependencyFilePairs,
) {
  const changed = new Set(changedPaths);
  return new Set(
    pairs
      .filter(({ packagePath }) => changed.has(packagePath))
      .filter(({ packagePath }) => {
        const before = readPackageAtRef(baseRef, packagePath, root);
        const after = readPackageAtRef('HEAD', packagePath, root);
        if (!before || !after) return true;
        return dependencyManifestChangesLockfile(before, after);
      })
      .map(({ packagePath }) => packagePath),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const baseRef = process.env.BASE_REF || process.argv[2];
  if (baseRef) {
    const changedPaths = changedFiles(baseRef);
    const pairingFindings = dependencyPairingFindings(
      changedPaths,
      dependencyFilePairs,
      lockfileRelevantManifestChanges(baseRef, changedPaths),
    );
    if (pairingFindings.length > 0) {
      console.error(`Dependency package/lock pairing failed:\n- ${pairingFindings.join('\n- ')}`);
      process.exit(1);
    }
  }
  const findings = [
    ...forbiddenNpmControlFindings(
      forbiddenNpmControlPaths.filter((path) => existsSync(resolve(repositoryRoot, path))),
    ),
    ...dependencyFilePairs.flatMap(({ packagePath, lockfilePath }) => {
      const packageJson = JSON.parse(readFileSync(resolve(repositoryRoot, packagePath), 'utf8'));
      const lockfile = JSON.parse(readFileSync(resolve(repositoryRoot, lockfilePath), 'utf8'));
      return inspectDependencyFiles(packageJson, lockfile, packagePath);
    }),
  ];
  if (findings.length) {
    console.error(`Dependency lock policy failed:\n- ${findings.join('\n- ')}`);
    process.exit(1);
  }
  console.log('Dependency lock policy passed.');
}
