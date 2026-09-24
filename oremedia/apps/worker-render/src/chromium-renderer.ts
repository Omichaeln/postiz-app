import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type LaunchOptions } from 'playwright';
import sharp from 'sharp';
import type { FormatRenderer, RenderTargetInput, RenderTargetOutput } from '@oremedia/activities';
import { NotFoundError } from '@oremedia/contracts/errors';
import { runRenderChecks } from '@oremedia/editor/checks';
import { formatFor } from '@oremedia/editor/formats';
import { reflow } from '@oremedia/editor/reduce';
import type { RenderInput, RenderOutput } from '@oremedia/editor/renderer/protocol';
import { RENDERER_VERSION } from '@oremedia/editor/renderer/version';
import { logger } from '@oremedia/observability';

/**
 * Spec 11.5: headless Chromium loads the render-only bundle of packages/editor/src/renderer (the same Konva scene
 * code the studio uses) with pinned fonts and assets injected as data: URLs. Render isolation: one fresh, offline
 * browser context per render (no network at all: the worker's only egress is the object store, and that happens in
 * the activity, not in the page), a hard per-render timeout, no credential in reach of the page.
 */
export interface ChromiumRendererOptions {
  /** OREMEDIA_CHROMIUM_PATH: the Playwright image ships its browser; tests point at the preinstalled build. */
  executablePath?: string;
  /** OREMEDIA_RENDERER_BUNDLE: overrides where dist/renderer.iife.js is read from. */
  bundlePath?: string;
  /** Hard limit for one render (fonts, drawing, encoding); default 60 s. */
  timeoutMs?: number;
  /** Largest format edge the worker accepts, so an oversized document cannot exhaust the container. */
  maxEdgePx?: number;
}

