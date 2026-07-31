#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  const serverConstructors = files.filter((file) => /\bnew\s+McpServer\s*\(/.test(readFileSync(file, 'utf8')));
  const mcpRoutes = files.filter((file) => /\broute\s*:\s*['"]mcp['"]/.test(readFileSync(file, 'utf8')));
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
  return [...source.matchAll(/\b(?:from|import)\s*(?:\(\s*)?['"]([^'"]+)['"]/g)].map((match) => match[1]);
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
