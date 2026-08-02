import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

const waiverFields = [
  'rule',
  'exactFileOrScope',
  'technicalReason',
  'owner',
  'creationDate',
  'expiryDate',
  'compensatingControl',
  'linkedIssue',
  'linkedReviewEvidence',
];

export function loadQualityInputs({ root = process.cwd(), gatesPath, waiversPath }) {
  const gates = parse(readFileSync(resolve(root, gatesPath), 'utf8'));
  const waiverDocument = parse(readFileSync(resolve(root, waiversPath), 'utf8'));
  validateGateDocument(gates);
  validateWaivers(waiverDocument);
  return { gates, waivers: waiverDocument.waivers };
}

export function evaluateQuality({ root = process.cwd(), gates, waivers }) {
  const sources = loadSources(root, gates.evidenceSources);
  const evaluationDate = gates.evaluationDate;
  const evaluatedWaivers = waivers.map((waiver) => ({
    ...waiver,
    active: waiver.creationDate <= evaluationDate && waiver.expiryDate >= evaluationDate,
  }));
  const categories = gates.categories.map((category) => evaluateCategory(category, sources, evaluatedWaivers));
  const requiredGates = categories.flatMap((category) => category.gates).filter((gate) => gate.required);
  const passedRequiredGates = requiredGates.filter((gate) => gate.status === 'passed').length;

  return {
    schemaVersion: 1,
    program: gates.program,
    evaluationDate,
    result: passedRequiredGates === requiredGates.length ? 'passed' : 'failed',
    summary: {
      categoriesEligibleForTen: categories.filter((category) => category.eligibleForTen).length,
      categoryCount: categories.length,
      requiredGatesPassed: passedRequiredGates,
      requiredGateCount: requiredGates.length,
      activeWaivers: evaluatedWaivers.filter((waiver) => waiver.active).length,
    },
    evidenceSources: Object.fromEntries(
      Object.entries(sources).map(([id, source]) => [id, { path: source.path, available: source.available }]),
    ),
    waivers: evaluatedWaivers,
    categories,
  };
}

export function renderQualityMarkdown(report) {
  const lines = [
    '# Quality 10 gate report',
    '',
    `Result: **${report.result}**`,
    '',
    `Mandatory gates: ${report.summary.requiredGatesPassed}/${report.summary.requiredGateCount} passed.`,
    '',
    `Categories eligible for 10/10: ${report.summary.categoriesEligibleForTen}/${report.summary.categoryCount}.`,
    '',
    '| Category | Required gates | 10/10 eligible |',
    '| --- | ---: | :---: |',
  ];
  for (const category of report.categories) {
    const required = category.gates.filter((gate) => gate.required);
    const passed = required.filter((gate) => gate.status === 'passed').length;
    lines.push(`| ${category.name} | ${passed}/${required.length} | ${category.eligibleForTen ? 'yes' : 'no'} |`);
  }
  lines.push('', '## Unsatisfied mandatory gates', '');
  const failures = report.categories
    .map((category) => ({
      category,
      gateIds: category.gates
        .filter((gate) => gate.required && gate.status !== 'passed')
        .map((gate) => `\`${gate.id}\``),
    }))
    .filter(({ gateIds }) => gateIds.length > 0)
    .map(({ category, gateIds }) => `- **${category.name}:** ${gateIds.join(', ')}`);
  lines.push(...(failures.length ? failures : ['None.']));
  return `${lines.join('\n')}\n`;
}

function evaluateCategory(category, sources, waivers) {
  const gates = category.gates.map((gate) => evaluateGate(category.id, gate, sources, waivers));
  const activeCategoryWaiver = waivers.some(
    (waiver) => waiver.active && (waiver.rule === category.id || waiver.rule.startsWith(`${category.id}.`)),
  );
  return {
    id: category.id,
    name: category.name,
    eligibleForTen:
      !activeCategoryWaiver && gates.filter((gate) => gate.required).every((gate) => gate.status === 'passed'),
    gates,
  };
}

function evaluateGate(categoryId, gate, sources, waivers) {
  const rule = `${categoryId}.${gate.id}`;
  const activeWaiver = waivers.find((waiver) => waiver.active && waiver.rule === rule);
  const evidence = gate.evidence.map((assertion) => evaluateAssertion(assertion, sources));
  return {
    id: gate.id,
    description: gate.description,
    required: gate.required,
    status: activeWaiver ? 'waived' : evidence.every((entry) => entry.passed) ? 'passed' : 'failed',
    waiver: activeWaiver ? { rule: activeWaiver.rule, expiryDate: activeWaiver.expiryDate } : null,
    evidence,
  };
}

