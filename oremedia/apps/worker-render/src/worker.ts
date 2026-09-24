import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NativeConnection,
  Worker,
  type NativeConnectionOptions,
  type WorkerOptions,
} from '@temporalio/worker';
import { createAssetIngestActivities, createRenderJobActivities } from '@oremedia/activities';
import { closeDatabase, configureDatabase } from '@oremedia/db';
import { RENDERER_VERSION } from '@oremedia/editor/renderer/version';
import { configureStorage, createStorageFromEnv, storage } from '@oremedia/module-assets';
import { startTelemetry, stopTelemetry } from '@oremedia/observability';
import { createChromiumRenderer } from './chromium-renderer';
import { creativeRenderJobStore } from './creative-store';

/**
 * worker-render (spec 4.4, 11.5): the isolated worker pool for CPU/memory-heavy and untrusted-input work. Two
 * Temporal workers share one connection: task queue `render` (renderJobWorkflowV1: headless Chromium) and task
 * queue `media` (assetIngestWorkflowV1: sniffing, scanning, sanitising and derivatives of uploads). No credential
 * broker access; egress is restricted to the object store at the network layer. Workflow code is pre-bundled at
 * build time (tsup.config.ts → dist/workflows.<queue>.js) because production images carry no sources. The process
 * entry is main.ts, which checks the configuration before this module (and its dependencies) load.
 */
const log = startTelemetry({ service: 'oremedia-worker-render', version: process.env['OREMEDIA_VERSION'] });
// main.ts already refused to start without these; the checks stay here so this module is safe to run directly.
const databaseUrl = process.env['DATABASE_URL'];
if (!databaseUrl) {
  log.error({}, 'DATABASE_URL is required');
  process.exit(2);
}
const temporalAddress = process.env['TEMPORAL_ADDRESS'];
if (!temporalAddress) {
  log.error({}, 'TEMPORAL_ADDRESS is required');
  process.exit(2);
}
configureDatabase({ url: databaseUrl, connectionLimit: Number(process.env['DATABASE_POOL'] ?? 4) });
configureStorage(createStorageFromEnv());

const here = dirname(fileURLToPath(import.meta.url));
const production = (process.env['NODE_ENV'] ?? 'development') === 'production';

/** The pre-built bundle next to this file; outside production the queue entry is bundled at start instead. */
function workflowsFor(queue: 'render' | 'media'): Pick<WorkerOptions, 'workflowBundle' | 'workflowsPath'> {
  const codePath = join(here, `workflows.${queue}.js`);
  if (existsSync(codePath)) return { workflowBundle: { codePath } };
  if (production) {
    log.error(
      { codePath },
      'workflow bundle missing: build the worker (pnpm --filter @oremedia/worker-render build)',
    );
    process.exit(2);
  }
  return { workflowsPath: createRequire(import.meta.url).resolve(`@oremedia/workflows/queues/${queue}`) };
}

/** Temporal Cloud: mTLS client certificate files or an API key; self-hosted: plain address (Appendix A). */
async function connectionOptions(): Promise<NativeConnectionOptions> {
  const options: NativeConnectionOptions = { address: temporalAddress as string };
  const certPath = process.env['TEMPORAL_TLS_CERT_REF'];
  const keyPath = process.env['TEMPORAL_TLS_KEY_REF'];
  if (certPath && keyPath)
    options.tls = { clientCertPair: { crt: await readFile(certPath), key: await readFile(keyPath) } };
  else if (process.env['TEMPORAL_TLS'] === '1') options.tls = true;
  const apiKey = process.env['TEMPORAL_API_KEY'];
  if (apiKey) options.apiKey = apiKey;
  return options;
}

const namespace = process.env['TEMPORAL_NAMESPACE'] ?? 'default';
const connection = await NativeConnection.connect(await connectionOptions());
const renderer = createChromiumRenderer({
  ...(process.env['OREMEDIA_CHROMIUM_PATH'] ? { executablePath: process.env['OREMEDIA_CHROMIUM_PATH'] } : {}),
  ...(process.env['RENDER_TIMEOUT_MS'] ? { timeoutMs: Number(process.env['RENDER_TIMEOUT_MS']) } : {}),
});

const renderWorker = await Worker.create({
  connection,
  namespace,
  taskQueue: 'render',
  ...workflowsFor('render'),
  activities: createRenderJobActivities({
    store: creativeRenderJobStore(),
    renderer,
    rendererVersion: RENDERER_VERSION,
    storage: storage(),
  }),
  // Each render holds a browser context and a decoded page: bounded per container (spec 11.5 per-job limits).
  maxConcurrentActivityTaskExecutions: Number(process.env['RENDER_CONCURRENCY'] ?? 2),
});
const mediaWorker = await Worker.create({
  connection,
  namespace,
  taskQueue: 'media',
  ...workflowsFor('media'),
  activities: createAssetIngestActivities({ storage: storage() }),
  maxConcurrentActivityTaskExecutions: Number(process.env['MEDIA_CONCURRENCY'] ?? 4),
});
log.info({ status: RENDERER_VERSION }, 'worker-render polling task queues render and media');

const shutdown = () => {
  log.info({}, 'worker-render shutting down');
  renderWorker.shutdown();
  mediaWorker.shutdown();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

try {
  await Promise.all([renderWorker.run(), mediaWorker.run()]);
} finally {
  await renderer.close();
  await connection.close();
  await closeDatabase();
  await stopTelemetry();
}
