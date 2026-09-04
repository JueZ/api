import { DefaultAzureCredential } from '@azure/identity';
import { BlobServiceClient, type ContainerClient } from '@azure/storage-blob';
import {
  parseYouTubeSnapshot,
  type YouTubeSnapshot,
  type YouTubeSnapshotStore,
} from '../../shared/youtube/snapshot.js';
import { YOUTUBE_LIMITS } from '../../shared/youtube/types.js';

export class AzureBlobYouTubeSnapshotStore implements YouTubeSnapshotStore {
  private container: ContainerClient;
  constructor(account: string, container: string) {
    this.container = new BlobServiceClient(
      `https://${account}.blob.core.windows.net`,
      new DefaultAzureCredential(),
    ).getContainerClient(container);
  }
  async findByCacheKey(key: string, now: number) {
    const index = await this.text(`cache/${key}.txt`, 100);
    if (!index || !/^[0-9a-f-]{36}$/i.test(index)) return null;
    const value = await this.load(index);
    return value && Date.parse(value.expiresAt) > now ? value : null;
  }
  async load(id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const text = await this.text(`snapshots/${id}.json`, YOUTUBE_LIMITS.snapshotBytes);
    return text ? parseYouTubeSnapshot(text) : null;
  }
  async save(value: YouTubeSnapshot) {
    const body = JSON.stringify(value);
    if (Buffer.byteLength(body) > YOUTUBE_LIMITS.snapshotBytes)
      throw new Error('YouTube snapshot exceeds storage limit.');
    await this.container
      .getBlockBlobClient(`snapshots/${value.snapshotId}.json`)
      .upload(body, Buffer.byteLength(body), {
        conditions: { ifNoneMatch: '*' },
        blobHTTPHeaders: { blobContentType: 'application/json' },
      });
    const index = this.container.getBlockBlobClient(`cache/${value.cacheKey}.txt`);
    await index.upload(value.snapshotId, value.snapshotId.length);
  }
  async withCacheLease<T>(key: string, action: () => Promise<T>): Promise<T> {
    const blob = this.container.getBlockBlobClient(`leases/${key}`);
    try {
      await blob.upload('', 0, { conditions: { ifNoneMatch: '*' } });
    } catch (e) {
      if (!status(e, 409)) throw e;
    }
    const lease = blob.getBlobLeaseClient();
    let leaseId: string | undefined;
    for (let i = 0; i < 10 && !leaseId; i++) {
      try {
        leaseId = (await lease.acquireLease(15)).leaseId;
      } catch (e) {
        if (!status(e, 409)) throw e;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    if (!leaseId) throw new Error('YouTube transcript cache is busy.');
    try {
      return await action();
    } finally {
      await lease.releaseLease().catch(() => undefined);
    }
  }
  private async text(name: string, max: number) {
    try {
      const response = await this.container.getBlobClient(name).download();
      const parts: Buffer[] = [];
      let total = 0;
      for await (const part of response.readableStreamBody ?? []) {
        const b = Buffer.from(part);
        total += b.length;
        if (total > max) throw new Error('Stored YouTube data exceeds read limit.');
        parts.push(b);
      }
      return Buffer.concat(parts).toString('utf8');
    } catch (e) {
      if (status(e, 404)) return null;
      throw e;
    }
  }
}
function status(error: unknown, code: number) {
  return !!error && typeof error === 'object' && (error as { statusCode?: number }).statusCode === code;
}
