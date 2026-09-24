import { hostname } from 'node:os';
import { startTelemetry, stopTelemetry } from '@oremedia/observability';
import { configureDatabase, closeDatabase } from '@oremedia/db';
import { composeModules } from './composition';
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
composeModules();

const client = await connectTemporal(temporalConfig);
const controller = new AbortController();
const workerId = `${hostname()}:${process.pid}`;
log.info({ status: workerId }, 'worker-core dispatching outbox');

// Spec 4.4: the core / agents / publish-{provider} Temporal workers register here when their workflows exist
// (Phases 4 and 5). Until then this process is the outbox dispatcher only.
const loop = runDispatchLoop({
  workerId,
  starter: new TemporalWorkflowStarter(client),
  intervalMs: Number(process.env['OUTBOX_POLL_INTERVAL_MS'] ?? 1000),
  signal: controller.signal,
});

const shutdown = async () => {
  controller.abort();
  await loop;
  await client.connection.close();
  await closeDatabase();
  await stopTelemetry();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
