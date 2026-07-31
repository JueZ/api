#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { requireUrl, fetchJson, safeSummary } from './lib/smoke-utils.mjs';
import { validateReleaseLedger } from './validate-release-ledger.mjs';

function parseArgs(argv = process.argv.slice(2), env = process.env) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const [rawKey, inline] = token.slice(2).split('=', 2);
    const key = rawKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    args[key] = inline ?? argv[++i] ?? 'true';
  }
  const environment = args.environment || env.ENVIRONMENT_NAME || '';
  return {
    environment,
    apiBaseUrl: args.apiBaseUrl || env.API_BASE_URL || '',
    expectedSha: String(args.expectedSha || env.EXPECTED_DEPLOYED_COMMIT_SHA || '').toLowerCase(),
    repo: args.repo || env.GITHUB_REPOSITORY || 'JueZ/api',
    workflow: args.workflow || (environment === 'prod' ? 'promote-production.yml' : 'deploy-test.yml'),
    runId: args.runId || '',
    includeLedger: String(args.includeLedger ?? 'false').toLowerCase() === 'true',
    artifactDir: args.artifactDir || '',
    json: args.json !== 'false',
  };
}

function ghAvailable(spawn = spawnSync) {
  return spawn('gh', ['--version'], { encoding: 'utf8' }).status === 0;
}

function runGh(args, spawn = spawnSync) {
  const completed = spawn('gh', args, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  if (completed.status !== 0) throw new Error(`gh ${args.join(' ')} failed`);
  return completed.stdout;
}

async function findJsonFile(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await findJsonFile(path);
      if (nested) return nested;
    } else if (entry.name.endsWith('.json')) return path;
  }
  return '';
}

export function summarizeLedger(ledger) {
  return {
    environment: ledger.environment,
    workflowRunId: ledger.workflowRunId,
    deployedCommit: ledger.deployedCommit,
    sourceRef: ledger.sourceRef,
    smokeRunId: ledger.smokeRunId,
    smokeResultsStatus: ledger.smokeResults?.status,
    authenticatedSmokeResultsStatus: ledger.authenticatedSmokeResults?.status,
    telemetryCheckResultStatus: ledger.telemetryCheckResult?.status,
    verifiedAt: ledger.verifiedAt,
  };
}

export function decideRuntimeTruth({ live = {}, ledger = null, options = {}, ledgerErrors = [] }) {
  const failures = [];
  const blockers = [];
  if (live.status === 'blocked') blockers.push(live.blockedReason || 'live runtime check was not configured');
  if (live.status === 'failed') failures.push(live.failureSummary || 'live runtime check failed');
  if (options.environment && live.runtime?.environmentName && live.runtime.environmentName !== options.environment)
    failures.push(`live environmentName expected ${options.environment}, got ${live.runtime.environmentName}`);
  if (
    options.expectedSha &&
    live.runtime?.deployedCommitSha &&
    String(live.runtime.deployedCommitSha).toLowerCase() !== options.expectedSha
  )
    failures.push(`live deployedCommitSha expected ${options.expectedSha}, got ${live.runtime.deployedCommitSha}`);

  if (options.includeLedger) {
    if (!ledger) blockers.push('release ledger artifact was not available');
    if (ledgerErrors.length > 0) failures.push(...ledgerErrors);
    if (ledger) {
      if (options.environment && ledger.environment !== options.environment)
        failures.push(`ledger environment expected ${options.environment}, got ${ledger.environment}`);
      if (options.expectedSha && ledger.deployedCommit !== options.expectedSha)
        failures.push(`ledger deployedCommit expected ${options.expectedSha}, got ${ledger.deployedCommit}`);
      if (
        live.runtime?.deployedCommitSha &&
        ledger.deployedCommit &&
        String(live.runtime.deployedCommitSha).toLowerCase() !== ledger.deployedCommit
      )
        failures.push(
          `live deployedCommitSha ${live.runtime.deployedCommitSha} does not match ledger deployedCommit ${ledger.deployedCommit}`,
        );
      if (ledger.smokeResults?.status !== 'passed')
        failures.push(`ledger smokeResults.status is ${ledger.smokeResults?.status || '<missing>'}`);
      if (ledger.authenticatedSmokeResults?.status !== 'passed')
        failures.push(
          `ledger authenticatedSmokeResults.status is ${ledger.authenticatedSmokeResults?.status || '<missing>'}`,
        );
      if (!['passed'].includes(ledger.telemetryCheckResult?.status))
        failures.push(`ledger telemetryCheckResult.status is ${ledger.telemetryCheckResult?.status || '<missing>'}`);
    }
  }
  const status = failures.length > 0 ? 'failed' : blockers.length > 0 ? 'blocked' : 'verified';
  return { status, exitCode: status === 'verified' ? 0 : status === 'blocked' ? 2 : 1, failures, blockers };
}

