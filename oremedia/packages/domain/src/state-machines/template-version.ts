import type { TemplateState, TemplateVersionState } from '@oremedia/contracts/creative';
import { defineMachine } from './machine';

export type TemplateVersionEvent = 'approve' | 'retire';

/** Spec 6.3 template_versions: draft → approved → retired; a draft may be retired without approval. Retired is final. */
export const templateVersionMachine = defineMachine<TemplateVersionState, TemplateVersionEvent>({
  name: 'template_version',
  states: ['draft', 'approved', 'retired'],
  events: ['approve', 'retire'],
  table: {
    draft: { approve: 'approved', retire: 'retired' },
    approved: { retire: 'retired' },
    retired: {},
  },
  terminal: ['retired'],
});

export type TemplateEvent = 'activate' | 'retire';

/** Spec 6.3 templates: draft → active (first approved version) → retired. Retired is final. */
export const templateMachine = defineMachine<TemplateState, TemplateEvent>({
  name: 'template',
  states: ['draft', 'active', 'retired'],
  events: ['activate', 'retire'],
  table: {
    draft: { activate: 'active', retire: 'retired' },
    active: { retire: 'retired' },
    retired: {},
  },
  terminal: ['retired'],
});
