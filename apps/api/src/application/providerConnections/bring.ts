import type { AuthenticatedPrincipal, TokenType } from '../authorization/types.js';
import { BringConfigError } from '../../shared/bring/config.js';
import { BringPolicyError } from '../../shared/bring/service.js';
import type { BringConfig } from '../../shared/bring/types.js';

export const LEGACY_BRING_CONNECTION_ID = 'operator';
export const LEGACY_BRING_CREDENTIAL_REFERENCE = 'legacy-environment-v1';
export const LEGACY_BRING_STORAGE_NAMESPACE = 'legacy-operator-v1';

export type BringPrincipalSelector = {
  tokenType: TokenType;
  tenantId: string;
  clientId?: string;
  objectId?: string;
  subject?: string;
};

export interface BringConnectionGrant {
  connectionId: string;
  principal: BringPrincipalSelector;
}

export interface BringConnectionPolicy {
  enabled: boolean;
  addEnabled: boolean;
  destructiveEnabled: boolean;
  accountFingerprint: string;
  readableListUuids: readonly string[];
  writableListUuids: readonly string[];
  writableSharedListUuids: readonly string[];
}

export interface BringConnection {
  id: string;
  credentialReference: string;
  policy: BringConnectionPolicy;
  storage: {
    namespace: string;
    sessionCacheContainer: string;
    sessionCacheBlob: string;
    mutationContainer: string;
    auditContainer: string;
  };
}

export interface BringConnectionResolverPort {
  resolve(principal: AuthenticatedPrincipal): BringConnection;
}

export class BringConnectionAccessError extends BringPolicyError {}

/**
 * This descriptor names the existing operator credentials and unchanged private blob locations.
 * The namespace records their ownership without adding a path prefix or moving legacy data.
 * Before another connection is registered, sessions, snapshots/caches, mutation/idempotency
 * records, and audit events must be partitioned by both connection and principal. A new
 * connection must never resolve to this legacy namespace or reuse its cached provider state.
 */
export function createLegacyBringConnection(config: BringConfig): BringConnection {
  return {
    id: LEGACY_BRING_CONNECTION_ID,
    credentialReference: LEGACY_BRING_CREDENTIAL_REFERENCE,
    policy: {
      enabled: config.enabled,
      addEnabled: config.addEnabled,
      destructiveEnabled: config.destructiveEnabled,
      accountFingerprint: config.accountFingerprint,
      readableListUuids: [...config.readableListUuids],
      writableListUuids: [...config.writableListUuids],
      writableSharedListUuids: [...config.writableSharedListUuids],
    },
    storage: {
      namespace: LEGACY_BRING_STORAGE_NAMESPACE,
      sessionCacheContainer: config.sessionCacheContainer,
      sessionCacheBlob: config.sessionCacheBlob,
      mutationContainer: config.mutationContainer,
      auditContainer: config.auditContainer,
    },
  };
}

export class ConfiguredBringConnectionResolver implements BringConnectionResolverPort {
  private parsedGrants: readonly BringConnectionGrant[] | undefined;
  private readonly connections: ReadonlyMap<string, BringConnection>;

  constructor(
    connections: readonly BringConnection[],
    private readonly grantsJson: string | undefined,
  ) {
    this.connections = new Map(connections.map((connection) => [connection.id, connection]));
    if (this.connections.size !== connections.length) {
      throw new BringConfigError('Bring connection IDs must be unique.');
    }
  }

  resolve(principal: AuthenticatedPrincipal): BringConnection {
    const grant = this.grants().find((candidate) => matchesPrincipal(candidate.principal, principal));
    if (!grant) {
      throw new BringConnectionAccessError('Authenticated principal has no Bring connection grant.');
    }
    const connection = this.connections.get(grant.connectionId);
    if (!connection) {
      throw new BringConfigError('BRING_CONNECTION_GRANTS references an unknown server connection.');
    }
    return connection;
  }

  private grants(): readonly BringConnectionGrant[] {
    this.parsedGrants ??= parseBringConnectionGrants(this.grantsJson);
    return this.parsedGrants;
  }
}

