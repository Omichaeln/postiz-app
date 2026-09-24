import { useQuery } from '@tanstack/react-query';
import type { inferOutput } from '@trpc/tanstack-react-query';
import { useTRPC, type Trpc } from '../../lib/trpc';

export type CampaignDto = inferOutput<Trpc['content']['campaigns']['get']>;
export type BriefDto = inferOutput<Trpc['content']['briefs']['get']>;
export type PackageDto = inferOutput<Trpc['content']['packages']['get']>;
export type PackageSummaryDto = inferOutput<Trpc['content']['calendar']['range']>['packages'][number];
export type PackageRevisionSummaryDto = PackageDto['revisions'][number];
export type PackageVariantDto = PackageDto['variants'][number];

/** One hook per query (spec 21.1). */
export function useCampaigns(brandId: string) {
  const trpc = useTRPC();
  return useQuery(trpc.content.campaigns.list.queryOptions({ brandId, page: { limit: 100 } }));
}

export function useBriefs(brandId: string, campaignId: string | null) {
  const trpc = useTRPC();
  return useQuery(
    trpc.content.briefs.list.queryOptions({
      brandId,
      ...(campaignId ? { campaignId } : {}),
      page: { limit: 100 },
    }),
  );
}

export function useBrief(briefId: string | null) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.content.briefs.get.queryOptions({ briefId: briefId ?? '' }),
    enabled: briefId !== null,
  });
}

export function usePackage(contentPackageId: string | null) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.content.packages.get.queryOptions({ contentPackageId: contentPackageId ?? '' }),
    enabled: contentPackageId !== null,
  });
}

/**
 * The content router has no package listing; the calendar range returns the packages touched in a window, which is
 * how the planner finds the brand's recent packages. The window is stated in the UI, never presented as "all".
 */
export function useRecentPackages(brandId: string, from: string, to: string) {
  const trpc = useTRPC();
  return useQuery(trpc.content.calendar.range.queryOptions({ brandId, from, to }));
}
