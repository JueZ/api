export interface BringConfig {
  baseUrl: string;
  clientApiKey: string;
  country: string;
  email: string;
  password: string;
  defaultListUuid?: string;
  sessionCacheEnabled: boolean;
  sessionCacheContainer: string;
  sessionCacheBlob: string;
  storageAccountName: string;
  timeoutMs: number;
}

export interface BringSession {
  version: 1;
  userUuid: string;
  publicUserUuid: string;
  defaultListUuid?: string;
  accessToken: string;
  refreshToken?: string;
  accessTokenExpiresAt: string;
  updatedAt: string;
}

export interface BringItemInput { name: string; specification?: string; uuid?: string }
export interface BringListSummary { uuid: string; name: string; theme?: string; isDefault: boolean; shared: boolean }
export interface BringItem { uuid?: string; name: string; specification?: string; status: 'active' | 'completed' }
export interface BringList { uuid: string; name?: string; items: BringItem[] }