export function parseBringConnectionGrants(value: string | undefined): BringConnectionGrant[] {
  if (value === undefined || value.trim().length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new BringConfigError('BRING_CONNECTION_GRANTS must be valid JSON.');
  }
  const root = requireRecord(parsed, 'BRING_CONNECTION_GRANTS');
  assertOnlyKeys(root, ['version', 'grants'], 'BRING_CONNECTION_GRANTS');
  if (root['version'] !== 1) {
    throw new BringConfigError('BRING_CONNECTION_GRANTS.version must be 1.');
  }
  if (!Array.isArray(root['grants']) || root['grants'].length === 0 || root['grants'].length > 100) {
    throw new BringConfigError('BRING_CONNECTION_GRANTS.grants must contain between 1 and 100 grants.');
  }
  const grants = root['grants'].map((entry, index) => parseGrant(entry, index));
  const identities = grants.map((grant) => selectorKey(grant.principal));
  if (new Set(identities).size !== identities.length) {
    throw new BringConfigError('BRING_CONNECTION_GRANTS must not contain duplicate principal selectors.');
  }
  return grants;
}

function parseGrant(value: unknown, index: number): BringConnectionGrant {
  const path = `BRING_CONNECTION_GRANTS.grants[${index}]`;
  const grant = requireRecord(value, path);
  assertOnlyKeys(grant, ['connectionId', 'principal'], path);
  const connectionId = boundedString(grant['connectionId'], `${path}.connectionId`, 64);
  if (!/^[a-z][a-z0-9-]*$/.test(connectionId)) {
    throw new BringConfigError(`${path}.connectionId must use lowercase letters, digits, and hyphens.`);
  }
  const principal = requireRecord(grant['principal'], `${path}.principal`);
  assertOnlyKeys(principal, ['tokenType', 'tenantId', 'clientId', 'objectId', 'subject'], `${path}.principal`);
  const tokenType = principal['tokenType'];
  if (tokenType !== 'user' && tokenType !== 'service') {
    throw new BringConfigError(`${path}.principal.tokenType must be user or service.`);
  }
  const tenantId = uuid(principal['tenantId'], `${path}.principal.tenantId`);
  const objectId = optionalUuid(principal['objectId'], `${path}.principal.objectId`);
  const subject = optionalBoundedString(principal['subject'], `${path}.principal.subject`, 512);
  if ((objectId ? 1 : 0) + (subject ? 1 : 0) !== 1) {
    throw new BringConfigError(`${path}.principal must contain exactly one of objectId or subject.`);
  }
  const clientId = optionalUuid(principal['clientId'], `${path}.principal.clientId`);
  if (tokenType === 'user' && clientId) {
    throw new BringConfigError(`${path}.principal.clientId is allowed only for service principals.`);
  }
  if (tokenType === 'service' && !clientId) {
    throw new BringConfigError(`${path}.principal.clientId is required for service principals.`);
  }
  return {
    connectionId,
    principal: {
      tokenType,
      tenantId,
      ...(clientId ? { clientId } : {}),
      ...(objectId ? { objectId } : {}),
      ...(subject ? { subject } : {}),
    },
  };
}

function matchesPrincipal(selector: BringPrincipalSelector, principal: AuthenticatedPrincipal): boolean {
  if (selector.tokenType !== principal.tokenType) return false;
  if (!principal.tenantId || selector.tenantId !== principal.tenantId.toLowerCase()) return false;
  if (selector.clientId && (!principal.clientId || selector.clientId !== principal.clientId.toLowerCase()))
    return false;
  if (selector.objectId) return Boolean(principal.objectId && selector.objectId === principal.objectId.toLowerCase());
  return selector.subject === principal.subject;
}

function selectorKey(selector: BringPrincipalSelector): string {
  return [
    selector.tokenType,
    selector.tenantId,
    selector.clientId ?? '',
    selector.objectId ? 'objectId' : 'subject',
    selector.objectId ?? selector.subject ?? '',
  ].join('|');
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BringConfigError(`${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected) throw new BringConfigError(`${path} contains unsupported field ${unexpected}.`);
}

function uuid(value: unknown, path: string): string {
  const normalized = boundedString(value, path, 36).toLowerCase();
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(normalized)) {
    throw new BringConfigError(`${path} must be a canonical hexadecimal GUID.`);
  }
  return normalized;
}

function optionalUuid(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : uuid(value, path);
}

function boundedString(value: unknown, path: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || value.trim() !== value) {
    throw new BringConfigError(`${path} must be a non-empty bounded string without surrounding whitespace.`);
  }
  if (value.includes('*')) throw new BringConfigError(`${path} must not contain wildcards.`);
  return value;
}

function optionalBoundedString(value: unknown, path: string, maxLength: number): string | undefined {
  return value === undefined ? undefined : boundedString(value, path, maxLength);
}
