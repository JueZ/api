import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  ACCEPTED_RELEASE_ARCHIVE_FILES,
  createAcceptedReleaseArchiveManifest,
  validateAcceptedReleaseArchiveManifest,
} from '../accepted-release-archive.mjs';

const sourceRef = 'a'.repeat(40);
const recoveryController = 'b'.repeat(40);
const otherSource = 'c'.repeat(40);

test('creates the canonical five-file manifest for a normal accepted promotion', async (context) => {
  const fixture = await createFixture(context);
  const result = await createAcceptedReleaseArchiveManifest(fixture.createInput);

  assert.deepEqual(Object.keys(result), ['ok', 'errors', 'manifest']);
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(
    result.manifest.files.map(({ file }) => file),
    ACCEPTED_RELEASE_ARCHIVE_FILES,
  );
  assert.ok(result.manifest.files.every(({ file, blob }) => blob.endsWith(`/1/promotion/${file}`)));
  assert.deepEqual(
    validateAcceptedReleaseArchiveManifest({
      manifest: result.manifest,
      expected: fixture.expected,
      fileBytes: fixture.fileBytes,
    }),
    { ok: true, errors: [] },
  );
});

test('accepts a restored old bundle only when recovery acceptance and ledger bind it exactly', async (context) => {
  const fixture = await createFixture(context, { kind: 'recovery' });
  const result = await createAcceptedReleaseArchiveManifest(fixture.createInput);

  assert.equal(result.ok, true);
  assert.equal(result.manifest.sourceRef, sourceRef);
  assert.deepEqual(result.manifest.originalBundle, { runId: 101, correlation: 'release-101-original' });
  assert.deepEqual(result.manifest.acceptance, {
    runId: 202,
    attempt: 1,
    correlation: 'recovery-202-verified',
    controllerRef: recoveryController,
    kind: 'recovery',
  });
  assert.ok(
    result.manifest.files.every(({ blob }) => blob.startsWith(`accepted/${recoveryController}/202/1/recovery/`)),
  );
});

test('rejects changed bundle bytes and an internally rehashed failed acceptance ledger', async (context) => {
  const bundle = await createFixture(context);
  await writeFile(join(bundle.directory, 'functionapp.zip'), 'tampered function package');
  const bundleResult = await createAcceptedReleaseArchiveManifest({
    ...bundle.createInput,
    uploads: await uploadsFor(bundle.directory, bundle.createInput.acceptance),
  });
  assert.equal(bundleResult.ok, false);
  assert.match(bundleResult.errors.join('\n'), /functionapp.zip digest does not match the release manifest/);

  const ledgerFixture = await createFixture(context);
  const validLedgerArchive = await createAcceptedReleaseArchiveManifest(ledgerFixture.createInput);
  const failedLedger = { ...ledgerFixture.ledger, telemetryCheckResult: { status: 'failed' } };
  await writeFile(join(ledgerFixture.directory, 'release-ledger-prod.json'), JSON.stringify(failedLedger));
  const ledgerResult = await createAcceptedReleaseArchiveManifest({
    ...ledgerFixture.createInput,
    uploads: await uploadsFor(ledgerFixture.directory, ledgerFixture.createInput.acceptance),
  });
  assert.equal(ledgerResult.ok, false);
  assert.ok(ledgerResult.errors.includes('Release ledger telemetryCheckResult.status must be passed'));

  const malformed = replaceJsonFile(
    validLedgerArchive.manifest,
    ledgerFixture.fileBytes,
    'release-ledger-prod.json',
    [],
  );
  const malformedResult = validateAcceptedReleaseArchiveManifest({
    ...malformed,
    expected: ledgerFixture.expected,
  });
  assert.equal(malformedResult.ok, false);
  assert.ok(malformedResult.errors.includes('release-ledger-prod.json must contain a JSON object'));
});

