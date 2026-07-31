import { DefaultAzureCredential } from '@azure/identity';
import { BlobServiceClient, type ContainerClient } from '@azure/storage-blob';
import type { BringAuditSink } from '../../application/auditing/bringAudit.js';
import type { BringMutationAuditEvent } from '../../application/idempotency/bringMutation.js';
import type { BringConfig } from '../../shared/bring/types.js';

export class AzureBlobBringAuditSink implements BringAuditSink {
  private readonly container: ContainerClient;

  constructor(config: BringConfig) {
    if (!config.storageAccountName) {
      throw new Error('BRING_STORAGE_ACCOUNT_NAME is required for audit storage.');
    }
    const service = new BlobServiceClient(
      `https://${config.storageAccountName}.blob.core.windows.net`,
      new DefaultAzureCredential(),
    );
    this.container = service.getContainerClient(config.auditContainer);
  }

  async append(event: BringMutationAuditEvent): Promise<void> {
    const date = event.timestamp.slice(0, 10);
    const eventName = encodeURIComponent(event.eventId);
    const blob = this.container.getBlockBlobClient(`events/${date}/${eventName}.json`);
    const body = JSON.stringify(event);
    try {
      await blob.upload(body, Buffer.byteLength(body), {
        blobHTTPHeaders: { blobContentType: 'application/json' },
        conditions: { ifNoneMatch: '*' },
      });
    } catch (error) {
      const statusCode =
        typeof error === 'object' && error !== null && 'statusCode' in error
          ? (error as { statusCode?: unknown }).statusCode
          : undefined;
      if (statusCode !== 409 && statusCode !== 412) throw error;
    }
  }
}
