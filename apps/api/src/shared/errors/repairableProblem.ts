import { randomBytes } from 'node:crypto';
export type RepairableErrorClassification =
  | 'caller_contract_violation'
  | 'semantic_precondition_missing'
  | 'resource_not_found'
  | 'authorization_context_mismatch'
  | 'version_skew'
  | 'dependency_failure'
  | 'capacity_or_timeout'
  | 'service_bug_likely'
  | 'internal_error'
  | 'security_suspicious'
  | 'diagnostic_uncertain';

export type AnalysisMode = 'deterministic' | 'llm_assisted' | 'hybrid' | 'fallback';

export interface RetryPolicy {
  can_retry: boolean;
  same_request: boolean;
  retry_after_ms?: number;
  idempotency_required?: boolean;
}

export interface InvalidField {
  path: string;
  problem: string;
  expected?: string;
  received?: string;
  suggestion?: string;
}

export interface RepairPlanStep {
  action:
    | 'provide_missing_value'
    | 'replace_invalid_value'
    | 'remove_unknown_field'
    | 'call_prerequisite_operation'
    | 'retry_with_modified_request'
    | 'retry_later'
    | 'do_not_change_request'
    | 'report_diagnostic_id';
  path?: string;
  value_hint?: string;
  operation_id?: string;
  reason: string;
}

export interface RepairableProblem {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  rec_version: '1.0';
  operation_id: string;
  diagnostic_id: string;
  trace_id?: string;
  classification: RepairableErrorClassification;
  repairable: boolean;
  confidence: number;
  retry_policy: RetryPolicy;
  invalid_fields?: InvalidField[];
  repair_patch?: Array<
    | { op: 'add'; path: string; value: unknown }
    | { op: 'remove'; path: string }
    | { op: 'replace'; path: string; value: unknown }
    | { op: 'move'; from: string; path: string }
    | { op: 'copy'; from: string; path: string }
    | { op: 'test'; path: string; value: unknown }
  >;
  repair_plan?: RepairPlanStep[];
  correct_request_example?: unknown;
  caller_instruction: string;
  llm_instruction?: string;
  safe_debug_summary: string;
  analysis_mode: AnalysisMode;
}

export interface RepairableProblemExpected {
  operation_id: string;
  diagnostic_id: string;
  status: number;
  allowedRequestFields: string[];
  allowedOperationIds: string[];
}

export interface RepairableProblemPolicy {
  allowedRequestFields: string[];
  allowedOperationIds: string[];
}

const CLASSIFICATIONS: readonly RepairableErrorClassification[] = [
  'caller_contract_violation',
  'semantic_precondition_missing',
  'resource_not_found',
  'authorization_context_mismatch',
  'version_skew',
  'dependency_failure',
  'capacity_or_timeout',
  'service_bug_likely',
  'internal_error',
  'security_suspicious',
  'diagnostic_uncertain',
] as const;

const ANALYSIS_MODES: readonly AnalysisMode[] = ['deterministic', 'llm_assisted', 'hybrid', 'fallback'] as const;
const REPAIR_PLAN_ACTIONS = new Set<RepairPlanStep['action']>([
  'provide_missing_value',
  'replace_invalid_value',
  'remove_unknown_field',
  'call_prerequisite_operation',
  'retry_with_modified_request',
  'retry_later',
  'do_not_change_request',
  'report_diagnostic_id',
]);
const PATCH_OPS = new Set(['add', 'remove', 'replace', 'move', 'copy', 'test']);

const REPAIRABLE_PROBLEM_KEYS = new Set([
  'type',
  'title',
  'status',
  'detail',
  'instance',
  'rec_version',
  'operation_id',
  'diagnostic_id',
  'trace_id',
  'classification',
  'repairable',
  'confidence',
  'retry_policy',
  'invalid_fields',
  'repair_patch',
  'repair_plan',
  'correct_request_example',
  'caller_instruction',
  'llm_instruction',
  'safe_debug_summary',
  'analysis_mode',
]);

