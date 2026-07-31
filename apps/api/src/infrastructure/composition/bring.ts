import { BringApplication } from '../../application/operations/bring/application.js';
import { BringMutationCoordinator } from '../../application/operations/bring/mutations.js';
import { BringMutationSecurity } from '../../application/operations/bring/mutationSecurity.js';
import { readBringConfig } from '../../shared/bring/config.js';
import { BringService } from '../../shared/bring/service.js';
import type { BringConfig } from '../../shared/bring/types.js';
import { AzureBlobBringAuditSink } from '../azure/bringAuditSink.js';
import { AzureBlobBringMutationStore } from '../azure/bringMutationStore.js';

export function createBringApplication(
  options: {
    config?: BringConfig;
    warn?: (message: string, details?: Record<string, unknown>) => void;
  } = {},
): BringApplication {
  const config = options.config ?? readBringConfig();
  const service = new BringService({ config, warn: options.warn });
  if (!config.addEnabled && !config.destructiveEnabled) {
    return new BringApplication(service, null);
  }
  const security = new BringMutationSecurity(config.confirmationHmacKey, config.mutationEncryptionKey);
  const coordinator = new BringMutationCoordinator(
    service,
    new AzureBlobBringMutationStore(config),
    new AzureBlobBringAuditSink(config),
    security,
    undefined,
    undefined,
    options.warn,
  );
  return new BringApplication(service, coordinator);
}
