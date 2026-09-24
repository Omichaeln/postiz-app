import { emptyBrandSystemDocument, defaultPolicyDocument } from '@oremedia/contracts/brand';
import { buildBrandSnapshot } from '@oremedia/domain/brand-snapshot';
import type { EvaluationBrandFixture } from './checks';

/**
 * Brand fixtures an evaluation case can reference by `brandFixtureRef`. The built-in `default` fixture is a plain
 * brand with one approved fact, one prohibited phrase, two eligible assets and a protected logo element; tenants
 * and tests register richer fixtures (spec 19.5/19.6: at least two fixture brands with different scripts).
 */
export const DEFAULT_EVALUATION_FIXTURE_REF = 'default';

export function defaultEvaluationFixture(): EvaluationBrandFixture {
  const base = emptyBrandSystemDocument();
  const snapshot = buildBrandSnapshot({
    brandId: 'brd_EVAFXTR0000000000000000001',
    brandVersionId: 'bv_EVAFXTR0000000000000000001',
    brandVersionNumber: 1,
    document: {
      ...base,
      voice: {
        ...base.voice,
        summary: 'Plain, confident, specific',
        tone: ['plain', 'confident'],
        prohibitedPhrases: ['cheap', 'guaranteed results'],
        locales: ['en'],
      },
      tokens: {
        ...base.tokens,
        colours: [
          { key: 'ink', value: '#172120', role: 'text' },
          { key: 'paper', value: '#F4F6F3', role: 'background' },
          { key: 'accent', value: '#0F6E63', role: 'accent' },
        ],
      },
    },
    facts: [
      {
        id: 'fact_EVAFXTR0000000000000000001',
        kind: 'offer',
        statement: '20% off all plans in October',
        validFrom: null,
        validUntil: null,
      },
    ],
    objectives: [],
    policyVersionId: null,
    policy: defaultPolicyDocument(),
    eligibleTemplateVersionIds: [],
    timezone: 'UTC',
    defaultLocale: 'en',
  });
  return {
    snapshot,
    eligibleAssetIds: ['av_EVAFXTR0000000000000000001', 'av_EVAFXTR0000000000000000002'],
    protectedElementIds: ['el_EVAFXTR0000000000000000G0'],
  };
}

/** The fixture brand the built-in skill suites reference (`harare-coffee`): a Harare coffee roaster, en locale. */
export const HARARE_COFFEE_FIXTURE_REF = 'harare-coffee';

export function harareCoffeeFixture(): EvaluationBrandFixture {
  const base = emptyBrandSystemDocument();
  const snapshot = buildBrandSnapshot({
    brandId: 'brd_HARARECFFEE000000000000001',
    brandVersionId: 'bv_HARARECFFEE000000000000001',
    brandVersionNumber: 2,
    document: {
      ...base,
      voice: {
        ...base.voice,
        summary:
          'Warm, direct and proud of the craft; specific about beans, roasting and delivery; never boastful.',
        tone: ['warm', 'direct', 'specific'],
        audiences: [
          { key: 'office_managers', description: 'Office managers ordering coffee for teams in Harare' },
          { key: 'enthusiasts', description: 'Home brewers who care about origin and roast dates' },
        ],
        preferredTerms: [
          { use: 'roasted this week', avoid: ['fresh-ish', 'super fresh'] },
          { use: 'subscription', avoid: ['plan', 'package deal'] },
        ],
        prohibitedPhrases: ['the best espresso in zimbabwe', 'world-class', 'cheap'],
        locales: ['en'],
        examples: [
          {
            text: 'Roasted on Tuesday, at your desk by Thursday.',
            verdict: 'on_brand',
            note: 'specific and plain',
          },
          {
            text: 'The best espresso in Zimbabwe, guaranteed!',
            verdict: 'off_brand',
            note: 'unsupported superlative',
          },
        ],
      },
      tokens: {
        ...base.tokens,
        colours: [
          { key: 'roast', value: '#3B2418', role: 'primary' },
          { key: 'cream', value: '#F6EFE6', role: 'background' },
          { key: 'ink', value: '#1E1A17', role: 'text' },
          { key: 'ember', value: '#C8552B', role: 'accent' },
        ],
      },
    },
    facts: [
      {
        id: 'fact_HARARE000000000000000000001',
        kind: 'product',
        statement: 'Beans are roasted every week in Harare',
        validFrom: null,
        validUntil: null,
      },
      {
        id: 'fact_HARARE000000000000000000002',
        kind: 'offer',
        statement: 'Free delivery within Harare for the first month of a subscription',
        validFrom: null,
        validUntil: null,
      },
      {
        id: 'fact_HARARE000000000000000000003',
        kind: 'product',
        statement: 'The winter roast subscription delivers 500 g every week',
        validFrom: null,
        validUntil: null,
      },
      {
        id: 'fact_HARARE000000000000000000004',
        kind: 'product',
        statement: 'The espresso blend is roasted in small batches of 12 kg',
        validFrom: null,
        validUntil: null,
      },
    ],
    objectives: [
      {
        id: 'obj_HARARE0000000000000000000001',
        name: 'Team subscriptions',
        primaryMetricKey: 'qualified_enquiries',
        guardrailMetricKeys: ['unsubscribes'],
      },
    ],
    policyVersionId: null,
    policy: { ...defaultPolicyDocument(), prohibitedTerms: ['guaranteed'] },
    eligibleTemplateVersionIds: [],
    timezone: 'Africa/Harare',
    defaultLocale: 'en',
  });
  return {
    snapshot,
    eligibleAssetIds: [
      'av_HARARECFFEE000000000000001',
      'av_HARARECFFEE000000000000002',
      'av_HARARECFFEE000000000000003',
    ],
    protectedElementIds: ['el_HARARECFFEE00000000000000G'],
  };
}

const fixtures = new Map<string, EvaluationBrandFixture>([
  [DEFAULT_EVALUATION_FIXTURE_REF, defaultEvaluationFixture()],
  [HARARE_COFFEE_FIXTURE_REF, harareCoffeeFixture()],
]);
export const registerEvaluationBrandFixture = (ref: string, fixture: EvaluationBrandFixture): void => {
  fixtures.set(ref, fixture);
};
export const evaluationBrandFixtures = (): Record<string, EvaluationBrandFixture> =>
  Object.fromEntries(fixtures);
