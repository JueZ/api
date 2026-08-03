import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { InMemoryBringAuditSink } from '../dist/application/auditing/bringAudit.js';
import { InMemoryBringMutationStore } from '../dist/application/idempotency/bringMutation.js';
import {
  BringConfirmationError,
  BringIdempotencyConflictError,
  BringMutationCoordinator,
  BringMutationOutcomeUnknownError,
} from '../dist/application/operations/bring/mutations.js';
import { BringMutationSecurity } from '../dist/application/operations/bring/mutationSecurity.js';
import { createBringHandler } from '../dist/functions/bring.js';
import { BringClient, BringUpstreamError } from '../dist/shared/bring/client.js';
import { BringConfigError, fingerprintBringAccount, readBringConfig } from '../dist/shared/bring/config.js';
import { BringInputError, BringPolicyError, BringService, validateItems } from '../dist/shared/bring/service.js';
import { parseCachedSession } from '../dist/shared/bring/sessionStore.js';

const providerFixture = JSON.parse(
  await readFile(new URL('./fixtures/bring/provider-v2026-07-26.json', import.meta.url), 'utf8'),
);
const listUuid = '11111111-1111-4111-8111-111111111111';
const sharedListUuid = '22222222-2222-4222-8222-222222222222';
const unlistedListUuid = '33333333-3333-4333-8333-333333333333';
const operationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const secondOperationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const expectedListVersion = '0'.repeat(64);
const hmacKey = 'bring-test-hmac-key-that-is-at-least-32-bytes';
const encryptionKey = Buffer.alloc(32, 7).toString('base64');
const cfg = {
  enabled: true,
  addEnabled: true,
  destructiveEnabled: true,
  baseUrl: 'https://bring.test/rest/',
  clientApiKey: 'shared-key',
  country: 'AT',
  email: 'private@example.test',
  password: 'private-password',
  accountFingerprint: fingerprintBringAccount('private@example.test'),
  defaultListUuid: listUuid,
  readableListUuids: [listUuid],
  writableListUuids: [listUuid],
  writableSharedListUuids: [],
  sessionCacheEnabled: false,
  sessionCacheContainer: 'bring-private',
  sessionCacheBlob: 'session-v1.json',
  mutationContainer: 'bring-mutations',
  auditContainer: 'bring-audit',
  storageAccountName: '',
  confirmationHmacKey: hmacKey,
  mutationEncryptionKey: encryptionKey,
  timeoutMs: 1000,
};
const login = {
  access_token: 'access-secret',
  refresh_token: 'refresh-secret',
  uuid: 'user-uuid',
  publicUuid: 'public-uuid',
  expires_in: 3600,
  bringListUUID: listUuid,
};
const principal = {
  subject: 'user-subject',
  objectId: 'allowed-user',
  tokenType: 'user',
  scopes: ['bring.read', 'bring.write', 'bring.complete', 'bring.remove'],
  roles: [],
};

test('sanitized Bring provider fixture has immutable provenance and no account data', () => {
  const digest = createHash('sha256').update(JSON.stringify(providerFixture.responses)).digest('hex');
  assert.equal(digest, providerFixture.provenance.responsesSha256);
  assert.match(providerFixture.provenance.origin, /Sanitized Bring v2/);
  assert.match(providerFixture.provenance.sanitization, /synthetic/);
  assert.doesNotMatch(JSON.stringify(providerFixture), /private@example|private-password|access-secret/);
});

