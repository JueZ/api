#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFile, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AzureCliCredential } from '@azure/identity';
import { BlobServiceClient } from '@azure/storage-blob';
import {
  ACCEPTED_RELEASE_ARCHIVE_FILES,
  createAcceptedReleaseArchiveManifest,
  validateAcceptedReleaseArchiveManifest,
} from './accepted-release-archive.mjs';
import { validateArchiveAttestationVerification } from './verify-archive-attestation.mjs';

const MANIFEST = 'accepted-release-manifest.json';
const ATTESTATION = 'accepted-release-attestation.json';
const MAX_FILE_BYTES = 512 * 1024 * 1024;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));

export function archivePrefix(expected) {
  if (
    expected?.repository !== 'JueZ/api' ||
    !/^[0-9a-f]{40}$/.test(expected?.sourceRef ?? '') ||
    !/^[0-9a-f]{40}$/.test(expected?.acceptance?.controllerRef ?? '') ||
    !Number.isSafeInteger(expected?.acceptance?.runId) ||
    expected.acceptance.runId <= 0 ||
    expected.acceptance.attempt !== 1 ||
    !['promotion', 'recovery'].includes(expected.acceptance.kind) ||
    !/^[a-z0-9]{3,24}$/.test(expected?.storage?.account ?? '') ||
    expected.storage.container !== 'function-releases'
  )
    throw new Error('Archive coordinates must be independently verified production identities.');
  return `accepted/${expected.acceptance.controllerRef}/${expected.acceptance.runId}/1/${expected.acceptance.kind}/`;
}

async function bytesAt(client, maxSize = MAX_FILE_BYTES) {
  const properties = await client.getProperties();
  const size = properties.contentLength;
  if (!Number.isSafeInteger(size) || size <= 0 || size > maxSize) throw new Error('Archive object size is invalid.');
  const bytes = await client.downloadToBuffer(0, size);
  if (bytes.byteLength !== size) throw new Error('Archive download is incomplete.');
  return bytes;
}

async function uploadExact(container, name, bytes) {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_FILE_BYTES) throw new Error('Archive upload size is invalid.');
  const client = container.getBlockBlobClient(name);
  let versionId;
  try {
    versionId = (await client.uploadData(bytes, { conditions: { ifNoneMatch: '*' } })).versionId;
  } catch (uploadError) {
    // A response can be lost after Azure committed an immutable object. Reconcile
    // once by exact version and bytes; never overwrite or accept different content.
    try {
      versionId = (await client.getProperties()).versionId;
    } catch {
      throw uploadError;
    }
  }
  if (!versionId) throw new Error('Archive upload must return an immutable version.');
  const observed = await bytesAt(client.withVersion(versionId));
  if (digest(observed) !== digest(bytes)) throw new Error('Archive upload readback does not match.');
  return { versionId, sha256: digest(bytes), size: bytes.byteLength };
}

/** Uploads validated bytes once. The manifest is still unpublished and untrusted until it is attested. */
export async function prepareAcceptedArchive({ container, directory, expected }) {
  const prefix = archivePrefix(expected);
  const fileBytes = {};
  const uploads = [];
  for (const file of ACCEPTED_RELEASE_ARCHIVE_FILES) {
    const path = resolve(directory, file);
    const stats = await lstat(path);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_FILE_BYTES)
      throw new Error('Archive input must be a bounded regular file.');
    const bytes = await readFile(path);
    fileBytes[file] = bytes;
    uploads.push({
      file,
      blob: `${prefix}${file}`,
      versionId: 'pending',
      sha256: digest(bytes),
      size: bytes.byteLength,
    });
  }
  const provisional = await createAcceptedReleaseArchiveManifest({ directory, ...expected, uploads });
  if (!provisional.ok) throw new Error(provisional.errors.join('\n'));
  for (const upload of uploads)
    Object.assign(upload, await uploadExact(container, upload.blob, fileBytes[upload.file]));
  const result = await createAcceptedReleaseArchiveManifest({ directory, ...expected, uploads });
  if (!result.ok) throw new Error(result.errors.join('\n'));
  return result.manifest;
}

/** Publish the attestation first and the manifest last, only after signature and exact-byte verification. */
export async function publishAcceptedArchive({
  container,
  manifestBytes,
  attestationBytes,
  expected,
  verifyAttestation,
}) {
  const prefix = archivePrefix(expected);
  await verifyAttestation(manifestBytes, attestationBytes, expected);
  const manifest = JSON.parse(manifestBytes);
  const fileBytes = await downloadManifestFiles(container, manifest, prefix);
  const result = validateAcceptedReleaseArchiveManifest({ manifest, expected, fileBytes });
  if (!result.ok) throw new Error(result.errors.join('\n'));
  await uploadExact(container, `${prefix}${ATTESTATION}`, attestationBytes);
  await uploadExact(container, `${prefix}${MANIFEST}`, manifestBytes);
  return { status: 'archived', sourceRef: expected.sourceRef, acceptanceRunId: expected.acceptance.runId };
}

