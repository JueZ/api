import type { BringConfig, BringItemInput, BringSession } from './types.js';

export type BringFetch = typeof fetch;
export type BringErrorKind = 'authentication' | 'rate_limit' | 'timeout' | 'upstream' | 'version_skew' | 'not_found';
export class BringUpstreamError extends Error { constructor(message: string, readonly status: number, readonly kind: BringErrorKind) { super(message); } }

export class BringClient {
  constructor(private readonly config: BringConfig, private readonly fetchImpl: BringFetch = fetch, private readonly now: () => Date = () => new Date()) {}
  async login(): Promise<BringSession> {
    const body = new URLSearchParams({ email: this.config.email, password: this.config.password });
    const data = await this.request('v2/bringauth', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }, undefined, true);
    return this.sessionFrom(data);
  }
  async refresh(refreshToken: string, prior: BringSession): Promise<BringSession> {
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken });
    const data = await this.request('v2/bringauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }, undefined, true);
    return this.sessionFrom(data, prior);
  }
  async getLists(session: BringSession): Promise<unknown> { return this.request(`bringusers/${encodeURIComponent(session.userUuid)}/lists`, {}, session); }
  async getList(session: BringSession, listUuid: string): Promise<unknown> { return this.request(`v2/bringlists/${encodeURIComponent(listUuid)}`, {}, session); }
  async updateItems(session: BringSession, listUuid: string, items: BringItemInput[], operation: 'add' | 'complete' | 'remove'): Promise<unknown> {
    return this.request(`v2/bringlists/${encodeURIComponent(listUuid)}/items`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items, operation }) }, session);
  }
  private async request(path: string, init: RequestInit, session?: BringSession, auth = false): Promise<any> {
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/json'); headers.set('X-BRING-API-KEY', this.config.clientApiKey); headers.set('X-BRING-CLIENT', 'webApp'); headers.set('X-BRING-APPLICATION', 'webApp'); headers.set('X-BRING-COUNTRY', this.config.country);
    if (session) { headers.set('Authorization', `Bearer ${session.accessToken}`); headers.set('X-BRING-USER-UUID', session.userUuid); headers.set('X-BRING-PUBLIC-USER-UUID', session.publicUserUuid); }
    let response: Response;
    try { response = await this.fetchImpl(new URL(path, this.config.baseUrl), { ...init, headers, signal: AbortSignal.timeout(this.config.timeoutMs) }); }
    catch (error: any) { if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw new BringUpstreamError('Bring request timed out.', 504, 'timeout'); throw new BringUpstreamError('Bring request failed.', 502, 'upstream'); }
    const text = await response.text(); let data: any = null;
    if (text) { try { data = JSON.parse(text); } catch { if (response.ok) throw new BringUpstreamError('Bring response shape changed.', 502, 'version_skew'); } }
    if (!response.ok) { const status = response.status === 429 ? 429 : response.status === 404 ? 404 : 502; const kind: BringErrorKind = response.status === 429 ? 'rate_limit' : response.status === 404 ? 'not_found' : response.status === 401 || response.status === 403 ? 'authentication' : 'upstream'; throw new BringUpstreamError(auth ? 'Bring account authentication failed.' : 'Bring dependency request failed.', status, kind); }
    if (data === null || typeof data !== 'object') throw new BringUpstreamError('Bring response shape changed.', 502, 'version_skew');
    return data;
  }
  private sessionFrom(data: any, prior?: BringSession): BringSession {
    const accessToken = stringAt(data, ['access_token', 'accessToken', 'token']); const userUuid = stringAt(data, ['uuid', 'userUuid', 'user_uuid']) ?? prior?.userUuid; const publicUserUuid = stringAt(data, ['publicUuid', 'publicUserUuid', 'public_user_uuid']) ?? prior?.publicUserUuid;
    if (!accessToken || !userUuid || !publicUserUuid) throw new BringUpstreamError('Bring authentication response shape changed.', 502, 'version_skew');
    const expiresIn = numberAt(data, ['expires_in', 'expiresIn']) ?? 3600;
    return { version: 1, userUuid, publicUserUuid, defaultListUuid: stringAt(data, ['defaultListUuid', 'default_list_uuid', 'listUuid']) ?? prior?.defaultListUuid ?? this.config.defaultListUuid, accessToken, refreshToken: stringAt(data, ['refresh_token', 'refreshToken']) ?? prior?.refreshToken, accessTokenExpiresAt: new Date(this.now().getTime() + expiresIn * 1000).toISOString(), updatedAt: this.now().toISOString() };
  }
}
function stringAt(x: any, keys: string[]): string | undefined { for (const k of keys) if (typeof x?.[k] === 'string' && x[k]) return x[k]; return undefined; }
function numberAt(x: any, keys: string[]): number | undefined { for (const k of keys) { const n = Number(x?.[k]); if (Number.isFinite(n) && n > 0) return n; } return undefined; }
