import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AuthenticatedPrincipal } from '../../authorization/types.js';
import type {
  BringMutationPayload,
  BringMutationRecord,
  EncryptedBringPayload,
} from '../../idempotency/bringMutation.js';
import type { BringMutationOperation } from '../../../shared/bring/types.js';

interface ConfirmationClaims {
  version: 2;
  purpose: 'bring-destructive-confirmation';
  operationId: string;
  operation: 'complete' | 'remove';
  payloadHash: string;
  principalPseudonym: string;
  listPseudonym: string;
  nonce: string;
  expiresAt: string;
}

type PayloadBinding = Pick<
  BringMutationRecord,
  'version' | 'operationId' | 'operation' | 'payloadHash' | 'principalPseudonym' | 'listPseudonym' | 'itemCount'
>;

const domains = {
  payloadHash: 'juez/api/bring/mutation-payload/v2',
  principalPseudonym: 'juez/api/bring/principal-pseudonym/v2',
  listPseudonym: 'juez/api/bring/list-pseudonym/v2',
  confirmationSignature: 'juez/api/bring/confirmation-signature/v2',
  confirmationNonce: 'juez/api/bring/confirmation-nonce/v2',
  confirmationTokenHmac: 'juez/api/bring/consumed-token-hmac/v2',
  payloadEncryption: 'juez/api/bring/payload-encryption/v2',
} as const;

const confirmationClaimKeys = [
  'expiresAt',
  'listPseudonym',
  'nonce',
  'operation',
  'operationId',
  'payloadHash',
  'principalPseudonym',
  'purpose',
  'version',
] as const;

export class BringMutationSecurity {
  private readonly encryptionKey: Buffer;

  constructor(
    private readonly hmacKey: string,
    encryptionKeyBase64: string,
  ) {
    this.encryptionKey = Buffer.from(encryptionKeyBase64, 'base64');
    if (Buffer.byteLength(hmacKey, 'utf8') < 32 || this.encryptionKey.byteLength !== 32) {
      throw new Error('Bring mutation security keys are invalid.');
    }
  }

  payloadHash(operation: BringMutationOperation, value: BringMutationPayload): string {
    return this.hash(domains.payloadHash, [
      ['operation', operation],
      ['payload', canonicalJson(value)],
    ]);
  }

  principalPseudonym(principal: AuthenticatedPrincipal): string {
    return this.hmac(domains.principalPseudonym, [
      ['tokenType', principal.tokenType],
      ['tenantKind', principal.tenantId ? 'entra-tenant' : 'local-unscoped'],
      ['tenantId', principal.tenantId ?? ''],
      ['clientId', principal.clientId ?? ''],
      ['identityKind', principal.objectId ? 'object-id' : 'subject'],
      ['identityValue', principal.objectId ?? principal.subject],
    ]);
  }

  listPseudonym(listUuid: string): string {
    return this.hmac(domains.listPseudonym, [['listUuid', listUuid.toLowerCase()]]);
  }

  createConfirmation(record: BringMutationRecord): { token: string; nonceHash: string } {
    if (record.version !== 2 || record.operation === 'add' || !record.confirmationExpiresAt) {
      throw new Error('Confirmation is only available for current prepared destructive mutations.');
    }
    const nonce = randomBytes(24).toString('base64url');
    const claims: ConfirmationClaims = {
      version: 2,
      purpose: 'bring-destructive-confirmation',
      operationId: record.operationId,
      operation: record.operation,
      payloadHash: record.payloadHash,
      principalPseudonym: record.principalPseudonym,
      listPseudonym: record.listPseudonym,
      nonce,
      expiresAt: record.confirmationExpiresAt,
    };
    const encoded = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const signature = this.sign(encoded);
    return {
      token: `${encoded}.${signature}`,
      nonceHash: this.hmac(domains.confirmationNonce, [['nonce', nonce]]),
    };
  }

  verifyConfirmation(token: string, record: BringMutationRecord, now: Date): boolean {
    if (record.version !== 2) return false;
    const claims = this.readConfirmation(token);
    if (!claims) return false;
    const nonceHash = this.hmac(domains.confirmationNonce, [['nonce', claims.nonce]]);
    return (
      confirmationMatchesRecord(claims, record) &&
      nonceHash === record.confirmationNonceHash &&
      claims.expiresAt === record.confirmationExpiresAt &&
      Date.parse(claims.expiresAt) > now.getTime()
    );
  }

  confirmationTokenHmac(token: string): string {
    return this.hmac(domains.confirmationTokenHmac, [['token', token]]);
  }

  verifyConsumedConfirmation(token: string, record: BringMutationRecord): boolean {
    if (record.version !== 2 || !record.confirmationTokenHmac) return false;
    const claims = this.readConfirmation(token);
    if (!claims || !confirmationMatchesRecord(claims, record)) return false;
    return safeEqual(this.confirmationTokenHmac(token), record.confirmationTokenHmac);
  }

