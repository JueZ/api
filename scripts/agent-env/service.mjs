// Detached log owner: the invoking CLI can exit while this process drains service output.
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { redact } from './core.mjs';

const [marker, name, log, command, ...args] = process.argv.slice(2);
function record(stream, message) {
  appendFileSync(
    log,
    JSON.stringify({
      timestamp: new Date().toISOString(),
      worktreeId: marker.slice('agent-env:'.length),
      service: name,
      stream,
      message: redact(message),
    }) + '\n',
    { mode: 0o600 },
  );
}
const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
for (const stream of ['stdout', 'stderr']) {
  createInterface({ input: child[stream] }).on('line', (line) => record(stream, line));
}
child.on('error', (error) => {
  record('stderr', error.message);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
