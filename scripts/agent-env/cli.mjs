import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  clean,
  resolveFunctionsCommand,
  loadManifest,
  owned,
  processIdentity,
  ports,
  root,
  runtimeDir,
  saveManifest,
  spawnService,
  stopOwned,
  worktreeId,
} from './core.mjs';
const action = process.argv[2] ?? 'start';
const json = process.argv.includes('--json');
const sleep = (n) => new Promise((r) => setTimeout(r, n));
async function servicesHealthy(m) {
  if (!['fixture', 'api', 'web'].every((name) => owned(m.processes?.[name], m))) return false;
  try {
    const responses = await Promise.all([
      fetch(`${m.urls.fixture}/health`, { signal: AbortSignal.timeout(2000) }),
      fetch(`${m.urls.api}/health`, { signal: AbortSignal.timeout(2000) }),
      fetch(m.urls.frontend, { signal: AbortSignal.timeout(2000) }),
    ]);
    return responses.every((response) => response.ok);
  } catch {
    return false;
  }
}
async function start() {
  let m = loadManifest();
  if (m && (await servicesHealthy(m))) return m;
  if (m) {
    stopOwned(m);
    clean();
  }
  if (
    spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', 'apps/api/tsconfig.json'], {
      cwd: root,
      stdio: 'inherit',
      windowsHide: true,
    }).status !== 0
  )
    throw new Error('API build failed before local startup.');
  const functions = resolveFunctionsCommand();
  if (!functions)
    throw new Error(
      'Azure Functions Core Tools is required: install func for Node.js 22, then rerun npm run agent:env:start.',
    );
  const p = await ports();
  const marker = `agent-env:${worktreeId}`;
  m = {
    version: 1,
    worktreeId,
    root,
    marker,
    startedAt: new Date().toISOString(),
    readiness: 'starting',
    urls: {
      api: `http://127.0.0.1:${p.api}`,
      frontend: `http://127.0.0.1:${p.web}`,
      fixture: `http://127.0.0.1:${p.fixture}`,
    },
    processes: {},
  };
  saveManifest(m);
  const proxyConfig = join(runtimeDir, 'proxy.json');
  writeFileSync(proxyConfig, JSON.stringify({ '/api/**': { target: m.urls.api } }) + '\n', { mode: 0o600 });
  try {
    m.processes.fixture = spawnService(
      'fixture',
      process.execPath,
      [
        join(root, 'scripts/agent-env/fixture-server.mjs'),
        String(p.fixture),
        join(runtimeDir, 'fixture-requests.jsonl'),
      ],
      process.env,
      m,
    );
    m.processes.api = spawnService(
      'api',
      functions.command,
      [...functions.args, 'start', '--script-root', join(root, 'apps/api'), '--port', String(p.api)],
      {
        ...process.env,
        DEPLOYED_ENVIRONMENT_NAME: 'local',
        FUNCTIONS_WORKER_RUNTIME: 'node',
        AUTH_ENABLED: 'false',
        WLH_BASE_URL: m.urls.fixture,
      },
      m,
    );
    m.processes.web = spawnService(
      'web',
      process.execPath,
      [
        join(root, 'node_modules/@angular/cli/bin/ng.js'),
        'serve',
        'web',
        '--host',
        '127.0.0.1',
        '--port',
        String(p.web),
        '--proxy-config',
        proxyConfig,
      ],
      process.env,
      m,
    );
    saveManifest(m);
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      await sleep(500);
      if (await servicesHealthy(m)) {
        m.readiness = 'ready';
        break;
      }
    }
    m.readiness = m.readiness === 'ready' ? 'ready' : 'failed';
    saveManifest(m);
    if (m.readiness !== 'ready')
      throw new Error(
        `Local services did not become ready within 120 seconds: ${JSON.stringify(Object.fromEntries(Object.entries(m.processes).map(([name, p]) => [name, { recorded: p.startTime, actual: processIdentity(p.pid) }])))}`,
      );
    return m;
  } catch (e) {
    const diagnostics = Object.entries(m.processes).flatMap(([name, process]) =>
      existsSync(process.log)
        ? readFileSync(process.log, 'utf8')
            .trim()
            .split('\n')
            .slice(-3)
            .map((line) => `${name}: ${line}`)
        : [],
    );
    stopOwned(m);
    await sleep(250);
    clean();
    throw new Error(`${e.message}${diagnostics.length ? `\n${diagnostics.join('\n')}` : ''}`, { cause: e });
  }
}
async function main() {
  if (action === 'start' || action === 'env') {
    console.log(JSON.stringify(await start(), null, 2));
    return;
  }
  const m = loadManifest();
  if (action === 'status') {
    const out = m ? { ...m, healthy: await servicesHealthy(m) } : { readiness: 'stopped' };
    console.log(JSON.stringify(out, null, json ? 0 : 2));
    return;
  }
  if (action === 'stop') {
    if (m) stopOwned(m);
    clean();
    console.log('{"stopped":true}');
    return;
  }
  if (action === 'reset') {
    if (m) {
      writeFileSync(join(runtimeDir, 'fixture-requests.jsonl'), '', { mode: 0o600 });
    }
    console.log('{"reset":true}');
    return;
  }
  if (action === 'logs') {
    if (!m) throw new Error('Agent environment is not running.');
    const serviceIndex = process.argv.indexOf('--service');
    const service = serviceIndex >= 0 ? process.argv[serviceIndex + 1] : null;
    const correlationIndex = process.argv.indexOf('--correlation');
    const correlation = correlationIndex >= 0 ? process.argv[correlationIndex + 1] : null;
    const tail = Number(process.argv[process.argv.indexOf('--tail') + 1] || 100);
    let lines = [];
    for (const [name, p] of Object.entries(m.processes))
      if (!service || service === name)
        if (existsSync(p.log)) lines.push(...readFileSync(p.log, 'utf8').trim().split('\n'));
    if (correlation) lines = lines.filter((line) => line.includes(correlation));
    console.log(lines.slice(-tail).join('\n'));
    return;
  }
  if (action === 'verify') {
    if (!m) await start();
    const current = loadManifest();
    const checks = { ownership: Object.values(current.processes).every((p) => owned(p, current)) };
    for (const [k, u] of Object.entries(current.urls)) {
      try {
        const r = await fetch(k === 'frontend' ? u : `${u}/health`, { signal: AbortSignal.timeout(2000) });
        checks[k] = r.ok;
      } catch {
        checks[k] = false;
      }
    }
    try {
      const frontendApi = await fetch(`${current.urls.frontend}/api/hello`, { signal: AbortSignal.timeout(5000) });
      checks.frontendApi = frontendApi.ok && (await frontendApi.json()).message === 'Hello, Martin';
      const response = await fetch(`${current.urls.fixture}/wlh/search`);
      checks.providerOperation = response.ok && (await response.json()).items?.[0]?.id === 'fixture-offer';
      checks.fixtureEvidence = readFileSync(join(runtimeDir, 'fixture-requests.jsonl'), 'utf8').includes('/wlh/search');
    } catch {
      checks.providerOperation = false;
      checks.fixtureEvidence = false;
    }
    console.log(JSON.stringify({ worktreeId, checks, passed: Object.values(checks).every(Boolean) }));
    if (!Object.values(checks).every(Boolean)) process.exitCode = 1;
    return;
  }
  throw new Error(`Unknown action: ${action}`);
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