async function downloadManifestFiles(container, manifest, prefix) {
  if (!Array.isArray(manifest?.files) || manifest.files.length !== ACCEPTED_RELEASE_ARCHIVE_FILES.length)
    throw new Error('Archive must list exactly five files.');
  const fileBytes = {};
  for (const [index, file] of ACCEPTED_RELEASE_ARCHIVE_FILES.entries()) {
    const entry = manifest.files[index];
    if (
      entry?.file !== file ||
      entry?.blob !== `${prefix}${file}` ||
      !/^[A-Za-z0-9][A-Za-z0-9._:+-]{0,255}$/.test(entry?.versionId ?? '')
    )
      throw new Error('Archive file coordinates are invalid.');
    fileBytes[file] = await bytesAt(container.getBlobClient(entry.blob).withVersion(entry.versionId));
  }
  return fileBytes;
}

/** Trusted run selection is a prerequisite; this adds cryptographic archive and byte verification. */
export async function restoreAcceptedArchive({ container, expected, verifyAttestation }) {
  const prefix = archivePrefix(expected);
  const manifestBytes = await bytesAt(container.getBlobClient(`${prefix}${MANIFEST}`), 1024 * 1024);
  const attestationBytes = await bytesAt(container.getBlobClient(`${prefix}${ATTESTATION}`), 8 * 1024 * 1024);
  await verifyAttestation(manifestBytes, attestationBytes, expected);
  const manifest = JSON.parse(manifestBytes);
  const fileBytes = await downloadManifestFiles(container, manifest, prefix);
  const result = validateAcceptedReleaseArchiveManifest({ manifest, expected, fileBytes });
  if (!result.ok) throw new Error(result.errors.join('\n'));
  return fileBytes;
}

export function expectedArchiveFromSelection({ selected, observation, resource, repository }) {
  const identity = observation?.identity;
  const receipt = identity?.mutationReceipt;
  if (
    observation?.ok !== true ||
    observation.state !== 'coherent' ||
    receipt?.recorded !== true ||
    selected?.sourceRef !== identity?.sourceRef ||
    String(selected?.runId) !== String(identity?.runId) ||
    selected?.correlation !== identity?.deliveryCorrelation ||
    String(selected?.acceptanceRunId) !== String(receipt?.runId) ||
    selected?.acceptanceCorrelation !== receipt?.correlation ||
    selected?.acceptanceKind !== receipt?.kind
  ) {
    throw new Error('Archive selection does not match the installed production receipt.');
  }
  const expected = {
    repository,
    sourceRef: selected.sourceRef,
    originalBundle: { runId: Number(selected.runId), correlation: selected.correlation },
    acceptance: {
      runId: Number(selected.acceptanceRunId),
      attempt: 1,
      correlation: selected.acceptanceCorrelation,
      controllerRef: receipt.controllerRef,
      kind: selected.acceptanceKind,
    },
    storage: { account: resource.releaseStorageAccountName, container: 'function-releases' },
  };
  archivePrefix(expected);
  return expected;
}

function containerFor(expected) {
  archivePrefix(expected);
  return new BlobServiceClient(
    `https://${expected.storage.account}.blob.core.windows.net`,
    new AzureCliCredential(),
  ).getContainerClient(expected.storage.container);
}

function temporaryPath(path) {
  const root = process.env.RUNNER_TEMP;
  if (!root || !path) throw new Error('Archive staging requires RUNNER_TEMP.');
  const target = resolve(path);
  const within = relative(resolve(root), target);
  if (!within || within.startsWith('..') || isAbsolute(within))
    throw new Error('Archive staging must stay inside RUNNER_TEMP.');
  return target;
}

async function newDirectory(path) {
  const target = temporaryPath(path);
  // mkdir without recursive refuses existing output directories, including links.
  await mkdir(target);
  return target;
}

