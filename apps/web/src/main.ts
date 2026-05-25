import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import {
  BrowserCacheLocation,
  EventType,
  InteractionRequiredAuthError,
  PublicClientApplication,
  type AccountInfo,
} from '@azure/msal-browser';
import YAML from 'yaml';

interface RuntimeConfig {
  authEnabled: boolean;
  authClientId: string;
  authAuthority: string;
  authRedirectUri: string;
  authApiScope: string;
  apiBaseUrl: string;
}

type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';
type JsonObject = Record<string, unknown>;
const httpMethods: HttpMethod[] = ['get', 'post', 'put', 'patch', 'delete'];

interface OpenApiSchema {
  $ref?: string;
  type?: string | readonly string[];
  format?: string;
  const?: unknown;
  enum?: readonly unknown[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  description?: string;
  examples?: readonly unknown[];
  properties?: Record<string, OpenApiSchema>;
  required?: readonly string[];
  items?: OpenApiSchema;
  additionalProperties?: boolean | OpenApiSchema;
}

interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: readonly string[];
  security?: readonly Record<string, readonly string[]>[];
  requestBody?: {
    required?: boolean;
    content?: Record<string, { schema?: OpenApiSchema; examples?: Record<string, { value?: unknown }> }>;
  };
  responses?: Record<string, {
    description?: string;
    content?: Record<string, { schema?: OpenApiSchema; examples?: Record<string, { value?: unknown }> }>;
  }>;
  parameters?: Array<{
    name: string;
    in: 'path' | 'query' | 'header' | 'cookie';
    required?: boolean;
    description?: string;
    schema?: OpenApiSchema;
  }>;
}

interface OpenApiDocument {
  info: {
    title: string;
    version: string;
    description?: string;
  };
  paths: Record<string, Partial<Record<HttpMethod, OpenApiOperation>>>;
  components?: {
    schemas?: Record<string, OpenApiSchema>;
    securitySchemes?: Record<string, { description?: string }>;
  };
}

interface SchemaFieldDoc {
  name: string;
  type: string;
  required: boolean;
  description: string;
  defaultValue: string;
  constraints: string;
  enumValues: string[];
  example: string;
  inputType: 'text' | 'number' | 'select' | 'checkbox';
}

interface SchemaDoc {
  name: string;
  description: string;
  fields: SchemaFieldDoc[];
}

interface ResponseDoc {
  status: string;
  description: string;
  schemaName: string;
  fields: SchemaFieldDoc[];
  example: string;
}

interface ApiOperationDoc {
  id: string;
  method: HttpMethod;
  path: string;
  tag: string;
  summary: string;
  description: string;
  requiresAuth: boolean;
  requestRequired: boolean;
  requestContentType: string;
  requestSchemaName: string;
  requestFields: SchemaFieldDoc[];
  requestExample: string;
  parameterFields: (SchemaFieldDoc & { parameterIn: 'path' | 'query' })[];
  responses: ResponseDoc[];
  schemas: SchemaDoc[];
}

declare global {
  interface Window {
    API_CATALOGUE_CONFIG?: Partial<RuntimeConfig>;
  }
}

const OPENAPI_ASSET_URL = 'assets/openapi.yaml';
const emptyOpenApiDocument: OpenApiDocument = { info: { title: '', version: '' }, paths: {} };
let openApiDocument = emptyOpenApiDocument;

const config = readRuntimeConfig();
const msalClient = createMsalClient(config);

