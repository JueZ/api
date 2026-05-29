export interface RuntimeConfig {
  authEnabled: boolean;
  authClientId: string;
  authAuthority: string;
  authRedirectUri: string;
  authApiScope: string;
  apiBaseUrl: string;
}

declare global {
  interface Window {
    API_CATALOGUE_CONFIG?: Partial<RuntimeConfig>;
  }
}

export function readRuntimeConfig(): RuntimeConfig {
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
