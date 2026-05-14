import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const mainSource = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');

test('logged-out state is visible in the Angular auth UI', () => {
  assert.match(mainSource, /Signed out\./);
  assert.match(mainSource, /Authentication config is incomplete\./);
});

test('login button exists', () => {
  assert.match(mainSource, />\s*Sign in\s*</);
});

test('API call sends a bearer token and requires authentication config', () => {
  assert.match(mainSource, /Authorization: `Bearer \$\{accessToken\}`/);
  assert.match(mainSource, /Authentication is not configured\./);
});

test('API errors are displayed clearly', () => {
  assert.match(mainSource, /role="alert"/);
  assert.match(mainSource, /API returned \$\{response\.status\}/);
});
