import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { auditPage, dialogFocusTrap, formatViolations, keyboardPath } from './a11y';
import { createMockHandler, E2E, MockBackend } from './mock-api';
import { P5 } from './mock-phase5';
import { P6 } from './mock-phase6';
import { startStaticServer } from './static-server';

/**
 * Accessibility audit (ledger F.5; spec 21.3 WCAG 2.2 AA for the application chrome, colour never the only carrier
 * of status, a keyboard path for every action). Every screen of the BUILT app is audited in light and dark themes at
 * 390 px and 1280 px against the in-process mock transport, each in a state that shows its richest content (a
 * selected publication with per-channel outcomes, an open review request, a run, a package with findings, …). The
 * audit is apps/web/e2e/a11y.ts (axe-core is not installed in this workspace). Opt-in like the other smokes
 * (`OREMEDIA_E2E=1`).
 */
const enabled = process.env['OREMEDIA_E2E'] === '1';
const dist = fileURLToPath(new URL('../dist', import.meta.url));
const chromiumPath = process.env['OREMEDIA_CHROMIUM_PATH'];
const launchOptions = chromiumPath
  ? { executablePath: chromiumPath, headless: true, args: ['--no-sandbox'] }
  : { channel: 'chromium' as const, headless: true, args: ['--no-sandbox'] };

const todayKey = () => new Date().toISOString().slice(0, 10);
const brandPath = (rest: string) =>
  `/c/${encodeURIComponent(E2E.tenantId)}/b/${encodeURIComponent(E2E.brandId)}/${rest}`;

interface Screen {
  name: string;
  path: () => string;
  /** The screen shows its content (not a skeleton). */
  ready: (page: Page) => Promise<unknown>;
}

