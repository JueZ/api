import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import type { BringApplicationPort } from '../application/operations/bring/application.js';
import type {
  AddItemsCommand,
  ApplyMutationCommand,
  PrepareMutationCommand,
} from '../application/operations/bring/mutations.js';
import { OPERATION_IDS } from '../application/operations/registry.js';
import { getTraceIdFromRequestOrContext } from '../shared/errors/diagnosticCapsule.js';
import { createCorsHeaders, type CorsOptions } from '../shared/http/cors.js';
import { authorizeRequestForOperation } from '../shared/security/auth.js';
import {
  BRING_OPERATION_IDS,
  bringProblemResponse,
  resolveBringProblem,
  type BringOperationId,
} from '../shared/bring/problem.js';
import { BringInputError } from '../shared/bring/service.js';
import { BringUpstreamError, bringUpstreamTelemetryDetails } from '../shared/bring/client.js';
import { createBringApplication } from '../infrastructure/composition/bring.js';

type BringHandlerDependencies = {
  getApplication?: (context: InvocationContext) => BringApplicationPort;
};

type BringRoute =
  | { kind: 'list'; problemOperationId: BringOperationId; authOperationId: string }
  | { kind: 'get'; problemOperationId: BringOperationId; authOperationId: string; listUuid: string }
  | { kind: 'add'; problemOperationId: BringOperationId; authOperationId: string; listUuid: string }
  | { kind: 'prepare'; problemOperationId: BringOperationId; listUuid: string }
  | { kind: 'apply'; problemOperationId: BringOperationId; listUuid: string };

const corsOptions = {
  methods: ['GET', 'POST', 'OPTIONS'],
} satisfies CorsOptions;

export function createBringHandler(
  dependencies: BringHandlerDependencies = {},
): (request: HttpRequest, context: InvocationContext) => Promise<HttpResponseInit> {
  let productionApplication: BringApplicationPort | undefined;
  const getApplication =
    dependencies.getApplication ??
    ((context: InvocationContext) => {
      productionApplication ??= createBringApplication({
        warn: (message, details) => context.warn(message, details),
      });
      return productionApplication;
    });

  return async function bringHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    const cors = createCorsHeaders(request, corsOptions);
    if (request.method === 'OPTIONS') return { status: 204, headers: cors };

    const traceId = getTraceIdFromRequestOrContext(request, context);
    let route: BringRoute | undefined;
    let rawBody: Record<string, unknown> | undefined;
    try {
      route = routeInfo(request, context);
      const application = getApplication(context);
      if (route.kind === 'list' || route.kind === 'get') {
        const auth = await authorizeRequestForOperation(request, context, route.authOperationId);
        if (!auth.ok) return withCors(auth.response, cors);
        const body = route.kind === 'list' ? await application.listLists() : await application.getList(route.listUuid);
        return { status: 200, headers: cors, jsonBody: body };
      }

      rawBody = await readJsonObject(request);
      if (route.kind === 'add') {
        const auth = await authorizeRequestForOperation(request, context, route.authOperationId);
        if (!auth.ok) return withCors(auth.response, cors);
        const command = parseAddCommand(rawBody, route.listUuid);
        const result = await application.addItems(auth.user, command, traceId ?? context.invocationId);
        return { status: 200, headers: cors, jsonBody: result };
      }

      if (route.kind === 'prepare') {
        const command = parsePrepareCommand(rawBody, route.listUuid);
        const authOperationId =
          command.operation === 'complete' ? OPERATION_IDS.bringPrepareComplete : OPERATION_IDS.bringPrepareRemove;
        const auth = await authorizeRequestForOperation(request, context, authOperationId);
        if (!auth.ok) return withCors(auth.response, cors);
        const result = await application.prepareMutation(auth.user, command, traceId ?? context.invocationId);
        return { status: 200, headers: cors, jsonBody: result };
      }

      const command = parseApplyCommand(rawBody, route.listUuid);
      const operation = application.getConfirmationOperation(command.confirmationToken);
      if (!operation) {
        throw new BringInputError('confirmationToken is malformed or unsupported.', 'confirmationToken');
      }
      const authOperationId =
        operation === 'complete' ? OPERATION_IDS.bringApplyComplete : OPERATION_IDS.bringApplyRemove;
      const auth = await authorizeRequestForOperation(request, context, authOperationId);
      if (!auth.ok) return withCors(auth.response, cors);
      const result = await application.applyMutation(auth.user, command, traceId ?? context.invocationId);
      return { status: 200, headers: cors, jsonBody: result };
    } catch (error) {
      const problemOperationId = route?.problemOperationId ?? BRING_OPERATION_IDS.getItems;
      const problem = await resolveBringProblem({
        error,
        operationId: problemOperationId,
        traceId,
        body: rawBody,
      });
      if (problem.status >= 500 || problem.status === 429) {
        context.warn('Bring request failed with a sanitized repairable error.', {
          operation_id: problemOperationId,
          diagnostic_id: problem.diagnostic_id,
          classification: problem.classification,
          status: problem.status,
          ...(error instanceof BringUpstreamError ? bringUpstreamTelemetryDetails(error) : {}),
        });
      }
      return bringProblemResponse(problem, cors);
    }
  };
}

