import type { AuthenticatedPrincipal } from '../../authorization/types.js';
import type { BringConnection, BringConnectionResolverPort } from '../../providerConnections/bring.js';
import { BringDisabledError, BringService } from '../../../shared/bring/service.js';
import type { BringList, BringListSummary, BringMutationResult } from '../../../shared/bring/types.js';
import {
  BringMutationCoordinator,
  type AddItemsCommand,
  type ApplyMutationCommand,
  type PreparedBringMutation,
  type PrepareMutationCommand,
} from './mutations.js';

export interface BringApplicationPort {
  listLists(principal: AuthenticatedPrincipal): Promise<{ source: 'bring'; lists: BringListSummary[] }>;
  getList(principal: AuthenticatedPrincipal, listUuid?: string): Promise<BringList>;
  addItems(
    principal: AuthenticatedPrincipal,
    command: AddItemsCommand,
    correlationId: string,
  ): Promise<BringMutationResult>;
  prepareMutation(
    principal: AuthenticatedPrincipal,
    command: PrepareMutationCommand,
    correlationId: string,
  ): Promise<PreparedBringMutation | BringMutationResult>;
  applyMutation(
    principal: AuthenticatedPrincipal,
    command: ApplyMutationCommand,
    correlationId: string,
  ): Promise<BringMutationResult>;
  getMutationOperation(
    principal: AuthenticatedPrincipal,
    operationId: string,
  ): Promise<'complete' | 'remove' | undefined>;
}

export class BringApplication implements BringApplicationPort {
  constructor(
    private readonly service: BringService,
    private readonly mutationCoordinator: BringMutationCoordinator | null,
    private readonly connectionResolver: BringConnectionResolverPort,
    private readonly connection: BringConnection,
  ) {}

  listLists(principal: AuthenticatedPrincipal): Promise<{ source: 'bring'; lists: BringListSummary[] }> {
    this.assertConnectionAccess(principal);
    return this.service.listLists();
  }

  getList(principal: AuthenticatedPrincipal, listUuid?: string): Promise<BringList> {
    this.assertConnectionAccess(principal);
    return this.service.getList(listUuid);
  }

  addItems(
    principal: AuthenticatedPrincipal,
    command: AddItemsCommand,
    correlationId: string,
  ): Promise<BringMutationResult> {
    this.assertConnectionAccess(principal);
    return this.requireMutationCoordinator().addItems(principal, command, correlationId);
  }

  prepareMutation(
    principal: AuthenticatedPrincipal,
    command: PrepareMutationCommand,
    correlationId: string,
  ): Promise<PreparedBringMutation | BringMutationResult> {
    this.assertConnectionAccess(principal);
    return this.requireMutationCoordinator().prepare(principal, command, correlationId);
  }

  applyMutation(
    principal: AuthenticatedPrincipal,
    command: ApplyMutationCommand,
    correlationId: string,
  ): Promise<BringMutationResult> {
    this.assertConnectionAccess(principal);
    return this.requireMutationCoordinator().apply(principal, command, correlationId);
  }

  getMutationOperation(
    principal: AuthenticatedPrincipal,
    operationId: string,
  ): Promise<'complete' | 'remove' | undefined> {
    this.assertConnectionAccess(principal);
    return this.requireMutationCoordinator().getMutationOperation(operationId);
  }

  private assertConnectionAccess(principal: AuthenticatedPrincipal): void {
    const resolved = this.connectionResolver.resolve(principal);
    if (resolved !== this.connection) {
      throw new Error('Bring connection resolver returned an unbound runtime connection.');
    }
  }

  private requireMutationCoordinator(): BringMutationCoordinator {
    if (!this.mutationCoordinator) {
      throw new BringDisabledError('Bring mutation operations are disabled.');
    }
    return this.mutationCoordinator;
  }
}
