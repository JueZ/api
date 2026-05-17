import assert from 'node:assert/strict';
import test from 'node:test';
import { readRuntimeProvenance } from '../dist/shared/runtimeProvenance.js';
import { sanitizeSmokeRunId } from '../dist/shared/smokeCorrelation.js';

test('readRuntimeProvenance returns safe deployment metadata', () => {
  const response = readRuntimeProvenance({
    DEPLOYED_ENVIRONMENT_NAME: 'prod',
    DEPLOYED_COMMIT_SHA: 'ABCDEFabcdef0123456789abcdef0123456789ab',
    DEPLOYED_SOURCE_REF: '1111111111111111111111111111111111111111',
    DEPLOYMENT_RUN_ID: 'run_123:attempt-1',
    DEPLOYED_AT_UTC: '2026-05-17T12:34:56Z',
    BUILD_TIMESTAMP_UTC: '2026-05-17T12:00:00Z',
  }, new Date('2026-05-17T13:00:00.000Z'));

  assert.deepEqual(response, {
    environmentName: 'prod',
    deployedCommitSha: 'abcdefabcdef0123456789abcdef0123456789ab',
    deployedSourceRef: '1111111111111111111111111111111111111111',
    deploymentRunId: 'run_123:attempt-1',
    deployedAtUtc: '2026-05-17T12:34:56.000Z',
    buildTimestampUtc: '2026-05-17T12:00:00.000Z',
  });
});

test('readRuntimeProvenance falls back to safe local/unknown defaults', () => {
  const response = readRuntimeProvenance({}, new Date('2026-05-17T13:00:00.000Z'));

  assert.equal(response.environmentName, 'local');
  assert.equal(response.deployedCommitSha, 'unknown');
  assert.equal(response.deployedSourceRef, 'unknown');
  assert.equal(response.deploymentRunId, 'unknown');
  assert.equal(response.deployedAtUtc, 'unknown');
  assert.equal(response.buildTimestampUtc, '2026-05-17T13:00:00.000Z');
});

test('sanitizeSmokeRunId strips unsafe characters and truncates', () => {
  const sanitized = sanitizeSmokeRunId(' smoke run/with spaces and !'.repeat(8));

  assert.ok(sanitized);
  assert.equal(sanitized.length, 96);
  assert.match(sanitized, /^[A-Za-z0-9_.:-]+(?:-[A-Za-z0-9_.:-]+)*$/);
});
