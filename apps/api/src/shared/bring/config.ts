import type { BringConfig } from './types.js';

export class BringConfigError extends Error {}

export function readBringConfig(env: NodeJS.ProcessEnv = process.env): BringConfig {
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new BringConfigError(`${name} is required.`);
    return value;
  };
  const baseUrl = required('BRING_BASE_URL');
  let parsed: URL;
  try { parsed = new URL(baseUrl); } catch { throw new BringConfigError('BRING_BASE_URL must be an absolute HTTPS URL.'); }
  if (parsed.protocol !== 'https:') throw new BringConfigError('BRING_BASE_URL must use HTTPS.');
  const country = required('BRING_COUNTRY').toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) throw new BringConfigError('BRING_COUNTRY must be a two-letter country code.');
  const cacheEnabled = (env['BRING_SESSION_CACHE_ENABLED'] ?? 'true').trim().toLowerCase();
  if (!['true', 'false'].includes(cacheEnabled)) throw new BringConfigError('BRING_SESSION_CACHE_ENABLED must be true or false.');
  return {
    baseUrl: parsed.toString(), clientApiKey: required('BRING_CLIENT_API_KEY'), country,
    email: required('BRING_EMAIL'), password: required('BRING_PASSWORD'), defaultListUuid: env['BRING_DEFAULT_LIST_UUID']?.trim() || undefined,
    sessionCacheEnabled: cacheEnabled === 'true', sessionCacheContainer: env['BRING_SESSION_CACHE_CONTAINER']?.trim() || 'bring-private',
    sessionCacheBlob: env['BRING_SESSION_CACHE_BLOB']?.trim() || 'session-v1.json', storageAccountName: env['BRING_STORAGE_ACCOUNT_NAME']?.trim() || '',
    timeoutMs: 10_000,
  };
}