test('rejects unknown files, external or traversing blobs, invalid versions, and wrong storage', async (context) => {
  const fixture = await createFixture(context);
  const created = await createAcceptedReleaseArchiveManifest(fixture.createInput);
  const mutations = [
    {
      mutate(manifest) {
        manifest.files[0].file = 'other.zip';
      },
      error: /file must be functionapp.zip/,
    },
    {
      mutate(manifest) {
        manifest.files[0].blob = '../functionapp.zip';
      },
      error: /blob must use the accepted release prefix/,
    },
    {
      mutate(manifest) {
        manifest.files[0].blob = 'https://example.test/functionapp.zip';
      },
      error: /blob must use the accepted release prefix/,
    },
    {
      mutate(manifest) {
        manifest.files[0].versionId = '';
      },
      error: /versionId is invalid/,
    },
    {
      mutate(manifest) {
        manifest.files[1] = { ...manifest.files[0] };
      },
      error: /duplicate file|file must be frontend.tar.gz/,
    },
    {
      mutate(manifest) {
        manifest.storage = { account: 'https://storage.example', container: 'other' };
      },
      error: /storage.account|storage.container/,
    },
  ];

  for (const { mutate, error } of mutations) {
    const manifest = structuredClone(created.manifest);
    mutate(manifest);
    const result = validateAcceptedReleaseArchiveManifest({
      manifest,
      expected: fixture.expected,
      fileBytes: fixture.fileBytes,
    });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), error);
  }
});

test('rejects failed smoke or telemetry even when the ledger archive digest is self-consistent', async (context) => {
  const fixture = await createFixture(context);
  const created = await createAcceptedReleaseArchiveManifest(fixture.createInput);

  for (const key of ['smokeResults', 'authenticatedSmokeResults', 'telemetryCheckResult']) {
    const ledger = { ...fixture.ledger, [key]: { status: 'failed' } };
    const { manifest, fileBytes } = replaceJsonFile(
      created.manifest,
      fixture.fileBytes,
      'release-ledger-prod.json',
      ledger,
    );
    const result = validateAcceptedReleaseArchiveManifest({ manifest, expected: fixture.expected, fileBytes });
    assert.equal(result.ok, false);
    assert.ok(result.errors.includes(`Release ledger ${key}.status must be passed`));
  }
});

test('rejects the wrong recovery original-bundle identity', async (context) => {
  const fixture = await createFixture(context, { kind: 'recovery' });
  const created = await createAcceptedReleaseArchiveManifest(fixture.createInput);
  const ledger = structuredClone(fixture.ledger);
  ledger.recovery.originalBundle.runId = '999';
  const changed = replaceJsonFile(created.manifest, fixture.fileBytes, 'release-ledger-prod.json', ledger);
  const result = validateAcceptedReleaseArchiveManifest({
    ...changed,
    expected: fixture.expected,
  });

  assert.equal(result.ok, false);
  assert.ok(result.errors.includes('Recovery ledger does not bind the verified original bundle identity'));
});

