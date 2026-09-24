import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { renderFixtures, type RenderFixture } from '@oremedia/editor/renderer/fixtures';
import type { RenderInput } from '@oremedia/editor/renderer/protocol';
import { formatFor } from '@oremedia/editor/formats';
import { createChromiumRenderer, resolveRendererBundlePath, launchChromium } from './chromium-renderer';
import {
  ACTUAL_DIR,
  GOLDEN_DIR,
  comparePng,
  diffPng,
  generateFixtureAsset,
  loadFixtureFont,
} from './fixture-assets';

/**
 * Spec 19.5 golden renders. For each fixture brand (Latin/Karla and Arabic/Noto Naskh, fonts pinned in
 * tooling/test-fixtures/fonts) the worker path renders the document and is compared with the committed golden PNG;
 * the web path (the same bundle driving buildScene on a visible stage, captured with a Playwright screenshot) is
 * compared with the worker output. Threshold: at most 0.1 % of pixels may differ, a pixel differing when any channel
 * moves by more than 2. The first run, or OREMEDIA_UPDATE_GOLDENS=1, writes the goldens; every run writes the actual
 * renders (and a pixelmatch diff on mismatch) to tooling/test-fixtures/golden/.actual for inspection.
 * Requires OREMEDIA_CHROMIUM_PATH (the preinstalled Chromium build) and the renderer bundle
 * (pnpm --filter @oremedia/editor build:renderer).
 */
const MAX_DIFF_PERCENT = 0.1;
const CHANNEL_TOLERANCE = 2;
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

const executablePath = process.env['OREMEDIA_CHROMIUM_PATH'];

type Loaded = {
  fixture: RenderFixture;
  fonts: Array<{ family: string; mime: string; bytes: Buffer }>;
  assets: Array<{ assetVersionId: string; mime: string; bytes: Buffer }>;
};

const dataUrl = (mime: string, bytes: Buffer) => `data:${mime};base64,${bytes.toString('base64')}`;

/** The page-side view of the render-only bundle and the DOM it needs, typed minimally (this file has no DOM lib). */
interface FontFaceLike {
  load(): Promise<unknown>;
}
interface StudioGlobals {
  document: {
    fonts: { add(face: FontFaceLike): void; ready: Promise<unknown> };
    getElementById(id: string): unknown;
  };
  FontFace: new (family: string, source: string, descriptors: { weight: string }) => FontFaceLike;
  __oremediaRenderer: {
    Konva: {
      pixelRatio: number;
      Stage: new (config: { container: unknown; width: number; height: number }) => {
        add(layer: unknown): void;
      };
      Layer: new () => { draw(): void };
    };
    buildScene: (
      layer: unknown,
      page: RenderInput['page'],
      ctx: {
        format: RenderInput['format'];
        resolveAssetUrl(id: string): string | null;
        fontFamilyFor(ref: string): string | null;
        colourFor(token: string): string | null;
      },
    ) => { ready(): Promise<void>; metrics(): { elements: unknown[] } };
  };
}

/** The studio path: fonts, a visible stage, buildScene, draw (serialised by Playwright; casts are erased). */
const webPath = async (input: RenderInput) => {
  const g = globalThis as unknown as StudioGlobals;
  for (const f of input.fonts) {
    const face = new g.FontFace(f.family, `url(${f.url})`, { weight: '100 900' });
    g.document.fonts.add(face);
    await face.load();
  }
  await g.document.fonts.ready;
  const { Konva, buildScene } = g.__oremediaRenderer;
  Konva.pixelRatio = 1;
  const stage = new Konva.Stage({
    container: g.document.getElementById('stage'),
    width: input.format.width,
    height: input.format.height,
  });
  const layer = new Konva.Layer();
  stage.add(layer);
  const handle = buildScene(layer, input.page, {
    format: input.format,
    resolveAssetUrl: (id) => input.assets[id] ?? null,
    fontFamilyFor: (ref) => (input.fonts.some((f) => f.family === ref) ? ref : null),
    colourFor: (token) => input.colours[token] ?? null,
  });
  await handle.ready();
  layer.draw();
  return handle.metrics();
};