const UNSAFE_RESPONSE_PATTERNS = [
  /\bAuthorization\s*:/i,
  /Bearer/i,
  /access_token/i,
  /refresh_token/i,
  /client_secret/i,
  /process\.env/i,
  /(^|\n)\s*at\s+\S+/,
  /raw\s+upstream\s+response\s+body/i,
  /upstream\s+response\s+body/i,
];

export const repairableProblemJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'type',
    'title',
    'status',
    'detail',
    'instance',
    'rec_version',
    'operation_id',
    'diagnostic_id',
    'classification',
    'repairable',
    'confidence',
    'retry_policy',
    'caller_instruction',
    'safe_debug_summary',
    'analysis_mode',
  ],
  properties: {
    type: { type: 'string', maxLength: 160 },
    title: { type: 'string', maxLength: 120 },
    status: { type: 'integer', minimum: 400, maximum: 599 },
    detail: { type: 'string', maxLength: 700 },
    instance: { type: 'string', maxLength: 220 },
    rec_version: { const: '1.0' },
    operation_id: { type: 'string', maxLength: 80 },
    diagnostic_id: { type: 'string', maxLength: 80 },
    trace_id: { type: 'string', maxLength: 120 },
    classification: { type: 'string', enum: CLASSIFICATIONS },
    repairable: { type: 'boolean' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    retry_policy: {
      type: 'object',
      additionalProperties: false,
      required: ['can_retry', 'same_request'],
      properties: {
        can_retry: { type: 'boolean' },
        same_request: { type: 'boolean' },
        retry_after_ms: { type: 'integer', minimum: 0, maximum: 3_600_000 },
        idempotency_required: { type: 'boolean' },
      },
    },
    invalid_fields: {
      type: 'array',
      maxItems: 10,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'problem'],
        properties: {
          path: { type: 'string', maxLength: 80 },
          problem: { type: 'string', maxLength: 240 },
          expected: { type: 'string', maxLength: 240 },
          received: { type: 'string', maxLength: 160 },
          suggestion: { type: 'string', maxLength: 240 },
        },
      },
    },
    repair_patch: { type: 'array', maxItems: 6, items: { type: 'object' } },
    repair_plan: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['action', 'reason'],
        properties: {
          action: { type: 'string', enum: [...REPAIR_PLAN_ACTIONS] },
          path: { type: 'string', maxLength: 80 },
          value_hint: { type: 'string', maxLength: 240 },
          operation_id: { type: 'string', maxLength: 80 },
          reason: { type: 'string', maxLength: 300 },
        },
      },
    },
    correct_request_example: {},
    caller_instruction: { type: 'string', maxLength: 700 },
    llm_instruction: { type: 'string', maxLength: 700 },
    safe_debug_summary: { type: 'string', maxLength: 700 },
    analysis_mode: { type: 'string', enum: ANALYSIS_MODES },
  },
} as const;

export function createDiagnosticId(): string {
  return `diag_${randomBytes(12).toString('hex')}`;
}

