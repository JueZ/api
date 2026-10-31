import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { ChargecloudClient, ChargecloudError } from '../dist/shared/chargecloud/client.js';
import { ChargecloudService } from '../dist/shared/chargecloud/service.js';

const fixture = async () =>
  JSON.parse(await readFile(new URL('./fixtures/chargecloud/postal-1080.fixture.json', import.meta.url), 'utf8'));
const service = (body) => new ChargecloudService(new ChargecloudClient(async () => new Response(JSON.stringify(body))));

test('a malformed matching station cannot produce a successful partial inventory', async () => {
  const body = await fixture();
  delete body.data[1].evses;
  await assert.rejects(
    service(body).list({}),
    (error) => error instanceof ChargecloudError && error.kind === 'contract',
  );
});

test('unclassifiable postal membership cannot masquerade as a successful empty inventory', async () => {
  for (const value of [undefined, null, 1080]) {
    const body = await fixture();
    body.data = [body.data[0]];
    if (value === undefined) delete body.data[0].postal_code;
    else body.data[0].postal_code = value;
    await assert.rejects(
      service(body).list({}),
      (error) => error instanceof ChargecloudError && error.kind === 'contract',
    );
  }
});

test('a missing provider EVSE identity is a contract failure rather than not_found', async () => {
  const body = await fixture();
  body.data = [body.data[0]];
  body.data[0].evses = [body.data[0].evses[0]];
  const evseId = body.data[0].evses[0].id;
  delete body.data[0].evses[0].id;
  await assert.rejects(
    service(body).get({ evseId }),
    (error) => error instanceof ChargecloudError && error.kind === 'contract',
  );
});

test('conflicting duplicate exact EVSE identities cannot silently choose the first status', async () => {
  const body = await fixture();
  const duplicate = structuredClone(body.data[0]);
  duplicate.evses[0].status = body.data[0].evses[0].status === 'AVAILABLE' ? 'CHARGING' : 'AVAILABLE';
  body.data.push(duplicate);
  await assert.rejects(
    service(body).get({ evseId: body.data[0].evses[0].id }),
    (error) => error instanceof ChargecloudError && error.kind === 'contract',
  );
});

test('unchanged membership paginates deterministically even when provider order changes', async () => {
  const body = await fixture();
  let calls = 0;
  const api = new ChargecloudService(
    new ChargecloudClient(async () => {
      const snapshot = structuredClone(body);
      if (calls++ % 2) snapshot.data.reverse();
      return new Response(JSON.stringify(snapshot));
    }),
  );
  const first = await api.list({ limit: 7 });
  const second = await api.list({ limit: 7, offset: first.nextOffset });
  const third = await api.list({ limit: 7, offset: second.nextOffset });
  const ids = [...first.chargingPoints, ...second.chargingPoints, ...third.chargingPoints].map((point) => point.evseId);
  assert.equal(ids.length, 20);
  assert.equal(new Set(ids).size, 20);
  assert.equal(third.truncated, false);
  assert.equal(third.nextOffset, undefined);
  assert.equal(calls, 3);
});

// The caller must not leave a provider response downloading after it has already
// rejected that response. A status/declared-length failure happens before reading
// the stream, so ordinary body-size tests alone do not establish this bound.
for (const scenario of [
  { name: 'rate limited', status: 429, kind: 'rate_limit' },
  { name: 'upstream failure', status: 503, kind: 'dependency' },
  { name: 'redirect', status: 302, kind: 'dependency' },
  {
    name: 'oversized declared body',
    status: 200,
    headers: { 'content-length': String(33 * 1024 * 1024) },
    kind: 'contract',
  },
]) {
  test(`early ${scenario.name} rejection terminates the provider transfer`, async () => {
    let cancelled = false;
    let signal;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('provider bytes'));
        // Deliberately leave the response open like a slow/chunked error page.
      },
      cancel() {
        cancelled = true;
      },
    });
    const client = new ChargecloudClient(async (_url, init) => {
      signal = init.signal;
      return new Response(body, { status: scenario.status, headers: scenario.headers });
    }, 1000);

    try {
      await assert.rejects(
        client.locations(),
        (error) => error instanceof ChargecloudError && error.kind === scenario.kind,
      );
      assert.ok(
        cancelled || signal.aborted,
        'Rejected provider transfer must be cancelled or aborted before returning',
      );
    } finally {
      if (!body.locked) await body.cancel();
    }
  });
}
