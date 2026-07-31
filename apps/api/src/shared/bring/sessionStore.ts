import { DefaultAzureCredential } from '@azure/identity';
import { BlobServiceClient, type BlockBlobClient, type ContainerClient } from '@azure/storage-blob';
import type { BringConfig, BringSession } from './types.js';

export interface BringSessionStore {
  load(): Promise<BringSession | null>;
  save(session: BringSession): Promise<void>;
  clear(): Promise<void>;
}

export type SafeWarning = (message: string, details?: Record<string, unknown>) => void;

export class BringSessionConflictError extends Error {}

export class AzureBlobBringSessionStore implements BringSessionStore {
  private readonly blob: BlockBlobClient;
  private readonly container: ContainerClient;
  private etag: string | undefined;

  constructor(
    config: BringConfig,
    private readonly warn: SafeWarning = () => undefined,
  ) {
    if (!config.storageAccountName) {
      throw new Error('BRING_STORAGE_ACCOUNT_NAME is required when durable caching is enabled.');
    }
    const service = new BlobServiceClient(
      `https://${config.storageAccountName}.blob.core.windows.net`,
      new DefaultAzureCredential(),
    );
    this.container = service.getContainerClient(config.sessionCacheContainer);
    this.blob = this.container.getBlockBlobClient(config.sessionCacheBlob);
  }

  async load(): Promise<BringSession | null> {
    try {
      const response = await this.blob.download(0);
      this.etag = response.etag;
      return parseCachedSession(await streamToText(response.readableStreamBody));
    } catch (error) {
      if (!hasStatusCode(error, 404)) {
        this.warn('Bring session cache read failed; authentication will continue without it.', {
          component: 'bring_session_cache',
          operation: 'read',
        });
      }
      this.etag = undefined;
      return null;
    }
  }

  async save(session: BringSession): Promise<void> {
    const body = JSON.stringify(session);
    try {
      const response = await this.blob.upload(body, Buffer.byteLength(body), {
        blobHTTPHeaders: { blobContentType: 'application/json' },
        conditions: this.etag ? { ifMatch: this.etag } : { ifNoneMatch: '*' },
      });
      this.etag = response.etag;
    } catch (error) {
      if (hasStatusCode(error, 409) || hasStatusCode(error, 412)) {
        throw new BringSessionConflictError('Concurrent Bring session cache update detected.');
      }
      throw error;
    }
  }

  async clear(): Promise<void> {
    try {
      await this.blob.deleteIfExists({
        conditions: this.etag ? { ifMatch: this.etag } : undefined,
      });
      this.etag = undefined;
    } catch (error) {
      this.warn('Bring session cache clear failed.', {
        component: 'bring_session_cache',
        operation: 'clear',
        conflict: hasStatusCode(error, 409) || hasStatusCode(error, 412),
      });
    }
  }
}

export function parseCachedSession(text: string): BringSession | null {
  try {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value)) return null;
    if (
      value['version'] !== 1 ||
      typeof value['userUuid'] !== 'string' ||
      typeof value['publicUserUuid'] !== 'string' ||
      typeof value['accessToken'] !== 'string' ||
      typeof value['accessTokenExpiresAt'] !== 'string' ||
      typeof value['updatedAt'] !== 'string' ||
      Number.isNaN(Date.parse(value['accessTokenExpiresAt']))
    ) {
      return null;
    }
    return {
      version: 1,
      userUuid: value['userUuid'],
      publicUserUuid: value['publicUserUuid'],
      accessToken: value['accessToken'],
      accessTokenExpiresAt: value['accessTokenExpiresAt'],
      updatedAt: value['updatedAt'],
      ...(typeof value['defaultListUuid'] === 'string' ? { defaultListUuid: value['defaultListUuid'] } : {}),
      ...(typeof value['refreshToken'] === 'string' ? { refreshToken: value['refreshToken'] } : {}),
    };
  } catch {
    return null;
  }
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
