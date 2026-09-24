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

/** A hook-backed tool whose module has not registered its source at composition denies with this reason. */
export const NOT_AVAILABLE_YET = 'tool_not_available_yet';

/** What every hook-backed write receives about the run: its brand, its id (recorded on the object) and its mode. */
export interface ToolRunRef {
  brandId: string;
  runId: string;
  autonomyMode: AutonomyMode;
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

/**
 * Spec 12.4 content.createBrief / content.draftCopy (effect draft): the content module registers this source. Every
 * object is created as the run's service principal under the run's autonomy mode and records the run id; ids of
 * another brand or tenant are NOT_FOUND. Absent, both tools deny with tool_not_available_yet.
 */
export interface ContentToolSource {
  createBrief(
    actor: ResolvedActorServicePrincipal,
    input: ToolRunRef & {
      campaignId?: string;
      audience: string;
      message: string;
      offerFactIds: string[];
      channelConnectionIds: string[];
      constraints: string[];
    },
    tx: Tx,
  ): Promise<{ briefId: string }>;
  /** Each variant becomes a draft content package (revision 1) under the brief; nothing is reviewed or published. */
  draftCopy(
    actor: ResolvedActorServicePrincipal,
    input: ToolRunRef & {
      briefId: string;
      variants: Array<{ text: string; factIds: string[]; rationale: string }>;
    },
    tx: Tx,
  ): Promise<{ drafts: Array<{ contentPackageId: string; contentRevisionId: string; contentHash: string }> }>;
}

/**
 * Spec 12.4 review.request (effect propose): the review module registers this source. It opens a review request on
 * the revision (manifest frozen, revision in_review) for a person with review.decide to decide.
 */
export interface ReviewToolSource {
  requestReview(
    actor: ResolvedActorServicePrincipal,
    input: ToolRunRef & {
      contentRevisionId: string;
      assigneeUserIds: string[];
      dueAt?: string;
      timing: { kind: 'exact'; at: string } | { kind: 'window'; from: string; to: string };
    },
    tx: Tx,
  ): Promise<{ reviewRequestId: string; manifestHash: string }>;
}

/**
 * Spec 12.4 publications.proposeSchedule (effect propose): the publishing module registers this source. It checks a
 * proposed slot (the revision and channels of the run's brand, a variant per channel, publication.schedule per
 * channel) and returns the publications.schedule commands a person completes; it never writes and never schedules.
 */
export interface PublishingToolSource {
  proposeSchedule(
    actor: ResolvedActorServicePrincipal,
    input: ToolRunRef & { contentRevisionId: string; channelConnectionIds: string[]; proposedAt: string },
    tx: Tx,
  ): Promise<{
    entries: Array<{ channelConnectionId: string; channelVariantId: string; scheduledFor: string }>;
  }>;
}

let contentSource: ContentToolSource | null = null;
export const registerContentToolSource = (source: ContentToolSource | null): void => {
  contentSource = source;
};
let reviewSource: ReviewToolSource | null = null;
export const registerReviewToolSource = (source: ReviewToolSource | null): void => {
  reviewSource = source;
};
let publishingSource: PublishingToolSource | null = null;
export const registerPublishingToolSource = (source: PublishingToolSource | null): void => {
  publishingSource = source;
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
  /** null until the content, review and publishing modules register their sources (composition roots). */
  content: ContentToolSource | null;
  review: ReviewToolSource | null;
  publishing: PublishingToolSource | null;
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
    get content() {
      return contentSource;
    },
    get review() {
      return reviewSource;
    },
    get publishing() {
      return publishingSource;
    },
  };
}
