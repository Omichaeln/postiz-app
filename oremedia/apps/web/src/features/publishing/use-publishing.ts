import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { inferOutput } from '@trpc/tanstack-react-query';
import { useTRPC, useTRPCClient, type Trpc } from '../../lib/trpc';

export type CalendarRangeDto = inferOutput<Trpc['content']['calendar']['range']>;
export type CalendarPublicationDto = CalendarRangeDto['publications'][number];
export type PublicationDto = inferOutput<Trpc['publishing']['publications']['get']>;
export type PublicationSummaryDto = inferOutput<Trpc['publishing']['publications']['list']>['items'][number];
export type ChannelDto = inferOutput<Trpc['publishing']['channels']['list']>[number];
export type ChannelVariantDto = inferOutput<Trpc['content']['variants']['get']>;
export type CancelResultDto = inferOutput<Trpc['publishing']['publications']['cancel']>;

/** In-flight states change without a user action, so the calendar keeps polling while any is shown. */
const IN_FLIGHT = new Set(['dispatching', 'processing', 'outcome_unknown']);
const pollWhileInFlight = (states: ReadonlyArray<string> | undefined) =>
  states?.some((s) => IN_FLIGHT.has(s)) ? 10_000 : false;

/** Spec 7.5 content.calendar.range: campaigns, packages and (through the registered source) publications by day. */
export function useCalendarRange(brandId: string, from: string, to: string) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.content.calendar.range.queryOptions({ brandId, from, to }),
    placeholderData: keepPreviousData,
    refetchInterval: (q) => pollWhileInFlight(q.state.data?.publications.map((p) => p.state)),
  });
}

export function useChannels(brandId: string) {
  const trpc = useTRPC();
  return useQuery(trpc.publishing.channels.list.queryOptions({ brandId }));
}

export function usePublication(publicationId: string | null) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.publishing.publications.get.queryOptions({ publicationId: publicationId ?? '' }),
    enabled: publicationId !== null,
    refetchInterval: (q) => pollWhileInFlight(q.state.data ? [q.state.data.state] : undefined),
  });
}

/** The list has no revision filter (spec 7.4 bounds), so the brand's pages are walked to the end; never one page. */
const SIBLING_PAGES_MAX = 25;

/** Spec 14.4: every channel is its own publication; the siblings of a revision give the per-channel outcomes. */
export function useRevisionPublications(brandId: string, contentRevisionId: string | null) {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const input = { brandId, page: { limit: 200 } };
  return useQuery({
    // Under the list's own key so `publications.pathFilter()` invalidation reaches it (spec 21.1: one hook per query).
    queryKey: [...trpc.publishing.publications.list.queryKey(input), 'revision', contentRevisionId],
    enabled: contentRevisionId !== null,
    queryFn: async () => {
      const items: PublicationSummaryDto[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < SIBLING_PAGES_MAX; page += 1) {
        const res = await client.publishing.publications.list.query({
          brandId,
          page: { limit: 200, cursor },
        });
        items.push(...res.items.filter((p) => p.contentRevisionId === contentRevisionId));
        if (!res.nextCursor) return { items, complete: true };
        cursor = res.nextCursor;
      }
      return { items, complete: false }; // the UI says the list may be incomplete rather than pretend
    },
  });
}

export function useChannelVariant(variantId: string | null) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.content.variants.get.queryOptions({ variantId: variantId ?? '' }),
    enabled: variantId !== null,
    retry: false,
  });
}

export function usePublicationEvidence(publicationId: string | null) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.publishing.publications.evidence.queryOptions({ publicationId: publicationId ?? '' }),
    enabled: publicationId !== null,
  });
}
