#!/usr/bin/env node
import { appendFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const releaseFiles = ['frontend.tar.gz', 'functionapp.zip', 'release-manifest.json', 'sbom.cdx.json'];

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
  // The transfer is an immutable, current-run GitHub artifact. Content/identity is
  // verified again against the accepted ledger and current production under the lock.
  const transfer = await readAcceptedTransfer(transferDirectory);
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
  return { bundled: transfer.bundled };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const values = process.argv.slice(2);
    if (
      values.length !== 6 ||
      values[0] !== '--transfer' ||
      values[2] !== '--output' ||
      values[4] !== '--github-output' ||
      !process.env.RUNNER_TEMP ||
      resolve(values[3]) !== resolve(process.env.RUNNER_TEMP) ||
      resolve(values[1]) !== resolve(process.env.RUNNER_TEMP, 'accepted-transfer')
    )
      throw new Error('Invalid baseline staging arguments.');
    const result = await materializeAcceptedBaseline({ transferDirectory: values[1], outputDirectory: values[3] });
    await appendFile(values[5], `bundled=${result.bundled}\n`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
