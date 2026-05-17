import type { HttpRequest, InvocationContext } from '@azure/functions';

const HEADER_NAME = 'x-smoke-run-id';
const MAX_SMOKE_RUN_ID_LENGTH = 96;

export function sanitizeSmokeRunId(value: string | undefined | null): string | undefined {
  const normalized = (value ?? '').trim();
  if (!normalized) return undefined;
  const sanitized = normalized.replace(/[^A-Za-z0-9_.:-]/g, '-').replace(/-+/g, '-').slice(0, MAX_SMOKE_RUN_ID_LENGTH);
  return sanitized || undefined;
}

export function getSmokeRunId(request: HttpRequest): string | undefined {
  return sanitizeSmokeRunId(request.headers.get(HEADER_NAME));
}

export function logSmokeRunId(request: HttpRequest, context: InvocationContext, operation: string): string | undefined {
  const smokeRunId = getSmokeRunId(request);
  if (smokeRunId) {
    context.info('Smoke correlation received.', {
      operation,
      smoke_run_id: smokeRunId,
    });
  }
  return smokeRunId;
}
