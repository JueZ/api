#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { lstat, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const workflowPath = '.github/workflows/delivery-v2.yml';
const shaPattern = /^[0-9a-f]{40}$/;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const correlationPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;

export async function resolveRecoveryContext(
  { failedRunId, repository, currentRunId, controllerRef },
  dependencies = {},
) {
  const failedRun = positiveInteger(failedRunId, 'failedRunId');
  const currentRun = positiveInteger(currentRunId, 'currentRunId');
  if (failedRun === currentRun) throw new Error('failedRunId must identify a prior workflow run');
  if (!repositoryPattern.test(repository ?? '')) throw new Error('repository must use owner/name format');
  assertSha(controllerRef, 'controllerRef');

  const getRun = dependencies.getRun ?? defaultGetRun;
  const listArtifacts = dependencies.listArtifacts ?? defaultListArtifacts;
  const isAncestor = dependencies.isAncestor ?? defaultIsAncestor;
  const downloadBaseline = dependencies.downloadBaseline ?? defaultDownloadBaseline;

  const run = await getRun({ repository, runId: failedRun });
  const failedControllerRef = validateFailedDeliveryRun(run, { failedRun, repository });
  if (!(await isAncestor({ ancestor: failedControllerRef, descendant: controllerRef }))) {
    throw new Error('Failed Delivery v2 controller is not an ancestor of the current recovery controller');
  }

  const artifacts = await listArtifacts({ repository, runId: failedRun });
  const selected = selectRecoveryArtifacts({ artifacts, failedRun, failedControllerRef });
  const baseline = await downloadBaseline({
    repository,
    runId: failedRun,
    artifactName: selected.baselineArtifact,
  });
  const accepted = validateAcceptedBaseline(baseline);

  return {
    acceptedSourceRef: accepted.sourceRef,
    acceptedReleaseRunId: accepted.runId,
    acceptedReleaseCorrelation: accepted.correlation,
    acceptedLedgerRunId: accepted.acceptanceRunId,
    acceptedLedgerCorrelation: accepted.acceptanceCorrelation,
    acceptedBaselineArtifact: selected.baselineArtifact,
    failedMutationArtifact: selected.failedMutationArtifact,
    evidenceRunId: String(failedRun),
    failedControllerRef,
  };
}

export function validateFailedDeliveryRun(run, { failedRun, repository }) {
  if (
    !run ||
    typeof run !== 'object' ||
    Number(run.id) !== failedRun ||
    run.repository?.full_name !== repository ||
    run.status !== 'completed' ||
    run.conclusion !== 'failure' ||
    run.head_branch !== 'main' ||
    run.run_attempt !== 1 ||
    run.path !== workflowPath ||
    !['push', 'workflow_dispatch'].includes(run.event) ||
    !shaPattern.test(run.head_sha ?? '') ||
    run.display_title !== `Delivery v2 ${run.head_sha}`
  ) {
    throw new Error('Failed run is not a trusted first-attempt Delivery v2 main run');
  }
  return run.head_sha;
}

export function selectRecoveryArtifacts({ artifacts, failedRun, failedControllerRef }) {
  if (!Array.isArray(artifacts)) throw new Error('GitHub artifact response must be an array');
  const baselineName = `accepted-production-baseline-${failedControllerRef}-${failedRun}`;
  const correlation = `prod-${failedRun}-1`;
  const mutationNames = [
    `production-mutation-${correlation}`,
    `production-mutation-prepared-${correlation}`,
    `production-mutation-intent-${correlation}`,
  ];

  const baselineArtifact = uniqueAvailableArtifact(artifacts, baselineName, failedRun);
  let failedMutationArtifact = null;
  for (const name of mutationNames) {
    const matches = exactArtifacts(artifacts, name, failedRun);
    if (matches.length > 1) throw new Error(`Recovery artifact is duplicated: ${name}`);
    if (matches.length === 1 && matches[0].expired !== true) {
      failedMutationArtifact = name;
      break;
    }
  }
  if (!failedMutationArtifact) {
    throw new Error('No non-expired failed production mutation artifact exists for the exact failed run');
  }
  return { baselineArtifact: baselineArtifact.name, failedMutationArtifact };
}

