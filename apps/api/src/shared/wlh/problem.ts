import type { HttpResponseInit } from '@azure/functions';
import {
  createDiagnosticId,
  sanitizeRepairableProblem,
  validateRepairableProblem,
  type InvalidField,
  type RepairPlanStep,
  type RepairableErrorClassification,
  type RepairableProblem,
  type RepairableProblemExpected,
  type RetryPolicy,
} from '../errors/repairableProblem.js';
import { buildDiagnosticCapsule } from '../errors/diagnosticCapsule.js';
import { resolveRepairableProblem } from '../errors/repairableErrorService.js';
import { AUTHENTICATED_PROVIDER_JSON_BODY_MAX_BYTES } from '../http/boundedBody.js';
import { WlhFetchError } from './client.js';
import { WlhInputError } from './input.js';
import { WlhNotFoundError } from './service.js';

export const WLH_OPERATION_IDS = {
  postWlhSearch: 'postWlhSearch',
  getWlhCategoriesTop: 'getWlhCategoriesTop',
  getWlhCategory: 'getWlhCategory',
  getWlhCategoryChildren: 'getWlhCategoryChildren',
  getWlhOffer: 'getWlhOffer',
  getWlhOfferImages: 'getWlhOfferImages',
} as const;

export type WlhOperationId = (typeof WLH_OPERATION_IDS)[keyof typeof WLH_OPERATION_IDS];

export const WLH_ENDPOINTS: Record<WlhOperationId, string> = {
  postWlhSearch: '/api/wlh/search',
  getWlhCategoriesTop: '/api/wlh/categories/top',
  getWlhCategory: '/api/wlh/categories/{categoryId}',
  getWlhCategoryChildren: '/api/wlh/categories/{categoryId}/children',
  getWlhOffer: '/api/wlh/offers/{adId}',
  getWlhOfferImages: '/api/wlh/offers/{adId}/images',
};

const SEARCH_FIELDS = [
  'keyword',
  'categoryId',
  'priceFrom',
  'priceTo',
  'areaId',
  'paylivery',
  'rows',
  'page',
  'condition',
  'delivery',
  'requiredTerms',
];
const CATEGORY_FIELDS = ['categoryId'];
const OFFER_FIELDS = ['adId'];
const NO_REQUEST_FIELDS: string[] = [];
const ALL_OPERATION_IDS = Object.values(WLH_OPERATION_IDS);

export type WlhFailureKind =
  | 'invalid_json'
  | 'body_too_large'
  | 'input_validation'
  | 'category_not_found'
  | 'upstream_rate_limited'
  | 'upstream_fetch_failure'
  | 'upstream_parse_failure'
  | 'internal_config_failure'
  | 'internal_failure';

export interface WlhProblemInput {
  operationId: WlhOperationId;
  status?: number;
  failureKind: WlhFailureKind;
  message?: string;
  field?: string;
  traceId?: string;
  diagnosticId?: string;
}

export function wlhProblemForError(args: {
  operationId: WlhOperationId;
  error: unknown;
  traceId?: string;
  diagnosticId?: string;
}): RepairableProblem {
  const mapped = classifyWlhError(args.error);
  return buildWlhProblem({
    operationId: args.operationId,
    traceId: args.traceId,
    diagnosticId: args.diagnosticId,
    ...mapped,
  });
}

export async function resolveWlhProblemForError(args: {
  operationId: WlhOperationId;
  error: unknown;
  traceId?: string;
  body?: unknown;
}): Promise<RepairableProblem> {
  const mapped = classifyWlhError(args.error);
  const deterministic = buildWlhProblem({
    operationId: args.operationId,
    traceId: args.traceId,
    ...mapped,
  });
  const allowedRequestFields = allowedFieldsForOperation(args.operationId);
  const expected = {
    operation_id: args.operationId,
    diagnostic_id: deterministic.diagnostic_id,
    status: deterministic.status,
    allowedRequestFields,
    allowedOperationIds: ALL_OPERATION_IDS,
  };
  const capsule = buildDiagnosticCapsule({
    diagnostic_id: deterministic.diagnostic_id,
    operation_id: args.operationId,
    endpoint: WLH_ENDPOINTS[args.operationId],
    method: args.operationId === WLH_OPERATION_IDS.postWlhSearch ? 'POST' : 'GET',
    failure_stage:
      deterministic.classification === 'diagnostic_uncertain'
        ? 'unknown'
        : deterministic.status >= 500
          ? 'dependency'
          : 'business_rule',
    http_status: deterministic.status,
    trace_id: args.traceId,
    safe_error: { code: mapped.failureKind.toUpperCase(), message: deterministic.detail },
    body: args.body,
    contract_summary: {
      required: requiredFieldsForOperation(args.operationId),
      properties: Object.fromEntries(allowedRequestFields.map((field) => [field, { documented: true }])),
    },
  });
  return resolveRepairableProblem({ deterministic, capsule, expected });
}