test('Bring configuration fails closed and test remains read-only for the same account', () => {
  assert.throws(() => readBringConfig({}), BringConfigError);
  assert.throws(
    () =>
      readBringConfig({
        BRING_BASE_URL: 'http://bad',
        BRING_CLIENT_API_KEY: 'x',
        BRING_COUNTRY: 'AT',
        BRING_EMAIL: 'e',
        BRING_PASSWORD: 'p',
      }),
    /HTTPS/,
  );

  const readOnlyTest = readBringConfig({
    DEPLOYED_ENVIRONMENT_NAME: 'test',
    BRING_ENABLED: 'true',
    BRING_ADD_ENABLED: 'false',
    BRING_DESTRUCTIVE_ENABLED: 'false',
    BRING_BASE_URL: 'https://bring.test/rest/',
    BRING_CLIENT_API_KEY: 'x',
    BRING_COUNTRY: 'AT',
    BRING_EMAIL: cfg.email,
    BRING_PASSWORD: 'p',
    BRING_EXPECTED_ACCOUNT_FINGERPRINT: cfg.accountFingerprint,
    BRING_READABLE_LIST_UUIDS: listUuid,
    BRING_DEFAULT_LIST_UUID: listUuid,
  });
  assert.equal(readOnlyTest.accountFingerprint, cfg.accountFingerprint);
  assert.equal(readOnlyTest.addEnabled, false);
  assert.equal(readOnlyTest.destructiveEnabled, false);
  assert.deepEqual(readOnlyTest.writableSharedListUuids, []);

  assert.throws(
    () =>
      readBringConfig({
        DEPLOYED_ENVIRONMENT_NAME: 'prod',
        BRING_ENABLED: 'true',
        BRING_ADD_ENABLED: 'true',
        BRING_DESTRUCTIVE_ENABLED: 'false',
        BRING_BASE_URL: 'https://bring.test/rest/',
        BRING_CLIENT_API_KEY: 'x',
        BRING_COUNTRY: 'AT',
        BRING_EMAIL: cfg.email,
        BRING_PASSWORD: 'p',
        BRING_READABLE_LIST_UUIDS: `${listUuid},${sharedListUuid}`,
        BRING_WRITABLE_LIST_UUIDS: listUuid,
        BRING_WRITABLE_SHARED_LIST_UUIDS: sharedListUuid,
        BRING_CONFIRMATION_HMAC_KEY: hmacKey,
        BRING_MUTATION_ENCRYPTION_KEY: encryptionKey,
      }),
    /shared-writable.*BRING_WRITABLE_LIST_UUIDS/,
  );

  assert.throws(
    () =>
      readBringConfig({
        DEPLOYED_ENVIRONMENT_NAME: 'test',
        BRING_ENABLED: 'true',
        BRING_ADD_ENABLED: 'true',
        BRING_DESTRUCTIVE_ENABLED: 'false',
        BRING_BASE_URL: 'https://bring.test/rest/',
        BRING_CLIENT_API_KEY: 'x',
        BRING_COUNTRY: 'AT',
        BRING_EMAIL: cfg.email,
        BRING_PASSWORD: 'p',
        BRING_READABLE_LIST_UUIDS: listUuid,
        BRING_WRITABLE_LIST_UUIDS: listUuid,
        BRING_CONFIRMATION_HMAC_KEY: hmacKey,
        BRING_MUTATION_ENCRYPTION_KEY: encryptionKey,
      }),
    /prohibited in test/,
  );
});

test('login form-encodes private values and normalizes the session', async () => {
  let body = '';
  let headers;
  const client = new BringClient({ ...cfg, email: 'ä & x@example.test', password: 'p a&ß' }, async (_url, init) => {
    body = String(init.body);
    headers = new Headers(init.headers);
    return json(login);
  });
  const session = await client.login();
  assert.match(body, /%26/);
  assert.equal(session.accessToken, 'access-secret');
  assert.equal(session.defaultListUuid, listUuid);
  assert.equal(headers.get('X-BRING-CLIENT'), 'android');
  assert.equal(headers.get('X-BRING-APPLICATION'), 'bring');
});

test('plain-text login errors and malformed successful JSON are sanitized', async () => {
  const plain = new BringClient(cfg, async () => new Response('password=private-password', { status: 401 }));
  await assert.rejects(
    plain.login(),
    (error) =>
      error instanceof BringUpstreamError &&
      error.kind === 'authentication' &&
      !error.message.includes('private-password'),
  );
  const malformed = new BringClient(cfg, async () => new Response('<html>changed</html>', { status: 200 }));
  await assert.rejects(
    malformed.login(),
    (error) => error instanceof BringUpstreamError && error.kind === 'version_skew',
  );
});

test('Bring rejects oversized provider responses without buffering them', async () => {
  const client = new BringClient(
    cfg,
    async () => new Response('small', { status: 200, headers: { 'content-length': String(1024 * 1024 + 1) } }),
  );
  await assert.rejects(
    client.login(),
    (error) => error instanceof BringUpstreamError && error.kind === 'upstream' && error.status === 502,
  );
});

test('concurrent calls share one login and in-memory session', async () => {
  let logins = 0;
  const service = new BringService({
    config: cfg,
    fetchImpl: async (url) => {
      if (String(url).endsWith('v2/bringauth')) {
        logins += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return json(login);
      }
      return json({ lists: [{ listUuid, name: 'Home' }] });
    },
    sessionStore: null,
  });
  await Promise.all([service.listLists(), service.listLists(), service.listLists()]);
  assert.equal(logins, 1);
});

