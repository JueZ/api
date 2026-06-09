import type { HttpRequest, HttpResponseInit } from '@azure/functions';

export const API_CORS_ALLOWED_ORIGINS_ENV = 'API_CORS_ALLOWED_ORIGINS';

export type CorsOptions = {
  methods: readonly string[];
  headers?: readonly string[];
  exposeHeaders?: readonly string[];
};

const DEFAULT_ALLOWED_HEADERS = ['Authorization', 'Content-Type'];

export function createCorsHeaders(
  request: Pick<HttpRequest, 'headers'> | undefined,
  options: CorsOptions,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Headers': (options.headers ?? DEFAULT_ALLOWED_HEADERS).join(', '),
    'Access-Control-Allow-Methods': options.methods.join(', '),
  };

  const allowedOrigin = resolveAllowedOrigin(request, env);
  if (allowedOrigin) {
    headers['Access-Control-Allow-Origin'] = allowedOrigin;
    if (allowedOrigin !== '*') headers['Vary'] = 'Origin';
  }

  if (options.exposeHeaders?.length) {
    headers['Access-Control-Expose-Headers'] = options.exposeHeaders.join(', ');
  }

  return headers;
}

export function withCorsHeaders(
  request: Pick<HttpRequest, 'headers'> | undefined,
  response: HttpResponseInit,
  options: CorsOptions,
  env: NodeJS.ProcessEnv = process.env,
): HttpResponseInit {
  return {
    ...response,
    headers: {
      ...createCorsHeaders(request, options, env),
      ...response.headers,
    },
  };
}

export function getConfiguredCorsAllowedOrigins(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  return splitOriginList(env[API_CORS_ALLOWED_ORIGINS_ENV]);
}

function resolveAllowedOrigin(request: Pick<HttpRequest, 'headers'> | undefined, env: NodeJS.ProcessEnv): string | undefined {
  const configuredOrigins = getConfiguredCorsAllowedOrigins(env);
  if (configuredOrigins.length === 0) return '*';
  if (configuredOrigins.includes('*')) return '*';

  const requestOrigin = request?.headers?.get('origin');
  const normalizedRequestOrigin = normalizeOrigin(requestOrigin ?? undefined);
  if (!normalizedRequestOrigin) return undefined;

  const allowedOrigins = new Set(configuredOrigins.map(normalizeOrigin).filter((origin): origin is string => Boolean(origin)));
  return allowedOrigins.has(normalizedRequestOrigin) ? normalizedRequestOrigin : undefined;
}

function splitOriginList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

function normalizeOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed === '*') return '*';
  try {
    return new URL(trimmed).origin;
  } catch {
    return undefined;
  }
}
