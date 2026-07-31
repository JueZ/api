#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

if (import.meta.url === `file://${process.argv[1]}`) {
  const ledgerPath = process.argv[2];
  if (!ledgerPath) {
    console.error('Usage: node scripts/validate-release-ledger.mjs <ledger.json>');
    process.exit(2);
  }

  const ledger = JSON.parse(await readFile(ledgerPath, 'utf8'));
  const errors = validateReleaseLedger(ledger);
  if (errors.length > 0) {
    console.error(errors.join('\n'));
    process.exit(1);
  }
  console.log(`Release ledger valid: ${ledgerPath}`);
}

export function validateReleaseLedger(ledger) {
  const errors = [];
  const required = [
    'environment',
    'deployedCommit',
    'sourceRef',
    'workflowRunId',
    'functionAppName',
    'apiBaseUrl',
    'artifacts',
    'smokeRunId',
    'smokeResults',
    'authenticatedSmokeResults',
    'telemetryCheckResult',
    'verifiedAt',
  ];
  for (const key of required)
    if (ledger?.[key] === undefined || ledger?.[key] === '') errors.push(`Missing required field: ${key}`);
  if (!['test', 'prod'].includes(ledger?.environment)) errors.push('environment must be test or prod');
  for (const key of ['deployedCommit', 'sourceRef'])
    if (!/^[0-9a-f]{40}$/.test(String(ledger?.[key] ?? ''))) errors.push(`${key} must be a lowercase 40-character SHA`);
  if (
    ledger?.deliveryCorrelation !== undefined &&
    !/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(String(ledger.deliveryCorrelation))
  ) {
    errors.push('deliveryCorrelation must be an opaque 8-128 character identifier');
  }
  for (const key of ['functionappSha256', 'frontendSha256', 'sbomSha256']) {
    if (!/^[0-9a-f]{64}$/.test(String(ledger?.artifacts?.[key] ?? ''))) {
      errors.push(`artifacts.${key} must be a lowercase SHA-256 digest`);
    }
  }
  for (const key of ['apiBaseUrl']) {
    try {
      new URL(ledger?.[key]);
    } catch {
      errors.push(`${key} must be a URL`);
    }
  }
  for (const key of ['smokeResults', 'authenticatedSmokeResults', 'telemetryCheckResult']) {
    const status = ledger?.[key]?.status;
    if (
      ![
        'passed',
        'failed',
        'blocked',
        'blocked_auth_smoke',
        'blocked_telemetry',
        'skipped_auth_smoke',
        'dependency_blocked',
      ].includes(status)
    )
      errors.push(`${key}.status is invalid`);
  }
  if (Number.isNaN(Date.parse(ledger?.verifiedAt))) errors.push('verifiedAt must be an ISO date-time');
  return errors;
}