test('durable session cache is reused and corrupt cache payloads fail safely', async () => {
  assert.equal(parseCachedSession('{broken'), null);
  assert.equal(parseCachedSession(JSON.stringify({ version: 2 })), null);
  let logins = 0;
  const stored = {
    version: 1,
    userUuid: 'u',
    publicUserUuid: 'p',
    defaultListUuid: listUuid,
    accessToken: 'cached',
    refreshToken: 'refresh',
    accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const service = new BringService({
    config: { ...cfg, sessionCacheEnabled: true },
    sessionStore: {
      load: async () => stored,
      save: async () => undefined,
      clear: async () => undefined,
    },
    fetchImpl: async (url) => {
      if (String(url).includes('bringauth')) logins += 1;
      return json({ lists: [{ listUuid, name: 'Home' }] });
    },
  });
  await service.listLists();
  assert.equal(logins, 0);
});

test('expired refresh failure falls back once and ordinary 401 retries only once', async () => {
  const expired = {
    version: 1,
    userUuid: 'u',
    publicUserUuid: 'p',
    defaultListUuid: listUuid,
    accessToken: 'old',
    refreshToken: 'bad',
    accessTokenExpiresAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
  let refreshes = 0;
  let logins = 0;
  const refreshed = new BringService({
    config: { ...cfg, sessionCacheEnabled: true },
    sessionStore: {
      load: async () => expired,
      save: async () => undefined,
      clear: async () => undefined,
    },
    fetchImpl: async (url) => {
      if (String(url).endsWith('bringauth/token')) {
        refreshes += 1;
        return new Response('invalid', { status: 401 });
      }
      if (String(url).endsWith('bringauth')) {
        logins += 1;
        return json(login);
      }
      return json({ lists: [{ listUuid, name: 'Home' }] });
    },
  });
  await refreshed.listLists();
  assert.equal(refreshes, 1);
  assert.equal(logins, 1);

  let listCalls = 0;
  const rejected = new BringService({
    config: cfg,
    sessionStore: null,
    fetchImpl: async (url) => {
      if (String(url).endsWith('bringauth')) {
        logins += 1;
        return json(login);
      }
      listCalls += 1;
      return new Response('unauthorized', { status: 401 });
    },
  });
  await assert.rejects(rejected.listLists(), BringUpstreamError);
  assert.equal(listCalls, 2);
});

test('list reads are allowlisted and shared writes require a second exact-list allowlist', async () => {
  const calls = [];
  const service = new BringService({
    config: {
      ...cfg,
      readableListUuids: [listUuid, sharedListUuid],
      writableListUuids: [listUuid, sharedListUuid],
    },
    sessionStore: null,
    fetchImpl: bringFixtureFetch({
      calls,
      lists: [
        { listUuid, name: 'Mine' },
        { listUuid: sharedListUuid, name: 'Family', isShared: true },
        { listUuid: unlistedListUuid, name: 'Hidden' },
      ],
      membersByList: {
        [sharedListUuid]: [{ publicUuid: 'fixture-public-user' }],
      },
    }),
  });

  const lists = await service.listLists();
  assert.deepEqual(
    lists.lists.map((entry) => [entry.name, entry.shared]),
    [
      ['Mine', false],
      ['Family', true],
    ],
  );
  assert.equal((await service.getList(sharedListUuid)).uuid, sharedListUuid);
  await assert.rejects(service.addItems(sharedListUuid, [{ name: 'Milk' }]), BringPolicyError);
  await assert.rejects(service.getList(unlistedListUuid), BringPolicyError);

  const sharedWriteService = new BringService({
    config: {
      ...cfg,
      defaultListUuid: sharedListUuid,
      readableListUuids: [sharedListUuid],
      writableListUuids: [sharedListUuid],
      writableSharedListUuids: [sharedListUuid],
    },
    sessionStore: null,
    fetchImpl: bringFixtureFetch({
      calls,
      lists: [{ listUuid: sharedListUuid, name: 'Family' }],
      membersByList: {
        [sharedListUuid]: [{ publicUuid: 'fixture-public-user' }, { publicUuid: 'family-member' }],
      },
    }),
  });
  await sharedWriteService.addItems(sharedListUuid, [{ name: 'Milk' }]);
  assert.equal(calls.length, 1);
});

test('shared-list summaries never bypass current Bring membership verification', async () => {
  const service = new BringService({
    config: {
      ...cfg,
      readableListUuids: [sharedListUuid],
      writableListUuids: [sharedListUuid],
      writableSharedListUuids: [sharedListUuid],
    },
    sessionStore: null,
    fetchImpl: bringFixtureFetch({
      calls: [],
      lists: [{ listUuid: sharedListUuid, name: 'Former family list', isShared: true }],
      membersByList: { [sharedListUuid]: [{ publicUuid: 'someone-else' }] },
    }),
  });
  await assert.rejects(service.addItems(sharedListUuid, [{ name: 'Milk' }]), BringPolicyError);
});

test('list versions are stable and batch mutations preserve the observed Bring wire protocol', async () => {
  const calls = [];
  const service = new BringService({
    config: cfg,
    sessionStore: null,
    fetchImpl: bringFixtureFetch({
      calls,
      list: providerFixture.responses.list,
    }),
  });
  const first = await service.getList(listUuid);
  const second = await service.getList(listUuid);
  assert.equal(first.version, second.version);
  assert.deepEqual(first.items, [
    {
      name: 'Fixture active item',
      specification: 'Fixture specification',
      status: 'active',
    },
    { name: 'Fixture completed item', status: 'completed' },
  ]);

  const items = [
    { name: 'Äpfel & Milch', specification: '2 Liter' },
    { name: 'Äpfel & Milch', specification: '1 Liter' },
  ];
  await service.addItems(listUuid, items, first.version);
  await assert.rejects(service.completeItems(listUuid, items), BringInputError);
  await service.completeItems(listUuid, items, first.version);
  await service.removeItems(listUuid, items, first.version);
  assert.deepEqual(
    calls.map((payload) => payload.changes[0].operation),
    ['TO_PURCHASE', 'TO_RECENTLY', 'REMOVE'],
  );
  assert.deepEqual(calls[0], {
    changes: [
      {
        accuracy: '0.0',
        altitude: '0.0',
        latitude: '0.0',
        longitude: '0.0',
        itemId: 'Äpfel & Milch',
        spec: '2 Liter',
        uuid: null,
        operation: 'TO_PURCHASE',
      },
      {
        accuracy: '0.0',
        altitude: '0.0',
        latitude: '0.0',
        longitude: '0.0',
        itemId: 'Äpfel & Milch',
        spec: '1 Liter',
        uuid: null,
        operation: 'TO_PURCHASE',
      },
    ],
    sender: '',
  });
});

test('mutation failures retain metadata-only diagnostics and no provider response content', async () => {
  const privateProviderText =
    'Family list: medication PIN 4829; password=private-password; bearer alternate-secret; email private@example.test';
  const client = new BringClient(
    cfg,
    async () =>
      new Response(privateProviderText, {
        status: 400,
        headers: { 'content-type': 'text/plain' },
      }),
  );
  await assert.rejects(
    client.updateItems(
      {
        version: 1,
        userUuid: 'u',
        publicUserUuid: 'p',
        accessToken: 'access-secret',
        accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        updatedAt: new Date().toISOString(),
      },
      listUuid,
      [{ name: 'Milk' }],
      'add',
    ),
    (error) => {
      assert.equal(error.diagnostics.upstreamStatus, 400);
      assert.equal(error.diagnostics.operation, 'add_items');
      assert.equal(error.diagnostics.path, 'v2/bringlists/{uuid}/items');
      assert.deepEqual(Object.keys(error.diagnostics).sort(), ['method', 'operation', 'path', 'upstreamStatus']);
      for (const fragment of ['Family list', 'medication', '4829', 'private-password', 'alternate-secret']) {
        assert.doesNotMatch(JSON.stringify(error), new RegExp(fragment));
      }
      return true;
    },
  );
});

test('Bring service warning telemetry retains only provider metadata', async () => {
  const warnings = [];
  const privateProviderText = 'Family list medication; api_key=alternate-secret; phone=+43-555-0199';
  const service = new BringService({
    config: cfg,
    sessionStore: null,
    warn: (message, details) => warnings.push({ message, details }),
    fetchImpl: async (url) =>
      String(url).endsWith('v2/bringauth')
        ? json(login)
        : new Response(privateProviderText, {
            status: 503,
            headers: { 'content-type': 'private/provider-detail' },
          }),
  });

  await assert.rejects(service.getList(listUuid), BringUpstreamError);
  assert.deepEqual(warnings, [
    {
      message: 'Bring upstream request failed.',
      details: {
        component: 'bring_upstream',
        error_kind: 'upstream',
        retry_count: 0,
        operation: 'get_items',
        method: 'GET',
        path: 'v2/bringlists/{uuid}',
        upstreamStatus: 503,
      },
    },
  ]);
  assert.doesNotMatch(JSON.stringify(warnings), /Family list|medication|alternate-secret|555-0199|provider-detail/);
});

test('Bring Function warning telemetry rejects unapproved upstream diagnostic fields', async () => {
  const warnings = [];
  const privateProviderText = 'Family medication item; api_key=alternate-secret; private@example.test';
  const application = {
    listLists: async () => {
      throw new BringUpstreamError('Bring dependency request failed.', 502, 'upstream', {
        operation: 'list_lists',
        method: 'GET',
        path: 'bringusers/{uuid}/lists',
        upstreamStatus: 503,
        responseExcerpt: privateProviderText,
        responseContentType: 'private/provider-detail',
        unapproved: 'must-not-be-logged',
      });
    },
  };
  const handler = createBringHandler({ getApplication: () => application });

  await withEnv({ AUTH_ENABLED: 'false', DEPLOYED_ENVIRONMENT_NAME: 'local' }, async () => {
    const response = await handler(
      request('GET', 'https://api.test/api/bring/lists'),
      context({ functionName: 'bringListLists', warn: (message, details) => warnings.push({ message, details }) }),
    );
    assert.equal(response.status, 502);
  });

  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].message, 'Bring request failed with a sanitized repairable error.');
  assert.deepEqual(Object.keys(warnings[0].details).sort(), [
    'classification',
    'diagnostic_id',
    'method',
    'operation',
    'operation_id',
    'path',
    'status',
    'upstreamStatus',
  ]);
  assert.equal(warnings[0].details.operation, 'list_lists');
  assert.equal(warnings[0].details.path, 'bringusers/{uuid}/lists');
  assert.doesNotMatch(
    JSON.stringify(warnings),
    /Family medication|alternate-secret|private@example|provider-detail|must-not-be-logged/,
  );
});

