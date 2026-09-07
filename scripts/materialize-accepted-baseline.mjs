#!/usr/bin/env node
import { appendFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const releaseFiles = ['frontend.tar.gz', 'functionapp.zip', 'release-manifest.json', 'sbom.cdx.json'];

export function validateAcceptedBaseline(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value.schemaVersion !== 1 ||
    value.status !== 'accepted'
  )
    throw new Error('Downloaded baseline must identify a schema-v1 accepted release');
  for (const name of ['sourceRef', 'runId', 'correlation', 'acceptanceRunId', 'acceptanceCorrelation']) {
    if (typeof value[name] === 'string' && value[name] !== value[name].trim())
      throw new Error(`baseline.${name} must not contain surrounding whitespace`);
  }
  if (typeof value.sourceRef !== 'string' || !/^[0-9a-f]{40}$/.test(value.sourceRef))
    throw new Error('baseline.sourceRef must be a full lowercase commit SHA');
  const [runId, acceptanceRunId] = ['runId', 'acceptanceRunId'].map((name) => {
    const run = value[name];
    if (
      !['string', 'number'].includes(typeof run) ||
      !/^[1-9][0-9]*$/.test(String(run)) ||
      !Number.isSafeInteger(Number(run))
    )
      throw new Error(`baseline.${name} must be a positive integer`);
    return String(run);
  });
  for (const name of ['correlation', 'acceptanceCorrelation']) {
    if (typeof value[name] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(value[name]))
      throw new Error(`baseline.${name} must be an opaque 8-128 character identifier`);
  }
  if (!['promotion', 'recovery'].includes(value.acceptanceKind))
    throw new Error('baseline.acceptanceKind must be promotion or recovery');
  if (value.releaseArtifactName !== `production-release-${value.sourceRef}-${value.correlation}`)
    throw new Error('baseline.releaseArtifactName does not match the accepted bundle identity');
  if (value.ledgerArtifactName !== `release-ledger-prod-${value.sourceRef}-${value.acceptanceCorrelation}`)
    throw new Error('baseline.ledgerArtifactName does not match the accepted ledger identity');
  return {
    sourceRef: value.sourceRef,
    runId,
    correlation: value.correlation,
    acceptanceRunId,
    acceptanceCorrelation: value.acceptanceCorrelation,
  };
}

async function regularBytes(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > 512 * 1024 * 1024) {
    throw new Error('Baseline transfer must contain bounded regular files.');
  }
  return readFile(path);
}

async function exactDirectory(path, expected) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Baseline transfer directory is invalid.');
  const names = (await readdir(path)).sort();
  if (JSON.stringify(names) !== JSON.stringify([...expected].sort()))
    throw new Error('Baseline transfer layout is invalid.');
}

export async function readAcceptedTransfer(directory) {
  const names = (await readdir(directory)).sort();
  const bundled = names.length === 3;
  await exactDirectory(
    directory,
    bundled ? ['accepted-baseline.json', 'release', 'ledger'] : ['accepted-baseline.json'],
  );
  const baselineBytes = await regularBytes(resolve(directory, 'accepted-baseline.json'));
  const baseline = JSON.parse(baselineBytes);
  if (baseline?.schemaVersion !== 1 || baseline.status !== 'accepted')
    throw new Error('Transfer must identify an accepted baseline.');
  const files = {};
  if (bundled) {
    await exactDirectory(resolve(directory, 'release'), releaseFiles);
    await exactDirectory(resolve(directory, 'ledger'), ['release-ledger-prod.json']);
    for (const file of releaseFiles)
      files[`accepted-release/${file}`] = await regularBytes(resolve(directory, 'release', file));
    files['accepted-ledger/release-ledger-prod.json'] = await regularBytes(
      resolve(directory, 'ledger', 'release-ledger-prod.json'),
    );
  }
  return { baseline, baselineBytes, bundled, files };
}

export async function materializeAcceptedBaseline({ transferDirectory, outputDirectory }) {
  // The transfer is an immutable GitHub artifact from the current or exact failed run. Content/identity is
  // verified again against the accepted ledger and current production under the lock.
  const transfer = await readAcceptedTransfer(transferDirectory);
  const coordinates = validateAcceptedBaseline(transfer.baseline);
  await mkdir(resolve(outputDirectory, 'accepted-baseline'));
  if (transfer.bundled) {
    await mkdir(resolve(outputDirectory, 'accepted-release'));
    await mkdir(resolve(outputDirectory, 'accepted-ledger'));
  }
  await writeFile(resolve(outputDirectory, 'accepted-baseline/accepted-baseline.json'), transfer.baselineBytes, {
    flag: 'wx',
  });
  for (const [name, bytes] of Object.entries(transfer.files))
    await writeFile(resolve(outputDirectory, name), bytes, { flag: 'wx' });
  return { bundled: transfer.bundled, ...coordinates };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const values = process.argv.slice(2);
    const environmentPath = process.env.GITHUB_ENV;
    if (
      values.length !== 6 ||
      values[0] !== '--transfer' ||
      values[2] !== '--output' ||
      values[4] !== '--github-output' ||
      !process.env.RUNNER_TEMP ||
      !environmentPath ||
      resolve(values[3]) !== resolve(process.env.RUNNER_TEMP) ||
      resolve(values[1]) !== resolve(process.env.RUNNER_TEMP, 'accepted-transfer')
    )
      throw new Error('Invalid baseline staging arguments.');
    const result = await materializeAcceptedBaseline({ transferDirectory: values[1], outputDirectory: values[3] });
    const coordinates = {
      ACCEPTED_SOURCE_REF: result.sourceRef,
      ACCEPTED_RELEASE_RUN_ID: result.runId,
      ACCEPTED_RELEASE_CORRELATION: result.correlation,
      ACCEPTED_LEDGER_RUN_ID: result.acceptanceRunId,
      ACCEPTED_LEDGER_CORRELATION: result.acceptanceCorrelation,
    };
    await appendFile(
      values[5],
      `bundled=${result.bundled}\n` +
        Object.entries(coordinates)
          .map(([name, value]) => `${name.toLowerCase()}=${value}\n`)
          .join(''),
    );
    await appendFile(
      environmentPath,
      Object.entries(coordinates)
        .map(([name, value]) => `${name}=${value}\n`)
        .join(''),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