@Component({
  selector: 'app-root',
  standalone: true,
  template: `
    <main class="shell" aria-labelledby="project-title">
      <section class="hero">
        <p class="eyebrow">Personal API catalogue</p>
        <h1 id="project-title">JueZ API Catalogue</h1>
        <p class="lede">
          A thin, serverless v0 foundation for publishing personal API integrations.
        </p>
      </section>

      <section class="card" aria-labelledby="auth-title">
        <h2 id="auth-title">Authentication</h2>
        <p class="status" [class.good]="isSignedIn()" [class.warn]="!isSignedIn()">
          {{ statusMessage() }}
        </p>
        @if (activeAccount(); as account) {
          <dl class="claims">
            <div>
              <dt>Signed-in user</dt>
              <dd>{{ account.username || account.name || 'Account signed in' }}</dd>
            </div>
            <div>
              <dt>Home account</dt>
              <dd>{{ account.homeAccountId }}</dd>
            </div>
          </dl>
        }
        <div class="button-row">
          <button class="button" type="button" (click)="login()" [disabled]="!canUseAuth() || isSignedIn()">
            Sign in
          </button>
          <button class="button secondary" type="button" (click)="logout()" [disabled]="!canUseAuth() || !isSignedIn()">
            Sign out
          </button>
        </div>
        @if (!canUseAuth()) {
          <p class="muted">
            Auth UI is disabled until non-secret Microsoft Entra runtime config is supplied.
          </p>
        }
      </section>

      <section class="card catalogue-card" aria-labelledby="catalogue-title">
        <h2 id="catalogue-title">API catalogue</h2>
        <p>
          This interactive catalogue is generated from the OpenAPI {{ openApiVersion() }} contract.
          It shows the expected payload fields, response objects, examples, and lets you call each
          endpoint from the browser.
        </p>
        <p class="muted">
          This endpoint now requires a valid OAuth/OIDC access token with the configured API
          scope or role and a server-side allowlisted user identifier.
        </p>
        @if (catalogueError()) {
          <pre class="api-error" role="alert">{{ catalogueError() }}</pre>
        }
        <div class="button-row">
          <a class="button secondary" [href]="openApiAssetUrl" target="_blank" rel="noreferrer">
            Open raw OpenAPI YAML
          </a>
        </div>
      </section>

      @for (operation of endpoints(); track operation.id) {
        <section class="card endpoint-card" [attr.aria-labelledby]="operation.id + '-title'">
          <div class="endpoint-heading">
            <span class="method-badge" [class]="'method-badge ' + operation.method">{{ operation.method.toUpperCase() }}</span>
            <code class="endpoint-path">{{ operation.path }}</code>
            <span class="tag-badge">{{ operation.tag }}</span>
          </div>
          <h2 [id]="operation.id + '-title'">{{ operation.summary }}</h2>
          <p>{{ operation.description }}</p>
          <p class="status" [class.good]="!operation.requiresAuth" [class.warn]="operation.requiresAuth">
            {{ operation.requiresAuth ? 'Requires Microsoft Entra bearer token with the configured API scope and allowlisted user.' : 'Public endpoint; no bearer token required.' }}
          </p>

          @if (operation.requestFields.length || operation.parameterFields.length) {
            @if (operation.parameterFields.length) {
              <div class="docs-panel">
                <h3>URL parameters</h3>
                <div class="field-table" role="table" [attr.aria-label]="operation.summary + ' url parameters'">
                  @for (field of operation.parameterFields; track field.name) {
                    <div class="field-row" role="row">
                      <div role="cell">
                        <strong>{{ field.name }}</strong>
                        @if (field.required) { <span class="required">required</span> }
                      </div>
                      <div role="cell"><code>{{ field.parameterIn }}</code></div>
                      <div role="cell"><code>{{ field.type }}</code></div>
                      <div role="cell">{{ field.description }}</div>
                    </div>
                  }
                </div>
              </div>
            }
            <div class="docs-panel">
              <h3>Request body: <code>{{ operation.requestSchemaName }}</code></h3>
              <p class="muted">Content type: {{ operation.requestContentType }}{{ operation.requestRequired ? '; required' : '; optional' }}</p>
              <div class="field-table" role="table" [attr.aria-label]="operation.summary + ' request fields'">
                @for (field of operation.requestFields; track field.name) {
                  <div class="field-row" role="row">
                    <div role="cell">
                      <strong>{{ field.name }}</strong>
                      @if (field.required) { <span class="required">required</span> }
                    </div>
                    <div role="cell"><code>{{ field.type }}</code></div>
                    <div role="cell">{{ field.description }}</div>
                    <div role="cell" class="muted">{{ field.constraints }}</div>
                  </div>
                }
              </div>
              @if (operation.requestExample) {
                <details>
                  <summary>Example request payload</summary>
                  <pre class="api-result">{{ operation.requestExample }}</pre>
                </details>
              }
            </div>

            <form class="try-form" (submit)="tryOperation(operation); $event.preventDefault()">
              <h3>Try this endpoint</h3>
              @for (field of operation.parameterFields; track field.name) {
                <label class="field">
                  <span>{{ field.name }} ({{ field.parameterIn }}) @if (field.required) { <em>(required)</em> }</span>
                  <input
                    [type]="field.inputType"
                    [value]="inputValue(operation.id, field.name)"
                    (input)="setInputValue(operation.id, field.name, $any($event.target).value)"
                  />
                  <small>{{ field.description }}</small>
                </label>
              }
              @for (field of operation.requestFields; track field.name) {
                <label class="field">
                  <span>{{ field.name }} @if (field.required) { <em>(required)</em> }</span>
                  @if (field.enumValues.length) {
                    <select [value]="inputValue(operation.id, field.name)" (change)="setInputValue(operation.id, field.name, $any($event.target).value)">
                      @for (value of field.enumValues; track value) {
                        <option [value]="value">{{ value }}</option>
                      }
                    </select>
                  } @else if (field.inputType === 'checkbox') {
                    <input type="checkbox" [checked]="inputValue(operation.id, field.name) === 'true'" (change)="setInputValue(operation.id, field.name, $any($event.target).checked ? 'true' : 'false')" />
                  } @else {
                    <input
                      [type]="field.inputType"
                      [min]="field.inputType === 'number' ? minimumFor(field) : null"
                      [max]="field.inputType === 'number' ? maximumFor(field) : null"
                      [value]="inputValue(operation.id, field.name)"
                      (input)="setInputValue(operation.id, field.name, $any($event.target).value)"
                    />
                  }
                  <small>{{ field.description }}</small>
                </label>
              }
              <button class="button" type="submit" [disabled]="isOperationLoading(operation.id) || (operation.requiresAuth && !canUseAuth())">
                {{ isOperationLoading(operation.id) ? 'Calling…' : 'Send ' + operation.method.toUpperCase() + ' ' + operation.path }}
              </button>
            </form>
          } @else {
            <div class="try-form">
              <h3>Try this endpoint</h3>
              <button class="button" type="button" (click)="tryOperation(operation)" [disabled]="isOperationLoading(operation.id) || (operation.requiresAuth && !canUseAuth())">
                {{ isOperationLoading(operation.id) ? 'Calling…' : 'Send ' + operation.method.toUpperCase() + ' ' + operation.path }}
              </button>
            </div>
          }

          @if (operationError(operation.id)) {
            <pre class="api-error" role="alert">{{ operationError(operation.id) }}</pre>
          }
          @if (operationResult(operation.id)) {
            <pre class="api-result">{{ operationResult(operation.id) }}</pre>
          }

          <div class="docs-panel">
            <h3>Responses</h3>
            @for (response of operation.responses; track response.status) {
              <details class="response-detail" [open]="response.status.startsWith('2')">
                <summary><strong>{{ response.status }}</strong> — {{ response.description }}</summary>
                @if (response.schemaName) {
                  <p>Returns <code>{{ response.schemaName }}</code>.</p>
                }
                @if (response.fields.length) {
                  <div class="field-table" role="table" [attr.aria-label]="operation.summary + ' response ' + response.status + ' fields'">
                    @for (field of response.fields; track field.name) {
                      <div class="field-row" role="row">
                        <div role="cell">
                          <strong>{{ field.name }}</strong>
                          @if (field.required) { <span class="required">required</span> }
                        </div>
                        <div role="cell"><code>{{ field.type }}</code></div>
                        <div role="cell">{{ field.description }}</div>
                        <div role="cell" class="muted">{{ field.example ? 'Example: ' + field.example : field.constraints }}</div>
                      </div>
                    }
                  </div>
                }
                @if (response.example) {
                  <pre class="api-result">{{ response.example }}</pre>
                }
              </details>
            }
          </div>

          @if (operation.schemas.length) {
            <div class="docs-panel">
              <h3>Object schemas used by this API</h3>
              @for (schema of operation.schemas; track schema.name) {
                <details class="schema-detail">
                  <summary><code>{{ schema.name }}</code>{{ schema.description ? ' — ' + schema.description : '' }}</summary>
                  <div class="field-table" role="table" [attr.aria-label]="schema.name + ' fields'">
                    @for (field of schema.fields; track field.name) {
                      <div class="field-row" role="row">
                        <div role="cell">
                          <strong>{{ field.name }}</strong>
                          @if (field.required) { <span class="required">required</span> }
                        </div>
                        <div role="cell"><code>{{ field.type }}</code></div>
                        <div role="cell">{{ field.description }}</div>
                        <div role="cell" class="muted">{{ field.constraints }}</div>
                      </div>
                    }
                  </div>
                </details>
              }
            </div>
          }
        </section>
      }

      <aside class="notice" role="note">
        <strong>/health</strong> remains public. Protected APIs require server-side JWT validation
        when <code>AUTH_ENABLED=true</code>; the OpenAPI explorer adds the bearer token only after sign-in.
      </aside>
    </main>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppComponent {
  protected readonly activeAccount = signal<AccountInfo | null>(msalClient?.getActiveAccount() ?? null);
  protected readonly endpoints = signal<ApiOperationDoc[]>([]);
  protected readonly formValues = signal<Record<string, Record<string, string>>>({});
  protected readonly catalogueError = signal<string | null>(null);
  protected readonly loadingOperations = signal<Record<string, boolean>>({});
  protected readonly operationResults = signal<Record<string, string>>({});
  protected readonly operationErrors = signal<Record<string, string>>({});
  protected readonly canUseAuth = computed(() => Boolean(msalClient && config.authApiScope));
  protected readonly isSignedIn = computed(() => this.activeAccount() !== null);
  protected readonly statusMessage = computed(() => {
    if (!config.authEnabled) {
      return 'Authentication UI disabled by WEB_AUTH_ENABLED.';
    }
    if (!this.canUseAuth()) {
      return 'Authentication config is incomplete.';
    }
    const account = this.activeAccount();
    return account ? `Signed in as ${account.username || account.name || 'an allowed account'}.` : 'Signed out.';
  });
  protected readonly openApiVersion = signal('loading');
  protected readonly openApiAssetUrl = OPENAPI_ASSET_URL;

  constructor() {
    void this.loadOpenApiDocument();
  }


  private async loadOpenApiDocument(): Promise<void> {
    try {
      const response = await fetch(OPENAPI_ASSET_URL);
      if (!response.ok) {
        throw new Error(`OpenAPI document returned ${response.status}.`);
      }

      openApiDocument = YAML.parse(await response.text()) as OpenApiDocument;
      const operations = buildApiOperations(openApiDocument);
      this.endpoints.set(operations);
      this.formValues.set(Object.fromEntries(
        operations.map((operation) => [operation.id, buildInitialBody(operation)]),
      ) as Record<string, Record<string, string>>);
      this.openApiVersion.set(openApiDocument.info.version);
      this.catalogueError.set(null);
    } catch (error) {
      this.catalogueError.set(error instanceof Error ? error.message : 'Failed to load OpenAPI document.');
      this.openApiVersion.set('unavailable');
    }
  }

  async login(): Promise<void> {
    if (!msalClient || !config.authApiScope) {
      this.setGlobalError('Authentication is not configured.');
      return;
    }

    this.clearAllErrors();
    await msalClient.loginRedirect({ scopes: [config.authApiScope] });
  }

  async logout(): Promise<void> {
    if (!msalClient) {
      return;
    }

    const account = this.activeAccount();
    await msalClient.logoutPopup({ account });
    this.activeAccount.set(null);
    this.operationResults.set({});
    this.operationErrors.set({});
  }

  inputValue(operationId: string, fieldName: string): string {
    return this.formValues()[operationId]?.[fieldName] ?? '';
  }

  setInputValue(operationId: string, fieldName: string, value: string): void {
    this.formValues.update((current) => ({
      ...current,
      [operationId]: {
        ...(current[operationId] ?? {}),
        [fieldName]: value,
      },
    }));
  }

  operationResult(operationId: string): string {
    return this.operationResults()[operationId] ?? '';
  }

  operationError(operationId: string): string {
    return this.operationErrors()[operationId] ?? '';
  }

  isOperationLoading(operationId: string): boolean {
    return this.loadingOperations()[operationId] === true;
  }

  minimumFor(field: SchemaFieldDoc): number | null {
    const match = /min ([^,]+)/.exec(field.constraints);
    return match ? Number(match[1]) : null;
  }

  maximumFor(field: SchemaFieldDoc): number | null {
    const match = /max ([^,]+)/.exec(field.constraints);
    return match ? Number(match[1]) : null;
  }

  async tryOperation(operation: ApiOperationDoc): Promise<void> {
    this.setOperationLoading(operation.id, true);
    this.clearOperationMessages(operation.id);

    try {
      const headers: Record<string, string> = {};
      if (operation.requiresAuth) {
        if (!msalClient || !config.authApiScope) {
          throw new Error('Authentication is not configured.');
        }

        const account = this.activeAccount() ?? msalClient.getAllAccounts()[0] ?? null;
        if (!account) {
          throw new Error('Sign in before calling the protected API.');
        }

        headers['Authorization'] = `Bearer ${await acquireAccessToken(account)}`;
      }

      const init: RequestInit = { method: operation.method.toUpperCase(), headers };
      const requestUrl = this.buildRequestUrl(operation);
      if (operation.requestFields.length) {
        headers['Content-Type'] = operation.requestContentType;
        init.body = JSON.stringify(this.buildRequestBody(operation));
      }

      const response = await fetch(requestUrl, init);
      const responseText = await response.text();
      const responseBody = parseJsonOrText(responseText);
      const formattedBody = formatBody(responseBody, true);

      if (!response.ok) {
        throw new Error(`API returned ${response.status}: ${formatBody(responseBody)}`);
      }

      this.operationResults.update((current) => ({
        ...current,
        [operation.id]: formattedBody,
      }));
    } catch (error) {
      this.operationErrors.update((current) => ({
        ...current,
        [operation.id]: error instanceof Error ? error.message : 'Unknown API error.',
      }));
    } finally {
      this.setOperationLoading(operation.id, false);
    }
  }

  private buildRequestBody(operation: ApiOperationDoc): JsonObject {
    const values = this.formValues()[operation.id] ?? {};
    const body: JsonObject = {};

    for (const field of operation.requestFields) {
      const rawValue = values[field.name] ?? '';
      if (!field.required && rawValue === '') {
        continue;
      }

      if (field.inputType === 'number') {
        body[field.name] = Number(rawValue);
      } else if (field.inputType === 'checkbox') {
        body[field.name] = rawValue === 'true';
      } else {
        body[field.name] = rawValue;
      }
    }

    return body;
  }

  private buildRequestUrl(operation: ApiOperationDoc): string {
    const values = this.formValues()[operation.id] ?? {};
    let path = operation.path;
    const query = new URLSearchParams();
    for (const field of operation.parameterFields) {
      const rawValue = values[field.name] ?? '';
      if (!field.required && rawValue === '') continue;
      if (field.parameterIn === 'path') {
        path = path.replace(`{${field.name}}`, encodeURIComponent(rawValue));
      } else if (field.parameterIn === 'query') {
        query.set(field.name, rawValue);
      }
    }
    const qs = query.toString();
    return `${config.apiBaseUrl}${path}${qs ? `?${qs}` : ''}`;
  }

  private setOperationLoading(operationId: string, loading: boolean): void {
    this.loadingOperations.update((current) => ({ ...current, [operationId]: loading }));
  }

  private clearOperationMessages(operationId: string): void {
    this.operationErrors.update((current) => ({ ...current, [operationId]: '' }));
    this.operationResults.update((current) => ({ ...current, [operationId]: '' }));
  }

  private clearAllErrors(): void {
    this.operationErrors.set({});
  }

  private setGlobalError(message: string): void {
    const firstOperation = this.endpoints()[0];
    this.operationErrors.update((current) => ({
      ...current,
      [firstOperation?.id ?? 'global']: message,
    }));
  }
}

async function initializeMsal(): Promise<void> {
  if (!msalClient) {
    return;
  }

  await msalClient.initialize();
  const redirectResult = await msalClient.handleRedirectPromise({ navigateToLoginRequestUrl: false });
  if (redirectResult?.account) {
    msalClient.setActiveAccount(redirectResult.account);
  } else if (!msalClient.getActiveAccount()) {
    msalClient.setActiveAccount(msalClient.getAllAccounts()[0] ?? null);
  }

  msalClient.addEventCallback((event) => {
    if (event.eventType === EventType.LOGIN_SUCCESS && event.payload && 'account' in event.payload) {
      msalClient.setActiveAccount(event.payload.account ?? null);
    }
  });
}

async function acquireAccessToken(account: AccountInfo): Promise<string> {
  if (!msalClient) {
    throw new Error('Authentication is not configured.');
  }

  try {
    const result = await msalClient.acquireTokenSilent({ account, scopes: [config.authApiScope] });
    return result.accessToken;
  } catch (error) {
    if (error instanceof InteractionRequiredAuthError) {
      await msalClient.acquireTokenRedirect({ account, scopes: [config.authApiScope] });
      throw new Error('Redirecting to sign in for API access.');
    }
    throw error;
  }
}

function buildApiOperations(document: OpenApiDocument): ApiOperationDoc[] {
  return Object.entries(document.paths)
    .flatMap(([path, pathItem]) =>
      Object.entries(pathItem)
        .filter(([method]) => httpMethods.includes(method as HttpMethod))
        .map(([method, operation]) => {
          const typedOperation = operation as OpenApiOperation;
          const id = typedOperation.operationId ?? `${method}-${path.replace(/[^a-z0-9]+/gi, '-')}`;
          const requestMedia = typedOperation.requestBody?.content?.['application/json'];
          const requestSchema = resolveSchema(requestMedia?.schema);
          const requestExample = firstExample(requestMedia?.examples) ?? exampleFromSchema(requestSchema);
          const responses = Object.entries(typedOperation.responses ?? {}).map(([status, response]) => {
            const responseMedia = response.content?.['application/json'];
            const responseSchema = resolveSchema(responseMedia?.schema);
            return {
              status,
              description: response.description ?? '',
              schemaName: schemaName(responseMedia?.schema),
              fields: schemaFields(responseSchema),
              example: stringifyExample(firstExample(responseMedia?.examples) ?? exampleFromSchema(responseSchema)),
            };
          });

          return {
            id,
            method: method as HttpMethod,
            path,
            tag: typedOperation.tags?.[0] ?? 'API',
            summary: typedOperation.summary ?? `${method.toUpperCase()} ${path}`,
            description: normalizeDescription(typedOperation.description),
            requiresAuth: Boolean(typedOperation.security?.length),
            requestRequired: typedOperation.requestBody?.required === true,
            requestContentType: requestMedia ? 'application/json' : '',
            requestSchemaName: schemaName(requestMedia?.schema),
            requestFields: schemaFields(requestSchema),
            requestExample: stringifyExample(requestExample),
            parameterFields: parameterFields(typedOperation),
            responses,
            schemas: relatedSchemas([
              requestMedia?.schema,
              ...responses.map((response) =>
                response.schemaName ? { $ref: `#/components/schemas/${response.schemaName}` } : undefined,
              ),
            ]),
          };
        }),
    )
    .sort((left, right) => left.path.localeCompare(right.path) || left.method.localeCompare(right.method));
}

