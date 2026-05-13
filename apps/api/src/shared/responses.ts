export interface HealthResponse {
  status: 'ok';
  service: 'api-catalogue';
  timestamp: string;
}

export interface HelloResponse {
  message: 'Hello, Martin';
  authenticated: false;
  note: 'Authentication placeholder; JWT enforcement comes in the next milestone.';
}

export function createHealthResponse(now: Date = new Date()): HealthResponse {
  return {
    status: 'ok',
    service: 'api-catalogue',
    timestamp: now.toISOString(),
  };
}

export function createHelloResponse(): HelloResponse {
  return {
    message: 'Hello, Martin',
    authenticated: false,
    note: 'Authentication placeholder; JWT enforcement comes in the next milestone.',
  };
}
