import { assetService } from '@oremedia/module-assets';
import { brandService } from '@oremedia/module-brand';
import { creativeService } from '@oremedia/module-creative';

/** Provider job protocol for generated images (spec 12.2 model-call recovery): submit once, then poll by job id. */
export interface ImageGenerator {
  readonly provider: string;
  submit(input: {
    tenantId: string;
    brandId: string;
    runId: string;
    prompt: string;
    count: number;
    aspect: string;
  }): Promise<{ jobId: string }>;
  poll(jobId: string): Promise<
    | { status: 'pending' }
    | { status: 'failed'; reason: string }
    | {
        status: 'done';
        images: Array<{ storageKey: string; contentHash: string; width: number; height: number }>;
      }
  >;
}

/** The module surfaces tools reach: narrow picks so a tool cannot wander into unrelated commands. */
export interface ToolServices {
  brand: Pick<typeof brandService, 'resolveBrandSnapshot'>;
  assets: Pick<typeof assetService, 'findEligibleAssets'>;
  creative: {
    operations: Pick<typeof creativeService.operations, 'propose' | 'apply'>;
    renders: Pick<typeof creativeService.renders, 'request'>;
    revisions: Pick<typeof creativeService.revisions, 'get'>;
  };
  /** null until IMAGE_GEN_PROVIDER names a registered generator: images.generate then denies provider_not_configured. */
  images: ImageGenerator | null;
}

const generators = new Map<string, ImageGenerator>();
/** Providers register here (none ships in Release 1; there are no fake image bytes). */
export const registerImageGenerator = (g: ImageGenerator): void => {
  generators.set(g.provider, g);
};
export function imageGeneratorFromEnv(env: NodeJS.ProcessEnv = process.env): ImageGenerator | null {
  const provider = env['IMAGE_GEN_PROVIDER'];
  return provider ? (generators.get(provider) ?? null) : null;
}

export function defaultToolServices(env: NodeJS.ProcessEnv = process.env): ToolServices {
  return {
    brand: brandService,
    assets: assetService,
    creative: {
      operations: creativeService.operations,
      renders: creativeService.renders,
      revisions: creativeService.revisions,
    },
    images: imageGeneratorFromEnv(env),
  };
}
