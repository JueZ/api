import { DefaultAzureCredential } from '@azure/identity';
import { BlobServiceClient } from '@azure/storage-blob';
import type { BringConfig, BringSession } from './types.js';

export interface BringSessionStore { load(): Promise<BringSession | null>; save(session: BringSession): Promise<void>; clear(): Promise<void> }
export type SafeWarning = (message: string, details?: Record<string, unknown>) => void;

export class AzureBlobBringSessionStore implements BringSessionStore {
  private readonly blob; private readonly container;
  constructor(config: BringConfig, private readonly warn: SafeWarning = () => {}) {
    if (!config.storageAccountName) throw new Error('BRING_STORAGE_ACCOUNT_NAME is required when durable caching is enabled.');
    const service = new BlobServiceClient(`https://${config.storageAccountName}.blob.core.windows.net`, new DefaultAzureCredential());
    this.container = service.getContainerClient(config.sessionCacheContainer);
    this.blob = this.container.getBlockBlobClient(config.sessionCacheBlob);
  }
  async load(): Promise<BringSession | null> {
    try {
      const response = await this.blob.download(0);
      const text = await streamToText(response.readableStreamBody);
      return parseCachedSession(text);
    } catch (error: any) {
      if (error?.statusCode !== 404) this.warn('Bring session cache read failed; authentication will continue without it.', { component: 'bring_session_cache', operation: 'read' });
      return null;
    }
  }
  async save(session: BringSession): Promise<void> {
    try {
      await this.container.createIfNotExists();
      const body = JSON.stringify(session);
      await this.blob.upload(body, Buffer.byteLength(body), { blobHTTPHeaders: { blobContentType: 'application/json' } });
    } catch { this.warn('Bring session cache write failed; the successful upstream operation is unaffected.', { component: 'bring_session_cache', operation: 'write' }); }
  }
  async clear(): Promise<void> { try { await this.blob.deleteIfExists(); } catch { this.warn('Bring session cache clear failed.', { component: 'bring_session_cache', operation: 'clear' }); } }
}

export function parseCachedSession(text: string): BringSession | null {
  try {
    const x = JSON.parse(text) as Record<string, unknown>;
    if (x['version'] !== 1 || typeof x['userUuid'] !== 'string' || typeof x['publicUserUuid'] !== 'string' || typeof x['accessToken'] !== 'string' || typeof x['accessTokenExpiresAt'] !== 'string' || typeof x['updatedAt'] !== 'string') return null;
    if (Number.isNaN(Date.parse(x['accessTokenExpiresAt']))) return null;
    return x as unknown as BringSession;
  } catch { return null; }
}
async function streamToText(stream: NodeJS.ReadableStream | undefined): Promise<string> { if (!stream) return ''; const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks).toString('utf8'); }