function evaluateAssertion(assertion, sources) {
  const source = sources[assertion.source];
  if (!source?.available) {
    return { ...assertion, passed: false, observed: null, reason: 'evidence source is absent' };
  }
  const resolved = jsonPointer(source.value, assertion.pointer);
  if (!resolved.found) {
    return { ...assertion, passed: false, observed: null, reason: 'evidence pointer is absent' };
  }
  return {
    ...assertion,
    passed: compare(resolved.value, assertion.operator, assertion.expected),
    observed: resolved.value,
    reason: null,
  };
}

function loadSources(root, sourceDefinitions) {
  return Object.fromEntries(
    Object.entries(sourceDefinitions).map(([id, definition]) => {
      const path = resolve(root, definition.path);
      if (!existsSync(path)) return [id, { path: definition.path, available: false, value: null }];
      return [id, { path: definition.path, available: true, value: JSON.parse(readFileSync(path, 'utf8')) }];
    }),
  );
}

function jsonPointer(value, pointer) {
  if (pointer === '') return { found: true, value };
  if (!pointer.startsWith('/')) return { found: false, value: undefined };
  let current = value;
  for (const rawPart of pointer.slice(1).split('/')) {
    const part = rawPart.replaceAll('~1', '/').replaceAll('~0', '~');
    if (current === null || typeof current !== 'object' || !(part in current)) {
      return { found: false, value: undefined };
    }
    current = current[part];
  }
  return { found: true, value: current };
}

function compare(observed, operator, expected) {
  if (operator === 'equals') return observed === expected;
  if (operator === 'notEquals') return observed !== expected;
  if (operator === 'gte') return typeof observed === 'number' && observed >= expected;
  if (operator === 'lte') return typeof observed === 'number' && observed <= expected;
  if (operator === 'empty') return Array.isArray(observed) && observed.length === 0;
  if (operator === 'notEmpty') return Array.isArray(observed) && observed.length > 0;
  throw new Error(`Unsupported quality gate operator: ${operator}`);
}

function validateGateDocument(document) {
  if (document?.version !== 1 || typeof document.program !== 'string') {
    throw new Error('quality-gates.yml must declare version 1 and a program name.');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(document.evaluationDate ?? '')) {
    throw new Error('quality-gates.yml must declare an exact evaluationDate.');
  }
  if (!document.evidenceSources || typeof document.evidenceSources !== 'object') {
    throw new Error('quality-gates.yml must declare evidenceSources.');
  }
  if (!Array.isArray(document.categories) || document.categories.length !== 15) {
    throw new Error('quality-gates.yml must define exactly 15 quality categories.');
  }
  const categoryIds = new Set();
  for (const category of document.categories) {
    if (!category.id || categoryIds.has(category.id) || !Array.isArray(category.gates)) {
      throw new Error('Every quality category needs a unique id and gates array.');
    }
    categoryIds.add(category.id);
    const gateIds = new Set();
    for (const gate of category.gates) {
      if (!gate.id || gateIds.has(gate.id) || typeof gate.required !== 'boolean' || !Array.isArray(gate.evidence)) {
        throw new Error(`Category ${category.id} contains an invalid or duplicate gate.`);
      }
      if (gate.evidence.length === 0) throw new Error(`Gate ${category.id}.${gate.id} has no evidence assertion.`);
      gateIds.add(gate.id);
    }
  }
}

function validateWaivers(document) {
  if (document?.version !== 1 || !Array.isArray(document.waivers)) {
    throw new Error('waivers.yml must declare version 1 and a waivers array.');
  }
  for (const waiver of document.waivers) {
    const missing = waiverFields.filter((field) => typeof waiver[field] !== 'string' || waiver[field].trim() === '');
    if (missing.length) throw new Error(`Quality waiver is missing required fields: ${missing.join(', ')}`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(waiver.creationDate) || !/^\d{4}-\d{2}-\d{2}$/.test(waiver.expiryDate)) {
      throw new Error(`Quality waiver ${waiver.rule} has an invalid date.`);
    }
    if (waiver.expiryDate < waiver.creationDate)
      throw new Error(`Quality waiver ${waiver.rule} expires before creation.`);
  }
}
