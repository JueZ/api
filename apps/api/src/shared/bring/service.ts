import { createHash } from 'node:crypto';
import { BringClient, BringUpstreamError, bringUpstreamTelemetryDetails, type BringFetch } from './client.js';
import { readBringConfig } from './config.js';
import {
  AzureBlobBringSessionStore,
  BringSessionConflictError,
  type BringSessionStore,
  type SafeWarning,
} from './sessionStore.js';
import type {
  BringConfig,
  BringItem,
  BringItemInput,
  BringList,
  BringListSummary,
  BringMutationOperation,
  BringSession,
} from './types.js';

export class BringInputError extends Error {
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
  }
}

export class BringNotFoundError extends Error {}
export class BringDisabledError extends Error {}
export class BringPolicyError extends Error {}
export class BringVersionConflictError extends Error {}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class BringService {
  private readonly config: BringConfig;
  private readonly client: BringClient;
  private readonly store: BringSessionStore | null;
  private readonly warn: SafeWarning;
  private readonly now: () => Date;
  private session: BringSession | null = null;
  private authenticationPromise: Promise<BringSession> | null = null;
  private durableLoaded = false;

  constructor(
    dependencies: {
      config?: BringConfig;
      fetchImpl?: BringFetch;
      sessionStore?: BringSessionStore | null;
      now?: () => Date;
      warn?: SafeWarning;
    } = {},
  ) {
    this.config = dependencies.config ?? readBringConfig();
    this.now = dependencies.now ?? (() => new Date());
    this.client = new BringClient(this.config, dependencies.fetchImpl, this.now);
    this.warn = dependencies.warn ?? (() => undefined);
    this.store =
      dependencies.sessionStore !== undefined
        ? dependencies.sessionStore
        : this.config.sessionCacheEnabled
          ? new AzureBlobBringSessionStore(this.config, this.warn)
          : null;
  }

  getConfig(): BringConfig {
    return this.config;
  }

  async listLists(): Promise<{ source: 'bring'; lists: BringListSummary[] }> {
    this.assertEnabled();
    const raw = await this.authorized((session) => this.client.getLists(session));
    const rows = listRows(raw);
    if (!rows) {
      throw new BringUpstreamError('Bring list response shape changed.', 502, 'version_skew');
    }
    const session = await this.authenticate();
    const allowed = new Set(this.config.readableListUuids);
    const lists = rows
      .map((row) => normalizeListSummary(row, this.config.defaultListUuid ?? session.defaultListUuid))
      .filter((row): row is BringListSummary => row !== undefined)
      .filter((row) => allowed.size === 0 || allowed.has(row.uuid));
    return { source: 'bring', lists };
  }

  async getList(listUuid?: string): Promise<BringList> {
    this.assertEnabled();
    const id = await this.resolveListUuid(listUuid);
    const raw = await this.authorized((session) => this.client.getList(session, id));
    const record = asRecord(raw);
    const catalogue = isRecord(record['items']) ? record['items'] : record;
    const active = arrayAt(catalogue, 'purchase') ?? (Array.isArray(record['items']) ? record['items'] : []);
    const completed = arrayAt(catalogue, 'recently') ?? (Array.isArray(record['completed']) ? record['completed'] : []);
    const items = [
      ...active.map((item) => normalizeItem(item, 'active')),
      ...completed.map((item) => normalizeItem(item, 'completed')),
    ];
    const name = stringAt(record, ['name']);
    return {
      uuid: id,
      ...(name ? { name } : {}),
      version: listVersion(id, items),
      items,
    };
  }

  async addItems(
    listUuid: string | undefined,
    items: BringItemInput[],
    expectedListVersion?: string,
  ): Promise<{ listUuid: string; operation: 'add'; itemCount: number }> {
    return this.mutateItems('add', listUuid, items, expectedListVersion);
  }

  async completeItems(
    listUuid: string | undefined,
    items: BringItemInput[],
    expectedListVersion?: string,
  ): Promise<{ listUuid: string; operation: 'complete'; itemCount: number }> {
    return this.mutateItems('complete', listUuid, items, expectedListVersion);
  }

  async removeItems(
    listUuid: string | undefined,
    items: BringItemInput[],
    expectedListVersion?: string,
  ): Promise<{ listUuid: string; operation: 'remove'; itemCount: number }> {
    return this.mutateItems('remove', listUuid, items, expectedListVersion);
  }

  async mutateItems<Operation extends BringMutationOperation>(
    operation: Operation,
    listUuid: string | undefined,
    input: BringItemInput[],
    expectedListVersion?: string,
  ): Promise<{ listUuid: string; operation: Operation; itemCount: number }> {
    const validated = await this.validateMutationTarget(operation, listUuid, input, expectedListVersion);

    await this.authorized((session) =>
      this.client.updateItems(session, validated.listUuid, validated.items, operation),
    );
    return {
      listUuid: validated.listUuid,
      operation,
      itemCount: validated.items.length,
    };
  }

