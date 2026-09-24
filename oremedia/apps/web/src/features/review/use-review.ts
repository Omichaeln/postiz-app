import { useQuery } from '@tanstack/react-query';
import type { inferOutput } from '@trpc/tanstack-react-query';
import { useTRPC, type Trpc } from '../../lib/trpc';

export type InboxItemDto = inferOutput<Trpc['review']['inbox']['list']>['items'][number];
/** Members get the full request; an external reviewer gets only the frozen manifest view (spec 5.6). */
export type ReviewRequestDto = inferOutput<Trpc['review']['requests']['get']>;
export type MemberReviewRequestDto = Extract<ReviewRequestDto, { decisions: unknown }>;
export type ExternalLinkCreatedDto = inferOutput<Trpc['review']['externalLinks']['create']>;

/** Spec 21.2 review inbox: open, stale and decided requests with the attention each needs. */
export function useReviewInbox(brandId: string) {
  const trpc = useTRPC();
  return useQuery(trpc.review.inbox.list.queryOptions({ brandId, page: { limit: 100 } }));
}

export function useReviewRequest(reviewRequestId: string | null) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.review.requests.get.queryOptions({ reviewRequestId: reviewRequestId ?? '' }),
    enabled: reviewRequestId !== null,
  });
}

export const isMemberView = (r: ReviewRequestDto): r is MemberReviewRequestDto => 'decisions' in r;
