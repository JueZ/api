import { BringApplication, type BringApplicationPort } from '../../application/operations/bring/application.js';
import { BringMutationCoordinator } from '../../application/operations/bring/mutations.js';
import { BringMutationSecurity } from '../../application/operations/bring/mutationSecurity.js';
import {
  ConfiguredBringConnectionResolver,
  createLegacyBringConnection,
} from '../../application/providerConnections/bring.js';
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
): BringApplicationPort {
  let application: BringApplication | undefined;
  const get = (): BringApplication => (application ??= composeBringApplication(options));
  return {
    listLists: (...args) => get().listLists(...args),
    getList: (...args) => get().getList(...args),
    addItems: (...args) => get().addItems(...args),
    prepareMutation: (...args) => get().prepareMutation(...args),
    applyMutation: (...args) => get().applyMutation(...args),
    getMutationOperation: (...args) => get().getMutationOperation(...args),
  };
}

function composeBringApplication(options: {
  config?: BringConfig;
  warn?: (message: string, details?: Record<string, unknown>) => void;
}): BringApplication {
  const config = options.config ?? readBringConfig();
  const connection = createLegacyBringConnection(config);
  const connectionResolver = new ConfiguredBringConnectionResolver([connection], config.connectionGrantsJson);
  const service = new BringService({ config, warn: options.warn });
  if (!config.addEnabled && !config.destructiveEnabled) {
    return new BringApplication(service, null, connectionResolver, connection);
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
  return new BringApplication(service, coordinator, connectionResolver, connection);
}
