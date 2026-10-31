import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { ChargecloudClient, ChargecloudError } from '../dist/shared/chargecloud/client.js';
import { ChargecloudService } from '../dist/shared/chargecloud/service.js';
import {
  chargecloudGetInputSchema,
  chargecloudListInputSchema,
  chargecloudListOutputSchema,
  chargecloudGetOutputSchema,
} from '../dist/shared/chargecloud/types.js';

const fixture = async (name) =>
  JSON.parse(await readFile(new URL(`./fixtures/chargecloud/${name}.fixture.json`, import.meta.url), 'utf8'));
const response = (value, options = {}) =>
  new Response(typeof value === 'string' ? value : JSON.stringify(value), options);
const service = (fetchImpl, timeout = 1000) => new ChargecloudService(new ChargecloudClient(fetchImpl, timeout));
const kind = (expected) => (error) => error instanceof ChargecloudError && error.kind === expected;

test('provider-derived live feed is filtered locally, normalized and paged truthfully', async () => {
  const body = await fixture('postal-1080');
  const outside = structuredClone(body.data[0]);
  outside.postal_code = '1090';
  body.data.push(outside);
  const calls = [];
  const api = service(async (url, init) => {
    calls.push({ url: new URL(url), init });
    return response(body);
  });
  const result = await api.list({ limit: 3 });
  assert.equal(result.totalMatching, 20);
  assert.equal(result.returned, 3);
  assert.equal(result.truncated, true);
  assert.equal(result.nextOffset, 3);
  assert.match(result.paginationNote, /new live snapshot/);
  assert.deepEqual(
    result.chargingPoints.map((point) => point.evseId),
    [...result.chargingPoints.map((point) => point.evseId)].sort(),
  );
  assert.equal(chargecloudListOutputSchema.safeParse(result).success, true);
  assert.equal(result.chargingPoints[0].connectors[0].maxPowerKw, 11);
  assert.equal(result.sourceTimestamp, body.timestamp);
  assert.ok(!JSON.stringify(result).includes('uid'));
  assert.equal(calls[0].url.search, '');
  assert.equal(calls[0].init.redirect, 'error');
  const available = await api.list({ availableOnly: true });
  const all = await api.list({});
  const charging = all.chargingPoints.find((point) => point.evseId === 'AT*VNA*E1080570003*1');
  assert.equal(charging.status, 'CHARGING');
  assert.deepEqual(charging.coordinates, { latitude: 48.21239, longitude: 16.345225 });
  assert.ok(available.chargingPoints.every((point) => point.status === 'AVAILABLE'));
  assert.equal(available.totalMatching, available.returned);
  assert.equal(calls.length, 3);
});

test('each call obtains a fresh snapshot; unknown status cannot be available', async () => {
  const body = await fixture('single-evse');
  let calls = 0;
  const statuses = ['AVAILABLE', 'SURPRISE', ' AVAILABLE ', 'available', null];
  const api = service(async () => {
    const next = structuredClone(body);
    next.data[0].evses[0].status = statuses[calls++];
    return response(next);
  });
  assert.equal((await api.list({ availableOnly: true })).returned, 1);
  for (let index = 1; index < statuses.length; index++)
    assert.equal((await api.list({ availableOnly: true })).returned, 0);
  assert.equal(calls, statuses.length);
});

test('exact EVSE lookup uses full ID, ignores upstream extra rows and rejects invalid inputs before fetch', async () => {
  const body = await fixture('single-evse');
  const extra = structuredClone(body.data[0].evses[0]);
  extra.id = 'AT*VNA*E999*1';
  body.data[0].evses.unshift(extra);
  let calls = 0;
  const api = service(async (url) => {
    calls++;
    assert.equal(new URL(url).searchParams.get('evse'), 'AT*VNA*E1080570007*2');
    return response(body);
  });
  const result = await api.get({ evseId: ' AT*VNA*E1080570007*2 ' });
  assert.equal(chargecloudGetOutputSchema.safeParse(result).success, true);
  assert.equal(result.point.evseId, 'AT*VNA*E1080570007*2');
  assert.equal(result.point.address, 'Pfeilgasse 4-6');
  assert.deepEqual(result.point.connectors, [{ type: 'IEC_62196_T2', maxPowerKw: 11 }]);
  await assert.rejects(api.get({ evseId: 'https://example.com/?x=1' }), kind('request'));
  await assert.rejects(api.get({ evseId: 'AT*VNA*E1,AT*VNA*E2' }), kind('request'));
  assert.equal(calls, 1);
  const empty = await fixture('unknown-evse');
  await assert.rejects(service(async () => response(empty)).get({ evseId: 'AT*VNA*E999*1' }), kind('not_found'));
});

test('input schemas reject extra properties and invalid bounds', () => {
  assert.equal(chargecloudListInputSchema.parse({}).postalCode, '1080');
  for (const input of [
    { postalCode: '108' },
    { limit: 101 },
    { offset: 10001 },
    { availableOnly: 'true' },
    { arbitrary: true },
  ])
    assert.equal(chargecloudListInputSchema.safeParse(input).success, false);
  assert.equal(chargecloudGetInputSchema.safeParse({ evseId: 'AT*430*E29013290*1' }).success, true);
  assert.equal(
    chargecloudGetInputSchema.safeParse({ evseId: 'AT*VNA*E1', url: 'https://evil.example' }).success,
    false,
  );
});

test('malformed envelopes, redirect, upstream errors and oversized bodies fail safely', async () => {
  const valid = await fixture('single-evse');
  for (const body of [
    { ...valid, data: undefined },
    { ...valid, status_code: 2000 },
    { ...valid, timestamp: 'bad' },
    '{bad',
  ]) {
    await assert.rejects(service(async () => response(body)).list({}), kind('contract'));
  }
  await assert.rejects(
    service(async () => response('', { status: 302, headers: { location: 'https://example.com' } })).list({}),
    kind('dependency'),
  );
  await assert.rejects(service(async () => response('', { status: 503 })).list({}), kind('dependency'));
  await assert.rejects(service(async () => response('', { status: 429 })).list({}), kind('rate_limit'));
  const duplicate = structuredClone(valid);
  duplicate.data[0].evses.push(structuredClone(duplicate.data[0].evses[0]));
  await assert.rejects(service(async () => response(duplicate)).list({}), kind('contract'));
  await assert.rejects(
    service(async () => response('', { headers: { 'content-length': String(33 * 1024 * 1024) } })).list({}),
    kind('contract'),
  );
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(1024 * 1024 + 1));
      controller.close();
    },
  });
  await assert.rejects(service(async () => new Response(body)).get({ evseId: 'AT*VNA*E1' }), kind('contract'));
});

test('timeout covers fetch and body consumption', async () => {
  await assert.rejects(service(() => new Promise(() => {}), 10).list({}), kind('timeout'));
  const stalled = new ReadableStream({ start() {} });
  await assert.rejects(service(async () => new Response(stalled), 10).list({}), kind('timeout'));
});