function relatedSchemas(schemaRefs: (OpenApiSchema | string | undefined)[]): SchemaDoc[] {
  const seen = new Set<string>();
  const docs: SchemaDoc[] = [];

  const visit = (schemaOrName: OpenApiSchema | string | undefined): void => {
    const name = typeof schemaOrName === 'string' ? schemaOrName : schemaName(schemaOrName);
    if (!name || seen.has(name)) {
      return;
    }

    const schema = openApiDocument.components?.schemas?.[name];
    if (!schema) {
      return;
    }

    seen.add(name);
    docs.push({ name, description: schema.description ?? '', fields: schemaFields(schema) });

    for (const property of Object.values(schema.properties ?? {})) {
      if (property.$ref) {
        visit(property);
      }
      if (property.items?.$ref) {
        visit(property.items);
      }
    }
  };

  for (const schemaRef of schemaRefs) {
    visit(schemaRef);
  }

  return docs;
}

function schemaFields(schema: OpenApiSchema | undefined): SchemaFieldDoc[] {
  if (!schema?.properties) {
    return [];
  }

  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties).map(([name, property]) => {
    const resolved = resolveSchema(property) ?? property;
    const enumValues = (resolved.enum ?? []).map(String);
    return {
      name,
      type: describeType(property),
      required: required.has(name),
      description: resolved.description ?? 'No description supplied yet.',
      defaultValue: resolved.default === undefined ? '' : String(resolved.default),
      constraints: describeConstraints(resolved),
      enumValues,
      example: stringifyInlineExample(firstSchemaExample(resolved)),
      inputType: inputTypeFor(resolved),
    };
  });
}

