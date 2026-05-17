import { readRuntimeProvenance, type RuntimeProvenance } from './runtimeProvenance.js';

export interface HealthResponse {
  status: 'ok';
  service: 'api-catalogue';
  timestamp: string;
  environmentName: RuntimeProvenance['environmentName'];
  deployedCommitSha: string;
  deployedSourceRef: string;
  deploymentRunId: string;
  deployedAtUtc: string;
  buildTimestampUtc: string;
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

export function createHealthResponse(now: Date = new Date(), env: NodeJS.ProcessEnv = process.env): HealthResponse {
  const provenance = readRuntimeProvenance(env, now);

  return {
    status: 'ok',
    service: 'api-catalogue',
    timestamp: now.toISOString(),
    environmentName: provenance.environmentName,
    deployedCommitSha: provenance.deployedCommitSha,
    deployedSourceRef: provenance.deployedSourceRef,
    deploymentRunId: provenance.deploymentRunId,
    deployedAtUtc: provenance.deployedAtUtc,
    buildTimestampUtc: provenance.buildTimestampUtc,
  };
}

export function createHelloResponse(user: HelloUser): HelloResponse {
  return {
    message: 'Hello, Martin',
    authenticated: true,
    user,
  };
}
