import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse as parseYaml } from 'yaml';
import { DEPENDENCY_PROJECTS, dependencyCoChangeFindings, inspectDependencyFiles } from '../check-lockfile-policy.mjs';
import { functionSbomFindings } from '../verify-function-sbom.mjs';

const repositoryFile = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

test('dependency policy covers the root and deployed Function projects independently', () => {
  assert.deepEqual(DEPENDENCY_PROJECTS, [
    { packagePath: 'package.json', lockfilePath: 'package-lock.json' },
    { packagePath: 'apps/api/package.json', lockfilePath: 'apps/api/package-lock.json' },
  ]);

  for (const project of DEPENDENCY_PROJECTS) {
    const packageJson = JSON.parse(repositoryFile(project.packagePath));
    const lockfile = JSON.parse(repositoryFile(project.lockfilePath));
    assert.deepEqual(inspectDependencyFiles(packageJson, lockfile, project), [], project.packagePath);
  }
});

test('lockfile co-change rules remain pair-local and fail closed for both projects', () => {
  assert.deepEqual(dependencyCoChangeFindings(['package-lock.json']), [
    'package.json and package-lock.json must change together.',
  ]);
  assert.deepEqual(dependencyCoChangeFindings(['apps/api/package-lock.json']), [
    'apps/api/package.json and apps/api/package-lock.json must change together.',
  ]);
  assert.deepEqual(dependencyCoChangeFindings(['apps/api/package.json'], new Map([['apps/api/package.json', true]])), [
    'Lock-relevant apps/api/package.json changes require apps/api/package-lock.json to change.',
  ]);
  assert.deepEqual(
    dependencyCoChangeFindings(['apps/api/package.json'], new Map([['apps/api/package.json', false]])),
    [],
  );
  assert.deepEqual(dependencyCoChangeFindings(['apps/api/package.json', 'apps/api/package-lock.json']), []);
});

test('Function dependency changes run both lockfile audits in the existing Security Gate', () => {
  const workflow = parseYaml(repositoryFile('.github/workflows/security-gate.yml'));
  const job = workflow.jobs.dependencyAudit;
  const setup = job.steps.find((step) => step.name === 'Setup Node.js');
  const audit = job.steps.find((step) => step.name === 'Audit registry dependencies');

  assert.equal(job.if, "needs.classify.outputs.dependencies == 'true'");
  assert.deepEqual(setup.with['cache-dependency-path'].trim().split(/\s+/), [
    'package-lock.json',
    'apps/api/package-lock.json',
  ]);
  assert.match(audit.run, /npm audit --audit-level=high/);
  assert.match(audit.run, /npm --prefix apps\/api audit --omit=dev --audit-level=high/);
  assert.doesNotMatch(audit.run, /npm ci/);
  assert.ok(workflow.jobs.aggregate.needs.includes('dependencyAudit'));
});

test('Dependabot monitors the deployed Function manifest as an independent npm project', () => {
  const config = parseYaml(repositoryFile('.github/dependabot.yml'));
  const npmUpdates = config.updates.filter((update) => update['package-ecosystem'] === 'npm');

  assert.deepEqual(
    npmUpdates.map((update) => update.directory),
    ['/', '/apps/api'],
  );
  assert.equal(npmUpdates[1]['open-pull-requests-limit'], 5);
  assert.deepEqual(npmUpdates[1].labels, ['dependencies', 'npm']);
});

test('release SBOM is generated once from the installed production Function stage', () => {
  const source = repositoryFile('scripts/build-release-artifacts.sh');
  const installIndex = source.indexOf('npm ci --omit=dev --ignore-scripts --prefix "$function_stage"');
  const sbomIndex = source.indexOf('npm sbom --sbom-format cyclonedx --sbom-type application --omit=dev');
  const functionStageIndex = source.lastIndexOf('cd "$function_stage"', sbomIndex);
  const repositoryRootIndex = source.lastIndexOf('cd "$repository_root"', sbomIndex);

  assert.match(source, /function_stage="\$release_temp\/api-catalogue-functions"/);
  assert.equal((source.match(/npm sbom/g) ?? []).length, 1);
  assert.ok(installIndex >= 0);
  assert.ok(sbomIndex > installIndex);
  assert.ok(functionStageIndex > installIndex);
  assert.ok(repositoryRootIndex < functionStageIndex);
  assert.match(source, /node "\$repository_root\/scripts\/verify-function-sbom\.mjs"/);
});

test('Function SBOM semantics bind the runtime root and exact direct dependencies', () => {
  const lockfile = {
    packages: {
      '': {
        name: 'api-catalogue-functions',
        version: '0.1.0',
        dependencies: { '@azure/functions': '4.14.0', jose: '^6.2.3' },
      },
      'node_modules/@azure/functions': { version: '4.14.0' },
      'node_modules/jose': { version: '6.2.4' },
    },
  };
  const valid = {
    bomFormat: 'CycloneDX',
    metadata: {
      component: {
        type: 'application',
        name: 'api-catalogue-functions',
        'bom-ref': 'api-catalogue-functions@0.1.0',
        purl: 'pkg:npm/api-catalogue-functions@0.1.0',
      },
    },
    components: [
      { name: '@azure/functions', version: '4.14.0' },
      { name: 'jose', version: '6.2.4' },
    ],
  };

  assert.deepEqual(functionSbomFindings(valid, lockfile), []);
  assert.deepEqual(
    functionSbomFindings(
      {
        ...valid,
        metadata: {
          component: {
            ...valid.metadata.component,
            name: 'api-catalogue-v0',
            purl: 'pkg:npm/api-catalogue-v0@0.1.0',
          },
        },
        components: [{ name: '@angular/core', version: '21.2.19' }],
      },
      lockfile,
    ),
    [
      'Function SBOM root name is invalid',
      'Function SBOM root purl is invalid',
      'Function SBOM is missing direct runtime dependency @azure/functions',
      'Function SBOM is missing direct runtime dependency jose',
      'Function SBOM contains root-only dependency @angular/core',
    ],
  );
});
