#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { safeSummary } from './lib/smoke-utils.mjs';

const environmentName = process.env.ENVIRONMENT_NAME || 'unknown';
const smokeRunId = process.env.SMOKE_RUN_ID || '';
const appInsightsApp = process.env.APPLICATIONINSIGHTS_APP_ID || process.env.APPLICATIONINSIGHTS_RESOURCE_ID || process.env.APPLICATIONINSIGHTS_NAME || '';
const resourceGroup = process.env.AZURE_RESOURCE_GROUP || '';
const failClosed = process.env.REQUIRE_TELEMETRY_CHECK === 'true' || environmentName === 'prod';
const timespanMinutes = Number.parseInt(process.env.TELEMETRY_TIMESPAN_MINUTES || '30', 10);
const outputPath = process.env.TELEMETRY_RESULTS_PATH || '';
const result = { status: 'passed', environmentName, smokeRunId: smokeRunId || undefined, timespanMinutes, checkedAt: new Date().toISOString(), checks: [] };

async function finish(status, code, extra = {}) {
  Object.assign(result, { status }, extra);
  const rendered = safeSummary(result);
  if (status === 'passed') console.log(rendered); else console.error(rendered);
  if (outputPath) await writeFile(outputPath, `${rendered}\n`);
  process.exit(code);
}

if (!appInsightsApp) {
  await finish('blocked_telemetry', failClosed ? 2 : 0, { blockedReason: 'Application Insights identifier is not configured. Set APPLICATIONINSIGHTS_APP_ID, APPLICATIONINSIGHTS_RESOURCE_ID, or APPLICATIONINSIGHTS_NAME.' });
}

const appArg = process.env.APPLICATIONINSIGHTS_RESOURCE_ID ? ['--ids', appInsightsApp] : ['--app', appInsightsApp, ...(resourceGroup ? ['--resource-group', resourceGroup] : [])];
const query = `let since = ago(${timespanMinutes}m);\nlet smokeRunId = '${smokeRunId.replace(/'/g, '')}';\nlet recentExceptions = exceptions | where timestamp > since | count;\nlet recent5xx = requests | where timestamp > since and toint(resultCode) >= 500 | count;\nlet failedRequests = requests | where timestamp > since and success == false and toint(resultCode) >= 500 | count;\nprint exceptions=toscalar(recentExceptions), http5xx=toscalar(recent5xx), failedRequests=toscalar(failedRequests)`;
const completed = spawnSync('az', ['monitor', 'app-insights', 'query', ...appArg, '--analytics-query', query, '--output', 'json'], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
if (completed.status !== 0) {
  await finish('blocked_telemetry', failClosed ? 2 : 0, { blockedReason: 'Azure Monitor query failed; verify OIDC permissions and Application Insights configuration.', azStatus: completed.status });
}

let parsed;
try { parsed = JSON.parse(completed.stdout); } catch { await finish('blocked_telemetry', failClosed ? 2 : 0, { blockedReason: 'Azure Monitor query returned non-JSON output.' }); }
const row = parsed?.tables?.[0]?.rows?.[0] || [];
const [exceptions = 0, http5xx = 0, failedRequests = 0, smokeTraceCount = 0] = row.map((value) => Number(value || 0));
result.checks.push({ name: 'exceptions', count: exceptions }, { name: 'http5xx', count: http5xx }, { name: 'failedRequests', count: failedRequests });
if (smokeRunId) result.checks.push({ name: 'smokeCorrelationTraces', count: smokeTraceCount });
if (exceptions > 0 || http5xx > 0 || failedRequests > 0) {
  await finish('failed', 1, { failureSummary: 'Critical runtime errors were observed after smoke tests.' });
}
await finish('passed', 0);
