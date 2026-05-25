import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const mainSource = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
const gitignoreSource = await readFile(new URL('../../../.gitignore', import.meta.url), 'utf8');
const angularConfigSource = await readFile(new URL('../../../angular.json', import.meta.url), 'utf8');
const packageSource = await readFile(new URL('../../../package.json', import.meta.url), 'utf8');
const openApiContractSource = await readFile(new URL('../../../contracts/openapi.yaml', import.meta.url), 'utf8');

test('logged-out state is visible in the Angular auth UI', () => {
  assert.match(mainSource, /Signed out\./);
  assert.match(mainSource, /Authentication config is incomplete\./);
});

test('login button exists and uses a redirect flow', () => {
  assert.match(mainSource, />\s*Sign in\s*</);
  assert.match(mainSource, /loginRedirect\(\{ scopes: \[config\.authApiScope\] \}\)/);
});

test('OpenAPI contract drives the interactive API catalogue', () => {
  assert.match(mainSource, /YAML\.parse/);
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


test('only the canonical OpenAPI YAML is committed while Angular copies it as an asset', () => {
  assert.match(gitignoreSource, /apps\/web\/src\/assets\/openapi\.yaml/);
  assert.match(gitignoreSource, /apps\/web\/src\/app\/openapi\.generated\.ts/);
  assert.match(angularConfigSource, /\"input\": \"contracts\"/);
  assert.match(angularConfigSource, /\"glob\": \"openapi\.yaml\"/);
  assert.doesNotMatch(packageSource, /sync:openapi/);
});

test('MSAL does not navigate back to the login request URL after processing auth code redirects', () => {
  assert.match(mainSource, /navigateToLoginRequestUrl: false/);
});

test('MSAL hidden iframes never bootstrap Angular or run redirect handling', () => {
  assert.match(mainSource, /isEmbeddedFrame\(\)/);
  assert.match(mainSource, /window\.self !== window\.top/);
  assert.match(mainSource, /!isEmbeddedFrame\(\)/);
  assert.doesNotMatch(mainSource, /code\|error\|state\|client_info/);
});


test('OpenAPI contract includes wlh endpoints used by Angular catalogue', () => {
  assert.match(openApiContractSource, /\/api\/wlh\/categories\/top:/);
  assert.match(openApiContractSource, /\/api\/wlh\/search:/);
  assert.match(openApiContractSource, /\/api\/wlh\/offers\/\{adId\}:/);
});
