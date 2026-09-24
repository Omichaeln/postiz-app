import { z } from 'zod';
import { createReleaseOneRegistry, type ToolDefinition, type ToolRegistry } from '@oremedia/ai';
import type { ApiScope } from '@oremedia/contracts/access';
import { NotFoundError } from '@oremedia/contracts/errors';
import { InsightKind } from '@oremedia/contracts/intelligence';
import { AutonomyMode } from '@oremedia/contracts/tenancy';
import { agentsService } from '@oremedia/module-agents';
import { brandService } from '@oremedia/module-brand';
import { intelligenceService } from '@oremedia/module-intelligence';
import { publicationService } from '@oremedia/module-publishing';

/**
 * Spec 7.6 MCP tool subset: list brands, search eligible assets, create brief, start run, propose design operations,
 * request review, read publication state, read insights. Four of them are Release 1 registry tools (spec 12.4); the
 * other four are read/start surfaces the registry does not carry, defined here as ordinary ToolDefinitions so they
 * pass through the same dispatcher (policy, audit, budget, timeout, output parsing) as every agent tool. None has
 * an external effect and none schedules: scheduling exists only as publications.schedule with an approval or a
 * mandate (spec 13.4, Postiz R2), which MCP does not expose.
 */

const BrandSummary = z
  .object({ id: z.string(), name: z.string(), timezone: z.string(), defaultLocale: z.string() })
  .passthrough();

/** brands.list: read, brand.read on the tenant. The brands the key's service principal is granted. */
export const mcpBrandsList: ToolDefinition<
  Record<string, never>,
  { items: z.infer<typeof BrandSummary>[] }
> = {
  name: 'brands.list',
  description: 'Lists the brands this API client may act on (id, name, timezone, default locale).',
  input: z.object({}).strict() as z.ZodType<Record<string, never>, z.ZodTypeDef, unknown>,
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  output: z.object({ items: z.array(BrandSummary) }),
  action: 'brand.read',
  effect: 'read',
  resource: (_input, run) => ({ type: 'tenant', tenantId: run.tenantId, id: run.tenantId }),
  async run(_input, ctx) {
    return { items: await brandService.list(ctx.actor, ctx.tx) };
  },
};

const StartRunInput = z
  .object({
    taskKind: z.string().min(1).max(60),
    brief: z.record(z.unknown()),
    requestedAutonomy: AutonomyMode.optional(),
  })
  .strict();

/**
 * agents.startRun: draft, agent.start_run. Starts a run of the calling service principal in the brand through the
 * outbox (spec 12.2); the run's autonomy is min(requested, principal, tenant, entitlement) as for any run.
 */
export const mcpAgentsStartRun: ToolDefinition<
  z.infer<typeof StartRunInput>,
  { runId: string; state: string; autonomyMode: string }
> = {
  name: 'agents.startRun',
  description:
    'Starts an agent run for this brand (task kind and brief). Returns the run id; read progress with the product or the REST API.',
  input: StartRunInput,
  inputSchema: {
    type: 'object',
    properties: {
      taskKind: { type: 'string', maxLength: 60 },
      brief: { type: 'object' },
      requestedAutonomy: { type: 'string', enum: AutonomyMode.options },
    },
    required: ['taskKind', 'brief'],
    additionalProperties: false,
  },
  output: z.object({ runId: z.string(), state: z.string(), autonomyMode: z.string() }).passthrough(),
  action: 'agent.start_run',
  effect: 'draft',
  async run(input, ctx) {
    return agentsService.runs.start(
      ctx.actor,
      {
        brandId: ctx.run.brandId,
        servicePrincipalId: ctx.actor.id,
        requestedAutonomy: input.requestedAutonomy ?? ctx.run.policy.autonomyMode,
        taskKind: input.taskKind,
        brief: input.brief,
      },
      ctx.tx,
      { autonomyMode: ctx.run.policy.autonomyMode },
    );
  },
};

const PublicationGetInput = z.object({ publicationId: z.string().max(32) }).strict();

