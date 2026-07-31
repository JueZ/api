import { randomUUID } from 'node:crypto';

export const DEFAULT_SMOKE_FETCH_TIMEOUT_MS = 30_000;

export function sanitizeSmokeRunId(value) {
  const normalized = String(value ?? '').trim();
  if (!normalized) return undefined;
  return (
    normalized
      .replace(/[^A-Za-z0-9_.:-]/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 96) || undefined
  );
}

export function getSmokeRunId(value = process.env.SMOKE_RUN_ID) {
  return sanitizeSmokeRunId(value) ?? `smoke-${new Date().toISOString().replace(/[^0-9TZ]/g, '')}-${randomUUID()}`;
}

export function getSmokeFetchTimeoutMs(value = process.env.SMOKE_FETCH_TIMEOUT_MS) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SMOKE_FETCH_TIMEOUT_MS;
  return Math.trunc(parsed);
}

export function requireUrl(name, value) {
  if (!value) throw new Error(`${name} is required`);
  return new URL(value).toString().replace(/\/$/, '');
}

function createTimeoutSignal(timeoutMs) {
  if (typeof AbortSignal.timeout === 'function') {
    return { signal: AbortSignal.timeout(timeoutMs), cleanup: () => {} };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new DOMException(`Timed out after ${timeoutMs}ms`, 'TimeoutError'));
  }, timeoutMs);
  return { signal: controller.signal, cleanup: () => clearTimeout(timeout) };
}

function combineAbortSignals(signals) {
  if (signals.length === 1) return { signal: signals[0], cleanup: () => {} };
  if (typeof AbortSignal.any === 'function') return { signal: AbortSignal.any(signals), cleanup: () => {} };

  const controller = new AbortController();
  const listeners = [];
  const cleanup = () => {
    for (const [signal, listener] of listeners) signal.removeEventListener('abort', listener);
    listeners.length = 0;
  };
  const abort = (signal) => {
    if (!controller.signal.aborted)
      controller.abort(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
    cleanup();
  };

  for (const signal of signals) {
    if (signal.aborted) {
      abort(signal);
      break;
    }
    const listener = () => abort(signal);
    listeners.push([signal, listener]);
    signal.addEventListener('abort', listener, { once: true });
  }

  return { signal: controller.signal, cleanup };
}

export function isTimeoutError(error) {
  return error?.name === 'SmokeFetchTimeoutError' || error?.name === 'TimeoutError' || error?.name === 'AbortError';
}

export function formatSmokeFetchError(error) {
  if (error?.name === 'SmokeFetchTimeoutError') return error.message;
  return error instanceof Error ? error.message : String(error);
}

export async function fetchWithTimeout(url, options = {}, timeoutMsOverride) {
  const { timeoutMs: requestedTimeoutMs, ...fetchOptions } = options;
  const timeoutMs = getSmokeFetchTimeoutMs(requestedTimeoutMs ?? timeoutMsOverride);
  const timeout = createTimeoutSignal(timeoutMs);
  const signals = fetchOptions.signal ? [fetchOptions.signal, timeout.signal] : [timeout.signal];
  const combined = combineAbortSignals(signals);

  try {
    return await fetch(url, { ...fetchOptions, signal: combined.signal });
  } catch (error) {
    if (timeout.signal.aborted && !fetchOptions.signal?.aborted) {
      const timeoutError = new Error(`fetch timed out after ${timeoutMs}ms`);
      timeoutError.name = 'SmokeFetchTimeoutError';
      timeoutError.cause = error;
      throw timeoutError;
    }
    throw error;
  } finally {
    combined.cleanup();
    timeout.cleanup();
  }
}

export async function fetchJson(url, options = {}) {
  const response = await fetchWithTimeout(url, { redirect: 'follow', ...options });
  let json = null;
  const text = await response.text();
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { response, json, text };
}

export function assertEqual(name, actual, expected) {
  if (actual !== expected) throw new Error(`${name} expected ${expected}, got ${actual ?? '<missing>'}`);
}

export function safeSummary(summary) {
  return JSON.stringify(summary, null, 2);
}
