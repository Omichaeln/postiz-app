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
import { createAgentRunActivities, createSkillEvaluationActivities } from '@oremedia/activities';
import { createModelAdapterFromEnv, createReleaseOneRegistry, modelConfigFromEnv } from '@oremedia/ai';
import { AGENTS_TASK_QUEUE, createAgentRunRuntime } from '@oremedia/module-agents';
import { logger } from '@oremedia/observability';
import { skillEvaluationStore } from './skills-store';
import type { TemporalConfig } from './temporal';

/**
 * Spec 4.4: worker-core hosts task queue `agents` (agentRunWorkflowV1, its signal relay and skillEvaluationWorkflowV1). Workflow code is
 * pre-bundled at build time (tsup.config.ts → dist/workflows.agents.js) because production images carry no
 * sources; outside production the queue entry is bundled at start. The model adapter comes from the environment:
 * ANTHROPIC_API_KEY_REF, or the scripted fake outside production (OREMEDIA_FAKE_MODEL=1); nothing else.
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

/** Temporal Cloud: mTLS client certificate files or an API key; self-hosted: plain address (Appendix A). */
async function connectionOptions(cfg: TemporalConfig): Promise<NativeConnectionOptions> {
  const options: NativeConnectionOptions = { address: cfg.address };
  if (cfg.tlsCertPath && cfg.tlsKeyPath)
    options.tls = {
      clientCertPair: { crt: await readFile(cfg.tlsCertPath), key: await readFile(cfg.tlsKeyPath) },
    };
  else if (cfg.apiKey) options.tls = true;
  if (cfg.apiKey) options.apiKey = cfg.apiKey;
  return options;
}

export interface AgentsWorkerHandle {
  run(): Promise<void>;
  shutdown(): void;
  close(): Promise<void>;
}

export async function startAgentsWorker(
  cfg: TemporalConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AgentsWorkerHandle> {
  const production = (env['NODE_ENV'] ?? 'development') === 'production';
  const adapter = createModelAdapterFromEnv(env); // loud when no model is configured
  const runtime = createAgentRunRuntime({
    adapter,
    modelConfig: modelConfigFromEnv(env),
    registry: createReleaseOneRegistry(),
  });
  const connection = await NativeConnection.connect(await connectionOptions(cfg));
  const worker = await Worker.create({
    connection,
    namespace: cfg.namespace,
    taskQueue: AGENTS_TASK_QUEUE,
    ...workflowsFor(AGENTS_TASK_QUEUE, production),
    activities: {
      ...createAgentRunActivities(runtime),
      ...createSkillEvaluationActivities({ store: skillEvaluationStore() }),
    },
    maxConcurrentActivityTaskExecutions: Number(env['AGENTS_CONCURRENCY'] ?? 8),
  });
  logger().info({ status: adapter.provider }, 'worker-core polling task queue agents');
  return {
    run: () => worker.run(),
    shutdown: () => worker.shutdown(),
    close: () => connection.close(),
  };
}
