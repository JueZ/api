import type { ApiOperationDoc } from './openapi';
import { buildRequestBody, buildRequestHeaders, buildRequestUrl, type OperationFormValues } from './request-builder';

export const ACCESS_TOKEN_PLACEHOLDER = '<ACCESS_TOKEN>';
export const SENSITIVE_VALUE_PLACEHOLDER = '<REDACTED>';

export function buildCurlCommand(args: {
  operation: ApiOperationDoc;
  values: OperationFormValues;
  apiBaseUrl: string;
}): string {
  const { operation, values, apiBaseUrl } = args;
  const url = buildRequestUrl(operation, values, apiBaseUrl || '');
  const headers = buildRequestHeaders(operation, operation.requiresAuth ? ACCESS_TOKEN_PLACEHOLDER : undefined);
  const parts = ['curl', '-i', '-X', operation.method.toUpperCase(), shellQuote(url)];

  for (const [name, value] of Object.entries(headers)) {
    parts.push('-H', shellQuote(`${name}: ${redactHeaderValue(name, value)}`));
  }

  if (operation.requestFields.length) {
    parts.push('--data', shellQuote(JSON.stringify(redactRequestBody(buildRequestBody(operation, values)))));
  }

  return parts.join(' \\\n  ');
}

function redactRequestBody(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(body).map(([name, value]) => [
      name,
      /(?:confirmation|access|refresh|identity|api)[_-]?token|password|secret/i.test(name)
        ? SENSITIVE_VALUE_PLACEHOLDER
        : value,
    ]),
  );
}

function redactHeaderValue(name: string, value: string): string {
  if (name.toLowerCase() === 'authorization') {
    return `Bearer ${ACCESS_TOKEN_PLACEHOLDER}`;
  }
  return value;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
