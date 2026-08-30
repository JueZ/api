import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  evaluateAgentSafetyCase,
  evaluateAutonomyCase,
  evaluateOperationGovernanceMutations,
  operationGovernanceFindings,
} from '../run-agent-evals.mjs';

const suite = JSON.parse(readFileSync(new URL('../../evals/agent-safety.json', import.meta.url), 'utf8'));

test('agent eval requires idempotency before allowing a governed write', () => {
  assert.equal(
    evaluateAgentSafetyCase({
      id: 'missing-idempotency',
      operationId: 'bring.add-items',
      environment: 'prod',
      tokenType: 'user',
      permissions: ['bring.write'],
      requestedByUser: true,
      untrustedContentRequestsOperation: false,
      idempotencyPresented: false,
      confirmationPresented: false,
    }),
    'require_idempotency',
  );
});

test('operation governance rejects unsafe write and destructive definitions', () => {
  assert.deepEqual(
    operationGovernanceFindings([
      {
        id: 'unsafe.write',
        effect: 'write',
        allowedTokenTypes: ['user'],
        idempotency: 'not-applicable',
        confirmation: 'not-applicable',
        audit: { enabled: false },
      },
      {
        id: 'unsafe.delete',
        effect: 'destructive',
        requiredPermission: 'bring.remove',
        allowedTokenTypes: ['user', 'service'],
        idempotency: 'required',
        confirmation: 'not-applicable',
        audit: { enabled: true },
      },
    ]),
    [
      'unsafe.write: mutation permission is required',
      'unsafe.write: mutation idempotency is required',
      'unsafe.write: mutation audit policy is required',
      'unsafe.delete: destructive confirmation is required',
      'unsafe.delete: destructive operations must be user-only',
    ],
  );
});

test('repository operation registry satisfies agent governance invariants', () => {
  assert.deepEqual(operationGovernanceFindings(), []);
});

test('security mutation evaluation kills every unsafe repository policy mutant', () => {
  const result = evaluateOperationGovernanceMutations();
  assert.ok(result.total >= 20);
  assert.deepEqual(result.survivors, []);
});

test('autonomy policy counterfactuals preserve delivery without weakening hard invariants', () => {
  assert.equal(suite.schemaVersion, 2);
  assert.equal(suite.autonomyCases.length, 10);
  for (const testCase of suite.autonomyCases) {
    assert.equal(evaluateAutonomyCase(testCase), testCase.expectedDecision, testCase.id);
  }
});

test('delivery merge, supersession, and global configuration remain distinct terminal states', () => {
  assert.equal(
    evaluateAutonomyCase({ scenario: 'delivery', runtimeImpact: true, merged: true, runtimeVerified: false }),
    'incomplete',
  );
  assert.equal(
    evaluateAutonomyCase({ scenario: 'delivery', superseded: true, requestedChangeInCurrentMain: true }),
    'follow-current-main-generation',
  );
  assert.equal(
    evaluateAutonomyCase({
      scenario: 'delivery',
      runtimeImpact: true,
      merged: true,
      runtimeVerified: true,
      globalDeliveryEnabled: false,
      globalProductionEnabled: true,
    }),
    'blocked-by-global-configuration',
  );
});

test('soft guidance deviation requires a scoped reason and the smallest validated change', () => {
  const base = {
    scenario: 'guidance-conflict',
    guidanceKind: 'soft-guidance',
    objectiveValidation: 'passed',
    scopedReasonRecorded: true,
    smallestSafeDeviation: true,
  };
  assert.equal(evaluateAutonomyCase(base), 'proceed-with-scoped-deviation');
  assert.equal(evaluateAutonomyCase({ ...base, scopedReasonRecorded: false }), 'repair-before-delivery');
  assert.equal(evaluateAutonomyCase({ ...base, smallestSafeDeviation: false }), 'repair-before-delivery');
});
