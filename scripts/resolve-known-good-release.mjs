#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const DIRECT_WORKFLOW_PATH = '.github/workflows/delivery-v2.yml';
const LEGACY_WORKFLOW_PATH = '.github/workflows/promote-production.yml';

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

export function selectKnownGoodRelease({ artifacts, runs, repository, sourceRef, currentRunId }) {
  if (!Array.isArray(artifacts)) throw new Error('artifacts must be an array');
  if (!Array.isArray(runs)) throw new Error('runs must be an array');
  if (!REPOSITORY_PATTERN.test(repository ?? '')) throw new Error('repository must use owner/name format');
  assertSha(sourceRef, 'sourceRef');
  const currentId = positiveInteger(currentRunId, 'currentRunId');
  const runsById = new Map(runs.map((run) => [positiveInteger(run?.id, 'run.id'), run]));
  const groups = new Map();

  for (const artifact of artifacts) {
    const identity = parseArtifactIdentity(artifact);
    if (!identity || identity.sourceRef !== sourceRef || identity.runId === currentId) continue;
    const key = `${identity.runId}:${identity.sourceRef}:${identity.correlation}`;
    const group = groups.get(key) ?? { ...identity, releaseArtifacts: [], ledgerArtifacts: [] };
    group[identity.kind === 'release' ? 'releaseArtifacts' : 'ledgerArtifacts'].push(artifact);
    groups.set(key, group);
  }

  const candidates = [];
  for (const group of groups.values()) {
    if (group.releaseArtifacts.length !== 1 || group.ledgerArtifacts.length !== 1) continue;
    const run = runsById.get(group.runId);
    if (!isTrustedSuccessfulRun(run, repository, group.sourceRef, group.correlation)) continue;
    candidates.push({
      sourceRef: group.sourceRef,
      correlation: group.correlation,
      runId: group.runId,
      runCreatedAt: run.created_at,
      releaseArtifactId: group.releaseArtifacts[0].id,
      ledgerArtifactId: group.ledgerArtifacts[0].id,
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

function isTrustedSuccessfulRun(run, repository, sourceRef, correlation) {
  if (
    run === null ||
    typeof run !== 'object' ||
    run.repository?.full_name !== repository ||
    run.conclusion !== 'success' ||
    run.head_branch !== 'main' ||
    run.head_sha !== sourceRef ||
    run.run_attempt !== 1 ||
    !Number.isFinite(Date.parse(run.created_at ?? ''))
  ) {
    return false;
  }
  if (run.path === DIRECT_WORKFLOW_PATH) {
    return ['push', 'workflow_dispatch'].includes(run.event) && run.display_title === `Delivery v2 ${sourceRef}`;
  }
  return (
    run.path === LEGACY_WORKFLOW_PATH &&
    ['repository_dispatch', 'workflow_dispatch'].includes(run.event) &&
    run.display_title === `Promote Production ${sourceRef} ${correlation}`
  );
}

async function resolveFromGitHub({ artifacts, repository, sourceRef, currentRunId, run = execFileAsync }) {
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
  return selectKnownGoodRelease({ artifacts, runs, repository, sourceRef, currentRunId });
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

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = new Map();
  for (let index = 2; index < process.argv.length; index += 2) {
    args.set(process.argv[index], process.argv[index + 1]);
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
