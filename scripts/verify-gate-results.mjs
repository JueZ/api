#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { verifyGateAggregate } from './lib/gate-aggregate.mjs';

const gate = process.env.GATE;
const flags = parseJson(process.env.FLAGS_JSON, 'FLAGS_JSON');
const needs = parseJson(process.env.NEEDS_JSON, 'NEEDS_JSON');
const result = verifyGateAggregate(gate, flags, needs);
const started = Number(process.env.STARTED_AT_EPOCH);
const duration = Number.isFinite(started) ? Math.max(0, Math.floor(Date.now() / 1000) - started) : 'unknown';

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    [
      `### ${gate === 'pr' ? 'PR Gate' : 'Security Gate'}`,
      `- Profile: ${process.env.PROFILE || 'privileged'}`,
      `- Exact SHA: ${process.env.EXACT_SHA || 'unknown'}`,
      `- Applicable jobs: ${result.applicable.join(', ')}`,
      `- Skipped jobs: ${result.skipped.join(', ') || 'none'}`,
      `- Duration: ${duration} seconds`,
      `- Result: ${result.passed ? 'passed' : 'failed'}`,
      '',
    ].join('\n'),
  );
}

console.log(JSON.stringify(result, null, 2));
if (!result.passed) {
  console.error(`Gate aggregation failed:\n- ${result.failures.join('\n- ')}`);
  process.exit(1);
}

function parseJson(value, name) {
  try {
    return JSON.parse(value ?? '');
  } catch {
    throw new Error(`${name} must contain valid JSON`);
  }
}
