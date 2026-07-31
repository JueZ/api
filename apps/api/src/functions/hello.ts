import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { logSmokeRunId } from '../shared/smokeCorrelation.js';
import { createHelloResponse } from '../shared/responses.js';
import { authorizeRequestForOperation } from '../shared/security/auth.js';
import { OPERATION_IDS } from '../application/operations/registry.js';
import { createCorsHeaders, withCorsHeaders, type CorsOptions } from '../shared/http/cors.js';
import { buildDiagnosticCapsule } from '../shared/errors/diagnosticCapsule.js';
import {
  buildDeterministicRepairableProblem,
  resolveRepairableProblem,
} from '../shared/errors/repairableErrorService.js';

export async function helloHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  logSmokeRunId(request, context, 'hello');

  if (request.method === 'OPTIONS') {
    return {
      status: 204,
      headers: corsHeaders(request),
    };
  }

  const authorization = await authorizeRequestForOperation(request, context, OPERATION_IDS.hello);

  if (!authorization.ok) {
    return withCors(authorization.response, request);
  }

  try {
    return withCors(
      {
        status: 200,
        jsonBody: createHelloResponse(authorization.user),
      },
      request,
    );
  } catch {
    const deterministic = buildDeterministicRepairableProblem({
      operationId: OPERATION_IDS.hello,
      status: 500,
      endpoint: '/api/hello',
      classification: 'diagnostic_uncertain',
      title: 'Authenticated response could not be generated',
      detail: 'Authentication succeeded, but the service could not build the bounded response.',
      callerInstruction: 'Retry later with the same request and report the diagnostic ID if the failure persists.',
      safeDebugSummary: 'Hello response construction failed; no identity claims, credentials, or stack included.',
      repairable: false,
      retryPolicy: { can_retry: true, same_request: true, idempotency_required: false },
      traceId: context.invocationId,
      repairPlan: [{ action: 'retry_later', reason: 'The response builder failed inside the service.' }],
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
      endpoint: '/api/hello',
      method: 'GET',
      failure_stage: 'internal',
      http_status: deterministic.status,
      trace_id: context.invocationId,
      safe_error: { code: 'HELLO_RESPONSE_FAILURE', message: deterministic.detail },
      contract_summary: { required: [], properties: {} },
    });
    const problem = await resolveRepairableProblem({ deterministic, capsule, expected });
    return withCors(
      {
        status: problem.status,
        headers: { 'Content-Type': 'application/problem+json' },
        jsonBody: problem,
      },
      request,
    );
  }
}

app.http('hello', {
  methods: ['GET', 'OPTIONS'],
  authLevel: 'anonymous',
  route: 'api/hello',
  handler: helloHandler,
});

const corsOptions = { methods: ['GET', 'OPTIONS'] } satisfies CorsOptions;

function withCors(response: HttpResponseInit, request?: HttpRequest): HttpResponseInit {
  return withCorsHeaders(request, response, corsOptions);
}

function corsHeaders(request?: HttpRequest): Record<string, string> {
  return createCorsHeaders(request, corsOptions);
}
