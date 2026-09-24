import { describe, expect, it } from 'vitest';
import { WorkflowNotFoundError, type Client } from '@temporalio/client';
import { TemporalWorkflowProbe } from './publishing-worker';

/** A client whose describe() answers as scripted: a status name, or a thrown error. */
const clientDescribing = (answer: string | Error): Pick<Client, 'workflow'> =>
  ({
    workflow: {
      getHandle: () => ({
        describe: async () => {
          if (answer instanceof Error) throw answer;
          return { status: { name: answer } };
        },
      }),
    },
  }) as unknown as Pick<Client, 'workflow'>;

describe('TemporalWorkflowProbe (the sweeper asks before declaring worker loss, spec 14.2)', () => {
  it('reports RUNNING as running and any closed status as not running', async () => {
    expect(await new TemporalWorkflowProbe(clientDescribing('RUNNING')).isRunning('pub:1')).toBe(true);
    expect(await new TemporalWorkflowProbe(clientDescribing('COMPLETED')).isRunning('pub:1')).toBe(false);
  });

  it('an unknown workflow id is not running', async () => {
    const probe = new TemporalWorkflowProbe(
      clientDescribing(new WorkflowNotFoundError('workflow not found', 'pub:1', undefined)),
    );
    expect(await probe.isRunning('pub:1')).toBe(false);
  });

  it('a transport failure (Temporal unreachable) is treated as running, never as worker loss', async () => {
    const unavailable = Object.assign(new Error('14 UNAVAILABLE: No connection established'), { code: 14 });
    expect(await new TemporalWorkflowProbe(clientDescribing(unavailable)).isRunning('pub:1')).toBe(true);
  });
});
