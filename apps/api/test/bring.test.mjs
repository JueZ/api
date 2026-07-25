import assert from 'node:assert/strict';
import test from 'node:test';
import { BringClient, BringUpstreamError } from '../dist/shared/bring/client.js';
import { BringConfigError, readBringConfig } from '../dist/shared/bring/config.js';
import { BringService, validateItems } from '../dist/shared/bring/service.js';
import { parseCachedSession } from '../dist/shared/bring/sessionStore.js';
import { bringHandler, setBringServiceForTesting } from '../dist/functions/bring.js';

const listUuid = '11111111-1111-4111-8111-111111111111';
const cfg = { baseUrl: 'https://bring.test/rest/', clientApiKey: 'shared-key', country: 'AT', email: 'private@example.test', password: 'private-password', defaultListUuid: listUuid, sessionCacheEnabled: false, sessionCacheContainer: 'private', sessionCacheBlob: 'session.json', storageAccountName: '', timeoutMs: 1000 };
const login = { access_token: 'access-secret', refresh_token: 'refresh-secret', uuid: 'user-uuid', publicUuid: 'public-uuid', expires_in: 3600, defaultListUuid: listUuid };

test('Bring configuration validates required HTTPS settings without exposing values', () => {
  assert.throws(() => readBringConfig({}), BringConfigError);
  assert.throws(() => readBringConfig({ BRING_BASE_URL: 'http://bad', BRING_CLIENT_API_KEY: 'x', BRING_COUNTRY: 'AT', BRING_EMAIL: 'e', BRING_PASSWORD: 'p' }), /HTTPS/);
});

test('login uses form encoding for spaces, umlauts and ampersands and normalizes session', async () => {
  let body = '';
  const client = new BringClient({ ...cfg, email: 'ä & x@example.test', password: 'p a&ß' }, async (_url, init) => { body = String(init.body); return json(login); });
  const session = await client.login();
  assert.match(body, /%26/); assert.equal(session.accessToken, 'access-secret'); assert.equal(session.defaultListUuid, listUuid);
});

test('plain-text login errors and malformed successful JSON are sanitized', async () => {
  const plain = new BringClient(cfg, async () => new Response('password=private-password', { status: 401 }));
  await assert.rejects(plain.login(), (e) => e instanceof BringUpstreamError && e.kind === 'authentication' && !e.message.includes('private-password'));
  const malformed = new BringClient(cfg, async () => new Response('<html>changed</html>', { status: 200 }));
  await assert.rejects(malformed.login(), (e) => e.kind === 'version_skew');
});

test('concurrent calls share one login and in-memory session', async () => {
  let logins = 0;
  const service = new BringService({ config: cfg, fetchImpl: async (url) => { if (String(url).endsWith('v2/bringauth')) { logins++; await new Promise((r) => setTimeout(r, 10)); return json(login); } return json({ lists: [{ listUuid, name: 'Home' }] }); }, sessionStore: null });
  await Promise.all([service.listLists(), service.listLists(), service.listLists()]);
  assert.equal(logins, 1);
});

test('durable cache is reused after simulated cold start', async () => {
  let logins = 0; const stored = { version: 1, userUuid: 'u', publicUserUuid: 'p', defaultListUuid: listUuid, accessToken: 'cached', refreshToken: 'refresh', accessTokenExpiresAt: new Date(Date.now() + 3600000).toISOString(), updatedAt: new Date().toISOString() };
  const store = { load: async () => stored, save: async () => {}, clear: async () => {} };
  const service = new BringService({ config: { ...cfg, sessionCacheEnabled: true }, sessionStore: store, fetchImpl: async (url) => { if (String(url).includes('bringauth')) logins++; return json({ lists: [] }); } });
  await service.listLists(); assert.equal(logins, 0);
});

