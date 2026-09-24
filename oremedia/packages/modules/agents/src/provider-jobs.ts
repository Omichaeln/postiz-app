import type { ProviderJobStore } from '@oremedia/ai';
import { newId } from '@oremedia/domain/ids';
import { ProviderJobRepository } from './repositories';

const jobs = new ProviderJobRepository();

/**
 * Spec 12.2 model-call recovery, durably: the provider_jobs table behind the ProviderJobStore hook, registered by
 * every process that dispatches agent tools (registerProviderJobStore at the composition root). Each call commits
 * on its own connection, never in the tool's unit of work: a tool that times out rolls its transaction back, and
 * the accepted job id must survive that, a worker restart and a retry on another worker.
 */
export function durableProviderJobStore(): ProviderJobStore {
  return {
    async persist(key, job) {
      await jobs.createIfAbsent({
        id: newId('providerJob'),
        brandId: job.brandId,
        runId: key.runId,
        stepId: key.stepId,
        toolName: key.toolName,
        toolCallId: key.toolCallId,
        provider: job.provider,
        providerJobId: job.providerJobId,
        status: 'submitted',
      });
    },
    async find(key) {
      return (await jobs.findForCall(key))?.providerJobId ?? null;
    },
    async finish(key, status) {
      const row = await jobs.findForCall(key);
      if (!row || row.status === status) return;
      await jobs.update(row.id, row.version, { status });
    },
  };
}
