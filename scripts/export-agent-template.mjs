import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url));
const source = join(repository, 'templates', 'agent-operating-contract');
export const TEMPLATE_FILES = Object.freeze([
  'AGENTS.md',
  '.agents/skills/delivery/SKILL.md',
  '.agents/skills/incident-repair/SKILL.md',
  '.agents/skills/learning/SKILL.md',
  'docs/architecture.md',
  'docs/project-memory.md',
  'scripts/doctor.mjs',
  'scripts/validate-affected.mjs',
  'scripts/delivery-status.mjs',
  'README.md',
]);

function contains(parent, child) {
  const path = relative(parent, child);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}

function inspect(path) {
  let current = parse(path).root;
  let stat;
  for (const part of relative(current, path).split(sep).filter(Boolean)) {
    current = join(current, part);
    stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) throw new Error('Symbolic links and junctions are not supported.');
    if (stat && current !== path && !stat.isDirectory()) throw new Error('Ancestor is not a directory.');
  }
  return stat;
}

function checkDestination(target) {
  const stat = inspect(target);
  if (stat && (!stat.isDirectory() || readdirSync(target).length > 0)) {
    throw new Error('Destination must be nonexistent or empty; existing entries are never overwritten.');
  }
}

export function exportAgentTemplate(destination) {
  if (typeof destination !== 'string' || !destination.trim()) throw new Error('Provide one destination path.');
  const target = resolve(destination);
  if (contains(repository, target) || contains(target, repository)) {
    throw new Error('Destination must not overlap the source checkout.');
  }
  checkDestination(target);
  const files = TEMPLATE_FILES.map((path) => {
    const input = join(source, path);
    if (!inspect(input)?.isFile()) throw new Error(`Template file is missing or not regular: ${path}`);
    return [path, readFileSync(input)];
  });
  checkDestination(target);
  mkdirSync(target, { recursive: true });
  for (const [path, content] of files) {
    const output = join(target, path);
    inspect(output);
    mkdirSync(dirname(output), { recursive: true });
    inspect(output);
    writeFileSync(output, content, { flag: 'wx' });
  }
  return { destination: target, files: TEMPLATE_FILES };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node scripts/export-agent-template.mjs <destination>');
    console.log(JSON.stringify(exportAgentTemplate(process.argv[2])));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
