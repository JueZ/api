#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const TASK_TYPES = Object.freeze([
  'ordinary_feature',
  'small_fix',
  'provider_shape_mismatch',
  'permissions_blocker',
  'superseded_deployment',
]);

export const DELIVERY_OUTCOMES = Object.freeze([
  'local_validation_passed',
  'protected_merged',
  'runtime_neutral_complete',
  'runtime_verified',
  'blocked_permissions',
  'superseded_following_current_main',
  'incomplete',
]);

const ROOT_FIELDS = new Set([
  'schemaVersion',
  'trialId',
  'comparisonId',
  'variant',
  'taskType',
  'instructionRevision',
  'sourceRevision',
  'actualModel',
  'actualEffort',
  'activeAgentTimeMs',
  'ciDeploymentTimeMs',
  'tokens',
  'validations',
  'repairAttempts',
  'finalDeliveryOutcome',
]);

const VALIDATION_OUTCOMES = new Set(['passed', 'failed', 'skipped', 'blocked']);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateString(value, path, errors, { pattern, maxLength = 200 } = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    errors.push(`${path} must be a non-empty string no longer than ${maxLength} characters`);
  } else if (pattern && !pattern.test(value)) {
    errors.push(`${path} has an invalid format`);
  }
}

function validateNonNegativeInteger(value, path, errors) {
  if (!Number.isSafeInteger(value) || value < 0) errors.push(`${path} must be a non-negative safe integer`);
}

function rejectUnexpectedFields(value, fields, path, errors) {
  for (const key of Object.keys(value)) {
    if (!fields.has(key)) errors.push(`${path}.${key} is not allowed`);
  }
}

function validateTiming(value, errors) {
  if (!isObject(value)) {
    errors.push('ciDeploymentTimeMs must be an object when provided');
    return;
  }
  const fields = new Set(['ci', 'deployment']);
  rejectUnexpectedFields(value, fields, 'ciDeploymentTimeMs', errors);
  if (!Object.hasOwn(value, 'ci') && !Object.hasOwn(value, 'deployment')) {
    errors.push('ciDeploymentTimeMs must include ci or deployment');
  }
  for (const name of fields) {
    if (Object.hasOwn(value, name)) validateNonNegativeInteger(value[name], `ciDeploymentTimeMs.${name}`, errors);
  }
}

function validateTokens(value, errors) {
  if (!isObject(value)) {
    errors.push('tokens must be an object when provided');
    return;
  }
  const fields = new Set(['input', 'output', 'reasoning', 'total']);
  rejectUnexpectedFields(value, fields, 'tokens', errors);
  if (Object.keys(value).length === 0) errors.push('tokens must include at least one reported token count');
  for (const name of fields) {
    if (Object.hasOwn(value, name)) validateNonNegativeInteger(value[name], `tokens.${name}`, errors);
  }
}

function validateValidations(value, errors) {
  if (!Array.isArray(value)) {
    errors.push('validations must be an array');
    return;
  }
  if (value.length > 100) errors.push('validations may contain at most 100 entries');
  for (const [index, validation] of value.entries()) {
    const path = `validations[${index}]`;
    if (!isObject(validation)) {
      errors.push(`${path} must be an object`);
      continue;
    }
    const fields = new Set(['name', 'outcome', 'repeated', 'durationMs']);
    rejectUnexpectedFields(validation, fields, path, errors);
    validateString(validation.name, `${path}.name`, errors, { maxLength: 300 });
    if (!VALIDATION_OUTCOMES.has(validation.outcome)) {
      errors.push(`${path}.outcome must be passed, failed, skipped, or blocked`);
    }
    if (typeof validation.repeated !== 'boolean') errors.push(`${path}.repeated must be a boolean`);
    if (Object.hasOwn(validation, 'durationMs')) {
      validateNonNegativeInteger(validation.durationMs, `${path}.durationMs`, errors);
    }
  }
}

/**
 * Validate a local, advisory live-trial record. This does not execute an agent,
 * infer missing metrics, or decide whether one instruction revision is better.
 */
export function validatePerformanceRecord(record) {
  const errors = [];
  if (!isObject(record)) return { errors: ['record must be an object'] };

  rejectUnexpectedFields(record, ROOT_FIELDS, 'record', errors);
  if (record.schemaVersion !== 1) errors.push('schemaVersion must equal 1');
  validateString(record.trialId, 'trialId', errors, { pattern: /^[a-z0-9][a-z0-9._-]*$/ });
  validateString(record.comparisonId, 'comparisonId', errors, { pattern: /^[a-z0-9][a-z0-9._-]*$/ });
  if (!['baseline', 'revised'].includes(record.variant)) errors.push('variant must be baseline or revised');
  if (!TASK_TYPES.includes(record.taskType)) errors.push(`taskType must be one of: ${TASK_TYPES.join(', ')}`);
  validateString(record.instructionRevision, 'instructionRevision', errors);
  validateString(record.sourceRevision, 'sourceRevision', errors, { pattern: /^[0-9a-f]{7,64}$/i, maxLength: 64 });

  for (const field of ['actualModel', 'actualEffort']) {
    if (Object.hasOwn(record, field)) validateString(record[field], field, errors);
  }
  if (Object.hasOwn(record, 'activeAgentTimeMs')) {
    validateNonNegativeInteger(record.activeAgentTimeMs, 'activeAgentTimeMs', errors);
  }
  if (Object.hasOwn(record, 'ciDeploymentTimeMs')) validateTiming(record.ciDeploymentTimeMs, errors);
  if (Object.hasOwn(record, 'tokens')) validateTokens(record.tokens, errors);
  validateValidations(record.validations, errors);
  validateNonNegativeInteger(record.repairAttempts, 'repairAttempts', errors);
  if (!DELIVERY_OUTCOMES.includes(record.finalDeliveryOutcome)) {
    errors.push(`finalDeliveryOutcome must be one of: ${DELIVERY_OUTCOMES.join(', ')}`);
  }
  return { errors };
}

export function parsePerformanceRecord(text) {
  try {
    return { record: JSON.parse(text), errors: [] };
  } catch {
    return { record: null, errors: ['record is not valid JSON'] };
  }
}

function main(args) {
  if (args.length !== 1) {
    console.error('Usage: node scripts/codex-evals/performance-record.mjs <record.json>');
    return 2;
  }
  let parsed;
  try {
    parsed = parsePerformanceRecord(readFileSync(args[0], 'utf8'));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  const result = parsed.errors.length > 0 ? parsed : { ...parsed, ...validatePerformanceRecord(parsed.record) };
  if (result.errors.length > 0) {
    console.error(`Agent-performance record is invalid:\n- ${result.errors.join('\n- ')}`);
    return 1;
  }
  console.log(`Validated advisory agent-performance record: ${parsed.record.trialId}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