function parameterFields(operation: OpenApiOperation): (SchemaFieldDoc & { parameterIn: 'path' | 'query' })[] {
  return (operation.parameters ?? [])
    .filter((parameter) => parameter.in === 'path' || parameter.in === 'query')
    .map((parameter) => {
      const parameterIn = parameter.in as 'path' | 'query';
      const schema = resolveSchema(parameter.schema) ?? parameter.schema ?? { type: 'string' };
      return {
        name: parameter.name,
        type: describeType(schema),
        required: parameter.required === true,
        description: parameter.description ?? schema.description ?? 'No description supplied yet.',
        defaultValue: schema.default === undefined ? '' : String(schema.default),
        constraints: describeConstraints(schema),
        enumValues: (schema.enum ?? []).map(String),
        example: stringifyInlineExample(firstSchemaExample(schema)),
        inputType: inputTypeFor(schema),
        parameterIn,
      };
    });
}

function resolveSchema(schema: OpenApiSchema | undefined): OpenApiSchema | undefined {
  if (!schema?.$ref) {
    return schema;
  }

  const name = schemaName(schema);
  return name ? openApiDocument.components?.schemas?.[name] : schema;
}

function schemaName(schema: OpenApiSchema | undefined): string {
  return schema?.$ref?.replace('#/components/schemas/', '') ?? '';
}

