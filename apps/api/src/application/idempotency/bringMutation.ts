import type { BringItemInput, BringMutationOperation, BringMutationResult } from '../../shared/bring/types.js';

export type BringMutationState = 'prepared' | 'applying' | 'succeeded' | 'rejected' | 'expired' | 'outcome_unknown';

export interface EncryptedBringPayload {
  algorithm: 'aes-256-gcm';
  iv: string;
  authenticationTag: string;
  ciphertext: string;
}

export interface BringMutationAuditEvent {
  eventId: string;
  timestamp: string;
  operationId: string;
  operation: BringMutationOperation;
  principalPseudonym: string;
  listPseudonym: string;
  itemCount: number;
  correlationId: string;
  result: BringMutationState;
  deployedCommitSha: string;
  providerStatus?: number;
}

export interface BringMutationRecord {
  version: 1;
  operationId: string;
  operation: BringMutationOperation;
  state: BringMutationState;
  payloadHash: string;
  principalPseudonym: string;
  listPseudonym: string;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
  confirmationExpiresAt?: string;
  confirmationNonceHash?: string;
  replayUntil: string;
  encryptedPayload?: EncryptedBringPayload;
  result?: BringMutationResult;
  auditTrail: BringMutationAuditEvent[];
}

export interface StoredBringMutation {
  record: BringMutationRecord;
  etag: string;
}

export interface BringMutationStore {
  get(operationId: string): Promise<StoredBringMutation | null>;
  create(record: BringMutationRecord): Promise<StoredBringMutation>;
  replace(record: BringMutationRecord, expectedEtag: string): Promise<StoredBringMutation>;
}

export interface BringMutationPayload {
  listUuid: string;
  expectedListVersion?: string;
  items: BringItemInput[];
}

export class BringMutationStoreConflictError extends Error {}

export class InMemoryBringMutationStore implements BringMutationStore {
  private readonly records = new Map<string, StoredBringMutation>();
  private nextEtag = 1;

  async get(operationId: string): Promise<StoredBringMutation | null> {
    const stored = this.records.get(operationId);
    return stored ? structuredClone(stored) : null;
  }

  async create(record: BringMutationRecord): Promise<StoredBringMutation> {
    if (this.records.has(record.operationId)) {
      throw new BringMutationStoreConflictError('Mutation operation already exists.');
    }
    const stored = { record: structuredClone(record), etag: String(this.nextEtag++) };
    this.records.set(record.operationId, stored);
    return structuredClone(stored);
  }

  async replace(record: BringMutationRecord, expectedEtag: string): Promise<StoredBringMutation> {
    const current = this.records.get(record.operationId);
    if (!current || current.etag !== expectedEtag) {
      throw new BringMutationStoreConflictError('Mutation operation changed concurrently.');
    }
    const stored = { record: structuredClone(record), etag: String(this.nextEtag++) };
    this.records.set(record.operationId, stored);
    return structuredClone(stored);
  }
}
