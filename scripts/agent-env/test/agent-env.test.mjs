import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePort, owned, redact, worktreeId } from '../core.mjs';
test('worktree id is stable and ports probe around collisions', async () => {
  assert.match(worktreeId, /^[a-f0-9]{12}$/);
  const p = await freePort(19000);
  const server = createServer().listen(p, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  assert.notEqual(await freePort(p), p);
  await new Promise((r) => server.close(r));
});
test('structured log sanitizer removes secrets and URL query values', () => {
  const value = redact('GET https://x.test/a?token=secretvalue123 Bearer abcdefghijklmnop');
  assert.doesNotMatch(value, /secretvalue123|abcdefghijklmnop/);
});
test('ownership rejects stale and unrelated processes', () => {
  assert.equal(owned({ pid: process.pid, marker: 'wrong' }, { root: '/definitely/not/the/root' }), false);
  assert.equal(owned({ pid: 99999999, marker: 'x' }, { root: process.cwd() }), false);
});
test('runtime manifests contain no environment or credentials', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-env-test-'));
  const manifest = { worktreeId, root: dir, urls: { api: 'http://127.0.0.1:1' }, processes: {}, readiness: 'ready' };
  const text = JSON.stringify(manifest);
  assert.doesNotMatch(text, /TOKEN|PASSWORD|SECRET|CODEX_HOME/);
  writeFileSync(join(dir, 'manifest.json'), text);
});
