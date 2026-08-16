import { DefaultAzureCredential } from '@azure/identity';
import { BlobServiceClient, type ContainerClient } from '@azure/storage-blob';
import type {
  BringMutationRecord,
  BringMutationStore,
  StoredBringMutation,
} from '../../application/idempotency/bringMutation.js';
import { BringMutationStoreConflictError } from '../../application/idempotency/bringMutation.js';
import type { BringConfig } from '../../shared/bring/types.js';

export class AzureBlobBringMutationStore implements BringMutationStore {
  private readonly container: ContainerClient;

  constructor(config: BringConfig) {
    if (!config.storageAccountName) {
      throw new Error('BRING_STORAGE_ACCOUNT_NAME is required for mutation storage.');
    }
    const service = new BlobServiceClient(
      `https://${config.storageAccountName}.blob.core.windows.net`,
      new DefaultAzureCredential(),
    );
    this.container = service.getContainerClient(config.mutationContainer);
  }

  async get(operationId: string): Promise<StoredBringMutation | null> {
    const blob = this.container.getBlockBlobClient(blobName(operationId));
    try {
      const response = await blob.download(0);
      const record = parseBringMutationRecord(await streamToText(response.readableStreamBody));
      if (record.operationId !== operationId.toLowerCase()) {
        throw new Error('Stored Bring mutation record does not match its operation key.');
      }
      if (!response.etag) throw new Error('Bring mutation blob did not return an ETag.');
      return { record, etag: response.etag };
    } catch (error) {
      if (hasStatusCode(error, 404)) return null;
      throw error;
    }
  }

  async create(record: BringMutationRecord): Promise<StoredBringMutation> {
    const blob = this.container.getBlockBlobClient(blobName(record.operationId));
    const body = JSON.stringify(record);
    try {
      const response = await blob.upload(body, Buffer.byteLength(body), {
        blobHTTPHeaders: { blobContentType: 'application/json' },
        conditions: { ifNoneMatch: '*' },
      });
      if (!response.etag) throw new Error('Bring mutation blob did not return an ETag.');
      return { record, etag: response.etag };
    } catch (error) {
      if (hasStatusCode(error, 409) || hasStatusCode(error, 412)) {
        throw new BringMutationStoreConflictError('Mutation operation already exists.');
      }
      throw error;
    }
  }

  async replace(record: BringMutationRecord, expectedEtag: string): Promise<StoredBringMutation> {
    const blob = this.container.getBlockBlobClient(blobName(record.operationId));
    const body = JSON.stringify(record);
    try {
      const response = await blob.upload(body, Buffer.byteLength(body), {
        blobHTTPHeaders: { blobContentType: 'application/json' },
        conditions: { ifMatch: expectedEtag },
      });
      if (!response.etag) throw new Error('Bring mutation blob did not return an ETag.');
      return { record, etag: response.etag };
    } catch (error) {
      if (hasStatusCode(error, 409) || hasStatusCode(error, 412)) {
        throw new BringMutationStoreConflictError('Mutation operation changed concurrently.');
      }
      throw error;
    }
  }
}

function blobName(operationId: string): string {
  return `operations/${operationId.toLowerCase()}.json`;
}

export function parseBringMutationRecord(text: string): BringMutationRecord {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed) || typeof parsed['operationId'] !== 'string') {
    throw new Error('Stored Bring mutation record is invalid.');
  }
  if (parsed['version'] === 1) {
    // Version 1 is retained only as an opaque migration tombstone. The
    // coordinator rejects it before reading any legacy identity or payload field.
    return parsed as unknown as BringMutationRecord;
  }
  if (parsed['version'] !== 2 || !isValidV2Record(parsed)) {
    throw new Error('Stored Bring mutation record is invalid.');
  }
  return parsed as unknown as BringMutationRecord;
}

