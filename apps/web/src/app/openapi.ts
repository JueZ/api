import YAML from 'yaml';

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';
export const httpMethods: HttpMethod[] = ['get', 'post', 'put', 'patch', 'delete'];

export interface OpenApiSchema {
  $ref?: string;
  type?: string | readonly string[];
  format?: string;
  const?: unknown;
  enum?: readonly unknown[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  description?: string;
  examples?: readonly unknown[];
  properties?: Record<string, OpenApiSchema>;
  required?: readonly string[];
  items?: OpenApiSchema;
  additionalProperties?: boolean | OpenApiSchema;
}

export interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: readonly string[];
  security?: readonly Record<string, readonly string[]>[];
  requestBody?: {
    required?: boolean;
    content?: Record<string, { schema?: OpenApiSchema; examples?: Record<string, { value?: unknown }> }>;
  };
  responses?: Record<string, {
    description?: string;
    content?: Record<string, { schema?: OpenApiSchema; examples?: Record<string, { value?: unknown }> }>;
  }>;
  parameters?: Array<{
    name: string;
    in: 'path' | 'query' | 'header' | 'cookie';
    required?: boolean;
    description?: string;
    schema?: OpenApiSchema;
  }>;
}

export interface OpenApiDocument {
  info: {
    title: string;
    version: string;
    description?: string;
  };
  paths: Record<string, Partial<Record<HttpMethod, OpenApiOperation>>>;
  components?: {
    schemas?: Record<string, OpenApiSchema>;
    securitySchemes?: Record<string, { description?: string }>;
  };
}

export interface SchemaFieldDoc {
  name: string;
  type: string;
  required: boolean;
  description: string;
  defaultValue: string;
  constraints: string;
  enumValues: string[];
  example: string;
  inputType: 'text' | 'number' | 'select' | 'checkbox';
}

export interface SchemaDoc {
  name: string;
  description: string;
  fields: SchemaFieldDoc[];
}

export interface ResponseDoc {
  status: string;
  description: string;
  schemaName: string;
  fields: SchemaFieldDoc[];
  example: string;
}

export interface ApiOperationDoc {
  id: string;
  method: HttpMethod;
  path: string;
  tag: string;
  summary: string;
  description: string;
  requiresAuth: boolean;
  requestRequired: boolean;
  requestContentType: string;
  requestSchemaName: string;
  requestFields: SchemaFieldDoc[];
  requestExample: string;
  parameterFields: (SchemaFieldDoc & { parameterIn: 'path' | 'query' })[];
  responses: ResponseDoc[];
  schemas: SchemaDoc[];
}

export function parseOpenApiDocument(source: string): OpenApiDocument {
  return YAML.parse(source) as OpenApiDocument;
}