function describeType(schema: OpenApiSchema): string {
  if (schema.$ref) {
    return `${schemaName(schema)} object`;
  }
  if (schema.items) {
    return `${describeType(schema.items)}[]`;
  }
  if (Array.isArray(schema.type)) {
    return schema.type.join(' | ');
  }
  const schemaType = typeof schema.type === 'string' ? schema.type : 'value';
  return schema.format ? `${schemaType} (${schema.format})` : schemaType;
}

function describeConstraints(schema: OpenApiSchema): string {
  const constraints: string[] = [];
  if (schema.minimum !== undefined) {
    constraints.push(`min ${schema.minimum}`);
  }
  if (schema.maximum !== undefined) {
    constraints.push(`max ${schema.maximum}`);
  }
  if (schema.default !== undefined) {
    constraints.push(`default ${schema.default}`);
  }
  if (schema.const !== undefined) {
    constraints.push(`const ${schema.const}`);
  }
  if (schema.enum?.length) {
    constraints.push(`allowed ${schema.enum.join(', ')}`);
  }
  return constraints.join(', ');
}

function inputTypeFor(schema: OpenApiSchema): SchemaFieldDoc['inputType'] {
  if (schema.enum?.length) {
    return 'select';
  }
  if (schema.type === 'integer' || schema.type === 'number') {
    return 'number';
  }
  if (schema.type === 'boolean') {
    return 'checkbox';
  }
  return 'text';
}