  async validateMutationTarget(
    operation: BringMutationOperation,
    listUuid: string | undefined,
    input: BringItemInput[],
    expectedListVersion?: string,
  ): Promise<{ listUuid: string; items: BringItemInput[] }> {
    this.assertEnabled();
    this.assertMutationEnabled(operation);
    const items = validateItems(input);
    const id = await this.resolveListUuid(listUuid);
    await this.assertWritableList(id);

    if (expectedListVersion) {
      if (!/^[0-9a-f]{64}$/.test(expectedListVersion)) {
        throw new BringInputError('expectedListVersion must be a lowercase SHA-256 digest.', 'expectedListVersion');
      }
      const current = await this.getList(id);
      if (current.version !== expectedListVersion) {
        throw new BringVersionConflictError('Bring list changed after it was read.');
      }
    }
    return { listUuid: id, items };
  }

  private assertEnabled(): void {
    if (!this.config.enabled) throw new BringDisabledError('Bring integration is disabled.');
  }

  private assertMutationEnabled(operation: BringMutationOperation): void {
    if (operation === 'add' && !this.config.addEnabled) {
      throw new BringDisabledError('Bring add operations are disabled.');
    }
    if (operation !== 'add' && !this.config.destructiveEnabled) {
      throw new BringDisabledError('Destructive Bring operations are disabled.');
    }
  }

  private async assertWritableList(listUuid: string): Promise<void> {
    if (!this.config.writableListUuids.includes(listUuid)) {
      throw new BringPolicyError('Bring list is not in the writable allowlist.');
    }
    const lists = await this.listLists();
    const selected = lists.lists.find((list) => list.uuid === listUuid);
    if (!selected) throw new BringPolicyError('Bring list is not readable by this environment.');
    const currentMembershipIsShared = await this.isSharedList(listUuid);
    const shared = selected.shared || currentMembershipIsShared;
    if (shared && !this.config.writableSharedListUuids.includes(listUuid)) {
      throw new BringPolicyError('Shared Bring list is not in the explicit shared-write allowlist.');
    }
  }

  private async isSharedList(listUuid: string): Promise<boolean> {
    const raw = await this.authorized((session) => this.client.getListUsers(session, listUuid));
    const users = userRows(raw);
    if (!users) {
      throw new BringUpstreamError('Bring list-membership response shape changed.', 502, 'version_skew');
    }
    const session = await this.authenticate();
    const currentPublicUuid = session.publicUserUuid.toLowerCase();
    const currentUserPresent = users.some(
      (user) => stringAt(asRecord(user), ['publicUuid', 'publicUserUuid'])?.toLowerCase() === currentPublicUuid,
    );
    if (!currentUserPresent) {
      throw new BringPolicyError('Authenticated Bring account is not a member of the requested list.');
    }
    return users.length > 1;
  }

  private async resolveListUuid(value?: string): Promise<string> {
    if (value !== undefined) {
      if (!uuidPattern.test(value)) {
        throw new BringInputError('listUuid must be a valid UUID.', 'listUuid');
      }
      const normalized = value.toLowerCase();
      if (this.config.readableListUuids.length > 0 && !this.config.readableListUuids.includes(normalized)) {
        throw new BringPolicyError('Bring list is not in the readable allowlist.');
      }
      return normalized;
    }

    const session = await this.authenticate();
    const candidate = this.config.defaultListUuid ?? session.defaultListUuid;
    if (
      candidate &&
      (this.config.readableListUuids.length === 0 || this.config.readableListUuids.includes(candidate.toLowerCase()))
    ) {
      return candidate.toLowerCase();
    }
    if (this.config.readableListUuids[0]) return this.config.readableListUuids[0];

    const lists = await this.listLists();
    if (!lists.lists[0]) throw new BringNotFoundError('No Bring list is available.');
    session.defaultListUuid = lists.lists[0].uuid;
    return lists.lists[0].uuid;
  }

  private async authorized<T>(action: (session: BringSession) => Promise<T>): Promise<T> {
    let session = await this.authenticate();
    try {
      return await action(session);
    } catch (error) {
      if (!(error instanceof BringUpstreamError) || error.kind !== 'authentication') {
        this.warnUpstream(error, 0);
        throw error;
      }
      this.warnUpstream(error, 0);
      this.session = null;
      this.authenticationPromise = null;
      session = await this.authenticate(true);
      try {
        return await action(session);
      } catch (retryError) {
        this.warnUpstream(retryError, 1);
        throw retryError;
      }
    }
  }

  private warnUpstream(error: unknown, retryCount: number): void {
    if (!(error instanceof BringUpstreamError)) return;
    this.warn('Bring upstream request failed.', {
      component: 'bring_upstream',
      error_kind: error.kind,
      retry_count: retryCount,
      ...bringUpstreamTelemetryDetails(error),
    });
  }