export function buildWlhProblem(input: WlhProblemInput): RepairableProblem {
  const diagnosticId = input.diagnosticId ?? createDiagnosticId();
  const allowedRequestFields = allowedFieldsForOperation(input.operationId);
  const expected: RepairableProblemExpected = {
    operation_id: input.operationId,
    diagnostic_id: diagnosticId,
    status: statusForFailure(input.failureKind, input.status),
    allowedRequestFields,
    allowedOperationIds: ALL_OPERATION_IDS,
  };
  const classification = classificationForFailure(input.failureKind);
  const retryPolicy = retryPolicyForFailure(input.failureKind);
  const field = normalizedField(input.field, allowedRequestFields, input.failureKind);
  const invalidFields = invalidFieldsForFailure(input.failureKind, field);
  const repairPlan = repairPlanForFailure(input.failureKind, field);
  const detail = detailForFailure(input.failureKind, input.message);
  const callerInstruction = callerInstructionForFailure(input.failureKind, field);

  const candidate: RepairableProblem = {
    type: `https://api.juez.local/problems/wlh/${classification}`,
    title: titleForFailure(input.failureKind),
    status: expected.status,
    detail,
    instance: `urn:diagnostic:${diagnosticId}`,
    rec_version: '1.0',
    operation_id: input.operationId,
    diagnostic_id: diagnosticId,
    ...(input.traceId ? { trace_id: input.traceId } : {}),
    classification,
    repairable: repairableForFailure(input.failureKind),
    confidence: confidenceForFailure(input.failureKind),
    retry_policy: retryPolicy,
    ...(invalidFields ? { invalid_fields: invalidFields } : {}),
    ...(repairPlan ? { repair_plan: repairPlan } : {}),
    ...(input.operationId === WLH_OPERATION_IDS.postWlhSearch && input.failureKind !== 'upstream_rate_limited'
      ? { correct_request_example: { categoryId: '10', rows: 30, page: 1, condition: 'used', delivery: ['pickup'] } }
      : {}),
    caller_instruction: callerInstruction,
    safe_debug_summary: safeSummaryForFailure(input.operationId, input.failureKind, expected.status),
    analysis_mode: classification === 'diagnostic_uncertain' ? 'fallback' : 'deterministic',
  };

  const validated = validateRepairableProblem(candidate, expected);
  const sanitized = validated
    ? sanitizeRepairableProblem(validated, { allowedRequestFields, allowedOperationIds: ALL_OPERATION_IDS })
    : null;
  if (!sanitized) {
    throw new Error('WLH deterministic repairable problem failed local validation.');
  }
  return sanitized;
}

export function wlhProblemResponse(problem: RepairableProblem, corsHeaders: Record<string, string>): HttpResponseInit {
  return {
    status: problem.status,
    headers: { ...corsHeaders, 'Content-Type': 'application/problem+json' },
    jsonBody: problem,
  };
}

function classifyWlhError(error: unknown): Omit<WlhProblemInput, 'operationId' | 'traceId' | 'diagnosticId'> {
  if (error instanceof WlhInputError) {
    return { failureKind: 'input_validation', status: 400, message: error.message, field: error.field };
  }
  if (error instanceof WlhNotFoundError) {
    return { failureKind: 'category_not_found', status: 404, message: 'Category was not found.', field: 'categoryId' };
  }
  if (error instanceof WlhFetchError) {
    if (error.status === 429)
      return { failureKind: 'upstream_rate_limited', status: 429, message: 'WLH rate limit reached.' };
    if (error.kind === 'parse')
      return { failureKind: 'upstream_parse_failure', status: 502, message: 'WLH page shape could not be parsed.' };
    if (error.kind === 'fetch')
      return { failureKind: 'upstream_fetch_failure', status: 502, message: 'WLH fetch failed.' };
    return { failureKind: 'upstream_fetch_failure', status: error.status, message: 'WLH upstream request failed.' };
  }
  if (error instanceof SyntaxError) {
    return { failureKind: 'upstream_parse_failure', status: 502, message: 'WLH page shape could not be parsed.' };
  }
  return { failureKind: 'internal_failure', status: 500, message: 'WLH request failed internally.' };
}

