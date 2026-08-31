import { AzureBlobRedditThreadSnapshotStore } from '../azure/redditThreadSnapshotStore.js';
import { readRedditConfig } from '../../shared/reddit/config.js';
import { RedditThreadService, type RedditThreadServiceOptions } from '../../shared/reddit/service.js';
import { InMemoryRedditThreadSnapshotStore } from '../../shared/reddit/snapshot.js';

export function createRedditThreadService(options: RedditThreadServiceOptions = {}): RedditThreadService {
  const config = options.config ?? readRedditConfig();
  const snapshotStore =
    options.snapshotStore ??
    (config.storageAccountName
      ? new AzureBlobRedditThreadSnapshotStore(config)
      : new InMemoryRedditThreadSnapshotStore());
  return new RedditThreadService({ ...options, config, snapshotStore });
}
