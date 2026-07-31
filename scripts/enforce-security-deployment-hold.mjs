#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DEFAULT_DEPLOYMENT_HOLD_PATH = fileURLToPath(
  new URL('../.github/security-deployment-hold.json', import.meta.url),
);
export const REQUIRED_ROTATION_EVIDENCE_SYSTEMS = ['github', 'azure', 'providers'];
export const SECURITY_INCIDENT_ID = 'credential-exposure-2026-07-31';
export const SECURITY_INCIDENT_DISCOVERED_AT = '2026-07-31T00:00:00Z';

const HOLD_FIELDS = ['version', 'active', 'incidentId', 'discoveredAt', 'reason', 'clearance'];
const CLEARANCE_FIELDS = ['status', 'verifiedAt', 'verifiedBy', 'evidence', 'approval'];
const EVIDENCE_FIELDS = [
  'system',
  'revokedAt',
  'rotatedAt',
  'revokedCount',
  'rotatedCount',
  'inventoryReference',
  'revocationReference',
  'replacementReference',
];
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/;
const SAFE_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{2,199}$/;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isIsoTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
    return false;
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return false;
  const canonical = value.includes('.') ? value : value.replace(/Z$/, '.000Z');
  return parsed.toISOString() === canonical;
}

function timestampMs(value) {
  return isIsoTimestamp(value) ? Date.parse(value) : Number.NaN;
}

function rejectUnknownFields(value, allowed, path, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push(`${path} contains unsupported field ${key}`);
  }
}

function validateCompleteEvidence(clearance, discoveredAtMs, nowMs, errors) {
  if (!Array.isArray(clearance.evidence)) {
    errors.push('clearance.evidence must be an array');
    return;
  }
  if (clearance.evidence.length !== REQUIRED_ROTATION_EVIDENCE_SYSTEMS.length) {
    errors.push('clearance evidence must contain exactly one record for each required credential system');
  }

  const seenSystems = new Set();
  const seenReferences = new Set();
  for (const [index, item] of clearance.evidence.entries()) {
    if (!isRecord(item)) {
      errors.push(`clearance.evidence[${index}] must be an object`);
      continue;
    }
    rejectUnknownFields(item, EVIDENCE_FIELDS, `clearance.evidence[${index}]`, errors);
    if (item.system !== REQUIRED_ROTATION_EVIDENCE_SYSTEMS[index]) {
      errors.push(`clearance.evidence[${index}].system must be ${REQUIRED_ROTATION_EVIDENCE_SYSTEMS[index]}`);
    }
    if (seenSystems.has(item.system)) errors.push(`clearance.evidence contains duplicate system ${item.system}`);
    seenSystems.add(item.system);

    for (const timestampName of ['revokedAt', 'rotatedAt']) {
      const value = item[timestampName];
      if (!isIsoTimestamp(value)) {
        errors.push(`clearance.evidence[${index}].${timestampName} must be a real ISO UTC timestamp`);
        continue;
      }
      const valueMs = timestampMs(value);
      if (valueMs < discoveredAtMs) {
        errors.push(`clearance.evidence[${index}].${timestampName} predates incident discovery`);
      }
      if (valueMs > nowMs) errors.push(`clearance.evidence[${index}].${timestampName} cannot be in the future`);
    }

    for (const countName of ['revokedCount', 'rotatedCount']) {
      if (!Number.isSafeInteger(item[countName]) || item[countName] < 1 || item[countName] > 1000) {
        errors.push(`clearance.evidence[${index}].${countName} must be an integer from 1 to 1000`);
      }
    }
    if (
      Number.isSafeInteger(item.revokedCount) &&
      Number.isSafeInteger(item.rotatedCount) &&
      item.revokedCount !== item.rotatedCount
    ) {
      errors.push(`clearance.evidence[${index}] revoked and rotated credential counts must match`);
    }

    for (const referenceName of ['inventoryReference', 'revocationReference', 'replacementReference']) {
      const reference = item[referenceName];
      if (!SAFE_REFERENCE_PATTERN.test(String(reference ?? ''))) {
        errors.push(`clearance.evidence[${index}].${referenceName} must be a safe non-secret audit reference`);
      } else if (seenReferences.has(reference)) {
        errors.push(`clearance evidence audit reference must be unique: ${reference}`);
      } else {
        seenReferences.add(reference);
      }
    }
  }
}

/**
 * Validate the incident record. This schema is deliberately active-only.
 * GitHub is one of the affected credential systems and this repository has no
 * independent security approver, so repository data cannot clear the hold.
 */
export function validateDeploymentHold(policy, { now = new Date() } = {}) {
  const errors = [];
  if (!isRecord(policy)) return ['deployment hold must be an object'];
  rejectUnknownFields(policy, HOLD_FIELDS, 'deployment hold', errors);
  if (policy.version !== 1) errors.push('version must be 1');
  if (policy.active !== true) errors.push('active must remain true until an out-of-band trust root is bootstrapped');
  if (policy.incidentId !== SECURITY_INCIDENT_ID || !SAFE_ID_PATTERN.test(String(policy.incidentId ?? ''))) {
    errors.push(`incidentId must be ${SECURITY_INCIDENT_ID}`);
  }
  if (policy.discoveredAt !== SECURITY_INCIDENT_DISCOVERED_AT) {
    errors.push(`discoveredAt must be ${SECURITY_INCIDENT_DISCOVERED_AT}`);
  }
  if (typeof policy.reason !== 'string' || policy.reason.trim().length < 10 || policy.reason.length > 240) {
    errors.push('reason must be a concise non-secret explanation');
  }

  const clearance = policy.clearance;
  if (!isRecord(clearance)) return [...errors, 'clearance must be an object'];
  rejectUnknownFields(clearance, CLEARANCE_FIELDS, 'clearance', errors);
  const nowMs = now instanceof Date ? now.getTime() : Number.NaN;
  if (!Number.isFinite(nowMs)) errors.push('validation time must be a valid Date');
  const discoveredAtMs = timestampMs(policy.discoveredAt);

  if (clearance.verifiedAt !== null || clearance.verifiedBy !== null || clearance.approval !== null) {
    errors.push('the active incident record cannot contain repository-local verification or approval data');
  }

  if (clearance.status === 'pending') {
    if (!Array.isArray(clearance.evidence) || clearance.evidence.length !== 0) {
      errors.push('pending clearance evidence must be empty');
    }
    return errors;
  }

  if (clearance.status === 'evidence-recorded') {
    validateCompleteEvidence(clearance, discoveredAtMs, nowMs, errors);
    return errors;
  }

  errors.push('clearance.status must be pending or evidence-recorded while the incident hold is active');
  return errors;
}

export function deploymentHoldDecision(policy, options) {
  const errors = validateDeploymentHold(policy, options);
  if (errors.length > 0) return { blocked: true, reason: 'invalid_policy', errors };
  return { blocked: true, reason: 'active_incident', errors: [] };
}

export function loadDeploymentHold(path = DEFAULT_DEPLOYMENT_HOLD_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.length !== 2) {
    console.error('Usage: enforce-security-deployment-hold.mjs');
    process.exit(2);
  }
  const policy = loadDeploymentHold();
  const decision = deploymentHoldDecision(policy);
  const incidentId = SAFE_ID_PATTERN.test(String(policy?.incidentId ?? '')) ? policy.incidentId : '<invalid>';
  const detail =
    decision.reason === 'invalid_policy'
      ? 'The hold policy is invalid.'
      : 'External rotation and an independent out-of-band clearance trust root are required.';
  console.error(`Security deployment hold ${incidentId} is active. ${detail}`);
  process.exit(1);
}
