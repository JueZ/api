#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const ledgerPath = process.argv[2];
  if (!ledgerPath) {
    console.error('Usage: node scripts/validate-release-ledger.mjs <ledger.json>');
    process.exit(2);
  }

  const ledger = JSON.parse(await readFile(ledgerPath, 'utf8'));
  const errors = validateReleaseLedger(ledger, {
    expectedDeliveryCorrelation: process.env.EXPECTED_DELIVERY_CORRELATION,
  });
  if (errors.length > 0) {
    console.error(errors.join('\n'));
    process.exit(1);
  }
  console.log(`Release ledger valid: ${ledgerPath}`);
}

export function validateReleaseLedger(ledger, { expectedDeliveryCorrelation = '' } = {}) {
  const errors = [];
  const required = [
    'environment',
    'deployedCommit',
    'sourceRef',
    'workflowRunId',
    'deliveryCorrelation',
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
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(String(ledger?.deliveryCorrelation ?? ''))) {
    errors.push('deliveryCorrelation must be an opaque 8-128 character identifier');
  }
  if (expectedDeliveryCorrelation && ledger?.deliveryCorrelation !== expectedDeliveryCorrelation) {
    errors.push('deliveryCorrelation does not match the expected workflow dispatch');
  }
  for (const key of ['functionappSha256', 'frontendSha256', 'sbomSha256']) {
    if (!/^[0-9a-f]{64}$/.test(String(ledger?.artifacts?.[key] ?? ''))) {
      errors.push(`artifacts.${key} must be a lowercase SHA-256 digest`);
    }
  }
  if (ledger?.installation !== undefined) {
    if (!/^[1-9][0-9]*$/.test(String(ledger.installation?.runId ?? ''))) {
      errors.push('installation.runId must be a positive integer');
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(String(ledger.installation?.correlation ?? ''))) {
      errors.push('installation.correlation must be an opaque 8-128 character identifier');
    }
    for (const key of ['storageAccountName', 'containerName', 'blobName', 'versionId']) {
      if (!String(ledger.installation?.functionPackage?.[key] ?? '')) {
        errors.push(`installation.functionPackage.${key} is required`);
      }
    }
    for (const key of ['metadataSha256', 'inventorySha256']) {
      if (!/^[0-9a-f]{64}$/.test(String(ledger.installation?.frontend?.[key] ?? ''))) {
        errors.push(`installation.frontend.${key} must be a lowercase SHA-256 digest`);
      }
    }
  }
  if (ledger?.recovery !== undefined) {
    if (!['verified', 'incomplete'].includes(ledger.recovery?.status)) {
      errors.push('recovery.status must be verified or incomplete');
    }
    if (typeof ledger.recovery?.configurationUncertain !== 'boolean') {
      errors.push('recovery.configurationUncertain must be boolean');
    }
    if (!/^[0-9a-f]{40}$/.test(String(ledger.recovery?.originalBundle?.sourceRef ?? ''))) {
      errors.push('recovery.originalBundle.sourceRef must be a lowercase 40-character SHA');
    }
    if (!/^[1-9][0-9]*$/.test(String(ledger.recovery?.originalBundle?.runId ?? ''))) {
      errors.push('recovery.originalBundle.runId must be a positive integer');
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(String(ledger.recovery?.originalBundle?.correlation ?? ''))) {
      errors.push('recovery.originalBundle.correlation must be an opaque 8-128 character identifier');
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
