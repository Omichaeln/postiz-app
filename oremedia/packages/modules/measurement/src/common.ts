import type { CollectionPlanV1 } from '@oremedia/contracts/measurement';
import { NotFoundError } from '@oremedia/contracts/errors';
import { requireTenant, type Tx } from '@oremedia/db';
import { BrandRepository } from '@oremedia/module-brand';
import {
  ChannelConnectionRepository,
  PublicationRepository,
  RemoteEvidenceRepository,
  providerRegistryInUse,
} from '@oremedia/module-publishing';

/** Read-only views of other modules' rows through their public index (spec 4.2: never their tables). */
const publicationsRepo = new PublicationRepository();
const connectionsRepo = new ChannelConnectionRepository();
const evidenceRepo = new RemoteEvidenceRepository();
const brandsRepo = new BrandRepository();

export type PublicationRow = Awaited<ReturnType<PublicationRepository['getById']>>;
export type ConnectionRow = Awaited<ReturnType<ChannelConnectionRepository['getById']>>;

/** Snapshot `source` = provider key + capability (API) version (spec 15.1). */
export const sourceOf = (providerKey: string, capabilityVersion: number): string =>
  `${providerKey}@v${capabilityVersion}`;
export const providerKeyOfSource = (source: string): string => source.split('@')[0] ?? source;

/** Default when a capability is not registered in this process (never happens for a certified provider). */
export const DEFAULT_LATENCY_HOURS = 24;

export const latencyHoursFor = (providerKey: string): number =>
  providerRegistryInUse().capability(providerKey)?.analytics.latencyHours ?? DEFAULT_LATENCY_HOURS;

export const brandResource = (brandId: string) => {
  const { tenantId } = requireTenant();
  return { type: 'brand', tenantId, brandId, id: brandId };
};

/** The publication, its connection and the brand's timezone, all inside the tenant and brand scope. */
export async function loadPublication(publicationId: string, tx?: Tx) {
  const row = await publicationsRepo.getById(publicationId, tx);
  const connection = await connectionsRepo.getById(row.channelConnectionId, tx);
  if (connection.brandId !== row.brandId)
    throw new NotFoundError('ChannelConnection', row.channelConnectionId);
  const brand = await brandsRepo.getById(row.brandId, tx);
  return { row, connection, brandTimezone: brand.timezone };
}

/** Spec 15.1: the schedule is derived from the publication moment and the capability's analytics latency. */
export async function collectionPlan(publicationId: string, tx?: Tx): Promise<CollectionPlanV1> {
  const { row, connection } = await loadPublication(publicationId, tx);
  const capability = providerRegistryInUse().capability(connection.providerKey);
  const evidence = await evidenceRepo.listForPublication(row.id, tx);
  const publishedAt = evidence[0]?.capturedAt ?? (row.state === 'published' ? row.updatedAt : null);
  return {
    collectable: row.state === 'published' && !!row.remotePostId,
    providerKey: connection.providerKey,
    publishedAt: publishedAt ? publishedAt.toISOString() : null,
    latencyHours: capability?.analytics.latencyHours ?? DEFAULT_LATENCY_HOURS,
    commentsReadable: capability?.comments.read ?? false,
  };
}
