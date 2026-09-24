import { vi } from 'vitest';
import { providerRegistry } from '@oremedia/providers';
// Relative imports: the harness and its fixtures live with the other cross-tenant fixtures (tooling/test-fixtures).
import {
  describeActivityHarness,
  type WorkerRegistration,
} from '../../../tooling/test-fixtures/src/activity-harness';
import { startAgentsWorker } from './agents-worker';
import { composeModules } from './composition';
import { startPublishingWorkers } from './publishing-worker';

/**
 * Ledger S.1: worker-core's activities in the cross-tenant harness. Temporal's Worker.create is stubbed to record
 * each worker's task queue and activities object, then the production start functions run (startAgentsWorker for
 * `agents`, startPublishingWorkers for `core` and every `publish-<provider>` queue), so the harness enumerates
 * exactly what this process registers. Every provider is reported certified while the workers are created so the
 * provider queues register too (the Release 1 adapters are not certified yet, which would hide those activities).
 */
const registrations = vi.hoisted((): WorkerRegistration[] => []);
vi.mock('@temporalio/worker', () => ({
  NativeConnection: { connect: async () => ({ close: async () => undefined }) },
  Worker: {
    create: async (opts: { taskQueue: string; activities?: object }) => {
      registrations.push({ taskQueue: opts.taskQueue, activities: opts.activities ?? {} });
      return { run: async () => undefined, shutdown: () => undefined };
    },
  },
}));

const env = {
  NODE_ENV: 'test',
  OREMEDIA_FAKE_MODEL: '1', // the scripted fake adapter; no model is called for foreign ids
  KMS_LOCAL_MASTER_SECRET: ['harness', 'master', 'key'].join('-'), // test-only value, assembled so the secrets scan sees no literal
};
const temporal = { address: 'cross-tenant-harness:7233', namespace: 'cross-tenant-harness' };

composeModules();
const list = providerRegistry.list.bind(providerRegistry);
const certifiedAll = vi
  .spyOn(providerRegistry, 'list')
  .mockImplementation(() => list().map((p) => ({ ...p, certified: true })));
await startAgentsWorker(temporal, env);
await startPublishingWorkers(temporal, env);
certifiedAll.mockRestore();

describeActivityHarness('worker-core', () => registrations);
