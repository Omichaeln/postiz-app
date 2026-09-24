import type { z } from 'zod';
import { eq } from 'drizzle-orm';
import { NotFoundError, PolicyDeniedError } from '@oremedia/contracts/errors';
import type {
  DeletionFanoutStatus,
  DeletionFinishResultV1,
  DeletionPlanV1,
  DeletionRequestCreate,
  DeletionStepResultV1,
} from '@oremedia/contracts/operations';
import { TenantScopedRepository, requireTenant, type Tx } from '@oremedia/db';
import { deletionRequests } from '@oremedia/db/schema/operations';
import { newId } from '@oremedia/domain/ids';
import { deletionRequestMachine } from '@oremedia/domain/state-machines/deletion-request';
import { DeletionWorkflowInputV1 } from '@oremedia/contracts/operations';
import { audit, type AuditActor } from './audit';
import { outbox } from './outbox';
import { registerOutboxRoute } from './outbox-routes';

type SubjectType = z.infer<typeof DeletionRequestCreate>['subjectType'];
type DeletionRow = typeof deletionRequests.$inferSelect;

/** Spec 17.5 stores a deletion reaches; each handler covers exactly one. */
export type DeletionStore =
  'database' | 'object_storage' | 'indexes' | 'temporal_visibility' | 'logs' | 'provider_side' | 'backups';

const STORES: readonly DeletionStore[] = [
  'database',
  'object_storage',
  'indexes',
  'temporal_visibility',
  'logs',
  'provider_side',
  'backups',
];

/** What a handler deletes: the tenant (and, for a brand deletion, the brand) named by one deletion request. */
export interface DeletionScope {
  deletionRequestId: string;
  tenantId: string;
  subjectType: SubjectType;
  subjectId: string;
  /** Set for a brand deletion: every handler narrows to this brand. */
  brandId?: string;
}

/** Counts per table or store (e.g. `{ publications: 3, objects: 2 }`), recorded as the step's evidence. */
export type DeletionEvidence = Record<string, number | string>;

/**
 * One subsystem's part of a deletion. Each module registers its handler at its composition root, so this module
 * never names another module's tables. A handler either runs in the step's transaction (idempotent: a repeat
 * deletes nothing) or, for a store with no API from the worker, names the exact operator action.
 */
export interface DeletionHandler {
  name: string;
  store: DeletionStore;
  subjects: readonly SubjectType[];
  run?(scope: DeletionScope, tx: Tx): Promise<DeletionEvidence>;
  operatorAction?: string;
}

/** Handler names share one fan-out map with the store roll-ups; a platform step is named after its store. */
const handlers: DeletionHandler[] = [];

/** Handlers run in registration order (children before parents across subsystems). Re-registering replaces. */
export function registerDeletionHandler(handler: DeletionHandler): void {
  if (!handler.run === !handler.operatorAction)
    throw new Error(`deletion handler ${handler.name} needs exactly one of run or operatorAction`);
  const i = handlers.findIndex((h) => h.name === handler.name);
  if (i >= 0) handlers[i] = handler;
  else handlers.push(handler);
}

export const deletionHandlers = (): readonly DeletionHandler[] => handlers;

/** Test seam. */
export function clearDeletionHandlers(): void {
  handlers.length = 0;
}

/**
 * The stores the worker cannot purge itself (spec 17.5). The commands are in docs/runbooks/process-deletion-request.md;
 * the composition root registers these after the module handlers.
 */
export function registerPlatformDeletionSteps(): void {
  registerDeletionHandler({
    name: 'temporal_visibility',
    store: 'temporal_visibility',
    subjects: ['tenant', 'brand'],
    operatorAction:
      'temporal workflow delete --namespace $TEMPORAL_NAMESPACE --query "WorkflowId STARTS_WITH \'<prefix>\'" per workflow-id prefix listed in the runbook (search attributes carry ids only)',
  });
  registerDeletionHandler({
    name: 'logs',
    store: 'logs',
    subjects: ['tenant', 'brand'],
    operatorAction:
      'confirm the log sink retention (≤ 30 days) has elapsed since completion or purge by tenantId in the log backend; logs carry allowlisted fields only',
  });
  registerDeletionHandler({
    name: 'backups',
    store: 'backups',
    subjects: ['tenant', 'brand'],
    operatorAction:
      'backups expire by policy (PITR window); record the expiry date; a restore before it must re-apply this request (restore-single-tenant runbook step 6)',
  });
  registerDeletionHandler({
    name: 'provider_side',
    store: 'provider_side',
    subjects: ['tenant', 'brand'],
    operatorAction:
      'remote posts stay on the platforms unless the tenant asked for removal: publishing.publications.deleteRemote per post before the request, or record that none was asked',
  });
}

