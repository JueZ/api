export interface HealthResponse {
  status: 'ok';
  service: 'api-catalogue';
  timestamp: string;
}

export interface HelloUser {
  subject: string;
  objectId?: string;
  tenantId?: string;
}

export interface HelloResponse {
  message: 'Hello, Martin';
  authenticated: true;
  user: HelloUser;
}

export function createHealthResponse(now: Date = new Date()): HealthResponse {
  return {
    status: 'ok',
    service: 'api-catalogue',
    timestamp: now.toISOString(),
  };
}

export function createHelloResponse(user: HelloUser): HelloResponse {
  return {
    message: 'Hello, Martin',
    authenticated: true,
    user,
  };
}
