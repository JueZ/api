import type { HttpResponseInit } from '@azure/functions';
import {
  BringConfirmationError,
  BringIdempotencyConflictError,
  BringMutationExpiredError,
  BringMutationOutcomeUnknownError,
} from '../../application/operations/bring/mutations.js';
import {
  createDiagnosticId,
  type RepairableErrorClassification,
  type RepairableProblem,
} from '../errors/repairableProblem.js';
import { buildDiagnosticCapsule } from '../errors/diagnosticCapsule.js';
import { resolveRepairableProblem } from '../errors/repairableErrorService.js';
import { BringUpstreamError } from './client.js';
import { BringConfigError } from './config.js';
import {
  BringDisabledError,
  BringInputError,
  BringNotFoundError,
  BringPolicyError,
  BringVersionConflictError,
} from './service.js';

export const BRING_OPERATION_IDS = {
  listLists: 'bringListLists',
  getItems: 'bringGetItems',
  addItems: 'bringAddItems',
  prepareMutation: 'bringPrepareItemMutation',
  applyMutation: 'bringApplyItemMutation',
} as const;

export type BringOperationId = (typeof BRING_OPERATION_IDS)[keyof typeof BRING_OPERATION_IDS];

export function bringProblem(error: unknown, operationId: BringOperationId, traceId?: string): RepairableProblem {
  let status = 500;
  let classification: RepairableErrorClassification = 'diagnostic_uncertain';
  let title = 'Bring request failed';
  let detail = 'The Bring operation could not be completed.';
  let canRetry = false;
  let sameRequest = false;

  if (error instanceof BringInputError) {
    status = 400;
    classification = 'caller_contract_violation';
    title = 'Invalid Bring request';
    detail = error.message;
  } else if (error instanceof BringNotFoundError) {
    status = 404;
    classification = 'resource_not_found';
    title = 'Bring list not found';
    detail = error.message;
  } else if (error instanceof BringPolicyError) {
    status = 403;
    classification = 'caller_contract_violation';
    title = 'Bring policy rejected the operation';
    detail = error.message;
  } else if (error instanceof BringDisabledError) {
    status = 503;
    classification = 'dependency_failure';
    title = 'Bring operation is disabled';
    detail = error.message;
  } else if (error instanceof BringVersionConflictError || error instanceof BringIdempotencyConflictError) {
    status = 409;
    classification = 'caller_contract_violation';
    title = 'Bring mutation conflict';
    detail = error.message;
  } else if (error instanceof BringConfirmationError) {
    status = 403;
    classification = 'caller_contract_violation';
    title = 'Bring confirmation rejected';
    detail = error.message;
  } else if (error instanceof BringMutationExpiredError) {
    status = 410;
    classification = 'caller_contract_violation';
    title = 'Bring mutation expired';
    detail = error.message;
  } else if (error instanceof BringMutationOutcomeUnknownError) {
    status = 409;
    classification = 'dependency_failure';
    title = 'Bring mutation outcome is unknown';
    detail = error.message;
  } else if (error instanceof BringUpstreamError) {
    status = error.status;
    classification =
      error.kind === 'version_skew'
        ? 'version_skew'
        : error.kind === 'timeout' || error.kind === 'rate_limit'
          ? 'capacity_or_timeout'
          : error.kind === 'not_found'
            ? 'resource_not_found'
            : 'dependency_failure';
    title = error.kind === 'authentication' ? 'Bring account authentication failed' : 'Bring dependency failure';
    detail = error.message;
    canRetry = error.kind === 'rate_limit';
    sameRequest = false;
  } else if (error instanceof BringConfigError) {
    classification = 'service_bug_likely';
    title = 'Bring runtime configuration is incomplete';
    detail = 'Bring runtime configuration is incomplete.';
  }

  const diagnosticId = createDiagnosticId();
  const writeOperations: BringOperationId[] = [
    BRING_OPERATION_IDS.addItems,
    BRING_OPERATION_IDS.prepareMutation,
    BRING_OPERATION_IDS.applyMutation,
  ];
  const isWrite = writeOperations.includes(operationId);
  return {
    type: `https://api.juez.local/problems/bring/${classification}`,
    title,
    status,
    detail,
    instance: `urn:diagnostic:${diagnosticId}`,
    rec_version: '1.0',
    operation_id: operationId,
    diagnostic_id: diagnosticId,
    ...(traceId ? { trace_id: traceId } : {}),
    classification,
    repairable: [400, 404, 409, 410].includes(status),
    confidence: classification === 'diagnostic_uncertain' ? 0.5 : 0.98,
    retry_policy: {
      can_retry: canRetry,
      same_request: sameRequest,
      idempotency_required: isWrite,
    },
    caller_instruction:
      status === 400
        ? 'Correct the invalid fields and retry with a new operationId.'
        : canRetry
          ? 'Retry only with an idempotent operationId.'
          : 'Report the diagnostic ID to the service owner.',
    safe_debug_summary: `${operationId}:${classification}:${status}`,
    analysis_mode: classification === 'diagnostic_uncertain' ? 'fallback' : 'deterministic',
  };
}