class DeletionRequestRepository extends TenantScopedRepository<typeof deletionRequests> {
  constructor() {
    super(deletionRequests);
  }
  async create(values: Omit<typeof deletionRequests.$inferInsert, 'tenantId'>, tx?: Tx) {
    await this.insertScoped(values, tx);
  }
  /** SELECT ... FOR UPDATE: fan-out steps of one request serialise on its row. */
  async lock(id: string, tx: Tx): Promise<DeletionRow> {
    const rows = await tx
      .select()
      .from(deletionRequests)
      .where(this.scope(eq(deletionRequests.id, id)))
      .for('update');
    const row = rows[0];
    if (!row) throw new NotFoundError('DeletionRequest', id);
    return row;
  }
  async update(row: DeletionRow, values: Partial<typeof deletionRequests.$inferInsert>, tx: Tx) {
    await this.updateScoped(row.id, row.version, values, tx);
  }
}
const repo = new DeletionRequestRepository();

const INITIAL_FANOUT: Record<DeletionStore, DeletionFanoutStatus> = {
  database: 'pending',
  object_storage: 'pending',
  indexes: 'pending',
  temporal_visibility: 'pending',
  logs: 'pending',
  provider_side: 'pending',
  backups: 'pending',
};

function scopeOf(row: DeletionRow): DeletionScope {
  return {
    deletionRequestId: row.id,
    tenantId: row.tenantId,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    ...(row.subjectType === 'brand' ? { brandId: row.subjectId } : {}),
  };
}

/** A store is done when every handler of it is done or not applicable; blocked when one waits for an operator. */
function storeStatuses(
  fanout: Record<string, DeletionFanoutStatus>,
): Record<DeletionStore, DeletionFanoutStatus> {
  const out = { ...INITIAL_FANOUT };
  for (const store of STORES) {
    const mine = handlers.filter((h) => h.store === store).map((h) => fanout[h.name] ?? 'pending');
    if (mine.length === 0) out[store] = 'not_applicable';
    else if (mine.some((s) => s === 'pending')) out[store] = 'pending';
    else if (mine.some((s) => s === 'blocked')) out[store] = 'blocked';
    else if (mine.every((s) => s === 'not_applicable')) out[store] = 'not_applicable';
    else out[store] = 'done';
  }
  return out;
}

const summarise = (evidence: DeletionEvidence): string =>
  Object.entries(evidence)
    .map(([k, v]) => `${k}=${v}`)
    .join(',')
    .slice(0, 1000);

/**
 * Spec 17.5: a deletion request fans out to every store. `request` records it and emits
 * `operations.deletion_requested` (deletionRequestWorkflowV1); the workflow calls `begin`, `runHandler` per
 * registered handler and `finish`. Every step is idempotent, so a retried activity or a re-run request is a no-op
 * for the handlers already done.
 */