const recordKeys = new Set([
  'auditTrail',
  'confirmationExpiresAt',
  'confirmationNonceHash',
  'confirmationTokenHmac',
  'createdAt',
  'encryptedPayload',
  'itemCount',
  'listPseudonym',
  'operation',
  'operationId',
  'payloadHash',
  'principalPseudonym',
  'replayUntil',
  'result',
  'state',
  'updatedAt',
  'version',
]);
const mutationStates = new Set(['prepared', 'applying', 'succeeded', 'rejected', 'expired', 'outcome_unknown']);
const mutationOperations = new Set(['add', 'complete', 'remove']);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sha256Pattern = /^[0-9a-f]{64}$/;

function isValidV2Record(record: Record<string, unknown>): boolean {
  return (
    Object.keys(record).every((key) => recordKeys.has(key)) &&
    uuidPattern.test(String(record['operationId'])) &&
    mutationOperations.has(record['operation'] as string) &&
    mutationStates.has(record['state'] as string) &&
    typeof record['payloadHash'] === 'string' &&
    sha256Pattern.test(record['payloadHash']) &&
    typeof record['principalPseudonym'] === 'string' &&
    sha256Pattern.test(record['principalPseudonym']) &&
    typeof record['listPseudonym'] === 'string' &&
    sha256Pattern.test(record['listPseudonym']) &&
    isBoundedItemCount(record['itemCount']) &&
    isTimestamp(record['createdAt']) &&
    isTimestamp(record['updatedAt']) &&
    isTimestamp(record['replayUntil']) &&
    isOptionalTimestamp(record['confirmationExpiresAt']) &&
    isOptionalDigest(record['confirmationNonceHash']) &&
    isOptionalDigest(record['confirmationTokenHmac']) &&
    isOptionalEncryptedPayload(record['encryptedPayload']) &&
    isOptionalResult(record['result']) &&
    resultMatchesRecord(record['result'], record) &&
    recordStateIsConsistent(record) &&
    Array.isArray(record['auditTrail']) &&
    record['auditTrail'].length > 0 &&
    record['auditTrail'].every(isAuditEvent) &&
    record['auditTrail'].every((event) => auditMatchesRecord(event, record))
  );
}

function isOptionalEncryptedPayload(value: unknown): boolean {
  if (value === undefined) return true;
  return (
    isRecord(value) &&
    hasExactKeys(value, ['algorithm', 'authenticationTag', 'ciphertext', 'iv']) &&
    value['algorithm'] === 'aes-256-gcm' &&
    isBase64Bytes(value['iv'], 12) &&
    isBase64Bytes(value['authenticationTag'], 16) &&
    isBase64Bytes(value['ciphertext'])
  );
}

function isOptionalResult(value: unknown): boolean {
  if (value === undefined) return true;
  return (
    isRecord(value) &&
    hasExactKeys(value, ['itemCount', 'listUuid', 'operation', 'operationId', 'replayed', 'source', 'state']) &&
    value['source'] === 'bring' &&
    typeof value['listUuid'] === 'string' &&
    uuidPattern.test(value['listUuid']) &&
    mutationOperations.has(value['operation'] as string) &&
    typeof value['operationId'] === 'string' &&
    uuidPattern.test(value['operationId']) &&
    isBoundedItemCount(value['itemCount']) &&
    value['state'] === 'succeeded' &&
    typeof value['replayed'] === 'boolean'
  );
}

function resultMatchesRecord(value: unknown, record: Record<string, unknown>): boolean {
  return (
    value === undefined ||
    (isRecord(value) &&
      value['operationId'] === record['operationId'] &&
      value['operation'] === record['operation'] &&
      value['itemCount'] === record['itemCount'])
  );
}

