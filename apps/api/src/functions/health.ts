import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { logSmokeRunId } from '../shared/smokeCorrelation.js';
import { createHealthResponse } from '../shared/responses.js';
import { buildDiagnosticCapsule } from '../shared/errors/diagnosticCapsule.js';
import {
  buildDeterministicRepairableProblem,
  resolveRepairableProblem,
} from '../shared/errors/repairableErrorService.js';

export async function healthHandler(_request: HttpRequest, _context: InvocationContext): Promise<HttpResponseInit> {
  logSmokeRunId(_request, _context, 'health');

  try {
    return {
      status: 200,
      jsonBody: createHealthResponse(),
    };
  } catch {
    const deterministic = buildDeterministicRepairableProblem({
      operationId: 'getHealth',
      status: 500,
      endpoint: '/health',
      classification: 'diagnostic_uncertain',
      title: 'Health response could not be generated',
      detail: 'The service reached the health handler but could not build its bounded runtime response.',
      callerInstruction: 'Retry the same health request later and report the diagnostic ID if the failure persists.',
      safeDebugSummary: 'Health response construction failed; no runtime settings, stack, or request headers included.',
      repairable: false,
      retryPolicy: { can_retry: true, same_request: true, idempotency_required: false },
      traceId: _context.invocationId,
      repairPlan: [{ action: 'retry_later', reason: 'The health handler failed internally.' }],
      confidence: 0.5,
      analysisMode: 'fallback',
    });
    const expected = {
      operation_id: deterministic.operation_id,
      diagnostic_id: deterministic.diagnostic_id,
      status: deterministic.status,
      allowedRequestFields: [],
      allowedOperationIds: [deterministic.operation_id],
    };
    const capsule = buildDiagnosticCapsule({
      diagnostic_id: deterministic.diagnostic_id,
      operation_id: deterministic.operation_id,
      endpoint: '/health',
      method: 'GET',
      failure_stage: 'internal',
      http_status: deterministic.status,
      trace_id: _context.invocationId,
      safe_error: { code: 'HEALTH_RESPONSE_FAILURE', message: deterministic.detail },
      contract_summary: { required: [], properties: {} },
    });
    const problem = await resolveRepairableProblem({ deterministic, capsule, expected });
    return {
      status: problem.status,
      headers: { 'Content-Type': 'application/problem+json' },
      jsonBody: problem,
    };
  }
}

app.http('health', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'health',
  handler: healthHandler,
});
