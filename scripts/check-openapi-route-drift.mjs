#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import ts from 'typescript';
import YAML from 'yaml';

const DEFAULT_FUNCTIONS_GLOB_DIR = 'apps/api/src/functions';
const CANONICAL_CONTRACT = 'contracts/openapi.yaml';
const GPT_CONTRACT = 'contracts/openapi.gpt.yaml';
const REMOVED_SPLIT_GPT_CONTRACTS = [
  'contracts/openapi.gpt.reddit.yaml',
  'contracts/openapi.gpt.wlh.yaml',
];
const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
const DOCUMENTED_METHODS = new Set(['get', 'put', 'post', 'delete', 'head', 'patch', 'trace']);
const AUTH_RESPONSE_STATUSES = ['401', '403'];
const STALE_SPLIT_CONTRACT_PATTERNS = [
  /(?:contracts\/)?openapi\.gpt\.(?:wlh|reddit)\.ya?ml/i,
];
const STALE_SPLIT_OPERATION_IDS = new Set([
  'health',
  'hello',
  'redditThread',
  'getWlhTopCategories',
  'searchWlh',
]);
const INTENTIONAL_NON_OPENAPI_ROUTES = new Set([
  '/mcp',
  '/.well-known/oauth-protected-resource',
]);

function isStringLiteralLike(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

function stringLiteralValue(node) {
  return isStringLiteralLike(node) ? node.text : undefined;
}

function propertyNameText(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

function objectProperty(objectLiteral, propertyName) {
  return objectLiteral.properties.find((property) => {
    if (!ts.isPropertyAssignment(property)) return false;
    return propertyNameText(property.name) === propertyName;
  });
}

function stringArrayInitializer(initializer) {
  if (!ts.isArrayLiteralExpression(initializer)) return [];
  return initializer.elements.map(stringLiteralValue).filter(Boolean);
}

function isAppHttpCall(node) {
  if (!ts.isCallExpression(node)) return false;
  const expression = node.expression;
  return ts.isPropertyAccessExpression(expression)
    && expression.name.text === 'http'
    && ts.isIdentifier(expression.expression)
    && expression.expression.text === 'app';
}

function normalizeRoute(route) {
  const trimmed = route.trim().replace(/^\/+/, '');
  return `/${trimmed}`.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
}

function detectProtectedSource(sourceText) {
  return /\bauthorizeRequest\s*\(/.test(sourceText);
}

function isIntentionalNonOpenApiRoute(route) {
  return INTENTIONAL_NON_OPENAPI_ROUTES.has(route.path);
}

export function extractRoutesFromSource(sourceText, filePath = '<inline>') {
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const protectedSource = detectProtectedSource(sourceText);
  const routes = [];

  function visit(node) {
    if (isAppHttpCall(node)) {
      const [nameArg, optionsArg] = node.arguments;
      if (!isStringLiteralLike(nameArg) || !optionsArg || !ts.isObjectLiteralExpression(optionsArg)) {
        throw new Error(`${filePath}: app.http calls must use a static function name and object literal options.`);
      }

      const methodsProperty = objectProperty(optionsArg, 'methods');
      const routeProperty = objectProperty(optionsArg, 'route');
      if (!methodsProperty || !routeProperty) {
        throw new Error(`${filePath}: app.http('${nameArg.text}') is missing static methods or route properties.`);
      }
      const routeValue = stringLiteralValue(routeProperty.initializer);
      if (!routeValue) {
        throw new Error(`${filePath}: app.http('${nameArg.text}') route must be a string literal.`);
      }

      const methods = stringArrayInitializer(methodsProperty.initializer)
        .map((method) => method.toLowerCase())
        .filter((method) => DOCUMENTED_METHODS.has(method));
      if (methods.length === 0) {
        throw new Error(`${filePath}: app.http('${nameArg.text}') has no documentable HTTP methods.`);
      }

      for (const method of methods) {
        routes.push({
          functionName: nameArg.text,
          filePath,
          method,
          path: normalizeRoute(routeValue),
          protected: protectedSource,
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return routes.filter((route) => !isIntentionalNonOpenApiRoute(route));
}

export function extractRoutesFromFunctions(functionsDir = DEFAULT_FUNCTIONS_GLOB_DIR) {
  return fs.readdirSync(functionsDir)
    .filter((entry) => entry.endsWith('.ts'))
    .sort()
    .flatMap((entry) => {
      const filePath = path.join(functionsDir, entry);
      return extractRoutesFromSource(fs.readFileSync(filePath, 'utf8'), filePath);
    });
}

export function parseOpenApiFile(filePath) {
  return YAML.parse(fs.readFileSync(filePath, 'utf8'));
}

function operationEntries(contract) {
  const entries = [];
  for (const [apiPath, pathItem] of Object.entries(contract.paths ?? {})) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    for (const [method, operation] of Object.entries(pathItem)) {
      const normalizedMethod = method.toLowerCase();
      if (!HTTP_METHODS.has(normalizedMethod)) continue;
      entries.push({ path: apiPath, method: normalizedMethod, operation });
    }
  }
  return entries;
}

function operationFor(contract, route) {
  return contract.paths?.[route.path]?.[route.method];
}

function hasSecurity(operation) {
  return Array.isArray(operation?.security) && operation.security.length > 0;
}

function response(operation, status) {
  return operation?.responses?.[status] ?? operation?.responses?.[Number(status)];
}

function hasAuthResponses(operation) {
  return AUTH_RESPONSE_STATUSES.every((status) => Boolean(response(operation, status)));
}

function isPlainObjectSchema(schema) {
  return schema
    && typeof schema === 'object'
    && !Array.isArray(schema)
    && Object.keys(schema).length === 1
    && schema.type === 'object';
}

function hasJsonSchema(media) {
  return Boolean(media?.schema);
}

function jsonRequestSchema(operation) {
  return operation?.requestBody?.content?.['application/json']?.schema;
}

function jsonResponseMedia(operation, status = '200') {
  return response(operation, status)?.content?.['application/json'];
}

function isRicherCanonicalRequest(canonicalOperation) {
  const schema = jsonRequestSchema(canonicalOperation);
  return Boolean(schema) && !isPlainObjectSchema(schema);
}

function isRicherCanonicalResponse(canonicalOperation) {
  const media = jsonResponseMedia(canonicalOperation, '200');
  return hasJsonSchema(media) && response(canonicalOperation, '200')?.description !== 'OK';
}

function isWlhRoute(apiPath) {
  return apiPath.startsWith('/api/wlh/');
}

function describeRoute(route) {
  return `${route.method.toUpperCase()} ${route.path}`;
}

export function findDuplicateOperationIds(contract, contractName = 'contract') {
  const seen = new Map();
  const issues = [];
  for (const entry of operationEntries(contract)) {
    const operationId = entry.operation?.operationId;
    if (!operationId) {
      issues.push(`${contractName}: ${entry.method.toUpperCase()} ${entry.path} is missing operationId.`);
      continue;
    }
    if (!/^[a-z][A-Za-z0-9]*$/.test(operationId)) {
      issues.push(`${contractName}: ${entry.method.toUpperCase()} ${entry.path} operationId '${operationId}' is not stable lower-camel-case ASCII.`);
    }
    const previous = seen.get(operationId);
    if (previous) {
      issues.push(`${contractName}: duplicate operationId '${operationId}' on ${previous.method.toUpperCase()} ${previous.path} and ${entry.method.toUpperCase()} ${entry.path}.`);
    } else {
      seen.set(operationId, entry);
    }
  }
  return issues;
}

export function findMissingCanonicalRoutes(implementationRoutes, canonicalContract) {
  return implementationRoutes
    .filter((route) => !operationFor(canonicalContract, route))
    .map((route) => `canonical OpenAPI is missing implementation route ${describeRoute(route)} from ${route.filePath}.`);
}

export function findMissingGptRoutes(gptIntendedRoutes, gptContract) {
  return gptIntendedRoutes
    .filter((route) => !operationFor(gptContract, route))
    .map((route) => `GPT Actions OpenAPI is missing intended route ${describeRoute(route)} from ${route.filePath}.`);
}

export function findProtectedRouteAuthIssues(implementationRoutes, contracts) {
  const issues = [];
  const protectedRoutes = implementationRoutes.filter((route) => route.protected);
  for (const route of protectedRoutes) {
    for (const { name, contract } of contracts) {
      const operation = operationFor(contract, route);
      if (!operation) continue;
      if (!hasSecurity(operation)) {
        issues.push(`${name}: protected implementation route ${describeRoute(route)} is missing operation security.`);
      }
      if (!hasAuthResponses(operation)) {
        issues.push(`${name}: protected implementation route ${describeRoute(route)} must document 401 and 403 auth responses.`);
      }
    }
  }
  return issues;
}

export function findUnstableSharedOperationIds(canonicalContract, gptContract) {
  const issues = [];
  for (const canonicalEntry of operationEntries(canonicalContract)) {
    const gptOperation = gptContract.paths?.[canonicalEntry.path]?.[canonicalEntry.method];
    if (!gptOperation) continue;
    if (canonicalEntry.operation?.operationId !== gptOperation.operationId) {
      issues.push(`operationId drift for ${canonicalEntry.method.toUpperCase()} ${canonicalEntry.path}: canonical '${canonicalEntry.operation?.operationId}' vs GPT '${gptOperation.operationId}'.`);
    }
  }
  return issues;
}

export function findUnexpectedSplitContractFiles(baseDir = '.') {
  return REMOVED_SPLIT_GPT_CONTRACTS
    .map((contractPath) => path.join(baseDir, contractPath))
    .filter((contractPath) => fs.existsSync(contractPath))
    .map((contractPath) => `${path.relative(baseDir, contractPath) || contractPath} was removed; use ${GPT_CONTRACT} as the only GPT Actions contract.`);
}

export function findStaleSplitContractReferences(gptContract, rawText = '') {
  const issues = [];
  const staleReferences = new Set();
  for (const pattern of STALE_SPLIT_CONTRACT_PATTERNS) {
    const match = rawText.match(pattern);
    if (match) staleReferences.add(match[0]);
  }
  for (const staleReference of staleReferences) {
    issues.push(`GPT Actions contract contains stale split-contract reference '${staleReference}'.`);
  }
  for (const entry of operationEntries(gptContract)) {
    const operationId = entry.operation?.operationId;
    if (STALE_SPLIT_OPERATION_IDS.has(operationId)) {
      issues.push(`GPT Actions contract contains stale split-contract operationId '${operationId}' on ${entry.method.toUpperCase()} ${entry.path}.`);
    }
  }
  return issues;
}

export function findGptWlhThinSchemaIssues(canonicalContract, gptContract) {
  const issues = [];
  for (const canonicalEntry of operationEntries(canonicalContract)) {
    if (!isWlhRoute(canonicalEntry.path)) continue;
    const gptOperation = gptContract.paths?.[canonicalEntry.path]?.[canonicalEntry.method];
    if (!gptOperation) continue;

    if (isRicherCanonicalRequest(canonicalEntry.operation) && isPlainObjectSchema(jsonRequestSchema(gptOperation))) {
      issues.push(`GPT WLH operation ${canonicalEntry.method.toUpperCase()} ${canonicalEntry.path} uses only { type: object } request schema while canonical has a richer schema.`);
    }

    const gpt200 = response(gptOperation, '200');
    const gptJson = jsonResponseMedia(gptOperation, '200');
    if (isRicherCanonicalResponse(canonicalEntry.operation) && (gpt200?.description === 'OK' || !hasJsonSchema(gptJson))) {
      issues.push(`GPT WLH operation ${canonicalEntry.method.toUpperCase()} ${canonicalEntry.path} uses a thin 200 response while canonical has a richer response schema.`);
    }
  }
  return issues;
}

export function checkOpenApiRouteDrift({
  implementationRoutes,
  canonicalContract,
  gptContract,
  gptRawText = '',
  baseDir = '.',
} = {}) {
  const routes = implementationRoutes ?? extractRoutesFromFunctions();
  const canonical = canonicalContract ?? parseOpenApiFile(CANONICAL_CONTRACT);
  const gpt = gptContract ?? parseOpenApiFile(GPT_CONTRACT);
  const rawGpt = gptRawText || (fs.existsSync(GPT_CONTRACT) ? fs.readFileSync(GPT_CONTRACT, 'utf8') : '');

  const issues = [
    ...findUnexpectedSplitContractFiles(baseDir),
    ...findMissingCanonicalRoutes(routes, canonical),
    ...findProtectedRouteAuthIssues(routes, [
      { name: 'canonical OpenAPI', contract: canonical },
      { name: 'GPT Actions OpenAPI', contract: gpt },
    ]),
    ...findMissingGptRoutes(routes, gpt),
    ...findDuplicateOperationIds(canonical, 'canonical OpenAPI'),
    ...findDuplicateOperationIds(gpt, 'GPT Actions OpenAPI'),
    ...findUnstableSharedOperationIds(canonical, gpt),
    ...findStaleSplitContractReferences(gpt, rawGpt),
    ...findGptWlhThinSchemaIssues(canonical, gpt),
  ];

  return { ok: issues.length === 0, issues, routes };
}

function main() {
  const result = checkOpenApiRouteDrift();
  if (result.ok) {
    console.log(`OpenAPI route drift check passed for ${result.routes.length} implementation route(s).`);
    return;
  }

  console.error('OpenAPI route drift check failed:');
  for (const issue of result.issues) console.error(`- ${issue}`);
  process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
