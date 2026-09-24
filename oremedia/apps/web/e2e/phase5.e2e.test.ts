import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { createMockHandler, E2E, MockBackend } from './mock-api';
import { P5 } from './mock-phase5';
import { startStaticServer } from './static-server';

/**
 * Phase 5 screens (spec 21.2 calendar/publishing and review inbox states, spec 5.6 portal) in the BUILT app
 * (apps/web/dist) against the in-process mock transport. Opt-in like the studio smoke (`OREMEDIA_E2E=1`); it
 * needs the mock's seeded states and backdoors, so it has no real-API mode (the studio suite's real mode seeds its
 * own document through the public contract, which these states cannot be reached through).
 */
const enabled = process.env['OREMEDIA_E2E'] === '1';
const dist = fileURLToPath(new URL('../dist', import.meta.url));
const chromiumPath = process.env['OREMEDIA_CHROMIUM_PATH'];
const launchOptions = chromiumPath
  ? { executablePath: chromiumPath, headless: true, args: ['--no-sandbox'] }
  : { channel: 'chromium' as const, headless: true, args: ['--no-sandbox'] };

const todayKey = () => new Date().toISOString().slice(0, 10);
const todayLocalInput = (hour: number) => `${todayKey()}T${String(hour).padStart(2, '0')}:00`;

