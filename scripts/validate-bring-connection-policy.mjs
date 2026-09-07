#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function validateBringConnectionPolicy(connectionModule, env = process.env) {
  const enabled = env.BRING_ENABLED ?? 'false';
  if (!['true', 'false'].includes(enabled)) throw new Error('Bring enablement must be explicit.');
  if (enabled === 'false') return { status: 'not_applicable' };
  const grants = connectionModule.parseBringConnectionGrants(env.BRING_CONNECTION_GRANTS);
  if (
    grants.length === 0 ||
    grants.some((grant) => grant.connectionId !== connectionModule.LEGACY_BRING_CONNECTION_ID)
  ) {
    throw new Error('Enabled Bring requires grants to a registered connection.');
  }
  return { status: 'passed', grantCount: grants.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--connection-module') throw new Error('Invalid arguments.');
    const connectionModule =
      process.env.BRING_ENABLED === 'true' ? await import(pathToFileURL(resolve(process.argv[3])).href) : undefined;
    console.log(JSON.stringify(validateBringConnectionPolicy(connectionModule)));
  } catch {
    console.error('Bring connection policy preflight failed; verify explicit grants before mutation.');
    process.exitCode = 1;
  }
}
