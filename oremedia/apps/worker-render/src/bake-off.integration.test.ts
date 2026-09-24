import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';
import type { BrandSnapshot } from '@oremedia/contracts/brand';
import type { CreativeDocumentV1, CreativePage, Element } from '@oremedia/contracts/creative';
import type { RenderTargetInput } from '@oremedia/activities';
import { eid } from '@oremedia/editor/fixtures';
import {
  arabicStoryFixture,
  latinFeedFixture,
  renderFixtures,
  type RenderFixture,
} from '@oremedia/editor/renderer/fixtures';
import { createChromiumRenderer } from './chromium-renderer';
import { generateFixtureAsset, loadFixtureFont } from './fixture-assets';

/**
 * Phase 0 editor bake-off (ledger 0.13, spec 22 Phase 0; write-up docs/spikes/editor-bake-off.md): Konva through the
 * current adapter and the real worker path (headless Chromium + the render-only bundle), on the two golden fixture
 * brands, Latin (Karla) and Arabic (Noto Naskh Arabic), each with its own pinned font from tooling/test-fixtures/fonts.
 * Probe pages are small documents in each brand; every assertion reads the exported PNG or the render findings:
 *   - shaping: Arabic letters join (a ZWNJ-separated copy draws differently and wider);
 *   - direction: the paragraph direction follows the first strong character, so the native word sits at the start
 *     edge (right for Arabic, left for Latin) of a mixed-script line;
 *   - font loading: the pinned font is what draws (the fallback draws differently) and a missing font blocks;
 *   - overflow: measured in the browser for both scripts (error blocks, clip warns, shrink_to_fit fits);
 *   - determinism: each fixture renders byte-identically in fresh contexts.
 * Requires OREMEDIA_CHROMIUM_PATH and the renderer bundle (pnpm --filter @oremedia/editor build:renderer).
 */
const executablePath = process.env['OREMEDIA_CHROMIUM_PATH'];
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

type Loaded = { fonts: RenderTargetInput['fonts']; assets: RenderTargetInput['assets'] };

interface Brand {
  fixture: RenderFixture;
  font: string;
  text: string;
  background: string;
}
const BRANDS = {
  latin: (): Brand => {
    const fixture = latinFeedFixture();
    return { fixture, font: fixture.fonts[0]!.assetVersionId, text: 'ink', background: 'paper' };
  },
  arabic: (): Brand => {
    const fixture = arabicStoryFixture();
    return { fixture, font: fixture.fonts[0]!.assetVersionId, text: 'paper', background: 'ink' };
  },
};

const BOX = { x: 60, y: 200, width: 960, height: 120 };

/** A one-text probe page in a fixture brand: the brand background plus one text element in the brand font. */
function probe(
  brand: Brand,
  text: string,
  style: Partial<Extract<Element, { type: 'text' }>['style']> = {},
  box: { x: number; y: number; width: number; height: number } = BOX,
): { document: CreativeDocumentV1; page: CreativePage } {
  const common = { locked: false, visible: true, opacity: 1, protected: false };
  const page: CreativePage = {
    id: 'page_probe',
    name: 'Probe',
    formatKey: 'square_1080',
    width: 1080,
    height: 1080,
    layoutConstraints: [],
    elements: [
      {
        ...common,
        id: eid('01PBG'),
        name: 'Background',
        type: 'background',
        fillToken: brand.background,
        transform: { x: 0, y: 0, width: 1080, height: 1080, rotation: 0 },
      },
      {
        ...common,
        id: eid('01PTXT'),
        name: 'Probe text',
        type: 'text',
        text,
        transform: { ...box, rotation: 0 },
        style: {
          typeRole: 'display',
          fontAssetVersionId: brand.font,
          weight: 700,
          sizePx: 64,
          lineHeight: 1.2,
          tracking: 0,
          colourToken: brand.text,
          align: 'left',
          overflow: 'clip',
          ...style,
        },
        factRefs: [],
      },
    ],
  };
  return {
    document: {
      schemaVersion: 1,
      brandVersionId: brand.fixture.document.brandVersionId,
      variants: [],
      pages: [page],
    },
    page,
  };
}

/** Columns [left, right] of the box's rows that hold ink (any channel more than 40 away from the background). */
function inkColumns(png: Buffer, box = BOX): { left: number; right: number; count: number } {
  const img = PNG.sync.read(png);
  const at = (x: number, y: number) => (y * img.width + x) * 4;
  const bg = at(2, 2);
  let left = Infinity;
  let right = -Infinity;
  let count = 0;
  for (let x = box.x; x < box.x + box.width; x++) {
    let ink = false;
    for (let y = box.y; y < box.y + box.height && !ink; y++) {
      const i = at(x, y);
      for (let c = 0; c < 3; c++)
        if (Math.abs((img.data[i + c] as number) - (img.data[bg + c] as number)) > 40) ink = true;
    }
    if (ink) {
      left = Math.min(left, x);
      right = Math.max(right, x);
      count += 1;
    }
  }
  return { left, right, count };
}

