#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function inspectDependencyFiles(packageJson, lockfile) {
  const findings = [];
  if (lockfile.lockfileVersion !== 3) {
    findings.push('package-lock.json must use lockfileVersion 3');
  }
  for (const lifecycle of ['preinstall', 'install', 'postinstall']) {
    if (packageJson.scripts?.[lifecycle]) {
      findings.push(`root lifecycle script ${lifecycle} is not allowed`);
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
    const changed = new Set(changedFiles(baseRef));
    if (changed.has('package.json') !== changed.has('package-lock.json')) {
      console.error('package.json and package-lock.json must change together.');
      process.exit(1);
    }
  }
  const packageJson = JSON.parse(readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8'));
  const lockfile = JSON.parse(readFileSync(resolve(repositoryRoot, 'package-lock.json'), 'utf8'));
  const findings = inspectDependencyFiles(packageJson, lockfile);
  if (findings.length) {
    console.error(`Dependency lock policy failed:\n- ${findings.join('\n- ')}`);
    process.exit(1);
  }
  console.log('Dependency lock policy passed.');
}
