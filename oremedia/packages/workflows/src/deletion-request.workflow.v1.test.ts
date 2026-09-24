import { describe, expect, it } from 'vitest';
import type { DeletionActivitiesV1, DeletionStepResultV1 } from '@oremedia/contracts/operations';
import { runDeletionRequest } from './deletion-request.workflow.v1';

const input = {
  tenantId: 'ten_A',
  actor: { kind: 'user' as const, id: 'usr_1' },
  correlationId: 'c',
  deletionRequestId: 'dr_1',
};

function fakes(pending: string[], operator: string[] = []) {
  const calls: string[] = [];
  const acts: DeletionActivitiesV1 = {
    beginDeletion: async () => {
      calls.push('begin');
      return { state: 'in_progress', pending };
    },
    runDeletionHandler: async ({ handler }) => {
      calls.push(`run:${handler}`);
      const status: DeletionStepResultV1['status'] = operator.includes(handler)
        ? 'operator_action_required'
        : 'done';
      return { handler, status, evidence: {} };
    },
    finishDeletion: async () => {
      calls.push('finish');
      return { state: operator.length ? 'blocked' : 'completed', operatorActions: operator };
    },
  };
  return { acts, calls };
}

describe('deletionRequestWorkflowV1 orchestration (spec 17.5)', () => {
  it('runs every pending handler in order, one activity each, then finishes', async () => {
    const f = fakes(['agents', 'publishing', 'assets']);
    const out = await runDeletionRequest(f.acts, input);
    expect(f.calls).toEqual(['begin', 'run:agents', 'run:publishing', 'run:assets', 'finish']);
    expect(out).toEqual({
      state: 'completed',
      steps: [
        { handler: 'agents', status: 'done' },
        { handler: 'publishing', status: 'done' },
        { handler: 'assets', status: 'done' },
      ],
      operatorActions: [],
    });
  });
  it('operator-only stores leave the request blocked with the actions named', async () => {
    const f = fakes(['database', 'logs'], ['logs']);
    const out = await runDeletionRequest(f.acts, input);
    expect(out).toMatchObject({ state: 'blocked', operatorActions: ['logs'] });
  });
  it('a re-run with nothing pending only finishes (idempotent)', async () => {
    const f = fakes([]);
    await runDeletionRequest(f.acts, input);
    expect(f.calls).toEqual(['begin', 'finish']);
  });
});
