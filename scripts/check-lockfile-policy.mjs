#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const DEPENDENCY_PROJECTS = Object.freeze([
  Object.freeze({ packagePath: 'package.json', lockfilePath: 'package-lock.json' }),
  Object.freeze({ packagePath: 'apps/api/package.json', lockfilePath: 'apps/api/package-lock.json' }),
]);

export function inspectDependencyFiles(packageJson, lockfile, project = DEPENDENCY_PROJECTS[0]) {
  const findings = [];
  if (lockfile.lockfileVersion !== 3) {
    findings.push(`${project.lockfilePath} must use lockfileVersion 3`);
  }
  for (const lifecycle of ['preinstall', 'install', 'postinstall']) {
    if (packageJson.scripts?.[lifecycle]) {
      findings.push(`${project.packagePath} lifecycle script ${lifecycle} is not allowed`);
    }
  }
  for (const [name, specifier] of Object.entries({
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
    ...packageJson.optionalDependencies,
  })) {
    if (/^(?:git(?:\+|:)|github:|https?:|file:|link:|workspace:)/i.test(specifier)) {
      findings.push(`${project.packagePath}: ${name} uses non-registry dependency specifier ${specifier}`);
    }
  }
  for (const [path, entry] of Object.entries(lockfile.packages ?? {})) {
    if (typeof entry.resolved === 'string' && !entry.resolved.startsWith('https://registry.npmjs.org/')) {
      findings.push(`${project.lockfilePath}: ${path || '<root>'} resolves outside the npm registry`);
    }
  }
  return findings;
}

export function packageChangeRequiresLockfile(basePackageJson, currentPackageJson) {
  const baseLockRelevant = structuredClone(basePackageJson);
  const currentLockRelevant = structuredClone(currentPackageJson);
  delete baseLockRelevant.scripts;
  delete currentLockRelevant.scripts;
  return !isDeepStrictEqual(baseLockRelevant, currentLockRelevant);
}

export function dependencyCoChangeFindings(changedFiles, lockRelevantPackageChanges = new Map()) {
  const changed = changedFiles instanceof Set ? changedFiles : new Set(changedFiles);
  const findings = [];
  for (const project of DEPENDENCY_PROJECTS) {
    const packageChanged = changed.has(project.packagePath);
    const lockfileChanged = changed.has(project.lockfilePath);
    if (lockfileChanged && !packageChanged) {
      findings.push(`${project.packagePath} and ${project.lockfilePath} must change together.`);
    }
    if (packageChanged && !lockfileChanged && lockRelevantPackageChanges.get(project.packagePath) !== false) {
      findings.push(`Lock-relevant ${project.packagePath} changes require ${project.lockfilePath} to change.`);
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

function readBasePackageJson(baseRef, packagePath) {
  const completed = spawnSync('git', ['show', `${baseRef}:${packagePath}`], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  if (completed.status !== 0) throw new Error(completed.stderr.trim());
  return JSON.parse(completed.stdout);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const baseRef = process.env.BASE_REF || process.argv[2];
  if (baseRef) {
    const changed = new Set(changedFiles(baseRef));
    const lockRelevantPackageChanges = new Map();
    for (const project of DEPENDENCY_PROJECTS) {
      if (changed.has(project.packagePath) && !changed.has(project.lockfilePath)) {
        const basePackageJson = readBasePackageJson(baseRef, project.packagePath);
        const currentPackageJson = JSON.parse(readFileSync(resolve(repositoryRoot, project.packagePath), 'utf8'));
        lockRelevantPackageChanges.set(
          project.packagePath,
          packageChangeRequiresLockfile(basePackageJson, currentPackageJson),
        );
      }
    }
    const coChangeFindings = dependencyCoChangeFindings(changed, lockRelevantPackageChanges);
    if (coChangeFindings.length > 0) {
      console.error(coChangeFindings.join('\n'));
      process.exit(1);
    }
  }
  const findings = DEPENDENCY_PROJECTS.flatMap((project) => {
    const packageJson = JSON.parse(readFileSync(resolve(repositoryRoot, project.packagePath), 'utf8'));
    const lockfile = JSON.parse(readFileSync(resolve(repositoryRoot, project.lockfilePath), 'utf8'));
    return inspectDependencyFiles(packageJson, lockfile, project);
  });
  if (findings.length) {
    console.error(`Dependency lock policy failed:\n- ${findings.join('\n- ')}`);
    process.exit(1);
  }
  console.log('Dependency lock policy passed.');
}