function recordStateIsConsistent(record: Record<string, unknown>): boolean {
  const state = record['state'];
  const operation = record['operation'];
  const destructive = operation === 'complete' || operation === 'remove';
  if (state === 'prepared' || state === 'expired') {
    return (
      destructive &&
      record['encryptedPayload'] !== undefined &&
      record['confirmationExpiresAt'] !== undefined &&
      record['confirmationNonceHash'] !== undefined &&
      record['confirmationTokenHmac'] === undefined &&
      record['result'] === undefined
    );
  }
  if (state === 'applying') {
    return (
      record['encryptedPayload'] !== undefined &&
      record['confirmationExpiresAt'] === undefined &&
      record['confirmationNonceHash'] === undefined &&
      record['result'] === undefined &&
      (destructive ? record['confirmationTokenHmac'] !== undefined : record['confirmationTokenHmac'] === undefined)
    );
  }
  if (state === 'succeeded') {
    return (
      record['encryptedPayload'] === undefined &&
      record['confirmationExpiresAt'] === undefined &&
      record['confirmationNonceHash'] === undefined &&
      record['result'] !== undefined &&
      (destructive ? record['confirmationTokenHmac'] !== undefined : record['confirmationTokenHmac'] === undefined)
    );
  }
  return (
    (state === 'rejected' || state === 'outcome_unknown') &&
    record['encryptedPayload'] === undefined &&
    record['confirmationExpiresAt'] === undefined &&
    record['confirmationNonceHash'] === undefined &&
    record['result'] === undefined &&
    (destructive ? record['confirmationTokenHmac'] !== undefined : record['confirmationTokenHmac'] === undefined)
  );
}

function isAuditEvent(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const allowedKeys = [
    'correlationId',
    'deployedCommitSha',
    'eventId',
    'itemCount',
    'listPseudonym',
    'operation',
    'operationId',
    'principalPseudonym',
    'providerStatus',
    'result',
    'timestamp',
  ];
  return (
    Object.keys(value).every((key) => allowedKeys.includes(key)) &&
    typeof value['eventId'] === 'string' &&
    isTimestamp(value['timestamp']) &&
    typeof value['operationId'] === 'string' &&
    uuidPattern.test(value['operationId']) &&
    mutationOperations.has(value['operation'] as string) &&
    typeof value['principalPseudonym'] === 'string' &&
    sha256Pattern.test(value['principalPseudonym']) &&
    typeof value['listPseudonym'] === 'string' &&
    sha256Pattern.test(value['listPseudonym']) &&
    isBoundedItemCount(value['itemCount']) &&
    typeof value['correlationId'] === 'string' &&
    mutationStates.has(value['result'] as string) &&
    typeof value['deployedCommitSha'] === 'string' &&
    (value['providerStatus'] === undefined ||
      (Number.isInteger(value['providerStatus']) &&
        Number(value['providerStatus']) >= 100 &&
        Number(value['providerStatus']) <= 599))
  );
}

function auditMatchesRecord(value: unknown, record: Record<string, unknown>): boolean {
  return (
    isRecord(value) &&
    value['operationId'] === record['operationId'] &&
    value['operation'] === record['operation'] &&
    value['principalPseudonym'] === record['principalPseudonym'] &&
    value['listPseudonym'] === record['listPseudonym'] &&
    value['itemCount'] === record['itemCount']
  );
}

function isBoundedItemCount(value: unknown): boolean {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 50;
}

function isTimestamp(value: unknown): boolean {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isOptionalTimestamp(value: unknown): boolean {
  return value === undefined || isTimestamp(value);
}

function isOptionalDigest(value: unknown): boolean {
  return value === undefined || (typeof value === 'string' && sha256Pattern.test(value));
}

function isBase64Bytes(value: unknown, exactBytes?: number): boolean {
  if (typeof value !== 'string' || value.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  const decoded = Buffer.from(value, 'base64');
  return decoded.toString('base64') === value && (exactBytes === undefined || decoded.byteLength === exactBytes);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

async function streamToText(stream: NodeJS.ReadableStream | undefined): Promise<string> {
  if (!stream) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function hasStatusCode(error: unknown, statusCode: number): boolean {
  return isRecord(error) && error['statusCode'] === statusCode;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
