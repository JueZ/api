import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import type { AccountInfo } from '@azure/msal-browser';
import { acquireAccessToken, createMsalClient, initializeMsal } from './app/auth';
import { buildCurlCommand } from './app/curl';
import { buildApiOperations, parseOpenApiDocument, type ApiOperationDoc, type SchemaFieldDoc } from './app/openapi';
import { formatApiError, formatProblemResponse, type SafeProblemView } from './app/problem-format';
import {
  buildInitialBody,
  buildRequestBody,
  buildRequestHeaders,
  buildRequestUrl,
  formatBody,
  parseJsonOrText,
  sanitizeOperationResponse,
} from './app/request-builder';
import { readRuntimeConfig } from './app/runtime-config';

const OPENAPI_ASSET_URL = 'assets/openapi.yaml';
const config = readRuntimeConfig();
const msalClient = createMsalClient(config);

interface PendingBringConfirmation {
  operationId: string;
  operation: 'complete' | 'remove';
  listPseudonym: string;
  itemCount: number;
  expiresAt: string;
}

@Component({
  selector: 'app-root',
  standalone: true,
  template: `
    <main class="shell" aria-labelledby="project-title">
      <section class="hero">
        <p class="eyebrow">Personal API catalogue</p>
        <h1 id="project-title">JueZ API Catalogue</h1>
        <p class="lede">A thin, serverless v0 foundation for publishing personal API integrations.</p>
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
          <p class="muted">Auth UI is disabled until non-secret Microsoft Entra runtime config is supplied.</p>
        }
      </section>

      <section class="card catalogue-card" aria-labelledby="catalogue-title">
        <h2 id="catalogue-title">API catalogue</h2>
        <p>
          This interactive catalogue is generated from the OpenAPI {{ openApiVersion() }} contract. It shows the
          expected payload fields, response objects, examples, and lets you call each endpoint from the browser.
        </p>
        <p class="muted">
          This endpoint now requires a valid OAuth/OIDC access token with the configured API scope or role and a
          server-side allowlisted user identifier.
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

      <section class="card bring-guide" aria-labelledby="bring-guide-title">
        <p class="eyebrow">Shopping lists</p>
        <h2 id="bring-guide-title">Bring! lists and items</h2>
        <p>
          Sign in, choose an explicitly allowlisted list, and read its current version. Adds use a caller-generated
          operation UUID. Complete and remove are always prepared first and applied only after a separate confirmation.
        </p>
        <div class="button-row">
          <a class="button secondary" href="#bringListLists">1. Choose a list</a>
          <a class="button secondary" href="#bringGetItems">2. View items</a>
          <a class="button secondary" href="#bringAddItems">3. Add items</a>
          <a class="button secondary" href="#bringPrepareItemMutation">4. Prepare complete/remove</a>
          <a class="button secondary" href="#bringApplyItemMutation">5. Confirm and apply</a>
        </div>
        <p class="muted">
          Production writes are denied for shared or unlisted lists. Test is read-only. Creating, deleting, or sharing
          whole lists is intentionally unsupported.
        </p>
        @if (pendingBringConfirmation(); as pending) {
          <div class="caller-instruction" role="status">
            <strong>Prepared {{ pending.operation }} operation</strong>
            <p>
              {{ pending.itemCount }} item(s) on list {{ pending.listPseudonym }}. Confirmation expires
              {{ pending.expiresAt }}. The apply form has been populated; review it before confirming.
            </p>
            <a class="button secondary" href="#bringApplyItemMutation">Review confirmation</a>
          </div>
        }
      </section>

      @for (operation of endpoints(); track operation.id) {
        <section class="card endpoint-card" [id]="operation.id" [attr.aria-labelledby]="operation.id + '-title'">
          <div class="endpoint-heading">
            <span class="method-badge" [class]="'method-badge ' + operation.method">{{
              operation.method.toUpperCase()
            }}</span>
            <code class="endpoint-path">{{ operation.path }}</code>
            <span class="tag-badge">{{ operation.tag }}</span>
            <a class="anchor-link" [href]="'#' + operation.id" [attr.aria-label]="'Link to ' + operation.summary"
              >#{{ operation.id }}</a
            >
          </div>
          <h2 [id]="operation.id + '-title'">{{ operation.summary }}</h2>
          <p>{{ operation.description }}</p>
          <p class="status" [class.good]="!operation.requiresAuth" [class.warn]="operation.requiresAuth">
            {{
              operation.requiresAuth ? operationScopeMessage(operation) : 'Public endpoint; no bearer token required.'
            }}
          </p>

          @if (operation.parameterFields.length) {
            <div class="docs-panel">
              <h3>URL parameters</h3>
              <div class="field-table" role="table" [attr.aria-label]="operation.summary + ' url parameters'">
                @for (field of operation.parameterFields; track field.name) {
                  <div class="field-row" role="row">
                    <div role="cell">
                      <strong>{{ field.name }}</strong>
                      @if (field.required) {
                        <span class="required">required</span>
                      }
                    </div>
                    <div role="cell">
                      <code>{{ field.parameterIn }}</code>
                    </div>
                    <div role="cell">
                      <code>{{ field.type }}</code>
                    </div>
                    <div role="cell">{{ field.description }}</div>
                  </div>
                }
              </div>
            </div>
          }

          @if (operation.requestFields.length) {
            <div class="docs-panel">
              <h3>
                Request body: <code>{{ operation.requestSchemaName }}</code>
              </h3>
              <p class="muted">
                Content type: {{ operation.requestContentType
                }}{{ operation.requestRequired ? '; required' : '; optional' }}
              </p>
              <div class="field-table" role="table" [attr.aria-label]="operation.summary + ' request fields'">
                @for (field of operation.requestFields; track field.name) {
                  <div class="field-row" role="row">
                    <div role="cell">
                      <strong>{{ field.name }}</strong>
                      @if (field.required) {
                        <span class="required">required</span>
                      }
                    </div>
                    <div role="cell">
                      <code>{{ field.type }}</code>
                    </div>
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
          }

          <form class="try-form" (submit)="tryOperation(operation); $event.preventDefault()">
            <h3>Try this endpoint</h3>
            @for (field of operation.parameterFields; track field.name) {
              <label class="field">
                <span
                  >{{ field.name }} ({{ field.parameterIn }})
                  @if (field.required) {
                    <em>(required)</em>
                  }
                </span>
                <input
                  [type]="field.inputType"
                  [value]="inputValue(operation.id, field.name)"
                  (input)="setInputValue(operation.id, field.name, $any($event.target).value)"
                />
                <small>{{ field.description }}</small>
              </label>
            }
            @for (field of operation.requestFields; track field.name) {
              @if (!isSensitiveRequestField(operation, field)) {
                <label class="field">
                  <span
                    >{{ field.name }}
                    @if (field.required) {
                      <em>(required)</em>
                    }
                  </span>
                  @if (field.enumValues.length) {
                    <select
                      [value]="inputValue(operation.id, field.name)"
                      (change)="setInputValue(operation.id, field.name, $any($event.target).value)"
                    >
                      @for (value of field.enumValues; track value) {
                        <option [value]="value">{{ value }}</option>
                      }
                    </select>
                  } @else if (field.inputType === 'checkbox') {
                    <input
                      type="checkbox"
                      [checked]="inputValue(operation.id, field.name) === 'true'"
                      (change)="setInputValue(operation.id, field.name, $any($event.target).checked ? 'true' : 'false')"
                    />
                  } @else if (field.inputType === 'textarea') {
                    <textarea
                      rows="8"
                      [value]="inputValue(operation.id, field.name)"
                      (input)="setInputValue(operation.id, field.name, $any($event.target).value)"
                    ></textarea>
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
            }
            <div class="button-row">
              <button
                class="button"
                type="submit"
                [disabled]="isOperationLoading(operation.id) || (operation.requiresAuth && !canUseAuth())"
              >
                {{ isOperationLoading(operation.id) ? 'Calling…' : operationButtonLabel(operation) }}
              </button>
              <button class="button secondary" type="button" (click)="copyCurl(operation)">Copy as curl</button>
            </div>
            @if (copyStatus(operation.id)) {
              <p class="muted">{{ copyStatus(operation.id) }}</p>
            }
          </form>

          @if (operationProblem(operation.id); as problem) {
            <section class="problem-card" role="alert" aria-label="Problem response">
              <div class="problem-heading">
                <strong>{{ problem.title }}</strong>
                <span>Status {{ problem.status }}</span>
              </div>
              @if (problem.detail) {
                <p>{{ problem.detail }}</p>
              }
              @if (problem.callerInstruction) {
                <div class="caller-instruction">
                  <strong>caller_instruction</strong>
                  <p>{{ problem.callerInstruction }}</p>
                </div>
              }
              @if (problem.retryPolicy) {
                <h3>retry_policy</h3>
                <pre class="api-result">{{ problem.retryPolicy }}</pre>
              }
              @if (problem.repairPatch) {
                <h3>repair_patch</h3>
                <pre class="api-result">{{ problem.repairPatch }}</pre>
              }
              @if (problem.repairPlan) {
                <h3>repair_plan</h3>
                <pre class="api-result">{{ problem.repairPlan }}</pre>
              }
              @if (problem.diagnosticId) {
                <p>
                  <strong>diagnostic_id:</strong> <code>{{ problem.diagnosticId }}</code>
                </p>
              }
            </section>
          } @else if (operationError(operation.id)) {
            <pre class="api-error" role="alert">{{ operationError(operation.id) }}</pre>
          }
          @if (operationResult(operation.id)) {
            <pre class="api-result">{{ operationResult(operation.id) }}</pre>
          }

          <div class="docs-panel">
            <h3>Responses</h3>
            @for (response of operation.responses; track response.status) {
              <details class="response-detail" [open]="response.status.startsWith('2')">
                <summary>
                  <strong>{{ response.status }}</strong> — {{ response.description }}
                </summary>
                @if (response.schemaName) {
                  <p>
                    Returns <code>{{ response.schemaName }}</code
                    >.
                  </p>
                }
                @if (response.fields.length) {
                  <div
                    class="field-table"
                    role="table"
                    [attr.aria-label]="operation.summary + ' response ' + response.status + ' fields'"
                  >
                    @for (field of response.fields; track field.name) {
                      <div class="field-row" role="row">
                        <div role="cell">
                          <strong>{{ field.name }}</strong>
                          @if (field.required) {
                            <span class="required">required</span>
                          }
                        </div>
                        <div role="cell">
                          <code>{{ field.type }}</code>
                        </div>
                        <div role="cell">{{ field.description }}</div>
                        <div role="cell" class="muted">
                          {{ field.example ? 'Example: ' + field.example : field.constraints }}
                        </div>
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
                  <summary>
                    <code>{{ schema.name }}</code
                    >{{ schema.description ? ' — ' + schema.description : '' }}
                  </summary>
                  <div class="field-table" role="table" [attr.aria-label]="schema.name + ' fields'">
                    @for (field of schema.fields; track field.name) {
                      <div class="field-row" role="row">
                        <div role="cell">
                          <strong>{{ field.name }}</strong>
                          @if (field.required) {
                            <span class="required">required</span>
                          }
                        </div>
                        <div role="cell">
                          <code>{{ field.type }}</code>
                        </div>
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
        <strong>/health</strong> remains public. Protected APIs require server-side JWT validation when
        <code>AUTH_ENABLED=true</code>; the OpenAPI explorer adds the bearer token only after sign-in.
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
  protected readonly operationProblems = signal<Record<string, SafeProblemView | null>>({});
  protected readonly copyStatuses = signal<Record<string, string>>({});
  protected readonly pendingBringConfirmation = signal<PendingBringConfirmation | null>(null);
  private pendingBringConfirmationToken: string | null = null;
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

      const openApiDocument = parseOpenApiDocument(await response.text());
      const operations = buildApiOperations(openApiDocument);
      this.endpoints.set(operations);
      this.formValues.set(
        Object.fromEntries(operations.map((operation) => [operation.id, buildInitialBody(operation)])) as Record<
          string,
          Record<string, string>
        >,
      );
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
    this.operationProblems.set({});
    this.pendingBringConfirmation.set(null);
    this.pendingBringConfirmationToken = null;
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

  operationProblem(operationId: string): SafeProblemView | null {
    return this.operationProblems()[operationId] ?? null;
  }

  copyStatus(operationId: string): string {
    return this.copyStatuses()[operationId] ?? '';
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

  isSensitiveRequestField(operation: ApiOperationDoc, field: SchemaFieldDoc): boolean {
    return operation.id === 'bringApplyItemMutation' && field.name === 'confirmationToken';
  }

  operationScopeMessage(operation: ApiOperationDoc): string {
    const scopes = operation.requiredScopes.length
      ? operation.requiredScopes.join(' or ')
      : 'the configured API permission';
    return `Requires Microsoft Entra bearer token with ${scopes} and an allowlisted principal.`;
  }

  operationButtonLabel(operation: ApiOperationDoc): string {
    if (operation.id === 'bringApplyItemMutation') {
      return 'Confirm and apply prepared mutation';
    }
    return `Send ${operation.method.toUpperCase()} ${operation.path}`;
  }

  async tryOperation(operation: ApiOperationDoc): Promise<void> {
    if (
      operation.id === 'bringApplyItemMutation' &&
      !window.confirm('Apply this prepared Bring! complete/remove mutation now?')
    ) {
      return;
    }
    this.setOperationLoading(operation.id, true);
    this.clearOperationMessages(operation.id);

    try {
      let accessToken: string | undefined;
      if (operation.requiresAuth) {
        if (!msalClient || !config.authApiScope) {
          throw new Error('Authentication is not configured.');
        }

        const account = this.activeAccount() ?? msalClient.getAllAccounts()[0] ?? null;
        if (!account) {
          throw new Error('Sign in before calling the protected API.');
        }

        accessToken = await acquireAccessToken({
          msalClient,
          account,
          scope: resolveOperationScope(operation, config.authApiScope),
        });
      }

      const values = { ...(this.formValues()[operation.id] ?? {}) };
      if (operation.id === 'bringApplyItemMutation') {
        if (!this.pendingBringConfirmationToken) throw new Error('Prepare the Bring mutation before applying it.');
        values['confirmationToken'] = this.pendingBringConfirmationToken;
      }
      const headers = buildRequestHeaders(operation, accessToken);
      const init: RequestInit = { method: operation.method.toUpperCase(), headers };
      const requestUrl = buildRequestUrl(operation, values, config.apiBaseUrl);
      if (operation.requestFields.length) {
        init.body = JSON.stringify(buildRequestBody(operation, values));
      }

      const response = await fetch(requestUrl, init);
      const responseText = await response.text();
      const responseBody = parseJsonOrText(responseText);

      if (!response.ok) {
        const problem = formatProblemResponse(responseBody, response.status);
        this.operationProblems.update((current) => ({ ...current, [operation.id]: problem }));
        throw new Error(formatApiError(response.status, responseBody));
      }

      this.operationResults.update((current) => ({
        ...current,
        [operation.id]: formatBody(sanitizeOperationResponse(operation.id, responseBody), true),
      }));
      if (operation.id === 'bringPrepareItemMutation') {
        this.captureBringConfirmation(responseBody);
      } else if (operation.id === 'bringApplyItemMutation') {
        this.pendingBringConfirmation.set(null);
        this.pendingBringConfirmationToken = null;
      }
    } catch (error) {
      this.operationErrors.update((current) => ({
        ...current,
        [operation.id]: error instanceof Error ? error.message : 'Unknown API error.',
      }));
    } finally {
      this.setOperationLoading(operation.id, false);
    }
  }

  private captureBringConfirmation(responseBody: unknown): void {
    if (!isRecord(responseBody)) return;
    const operation = responseBody['operation'];
    const operationId = responseBody['operationId'];
    const confirmationToken = responseBody['confirmationToken'];
    const listPseudonym = responseBody['listPseudonym'];
    const itemCount = responseBody['itemCount'];
    const expiresAt = responseBody['expiresAt'];
    const listUuid = this.inputValue('bringPrepareItemMutation', 'listUuid');
    if (
      (operation !== 'complete' && operation !== 'remove') ||
      typeof operationId !== 'string' ||
      typeof confirmationToken !== 'string' ||
      typeof listPseudonym !== 'string' ||
      typeof itemCount !== 'number' ||
      typeof expiresAt !== 'string' ||
      !listUuid
    ) {
      return;
    }

    this.formValues.update((current) => ({
      ...current,
      bringApplyItemMutation: {
        ...(current['bringApplyItemMutation'] ?? {}),
        listUuid,
        operationId,
      },
    }));
    this.pendingBringConfirmationToken = confirmationToken;
    this.pendingBringConfirmation.set({
      operation,
      operationId,
      listPseudonym,
      itemCount,
      expiresAt,
    });
  }

  async copyCurl(operation: ApiOperationDoc): Promise<void> {
    const curl = buildCurlCommand({
      operation,
      values: this.formValues()[operation.id] ?? {},
      apiBaseUrl: config.apiBaseUrl,
    });

    try {
      await navigator.clipboard.writeText(curl);
      this.copyStatuses.update((current) => ({ ...current, [operation.id]: 'Copied redacted curl command.' }));
    } catch {
      this.copyStatuses.update((current) => ({ ...current, [operation.id]: 'Could not copy curl command.' }));
    }
  }

  private setOperationLoading(operationId: string, loading: boolean): void {
    this.loadingOperations.update((current) => ({ ...current, [operationId]: loading }));
  }

  private clearOperationMessages(operationId: string): void {
    this.operationErrors.update((current) => ({ ...current, [operationId]: '' }));
    this.operationProblems.update((current) => ({ ...current, [operationId]: null }));
    this.operationResults.update((current) => ({ ...current, [operationId]: '' }));
  }

  private clearAllErrors(): void {
    this.operationErrors.set({});
    this.operationProblems.set({});
  }

  private setGlobalError(message: string): void {
    const firstOperation = this.endpoints()[0];
    this.operationErrors.update((current) => ({
      ...current,
      [firstOperation?.id ?? 'global']: message,
    }));
  }
}

// MSAL silent-token renewal uses a hidden iframe pointed at the SPA redirect URI.
// Keep every embedded iframe inert so Angular and MSAL redirect handling cannot start in
// the child frame before or after Microsoft Entra returns the auth response.
if (!isEmbeddedFrame()) {
  initializeMsal(msalClient)
    .then(() => bootstrapApplication(AppComponent))
    .catch((error: unknown) => {
      console.error('Failed to bootstrap Angular application.', error);
    });
}

function isEmbeddedFrame(): boolean {
  return window.self !== window.top;
}

function resolveOperationScope(operation: ApiOperationDoc, configuredScope: string): string {
  const requiredScope = operation.requiredScopes[0];
  if (!requiredScope) return configuredScope;
  if (requiredScope.startsWith('api://') || requiredScope.startsWith('https://')) {
    return requiredScope;
  }
  const separator = configuredScope.lastIndexOf('/');
  return separator > 'api://'.length ? `${configuredScope.slice(0, separator + 1)}${requiredScope}` : requiredScope;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
