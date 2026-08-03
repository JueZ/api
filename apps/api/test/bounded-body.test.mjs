import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BodyTooLargeError,
  readRequestTextWithLimit,
  readResponseTextWithLimit,
} from '../dist/shared/http/boundedBody.js';

test('bounded body reader rejects oversized declared responses before reading', async () => {
  const response = new Response('small', { headers: { 'content-length': '1025' } });
  await assert.rejects(readResponseTextWithLimit(response, 1024), BodyTooLargeError);
});

test('bounded body reader counts streamed bytes and cancels oversized bodies', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(20));
      controller.enqueue(new Uint8Array(20));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(readRequestTextWithLimit({ headers: new Headers(), body }, 32), BodyTooLargeError);
  assert.equal(cancelled, true);
});

test('bounded body reader decodes a valid multibyte stream', async () => {
  const encoded = new TextEncoder().encode('Grüße');
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoded.slice(0, 3));
      controller.enqueue(encoded.slice(3));
      controller.close();
    },
  });
  assert.equal(await readRequestTextWithLimit({ headers: new Headers(), body }, encoded.byteLength), 'Grüße');
});
