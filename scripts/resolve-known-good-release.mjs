#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const DIRECT_WORKFLOW_PATH = '.github/workflows/delivery-v2.yml';

export function classifyProductionFailureState({ failedSourceRef, previousSourceRef, observedSourceRef }) {
  for (const [name, value] of Object.entries({ failedSourceRef, previousSourceRef, observedSourceRef })) {
    if (!SHA_PATTERN.test(value ?? '')) throw new Error(`${name} must be a full lowercase commit SHA`);
  }
  if (failedSourceRef === previousSourceRef) {
    throw new Error('The failed and previous production sources must be different.');
  }
  if (observedSourceRef === failedSourceRef) {
    return { rollbackRequired: true, state: 'failed-release-observed' };
  }
  if (observedSourceRef === previousSourceRef) {
    return { rollbackRequired: false, state: 'production-unchanged' };
  }
  throw new Error(
    `Production reports unexpected source ${observedSourceRef}; refusing an ambiguous rollback between ${previousSourceRef} and ${failedSourceRef}.`,
  );
}

export function candidateRunIdsForSource(artifacts, sourceRef, currentRunId) {
  if (!Array.isArray(artifacts)) throw new Error('artifacts must be an array');
  assertSha(sourceRef, 'sourceRef');
  const currentId = positiveInteger(currentRunId, 'currentRunId');
  const ids = new Set();
  for (const artifact of artifacts) {
    const identity = parseArtifactIdentity(artifact);
    if (identity && identity.sourceRef === sourceRef && identity.runId !== currentId) ids.add(identity.runId);
  }
  return [...ids].sort((left, right) => right - left);
}

export function selectKnownGoodRelease({ artifacts, runs, repository, sourceRef, currentRunId, requiredRunId = '' }) {
  if (!Array.isArray(artifacts)) throw new Error('artifacts must be an array');
  if (!Array.isArray(runs)) throw new Error('runs must be an array');
  if (!REPOSITORY_PATTERN.test(repository ?? '')) throw new Error('repository must use owner/name format');
  assertSha(sourceRef, 'sourceRef');
  const currentId = positiveInteger(currentRunId, 'currentRunId');
  const requiredId = requiredRunId === '' ? null : positiveInteger(requiredRunId, 'requiredRunId');
  const runsById = new Map(runs.map((run) => [positiveInteger(run?.id, 'run.id'), run]));
  const groups = new Map();

  for (const artifact of artifacts) {
    const identity = parseArtifactIdentity(artifact);
    if (
      !identity ||
      identity.sourceRef !== sourceRef ||
      identity.runId === currentId ||
      (requiredId !== null && identity.runId !== requiredId)
    )
      continue;
    const key = `${identity.runId}:${identity.sourceRef}:${identity.correlation}`;
    const group = groups.get(key) ?? { ...identity, releaseArtifacts: [], ledgerArtifacts: [] };
    group[identity.kind === 'release' ? 'releaseArtifacts' : 'ledgerArtifacts'].push(artifact);
    groups.set(key, group);
  }

  const candidates = [];
  for (const group of groups.values()) {
    if (group.releaseArtifacts.length !== 1 || group.ledgerArtifacts.length !== 1) continue;
    const run = runsById.get(group.runId);
    if (!isTrustedSuccessfulRun(run, repository, group.sourceRef)) continue;
    candidates.push({
      sourceRef: group.sourceRef,
      correlation: group.correlation,
      runId: group.runId,
      runCreatedAt: run.created_at,
      releaseArtifactId: group.releaseArtifacts[0].id,
      ledgerArtifactId: group.ledgerArtifacts[0].id,
      releaseArtifactName: group.releaseArtifacts[0].name,
      ledgerArtifactName: group.ledgerArtifacts[0].name,
      workflowPath: run.path,
    });
  }

  candidates.sort((left, right) => {
    const time = Date.parse(right.runCreatedAt) - Date.parse(left.runCreatedAt);
    return time || right.runId - left.runId;
  });
  if (candidates.length === 0) {
    throw new Error(`No complete trusted known-good production artifact exists for ${sourceRef}.`);
  }
  if (
    candidates.length > 1 &&
    Date.parse(candidates[0].runCreatedAt) === Date.parse(candidates[1].runCreatedAt) &&
    candidates[0].runId !== candidates[1].runId
  ) {
    throw new Error(`Known-good production artifact selection is ambiguous for ${sourceRef}.`);
  }
  return candidates[0];
}

