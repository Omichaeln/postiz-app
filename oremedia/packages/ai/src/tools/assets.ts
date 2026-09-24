import { z } from 'zod';
import { AssetKind, AssetPurpose } from '@oremedia/contracts/assets';
import type { ToolDefinition } from '../tool-registry';

const SearchInput = z
  .object({
    purpose: AssetPurpose.default('creative'),
    kinds: z.array(AssetKind).max(9).optional(),
    query: z.string().max(200).optional(),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict();

const AssetRefSchema = z.object({
  assetId: z.string(),
  assetVersionId: z.string(),
  kind: AssetKind,
  semanticRole: z.string().nullable(),
  altText: z.string().nullable(),
  contentHash: z.string(),
  width: z.number().nullable(),
  height: z.number().nullable(),
});

/** assets.searchEligible: read, asset.read. Eligibility (spec 9.2) is applied before anything is returned. */
export const assetsSearchEligible: ToolDefinition<
  z.infer<typeof SearchInput>,
  { items: z.infer<typeof AssetRefSchema>[] }
> = {
  name: 'assets.searchEligible',
  description:
    'Searches approved, rights-cleared assets of this brand that are eligible for the purpose. Only returned asset version ids may be used.',
  input: SearchInput,
  inputSchema: {
    type: 'object',
    properties: {
      purpose: { type: 'string', enum: AssetPurpose.options },
      kinds: { type: 'array', items: { type: 'string', enum: AssetKind.options } },
      query: { type: 'string', maxLength: 200 },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
    },
    additionalProperties: false,
  },
  output: z.object({ items: z.array(AssetRefSchema) }),
  action: 'asset.read',
  effect: 'read',
  async run(input, ctx) {
    const page = await ctx.services.assets.findEligibleAssets(
      {
        brandId: ctx.run.brandId,
        purpose: input.purpose,
        channelConnectionIds: [],
        ...(input.kinds ? { kinds: input.kinds } : {}),
        ...(input.query ? { query: input.query } : {}),
      },
      { limit: input.limit },
      ctx.tx,
    );
    return { items: page.items };
  },
};
