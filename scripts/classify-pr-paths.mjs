#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { classifyChangedFiles, fullValidation, parseGitNameStatus, VALIDATION_FLAGS } from './lib/path-classifier.mjs';

export function classifyGitRange(baseSha, headSha, cwd = process.cwd()) {
  assertSha(baseSha, 'base SHA');
  assertSha(headSha, 'head SHA');
  const diff = spawnSync('git', ['diff', '--name-status', '--find-renames', '-z', `${baseSha}...${headSha}`], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  if (diff.status !== 0) throw new Error(`git diff failed: ${diff.stderr.trim()}`);
  const files = parseGitNameStatus(diff.stdout);
  return files === null ? fullValidation('malformed-git-diff') : classifyChangedFiles(files);
}

function outputClassification(result, baseSha, headSha, outputPath = process.env.GITHUB_OUTPUT) {
  const profile = result.profiles.join(',') || 'privileged';
  const values = {
    profile,
    reason: result.reason,
    base_sha: baseSha,
    head_sha: headSha,
    flags_json: JSON.stringify(result.flags),
    classification_json: JSON.stringify(result),
    started_at_epoch: String(Math.floor(Date.now() / 1000)),
    ...Object.fromEntries(VALIDATION_FLAGS.map((flag) => [snakeCase(flag), String(result.flags[flag])])),
  };
  if (outputPath) {
    appendFileSync(
      outputPath,
      `${Object.entries(values)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n')}\n`,
    );
  }
  console.log(JSON.stringify({ ...result, baseSha, headSha }, null, 2));
}

function assertSha(value, name) {
  if (!/^[0-9a-f]{40}$/.test(value ?? '')) throw new Error(`${name} must be a full lowercase commit SHA`);
}

function snakeCase(value) {
  return value.replace(/[A-Z]/g, (character) => `_${character.toLowerCase()}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = new Map();
  for (let index = 2; index < process.argv.length; index += 2) {
    args.set(process.argv[index], process.argv[index + 1]);
  }
  const headSha = args.get('--head');
  const baseSha = args.get('--base') ?? headSha;
  assertSha(headSha, 'head SHA');
  const checkedOut = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (checkedOut.status !== 0 || checkedOut.stdout.trim() !== headSha) {
    throw new Error(
      `exact-head checkout mismatch: expected ${headSha}, got ${checkedOut.stdout.trim() || 'unavailable'}`,
    );
  }
  const result = args.has('--full') ? fullValidation(args.get('--full')) : classifyGitRange(baseSha, headSha);
  outputClassification(result, baseSha, headSha, args.get('--output'));
}
