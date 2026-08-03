import type { BringConfig, BringItemInput, BringMutationOperation, BringSession } from './types.js';
import { BodyTooLargeError, readResponseTextWithLimit } from '../http/boundedBody.js';

export type BringFetch = typeof fetch;
export type BringErrorKind = 'authentication' | 'rate_limit' | 'timeout' | 'upstream' | 'version_skew' | 'not_found';

export const BRING_RESPONSE_MAX_BYTES = 1024 * 1024;

interface BringErrorDiagnostics {
  operation: string;
  method: string;
  path: string;
  upstreamStatus?: number;
}

export type BringUpstreamTelemetryDetails = BringErrorDiagnostics;

export class BringUpstreamError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly kind: BringErrorKind,
    readonly diagnostics?: BringErrorDiagnostics,
  ) {
    super(message);
  }
}

export class BringClient {
  constructor(
    private readonly config: BringConfig,
    private readonly fetchImpl: BringFetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async login(): Promise<BringSession> {
    const body = new URLSearchParams({
      email: this.config.email,
      password: this.config.password,
    });
    const data = await this.request(
      'v2/bringauth',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      },
      undefined,
      { auth: true, operation: 'login' },
    );
    return this.sessionFrom(data);
  }

  async refresh(refreshToken: string, prior: BringSession): Promise<BringSession> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
    const data = await this.request(
      'v2/bringauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      },
      undefined,
      { auth: true, operation: 'refresh' },
    );
    return this.sessionFrom(data, prior);
  }

  async getLists(session: BringSession): Promise<unknown> {
    return this.request(`bringusers/${encodeURIComponent(session.userUuid)}/lists`, {}, session, {
      operation: 'list_lists',
    });
  }

  async getList(session: BringSession, listUuid: string): Promise<unknown> {
    return this.request(`v2/bringlists/${encodeURIComponent(listUuid)}`, {}, session, { operation: 'get_items' });
  }

  async getListUsers(session: BringSession, listUuid: string): Promise<unknown> {
    return this.request(`v2/bringlists/${encodeURIComponent(listUuid)}/users`, {}, session, {
      operation: 'get_list_users',
    });
  }

  async updateItems(
    session: BringSession,
    listUuid: string,
    items: BringItemInput[],
    operation: BringMutationOperation,
  ): Promise<void> {
    const upstreamOperation = {
      add: 'TO_PURCHASE',
      complete: 'TO_RECENTLY',
      remove: 'REMOVE',
    }[operation];
    const changes = items.map((item) => ({
      accuracy: '0.0',
      altitude: '0.0',
      latitude: '0.0',
      longitude: '0.0',
      itemId: item.name,
      spec: item.specification ?? '',
      uuid: item.uuid ?? null,
      operation: upstreamOperation,
    }));

    await this.request(
      `v2/bringlists/${encodeURIComponent(listUuid)}/items`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changes, sender: '' }),
      },
      session,
      { allowEmpty: true, operation: `${operation}_items` },
    );
  }

  private async request(
    path: string,
    init: RequestInit,
    session: BringSession | undefined,
    options: { auth?: boolean; allowEmpty?: boolean; operation: string },
  ): Promise<unknown> {
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/json');
    headers.set('X-BRING-API-KEY', this.config.clientApiKey);
    headers.set('X-BRING-CLIENT', 'android');
    headers.set('X-BRING-APPLICATION', 'bring');
    headers.set('X-BRING-COUNTRY', this.config.country);
    if (session) {
      headers.set('Authorization', `Bearer ${session.accessToken}`);
      headers.set('X-BRING-USER-UUID', session.userUuid);
      headers.set('X-BRING-PUBLIC-USER-UUID', session.publicUserUuid);
    }

    const baseDiagnostics = {
      operation: options.operation,
      method,
      path: safePath(path),
    };
    let response;
    try {
      response = await this.fetchImpl(new URL(path, this.config.baseUrl), {
        ...init,
        headers,
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw new BringUpstreamError('Bring request timed out.', 504, 'timeout', baseDiagnostics);
      }
      throw new BringUpstreamError('Bring request failed.', 502, 'upstream', baseDiagnostics);
    }

    const responseDiagnostics = {
      ...baseDiagnostics,
      upstreamStatus: response.status,
    };
    let text: string;
    try {
      text = await readResponseTextWithLimit(response, BRING_RESPONSE_MAX_BYTES);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        throw new BringUpstreamError(
          'Bring response exceeded the safe size limit.',
          502,
          'upstream',
          responseDiagnostics,
        );
      }
      throw new BringUpstreamError('Bring response could not be read.', 502, 'upstream', responseDiagnostics);
    }
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text) as unknown;
      } catch {
        if (response.ok) {
          throw new BringUpstreamError('Bring response shape changed.', 502, 'version_skew', responseDiagnostics);
        }
      }
    }

    if (!response.ok) {
      const status = response.status === 429 ? 429 : response.status === 404 ? 404 : 502;
      const kind: BringErrorKind =
        response.status === 429
          ? 'rate_limit'
          : response.status === 404
            ? 'not_found'
            : response.status === 401 || response.status === 403
              ? 'authentication'
              : 'upstream';
      throw new BringUpstreamError(
        options.auth ? 'Bring account authentication failed.' : 'Bring dependency request failed.',
        status,
        kind,
        responseDiagnostics,
      );
    }

    if (data === null) {
      if (options.allowEmpty) return undefined;
      throw new BringUpstreamError('Bring response shape changed.', 502, 'version_skew', responseDiagnostics);
    }
    if (!isRecord(data) && !Array.isArray(data)) {
      throw new BringUpstreamError('Bring response shape changed.', 502, 'version_skew', responseDiagnostics);
    }
    return data;
  }

  private sessionFrom(data: unknown, prior?: BringSession): BringSession {
    const accessToken = stringAt(data, ['access_token', 'accessToken', 'token']);
    const userUuid = stringAt(data, ['uuid', 'userUuid', 'user_uuid']) ?? prior?.userUuid;
    const publicUserUuid =
      stringAt(data, ['publicUuid', 'publicUserUuid', 'public_user_uuid']) ?? prior?.publicUserUuid;
    if (!accessToken || !userUuid || !publicUserUuid) {
      throw new BringUpstreamError('Bring authentication response shape changed.', 502, 'version_skew');
    }
    const expiresIn = numberAt(data, ['expires_in', 'expiresIn']) ?? 3600;
    const defaultListUuid =
      stringAt(data, ['defaultListUuid', 'default_list_uuid', 'bringListUUID', 'bringListUuid', 'listUuid']) ??
      prior?.defaultListUuid ??
      this.config.defaultListUuid;
    const refreshToken = stringAt(data, ['refresh_token', 'refreshToken']) ?? prior?.refreshToken;
    return {
      version: 1,
      userUuid,
      publicUserUuid,
      ...(defaultListUuid ? { defaultListUuid } : {}),
      accessToken,
      ...(refreshToken ? { refreshToken } : {}),
      accessTokenExpiresAt: new Date(this.now().getTime() + expiresIn * 1000).toISOString(),
      updatedAt: this.now().toISOString(),
    };
  }
}

export function bringUpstreamTelemetryDetails(error: BringUpstreamError): BringUpstreamTelemetryDetails | undefined {
  const diagnostics = error.diagnostics;
  if (!diagnostics) return undefined;
  return {
    operation: diagnostics.operation,
    method: diagnostics.method,
    path: diagnostics.path,
    ...(diagnostics.upstreamStatus === undefined ? {} : { upstreamStatus: diagnostics.upstreamStatus }),
  };
}

function safePath(path: string): string {
  return path.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '{uuid}');
}

function stringAt(value: unknown, keys: string[]): string | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return undefined;
}

function numberAt(value: unknown, keys: string[]): number | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of keys) {
    const candidate = Number(value[key]);
    if (Number.isFinite(candidate) && candidate > 0) return candidate;
  }
  return undefined;
}

function isAbortError(error: unknown): boolean {
  return isRecord(error) && (error['name'] === 'TimeoutError' || error['name'] === 'AbortError');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
