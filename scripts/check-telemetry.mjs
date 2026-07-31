#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { safeSummary, sanitizeSmokeRunId } from './lib/smoke-utils.mjs';

const DEFAULT_STATUSES = {
  passed: 0,
  failed: 1,
  blocked_telemetry: 2,
};

export function parseBoolean(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return String(value).toLowerCase() === 'true';
}

export function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function sanitizeTelemetrySmokeRunId(value) {
  return sanitizeSmokeRunId(value) || '';
}

export function sanitizeTelemetryEvaluationStart(value) {
  const raw = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(raw)) return '';
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString();
}

export function buildTelemetryQuery({ timespanMinutes, smokeRunId = '', evaluationStart = '' }) {
  const minutes = parsePositiveInt(timespanMinutes, 30);
  const safeSmokeRunId = sanitizeTelemetrySmokeRunId(smokeRunId);
  const safeEvaluationStart = sanitizeTelemetryEvaluationStart(evaluationStart);
  const since = safeEvaluationStart ? `datetime(${safeEvaluationStart})` : `ago(${minutes}m)`;
  return `let since = ${since};\nlet smokeRunId = '${safeSmokeRunId}';\nlet recentExceptions = toscalar(\n  exceptions\n  | where timestamp >= since\n  | count\n);\nlet recent5xx = toscalar(\n  requests\n  | where timestamp >= since\n  | where toint(resultCode) >= 500\n  | count\n);\nlet failedRequests = toscalar(\n  requests\n  | where timestamp >= since\n  | where success == false and toint(resultCode) >= 500\n  | count\n);\nlet smokeTraces = toscalar(\n  traces\n  | where timestamp >= since\n  | where smokeRunId != ''\n  | where tostring(customDimensions.smoke_run_id) == smokeRunId\n      or tostring(customDimensions['smoke_run_id']) == smokeRunId\n      or tostring(customDimensions) has smokeRunId\n      or message has smokeRunId\n  | count\n);\nlet smokeRequests = toscalar(\n  requests\n  | where timestamp >= since\n  | where smokeRunId != ''\n  | where tostring(customDimensions.smoke_run_id) == smokeRunId\n      or tostring(customDimensions['smoke_run_id']) == smokeRunId\n      or tostring(customDimensions) has smokeRunId\n      or name has smokeRunId\n  | count\n);\nprint\n  exceptions=recentExceptions,\n  http5xx=recent5xx,\n  failedRequests=failedRequests,\n  smokeTraceCount=smokeTraces,\n  smokeRequestCount=smokeRequests,\n  smokeEvidenceCount=smokeTraces + smokeRequests`;
}

export function parseAzureMonitorQueryResult(parsed) {
  const table = parsed?.tables?.[0];
  const columns = table?.columns || [];
  const row = table?.rows?.[0] || [];
  const byName = new Map(columns.map((column, index) => [String(column.name), row[index]]));
  const numberField = (name) => Number(byName.get(name) ?? 0) || 0;
  return {
    exceptions: numberField('exceptions'),
    http5xx: numberField('http5xx'),
    failedRequests: numberField('failedRequests'),
    smokeTraceCount: numberField('smokeTraceCount'),
    smokeRequestCount: numberField('smokeRequestCount'),
    smokeEvidenceCount: numberField('smokeEvidenceCount'),
  };
}

export function telemetryDecision({
  environmentName = 'unknown',
  failClosed = false,
  requireSmokeCorrelation = false,
  smokeRunId = '',
  querySucceeded = true,
  checks = {},
  queryAttempt = 1,
  blockedReason = '',
}) {
  const productionRequired = failClosed || environmentName === 'prod';
  const normalized = {
    exceptions: Number(checks.exceptions || 0),
    http5xx: Number(checks.http5xx || 0),
    failedRequests: Number(checks.failedRequests || 0),
    smokeTraceCount: Number(checks.smokeTraceCount || 0),
    smokeRequestCount: Number(checks.smokeRequestCount || 0),
    smokeEvidenceCount: Number(checks.smokeEvidenceCount || 0),
  };
  if (!querySucceeded) {
    return {
      status: 'blocked_telemetry',
      exitCode: productionRequired ? 2 : 0,
      checks: normalized,
      blockedReason:
        blockedReason || 'Azure Monitor query failed; verify OIDC permissions and Application Insights configuration.',
      queryAttempt,
    };
  }
  if (normalized.exceptions > 0 || normalized.http5xx > 0 || normalized.failedRequests > 0) {
    return {
      status: 'failed',
      exitCode: 1,
      checks: normalized,
      failureSummary: 'Critical runtime errors were observed after smoke tests.',
      queryAttempt,
    };
  }
  if (smokeRunId && requireSmokeCorrelation && normalized.smokeEvidenceCount < 1) {
    return {
      status: productionRequired ? 'failed' : 'blocked_telemetry',
      exitCode: productionRequired ? 1 : 0,
      checks: normalized,
      failureSummary: productionRequired
        ? 'Required smoke correlation telemetry was not observed after smoke tests.'
        : undefined,
      blockedReason: productionRequired
        ? undefined
        : 'Smoke correlation telemetry was not observed, but telemetry is not required to fail closed for this environment.',
      queryAttempt,
    };
  }
  return { status: 'passed', exitCode: 0, checks: normalized, queryAttempt };
}

