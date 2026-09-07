import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { validateReleaseLedger } from './validate-release-ledger.mjs';
import { verifyReleaseArtifacts } from './verify-release-artifacts.mjs';

export const ACCEPTED_RELEASE_ARCHIVE_FILES = Object.freeze([
  'functionapp.zip',
  'frontend.tar.gz',
  'sbom.cdx.json',
  'release-manifest.json',
  'release-ledger-prod.json',
]);

const artifactFiles = {
  functionapp: 'functionapp.zip',
  frontend: 'frontend.tar.gz',
  sbom: 'sbom.cdx.json',
};
const shaPattern = /^[0-9a-f]{40}$/;
const digestPattern = /^[0-9a-f]{64}$/;
const correlationPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const storageAccountPattern = /^[a-z0-9]{3,24}$/;
const versionPattern = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,255}$/;

/**
 * Schema 1 contains only repository and release identity, immutable Azure blob
 * coordinates, and byte digests. The caller must separately verify the manifest
 * attestation, trusted first-attempt Delivery run, and installed production identity.
 */
export async function createAcceptedReleaseArchiveManifest({
  directory,
  repository,
  sourceRef,
  originalBundle,
  acceptance,
  storage,
  uploads,
}) {
  const errors = [];
  const files = canonicalUploads(uploads, errors);
  const manifest = {
    schemaVersion: 1,
    repository,
    sourceRef,
    originalBundle,
    acceptance,
    storage,
    files,
  };
  const fileBytes = {};

  for (const file of ACCEPTED_RELEASE_ARCHIVE_FILES) {
    try {
      const path = resolve(directory, file);
      const stats = await lstat(path);
      if (!stats.isFile() || stats.isSymbolicLink()) throw new Error('not a regular file');
      fileBytes[file] = await readFile(path);
    } catch {
      errors.push(`${file} must be a readable regular file`);
    }
  }

  try {
    const release = await verifyReleaseArtifacts(directory, sourceRef);
    errors.push(...release.errors.map((error) => `Release bundle: ${error}`));
  } catch {
    errors.push('Release bundle could not be verified');
  }

  const validation = validateAcceptedReleaseArchiveManifest({
    manifest,
    expected: { repository, sourceRef, originalBundle, acceptance, storage },
    fileBytes,
  });
  errors.push(...validation.errors);
  const uniqueErrors = [...new Set(errors)];
  return { ok: uniqueErrors.length === 0, errors: uniqueErrors, manifest: uniqueErrors.length === 0 ? manifest : null };
}

/**
 * Pure validation of an attested manifest and downloaded bytes. `expected` must
 * come from independently trusted caller inputs; matching a manifest to itself
 * does not establish cryptographic provenance or production acceptance.
 */
export function validateAcceptedReleaseArchiveManifest({ manifest, expected, fileBytes }) {
  const errors = [];
  exactKeys(
    manifest,
    ['schemaVersion', 'repository', 'sourceRef', 'originalBundle', 'acceptance', 'storage', 'files'],
    'manifest',
    errors,
  );
  exactKeys(manifest?.originalBundle, ['runId', 'correlation'], 'manifest.originalBundle', errors);
  exactKeys(
    manifest?.acceptance,
    ['runId', 'attempt', 'correlation', 'controllerRef', 'kind'],
    'manifest.acceptance',
    errors,
  );
  exactKeys(manifest?.storage, ['account', 'container'], 'manifest.storage', errors);

  if (manifest?.schemaVersion !== 1) errors.push('manifest.schemaVersion must be 1');
  if (!repositoryPattern.test(manifest?.repository ?? ''))
    errors.push('manifest.repository must use owner/name format');
  if (!shaPattern.test(manifest?.sourceRef ?? ''))
    errors.push('manifest.sourceRef must be a lowercase 40-character SHA');
  validateBundleIdentity(manifest?.originalBundle, 'manifest.originalBundle', errors);
  validateAcceptance(manifest?.acceptance, 'manifest.acceptance', errors);
  validateStorage(manifest?.storage, 'manifest.storage', errors);
  validateExpected(expected, errors);
  bindExpectedIdentity(manifest, expected, errors);
  bindPromotionOrRecovery(manifest, errors);

  const entries = validateFileEntries(manifest, errors);
  const bytesByFile = validateBytes(fileBytes, entries, errors);
  const releaseManifest = parseJson(bytesByFile['release-manifest.json'], 'release-manifest.json', errors);
  const ledger = parseJson(bytesByFile['release-ledger-prod.json'], 'release-ledger-prod.json', errors);
  validateReleaseManifest(releaseManifest, manifest?.sourceRef, bytesByFile, errors);
  validateAcceptedLedger(ledger, manifest, bytesByFile, errors);

  return { ok: errors.length === 0, errors };
}