test('item input bounds, lengths, UUIDs, and unknown fields fail closed', () => {
  for (const value of [
    [],
    Array(51).fill({ name: 'x' }),
    [{ name: '' }],
    [{ name: 'x'.repeat(201) }],
    [{ name: 'x', extra: true }],
    [{ name: 'x', uuid: 'bad' }],
  ]) {
    assert.throws(() => validateItems(value));
  }
});

test('add is idempotent by operation ID and rejects payload reuse', async () => {
  const calls = [];
  const { coordinator, store, audit } = mutationHarness({
    mutateItems: async (operation, selectedListUuid, items) => {
      calls.push([operation, selectedListUuid, items.length]);
      return { listUuid: selectedListUuid, operation, itemCount: items.length };
    },
  });
  const command = {
    operationId,
    listUuid,
    items: [{ name: 'Milk' }],
  };

  const first = await coordinator.addItems(principal, command, 'trace-add-1');
  const replay = await coordinator.addItems(principal, command, 'trace-add-2');
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.deepEqual(calls, [['add', listUuid, 1]]);
  await assert.rejects(
    coordinator.addItems(principal, { ...command, items: [{ name: 'Bread' }] }, 'trace-add-3'),
    BringIdempotencyConflictError,
  );
  const stored = await store.get(operationId);
  assert.equal(stored.record.encryptedPayload, undefined);
  assert.equal(audit.events.length, 2);
  assert.doesNotMatch(JSON.stringify(audit.events), /Milk|Bread/);
});

