import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parsePerformanceRecord, validatePerformanceRecord } from '../performance-record.mjs';

function validRecord(overrides = {}) {
  return {
    schemaVersion: 1,
    trialId: 'ordinary-feature-baseline-01',
    comparisonId: 'ordinary-feature-01',
    variant: 'baseline',
    taskType: 'ordinary_feature',
    instructionRevision: 'baseline-instructions',
    sourceRevision: '17a371a5654b4d15d9ee7468a59f85fd9574ab1f',
    validations: [{ name: 'focused node:test', outcome: 'passed', repeated: false }],
    repairAttempts: 0,
    finalDeliveryOutcome: 'incomplete',
    ...overrides,
  };
}

test('synthetic example is a valid advisory record without fabricated metrics', () => {
  const example = JSON.parse(
    readFileSync(new URL('../../../evals/codex-tasks/agent-performance-record.example.json', import.meta.url), 'utf8'),
  );
  assert.deepEqual(validatePerformanceRecord(example).errors, []);
  assert.equal(Object.hasOwn(example, 'activeAgentTimeMs'), false);
  assert.equal(Object.hasOwn(example, 'tokens'), false);
});

test('record keeps agent time and CI or deployment time separate when observed', () => {
  const errors = validatePerformanceRecord(
    validRecord({
      actualModel: 'reported-model',
      actualEffort: 'reported-effort',
      activeAgentTimeMs: 123,
      ciDeploymentTimeMs: { ci: 456, deployment: 789 },
      tokens: { input: 10, output: 20 },
      validations: [
        { name: 'focused node:test', outcome: 'passed', repeated: false, durationMs: 8 },
        { name: 'focused node:test', outcome: 'passed', repeated: true },
      ],
    }),
  ).errors;
  assert.deepEqual(errors, []);
});

test('record rejects missing or misleading trial fields', () => {
  const errors = validatePerformanceRecord(
    validRecord({
      taskType: 'feature',
      sourceRevision: 'moving-main',
      activeAgentTimeMs: -1,
      ciDeploymentTimeMs: { wallClock: 5 },
      validations: [{ name: 'focused node:test', outcome: 'passed' }],
      repairAttempts: -1,
      finalDeliveryOutcome: 'verified',
      inventedTiming: 10,
    }),
  ).errors;
  assert.ok(errors.some((error) => error.includes('taskType')));
  assert.ok(errors.some((error) => error.includes('sourceRevision')));
  assert.ok(errors.some((error) => error.includes('activeAgentTimeMs')));
  assert.ok(errors.some((error) => error.includes('ciDeploymentTimeMs.wallClock is not allowed')));
  assert.ok(errors.some((error) => error.includes('validations[0].repeated')));
  assert.ok(errors.some((error) => error.includes('repairAttempts')));
  assert.ok(errors.some((error) => error.includes('finalDeliveryOutcome')));
  assert.ok(errors.some((error) => error.includes('record.inventedTiming is not allowed')));
});

test('invalid JSON remains distinct from a schema failure', () => {
  assert.deepEqual(parsePerformanceRecord('{').errors, ['record is not valid JSON']);
});