export async function resolveBringProblem(args: {
  error: unknown;
  operationId: BringOperationId;
  traceId?: string;
  body?: unknown;
}): Promise<RepairableProblem> {
  const deterministic = bringProblem(args.error, args.operationId, args.traceId);
  const allowedRequestFields = bringFields(args.operationId);
  const allowedOperationIds = Object.values(BRING_OPERATION_IDS);
  const expected = {
    operation_id: args.operationId,
    diagnostic_id: deterministic.diagnostic_id,
    status: deterministic.status,
    allowedRequestFields,
    allowedOperationIds,
  };
  const capsule = buildDiagnosticCapsule({
    diagnostic_id: deterministic.diagnostic_id,
    operation_id: args.operationId,
    endpoint: bringEndpoint(args.operationId),
    method:
      args.operationId === BRING_OPERATION_IDS.listLists || args.operationId === BRING_OPERATION_IDS.getItems
        ? 'GET'
        : 'POST',
    failure_stage: deterministic.classification === 'diagnostic_uncertain' ? 'unknown' : 'business_rule',
    http_status: deterministic.status,
    trace_id: args.traceId,
    safe_error: { code: bringSafeCode(args.error), message: deterministic.detail },
    body: args.body,
    contract_summary: {
      required: bringRequiredFields(args.operationId),
      properties: Object.fromEntries(allowedRequestFields.map((field) => [field, { documented: true }])),
    },
  });
  return resolveRepairableProblem({ deterministic, capsule, expected });
}

export function bringProblemResponse(problem: RepairableProblem, cors: Record<string, string>): HttpResponseInit {
  return {
    status: problem.status,
    headers: { ...cors, 'Content-Type': 'application/problem+json' },
    jsonBody: problem,
  };
}

function bringFields(operationId: BringOperationId): string[] {
  if (operationId === BRING_OPERATION_IDS.listLists) return [];
  if (operationId === BRING_OPERATION_IDS.getItems) return ['listUuid'];
  if (operationId === BRING_OPERATION_IDS.addItems) return ['listUuid', 'operationId', 'expectedListVersion', 'items'];
  if (operationId === BRING_OPERATION_IDS.prepareMutation)
    return ['listUuid', 'operationId', 'expectedListVersion', 'operation', 'items'];
  return ['listUuid', 'operationId', 'confirmationToken'];
}

function bringRequiredFields(operationId: BringOperationId): string[] {
  if (operationId === BRING_OPERATION_IDS.listLists) return [];
  if (operationId === BRING_OPERATION_IDS.getItems) return ['listUuid'];
  if (operationId === BRING_OPERATION_IDS.addItems) return ['listUuid', 'operationId', 'items'];
  if (operationId === BRING_OPERATION_IDS.prepareMutation) return ['listUuid', 'operationId', 'operation', 'items'];
  return ['listUuid', 'operationId', 'confirmationToken'];
}

function bringEndpoint(operationId: BringOperationId): string {
  if (operationId === BRING_OPERATION_IDS.listLists) return '/api/bring/lists';
  if (operationId === BRING_OPERATION_IDS.getItems || operationId === BRING_OPERATION_IDS.addItems)
    return '/api/bring/lists/{listUuid}/items';
  if (operationId === BRING_OPERATION_IDS.prepareMutation) return '/api/bring/lists/{listUuid}/mutations/prepare';
  return '/api/bring/lists/{listUuid}/mutations/apply';
}

function bringSafeCode(error: unknown): string {
  if (error instanceof BringInputError) return 'BRING_INPUT_ERROR';
  if (error instanceof BringNotFoundError) return 'BRING_NOT_FOUND';
  if (error instanceof BringPolicyError) return 'BRING_POLICY_DENIED';
  if (error instanceof BringDisabledError) return 'BRING_DISABLED';
  if (error instanceof BringVersionConflictError || error instanceof BringIdempotencyConflictError)
    return 'BRING_IDEMPOTENCY_CONFLICT';
  if (error instanceof BringConfirmationError) return 'BRING_CONFIRMATION_INVALID';
  if (error instanceof BringMutationExpiredError) return 'BRING_CONFIRMATION_EXPIRED';
  if (error instanceof BringMutationOutcomeUnknownError) return 'BRING_OUTCOME_UNKNOWN';
  if (error instanceof BringUpstreamError) return 'BRING_UPSTREAM_ERROR';
  if (error instanceof BringConfigError) return 'BRING_CONFIG_ERROR';
  return 'BRING_UNKNOWN_ERROR';
}
