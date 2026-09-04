import type { AuthenticatedPrincipal } from '../../authorization/types.js';
import type { BringAuditSink } from '../../auditing/bringAudit.js';
import {
  BringMutationStoreConflictError,
  type BringMutationAuditEvent,
  type BringMutationPayload,
  type BringMutationRecord,
  type BringMutationState,
  type BringMutationStore,
  type StoredBringMutation,
} from '../../idempotency/bringMutation.js';
import { BringUpstreamError } from '../../../shared/bring/client.js';
import { BringInputError, BringService, validateItems } from '../../../shared/bring/service.js';
import type {
  BringDestructiveOperation,
  BringItemInput,
  BringMutationOperation,
  BringMutationResult,
} from '../../../shared/bring/types.js';
import { BringMutationSecurity } from './mutationSecurity.js';

export interface AddItemsCommand {
  operationId: string;
  listUuid: string;
  expectedListVersion?: string;
  items: BringItemInput[];
}

export interface PrepareMutationCommand {
  operationId: string;
  listUuid: string;
  expectedListVersion?: string;
  operation: BringDestructiveOperation;
  items: BringItemInput[];
}

export interface ApplyMutationCommand {
  operationId: string;
  listUuid: string;
  confirmationToken: string;
  expectedListVersion?: string;
  operation?: BringDestructiveOperation;
  items?: BringItemInput[];
}

export interface PreparedBringMutation {
  source: 'bring';
  state: 'prepared';
  operationId: string;
  operation: BringDestructiveOperation;
  listPseudonym: string;
  itemCount: number;
  expiresAt: string;
  confirmationToken: string;
  replayed: boolean;
}

export class BringIdempotencyConflictError extends Error {}
export class BringConfirmationError extends Error {}
export class BringMutationOutcomeUnknownError extends Error {}
export class BringMutationExpiredError extends Error {}

const operationIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const listUuidPattern = operationIdPattern;
const replayWindowMilliseconds = 30 * 24 * 60 * 60 * 1000;
const confirmationWindowMilliseconds = 5 * 60 * 1000;

export class BringMutationCoordinator {
  constructor(
    private readonly service: BringService,
    private readonly store: BringMutationStore,
    private readonly auditSink: BringAuditSink,
    private readonly security: BringMutationSecurity,
    private readonly now: () => Date = () => new Date(),
    private readonly deployedCommitSha: string = process.env['DEPLOYED_COMMIT_SHA'] ?? 'local',
    private readonly warn: (message: string, details?: Record<string, unknown>) => void = () => undefined,
  ) {}

  async addItems(
    principal: AuthenticatedPrincipal,
    command: AddItemsCommand,
    correlationId: string,
  ): Promise<BringMutationResult> {
    const normalized = normalizeAddCommand(command);
    const payload = toPayload(normalized);
    const identity = this.identity(principal, normalized.listUuid);
    const payloadHash = this.security.payloadHash('add', payload);
    const existing = await this.store.get(normalized.operationId);
    if (existing) {
      return this.replayResult(existing.record, 'add', payloadHash, identity);
    }

    await this.service.validateMutationTarget(
      'add',
      normalized.listUuid,
      normalized.items,
      normalized.expectedListVersion,
    );
    const timestamp = this.now();
    const record = this.newRecord({
      command: normalized,
      operation: 'add',
      state: 'applying',
      payload,
      payloadHash,
      identity,
      timestamp,
      correlationId,
    });
    const created = await this.createOrReplay(record);
    const stored = created.stored;
    if (!created.created) {
      return this.replayResult(stored.record, 'add', payloadHash, identity);
    }
    await this.appendLatestAudit(record);

    let providerResult: {
      listUuid: string;
      operation: BringMutationOperation;
      itemCount: number;
    };
    try {
      providerResult = await this.service.mutateItems(
        'add',
        normalized.listUuid,
        normalized.items,
        normalized.expectedListVersion,
      );
    } catch (error) {
      await this.failMutation(stored, error, correlationId);
      throw error;
    }
    return this.completeMutation(stored, providerResult, correlationId);
  }

