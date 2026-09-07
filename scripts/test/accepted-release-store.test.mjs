import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ACCEPTED_RELEASE_ARCHIVE_FILES } from '../accepted-release-archive.mjs';
import {
  expectedArchiveFromSelection,
  prepareAcceptedArchive,
  publishAcceptedArchive,
  restoreAcceptedArchive,
} from '../accepted-release-store.mjs';

const sourceRef = 'a'.repeat(40);
const otherSource = 'c'.repeat(40);
const manifestName = 'accepted-release-manifest.json';
const attestationName = 'accepted-release-attestation.json';

test('prepare rejects an incomplete accepted ledger before opening any upload', async (context) => {
  const fixture = await createFixture(context);
  const store = new VersionedContainer();
  const failedLedger = { ...fixture.ledger, telemetryCheckResult: { status: 'failed' } };
  await writeFile(join(fixture.directory, 'release-ledger-prod.json'), JSON.stringify(failedLedger));

  await assert.rejects(
    prepareAcceptedArchive({ container: store, directory: fixture.directory, expected: fixture.expected }),
    /telemetryCheckResult.status must be passed/,
  );
  assert.deepEqual(store.uploads, []);
});

test('prepare uses immutable create and rejects an exact-version readback corruption', async (context) => {
  const fixture = await createFixture(context);
  const store = new VersionedContainer({ corruptExactReadback: true });

  await assert.rejects(
    prepareAcceptedArchive({ container: store, directory: fixture.directory, expected: fixture.expected }),
    /readback does not match/,
  );
  assert.equal(store.uploads.length, 1);
  assert.deepEqual(store.uploads[0].options, { conditions: { ifNoneMatch: '*' } });
  assert.match(store.reads[0], /@v0001$/);
  assert.ok(store.reads.every((read) => !read.endsWith('@')));
});

test('publish verifies cryptographic provenance before parsing, downloading, or writing and fails without writes', async (context) => {
  const fixture = await preparedFixture(context);
  const events = fixture.store.events;
  const verifierFailure = async () => {
    events.push('verify');
    throw new Error('attestation rejected');
  };

  await assert.rejects(
    publishAcceptedArchive({
      container: fixture.store,
      expected: fixture.expected,
      manifestBytes: Buffer.from(JSON.stringify(fixture.manifest)),
      attestationBytes: Buffer.from('attestation'),
      verifyAttestation: verifierFailure,
    }),
    /attestation rejected/,
  );
  assert.deepEqual(events, ['verify']);
  assert.deepEqual(fixture.store.uploads, []);
});

test('publish reads only versioned archive objects and publishes the signed manifest last', async (context) => {
  const fixture = await preparedFixture(context);
  const manifestBytes = Buffer.from(JSON.stringify(fixture.manifest));
  const attestationBytes = Buffer.from('attestation');
  fixture.store.events.length = 0;
  fixture.store.uploads.length = 0;

  const result = await publishAcceptedArchive({
    container: fixture.store,
    expected: fixture.expected,
    manifestBytes,
    attestationBytes,
    verifyAttestation: async () => fixture.store.events.push('verify'),
  });

  assert.deepEqual(result, { status: 'archived', sourceRef, acceptanceRunId: 101 });
  const firstRead = fixture.store.events.findIndex((event) => event.startsWith('read:'));
  const firstUpload = fixture.store.events.findIndex((event) => event.startsWith('upload:'));
  assert.equal(fixture.store.events[0], 'verify');
  assert.ok(firstRead > 0 && firstUpload > firstRead);
  assert.equal(fixture.store.uploads.at(-1).name, `${fixture.prefix}${manifestName}`);
  assert.equal(fixture.store.uploads.at(-2).name, `${fixture.prefix}${attestationName}`);
  assert.ok(fixture.store.reads.every((read) => /@v\d+$/.test(read)));
});

test('a lost manifest response and identical replay reconcile without overwriting accepted bytes', async (context) => {
  const fixture = await preparedFixture(context);
  fixture.store.loseResponseFor = (name) => name.endsWith(manifestName);
  const input = {
    container: fixture.store,
    expected: fixture.expected,
    manifestBytes: Buffer.from(JSON.stringify(fixture.manifest)),
    attestationBytes: Buffer.from('attestation'),
    verifyAttestation: async () => {},
  };
  assert.equal((await publishAcceptedArchive(input)).status, 'archived');
  const firstVersions = fixture.store.nextVersion;
  assert.equal((await publishAcceptedArchive(input)).status, 'archived');
  assert.equal(fixture.store.nextVersion, firstVersions);
  assert.equal(fixture.store.uploads.length, 2);
});

