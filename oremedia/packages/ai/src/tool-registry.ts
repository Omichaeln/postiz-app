import type { z } from 'zod';
import type { ToolEffect, ToolSchema } from '@oremedia/contracts/agents';
import type { Action, PolicyResource, ResolvedActorServicePrincipal } from '@oremedia/contracts/policy';
import type { UsageKind } from '@oremedia/contracts/billing';
import type { Tx } from '@oremedia/db';
import type { ContextSnapshot } from './context-resolver';
import type { ProviderJobStore } from './provider-jobs';
import type { ToolServices } from './tools/services';
import type { AgentRunContext } from './tool-dispatcher';

/** What a tool receives besides its parsed input: the run, the principal, the pinned context and the services. */
export interface ToolContext {
  run: AgentRunContext;
  actor: ResolvedActorServicePrincipal;
  snapshot: ContextSnapshot | null;
  services: ToolServices;
  providerJobs: ProviderJobStore;
  tx: Tx;
  now: () => Date;
}

/** A tool returns this instead of an output when a person must decide (spec 12.4 proposal_requires_user). */
export class ProposalRequest {
  constructor(
    readonly proposalRef: string,
    readonly payload: Record<string, unknown>,
  ) {}
}

/** Spec 12.4 ToolDefinition, plus the JSON Schema the model is shown and the hooks the dispatcher needs. */
export interface ToolDefinition<I, O> {
  name: string;
  description: string;
  input: z.ZodType<I, z.ZodTypeDef, unknown>;
  /** JSON Schema of `input` as the model sees it (written by hand next to the Zod schema: no codegen dependency). */
  inputSchema: Record<string, unknown>;
  output: z.ZodType<O, z.ZodTypeDef, unknown>;
  action: Action; // policy action checked for the service principal
  effect: ToolEffect; // 'external' tools do not exist for agents except via release command
  costEstimateMicros?: (input: I) => number;
  costKind?: z.infer<typeof UsageKind>;
  /** The policy resource of a call; defaults to the run's brand. */
  resource?: (input: I, run: AgentRunContext) => PolicyResource;
  /** A denial reason when the tool cannot run in this deployment or phase (checked after policy, before spend). */
  availability?: (ctx: Pick<ToolContext, 'services' | 'run'>) => string | null;
  timeoutMs?: number;
  run(input: I, ctx: ToolContext): Promise<O | ProposalRequest>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolDefinition = ToolDefinition<any, any>;

/** The registry is the closed list of what an agent can ever call; nothing outside it exists for the model. */
export class ToolRegistry {
  private readonly tools = new Map<string, AnyToolDefinition>();

  register<I, O>(def: ToolDefinition<I, O>): this {
    if (def.effect === 'external')
      throw new Error(`tool ${def.name} has effect external: no agent tool publishes (spec 12.4)`);
    if (this.tools.has(def.name)) throw new Error(`tool ${def.name} registered twice`);
    this.tools.set(def.name, def as AnyToolDefinition);
    return this;
  }
  get(name: string): AnyToolDefinition | undefined {
    return this.tools.get(name);
  }
  has(name: string): boolean {
    return this.tools.has(name);
  }
  names(): string[] {
    return [...this.tools.keys()].sort();
  }
  /** Schemas for the model: only the run's allowed tools, in registry order (stable for prompt caching). */
  schemasFor(allowed: readonly string[]): ToolSchema[] {
    const set = new Set(allowed);
    return this.names()
      .filter((n) => set.has(n))
      .map((n) => {
        const def = this.tools.get(n) as AnyToolDefinition;
        return { name: def.name, description: def.description, inputSchema: def.inputSchema };
      });
  }
}
