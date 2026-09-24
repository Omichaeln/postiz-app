import type { z } from 'zod';
import type { ContentPackageState } from '@oremedia/contracts/content';
import { defineMachine } from './machine';

export type ContentPackageStateValue = z.infer<typeof ContentPackageState>;
export type ContentPackageEvent =
  'request_review' | 'request_changes' | 'approve' | 'revise' | 'schedule' | 'publish' | 'archive';

/**
 * Spec 6.3 content_packages: the package follows its current revision (draft → in_review → approved) and the
 * publishing lifecycle after that; revising always returns it to draft with a new current revision.
 */
export const contentPackageMachine = defineMachine<ContentPackageStateValue, ContentPackageEvent>({
  name: 'content_package',
  states: ['draft', 'in_review', 'approved', 'scheduled', 'published', 'archived'],
  events: ['request_review', 'request_changes', 'approve', 'revise', 'schedule', 'publish', 'archive'],
  table: {
    draft: { request_review: 'in_review', revise: 'draft', archive: 'archived' },
    in_review: { request_changes: 'draft', approve: 'approved', revise: 'draft', archive: 'archived' },
    approved: { schedule: 'scheduled', revise: 'draft', archive: 'archived' },
    scheduled: { publish: 'published', revise: 'draft', archive: 'archived' },
    published: { revise: 'draft', archive: 'archived' },
    archived: {},
  },
  terminal: ['archived'],
});
