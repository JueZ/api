import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';

const mainSource = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
const gitignoreSource = await readFile(new URL('../../../.gitignore', import.meta.url), 'utf8');
const angularConfigSource = await readFile(new URL('../../../angular.json', import.meta.url), 'utf8');
const packageSource = await readFile(new URL('../../../package.json', import.meta.url), 'utf8');
const helpers = await importWebHelpers();

test('logged-out state is visible in the Angular auth UI', () => {
  assert.match(mainSource, /Signed out\./);
  assert.match(mainSource, /Authentication config is incomplete\./);
});

test('login button exists and uses a redirect flow', async () => {
  const authSource = await readFile(new URL('../src/app/auth.ts', import.meta.url), 'utf8');
  assert.match(mainSource, />\s*Sign in\s*</);
  assert.match(mainSource, /loginRedirect\(\{ scopes: \[config\.authApiScope\] \}\)/);
  assert.match(authSource, /handleRedirectPromise\(\{ navigateToLoginRequestUrl: false \}\)/);
});

test('OpenAPI helper parses operations from the catalogue contract', () => {
  const document = helpers.parseOpenApiDocument(`
openapi: 3.1.0
info: { title: Test API, version: 1.0.0 }
paths:
  /api/things/{id}:
    get:
      operationId: getThing
      tags: [Things]
      summary: Get a thing
      security: [{ bearerAuth: [] }]
      parameters:
        - { name: id, in: path, required: true, schema: { type: string, examples: [abc] } }
        - { name: verbose, in: query, schema: { type: boolean, default: false } }
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Thing' }
components:
  schemas:
    Thing:
      type: object
      required: [id]
      properties:
        id: { type: string, description: Thing id }
`);

  const operations = helpers.buildApiOperations(document);
  assert.equal(operations.length, 1);
  assert.equal(operations[0].id, 'getThing');
  assert.equal(operations[0].requiresAuth, true);
  assert.deepEqual(
    operations[0].parameterFields.map((field) => [field.name, field.parameterIn]),
    [
      ['id', 'path'],
      ['verbose', 'query'],
    ],
  );
  assert.equal(operations[0].responses[0].schemaName, 'Thing');
});

test('request body helper coerces form values into typed JSON', () => {
  const operation = operationFixture({
    requestFields: [
      fieldFixture({ name: 'limit', inputType: 'number', required: true }),
      fieldFixture({ name: 'include_comments', inputType: 'checkbox' }),
      fieldFixture({ name: 'post', inputType: 'text', required: true }),
      fieldFixture({ name: 'optional', inputType: 'text' }),
    ],
  });

  assert.deepEqual(
    helpers.buildRequestBody(operation, {
      limit: '3',
      include_comments: 'true',
      post: 'abc123',
      optional: '',
    }),
    {
      limit: 3,
      include_comments: true,
      post: 'abc123',
    },
  );
});

test('confirmation capability bypasses generic form state and uses an explicit sensitive request channel', () => {
  const operation = operationFixture({
    id: 'bringApplyItemMutation',
    requestFields: [
      fieldFixture({ name: 'operationId', required: true }),
      fieldFixture({ name: 'confirmationToken', required: true }),
    ],
    requestExample: JSON.stringify({ operationId: 'operation-1', confirmationToken: 'example-must-not-enter-state' }),
  });

  const initial = helpers.buildInitialBody(operation);
  assert.equal(Object.hasOwn(initial, 'confirmationToken'), false);
  assert.deepEqual(
    helpers.buildRequestBody(
      operation,
      { operationId: 'operation-1', confirmationToken: 'generic-state-value' },
      { confirmationToken: 'ephemeral-capability-value' },
    ),
    {
      operationId: 'operation-1',
      confirmationToken: 'ephemeral-capability-value',
    },
  );
  assert.deepEqual(helpers.withoutSensitiveFormValues({ operationId: 'operation-1', confirmationToken: 'value' }), {
    operationId: 'operation-1',
  });
});

