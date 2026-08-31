import { DefaultAzureCredential } from '@azure/identity';
import { BlobServiceClient, type ContainerClient } from '@azure/storage-blob';
import type { RedditConfig } from '../../shared/reddit/config.js';
import {
  parseRedditThreadSnapshot,
  RedditSnapshotConflictError,
  type RedditThreadSnapshot,
  type RedditThreadSnapshotStore,
  type StoredRedditThreadSnapshot,
} from '../../shared/reddit/snapshot.js';

const MAX_STORED_SNAPSHOT_BYTES = 128 * 1024 * 1024;

export class AzureBlobRedditThreadSnapshotStore implements RedditThreadSnapshotStore {
  private readonly container: ContainerClient;

  constructor(config: RedditConfig) {
    if (!config.storageAccountName) throw new Error('REDDIT_STORAGE_ACCOUNT_NAME is required for snapshot storage.');
    const service = new BlobServiceClient(
      `https://${config.storageAccountName}.blob.core.windows.net`,
      new DefaultAzureCredential(),
    );
    this.container = service.getContainerClient(config.snapshotContainer);
  }

  async load(snapshotId: string): Promise<StoredRedditThreadSnapshot | null> {
    const blob = this.container.getBlockBlobClient(blobName(snapshotId));
    try {
      const response = await blob.download(0);
      if (!response.etag) throw new Error('Reddit snapshot blob did not return an ETag.');
      const text = await streamToBoundedText(response.readableStreamBody, MAX_STORED_SNAPSHOT_BYTES);
      return { snapshot: parseRedditThreadSnapshot(text), etag: response.etag };
    } catch (error) {
      if (hasStatusCode(error, 404)) return null;
      throw error;
    }
  }

  async create(snapshot: RedditThreadSnapshot): Promise<StoredRedditThreadSnapshot> {
    return this.upload(snapshot, { ifNoneMatch: '*' });
  }

  async replace(snapshot: RedditThreadSnapshot, expectedEtag: string): Promise<StoredRedditThreadSnapshot> {
    return this.upload(snapshot, { ifMatch: expectedEtag });
  }

  private async upload(
    snapshot: RedditThreadSnapshot,
    conditions: { ifNoneMatch: '*' } | { ifMatch: string },
  ): Promise<StoredRedditThreadSnapshot> {
    const blob = this.container.getBlockBlobClient(blobName(snapshot.snapshotId));
    const body = JSON.stringify(snapshot);
    if (Buffer.byteLength(body) > MAX_STORED_SNAPSHOT_BYTES) {
      throw new Error('Reddit thread snapshot exceeded the durable storage safety limit.');
    }
    try {
      const response = await blob.upload(body, Buffer.byteLength(body), {
        blobHTTPHeaders: { blobContentType: 'application/json' },
        conditions,
      });
      if (!response.etag) throw new Error('Reddit snapshot blob did not return an ETag.');
      return { snapshot, etag: response.etag };
    } catch (error) {
      if (hasStatusCode(error, 409) || hasStatusCode(error, 412)) throw new RedditSnapshotConflictError();
      throw error;
    }
  }
}

function blobName(snapshotId: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(snapshotId)) throw new Error('Reddit snapshot ID is invalid.');
  return `snapshots/${snapshotId.toLowerCase()}.json`;
}

async function streamToBoundedText(stream: NodeJS.ReadableStream | undefined, maxBytes: number): Promise<string> {
  if (!stream) return '';
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new Error('Stored Reddit thread snapshot exceeded the read safety limit.');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function hasStatusCode(error: unknown, statusCode: number): boolean {
  return isRecord(error) && error['statusCode'] === statusCode;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
