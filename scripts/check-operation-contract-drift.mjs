#!/usr/bin/env node
import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import ts from 'typescript';
import YAML from 'yaml';
import { listOperationDefinitions } from '../apps/api/dist/application/operations/registry.js';

const methods = new Set(['get', 'post', 'put', 'patch', 'delete']);

export function registryRoutes(operations = listOperationDefinitions(), forGptActions = false) {
  return new Set(
    operations
      .filter((operation) => operation.rest && (!forGptActions || operation.gptActions !== false))
      .map((operation) => `${operation.rest.method} ${operation.rest.path}`),
  );
}

export function registryRoutePermissions(operations = listOperationDefinitions(), forGptActions = false) {
  const result = new Map();
  for (const operation of operations.filter(
    (candidate) => candidate.rest && (!forGptActions || candidate.gptActions !== false),
  )) {
    const route = `${operation.rest.method} ${operation.rest.path}`;
    const permissions = result.get(route) ?? new Set();
    if (operation.requiredPermission) permissions.add(operation.requiredPermission);
    result.set(route, permissions);
  }
  return result;
}

export function registryMcpTools(operations = listOperationDefinitions()) {
  return new Set(operations.flatMap((operation) => (operation.mcp ? [operation.mcp.toolName] : [])));
}

export function registeredMcpToolsFromSource(source, filePath = '<inline>') {
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const tools = new Set();
  const findings = [];
  function visit(node) {
    if (ts.isCallExpression(node) && isRegisterToolCall(node.expression)) {
      const name = node.arguments[0];
      if (!name || (!ts.isStringLiteral(name) && !ts.isNoSubstitutionTemplateLiteral(name))) {
        findings.push(`${filePath}: registerTool names must be static string literals.`);
      } else {
        tools.add(name.text);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  if (findings.length) throw new Error(findings.join('\n'));
  return tools;
}

export async function registeredMcpTools(root = resolve('apps/api/src/mcp')) {
  const tools = new Set();
  for (const file of await walk(root)) {
    if (!file.endsWith('.ts')) continue;
    for (const tool of registeredMcpToolsFromSource(await readFile(file, 'utf8'), file)) tools.add(tool);
  }
  return tools;
}

export function openApiRoutes(document) {
  return new Set(
    Object.entries(document.paths ?? {}).flatMap(([path, pathItem]) =>
      Object.keys(pathItem)
        .filter((method) => methods.has(method.toLowerCase()))
        .map((method) => `${method.toUpperCase()} ${path}`),
    ),
  );
}

export function openApiRoutePermissions(document) {
  const result = new Map();
  for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!methods.has(method.toLowerCase())) continue;
      const route = `${method.toUpperCase()} ${path}`;
      const permissions = new Set(
        (operation.security ?? [])
          .flatMap((requirement) => requirement.entraOAuth2 ?? [])
          .map(normalizePermissionScope)
          .filter(Boolean),
      );
      result.set(route, permissions);
    }
  }
  return result;
}

export function routeDrift(expected, actual) {
  return {
    missingFromContract: [...expected].filter((route) => !actual.has(route)).sort(),
    missingFromRegistry: [...actual].filter((route) => !expected.has(route)).sort(),
  };
}

export function permissionDrift(expected, actual) {
  const mismatches = [];
  for (const [route, expectedPermissions] of expected) {
    const actualPermissions = actual.get(route);
    if (!actualPermissions) continue;
    const missing = [...expectedPermissions].filter((permission) => !actualPermissions.has(permission)).sort();
    const unexpected = [...actualPermissions].filter((permission) => !expectedPermissions.has(permission)).sort();
    if (missing.length || unexpected.length) mismatches.push({ route, missing, unexpected });
  }
  return mismatches.sort((left, right) => left.route.localeCompare(right.route));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const canonicalExpected = registryRoutes();
  const canonicalPermissions = registryRoutePermissions();
  const gptExpected = registryRoutes(listOperationDefinitions(), true);
  const gptPermissions = registryRoutePermissions(listOperationDefinitions(), true);
  const expectedMcpTools = registryMcpTools();
  const actualMcpTools = await registeredMcpTools();
  let failed = false;
  for (const contractPath of ['contracts/openapi.yaml', 'contracts/openapi.gpt.yaml']) {
    const document = YAML.parse(await readFile(new URL(`../${contractPath}`, import.meta.url), 'utf8'));
    const expected = contractPath.endsWith('.gpt.yaml') ? gptExpected : canonicalExpected;
    const expectedPermissions = contractPath.endsWith('.gpt.yaml') ? gptPermissions : canonicalPermissions;
    const drift = routeDrift(expected, openApiRoutes(document));
    const permissions = permissionDrift(expectedPermissions, openApiRoutePermissions(document));
    if (drift.missingFromContract.length || drift.missingFromRegistry.length || permissions.length) {
      failed = true;
      console.error(
        `${contractPath} operation registry drift:\n${JSON.stringify({ ...drift, permissionMismatches: permissions }, null, 2)}`,
      );
    }
  }
  const mcpDrift = routeDrift(expectedMcpTools, actualMcpTools);
  if (mcpDrift.missingFromContract.length || mcpDrift.missingFromRegistry.length) {
    failed = true;
    console.error(`MCP operation registry drift:\n${JSON.stringify(mcpDrift, null, 2)}`);
  }
  if (failed) process.exit(1);
  console.log(
    `Operation registry matches canonical OpenAPI (${canonicalExpected.size} routes), GPT Actions OpenAPI (${gptExpected.size} routes), and the bundled MCP server (${expectedMcpTools.size} tools).`,
  );
}

function isRegisterToolCall(expression) {
  while (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isNonNullExpression(expression)
  ) {
    expression = expression.expression;
  }
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text === 'registerTool';
  if (ts.isElementAccessExpression(expression)) {
    const argument = expression.argumentExpression;
    return Boolean(argument && ts.isStringLiteral(argument) && argument.text === 'registerTool');
  }
  return false;
}

function normalizePermissionScope(scope) {
  if (typeof scope !== 'string' || scope.length === 0) return undefined;
  return scope.includes('/') ? scope.slice(scope.lastIndexOf('/') + 1) : scope;
}

async function walk(directory) {
  const files = [];
  for (const name of await readdir(directory)) {
    const entry = resolve(directory, name);
    if ((await stat(entry)).isDirectory()) files.push(...(await walk(entry)));
    else files.push(entry);
  }
  return files;
}