export function buildApiOperations(document: OpenApiDocument): ApiOperationDoc[] {
  const helpers = createSchemaHelpers(document);

  return Object.entries(document.paths)
    .flatMap(([path, pathItem]) =>
      Object.entries(pathItem)
        .filter(([method]) => httpMethods.includes(method as HttpMethod))
        .map(([method, operation]) => {
          const typedOperation = operation as OpenApiOperation;
          const id = typedOperation.operationId ?? `${method}-${path.replace(/[^a-z0-9]+/gi, '-')}`;
          const requestMedia = typedOperation.requestBody?.content?.['application/json'];
          const requestSchema = helpers.resolveSchema(requestMedia?.schema);
          const requestExample = firstExample(requestMedia?.examples) ?? helpers.exampleFromSchema(requestSchema);
          const responses = Object.entries(typedOperation.responses ?? {}).map(([status, response]) => {
            const responseMedia = response.content?.['application/json'] ?? response.content?.['application/problem+json'];
            const responseSchema = helpers.resolveSchema(responseMedia?.schema);
            return {
              status,
              description: response.description ?? '',
              schemaName: schemaName(responseMedia?.schema),
              fields: helpers.schemaFields(responseSchema),
              example: stringifyExample(firstExample(responseMedia?.examples) ?? helpers.exampleFromSchema(responseSchema)),
            };
          });

          return {
            id,
            method: method as HttpMethod,
            path,
            tag: typedOperation.tags?.[0] ?? 'API',
            summary: typedOperation.summary ?? `${method.toUpperCase()} ${path}`,
            description: normalizeDescription(typedOperation.description),
            requiresAuth: Boolean(typedOperation.security?.length),
            requestRequired: typedOperation.requestBody?.required === true,
            requestContentType: requestMedia ? 'application/json' : '',
            requestSchemaName: schemaName(requestMedia?.schema),
            requestFields: helpers.schemaFields(requestSchema),
            requestExample: stringifyExample(requestExample),
            parameterFields: helpers.parameterFields(typedOperation),
            responses,
            schemas: helpers.relatedSchemas([
              requestMedia?.schema,
              ...responses.map((response) =>
                response.schemaName ? { $ref: `#/components/schemas/${response.schemaName}` } : undefined,
              ),
            ]),
          };
        }),
    )
    .sort((left, right) => left.path.localeCompare(right.path) || left.method.localeCompare(right.method));
}

function createSchemaHelpers(document: OpenApiDocument) {
  function resolveSchema(schema: OpenApiSchema | undefined): OpenApiSchema | undefined {
    if (!schema?.$ref) {
      return schema;
    }

    const name = schemaName(schema);
    return name ? document.components?.schemas?.[name] : schema;
  }

  function relatedSchemas(schemaRefs: (OpenApiSchema | string | undefined)[]): SchemaDoc[] {
    const seen = new Set<string>();
    const docs: SchemaDoc[] = [];

    const visit = (schemaOrName: OpenApiSchema | string | undefined): void => {
      const name = typeof schemaOrName === 'string' ? schemaOrName : schemaName(schemaOrName);
      if (!name || seen.has(name)) {
        return;
      }

      const schema = document.components?.schemas?.[name];
      if (!schema) {
        return;
      }

      seen.add(name);
      docs.push({ name, description: schema.description ?? '', fields: schemaFields(schema) });

      for (const property of Object.values(schema.properties ?? {})) {
        if (property.$ref) {
          visit(property);
        }
        if (property.items?.$ref) {
          visit(property.items);
        }
      }
    };

    for (const schemaRef of schemaRefs) {
      visit(schemaRef);
    }

    return docs;
  }

  function schemaFields(schema: OpenApiSchema | undefined): SchemaFieldDoc[] {
    if (!schema?.properties) {
      return [];
    }

    const required = new Set(schema.required ?? []);
    return Object.entries(schema.properties).map(([name, property]) => {
      const resolved = resolveSchema(property) ?? property;
      const enumValues = (resolved.enum ?? []).map(String);
      return {
        name,
        type: describeType(property),
        required: required.has(name),
        description: resolved.description ?? 'No description supplied yet.',
        defaultValue: resolved.default === undefined ? '' : String(resolved.default),
        constraints: describeConstraints(resolved),
        enumValues,
        example: stringifyInlineExample(firstSchemaExample(resolved)),
        inputType: inputTypeFor(resolved),
      };
    });
  }

  function parameterFields(operation: OpenApiOperation): (SchemaFieldDoc & { parameterIn: 'path' | 'query' })[] {
    return (operation.parameters ?? [])
      .filter((parameter) => parameter.in === 'path' || parameter.in === 'query')
      .map((parameter) => {
        const parameterIn = parameter.in as 'path' | 'query';
        const schema = resolveSchema(parameter.schema) ?? parameter.schema ?? { type: 'string' };
        return {
          name: parameter.name,
          type: describeType(schema),
          required: parameter.required === true,
          description: parameter.description ?? schema.description ?? 'No description supplied yet.',
          defaultValue: schema.default === undefined ? '' : String(schema.default),
          constraints: describeConstraints(schema),
          enumValues: (schema.enum ?? []).map(String),
          example: stringifyInlineExample(firstSchemaExample(schema)),
          inputType: inputTypeFor(schema),
          parameterIn,
        };
      });
  }

  function exampleFromSchema(schema: OpenApiSchema | undefined): unknown {
    if (!schema) {
      return undefined;
    }
    const resolved = resolveSchema(schema) ?? schema;
    if (resolved.examples?.length) {
      return resolved.examples[0];
    }
    if (resolved.const !== undefined) {
      return resolved.const;
    }
    if (resolved.default !== undefined) {
      return resolved.default;
    }
    if (resolved.properties) {
      return Object.fromEntries(
        Object.entries(resolved.properties).map(([name, property]) => [name, exampleFromSchema(property)]),
      );
    }
    if (resolved.items) {
      return [exampleFromSchema(resolved.items)];
    }
    if (resolved.enum?.length) {
      return resolved.enum[0];
    }
    if (resolved.type === 'integer' || resolved.type === 'number') {
      return 0;
    }
    if (resolved.type === 'boolean') {
      return false;
    }
    if (Array.isArray(resolved.type) && resolved.type.includes('null')) {
      return null;
    }
    return '';
  }

  return { resolveSchema, relatedSchemas, schemaFields, parameterFields, exampleFromSchema };
}

