import { randomUUID } from 'node:crypto';

export const DEFAULT_SMOKE_FETCH_TIMEOUT_MS = 30_000;

export function sanitizeSmokeRunId(value) {
  const normalized = String(value ?? '').trim();
  if (!normalized) return undefined;
  return normalized.replace(/[^A-Za-z0-9_.:-]/g, '-').replace(/-+/g, '-').slice(0, 96) || undefined;
}

export function getSmokeRunId(value = process.env.SMOKE_RUN_ID) {
  return sanitizeSmokeRunId(value) ?? `smoke-${new Date().toISOString().replace(/[^0-9TZ]/g, '')}-${randomUUID()}`;
}

export function requireUrl(name, value) {
  if (!value) throw new Error(`${name} is required`);
  return new URL(value).toString().replace(/\/$/, '');
}

export function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_SMOKE_FETCH_TIMEOUT_MS) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;
  return fetch(url, { ...options, signal });
}

export function isTimeoutError(error) {
  return error?.name === 'TimeoutError' || error?.name === 'AbortError';
}

export async function fetchJson(url, options = {}) {
  const response = await fetch(url, { ...options, redirect: 'follow' });
  let json = null;
  const text = await response.text();
  if (text) {
    try { json = JSON.parse(text); } catch { json = null; }
  }
  return { response, json, text };
}

export function assertEqual(name, actual, expected) {
  if (actual !== expected) throw new Error(`${name} expected ${expected}, got ${actual ?? '<missing>'}`);
}

export function safeSummary(summary) {
  return JSON.stringify(summary, null, 2);
}
