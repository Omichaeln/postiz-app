import { startTelemetry, stopTelemetry } from '@oremedia/observability';
import { configureDatabase, closeDatabase } from '@oremedia/db';
import { definitionService } from '@oremedia/module-measurement';
import { providerRegistry } from '@oremedia/providers';
import { composeCredentialBroker, composeModules } from './composition';
import { startIngestWorkers } from './ingest-worker';
import { temporalConfigFromEnv } from './temporal';

const log = startTelemetry({ service: 'oremedia-worker-ingest', version: process.env['OREMEDIA_VERSION'] });
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

// Spec 4.4 / 14.7: scheduled pulls with provider rate limits; this process (with worker-core) may decrypt.
let ingestWorkers;
try {
  composeModules();
  composeCredentialBroker();
  // Spec 15.1: global metric definitions follow the certified capability register (idempotent).
  const seeded = await definitionService.seedGlobal(
    providerRegistry
      .list()
      .filter((p) => p.certified)
      .map((p) => p.capability),
  );
  log.info({ count: seeded }, 'metric definitions seeded');
  ingestWorkers = await startIngestWorkers(temporalConfig);
} catch (err) {
  log.error(
    { errorMessage: err instanceof Error ? err.message : String(err) },
    'ingest workers could not start',
  );
  process.exit(2);
}
const ingestRun = ingestWorkers.run();

const shutdown = async () => {
  ingestWorkers.shutdown();
  await ingestRun;
  await ingestWorkers.close();
  await closeDatabase();
  await stopTelemetry();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
