import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const mainSource = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');

test('logged-out state is visible in the Angular auth UI', () => {
  assert.match(mainSource, /Signed out\./);
  assert.match(mainSource, /Authentication config is incomplete\./);
});

test('login button exists and uses a redirect flow', () => {
  assert.match(mainSource, />\s*Sign in\s*</);
  assert.match(mainSource, /loginRedirect\(\{ scopes: \[config\.authApiScope\] \}\)/);
});

test('OpenAPI contract drives the interactive API catalogue', () => {
  assert.match(mainSource, /OPENAPI_DOCUMENT/);
  assert.match(mainSource, /buildApiOperations\(openApiDocument\)/);
  assert.match(mainSource, /assets\/openapi\.yaml/);
  assert.match(mainSource, /expected payload fields, response objects, examples/);
});

test('API calls send bearer tokens for protected OpenAPI operations', () => {
  assert.ok(mainSource.includes("headers['Authorization'] = `Bearer ${await acquireAccessToken(account)}`"));
  assert.match(mainSource, /Authentication is not configured\./);
  assert.match(mainSource, /operation\.requiresAuth/);
});

test('API errors are displayed clearly for each operation', () => {
  assert.match(mainSource, /role="alert"/);
  assert.match(mainSource, /API returned \$\{response\.status\}/);
  assert.match(mainSource, /operationErrors/);
});

test('OpenAPI request payload fields render interactive controls', () => {
  assert.match(mainSource, /field\.enumValues\.length/);
  assert.match(mainSource, /setInputValue\(operation\.id, field\.name/);
  assert.match(mainSource, /buildRequestBody\(operation/);
  assert.doesNotMatch(mainSource, /sort: 'confidence'/);
});

test('MSAL does not navigate back to the login request URL after processing auth code redirects', () => {
  assert.match(mainSource, /navigateToLoginRequestUrl: false/);
});
