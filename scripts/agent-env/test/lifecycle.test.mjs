import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const core = new URL('../core.mjs', import.meta.url).href;
const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test(
  'services outlive the launcher, retain ownership/logs, and stop their descendants on both platforms',
  { timeout: 60000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent lifecycle space-'));
    const service = join(directory, 'fake service.mjs');
    const portFile = join(directory, 'port.json');
    const statusFile = join(directory, 'http-status');
    const foreignDirectory = mkdtempSync(join(tmpdir(), 'foreign agent lifecycle-'));
    writeFileSync(statusFile, '200');
    writeFileSync(
      service,
      `import { createServer } from 'node:http';
    import { readFileSync, writeFileSync } from 'node:fs';
    import { spawn } from 'node:child_process';
    const descendant = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000)"], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    descendant.once('message', () => server.listen(0, '127.0.0.1'));
    const server = createServer((req, res) => {
      res.statusCode = Number(readFileSync(process.argv[3], 'utf8')); res.end('ready');
    }).on('listening', () => {
      writeFileSync(process.argv[2], JSON.stringify({ port: server.address().port, descendant: descendant.pid }));
      process.stdout.write('Bearer abcdef');
      setTimeout(() => process.stdout.write('ghijklmnop\\n'), 25);
    });`,
    );
    function run(source, cwd = directory) {
      return spawnSync(process.execPath, ['--input-type=module', '-e', source], {
        cwd,
        encoding: 'utf8',
        timeout: 20000,
        windowsHide: true,
      });
    }
    const stop = `import { loadManifest, stopOwned } from ${JSON.stringify(core)}; const m = loadManifest(); if (m) stopOwned(m);`;
    try {
      const started = run(`import { saveManifest, spawnService, root, worktreeId } from ${JSON.stringify(core)};
      const m = { root, worktreeId, processes: {} }; saveManifest(m);
      m.processes.fake = spawnService('fake', process.execPath, [${JSON.stringify(service)}, ${JSON.stringify(portFile)}, ${JSON.stringify(statusFile)}], process.env, m);
      saveManifest(m);`);
      assert.equal(started.status, 0, started.stderr || started.error?.message);
      for (let attempt = 0; attempt < 100 && !existsSync(portFile); attempt++) await delay(100);
      const { port, descendant } = JSON.parse(readFileSync(portFile, 'utf8'));
      assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'ready');
      const checked = run(`import { loadManifest, owned } from ${JSON.stringify(core)};
      const m = loadManifest(); const p = m.processes.fake;
      console.log(JSON.stringify({ m, live: owned(p, m), stale: owned({ ...p, startTime: 'stale' }, m),
        unrelated: owned(p, { ...m, root: m.root + '-other' }) }));`);
      assert.equal(checked.status, 0, checked.stderr);
      const checkedState = JSON.parse(checked.stdout);
      assert.equal(checkedState.live, true);
      assert.equal(checkedState.stale, false);
      assert.equal(checkedState.unrelated, false);
      const log = readFileSync(checkedState.m.processes.fake.log, 'utf8');
      assert.match(log, /\[redacted\]/);
      assert.doesNotMatch(log, /abcdefghijklmnop/);
      const foreign = run(
        `import { owned, stopOwned } from ${JSON.stringify(core)};
        const m = ${JSON.stringify(checkedState.m)};
        console.log(JSON.stringify({ owned: owned(m.processes.fake, m) })); stopOwned(m);`,
        foreignDirectory,
      );
      assert.equal(foreign.status, 0, foreign.stderr);
      assert.equal(JSON.parse(foreign.stdout).owned, false);
      assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'ready');

      assert.equal(
        run(`import { loadManifest, saveManifest } from ${JSON.stringify(core)};
        const m = loadManifest(); const p = m.processes.fake;
        m.processes = { fixture: p, api: p, web: p }; m.readiness = 'ready';
        m.urls = { fixture: 'http://127.0.0.1:${port}', api: 'http://127.0.0.1:${port}', frontend: 'http://127.0.0.1:${port}' };
        saveManifest(m);`).status,
        0,
      );
      function status() {
        const response = spawnSync(process.execPath, [cli, 'status', '--json'], {
          cwd: directory,
          encoding: 'utf8',
          timeout: 20000,
          windowsHide: true,
        });
        assert.equal(response.status, 0, response.stderr);
        return JSON.parse(response.stdout);
      }
      assert.equal(status().healthy, true);
      writeFileSync(statusFile, '503');
      assert.equal(status().healthy, false, 'live owned processes must not hide failed HTTP readiness');
      assert.equal(run(stop).status, 0);
      for (let attempt = 0; attempt < 50; attempt++) {
        try {
          await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(200) });
        } catch {
          break;
        }
        await delay(100);
      }
      await assert.rejects(fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(500) }));
      const stopped = run(
        `import { processIdentity } from ${JSON.stringify(core)}; console.log(JSON.stringify(processIdentity(${descendant})));`,
      );
      assert.equal(stopped.status, 0, stopped.stderr);
      assert.equal(JSON.parse(stopped.stdout).cmdline, '');
    } finally {
      run(stop);
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      rmSync(foreignDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  },
);
