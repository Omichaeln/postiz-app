import type { ClientConfig } from '@oremedia/contracts/providers';
import type { ChannelVariantForPublishing, PublicationForRelease } from '@oremedia/contracts/publishing';
import type { ReleaseDecision } from '@oremedia/contracts/review';
import type { Tx } from '@oremedia/db';
import type { PublishMedia } from '@oremedia/providers';

/**
 * Cross-module hooks (same pattern as registerAssetAuthoriser in the creative module: modules never import each
 * other's tables). The composition root wires the content module's `contentService.variants.get`, the review
 * module's `reviewService.evaluateRelease` / `approvals.consume` and the assets module's release-URL minting; until then the defaults
 * are loud so a composition mistake cannot pass silently.
 */

/** Spec 14.1 `variants.getById`: the content module registers `contentService.variants.get`. */
export type VariantSource = (variantId: string, tx?: Tx) => Promise<ChannelVariantForPublishing>;
const unregisteredVariantSource: VariantSource = async () => {
  throw new Error('variant source not registered (composition root must call registerVariantSource)');
};
let variantSource: VariantSource = unregisteredVariantSource;
export const registerVariantSource = (fn: VariantSource): void => {
  variantSource = fn;
};
export const resetVariantSource = (): void => {
  variantSource = unregisteredVariantSource;
};
export const variants = { get: (variantId: string, tx?: Tx) => variantSource(variantId, tx) };

/**
 * Spec 12.4 publications.proposeSchedule: a content revision (tenant-scoped; a foreign id is NOT_FOUND) with its
 * channel variants. The content module registers `contentService.revisions.withVariants`.
 */
export interface RevisionWithVariants {
  id: string;
  brandId: string;
  state: string;
  variants: Array<{ id: string; channelConnectionId: string }>;
}
export type RevisionVariantSource = (contentRevisionId: string, tx?: Tx) => Promise<RevisionWithVariants>;
const unregisteredRevisionVariantSource: RevisionVariantSource = async () => {
  throw new Error(
    'revision variant source not registered (composition root must call registerRevisionVariantSource)',
  );
};
let revisionVariantSource: RevisionVariantSource = unregisteredRevisionVariantSource;
export const registerRevisionVariantSource = (fn: RevisionVariantSource): void => {
  revisionVariantSource = fn;
};
export const resetRevisionVariantSource = (): void => {
  revisionVariantSource = unregisteredRevisionVariantSource;
};
export const revisions = {
  withVariants: (contentRevisionId: string, tx?: Tx) => revisionVariantSource(contentRevisionId, tx),
};

/** Spec 13.4 `review.evaluateRelease(pub, at)`: the review module registers `reviewService.evaluateRelease`. */
export type ReleaseEvaluator = (pub: PublicationForRelease, at: Date, tx?: Tx) => Promise<ReleaseDecision>;
const unregisteredReleaseEvaluator: ReleaseEvaluator = async () => {
  throw new Error('release evaluator not registered (composition root must call registerReleaseEvaluator)');
};
let releaseEvaluator: ReleaseEvaluator = unregisteredReleaseEvaluator;
export const registerReleaseEvaluator = (fn: ReleaseEvaluator): void => {
  releaseEvaluator = fn;
};
export const resetReleaseEvaluator = (): void => {
  releaseEvaluator = unregisteredReleaseEvaluator;
};
export const review = {
  evaluateRelease: (pub: PublicationForRelease, at: Date, tx?: Tx) => releaseEvaluator(pub, at, tx),
};

/**
 * Spec 13.1 approval valid → consumed once the approved release is out: the review module registers
 * `reviewService.approvals.consume`. Called in the transaction that marks the publication published, so the same
 * approval cannot authorise a second publication (another occurrence inside the timing tolerance).
 */
/**
 * An approval binds every channel target of the revision (spec 13.2), so it is spent only once every target has
 * published: the consumer receives the channels published under the approval so far (this publication included)
 * and decides; per-target reuse is refused at dispatch by the release evaluator instead.
 */
export type ApprovalConsumer = (
  approvalId: string,
  publicationId: string,
  publishedChannelConnectionIds: string[],
  tx: Tx,
) => Promise<void>;
const unregisteredApprovalConsumer: ApprovalConsumer = async () => {
  throw new Error('approval consumer not registered (composition root must call registerApprovalConsumer)');
};
let approvalConsumer: ApprovalConsumer = unregisteredApprovalConsumer;
export const registerApprovalConsumer = (fn: ApprovalConsumer): void => {
  approvalConsumer = fn;
};
export const resetApprovalConsumer = (): void => {
  approvalConsumer = unregisteredApprovalConsumer;
};
export const approvals = {
  consume: (approvalId: string, publicationId: string, publishedChannelConnectionIds: string[], tx: Tx) =>
    approvalConsumer(approvalId, publicationId, publishedChannelConnectionIds, tx),
};