test('conflicting pre-existing archive bytes never become an accepted retry', async (context) => {
  const fixture = await createFixture(context);
  const store = new VersionedContainer();
  const blob = `${archivePrefix(fixture.expected)}functionapp.zip`;
  store.seed(blob, Buffer.from('conflicting prior upload'));
  await assert.rejects(
    prepareAcceptedArchive({ container: store, directory: fixture.directory, expected: fixture.expected }),
    /readback does not match/,
  );
  assert.deepEqual(store.uploads, []);
  assert.equal(store.objects.get(blob).get('current').toString(), 'conflicting prior upload');
});

test('a partially staged promotion cannot collide with recovery in the same controller run', async (context) => {
  const promotion = await createFixture(context);
  const store = new VersionedContainer({ corruptExactReadback: true });
  await assert.rejects(
    prepareAcceptedArchive({ container: store, directory: promotion.directory, expected: promotion.expected }),
    /readback does not match/,
  );
  store.corruptExactReadback = false;
  const recovery = await createFixture(context, {
    kind: 'recovery',
    releaseSource: otherSource,
    controllerRef: sourceRef,
    acceptanceRunId: 101,
    originalRunId: 99,
  });
  const manifest = await prepareAcceptedArchive({
    container: store,
    directory: recovery.directory,
    expected: recovery.expected,
  });
  const result = await publishAcceptedArchive({
    container: store,
    expected: recovery.expected,
    manifestBytes: Buffer.from(JSON.stringify(manifest)),
    attestationBytes: Buffer.from('recovery attestation'),
    verifyAttestation: async () => {},
  });
  assert.equal(result.status, 'archived');
  assert.equal(result.sourceRef, otherSource);
  assert.ok(store.objects.has(`${archivePrefix(promotion.expected)}functionapp.zip`));
  assert.ok(store.objects.has(`${archivePrefix(recovery.expected)}functionapp.zip`));
  assert.notEqual(archivePrefix(promotion.expected), archivePrefix(recovery.expected));
  assert.equal(promotion.expected.acceptance.runId, recovery.expected.acceptance.runId);
  assert.equal(promotion.expected.acceptance.controllerRef, recovery.expected.acceptance.controllerRef);
});

test('restore verifies before fetching archive file bytes and never falls back to unversioned file objects', async (context) => {
  const fixture = await publishedFixture(context);
  fixture.store.events.length = 0;
  fixture.store.reads.length = 0;

  const restored = await restoreAcceptedArchive({
    container: fixture.store,
    expected: fixture.expected,
    verifyAttestation: async () => fixture.store.events.push('verify'),
  });

  assert.deepEqual(restored, fixture.fileBytes);
  const verifyAt = fixture.store.events.indexOf('verify');
  const firstFileRead = fixture.store.events.findIndex((event) => event.includes('functionapp.zip'));
  assert.ok(verifyAt >= 0 && firstFileRead > verifyAt);
  assert.ok(fixture.store.reads.filter(isArchiveFileRead).every((read) => /@v\d+$/.test(read)));
});

test('restore rejects a signed manifest modified after signing', async (context) => {
  const fixture = await publishedFixture(context);
  const modified = { ...fixture.manifest, sourceRef: otherSource };
  fixture.store.seed(`${fixture.prefix}${manifestName}`, Buffer.from(JSON.stringify(modified)));
  fixture.store.events.length = 0;

  await assert.rejects(
    restoreAcceptedArchive({
      container: fixture.store,
      expected: fixture.expected,
      verifyAttestation: async () => fixture.store.events.push('verify'),
    }),
    /sourceRef does not match the trusted expected identity/,
  );
  assert.ok(
    fixture.store.events.indexOf('verify') <
      fixture.store.events.findIndex((event) => event.includes('functionapp.zip')),
  );
});

test('restore rejects changed exact-version bytes even if the signed manifest is accepted', async (context) => {
  const fixture = await publishedFixture(context);
  const entry = fixture.manifest.files.find(({ file }) => file === 'functionapp.zip');
  fixture.store.overwriteVersion(entry.blob, entry.versionId, Buffer.from('changed exact-version byte'));

  await assert.rejects(
    restoreAcceptedArchive({
      container: fixture.store,
      expected: fixture.expected,
      verifyAttestation: async () => {},
    }),
    /functionapp.zip (?:size|digest) does not match/,
  );
});

