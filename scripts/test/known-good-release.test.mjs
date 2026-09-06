import assert from 'node:assert/strict';
import test from 'node:test';
import {
  candidateRunIdsForSource,
  classifyProductionFailureState,
  selectInstalledAcceptedRelease,
  selectKnownGoodRelease,
} from '../resolve-known-good-release.mjs';

const failedSource = 'b'.repeat(40);
const previousSource = 'a'.repeat(40);
const repository = 'JueZ/api';

function artifact(id, name, runId, extra = {}) {
  return { id, name, expired: false, workflow_run: { id: runId }, ...extra };
}

function directRun(id, createdAt = '2026-08-10T10:00:00Z', extra = {}) {
  return {
    id,
    repository: { full_name: repository },
    conclusion: 'success',
    head_branch: 'main',
    head_sha: previousSource,
    run_attempt: 1,
    created_at: createdAt,
    path: '.github/workflows/delivery-v2.yml',
    event: 'push',
    display_title: `Delivery v2 ${previousSource}`,
    ...extra,
  };
}

function releasePair(runId, correlation, firstId = runId * 10) {
  return [
    artifact(firstId, `production-release-${previousSource}-${correlation}`, runId),
    artifact(firstId + 1, `release-ledger-prod-${previousSource}-${correlation}`, runId),
  ];
}

test('production recovery distinguishes mutation, no mutation, and unsafe ambiguity', () => {
  assert.deepEqual(
    classifyProductionFailureState({
      failedSourceRef: failedSource,
      previousSourceRef: previousSource,
      observedSourceRef: failedSource,
    }),
    { rollbackRequired: true, state: 'failed-release-observed' },
  );
  assert.deepEqual(
    classifyProductionFailureState({
      failedSourceRef: failedSource,
      previousSourceRef: previousSource,
      observedSourceRef: previousSource,
    }),
    { rollbackRequired: false, state: 'production-unchanged' },
  );
  assert.throws(
    () =>
      classifyProductionFailureState({
        failedSourceRef: failedSource,
        previousSourceRef: previousSource,
        observedSourceRef: 'c'.repeat(40),
      }),
    /refusing an ambiguous rollback/,
  );
});

test('known-good selection requires one complete trusted pair and chooses the latest accepted run', () => {
  const artifacts = [...releasePair(10, 'prod-10-1'), ...releasePair(20, 'prod-20-1', 300)];
  assert.deepEqual(candidateRunIdsForSource(artifacts, previousSource, 99), [20, 10]);
  assert.deepEqual(
    selectKnownGoodRelease({
      artifacts,
      runs: [directRun(10, '2026-08-10T09:00:00Z'), directRun(20, '2026-08-10T10:00:00Z')],
      repository,
      sourceRef: previousSource,
      currentRunId: 99,
    }),
    {
      sourceRef: previousSource,
      correlation: 'prod-20-1',
      runId: 20,
      runCreatedAt: '2026-08-10T10:00:00Z',
      releaseArtifactId: 300,
      ledgerArtifactId: 301,
      releaseArtifactName: `production-release-${previousSource}-prod-20-1`,
      ledgerArtifactName: `release-ledger-prod-${previousSource}-prod-20-1`,
      workflowPath: '.github/workflows/delivery-v2.yml',
    },
  );
});

test('accepted baseline selection binds the installed run instead of choosing another release of the same source', () => {
  const artifacts = [...releasePair(10, 'prod-10-1'), ...releasePair(20, 'prod-20-1', 300)];
  const selected = selectKnownGoodRelease({
    artifacts,
    runs: [directRun(10, '2026-08-10T09:00:00Z'), directRun(20, '2026-08-10T10:00:00Z')],
    repository,
    sourceRef: previousSource,
    currentRunId: 99,
    requiredRunId: 10,
  });
  assert.equal(selected.runId, 10);
  assert.equal(selected.correlation, 'prod-10-1');
});