function firstSchemaExample(schema: OpenApiSchema): unknown {
  if (schema.examples?.length) {
    return schema.examples[0];
  }
  if (schema.default !== undefined) {
    return schema.default;
  }
  if (schema.const !== undefined) {
    return schema.const;
  }
  return '';
}

function exampleFromSchema(schema: OpenApiSchema | undefined): unknown {
  if (!schema) {
    return undefined;
  }
  const resolved = resolveSchema(schema) ?? schema;
  if (resolved.examples?.length) {
    return resolved.examples[0];
  }
  if (resolved.const !== undefined) {
    return resolved.const;
  }
  if (resolved.default !== undefined) {
    return resolved.default;
  }
  if (resolved.properties) {
    return Object.fromEntries(
      Object.entries(resolved.properties).map(([name, property]) => [name, exampleFromSchema(property)]),
    );
  }
  if (resolved.items) {
    return [exampleFromSchema(resolved.items)];
  }
  if (resolved.enum?.length) {
    return resolved.enum[0];
  }
  if (resolved.type === 'integer' || resolved.type === 'number') {
    return 0;
  }
  if (resolved.type === 'boolean') {
    return false;
  }
  if (Array.isArray(resolved.type) && resolved.type.includes('null')) {
    return null;
  }
  return '';
}