  async prepare(
    principal: AuthenticatedPrincipal,
    command: PrepareMutationCommand,
    correlationId: string,
  ): Promise<PreparedBringMutation | BringMutationResult> {
    const normalized = normalizePrepareCommand(command);
    const payload = toPayload(normalized);
    const identity = this.identity(principal, normalized.listUuid);
    const payloadHash = this.security.payloadHash(normalized.operation, payload);
    const existing = await this.store.get(normalized.operationId);
    if (existing) {
      return this.replayPrepared(existing, normalized.operation, payloadHash, identity, correlationId);
    }

    await this.service.validateMutationTarget(
      normalized.operation,
      normalized.listUuid,
      normalized.items,
      normalized.expectedListVersion,
    );
    const timestamp = this.now();
    const record = this.newRecord({
      command: normalized,
      operation: normalized.operation,
      state: 'prepared',
      payload,
      payloadHash,
      identity,
      timestamp,
      correlationId,
      confirmationExpiresAt: new Date(timestamp.getTime() + confirmationWindowMilliseconds).toISOString(),
    });
    const confirmation = this.security.createConfirmation(record);
    record.confirmationNonceHash = confirmation.nonceHash;
    const created = await this.createOrReplay(record);
    const stored = created.stored;
    if (!created.created) {
      this.assertReplayIdentity(stored.record, normalized.operation, payloadHash, identity);
      throw new BringIdempotencyConflictError(
        'operationId was prepared concurrently; retry only the identical prepare request.',
      );
    }
    await this.appendLatestAudit(record);
    return preparedResponse(record, confirmation.token, false);
  }

  async apply(
    principal: AuthenticatedPrincipal,
    command: ApplyMutationCommand,
    correlationId: string,
  ): Promise<BringMutationResult> {
    const operationId = normalizeOperationId(command.operationId);
    const listUuid = normalizeListUuid(command.listUuid);
    if (
      typeof command.confirmationToken !== 'string' ||
      command.confirmationToken.length === 0 ||
      command.confirmationToken.length > 4096
    ) {
      throw new BringInputError('confirmationToken must be a non-empty bounded string.', 'confirmationToken');
    }
    const stored = await this.store.get(operationId);
    if (!stored) throw new BringConfirmationError('Prepared mutation was not found.');
    if (stored.record.version !== 2) {
      throw new BringConfirmationError(
        'Prepared mutation uses a legacy integrity version; re-read the list before preparing a new operationId.',
      );
    }
    const identity = this.identity(principal, listUuid);
    if (command.operation !== undefined || command.items !== undefined || command.expectedListVersion !== undefined) {
      if (!command.operation || !command.items) {
        throw new BringInputError('operation and items are required when applying with payload verification.', 'items');
      }
      const verifiedCommand = normalizePrepareCommand({
        operationId,
        listUuid,
        operation: command.operation,
        items: command.items,
        expectedListVersion: command.expectedListVersion,
      });
      this.assertReplayIdentity(
        stored.record,
        verifiedCommand.operation,
        this.security.payloadHash(verifiedCommand.operation, toPayload(verifiedCommand)),
        identity,
      );
    }
    this.assertSamePrincipal(stored.record, identity.principalPseudonym);
    if (stored.record.listPseudonym !== identity.listPseudonym) {
      throw new BringConfirmationError('Prepared mutation belongs to another list.');
    }

    if (stored.record.state === 'succeeded') {
      if (!this.security.verifyConsumedConfirmation(command.confirmationToken, stored.record)) {
        throw new BringConfirmationError('Confirmation token does not match the applied mutation.');
      }
      return this.replayResult(stored.record, stored.record.operation, stored.record.payloadHash, identity);
    }
    if (stored.record.state === 'applying' || stored.record.state === 'outcome_unknown') {
      throw new BringMutationOutcomeUnknownError('Mutation outcome is unknown and must not be replayed automatically.');
    }
    if (stored.record.state !== 'prepared') {
      throw new BringConfirmationError(`Mutation cannot be applied from state ${stored.record.state}.`);
    }
    if (!this.security.verifyConfirmation(command.confirmationToken, stored.record, this.now())) {
      throw new BringConfirmationError('Confirmation token is invalid or expired.');
    }
    if (!stored.record.encryptedPayload) {
      throw new BringConfirmationError('Prepared mutation payload is unavailable.');
    }

    let payload: BringMutationPayload;
    try {
      payload = this.security.decryptPayload(stored.record.encryptedPayload, stored.record);
    } catch {
      throw new BringConfirmationError('Prepared mutation payload integrity check failed.');
    }
    if (
      payload.listUuid !== listUuid ||
      this.security.listPseudonym(payload.listUuid) !== stored.record.listPseudonym ||
      this.security.payloadHash(stored.record.operation, payload) !== stored.record.payloadHash ||
      payload.items.length !== stored.record.itemCount
    ) {
      throw new BringConfirmationError('Prepared mutation payload integrity check failed.');
    }
    const applying = this.transition(stored.record, 'applying', correlationId, undefined, {
      confirmationNonceHash: undefined,
      confirmationExpiresAt: undefined,
      confirmationTokenHmac: this.security.confirmationTokenHmac(command.confirmationToken),
    });
    let applyingStored: StoredBringMutation;
    try {
      applyingStored = await this.store.replace(applying, stored.etag);
    } catch (error) {
      if (error instanceof BringMutationStoreConflictError) {
        throw new BringMutationOutcomeUnknownError(
          'Mutation is already being applied or completed. Check its durable result before retrying.',
          { cause: error },
        );
      }
      throw error;
    }
    await this.appendLatestAudit(applying);

    let providerResult: {
      listUuid: string;
      operation: BringMutationOperation;
      itemCount: number;
    };
    try {
      providerResult = await this.service.mutateItems(
        stored.record.operation,
        payload.listUuid,
        payload.items,
        payload.expectedListVersion,
      );
    } catch (error) {
      await this.failMutation(applyingStored, error, correlationId);
      throw error;
    }
    return this.completeMutation(applyingStored, providerResult, correlationId);
  }