export function selectInstalledAcceptedRelease({
  artifacts,
  runs,
  jobsByRun = {},
  repository,
  installedIdentity,
  currentRunId,
}) {
  if (!Array.isArray(artifacts)) throw new Error('artifacts must be an array');
  if (!Array.isArray(runs)) throw new Error('runs must be an array');
  if (!REPOSITORY_PATTERN.test(repository ?? '')) throw new Error('repository must use owner/name format');
  const sourceRef = installedIdentity?.sourceRef;
  const bundleRunId = positiveInteger(installedIdentity?.runId, 'installedIdentity.runId');
  let bundleCorrelation = String(installedIdentity?.deliveryCorrelation ?? '');
  assertSha(sourceRef, 'installedIdentity.sourceRef');
  if (!bundleCorrelation) {
    const correlations = new Set();
    const identities = artifacts.map(parseArtifactIdentity).filter(Boolean);
    for (const identity of identities) {
      if (identity.sourceRef !== sourceRef || identity.runId !== bundleRunId || identity.kind !== 'release') continue;
      if (
        identities.some(
          (candidate) =>
            candidate.kind === 'ledger' &&
            candidate.sourceRef === sourceRef &&
            candidate.runId === bundleRunId &&
            candidate.correlation === identity.correlation,
        )
      ) {
        correlations.add(identity.correlation);
      }
    }
    if (correlations.size !== 1) {
      throw new Error('Legacy installed production identity does not resolve to one exact artifact correlation.');
    }
    [bundleCorrelation] = correlations;
  }
  assertCorrelation(bundleCorrelation, 'installedIdentity.deliveryCorrelation');
  const observedReceipt = installedIdentity?.mutationReceipt;
  const receipt =
    !observedReceipt || observedReceipt.recorded === false
      ? {
          ...(observedReceipt ?? {}),
          recorded: false,
          runId: bundleRunId,
          correlation: bundleCorrelation,
          controllerRef: sourceRef,
          kind: 'legacy-release',
        }
      : observedReceipt;
  const acceptanceRunId = positiveInteger(receipt.runId, 'installedIdentity.mutationReceipt.runId');
  const acceptanceCorrelation = String(receipt.correlation ?? '');
  assertCorrelation(acceptanceCorrelation, 'installedIdentity.mutationReceipt.correlation');
  assertSha(receipt.controllerRef, 'installedIdentity.mutationReceipt.controllerRef');
  positiveInteger(currentRunId, 'currentRunId');

  const releaseArtifacts = artifacts.filter((artifact) => {
    const identity = parseArtifactIdentity(artifact);
    return (
      identity?.kind === 'release' &&
      identity.sourceRef === sourceRef &&
      identity.runId === bundleRunId &&
      identity.correlation === bundleCorrelation
    );
  });
  const ledgerArtifacts = artifacts.filter((artifact) => {
    const identity = parseArtifactIdentity(artifact);
    return (
      identity?.kind === 'ledger' &&
      identity.sourceRef === sourceRef &&
      identity.runId === acceptanceRunId &&
      identity.correlation === acceptanceCorrelation
    );
  });
  if (releaseArtifacts.length !== 1 || ledgerArtifacts.length !== 1) {
    throw new Error(`Installed production identity lacks one exact release and acceptance-ledger artifact pair.`);
  }

  const runsById = new Map(runs.map((run) => [positiveInteger(run?.id, 'run.id'), run]));
  const bundleRun = runsById.get(bundleRunId);
  if (!isTrustedSuccessfulRun(bundleRun, repository, sourceRef)) {
    throw new Error('Original installed production bundle is not backed by a trusted successful first-attempt run.');
  }

  const recovery =
    receipt.recorded === true &&
    (acceptanceRunId !== bundleRunId || acceptanceCorrelation !== bundleCorrelation || receipt.kind === 'recovery');
  if (recovery) {
    const acceptanceRun = runsById.get(acceptanceRunId);
    if (receipt.kind !== 'recovery' || !isTrustedDeliveryRun(acceptanceRun, repository, receipt.controllerRef)) {
      throw new Error('Installed recovery receipt is not backed by a trusted first-attempt Delivery v2 run.');
    }
    const jobs = jobsByRun[acceptanceRunId] ?? jobsByRun[String(acceptanceRunId)] ?? [];
    const rollbackJobs = jobs.filter((job) => job?.name === 'rollback production / deploy prod');
    if (rollbackJobs.length !== 1 || rollbackJobs[0].conclusion !== 'success') {
      throw new Error('Installed recovery receipt is not backed by one successful rollback production job.');
    }
  } else if (
    acceptanceRunId !== bundleRunId ||
    acceptanceCorrelation !== bundleCorrelation ||
    !['legacy-release', 'promotion'].includes(receipt.kind)
  ) {
    throw new Error('Installed promotion receipt disagrees with the original accepted bundle identity.');
  }

  return {
    sourceRef,
    correlation: bundleCorrelation,
    runId: bundleRunId,
    acceptanceCorrelation,
    acceptanceRunId,
    acceptanceKind: recovery ? 'recovery' : 'promotion',
    releaseArtifactId: releaseArtifacts[0].id,
    ledgerArtifactId: ledgerArtifacts[0].id,
    releaseArtifactName: releaseArtifacts[0].name,
    ledgerArtifactName: ledgerArtifacts[0].name,
    workflowPath: bundleRun.path,
  };
}

