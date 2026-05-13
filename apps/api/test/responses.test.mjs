import assert from 'node:assert/strict';
import test from 'node:test';
import { createHealthResponse, createHelloResponse } from '../dist/shared/responses.js';

test('createHealthResponse returns the public health payload', () => {
  const response = createHealthResponse(new Date('2026-05-13T00:00:00.000Z'));

  assert.deepEqual(response, {
    status: 'ok',
    service: 'api-catalogue',
    timestamp: '2026-05-13T00:00:00.000Z',
  });
});

test('createHelloResponse returns the v0 auth placeholder payload', () => {
  const response = createHelloResponse();

  assert.deepEqual(response, {
    message: 'Hello, Martin',
    authenticated: false,
    note: 'Authentication placeholder; JWT enforcement comes in the next milestone.',
  });
});
