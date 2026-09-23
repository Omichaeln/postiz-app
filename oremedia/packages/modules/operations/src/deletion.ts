import type { z } from 'zod';
import type { DeletionRequestCreate } from '@oremedia/contracts/operations';
import { TenantScopedRepository, type Tx } from '@oremedia/db';
import { deletionRequests } from '@oremedia/db/schema/operations';
import { newId } from '@oremedia/domain/ids';
import { audit, type AuditActor } from './audit';

class DeletionRequestRepository extends TenantScopedRepository<typeof deletionRequests> {
  constructor() {
    super(deletionRequests);
  }
  async create(values: Omit<typeof deletionRequests.$inferInsert, 'tenantId'>, tx?: Tx) {
    await this.insertScoped(values, tx);
  }
}
const repo = new DeletionRequestRepository();

/** Spec 17.5: deletion requests fan out to every store; processing is a worker job (Phase 7). */
export const deletion = {
  async request(
    actor: AuditActor,
    input: z.infer<typeof DeletionRequestCreate>,
    tx: Tx,
  ): Promise<{ deletionRequestId: string }> {
    const id = newId('deletionRequest');
    await repo.create(
      {
        id,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        reason: input.reason,
        requestedByKind: actor.kind,
        requestedById: actor.id,
        state: 'requested',
        fanout: {
          database: 'pending',
          object_storage: 'pending',
          indexes: 'pending',
          temporal_visibility: 'pending',
          logs: 'pending',
          provider_side: 'pending',
          backups: 'pending',
        },
      },
      tx,
    );
    await audit.record(actor, 'deletion.request', { type: 'deletion_request', id }, 'allowed', tx);
    return { deletionRequestId: id };
  },
};