test('generated mutation cases preserve operation ID, payload, list, and principal binding', async () => {
  for (let index = 1; index <= 16; index += 1) {
    const generatedOperationId = `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
    const generatedListUuid = `10000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
    let providerCalls = 0;
    const { coordinator } = mutationHarness({
      mutateItems: async (operation, selectedListUuid, items) => {
        providerCalls += 1;
        return { listUuid: selectedListUuid, operation, itemCount: items.length };
      },
    });
    const command = {
      operationId: generatedOperationId,
      listUuid: generatedListUuid,
      expectedListVersion: createHash('sha256').update(`version-${index}`).digest('hex'),
      items: [{ name: `Generated item ${index}` }],
    };

    const first = await coordinator.addItems(principal, command, `trace-generated-${index}-first`);
    const replay = await coordinator.addItems(principal, command, `trace-generated-${index}-replay`);
    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.equal(providerCalls, 1);

    for (const conflictingCommand of [
      { ...command, listUuid },
      { ...command, expectedListVersion: 'f'.repeat(64) },
      { ...command, items: [{ name: `Changed item ${index}` }] },
    ]) {
      await assert.rejects(
        coordinator.addItems(principal, conflictingCommand, `trace-generated-${index}-conflict`),
        BringIdempotencyConflictError,
      );
    }
    await assert.rejects(
      coordinator.addItems(
        { ...principal, objectId: `different-user-${index}` },
        command,
        `trace-generated-${index}-principal`,
      ),
      BringIdempotencyConflictError,
    );
    assert.equal(providerCalls, 1);
  }
});

test('pre-mutation audit failure is fail-closed and never calls Bring', async () => {
  let calls = 0;
  const audit = {
    append: async () => {
      throw new Error('audit unavailable');
    },
  };
  const { coordinator, store } = mutationHarness({
    audit,
    mutateItems: async () => {
      calls += 1;
      return { listUuid, operation: 'add', itemCount: 1 };
    },
  });
  const command = {
    operationId,
    listUuid,
    items: [{ name: 'Milk' }],
  };

  await assert.rejects(coordinator.addItems(principal, command, 'trace-audit-failed'), /audit unavailable/);
  await assert.rejects(coordinator.addItems(principal, command, 'trace-audit-retry'), BringMutationOutcomeUnknownError);
  assert.equal(calls, 0);
  assert.equal((await store.get(operationId)).record.state, 'applying');
});

test('terminal audit failure does not misreport or replay a successful Bring mutation', async () => {
  let calls = 0;
  const warnings = [];
  const audit = {
    events: [],
    append: async (event) => {
      if (event.result === 'succeeded') throw new Error('audit unavailable');
      audit.events.push(structuredClone(event));
    },
  };
  const { coordinator, store } = mutationHarness({
    audit,
    warn: (message, details) => warnings.push({ message, details }),
    mutateItems: async (operation, selectedListUuid, items) => {
      calls += 1;
      return { listUuid: selectedListUuid, operation, itemCount: items.length };
    },
  });
  const command = {
    operationId,
    listUuid,
    items: [{ name: 'Milk' }],
  };

  const first = await coordinator.addItems(principal, command, 'trace-terminal-audit-failed');
  const replay = await coordinator.addItems(principal, command, 'trace-terminal-audit-replay');
  assert.equal(first.state, 'succeeded');
  assert.equal(replay.replayed, true);
  assert.equal(calls, 1);
  assert.equal((await store.get(operationId)).record.state, 'succeeded');
  assert.equal(warnings.length, 1);
  assert.deepEqual(warnings[0].details, { operation: 'add', state: 'succeeded', attempts: 3 });
});

