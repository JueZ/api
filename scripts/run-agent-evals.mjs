#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { authorizeOperation } from '../apps/api/dist/application/authorization/policy.js';
import { getOperationDefinition, listOperationDefinitions } from '../apps/api/dist/application/operations/registry.js';

export function evaluateAgentSafetyCase(testCase) {
  const operation = getOperationDefinition(testCase.operationId);
  if (
    testCase.untrustedContentRequestsOperation === true &&
    testCase.requestedByUser !== true &&
    operation.effect !== 'read'
  ) {
    return 'deny_unrequested_operation';
  }
  if (operation.requiredPermission) {
    const authorization = authorizeOperation(
      {
        subject: `eval-${testCase.id}`,
        tokenType: testCase.tokenType,
        scopes: testCase.permissions,
        roles: [],
      },
      {
        permission: operation.requiredPermission,
        allowedTokenTypes: operation.allowedTokenTypes,
        environment: testCase.environment,
        allowedEnvironments: operation.allowedEnvironments,
      },
    );
    if (!authorization.ok) {
      if (authorization.reason === 'token_type_not_allowed') return 'deny_token_type';
      if (authorization.reason === 'environment_not_allowed') return 'deny_environment';
      return 'deny_permission';
    }
  }
  if (operation.effect !== 'read' && !operation.audit.enabled) return 'deny_missing_audit_policy';
  if (operation.idempotency === 'required' && testCase.idempotencyPresented !== true) {
    return 'require_idempotency';
  }
  if (operation.confirmation === 'required' && testCase.confirmationPresented !== true) {
    return 'require_confirmation';
  }
  return 'allow';
}

export function operationGovernanceFindings(operations = listOperationDefinitions()) {
  const findings = [];
  for (const operation of operations) {
    if (operation.effect === 'read') continue;
    if (!operation.requiredPermission) findings.push(`${operation.id}: mutation permission is required`);
    if (operation.idempotency !== 'required') findings.push(`${operation.id}: mutation idempotency is required`);
    if (!operation.audit.enabled) findings.push(`${operation.id}: mutation audit policy is required`);
    if (operation.effect === 'destructive') {
      if (operation.confirmation !== 'required') {
        findings.push(`${operation.id}: destructive confirmation is required`);
      }
      if (operation.allowedTokenTypes.some((tokenType) => tokenType !== 'user')) {
        findings.push(`${operation.id}: destructive operations must be user-only`);
      }
    }
  }
  return findings;
}

export function evaluateOperationGovernanceMutations(operations = listOperationDefinitions()) {
  const survivors = [];
  let total = 0;
  for (const operation of operations.filter((candidate) => candidate.effect !== 'read')) {
    const mutations = [
      ['missing-permission', { requiredPermission: undefined }],
      ['missing-idempotency', { idempotency: 'not-applicable' }],
      ['missing-audit', { audit: { ...operation.audit, enabled: false } }],
      ...(operation.effect === 'destructive'
        ? [
            ['missing-confirmation', { confirmation: 'not-applicable' }],
            ['service-token-enabled', { allowedTokenTypes: ['user', 'service'] }],
          ]
        : []),
    ];
    for (const [mutation, updates] of mutations) {
      total += 1;
      const mutant = { ...operation, ...updates };
      if (operationGovernanceFindings([mutant]).length === 0) {
        survivors.push(`${operation.id}:${mutation}`);
      }
    }
  }
  return { total, survivors };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const suite = JSON.parse(await readFile(new URL('../evals/agent-safety.json', import.meta.url), 'utf8'));
  if (suite.schemaVersion !== 1 || !Array.isArray(suite.cases) || suite.cases.length < 5) {
    console.error('Agent safety eval suite metadata is invalid.');
    process.exit(1);
  }
  const failures = suite.cases
    .map((testCase) => ({
      id: testCase.id,
      expected: testCase.expectedDecision,
      actual: evaluateAgentSafetyCase(testCase),
    }))
    .filter((result) => result.actual !== result.expected);
  const governanceFindings = operationGovernanceFindings();
  const mutationEvaluation = evaluateOperationGovernanceMutations();
  if (failures.length || governanceFindings.length || mutationEvaluation.survivors.length) {
    console.error(JSON.stringify({ failures, governanceFindings, mutationEvaluation }, null, 2));
    process.exit(1);
  }
  console.log(
    `Agent safety evals passed: ${suite.cases.length}/${suite.cases.length}; ${listOperationDefinitions().length} operation governance contracts valid; ${mutationEvaluation.total} unsafe policy mutants killed.`,
  );
}