export const deletion = {
  async request(
    actor: AuditActor,
    input: z.infer<typeof DeletionRequestCreate>,
    tx: Tx,
  ): Promise<{ deletionRequestId: string }> {
    const ctx = requireTenant();
    if (input.subjectType === 'tenant' && input.subjectId !== ctx.tenantId)
      throw new NotFoundError('Tenant', input.subjectId);
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
        fanout: { ...INITIAL_FANOUT },
      },
      tx,
    );
    await audit.record(actor, 'deletion.request', { type: 'deletion_request', id }, 'allowed', tx);
    await outbox.add(
      'operations.deletion_requested',
      { type: 'deletion_request', id, version: 0 },
      {
        deletionRequestId: id,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        actorKind: actor.kind,
        actorId: actor.id,
      },
      tx,
      input.subjectType === 'brand' ? { brandId: input.subjectId } : undefined,
    );
    return { deletionRequestId: id };
  },

  /** requested → in_progress (blocked → in_progress on a re-run); lists the handlers still pending, in order. */
  async begin(actor: AuditActor, id: string, tx: Tx): Promise<DeletionPlanV1> {
    const row = await repo.lock(id, tx);
    if (row.state === 'completed') return { state: row.state, pending: [] };
    const fanout: Record<string, DeletionFanoutStatus> = { ...row.fanout };
    for (const h of handlers) fanout[h.name] ??= 'pending';
    const pending = handlers.filter((h) => fanout[h.name] === 'pending').map((h) => h.name);
    // A request waiting for its operator actions with nothing new to run is left exactly as it is (a no-op re-run).
    if (row.state === 'blocked' && pending.length === 0) return { state: row.state, pending };
    const event = row.state === 'requested' ? 'begin' : row.state === 'blocked' ? 'resume' : null;
    const state = event ? deletionRequestMachine.transition(row.state, event) : row.state;
    await repo.update(row, { state, fanout: { ...fanout, ...storeStatuses(fanout) } }, tx);
    if (event)
      await audit.record(actor, 'deletion.begin', { type: 'deletion_request', id }, 'allowed', tx, {
        fromState: row.state,
        toState: state,
      });
    return { state, pending };
  },

  /** Runs one handler in this transaction and records its completion with evidence. A finished step is skipped. */
  async runHandler(actor: AuditActor, id: string, name: string, tx: Tx): Promise<DeletionStepResultV1> {
    const row = await repo.lock(id, tx);
    const handler = handlers.find((h) => h.name === name);
    if (!handler) throw new PolicyDeniedError('deletion_handler_unknown', `No deletion handler ${name}`);
    const current = row.fanout[name];
    if (row.state !== 'in_progress' || (current && current !== 'pending'))
      return { handler: name, status: 'skipped', evidence: { status: current ?? row.state } };
    let status: DeletionFanoutStatus;
    let evidence: DeletionEvidence;
    let result: DeletionStepResultV1['status'];
    if (!handler.subjects.includes(row.subjectType)) {
      status = 'not_applicable';
      result = 'not_applicable';
      evidence = { subjectType: row.subjectType };
    } else if (handler.run) {
      evidence = await handler.run(scopeOf(row), tx);
      status = 'done';
      result = 'done';
    } else {
      status = 'blocked';
      result = 'operator_action_required';
      evidence = { operatorAction: handler.operatorAction ?? 'see the deletion runbook' };
    }
    const fanout = { ...row.fanout, [name]: status };
    await repo.update(row, { fanout: { ...fanout, ...storeStatuses(fanout) } }, tx);
    const rows = Object.values(evidence).reduce<number>((n, v) => n + (typeof v === 'number' ? v : 0), 0);
    await audit.record(actor, 'deletion.step', { type: 'deletion_request', id }, 'allowed', tx, {
      scope: name,
      toState: status,
      count: rows,
      evidence: summarise(evidence),
    });
    return { handler: name, status: result, evidence };
  },

  /** in_progress → completed, or → blocked with the operator actions still to do. */
  async finish(actor: AuditActor, id: string, tx: Tx): Promise<DeletionFinishResultV1> {
    const row = await repo.lock(id, tx);
    const waiting = handlers.filter((h) => row.fanout[h.name] === 'blocked');
    const operatorActions = waiting.map((h) => h.name);
    if (row.state !== 'in_progress') return { state: row.state, operatorActions };
    const pending = handlers.filter((h) => (row.fanout[h.name] ?? 'pending') === 'pending');
    if (pending.length)
      throw new PolicyDeniedError(
        'deletion_steps_pending',
        `Deletion ${id} still has pending steps: ${pending.map((h) => h.name).join(', ')}`,
      );
    const state = deletionRequestMachine.transition(
      row.state,
      waiting.length ? 'await_operator' : 'complete',
    );
    await repo.update(
      row,
      state === 'completed'
        ? { state, completedAt: new Date(), blockedReason: null }
        : { state, blockedReason: `operator action required: ${operatorActions.join(', ')}` },
      tx,
    );
    await audit.record(
      actor,
      state === 'completed' ? 'deletion.complete' : 'deletion.await_operator',
      { type: 'deletion_request', id },
      'allowed',
      tx,
      { fromState: row.state, toState: state, count: operatorActions.length },
    );
    return { state, operatorActions };
  },

  /**
   * Spec 17.6 / restore runbook step 6: after a tenant's rows were restored from a point before this request, its
   * automated steps must run again. Every step that ran (done / not applicable) goes back to pending; operator
   * steps already confirmed stay done. The deletion workflow is then re-run for the request.
   */
  async reapply(actor: AuditActor, id: string, tx: Tx): Promise<DeletionPlanV1> {
    const row = await repo.lock(id, tx);
    const state = deletionRequestMachine.transition(row.state, 'reapply');
    const fanout: Record<string, DeletionFanoutStatus> = { ...row.fanout };
    for (const h of handlers) if (h.run) fanout[h.name] = 'pending';
    await repo.update(
      row,
      { state, completedAt: null, blockedReason: null, fanout: { ...fanout, ...storeStatuses(fanout) } },
      tx,
    );
    await audit.record(actor, 'deletion.reapply', { type: 'deletion_request', id }, 'allowed', tx, {
      fromState: row.state,
      toState: state,
    });
    return { state, pending: handlers.filter((h) => fanout[h.name] === 'pending').map((h) => h.name) };
  },

  /** An operator records a store they purged by hand (runbook); the request completes when none is left. */
  async confirmOperatorAction(
    actor: AuditActor,
    id: string,
    name: string,
    note: string,
    tx: Tx,
  ): Promise<{ state: DeletionRow['state'] }> {
    const row = await repo.lock(id, tx);
    if (row.fanout[name] !== 'blocked')
      throw new PolicyDeniedError('deletion_step_not_waiting', `Step ${name} is not waiting for an operator`);
    const fanout = { ...row.fanout, [name]: 'done' as const };
    const stillWaiting = handlers.some((h) => fanout[h.name] === 'blocked');
    const state =
      stillWaiting || row.state !== 'blocked'
        ? row.state
        : deletionRequestMachine.transition(row.state, 'complete');
    await repo.update(
      row,
      {
        state,
        fanout: { ...fanout, ...storeStatuses(fanout) },
        ...(state === 'completed' ? { completedAt: new Date(), blockedReason: null } : {}),
      },
      tx,
    );
    await audit.record(actor, 'deletion.operator_action', { type: 'deletion_request', id }, 'allowed', tx, {
      scope: name,
      toState: state,
      reason: note.slice(0, 120),
    });
    return { state };
  },
};

