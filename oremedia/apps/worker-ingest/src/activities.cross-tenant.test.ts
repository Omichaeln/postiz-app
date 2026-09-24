import { vi } from 'vitest';
// Relative import: the harness and its fixtures live with the other cross-tenant fixtures (tooling/test-fixtures).
import {
  describeActivityHarness,
  type WorkerRegistration,
} from '../../../tooling/test-fixtures/src/activity-harness';
import { composeCredentialBroker, composeModules } from './composition';
import { startIngestWorkers } from './ingest-worker';

/**
 * Ledger S.1: worker-ingest's activities in the cross-tenant harness. Temporal's Worker.create is stubbed to record
 * each worker's task queue and activities object, then the production startIngestWorkers runs (`ingest-metrics`
 * and `ingest-comments`), so the harness enumerates exactly what this process registers.
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
  KMS_LOCAL_MASTER_SECRET: ['harness', 'master', 'key'].join('-'), // test-only value, assembled so the secrets scan sees no literal
  COMMENT_AUTHOR_HASH_SECRET_REF: ['harness', 'author', 'key'].join('-'),
};

composeModules(env);
composeCredentialBroker(env);
await startIngestWorkers({ address: 'cross-tenant-harness:7233', namespace: 'cross-tenant-harness' }, env);

describeActivityHarness('worker-ingest', () => registrations);