function statusForFailure(kind: WlhFailureKind, status?: number): number {
  if (status) return status;
  if (kind === 'body_too_large') return 413;
  if (kind === 'invalid_json' || kind === 'input_validation') return 400;
  if (kind === 'category_not_found') return 404;
  if (kind === 'upstream_rate_limited') return 429;
  if (kind === 'internal_config_failure' || kind === 'internal_failure') return 500;
  return 502;
}

function classificationForFailure(kind: WlhFailureKind): RepairableErrorClassification {
  if (
    kind === 'invalid_json' ||
    kind === 'body_too_large' ||
    kind === 'input_validation' ||
    kind === 'category_not_found'
  )
    return 'caller_contract_violation';
  if (kind === 'upstream_rate_limited') return 'capacity_or_timeout';
  if (kind === 'upstream_parse_failure') return 'version_skew';
  if (kind === 'internal_config_failure') return 'service_bug_likely';
  if (kind === 'internal_failure') return 'diagnostic_uncertain';
  return 'dependency_failure';
}

function retryPolicyForFailure(kind: WlhFailureKind): RetryPolicy {
  if (
    kind === 'invalid_json' ||
    kind === 'body_too_large' ||
    kind === 'input_validation' ||
    kind === 'category_not_found'
  ) {
    return { can_retry: true, same_request: false, idempotency_required: false };
  }
  if (kind === 'upstream_rate_limited') {
    return { can_retry: true, same_request: true, retry_after_ms: 30_000, idempotency_required: false };
  }
  if (kind === 'upstream_fetch_failure' || kind === 'upstream_parse_failure') {
    return { can_retry: true, same_request: true, idempotency_required: false };
  }
  return { can_retry: false, same_request: false };
}

function repairableForFailure(kind: WlhFailureKind): boolean {
  return (
    kind === 'invalid_json' || kind === 'body_too_large' || kind === 'input_validation' || kind === 'category_not_found'
  );
}

function confidenceForFailure(kind: WlhFailureKind): number {
  if (kind === 'invalid_json' || kind === 'body_too_large' || kind === 'input_validation') return 0.9;
  if (kind === 'category_not_found' || kind === 'upstream_rate_limited') return 0.84;
  if (kind === 'upstream_parse_failure') return 0.78;
  if (kind === 'internal_failure') return 0.5;
  return 0.72;
}

function titleForFailure(kind: WlhFailureKind): string {
  if (kind === 'body_too_large') return 'WLH request body is too large';
  if (kind === 'invalid_json' || kind === 'input_validation') return 'WLH request contract violation';
  if (kind === 'category_not_found') return 'WLH category was not found';
  if (kind === 'upstream_rate_limited') return 'WLH rate limit reached';
  if (kind === 'upstream_parse_failure') return 'WLH upstream layout changed';
  if (kind === 'upstream_fetch_failure') return 'WLH upstream dependency failure';
  return 'WLH internal failure';
}

function detailForFailure(kind: WlhFailureKind, message?: string): string {
  if (kind === 'invalid_json') return 'The WLH request body must be valid JSON.';
  if (kind === 'body_too_large')
    return `The WLH request body exceeds the ${AUTHENTICATED_PROVIDER_JSON_BODY_MAX_BYTES}-byte limit.`;
  if (kind === 'input_validation') return message ?? 'The WLH request did not match the endpoint contract.';
  if (kind === 'category_not_found')
    return 'The requested WLH categoryId does not exist in the current category index.';
  if (kind === 'upstream_rate_limited') return 'WLH asked callers to slow down before retrying.';
  if (kind === 'upstream_parse_failure')
    return 'WLH returned a page shape that the deterministic parser does not recognize.';
  if (kind === 'upstream_fetch_failure') return 'The API could not fetch the WLH upstream dependency.';
  return 'The API could not complete the WLH request because of an internal failure.';
}

function callerInstructionForFailure(kind: WlhFailureKind, field?: string): string {
  if (kind === 'invalid_json') return 'Send a syntactically valid JSON request body and retry.';
  if (kind === 'body_too_large')
    return `Reduce the JSON request body to ${AUTHENTICATED_PROVIDER_JSON_BODY_MAX_BYTES} bytes or fewer and retry.`;
  if (kind === 'input_validation')
    return `Correct the ${field ?? 'WLH request'} field according to the documented schema and retry.`;
  if (kind === 'category_not_found')
    return 'Call getWlhCategoriesTop or getWlhCategoryChildren to choose a current categoryId, then retry with that value.';
  if (kind === 'upstream_rate_limited')
    return 'Retry later with the same request. Do not change parameters solely to bypass rate limiting.';
  if (kind === 'upstream_parse_failure')
    return 'Retry later with the same request; if the problem persists, report the diagnostic_id because the WLH page shape may have changed.';
  if (kind === 'upstream_fetch_failure')
    return 'Retry later with the same request. Do not include raw upstream response bodies in client-visible diagnostics.';
  return 'Do not retry blindly. Report the diagnostic_id to the service owner if this persists.';
}

