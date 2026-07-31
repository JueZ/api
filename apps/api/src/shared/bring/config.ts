import { createHash } from 'node:crypto';
import { getDeployedEnvironmentName } from '../config/runtime.js';
import type { BringConfig } from './types.js';

export class BringConfigError extends Error {}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function readBringConfig(env: NodeJS.ProcessEnv = process.env): BringConfig {
  const enabled = readBoolean(env, 'BRING_ENABLED', false);
  const addEnabled = readBoolean(env, 'BRING_ADD_ENABLED', false);
  const destructiveEnabled = readBoolean(env, 'BRING_DESTRUCTIVE_ENABLED', false);
  const baseUrl = required(env, 'BRING_BASE_URL');
  const parsedBaseUrl = parseHttpsUrl(baseUrl, 'BRING_BASE_URL');
  const country = required(env, 'BRING_COUNTRY').toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) {
    throw new BringConfigError('BRING_COUNTRY must be a two-letter country code.');
  }

  const email = required(env, 'BRING_EMAIL');
  const accountFingerprint = fingerprintBringAccount(email);
  const expectedAccountFingerprint = optional(env, 'BRING_EXPECTED_ACCOUNT_FINGERPRINT');
  if (expectedAccountFingerprint && expectedAccountFingerprint !== accountFingerprint) {
    throw new BringConfigError('Bring account fingerprint does not match BRING_EXPECTED_ACCOUNT_FINGERPRINT.');
  }

  const readableListUuids = parseUuidList(env['BRING_READABLE_LIST_UUIDS'], 'BRING_READABLE_LIST_UUIDS');
  const writableListUuids = parseUuidList(env['BRING_WRITABLE_LIST_UUIDS'], 'BRING_WRITABLE_LIST_UUIDS');
  const defaultListUuid = optional(env, 'BRING_DEFAULT_LIST_UUID');
  if (defaultListUuid && !uuidPattern.test(defaultListUuid)) {
    throw new BringConfigError('BRING_DEFAULT_LIST_UUID must be a valid UUID.');
  }

  const environment = getDeployedEnvironmentName(env);
  if (enabled && environment !== 'local' && readableListUuids.length === 0) {
    throw new BringConfigError(`BRING_READABLE_LIST_UUIDS is required in ${environment}.`);
  }
  if ((addEnabled || destructiveEnabled) && writableListUuids.length === 0) {
    throw new BringConfigError('BRING_WRITABLE_LIST_UUIDS is required when Bring writes are enabled.');
  }
  if (!enabled && (addEnabled || destructiveEnabled)) {
    throw new BringConfigError('Bring write flags require BRING_ENABLED=true.');
  }
  if (environment === 'test' && (addEnabled || destructiveEnabled)) {
    throw new BringConfigError('Bring writes are prohibited in test.');
  }
  if (writableListUuids.some((uuid) => !readableListUuids.includes(uuid))) {
    throw new BringConfigError('Every writable Bring list must also be readable.');
  }
  if (defaultListUuid && readableListUuids.length > 0 && !readableListUuids.includes(defaultListUuid)) {
    throw new BringConfigError('BRING_DEFAULT_LIST_UUID must be present in BRING_READABLE_LIST_UUIDS.');
  }

  const confirmationHmacKey = optional(env, 'BRING_CONFIRMATION_HMAC_KEY') ?? '';
  const mutationEncryptionKey = optional(env, 'BRING_MUTATION_ENCRYPTION_KEY') ?? '';
  if (addEnabled || destructiveEnabled) {
    validateSecretKey(confirmationHmacKey, 'BRING_CONFIRMATION_HMAC_KEY');
    validateEncryptionKey(mutationEncryptionKey);
  }

  return {
    enabled,
    addEnabled,
    destructiveEnabled,
    baseUrl: parsedBaseUrl.toString(),
    clientApiKey: required(env, 'BRING_CLIENT_API_KEY'),
    country,
    email,
    password: required(env, 'BRING_PASSWORD'),
    accountFingerprint,
    ...(expectedAccountFingerprint ? { expectedAccountFingerprint } : {}),
    ...(defaultListUuid ? { defaultListUuid } : {}),
    readableListUuids,
    writableListUuids,
    sessionCacheEnabled: readBoolean(env, 'BRING_SESSION_CACHE_ENABLED', true),
    sessionCacheContainer: optional(env, 'BRING_SESSION_CACHE_CONTAINER') ?? 'bring-private',
    sessionCacheBlob: optional(env, 'BRING_SESSION_CACHE_BLOB') ?? 'session-v1.json',
    mutationContainer: optional(env, 'BRING_MUTATION_CONTAINER') ?? 'bring-mutations',
    auditContainer: optional(env, 'BRING_AUDIT_CONTAINER') ?? 'bring-audit',
    storageAccountName: optional(env, 'BRING_STORAGE_ACCOUNT_NAME') ?? '',
    confirmationHmacKey,
    mutationEncryptionKey,
    timeoutMs: parsePositiveInteger(env['BRING_TIMEOUT_MS'], 10_000, 'BRING_TIMEOUT_MS'),
  };
}

export function fingerprintBringAccount(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = optional(env, name);
  if (!value) throw new BringConfigError(`${name} is required.`);
  return value;
}

function optional(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return env[name]?.trim() || undefined;
}

function readBoolean(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const value = optional(env, name);
  if (!value) return fallback;
  if (!['true', 'false'].includes(value.toLowerCase())) {
    throw new BringConfigError(`${name} must be true or false.`);
  }
  return value.toLowerCase() === 'true';
}

function parseUuidList(value: string | undefined, name: string): string[] {
  const values = (value ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (values.some((entry) => !uuidPattern.test(entry))) {
    throw new BringConfigError(`${name} must contain only UUIDs.`);
  }
  return [...new Set(values)];
}

function parseHttpsUrl(value: string, name: string): URL {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new BringConfigError(`${name} must be an absolute HTTPS URL.`);
  }
  if (parsed.protocol !== 'https:') throw new BringConfigError(`${name} must use HTTPS.`);
  return parsed;
}

function validateSecretKey(value: string, name: string): void {
  if (Buffer.byteLength(value, 'utf8') < 32) {
    throw new BringConfigError(`${name} must contain at least 32 bytes.`);
  }
}

function validateEncryptionKey(value: string): void {
  let decoded;
  try {
    decoded = Buffer.from(value, 'base64');
  } catch {
    throw new BringConfigError('BRING_MUTATION_ENCRYPTION_KEY must be base64 encoded.');
  }
  if (decoded.byteLength !== 32) {
    throw new BringConfigError('BRING_MUTATION_ENCRYPTION_KEY must decode to exactly 32 bytes.');
  }
}

function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 120_000) {
    throw new BringConfigError(`${name} must be an integer between 1 and 120000.`);
  }
  return parsed;
}
