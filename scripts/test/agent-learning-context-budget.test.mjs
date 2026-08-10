import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const routineContext = [
  'AGENTS.md',
  'docs/project-memory/current-state.md',
  'docs/project-memory/known-issues.md',
  'docs/project-memory/next-steps.md',
  '.agents/skills/autonomous-pr-delivery/SKILL.md',
  '.agents/skills/github-cli-devops/SKILL.md',
  '.agents/skills/project-memory-maintainer/SKILL.md',
];

function source(path) {
  return readFileSync(resolve(root, path), 'utf8');
}

function wordCount(value) {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

test('routine agent context stays bounded and routes historical detail on demand', () => {
  const files = routineContext.map((path) => ({ path, text: source(path) }));
  const bytes = files.reduce((total, file) => total + Buffer.byteLength(file.text), 0);
  const words = files.reduce((total, file) => total + wordCount(file.text), 0);

  assert.ok(bytes <= 48_000, `routine agent context is ${bytes} bytes; expected at most 48000`);
  assert.ok(words <= 5_500, `routine agent context is ${words} words; expected at most 5500`);
  assert.match(source('docs/project-memory/README.md'), /read `current-state\.md` first/i);
  assert.match(source('AGENTS.md'), /Read `docs\/agent-learning\/program\.md` only/);
});

test('routine delivery guidance avoids repetitive watchers and evidence-only bookkeeping PRs', () => {
  for (const path of ['.agents/skills/autonomous-pr-delivery/SKILL.md', '.agents/skills/github-cli-devops/SKILL.md']) {
    assert.doesNotMatch(source(path), /gh (?:pr checks|run watch)[^\n]*--watch/);
  }
  assert.match(source('.agents/skills/autonomous-pr-delivery/SKILL.md'), /Emit only state transitions/);
  assert.match(source('.agents/skills/project-memory-maintainer/SKILL.md'), /Never open a follow-up PR solely/);
});