test('verified recovery uses the original successful bundle and a separate successful rollback receipt', () => {
  const bundleRun = directRun(10);
  const recoveryRun = directRun(20, '2026-08-10T11:00:00Z', {
    conclusion: 'failure',
    head_sha: failedSource,
    display_title: `Delivery v2 ${failedSource}`,
  });
  const artifacts = [
    artifact(100, `production-release-${previousSource}-prod-10-1`, 10),
    artifact(201, `release-ledger-prod-${previousSource}-rollback-20-1`, 20),
  ];
  const selected = selectInstalledAcceptedRelease({
    artifacts,
    runs: [bundleRun, recoveryRun],
    jobsByRun: { 20: [{ name: 'rollback production / deploy prod', conclusion: 'success' }] },
    repository,
    installedIdentity: {
      sourceRef: previousSource,
      runId: '10',
      deliveryCorrelation: 'prod-10-1',
      mutationReceipt: {
        recorded: true,
        runId: '20',
        correlation: 'rollback-20-1',
        controllerRef: failedSource,
        kind: 'recovery',
      },
    },
    currentRunId: 99,
  });
  assert.equal(selected.runId, 10);
  assert.equal(selected.correlation, 'prod-10-1');
  assert.equal(selected.acceptanceRunId, 20);
  assert.equal(selected.acceptanceCorrelation, 'rollback-20-1');
  assert.equal(selected.acceptanceKind, 'recovery');
});

test('failed rollback job cannot make restored original bytes an accepted baseline', () => {
  const artifacts = [
    artifact(100, `production-release-${previousSource}-prod-10-1`, 10),
    artifact(201, `release-ledger-prod-${previousSource}-rollback-20-1`, 20),
  ];
  const installedIdentity = {
    sourceRef: previousSource,
    runId: '10',
    deliveryCorrelation: 'prod-10-1',
    mutationReceipt: {
      recorded: true,
      runId: '20',
      correlation: 'rollback-20-1',
      controllerRef: failedSource,
      kind: 'recovery',
    },
  };
  assert.throws(
    () =>
      selectInstalledAcceptedRelease({
        artifacts,
        runs: [
          directRun(10),
          directRun(20, '2026-08-10T11:00:00Z', {
            conclusion: 'failure',
            head_sha: failedSource,
            display_title: `Delivery v2 ${failedSource}`,
          }),
        ],
        jobsByRun: { 20: [{ name: 'rollback production / deploy prod', conclusion: 'failure' }] },
        repository,
        installedIdentity,
        currentRunId: 99,
      }),
    /successful rollback production job/,
  );
});

test('removed legacy delivery workflows cannot be selected as known-good recovery evidence', () => {
  const artifacts = releasePair(30, 'legacy-prod-1');
  const run = directRun(30, '2026-08-09T10:00:00Z', {
    path: '.github/workflows/legacy-delivery.yml',
    event: 'repository_dispatch',
    display_title: `Legacy Delivery ${previousSource} legacy-prod-1`,
  });
  assert.throws(
    () => selectKnownGoodRelease({ artifacts, runs: [run], repository, sourceRef: previousSource, currentRunId: 99 }),
    /No complete trusted known-good production artifact/,
  );
});

test('expired, unpaired, failed, wrong-source, current-run, and duplicate evidence fail closed', () => {
  const correlation = 'prod-safe-1';
  const pair = releasePair(40, correlation);
  const invalidSets = [
    [pair[0]],
    [{ ...pair[0], expired: true }, pair[1]],
    pair.map((item) => ({ ...item, workflow_run: { id: 99 } })),
    pair.map((item) => ({ ...item, name: item.name.replace(previousSource, failedSource) })),
    [pair[0], { ...pair[0], id: 999 }, pair[1]],
  ];
  for (const artifacts of invalidSets) {
    assert.throws(
      () =>
        selectKnownGoodRelease({
          artifacts,
          runs: [directRun(40), directRun(99)],
          repository,
          sourceRef: previousSource,
          currentRunId: 99,
        }),
      /No complete trusted known-good production artifact/,
    );
  }
  assert.throws(
    () =>
      selectKnownGoodRelease({
        artifacts: pair,
        runs: [directRun(40, undefined, { conclusion: 'failure' })],
        repository,
        sourceRef: previousSource,
        currentRunId: 99,
      }),
    /No complete trusted known-good production artifact/,
  );
});

test('equal-time accepted runs are treated as ambiguous rather than guessed', () => {
  assert.throws(
    () =>
      selectKnownGoodRelease({
        artifacts: [...releasePair(50, 'prod-50-1'), ...releasePair(60, 'prod-60-1', 700)],
        runs: [directRun(50), directRun(60)],
        repository,
        sourceRef: previousSource,
        currentRunId: 99,
      }),
    /selection is ambiguous/,
  );
});
