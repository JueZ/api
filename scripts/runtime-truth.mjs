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
    expectedDeliveryCorrelation: args.deliveryCorrelation || env.EXPECTED_DELIVERY_CORRELATION || '',
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

const workflowIdentities = {
  'deploy-test.yml': { path: '.github/workflows/deploy-test.yml', name: 'Deploy Test' },
  'promote-production.yml': { path: '.github/workflows/promote-production.yml', name: 'Promote Production' },
};

export function validateWorkflowRunMetadata(run = {}, options = {}) {
  const errors = [];
  const identity = workflowIdentities[options.workflow];
  if (!identity) return [`unsupported deployment workflow: ${options.workflow || '<missing>'}`];
  const expectedTitle = `${identity.name} ${options.expectedSha} ${options.expectedDeliveryCorrelation}`;
  if (String(run.id || '') !== options.runId) errors.push('workflow run ID does not match the requested run');
  if (run.repository?.full_name !== options.repo) errors.push('workflow repository does not match the requested repo');
  if (run.path !== identity.path) errors.push(`workflow path must be ${identity.path}`);
  if (run.name !== identity.name) errors.push(`workflow name must be ${identity.name}`);
  if (run.event !== 'workflow_dispatch') errors.push('workflow event must be workflow_dispatch');
  if (run.conclusion !== 'success') errors.push('workflow conclusion must be success');
  if (run.head_branch !== 'main') errors.push('workflow head branch must be main');
  if (String(run.head_sha || '').toLowerCase() !== options.expectedSha) {
    errors.push('workflow head SHA does not match the expected deployed commit');
  }
  if (run.display_title !== expectedTitle) {
    errors.push('workflow display title does not match the expected source and delivery correlation');
  }
  return errors;
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
    deliveryCorrelation: ledger.deliveryCorrelation,
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
      if (options.expectedDeliveryCorrelation && ledger.deliveryCorrelation !== options.expectedDeliveryCorrelation) {
        failures.push('ledger deliveryCorrelation does not match the expected workflow dispatch');
      }
      if (options.runId && ledger.workflowRunId !== options.runId) {
        failures.push('ledger workflowRunId does not match the expected workflow run');
      }
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

export async function loadLedger(options, spawn = spawnSync) {
  if (!options.includeLedger) return { ledger: null, artifactName: '', runId: '' };
  if (!ghAvailable(spawn)) throw new Error('gh CLI is unavailable; ledger mode requires GitHub CLI.');
  if (!/^\d+$/.test(options.runId || '')) {
    throw new Error('Ledger mode requires the exact workflow run ID via --run-id.');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(options.expectedDeliveryCorrelation || '')) {
    throw new Error('Ledger mode requires the exact workflow delivery correlation via --delivery-correlation.');
  }
  if (!/^[0-9a-f]{40}$/.test(options.expectedSha || '')) {
    throw new Error('Ledger mode requires the exact lowercase deployed commit via --expected-sha.');
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repo || '')) {
    throw new Error('Ledger mode requires an owner/repository GitHub repository identifier.');
  }
  const runId = options.runId;
  const runMetadata = JSON.parse(runGh(['api', `repos/${options.repo}/actions/runs/${runId}`], spawn));
  const runErrors = validateWorkflowRunMetadata(runMetadata, options);
  if (runErrors.length > 0) throw new Error(`Workflow run identity rejected: ${runErrors.join('; ')}`);
  const artifactName = `release-ledger-${options.environment}-${options.expectedSha}`;
  const artifactDir = options.artifactDir || (await mkdtemp(join(tmpdir(), 'runtime-truth-ledger-')));
  if (!existsSync(artifactDir)) throw new Error(`artifact directory does not exist: ${artifactDir}`);
  runGh(['run', 'download', runId, '--repo', options.repo, '--name', artifactName, '--dir', artifactDir], spawn);
  const ledgerPath = await findJsonFile(artifactDir);
  if (!ledgerPath) throw new Error(`Artifact ${artifactName} did not contain a JSON ledger.`);
  const ledger = JSON.parse(await readFile(ledgerPath, 'utf8'));
  if (
    ledger.workflowRunId !== runId ||
    ledger.sourceRef !== options.expectedSha ||
    ledger.deployedCommit !== options.expectedSha ||
    ledger.deliveryCorrelation !== options.expectedDeliveryCorrelation
  ) {
    throw new Error('Release ledger identity does not match the exact inspected workflow run.');
  }
  return { ledger, artifactName, runId, ledgerPath, runMetadata };
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
      ledgerErrors = validateReleaseLedger(ledger, {
        expectedDeliveryCorrelation: options.expectedDeliveryCorrelation,
      });
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
    expectedDeliveryCorrelation: options.expectedDeliveryCorrelation || undefined,
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
