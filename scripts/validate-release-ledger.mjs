#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';

export const releaseLedgerSchema = JSON.parse(
  readFileSync(new URL('../ops/release-ledger/schema.json', import.meta.url), 'utf8'),
);

if (import.meta.url === `file://${process.argv[1]}`) {
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
  const errors = validateSchemaValue(ledger, releaseLedgerSchema, '$', releaseLedgerSchema);
  if (expectedDeliveryCorrelation && ledger?.deliveryCorrelation !== expectedDeliveryCorrelation) {
    errors.push('deliveryCorrelation does not match the expected workflow dispatch');
  }
  return [...new Set(errors)];
}

export function validateSchemaValue(value, schema, path = '$', rootSchema = schema) {
  if (schema.$ref) return validateSchemaValue(value, resolveLocalReference(rootSchema, schema.$ref), path, rootSchema);
  const errors = [];
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [`${displayPath(path)} must be an object`];
    for (const key of schema.required ?? []) {
      if (value[key] === undefined || (typeof value[key] === 'string' && value[key] === '')) {
        errors.push(`Missing required field: ${displayPath(joinPath(path, key))}`);
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(schema.properties ?? {}, key)) {
          errors.push(`Unexpected field: ${displayPath(joinPath(path, key))}`);
        }
      }
    }
    for (const [key, childSchema] of Object.entries(schema.properties ?? {})) {
      if (value[key] !== undefined) {
        errors.push(...validateSchemaValue(value[key], childSchema, joinPath(path, key), rootSchema));
      }
    }
    return errors;
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string') return [`${displayPath(path)} must be a string`];
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${displayPath(path)} must contain at least ${schema.minLength} character(s)`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${displayPath(path)} must contain no more than ${schema.maxLength} character(s)`);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(patternMessage(path));
    if (schema.format === 'uri' && !isUri(value)) errors.push(`${displayPath(path)} must be a URL`);
    if (schema.format === 'date-time' && !isDateTime(value))
      errors.push(`${displayPath(path)} must be an ISO date-time`);
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(enumMessage(path, schema.enum));
  return errors;
}

function resolveLocalReference(schema, reference) {
  if (!reference.startsWith('#/')) throw new Error(`Only local JSON Schema references are supported: ${reference}`);
  return reference
    .slice(2)
    .split('/')
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
    .reduce((value, part) => value?.[part], schema);
}

function joinPath(path, key) {
  return path === '$' ? key : `${path}.${key}`;
}

function displayPath(path) {
  return path === '$' ? 'release ledger' : path;
}

function patternMessage(path) {
  const name = displayPath(path);
  if (name === 'deployedCommit' || name === 'sourceRef') return `${name} must be a lowercase 40-character SHA`;
  if (name === 'deliveryCorrelation') return 'deliveryCorrelation must be an opaque 8-128 character identifier';
  if (name.startsWith('artifacts.')) return `${name} must be a lowercase SHA-256 digest`;
  return `${name} has an invalid format`;
}

function enumMessage(path, values) {
  const name = displayPath(path);
  if (name === 'environment') return 'environment must be test or prod';
  if (name.endsWith('.status')) return `${name} is invalid`;
  return `${name} must be one of: ${values.join(', ')}`;
}

function isUri(value) {
  try {
    return Boolean(new URL(value).protocol);
  } catch {
    return false;
  }
}

function isDateTime(value) {
  return /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));
}