/** Share of pixels in columns [from, to) of the box's rows that differ (any channel by more than 2). */
function regionDiff(a: Buffer, b: Buffer, from: number, to: number, box = BOX): number {
  const pa = PNG.sync.read(a);
  const pb = PNG.sync.read(b);
  let differing = 0;
  let total = 0;
  for (let y = box.y; y < box.y + box.height; y++)
    for (let x = from; x < to; x++) {
      const i = (y * pa.width + x) * 4;
      total += 1;
      for (let c = 0; c < 4; c++)
        if (Math.abs((pa.data[i + c] as number) - (pb.data[i + c] as number)) > 2) {
          differing += 1;
          break;
        }
    }
  return total ? differing / total : 0;
}

describe('editor bake-off: Konva through the worker path on the Latin and Arabic fixture brands', () => {
  const renderer = createChromiumRenderer({
    ...(executablePath ? { executablePath } : {}),
    timeoutMs: 120_000,
  });
  const loaded = new Map<string, Loaded>();

  beforeAll(async () => {
    for (const fixture of renderFixtures())
      loaded.set(fixture.key, {
        fonts: await Promise.all(fixture.fonts.map(loadFixtureFont)),
        assets: await Promise.all(fixture.assets.map(generateFixtureAsset)),
      });
  }, 180_000);
  afterAll(async () => {
    await renderer.close();
  });

  const renderProbe = async (
    brand: Brand,
    doc: { document: CreativeDocumentV1; page: CreativePage },
    opts: { withFont?: boolean } = {},
  ) => {
    const l = loaded.get(brand.fixture.key)!;
    return renderer.render({
      document: doc.document,
      page: doc.page,
      formatKey: 'square_1080',
      reflow: false,
      snapshot: brand.fixture.snapshot as BrandSnapshot,
      fonts: opts.withFont === false ? [] : l.fonts,
      assets: [],
    });
  };
  const codes = (out: { findings: Array<{ code: string; severity: string }> }) =>
    out.findings.map((f) => `${f.severity}:${f.code}`);

  describe('text shaping and direction', () => {
    const word = 'مرحبا';
    it('Arabic letters join: a ZWNJ-separated copy of the same letters draws differently and wider', async () => {
      const brand = BRANDS.arabic();
      const joined = await renderProbe(brand, probe(brand, word));
      const isolated = await renderProbe(brand, probe(brand, [...word].join('‌')));
      const j = inkColumns(joined.png);
      const i = inkColumns(isolated.png);
      console.error(
        `joined ink ${j.left}–${j.right} (${j.count} cols); isolated ${i.left}–${i.right} (${i.count})`,
      );
      expect(j.count).toBeGreaterThan(0);
      expect(i.right - i.left).toBeGreaterThan(j.right - j.left);
      expect(regionDiff(joined.png, isolated.png, BOX.x, BOX.x + BOX.width)).toBeGreaterThan(0.01);
      // Tracking on an RTL paragraph keeps the run whole (Konva draws RTL as one native run), so joining survives.
      const tracked = await renderProbe(brand, probe(brand, word, { tracking: 0.05 }));
      expect(inkColumns(tracked.png).right - inkColumns(tracked.png).left).toBeLessThan(i.right - i.left);
    }, 120_000);

    it('the first strong character sets the paragraph direction: an Arabic line starts at the right edge', async () => {
      const brand = BRANDS.arabic();
      const native = await renderProbe(brand, probe(brand, word, { align: 'right' }));
      const mixed = await renderProbe(brand, probe(brand, `${word} ABC`, { align: 'right' }));
      const n = inkColumns(native.png);
      // RTL: the Arabic word is at the right end of the mixed line exactly where it is on its own.
      const diff = regionDiff(native.png, mixed.png, n.left - 4, BOX.x + BOX.width);
      console.error(
        `arabic start-edge region ${n.left - 4}–${BOX.x + BOX.width}: ${(diff * 100).toFixed(3)} % differ`,
      );
      expect(diff).toBeLessThan(0.005);
      expect(inkColumns(mixed.png).left).toBeLessThan(n.left - 20); // the Latin run went to the left
    }, 120_000);

    it('a Latin line (first strong character Latin) starts at the left edge with the foreign run after it', async () => {
      const brand = BRANDS.latin();
      const native = await renderProbe(brand, probe(brand, 'Autumn'));
      const mixed = await renderProbe(brand, probe(brand, `Autumn ${word}`));
      const n = inkColumns(native.png);
      const diff = regionDiff(native.png, mixed.png, BOX.x, n.right + 4);
      console.error(`latin start-edge region ${BOX.x}–${n.right + 4}: ${(diff * 100).toFixed(3)} % differ`);
      expect(diff).toBeLessThan(0.005);
      expect(inkColumns(mixed.png).right).toBeGreaterThan(n.right + 20);
    }, 120_000);
  });

  describe('font loading', () => {
    it.each([['latin'], ['arabic']] as const)(
      '%s: the pinned font draws the text; without it the render blocks with missing_font and draws differently',
      async (key) => {
        const brand = BRANDS[key]();
        const text = key === 'latin' ? 'Autumn range' : 'عرض خاص';
        const pinned = await renderProbe(brand, probe(brand, text));
        const fallback = await renderProbe(brand, probe(brand, text), { withFont: false });
        expect(codes(pinned)).not.toContain('blocking:missing_font');
        expect(codes(fallback)).toContain('blocking:missing_font');
        const diff = regionDiff(pinned.png, fallback.png, BOX.x, BOX.x + BOX.width);
        console.error(`${key}: pinned vs fallback ${(diff * 100).toFixed(2)} % of the text box differs`);
        expect(diff).toBeGreaterThan(0.01);
      },
      120_000,
    );
  });

  describe('overflow detection (measured in the browser)', () => {
    const long = {
      latin: 'A headline far longer than the small box it has to fit into on this probe page',
      arabic: 'عرض خاص لشهر أكتوبر على جميع المنتجات المختارة في المتجر حتى نهاية الشهر',
    };
    const small = { x: 60, y: 200, width: 420, height: 90 };
    it.each([['latin'], ['arabic']] as const)(
      '%s: error blocks with text_overflow, clip warns with text_clipped, shrink_to_fit fits with no finding',
      async (key) => {
        const brand = BRANDS[key]();
        const text = long[key];
        const error = await renderProbe(brand, probe(brand, text, { overflow: 'error' }, small));
        const clip = await renderProbe(brand, probe(brand, text, { overflow: 'clip' }, small));
        const shrink = await renderProbe(brand, probe(brand, text, { overflow: 'shrink_to_fit' }, small));
        const fits = await renderProbe(
          brand,
          probe(brand, key === 'latin' ? 'Short' : 'قصير', { overflow: 'error' }, small),
        );
        expect(codes(error)).toContain('blocking:text_overflow');
        expect(codes(clip)).toContain('warning:text_clipped');
        expect(codes(clip)).not.toContain('blocking:text_overflow');
        expect(
          codes(shrink).filter((c) => c.endsWith('text_overflow') || c.endsWith('text_clipped')),
        ).toEqual([]);
        expect(codes(fits).filter((c) => c.endsWith('text_overflow'))).toEqual([]);
      },
      120_000,
    );
  });

  /**
   * Known gaps, recorded as expected failures (docs/spikes/editor-bake-off.md): each states the correct behaviour, so
   * the day the renderer (a MINOR renderer-version change) or Konva fixes it, the `fails` marker has to come off.
   */
  describe('known gaps (expected to fail until fixed)', () => {
    const word = 'مرحبا';
    const paragraph = 'خصم على كل الطلبات حتى نهاية الشهر التوصيل مجاني للطلبات فوق دولار';
    const wide = { x: 60, y: 200, width: 700, height: 200 };

    it.fails(
      'GAP: an Arabic run inside a Latin-first line with tracking is shaped (today it is drawn letter by letter, unjoined, in logical order)',
      async () => {
        const brand = BRANDS.latin();
        const tracked = await renderProbe(brand, probe(brand, `Autumn ${word}`, { tracking: 0.05 }));
        const unjoined = await renderProbe(
          brand,
          probe(brand, `Autumn ${[...word].join('\u200C')}`, { tracking: 0.05 }),
        );
        // Shaped text cannot be pixel-identical to the same letters with every join broken.
        expect(regionDiff(tracked.png, unjoined.png, BOX.x, BOX.x + BOX.width)).toBeGreaterThan(0.001);
      },
      120_000,
    );

    it.fails(
      'GAP: align=justify on an Arabic (RTL) paragraph is justified or at least right-aligned (today it draws left-aligned)',
      async () => {
        const brand = BRANDS.arabic();
        const style = { sizePx: 40 } as const;
        const justified = await renderProbe(
          brand,
          probe(brand, paragraph, { ...style, align: 'justify' }, wide),
        );
        const left = await renderProbe(brand, probe(brand, paragraph, { ...style, align: 'left' }, wide));
        expect(regionDiff(justified.png, left.png, wide.x, wide.x + wide.width, wide)).toBeGreaterThan(0.001);
      },
      120_000,
    );
  });

  describe('export determinism', () => {
    it.each(renderFixtures().map((f) => [f.key] as const))(
      '%s: two renders in fresh browser contexts are byte-identical',
      async (key) => {
        const fixture = renderFixtures().find((f) => f.key === key)!;
        const l = loaded.get(key)!;
        const input: RenderTargetInput = {
          document: fixture.document,
          page: fixture.document.pages[0]!,
          formatKey: fixture.formatKey,
          reflow: false,
          snapshot: fixture.snapshot,
          fonts: l.fonts,
          assets: l.assets,
        };
        const first = await renderer.render(input);
        const second = await renderer.render(input);
        expect(sha256(second.png)).toBe(sha256(first.png));
      },
      180_000,
    );
  });
});
