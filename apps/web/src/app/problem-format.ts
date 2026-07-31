import { formatBody } from './request-builder';

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
  diagnostic_id?: string;
  retry_policy?: RetryPolicy;
  repair_patch?: unknown[];
  repair_plan?: unknown[];
  caller_instruction?: string;
  safe_debug_summary?: string;
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
  'diagnostic_id',
  'retry_policy',
  'repair_patch',
  'repair_plan',
  'caller_instruction',
  'safe_debug_summary',
] as const;

export function formatProblemResponse(body: unknown, fallbackStatus: number): SafeProblemView | null {
  if (!isJsonObject(body)) {
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
  return `API returned ${status}: ${formatBody(body)}`;
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
