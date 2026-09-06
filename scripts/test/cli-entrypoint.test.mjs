import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

test('CLI entry guard handles native paths and URL characters without executing on import', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cli entry # % '));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const script = join(directory, 'validate-release-ledger.mjs');
  copyFileSync(new URL('../validate-release-ledger.mjs', import.meta.url), script);

  for (const entry of [script, './validate-release-ledger.mjs']) {
    const result = spawnSync(process.execPath, [entry], {
      cwd: directory,
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stderr, /Usage: node scripts\/validate-release-ledger.mjs/);
  }

  const imported = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `await import(${JSON.stringify(pathToFileURL(script).href)}); console.log('imported');`,
    ],
    { cwd: directory, encoding: 'utf8', timeout: 10_000 },
  );
  assert.equal(imported.status, 0, imported.stdout + imported.stderr);
  assert.equal(imported.stdout.trim(), 'imported');
  assert.equal(imported.stderr, '');
});
