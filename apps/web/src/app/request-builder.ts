import type { ApiOperationDoc } from './openapi';

export type JsonObject = Record<string, unknown>;
export type OperationFormValues = Record<string, string>;

export function buildInitialBody(operation: ApiOperationDoc): OperationFormValues {
  const example = operation.requestExample ? parseJsonOrText(operation.requestExample) : {};
  return Object.fromEntries(
    [...operation.parameterFields, ...operation.requestFields].map((field) => {
      const exampleValue =
        typeof example === 'object' && example !== null ? (example as JsonObject)[field.name] : undefined;
      const value = exampleValue ?? field.defaultValue ?? '';
      return [field.name, value === undefined || value === null ? '' : String(value)];
    }),
  );
}

export function buildRequestBody(operation: ApiOperationDoc, values: OperationFormValues): JsonObject {
  const body: JsonObject = {};

  for (const field of operation.requestFields) {
    const rawValue = values[field.name] ?? '';
    if (!field.required && rawValue === '') {
      continue;
    }

    if (field.inputType === 'number') {
      body[field.name] = Number(rawValue);
    } else if (field.inputType === 'checkbox') {
      body[field.name] = rawValue === 'true';
    } else if (field.inputType === 'textarea') {
      try {
        body[field.name] = JSON.parse(rawValue) as unknown;
      } catch {
        throw new Error(`${field.name} must be valid JSON.`);
      }
    } else {
      body[field.name] = rawValue;
    }
  }

  return body;
}

export function buildRequestUrl(operation: ApiOperationDoc, values: OperationFormValues, apiBaseUrl: string): string {
  let path = operation.path;
  const query = new URLSearchParams();
  for (const field of operation.parameterFields) {
    const rawValue = values[field.name] ?? '';
    if (!field.required && rawValue === '') continue;
    if (field.parameterIn === 'path') {
      path = path.replace(`{${field.name}}`, encodeURIComponent(rawValue));
    } else if (field.parameterIn === 'query') {
      query.set(field.name, rawValue);
    }
  }
  const qs = query.toString();
  return `${apiBaseUrl}${path}${qs ? `?${qs}` : ''}`;
}

export function buildRequestHeaders(operation: ApiOperationDoc, accessToken?: string): Record<string, string> {
  const headers: Record<string, string> = {};
  if (operation.requiresAuth && accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }
  if (operation.requestFields.length) {
    headers['Content-Type'] = operation.requestContentType;
  }
  return headers;
}

export function parseJsonOrText(responseText: string): unknown {
  if (!responseText) {
    return '';
  }

  try {
    return JSON.parse(responseText) as unknown;
  } catch {
    return responseText;
  }
}

export function formatBody(body: unknown, pretty = false): string {
  return typeof body === 'string' ? body : JSON.stringify(body, null, pretty ? 2 : undefined);
}