  async getMutationOperation(operationId: string): Promise<BringDestructiveOperation | undefined> {
    const stored = await this.store.get(normalizeOperationId(operationId));
    if (
      stored?.record.version === 2 &&
      (stored.record.operation === 'complete' || stored.record.operation === 'remove')
    ) {
      return stored.record.operation;
    }
    return undefined;
  }

  private async replayPrepared(
    stored: StoredBringMutation,
    operation: BringDestructiveOperation,
    payloadHash: string,
    identity: { principalPseudonym: string; listPseudonym: string },
    correlationId: string,
  ): Promise<PreparedBringMutation | BringMutationResult> {
    this.assertReplayIdentity(stored.record, operation, payloadHash, identity);
    if (stored.record.state === 'succeeded') {
      throw new BringIdempotencyConflictError(
        'A succeeded destructive mutation can be replayed only through apply with its consumed confirmation token.',
      );
    }
    if (stored.record.state !== 'prepared') {
      this.throwForNonReplayableState(stored.record.state);
    }
    if (
      !stored.record.confirmationExpiresAt ||
      Date.parse(stored.record.confirmationExpiresAt) <= this.now().getTime()
    ) {
      const expired = this.transition(stored.record, 'expired', correlationId);
      await this.store.replace(expired, stored.etag);
      await this.appendLatestAudit(expired, false);
      throw new BringMutationExpiredError('Prepared mutation expired.');
    }

    const confirmation = this.security.createConfirmation(stored.record);
    const refreshed = {
      ...stored.record,
      confirmationNonceHash: confirmation.nonceHash,
      updatedAt: this.now().toISOString(),
    };
    try {
      await this.store.replace(refreshed, stored.etag);
    } catch (error) {
      if (error instanceof BringMutationStoreConflictError) {
        throw new BringIdempotencyConflictError(
          'Prepared mutation changed concurrently; retry only the identical prepare request.',
          { cause: error },
        );
      }
      throw error;
    }
    await this.appendLatestAudit(refreshed);
    return preparedResponse(refreshed, confirmation.token, true);
  }

  private replayResult(
    record: BringMutationRecord,
    operation: BringMutationOperation,
    payloadHash: string,
    identity: { principalPseudonym: string; listPseudonym: string },
  ): BringMutationResult {
    this.assertReplayIdentity(record, operation, payloadHash, identity);
    if (Date.parse(record.replayUntil) <= this.now().getTime()) {
      throw new BringMutationExpiredError('Mutation replay window expired.');
    }
    if (record.state !== 'succeeded' || !record.result) {
      this.throwForNonReplayableState(record.state);
    }
    if (
      record.result.operationId !== record.operationId ||
      record.result.operation !== record.operation ||
      record.result.itemCount !== record.itemCount ||
      this.security.listPseudonym(record.result.listUuid) !== record.listPseudonym
    ) {
      throw new BringIdempotencyConflictError('Stored mutation result integrity check failed.');
    }
    return { ...record.result, replayed: true };
  }

