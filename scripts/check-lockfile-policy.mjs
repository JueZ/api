#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const dependencyFilePairs = [
  { packagePath: 'package.json', lockfilePath: 'package-lock.json' },
  { packagePath: 'apps/api/package.json', lockfilePath: 'apps/api/package-lock.json' },
];

export function dependencyPairingFindings(changedPaths, pairs = dependencyFilePairs) {
  const changed = changedPaths instanceof Set ? changedPaths : new Set(changedPaths);
  return pairs
    .filter(({ packagePath, lockfilePath }) => changed.has(packagePath) !== changed.has(lockfilePath))
    .map(({ packagePath, lockfilePath }) => `${packagePath} and ${lockfilePath} must change together`);
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

if (import.meta.url === `file://${process.argv[1]}`) {
  const baseRef = process.env.BASE_REF || process.argv[2];
  if (baseRef) {
    const pairingFindings = dependencyPairingFindings(changedFiles(baseRef));
    if (pairingFindings.length > 0) {
      console.error(`Dependency package/lock pairing failed:\n- ${pairingFindings.join('\n- ')}`);
      process.exit(1);
    }
  }
  const findings = dependencyFilePairs.flatMap(({ packagePath, lockfilePath }) => {
    const packageJson = JSON.parse(readFileSync(resolve(repositoryRoot, packagePath), 'utf8'));
    const lockfile = JSON.parse(readFileSync(resolve(repositoryRoot, lockfilePath), 'utf8'));
    return inspectDependencyFiles(packageJson, lockfile, packagePath);
  });
  if (findings.length) {
    console.error(`Dependency lock policy failed:\n- ${findings.join('\n- ')}`);
    process.exit(1);
  }
  console.log('Dependency lock policy passed.');
}
