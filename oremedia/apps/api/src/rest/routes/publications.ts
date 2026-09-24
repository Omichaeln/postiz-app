import type { RestRouteSpec } from '../route';

/**
 * Spec 7.6 / 14.1 publications. Scheduling is the same publications.schedule command as the product: it requires a
 * valid approval or an active mandate (spec 13.4, Postiz R2), and dispatch re-checks it.
 */
export const PUBLICATION_ROUTES: readonly RestRouteSpec[] = [
  {
    method: 'POST',
    path: '/v1/publications',
    procedure: 'publishing.publications.schedule',
    summary: 'Schedule a channel variant under an approval or a mandate',
    successStatus: 201,
  },
  {
    method: 'POST',
    path: '/v1/publications/:publicationId/cancel',
    procedure: 'publishing.publications.cancel',
    summary: 'Cancel a scheduled publication',
  },
  {
    method: 'POST',
    path: '/v1/publications/:publicationId/reschedule',
    procedure: 'publishing.publications.reschedule',
    summary: 'Move a scheduled publication to a new time',
  },
  {
    method: 'GET',
    path: '/v1/publications/:publicationId',
    procedure: 'publishing.publications.get',
    summary: 'Get a publication with its attempts',
  },
  {
    method: 'GET',
    path: '/v1/brands/:brandId/publications',
    procedure: 'publishing.publications.list',
    summary: 'List the publications of a brand, optionally by state',
  },
];