test('restore rejects signed archive coordinates for another acceptance run before fetching archive files', async (context) => {
  const fixture = await publishedFixture(context);
  const wrongRun = 999;
  const altered = structuredClone(fixture.manifest);
  altered.acceptance.runId = wrongRun;
  altered.files = altered.files.map((entry) => ({
    ...entry,
    blob: `accepted/${fixture.expected.acceptance.controllerRef}/${wrongRun}/1/promotion/${entry.file}`,
  }));
  fixture.store.seed(`${fixture.prefix}${manifestName}`, Buffer.from(JSON.stringify(altered)));
  fixture.store.events.length = 0;

  await assert.rejects(
    restoreAcceptedArchive({
      container: fixture.store,
      expected: fixture.expected,
      verifyAttestation: async () => fixture.store.events.push('verify'),
    }),
    /Archive file coordinates are invalid/,
  );
  assert.equal(fixture.store.events.includes('verify'), true);
  assert.equal(fixture.store.events.some(isArchiveFileRead), false);
});

test('expected archive coordinates derive from the installed receipt, not self-reported selection or manifest fields', () => {
  const selected = {
    sourceRef,
    runId: 101,
    correlation: 'release-101-original',
    acceptanceRunId: 202,
    acceptanceCorrelation: 'recovery-202-verified',
    acceptanceKind: 'recovery',
    controllerRef: otherSource,
    manifest: { acceptance: { controllerRef: otherSource, runId: 999 } },
  };
  const observation = {
    ok: true,
    state: 'coherent',
    identity: {
      sourceRef,
      runId: '101',
      deliveryCorrelation: 'release-101-original',
      mutationReceipt: {
        recorded: true,
        runId: '202',
        correlation: 'recovery-202-verified',
        kind: 'recovery',
        controllerRef: 'b'.repeat(40),
      },
    },
  };
  const resource = { releaseStorageAccountName: 'juezreleasesprod' };

  const expected = expectedArchiveFromSelection({ selected, observation, resource, repository: 'JueZ/api' });
  assert.equal(expected.acceptance.controllerRef, 'b'.repeat(40));
  assert.equal(expected.acceptance.runId, 202);
  for (const change of [
    { sourceRef: otherSource },
    { runId: 303 },
    { correlation: 'other-correlation' },
    { acceptanceRunId: 404 },
    { acceptanceCorrelation: 'other-acceptance' },
    { acceptanceKind: 'promotion' },
  ]) {
    assert.throws(
      () =>
        expectedArchiveFromSelection({
          selected: { ...selected, ...change },
          observation,
          resource,
          repository: 'JueZ/api',
        }),
      /does not match the installed production receipt/,
    );
  }
});

async function preparedFixture(context) {
  const fixture = await createFixture(context);
  const store = new VersionedContainer();
  const manifest = await prepareAcceptedArchive({
    container: store,
    directory: fixture.directory,
    expected: fixture.expected,
  });
  store.events.length = 0;
  store.uploads.length = 0;
  return { ...fixture, store, manifest, prefix: archivePrefix(fixture.expected) };
}

async function publishedFixture(context) {
  const fixture = await preparedFixture(context);
  fixture.store.seed(`${fixture.prefix}${manifestName}`, Buffer.from(JSON.stringify(fixture.manifest)));
  fixture.store.seed(`${fixture.prefix}${attestationName}`, Buffer.from('attestation'));
  return fixture;
}