function canonicalUploads(uploads, errors) {
  if (!Array.isArray(uploads)) {
    errors.push('uploads must be an array');
    return [];
  }
  const byFile = new Map();
  for (const upload of uploads) {
    const file = upload?.file;
    if (!ACCEPTED_RELEASE_ARCHIVE_FILES.includes(file)) {
      errors.push(`uploads contains an unlisted file: ${String(file ?? '')}`);
    } else if (byFile.has(file)) {
      errors.push(`uploads contains duplicate file: ${file}`);
    } else {
      byFile.set(file, upload);
    }
  }
  return ACCEPTED_RELEASE_ARCHIVE_FILES.filter((file) => byFile.has(file)).map((file) => ({
    file,
    blob: byFile.get(file).blob,
    versionId: byFile.get(file).versionId,
    sha256: byFile.get(file).sha256,
    size: byFile.get(file).size,
  }));
}

function validateFileEntries(manifest, errors) {
  if (!Array.isArray(manifest?.files) || manifest.files.length !== ACCEPTED_RELEASE_ARCHIVE_FILES.length) {
    errors.push('manifest.files must contain exactly the five fixed archive files');
    return new Map();
  }
  const entries = new Map();
  const prefix = `accepted/${manifest?.acceptance?.controllerRef}/${manifest?.acceptance?.runId}/1/${manifest?.acceptance?.kind}/`;
  for (const [index, expectedFile] of ACCEPTED_RELEASE_ARCHIVE_FILES.entries()) {
    const entry = manifest.files[index];
    exactKeys(entry, ['file', 'blob', 'versionId', 'sha256', 'size'], `manifest.files[${index}]`, errors);
    if (entry?.file !== expectedFile) errors.push(`manifest.files[${index}].file must be ${expectedFile}`);
    if (entry?.blob !== `${prefix}${expectedFile}`)
      errors.push(`manifest.files[${index}].blob must use the accepted release prefix`);
    if (!versionPattern.test(entry?.versionId ?? '')) errors.push(`manifest.files[${index}].versionId is invalid`);
    if (!digestPattern.test(entry?.sha256 ?? '')) errors.push(`manifest.files[${index}].sha256 is invalid`);
    if (!Number.isSafeInteger(entry?.size) || entry.size <= 0)
      errors.push(`manifest.files[${index}].size must be a positive integer`);
    if (entries.has(entry?.file)) errors.push(`manifest.files contains duplicate file: ${String(entry?.file ?? '')}`);
    else entries.set(entry?.file, entry);
  }
  return entries;
}

function validateBytes(fileBytes, entries, errors) {
  const result = {};
  if (!isRecord(fileBytes)) {
    errors.push('fileBytes must provide the five archive byte sequences');
    return result;
  }
  for (const unexpected of Object.keys(fileBytes).filter((file) => !ACCEPTED_RELEASE_ARCHIVE_FILES.includes(file))) {
    errors.push(`fileBytes contains an unlisted file: ${unexpected}`);
  }
  for (const file of ACCEPTED_RELEASE_ARCHIVE_FILES) {
    const bytes = fileBytes[file];
    if (!(bytes instanceof Uint8Array)) {
      errors.push(`${file} bytes are required`);
      continue;
    }
    result[file] = bytes;
    const entry = entries.get(file);
    if (entry && entry.size !== bytes.byteLength) errors.push(`${file} size does not match the archive manifest`);
    if (entry && entry.sha256 !== sha256(bytes)) errors.push(`${file} digest does not match the archive manifest`);
  }
  return result;
}

function validateReleaseManifest(release, sourceRef, fileBytes, errors) {
  if (!isRecord(release)) {
    errors.push('release-manifest.json must contain a JSON object');
    return;
  }
  if (release.schemaVersion !== 1) errors.push('Release manifest schemaVersion must be 1');
  if (release.sourceRef !== sourceRef) errors.push('Release manifest sourceRef does not match the archive source');
  const names = Object.keys(release.artifacts ?? {});
  for (const name of names.filter((value) => !(value in artifactFiles)))
    errors.push(`Release manifest has unexpected artifact: ${name}`);
  for (const [name, file] of Object.entries(artifactFiles)) {
    const artifact = release.artifacts?.[name];
    if (artifact?.file !== file || !digestPattern.test(artifact?.sha256 ?? '')) {
      errors.push(`Release manifest ${name} metadata is invalid`);
    } else if (fileBytes[file] && artifact.sha256 !== sha256(fileBytes[file])) {
      errors.push(`${file} digest does not match the release manifest`);
    }
  }
}