test('problem response formatter exposes only sanitized RepairableProblem fields', () => {
  const problem = helpers.formatProblemResponse(
    {
      type: 'https://api.example.test/problems/caller-contract-violation',
      title: 'Invalid Reddit post',
      status: 400,
      detail: 'The post field is required.',
      instance: 'urn:diagnostic:diag_test',
      rec_version: '1.0',
      operation_id: 'postRedditThread',
      classification: 'caller_contract_violation',
      repairable: true,
      confidence: 0.99,
      caller_instruction: 'Move the Reddit URL into post and retry.',
      retry_policy: { can_retry: true, same_request: false },
      repair_patch: [{ op: 'add', path: '/post', value: 'abc123' }],
      repair_plan: [{ action: 'provide_missing_value', path: '/post', reason: 'Required.' }],
      diagnostic_id: 'diag_test',
      safe_debug_summary: 'The post field was missing.',
      analysis_mode: 'deterministic',
      unsafe_raw_detail: 'Authorization Bearer real-token',
    },
    400,
  );

  assert.equal(problem.title, 'Invalid Reddit post');
  assert.equal(problem.status, '400');
  assert.match(problem.callerInstruction, /Move the Reddit URL/);
  assert.match(problem.retryPolicy, /can_retry/);
  assert.match(problem.repairPatch, /abc123/);
  assert.match(problem.repairPlan, /provide_missing_value/);
  assert.equal(problem.diagnosticId, 'diag_test');
  assert.equal(problem.raw.unsafe_raw_detail, undefined);
});

test('non-problem API errors suppress untrusted response bodies', () => {
  const error = helpers.formatApiError(
    502,
    '<html>Authorization: Bearer raw-response-token; Set-Cookie: private-cookie</html>',
  );

  assert.equal(
    error,
    'API returned 502: response details were suppressed because they did not match the sanitized problem contract.',
  );
  assert.doesNotMatch(error, /raw-response-token|private-cookie|Authorization|Set-Cookie|<html>/i);

  const objectError = helpers.formatApiError(502, {
    detail: 'Authorization: Bearer object-response-token',
  });
  assert.doesNotMatch(objectError, /object-response-token|Authorization/i);
});

test('successful response formatting recursively redacts confirmation capabilities', () => {
  const formatted = helpers.formatBody(
    {
      state: 'prepared',
      confirmationToken: 'top-level-capability',
      nested: { confirmation_token: 'nested-capability' },
    },
    true,
  );

  assert.match(formatted, /<REDACTED>/);
  assert.doesNotMatch(formatted, /top-level-capability|nested-capability/);
});

test('curl generation uses bearer placeholder and never includes real tokens', () => {
  const operation = operationFixture({
    id: 'postWlhSearch',
    method: 'post',
    path: '/api/reddit/thread',
    requiresAuth: true,
    requestFields: [fieldFixture({ name: 'post', inputType: 'text', required: true })],
  });

  const curl = helpers.buildCurlCommand({
    operation,
    values: { post: 'abc123' },
    apiBaseUrl: 'https://api.example.test',
  });

  assert.match(curl, /Authorization: Bearer <ACCESS_TOKEN>/);
  assert.match(curl, /--data/);
  assert.ok(curl.includes(`'{"post":"abc123"}'`));
  assert.doesNotMatch(curl, /real-token|eyJ|Bearer [A-Za-z0-9._-]{12,}/);
});

test('curl generation replaces confirmation capabilities even if unsafe state is supplied', () => {
  const operation = operationFixture({
    id: 'bringApplyItemMutation',
    requiresAuth: true,
    requestFields: [
      fieldFixture({ name: 'operationId', required: true }),
      fieldFixture({ name: 'confirmationToken', required: true }),
    ],
  });

  const curl = helpers.buildCurlCommand({
    operation,
    values: { operationId: 'operation-1', confirmationToken: 'must-not-reach-clipboard' },
    apiBaseUrl: 'https://api.example.test',
  });

  assert.match(curl, /<CONFIRMATION_TOKEN>/);
  assert.doesNotMatch(curl, /must-not-reach-clipboard/);
});

