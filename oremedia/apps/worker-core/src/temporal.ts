import { readFile } from 'node:fs/promises';
import { Client, Connection, type ConnectionOptions } from '@temporalio/client';
import type { WorkflowStarter } from '@oremedia/module-operations';

export interface TemporalConfig {
  address: string;
  namespace: string;
  /** Temporal Cloud API key (TLS implied). */
  apiKey?: string;
  /** mTLS: paths of the PEM files the platform mounts from the secret references (Appendix A). */
  tlsCertPath?: string;
  tlsKeyPath?: string;
  /** Server-side TLS without client certificates (TEMPORAL_TLS=1). */
  tls?: boolean;
}

/** Appendix A names only; values come from the secret manager. Missing address is a startup error, never a default. */
export function temporalConfigFromEnv(env: NodeJS.ProcessEnv = process.env): TemporalConfig {
  const address = env['TEMPORAL_ADDRESS'];
  if (!address) throw new Error('TEMPORAL_ADDRESS is required');
  const cfg: TemporalConfig = { address, namespace: env['TEMPORAL_NAMESPACE'] ?? 'default' };
  if (env['TEMPORAL_API_KEY']) cfg.apiKey = env['TEMPORAL_API_KEY'];
  if (env['TEMPORAL_TLS_CERT_REF']) cfg.tlsCertPath = env['TEMPORAL_TLS_CERT_REF'];
  if (env['TEMPORAL_TLS_KEY_REF']) cfg.tlsKeyPath = env['TEMPORAL_TLS_KEY_REF'];
  if (env['TEMPORAL_TLS'] === '1') cfg.tls = true;
  return cfg;
}

export async function connectTemporal(cfg: TemporalConfig): Promise<Client> {
  const options: ConnectionOptions = { address: cfg.address };
  if (cfg.apiKey) {
    options.apiKey = cfg.apiKey;
    options.tls = true;
  } else if (cfg.tlsCertPath && cfg.tlsKeyPath) {
    options.tls = {
      clientCertPair: { crt: await readFile(cfg.tlsCertPath), key: await readFile(cfg.tlsKeyPath) },
    };
  } else if (cfg.tls) {
    options.tls = true;
  }
  const connection = await Connection.connect(options);
  return new Client({ connection, namespace: cfg.namespace });
}

/**
 * Spec 14.2: a stable workflowId with USE_EXISTING dedupes against a running workflow; ALLOW_DUPLICATE_FAILED_ONLY
 * lets a failed run be retried by a replayed event while a completed one is never restarted. The outbox row remains
 * the dedupe authority.
 */
export class TemporalWorkflowStarter implements WorkflowStarter {
  constructor(private readonly client: Client) {}

  async start(req: Parameters<WorkflowStarter['start']>[0]): Promise<void> {
    await this.client.workflow.start(req.workflowType, {
      taskQueue: req.taskQueue,
      workflowId: req.workflowId,
      args: req.args,
      workflowIdConflictPolicy: 'USE_EXISTING',
      workflowIdReusePolicy: 'ALLOW_DUPLICATE_FAILED_ONLY',
      searchAttributes: {},
      memo: { tenantId: req.tenantId, correlationId: req.correlationId },
    });
  }
}
