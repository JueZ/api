import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveRecoveryContext,
  selectRecoveryArtifacts,
  validateAcceptedBaseline,
} from '../resolve-recovery-context.mjs';

const repository = 'JueZ/api';
const failedRun = 34042707608;
const currentRun = 34050000000;
const failedSha = 'b'.repeat(40);
const controllerSha = 'c'.repeat(40);
const acceptedSha = 'a'.repeat(40);
const failedCorrelation = `prod-${failedRun}-1`;
const baselineName = `accepted-production-baseline-${failedSha}-${failedRun}`;

function run(overrides = {}) {
  return {
    id: failedRun,
    repository: { full_name: repository },
    status: 'completed',
    conclusion: 'failure',
    head_branch: 'main',
    head_sha: failedSha,
    run_attempt: 1,
    path: '.github/workflows/delivery-v2.yml',
    event: 'push',
    display_title: `Delivery v2 ${failedSha}`,
    ...overrides,
  };
}

function artifact(id, name, overrides = {}) {
  return {
    id,
    name,
    expired: false,
    workflow_run: { id: failedRun },
    ...overrides,
  };
}

function baseline(overrides = {}) {
  const correlation = 'prod-34040400398-1';
  return {
    schemaVersion: 1,
    status: 'accepted',
    sourceRef: acceptedSha,
    runId: '34040400398',
    correlation,
    acceptanceRunId: '34040400398',
    acceptanceCorrelation: correlation,
    acceptanceKind: 'promotion',
    releaseArtifactName: `production-release-${acceptedSha}-${correlation}`,
    ledgerArtifactName: `release-ledger-prod-${acceptedSha}-${correlation}`,
    ...overrides,
  };
}

function artifacts(mutationName = `production-mutation-${failedCorrelation}`) {
  return [artifact(1, baselineName), artifact(2, mutationName)];
}

function dependencies(overrides = {}) {
  const calls = [];
  return {
    calls,
    value: {
      getRun: async (input) => {
        calls.push(['getRun', input]);
        return run();
      },
      listArtifacts: async (input) => {
        calls.push(['listArtifacts', input]);
        return artifacts();
      },
      isAncestor: async (input) => {
        calls.push(['isAncestor', input]);
        return true;
      },
      downloadBaseline: async (input) => {
        calls.push(['downloadBaseline', input]);
        return baseline();
      },
      ...overrides,
    },
  };
}

test('resolves only the exact failed run baseline and highest-priority mutation evidence', async () => {
  const deps = dependencies({
    listArtifacts: async () => [
      artifact(1, baselineName),
      artifact(2, `production-mutation-intent-${failedCorrelation}`),
      artifact(3, `production-mutation-prepared-${failedCorrelation}`),
      artifact(4, `production-mutation-${failedCorrelation}`),
      artifact(5, `production-mutation-prod-${failedRun - 1}-1`),
    ],
  });
  const result = await resolveRecoveryContext(
    { failedRunId: failedRun, repository, currentRunId: currentRun, controllerRef: controllerSha },
    deps.value,
  );
  assert.deepEqual(result, {
    acceptedSourceRef: acceptedSha,
    acceptedReleaseRunId: '34040400398',
    acceptedReleaseCorrelation: 'prod-34040400398-1',
    acceptedLedgerRunId: '34040400398',
    acceptedLedgerCorrelation: 'prod-34040400398-1',
    acceptedBaselineArtifact: baselineName,
    failedMutationArtifact: `production-mutation-${failedCorrelation}`,
    evidenceRunId: String(failedRun),
    failedControllerRef: failedSha,
  });
  assert.ok(
    deps.calls.some(
      ([name, input]) => name === 'isAncestor' && input.ancestor === failedSha && input.descendant === controllerSha,
    ),
  );
});

