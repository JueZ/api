import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const openApi = fs.readFileSync('contracts/openapi.yaml', 'utf8');
const appMain = fs.readFileSync('apps/web/src/main.ts', 'utf8');

test('OpenAPI includes willhaben operations consumed by Angular UI', () => {
  assert.match(openApi, /operationId: listWillhabenCategories/);
  assert.match(openApi, /operationId: getWillhabenFilterSchema/);
  assert.match(openApi, /operationId: searchWillhabenListings/);
  assert.match(openApi, /operationId: getWillhabenListing/);
  assert.match(appMain, /buildApiOperations\(openApiDocument\)/);
});
