import type { RestRouteSpec } from '../route';

/** Spec 7.6 channels: read only (connecting a channel is an interactive OAuth flow in the product). */
export const CHANNEL_ROUTES: readonly RestRouteSpec[] = [
  {
    method: 'GET',
    path: '/v1/brands/:brandId/channels',
    procedure: 'publishing.channels.list',
    summary: 'List the channel connections of a brand',
  },
];
