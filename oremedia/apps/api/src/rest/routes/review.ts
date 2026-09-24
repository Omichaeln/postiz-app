import type { RestRouteSpec } from '../route';

/** Spec 7.6 review requests (spec 13.3): a frozen manifest is created; decisions stay in the product. */
export const REVIEW_ROUTES: readonly RestRouteSpec[] = [
  {
    method: 'GET',
    path: '/v1/review-requests/:reviewRequestId',
    procedure: 'review.requests.get',
    summary: 'Get a review request',
  },
  {
    method: 'POST',
    path: '/v1/review-requests',
    procedure: 'review.requests.create',
    summary: 'Request review of a content revision',
    successStatus: 201,
  },
];
