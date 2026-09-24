import { z } from 'zod';
import { BrandSnapshotV1, FactKind } from '@oremedia/contracts/brand';
import type { ToolDefinition } from '../tool-registry';

const FactRef = z.object({
  id: z.string(),
  kind: FactKind,
  statement: z.string(),
  validFrom: z.string().datetime().nullable(),
  validUntil: z.string().datetime().nullable(),
});

const GetSnapshotInput = z.object({}).strict();
const FactsListInput = z.object({ kind: FactKind.optional() }).strict();

/** brand.getSnapshot: read, brand.read. The pinned snapshot of the run (the same bundle the resolver hashed). */
export const brandGetSnapshot: ToolDefinition<
  z.infer<typeof GetSnapshotInput>,
  z.infer<typeof BrandSnapshotV1>
> = {
  name: 'brand.getSnapshot',
  description:
    'Returns the approved brand system for this run: voice, tokens, logo rules, approved facts, objectives and policy.',
  input: GetSnapshotInput,
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  output: BrandSnapshotV1,
  action: 'brand.read',
  effect: 'read',
  async run(_input, ctx) {
    if (ctx.snapshot) return ctx.snapshot.brand;
    return ctx.services.brand.resolveBrandSnapshot(ctx.actor, { brandId: ctx.run.brandId }, ctx.tx);
  },
};

/** facts.list: read, brand.read. Approved facts effective now, optionally by kind; claims must cite these ids. */
export const factsList: ToolDefinition<
  z.infer<typeof FactsListInput>,
  { facts: z.infer<typeof FactRef>[] }
> = {
  name: 'facts.list',
  description:
    'Lists the approved facts (products, claims, offers, prices, legal) the copy may state, by id.',
  input: FactsListInput,
  inputSchema: {
    type: 'object',
    properties: { kind: { type: 'string', enum: FactKind.options } },
    additionalProperties: false,
  },
  output: z.object({ facts: z.array(FactRef) }),
  action: 'brand.read',
  effect: 'read',
  async run(input, ctx) {
    const brand =
      ctx.snapshot?.brand ??
      (await ctx.services.brand.resolveBrandSnapshot(ctx.actor, { brandId: ctx.run.brandId }, ctx.tx));
    return { facts: brand.facts.filter((f) => !input.kind || f.kind === input.kind) };
  },
};
