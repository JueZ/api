export type RuntimeEnvironmentName = 'test' | 'prod' | 'local' | 'unknown';

export interface RuntimeProvenance {
  environmentName: RuntimeEnvironmentName;
  deployedCommitSha: string;
  deployedSourceRef: string;
  deploymentRunId: string;
  deployedAtUtc: string;
  buildTimestampUtc: string;
}

const KNOWN_ENVIRONMENTS = new Set<RuntimeEnvironmentName>(['test', 'prod', 'local', 'unknown']);
const SHA_PATTERN = /^[0-9a-f]{40}$/i;

export function readRuntimeProvenance(env: NodeJS.ProcessEnv = process.env, now: Date = new Date()): RuntimeProvenance {
  const fallbackTimestamp = now.toISOString();
  const environmentName = normalizeEnvironmentName(env['DEPLOYED_ENVIRONMENT_NAME'] ?? env['ENVIRONMENT_NAME'] ?? (env['AZURE_FUNCTIONS_ENVIRONMENT'] ? 'unknown' : 'local'));
  const deployedCommitSha = normalizeSha(env['DEPLOYED_COMMIT_SHA']);
  const deployedSourceRef = normalizeSha(env['DEPLOYED_SOURCE_REF']) || deployedCommitSha || 'unknown';

  return {
    environmentName,
    deployedCommitSha: deployedCommitSha || 'unknown',
    deployedSourceRef,
    deploymentRunId: normalizeToken(env['DEPLOYMENT_RUN_ID']),
    deployedAtUtc: normalizeIsoTimestamp(env['DEPLOYED_AT_UTC']) || 'unknown',
    buildTimestampUtc: normalizeIsoTimestamp(env['BUILD_TIMESTAMP_UTC']) || fallbackTimestamp,
  };
}

function normalizeEnvironmentName(value: string | undefined): RuntimeEnvironmentName {
  const normalized = (value ?? '').trim().toLowerCase();
  return KNOWN_ENVIRONMENTS.has(normalized as RuntimeEnvironmentName) ? (normalized as RuntimeEnvironmentName) : 'unknown';
}

function normalizeSha(value: string | undefined): string {
  const normalized = (value ?? '').trim();
  return SHA_PATTERN.test(normalized) ? normalized.toLowerCase() : '';
}

function normalizeToken(value: string | undefined): string {
  const normalized = (value ?? '').trim();
  if (!normalized) return 'unknown';
  return normalized.replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 128) || 'unknown';
}

function normalizeIsoTimestamp(value: string | undefined): string {
  const normalized = (value ?? '').trim();
  if (!normalized) return '';
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString();
}
