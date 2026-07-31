import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { buildMcpProtectedResourceMetadata, validateMcpRequestOrigin } from '../mcp/auth.js';
import { createCorsHeaders, type CorsOptions } from '../shared/http/cors.js';
import { buildDiagnosticCapsule } from '../shared/errors/diagnosticCapsule.js';
import {
  buildDeterministicRepairableProblem,
  resolveRepairableProblem,
} from '../shared/errors/repairableErrorService.js';
import type { RepairableProblem } from '../shared/errors/repairableProblem.js';

const corsOptions = { methods: ['GET', 'OPTIONS'] } satisfies CorsOptions;
const OPERATION_ID = 'oauth.protected-resource';
const ENDPOINT = '/.well-known/oauth-protected-resource';

export async function oauthProtectedResourceHandler(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const originValidation = validateMcpRequestOrigin(request);
  if (!originValidation.ok) {
    const problem = protectedResourceProblem(
      originValidation.status,
      'security_suspicious',
      'MCP resource origin is not allowed',
      originValidation.message,
      context.invocationId,
    );
    return {
      status: originValidation.status,
      headers: { ...corsHeaders(request), 'Content-Type': 'application/problem+json' },
      jsonBody: problem,
    };
  }
  if (request.method === 'OPTIONS') return { status: 204, headers: corsHeaders(request) };
  try {
    return { status: 200, headers: corsHeaders(request), jsonBody: buildMcpProtectedResourceMetadata(request) };
  } catch {
    const deterministic = protectedResourceProblem(
      500,
      'diagnostic_uncertain',
      'OAuth protected resource metadata is unavailable',
      'The service could not build its protected resource metadata.',
      context.invocationId,
    );
    const expected = {
      operation_id: OPERATION_ID,
      diagnostic_id: deterministic.diagnostic_id,
      status: deterministic.status,
      allowedRequestFields: [],
      allowedOperationIds: [OPERATION_ID],
    };
    const capsule = buildDiagnosticCapsule({
      diagnostic_id: deterministic.diagnostic_id,
      operation_id: OPERATION_ID,
      endpoint: ENDPOINT,
      method: request.method,
      failure_stage: 'internal',
      http_status: deterministic.status,
      trace_id: context.invocationId,
      safe_error: { code: 'oauth_metadata_failure', message: deterministic.detail },
      contract_summary: { required: [], properties: {} },
    });
    const problem = await resolveRepairableProblem({ deterministic, capsule, expected });
    return {
      status: problem.status,
      headers: { ...corsHeaders(request), 'Content-Type': 'application/problem+json' },
      jsonBody: problem,
    };
  }
}

app.http('oauthProtectedResource', {
  methods: ['GET', 'OPTIONS'],
  authLevel: 'anonymous',
  route: '.well-known/oauth-protected-resource',
  handler: oauthProtectedResourceHandler,
});

function corsHeaders(request?: HttpRequest): Record<string, string> {
  return createCorsHeaders(request, corsOptions);
}

function protectedResourceProblem(
  status: number,
  classification: 'security_suspicious' | 'diagnostic_uncertain',
  title: string,
  detail: string,
  traceId?: string,
): RepairableProblem {
  return buildDeterministicRepairableProblem({
    operationId: OPERATION_ID,
    status,
    endpoint: ENDPOINT,
    classification,
    title,
    detail,
    callerInstruction:
      classification === 'security_suspicious'
        ? 'Use the configured canonical MCP resource origin. Do not retry with alternate host, scheme, or forwarded-origin values.'
        : 'Retry later without inventing metadata fields, and report the diagnostic ID if discovery remains unavailable.',
    safeDebugSummary: `OAuth protected-resource metadata failure; http_status=${status}; no request headers, credentials, or runtime settings included.`,
    repairable: false,
    retryPolicy: { can_retry: false, same_request: false },
    traceId,
    repairPlan: [
      { action: 'report_diagnostic_id', reason: 'The service owner must inspect the protected-resource setup.' },
    ],
    confidence: classification === 'diagnostic_uncertain' ? 0.5 : 0.99,
    analysisMode: classification === 'diagnostic_uncertain' ? 'fallback' : 'deterministic',
  });
}
