import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser } from 'playwright';
import type { CreativePage, Element } from '@oremedia/contracts/creative';
import { ValidationFailedError } from '@oremedia/contracts/errors';
import { renderFixtures } from '@oremedia/editor/renderer/fixtures';
import {
  MAX_RENDER_PAGE_ELEMENTS,
  MAX_RENDER_TOTAL_ELEMENTS,
  createChromiumRenderer,
  launchChromium,
  openRenderContext,
} from './chromium-renderer';

/**
 * Spec 18 (upload/render → host or network): the worker refuses oversized input before Chromium starts, and the
 * render context has no egress at all. The network probe runs against a loopback server that counts every request
 * it receives; the page script tries every way a page can reach the network. Requires OREMEDIA_CHROMIUM_PATH (the
 * preinstalled Chromium build), like golden.integration.test.ts.
 */
const executablePath = process.env['OREMEDIA_CHROMIUM_PATH'];

/** The page-side globals the probe uses, typed minimally (this file has no DOM lib). */
interface Settles {
  onload: ((e: unknown) => void) | null;
  onerror: ((e: unknown) => void) | null;
}
interface PageGlobals {
  fetch(url: string): Promise<unknown>;
  XMLHttpRequest: new () => Settles & { open(method: string, url: string): void; send(): void };
  Image: new () => Settles & { src: string };
  WebSocket: new (url: string) => {
    onopen: ((e: unknown) => void) | null;
    onerror: ((e: unknown) => void) | null;
  };
  navigator: { sendBeacon(url: string, body: string): boolean };
  document: { createElement(tag: 'iframe'): { src: string }; body: { appendChild(node: unknown): void } };
}

const fixture = renderFixtures()[0]!;
const basePage = fixture.document.pages[0]!;
const leaf = basePage.elements.find((e) => e.type !== 'group')!;
const clone = (n: number): Element => ({
  ...leaf,
  id: `${leaf.id.slice(0, -6)}${String(n).padStart(6, '0')}`,
});
const renderInput = (page: CreativePage, formatKey = fixture.formatKey) => ({
  document: { ...fixture.document, pages: [page] },
  page,
  formatKey,
  reflow: false,
  snapshot: fixture.snapshot,
  fonts: [],
  assets: [],
});

describe('render refusals happen before Chromium launches', () => {
  afterEach(() => vi.restoreAllMocks());

  const refusal = async (page: CreativePage, maxEdgePx?: number) => {
    const launch = vi.spyOn(chromium, 'launch');
    const renderer = createChromiumRenderer({
      executablePath: '/nonexistent/chromium',
      ...(maxEdgePx ? { maxEdgePx } : {}),
    });
    const err = await renderer.render(renderInput(page)).then(
      () => new Error('rendered'),
      (e: unknown) => e,
    );
    expect(launch).not.toHaveBeenCalled();
    await renderer.close();
    expect(err).toBeInstanceOf(ValidationFailedError);
    return (err as ValidationFailedError).details;
  };

  it('a format larger than the render limit is refused with format_exceeds_render_limit', async () => {
    expect(await refusal(basePage, 1000)).toEqual([
      { path: 'formatKey', issue: 'format_exceeds_render_limit' },
    ]);
  });

  it(`a page with more than ${MAX_RENDER_PAGE_ELEMENTS} elements is refused with too_many_elements`, async () => {
    const elements = Array.from({ length: MAX_RENDER_PAGE_ELEMENTS + 1 }, (_, n) => clone(n));
    expect(await refusal({ ...basePage, elements })).toEqual([
      { path: 'page.elements', issue: 'too_many_elements' },
    ]);
  });

  it(`nested groups are counted: more than ${MAX_RENDER_TOTAL_ELEMENTS} elements in total is refused`, async () => {
    let n = 0;
    const group = (): Element => ({
      ...leaf,
      id: clone(n++).id,
      type: 'group',
      children: Array.from({ length: 200 }, () => clone(n++)),
    });
    const elements = Array.from({ length: Math.ceil(MAX_RENDER_TOTAL_ELEMENTS / 200) }, group);
    expect(elements.length).toBeLessThanOrEqual(MAX_RENDER_PAGE_ELEMENTS);
    expect(await refusal({ ...basePage, elements })).toEqual([
      { path: 'page.elements', issue: 'too_many_elements' },
    ]);
  });
});