async function createFixture(
  context,
  {
    kind = 'promotion',
    releaseSource = sourceRef,
    controllerRef = releaseSource,
    acceptanceRunId = 101,
    originalRunId = acceptanceRunId,
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'accepted-release-store-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const bodies = {
    'functionapp.zip': Buffer.from(`function package ${releaseSource}`),
    'frontend.tar.gz': Buffer.from('rendered frontend'),
    'sbom.cdx.json': Buffer.from('{"bomFormat":"CycloneDX"}'),
  };
  const acceptance = {
    runId: acceptanceRunId,
    attempt: 1,
    correlation: kind === 'promotion' ? `release-${acceptanceRunId}-original` : `recovery-${acceptanceRunId}-verified`,
    controllerRef,
    kind,
  };
  const ledger = {
    environment: 'prod',
    deployedCommit: releaseSource,
    sourceRef: releaseSource,
    workflowRunId: String(acceptanceRunId),
    deliveryCorrelation: acceptance.correlation,
    functionAppName: 'juez-prod-api',
    apiBaseUrl: 'https://juez-prod-api.azurewebsites.net',
    artifacts: Object.fromEntries(
      Object.entries({ functionapp: 'functionapp.zip', frontend: 'frontend.tar.gz', sbom: 'sbom.cdx.json' }).map(
        ([name, file]) => [`${name}Sha256`, digest(bodies[file])],
      ),
    ),
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
              sourceRef: releaseSource,
              runId: String(originalRunId),
              correlation: `release-${originalRunId}-original`,
            },
          },
        }
      : {}),
  };
  const releaseManifest = {
    schemaVersion: 1,
    sourceRef: releaseSource,
    artifacts: Object.fromEntries(
      Object.entries({ functionapp: 'functionapp.zip', frontend: 'frontend.tar.gz', sbom: 'sbom.cdx.json' }).map(
        ([name, file]) => [name, { file, sha256: digest(bodies[file]) }],
      ),
    ),
  };
  for (const [file, bytes] of Object.entries(bodies)) await writeFile(join(directory, file), bytes);
  await writeFile(join(directory, 'release-manifest.json'), JSON.stringify(releaseManifest));
  await writeFile(join(directory, 'release-ledger-prod.json'), JSON.stringify(ledger));
  const fileBytes = Object.fromEntries(
    await Promise.all(
      ACCEPTED_RELEASE_ARCHIVE_FILES.map(async (file) => [file, await readFile(join(directory, file))]),
    ),
  );
  return {
    directory,
    ledger,
    fileBytes,
    expected: {
      repository: 'JueZ/api',
      sourceRef: releaseSource,
      originalBundle: { runId: originalRunId, correlation: `release-${originalRunId}-original` },
      acceptance,
      storage: { account: 'juezreleasesprod', container: 'function-releases' },
    },
  };
}

class VersionedContainer {
  constructor({ corruptExactReadback = false, loseResponseFor = () => false } = {}) {
    this.corruptExactReadback = corruptExactReadback;
    this.loseResponseFor = loseResponseFor;
    this.objects = new Map();
    this.events = [];
    this.uploads = [];
    this.reads = [];
    this.nextVersion = 1;
  }

  getBlockBlobClient(name) {
    return this.client(name, undefined, true);
  }

  getBlobClient(name) {
    return this.client(name, undefined, false);
  }

  seed(name, bytes) {
    this.objects.set(name, new Map([['current', Buffer.from(bytes)]]));
  }

  overwriteVersion(name, version, bytes) {
    this.objects.get(name).set(version, Buffer.from(bytes));
  }

  client(name, version, writable) {
    return {
      withVersion: (nextVersion) => this.client(name, nextVersion, false),
      uploadData: async (bytes, options) => {
        assert.equal(writable, true, 'only block clients upload');
        assert.deepEqual(options, { conditions: { ifNoneMatch: '*' } });
        if (this.objects.has(name)) throw new Error('immutable object already exists');
        const nextVersion = `v${String(this.nextVersion++).padStart(4, '0')}`;
        this.objects.set(name, new Map([[nextVersion, Buffer.from(bytes)]]));
        this.uploads.push({ name, options });
        this.events.push(`upload:${name}@${nextVersion}`);
        if (this.loseResponseFor(name)) throw new Error('response lost after immutable write');
        return { versionId: nextVersion };
      },
      getProperties: async () => {
        const versionId = version ?? this.objects.get(name)?.keys().next().value;
        const bytes = this.bytes(name, versionId);
        return { contentLength: bytes.byteLength, versionId };
      },
      downloadToBuffer: async () => {
        const bytes = this.bytes(name, version);
        this.reads.push(`${name}@${version ?? 'current'}`);
        this.events.push(`read:${name}@${version ?? 'current'}`);
        if (this.corruptExactReadback && version)
          return Buffer.from(bytes.map((value, index) => (index === 0 ? value ^ 1 : value)));
        return Buffer.from(bytes);
      },
    };
  }

  bytes(name, version) {
    if (ACCEPTED_RELEASE_ARCHIVE_FILES.some((file) => name.endsWith(`/${file}`)) && !version) {
      throw new Error('archive file objects require an immutable version');
    }
    const bytes = this.objects.get(name)?.get(version ?? 'current');
    if (!bytes) throw new Error(`missing object ${name}@${version ?? 'current'}`);
    return bytes;
  }
}

function archivePrefix(expected) {
  return `accepted/${expected.acceptance.controllerRef}/${expected.acceptance.runId}/1/${expected.acceptance.kind}/`;
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function isArchiveFileRead(value) {
  return ACCEPTED_RELEASE_ARCHIVE_FILES.some((file) => value.includes(`/${file}@`));
}