test('Bring complete and remove flows resolve their exact OpenAPI OAuth scopes', () => {
  const operation = operationFixture({
    id: 'bringPrepareItemMutation',
    requiresAuth: true,
    requiredScopes: ['bring.complete', 'bring.remove'],
  });

  assert.equal(
    helpers.resolveOperationScope(operation, 'api://catalogue-client/catalogue.read', 'complete'),
    'api://catalogue-client/bring.complete',
  );
  assert.equal(
    helpers.resolveOperationScope(operation, 'api://catalogue-client/catalogue.read', 'remove'),
    'api://catalogue-client/bring.remove',
  );
  assert.throws(
    () =>
      helpers.resolveOperationScope(
        operationFixture({ id: 'brokenBringMutation', requiredScopes: ['bring.complete'] }),
        'api://catalogue-client/catalogue.read',
        'remove',
      ),
    /does not declare the bring\.remove permission/,
  );
});

test('Bring confirmation vault exposes only safe UI metadata and clears at expiry', () => {
  const now = Date.parse('2026-07-31T12:00:00.000Z');
  let expiryCallback;
  let scheduledDelay = -1;
  let clearNotifications = 0;
  const vault = new helpers.BringConfirmationVault({
    now: () => now,
    schedule: (callback, delayMs) => {
      expiryCallback = callback;
      scheduledDelay = delayMs;
      return 1;
    },
    cancel: () => undefined,
    onClear: () => {
      clearNotifications += 1;
    },
  });

  const summary = vault.capture(
    {
      operation: 'remove',
      state: 'prepared',
      operationId: 'operation-1',
      confirmationToken: 'ephemeral-capability-value',
      listPseudonym: 'list-abcd',
      itemCount: 2,
      expiresAt: '2026-07-31T12:05:00.000Z',
    },
    '11111111-1111-4111-8111-111111111111',
  );

  assert.deepEqual(summary, {
    operation: 'remove',
    operationId: 'operation-1',
    listPseudonym: 'list-abcd',
    itemCount: 2,
    expiresAt: '2026-07-31T12:05:00.000Z',
  });
  assert.doesNotMatch(JSON.stringify(summary), /ephemeral-capability-value|confirmationToken/);
  assert.equal(vault.active().confirmationToken, 'ephemeral-capability-value');
  assert.equal(scheduledDelay, 300_000);
  assert.equal(clearNotifications, 1);

  expiryCallback();
  assert.equal(vault.active(), null);
  assert.equal(clearNotifications, 2);
});

test('OpenAPI contract drives the interactive API catalogue', () => {
  assert.match(mainSource, /parseOpenApiDocument/);
  assert.match(mainSource, /buildApiOperations\(openApiDocument\)/);
  assert.match(mainSource, /assets\/openapi\.yaml/);
  assert.match(mainSource, /expected payload fields, response objects, examples/);
});

test('API calls send bearer tokens for protected OpenAPI operations', () => {
  assert.match(mainSource, /resolveOperationScope\(operation, config\.authApiScope, bringMutationOperation\)/);
  assert.match(mainSource, /Authentication is not configured\./);
  assert.match(mainSource, /operation\.requiresAuth/);
});

test('API problem responses are displayed with repair guidance and no raw unsafe details', () => {
  assert.match(mainSource, /caller_instruction/);
  assert.match(mainSource, /retry_policy/);
  assert.match(mainSource, /repair_patch/);
  assert.match(mainSource, /repair_plan/);
  assert.match(mainSource, /diagnostic_id/);
  assert.doesNotMatch(mainSource, /unsafe_raw_detail/);
});

test('copy-as-curl button and stable operation anchors are rendered', () => {
  assert.match(mainSource, /Copy as curl/);
  assert.match(mainSource, /buildCurlCommand/);
  assert.match(mainSource, /\[id\]="operation\.id"/);
  assert.match(mainSource, /'#' \+ operation\.id/);
});

