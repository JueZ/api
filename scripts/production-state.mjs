#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import {
  decidePromotionGuard,
  decideRollbackGuard,
  observeProductionState,
  parseImmutablePackagePointer,
} from './lib/production-state.mjs';

function parseArgs(argv) {
  const args = new Map();
  for (let index = 1; index < argv.length; index += 2) args.set(argv[index], argv[index + 1]);
  return { command: argv[0], args };
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

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function run() {
  const { command, args } = parseArgs(process.argv.slice(2));
  if (command === 'package-pointer') {
    const settings = await readJson(args.get('--settings'));
    const packageSetting = settings.find((entry) => entry?.name === 'WEBSITE_RUN_FROM_PACKAGE');
    const pointer = parseImmutablePackagePointer(packageSetting?.value);
    writeOutputs(
      {
        package_storage_account: pointer.storageAccountName,
        package_container: pointer.containerName,
        package_blob: pointer.blobName,
        package_version_id: pointer.versionId,
      },
      args.get('--output'),
    );
    process.stdout.write(`${JSON.stringify(pointer)}\n`);
    return;
  }

  if (command === 'observe') {
    const frontendMetadataBytes = await readFile(args.get('--frontend-metadata'));
    const healthStatus = args.get('--health-status');
    const health =
      healthStatus === 'available'
        ? { status: 'available', body: await readJson(args.get('--health')) }
        : { status: 'unavailable' };
    const observation = observeProductionState({
      appSettings: await readJson(args.get('--settings')),
      frontendMetadata: JSON.parse(frontendMetadataBytes.toString('utf8')),
      frontendMetadataBytes,
      frontendInventory: await readJson(args.get('--frontend-inventory')),
      health,
      packageContentSha256: args.get('--package-digest'),
      resource: await readJson(args.get('--resource')),
    });
    await writeFile(args.get('--json-output'), `${JSON.stringify(observation, null, 2)}\n`);
    writeOutputs(
      {
        observation_state: observation.state,
        observed_source_ref: observation.identity.sourceRef ?? '',
        observed_run_id: observation.identity.runId ?? '',
        observed_health: observation.identity.health.status,
      },
      args.get('--output'),
    );
    if (!observation.ok && args.get('--allow-noncoherent') !== 'true') {
      throw new Error(observation.errors.join('\n'));
    }
    process.stdout.write(
      `${JSON.stringify({ state: observation.state, health: observation.identity.health.status })}\n`,
    );
    return;
  }

  if (command === 'promotion-decision') {
    const decision = decidePromotionGuard({
      candidateSourceRef: args.get('--candidate-source'),
      currentMainRef: args.get('--current-main'),
      recoveryReady: args.get('--recovery-ready') === 'true',
      acceptedIdentity: (await readJson(args.get('--accepted'))).identity,
      observed: await readJson(args.get('--observed')),
    });
    await emitDecision(decision, args);
    return;
  }

  if (command === 'rollback-decision') {
    const accepted = await readJson(args.get('--accepted'));
    const observed = await readJson(args.get('--observed'));
    const failedIntent = await readJson(args.get('--intent'));
    const decision = decideRollbackGuard({
      acceptedIdentity: accepted.identity,
      failedIntent,
      observed,
      rollbackAlreadyAttempted: args.get('--rollback-attempted') === 'true',
      currentMainRef: args.get('--current-main'),
      failedControllerRef: args.get('--failed-controller'),
    });
    await emitDecision(decision, args);
    return;
  }

  throw new Error('Unsupported production-state command');
}

async function emitDecision(decision, args) {
  if (args.get('--json-output')) await writeFile(args.get('--json-output'), `${JSON.stringify(decision, null, 2)}\n`);
  writeOutputs(
    {
      guard_state: decision.state,
      mutation_allowed: String(decision.mutate),
      guard_reason: decision.reason,
      superseded_by: decision.supersededBy ?? '',
      configuration_uncertain: String(Boolean(decision.configurationUncertain)),
    },
    args.get('--output'),
  );
  process.stdout.write(`${JSON.stringify(decision)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await run();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
