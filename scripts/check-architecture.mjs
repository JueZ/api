#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = resolve(repositoryRoot, 'apps/api/src');
const forbiddenDependencies = {
  application: new Set(['functions', 'infrastructure', 'mcp']),
  infrastructure: new Set(['functions', 'mcp']),
  shared: new Set(['functions', 'mcp']),
};
const applicationForbiddenPackages = ['@azure/functions', '@modelcontextprotocol/', '@azure/'];

export function architectureFindings(root = sourceRoot) {
  const findings = [];
  for (const file of walk(root).filter((entry) => entry.endsWith('.ts'))) {
    const source = readFileSync(file, 'utf8');
    findings.push(...sourceArchitectureFindings(file, source, root));
  }
  findings.push(...bundledMcpFindings(root));
  findings.push(...bicepSecurityConfigFindings());
  return findings;
}

export function sourceArchitectureFindings(file, source, root = sourceRoot) {
  const findings = [];
  const sourceLayer = layerOf(file, root);
  const sourcePath = normalizedRelative(root, file);
  for (const specifier of importsFrom(source)) {
    if (!specifier.startsWith('.')) {
      if (
        sourceLayer === 'application' &&
        applicationForbiddenPackages.some((forbidden) => specifier === forbidden || specifier.startsWith(forbidden))
      ) {
        findings.push(`${displayPath(file)}: application must not import runtime SDK ${specifier}`);
      }
      continue;
    }
    const target = resolve(dirname(file), specifier.replace(/\.js$/, '.ts'));
    const targetLayer = layerOf(target, root);
    if (forbiddenDependencies[sourceLayer]?.has(targetLayer)) {
      findings.push(`${displayPath(file)}: ${sourceLayer} must not import ${targetLayer} (${specifier})`);
    }
    const isCompositionRoot = resolve(file) === resolve(root, 'index.ts');
    if (targetLayer === 'functions' && sourceLayer !== 'functions' && !isCompositionRoot) {
      findings.push(`${displayPath(file)}: Azure Function adapters cannot be imported by ${sourceLayer}`);
    }
    const targetPath = normalizedRelative(root, target);
    if (isProductionSourcePath(sourcePath) && isTestOnlyPath(targetPath)) {
      findings.push(`${displayPath(file)}: production source must not import test-only module ${specifier}`);
    }
    if (sourcePath.startsWith('application/authorization/') && !targetPath.startsWith('application/authorization/')) {
      findings.push(`${displayPath(file)}: authorization policy must remain transport and provider independent`);
    }
  }
  return findings;
}

export function bundledMcpFindings(root = sourceRoot) {
  const files = walk(root).filter((entry) => entry.endsWith('.ts'));
  const serverConstructors = [];
  const mcpRoutes = [];
  for (const file of files) {
    const sourceFile = parseTypeScript(readFileSync(file, 'utf8'), file);
    const mcpServerNames = importedMcpServerNames(sourceFile);
    function visit(node) {
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && mcpServerNames.has(node.expression.text)) {
        serverConstructors.push(file);
      }
      if (isMcpHttpRoute(node)) mcpRoutes.push(file);
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
  }
  const findings = [];
  const expectedServer = resolve(root, 'mcp/server.ts');
  const expectedRoute = resolve(root, 'functions/mcp.ts');
  if (serverConstructors.length !== 1 || resolve(serverConstructors[0] ?? '') !== expectedServer) {
    findings.push(
      `MCP must remain bundled in one server at ${displayPath(expectedServer)}; found ${serverConstructors.length} constructors`,
    );
  }
  if (mcpRoutes.length !== 1 || resolve(mcpRoutes[0] ?? '') !== expectedRoute) {
    findings.push(
      `MCP must expose exactly one /mcp Function route at ${displayPath(expectedRoute)}; found ${mcpRoutes.length}`,
    );
  }
  return findings;
}

export function importsFrom(source) {
  const sourceFile = parseTypeScript(source);
  const imports = [];
  function visit(node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      imports.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return imports;
}

export function bicepSecurityConfigFindings(configPath = resolve(repositoryRoot, 'bicepconfig.json')) {
  const findings = [];
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    return [`${displayPath(configPath)}: Bicep analyzer configuration must be valid JSON`];
  }
  if (config?.analyzers?.core?.enabled !== true) {
    findings.push(`${displayPath(configPath)}: Bicep core analyzer must remain enabled`);
  }
  for (const rule of [
    'outputs-should-not-contain-secrets',
    'secure-parameter-default',
    'use-secure-value-for-secure-inputs',
  ]) {
    if (config?.analyzers?.core?.rules?.[rule]?.level !== 'error') {
      findings.push(`${displayPath(configPath)}: Bicep analyzer rule ${rule} must remain at error`);
    }
  }
  return findings;
}

function parseTypeScript(source, file = '<inline>') {
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function importedMcpServerNames(sourceFile) {
  const names = new Set();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!statement.moduleSpecifier.text.includes('@modelcontextprotocol/sdk/server/mcp')) continue;
    for (const element of statement.importClause?.namedBindings?.elements ?? []) {
      if ((element.propertyName ?? element.name).text === 'McpServer') names.add(element.name.text);
    }
  }
  return names;
}

function isMcpHttpRoute(node) {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false;
  if (!ts.isIdentifier(node.expression.expression) || node.expression.expression.text !== 'app') return false;
  if (node.expression.name.text !== 'http') return false;
  const options = node.arguments[1];
  if (!options || !ts.isObjectLiteralExpression(options)) return false;
  return options.properties.some(
    (property) =>
      ts.isPropertyAssignment(property) &&
      ((ts.isIdentifier(property.name) && property.name.text === 'route') ||
        (ts.isStringLiteral(property.name) && property.name.text === 'route')) &&
      (ts.isStringLiteral(property.initializer) || ts.isNoSubstitutionTemplateLiteral(property.initializer)) &&
      property.initializer.text === 'mcp',
  );
}

function layerOf(file, root) {
  return relative(root, file).split(sep)[0] ?? '';
}

function normalizedRelative(root, file) {
  return relative(root, file).split(sep).join('/');
}

function displayPath(file) {
  const path = relative(repositoryRoot, file);
  return path.startsWith('..') ? file : path;
}

function isProductionSourcePath(path) {
  return !isTestOnlyPath(path);
}

function isTestOnlyPath(path) {
  return /(?:^|\/)(?:test|tests|fixtures)(?:\/|$)/.test(path);
}

function walk(directory) {
  return readdirSync(directory).flatMap((name) => {
    const entry = resolve(directory, name);
    return statSync(entry).isDirectory() ? walk(entry) : [entry];
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const findings = architectureFindings();
  if (findings.length) {
    console.error(`Architecture dependency violations:\n- ${findings.join('\n- ')}`);
    process.exit(1);
  }
  console.log('Architecture dependency check passed.');
}
