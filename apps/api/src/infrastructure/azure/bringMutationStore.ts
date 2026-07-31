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
      const record = parseRecord(await streamToText(response.readableStreamBody));
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

function parseRecord(text: string): BringMutationRecord {
  const parsed: unknown = JSON.parse(text);
  if (
    !isRecord(parsed) ||
    parsed['version'] !== 1 ||
    typeof parsed['operationId'] !== 'string' ||
    typeof parsed['state'] !== 'string'
  ) {
    throw new Error('Stored Bring mutation record is invalid.');
  }
  return parsed as unknown as BringMutationRecord;
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
