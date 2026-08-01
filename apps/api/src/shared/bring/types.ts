export type BringMutationOperation = 'add' | 'complete' | 'remove';
export type BringDestructiveOperation = Exclude<BringMutationOperation, 'add'>;

export interface BringConfig {
  enabled: boolean;
  addEnabled: boolean;
  destructiveEnabled: boolean;
  baseUrl: string;
  clientApiKey: string;
  country: string;
  email: string;
  password: string;
  accountFingerprint: string;
  expectedAccountFingerprint?: string;
  defaultListUuid?: string;
  readableListUuids: string[];
  writableListUuids: string[];
  writableSharedListUuids: string[];
  sessionCacheEnabled: boolean;
  sessionCacheContainer: string;
  sessionCacheBlob: string;
  mutationContainer: string;
  auditContainer: string;
  storageAccountName: string;
  confirmationHmacKey: string;
  mutationEncryptionKey: string;
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

export interface BringItemInput {
  name: string;
  specification?: string;
  uuid?: string;
}

export interface BringListSummary {
  uuid: string;
  name: string;
  theme?: string;
  isDefault: boolean;
  shared: boolean;
}

export interface BringItem {
  uuid?: string;
  name: string;
  specification?: string;
  status: 'active' | 'completed';
}

export interface BringList {
  uuid: string;
  name?: string;
  version: string;
  items: BringItem[];
}

export interface BringMutationResult {
  source: 'bring';
  listUuid: string;
  operation: BringMutationOperation;
  operationId: string;
  itemCount: number;
  state: 'succeeded';
  replayed: boolean;
}