export function validateRepairableProblem(
  value: unknown,
  expected: RepairableProblemExpected,
): RepairableProblem | null {
  if (!isRecord(value)) return null;
  if (Object.keys(value).some((key) => !REPAIRABLE_PROBLEM_KEYS.has(key))) return null;
  if (value.rec_version !== '1.0') return null;
  if (value.status !== expected.status) return null;
  if (value.operation_id !== expected.operation_id) return null;
  if (value.diagnostic_id !== expected.diagnostic_id) return null;
  if (!expected.allowedOperationIds.includes(String(value.operation_id))) return null;
  if (!CLASSIFICATIONS.includes(value.classification as RepairableErrorClassification)) return null;
  if (!ANALYSIS_MODES.includes(value.analysis_mode as AnalysisMode)) return null;
  if (typeof value.repairable !== 'boolean') return null;
  if (typeof value.confidence !== 'number' || value.confidence < 0 || value.confidence > 1) return null;

  const stringFields: Array<[string, number]> = [
    ['type', 160],
    ['title', 120],
    ['detail', 700],
    ['instance', 220],
    ['operation_id', 80],
    ['diagnostic_id', 80],
    ['caller_instruction', 700],
    ['safe_debug_summary', 700],
  ];
  if (value.trace_id !== undefined) stringFields.push(['trace_id', 120]);
  if (value.llm_instruction !== undefined) stringFields.push(['llm_instruction', 700]);
  for (const [field, maxLength] of stringFields) {
    if (typeof value[field] !== 'string' || value[field].length === 0 || value[field].length > maxLength) return null;
  }

  if (value.instance !== diagnosticInstance(expected.diagnostic_id)) return null;

  if (!isRecord(value.retry_policy)) return null;
  if (typeof value.retry_policy.can_retry !== 'boolean' || typeof value.retry_policy.same_request !== 'boolean')
    return null;
  if (!value.retry_policy.can_retry && value.retry_policy.same_request) return null;
  if (
    value.retry_policy.retry_after_ms !== undefined &&
    (!Number.isInteger(value.retry_policy.retry_after_ms) ||
      value.retry_policy.retry_after_ms < 0 ||
      value.retry_policy.retry_after_ms > 3_600_000)
  ) {
    return null;
  }
  if (
    value.retry_policy.idempotency_required !== undefined &&
    typeof value.retry_policy.idempotency_required !== 'boolean'
  )
    return null;

  if (value.invalid_fields !== undefined) {
    if (!Array.isArray(value.invalid_fields) || value.invalid_fields.length > 10) return null;
    for (const field of value.invalid_fields) {
      if (!isRecord(field) || !isAllowedPath(field.path, expected.allowedRequestFields)) return null;
      if (!boundedOptionalString(field.problem, 240, true)) return null;
      if (!boundedOptionalString(field.expected, 240)) return null;
      if (!boundedOptionalString(field.received, 160)) return null;
      if (!boundedOptionalString(field.suggestion, 240)) return null;
    }
  }

  if (value.repair_patch !== undefined) {
    if (!Array.isArray(value.repair_patch) || value.repair_patch.length > 6) return null;
    for (const op of value.repair_patch) {
      if (
        !isRecord(op) ||
        !PATCH_OPS.has(String(op.op)) ||
        !isAllowedJsonPointerPath(op.path, expected.allowedRequestFields)
      )
        return null;
      if ((op.op === 'move' || op.op === 'copy') && !isAllowedJsonPointerPath(op.from, expected.allowedRequestFields))
        return null;
    }
  }

  if (value.repair_plan !== undefined) {
    if (!Array.isArray(value.repair_plan) || value.repair_plan.length > 8) return null;
    for (const step of value.repair_plan) {
      if (!isRecord(step) || !REPAIR_PLAN_ACTIONS.has(step.action as RepairPlanStep['action'])) return null;
      if (step.path !== undefined && !isAllowedPath(step.path, expected.allowedRequestFields)) return null;
      if (step.operation_id !== undefined && !expected.allowedOperationIds.includes(String(step.operation_id)))
        return null;
      if (!boundedOptionalString(step.value_hint, 240)) return null;
      if (!boundedOptionalString(step.reason, 300, true)) return null;
    }
  }

  if (containsUnsafeString(value)) return null;
  return value as RepairableProblem;
}

export function sanitizeRepairableProblem(
  problem: RepairableProblem,
  policy: RepairableProblemPolicy,
): RepairableProblem | null {
  const expected = {
    operation_id: problem.operation_id,
    diagnostic_id: problem.diagnostic_id,
    status: problem.status,
    allowedRequestFields: policy.allowedRequestFields,
    allowedOperationIds: policy.allowedOperationIds,
  };
  if (!validateRepairableProblem(problem, expected)) return null;
  if (problem.repair_plan?.some((step) => step.operation_id && !policy.allowedOperationIds.includes(step.operation_id)))
    return null;
  return problem;
}

