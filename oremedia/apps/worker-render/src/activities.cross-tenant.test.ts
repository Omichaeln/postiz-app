import { vi } from 'vitest';
import type * as Db from '@oremedia/db';
// Relative import: the harness and its fixtures live with the other cross-tenant fixtures (tooling/test-fixtures).
import {
  describeActivityHarness,
  type WorkerRegistration,
} from '../../../tooling/test-fixtures/src/activity-harness';

/**
 * Ledger S.1: worker-render's activities in the cross-tenant harness. worker.ts is the process entry (it configures
 * the database and object store and creates both Temporal workers at module load), so Temporal's Worker.create is
 * stubbed to record each worker's task queue and activities object, the database configuration calls are stubbed
 * (the harness owns the test database), and the real module is loaded: the harness enumerates exactly what the
 * `render` and `media` workers register. Object storage falls back to the in-memory provider outside production.
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
vi.mock('@oremedia/db', async (importOriginal) => ({
  ...(await importOriginal<typeof Db>()),
  configureDatabase: () => undefined,
  closeDatabase: async () => undefined,
}));

process.env['DATABASE_URL'] ??= 'mysql://cross-tenant-harness/unused';
process.env['TEMPORAL_ADDRESS'] ??= 'cross-tenant-harness:7233';
await import('./worker');

describeActivityHarness('worker-render', () => registrations);