/** Spec 4.4: deletion and retention run on task queue `core` (worker-core). */
export const OPERATIONS_TASK_QUEUE = 'core';
export const DELETION_WORKFLOW_TYPE = 'deletionRequestWorkflowV1';
export const RETENTION_SWEEP_WORKFLOW_TYPE = 'retentionSweepWorkflowV1';
export const RETENTION_SCHEDULE_ID = 'retention-sweep';
export const deletionWorkflowId = (deletionRequestId: string): string => `deletion:${deletionRequestId}`;

/**
 * operations.deletion_requested → deletionRequestWorkflowV1. The workflow id is stable per request, so a redelivered
 * event joins the running workflow; the request row's fan-out map is the dedupe authority for each step.
 */
export function registerOperationsOutboxRoutes(): void {
  registerOutboxRoute('operations.deletion_requested', (evt) => {
    const p = evt.payload;
    const input = DeletionWorkflowInputV1.parse({
      tenantId: evt.tenantId,
      actor: { kind: p['actorKind'], id: p['actorId'] },
      correlationId: evt.correlationId,
      deletionRequestId: p['deletionRequestId'],
    });
    return {
      workflowType: DELETION_WORKFLOW_TYPE,
      taskQueue: OPERATIONS_TASK_QUEUE,
      workflowId: deletionWorkflowId(input.deletionRequestId),
      args: [input],
    };
  });
}
