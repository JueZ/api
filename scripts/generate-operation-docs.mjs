#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { listOperationDefinitions } from '../apps/api/dist/application/operations/registry.js';

const targetUrl = new URL('../docs/architecture/operation-catalogue.md', import.meta.url);

export function renderOperationCatalogue(operations = listOperationDefinitions()) {
  const rows = operations.map((operation) => {
    const rest = operation.rest ? `${operation.rest.method} ${operation.rest.path}` : '—';
    const mcp = operation.mcp?.toolName ?? '—';
    return [
      operation.id,
      operation.provider,
      operation.effect,
      operation.requiredPermission ?? 'public',
      operation.allowedTokenTypes.join(', '),
      operation.allowedEnvironments.join(', '),
      operation.idempotency,
      operation.confirmation,
      operation.rest ? (operation.gptActions ? 'yes' : 'no') : 'n/a',
      rest,
      mcp,
    ];
  });
  return [
    '# Operation catalogue',
    '',
    '> Generated from `apps/api/src/application/operations/registry.ts`. Run `npm run docs:check-operations` to detect drift.',
    '',
    '| Operation | Provider | Effect | Permission | Tokens | Environments | Idempotency | Confirmation | GPT Actions | REST | MCP |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map((row) => `| ${row.map(escapeCell).join(' | ')} |`),
    '',
  ].join('\n');
}

function escapeCell(value) {
  return String(value).replaceAll('|', '\\|');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rendered = renderOperationCatalogue();
  if (process.argv.includes('--check')) {
    const current = await readFile(targetUrl, 'utf8');
    if (current !== rendered) {
      console.error('Operation catalogue is stale. Regenerate it from the canonical registry.');
      process.exit(1);
    }
    console.log('Operation catalogue is current.');
  } else {
    process.stdout.write(rendered);
  }
}
