import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

export const root = realpathSync(process.cwd());
export const worktreeId = createHash('sha256').update(root).digest('hex').slice(0, 12);
export const runtimeDir = join(root, '.agent-runtime', worktreeId);
export const manifestPath = join(runtimeDir, 'manifest.json');
export const redact = (v) =>
  String(v)
    .replace(/([?&](?:sig|token|key|code)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\b(?:Bearer\s+|gh[pousr]_|github_pat_|sk-)[A-Za-z0-9._-]{12,}/gi, '[redacted]');
export async function freePort(preferred) {
  for (let p = preferred; p < preferred + 200; p++) {
    if (await canListen(p)) return p;
  }
  throw new Error('No loopback port available');
}
function canListen(port) {
  return new Promise((r) => {
    const s = createServer();
    s.once('error', () => r(false));
    s.listen(port, '127.0.0.1', () => s.close(() => r(true)));
  });
}
export async function ports() {
  const seed = parseInt(worktreeId.slice(0, 6), 16) % 1000;
  const used = new Set();
  const pick = async (base) => {
    let p = await freePort(base + seed);
    while (used.has(p)) p = await freePort(p + 1);
    used.add(p);
    return p;
  };
  return { api: await pick(7071), web: await pick(4200), fixture: await pick(9100) };
}
export function saveManifest(value) {
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  writeFileSync(manifestPath, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}
export function loadManifest() {
  return existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;
}
export function processIdentity(pid) {
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ');
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    return { cmdline, start };
  } catch {
    return { cmdline: '', start: '' };
  }
}
export function owned(proc, manifest) {
  const identity = processIdentity(proc?.pid);
  return (
    Number.isInteger(proc?.pid) &&
    proc.pid > 1 &&
    identity.cmdline.includes(manifest.root) &&
    identity.start === proc.startTime
  );
}
export function stopOwned(manifest) {
  for (const proc of Object.values(manifest?.processes ?? {})) {
    if (!owned(proc, manifest)) continue;
    try {
      process.kill(-proc.pid, 'SIGTERM');
    } catch (e) {
      if (e.code !== 'ESRCH') throw e;
    }
  }
}
export function commandExists(name) {
  return spawnSync('sh', ['-c', `command -v ${name}`], { stdio: 'ignore' }).status === 0;
}
export function spawnService(name, command, args, env, manifest) {
  const log = join(runtimeDir, `${name}.jsonl`);
  const child = spawn(command, args, {
    cwd: root,
    env: { ...env, AGENT_ENV_MARKER: manifest.marker },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of ['stdout', 'stderr'])
    child[stream].on('data', (b) => {
      if (!existsSync(runtimeDir)) return;
      for (const line of b.toString().split(/\r?\n/).filter(Boolean))
        appendFileSync(
          log,
          JSON.stringify({
            timestamp: new Date().toISOString(),
            worktreeId,
            service: name,
            stream,
            message: redact(line),
          }) + '\n',
          { mode: 0o600 },
        );
    });
  child.unref();
  const identity = processIdentity(child.pid);
  return { pid: child.pid, group: child.pid, startTime: identity.start, marker: manifest.marker, log };
}
export function clean() {
  rmSync(runtimeDir, { recursive: true, force: true });
}
