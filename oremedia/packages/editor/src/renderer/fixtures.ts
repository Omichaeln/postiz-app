import type { BrandSnapshot } from '@oremedia/contracts/brand';
import type { CreativeDocumentV1, Element } from '@oremedia/contracts/creative';
import { eid } from '../fixtures';

/**
 * Spec 19.5 golden-render fixtures: two brands with different scripts and pinned fonts (tooling/test-fixtures/fonts,
 * both OFL), and documents exercising wrapping, right-to-left text, transparency, rotation, clipping (crop and
 * masks) and a very large image. Pure data: the golden test generates the image bytes deterministically and loads
 * the font files; nothing here touches the DOM. Changing a fixture or the renderer regenerates the goldens
 * (OREMEDIA_UPDATE_GOLDENS=1) in the same change, reviewed like any other diff.
 */
export interface FixtureFont {
  assetVersionId: string;
  /** Path under tooling/test-fixtures/fonts. */
  file: string;
  mime: string;
}

export interface FixtureAsset {
  assetVersionId: string;
  /** Deterministic generator the test implements: a smooth gradient, a checkerboard, or a wordmark with alpha. */
  kind: 'gradient' | 'checker' | 'logo';
  width: number;
  height: number;
}

export interface RenderFixture {
  key: string;
  formatKey: string;
  snapshot: BrandSnapshot;
  document: CreativeDocumentV1;
  fonts: FixtureFont[];
  assets: FixtureAsset[];
}

export const FIXTURE_FONTS = {
  karla: { assetVersionId: 'av_font_karla', file: 'karla/Karla[wght].ttf', mime: 'font/ttf' },
  naskh: {
    assetVersionId: 'av_font_naskh',
    file: 'noto-naskh-arabic/NotoNaskhArabic[wght].ttf',
    mime: 'font/ttf',
  },
} as const satisfies Record<string, FixtureFont>;

const base = (
  id: string,
  name: string,
  x: number,
  y: number,
  width: number,
  height: number,
  rotation = 0,
  opacity = 1,
) => ({
  id,
  name,
  locked: false,
  visible: true,
  opacity,
  protected: false,
  transform: { x, y, width, height, rotation },
});

const snapshot = (
  brandId: string,
  fontAssetId: string,
  colours: Array<{ key: string; value: string; role: 'text' | 'background' | 'accent' | 'neutral' }>,
  logoBackgrounds: string[],
): BrandSnapshot => ({
  hash: 'h'.repeat(64),
  brandId,
  brandVersionId: `bv_${brandId}`,
  brandVersionNumber: 1,
  policyVersionId: null,
  eligibleTemplateVersionIds: [],
  timezone: 'UTC',
  defaultLocale: 'en',
  facts: [],
  objectives: [],
  policy: {
    schemaVersion: 1,
    reviewThresholds: { requireReviewForContentClasses: [], blockOnBrandReviewSeverity: 'blocking' },
    restrictedTopics: [],
    prohibitedTerms: [],
    requireDistinctApprover: false,
    holdOnDependencyRevocation: true,
    mfaRequired: false,
  },
  document: {
    schemaVersion: 1,
    voice: {
      summary: 'Fixture',
      tone: [],
      audiences: [],
      preferredTerms: [],
      prohibitedPhrases: [],
      locales: ['en'],
      examples: [],
    },
    tokens: {
      colours,
      typeRoles: [
        { role: 'display', fontAssetId, weight: 700, minSizePx: 40 },
        { role: 'heading', fontAssetId, weight: 600, minSizePx: 28 },
        { role: 'body', fontAssetId, weight: 400, minSizePx: 18 },
        { role: 'label', fontAssetId, weight: 500, minSizePx: 14 },
        { role: 'caption', fontAssetId, weight: 400, minSizePx: 12 },
      ],
      spacingScale: [4, 8, 16, 24, 32],
      radii: [0, 8, 24],
      contrastTarget: 'AA',
    },
    logoRules: [
      {
        assetId: 'ast_logo',
        variant: 'primary',
        allowedBackgroundColourKeys: logoBackgrounds,
        clearSpaceRatio: 0.5,
        minWidthPx: 120,
      },
      {
        assetId: 'ast_logo',
        variant: 'reversed',
        allowedBackgroundColourKeys: logoBackgrounds,
        clearSpaceRatio: 0.5,
        minWidthPx: 120,
      },
    ],
    patterns: [],
    channelGuidance: [],
  },
});