function firstExample(examples: Record<string, { value?: unknown }> | undefined): unknown {
  return Object.values(examples ?? {})[0]?.value;
}

function stringifyExample(example: unknown): string {
  return example === undefined ? '' : JSON.stringify(example, null, 2);
}

function stringifyInlineExample(example: unknown): string {
  if (example === undefined || example === '') {
    return '';
  }
  return typeof example === 'string' ? example : JSON.stringify(example);
}

function buildInitialBody(operation: ApiOperationDoc): Record<string, string> {
  const example = operation.requestExample ? parseJsonOrText(operation.requestExample) : {};
  return Object.fromEntries(
    operation.requestFields.map((field) => {
      const exampleValue = typeof example === 'object' && example !== null ? (example as JsonObject)[field.name] : undefined;
      const value = exampleValue ?? field.defaultValue ?? '';
      return [field.name, value === undefined || value === null ? '' : String(value)];
    }),
  );
}

function normalizeDescription(description: string | undefined): string {
  return description?.replace(/\s+/g, ' ').trim() ?? '';
}

function createMsalClient(runtimeConfig: RuntimeConfig): PublicClientApplication | null {
  if (!runtimeConfig.authEnabled || !runtimeConfig.authClientId || !runtimeConfig.authAuthority) {
    return null;
  }

  return new PublicClientApplication({
    auth: {
      clientId: runtimeConfig.authClientId,
      authority: runtimeConfig.authAuthority,
      redirectUri: runtimeConfig.authRedirectUri || window.location.origin,
    },
    cache: {
      cacheLocation: BrowserCacheLocation.SessionStorage,
    },
  });
}

