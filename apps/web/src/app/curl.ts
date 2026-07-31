import type { ApiOperationDoc } from './openapi';
import {
  buildRequestBody,
  buildRequestHeaders,
  buildRequestUrl,
  CONFIRMATION_TOKEN_FIELD,
  CONFIRMATION_TOKEN_PLACEHOLDER,
  type OperationFormValues,
} from './request-builder';

export const ACCESS_TOKEN_PLACEHOLDER = '<ACCESS_TOKEN>';

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
    parts.push(
      '--data',
      shellQuote(
        JSON.stringify(
          buildRequestBody(operation, values, {
            [CONFIRMATION_TOKEN_FIELD]: CONFIRMATION_TOKEN_PLACEHOLDER,
          }),
        ),
      ),
    );
  }

  return parts.join(' \\\n  ');
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