async function signatureVerifier(directory) {
  const verifyDir = await newDirectory(directory);
  return async (manifestBytes, attestationBytes, expected) => {
    const manifestPath = resolve(verifyDir, MANIFEST);
    const bundlePath = resolve(verifyDir, ATTESTATION);
    await writeFile(manifestPath, manifestBytes, { flag: 'wx' });
    await writeFile(bundlePath, attestationBytes, { flag: 'wx' });
    const signer = 'JueZ/api/.github/workflows/deploy-environment.yml';
    const result = spawnSync(
      'gh',
      [
        'attestation',
        'verify',
        manifestPath,
        '--bundle',
        bundlePath,
        '--repo',
        expected.repository,
        '--signer-workflow',
        signer,
        '--cert-identity',
        `https://github.com/${signer}@refs/heads/main`,
        '--source-ref',
        'refs/heads/main',
        '--source-digest',
        expected.acceptance.controllerRef,
        '--signer-digest',
        expected.acceptance.controllerRef,
        '--deny-self-hosted-runners',
        '--format',
        'json',
      ],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
    );
    if (result.error || result.status !== 0) throw new Error('Archive cryptographic provenance verification failed.');
    const validation = validateArchiveAttestationVerification({
      verification: JSON.parse(result.stdout),
      expected: {
        repository: expected.repository,
        controllerRef: expected.acceptance.controllerRef,
        runId: expected.acceptance.runId,
        attempt: expected.acceptance.attempt,
      },
    });
    if (!validation.ok) throw new Error(validation.errors.join('\n'));
  };
}

async function runCli() {
  const [command, ...values] = process.argv.slice(2);
  if (values.length % 2 || !['prepare', 'publish', 'restore'].includes(command))
    throw new Error('Invalid archive command.');
  const args = new Map();
  for (let index = 0; index < values.length; index += 2) {
    if (!values[index].startsWith('--') || args.has(values[index])) throw new Error('Invalid archive arguments.');
    args.set(values[index], values[index + 1]);
  }
  if (command === 'prepare') {
    const directory = await newDirectory(args.get('--output-dir'));
    for (const file of ACCEPTED_RELEASE_ARCHIVE_FILES) {
      await copyFile(
        file === 'release-ledger-prod.json' ? args.get('--ledger') : resolve(args.get('--release-dir'), file),
        resolve(directory, file),
      );
    }
    const rollback = process.env.ALLOW_ROLLBACK === 'true';
    const expected = {
      repository: process.env.GITHUB_REPOSITORY,
      sourceRef: process.env.SOURCE_REF,
      originalBundle: {
        runId: Number(rollback ? process.env.ACCEPTED_RELEASE_RUN_ID : process.env.GITHUB_RUN_ID),
        correlation: rollback ? process.env.ACCEPTED_RELEASE_CORRELATION : process.env.DELIVERY_CORRELATION,
      },
      acceptance: {
        runId: Number(process.env.GITHUB_RUN_ID),
        attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
        correlation: process.env.DELIVERY_CORRELATION,
        controllerRef: process.env.GITHUB_SHA,
        kind: rollback ? 'recovery' : 'promotion',
      },
      storage: { account: process.env.EFFECTIVE_RELEASE_STORAGE_ACCOUNT, container: 'function-releases' },
    };
    const manifest = await prepareAcceptedArchive({ directory, expected, container: containerFor(expected) });
    await writeFile(resolve(directory, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    await writeFile(resolve(directory, 'expected.json'), `${JSON.stringify(expected)}\n`, { flag: 'wx' });
    return { status: 'prepared', sourceRef: expected.sourceRef };
  }
  const verifyAttestation = await signatureVerifier(args.get('--verification-dir'));
  if (command === 'publish') {
    const directory = temporaryPath(args.get('--prepared-dir'));
    const expected = await json(resolve(directory, 'expected.json'));
    return publishAcceptedArchive({
      expected,
      container: containerFor(expected),
      verifyAttestation,
      manifestBytes: await readFile(resolve(directory, MANIFEST)),
      attestationBytes: await readFile(args.get('--bundle')),
    });
  }
  const expected = expectedArchiveFromSelection({
    selected: await json(args.get('--selection')),
    observation: await json(args.get('--observation')),
    resource: await json(args.get('--resource')),
    repository: process.env.GITHUB_REPOSITORY,
  });
  const fileBytes = await restoreAcceptedArchive({ expected, container: containerFor(expected), verifyAttestation });
  const releaseDirectory = await newDirectory(args.get('--release-dir'));
  const ledgerDirectory = await newDirectory(args.get('--ledger-dir'));
  for (const [file, bytes] of Object.entries(fileBytes))
    await writeFile(resolve(file === 'release-ledger-prod.json' ? ledgerDirectory : releaseDirectory, file), bytes, {
      flag: 'wx',
    });
  return { status: 'archive-verified', sourceRef: expected.sourceRef, acceptanceRunId: expected.acceptance.runId };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(JSON.stringify(await runCli()));
  } catch (error) {
    // Azure transport errors may contain credential-bearing URLs; do not echo them.
    console.error(`Accepted release archive failed (${error?.name ?? 'Error'}). No unverified archive is accepted.`);
    process.exitCode = 1;
  }
}
