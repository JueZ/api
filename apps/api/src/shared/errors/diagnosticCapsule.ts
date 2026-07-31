import type { HttpRequest, InvocationContext } from '@azure/functions';

export interface DiagnosticCapsule {
  rec_version: '1.0';
  diagnostic_id: string;
  operation_id: string;
  endpoint: string;
  method: string;
  failure_stage:
    | 'json_parse'
    | 'request_shape'
    | 'input_validation'
    | 'business_rule'
    | 'upstream'
    | 'dependency'
    | 'internal'
    | 'unknown';
  http_status: number;
  trace_id?: string;
  safe_error: {
    code?: string;
    message: string;
    original_status?: number;
  };
  request_shape: Record<
    string,
    {
      type: 'undefined' | 'null' | 'string' | 'number' | 'boolean' | 'array' | 'object' | 'unknown';
      length_bucket?: 'empty' | 'short' | 'medium' | 'long';
      value_exposed: false;
    }
  >;
  contract_summary: {
    required: string[];
    properties: Record<string, unknown>;
    aliases?: Record<string, string>;
  };
  safe_examples: unknown[];
  security_policy: {
    raw_request_body_included: false;
    authorization_headers_included: false;
    tokens_included: false;
    stack_trace_included: false;
    raw_upstream_response_included: false;
    return_only_schema_valid_problem: true;
  };
}

export function buildRequestShape(body: unknown): DiagnosticCapsule['request_shape'] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return {
      $: { type: valueType(body), ...lengthBucket(body), value_exposed: false },
    };
  }

  const shape: DiagnosticCapsule['request_shape'] = {};
  const sensitiveKeyPlaceholders = new Map<string, string>();
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    const shapeKey = sanitizeShapeKey(key, sensitiveKeyPlaceholders);
    shape[shapeKey] = { type: valueType(value), ...lengthBucket(value), value_exposed: false };
  }
  return shape;
}

export function sanitizeShapeKey(key: string, placeholders = new Map<string, string>()): string {
  if (!isSensitiveShapeKey(key)) return key;
  const normalized = key.toLowerCase();
  const existing = placeholders.get(normalized);
  if (existing) return existing;
  const placeholder = `[redacted_sensitive_field_${placeholders.size + 1}]`;
  placeholders.set(normalized, placeholder);
  return placeholder;
}

export function buildRedditDiagnosticCapsule(args: {
  diagnostic_id: string;
  operation_id?: string;
  endpoint?: string;
  method?: string;
  failure_stage: DiagnosticCapsule['failure_stage'];
  http_status: number;
  trace_id?: string;
  safe_error: DiagnosticCapsule['safe_error'];
  body?: unknown;
}): DiagnosticCapsule {
  return buildDiagnosticCapsule({
    diagnostic_id: args.diagnostic_id,
    operation_id: args.operation_id ?? 'postRedditThread',
    endpoint: args.endpoint ?? '/api/reddit/thread',
    method: args.method ?? 'POST',
    failure_stage: args.failure_stage,
    http_status: args.http_status,
    ...(args.trace_id ? { trace_id: args.trace_id } : {}),
    safe_error: args.safe_error,
    body: args.body,
    contract_summary: redditContractSummary(args.operation_id, args.endpoint),
    safe_examples: redditSafeExamples(args.operation_id, args.endpoint),
  });
}

export function buildDiagnosticCapsule(args: {
  diagnostic_id: string;
  operation_id: string;
  endpoint: string;
  method: string;
  failure_stage: DiagnosticCapsule['failure_stage'];
  http_status: number;
  trace_id?: string;
  safe_error: DiagnosticCapsule['safe_error'];
  body?: unknown;
  contract_summary: DiagnosticCapsule['contract_summary'];
  safe_examples?: unknown[];
}): DiagnosticCapsule {
  return {
    rec_version: '1.0',
    diagnostic_id: args.diagnostic_id,
    operation_id: args.operation_id,
    endpoint: args.endpoint,
    method: args.method,
    failure_stage: args.failure_stage,
    http_status: args.http_status,
    ...(args.trace_id ? { trace_id: args.trace_id } : {}),
    safe_error: args.safe_error,
    request_shape: buildRequestShape(args.body),
    contract_summary: args.contract_summary,
    safe_examples: args.safe_examples ?? [],
    security_policy: {
      raw_request_body_included: false,
      authorization_headers_included: false,
      tokens_included: false,
      stack_trace_included: false,
      raw_upstream_response_included: false,
      return_only_schema_valid_problem: true,
    },
  };
}