function parseArtifactIdentity(artifact) {
  if (
    artifact === null ||
    typeof artifact !== 'object' ||
    artifact.expired === true ||
    !Number.isSafeInteger(artifact.id) ||
    artifact.id <= 0
  ) {
    return null;
  }
  const runId = artifact.workflow_run?.id;
  if (!Number.isSafeInteger(runId) || runId <= 0) return null;
  const match = /^(production-release|release-ledger-prod)-([0-9a-f]{40})-([A-Za-z0-9][A-Za-z0-9._-]{7,127})$/.exec(
    artifact.name ?? '',
  );
  if (!match) return null;
  return {
    kind: match[1] === 'production-release' ? 'release' : 'ledger',
    sourceRef: match[2],
    correlation: match[3],
    runId,
  };
}

function isTrustedSuccessfulRun(run, repository, sourceRef) {
  return isTrustedDeliveryRun(run, repository, sourceRef) && run.conclusion === 'success';
}

function isTrustedDeliveryRun(run, repository, controllerRef) {
  if (
    run === null ||
    typeof run !== 'object' ||
    run.repository?.full_name !== repository ||
    run.head_branch !== 'main' ||
    run.head_sha !== controllerRef ||
    run.run_attempt !== 1 ||
    !Number.isFinite(Date.parse(run.created_at ?? ''))
  ) {
    return false;
  }
  if (run.path === DIRECT_WORKFLOW_PATH) {
    return ['push', 'workflow_dispatch'].includes(run.event) && run.display_title === `Delivery v2 ${controllerRef}`;
  }
  return false;
}

export async function resolveFromGitHub({
  artifacts,
  repository,
  sourceRef,
  currentRunId,
  requiredRunId = '',
  run = execFileAsync,
}) {
  const runIds = candidateRunIdsForSource(artifacts, sourceRef, currentRunId);
  if (runIds.length === 0) throw new Error(`No retained production artifacts exist for ${sourceRef}.`);
  if (runIds.length > 20)
    throw new Error(`Too many retained production runs exist for ${sourceRef}; refusing ambiguity.`);
  const runs = await Promise.all(
    runIds.map(async (runId) => {
      const { stdout } = await run('gh', ['api', `repos/${repository}/actions/runs/${runId}`], {
        env: process.env,
        timeout: 30_000,
        maxBuffer: 2 * 1024 * 1024,
      });
      return JSON.parse(stdout);
    }),
  );
  return selectKnownGoodRelease({ artifacts, runs, repository, sourceRef, currentRunId, requiredRunId });
}