function readRuntimeConfig(): RuntimeConfig {
  const runtimeConfig = window.API_CATALOGUE_CONFIG ?? {};
  return {
    authEnabled: runtimeConfig.authEnabled === true,
    authClientId: runtimeConfig.authClientId?.trim() ?? '',
    authAuthority: runtimeConfig.authAuthority?.replace(/\/$/, '') ?? '',
    authRedirectUri: runtimeConfig.authRedirectUri?.trim() || window.location.origin,
    authApiScope: runtimeConfig.authApiScope?.trim() ?? '',
    apiBaseUrl: runtimeConfig.apiBaseUrl?.replace(/\/$/, '') ?? '',
  };
}

function parseJsonOrText(responseText: string): unknown {
  if (!responseText) {
    return '';
  }

  try {
    return JSON.parse(responseText) as unknown;
  } catch {
    return responseText;
  }
}

function formatBody(body: unknown, pretty = false): string {
  return typeof body === 'string' ? body : JSON.stringify(body, null, pretty ? 2 : undefined);
}

// MSAL silent-token renewal uses a hidden iframe pointed at the SPA redirect URI.
// Keep every embedded iframe inert so Angular and MSAL redirect handling cannot start in
// the child frame before or after Microsoft Entra returns the auth response.
if (!isEmbeddedFrame()) {
  initializeMsal()
    .then(() => bootstrapApplication(AppComponent))
    .catch((error: unknown) => {
      console.error('Failed to bootstrap Angular application.', error);
    });
}

function isEmbeddedFrame(): boolean {
  return window.self !== window.top;
}