/**
 * Spec 9.3 / 14.5 PublishMedia: the exports a variant references, as the adapter needs them. `describe` serves the
 * capability check (spec 13.4 capability_valid, the schedule pre-check): dimensions, mime and bytes, nothing
 * minted. `release` serves publishOnce immediately before send: signed release URLs covering the provider's
 * processing window, the bytes re-verified against the pinned hash (spec 3.g4). Registered by the composition
 * root from the creative (export rows) and assets (release URLs) modules. A variant without exports needs no media
 * and never calls the hook. A ReleaseIntegrityError from `release` holds the publication with reason
 * export_hash_mismatch (runtime.publishOnce).
 */
export interface PublishMediaOptions {
  /** The provider's processing window (capability.media.publicUrlFetch): how long the signed URL must stay valid. */
  providerProcessingWindowSec: number;
}
export type PublishMediaDescription = Omit<PublishMedia, 'url' | 'altText'>;
export interface PublishMediaSource {
  describe(variant: ChannelVariantForPublishing, tx?: Tx): Promise<PublishMediaDescription[]>;
  release(variant: ChannelVariantForPublishing, opts: PublishMediaOptions, tx?: Tx): Promise<PublishMedia[]>;
}
const unregisteredMediaSource: PublishMediaSource = {
  describe: async () => {
    throw new Error(
      'publish media source not registered (composition root must call registerPublishMediaSource)',
    );
  },
  release: async () => {
    throw new Error(
      'publish media source not registered (composition root must call registerPublishMediaSource)',
    );
  },
};
let mediaSource: PublishMediaSource = unregisteredMediaSource;
export const registerPublishMediaSource = (source: PublishMediaSource): void => {
  mediaSource = source;
};
export const resetPublishMediaSource = (): void => {
  mediaSource = unregisteredMediaSource;
};
export const publishMedia = {
  describeForVariant: (variant: ChannelVariantForPublishing, tx?: Tx): Promise<PublishMediaDescription[]> =>
    variant.exportIds.length === 0 ? Promise.resolve([]) : mediaSource.describe(variant, tx),
  forVariant: (
    variant: ChannelVariantForPublishing,
    opts: PublishMediaOptions,
    tx?: Tx,
  ): Promise<PublishMedia[]> =>
    variant.exportIds.length === 0 ? Promise.resolve([]) : mediaSource.release(variant, opts, tx),
};

/**
 * Per-provider app credentials (Appendix A: PROVIDER_<KEY>_CLIENT_ID_REF / _SECRET_REF). Registered by the
 * composition root; tests register a fixture.
 */
export type ProviderClientSource = (providerKey: string) => ClientConfig;
const unregisteredClients: ProviderClientSource = (providerKey) => {
  throw new Error(
    `provider client configuration not registered for ${providerKey} (registerProviderClients)`,
  );
};
let providerClients: ProviderClientSource = unregisteredClients;
export const registerProviderClients = (fn: ProviderClientSource): void => {
  providerClients = fn;
};
export const providerClientFor = (providerKey: string): ClientConfig => providerClients(providerKey);

/** Appendix A names: PROVIDER_<KEY_UPPER>_CLIENT_ID_REF and PROVIDER_<KEY_UPPER>_SECRET_REF. */
export const providerClientsFromEnv =
  (env: NodeJS.ProcessEnv = process.env): ProviderClientSource =>
  (providerKey) => {
    const upper = providerKey.toUpperCase();
    const clientId = env[`PROVIDER_${upper}_CLIENT_ID_REF`];
    const clientSecret = env[`PROVIDER_${upper}_SECRET_REF`];
    if (!clientId || !clientSecret)
      throw new Error(`PROVIDER_${upper}_CLIENT_ID_REF and PROVIDER_${upper}_SECRET_REF are required`);
    return { clientId, clientSecret };
  };

/** Brand ids named in inputs are verified through the brand module (spec 4.2), as the skills module does. */
export interface BrandChecker {
  assertExist(brandIds: string[], tx?: Tx): Promise<void>;
}
let brandChecker: BrandChecker = {
  assertExist: async () => {
    throw new Error('brand checker not registered (composition root must call registerBrandChecker)');
  },
};
export const registerBrandChecker = (c: BrandChecker): void => {
  brandChecker = c;
};
export const assertBrandExists = (brandId: string, tx?: Tx): Promise<void> =>
  brandChecker.assertExist([brandId], tx);

/**
 * The sweeper asks whether a workflow is running before it re-emits a start or declares worker loss; a process
 * that holds a Temporal client (worker-core) registers the probe. Absent, the sweeper assumes nothing is running
 * and lets the outbox start's USE_EXISTING policy absorb the duplicate.
 */
export interface WorkflowProbe {
  isRunning(workflowId: string): Promise<boolean>;
}
let workflowProbe: WorkflowProbe = { isRunning: async () => false };
export const registerWorkflowProbe = (probe: WorkflowProbe | null): void => {
  workflowProbe = probe ?? { isRunning: async () => false };
};
export const workflowRunning = (workflowId: string): Promise<boolean> => workflowProbe.isRunning(workflowId);
