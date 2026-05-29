import {
  BrowserCacheLocation,
  EventType,
  InteractionRequiredAuthError,
  PublicClientApplication,
  type AccountInfo,
} from '@azure/msal-browser';
import type { RuntimeConfig } from './runtime-config';

export function createMsalClient(runtimeConfig: RuntimeConfig): PublicClientApplication | null {
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

export async function initializeMsal(msalClient: PublicClientApplication | null): Promise<void> {
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

export async function acquireAccessToken(args: {
  msalClient: PublicClientApplication | null;
  account: AccountInfo;
  scope: string;
}): Promise<string> {
  const { msalClient, account, scope } = args;
  if (!msalClient) {
    throw new Error('Authentication is not configured.');
  }

  try {
    const result = await msalClient.acquireTokenSilent({ account, scopes: [scope] });
    return result.accessToken;
  } catch (error) {
    if (error instanceof InteractionRequiredAuthError) {
      await msalClient.acquireTokenRedirect({ account, scopes: [scope] });
      throw new Error('Redirecting to sign in for API access.');
    }
    throw error;
  }
}