test('post-provider persistence failure remains outcome-unknown and is never replayed', async () => {
  let calls = 0;
  const baseStore = new InMemoryBringMutationStore();
  const store = {
    get: (selectedOperationId) => baseStore.get(selectedOperationId),
    create: (record) => baseStore.create(record),
    replace: (record, etag) => {
      if (record.state === 'succeeded') throw new Error('mutation store unavailable');
      return baseStore.replace(record, etag);
    },
  };
  const { coordinator } = mutationHarness({
    store,
    mutateItems: async (operation, selectedListUuid, items) => {
      calls += 1;
      return { listUuid: selectedListUuid, operation, itemCount: items.length };
    },
  });
  const command = {
    operationId,
    listUuid,
    items: [{ name: 'Milk' }],
  };

  await assert.rejects(
    coordinator.addItems(principal, command, 'trace-persistence-failed'),
    BringMutationOutcomeUnknownError,
  );
  await assert.rejects(
    coordinator.addItems(principal, command, 'trace-persistence-retry'),
    BringMutationOutcomeUnknownError,
  );
  assert.equal(calls, 1);
  assert.equal((await store.get(operationId)).record.state, 'applying');
});

test('destructive mutations require a fresh principal-bound confirmation and execute once', async () => {
  const calls = [];
  const { coordinator, audit } = mutationHarness({
    mutateItems: async (operation, selectedListUuid, items) => {
      calls.push([operation, selectedListUuid, items.length]);
      return { listUuid: selectedListUuid, operation, itemCount: items.length };
    },
  });
  const command = {
    operationId: secondOperationId,
    listUuid,
    expectedListVersion,
    operation: 'remove',
    items: [{ name: 'Private item name' }],
  };

  await assert.rejects(
    coordinator.prepare(principal, { ...command, expectedListVersion: undefined }, 'trace-prepare-missing-version'),
    BringInputError,
  );
  const prepared = await coordinator.prepare(principal, command, 'trace-prepare-1');
  const refreshed = await coordinator.prepare(principal, command, 'trace-prepare-2');
  assert.equal(prepared.state, 'prepared');
  assert.equal(refreshed.replayed, true);
  assert.notEqual(prepared.confirmationToken, refreshed.confirmationToken);
  assert.doesNotMatch(JSON.stringify(prepared), /Private item name|11111111/);

  await assert.rejects(
    coordinator.apply(
      principal,
      { operationId: secondOperationId, listUuid, confirmationToken: '' },
      'trace-apply-empty-token',
    ),
    BringInputError,
  );
  await assert.rejects(
    coordinator.apply(
      principal,
      { operationId: secondOperationId, listUuid, confirmationToken: prepared.confirmationToken },
      'trace-apply-old-token',
    ),
    BringConfirmationError,
  );
  await assert.rejects(
    coordinator.apply(
      { ...principal, objectId: 'different-user' },
      { operationId: secondOperationId, listUuid, confirmationToken: refreshed.confirmationToken },
      'trace-apply-wrong-user',
    ),
    BringConfirmationError,
  );
  await assert.rejects(
    coordinator.apply(
      principal,
      {
        operationId: secondOperationId,
        listUuid: sharedListUuid,
        confirmationToken: refreshed.confirmationToken,
      },
      'trace-apply-wrong-list',
    ),
    BringConfirmationError,
  );
  const result = await coordinator.apply(
    principal,
    { operationId: secondOperationId, listUuid, confirmationToken: refreshed.confirmationToken },
    'trace-apply',
  );
  const replay = await coordinator.apply(
    principal,
    { operationId: secondOperationId, listUuid, confirmationToken: refreshed.confirmationToken },
    'trace-apply-replay',
  );
  assert.equal(result.replayed, false);
  assert.equal(replay.replayed, true);
  assert.deepEqual(calls, [['remove', listUuid, 1]]);
  assert.doesNotMatch(JSON.stringify(audit.events), /Private item name|11111111/);
  assert.ok(audit.events.every((event) => event.principalPseudonym.length === 64));
  assert.ok(audit.events.every((event) => event.listPseudonym.length === 64));
});