const text = (
  id: string,
  name: string,
  fontAssetVersionId: string,
  role: 'display' | 'heading' | 'body' | 'label' | 'caption',
  t: string,
  box: [number, number, number, number],
  style: Partial<Extract<Element, { type: 'text' }>['style']> & { sizePx: number },
  rotation = 0,
): Element => ({
  ...base(id, name, box[0], box[1], box[2], box[3], rotation),
  type: 'text',
  text: t,
  style: {
    typeRole: role,
    fontAssetVersionId,
    weight: 600,
    lineHeight: 1.25,
    tracking: 0,
    colourToken: 'ink',
    align: 'left',
    overflow: 'error',
    ...style,
  },
  factRefs: [],
});

/** Brand 1: Latin script (Karla), a square feed post with a very large photo, crops, transparency and rotation. */
export const latinFeedFixture = (): RenderFixture => {
  const font = FIXTURE_FONTS.karla.assetVersionId;
  return {
    key: 'latin_feed_square',
    formatKey: 'square_1080',
    snapshot: snapshot(
      'brd_latin',
      'ast_font_karla',
      [
        { key: 'ink', value: '#172120', role: 'text' },
        { key: 'paper', value: '#F4F6F3', role: 'background' },
        { key: 'accent', value: '#0F6E63', role: 'accent' },
        { key: 'mist', value: '#D3DAD5', role: 'neutral' },
        { key: 'coral', value: '#D9542B', role: 'accent' },
      ],
      ['paper'],
    ),
    fonts: [FIXTURE_FONTS.karla],
    assets: [
      { assetVersionId: 'av_photo_large', kind: 'gradient', width: 4000, height: 3000 },
      { assetVersionId: 'av_photo_checker', kind: 'checker', width: 1200, height: 800 },
      { assetVersionId: 'av_logo_wide', kind: 'logo', width: 600, height: 180 },
    ],
    document: {
      schemaVersion: 1,
      brandVersionId: 'bv_brd_latin',
      variants: [],
      pages: [
        {
          id: 'page_feed',
          name: 'Feed',
          formatKey: 'square_1080',
          width: 1080,
          height: 1080,
          layoutConstraints: [],
          elements: [
            { ...base(eid('01GBG'), 'Background', 0, 0, 1080, 1080), type: 'background', fillToken: 'paper' },
            {
              // Very large source (4000×3000) covered into a wide box, crop driven by the focal point.
              ...base(eid('01GHER0'), 'Hero', 80, 300, 920, 420),
              type: 'image',
              assetVersionId: 'av_photo_large',
              fit: 'cover',
              focalPoint: { x: 0.8, y: 0.3 },
              mask: { kind: 'rounded', radius: 32 },
            },
            {
              // Explicit crop of a checkerboard, contain-fit in a circle mask (clipping).
              ...base(eid('01GCR0P'), 'Crop', 760, 740, 240, 240),
              type: 'image',
              assetVersionId: 'av_photo_checker',
              fit: 'contain',
              crop: { x: 300, y: 200, width: 600, height: 400 },
              mask: { kind: 'circle' },
            },
            {
              // Translucent rotated panel over the photo (transparency + rotation).
              ...base(eid('01GPANE1'), 'Panel', 120, 560, 420, 120, -8, 0.6),
              type: 'shape',
              shape: 'rect',
              fillToken: 'accent',
              strokeWidth: 0,
              cornerRadius: 16,
              semanticRole: 'decoration',
            },
            {
              ...base(eid('01GR1NG'), 'Ring', 900, 120, 100, 100),
              type: 'shape',
              shape: 'ellipse',
              strokeToken: 'coral',
              strokeWidth: 8,
              cornerRadius: 0,
              semanticRole: 'decoration',
            },
            {
              ...base(eid('01GRV1E'), 'Rule', 80, 270, 920, 4),
              type: 'shape',
              shape: 'line',
              strokeToken: 'mist',
              strokeWidth: 4,
              cornerRadius: 0,
              semanticRole: 'decoration',
            },
            text(
              eid('01GHEAD'),
              'Headline',
              font,
              'display',
              'Twenty percent off every autumn range this October',
              [80, 80, 780, 170],
              { sizePx: 60, weight: 700, lineHeight: 1.1, tracking: -0.02 },
            ),
            text(
              eid('01GB0DY'),
              'Body',
              font,
              'body',
              'Wrapped, justified body copy proves line breaking, word spacing and line height survive the trip from the studio canvas to the exported file. Numbers 0123456789 and punctuation; too.',
              [80, 760, 640, 112],
              { sizePx: 22, weight: 400, align: 'justify', lineHeight: 1.2 },
            ),
            {
              // A group's own box spans the page; it is decoration so the brand rules read its children, not the box.
              ...base(eid('01GGR0VP'), 'Badge group', 0, 0, 1080, 1080),
              type: 'group',
              semanticRole: 'decoration',
              children: [
                {
                  ...base(eid('01GBADGE'), 'Badge', 560, 580, 200, 72, 6),
                  type: 'shape',
                  shape: 'rect',
                  fillToken: 'coral',
                  strokeWidth: 0,
                  cornerRadius: 36,
                  semanticRole: 'decoration',
                },
                text(
                  eid('01GBTXT'),
                  'Badge text',
                  font,
                  'label',
                  'NEW',
                  [560, 596, 200, 40],
                  { sizePx: 26, weight: 700, align: 'center', colourToken: 'paper', tracking: 0.12 },
                  6,
                ),
              ],
            },
            text(
              eid('01GC11P'),
              'Clipped caption',
              font,
              'caption',
              'This caption is deliberately longer than its box so the clip overflow mode cuts it cleanly at the box edge without an error.',
              [80, 882, 400, 40],
              { sizePx: 18, weight: 400, overflow: 'clip', colourToken: 'ink' },
            ),
            {
              ...base(eid('01G10G0'), 'Logo', 80, 960, 200, 60),
              type: 'logo',
              assetVersionId: 'av_logo_wide',
              variant: 'primary',
              semanticRole: 'logo',
              protected: true,
            },
          ],
        },
      ],
    },
  };
};