test('expired durable token refreshes and invalid refresh falls back to one full login', async () => {
  let refreshes = 0, logins = 0; const expired = { version: 1, userUuid: 'u', publicUserUuid: 'p', defaultListUuid: listUuid, accessToken: 'old', refreshToken: 'bad', accessTokenExpiresAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() };
  const service = new BringService({ config: { ...cfg, sessionCacheEnabled: true }, sessionStore: { load: async () => expired, save: async () => {}, clear: async () => {} }, fetchImpl: async (url) => { if (String(url).endsWith('bringauth/token')) { refreshes++; return new Response('invalid', { status: 401 }); } if (String(url).endsWith('bringauth')) { logins++; return json(login); } return json({ lists: [] }); } });
  await service.listLists(); assert.equal(refreshes, 1); assert.equal(logins, 1);
});

test('ordinary 401 reauthenticates exactly once without an infinite retry', async () => {
  let logins = 0, lists = 0; const service = new BringService({ config: cfg, sessionStore: null, fetchImpl: async (url) => { if (String(url).endsWith('bringauth')) { logins++; return json(login); } lists++; return new Response('unauthorized', { status: 401 }); } });
  await assert.rejects(service.listLists(), BringUpstreamError); assert.equal(logins, 2); assert.equal(lists, 2);
});

test('cache failures and corrupt payloads are safe', async () => {
  assert.equal(parseCachedSession('{broken'), null); assert.equal(parseCachedSession(JSON.stringify({ version: 2 })), null);
  const service = new BringService({ config: cfg, sessionStore: { load: async () => { throw new Error('cache'); }, save: async () => {}, clear: async () => {} }, fetchImpl: async (url) => String(url).endsWith('bringauth') ? json(login) : json({ lists: [] }) });
  await service.listLists();
});

test('list loading, default resolution and batch add/complete preserve duplicates and characters', async () => {
  const calls = []; const service = new BringService({ config: cfg, sessionStore: null, fetchImpl: async (url, init) => { if (String(url).endsWith('bringauth')) return json(login); if (init?.method === 'PUT') { calls.push(JSON.parse(String(init.body))); return json({ ok: true }); } return json({ purchase: [{ name: 'Milch' }], recently: [] }); } });
  assert.equal((await service.getList()).items[0].name, 'Milch'); const items = [{ name: 'Äpfel & Milch', specification: '2 Liter' }, { name: 'Äpfel & Milch', specification: '1 Liter' }]; await service.addItems(undefined, items); await service.completeItems(undefined, items); assert.deepEqual(calls.map((x) => x.operation), ['add', 'complete']); assert.equal(calls[0].items.length, 2);
});

test('item input bounds, lengths, UUIDs and unknown fields fail closed', () => {
  for (const value of [[], Array(51).fill({ name: 'x' }), [{ name: '' }], [{ name: 'x'.repeat(201) }], [{ name: 'x', extra: true }], [{ name: 'x', uuid: 'bad' }]]) assert.throws(() => validateItems(value));
});

test('protected HTTP route preserves existing OAuth envelope and injects service', async () => {
  await withEnv({ AUTH_ENABLED: 'true' }, async () => { const response = await bringHandler({ method: 'GET', url: 'https://api.test/api/bring/lists', params: {}, headers: new Headers() }, context()); assert.equal(response.status, 401); assert.equal(response.jsonBody.error.code, 'unauthorized'); });
  await withEnv({ AUTH_ENABLED: 'false' }, async () => { setBringServiceForTesting({ listLists: async () => ({ source: 'bring', lists: [] }) }); const response = await bringHandler({ method: 'GET', url: 'https://api.test/api/bring/lists', params: {}, headers: new Headers() }, context({ functionName: 'bringListLists' })); assert.equal(response.status, 200); }); setBringServiceForTesting(null);
});

function json(value, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } }); }
function context(extra = {}) { return { invocationId: 'bring-test', warn: () => {}, ...extra }; }
async function withEnv(values, fn) { const old = {}; for (const [k,v] of Object.entries(values)) { old[k]=process.env[k]; process.env[k]=v; } try { await fn(); } finally { for (const [k,v] of Object.entries(old)) v === undefined ? delete process.env[k] : process.env[k]=v; } }