  private authenticate(forceLogin = false): Promise<BringSession> {
    if (!forceLogin && this.session && this.isSessionValid(this.session)) {
      return Promise.resolve(this.session);
    }
    if (this.authenticationPromise) return this.authenticationPromise;
    this.authenticationPromise = this.authenticateInner(forceLogin).finally(() => {
      this.authenticationPromise = null;
    });
    return this.authenticationPromise;
  }

  private async authenticateInner(forceLogin: boolean): Promise<BringSession> {
    if (!forceLogin && !this.durableLoaded) {
      this.durableLoaded = true;
      try {
        this.session = (await this.store?.load()) ?? null;
      } catch {
        this.warn('Bring session cache read failed; authentication will continue without it.');
        this.session = null;
      }
    }
    if (!forceLogin && this.session && this.isSessionValid(this.session)) {
      return this.session;
    }
    if (!forceLogin && this.session?.refreshToken) {
      try {
        return await this.persist(await this.client.refresh(this.session.refreshToken, this.session));
      } catch (error) {
        if (!(error instanceof BringUpstreamError) || error.kind !== 'authentication') {
          throw error;
        }
        await this.store?.clear();
        this.session = null;
      }
    }
    return this.persist(await this.client.login());
  }

  private isSessionValid(session: BringSession): boolean {
    return Date.parse(session.accessTokenExpiresAt) - this.now().getTime() > 60_000;
  }

  private async persist(session: BringSession): Promise<BringSession> {
    this.session = session;
    try {
      await this.store?.save(session);
    } catch (error) {
      this.warn('Bring session cache write failed; the successful upstream operation is unaffected.', {
        conflict: error instanceof BringSessionConflictError,
      });
    }
    return session;
  }
}

function listRows(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  return Array.isArray(record['lists']) ? record['lists'] : undefined;
}

function userRows(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  return Array.isArray(record['users']) ? record['users'] : undefined;
}

function normalizeListSummary(value: unknown, defaultListUuid: string | undefined): BringListSummary | undefined {
  const record = asRecord(value);
  const uuid = stringAt(record, ['listUuid', 'uuid'])?.toLowerCase();
  const name = stringAt(record, ['name', 'listName']);
  if (!uuid || !name || !uuidPattern.test(uuid)) return undefined;
  const users = record['users'];
  const theme = stringAt(record, ['theme']);
  return {
    uuid,
    name,
    ...(theme ? { theme } : {}),
    isDefault: uuid === defaultListUuid?.toLowerCase(),
    shared: record['shared'] === true || record['isShared'] === true || (Array.isArray(users) && users.length > 1),
  };
}

function normalizeItem(value: unknown, status: BringItem['status']): BringItem {
  const record = asRecord(value);
  const uuid = stringAt(record, ['uuid', 'itemUuid']);
  const specification = stringAt(record, ['specification', 'spec']);
  return {
    ...(uuid ? { uuid } : {}),
    name: stringAt(record, ['name', 'itemId']) ?? '',
    ...(specification ? { specification } : {}),
    status,
  };
}

export function validateItems(value: unknown): BringItemInput[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) {
    throw new BringInputError('items must contain between 1 and 50 entries.', 'items');
  }
  return value.map((raw, index) => {
    if (!isRecord(raw)) {
      throw new BringInputError(`items[${index}] must be an object.`, 'items');
    }
    const unknownFields = Object.keys(raw).filter((key) => !['name', 'specification', 'uuid'].includes(key));
    if (unknownFields.length > 0) {
      throw new BringInputError(`items[${index}] contains unknown fields.`, 'items');
    }
    const name = raw['name'];
    const specification = raw['specification'];
    const uuid = raw['uuid'];
    if (typeof name !== 'string' || !name.trim() || name.length > 200) {
      throw new BringInputError(`items[${index}].name must contain 1-200 characters.`, 'items');
    }
    if (specification !== undefined && (typeof specification !== 'string' || specification.length > 500)) {
      throw new BringInputError(`items[${index}].specification must not exceed 500 characters.`, 'items');
    }
    if (uuid !== undefined && (typeof uuid !== 'string' || !uuidPattern.test(uuid))) {
      throw new BringInputError(`items[${index}].uuid must be a valid UUID.`, 'items');
    }
    return {
      name,
      ...(typeof specification === 'string' ? { specification } : {}),
      ...(typeof uuid === 'string' ? { uuid } : {}),
    };
  });
}

function listVersion(listUuid: string, items: BringItem[]): string {
  const canonical = JSON.stringify({
    listUuid,
    items: [...items].sort((left, right) => {
      const leftKey = `${left.status}:${left.uuid ?? ''}:${left.name}:${left.specification ?? ''}`;
      const rightKey = `${right.status}:${right.uuid ?? ''}:${right.name}:${right.specification ?? ''}`;
      return leftKey.localeCompare(rightKey);
    }),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function arrayAt(record: Record<string, unknown>, key: string): unknown[] | undefined {
  return Array.isArray(record[key]) ? record[key] : undefined;
}

function stringAt(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