describe('golden renders (spec 19.5): worker path vs goldens, web path vs worker path', () => {
  const renderer = createChromiumRenderer({
    ...(executablePath ? { executablePath } : {}),
    timeoutMs: 120_000,
  });
  const loaded: Loaded[] = [];
  const workerPng = new Map<string, Buffer>();
  let browser: Browser | null = null;
  let bundle = '';

  beforeAll(async () => {
    await mkdir(ACTUAL_DIR, { recursive: true });
    bundle = await readFile(resolveRendererBundlePath(), 'utf8');
    for (const fixture of renderFixtures()) {
      loaded.push({
        fixture,
        fonts: await Promise.all(fixture.fonts.map(loadFixtureFont)),
        assets: await Promise.all(fixture.assets.map(generateFixtureAsset)),
      });
    }
  }, 180_000);
  afterAll(async () => {
    await renderer.close();
    await browser?.close();
  });

  const renderWorker = async (l: Loaded) => {
    const page = l.fixture.document.pages[0]!;
    return renderer.render({
      document: l.fixture.document,
      page,
      formatKey: l.fixture.formatKey,
      reflow: false,
      snapshot: l.fixture.snapshot,
      fonts: l.fonts,
      assets: l.assets,
    });
  };

  it.each(renderFixtures().map((f) => [f.key] as const))(
    '%s: the worker render matches its committed golden (≤ 0.1 % pixels, channel tolerance 2)',
    async (key) => {
      const l = loaded.find((x) => x.fixture.key === key)!;
      const out = await renderWorker(l);
      workerPng.set(key, out.png);
      const format = formatFor(l.fixture.formatKey)!;
      const actualPath = join(ACTUAL_DIR, `${key}.png`);
      await writeFile(actualPath, out.png);
      console.error(
        `${key}: ${out.png.length} bytes; findings ${JSON.stringify(out.findings.map((f) => `${f.severity}:${f.code}`))}`,
      );
      expect({ width: out.width, height: out.height }).toEqual({
        width: format.width,
        height: format.height,
      });
      // Fonts and assets were pinned and present, nothing fell back, and the fixture is brand-clean.
      expect(out.findings.filter((f) => f.code === 'missing_font' || f.code === 'missing_asset')).toEqual([]);
      expect(out.findings.filter((f) => f.severity === 'blocking')).toEqual([]);
      const goldenPath = join(GOLDEN_DIR, `${key}.png`);
      if (!existsSync(goldenPath) || process.env['OREMEDIA_UPDATE_GOLDENS'] === '1') {
        await writeFile(goldenPath, out.png);
        console.error(`golden written: ${goldenPath} (${out.png.length} bytes)`);
        return;
      }
      const golden = await readFile(goldenPath);
      const cmp = comparePng(golden, out.png, CHANNEL_TOLERANCE);
      if (cmp.differing > 0) {
        const diff = diffPng(golden, out.png);
        if (diff) await writeFile(join(ACTUAL_DIR, `${key}.diff.png`), diff);
      }
      console.error(`${key}: ${cmp.differing}/${cmp.total} pixels differ (${cmp.percent.toFixed(4)} %)`);
      expect(cmp.sameDimensions).toBe(true);
      expect(cmp.percent).toBeLessThanOrEqual(MAX_DIFF_PERCENT);
    },
    180_000,
  );

  it('the same fixture renders byte-identically in two fresh contexts (export hash stability)', async () => {
    const l = loaded[0]!;
    const first = workerPng.get(l.fixture.key) ?? (await renderWorker(l)).png;
    const second = (await renderWorker(l)).png;
    expect(sha256(second)).toBe(sha256(first));
    expect(second.equals(first)).toBe(true);
  }, 180_000);

  it.each(renderFixtures().map((f) => [f.key] as const))(
    '%s: the web path (bundle on a visible stage, Playwright screenshot) matches the worker export',
    async (key) => {
      const l = loaded.find((x) => x.fixture.key === key)!;
      const worker = workerPng.get(key) ?? (await renderWorker(l)).png;
      const format = formatFor(l.fixture.formatKey)!;
      browser ??= await launchChromium(executablePath);
      const context = await browser.newContext({
        offline: true,
        deviceScaleFactor: 1,
        viewport: { width: format.width + 40, height: format.height + 40 },
        locale: 'en-US',
        timezoneId: 'UTC',
        colorScheme: 'light',
      });
      try {
        const tab = await context.newPage();
        const errors: string[] = [];
        tab.on('pageerror', (e) => errors.push(e.message));
        await tab.setContent(
          '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#fff}#stage{position:absolute;left:20px;top:20px}</style></head><body><div id="stage"></div></body></html>',
        );
        await tab.addScriptTag({ content: bundle });
        const input: RenderInput = {
          page: l.fixture.document.pages[0]!,
          format,
          fonts: l.fonts.map((f) => ({ family: f.family, url: dataUrl(f.mime, f.bytes) })),
          assets: Object.fromEntries(l.assets.map((a) => [a.assetVersionId, dataUrl(a.mime, a.bytes)])),
          colours: Object.fromEntries(
            l.fixture.snapshot.document.tokens.colours.map((c) => [c.key, c.value]),
          ),
        };
        const metrics = await tab.evaluate(webPath, input);
        expect(errors).toEqual([]);
        expect(metrics.elements.length).toBeGreaterThan(0);
        const screenshot = await tab.locator('#stage canvas').first().screenshot({ type: 'png' });
        await writeFile(join(ACTUAL_DIR, `${key}.web.png`), screenshot);
        const cmp = comparePng(worker, screenshot, CHANNEL_TOLERANCE);
        if (cmp.differing > 0) {
          const diff = diffPng(worker, screenshot);
          if (diff) await writeFile(join(ACTUAL_DIR, `${key}.web.diff.png`), diff);
        }
        console.error(
          `${key} web vs worker: ${cmp.differing}/${cmp.total} pixels differ (${cmp.percent.toFixed(4)} %)`,
        );
        expect(cmp.sameDimensions).toBe(true);
        expect(cmp.percent).toBeLessThanOrEqual(MAX_DIFF_PERCENT);
      } finally {
        await context.close();
      }
    },
    180_000,
  );
});