test('OpenAPI request payload fields render interactive controls', () => {
  assert.match(mainSource, /field\.enumValues\.length/);
  assert.match(mainSource, /setInputValue\(operation\.id, field\.name/);
  assert.match(mainSource, /buildRequestBody\(\s*operation,\s*values,/);
  assert.doesNotMatch(mainSource, /sort: 'confidence'/);
  assert.match(mainSource, /field\.inputType === 'textarea'/);
  assert.match(mainSource, /Bring! lists and items/);
});

test('complex OpenAPI request fields are parsed as JSON for Bring item batches', () => {
  const operation = operationFixture({
    requestFields: [
      {
        name: 'items',
        type: 'BringItemInput[]',
        required: true,
        description: '',
        defaultValue: '',
        constraints: '',
        enumValues: [],
        example: '',
        inputType: 'textarea',
      },
    ],
  });
  assert.deepEqual(helpers.buildRequestBody(operation, { items: '[{"name":"Milch"}]' }), {
    items: [{ name: 'Milch' }],
  });
  assert.throws(() => helpers.buildRequestBody(operation, { items: 'not json' }), /items must be valid JSON/);
});

test('Bring destructive writes use a separate prepared confirmation step', () => {
  assert.match(mainSource, /bringPrepareItemMutation/);
  assert.match(mainSource, /bringApplyItemMutation/);
  assert.match(mainSource, /window\.confirm\('Apply this prepared Bring!/);
  assert.match(mainSource, /captureBringConfirmation\(responseBody\)/);
  assert.match(mainSource, /new BringConfirmationVault/);
  assert.match(mainSource, /@if \(!isSensitiveRequestField\(field\.name\)\)/);
  assert.match(mainSource, /this\.clearPendingBringConfirmation\(\)/);
  assert.doesNotMatch(mainSource, /bringCompleteItems|bringRemoveItems/);
});

test('only the canonical OpenAPI YAML is committed while Angular copies it as an asset', () => {
  assert.match(gitignoreSource, /apps\/web\/src\/assets\/openapi\.yaml/);
  assert.match(gitignoreSource, /apps\/web\/src\/app\/openapi\.generated\.ts/);
  assert.match(angularConfigSource, /"input": "contracts"/);
  assert.match(angularConfigSource, /"glob": "openapi\.yaml"/);
  assert.doesNotMatch(packageSource, /sync:openapi/);
});

test('MSAL hidden iframes never bootstrap Angular or run redirect handling', () => {
  assert.match(mainSource, /isEmbeddedFrame\(\)/);
  assert.match(mainSource, /window\.self !== window\.top/);
  assert.match(mainSource, /!isEmbeddedFrame\(\)/);
  assert.doesNotMatch(mainSource, /code\|error\|state\|client_info/);
});

function operationFixture(overrides = {}) {
  return {
    id: 'exampleOperation',
    method: 'post',
    path: '/api/example',
    tag: 'Example',
    summary: 'Example operation',
    description: '',
    requiresAuth: false,
    requiredScopes: [],
    requestRequired: true,
    requestContentType: 'application/json',
    requestSchemaName: 'ExampleRequest',
    requestFields: [],
    requestExample: '',
    parameterFields: [],
    responses: [],
    schemas: [],
    ...overrides,
  };
}

function fieldFixture(overrides = {}) {
  return {
    name: 'field',
    type: 'string',
    required: false,
    description: '',
    defaultValue: '',
    constraints: '',
    enumValues: [],
    example: '',
    inputType: 'text',
    ...overrides,
  };
}

async function importWebHelpers() {
  const tempDirectory = await mkdtemp(join(process.cwd(), 'apps/web/test/.tmp-web-helper-tests-'));
  const sourceFiles = [
    'openapi.ts',
    'bring-confirmation.ts',
    'operation-scope.ts',
    'request-builder.ts',
    'problem-format.ts',
    'curl.ts',
  ];

  await Promise.all(
    sourceFiles.map(async (fileName) => {
      const source = await readFile(new URL(`../src/app/${fileName}`, import.meta.url), 'utf8');
      const js = ts
        .transpileModule(source, {
          compilerOptions: {
            module: ts.ModuleKind.ESNext,
            target: ts.ScriptTarget.ES2022,
            moduleResolution: ts.ModuleResolutionKind.Bundler,
            verbatimModuleSyntax: true,
          },
        })
        .outputText.replace(/from '(\.\/[^']+)'/g, "from '$1.js'");
      await writeFile(join(tempDirectory, fileName.replace(/\.ts$/, '.js')), js);
    }),
  );

  const modules = await Promise.all(
    sourceFiles.map((fileName) => import(join(tempDirectory, fileName.replace(/\.ts$/, '.js')))),
  );
  await rm(tempDirectory, { recursive: true, force: true });
  return Object.assign({}, ...modules);
}
