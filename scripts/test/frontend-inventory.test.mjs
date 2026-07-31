import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  compareFrontendInventories,
  compareFrontendNames,
  createFrontendInventory,
  planStaleFrontendBlobs,
  validateBlobName,
} from '../frontend-inventory.mjs';

test('frontend inventory is deterministic and binds every file name, size, and digest', async (context) => {
  const directory = await createFrontendFixture(context);
  const inventory = await createFrontendInventory(directory);

  assert.deepEqual(
    inventory.files.map(({ name, size }) => ({ name, size })),
    [
      { name: 'assets/app.js', size: 19 },
      { name: 'index.html', size: 15 },
    ],
  );
  assert.match(inventory.files[0].sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(await createFrontendInventory(directory), inventory);
});

test('frontend inventory comparison rejects missing, stale, and tampered deployed files', async (context) => {
  const expectedDirectory = await createFrontendFixture(context);
  const actualDirectory = await createFrontendFixture(context, 'actual');
  await writeFile(join(actualDirectory, 'assets', 'app.js'), 'tampered');
  await rm(join(actualDirectory, 'index.html'));
  await writeFile(join(actualDirectory, 'stale.js'), 'stale');

  const expected = await createFrontendInventory(expectedDirectory);
  const actual = await createFrontendInventory(actualDirectory);
  const result = compareFrontendInventories(expected, actual);

  assert.equal(result.ok, false);
  assert.ok(result.errors.includes('missing deployed frontend blob: index.html'));
  assert.ok(result.errors.includes('unexpected deployed frontend blob: stale.js'));
  assert.ok(result.errors.includes('deployed frontend blob size does not match: assets/app.js'));
  assert.ok(result.errors.includes('deployed frontend blob digest does not match: assets/app.js'));
});

test('stale-blob planning deletes only names absent from the approved inventory', async (context) => {
  const directory = await createFrontendFixture(context);
  const inventory = await createFrontendInventory(directory);
  const actualNames = [
    'old-worker.js',
    'index.html',
    'assets/old chunk.js',
    'assets/app.js',
    'legacy\\asset.js',
    '../legacy.js',
  ];

  assert.deepEqual(planStaleFrontendBlobs(inventory, actualNames), [
    '../legacy.js',
    'assets/old chunk.js',
    'legacy\\asset.js',
    'old-worker.js',
  ]);
  assert.deepEqual(compareFrontendNames(inventory, actualNames).errors, [
    'unexpected deployed frontend blob: ../legacy.js',
    'unexpected deployed frontend blob: assets/old chunk.js',
    'unexpected deployed frontend blob: legacy\\asset.js',
    'unexpected deployed frontend blob: old-worker.js',
  ]);
});

test('frontend inventory rejects symbolic links and unsafe blob names', async (context) => {
  const directory = await createFrontendFixture(context);
  await symlink(join(directory, 'index.html'), join(directory, 'linked.html'));

  await assert.rejects(createFrontendInventory(directory), /must not be a symbolic link: linked\.html/);
  for (const name of ['', '/root', 'trailing/', '../escape', 'a//b', 'a\\b', 'line\nfeed']) {
    assert.throws(() => validateBlobName(name), /frontend blob name|unsafe frontend blob name/);
  }
});

async function createFrontendFixture(context, suffix = 'expected') {
  const directory = await mkdtemp(join(tmpdir(), `juez-frontend-${suffix}-`));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'assets'));
  await writeFile(join(directory, 'index.html'), '<main>ok</main>');
  await writeFile(join(directory, 'assets', 'app.js'), 'console.log("ok");\n');
  return directory;
}