/** Brand 2: Arabic script (Noto Naskh Arabic), a dark story with right-to-left wrapping and mixed numerals. */
export const arabicStoryFixture = (): RenderFixture => {
  const font = FIXTURE_FONTS.naskh.assetVersionId;
  return {
    key: 'arabic_story_9x16',
    formatKey: 'ig_story_9x16',
    snapshot: snapshot(
      'brd_arabic',
      'ast_font_naskh',
      [
        { key: 'ink', value: '#101820', role: 'background' },
        { key: 'paper', value: '#FAF7F0', role: 'text' },
        { key: 'gold', value: '#D4A64A', role: 'accent' },
        { key: 'teal', value: '#2A9D8F', role: 'accent' },
      ],
      ['ink'],
    ),
    fonts: [FIXTURE_FONTS.naskh],
    assets: [
      { assetVersionId: 'av_photo_story', kind: 'gradient', width: 2160, height: 2160 },
      { assetVersionId: 'av_logo_mark', kind: 'logo', width: 400, height: 400 },
    ],
    document: {
      schemaVersion: 1,
      brandVersionId: 'bv_brd_arabic',
      variants: [],
      pages: [
        {
          id: 'page_story',
          name: 'Story',
          formatKey: 'ig_story_9x16',
          width: 1080,
          height: 1920,
          layoutConstraints: [],
          elements: [
            { ...base(eid('01ABG'), 'Background', 0, 0, 1080, 1920), type: 'background', fillToken: 'ink' },
            {
              ...base(eid('01APH0T0'), 'Photo', 140, 520, 800, 800),
              type: 'image',
              assetVersionId: 'av_photo_story',
              fit: 'cover',
              mask: { kind: 'circle' },
            },
            {
              ...base(eid('01AR1BB0N'), 'Ribbon', 60, 1360, 960, 80, -4, 0.85),
              type: 'shape',
              shape: 'rect',
              fillToken: 'gold',
              strokeWidth: 0,
              cornerRadius: 45,
              semanticRole: 'decoration',
            },
            text(
              eid('01AHEAD'),
              'Headline',
              font,
              'display',
              'عرض خاص لشهر أكتوبر على جميع المنتجات المختارة في المتجر',
              [80, 280, 920, 220],
              { sizePx: 64, weight: 700, align: 'right', colourToken: 'paper', lineHeight: 1.3 },
            ),
            text(
              eid('01AB0DY'),
              'Body',
              font,
              'body',
              'خصم 20% على كل الطلبات حتى نهاية الشهر. التوصيل مجاني للطلبات فوق 50 دولاراً.',
              [80, 1372, 920, 56],
              { sizePx: 30, weight: 500, align: 'center', colourToken: 'ink' },
            ),
            text(eid('01A1ABE1'), 'Label', font, 'label', 'OREMEDIA · 2026', [80, 1450, 920, 36], {
              sizePx: 22,
              weight: 500,
              align: 'center',
              colourToken: 'teal',
              tracking: 0.2,
            }),
            {
              ...base(eid('01A10G0'), 'Mark', 480, 1550, 120, 120),
              type: 'logo',
              assetVersionId: 'av_logo_mark',
              variant: 'reversed',
              semanticRole: 'logo',
              protected: true,
            },
          ],
        },
      ],
    },
  };
};

export const renderFixtures = (): RenderFixture[] => [latinFeedFixture(), arabicStoryFixture()];
