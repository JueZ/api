import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import {
  BrowserCacheLocation,
  EventType,
  InteractionRequiredAuthError,
  PublicClientApplication,
  type AccountInfo,
} from '@azure/msal-browser';

interface RuntimeConfig {
  authEnabled: boolean;
  authClientId: string;
  authAuthority: string;
  authRedirectUri: string;
  authApiScope: string;
  apiBaseUrl: string;
}

interface HelloApiResponse {
  message: string;
  authenticated: boolean;
  user?: {
    subject?: string;
    objectId?: string;
    tenantId?: string;
  };
}

declare global {
  interface Window {
    API_CATALOGUE_CONFIG?: Partial<RuntimeConfig>;
  }
}

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

      <section class="card" aria-labelledby="catalogue-title">
        <h2 id="catalogue-title">API catalogue placeholder</h2>
        <p>
          Integrations will appear here in later milestones. Reddit is intentionally not
          implemented in this authentication milestone.
        </p>
      </section>

      <section class="card" aria-labelledby="hello-title">
        <h2 id="hello-title">Call protected <code>/api/hello</code></h2>
        <p>
          This endpoint now requires a valid OAuth/OIDC access token with the configured API
          scope or role and a server-side allowlisted user identifier.
        </p>
        <button class="button" type="button" (click)="callHello()" [disabled]="helloLoading() || !canUseAuth()">
          {{ helloLoading() ? 'Calling…' : 'Call hello with access token' }}
        </button>
        @if (apiError()) {
          <pre class="api-error" role="alert">{{ apiError() }}</pre>
        }
        @if (helloResponse(); as response) {
          <pre class="api-result">{{ response }}</pre>
        }
      </section>

      <aside class="notice" role="note">
        <strong>/health</strong> remains public. <strong>/api/hello</strong> is protected by
        server-side JWT validation when <code>AUTH_ENABLED=true</code>.
      </aside>
    </main>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppComponent {
  protected readonly activeAccount = signal<AccountInfo | null>(msalClient?.getActiveAccount() ?? null);
  protected readonly helloLoading = signal(false);
  protected readonly helloResponse = signal<string | null>(null);
  protected readonly apiError = signal<string | null>(null);
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

  async login(): Promise<void> {
    if (!msalClient || !config.authApiScope) {
      this.apiError.set('Authentication is not configured.');
      return;
    }

    this.apiError.set(null);
    await msalClient.loginRedirect({ scopes: [config.authApiScope] });
  }

  async logout(): Promise<void> {
    if (!msalClient) {
      return;
    }

    const account = this.activeAccount();
    await msalClient.logoutPopup({ account });
    this.activeAccount.set(null);
    this.helloResponse.set(null);
  }

  async callHello(): Promise<void> {
    if (!msalClient || !config.authApiScope) {
      this.apiError.set('Authentication is not configured.');
      return;
    }

    this.helloLoading.set(true);
    this.apiError.set(null);
    this.helloResponse.set(null);

    try {
      const account = this.activeAccount() ?? msalClient.getAllAccounts()[0] ?? null;
      if (!account) {
        throw new Error('Sign in before calling the protected API.');
      }

      const accessToken = await acquireAccessToken(account);
      const response = await fetch(`${config.apiBaseUrl}/api/hello`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });
      const responseText = await response.text();
      const responseBody = parseJsonOrText(responseText);

      if (!response.ok) {
        throw new Error(`API returned ${response.status}: ${formatBody(responseBody)}`);
      }

      this.helloResponse.set(JSON.stringify(responseBody as HelloApiResponse, null, 2));
    } catch (error) {
      this.apiError.set(error instanceof Error ? error.message : 'Unknown API error.');
    } finally {
      this.helloLoading.set(false);
    }
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

function formatBody(body: unknown): string {
  return typeof body === 'string' ? body : JSON.stringify(body);
}

initializeMsal()
  .then(() => bootstrapApplication(AppComponent))
  .catch((error: unknown) => {
    console.error('Failed to bootstrap Angular application.', error);
  });
