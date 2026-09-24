import type { ResolvedActorServicePrincipal } from '@oremedia/contracts/policy';
import type { AutonomyMode } from '@oremedia/contracts/tenancy';
import type { Tx } from '@oremedia/db';
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

/**
 * Spec 12.4 metrics.query / voice.clusters / recommendations.create / experiments.proposeDesign: the intelligence
 * module registers this source (composition root); the tool code stays generic and never names that module.
 * Absent, the four tools deny with tool_not_available_yet.
 */
export interface IntelligenceToolSource {
  metricsQuery(
    actor: ResolvedActorServicePrincipal,
    input: {
      brandId: string;
      metricKeys: string[];
      from: string;
      to: string;
      channelConnectionIds: string[];
    },
    tx: Tx,
  ): Promise<{
    series: Array<{
      metricKey: string;
      points: Array<{ at: string; value: number | null; complete: boolean }>;
    }>;
  }>;
  voiceClusters(
    actor: ResolvedActorServicePrincipal,
    input: { brandId: string; limit: number },
    tx: Tx,
  ): Promise<{
    clusters: Array<{ id: string; label: string; size: number; examples: string[] }>;
  }>;
  recommendationsCreate(
    actor: ResolvedActorServicePrincipal,
    input: {
      brandId: string;
      runId: string;
      title: string;
      rationale: string;
      evidenceRefs: string[];
      suggestedAction: 'brief' | 'variant' | 'experiment' | 'playbook_entry';
    },
    tx: Tx,
  ): Promise<{ recommendationId: string }>;
  experimentsProposeDesign(
    actor: ResolvedActorServicePrincipal,
    input: {
      brandId: string;
      runId: string;
      autonomyMode: AutonomyMode;
      recommendationId?: string;
      hypothesis: string;
      primaryMetricKey: string;
      variants: Array<{ key: string; description: string }>;
    },
    tx: Tx,
  ): Promise<{ experimentId: string }>;
}

let intelligenceSource: IntelligenceToolSource | null = null;
export const registerIntelligenceToolSource = (source: IntelligenceToolSource | null): void => {
  intelligenceSource = source;
};

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
  /** null until the intelligence module registers (Phase 6): its tools then deny tool_not_available_yet. */
  intelligence: IntelligenceToolSource | null;
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
    // A getter: the source registers at composition, after runtimes that captured these services were built.
    get intelligence() {
      return intelligenceSource;
    },
  };
}