describe.skipIf(!enabled)('accessibility audit (built app in Chromium, mock transport)', () => {
  const backend = new MockBackend();
  let documentId = '';
  let origin = '';
  let close: () => Promise<void> = async () => {};
  let browser: Browser;

  const testId = (page: Page, id: string) => page.getByTestId(id).first().waitFor({ timeout: 15_000 });
  const SCREENS: Screen[] = [
    {
      name: 'portfolio',
      path: () => '/portfolio',
      ready: (page) => page.getByRole('list', { name: 'Companies' }).waitFor({ timeout: 15_000 }),
    },
    {
      name: 'company',
      path: () => `/c/${encodeURIComponent(E2E.tenantId)}`,
      ready: (page) => page.getByRole('list', { name: 'Brands' }).waitFor({ timeout: 15_000 }),
    },
    {
      name: 'brand home',
      path: () => brandPath('home'),
      ready: (page) =>
        page.getByRole('heading', { level: 1, name: E2E.brandName }).waitFor({ timeout: 15_000 }),
    },
    {
      name: 'brand system',
      path: () => brandPath('system'),
      ready: (page) => page.getByRole('heading', { level: 1 }).waitFor({ timeout: 15_000 }),
    },
    {
      name: 'assets',
      path: () => brandPath('assets'),
      ready: (page) => page.getByRole('heading', { level: 1 }).waitFor({ timeout: 15_000 }),
    },
    {
      name: 'studio',
      path: () => brandPath(`studio/${encodeURIComponent(documentId)}`),
      ready: (page) => testId(page, 'document-title'),
    },
    {
      name: 'calendar',
      path: () => brandPath(`calendar?day=${todayKey()}&publication=${P5.publications.published}`),
      ready: (page) => testId(page, 'channel-outcomes'),
    },
    {
      name: 'review inbox',
      path: () => brandPath(`review?request=${P5.requests.open}`),
      ready: (page) => testId(page, 'manifest-hash'),
    },
    {
      name: 'agents',
      path: () => brandPath('agents?run=run_e2e_copy'),
      ready: (page) =>
        page.locator('[data-testid="run-detail"][data-run-state="completed"]').waitFor({ timeout: 15_000 }),
    },
    {
      name: 'intelligence',
      path: () => brandPath('intelligence'),
      ready: (page) => testId(page, 'anomaly'),
    },
    {
      name: 'experiments',
      path: () => brandPath(`experiments?experiment=${P6.experiments.breach}`),
      ready: (page) => testId(page, 'experiment-result'),
    },
    {
      name: 'campaigns',
      path: () => brandPath(`campaigns?brief=${P6.briefs.accepted}&package=${P6.packages.review}`),
      ready: (page) => testId(page, 'revision-state'),
    },
    {
      name: 'settings',
      path: () => brandPath('settings'),
      ready: (page) => testId(page, `channel-${P5.channels.expired}`),
    },
    {
      name: 'review portal',
      path: () =>
        `/review-portal/#${new URLSearchParams({
          request: P5.requests.revoked,
          token: P5.links.active,
          exp: new Date(Date.now() + 5 * 86_400_000).toISOString(),
        }).toString()}`,
      ready: (page) => testId(page, 'portal-state'),
    },
  ];

  /** A fresh navigation (a fragment-only change would not reload), then the content and no pending skeleton. */
  const open = async (page: Page, screen: Screen) => {
    await page.goto('about:blank');
    await page.goto(`${origin}${screen.path()}`);
    await screen.ready(page);
    await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), undefined, {
      timeout: 15_000,
    });
  };

  const signedIn = async (
    theme: 'light' | 'dark',
    width: number,
  ): Promise<{ context: BrowserContext; page: Page }> => {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      colorScheme: theme,
      timezoneId: 'UTC',
      reducedMotion: 'reduce',
    });
    // The theme is a per-device preference (apps/web/src/lib/theme.ts); set it before any page script runs.
    await context.addInitScript((t) => {
      try {
        localStorage.setItem('oremedia.theme', t);
      } catch {
        // storage blocked: the colour scheme preference still applies
      }
    }, theme);
    const page = await context.newPage();
    page.on('pageerror', (err) => console.error('[page error]', err));
    await page.goto(`${origin}/sign-in`);
    await page.getByLabel('Session token').fill(E2E.token);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.waitForURL('**/portfolio*', { timeout: 15_000 });
    return { context, page };
  };

  beforeAll(async () => {
    if (!existsSync(`${dist}/index.html`))
      throw new Error(`build first: pnpm --filter @oremedia/web build (missing ${dist}/index.html)`);
    documentId = backend.createDocument('Accessibility poster').id;
    const served = await startStaticServer({ dist, trpcHandler: createMockHandler(backend) });
    origin = served.origin;
    close = served.close;
    browser = await chromium.launch(launchOptions);
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await close();
  });

  it('the audit is not vacuous: every rule fires on a fixture page with one seeded violation each', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 700 } });
    const page = await context.newPage();
    await page.setContent(`
      <main><h1>One</h1><h1>Two</h1><h2>Section</h2><h4>Skipped a level</h4>
        <button><span aria-hidden="true">×</span></button>
        <input type="text">
        <div><span class="text-status-critical" aria-hidden="true" style="color:#b2271f">●</span></div>
        <p style="color:#999999;background:#ffffff">Low contrast text</p>
        <a href="#x" tabindex="3">Jumps the order</a>
        <span aria-describedby="nowhere">Dangling reference</span>
        <div role="dialog">Unnamed dialog</div>
        <p><button style="all:unset;display:inline-block;width:10px;height:10px">a</button><button style="all:unset;display:inline-block;width:10px;height:10px">b</button></p>
        <div style="width:800px">Too wide for a phone</div>
        <div style="cursor:pointer" onclick="void 0">Pointer only</div>
        <button id="ring-less" style="outline:none">No focus ring</button>
        <button id="covered">Under a banner</button>
      </main><main>Second main</main>
      <div style="position:fixed;inset:0 0 auto 0;height:100vh;background:#fff;pointer-events:auto" data-cover></div>`);
    // The cover is placed over #covered only (the rest of the page stays hit-testable).
    await page.evaluate(() => {
      const r = document.getElementById('covered')?.getBoundingClientRect();
      const cover = document.querySelector<HTMLElement>('[data-cover]');
      if (r && cover)
        Object.assign(cover.style, {
          top: `${r.top - 4}px`,
          left: '0',
          height: `${r.height + 8}px`,
          width: '100%',
        });
    });
    const rules = new Set((await auditPage(page, { narrow: true })).map((v) => v.rule));
    for (const rule of [
      'single-h1',
      'heading-order',
      'accessible-name',
      'form-label',
      'status-colour-only',
      'contrast',
      'positive-tabindex',
      'aria-reference',
      'dialog-label',
      'target-size',
      'reflow',
      'landmarks',
    ])
      expect(rules, rule).toContain(rule);
    const keyboard = await keyboardPath(page);
    expect(keyboard.unreached.map((v) => v.detail).join('\n')).toContain('Pointer only');
    expect(keyboard.invisibleFocus.map((v) => v.selector).join('\n')).toContain('#ring-less');
    expect(
      keyboard.invisibleFocus.filter((v) => v.rule === 'focus-obscured').map((v) => v.selector),
    ).toContain('button#covered');
    await context.close();
  }, 45_000);

  for (const theme of ['light', 'dark'] as const)
    for (const width of [390, 1280])
      describe(`${theme} theme at ${width} px`, () => {
        let context: BrowserContext;
        let page: Page;
        beforeAll(async () => {
          ({ context, page } = await signedIn(theme, width));
        }, 60_000);
        afterAll(async () => {
          await context?.close();
        });

        it.each(SCREENS.map((s) => [s.name, s] as const))(
          '%s: zero violations',
          async (name, screen) => {
            await open(page, screen);
            expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe(
              theme,
            );
            const violations = await auditPage(page, { narrow: width <= 400 });
            expect(violations, formatViolations(`${name} (${theme}, ${width}px)`, violations)).toEqual([]);
          },
          45_000,
        );
      });

  for (const width of [390, 1280])
    describe(`keyboard path at ${width} px (every pointer action is reached by Tab, focus visible and not obscured)`, () => {
      let context: BrowserContext;
      let page: Page;
      beforeAll(async () => {
        ({ context, page } = await signedIn('light', width));
      }, 60_000);
      afterAll(async () => {
        await context?.close();
      });

      it.each(SCREENS.map((s) => [s.name, s] as const))(
        '%s',
        async (name, screen) => {
          await open(page, screen);
          const result = await keyboardPath(page);
          console.info(
            `[a11y] ${name}: ${result.actions.length} keyboard actions in ${result.stops} Tab stops\n  ${result.actions.join('\n  ')}`,
          );
          expect(result.actions.length).toBeGreaterThan(0);
          expect(result.unreached, formatViolations(`${name} keyboard reach`, result.unreached)).toEqual([]);
          expect(
            result.invisibleFocus,
            formatViolations(`${name} focus visible`, result.invisibleFocus),
          ).toEqual([]);
        },
        90_000,
      );
    });

  describe('dialogs trap focus, are named and pass the audit', () => {
    let context: BrowserContext;
    let page: Page;
    beforeAll(async () => {
      ({ context, page } = await signedIn('dark', 390));
    }, 60_000);
    afterAll(async () => {
      await context?.close();
    });

    it('reconcile dialog (calendar)', async () => {
      await open(page, {
        name: 'calendar',
        path: () => brandPath(`calendar?day=${todayKey()}&publication=${P5.publications.unknown}`),
        ready: (p) => p.getByRole('button', { name: 'Reconcile' }).waitFor({ timeout: 15_000 }),
      });
      await page.getByRole('button', { name: 'Reconcile' }).focus();
      await page.keyboard.press('Enter');
      await page.getByRole('dialog', { name: 'Reconcile the outcome' }).waitFor();
      const violations = [...(await auditPage(page, { narrow: true })), ...(await dialogFocusTrap(page))];
      expect(violations, formatViolations('reconcile dialog', violations)).toEqual([]);
      await page.keyboard.press('Escape');
      await expect.poll(() => page.getByRole('dialog').count()).toBe(0);
      // Focus returns to the control that opened it.
      expect(await page.evaluate(() => document.activeElement?.textContent)).toContain('Reconcile');
    }, 45_000);

    it('disconnect confirmation (settings)', async () => {
      await open(page, {
        name: 'settings',
        path: () => brandPath('settings'),
        ready: (p) => p.getByTestId(`channel-${P5.channels.ok}`).waitFor({ timeout: 15_000 }),
      });
      await page.getByTestId(`channel-${P5.channels.ok}`).getByRole('button', { name: 'Disconnect' }).focus();
      await page.keyboard.press('Enter');
      await page.getByRole('alertdialog').waitFor();
      const violations = [...(await auditPage(page, { narrow: true })), ...(await dialogFocusTrap(page))];
      expect(violations, formatViolations('disconnect dialog', violations)).toEqual([]);
      await page.keyboard.press('Escape');
      await expect.poll(() => page.getByRole('alertdialog').count()).toBe(0);
    }, 45_000);
  });
});