export function getTraceIdFromRequestOrContext(request: HttpRequest, context: InvocationContext): string | undefined {
  const headerValue =
    request.headers?.get?.('x-ms-request-id') ??
    request.headers?.get?.('x-correlation-id') ??
    request.headers?.get?.('traceparent');
  if (headerValue) return headerValue.slice(0, 120);
  const invocationId = (context as unknown as { invocationId?: string }).invocationId;
  return invocationId ? invocationId.slice(0, 120) : undefined;
}

function redditContractSummary(operationId?: string, endpoint?: string): DiagnosticCapsule['contract_summary'] {
  if (operationId === 'postRedditThreadOverview' || endpoint === '/api/reddit/thread/overview') {
    return {
      required: ['post'],
      properties: {
        post: {
          type: 'string',
          acceptedFormats: ['raw Reddit article ID', 't3 fullname', 'redd.it URL', 'reddit.com comments URL'],
        },
        sort: {
          type: 'string',
          enum: ['confidence', 'top', 'new', 'controversial', 'old', 'qa'],
          default: 'confidence',
        },
        maxComments: {
          type: 'integer',
          minimum: 1,
          maximum: 10000,
          default: 500,
          description: 'bounded snapshot size used to compute cheap thread stats',
        },
      },
      aliases: {
        url: 'post',
        redditUrl: 'post',
        reddit_url: 'post',
        threadUrl: 'post',
        thread_url: 'post',
      },
    };
  }

  if (operationId === 'postRedditThreadComments' || endpoint === '/api/reddit/thread/comments') {
    return {
      required: ['post'],
      properties: {
        post: {
          type: 'string',
          acceptedFormats: ['raw Reddit article ID', 't3 fullname', 'redd.it URL', 'reddit.com comments URL'],
        },
        sort: {
          type: 'string',
          enum: ['confidence', 'top', 'new', 'controversial', 'old', 'qa'],
          default: 'confidence',
        },
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 200 },
        cursor: { type: 'string', description: 'opaque pagination cursor from the previous response' },
        includeBody: { type: 'boolean', default: false },
        bodyPreviewChars: { type: 'integer', minimum: 0, maximum: 500, default: 160 },
        maxDepth: { type: 'integer', minimum: 0, maximum: 50 },
        parentId: { type: 'string', description: 'optional t1/t3 parent fullname filter' },
        minScore: { type: 'integer' },
        minBodyLength: { type: 'integer', minimum: 0 },
        includeDeleted: { type: 'boolean', default: false },
        maxBytes: { type: 'integer', minimum: 1000, maximum: 2000000, default: 500000 },
        maxComments: { type: 'integer', minimum: 1, maximum: 10000, default: 1000 },
        maxMoreChildrenRequests: { type: 'integer', minimum: 0, maximum: 5000, default: 0 },
      },
      aliases: {
        url: 'post',
        redditUrl: 'post',
        reddit_url: 'post',
        threadUrl: 'post',
        thread_url: 'post',
      },
    };
  }

  if (operationId === 'postRedditCommentsBatch' || endpoint === '/api/reddit/comments/batch') {
    return {
      required: ['ids'],
      properties: {
        ids: {
          type: 'string_or_string_array',
          description: 'Reddit comment IDs, raw or t1_ fullnames; maximum 100 unique IDs',
        },
        fields: {
          type: 'string_or_string_array',
          description: 'optional field projection such as id,parentId,score,body,replyCount',
        },
        maxBytes: { type: 'integer', minimum: 1000, maximum: 2000000, default: 500000 },
      },
    };
  }

  if (operationId === 'postRedditCommentTree' || endpoint === '/api/reddit/comment-tree') {
    return {
      required: ['post'],
      properties: {
        post: {
          type: 'string',
          acceptedFormats: ['raw Reddit article ID', 't3 fullname', 'redd.it URL', 'reddit.com comments URL'],
        },
        commentId: {
          type: 'string',
          requiredAlternative: 'children',
          description: 'raw Reddit comment ID or t1 fullname',
        },
        children: {
          type: 'string_or_string_array',
          requiredAlternative: 'commentId',
          description: 'Reddit child comment IDs from a continuation handle',
        },
        parentId: { type: 'string', description: 'optional t1/t3 fullname from the continuation handle' },
        sort: {
          type: 'string',
          enum: ['confidence', 'top', 'new', 'controversial', 'old', 'qa'],
          default: 'confidence',
        },
        depth: { type: 'integer', minimum: 0, maximum: 10, default: 3 },
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
        maxMoreChildrenRequests: { type: 'integer', minimum: 0, maximum: 5000, default: 0 },
      },
      aliases: {
        url: 'post',
        redditUrl: 'post',
        reddit_url: 'post',
        threadUrl: 'post',
        thread_url: 'post',
      },
    };
  }

  return {
    required: ['post'],
    properties: {
      post: {
        type: 'string',
        acceptedFormats: [
          'raw Reddit article ID',
          't3 fullname',
          'redd.it URL',
          'reddit.com comments URL',
          'old.reddit.com comments URL',
          'Reddit share URL only if it resolves to a canonical comments URL',
        ],
      },
      sort: { type: 'string', enum: ['confidence', 'top', 'new', 'controversial', 'old', 'qa'], default: 'confidence' },
      maxComments: { type: 'integer', minimum: 1, maximum: 10000, default: 10000 },
      maxMoreChildrenRequests: { type: 'integer', minimum: 0, maximum: 5000, default: 1000 },
    },
    aliases: {
      url: 'post',
      redditUrl: 'post',
      reddit_url: 'post',
      threadUrl: 'post',
      thread_url: 'post',
    },
  };
}

