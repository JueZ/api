export interface RetryPolicy {
  can_retry: boolean;
  same_request: boolean;
  retry_after_ms?: number;
  idempotency_required?: boolean;
}

export interface RepairableProblem {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  instance?: string;
  rec_version?: string;
  operation_id?: string;
  diagnostic_id?: string;
  classification?: string;
  repairable?: boolean;
  confidence?: number;
  retry_policy?: RetryPolicy;
  repair_patch?: unknown[];
  repair_plan?: unknown[];
  caller_instruction?: string;
  safe_debug_summary?: string;
  analysis_mode?: string;
}

export interface SafeProblemView {
  title: string;
  status: string;
  detail: string;
  callerInstruction: string;
  retryPolicy: string;
  repairPatch: string;
  repairPlan: string;
  diagnosticId: string;
  raw: RepairableProblem;
}

const SAFE_PROBLEM_KEYS = [
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
  'repair_patch',
  'repair_plan',
  'caller_instruction',
  'safe_debug_summary',
  'analysis_mode',
] as const;

export function formatProblemResponse(body: unknown, fallbackStatus: number): SafeProblemView | null {
  if (!isRepairableProblemShape(body, fallbackStatus)) {
    return null;
  }

  const safeProblem = Object.fromEntries(
    SAFE_PROBLEM_KEYS.filter((key) => body[key] !== undefined).map((key) => [key, body[key]]),
  ) as RepairableProblem;

  if (!safeProblem.title && !safeProblem.detail && !safeProblem.caller_instruction && !safeProblem.diagnostic_id) {
    return null;
  }

  return {
    title: safeString(safeProblem.title) || 'API problem response',
    status: String(safeProblem.status ?? fallbackStatus),
    detail: safeString(safeProblem.detail),
    callerInstruction: safeString(safeProblem.caller_instruction),
    retryPolicy: formatOptionalJson(safeProblem.retry_policy),
    repairPatch: formatOptionalJson(safeProblem.repair_patch),
    repairPlan: formatOptionalJson(safeProblem.repair_plan),
    diagnosticId: safeString(safeProblem.diagnostic_id),
    raw: safeProblem,
  };
}

export function formatApiError(status: number, body: unknown): string {
  const problem = formatProblemResponse(body, status);
  if (problem) {
    return `API returned ${problem.status}: ${problem.title}`;
  }
  return `API returned ${status}: response details were suppressed because they did not match the sanitized problem contract.`;
}

function formatOptionalJson(value: unknown): string {
  return value === undefined ? '' : JSON.stringify(value, null, 2);
}

function safeString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRepairableProblemShape(value: unknown, fallbackStatus: number): value is Record<string, unknown> {
  if (!isJsonObject(value) || !isJsonObject(value['retry_policy'])) return false;
  const retryPolicy = value['retry_policy'];
  return (
    typeof value['type'] === 'string' &&
    typeof value['title'] === 'string' &&
    Number.isInteger(value['status']) &&
    value['status'] === fallbackStatus &&
    typeof value['detail'] === 'string' &&
    typeof value['instance'] === 'string' &&
    value['rec_version'] === '1.0' &&
    typeof value['operation_id'] === 'string' &&
    typeof value['diagnostic_id'] === 'string' &&
    typeof value['classification'] === 'string' &&
    typeof value['repairable'] === 'boolean' &&
    typeof value['confidence'] === 'number' &&
    Number.isFinite(value['confidence']) &&
    typeof retryPolicy['can_retry'] === 'boolean' &&
    typeof retryPolicy['same_request'] === 'boolean' &&
    typeof value['caller_instruction'] === 'string' &&
    typeof value['safe_debug_summary'] === 'string' &&
    typeof value['analysis_mode'] === 'string'
  );
}