function schemaName(schema: OpenApiSchema | undefined): string {
  return schema?.$ref?.replace('#/components/schemas/', '') ?? '';
}

function describeType(schema: OpenApiSchema): string {
  if (schema.$ref) {
    return `${schemaName(schema)} object`;
  }
  if (schema.items) {
    return `${describeType(schema.items)}[]`;
  }
  if (Array.isArray(schema.type)) {
    return schema.type.join(' | ');
  }
  const schemaType = typeof schema.type === 'string' ? schema.type : 'value';
  return schema.format ? `${schemaType} (${schema.format})` : schemaType;
}

function describeConstraints(schema: OpenApiSchema): string {
  const constraints: string[] = [];
  if (schema.minimum !== undefined) {
    constraints.push(`min ${schema.minimum}`);
  }
  if (schema.maximum !== undefined) {
    constraints.push(`max ${schema.maximum}`);
  }
  if (schema.default !== undefined) {
    constraints.push(`default ${schema.default}`);
  }
  if (schema.const !== undefined) {
    constraints.push(`const ${schema.const}`);
  }
  if (schema.enum?.length) {
    constraints.push(`allowed ${schema.enum.join(', ')}`);
  }
  return constraints.join(', ');
}

function inputTypeFor(schema: OpenApiSchema): SchemaFieldDoc['inputType'] {
  if (schema.enum?.length) {
    return 'select';
  }
  if (schema.type === 'integer' || schema.type === 'number') {
    return 'number';
  }
  if (schema.type === 'boolean') {
    return 'checkbox';
  }
  return 'text';
}

function firstSchemaExample(schema: OpenApiSchema): unknown {
  if (schema.examples?.length) {
    return schema.examples[0];
  }
  if (schema.default !== undefined) {
    return schema.default;
  }
  if (schema.const !== undefined) {
    return schema.const;
  }
  return '';
}

function firstExample(examples: Record<string, { value?: unknown }> | undefined): unknown {
  return Object.values(examples ?? {})[0]?.value;
}

function stringifyExample(example: unknown): string {
  return example === undefined ? '' : JSON.stringify(example, null, 2);
}

function stringifyInlineExample(example: unknown): string {
  if (example === undefined || example === '') {
    return '';
  }
  return typeof example === 'string' ? example : JSON.stringify(example);
}

function normalizeDescription(description: string | undefined): string {
  return description?.replace(/\s+/g, ' ').trim() ?? '';
}
