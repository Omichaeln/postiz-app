import { hostname } from 'node:os';
import { startTelemetry, stopTelemetry } from '@oremedia/observability';
import { configureDatabase, closeDatabase } from '@oremedia/db';
import { composeModules } from './composition';
import { TemporalWorkflowSignaller, startAgentsWorker } from './agents-worker';
import { runDispatchLoop } from './dispatch-loop';
import { TemporalWorkflowStarter, connectTemporal, temporalConfigFromEnv } from './temporal';

const log = startTelemetry({ service: 'oremedia-worker-core', version: process.env['OREMEDIA_VERSION'] });
const url = process.env['DATABASE_URL'];
if (!url) {
  log.error({}, 'DATABASE_URL is required');
  process.exit(2);
}
let temporalConfig;
try {
  temporalConfig = temporalConfigFromEnv();
} catch (err) {
  log.error(
    { errorMessage: err instanceof Error ? err.message : String(err) },
    'temporal configuration invalid',
  );
  process.exit(2);
}
configureDatabase({ url, connectionLimit: Number(process.env['DATABASE_POOL'] ?? 5) });

const client = await connectTemporal(temporalConfig);
composeModules({ signaller: new TemporalWorkflowSignaller(client) });
const controller = new AbortController();
const workerId = `${hostname()}:${process.pid}`;
log.info({ status: workerId }, 'worker-core dispatching outbox');

// Spec 4.4: worker-core hosts the `agents` task queue (Phase 4); the core / publish-{provider} workers register
// here when their workflows exist (Phase 5). The outbox dispatcher keeps running alongside.
let agentsWorker;
try {
  agentsWorker = await startAgentsWorker(temporalConfig);
} catch (err) {
  log.error(
    { errorMessage: err instanceof Error ? err.message : String(err) },
    'agents worker could not start',
  );
  process.exit(2);
}
const agentsRun = agentsWorker.run();
const loop = runDispatchLoop({
  workerId,
  starter: new TemporalWorkflowStarter(client),
  intervalMs: Number(process.env['OUTBOX_POLL_INTERVAL_MS'] ?? 1000),
  signal: controller.signal,
});

const shutdown = async () => {
  controller.abort();
  agentsWorker.shutdown();
  await Promise.all([loop, agentsRun]);
  await agentsWorker.close();
  await client.connection.close();
  await closeDatabase();
  await stopTelemetry();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