function redditSafeExamples(operationId?: string, endpoint?: string): unknown[] {
  if (operationId === 'postRedditThreadOverview' || endpoint === '/api/reddit/thread/overview') {
    return [{ post: 'abc123', sort: 'confidence', maxComments: 500 }, { post: 'https://redd.it/abc123' }];
  }
  if (operationId === 'postRedditThreadComments' || endpoint === '/api/reddit/thread/comments') {
    return [
      { post: 'abc123', includeBody: false, limit: 200, bodyPreviewChars: 160 },
      { post: 'abc123', minScore: 50, maxDepth: 3, includeBody: false, limit: 100 },
    ];
  }
  if (operationId === 'postRedditCommentsBatch' || endpoint === '/api/reddit/comments/batch') {
    return [
      { ids: ['def456', 'ghi789'], fields: ['id', 'parentId', 'score', 'body', 'replyCount'] },
      { ids: 'def456,ghi789', fields: 'id,score,bodyPreview' },
    ];
  }
  if (operationId === 'postRedditCommentTree' || endpoint === '/api/reddit/comment-tree') {
    return [
      { post: 'abc123', commentId: 'def456', depth: 3, limit: 100 },
      { post: 'abc123', parentId: 't1_def456', children: 'ghi789,jkl012', limit: 100 },
    ];
  }
  return [
    { post: 'abc123', sort: 'confidence', maxComments: 10000, maxMoreChildrenRequests: 1000 },
    { post: 't3_abc123' },
    { post: 'https://redd.it/abc123' },
    { post: 'https://www.reddit.com/r/example/comments/abc123/example_title/' },
  ];
}

const SENSITIVE_SHAPE_KEY_PATTERNS = [
  /^access[_-]?token$/i,
  /^refresh[_-]?token$/i,
  /^id[_-]?token$/i,
  /^authorization$/i,
  /^cookie$/i,
  /^set-cookie$/i,
  /^client[_-]?secret$/i,
  /^secret$/i,
  /^password$/i,
  /^api[_-]?key$/i,
  /^apikey$/i,
  /^token$/i,
];

function isSensitiveShapeKey(key: string): boolean {
  return SENSITIVE_SHAPE_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

function valueType(value: unknown): DiagnosticCapsule['request_shape'][string]['type'] {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean' || type === 'object') return type;
  return 'unknown';
}

function lengthBucket(value: unknown): { length_bucket?: 'empty' | 'short' | 'medium' | 'long' } {
  let length: number | undefined;
  if (typeof value === 'string' || Array.isArray(value)) length = value.length;
  if (value && typeof value === 'object' && !Array.isArray(value)) length = Object.keys(value).length;
  if (length === undefined) return {};
  if (length === 0) return { length_bucket: 'empty' };
  if (length <= 32) return { length_bucket: 'short' };
  if (length <= 256) return { length_bucket: 'medium' };
  return { length_bucket: 'long' };
}