describe.skipIf(!enabled)('phase 5 screens (built app in Chromium, mock transport)', () => {
  const backend = new MockBackend();
  const p5 = backend.phase5;
  let origin = '';
  let close: () => Promise<void> = async () => {};
  let browser: Browser;
  let page: Page;

  const brandPath = (rest: string) =>
    `/c/${encodeURIComponent(E2E.tenantId)}/b/${encodeURIComponent(E2E.brandId)}/${rest}`;
  const calendarPath = (publication?: string) =>
    `${brandPath('calendar')}?day=${todayKey()}${publication ? `&publication=${publication}` : ''}`;
  const detail = () => page.getByTestId('publication-detail');
  const portalUrl = (request: string, token: string, exp?: string) =>
    `${origin}/review-portal/#${new URLSearchParams({ request, token, ...(exp ? { exp } : {}) }).toString()}`;
  /** A reviewer opens a link fresh; a same-path navigation that differs only by fragment would not reload. */
  const openPortal = async (url: string) => {
    await page.goto('about:blank');
    await page.goto(url);
  };

  beforeAll(async () => {
    if (!existsSync(`${dist}/review-portal.html`))
      throw new Error(`build first: pnpm --filter @oremedia/web build (missing ${dist}/review-portal.html)`);
    const served = await startStaticServer({ dist, trpcHandler: createMockHandler(backend) });
    origin = served.origin;
    close = served.close;
    browser = await chromium.launch(launchOptions);
    // The mock brand is in UTC; the browser clock is pinned to UTC so datetime-local values read as instants.
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'UTC' });
    page = await context.newPage();
    page.on('pageerror', (err) => console.error('[page error]', err));
    await page.goto(`${origin}/sign-in`);
    await page.getByLabel('Session token').fill(E2E.token);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.waitForURL('**/portfolio*', { timeout: 15_000 });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await close();
  });

  // ---- calendar and publishing ----

  it('shows channels needing reconnection (token expiry) at the top of the calendar', async () => {
    await page.goto(`${origin}${calendarPath()}`);
    await expect.poll(() => page.getByTestId('channel-status').count(), { timeout: 15_000 }).toBe(1);
    const text = await page.getByTestId('channel-status').textContent();
    expect(text).toContain('Acme Instagram (instagram): Needs reconnecting');
    expect(text).toContain('Token expired');
    expect(text).toContain('channel_active');
    // Phone width: no horizontal overflow of the document.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflow).toBe(false);
  }, 30_000);

  it('lists the day’s publications with state chips as text', async () => {
    const list = page.getByTestId('day-list');
    await expect.poll(() => list.getByRole('button').count(), { timeout: 15_000 }).toBe(5);
    const text = await list.textContent();
    for (const label of ['Held', 'Outcome unknown', 'Dispatching', 'Published', 'Failed'])
      expect(text).toContain(label);
  }, 30_000);

  it('refuses to schedule a variant with invalid media and names the findings', async () => {
    await page.getByLabel('Channel variant id').fill(P5.variants.invalid);
    await page.getByRole('button', { name: 'Load variant' }).click();
    await expect.poll(() => page.getByTestId('variant-findings').count(), { timeout: 15_000 }).toBe(1);
    const findings = await page.getByTestId('variant-findings').textContent();
    expect(findings).toContain('12.4 MB');
    expect(findings).toContain('310 characters');
    expect(
      await page.getByRole('button', { name: 'Schedule', exact: true }).getAttribute('aria-disabled'),
    ).toBe('true');
  }, 30_000);

  it('schedule → the publication appears as Scheduled, and shows Published once the workflow reports it', async () => {
    await page.getByLabel('Channel variant id').fill(P5.variants.ok);
    await page.getByRole('button', { name: 'Load variant' }).click();
    await expect
      .poll(() => page.getByTestId('variant-preview').textContent(), { timeout: 15_000 })
      .toContain('Acme LinkedIn');
    await page.locator('#schedule-at').fill(todayLocalInput(16));
    await page.locator('#schedule-authority-id').fill(P5.approvalId);
    // The first attempt fails server-side; the retry is the same intent and must carry the same key (spec 7.3).
    p5.failNextSchedule = true;
    const schedules = () => backend.requests.filter((r) => r.path === 'publishing.publications.schedule');
    const before = schedules().length;
    await page.getByRole('button', { name: 'Schedule', exact: true }).click();
    await expect.poll(() => schedules().length, { timeout: 15_000 }).toBe(before + 1);
    await expect.poll(() => p5.failNextSchedule, { timeout: 15_000 }).toBe(false);
    expect(page.url()).not.toContain('publication=pub_');
    await page.getByRole('button', { name: 'Schedule', exact: true }).click();
    await expect.poll(() => page.url(), { timeout: 15_000 }).toContain('publication=pub_');
    const publicationId = decodeURIComponent(new URL(page.url()).searchParams.get('publication') ?? '');
    expect(publicationId).toMatch(/^pub_/);
    await expect
      .poll(() => detail().getByTestId('publication-state').textContent(), { timeout: 15_000 })
      .toContain('Scheduled');
    expect(await page.getByTestId('day-list').getByRole('button').count()).toBe(6);
    const [failed, retried] = schedules().slice(before);
    expect(typeof failed?.headers['idempotency-key']).toBe('string');
    expect(retried?.headers['idempotency-key']).toBe(failed?.headers['idempotency-key']);
    // The workflow publishes it.
    p5.transition(publicationId, {
      state: 'published',
      remotePostId: 'li_777',
      remoteUrl: 'https://linkedin.example/posts/777',
    });
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect
      .poll(() => detail().getByTestId('publication-state').textContent(), { timeout: 15_000 })
      .toContain('Published');
    expect(await detail().textContent()).toContain('https://linkedin.example/posts/777');
  }, 45_000);

  it('a held publication lists its release-check reasons verbatim', async () => {
    await page.goto(`${origin}${calendarPath(P5.publications.held)}`);
    await expect.poll(() => detail().getByTestId('hold-reasons').count(), { timeout: 15_000 }).toBe(1);
    const reasons = await detail().getByTestId('hold-reasons').textContent();
    expect(reasons).toContain('approval_matches');
    expect(reasons).toContain('facts_valid');
    expect(await detail().getByTestId('publication-state').textContent()).toContain('Held');
    expect(await detail().getByRole('button', { name: 'Release again' }).count()).toBe(1);
  }, 30_000);

  it('outcome_unknown explains itself and the reconcile action moves it on', async () => {
    await page.goto(`${origin}${calendarPath(P5.publications.unknown)}`);
    await expect
      .poll(() => detail().getByTestId('publication-state').textContent(), { timeout: 15_000 })
      .toContain('Outcome unknown');
    expect(await detail().textContent()).toContain('Nothing is re-sent until then');
    await detail().getByRole('button', { name: 'Reconcile' }).click();
    const dialog = page.getByRole('dialog', { name: 'Reconcile the outcome' });
    await expect.poll(() => dialog.count()).toBe(1);
    await dialog.getByLabel('What did you find?').click();
    await page.getByRole('option', { name: /definitely absent/ }).click();
    await dialog.getByRole('button', { name: 'Record resolution' }).click();
    await expect
      .poll(() => detail().getByTestId('publication-state').textContent(), { timeout: 15_000 })
      .toContain('Retry eligible');
    expect(p5.publication(P5.publications.unknown).state).toBe('retry_eligible');
    expect(await detail().getByRole('button', { name: 'Retry' }).count()).toBe(1);
  }, 45_000);

  it('cancel during dispatch reports the race honestly (prevented: false)', async () => {
    await page.goto(`${origin}${calendarPath(P5.publications.dispatching)}`);
    await expect
      .poll(() => detail().getByRole('button', { name: 'Request cancellation' }).count(), { timeout: 15_000 })
      .toBe(1);
    await detail().getByRole('button', { name: 'Request cancellation' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Request cancellation' }).click();
    await expect.poll(() => page.getByTestId('cancel-race').count(), { timeout: 15_000 }).toBe(1);
    const text = await page.getByTestId('cancel-race').textContent();
    expect(text).toContain('Dispatch already in progress; cancellation requested');
    expect(text).toContain('Dispatch in progress; outcome will be reconciled');
    expect(p5.publication(P5.publications.dispatching).state).toBe('dispatching');
  }, 45_000);

  it('a revision published on some channels and not others is shown per channel as partial success', async () => {
    await page.goto(`${origin}${calendarPath(P5.publications.published)}`);
    await expect
      .poll(() => page.getByTestId('channel-outcomes').textContent(), { timeout: 15_000 })
      .toContain('Partial success');
    const text = await page.getByTestId('channel-outcomes').textContent();
    expect(text).toContain('1 published, 1 failed, 1 pending of 3 channels.');
    const outcomes = page.getByRole('list', { name: 'Per-channel outcomes' });
    expect(await outcomes.textContent()).toContain('Acme X (x)');
    expect(await outcomes.textContent()).toContain('Acme Instagram (instagram)');
    expect(await outcomes.textContent()).toContain('Failed');
  }, 30_000);

  // ---- review inbox ----

  it('the inbox shows every attention flag as a text chip', async () => {
    await page.goto(`${origin}${brandPath('review')}`);
    const inbox = page.getByTestId('inbox');
    await expect.poll(() => inbox.getByRole('button').count(), { timeout: 15_000 }).toBe(6);
    const text = await inbox.textContent();
    for (const label of [
      'Awaiting decision',
      'Stale',
      'Changes requested',
      'Approval invalidated',
      'External access revoked',
      'Approved',
    ])
      expect(text).toContain(label);
    await page.getByTestId(`inbox-${P5.requests.stale}`).click();
    await expect
      .poll(() => page.getByTestId('request-detail').textContent(), { timeout: 15_000 })
      .toContain('a channel variant changed');
    await page.getByTestId(`inbox-${P5.requests.invalidated}`).click();
    await expect
      .poll(() => page.getByTestId('request-detail').textContent(), { timeout: 15_000 })
      .toContain('the content revision changed');
    await page.getByTestId(`inbox-${P5.requests.changes}`).click();
    await expect
      .poll(() => page.getByTestId('decisions').textContent(), { timeout: 15_000 })
      .toContain('Shorten the headline');
  }, 45_000);

  let reviewLink = '';

  it('creates an external reviewer link whose token is shown once and never again', async () => {
    await page.getByTestId(`inbox-${P5.requests.open}`).click();
    await expect.poll(() => page.getByTestId('manifest-hash').count(), { timeout: 15_000 }).toBe(1);
    await page.getByLabel('Reviewer email').fill('client@example.com');
    await page.getByRole('button', { name: 'Create link' }).click();
    await expect.poll(() => page.getByTestId('link-once').count(), { timeout: 15_000 }).toBe(1);
    reviewLink = await page.getByTestId('link-url').inputValue();
    expect(reviewLink).toContain(`/review-portal/#request=${P5.requests.open}&token=rl_`);
    const token = new URLSearchParams(new URL(reviewLink).hash.slice(1)).get('token') ?? '';
    expect(token.startsWith('rl_')).toBe(true);
    await page.getByRole('button', { name: 'I have shared it' }).click();
    await expect.poll(() => page.getByTestId('link-once').count()).toBe(0);
    await page.reload();
    await expect
      .poll(() => page.getByTestId('external-links').textContent(), { timeout: 15_000 })
      .toContain('client@example.com');
    expect(await page.locator('body').textContent()).not.toContain(token);
  }, 45_000);

  // ---- review portal ----

  it('the portal decides once from the rl_ token, then reports "already decided"', async () => {
    await openPortal(reviewLink);
    await expect
      .poll(() => page.getByTestId('portal-state').textContent(), { timeout: 15_000 })
      .toContain('Open');
    // The token left the address bar and nothing of the app's session is used.
    expect(page.url()).not.toContain('rl_');
    expect(await page.getByTestId('manifest-hash').textContent()).toBe(
      p5.request(P5.requests.open).manifestHash,
    );
    expect(await page.locator('body').textContent()).toContain('Autumn offer');
    await page.getByRole('button', { name: 'Approve' }).click();
    await expect.poll(() => page.getByTestId('portal-success').count(), { timeout: 15_000 }).toBe(1);
    const portalRequests = backend.requests.filter((r) => r.path === 'review.decisions.submit');
    const last = portalRequests.at(-1);
    expect(String(last?.headers['authorization'])).toMatch(/^Bearer rl_/);
    expect(last?.headers['x-oremedia-tenant']).toBeUndefined();
    expect(p5.request(P5.requests.open).state).toBe('decided');
    expect(p5.decisions.at(-1)?.verifiedEmail).toBe('client@example.com');
    await openPortal(reviewLink);
    await expect.poll(() => page.getByTestId('portal-decided').count(), { timeout: 15_000 }).toBe(1);
    expect(await page.getByTestId('decision-form').count()).toBe(0);
  }, 45_000);

  it('a revoked link is refused on its next request', async () => {
    const future = new Date(Date.now() + 5 * 86_400_000).toISOString();
    await openPortal(portalUrl(P5.requests.revoked, P5.links.active, future));
    await expect
      .poll(() => page.getByTestId('portal-state').textContent(), { timeout: 15_000 })
      .toContain('Open');
    await page.goto(`${origin}${brandPath('review')}?request=${P5.requests.revoked}`);
    await expect
      .poll(() => page.getByRole('button', { name: 'Revoke link for approver@client.example' }).count(), {
        timeout: 15_000,
      })
      .toBe(1);
    await page.getByRole('button', { name: 'Revoke link for approver@client.example' }).click();
    await expect
      .poll(() => page.getByTestId('external-links').textContent(), { timeout: 15_000 })
      .toContain('Revoked');
    await openPortal(portalUrl(P5.requests.revoked, P5.links.active, future));
    await expect.poll(() => page.getByTestId('portal-revoked').count(), { timeout: 15_000 }).toBe(1);
  }, 45_000);

  it('an expired link says so, and a stale request cannot be decided', async () => {
    const past = new Date(Date.now() - 2 * 86_400_000).toISOString();
    await openPortal(portalUrl(P5.requests.revoked, P5.links.expired, past));
    await expect.poll(() => page.getByTestId('portal-expired').count(), { timeout: 15_000 }).toBe(1);
    // Without the expiry in the link the server's refusal is all there is; the text claims no more than that.
    await openPortal(portalUrl(P5.requests.revoked, P5.links.expired));
    await expect.poll(() => page.getByTestId('portal-invalid').count(), { timeout: 15_000 }).toBe(1);
    // Stale: seed a link for the stale request and open it.
    p5.links.set('rl_id_stale', {
      id: 'rl_id_stale',
      reviewRequestId: P5.requests.stale,
      brandId: E2E.brandId,
      email: 'stale@client.example',
      token: 'rl_stale_link',
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      revokedAt: null,
      emailVerifiedAt: null,
      lastUsedAt: null,
    });
    await openPortal(portalUrl(P5.requests.stale, 'rl_stale_link'));
    await expect.poll(() => page.getByTestId('portal-stale').count(), { timeout: 15_000 }).toBe(1);
    expect(await page.getByTestId('portal-stale').textContent()).toContain('a channel variant changed');
    expect(await page.getByTestId('decision-form').count()).toBe(0);
  }, 45_000);

  it('an incomplete link is named as such', async () => {
    await openPortal(`${origin}/review-portal/`);
    await expect
      .poll(() => page.locator('body').textContent(), { timeout: 15_000 })
      .toContain('This link is incomplete');
  }, 30_000);
});