function validateAcceptedLedger(ledger, manifest, fileBytes, errors) {
  if (!isRecord(ledger)) {
    errors.push('release-ledger-prod.json must contain a JSON object');
    return;
  }
  errors.push(
    ...validateReleaseLedger(ledger, { expectedDeliveryCorrelation: manifest?.acceptance?.correlation }).map(
      (error) => `Release ledger: ${error}`,
    ),
  );
  if (ledger.environment !== 'prod') errors.push('Release ledger environment must be prod');
  if (ledger.sourceRef !== manifest?.sourceRef || ledger.deployedCommit !== manifest?.sourceRef) {
    errors.push('Release ledger source does not match the archived bundle');
  }
  if (String(ledger.workflowRunId ?? '') !== String(manifest?.acceptance?.runId ?? '')) {
    errors.push('Release ledger run does not match the acceptance run');
  }
  for (const key of ['smokeResults', 'authenticatedSmokeResults', 'telemetryCheckResult']) {
    if (ledger[key]?.status !== 'passed') errors.push(`Release ledger ${key}.status must be passed`);
  }
  for (const [name, file] of Object.entries(artifactFiles)) {
    const key = `${name}Sha256`;
    if (fileBytes[file] && ledger.artifacts?.[key] !== sha256(fileBytes[file])) {
      errors.push(`Release ledger artifacts.${key} does not match ${file}`);
    }
  }
  if (manifest?.acceptance?.kind === 'recovery') {
    const original = ledger.recovery?.originalBundle;
    if (
      ledger.recovery?.status !== 'verified' ||
      ledger.recovery?.configurationUncertain !== false ||
      original?.sourceRef !== manifest?.sourceRef ||
      String(original?.runId ?? '') !== String(manifest?.originalBundle?.runId ?? '') ||
      original?.correlation !== manifest?.originalBundle?.correlation
    ) {
      errors.push('Recovery ledger does not bind the verified original bundle identity');
    }
  } else if (ledger.recovery !== undefined) {
    errors.push('Promotion ledger must not contain recovery evidence');
  }
}

function bindPromotionOrRecovery(manifest, errors) {
  if (manifest?.acceptance?.kind !== 'promotion') return;
  if (
    manifest.acceptance.runId !== manifest?.originalBundle?.runId ||
    manifest.acceptance.correlation !== manifest?.originalBundle?.correlation ||
    manifest.acceptance.controllerRef !== manifest?.sourceRef
  ) {
    errors.push('Promotion acceptance must match the original bundle identity');
  }
}

function bindExpectedIdentity(manifest, expected, errors) {
  for (const [path, actual, trusted] of [
    ['repository', manifest?.repository, expected?.repository],
    ['sourceRef', manifest?.sourceRef, expected?.sourceRef],
    ['originalBundle.runId', manifest?.originalBundle?.runId, expected?.originalBundle?.runId],
    ['originalBundle.correlation', manifest?.originalBundle?.correlation, expected?.originalBundle?.correlation],
    ['acceptance.runId', manifest?.acceptance?.runId, expected?.acceptance?.runId],
    ['acceptance.attempt', manifest?.acceptance?.attempt, expected?.acceptance?.attempt],
    ['acceptance.correlation', manifest?.acceptance?.correlation, expected?.acceptance?.correlation],
    ['acceptance.controllerRef', manifest?.acceptance?.controllerRef, expected?.acceptance?.controllerRef],
    ['acceptance.kind', manifest?.acceptance?.kind, expected?.acceptance?.kind],
    ['storage.account', manifest?.storage?.account, expected?.storage?.account],
    ['storage.container', manifest?.storage?.container, expected?.storage?.container],
  ]) {
    if (actual !== trusted) errors.push(`manifest.${path} does not match the trusted expected identity`);
  }
}

function validateExpected(expected, errors) {
  if (!isRecord(expected)) {
    errors.push('expected trusted identity is required');
    return;
  }
  if (!repositoryPattern.test(expected.repository ?? '')) errors.push('expected.repository must use owner/name format');
  if (!shaPattern.test(expected.sourceRef ?? ''))
    errors.push('expected.sourceRef must be a lowercase 40-character SHA');
  validateBundleIdentity(expected.originalBundle, 'expected.originalBundle', errors);
  validateAcceptance(expected.acceptance, 'expected.acceptance', errors);
  validateStorage(expected.storage, 'expected.storage', errors);
}

function validateBundleIdentity(value, path, errors) {
  if (!positiveInteger(value?.runId)) errors.push(`${path}.runId must be a positive integer`);
  if (!correlationPattern.test(value?.correlation ?? '')) errors.push(`${path}.correlation is invalid`);
}

function validateAcceptance(value, path, errors) {
  validateBundleIdentity(value, path, errors);
  if (value?.attempt !== 1) errors.push(`${path}.attempt must be 1`);
  if (!shaPattern.test(value?.controllerRef ?? ''))
    errors.push(`${path}.controllerRef must be a lowercase 40-character SHA`);
  if (!['promotion', 'recovery'].includes(value?.kind)) errors.push(`${path}.kind must be promotion or recovery`);
}

function validateStorage(value, path, errors) {
  if (!storageAccountPattern.test(value?.account ?? ''))
    errors.push(`${path}.account must be an Azure storage account name`);
  if (value?.container !== 'function-releases') errors.push(`${path}.container must be function-releases`);
}

function exactKeys(value, expectedKeys, path, errors) {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    errors.push(`${path} must contain only: ${expectedKeys.join(', ')}`);
  }
}

function parseJson(bytes, file, errors) {
  if (!bytes) return null;
  try {
    return JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    errors.push(`${file} must contain valid JSON`);
    return null;
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