  private async completeMutation(
    stored: StoredBringMutation,
    providerResult: {
      listUuid: string;
      operation: BringMutationOperation;
      itemCount: number;
    },
    correlationId: string,
  ): Promise<BringMutationResult> {
    const result: BringMutationResult = {
      source: 'bring',
      listUuid: providerResult.listUuid,
      operation: providerResult.operation,
      operationId: stored.record.operationId,
      itemCount: providerResult.itemCount,
      state: 'succeeded',
      replayed: false,
    };
    const succeeded = this.transition(stored.record, 'succeeded', correlationId, undefined, {
      encryptedPayload: undefined,
      confirmationExpiresAt: undefined,
      confirmationNonceHash: undefined,
      result,
    });
    try {
      await this.store.replace(succeeded, stored.etag);
    } catch (error) {
      throw new BringMutationOutcomeUnknownError(
        'Bring accepted the mutation, but its durable result could not be recorded. Do not replay automatically.',
        { cause: error },
      );
    }
    await this.appendLatestAudit(succeeded, false);
    return result;
  }

  private async failMutation(stored: StoredBringMutation, error: unknown, correlationId: string): Promise<void> {
    const state: BringMutationState = isAmbiguousProviderFailure(error) ? 'outcome_unknown' : 'rejected';
    const providerStatus = error instanceof BringUpstreamError ? error.diagnostics?.upstreamStatus : undefined;
    const failed = this.transition(stored.record, state, correlationId, providerStatus, {
      encryptedPayload: undefined,
      confirmationExpiresAt: undefined,
      confirmationNonceHash: undefined,
    });
    try {
      await this.store.replace(failed, stored.etag);
    } catch (storeError) {
      if (storeError instanceof BringMutationStoreConflictError) return;
      throw new BringMutationOutcomeUnknownError(
        'Bring mutation state could not be recorded. Do not replay automatically.',
        { cause: storeError },
      );
    }
    await this.appendLatestAudit(failed, false);
  }

  private newRecord(options: {
    command: AddItemsCommand | PrepareMutationCommand;
    operation: BringMutationOperation;
    state: 'prepared' | 'applying';
    payload: BringMutationPayload;
    payloadHash: string;
    identity: { principalPseudonym: string; listPseudonym: string };
    timestamp: Date;
    correlationId: string;
    confirmationExpiresAt?: string;
  }): BringMutationRecord {
    const timestamp = options.timestamp.toISOString();
    const record: BringMutationRecord = {
      version: 2,
      operationId: options.command.operationId,
      operation: options.operation,
      state: options.state,
      payloadHash: options.payloadHash,
      principalPseudonym: options.identity.principalPseudonym,
      listPseudonym: options.identity.listPseudonym,
      itemCount: options.command.items.length,
      createdAt: timestamp,
      updatedAt: timestamp,
      ...(options.confirmationExpiresAt ? { confirmationExpiresAt: options.confirmationExpiresAt } : {}),
      replayUntil: new Date(options.timestamp.getTime() + replayWindowMilliseconds).toISOString(),
      auditTrail: [],
    };
    record.encryptedPayload = this.security.encryptPayload(options.payload, record);
    record.auditTrail.push(this.auditEvent(record, options.correlationId));
    return record;
  }

  private transition(
    record: BringMutationRecord,
    state: BringMutationState,
    correlationId: string,
    providerStatus?: number,
    updates: Partial<BringMutationRecord> = {},
  ): BringMutationRecord {
    const transitioned: BringMutationRecord = {
      ...record,
      ...updates,
      state,
      updatedAt: this.now().toISOString(),
      auditTrail: [...record.auditTrail],
    };
    transitioned.auditTrail.push(this.auditEvent(transitioned, correlationId, providerStatus));
    return transitioned;
  }

  private auditEvent(
    record: BringMutationRecord,
    correlationId: string,
    providerStatus?: number,
  ): BringMutationAuditEvent {
    const timestamp = record.updatedAt;
    return {
      eventId: `${record.operationId}:${record.state}:${timestamp}`,
      timestamp,
      operationId: record.operationId,
      operation: record.operation,
      principalPseudonym: record.principalPseudonym,
      listPseudonym: record.listPseudonym,
      itemCount: record.itemCount,
      correlationId,
      result: record.state,
      deployedCommitSha: this.deployedCommitSha,
      ...(providerStatus !== undefined ? { providerStatus } : {}),
    };
  }

  private async appendLatestAudit(record: BringMutationRecord, required = true): Promise<void> {
    const event = record.auditTrail.at(-1);
    if (!event) throw new Error('Mutation audit event is missing.');
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await this.auditSink.append(event);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    if (required) {
      throw lastError instanceof Error ? lastError : new Error('Bring audit append failed.');
    }
    this.warn('Bring terminal audit delivery failed after durable state persistence.', {
      operation: record.operation,
      state: record.state,
      attempts: 3,
    });
  }