export async function checkLiveRuntime(options) {
  if (!options.apiBaseUrl)
    return {
      status: 'blocked',
      blockedReason: 'API base URL is required for live runtime truth. Set --api-base-url or API_BASE_URL.',
    };
  const apiBaseUrl = requireUrl('API_BASE_URL', options.apiBaseUrl);
  try {
    const health = await fetchJson(`${apiBaseUrl}/health`);
    if (health.response.status !== 200) throw new Error(`/health returned ${health.response.status}`);
    return { status: 'passed', apiBaseUrl, runtime: health.json };
  } catch (error) {
    return { status: 'failed', apiBaseUrl, failureSummary: error instanceof Error ? error.message : String(error) };
  }
}

async function latestRunIdForLedger(options, spawn) {
  if (options.runId) return options.runId;
  const runs = JSON.parse(
    runGh(
      [
        'run',
        'list',
        '--repo',
        options.repo,
        '--workflow',
        options.workflow,
        '--branch',
        'main',
        '--status',
        'success',
        '--limit',
        '30',
        '--json',
        'databaseId,headSha,conclusion,status',
      ],
      spawn,
    ),
  );
  const run = runs.find(
    (candidate) => !options.expectedSha || String(candidate.headSha).toLowerCase() === options.expectedSha,
  );
  if (!run)
    throw new Error(
      `No successful ${options.workflow} run found${options.expectedSha ? ` for ${options.expectedSha}` : ''}.`,
    );
  return String(run.databaseId);
}

export async function loadLedger(options, spawn = spawnSync) {
  if (!options.includeLedger) return { ledger: null, artifactName: '', runId: '' };
  if (!ghAvailable(spawn)) throw new Error('gh CLI is unavailable; ledger mode requires GitHub CLI.');
  const runId = await latestRunIdForLedger(options, spawn);
  const artifactName = `release-ledger-${options.environment}-${options.expectedSha}`;
  const artifactDir = options.artifactDir || (await mkdtemp(join(tmpdir(), 'runtime-truth-ledger-')));
  if (!existsSync(artifactDir)) throw new Error(`artifact directory does not exist: ${artifactDir}`);
  runGh(['run', 'download', runId, '--repo', options.repo, '--name', artifactName, '--dir', artifactDir], spawn);
  const ledgerPath = await findJsonFile(artifactDir);
  if (!ledgerPath) throw new Error(`Artifact ${artifactName} did not contain a JSON ledger.`);
  const ledger = JSON.parse(await readFile(ledgerPath, 'utf8'));
  return { ledger, artifactName, runId, ledgerPath };
}

export async function runRuntimeTruth({ argv = process.argv.slice(2), env = process.env, spawn = spawnSync } = {}) {
  const options = parseArgs(argv, env);
  const live = await checkLiveRuntime(options);
  let ledger = null;
  let ledgerInfo = {};
  let ledgerLoadError = '';
  let ledgerErrors = [];
  if (options.includeLedger) {
    try {
      ledgerInfo = await loadLedger(options, spawn);
      ledger = ledgerInfo.ledger;
      ledgerErrors = validateReleaseLedger(ledger);
    } catch (error) {
      ledgerLoadError = error instanceof Error ? error.message : String(error);
    }
  }
  const decision = decideRuntimeTruth({ live, ledger, options, ledgerErrors });
  if (ledgerLoadError) {
    decision.status = decision.status === 'failed' ? 'failed' : 'blocked';
    decision.exitCode = decision.status === 'failed' ? 1 : 2;
    decision.blockers.push(ledgerLoadError);
  }
  const result = {
    status: decision.status,
    checkedAt: new Date().toISOString(),
    environment: options.environment || undefined,
    expectedSha: options.expectedSha || undefined,
    live,
    ledger: ledger ? summarizeLedger(ledger) : undefined,
    ledgerArtifact: ledgerInfo.artifactName,
    ledgerRunId: ledgerInfo.runId,
    failures: decision.failures,
    blockers: decision.blockers,
  };
  return { result, exitCode: decision.exitCode };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { result, exitCode } = await runRuntimeTruth();
  const rendered = safeSummary(result);
  if (exitCode === 0) console.log(rendered);
  else console.error(rendered);
  process.exit(exitCode);
}