export function validateAcceptedBaseline(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.status !== 'accepted') {
    throw new Error('Downloaded baseline status must be accepted');
  }
  assertSha(value.sourceRef, 'baseline.sourceRef');
  const runId = positiveInteger(value.runId, 'baseline.runId');
  const acceptanceRunId = positiveInteger(value.acceptanceRunId, 'baseline.acceptanceRunId');
  assertCorrelation(value.correlation, 'baseline.correlation');
  assertCorrelation(value.acceptanceCorrelation, 'baseline.acceptanceCorrelation');
  if (!['promotion', 'recovery'].includes(value.acceptanceKind)) {
    throw new Error('baseline.acceptanceKind must be promotion or recovery');
  }
  const expectedRelease = `production-release-${value.sourceRef}-${value.correlation}`;
  const expectedLedger = `release-ledger-prod-${value.sourceRef}-${value.acceptanceCorrelation}`;
  if (value.releaseArtifactName !== expectedRelease) {
    throw new Error('baseline.releaseArtifactName does not match the accepted bundle identity');
  }
  if (value.ledgerArtifactName !== expectedLedger) {
    throw new Error('baseline.ledgerArtifactName does not match the accepted ledger identity');
  }
  return {
    sourceRef: value.sourceRef,
    runId: String(runId),
    correlation: value.correlation,
    acceptanceRunId: String(acceptanceRunId),
    acceptanceCorrelation: value.acceptanceCorrelation,
  };
}

function uniqueAvailableArtifact(artifacts, name, runId) {
  const matches = exactArtifacts(artifacts, name, runId);
  if (matches.length !== 1) throw new Error(`Recovery artifact must exist exactly once: ${name}`);
  if (matches[0].expired === true) throw new Error(`Recovery artifact is expired: ${name}`);
  return matches[0];
}

function exactArtifacts(artifacts, name, runId) {
  return artifacts.filter(
    (artifact) =>
      artifact &&
      typeof artifact === 'object' &&
      artifact.name === name &&
      Number.isSafeInteger(artifact.id) &&
      artifact.id > 0 &&
      Number(artifact.workflow_run?.id) === runId,
  );
}

async function defaultGetRun({ repository, runId }) {
  const { stdout } = await execFileAsync('gh', ['api', `repos/${repository}/actions/runs/${runId}`], commandOptions());
  return JSON.parse(stdout);
}

async function defaultListArtifacts({ repository, runId }) {
  const { stdout } = await execFileAsync(
    'gh',
    ['api', '--paginate', '--slurp', `repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`],
    commandOptions(),
  );
  const pages = JSON.parse(stdout);
  return pages.flatMap((page) => page.artifacts ?? []);
}

async function defaultIsAncestor({ ancestor, descendant }) {
  try {
    await execFileAsync('git', ['merge-base', '--is-ancestor', ancestor, descendant], commandOptions());
    return true;
  } catch (error) {
    if (error?.code === 1) return false;
    throw error;
  }
}

async function defaultDownloadBaseline({ repository, runId, artifactName }) {
  const directory = await mkdtemp(join(tmpdir(), 'delivery-recovery-context-'));
  try {
    await execFileAsync(
      'gh',
      ['run', 'download', String(runId), '--repo', repository, '--name', artifactName, '--dir', directory],
      commandOptions(),
    );
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.length !== 1 || entries[0].name !== 'accepted-baseline.json' || !entries[0].isFile()) {
      throw new Error('Downloaded baseline artifact must contain exactly accepted-baseline.json');
    }
    const path = join(directory, entries[0].name);
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error('Downloaded baseline document must be a regular file');
    }
    return JSON.parse(await readFile(path, 'utf8'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function commandOptions() {
  return { env: process.env, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 };
}

function parseArgs(argv) {
  if (argv.length % 2 !== 0) throw new Error('Every CLI option requires a value');
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    if (args.has(argv[index])) throw new Error(`CLI option is duplicated: ${argv[index]}`);
    args.set(argv[index], argv[index + 1]);
  }
  for (const key of ['--failed-run', '--repository', '--current-run', '--controller', '--output']) {
    if (!args.get(key)) throw new Error(`Missing required option: ${key}`);
  }
  return args;
}

function writeOutputs(values, outputPath) {
  appendFileSync(
    outputPath,
    `${Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n')}\n`,
  );
}

function positiveInteger(value, name) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function assertSha(value, name) {
  if (!shaPattern.test(value ?? '')) throw new Error(`${name} must be a full lowercase commit SHA`);
}

function assertCorrelation(value, name) {
  if (!correlationPattern.test(value ?? '')) {
    throw new Error(`${name} must be an opaque 8-128 character identifier`);
  }
}

async function runCli() {
  const args = parseArgs(process.argv.slice(2));
  const result = await resolveRecoveryContext({
    failedRunId: args.get('--failed-run'),
    repository: args.get('--repository'),
    currentRunId: args.get('--current-run'),
    controllerRef: args.get('--controller'),
  });
  writeOutputs(result, args.get('--output'));
  process.stdout.write(
    `${JSON.stringify({ evidenceRunId: result.evidenceRunId, failedControllerRef: result.failedControllerRef })}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
