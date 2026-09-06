import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  if (!Number.isInteger(pid) || pid <= 1) return { cmdline: '', start: '' };
  try {
    if (process.platform === 'win32') {
      const query = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($p) { @{ cmdline = $p.CommandLine; start = $p.CreationDate.ToUniversalTime().Ticks.ToString() } | ConvertTo-Json -Compress }`,
        ],
        { encoding: 'utf8', windowsHide: true, timeout: 10000 },
      );
      if (query.status !== 0) return { cmdline: '', start: '' };
      return JSON.parse(query.stdout);
    }
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ');
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    return { cmdline, start };
  } catch {
    return { cmdline: '', start: '' };
  }
}
export function owned(proc, manifest) {
  if (manifest.root !== root || manifest.worktreeId !== worktreeId) return false;
  const identity = processIdentity(proc?.pid);
  return (
    Number.isInteger(proc?.pid) &&
    proc.pid > 1 &&
    Boolean(proc.startTime) &&
    Boolean(identity.cmdline) &&
    identity.cmdline.includes(manifest.root) &&
    identity.cmdline.includes(proc.marker ?? 'agent-env:') &&
    identity.start === proc.startTime
  );
}
export function stopOwned(manifest) {
  for (const proc of Object.values(manifest?.processes ?? {})) {
    if (!owned(proc, manifest)) continue;
    try {
      if (process.platform === 'win32') {
        const stopped = spawnSync('taskkill.exe', ['/PID', String(proc.pid), '/T', '/F'], {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 10000,
        });
        if (stopped.status !== 0 && owned(proc, manifest)) throw new Error('Could not stop owned local service.');
      } else {
        // Local fixture processes have no durable state to drain. Kill the entire
        // verified group so a SIGTERM-resistant descendant cannot be orphaned.
        process.kill(-proc.pid, 'SIGKILL');
      }
    } catch (e) {
      if (e.code !== 'ESRCH') throw e;
    }
  }
}
export function resolveFunctionsCommand() {
  for (const directory of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const executable = join(directory, process.platform === 'win32' ? 'func.exe' : 'func');
    if (existsSync(executable)) return { command: executable, args: [] };
    // Run npm's Windows shim through its JS entrypoint, without a command shell.
    const npmEntry = join(directory, 'node_modules/azure-functions-core-tools/lib/main.js');
    if (process.platform === 'win32' && existsSync(npmEntry)) return { command: process.execPath, args: [npmEntry] };
  }
  return null;
}
export function spawnService(name, command, args, env, manifest) {
  const log = join(runtimeDir, `${name}.jsonl`);
  const marker = `agent-env:${manifest.worktreeId}`;
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('./service.mjs', import.meta.url)), marker, name, log, command, ...args],
    {
      cwd: root,
      env: { ...env, AGENT_ENV_MARKER: manifest.marker },
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    },
  );
  child.on('error', () => {}); // Ownership/readiness checks reject failed starts.
  child.unref();
  const identity = processIdentity(child.pid);
  return { pid: child.pid, group: child.pid, startTime: identity.start, marker, log };
}
export function clean() {
  rmSync(runtimeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