export function buildFallbackRepairableProblem(args: {
  operation_id: string;
  diagnostic_id: string;
  status: number;
  endpoint: string;
  trace_id?: string;
  safe_error?: { code?: string; message?: string; original_status?: number };
  failure_stage?: string;
  error_kind?: 'input' | 'content' | 'upstream' | 'fetch' | 'config' | 'internal';
}): RepairableProblem {
  const code = args.safe_error?.code;
  const isShareUrl = code === 'UNRESOLVED_REDDIT_SHARE_URL' || code === 'REDDIT_SHARE_RESOLUTION_BLOCKED';
  const status = args.status;
  let classification: RepairableErrorClassification = 'diagnostic_uncertain';
  let repairable = false;
  let retryPolicy: RetryPolicy = { can_retry: false, same_request: false };
  let title = 'Request could not be completed';
  let detail = args.safe_error?.message ?? 'The request could not be completed.';
  let callerInstruction = 'Do not expose internals. Report the diagnostic_id if this persists.';
  let repair_plan: RepairPlanStep[] | undefined;
  let invalid_fields: InvalidField[] | undefined;
  let correct_request_example: unknown;

  if (status === 413) {
    classification = 'caller_contract_violation';
    repairable = true;
    retryPolicy = { can_retry: true, same_request: false, idempotency_required: false };
    title = 'Request body too large';
    callerInstruction = 'Reduce the JSON request body to the documented byte limit and retry.';
    repair_plan = [
      {
        action: 'retry_with_modified_request',
        reason: 'The request body exceeded the endpoint byte limit before JSON parsing.',
      },
    ];
  } else if (status === 400) {
    classification = 'caller_contract_violation';
    repairable = true;
    retryPolicy = { can_retry: true, same_request: false, idempotency_required: false };
    title = 'Request contract violation';
    callerInstruction =
      'Send valid JSON with a post field containing a Reddit article ID, t3 fullname, redd.it URL, or canonical reddit.com /comments/<id> URL.';
    invalid_fields = [
      { path: '/post', problem: 'The Reddit thread request must include a valid post value.', expected: 'string' },
    ];
    correct_request_example = { post: 'abc123', sort: 'confidence', maxComments: 10000, maxMoreChildrenRequests: 0 };
    repair_plan = [
      {
        action: 'provide_missing_value',
        path: '/post',
        value_hint: 'Reddit article ID, t3 fullname, redd.it URL, or canonical /comments/<id> URL',
        reason: 'The endpoint needs a post identifier to fetch a thread.',
      },
    ];
    if (isShareUrl) {
      detail =
        'Reddit /s/ share URLs must resolve to a canonical comments URL before this endpoint can fetch the thread.';
      callerInstruction =
        'Do not retry the same /s/ share URL. Use a canonical reddit.com /comments/<id> URL, redd.it URL, t3 fullname, or raw post ID instead.';
      repair_plan = [
        {
          action: 'replace_invalid_value',
          path: '/post',
          value_hint: 'canonical /comments/<id> URL, redd.it URL, t3 fullname, or raw post ID',
          reason: 'The /s/ share URL could not be resolved deterministically.',
        },
      ];
    }
  } else if (status === 403) {
    classification = 'authorization_context_mismatch';
    title = 'Reddit content is inaccessible';
    callerInstruction = 'Do not retry the same request unless the Reddit content access context changes.';
  } else if (status === 404) {
    classification = 'resource_not_found';
    repairable = true;
    retryPolicy = { can_retry: true, same_request: false, idempotency_required: false };
    title = 'Reddit content was not found';
    callerInstruction =
      'Check that post references an existing public Reddit thread and retry with the corrected identifier or canonical URL.';
  } else if (status === 429) {
    classification = 'capacity_or_timeout';
    retryPolicy = { can_retry: true, same_request: true, retry_after_ms: 30_000, idempotency_required: false };
    title = 'Reddit rate limit reached';
    callerInstruction =
      'Retry later with the same request. Do not change request parameters solely to bypass rate limiting.';
    repair_plan = [{ action: 'retry_later', reason: 'The upstream service asked callers to slow down.' }];
  } else if (status >= 500) {
    if (args.error_kind === 'internal' || args.error_kind === 'config') {
      classification = 'service_bug_likely';
      retryPolicy = { can_retry: true, same_request: true, idempotency_required: false };
      title = 'Service bug likely';
      detail = 'The request could not be completed because the service hit an unexpected internal failure.';
      callerInstruction =
        'Retry later with the same request if appropriate. Do not invent request parameters; report the diagnostic_id to the service owner if this persists.';
      repair_plan = [
        {
          action: 'report_diagnostic_id',
          reason:
            'The failure appears to be inside the service rather than in the caller request or Reddit dependency.',
        },
      ];
    } else {
      classification = 'dependency_failure';
      retryPolicy = { can_retry: true, same_request: true, idempotency_required: false };
      title = 'Reddit dependency failure';
      callerInstruction =
        'Retry later with the same request. Do not invent alternative request parameters for this upstream failure.';
      repair_plan = [
        {
          action: 'retry_later',
          reason: 'The failure happened while contacting or processing the upstream Reddit dependency.',
        },
      ];
    }
  }

  return {
    type: `https://api.juez.local/problems/reddit-thread/${classification}`,
    title,
    status,
    detail,
    instance: diagnosticInstance(args.diagnostic_id),
    rec_version: '1.0',
    operation_id: args.operation_id,
    diagnostic_id: args.diagnostic_id,
    ...(args.trace_id ? { trace_id: args.trace_id } : {}),
    classification,
    repairable,
    confidence: isShareUrl || status === 400 || status === 413 ? 0.82 : 0.68,
    retry_policy: retryPolicy,
    ...(invalid_fields ? { invalid_fields } : {}),
    ...(repair_plan ? { repair_plan } : {}),
    ...(correct_request_example ? { correct_request_example } : {}),
    caller_instruction: callerInstruction,
    llm_instruction: callerInstruction,
    safe_debug_summary: `Fallback repairable error for ${args.operation_id} at stage ${args.failure_stage ?? 'unknown'} with status ${status}${code ? ` and code ${code}` : ''}.`,
    analysis_mode: classification === 'diagnostic_uncertain' ? 'fallback' : 'deterministic',
  };
}

