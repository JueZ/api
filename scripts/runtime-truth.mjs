#!/usr/bin/env node
import { requireUrl, fetchJson, safeSummary } from './lib/smoke-utils.mjs';

const apiBaseUrl = requireUrl('API_BASE_URL', process.env.API_BASE_URL);
const result = { apiBaseUrl, checkedAt: new Date().toISOString() };
try {
  const health = await fetchJson(`${apiBaseUrl}/health`, { headers: process.env.SMOKE_RUN_ID ? { 'X-Smoke-Run-Id': process.env.SMOKE_RUN_ID } : {} });
  if (health.response.status !== 200) throw new Error(`/health returned ${health.response.status}`);
  Object.assign(result, { status: 'passed', runtime: health.json });
  console.log(safeSummary(result));
} catch (error) {
  Object.assign(result, { status: 'failed', error: error instanceof Error ? error.message : String(error) });
  console.error(safeSummary(result));
  process.exit(1);
}
