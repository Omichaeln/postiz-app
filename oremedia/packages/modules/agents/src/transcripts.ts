import type { ModelMessage } from '@oremedia/contracts/agents';

/**
 * The conversation of a run between activities (spec 12.2: the model loop is bounded inside activities, Temporal
 * owns the durable waits). Tool inputs, outcomes and costs are the durable record (agent_steps, tool_invocations);
 * the verbatim transcript is working state. The default store is per worker process; a worker restart rebuilds a
 * summary from the recorded steps (see runtime.ts). A shared store (Redis) registers here when one is deployed.
 */
export interface TranscriptStore {
  get(runId: string): Promise<ModelMessage[] | null>;
  set(runId: string, messages: ModelMessage[]): Promise<void>;
  delete(runId: string): Promise<void>;
}

export class MemoryTranscriptStore implements TranscriptStore {
  private readonly transcripts = new Map<string, ModelMessage[]>();
  async get(runId: string): Promise<ModelMessage[] | null> {
    const t = this.transcripts.get(runId);
    return t ? structuredClone(t) : null;
  }
  async set(runId: string, messages: ModelMessage[]): Promise<void> {
    this.transcripts.set(runId, structuredClone(messages));
  }
  async delete(runId: string): Promise<void> {
    this.transcripts.delete(runId);
  }
}

let store: TranscriptStore = new MemoryTranscriptStore();
export const registerTranscriptStore = (s: TranscriptStore): void => {
  store = s;
};
export const transcripts = (): TranscriptStore => store;
