#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { classifyDeploymentImpact } from './lib/autonomous-policy.mjs';

export async function classifyDeploymentImpactFile(path) {
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error('A changed-files JSON path is required.');
  }
  const files = JSON.parse(await readFile(path, 'utf8'));
  return classifyDeploymentImpact(files);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await classifyDeploymentImpactFile(process.argv[2]);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
