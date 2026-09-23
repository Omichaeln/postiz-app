import type { BrandVersionState } from '@oremedia/contracts/brand';
import { defineMachine } from './machine';

export type BrandVersionEvent = 'submit' | 'publish' | 'reject' | 'retire';

/** Spec 8.2: draft → in_review → published → retired. */
export const brandVersionMachine = defineMachine<BrandVersionState, BrandVersionEvent>({
  name: 'brand_version',
  states: ['draft', 'in_review', 'published', 'retired'],
  events: ['submit', 'publish', 'reject', 'retire'],
  table: {
    draft: { submit: 'in_review', retire: 'retired' },
    in_review: { publish: 'published', reject: 'draft', retire: 'retired' },
    published: { retire: 'retired' },
    retired: {},
  },
  terminal: ['retired'],
});
