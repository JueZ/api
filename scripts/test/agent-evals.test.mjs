import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateAgentSafetyCase,
  evaluateOperationGovernanceMutations,
  operationGovernanceFindings,
} from '../run-agent-evals.mjs';

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
