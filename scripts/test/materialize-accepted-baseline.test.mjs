import assert from 'node:assert/strict';
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { materializeAcceptedBaseline } from '../materialize-accepted-baseline.mjs';

const releaseFiles = {
  'frontend.tar.gz': Buffer.from('frontend archive'),
  'functionapp.zip': Buffer.from('function archive'),
  'release-manifest.json': Buffer.from('{"schemaVersion":1}'),
  'sbom.cdx.json': Buffer.from('{"bomFormat":"CycloneDX"}'),
};
const ledgerBytes = Buffer.from('{"environment":"prod"}');
const baselineBytes = Buffer.from(
  '{"schemaVersion":1,"status":"accepted","sourceRef":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}',
);

test('materializes a complete accepted transfer by copying every exact filesystem byte', async (context) => {
  const fixture = await createFixture(context, { bundled: true });

  assert.deepEqual(
    await materializeAcceptedBaseline({ transferDirectory: fixture.transfer, outputDirectory: fixture.output }),
    { bundled: true },
  );
  assert.deepEqual((await readdir(fixture.output)).sort(), [
    'accepted-baseline',
    'accepted-ledger',
    'accepted-release',
  ]);
  assert.deepEqual(await readFile(join(fixture.output, 'accepted-baseline', 'accepted-baseline.json')), baselineBytes);
  for (const [file, bytes] of Object.entries(releaseFiles)) {
    assert.deepEqual(await readFile(join(fixture.output, 'accepted-release', file)), bytes);
  }
  assert.deepEqual(await readFile(join(fixture.output, 'accepted-ledger', 'release-ledger-prod.json')), ledgerBytes);
});

test('materializes a legacy identity-only transfer without inventing release bytes', async (context) => {
  const fixture = await createFixture(context, { bundled: false });

  assert.deepEqual(
    await materializeAcceptedBaseline({ transferDirectory: fixture.transfer, outputDirectory: fixture.output }),
    { bundled: false },
  );
  assert.deepEqual((await readdir(fixture.output)).sort(), ['accepted-baseline']);
  assert.deepEqual(await readFile(join(fixture.output, 'accepted-baseline', 'accepted-baseline.json')), baselineBytes);
});

test('missing, extra, or substituted transfer directories fail before any output write', async (context) => {
  const cases = [
    {
      name: 'missing ledger directory',
      mutate: async (transfer) => rm(join(transfer, 'ledger'), { recursive: true, force: true }),
    },
    {
      name: 'unexpected top-level entry',
      mutate: async (transfer) => writeFile(join(transfer, 'unexpected'), 'extra'),
    },
    {
      name: 'release directory replaced by a regular file',
      mutate: async (transfer) => {
        await rm(join(transfer, 'release'), { recursive: true, force: true });
        await writeFile(join(transfer, 'release'), 'not a directory');
      },
    },
    {
      name: 'unexpected release entry',
      mutate: async (transfer) => writeFile(join(transfer, 'release', 'unexpected'), 'extra'),
    },
  ];

  for (const scenario of cases) {
    const fixture = await createFixture(context, { bundled: true });
    await scenario.mutate(fixture.transfer);
    await assert.rejects(
      materializeAcceptedBaseline({ transferDirectory: fixture.transfer, outputDirectory: fixture.output }),
      /Baseline transfer (?:directory|layout) is invalid/,
      scenario.name,
    );
    assert.deepEqual(await readdir(fixture.output), [], `${scenario.name} wrote output before rejection`);
  }
});

test('a Windows directory junction in the transfer is rejected before any output write', async (context) => {
  const fixture = await createFixture(context, { bundled: true });
  const target = join(fixture.root, 'release-target');
  await mkdir(target);
  for (const [file, bytes] of Object.entries(releaseFiles)) await writeFile(join(target, file), bytes);
  await rm(join(fixture.transfer, 'release'), { recursive: true, force: true });
  try {
    await symlink(target, join(fixture.transfer, 'release'), 'junction');
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES')
      return context.skip('directory junctions are unavailable to this user');
    throw error;
  }

  await assert.rejects(
    materializeAcceptedBaseline({ transferDirectory: fixture.transfer, outputDirectory: fixture.output }),
    /Baseline transfer directory is invalid/,
  );
  assert.deepEqual(await readdir(fixture.output), []);
});

test('an existing destination is refused without replacing its contents', async (context) => {
  const fixture = await createFixture(context, { bundled: true });
  const destination = join(fixture.output, 'accepted-baseline');
  await mkdir(destination);
  await writeFile(join(destination, 'existing.json'), 'preserve me');

  await assert.rejects(
    materializeAcceptedBaseline({ transferDirectory: fixture.transfer, outputDirectory: fixture.output }),
    /EEXIST/,
  );
  assert.deepEqual(await readFile(join(destination, 'existing.json'), 'utf8'), 'preserve me');
  assert.equal(await exists(join(fixture.output, 'accepted-release')), false);
  assert.equal(await exists(join(fixture.output, 'accepted-ledger')), false);
});

async function createFixture(context, { bundled }) {
  const root = await mkdtemp(join(tmpdir(), 'materialize-accepted-baseline-'));
  const transfer = join(root, 'transfer');
  const output = join(root, 'output');
  await mkdir(transfer);
  await mkdir(output);
  await writeFile(join(transfer, 'accepted-baseline.json'), baselineBytes);
  if (bundled) {
    await mkdir(join(transfer, 'release'));
    await mkdir(join(transfer, 'ledger'));
    for (const [file, bytes] of Object.entries(releaseFiles)) await writeFile(join(transfer, 'release', file), bytes);
    await writeFile(join(transfer, 'ledger', 'release-ledger-prod.json'), ledgerBytes);
  }
  context.after(() => rm(root, { recursive: true, force: true }));
  return { root, transfer, output };
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}
