import { describe, expect, it } from 'vitest';
import type { CreativeDocumentV1 } from '@oremedia/contracts/creative';
import { copyFeatures, layoutFeatures } from './attributes';

describe('creative attribute capture at creation (spec 16.2)', () => {
  it('copy features: hook type, topic, message, offer fact and call to action from the master text', () => {
    expect(
      copyFeatures({
        schemaVersion: 1,
        master: {
          text: 'Tired of slow mornings? Our new blend fixes that. Shop now at the store. #coffee',
          factRefs: ['fact_1'],
        },
      }),
    ).toEqual({
      hookType: 'question',
      topic: 'coffee',
      message: 'Tired of slow mornings?',
      offerFactId: 'fact_1',
      cta: 'Shop now at the store.',
    });
    expect(
      copyFeatures({ schemaVersion: 1, master: { text: '3 ways to save this week', factRefs: [] } }),
    ).toMatchObject({
      hookType: 'number',
      topic: '3 ways to save this week',
    });
    expect(copyFeatures({ schemaVersion: 1, master: { text: '', factRefs: [] } })).toEqual({});
  });
  it('layout features from element semantic roles, type roles, colour tokens and imagery', () => {
    const doc = {
      schemaVersion: 1,
      brandVersionId: 'bv_1',
      templateVersionId: 'tv_1',
      pages: [
        {
          id: 'pg',
          elements: [
            { type: 'text', semanticRole: 'headline', style: { typeRole: 'display', colourToken: 'ink' } },
            { type: 'text', semanticRole: 'cta', style: { typeRole: 'label', colourValue: '#fff' } },
            { type: 'image', name: 'Hero product shot', semanticRole: 'product' },
            { type: 'logo', semanticRole: 'logo' },
          ],
        },
      ],
      variants: [],
    } as unknown as CreativeDocumentV1;
    expect(layoutFeatures(doc)).toEqual({
      templateVersionId: 'tv_1',
      layoutKey: 'cta+headline+logo+product',
      colourTreatment: 'mixed',
      typographyRoles: ['display', 'label'],
      imageryKind: 'product',
    });
    const empty = {
      schemaVersion: 1,
      brandVersionId: 'bv',
      pages: [{ id: 'p', elements: [] }],
      variants: [],
    } as unknown as CreativeDocumentV1;
    expect(layoutFeatures(empty)).toMatchObject({
      layoutKey: 'unlabelled',
      colourTreatment: 'none',
      imageryKind: 'none',
    });
  });
});