export interface ChromiumRenderer extends FormatRenderer {
  readonly version: string;
  close(): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_EDGE_PX = 4096;
const PAGE_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#fff}</style></head><body></body></html>';

/** Container-safe launch arguments; no sandbox flags (the Playwright image runs as pwuser with the sandbox on). */
const LAUNCH_ARGS = ['--disable-dev-shm-usage'];

/** dist/renderer.iife.js: next to the worker bundle in production, the editor's dist folder in development. */
export function resolveRendererBundlePath(explicit?: string): string {
  const candidates = [
    explicit,
    process.env['OREMEDIA_RENDERER_BUNDLE'],
    join(dirname(fileURLToPath(import.meta.url)), 'renderer.iife.js'),
  ];
  try {
    const versionModule = createRequire(import.meta.url).resolve('@oremedia/editor/renderer/version');
    candidates.push(resolve(dirname(versionModule), '../../dist/renderer.iife.js'));
  } catch {
    // Production bundle: the editor package is inlined and not resolvable; the sibling file is the source.
  }
  const found = candidates.find((c): c is string => Boolean(c) && existsSync(c as string));
  if (!found)
    throw new Error(
      'renderer bundle not found: run `pnpm --filter @oremedia/editor build:renderer` (or set OREMEDIA_RENDERER_BUNDLE)',
    );
  return found;
}

const dataUrl = (mime: string, bytes: Buffer) => `data:${mime};base64,${bytes.toString('base64')}`;

/** What the render-only bundle installs on the page's global (packages/editor/src/renderer/entry.ts). */
interface RendererGlobal {
  __oremediaRender(input: RenderInput): Promise<RenderOutput>;
}

export function createChromiumRenderer(opts: ChromiumRendererOptions = {}): ChromiumRenderer {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxEdge = opts.maxEdgePx ?? DEFAULT_MAX_EDGE_PX;
  let browser: Browser | null = null;
  let bundle: string | null = null;
  const log = () => logger().child('chromium-renderer');

  const launch = async (): Promise<Browser> => {
    if (browser?.isConnected()) return browser;
    const launchOptions: LaunchOptions = { headless: true, args: LAUNCH_ARGS };
    const executablePath = opts.executablePath ?? process.env['OREMEDIA_CHROMIUM_PATH'];
    if (executablePath) launchOptions.executablePath = executablePath;
    browser = await chromium.launch(launchOptions);
    log().info({ status: browser.version() }, 'chromium launched');
    return browser;
  };

  const loadBundle = async (): Promise<string> => {
    if (bundle === null) bundle = await readFile(resolveRendererBundlePath(opts.bundlePath), 'utf8');
    return bundle;
  };

  return {
    version: RENDERER_VERSION,

    async render(input: RenderTargetInput): Promise<RenderTargetOutput> {
      const format = formatFor(input.formatKey);
      if (!format) throw new NotFoundError('FormatDefinition', input.formatKey);
      if (format.width > maxEdge || format.height > maxEdge)
        throw new Error(`format ${format.key} exceeds the ${maxEdge}px render limit`);
      const page = input.reflow ? reflow(input.page, format.key, format.width, format.height) : input.page;
      const browserInput: RenderInput = {
        page,
        format,
        fonts: input.fonts.map((f) => ({ family: f.family, url: dataUrl(f.mime, f.bytes) })),
        assets: Object.fromEntries(input.assets.map((a) => [a.assetVersionId, dataUrl(a.mime, a.bytes)])),
        colours: Object.fromEntries(input.snapshot.document.tokens.colours.map((c) => [c.key, c.value])),
      };

      const [b, code] = await Promise.all([launch(), loadBundle()]);
      const context = await b.newContext({
        offline: true,
        deviceScaleFactor: 1,
        viewport: { width: Math.min(format.width, 1600), height: Math.min(format.height, 1600) },
        locale: 'en-US',
        timezoneId: 'UTC',
        colorScheme: 'light',
        reducedMotion: 'reduce',
        javaScriptEnabled: true,
      });
      context.setDefaultTimeout(timeoutMs);
      let timer: NodeJS.Timeout | undefined;
      try {
        await context.route('**/*', (route) => route.abort('blockedbyclient'));
        const tab = await context.newPage();
        const pageErrors: string[] = [];
        tab.on('pageerror', (err) => pageErrors.push(err.message));
        await tab.setContent(PAGE_HTML, { waitUntil: 'load' });
        await tab.addScriptTag({ content: code });
        const hardTimeout = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`render exceeded ${timeoutMs}ms`)), timeoutMs);
        });
        // The page function is serialised by Playwright; the cast (erased at compile time) keeps this file free of
        // DOM typings while calling exactly the bundle's public entry.
        const out = await Promise.race([
          tab.evaluate(
            (i: RenderInput) => (globalThis as unknown as RendererGlobal).__oremediaRender(i),
            browserInput,
          ),
          hardTimeout,
        ]);
        if (pageErrors.length) throw new Error(`renderer page errors: ${pageErrors.join('; ')}`);
        if (out.rendererVersion !== RENDERER_VERSION)
          throw new Error(`renderer bundle ${out.rendererVersion} does not match worker ${RENDERER_VERSION}`);
        const comma = out.dataUrl.indexOf(',');
        if (!out.dataUrl.startsWith('data:image/png;base64,') || comma < 0)
          throw new Error('renderer returned no PNG');
        const png = Buffer.from(out.dataUrl.slice(comma + 1), 'base64');
        const meta = await sharp(png).metadata();
        if (meta.format !== 'png' || !meta.width || !meta.height)
          throw new Error('renderer output is not a PNG');
        const validation = runRenderChecks({
          doc: input.document,
          page,
          format,
          metrics: out.metrics,
          snapshot: input.snapshot,
          output: { width: meta.width, height: meta.height, bytes: png.length },
          ...(input.limits ? { limits: input.limits } : {}),
        });
        return { png, width: meta.width, height: meta.height, findings: validation.findings };
      } finally {
        if (timer) clearTimeout(timer);
        await context.close();
      }
    },

    async close() {
      const b = browser;
      browser = null;
      await b?.close();
    },
  };
}
