import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { verifyReleaseArtifacts } from '../verify-release-artifacts.mjs';

const sourceRef = 'a'.repeat(40);
const files = {
  functionapp: { file: 'functionapp.zip', body: 'function' },
  frontend: { file: 'frontend.tar.gz', body: 'frontend' },
  sbom: { file: 'sbom.cdx.json', body: '{"bomFormat":"CycloneDX"}' },
};

test('release artifact verification binds exact filenames, digests, and source SHA', async (context) => {
  const directory = await createFixture(context);
  const result = await verifyReleaseArtifacts(directory, sourceRef);
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test('release artifact verification rejects tampering, source mismatch, and unexpected files', async (context) => {
  const directory = await createFixture(context, {
    sourceRef: 'b'.repeat(40),
    extraArtifact: {
      file: '../outside',
      sha256: '0'.repeat(64),
    },
  });
  await writeFile(join(directory, files.functionapp.file), 'tampered');

  const result = await verifyReleaseArtifacts(directory, sourceRef);
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes('release manifest sourceRef does not match the deployment source'));
  assert.ok(result.errors.includes('functionapp artifact digest does not match'));
  assert.ok(result.errors.includes('unexpected artifact: extra'));
});

test('release artifact verification rejects renamed and missing required artifacts', async (context) => {
  const directory = await createFixture(context, {
    artifactOverrides: {
      functionapp: {
        file: '../functionapp.zip',
        sha256: digest(files.functionapp.body),
      },
      sbom: undefined,
    },
  });

  const result = await verifyReleaseArtifacts(directory, sourceRef);
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes('functionapp artifact filename is invalid'));
  assert.ok(result.errors.includes('missing required artifact: sbom'));
});

async function createFixture(context, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'juez-release-test-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const artifacts = {};
  for (const [name, file] of Object.entries(files)) {
    await writeFile(join(directory, file.file), file.body);
    artifacts[name] = { file: file.file, sha256: digest(file.body) };
  }
  for (const [name, override] of Object.entries(options.artifactOverrides ?? {})) {
    if (override === undefined) delete artifacts[name];
    else artifacts[name] = override;
  }
  if (options.extraArtifact) artifacts.extra = options.extraArtifact;
  await writeFile(
    join(directory, 'release-manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      sourceRef: options.sourceRef ?? sourceRef,
      artifacts,
    }),
  );
  return directory;
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}