export const bringHandler = createBringHandler();

function routeInfo(request: HttpRequest, context: InvocationContext): BringRoute {
  const listUuid = request.params['listUuid'];
  if (context.functionName === 'bringListLists') {
    return {
      kind: 'list',
      problemOperationId: BRING_OPERATION_IDS.listLists,
      authOperationId: OPERATION_IDS.bringListLists,
    };
  }
  if (!listUuid) throw new BringInputError('listUuid is required.', 'listUuid');
  if (context.functionName === 'bringItems' && request.method === 'GET') {
    return {
      kind: 'get',
      problemOperationId: BRING_OPERATION_IDS.getItems,
      authOperationId: OPERATION_IDS.bringGetItems,
      listUuid,
    };
  }
  if (context.functionName === 'bringPrepareMutation') {
    return {
      kind: 'prepare',
      problemOperationId: BRING_OPERATION_IDS.prepareMutation,
      listUuid,
    };
  }
  if (context.functionName === 'bringApplyMutation') {
    return {
      kind: 'apply',
      problemOperationId: BRING_OPERATION_IDS.applyMutation,
      listUuid,
    };
  }
  return {
    kind: 'add',
    problemOperationId: BRING_OPERATION_IDS.addItems,
    authOperationId: OPERATION_IDS.bringAddItems,
    listUuid,
  };
}

async function readJsonObject(request: HttpRequest): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new BringInputError('Request body must be valid JSON.', 'body');
  }
  if (!isRecord(value)) {
    throw new BringInputError('Request body must be an object.', 'body');
  }
  return value;
}

function parseAddCommand(body: Record<string, unknown>, listUuid: string): AddItemsCommand {
  assertOnlyKeys(body, ['operationId', 'expectedListVersion', 'items']);
  return {
    operationId: requiredString(body, 'operationId'),
    listUuid,
    ...(optionalString(body, 'expectedListVersion')
      ? { expectedListVersion: optionalString(body, 'expectedListVersion') }
      : {}),
    items: requiredArray(body, 'items'),
  } as AddItemsCommand;
}

function parsePrepareCommand(body: Record<string, unknown>, listUuid: string): PrepareMutationCommand {
  assertOnlyKeys(body, ['operationId', 'expectedListVersion', 'operation', 'items']);
  const operation = requiredString(body, 'operation');
  if (operation !== 'complete' && operation !== 'remove') {
    throw new BringInputError('operation must be complete or remove.', 'operation');
  }
  return {
    operationId: requiredString(body, 'operationId'),
    listUuid,
    operation,
    ...(optionalString(body, 'expectedListVersion')
      ? { expectedListVersion: optionalString(body, 'expectedListVersion') }
      : {}),
    items: requiredArray(body, 'items'),
  } as PrepareMutationCommand;
}

function parseApplyCommand(body: Record<string, unknown>, listUuid: string): ApplyMutationCommand {
  assertOnlyKeys(body, ['operationId', 'confirmationToken']);
  return {
    operationId: requiredString(body, 'operationId'),
    listUuid,
    confirmationToken: requiredString(body, 'confirmationToken'),
  };
}

function assertOnlyKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(body).some((key) => !allowed.includes(key))) {
    throw new BringInputError('Request body contains unknown fields.', 'body');
  }
}

function requiredString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new BringInputError(`${field} must be a non-empty string.`, field);
  }
  return value;
}

function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new BringInputError(`${field} must be a non-empty string.`, field);
  }
  return value;
}

function requiredArray(body: Record<string, unknown>, field: string): unknown[] {
  const value = body[field];
  if (!Array.isArray(value)) {
    throw new BringInputError(`${field} must be an array.`, field);
  }
  return value;
}

function withCors(response: HttpResponseInit, cors: Record<string, string>): HttpResponseInit {
  return {
    ...response,
    headers: { ...cors, ...response.headers },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

app.http('bringListLists', {
  methods: ['GET', 'OPTIONS'],
  authLevel: 'anonymous',
  route: 'api/bring/lists',
  handler: bringHandler,
});

app.http('bringItems', {
  methods: ['GET', 'POST', 'OPTIONS'],
  authLevel: 'anonymous',
  route: 'api/bring/lists/{listUuid}/items',
  handler: bringHandler,
});

app.http('bringPrepareMutation', {
  methods: ['POST', 'OPTIONS'],
  authLevel: 'anonymous',
  route: 'api/bring/lists/{listUuid}/mutations/prepare',
  handler: bringHandler,
});

app.http('bringApplyMutation', {
  methods: ['POST', 'OPTIONS'],
  authLevel: 'anonymous',
  route: 'api/bring/lists/{listUuid}/mutations/apply',
  handler: bringHandler,
});
