import assert from 'node:assert/strict';
import test from 'node:test';
import { createHealthResponse, createHelloResponse } from '../dist/shared/responses.js';

test('createHealthResponse returns the public health payload', () => {
  const response = createHealthResponse(new Date('2026-05-13T00:00:00.000Z'), {
    DEPLOYED_ENVIRONMENT_NAME: 'test',
    DEPLOYED_COMMIT_SHA: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    DEPLOYED_SOURCE_REF: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    DEPLOYMENT_RUN_ID: '12345',
    DEPLOYED_AT_UTC: '2026-05-12T23:59:00Z',
    BUILD_TIMESTAMP_UTC: '2026-05-12T23:58:00Z',
  });

  assert.deepEqual(response, {
    status: 'ok',
    service: 'api-catalogue',
    timestamp: '2026-05-13T00:00:00.000Z',
    environmentName: 'test',
    deployedCommitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    deployedSourceRef: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    deploymentRunId: '12345',
    deployedAtUtc: '2026-05-12T23:59:00.000Z',
    buildTimestampUtc: '2026-05-12T23:58:00.000Z',
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