  encryptPayload(payload: BringMutationPayload, binding: PayloadBinding): EncryptedBringPayload {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    cipher.setAAD(payloadAdditionalAuthenticatedData(binding));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
    return {
      algorithm: 'aes-256-gcm',
      iv: iv.toString('base64'),
      authenticationTag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
  }

  decryptPayload(payload: EncryptedBringPayload, binding: PayloadBinding): BringMutationPayload {
    const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, Buffer.from(payload.iv, 'base64'));
    decipher.setAAD(payloadAdditionalAuthenticatedData(binding));
    decipher.setAuthTag(Buffer.from(payload.authenticationTag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(payload.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
    const parsed: unknown = JSON.parse(plaintext);
    if (!isRecord(parsed) || typeof parsed['listUuid'] !== 'string' || !Array.isArray(parsed['items'])) {
      throw new Error('Encrypted Bring mutation payload is invalid.');
    }
    return {
      listUuid: parsed['listUuid'],
      items: parsed['items'] as BringMutationPayload['items'],
      ...(typeof parsed['expectedListVersion'] === 'string'
        ? { expectedListVersion: parsed['expectedListVersion'] }
        : {}),
    };
  }

  private readConfirmation(token: string): ConfirmationClaims | undefined {
    const [encoded, signature, extra] = token.split('.');
    if (!encoded || !signature || extra) return undefined;
    if (!safeEqual(signature, this.sign(encoded))) return undefined;

    let claims: unknown;
    try {
      claims = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown;
    } catch {
      return undefined;
    }
    if (!isConfirmationClaims(claims)) return undefined;
    const canonicalEncoded = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return safeEqual(encoded, canonicalEncoded) ? claims : undefined;
  }

  private hash(domain: string, fields: ReadonlyArray<readonly [string, string]>): string {
    return createHash('sha256').update(canonicalEnvelope(domain, fields)).digest('hex');
  }

  private hmac(domain: string, fields: ReadonlyArray<readonly [string, string]>): string {
    return createHmac('sha256', this.hmacKey).update(canonicalEnvelope(domain, fields)).digest('hex');
  }

  private sign(encoded: string): string {
    return createHmac('sha256', this.hmacKey)
      .update(canonicalEnvelope(domains.confirmationSignature, [['claims', encoded]]))
      .digest('base64url');
  }
}

function canonicalEnvelope(domain: string, fields: ReadonlyArray<readonly [string, string]>): string {
  return JSON.stringify([domain, fields]);
}

function payloadAdditionalAuthenticatedData(binding: PayloadBinding): Buffer {
  if (binding.version !== 2) {
    throw new Error('Legacy Bring mutation payloads are not accepted.');
  }
  return Buffer.from(
    canonicalEnvelope(domains.payloadEncryption, [
      ['version', String(binding.version)],
      ['operationId', binding.operationId],
      ['operation', binding.operation],
      ['payloadHash', binding.payloadHash],
      ['principalPseudonym', binding.principalPseudonym],
      ['listPseudonym', binding.listPseudonym],
      ['itemCount', String(binding.itemCount)],
    ]),
  );
}

function canonicalJson(value: BringMutationPayload): string {
  return JSON.stringify({
    listUuid: value.listUuid.toLowerCase(),
    ...(value.expectedListVersion ? { expectedListVersion: value.expectedListVersion } : {}),
    items: value.items.map((item) => ({
      name: item.name,
      ...(item.specification !== undefined ? { specification: item.specification } : {}),
      ...(item.uuid !== undefined ? { uuid: item.uuid.toLowerCase() } : {}),
    })),
  });
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.byteLength === rightBuffer.byteLength && timingSafeEqual(leftBuffer, rightBuffer);
}

function confirmationMatchesRecord(claims: ConfirmationClaims, record: BringMutationRecord): boolean {
  return (
    claims.operationId === record.operationId &&
    claims.operation === record.operation &&
    claims.payloadHash === record.payloadHash &&
    claims.principalPseudonym === record.principalPseudonym &&
    claims.listPseudonym === record.listPseudonym
  );
}

function isConfirmationClaims(value: unknown): value is ConfirmationClaims {
  return (
    isRecord(value) &&
    hasExactKeys(value, confirmationClaimKeys) &&
    value['version'] === 2 &&
    value['purpose'] === 'bring-destructive-confirmation' &&
    typeof value['operationId'] === 'string' &&
    (value['operation'] === 'complete' || value['operation'] === 'remove') &&
    typeof value['payloadHash'] === 'string' &&
    typeof value['principalPseudonym'] === 'string' &&
    typeof value['listPseudonym'] === 'string' &&
    typeof value['nonce'] === 'string' &&
    typeof value['expiresAt'] === 'string'
  );
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
