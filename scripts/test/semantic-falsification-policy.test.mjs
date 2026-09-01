import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

test('substantial semantic changes invoke an autonomous proportional falsification phase', () => {
  const root = source('AGENTS.md');
  const delivery = source('.agents/skills/autonomous-pr-delivery/SKILL.md');
  const critic = source('.agents/skills/semantic-falsification/SKILL.md');

  assert.match(root, /Never derive a stronger user-visible completion guarantee/i);
  assert.match(delivery, /use `semantic-falsification` before committing/i);
  assert.match(delivery, /not an additional required check or human approval/i);
  assert.match(critic, /derive 3–8 falsifiable correctness invariants/i);
  assert.match(critic, /all\s+current tests pass but the requested outcome does not/i);
  assert.match(critic, /provider\/service boundary/i);
  assert.match(critic, /typo, formatting.+behavior-neutral/s);
  assert.match(critic, /continue normal protected delivery/i);
});

test('semantic review separates evidence levels and treats strong terminal names as claims', () => {
  const critic = source('.agents/skills/semantic-falsification/SKILL.md');

  for (const level of ['implementation', 'unit', 'contract', 'provider', 'production']) {
    assert.match(critic, new RegExp(`\\b${level}\\b`, 'i'));
  }
  for (const status of ['complete', 'exhaustive', 'successful', 'verified', 'sourceExhausted']) {
    assert.match(critic, new RegExp(`\\b${status}\\b`));
  }
  assert.match(critic, /mocks can establish unit or contract evidence but not live-provider evidence/i);
});

test('Codex evals generalize semantic falsification beyond Reddit', () => {
  const completeness = source('evals/codex-tasks/semantic-completeness-falsification.yml');
  const runtime = source('evals/codex-tasks/semantic-runtime-verification-falsification.yml');

  assert.match(completeness, /view A exposes IDs 1–500/);
  assert.match(completeness, /executable service-boundary contract/);
  assert.match(runtime, /expected SHA/);
  assert.match(runtime, /executable runtime identity\/behavior check/);
  assert.match(runtime, /workflow success as runtime proof/);
});
