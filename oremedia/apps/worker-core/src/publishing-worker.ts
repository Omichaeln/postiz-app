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
import type { Client } from '@temporalio/client';
import {
  createBrandChangeImpactActivities,
  createPublicationSweepActivities,
  createPublishControlActivities,
  createPublishProviderActivities,
  createTokenRefreshActivities,
} from '@oremedia/activities';
import {
  CORE_TASK_QUEUE,
  PUBLICATION_SWEEPER_WORKFLOW_ID,
  PUBLICATION_SWEEPER_WORKFLOW_TYPE,
  configureCredentialBroker,
  createKmsFromEnv,
  createPublishingRuntime,
  publishTaskQueue,
  type WorkflowProbe,
} from '@oremedia/module-publishing';
import { logger } from '@oremedia/observability';
import { providerRegistry } from '@oremedia/providers';
import { createBrandChangeImpactRuntime } from './brand-change-runtime';
import { intelligenceActivities } from './intelligence-worker';
import type { TemporalConfig } from './temporal';

/**
 * Spec 4.4: worker-core hosts task queue `core` (publicationWorkflowV1, its reconcile and signal relay, the
 * sweeper, tokenRefreshWorkflowV1 and brandChangeImpactWorkflowV1) and one activity-only `publish-<providerKey>` queue per registered provider,
 * so a slow or rate-limited platform cannot starve the others. This is the only process (with worker-ingest)
 * whose KMS may decrypt: the credential broker is composed here with a decrypting key (spec 14.7). Workflow code
 * is pre-bundled at build time (tsup.config.ts → dist/workflows.core.js), as the agents queue is.
 */
const here = dirname(fileURLToPath(import.meta.url));

function workflowsFor(
  queue: string,
  production: boolean,
): Pick<WorkerOptions, 'workflowBundle' | 'workflowsPath'> {
  const codePath = join(here, `workflows.${queue}.js`);
  if (existsSync(codePath)) return { workflowBundle: { codePath } };
  if (production)
    throw new Error(
      `workflow bundle ${codePath} is missing: build the worker (pnpm --filter @oremedia/worker-core build)`,
    );
  return { workflowsPath: createRequire(import.meta.url).resolve(`@oremedia/workflows/queues/${queue}`) };
}

async function connectionOptions(cfg: TemporalConfig): Promise<NativeConnectionOptions> {
  const options: NativeConnectionOptions = { address: cfg.address };
  if (cfg.tlsCertPath && cfg.tlsKeyPath)
    options.tls = {
      clientCertPair: { crt: await readFile(cfg.tlsCertPath), key: await readFile(cfg.tlsKeyPath) },
    };
  else if (cfg.apiKey || cfg.tls) options.tls = true;
  if (cfg.apiKey) options.apiKey = cfg.apiKey;
  return options;
}

export interface PublishingWorkersHandle {
  run(): Promise<void>;
  shutdown(): void;
  close(): Promise<void>;
}

export async function startPublishingWorkers(
  cfg: TemporalConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PublishingWorkersHandle> {
  const production = (env['NODE_ENV'] ?? 'development') === 'production';
  configureCredentialBroker({ kms: createKmsFromEnv({ decrypt: true }, env) }); // loud without a key
  const runtime = createPublishingRuntime();
  const connection = await NativeConnection.connect(await connectionOptions(cfg));
  const core = await Worker.create({
    connection,
    namespace: cfg.namespace,
    taskQueue: CORE_TASK_QUEUE,
    ...workflowsFor(CORE_TASK_QUEUE, production),
    activities: {
      ...createPublishControlActivities(runtime.control),
      ...createTokenRefreshActivities(runtime.tokenRefresh),
      ...createPublicationSweepActivities(runtime.sweep),
      // brand.version_published / brand.fact_revoked → brandChangeImpactWorkflowV1 (spec 8.2)
      ...createBrandChangeImpactActivities(createBrandChangeImpactRuntime()),
      // brandAnalystWorkflowV1 / brandAnalystSweepWorkflowV1 / baselineComparisonWorkflowV1 (spec 16.3, 16.8)
      ...intelligenceActivities(),
    },
    maxConcurrentActivityTaskExecutions: Number(env['CORE_CONCURRENCY'] ?? 16),
  });
  // One activity-only worker per certified provider; the per-queue cap is the fairness bound (spec 17.4).
  const providers = providerRegistry.list().filter((p) => p.certified);
  const publishWorkers = await Promise.all(
    providers.map((p) =>
      Worker.create({
        connection,
        namespace: cfg.namespace,
        taskQueue: publishTaskQueue(p.key),
        activities: createPublishProviderActivities(runtime.provider),
        maxConcurrentActivityTaskExecutions: Number(env['PUBLISH_CONCURRENCY'] ?? 4),
      }),
    ),
  );
  logger().info(
    { status: providers.map((p) => p.key).join(',') || 'none' },
    'worker-core polling task queue core and publish-<provider> queues',
  );
  const workers = [core, ...publishWorkers];
  return {
    run: async () => {
      await Promise.all(workers.map((w) => w.run()));
    },
    shutdown: () => workers.forEach((w) => w.shutdown()),
    close: () => connection.close(),
  };
}

/** The always-on sweeper: one execution per namespace, joined if it already runs (USE_EXISTING). */
export async function ensureSweeperRunning(client: Client): Promise<void> {
  await client.workflow.start(PUBLICATION_SWEEPER_WORKFLOW_TYPE, {
    taskQueue: CORE_TASK_QUEUE,
    workflowId: PUBLICATION_SWEEPER_WORKFLOW_ID,
    args: [{}],
    workflowIdConflictPolicy: 'USE_EXISTING',
    workflowIdReusePolicy: 'ALLOW_DUPLICATE',
  });
}

/** The sweeper's probe: is a workflow execution running right now? (unknown id → false). */
export class TemporalWorkflowProbe implements WorkflowProbe {
  constructor(private readonly client: Client) {}
  async isRunning(workflowId: string): Promise<boolean> {
    try {
      const d = await this.client.workflow.getHandle(workflowId).describe();
      return d.status.name === 'RUNNING';
    } catch {
      return false;
    }
  }
}