/** publications.get: read, brand.read. A publication of this brand with its attempts; another brand's is NOT_FOUND. */
export const mcpPublicationsGet: ToolDefinition<
  z.infer<typeof PublicationGetInput>,
  { id: string; brandId: string; state: string }
> = {
  name: 'publications.get',
  description: 'Reads the state of a publication of this brand (schedule, state, attempts, remote URL).',
  input: PublicationGetInput,
  inputSchema: {
    type: 'object',
    properties: { publicationId: { type: 'string', maxLength: 32 } },
    required: ['publicationId'],
    additionalProperties: false,
  },
  output: z.object({ id: z.string(), brandId: z.string(), state: z.string() }).passthrough(),
  action: 'brand.read',
  effect: 'read',
  async run(input, ctx) {
    const publication = await publicationService.get(ctx.actor, input, ctx.tx);
    if (publication.brandId !== ctx.run.brandId) throw new NotFoundError('Publication', input.publicationId);
    return publication;
  },
};

const InsightsListInput = z
  .object({
    kind: InsightKind.optional(),
    limit: z.number().int().min(1).max(50).default(20),
    cursor: z.string().max(512).optional(),
  })
  .strict();

/** insights.list: read, insight.read. Active insights of this brand, newest first. */
export const mcpInsightsList: ToolDefinition<
  z.infer<typeof InsightsListInput>,
  { items: Record<string, unknown>[]; nextCursor: string | null }
> = {
  name: 'insights.list',
  description: 'Lists the active insights of this brand (what changed, anomalies, associations, findings).',
  input: InsightsListInput,
  inputSchema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: InsightKind.options },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
      cursor: { type: 'string', maxLength: 512 },
    },
    additionalProperties: false,
  },
  output: z.object({ items: z.array(z.record(z.unknown())), nextCursor: z.string().nullable() }),
  action: 'insight.read',
  effect: 'read',
  async run(input, ctx) {
    return intelligenceService.insights.list(
      ctx.actor,
      {
        brandId: ctx.run.brandId,
        state: 'active',
        ...(input.kind ? { kind: input.kind } : {}),
        page: { limit: input.limit, ...(input.cursor ? { cursor: input.cursor } : {}) },
      },
      ctx.tx,
    );
  },
};

export interface McpToolExposure {
  name: string;
  /** The per-key scope a call needs (spec 7.6), from the same vocabulary as REST. */
  scope: ApiScope;
  /** Brand-scoped tools take a `brandId` argument: the brand the call acts in, like an agent run's brand. */
  brandScoped: boolean;
}

/** The curated subset, in the order of spec 7.6. Nothing else in the registry is callable over MCP. */
export const MCP_TOOLS: readonly McpToolExposure[] = [
  { name: 'brands.list', scope: 'brands:read', brandScoped: false },
  { name: 'assets.searchEligible', scope: 'assets:read', brandScoped: true },
  { name: 'content.createBrief', scope: 'content:write', brandScoped: true },
  { name: 'agents.startRun', scope: 'agents:write', brandScoped: true },
  { name: 'creative.proposeOperations', scope: 'creative:write', brandScoped: true },
  { name: 'review.request', scope: 'review:write', brandScoped: true },
  { name: 'publications.get', scope: 'publications:read', brandScoped: true },
  { name: 'insights.list', scope: 'insights:read', brandScoped: true },
];

/**
 * The MCP registry: the whole Release 1 registry plus the surface tools. Every name is known to the dispatcher, so a
 * call to a registered tool outside MCP_TOOLS (images.generate, publications.proposeSchedule, ...) is denied as
 * tool_not_allowed and audited, exactly as for an agent whose allowlist lacks it.
 */
export function createMcpRegistry(): ToolRegistry {
  return createReleaseOneRegistry()
    .register(mcpBrandsList)
    .register(mcpAgentsStartRun)
    .register(mcpPublicationsGet)
    .register(mcpInsightsList);
}
