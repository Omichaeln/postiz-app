/**
 * Spec 12.2 model-call recovery: when a generation provider returns a job id (images, video) it is persisted before
 * the activity waits; a retried activity polls that job instead of submitting again. The store is keyed by run and
 * step so a retry of the same activity attempt finds its own job.
 */
export interface ProviderJobStore {
  persist(runId: string, stepId: string, toolName: string, jobId: string): Promise<void>;
  find(runId: string, stepId: string, toolName: string): Promise<string | null>;
}

const key = (runId: string, stepId: string, toolName: string) => `${runId}:${stepId}:${toolName}`;

/**
 * In-process store: survives activity retries on the same worker. A durable store (a table or Redis) registers
 * through registerProviderJobStore when the image provider arrives; only images.generate uses it in Release 1.
 */
export class MemoryProviderJobStore implements ProviderJobStore {
  private readonly jobs = new Map<string, string>();
  async persist(runId: string, stepId: string, toolName: string, jobId: string): Promise<void> {
    this.jobs.set(key(runId, stepId, toolName), jobId);
  }
  async find(runId: string, stepId: string, toolName: string): Promise<string | null> {
    return this.jobs.get(key(runId, stepId, toolName)) ?? null;
  }
}

let store: ProviderJobStore = new MemoryProviderJobStore();
export const registerProviderJobStore = (s: ProviderJobStore): void => {
  store = s;
};
export const providerJobs = (): ProviderJobStore => store;