export function shouldRetryTelemetry({
  decision,
  smokeRunId,
  requireSmokeCorrelation,
  attempt,
  maxAttempts,
  querySucceeded,
}) {
  if (attempt >= maxAttempts) return false;
  if (!querySucceeded) return true;
  const missingSmokeEvidence =
    smokeRunId && requireSmokeCorrelation && Number(decision?.checks?.smokeEvidenceCount || 0) < 1;
  const runtimeErrors =
    Number(decision?.checks?.exceptions || 0) > 0 ||
    Number(decision?.checks?.http5xx || 0) > 0 ||
    Number(decision?.checks?.failedRequests || 0) > 0;
  return Boolean(missingSmokeEvidence && !runtimeErrors);
}

function appInsightsArgs(env) {
  const app =
    env.APPLICATIONINSIGHTS_APP_ID || env.APPLICATIONINSIGHTS_RESOURCE_ID || env.APPLICATIONINSIGHTS_NAME || '';
  const resourceGroup = env.AZURE_RESOURCE_GROUP || '';
  if (!app) return { app, args: [] };
  if (env.APPLICATIONINSIGHTS_RESOURCE_ID) return { app, args: ['--ids', app] };
  return { app, args: ['--app', app, ...(resourceGroup ? ['--resource-group', resourceGroup] : [])] };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function finish(result, outputPath) {
  const rendered = safeSummary(result);
  if (result.status === 'passed') console.log(rendered);
  else console.error(rendered);
  if (outputPath) await writeFile(outputPath, `${rendered}\n`);
  return result;
}

export async function runTelemetryCheck({
  env = process.env,
  spawn = spawnSync,
  now = () => new Date(),
  sleeper = sleep,
} = {}) {
  const environmentName = env.ENVIRONMENT_NAME || 'unknown';
  const rawSmokeRunId = env.SMOKE_RUN_ID || '';
  const smokeRunId = sanitizeTelemetrySmokeRunId(rawSmokeRunId);
  const failClosed = parseBoolean(env.REQUIRE_TELEMETRY_CHECK, false) || environmentName === 'prod';
  const requireSmokeCorrelation = parseBoolean(env.TELEMETRY_REQUIRE_SMOKE_CORRELATION, environmentName === 'prod');
  const timespanMinutes = parsePositiveInt(env.TELEMETRY_TIMESPAN_MINUTES, 30);
  const evaluationStart = sanitizeTelemetryEvaluationStart(env.TELEMETRY_EVALUATION_START);
  const maxAttempts = parsePositiveInt(env.TELEMETRY_QUERY_RETRIES, 6);
  const retryDelayMs = parsePositiveInt(env.TELEMETRY_QUERY_RETRY_DELAY_MS, 10_000);
  const outputPath = env.TELEMETRY_RESULTS_PATH || '';
  const { app, args } = appInsightsArgs(env);
  const baseResult = {
    status: 'passed',
    environmentName,
    smokeRunId: smokeRunId || undefined,
    checkedAt: now().toISOString(),
    timespanMinutes,
    evaluationStart: evaluationStart || undefined,
    checks: {},
  };

  if (!app) {
    const decision = telemetryDecision({
      environmentName,
      failClosed,
      querySucceeded: false,
      queryAttempt: 0,
      blockedReason:
        'Application Insights identifier is not configured. Set APPLICATIONINSIGHTS_APP_ID, APPLICATIONINSIGHTS_RESOURCE_ID, or APPLICATIONINSIGHTS_NAME.',
    });
    return finish({ ...baseResult, ...decision, checks: decision.checks }, outputPath);
  }

  const query = buildTelemetryQuery({ timespanMinutes, smokeRunId, evaluationStart });
  let finalDecision;
  let lastBlockedReason = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const completed = spawn(
      'az',
      ['monitor', 'app-insights', 'query', ...args, '--analytics-query', query, '--output', 'json'],
      { encoding: 'utf8', maxBuffer: 1024 * 1024 },
    );
    let querySucceeded = completed.status === 0;
    let checks = {};
    if (querySucceeded) {
      try {
        checks = parseAzureMonitorQueryResult(JSON.parse(completed.stdout || '{}'));
      } catch {
        querySucceeded = false;
        lastBlockedReason = 'Azure Monitor query returned non-JSON output.';
      }
    } else {
      lastBlockedReason = 'Azure Monitor query failed; verify OIDC permissions and Application Insights configuration.';
    }
    finalDecision = telemetryDecision({
      environmentName,
      failClosed,
      requireSmokeCorrelation,
      smokeRunId,
      querySucceeded,
      checks,
      queryAttempt: attempt,
      blockedReason: lastBlockedReason,
    });
    if (
      !shouldRetryTelemetry({
        decision: finalDecision,
        smokeRunId,
        requireSmokeCorrelation,
        attempt,
        maxAttempts,
        querySucceeded,
      })
    )
      break;
    await sleeper(retryDelayMs);
  }

  return finish({ ...baseResult, ...finalDecision, checks: finalDecision.checks }, outputPath);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runTelemetryCheck();
  process.exit(result.exitCode ?? DEFAULT_STATUSES[result.status] ?? 1);
}
