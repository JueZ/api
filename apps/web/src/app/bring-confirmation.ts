export type BringMutationOperation = 'complete' | 'remove';

export interface PendingBringConfirmation {
  operationId: string;
  operation: BringMutationOperation;
  listPseudonym: string;
  itemCount: number;
  expiresAt: string;
}

export interface ActiveBringConfirmation extends PendingBringConfirmation {
  listUuid: string;
  confirmationToken: string;
}

type TimeoutHandle = ReturnType<typeof setTimeout>;

interface BringConfirmationVaultOptions {
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => TimeoutHandle;
  cancel?: (handle: TimeoutHandle) => void;
  onClear?: () => void;
}

const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Keeps the short-lived destructive capability outside Angular signals, form state, and templates.
 * Callers receive a copy only while constructing the apply request.
 */
export class BringConfirmationVault {
  readonly #now: () => number;
  readonly #schedule: (callback: () => void, delayMs: number) => TimeoutHandle;
  readonly #cancel: (handle: TimeoutHandle) => void;
  readonly #onClear: () => void;
  #active: ActiveBringConfirmation | null = null;
  #expiryTimer: TimeoutHandle | null = null;

  constructor(options: BringConfirmationVaultOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.#cancel = options.cancel ?? clearTimeout;
    this.#onClear = options.onClear ?? (() => undefined);
  }

  capture(responseBody: unknown, listUuid: string): PendingBringConfirmation | null {
    this.clear();
    if (!isRecord(responseBody) || responseBody['state'] !== 'prepared' || !listUuid.trim()) return null;

    const operation = responseBody['operation'];
    const operationId = responseBody['operationId'];
    const confirmationToken = responseBody['confirmationToken'];
    const listPseudonym = responseBody['listPseudonym'];
    const itemCount = responseBody['itemCount'];
    const expiresAt = responseBody['expiresAt'];
    const expiresAtMs = typeof expiresAt === 'string' ? Date.parse(expiresAt) : Number.NaN;
    if (
      !isBringMutationOperation(operation) ||
      typeof operationId !== 'string' ||
      !operationId.trim() ||
      typeof confirmationToken !== 'string' ||
      !confirmationToken ||
      typeof listPseudonym !== 'string' ||
      typeof itemCount !== 'number' ||
      !Number.isSafeInteger(itemCount) ||
      itemCount < 1 ||
      typeof expiresAt !== 'string' ||
      !Number.isFinite(expiresAtMs) ||
      expiresAtMs <= this.#now()
    ) {
      return null;
    }

    this.#active = {
      operation,
      operationId,
      listUuid: listUuid.trim(),
      confirmationToken,
      listPseudonym,
      itemCount,
      expiresAt,
    };
    this.#expiryTimer = this.#schedule(
      () => this.clear(),
      Math.min(MAX_TIMEOUT_MS, Math.max(0, expiresAtMs - this.#now())),
    );
    return safeSummary(this.#active);
  }

  active(): ActiveBringConfirmation | null {
    if (!this.#active) return null;
    if (Date.parse(this.#active.expiresAt) <= this.#now()) {
      this.clear();
      return null;
    }
    return { ...this.#active };
  }

  clear(): void {
    if (this.#expiryTimer !== null) {
      this.#cancel(this.#expiryTimer);
      this.#expiryTimer = null;
    }
    this.#active = null;
    this.#onClear();
  }
}

export function isBringMutationOperation(value: unknown): value is BringMutationOperation {
  return value === 'complete' || value === 'remove';
}

export function isSucceededBringMutationResponse(value: unknown): boolean {
  return isRecord(value) && value['state'] === 'succeeded';
}

function safeSummary(active: ActiveBringConfirmation): PendingBringConfirmation {
  return {
    operation: active.operation,
    operationId: active.operationId,
    listPseudonym: active.listPseudonym,
    itemCount: active.itemCount,
    expiresAt: active.expiresAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
