import { useQueries, useQuery } from '@tanstack/react-query';
import type { inferOutput } from '@trpc/tanstack-react-query';
import type { AssetPurpose } from '@oremedia/contracts/assets';
import { useTRPC, type Trpc } from '../../lib/trpc';

export type AssetDto = inferOutput<Trpc['assets']['get']>;
export type AssetRefDto = inferOutput<Trpc['assets']['search']>['items'][number];

/** Spec 9.2: the search returns eligible assets only; ineligible ones never appear here. */
export function useAssetSearch(brandId: string, purpose: AssetPurpose, query?: string) {
  const trpc = useTRPC();
  return useQuery(
    trpc.assets.search.queryOptions({
      query: { brandId, purpose, channelConnectionIds: [], query: query || undefined },
      page: { limit: 100 },
    }),
  );
}

export function useAsset(assetId: string | null) {
  const trpc = useTRPC();
  return useQuery({ ...trpc.assets.get.queryOptions({ assetId: assetId ?? '' }), enabled: assetId !== null });
}

/** Spec 9.3: a 5-minute signed GET; refreshed before it expires. */
export function useSignedUrl(
  assetVersionId: string | null,
  derivative: 'thumbnail' | 'preview' | 'web' | 'original' = 'preview',
) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.assets.media.signedUrl.queryOptions({ assetVersionId: assetVersionId ?? '', derivative }),
    enabled: assetVersionId !== null,
    staleTime: 4 * 60_000,
    refetchInterval: 4 * 60_000,
    retry: false,
  });
}

/** Signed URLs for every asset version a document references, as one map (a single useQueries call). */
export function useAssetUrls(assetVersionIds: string[]): Map<string, string> {
  const trpc = useTRPC();
  const results = useQueries({
    queries: assetVersionIds.map((assetVersionId) => ({
      ...trpc.assets.media.signedUrl.queryOptions({ assetVersionId, derivative: 'web' as const }),
      staleTime: 4 * 60_000,
      refetchInterval: 4 * 60_000,
      retry: false,
    })),
  });
  const map = new Map<string, string>();
  results.forEach((r, i) => {
    const id = assetVersionIds[i];
    if (id && r.data?.url) map.set(id, r.data.url);
  });
  return map;
}
