import { readdirSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';

const productionRoots = ['apps/api/src', 'apps/web/src'];
const testRoots = ['apps/api/test', 'apps/web/test', 'scripts/test'];

export function collectQualityBaseline({ root = process.cwd(), sourceRef = 'unknown', runChecks = true } = {}) {
  const productionFiles = productionRoots.flatMap((directory) => listFiles(resolve(root, directory), '.ts'));
  const sourceMetrics = productionFiles.map((file) => analyzeTypeScriptFile(root, file));
  const functions = sourceMetrics.flatMap((entry) => entry.functions);
  const testFiles = testRoots.flatMap((directory) => listFiles(resolve(root, directory), '.test.mjs'));
  const packageJson = readJson(resolve(root, 'package.json'));
  const angular = readJson(resolve(root, 'angular.json'));
  const compiler = compilerEvidence(root);
  const lint = lintEvidence(root);
  const commands = runChecks ? runBaselineChecks(root) : {};

  return {
    schemaVersion: 1,
    repository: {
      name: 'JueZ/api',
      sourceRef,
      productionRoots,
      measurement: 'TypeScript scanner counts unique physical lines containing non-trivia tokens.',
    },
    source: {
      typescriptFiles: sourceMetrics.length,
      logicalLines: sum(sourceMetrics.map((entry) => entry.logicalLines)),
      largestModules: sourceMetrics
        .map(({ path, logicalLines }) => ({ path, logicalLines }))
        .sort(byMetric('logicalLines'))
        .slice(0, 15),
      largestFunctions: functions.sort(byMetric('logicalLines')).slice(0, 20),
      explicitAny: {
        count: sum(sourceMetrics.map((entry) => entry.explicitAny.length)),
        occurrences: sourceMetrics.flatMap((entry) => entry.explicitAny),
      },
      unsafeDoubleAssertions: {
        count: sum(sourceMetrics.map((entry) => entry.unsafeDoubleAssertions.length)),
        occurrences: sourceMetrics.flatMap((entry) => entry.unsafeDoubleAssertions),
      },
    },
    compiler,
    lint,
    operations: operationSchemaEvidence(root),
    tests: {
      files: testFiles.length,
      declaredCases: sum(
        testFiles.map((file) => (readFileSync(file, 'utf8').match(/\b(?:test|it)(?:\.\w+)?\s*\(/g) ?? []).length),
      ),
      executed: commandTestEvidence(commands.tests),
      gates: testGateAvailability(root, packageJson),
    },
    frontendBundle: bundleEvidence(root, angular, commands.webBuild),
    checks: Object.fromEntries(
      Object.entries(commands).map(([id, result]) => [id, { status: result.status, command: result.command }]),
    ),
    supplyChain: supplyChainEvidence(root, commands),
    knownOperationalGaps: knownIssueHeadings(root),
  };
}

function analyzeTypeScriptFile(root, file) {
  const text = readFileSync(file, 'utf8');
  const path = toPosix(relative(root, file));
  const sourceFile = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const explicitAny = [];
  const unsafeDoubleAssertions = [];
  const functions = [];

  function visit(node) {
    if (node.kind === ts.SyntaxKind.AnyKeyword) explicitAny.push(location(sourceFile, node, path));
    if (
      ts.isAsExpression(node) &&
      ts.isAsExpression(node.expression) &&
      node.expression.type.kind === ts.SyntaxKind.UnknownKeyword
    ) {
      unsafeDoubleAssertions.push(location(sourceFile, node, path));
    }
    if (isFunctionLike(node)) {
      const start = node.getStart(sourceFile);
      functions.push({
        path,
        name: functionName(node, sourceFile),
        line: sourceFile.getLineAndCharacterOfPosition(start).line + 1,
        logicalLines: logicalLineCount(text.slice(start, node.getEnd())),
      });
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { path, logicalLines: logicalLineCount(text), explicitAny, unsafeDoubleAssertions, functions };
}

function logicalLineCount(text) {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
  const lines = new Set();
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    const start = scanner.getTokenPos();
    const end = scanner.getTextPos();
    const first = lineAt(text, start);
    const last = lineAt(text, Math.max(start, end - 1));
    for (let line = first; line <= last; line += 1) lines.add(line);
  }
  return lines.size;
}

function lineAt(text, position) {
  let line = 1;
  for (let index = 0; index < position; index += 1) if (text.charCodeAt(index) === 10) line += 1;
  return line;
}

function isFunctionLike(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function functionName(node, sourceFile) {
  if (node.name) return node.name.getText(sourceFile);
  if (ts.isConstructorDeclaration(node)) return 'constructor';
  if (ts.isVariableDeclaration(node.parent)) return node.parent.name.getText(sourceFile);
  if (ts.isPropertyAssignment(node.parent)) return node.parent.name.getText(sourceFile);
  const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  return `<callback@${line}>`;
}

function location(sourceFile, node, path) {
  const point = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { path, line: point.line + 1, column: point.character + 1 };
}

function compilerEvidence(root) {
  const base = readJson(resolve(root, 'tsconfig.json')).compilerOptions ?? {};
  const api = readJson(resolve(root, 'apps/api/tsconfig.json')).compilerOptions ?? {};
  const web = readJson(resolve(root, 'apps/web/tsconfig.app.json')).compilerOptions ?? {};
  return {
    baseOptions: base,
    apiOverrides: api,
    webOverrides: web,
    targetFlags: {
      strict: base.strict === true,
      noUncheckedIndexedAccess: base.noUncheckedIndexedAccess === true,
      exactOptionalPropertyTypes: base.exactOptionalPropertyTypes === true,
      useUnknownInCatchVariables:
        base.useUnknownInCatchVariables === true ||
        (base.useUnknownInCatchVariables === undefined && base.strict === true),
    },
  };
}

function lintEvidence(root) {
  const config = readFileSync(resolve(root, 'eslint.config.js'), 'utf8');
  return {
    typeAware: /(?:projectService|project)\s*:/.test(config),
    noExplicitAnyRule: /['"]@typescript-eslint\/no-explicit-any['"]\s*:\s*['"]error['"]/.test(config),
    productionExemptionPresent: /['"]@typescript-eslint\/no-explicit-any['"]\s*:\s*['"]off['"]/.test(config),
  };
}

function operationSchemaEvidence(root) {
  const file = resolve(root, 'apps/api/src/application/operations/registry.ts');
  const sourceFile = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const definitions = findDefinitionsArray(sourceFile);
  if (!definitions) return { total: 0, input: { concrete: 0, unknown: 0 }, output: { concrete: 0, unknown: 0 } };

  let unknownInput = 0;
  let unknownOutput = 0;
  for (const element of definitions.elements) {
    if (!ts.isCallExpression(element)) continue;
    const helper = element.expression.getText(sourceFile);
    if (helper === 'defineRead') {
      unknownInput += 1;
      unknownOutput += 1;
      continue;
    }
    const object = element.arguments[0];
    if (!object || !ts.isObjectLiteralExpression(object)) continue;
    if (schemaPropertyIsUnknown(object, 'inputSchema', sourceFile)) unknownInput += 1;
    if (schemaPropertyIsUnknown(object, 'outputSchema', sourceFile)) unknownOutput += 1;
  }
  const total = definitions.elements.length;
  return {
    total,
    input: { concrete: total - unknownInput, unknown: unknownInput },
    output: { concrete: total - unknownOutput, unknown: unknownOutput },
  };
}

function findDefinitionsArray(sourceFile) {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (declaration.name.getText(sourceFile) !== 'definitions' || !declaration.initializer) continue;
      let initializer = declaration.initializer;
      while (ts.isAsExpression(initializer) || ts.isSatisfiesExpression(initializer))
        initializer = initializer.expression;
      if (ts.isArrayLiteralExpression(initializer)) return initializer;
    }
  }
  return null;
}

function schemaPropertyIsUnknown(object, name, sourceFile) {
  const property = object.properties.find(
    (entry) => ts.isPropertyAssignment(entry) && entry.name.getText(sourceFile) === name,
  );
  if (!property || !ts.isPropertyAssignment(property)) return false;
  const text = property.initializer.getText(sourceFile);
  return text === 'unknownOutput' || text === 'z.unknown()';
}

function testGateAvailability(root, packageJson) {
  const scripts = packageJson.scripts ?? {};
  const dependencies = { ...(packageJson.dependencies ?? {}), ...(packageJson.devDependencies ?? {}) };
  return {
    coverage: Boolean(scripts['test:coverage']),
    mutation: Boolean(
      scripts['test:mutation:changed'] || Object.keys(dependencies).some((name) => name.includes('stryker')),
    ),
    browserE2e: Boolean(scripts['test:e2e'] || existsMatching(root, /^playwright\.config\./)),
    accessibility: Boolean(scripts['test:a11y'] || Object.keys(dependencies).some((name) => /axe|pa11y/.test(name))),
    benchmark: Boolean(scripts['benchmark:check']),
  };
}

function bundleEvidence(root, angular, webBuild) {
  const budget = angular.projects?.web?.architect?.build?.configurations?.production?.budgets?.find(
    (entry) => entry.type === 'initial',
  );
  const browserDirectory = resolve(root, 'dist/apps/web/browser');
  const javascript = listFiles(browserDirectory, '.js');
  return {
    configuredBudget: budget ?? null,
    measured: javascript.length
      ? {
          javascriptFiles: javascript.length,
          builtJavaScriptBytes: sum(javascript.map((file) => statSync(file).size)),
          initialBundleBytes: webBuild?.bundle?.initialBytes ?? null,
          initialBundleDisplay: webBuild?.bundle?.display ?? null,
        }
      : null,
  };
}

function runBaselineChecks(root) {
  return Object.fromEntries(
    [
      ['architecture', 'npm run ops:check-architecture'],
      ['openapiDrift', 'npm run ops:check-openapi-drift'],
      ['operationDrift', 'npm run ops:check-operation-drift'],
      ['generatedOperationDocs', 'npm run docs:check-operations'],
      ['policyGuardrails', 'npm run ops:policy-guardrails'],
      ['tests', 'npm test'],
      ['webBuild', 'npm run build:web'],
      ['dependencyAudit', 'npm audit --audit-level=high'],
    ].map(([id, command]) => [id, runCommand(root, command)]),
  );
}

function runCommand(root, command) {
  const result = spawnSync(command, { cwd: root, encoding: 'utf8', shell: true, maxBuffer: 20 * 1024 * 1024 });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  return {
    command,
    status: result.status === 0 ? 'passed' : 'failed',
    exitCode: result.status ?? 1,
    summary: output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-3),
    testCounts: parseTestCounts(output),
    bundle: parseAngularInitialBundle(output),
  };
}

function parseTestCounts(output) {
  const value = (label) => Number(output.match(new RegExp(`# ${label} (\\d+)`))?.[1] ?? 0);
  return { tests: value('tests'), passed: value('pass'), failed: value('fail'), skipped: value('skipped') };
}

export function parseAngularInitialBundle(output) {
  const match = output.match(/Initial total\s+\|\s+([\d.]+)\s+(bytes|kB|MB)/);
  if (!match) return null;
  const multipliers = { bytes: 1, kB: 1000, MB: 1_000_000 };
  return { display: `${match[1]} ${match[2]}`, initialBytes: Math.round(Number(match[1]) * multipliers[match[2]]) };
}

function commandTestEvidence(result) {
  if (!result) return null;
  return { status: result.status, ...result.testCounts };
}

function supplyChainEvidence(root, commands) {
  const ci = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8');
  const codeql = readFileSync(resolve(root, '.github/workflows/codeql.yml'), 'utf8');
  return {
    configured: {
      trivy: /trivy/i.test(ci),
      gitleaks: /gitleaks/i.test(ci),
      dependencyAudit: /npm audit/.test(ci),
      codeql: /github\/codeql-action/.test(codeql),
    },
    localDependencyAudit: commands.dependencyAudit?.status ?? 'not_run',
  };
}

function knownIssueHeadings(root) {
  const text = readFileSync(resolve(root, 'docs/project-memory/known-issues.md'), 'utf8');
  return [...text.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
}

function listFiles(directory, suffix) {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .flatMap((entry) => {
        const path = resolve(directory, entry.name);
        return entry.isDirectory() ? listFiles(path, suffix) : path.endsWith(suffix) ? [path] : [];
      })
      .sort();
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return [];
    throw error;
  }
}

function existsMatching(root, pattern) {
  return readdirSync(root, { withFileTypes: true }).some((entry) => entry.isFile() && pattern.test(entry.name));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function byMetric(metric) {
  return (left, right) => right[metric] - left[metric] || left.path.localeCompare(right.path);
}

function toPosix(path) {
  return path.replaceAll('\\', '/');
}
