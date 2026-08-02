import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { stringify } from 'yaml';
import { collectQualityBaseline, parseAngularInitialBundle } from '../lib/quality-evidence.mjs';
import { evaluateQuality, renderQualityMarkdown } from '../lib/quality-gates.mjs';

const root = resolve(import.meta.dirname, '../..');

test('baseline collector measures production source and gate availability without an LLM', () => {
  const baseline = collectQualityBaseline({ root, sourceRef: 'test-ref', runChecks: false });

  assert.equal(baseline.repository.sourceRef, 'test-ref');
  assert.ok(baseline.source.typescriptFiles > 0);
  assert.ok(baseline.source.logicalLines > 0);
  assert.equal(baseline.operations.total, 21);
  assert.equal(baseline.operations.input.unknown, 20);
  assert.equal(baseline.operations.output.unknown, 21);
  assert.equal(baseline.compiler.targetFlags.strict, true);
  assert.equal(baseline.tests.gates.coverage, false);
  assert.equal(baseline.tests.gates.browserE2e, false);
});

test('Angular initial bundle output is normalized to deterministic bytes', () => {
  assert.deepEqual(parseAngularInitialBundle('Initial total | 542.77 kB | 138.09 kB'), {
    display: '542.77 kB',
    initialBytes: 542_770,
  });
  assert.equal(parseAngularInitialBundle('build output without bundle totals'), null);
});

test('all mandatory evidence must pass before any category is eligible for 10/10', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'quality-gates-'));
  writeFileSync(resolve(directory, 'evidence.json'), '{"passed":true}\n');
  const gates = gateDocument(resolve(directory, 'evidence.json'));

  const report = evaluateQuality({ root, gates, waivers: [] });

  assert.equal(report.result, 'passed');
  assert.equal(report.summary.requiredGatesPassed, 15);
  assert.equal(report.summary.categoriesEligibleForTen, 15);
  assert.match(renderQualityMarkdown(report), /Categories eligible for 10\/10: 15\/15/);
});

test('missing evidence and active waivers both prevent a 10/10 claim', () => {
  const missing = gateDocument('/missing/quality-evidence.json');
  const missingReport = evaluateQuality({ root, gates: missing, waivers: [] });
  assert.equal(missingReport.result, 'failed');
  assert.equal(missingReport.summary.requiredGatesPassed, 0);

  const directory = mkdtempSync(resolve(tmpdir(), 'quality-waiver-'));
  writeFileSync(resolve(directory, 'evidence.json'), '{"passed":true}\n');
  const gates = gateDocument(resolve(directory, 'evidence.json'));
  const waiverReport = evaluateQuality({
    root,
    gates,
    waivers: [waiver('category-1.required-evidence')],
  });
  assert.equal(waiverReport.result, 'failed');
  assert.equal(waiverReport.categories[0].gates[0].status, 'waived');
  assert.equal(waiverReport.categories[0].eligibleForTen, false);
});

test('quality-report CLI writes JSON and Markdown and exits nonzero for incomplete gates', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'quality-cli-'));
  const gatesPath = resolve(directory, 'quality-gates.yml');
  const waiversPath = resolve(directory, 'waivers.yml');
  const outputDirectory = resolve(directory, 'output');
  writeFileSync(gatesPath, stringify(gateDocument(resolve(directory, 'absent.json'))));
  writeFileSync(waiversPath, stringify({ version: 1, waivers: [] }));

  const result = spawnSync(
    process.execPath,
    ['scripts/quality-report.mjs', '--gates', gatesPath, '--waivers', waiversPath, '--output-dir', outputDirectory],
    { cwd: root, encoding: 'utf8' },
  );

  assert.equal(result.status, 1);
  assert.equal(existsSync(resolve(outputDirectory, 'quality-report.json')), true);
  assert.equal(existsSync(resolve(outputDirectory, 'quality-report.md')), true);
  const report = JSON.parse(readFileSync(resolve(outputDirectory, 'quality-report.json'), 'utf8'));
  assert.equal(report.result, 'failed');
});

function gateDocument(path) {
  return {
    version: 1,
    program: 'test-quality-program',
    evaluationDate: '2026-08-02',
    evidenceSources: { evidence: { path } },
    categories: Array.from({ length: 15 }, (_, index) => ({
      id: `category-${index + 1}`,
      name: `Category ${index + 1}`,
      gates: [
        {
          id: 'required-evidence',
          description: 'Required evidence passes.',
          required: true,
          evidence: [{ source: 'evidence', pointer: '/passed', operator: 'equals', expected: true }],
        },
      ],
    })),
  };
}

function waiver(rule) {
  return {
    rule,
    exactFileOrScope: 'test only',
    technicalReason: 'exercise waiver handling',
    owner: 'test-owner',
    creationDate: '2026-08-01',
    expiryDate: '2026-08-03',
    compensatingControl: 'test assertion',
    linkedIssue: 'https://example.test/issues/1',
    linkedReviewEvidence: 'https://example.test/reviews/1',
  };
}
