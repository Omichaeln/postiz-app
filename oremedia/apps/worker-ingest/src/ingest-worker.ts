import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NativeConnection, Worker, type WorkerOptions } from '@temporalio/worker';
import { createCommentIngestionActivities, createMetricCollectionActivities } from '@oremedia/activities';
import {
  INGEST_COMMENTS_TASK_QUEUE,
  INGEST_METRICS_TASK_QUEUE,
  createCommentIngestionRuntime,
  createMetricCollectionRuntime,
} from '@oremedia/module-measurement';
import { logger } from '@oremedia/observability';
import { connectionOptions, type TemporalConfig } from './temporal';

/**
 * Spec 4.4: worker-ingest hosts task queues `ingest-metrics` (metricCollectionWorkflowV1) and `ingest-comments`
 * (commentIngestionWorkflowV1); `listening` and `crm` arrive with Release 2. Both queues serve the same
 * pre-bundled workflow code (tsup.config.ts → dist/workflows.ingest.js), one Worker each so a slow comment pull
 * cannot hold back metric pulls and neither can starve publishing (its own process and queues).
 */
const here = dirname(fileURLToPath(import.meta.url));
const INGEST_BUNDLE = 'ingest';

function workflowsFor(production: boolean): Pick<WorkerOptions, 'workflowBundle' | 'workflowsPath'> {
  const codePath = join(here, `workflows.${INGEST_BUNDLE}.js`);
  if (existsSync(codePath)) return { workflowBundle: { codePath } };
  if (production)
    throw new Error(
      `workflow bundle ${codePath} is missing: build the worker (pnpm --filter @oremedia/worker-ingest build)`,
    );
  return {
    workflowsPath: createRequire(import.meta.url).resolve(`@oremedia/workflows/queues/${INGEST_BUNDLE}`),
  };
}

export interface IngestWorkersHandle {
  run(): Promise<void>;
  shutdown(): void;
  close(): Promise<void>;
}

export async function startIngestWorkers(
  cfg: TemporalConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<IngestWorkersHandle> {
  const production = (env['NODE_ENV'] ?? 'development') === 'production';
  const connection = await NativeConnection.connect(await connectionOptions(cfg));
  const workflows = workflowsFor(production);
  const metrics = await Worker.create({
    connection,
    namespace: cfg.namespace,
    taskQueue: INGEST_METRICS_TASK_QUEUE,
    ...workflows,
    activities: createMetricCollectionActivities(createMetricCollectionRuntime()),
    maxConcurrentActivityTaskExecutions: Number(env['INGEST_METRICS_CONCURRENCY'] ?? 8),
  });
  const comments = await Worker.create({
    connection,
    namespace: cfg.namespace,
    taskQueue: INGEST_COMMENTS_TASK_QUEUE,
    ...workflows,
    activities: createCommentIngestionActivities(createCommentIngestionRuntime()),
    maxConcurrentActivityTaskExecutions: Number(env['INGEST_COMMENTS_CONCURRENCY'] ?? 4),
  });
  logger().info(
    { status: `${INGEST_METRICS_TASK_QUEUE},${INGEST_COMMENTS_TASK_QUEUE}` },
    'worker-ingest polling task queues ingest-metrics and ingest-comments',
  );
  const workers = [metrics, comments];
  return {
    run: async () => {
      await Promise.all(workers.map((w) => w.run()));
    },
    shutdown: () => workers.forEach((w) => w.shutdown()),
    close: () => connection.close(),
  };
}
