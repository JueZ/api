export type DeployedEnvironmentName = 'local' | 'test' | 'prod';

export class RuntimeConfigurationError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Unsafe runtime configuration:\n- ${problems.join('\n- ')}`);
  }
}

const canonicalPermissions = [
  'catalogue.read',
  'reddit.read',
  'wlh.read',
  'bring.read',
  'bring.write',
  'bring.complete',
  'bring.remove',
] as const;
const guidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function getDeployedEnvironmentName(env: NodeJS.ProcessEnv = process.env): DeployedEnvironmentName {
  const value = env['DEPLOYED_ENVIRONMENT_NAME']?.trim().toLowerCase();
  if (value === 'test' || value === 'prod') return value;
  return 'local';
}

export function validateRuntimeSafety(env: NodeJS.ProcessEnv = process.env): string[] {
  const environment = getDeployedEnvironmentName(env);
  if (environment === 'local') return [];

  const problems = [];
  if (env['AUTH_ENABLED'] !== 'true') {
    problems.push(`AUTH_ENABLED must be true in ${environment}`);
  }
  const issuers = parseCsv(env['OIDC_ISSUER']);
  if (issuers.length === 0 || issuers.some((issuer) => !validHttpsUrl(issuer))) {
    problems.push(`OIDC_ISSUER must contain only absolute HTTPS issuer URLs in ${environment}`);
  }
  if (!env['OIDC_AUDIENCE']?.trim()) {
    problems.push(`OIDC_AUDIENCE is required in ${environment}`);
  }
  if (env['OIDC_JWKS_URI']?.trim() && !validHttpsUrl(env['OIDC_JWKS_URI'].trim())) {
    problems.push(`OIDC_JWKS_URI must be an absolute HTTPS URL in ${environment}`);
  }
  const configuredPermissions = new Set(parseCsv(env['OIDC_REQUIRED_SCOPES']));
  if (canonicalPermissions.some((permission) => !configuredPermissions.has(permission))) {
    problems.push(`OIDC_REQUIRED_SCOPES must include every canonical operation permission in ${environment}`);
  }
  const allowedObjectIds = parseCsv(env['OIDC_ALLOWED_OBJECT_IDS']);
  if (allowedObjectIds.length === 0 || allowedObjectIds.some((value) => !guidPattern.test(value))) {
    problems.push(`OIDC_ALLOWED_OBJECT_IDS must contain at least one valid user object ID in ${environment}`);
  }
  const allowedTenants = parseCsv(env['OIDC_ALLOWED_TENANTS']);
  if (allowedTenants.length === 0 || allowedTenants.some((value) => !guidPattern.test(value))) {
    problems.push(`OIDC_ALLOWED_TENANTS must contain at least one valid tenant ID in ${environment}`);
  }

  const corsOrigins = parseCsv(env['API_CORS_ALLOWED_ORIGINS']);
  if (corsOrigins.length === 0) {
    problems.push(`API_CORS_ALLOWED_ORIGINS is required in ${environment}`);
  } else if (corsOrigins.some((origin) => !validHttpsOrigin(origin))) {
    problems.push(`API_CORS_ALLOWED_ORIGINS must contain only exact HTTPS origins in ${environment}`);
  }

  const mcpOrigin = validHttpsOrigin(env['MCP_RESOURCE_ORIGIN']);
  if (!mcpOrigin) {
    problems.push(`MCP_RESOURCE_ORIGIN must be an absolute HTTPS origin in ${environment}`);
  }

  const mcpAllowedOrigins = parseCsv(env['MCP_ALLOWED_ORIGINS']);
  if (mcpAllowedOrigins.length === 0) {
    problems.push(`MCP_ALLOWED_ORIGINS is required in ${environment}`);
  } else if (mcpAllowedOrigins.some((origin) => origin === '*' || !validHttpsOrigin(origin))) {
    problems.push(`MCP_ALLOWED_ORIGINS must contain only exact HTTPS origins in ${environment}`);
  }

  for (const name of ['BRING_ENABLED', 'BRING_ADD_ENABLED', 'BRING_DESTRUCTIVE_ENABLED']) {
    if (!['true', 'false'].includes(env[name] ?? '')) {
      problems.push(`${name} must be explicitly true or false in ${environment}`);
    }
  }
  const bringEnabled = env['BRING_ENABLED'] === 'true';
  const bringWritesEnabled = env['BRING_ADD_ENABLED'] === 'true' || env['BRING_DESTRUCTIVE_ENABLED'] === 'true';
  if (bringWritesEnabled && !bringEnabled) {
    problems.push('Bring write flags require BRING_ENABLED=true');
  }
  if (environment === 'test' && bringWritesEnabled) {
    problems.push('Bring writes must remain disabled in test');
  }
  if (bringEnabled) {
    if (!/^[0-9a-f]{64}$/.test(env['BRING_EXPECTED_ACCOUNT_FINGERPRINT'] ?? '')) {
      problems.push(`BRING_EXPECTED_ACCOUNT_FINGERPRINT must be a lowercase SHA-256 digest in ${environment}`);
    }
    const readableLists = parseCsv(env['BRING_READABLE_LIST_UUIDS']);
    if (readableLists.length === 0 || readableLists.some((value) => !uuidPattern.test(value))) {
      problems.push(`BRING_READABLE_LIST_UUIDS must contain valid UUIDs in ${environment}`);
    }
  }
  if (bringWritesEnabled) {
    const writableLists = parseCsv(env['BRING_WRITABLE_LIST_UUIDS']);
    const writableSharedLists = parseCsv(env['BRING_WRITABLE_SHARED_LIST_UUIDS']);
    if (environment !== 'prod') {
      problems.push('Bring writes are allowed only in production');
    }
    if (writableLists.length === 0 || writableLists.some((value) => !uuidPattern.test(value))) {
      problems.push('BRING_WRITABLE_LIST_UUIDS must contain explicit valid UUIDs when writes are enabled');
    }
    const readableLists = new Set(parseCsv(env['BRING_READABLE_LIST_UUIDS']));
    if (writableLists.some((value) => !readableLists.has(value))) {
      problems.push('Every writable Bring list must also be readable');
    }
    if (writableSharedLists.some((value) => !uuidPattern.test(value))) {
      problems.push('BRING_WRITABLE_SHARED_LIST_UUIDS must contain only valid UUIDs');
    }
    const writableListSet = new Set(writableLists);
    if (writableSharedLists.some((value) => !writableListSet.has(value))) {
      problems.push('Every shared-writable Bring list must also be writable');
    }
  }

  return problems;
}

export function assertRuntimeSafety(env: NodeJS.ProcessEnv = process.env): void {
  const problems = validateRuntimeSafety(env);
  if (problems.length > 0) throw new RuntimeConfigurationError(problems);
}

function validHttpsOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.origin !== value) return undefined;
    return parsed.origin;
  } catch {
    return undefined;
  }
}

function validHttpsUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
  } catch {
    return false;
  }
}

function parseCsv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}
