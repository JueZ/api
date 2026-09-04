import { createHash } from 'node:crypto';
import { AzureBlobYouTubeSnapshotStore } from '../azure/youtubeSnapshotStore.js';
import { SupadataYouTubeTranscriptProvider } from '../../shared/youtube/client.js';
import { readYouTubeConfig } from '../../shared/youtube/config.js';
import { YouTubeTranscriptService } from '../../shared/youtube/service.js';
import { InMemoryYouTubeSnapshotStore } from '../../shared/youtube/snapshot.js';

export function createYouTubeTranscriptService(): YouTubeTranscriptService {
  const c = readYouTubeConfig();
  return new YouTubeTranscriptService({
    provider: new SupadataYouTubeTranscriptProvider(c.apiKey),
    snapshots: c.storageAccountName
      ? new AzureBlobYouTubeSnapshotStore(c.storageAccountName, c.container)
      : new InMemoryYouTubeSnapshotStore(),
    cursorSecret: c.cursorSecret,
    cacheTtlMs: c.cacheTtlMs,
    enabled: c.enabled,
  });
}
export function youtubePrincipalPseudonym(principal: {
  subject: string;
  objectId?: string;
  tenantId?: string;
}): string {
  return createHash('sha256')
    .update(`${principal.tenantId ?? '-'}|${principal.objectId ?? principal.subject}`)
    .digest('hex');
}