export async function resolveInstalledFromGitHub({
  artifacts,
  repository,
  installedIdentity,
  currentRunId,
  run = execFileAsync,
}) {
  const runIds = [...new Set([installedIdentity?.runId, installedIdentity?.mutationReceipt?.runId])].map((value) =>
    positiveInteger(value, 'installed run ID'),
  );
  if (runIds.includes(positiveInteger(currentRunId, 'currentRunId'))) {
    throw new Error('Current workflow run cannot supply an already accepted production identity.');
  }
  const runs = [];
  const jobsByRun = {};
  for (const runId of runIds) {
    const { stdout } = await run('gh', ['api', `repos/${repository}/actions/runs/${runId}`], {
      env: process.env,
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    runs.push(JSON.parse(stdout));
  }
  const receipt = installedIdentity?.mutationReceipt;
  if (receipt?.recorded === true && receipt.kind === 'recovery') {
    const receiptRunId = positiveInteger(receipt.runId, 'installed recovery run ID');
    const { stdout } = await run(
      'gh',
      ['api', '--paginate', `repos/${repository}/actions/runs/${receiptRunId}/jobs`, '--jq', '.jobs'],
      { env: process.env, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
    );
    const pages = stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    jobsByRun[receiptRunId] = pages.flat();
  }
  return selectInstalledAcceptedRelease({
    artifacts,
    runs,
    jobsByRun,
    repository,
    installedIdentity,
    currentRunId,
  });
}

function writeOutputs(values, outputPath) {
  if (!outputPath) return;
  appendFileSync(
    outputPath,
    `${Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n')}\n`,
  );
}

function assertSha(value, name) {
  if (!SHA_PATTERN.test(value ?? '')) throw new Error(`${name} must be a full lowercase commit SHA`);
}

function positiveInteger(value, name) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function assertCorrelation(value, name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(value ?? '')) {
    throw new Error(`${name} must be an opaque 8-128 character identifier`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = new Map();
  for (let index = 2; index < process.argv.length; index += 2) {
    args.set(process.argv[index], process.argv[index + 1]);
  }
  if (args.has('--installed-state')) {
    const observed = JSON.parse(await readFile(args.get('--installed-state'), 'utf8'));
    if (!observed.ok || observed.state !== 'coherent') {
      throw new Error(`Installed production identity is not coherent: ${(observed.errors ?? []).join('; ')}`);
    }
    const artifacts = JSON.parse(await readFile(args.get('--artifacts'), 'utf8'));
    const selected = await resolveInstalledFromGitHub({
      artifacts,
      repository: args.get('--repository'),
      installedIdentity: observed.identity,
      currentRunId: args.get('--current-run'),
    });
    writeOutputs(
      {
        baseline_status: 'selected',
        baseline_source_ref: selected.sourceRef,
        baseline_run_id: selected.runId,
        baseline_correlation: selected.correlation,
        baseline_acceptance_run_id: selected.acceptanceRunId,
        baseline_acceptance_correlation: selected.acceptanceCorrelation,
        baseline_acceptance_kind: selected.acceptanceKind,
        baseline_release_artifact: selected.releaseArtifactName,
        baseline_ledger_artifact: selected.ledgerArtifactName,
      },
      args.get('--output'),
    );
    process.stdout.write(`${JSON.stringify(selected)}\n`);
    process.exit(0);
  }

  const recovery = classifyProductionFailureState({
    failedSourceRef: args.get('--failed-source'),
    previousSourceRef: args.get('--previous-source'),
    observedSourceRef: args.get('--observed-source'),
  });
  if (!recovery.rollbackRequired) {
    writeOutputs({ rollback_required: false, recovery_state: recovery.state }, args.get('--output'));
    process.stdout.write(`${JSON.stringify(recovery)}\n`);
  } else {
    const artifacts = JSON.parse(await readFile(args.get('--artifacts'), 'utf8'));
    const selected = await resolveFromGitHub({
      artifacts,
      repository: args.get('--repository'),
      sourceRef: args.get('--previous-source'),
      currentRunId: args.get('--current-run'),
    });
    writeOutputs(
      {
        rollback_required: true,
        recovery_state: recovery.state,
        rollback_source_ref: selected.sourceRef,
        rollback_run_id: selected.runId,
        rollback_correlation: selected.correlation,
      },
      args.get('--output'),
    );
    process.stdout.write(`${JSON.stringify({ ...recovery, selected })}\n`);
  }
}
