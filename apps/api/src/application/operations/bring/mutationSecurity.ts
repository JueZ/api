import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AuthenticatedPrincipal } from '../../authorization/types.js';
import type {
  BringMutationPayload,
  BringMutationRecord,
  EncryptedBringPayload,
} from '../../idempotency/bringMutation.js';

interface ConfirmationClaims {
  version: 1;
  operationId: string;
  operation: 'complete' | 'remove';
  payloadHash: string;
  principalPseudonym: string;
  nonce: string;
  expiresAt: string;
}

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

  payloadHash(value: BringMutationPayload): string {
    return createHash('sha256').update(canonicalJson(value)).digest('hex');
  }

  principalPseudonym(principal: AuthenticatedPrincipal): string {
    return this.pseudonym(
      [principal.tokenType, principal.clientId ?? '', principal.objectId ?? principal.subject].join(':'),
    );
  }

  listPseudonym(listUuid: string): string {
    return this.pseudonym(`bring-list:${listUuid.toLowerCase()}`);
  }

  createConfirmation(record: BringMutationRecord): { token: string; nonceHash: string } {
    if (record.operation === 'add' || !record.confirmationExpiresAt) {
      throw new Error('Confirmation is only available for prepared destructive mutations.');
    }
    const nonce = randomBytes(24).toString('base64url');
    const claims: ConfirmationClaims = {
      version: 1,
      operationId: record.operationId,
      operation: record.operation,
      payloadHash: record.payloadHash,
      principalPseudonym: record.principalPseudonym,
      nonce,
      expiresAt: record.confirmationExpiresAt,
    };
    const encoded = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const signature = this.sign(encoded);
    return {
      token: `${encoded}.${signature}`,
      nonceHash: createHash('sha256').update(nonce).digest('hex'),
    };
  }

  verifyConfirmation(token: string, record: BringMutationRecord, now: Date): boolean {
    const [encoded, signature, extra] = token.split('.');
    if (!encoded || !signature || extra) return false;
    const expectedSignature = this.sign(encoded);
    if (!safeEqual(signature, expectedSignature)) return false;

    let claims: unknown;
    try {
      claims = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown;
    } catch {
      return false;
    }
    if (!isConfirmationClaims(claims)) return false;
    const nonceHash = createHash('sha256').update(claims.nonce).digest('hex');
    return (
      claims.operationId === record.operationId &&
      claims.operation === record.operation &&
      claims.payloadHash === record.payloadHash &&
      claims.principalPseudonym === record.principalPseudonym &&
      nonceHash === record.confirmationNonceHash &&
      claims.expiresAt === record.confirmationExpiresAt &&
      Date.parse(claims.expiresAt) > now.getTime()
    );
  }

  peekConfirmationOperation(token: string): 'complete' | 'remove' | undefined {
    const encoded = token.split('.')[0];
    if (!encoded) return undefined;
    try {
      const claims: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
      return isConfirmationClaims(claims) ? claims.operation : undefined;
    } catch {
      return undefined;
    }
  }

  encryptPayload(payload: BringMutationPayload): EncryptedBringPayload {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
    return {
      algorithm: 'aes-256-gcm',
      iv: iv.toString('base64'),
      authenticationTag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
  }

  decryptPayload(payload: EncryptedBringPayload): BringMutationPayload {
    const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, Buffer.from(payload.iv, 'base64'));
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

  private pseudonym(value: string): string {
    return createHmac('sha256', this.hmacKey).update(value).digest('hex');
  }

  private sign(value: string): string {
    return createHmac('sha256', this.hmacKey).update(value).digest('base64url');
  }
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

function isConfirmationClaims(value: unknown): value is ConfirmationClaims {
  return (
    isRecord(value) &&
    value['version'] === 1 &&
    typeof value['operationId'] === 'string' &&
    (value['operation'] === 'complete' || value['operation'] === 'remove') &&
    typeof value['payloadHash'] === 'string' &&
    typeof value['principalPseudonym'] === 'string' &&
    typeof value['nonce'] === 'string' &&
    typeof value['expiresAt'] === 'string'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