describe('render context egress deny (Chromium)', () => {
  let browser: Browser;
  let server: Server;
  let base = '';
  const hits: string[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push(`${req.method} ${req.url}`);
      res.setHeader('access-control-allow-origin', '*');
      res.end('reachable');
    });
    server.on('upgrade', (req, socket) => {
      hits.push(`UPGRADE ${req.url}`);
      socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await launchChromium(executablePath);
  }, 120_000);
  afterAll(async () => {
    await browser?.close();
    await new Promise((resolve) => server?.close(resolve));
  });

  it('a page script cannot reach the network: fetch, XHR, image, WebSocket, beacon, iframe and navigation all fail', async () => {
    const context = await openRenderContext(browser, { width: 400, height: 400 }, 30_000);
    const failed: Array<{ url: string; error: string }> = [];
    context.on('requestfailed', (r) => failed.push({ url: r.url(), error: r.failure()?.errorText ?? '' }));
    try {
      const tab = await context.newPage();
      await tab.setContent('<!doctype html><html><body></body></html>');
      // Serialised by Playwright into the page; the casts keep this file free of DOM typings.
      const outcome = await tab.evaluate(async (origin: string) => {
        const g = globalThis as unknown as PageGlobals;
        const settle = (p: Promise<unknown>) =>
          Promise.race([
            p.then(
              () => 'reached',
              () => 'blocked',
            ),
            new Promise((r) => setTimeout(() => r('timeout'), 3000)),
          ]);
        const out: Record<string, unknown> = {};
        out['fetch'] = await settle(g.fetch(`${origin}/fetch`));
        out['xhr'] = await settle(
          new Promise((resolve, reject) => {
            const x = new g.XMLHttpRequest();
            x.onload = resolve;
            x.onerror = reject;
            x.open('GET', `${origin}/xhr`);
            x.send();
          }),
        );
        out['image'] = await settle(
          new Promise((resolve, reject) => {
            const i = new g.Image();
            i.onload = resolve;
            i.onerror = reject;
            i.src = `${origin}/image`;
          }),
        );
        out['websocket'] = await settle(
          new Promise((resolve, reject) => {
            const w = new g.WebSocket(origin.replace('http', 'ws') + '/ws');
            w.onopen = resolve;
            w.onerror = reject;
          }),
        );
        out['beacon'] = g.navigator.sendBeacon(`${origin}/beacon`, 'secret');
        const frame = g.document.createElement('iframe');
        frame.src = `${origin}/iframe`;
        g.document.body.appendChild(frame);
        await new Promise((r) => setTimeout(r, 500));
        return out;
      }, base);
      const navigation = await tab.goto(`${base}/navigate`).then(
        () => 'reached',
        () => 'blocked',
      );
      await new Promise((r) => setTimeout(r, 500));
      expect({ ...outcome, navigation }).toMatchObject({
        fetch: 'blocked',
        xhr: 'blocked',
        image: 'blocked',
        websocket: 'blocked',
        navigation: 'blocked',
      });
      // Offline emulation: nothing (including the WebSocket upgrade and the beacon, which routing does not see)
      // arrives at the server.
      expect(hits).toEqual([]);
      // Route abort: every routed request is refused by the client before it reaches the network stack.
      for (const path of ['/fetch', '/xhr', '/image'])
        expect(failed.find((f) => f.url === `${base}${path}`)?.error, path).toMatch(/ERR_BLOCKED_BY_CLIENT/);
    } finally {
      await context.close();
    }
  }, 120_000);
});
