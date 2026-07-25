import type { HttpResponseInit } from '@azure/functions';
import { createDiagnosticId, type RepairableProblem, type RepairableErrorClassification } from '../errors/repairableProblem.js';
import { BringUpstreamError } from './client.js';
import { BringConfigError } from './config.js';
import { BringInputError, BringNotFoundError } from './service.js';

export const BRING_OPERATION_IDS = { listLists: 'bringListLists', getItems: 'bringGetItems', addItems: 'bringAddItems', completeItems: 'bringCompleteItems', removeItems: 'bringRemoveItems' } as const;
export type BringOperationId = typeof BRING_OPERATION_IDS[keyof typeof BRING_OPERATION_IDS];

export function bringProblem(error: unknown, operationId: BringOperationId, traceId?: string): RepairableProblem {
  let status = 500; let classification: RepairableErrorClassification = 'internal_error'; let title = 'Bring request failed'; let detail = 'The Bring operation could not be completed.'; let canRetry = false;
  if (error instanceof BringInputError) { status = 400; classification = 'caller_contract_violation'; title = 'Invalid Bring request'; detail = error.message; }
  else if (error instanceof BringNotFoundError) { status = 404; classification = 'resource_not_found'; title = 'Bring list not found'; detail = error.message; }
  else if (error instanceof BringUpstreamError) { status = error.status; classification = error.kind === 'version_skew' ? 'version_skew' : error.kind === 'timeout' || error.kind === 'rate_limit' ? 'capacity_or_timeout' : error.kind === 'not_found' ? 'resource_not_found' : 'dependency_failure'; title = error.kind === 'authentication' ? 'Bring account authentication failed' : 'Bring dependency failure'; detail = error.message; canRetry = !['authentication', 'not_found'].includes(error.kind); }
  else if (error instanceof BringConfigError) { detail = 'Bring runtime configuration is incomplete.'; }
  const diagnosticId = createDiagnosticId();
  const isWrite = operationId === BRING_OPERATION_IDS.addItems || operationId === BRING_OPERATION_IDS.completeItems || operationId === BRING_OPERATION_IDS.removeItems;
  return { type: `https://api.juez.local/problems/bring/${classification}`, title, status, detail, instance: `urn:diagnostic:${diagnosticId}`, rec_version: '1.0', operation_id: operationId, diagnostic_id: diagnosticId, ...(traceId ? { trace_id: traceId } : {}), classification, repairable: status === 400 || status === 404, confidence: 0.98, retry_policy: { can_retry: canRetry, same_request: canRetry, idempotency_required: isWrite }, caller_instruction: status === 400 ? 'Correct the invalid fields and retry.' : canRetry ? 'Retry later; do not expose or alter Bring credentials.' : 'Report the diagnostic ID to the service owner.', safe_debug_summary: `${operationId}:${classification}:${status}`, analysis_mode: 'deterministic' };
}
export function bringProblemResponse(problem: RepairableProblem, cors: Record<string, string>): HttpResponseInit { return { status: problem.status, headers: { ...cors, 'Content-Type': 'application/problem+json' }, jsonBody: problem }; }
