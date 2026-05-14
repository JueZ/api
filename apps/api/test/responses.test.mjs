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

test('createHelloResponse returns an authenticated v0 payload without raw claims', () => {
  const response = createHelloResponse({
    subject: 'subject-id',
    objectId: 'object-id',
    tenantId: 'tenant-id',
  });

  assert.deepEqual(response, {
    message: 'Hello, Martin',
    authenticated: true,
    user: {
      subject: 'subject-id',
      objectId: 'object-id',
      tenantId: 'tenant-id',
    },
  });
});