test('a record for another source or acceptance cannot match trusted installed identity', async (context) => {
  const fixture = await createFixture(context, { kind: 'recovery' });
  const created = await createAcceptedReleaseArchiveManifest(fixture.createInput);
  const expected = {
    repository: 'JueZ/api',
    sourceRef: otherSource,
    originalBundle: { runId: 303, correlation: 'release-303-expected' },
    acceptance: {
      runId: 404,
      attempt: 1,
      correlation: 'recovery-404-expected',
      controllerRef: otherSource,
      kind: 'recovery',
    },
    storage: fixture.expected.storage,
  };
  const result = validateAcceptedReleaseArchiveManifest({
    manifest: created.manifest,
    expected,
    fileBytes: fixture.fileBytes,
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /sourceRef does not match the trusted expected identity/);
  assert.match(result.errors.join('\n'), /acceptance.controllerRef does not match the trusted expected identity/);
});

test('self-reported attestation or signature metadata is rejected rather than treated as proof', async (context) => {
  const fixture = await createFixture(context);
  const created = await createAcceptedReleaseArchiveManifest(fixture.createInput);
  const manifest = {
    ...created.manifest,
    attestationVerified: true,
    signature: { valid: true },
  };
  const result = validateAcceptedReleaseArchiveManifest({
    manifest,
    expected: fixture.expected,
    fileBytes: fixture.fileBytes,
  });

  assert.equal(result.ok, false);
  assert.ok(
    result.errors.includes(
      'manifest must contain only: schemaVersion, repository, sourceRef, originalBundle, acceptance, storage, files',
    ),
  );
});

async function createFixture(context, { kind = 'promotion' } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'accepted-release-archive-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const originalBundle = { runId: 101, correlation: 'release-101-original' };
  const acceptance =
    kind === 'recovery'
      ? {
          runId: 202,
          attempt: 1,
          correlation: 'recovery-202-verified',
          controllerRef: recoveryController,
          kind,
        }
      : {
          runId: originalBundle.runId,
          attempt: 1,
          correlation: originalBundle.correlation,
          controllerRef: sourceRef,
          kind,
        };
  const bodies = {
    'functionapp.zip': Buffer.from('function package'),
    'frontend.tar.gz': Buffer.from('rendered frontend'),
    'sbom.cdx.json': Buffer.from('{"bomFormat":"CycloneDX"}'),
  };
  const releaseManifest = {
    schemaVersion: 1,
    sourceRef,
    artifacts: {
      functionapp: { file: 'functionapp.zip', sha256: digest(bodies['functionapp.zip']) },
      frontend: { file: 'frontend.tar.gz', sha256: digest(bodies['frontend.tar.gz']) },
      sbom: { file: 'sbom.cdx.json', sha256: digest(bodies['sbom.cdx.json']) },
    },
  };
  const ledger = {
    environment: 'prod',
    deployedCommit: sourceRef,
    sourceRef,
    workflowRunId: String(acceptance.runId),
    deliveryCorrelation: acceptance.correlation,
    functionAppName: 'juez-prod-api',
    apiBaseUrl: 'https://juez-prod-api.azurewebsites.net',
    artifacts: {
      functionappSha256: digest(bodies['functionapp.zip']),
      frontendSha256: digest(bodies['frontend.tar.gz']),
      sbomSha256: digest(bodies['sbom.cdx.json']),
    },
    smokeRunId: 'smoke-accepted-1',
    smokeResults: { status: 'passed' },
    authenticatedSmokeResults: { status: 'passed' },
    telemetryCheckResult: { status: 'passed' },
    verifiedAt: '2026-09-07T00:00:00.000Z',
    ...(kind === 'recovery'
      ? {
          recovery: {
            status: 'verified',
            configurationUncertain: false,
            originalBundle: {
              sourceRef,
              runId: String(originalBundle.runId),
              correlation: originalBundle.correlation,
            },
          },
        }
      : {}),
  };
  for (const [file, bytes] of Object.entries(bodies)) await writeFile(join(directory, file), bytes);
  await writeFile(join(directory, 'release-manifest.json'), JSON.stringify(releaseManifest));
  await writeFile(join(directory, 'release-ledger-prod.json'), JSON.stringify(ledger));
  const storage = { account: 'juezreleasesprod', container: 'function-releases' };
  const fileBytes = await readArchiveBytes(directory);
  const createInput = {
    directory,
    repository: 'JueZ/api',
    sourceRef,
    originalBundle,
    acceptance,
    storage,
    uploads: await uploadsFor(directory, acceptance),
  };
  return {
    directory,
    ledger,
    fileBytes,
    createInput,
    expected: { repository: 'JueZ/api', sourceRef, originalBundle, acceptance, storage },
  };
}

async function uploadsFor(directory, acceptance) {
  const fileBytes = await readArchiveBytes(directory);
  return ACCEPTED_RELEASE_ARCHIVE_FILES.map((file, index) => ({
    file,
    blob: `accepted/${acceptance.controllerRef}/${acceptance.runId}/1/${acceptance.kind}/${file}`,
    versionId: `2026-09-07T00:00:0${index}.0000000Z`,
    sha256: digest(fileBytes[file]),
    size: fileBytes[file].byteLength,
  }));
}

async function readArchiveBytes(directory) {
  return Object.fromEntries(
    await Promise.all(
      ACCEPTED_RELEASE_ARCHIVE_FILES.map(async (file) => [file, await readFile(join(directory, file))]),
    ),
  );
}

function replaceJsonFile(manifest, fileBytes, file, value) {
  const bytes = Buffer.from(JSON.stringify(value));
  const nextManifest = structuredClone(manifest);
  const entry = nextManifest.files.find((candidate) => candidate.file === file);
  entry.sha256 = digest(bytes);
  entry.size = bytes.byteLength;
  return { manifest: nextManifest, fileBytes: { ...fileBytes, [file]: bytes } };
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}