function boundedOptionalString(value: unknown, maxLength: number, required = false): boolean {
  if (value === undefined) return !required;
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function diagnosticInstance(diagnosticId: string): string {
  return `urn:diagnostic:${diagnosticId}`;
}

function isAllowedPath(path: unknown, allowedFields: string[]): boolean {
  return normalizeDiagnosticPath(path, allowedFields) !== null;
}

function isAllowedJsonPointerPath(path: unknown, allowedFields: string[]): boolean {
  if (typeof path !== 'string' || path.length === 0 || path.length > 80) return false;
  if (!path.startsWith('/')) return false;
  const field = path.slice(1);
  if (!isSafeTopLevelFieldPath(field)) return false;
  return allowedFields.includes(field);
}

function normalizeDiagnosticPath(path: unknown, allowedFields: string[]): string | null {
  if (typeof path !== 'string' || path.length === 0 || path.length > 80) return null;
  let field = path;
  if (path.startsWith('/')) {
    field = path.slice(1);
  } else if (path.startsWith('$.')) {
    field = path.slice(2);
  }
  if (!isSafeTopLevelFieldPath(field)) return null;
  return allowedFields.includes(field) ? field : null;
}

function isSafeTopLevelFieldPath(field: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(field)) return false;
  return !/(^|[_-])(access[_-]?token|refresh[_-]?token|id[_-]?token|authorization|cookie|set-cookie|client[_-]?secret|secret|password|api[_-]?key|apikey|token)([_-]|$)/i.test(
    field,
  );
}

function containsUnsafeString(value: unknown): boolean {
  if (typeof value === 'string') return UNSAFE_RESPONSE_PATTERNS.some((pattern) => pattern.test(value));
  if (Array.isArray(value)) return value.some(containsUnsafeString);
  if (isRecord(value)) return Object.values(value).some(containsUnsafeString);
  return false;
}

function isRecord(value: unknown): value is any {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
