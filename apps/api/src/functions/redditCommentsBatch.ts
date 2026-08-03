import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { logSmokeRunId } from '../shared/smokeCorrelation.js';
import { analyzeRepairableErrorWithLlm } from '../shared/errors/llmDiagnosticAnalyzer.js';
import { resolveRepairableProblem } from '../shared/errors/repairableErrorService.js';
import {
  buildRedditDiagnosticCapsule,
  getTraceIdFromRequestOrContext,
  type DiagnosticCapsule,
} from '../shared/errors/diagnosticCapsule.js';
import {
  buildFallbackRepairableProblem,
  createDiagnosticId,
  type RepairableProblem,
  type RepairableProblemExpected,
} from '../shared/errors/repairableProblem.js';
import { mapRedditError, RedditThreadService } from '../shared/reddit/service.js';
import type { RedditCommentsBatchRequest } from '../shared/reddit/types.js';
import { authorizeRequestForOperation } from '../shared/security/auth.js';
import { OPERATION_IDS } from '../application/operations/registry.js';
import { createCorsHeaders, withCorsHeaders, type CorsOptions } from '../shared/http/cors.js';
import { BodyTooLargeError, readRequestJsonWithLimit } from '../shared/http/boundedBody.js';

const OPERATION_ID = 'postRedditCommentsBatch';
const ENDPOINT = '/api/reddit/comments/batch';
const ALLOWED_REQUEST_FIELDS = [
  'ids',
  'fields',
  'maxBytes',
  'post',
  'url',
  'redditUrl',
  'reddit_url',
  'threadUrl',
  'thread_url',
];
const ALLOWED_OPERATION_IDS = [OPERATION_ID];
const REQUEST_BODY_MAX_BYTES = 64 * 1024;

let redditThreadService = new RedditThreadService();
let repairableErrorAnalyzer = analyzeRepairableErrorWithLlm;

export async function redditCommentsBatchHandler(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  logSmokeRunId(request, context, 'redditCommentsBatch');

  if (request.method === 'OPTIONS') return { status: 204, headers: corsHeaders(request) };

  const authorization = await authorizeRequestForOperation(request, context, OPERATION_IDS.redditCommentsBatch);
  if (!authorization.ok) return withCors(authorization.response, request);

  const traceId = getTraceIdFromRequestOrContext(request, context);
  let body: RedditCommentsBatchRequest;
  try {
    body = (await readRequestJsonWithLimit(request, REQUEST_BODY_MAX_BYTES)) as RedditCommentsBatchRequest;
  } catch (error) {
    const tooLarge = error instanceof BodyTooLargeError;
    const problem = await problemForRedditError({
      request,
      context,
      traceId,
      diagnosticId: createDiagnosticId(),
      status: tooLarge ? 413 : 400,
      failureStage: tooLarge ? 'input_validation' : 'json_parse',
      safeError: tooLarge
        ? { code: 'REQUEST_BODY_TOO_LARGE', message: 'Request body exceeds the allowed size.' }
        : { code: 'INVALID_JSON', message: 'Request body must be valid JSON.' },
    });
    return problemResponse(problem, request);
  }

  try {
    const response = await redditThreadService.fetchCommentsBatch(body);
    return withCors({ status: 200, jsonBody: response }, request);
  } catch (error) {
    const mapped = mapRedditError(error);
    const diagnosticId = createDiagnosticId();
    const problem = await problemForRedditError({
      request,
      context,
      traceId,
      diagnosticId,
      status: mapped.status,
      failureStage: failureStageForStatus(mapped.status),
      safeError: { code: mapped.code, message: mapped.message },
      errorKind: mapped.kind,
      body,
    });

    if (problem.status >= 500) {
      context.warn('Reddit comments-batch fetch failed with a repairable error contract.', {
        operation_id: problem.operation_id,
        diagnostic_id: problem.diagnostic_id,
        classification: problem.classification,
        status: problem.status,
        safe_debug_summary: problem.safe_debug_summary,
      });
    }

    return problemResponse(problem, request);
  }
}

export function setRedditCommentsBatchServiceForTesting(service: RedditThreadService | null): void {
  redditThreadService = service ?? new RedditThreadService();
}

export function setRepairableErrorAnalyzerForTesting(analyzer: typeof analyzeRepairableErrorWithLlm | null): void {
  repairableErrorAnalyzer = analyzer ?? analyzeRepairableErrorWithLlm;
}

app.http('redditCommentsBatch', {
  methods: ['POST', 'OPTIONS'],
  authLevel: 'anonymous',
  route: 'api/reddit/comments/batch',
  handler: redditCommentsBatchHandler,
});

async function problemForRedditError(args: {
  request: HttpRequest;
  context: InvocationContext;
  traceId?: string;
  diagnosticId: string;
  status: number;
  failureStage: DiagnosticCapsule['failure_stage'];
  safeError: DiagnosticCapsule['safe_error'];
  body?: unknown;
  errorKind?: 'input' | 'content' | 'upstream' | 'fetch' | 'config' | 'internal';
}): Promise<RepairableProblem> {
  const capsule = buildRedditDiagnosticCapsule({
    diagnostic_id: args.diagnosticId,
    operation_id: OPERATION_ID,
    endpoint: ENDPOINT,
    method: args.request.method,
    failure_stage: args.failureStage,
    http_status: args.status,
    trace_id: args.traceId,
    safe_error: args.safeError,
    body: args.body,
  });
  const expected: RepairableProblemExpected = {
    operation_id: OPERATION_ID,
    diagnostic_id: args.diagnosticId,
    status: args.status,
    allowedRequestFields: ALLOWED_REQUEST_FIELDS,
    allowedOperationIds: ALLOWED_OPERATION_IDS,
  };

  const deterministic = buildFallbackRepairableProblem({
    operation_id: OPERATION_ID,
    diagnostic_id: args.diagnosticId,
    status: args.status,
    endpoint: ENDPOINT,
    trace_id: args.traceId,
    safe_error: args.safeError,
    failure_stage: args.failureStage,
    error_kind: args.errorKind,
  });
  return resolveRepairableProblem({ deterministic, capsule, expected, analyzer: repairableErrorAnalyzer });
}

function problemResponse(problem: RepairableProblem, request: HttpRequest): HttpResponseInit {
  return withCors(
    { status: problem.status, headers: { 'Content-Type': 'application/problem+json' }, jsonBody: problem },
    request,
  );
}

function failureStageForStatus(status: number): DiagnosticCapsule['failure_stage'] {
  if (status === 400) return 'input_validation';
  if (status === 403 || status === 404 || status === 429) return 'upstream';
  if (status >= 500) return 'dependency';
  return 'unknown';
}

const corsOptions = { methods: ['POST', 'OPTIONS'] } satisfies CorsOptions;

function withCors(response: HttpResponseInit, request?: HttpRequest): HttpResponseInit {
  return withCorsHeaders(request, response, corsOptions);
}

function corsHeaders(request?: HttpRequest): Record<string, string> {
  return createCorsHeaders(request, corsOptions);
}