  private async createOrReplay(
    record: BringMutationRecord,
  ): Promise<{ stored: StoredBringMutation; created: boolean }> {
    try {
      return { stored: await this.store.create(record), created: true };
    } catch (error) {
      if (!(error instanceof BringMutationStoreConflictError)) throw error;
      const existing = await this.store.get(record.operationId);
      if (!existing) throw error;
      return { stored: existing, created: false };
    }
  }

  private identity(
    principal: AuthenticatedPrincipal,
    listUuid: string,
  ): { principalPseudonym: string; listPseudonym: string } {
    return {
      principalPseudonym: this.security.principalPseudonym(principal),
      listPseudonym: this.security.listPseudonym(listUuid),
    };
  }

  private assertReplayIdentity(
    record: BringMutationRecord,
    operation: BringMutationOperation,
    payloadHash: string,
    identity: { principalPseudonym: string; listPseudonym: string },
  ): void {
    if (record.version !== 2) {
      throw new BringIdempotencyConflictError(
        'operationId belongs to a legacy mutation record; re-read the list before choosing a new operationId.',
      );
    }
    if (
      record.operation !== operation ||
      record.payloadHash !== payloadHash ||
      record.principalPseudonym !== identity.principalPseudonym ||
      record.listPseudonym !== identity.listPseudonym
    ) {
      throw new BringIdempotencyConflictError('operationId was already used with different input or identity.');
    }
  }

  private assertSamePrincipal(record: BringMutationRecord, principalPseudonym: string): void {
    if (record.principalPseudonym !== principalPseudonym) {
      throw new BringConfirmationError('Prepared mutation belongs to another principal.');
    }
  }

  private throwForNonReplayableState(state: BringMutationState): never {
    if (state === 'applying' || state === 'outcome_unknown') {
      throw new BringMutationOutcomeUnknownError('Mutation outcome is unknown and must not be replayed automatically.');
    }
    if (state === 'expired') {
      throw new BringMutationExpiredError('Mutation expired.');
    }
    throw new BringIdempotencyConflictError(`Mutation cannot be replayed from state ${state}.`);
  }
}

function normalizeAddCommand(command: AddItemsCommand): AddItemsCommand {
  return {
    operationId: normalizeOperationId(command.operationId),
    listUuid: normalizeListUuid(command.listUuid),
    ...(normalizeExpectedVersion(command.expectedListVersion)
      ? { expectedListVersion: command.expectedListVersion }
      : {}),
    items: validateItems(command.items),
  };
}

function normalizePrepareCommand(command: PrepareMutationCommand): PrepareMutationCommand {
  if (!['complete', 'remove'].includes(command.operation)) {
    throw new BringInputError('operation must be complete or remove.', 'operation');
  }
  return {
    operationId: normalizeOperationId(command.operationId),
    listUuid: normalizeListUuid(command.listUuid),
    operation: command.operation,
    ...(normalizeExpectedVersion(command.expectedListVersion)
      ? { expectedListVersion: command.expectedListVersion }
      : {}),
    items: validateItems(command.items),
  };
}

function normalizeOperationId(value: string): string {
  if (typeof value !== 'string' || !operationIdPattern.test(value)) {
    throw new BringInputError('operationId must be a UUID.', 'operationId');
  }
  return value.toLowerCase();
}

function normalizeListUuid(value: string): string {
  if (typeof value !== 'string' || !listUuidPattern.test(value)) {
    throw new BringInputError('listUuid must be a UUID.', 'listUuid');
  }
  return value.toLowerCase();
}

function normalizeExpectedVersion(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new BringInputError('expectedListVersion must be a lowercase SHA-256 digest.', 'expectedListVersion');
  }
  return value;
}

function toPayload(command: AddItemsCommand | PrepareMutationCommand): BringMutationPayload {
  return {
    listUuid: command.listUuid,
    ...(command.expectedListVersion ? { expectedListVersion: command.expectedListVersion } : {}),
    items: command.items,
  };
}

function preparedResponse(
  record: BringMutationRecord,
  confirmationToken: string,
  replayed: boolean,
): PreparedBringMutation {
  if (record.operation === 'add' || !record.confirmationExpiresAt) {
    throw new Error('Prepared response requires a destructive operation.');
  }
  return {
    source: 'bring',
    state: 'prepared',
    operationId: record.operationId,
    operation: record.operation,
    listPseudonym: record.listPseudonym,
    itemCount: record.itemCount,
    expiresAt: record.confirmationExpiresAt,
    confirmationToken,
    replayed,
  };
}

function isAmbiguousProviderFailure(error: unknown): boolean {
  return error instanceof BringUpstreamError && ['timeout', 'upstream', 'version_skew'].includes(error.kind);
}
