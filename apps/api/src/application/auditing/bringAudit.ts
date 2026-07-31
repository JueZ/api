import type { BringMutationAuditEvent } from '../idempotency/bringMutation.js';

export interface BringAuditSink {
  append(event: BringMutationAuditEvent): Promise<void>;
}

export class InMemoryBringAuditSink implements BringAuditSink {
  readonly events: BringMutationAuditEvent[] = [];

  async append(event: BringMutationAuditEvent): Promise<void> {
    this.events.push(structuredClone(event));
  }
}