test('concurrent confirmation apply uses optimistic concurrency and calls the provider once', async () => {
  let providerCalls = 0;
  const { coordinator } = mutationHarness({
    mutateItems: async (operation, selectedListUuid, items) => {
      providerCalls += 1;
      return { listUuid: selectedListUuid, operation, itemCount: items.length };
    },
  });
  const prepared = await coordinator.prepare(
    principal,
    {
      operationId: secondOperationId,
      listUuid,
      expectedListVersion,
      operation: 'complete',
      items: [{ name: 'Milk' }],
    },
    'trace-concurrent-prepare',
  );
  const command = {
    operationId: secondOperationId,
    listUuid,
    confirmationToken: prepared.confirmationToken,
  };

  const results = await Promise.allSettled([
    coordinator.apply(principal, command, 'trace-concurrent-a'),
    coordinator.apply(principal, command, 'trace-concurrent-b'),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert.ok(rejected);
  assert.ok(rejected.reason instanceof BringMutationOutcomeUnknownError);
  assert.equal(providerCalls, 1);
});

test('partial provider success with an ambiguous timeout is recorded and never replayed automatically', async () => {
  let providerSideEffects = 0;
  const { coordinator, store } = mutationHarness({
    mutateItems: async () => {
      providerSideEffects += 1;
      throw new BringUpstreamError('Bring request timed out.', 504, 'timeout');
    },
  });
  const prepared = await coordinator.prepare(
    principal,
    {
      operationId: secondOperationId,
      listUuid,
      expectedListVersion,
      operation: 'complete',
      items: [{ name: 'Milk' }],
    },
    'trace-prepare',
  );
  await assert.rejects(
    coordinator.apply(
      principal,
      {
        operationId: secondOperationId,
        listUuid,
        confirmationToken: prepared.confirmationToken,
      },
      'trace-apply',
    ),
    BringUpstreamError,
  );
  await assert.rejects(
    coordinator.apply(
      principal,
      {
        operationId: secondOperationId,
        listUuid,
        confirmationToken: prepared.confirmationToken,
      },
      'trace-retry',
    ),
    BringMutationOutcomeUnknownError,
  );
  assert.equal(providerSideEffects, 1);
  assert.equal((await store.get(secondOperationId)).record.state, 'outcome_unknown');
});

test('HTTP handler uses the breaking add/prepare/apply contract through one application port', async () => {
  const calls = [];
  const application = {
    listLists: async () => ({ source: 'bring', lists: [] }),
    getList: async (selectedListUuid) => ({
      uuid: selectedListUuid,
      version: '0'.repeat(64),
      items: [],
    }),
    addItems: async (_principal, command, correlationId) => {
      calls.push(['add', command, correlationId]);
      return mutationResult(command, 'add');
    },
    prepareMutation: async (_principal, command, correlationId) => {
      calls.push(['prepare', command, correlationId]);
      return {
        source: 'bring',
        state: 'prepared',
        operationId: command.operationId,
        operation: command.operation,
        listPseudonym: 'a'.repeat(64),
        itemCount: command.items.length,
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
        confirmationToken: 'safe-token',
        replayed: false,
      };
    },
    applyMutation: async (_principal, command, correlationId) => {
      calls.push(['apply', command, correlationId]);
      return {
        source: 'bring',
        listUuid,
        operation: 'remove',
        operationId: command.operationId,
        itemCount: 1,
        state: 'succeeded',
        replayed: false,
      };
    },
    getMutationOperation: async () => 'remove',
    getConfirmationOperation: (token) => (token === 'safe-token' ? 'remove' : undefined),
  };
  const handler = createBringHandler({ getApplication: () => application });

  await withEnv({ AUTH_ENABLED: 'true' }, async () => {
    const response = await handler(
      request('GET', 'https://api.test/api/bring/lists'),
      context({ functionName: 'bringListLists' }),
    );
    assert.equal(response.status, 401);
  });

  await withEnv({ AUTH_ENABLED: 'false', DEPLOYED_ENVIRONMENT_NAME: 'local' }, async () => {
    const add = await handler(
      request(
        'POST',
        `https://api.test/api/bring/lists/${listUuid}/items`,
        {
          operationId,
          items: [{ name: 'Milk' }],
        },
        { listUuid },
      ),
      context({ functionName: 'bringItems' }),
    );
    const prepare = await handler(
      request(
        'POST',
        `https://api.test/api/bring/lists/${listUuid}/mutations/prepare`,
        {
          operationId: secondOperationId,
          expectedListVersion,
          operation: 'remove',
          items: [{ name: 'Milk' }],
        },
        { listUuid },
      ),
      context({ functionName: 'bringPrepareMutation' }),
    );
    const missingVersion = await handler(
      request(
        'POST',
        `https://api.test/api/bring/lists/${listUuid}/mutations/prepare`,
        {
          operationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          operation: 'remove',
          items: [{ name: 'Milk' }],
        },
        { listUuid },
      ),
      context({ functionName: 'bringPrepareMutation' }),
    );
    const apply = await handler(
      request(
        'POST',
        `https://api.test/api/bring/lists/${listUuid}/mutations/apply`,
        {
          operationId: secondOperationId,
          confirmationToken: 'safe-token',
        },
        { listUuid },
      ),
      context({ functionName: 'bringApplyMutation' }),
    );
    const missingList = await handler(
      request('GET', 'https://api.test/api/bring/lists//items'),
      context({ functionName: 'bringItems' }),
    );
    assert.equal(add.status, 200);
    assert.equal(prepare.status, 200);
    assert.equal(missingVersion.status, 400);
    assert.equal(apply.status, 200);
    assert.equal(missingList.status, 400);
  });

  assert.deepEqual(
    calls.map((entry) => entry[0]),
    ['add', 'prepare', 'apply'],
  );
  assert.equal(calls[0][1].operationId, operationId);
  assert.equal(calls[1][1].operation, 'remove');
  assert.equal(calls[1][1].expectedListVersion, expectedListVersion);
  assert.equal(calls[2][1].listUuid, listUuid);
  assert.equal(calls[2][1].confirmationToken, 'safe-token');
});

test('Bring mutation handlers authenticate before reading request bodies and cap authenticated payloads', async () => {
  const handler = createBringHandler({
    getApplication: () => {
      throw new Error('application must not be resolved before authentication');
    },
  });
  let bodyRead = false;
  const unauthenticatedRequest = {
    method: 'POST',
    url: `https://api.test/api/bring/lists/${listUuid}/items`,
    params: { listUuid },
    headers: new Headers(),
    get body() {
      bodyRead = true;
      throw new Error('body must not be read');
    },
  };
  await withEnv({ AUTH_ENABLED: 'true' }, async () => {
    const response = await handler(unauthenticatedRequest, context({ functionName: 'bringItems' }));
    assert.equal(response.status, 401);
  });
  assert.equal(bodyRead, false);

  const localHandler = createBringHandler({
    getApplication: () => ({
      addItems: async () => {
        throw new Error('oversized body must not reach the application');
      },
    }),
  });
  await withEnv({ AUTH_ENABLED: 'false', DEPLOYED_ENVIRONMENT_NAME: 'local' }, async () => {
    const response = await localHandler(
      request(
        'POST',
        `https://api.test/api/bring/lists/${listUuid}/items`,
        { operationId, items: [{ name: 'x'.repeat(70 * 1024) }] },
        { listUuid },
      ),
      context({ functionName: 'bringItems' }),
    );
    assert.equal(response.status, 413);
  });
});

function mutationHarness({
  mutateItems,
  store = new InMemoryBringMutationStore(),
  audit = new InMemoryBringAuditSink(),
  warn = () => undefined,
}) {
  const service = {
    validateMutationTarget: async (_operation, selectedListUuid, items) => ({
      listUuid: selectedListUuid,
      items,
    }),
    mutateItems,
  };
  const security = new BringMutationSecurity(hmacKey, encryptionKey);
  const coordinator = new BringMutationCoordinator(
    service,
    store,
    audit,
    security,
    () => new Date('2026-07-26T12:00:00.000Z'),
    'test-commit',
    warn,
  );
  return { coordinator, store, audit };
}

function bringFixtureFetch({ lists, list, calls = [], membersByList = {} } = {}) {
  return async (url, init) => {
    const path = String(url);
    if (path.endsWith('v2/bringauth')) return json(providerFixture.responses.login);
    if (path.endsWith('/users')) {
      const selectedListUuid = path.match(/bringlists\/([^/]+)\/users$/)?.[1];
      return json({
        users: membersByList[selectedListUuid] ?? [{ publicUuid: 'fixture-public-user' }],
      });
    }
    if (path.includes('/bringusers/')) {
      return json(lists ? { lists } : providerFixture.responses.lists);
    }
    if (init?.method === 'PUT') {
      calls.push(JSON.parse(String(init.body)));
      return new Response(null, { status: 204 });
    }
    return json(list ?? { purchase: [{ name: 'Bread' }], recently: [] });
  };
}

function mutationResult(command, operation) {
  return {
    source: 'bring',
    listUuid: command.listUuid,
    operation,
    operationId: command.operationId,
    itemCount: command.items.length,
    state: 'succeeded',
    replayed: false,
  };
}

function request(method, url, body, params = {}) {
  const serializedBody = body === undefined ? '' : JSON.stringify(body);
  return {
    method,
    url,
    params,
    headers: new Headers(serializedBody ? { 'content-length': String(Buffer.byteLength(serializedBody)) } : {}),
    body: serializedBody
      ? new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(serializedBody));
            controller.close();
          },
        })
      : null,
    json: async () => body,
  };
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function context(extra = {}) {
  return {
    invocationId: 'bring-test',
    functionName: 'bringItems',
    warn: () => undefined,
    ...extra,
  };
}

async function withEnv(values, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
