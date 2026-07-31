import type { AuthenticatedPrincipal } from '../../authorization/types.js';
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
  listLists(): Promise<{ source: 'bring'; lists: BringListSummary[] }>;
  getList(listUuid?: string): Promise<BringList>;
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
  getMutationOperation(operationId: string): Promise<'complete' | 'remove' | undefined>;
  getConfirmationOperation(confirmationToken: string): 'complete' | 'remove' | undefined;
}

export class BringApplication implements BringApplicationPort {
  constructor(
    private readonly service: BringService,
    private readonly mutationCoordinator: BringMutationCoordinator | null,
  ) {}

  listLists(): Promise<{ source: 'bring'; lists: BringListSummary[] }> {
    return this.service.listLists();
  }

  getList(listUuid?: string): Promise<BringList> {
    return this.service.getList(listUuid);
  }

  addItems(
    principal: AuthenticatedPrincipal,
    command: AddItemsCommand,
    correlationId: string,
  ): Promise<BringMutationResult> {
    return this.requireMutationCoordinator().addItems(principal, command, correlationId);
  }

  prepareMutation(
    principal: AuthenticatedPrincipal,
    command: PrepareMutationCommand,
    correlationId: string,
  ): Promise<PreparedBringMutation | BringMutationResult> {
    return this.requireMutationCoordinator().prepare(principal, command, correlationId);
  }

  applyMutation(
    principal: AuthenticatedPrincipal,
    command: ApplyMutationCommand,
    correlationId: string,
  ): Promise<BringMutationResult> {
    return this.requireMutationCoordinator().apply(principal, command, correlationId);
  }

  getMutationOperation(operationId: string): Promise<'complete' | 'remove' | undefined> {
    return this.requireMutationCoordinator().getMutationOperation(operationId);
  }

  getConfirmationOperation(confirmationToken: string): 'complete' | 'remove' | undefined {
    return this.requireMutationCoordinator().getConfirmationOperation(confirmationToken);
  }

  private requireMutationCoordinator(): BringMutationCoordinator {
    if (!this.mutationCoordinator) {
      throw new BringDisabledError('Bring mutation operations are disabled.');
    }
    return this.mutationCoordinator;
  }
}