test('rejects wrong workflow, display title, branch, attempt, and conclusion', async () => {
  for (const replacement of [
    { path: '.github/workflows/other.yml' },
    { display_title: 'Delivery v2 forged' },
    { head_branch: 'feature' },
    { run_attempt: 2 },
    { conclusion: 'success' },
  ]) {
    const deps = dependencies({ getRun: async () => run(replacement) });
    await assert.rejects(
      resolveRecoveryContext(
        { failedRunId: failedRun, repository, currentRunId: currentRun, controllerRef: controllerSha },
        deps.value,
      ),
      /trusted first-attempt Delivery v2 main run/,
    );
  }
});

test('rejects a failed controller outside the current controller ancestry', async () => {
  const deps = dependencies({ isAncestor: async () => false });
  await assert.rejects(
    resolveRecoveryContext(
      { failedRunId: failedRun, repository, currentRunId: currentRun, controllerRef: controllerSha },
      deps.value,
    ),
    /not an ancestor/,
  );
});

test('rejects expired or missing exact baseline and mutation evidence', () => {
  for (const fixture of [
    [artifact(1, baselineName, { expired: true }), artifact(2, `production-mutation-${failedCorrelation}`)],
    [artifact(2, `production-mutation-${failedCorrelation}`)],
    [artifact(1, baselineName), artifact(2, `production-mutation-${failedCorrelation}`, { expired: true })],
    [artifact(1, baselineName)],
  ]) {
    assert.throws(
      () => selectRecoveryArtifacts({ artifacts: fixture, failedRun, failedControllerRef: failedSha }),
      /expired|exactly once|No non-expired/,
    );
  }
});

test('rejects duplicate exact baseline or mutation artifacts', () => {
  for (const fixture of [
    [artifact(1, baselineName), artifact(2, baselineName), artifact(3, `production-mutation-${failedCorrelation}`)],
    [
      artifact(1, baselineName),
      artifact(2, `production-mutation-${failedCorrelation}`),
      artifact(3, `production-mutation-${failedCorrelation}`),
    ],
  ]) {
    assert.throws(
      () => selectRecoveryArtifacts({ artifacts: fixture, failedRun, failedControllerRef: failedSha }),
      /exactly once|duplicated/,
    );
  }
});

test('accepts prepared then intent fallback but never global or differently correlated names', () => {
  assert.equal(
    selectRecoveryArtifacts({
      artifacts: artifacts(`production-mutation-prepared-${failedCorrelation}`),
      failedRun,
      failedControllerRef: failedSha,
    }).failedMutationArtifact,
    `production-mutation-prepared-${failedCorrelation}`,
  );
  assert.equal(
    selectRecoveryArtifacts({
      artifacts: artifacts(`production-mutation-intent-${failedCorrelation}`),
      failedRun,
      failedControllerRef: failedSha,
    }).failedMutationArtifact,
    `production-mutation-intent-${failedCorrelation}`,
  );
  assert.throws(
    () =>
      selectRecoveryArtifacts({
        artifacts: [artifact(1, baselineName), artifact(2, 'production-mutation-latest')],
        failedRun,
        failedControllerRef: failedSha,
      }),
    /No non-expired/,
  );
});

test('validates untrusted baseline status, correlations, and exact artifact names before output', () => {
  assert.deepEqual(validateAcceptedBaseline(baseline()), {
    sourceRef: acceptedSha,
    runId: '34040400398',
    correlation: 'prod-34040400398-1',
    acceptanceRunId: '34040400398',
    acceptanceCorrelation: 'prod-34040400398-1',
  });
  for (const value of [
    baseline({ status: 'incomplete' }),
    baseline({ sourceRef: 'not-a-sha' }),
    baseline({ acceptanceCorrelation: 'bad' }),
    baseline({ releaseArtifactName: 'production-release-latest' }),
    baseline({ ledgerArtifactName: 'release-ledger-prod-latest' }),
  ]) {
    assert.throws(() => validateAcceptedBaseline(value));
  }
});
