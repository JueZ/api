#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { classifyDeploymentImpact } from './lib/deployment-impact.mjs';
import { parseGitNameStatus } from './lib/path-classifier.mjs';

export async function classifyDeploymentImpactFile(path) {
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error('A changed-files JSON path is required.');
  }
  const files = JSON.parse(await readFile(path, 'utf8'));
  return classifyDeploymentImpact(files);
}

export function classifyDeploymentGitRange(baseSha, headSha, cwd = process.cwd()) {
  assertSha(baseSha, 'base SHA');
  assertSha(headSha, 'head SHA');
  const diff = spawnSync('git', ['diff', '--name-status', '--find-renames', '-z', `${baseSha}...${headSha}`], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  if (diff.status !== 0) throw new Error(`git diff failed: ${diff.stderr.trim()}`);
  const files = parseGitNameStatus(diff.stdout);
  return files === null
    ? { ...classifyDeploymentImpact([]), reason: 'malformed-git-diff' }
    : classifyDeploymentImpact(files);
}

function outputClassification(result, baseSha, headSha, outputPath = process.env.GITHUB_OUTPUT) {
  const values = {
    deployment_required: String(result.deploymentRequired),
    valid: String(result.valid),
    reason: result.reason,
    file_count: String(result.fileCount),
    impact_path_count: String(result.impactPathCount),
    base_sha: baseSha,
    head_sha: headSha,
    classification_json: JSON.stringify(result),
    started_at_epoch: String(Math.floor(Date.now() / 1000)),
  };
  if (outputPath) {
    appendFileSync(
      outputPath,
      `${Object.entries(values)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n')}\n`,
    );
  }
  process.stdout.write(`${JSON.stringify({ ...result, baseSha, headSha }, null, 2)}\n`);
}

function assertSha(value, name) {
  if (!/^[0-9a-f]{40}$/.test(value ?? '')) throw new Error(`${name} must be a full lowercase commit SHA`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!process.argv[2]?.startsWith('--')) {
    const result = await classifyDeploymentImpactFile(process.argv[2]);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    const args = new Map();
    for (let index = 2; index < process.argv.length; index += 2) {
      args.set(process.argv[index], process.argv[index + 1]);
    }
    const baseSha = args.get('--base');
    const headSha = args.get('--head');
    assertSha(baseSha, 'base SHA');
    assertSha(headSha, 'head SHA');
    const checkedOut = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
    if (checkedOut.status !== 0 || checkedOut.stdout.trim() !== headSha) {
      throw new Error(
        `exact-main checkout mismatch: expected ${headSha}, got ${checkedOut.stdout.trim() || 'unavailable'}`,
      );
    }
    const result = args.has('--full')
      ? { ...classifyDeploymentImpact([]), reason: args.get('--full') || 'explicit-full-deployment' }
      : classifyDeploymentGitRange(baseSha, headSha);
    outputClassification(result, baseSha, headSha, args.get('--output'));
  }
}
