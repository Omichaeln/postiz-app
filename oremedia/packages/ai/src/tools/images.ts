import { z } from 'zod';
import { ToolDeniedError } from '../tool-dispatcher';
import type { ToolDefinition } from '../tool-registry';

const GenerateInput = z
  .object({
    prompt: z.string().min(1).max(2000),
    count: z.number().int().min(1).max(4).default(1),
    aspect: z.enum(['1:1', '4:5', '9:16', '16:9']).default('1:1'),
  })
  .strict();

const GenerateOutput = z.object({
  jobId: z.string(),
  images: z.array(
    z.object({ storageKey: z.string(), contentHash: z.string(), width: z.number(), height: z.number() }),
  ),
});

/** Placeholder price per generated image (D-08 price list); consumed from the reservation before the call. */
export const IMAGE_COST_MICROS = 40_000;
const POLL_INTERVAL_MS = 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * images.generate: draft (costed), creative.edit. Generated images are pending assets (provenance generated), never
 * logos. The provider job id is persisted before waiting so a retried activity polls instead of resubmitting.
 * Without IMAGE_GEN_PROVIDER (and a registered generator) the tool denies provider_not_configured: no fake bytes.
 */
export const imagesGenerate: ToolDefinition<z.infer<typeof GenerateInput>, z.infer<typeof GenerateOutput>> = {
  name: 'images.generate',
  description:
    'Generates candidate images from a prompt for use as pending assets. Costed against the run budget. Never generates logos.',
  input: GenerateInput,
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', minLength: 1, maxLength: 2000 },
      count: { type: 'integer', minimum: 1, maximum: 4 },
      aspect: { type: 'string', enum: ['1:1', '4:5', '9:16', '16:9'] },
    },
    required: ['prompt'],
    additionalProperties: false,
  },
  output: GenerateOutput,
  action: 'creative.edit',
  effect: 'draft',
  costKind: 'image_generation',
  costEstimateMicros: (input) => input.count * IMAGE_COST_MICROS,
  availability: ({ services }) => (services.images ? null : 'provider_not_configured'),
  timeoutMs: 180_000,
  async run(input, ctx) {
    const generator = ctx.services.images;
    if (!generator) throw new ToolDeniedError('provider_not_configured');
    const existing = await ctx.providerJobs.find(ctx.run.runId, ctx.run.stepId, imagesGenerate.name);
    let jobId = existing;
    if (!jobId) {
      const submitted = await generator.submit({
        tenantId: ctx.run.tenantId,
        brandId: ctx.run.brandId,
        runId: ctx.run.runId,
        prompt: input.prompt,
        count: input.count,
        aspect: input.aspect,
      });
      jobId = submitted.jobId;
      await ctx.providerJobs.persist(ctx.run.runId, ctx.run.stepId, imagesGenerate.name, jobId); // before waiting
    }
    for (;;) {
      const status = await generator.poll(jobId);
      if (status.status === 'done') return { jobId, images: status.images };
      if (status.status === 'failed')
        throw new ToolDeniedError(`provider_failed:${status.reason}`.slice(0, 80));
      await sleep(POLL_INTERVAL_MS);
    }
  },
};