function invalidFieldsForFailure(kind: WlhFailureKind, field?: string): InvalidField[] | undefined {
  if (kind === 'invalid_json')
    return [
      {
        path: 'categoryId',
        problem: 'The request body was not valid JSON.',
        expected: 'JSON object matching WlhSearchRequest',
      },
    ];
  if (kind === 'input_validation' && field)
    return [{ path: field, problem: `The ${field} field is invalid or missing.`, expected: expectedForField(field) }];
  if (kind === 'category_not_found')
    return [
      {
        path: 'categoryId',
        problem: 'The categoryId was not found in the current WLH category index.',
        expected: 'categoryId from getWlhCategoriesTop or getWlhCategoryChildren',
      },
    ];
  return undefined;
}

function repairPlanForFailure(kind: WlhFailureKind, field?: string): RepairPlanStep[] | undefined {
  if (kind === 'invalid_json' || kind === 'body_too_large')
    return [
      {
        action: 'retry_with_modified_request',
        reason:
          kind === 'body_too_large'
            ? 'The request body exceeded the server-owned byte limit.'
            : 'The body must parse as JSON before the WLH search contract can be validated.',
      },
    ];
  if (kind === 'input_validation')
    return [
      {
        action: field === 'categoryId' ? 'provide_missing_value' : 'replace_invalid_value',
        ...(field ? { path: field } : {}),
        reason: 'The caller supplied a value outside the WLH request contract.',
      },
    ];
  if (kind === 'category_not_found')
    return [
      {
        action: 'call_prerequisite_operation',
        operation_id: WLH_OPERATION_IDS.getWlhCategoriesTop,
        path: 'categoryId',
        reason: 'A current category id is required before searching or reading category children.',
      },
    ];
  if (kind === 'upstream_rate_limited')
    return [{ action: 'retry_later', reason: 'The upstream WLH service is rate limiting requests.' }];
  if (kind === 'upstream_parse_failure' || kind === 'upstream_fetch_failure')
    return [{ action: 'retry_later', reason: 'The failure occurred while contacting or parsing the WLH dependency.' }];
  return [{ action: 'report_diagnostic_id', reason: 'The failure appears to be inside the API service.' }];
}

function expectedForField(field: string): string {
  switch (field) {
    case 'categoryId':
      return 'non-empty string from the WLH category index';
    case 'condition':
      return 'one of new, like_new, used, defect';
    case 'delivery':
      return 'array containing pickup and/or shipping';
    case 'rows':
      return 'integer from 1 through 100';
    case 'page':
      return 'integer greater than or equal to 1';
    default:
      return 'valid WLH request field';
  }
}

function safeSummaryForFailure(operationId: WlhOperationId, kind: WlhFailureKind, status: number): string {
  return `Deterministic WLH repairable error for ${operationId}; failure_kind=${kind}; http_status=${status}; no raw WLH HTML, upstream body, auth header, token, or sensitive request data included.`;
}

function normalizedField(field: string | undefined, allowedFields: string[], kind: WlhFailureKind): string | undefined {
  if (field && allowedFields.includes(field)) return field;
  if (kind === 'invalid_json' && allowedFields.includes('categoryId')) return 'categoryId';
  if (kind === 'category_not_found' && allowedFields.includes('categoryId')) return 'categoryId';
  return undefined;
}

function allowedFieldsForOperation(operationId: WlhOperationId): string[] {
  if (operationId === WLH_OPERATION_IDS.postWlhSearch) return SEARCH_FIELDS;
  if (operationId === WLH_OPERATION_IDS.getWlhCategory || operationId === WLH_OPERATION_IDS.getWlhCategoryChildren)
    return CATEGORY_FIELDS;
  if (operationId === WLH_OPERATION_IDS.getWlhOffer || operationId === WLH_OPERATION_IDS.getWlhOfferImages)
    return OFFER_FIELDS;
  return NO_REQUEST_FIELDS;
}

function requiredFieldsForOperation(operationId: WlhOperationId): string[] {
  if (operationId === WLH_OPERATION_IDS.postWlhSearch) return [];
  if (operationId === WLH_OPERATION_IDS.getWlhCategory || operationId === WLH_OPERATION_IDS.getWlhCategoryChildren)
    return ['categoryId'];
  if (operationId === WLH_OPERATION_IDS.getWlhOffer || operationId === WLH_OPERATION_IDS.getWlhOfferImages)
    return ['adId'];
  return [];
}
