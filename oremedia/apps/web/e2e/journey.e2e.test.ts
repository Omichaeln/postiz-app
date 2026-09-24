import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { createMockHandler, createSecondCompany, E2E, E2E_B, MockBackend } from './mock-api';
import { P5 } from './mock-phase5';
import { P6 } from './mock-phase6';
import { startStaticServer } from './static-server';

/**
 * Two-company end-to-end journey (ledger T.8; spec 19.1 "End-to-end: two companies; roles; create → review →
 * schedule; edit after approval invalidates; partial failure; restore and reconcile"). The BUILT app in Chromium at
 * phone width against the in-process mock transport, which serves company A and company B from separate stores and
 * routes every request by its X-Oremedia-Tenant header (mock-api.ts). People sign in with their own session tokens:
 * an agency user who belongs to both companies, a reviewer of company A, and a creator of company A restricted to
 * brand 1. Workflow outcomes (dispatch, the channel's answer, the release check) come from the mock's backdoors.
 * Opt-in like the other smokes (`OREMEDIA_E2E=1`); the steps depend on each other and run in order.
 */
const enabled = process.env['OREMEDIA_E2E'] === '1';
const dist = fileURLToPath(new URL('../dist', import.meta.url));
const chromiumPath = process.env['OREMEDIA_CHROMIUM_PATH'];
const launchOptions = chromiumPath
  ? { executablePath: chromiumPath, headless: true, args: ['--no-sandbox'] }
  : { channel: 'chromium' as const, headless: true, args: ['--no-sandbox'] };

const TOKENS = { agency: 'ses_agency', reviewer: 'ses_reviewer', creator: 'ses_creator' };
const BRAND_2 = { id: 'brd_e2e_2', name: 'Second brand' };
const dayKey = (offsetDays = 0) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
const localInput = (offsetDays: number, hour: number) =>
  `${dayKey(offsetDays)}T${String(hour).padStart(2, '0')}:00`;
const brandPath = (tenantId: string, brandId: string, rest: string) =>
  `/c/${encodeURIComponent(tenantId)}/b/${encodeURIComponent(brandId)}/${rest}`;
const pathA = (rest: string) => brandPath(E2E.tenantId, E2E.brandId, rest);
const pathB = (rest: string) => brandPath(E2E_B.tenantId, E2E_B.brandId, rest);

describe.skipIf(!enabled)('two-company journey (built app in Chromium, mock transport, phone width)', () => {
  const companyA = new MockBackend();
  const companyB = createSecondCompany();
  const p5 = companyA.phase5;
  let origin = '';
  let close: () => Promise<void> = async () => {};
  let browser: Browser;
  let page: Page;

  /** What the journey creates in company A; B must never show any of it. */
  const journey = {
    title: 'Journey launch post',
    copy: 'Lamps ship free this week',
    packageId: '',
    requestId: '',
    approvalId: '',
    variants: { linkedin: '', x: '' },
    publications: { linkedin: '', x: '', followUp: '' },
  };

  const open = async (path: string) => {
    await page.goto('about:blank');
    await page.goto(`${origin}${path}`);
  };
  const text = (testId: string) => page.getByTestId(testId).first().textContent();
  const signIn = async (token: string) => {
    await page.goto(`${origin}/sign-in`);
    await page.getByLabel('Session token').fill(token);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.waitForURL('**/portfolio*', { timeout: 15_000 });
  };
  const signOut = async () => {
    await page.getByRole('button', { name: 'Sign out' }).first().click();
    await page.waitForURL('**/sign-in*', { timeout: 15_000 });
  };
  const publicationState = () =>
    page.getByTestId('publication-detail').getByTestId('publication-state').textContent();
  /** Loads the variant (waiting for ITS channel in the preview, not a previous one), then schedules it. */
  const schedule = async (variantId: string, channelName: string, at: string) => {
    // Earlier confirmations sit over the bottom of a phone screen; dismiss them as a person would.
    for (const dismiss of await page.getByRole('button', { name: /^Dismiss: / }).all()) await dismiss.click();
    await page.getByLabel('Channel variant id').fill(variantId);
    await page.getByRole('button', { name: 'Load variant' }).click();
    await expect
      .poll(() => page.getByTestId('variant-preview').textContent(), { timeout: 15_000 })
      .toContain(channelName);
    await page.locator('#schedule-at').fill(at);
    await page.locator('#schedule-authority-id').fill(journey.approvalId);
    const before = new URL(page.url()).searchParams.get('publication');
    await page.getByRole('button', { name: 'Schedule', exact: true }).click();
    await expect
      .poll(() => new URL(page.url()).searchParams.get('publication'), { timeout: 15_000 })
      .not.toBe(before);
    const publicationId = new URL(page.url()).searchParams.get('publication') ?? '';
    expect(p5.publication(publicationId).channelVariantId).toBe(variantId);
    return publicationId;
  };

  beforeAll(async () => {
    if (!existsSync(`${dist}/index.html`))
      throw new Error(`build first: pnpm --filter @oremedia/web build (missing ${dist}/index.html)`);
    // Company A has a second brand; company B is a separate tenant served next to it for the same people.
    companyA.addBrand(BRAND_2.id, BRAND_2.name);
    companyA.addCompany(companyB);
    companyA.sessions.set(TOKENS.agency, {
      userId: 'usr_agency',
      memberships: {
        [E2E.tenantId]: { role: 'owner', brandIds: null },
        [E2E_B.tenantId]: { role: 'brand_manager', brandIds: null },
      },
    });
    companyA.sessions.set(TOKENS.reviewer, {
      userId: 'usr_reviewer',
      memberships: { [E2E.tenantId]: { role: 'reviewer', brandIds: null } },
    });
    companyA.sessions.set(TOKENS.creator, {
      userId: 'usr_creator',
      memberships: { [E2E.tenantId]: { role: 'creator', brandIds: [E2E.brandId] } },
    });
    const served = await startStaticServer({ dist, trpcHandler: createMockHandler(companyA) });
    origin = served.origin;
    close = served.close;
    browser = await chromium.launch(launchOptions);
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'UTC' });
    page = await context.newPage();
    page.on('pageerror', (err) => console.error('[page error]', err));
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await close();
  });

  it('an agency user signs in and sees both companies with their role in each', async () => {
    await signIn(TOKENS.agency);
    const companies = page.getByRole('list', { name: 'Companies' });
    await expect.poll(() => companies.getByRole('listitem').count(), { timeout: 15_000 }).toBe(2);
    const a = page.getByRole('region', { name: E2E.companyName });
    const b = page.getByRole('region', { name: E2E_B.companyName });
    expect(await a.textContent()).toContain('owner');
    expect(await b.textContent()).toContain('brand_manager');
    // Company A has two brands and the owner sees both.
    await a.getByRole('link', { name: 'Open' }).click();
    await expect
      .poll(() => page.getByRole('list', { name: 'Brands' }).getByRole('listitem').count(), {
        timeout: 15_000,
      })
      .toBe(2);
    await page.getByRole('region', { name: E2E.brandName }).getByRole('link', { name: 'Open' }).click();
    await expect.poll(() => page.url(), { timeout: 15_000 }).toContain(pathA('home'));
    expect(await page.getByLabel('Company').textContent()).toBe(E2E.companyName);
  }, 45_000);

  it('company A: create a package from an accepted brief and generate variants for two channels', async () => {
    await page
      .getByRole('navigation', { name: 'Brand sections' })
      .getByRole('link', { name: 'Campaigns' })
      .click();
    await page.getByTestId(`brief-${P6.briefs.accepted}`).click();
    await expect.poll(() => page.locator('#pkg-title').count(), { timeout: 15_000 }).toBe(1);
    await page.locator('#pkg-title').fill(journey.title);
    await page.locator('#pkg-copy').fill(journey.copy);
    await page.getByRole('button', { name: 'Create package' }).click();
    await expect
      .poll(() => new URL(page.url()).searchParams.get('package') ?? '', { timeout: 15_000 })
      .toMatch(/^pkg_/);
    journey.packageId = new URL(page.url()).searchParams.get('package') ?? '';
    const detail = page.getByTestId('package-detail');
    await expect.poll(() => text('revision-state'), { timeout: 15_000 }).toContain('Draft');
    expect(await detail.textContent()).toContain(journey.title);
    await detail.getByLabel(/Acme LinkedIn \(linkedin\)/).check();
    await detail.getByLabel(/Acme X \(x\)/).check();
    await detail.getByRole('button', { name: 'Generate variants' }).click();
    await expect.poll(() => detail.getByTestId('variant').count(), { timeout: 15_000 }).toBe(2);
    expect(await detail.locator('[data-testid="variant"][data-variant-valid="false"]').count()).toBe(0);
    for (const [key, name] of [
      ['linkedin', 'Acme LinkedIn'],
      ['x', 'Acme X'],
    ] as const) {
      const row = detail.getByTestId('variant').filter({ hasText: name });
      journey.variants[key] = (await row.locator('code').first().textContent()) ?? '';
      expect(journey.variants[key]).toMatch(/^cv_/);
    }
  }, 45_000);

  it('company A: request review freezes the revision and its variants', async () => {
    const detail = page.getByTestId('package-detail');
    await detail.getByLabel('Planned publish time').fill(localInput(0, 20));
    await detail.getByRole('button', { name: 'Request review' }).click();
    await expect.poll(() => page.getByTestId('review-requested').count(), { timeout: 15_000 }).toBe(1);
    await expect.poll(() => text('revision-state'), { timeout: 15_000 }).toContain('In review');
    const href =
      (await page.getByRole('link', { name: 'Open in the review inbox' }).getAttribute('href')) ?? '';
    journey.requestId = new URL(href, origin).searchParams.get('request') ?? '';
    expect(journey.requestId).toMatch(/^rr_/);
    const request = p5.request(journey.requestId);
    expect(request.state).toBe('open');
    expect(request.requestedById).toBe('usr_agency');
    expect(request.frozenManifest.captions.map((c) => c.channelConnectionId).sort()).toEqual(
      [P5.channels.ok, P5.channels.two].sort(),
    );
  }, 45_000);

  it('a reviewer of company A approves it from the inbox; the approval names the frozen manifest', async () => {
    await signOut();
    await signIn(TOKENS.reviewer);
    await open(pathA(`review?request=${encodeURIComponent(journey.requestId)}`));
    await expect.poll(() => page.getByTestId('decision-form').count(), { timeout: 15_000 }).toBe(1);
    expect(await text('manifest')).toContain(journey.copy);
    await page.getByTestId('decision-form').getByRole('button', { name: 'Approve' }).click();
    await expect
      .poll(() => page.getByTestId('request-detail').textContent(), { timeout: 15_000 })
      .toMatch(/Approval apr_\w+ binds this exact package/);
    journey.approvalId = /Approval (apr_\w+)/.exec((await text('request-detail')) ?? '')?.[1] ?? '';
    expect(journey.approvalId).toMatch(/^apr_/);
    expect(await page.getByTestId(`inbox-${journey.requestId}`).textContent()).toContain('Approved');
    const decision = p5.decisions.at(-1);
    expect(decision).toMatchObject({
      reviewRequestId: journey.requestId,
      decision: 'approve',
      deciderId: 'usr_reviewer',
    });
    expect(p5.approvals.find((a) => a.id === journey.approvalId)?.state).toBe('valid');
  }, 45_000);

  it('the agency user schedules the approved revision to two channels', async () => {
    await signOut();
    await signIn(TOKENS.agency);
    await open(pathA(`calendar?day=${dayKey(0)}`));
    await expect.poll(() => page.getByLabel('Channel variant id').count(), { timeout: 15_000 }).toBe(1);
    journey.publications.linkedin = await schedule(
      journey.variants.linkedin,
      'Acme LinkedIn',
      localInput(0, 20),
    );
    journey.publications.x = await schedule(journey.variants.x, 'Acme X', localInput(0, 20));
    for (const id of [journey.publications.linkedin, journey.publications.x]) {
      expect(id).toMatch(/^pub_/);
      expect(p5.publication(id)).toMatchObject({
        state: 'scheduled',
        approvalId: journey.approvalId,
        scheduledById: 'usr_agency',
      });
    }
    await expect.poll(publicationState, { timeout: 15_000 }).toContain('Scheduled');
  }, 45_000);

  it('dispatch: one channel fails, the other is outcome_unknown and is reconciled in the UI; partial failure per channel', async () => {
    // The workflow's side: X rejects the post; LinkedIn's worker is lost after sending.
    p5.transition(journey.publications.x, { state: 'failed', stateReason: 'rejected' });
    p5.transition(journey.publications.linkedin, {
      state: 'outcome_unknown',
      stateReason: 'worker_lost',
      fencingToken: 1,
    });
    await open(pathA(`calendar?day=${dayKey(0)}&publication=${journey.publications.linkedin}`));
    await expect.poll(publicationState, { timeout: 15_000 }).toContain('Outcome unknown');
    const detail = page.getByTestId('publication-detail');
    expect(await detail.textContent()).toContain('Nothing is re-sent until then');
    await detail.getByRole('button', { name: 'Reconcile' }).click();
    const dialog = page.getByRole('dialog', { name: 'Reconcile the outcome' });
    await dialog.getByLabel('What did you find?').click();
    await page.getByRole('option', { name: /confirm published/ }).click();
    await dialog.getByLabel('Remote post id').fill('li_journey_1');
    await dialog.getByRole('button', { name: 'Record resolution' }).click();
    await expect.poll(publicationState, { timeout: 15_000 }).toContain('Published');
    expect(p5.publication(journey.publications.linkedin)).toMatchObject({
      state: 'published',
      remotePostId: 'li_journey_1',
      stateReason: 'human_confirmed',
    });
    await expect
      .poll(() => page.getByTestId('channel-outcomes').textContent(), { timeout: 15_000 })
      .toContain('Partial success');
    expect(await text('channel-outcomes')).toContain('1 published, 1 failed of 2 channels.');
    const outcomes = await page.getByRole('list', { name: 'Per-channel outcomes' }).textContent();
    expect(outcomes).toContain('Acme LinkedIn (linkedin)');
    expect(outcomes).toContain('Acme X (x)');
    expect(outcomes).toContain('Failed');
    // The day list carries each state as text next to its channel.
    const day = await text('day-list');
    expect(day).toContain(journey.publications.x);
    expect(day).toContain('Failed');
  }, 45_000);

  it('a post-approval edit invalidates the approval: the inbox says so and a later release is held (approval_matches)', async () => {
    // A follow-up slot tomorrow under the same approval, scheduled before the edit.
    await page.getByTestId('publication-detail').waitFor();
    journey.publications.followUp = await schedule(
      journey.variants.linkedin,
      'Acme LinkedIn',
      localInput(1, 10),
    );
    // The edit: the next revision of the approved package.
    await open(
      pathA(`campaigns?brief=${P6.briefs.accepted}&package=${encodeURIComponent(journey.packageId)}`),
    );
    await expect.poll(() => text('revision-state'), { timeout: 15_000 }).toContain('Approved');
    const detail = page.getByTestId('package-detail');
    await detail.getByLabel('Master copy').fill(`${journey.copy} and next`);
    await detail.getByRole('button', { name: 'Create next revision' }).click();
    await expect.poll(() => text('revision-state'), { timeout: 15_000 }).toContain('Draft');
    expect(await text('revision-history')).toContain('Superseded');
    expect(p5.approvals.find((a) => a.id === journey.approvalId)).toMatchObject({
      state: 'invalidated',
      invalidatedReason: 'content_revision_changed',
    });
    // Inbox: the request shows approval_invalidated as text, and the detail explains it.
    await open(pathA(`review?request=${encodeURIComponent(journey.requestId)}`));
    const item = page.getByTestId(`inbox-${journey.requestId}`);
    await expect.poll(() => item.textContent(), { timeout: 15_000 }).toContain('Approval invalidated');
    expect(await item.textContent()).not.toMatch(/✓\s*Approved/);
    await expect
      .poll(() => page.getByTestId('request-detail').textContent(), { timeout: 15_000 })
      .toContain(
        `Approval ${journey.approvalId} no longer releases anything because the content revision changed`,
      );
    // The workflow reaches tomorrow's slot: the release check recomputes the binding and holds it.
    p5.releaseDue(journey.publications.followUp);
    await open(pathA(`calendar?day=${dayKey(1)}&publication=${journey.publications.followUp}`));
    await expect.poll(publicationState, { timeout: 15_000 }).toContain('Held');
    const reasons = await page.getByTestId('publication-detail').getByTestId('hold-reasons').textContent();
    expect(reasons).toContain('approval_matches');
    expect(reasons).toContain('The approved package no longer matches what would be published.');
  }, 60_000);

  it('switching to company B shows none of company A’s rows on any screen', async () => {
    const requestsBefore = companyB.requests.length;
    await open('/portfolio');
    await page.getByRole('region', { name: E2E_B.companyName }).getByRole('link', { name: 'Open' }).click();
    const brands = page.getByRole('list', { name: 'Brands' });
    await expect.poll(() => brands.getByRole('listitem').count(), { timeout: 15_000 }).toBe(1);
    expect(await brands.textContent()).toContain(E2E_B.brandName);
    expect(await brands.textContent()).not.toContain(E2E.brandName);
    expect(await brands.textContent()).not.toContain(BRAND_2.name);
    await brands.getByRole('link', { name: 'Open' }).click();
    await expect.poll(() => page.url(), { timeout: 15_000 }).toContain(pathB('home'));

    /** Anything of company A: names, seeded rows, and every id the journey created. */
    const aMarkers = [
      E2E.companyName,
      E2E.brandName,
      BRAND_2.name,
      'Acme',
      journey.title,
      journey.copy,
      journey.packageId,
      journey.requestId,
      journey.approvalId,
      journey.variants.linkedin,
      journey.variants.x,
      ...Object.values(journey.publications),
      ...Object.values(P5.publications),
      ...Object.values(P5.requests),
      'Spring launch',
      'Winter clearance',
      'Autumn offer',
      'Qualified enquiries fell',
      'Do you ship to Ireland?',
      'Landing page B',
      'run_e2e_copy',
    ];
    const screens: Array<[string, string, string]> = [
      // [route, a marker that B's own content is shown, what the screen is]
      ['home', E2E_B.brandName, 'brand home'],
      [`calendar?day=${dayKey(0)}`, 'Nothing scheduled on this day', 'calendar'],
      ['review', 'No review requests', 'review inbox'],
      ['agents', 'layout', 'agents'],
      ['intelligence', 'No data yet', 'intelligence'],
      ['campaigns', 'Beta harvest', 'campaigns'],
      ['settings', 'Beta LinkedIn', 'settings'],
    ];
    for (const [route, own, name] of screens) {
      await open(pathB(route));
      await expect
        .poll(() => page.locator('body').textContent(), {
          timeout: 15_000,
          message: `${name} shows company B`,
        })
        .toContain(own);
      await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), undefined, {
        timeout: 15_000,
      });
      const body = (await page.locator('body').textContent()) ?? '';
      expect(await page.getByLabel('Company').textContent()).toBe(E2E_B.companyName);
      for (const marker of aMarkers) expect(body, `${name} must not show "${marker}"`).not.toContain(marker);
    }
    // The portfolio lists the person's own memberships, never another company's rows.
    await open('/portfolio');
    await expect
      .poll(() => page.getByRole('list', { name: 'Companies' }).getByRole('listitem').count(), {
        timeout: 15_000,
      })
      .toBe(2);
    const portfolio = (await page.locator('main').textContent()) ?? '';
    for (const marker of aMarkers.filter((m) => m !== E2E.companyName))
      expect(portfolio, `portfolio must not show "${marker}"`).not.toContain(marker);
    // Every request B's screens made carried B's tenant, and company A's ids are unknown there.
    expect(companyB.requests.length).toBeGreaterThan(requestsBefore);
    expect(
      companyB.requests.slice(requestsBefore).every((r) => r.headers['x-oremedia-tenant'] === E2E_B.tenantId),
    ).toBe(true);
    await open(pathB(`calendar?day=${dayKey(0)}&publication=${journey.publications.linkedin}`));
    await expect
      .poll(
        () =>
          page.getByTestId('publication-detail').locator('[data-error-code]').getAttribute('data-error-code'),
        { timeout: 15_000 },
      )
      .toBe('NOT_FOUND');
    // Company A's brand under company B's address does not exist there.
    await open(brandPath(E2E_B.tenantId, E2E.brandId, 'calendar'));
    await expect
      .poll(() => page.locator('main [data-error-code]').first().getAttribute('data-error-code'), {
        timeout: 15_000,
      })
      .toBe('NOT_FOUND');
  }, 90_000);

  it('a creator restricted to brand 1 sees only it; brand 2’s routes are NOT_FOUND', async () => {
    await signOut();
    await signIn(TOKENS.creator);
    const companies = page.getByRole('list', { name: 'Companies' });
    await expect.poll(() => companies.getByRole('listitem').count(), { timeout: 15_000 }).toBe(1);
    expect(await companies.textContent()).toContain('creator');
    expect(await companies.textContent()).toContain('Selected brands');
    expect(await companies.textContent()).not.toContain(E2E_B.companyName);
    await open(`/c/${encodeURIComponent(E2E.tenantId)}`);
    const brands = page.getByRole('list', { name: 'Brands' });
    await expect.poll(() => brands.getByRole('listitem').count(), { timeout: 15_000 }).toBe(1);
    expect(await brands.textContent()).toContain(E2E.brandName);
    expect(await brands.textContent()).not.toContain(BRAND_2.name);
    // Brand 1 opens.
    await open(pathA('home'));
    await expect
      .poll(() => page.getByRole('heading', { level: 1 }).textContent(), { timeout: 15_000 })
      .toBe(E2E.brandName);
    // Every brand-2 route is NOT_FOUND (the server never confirms the brand exists), with no brand data rendered.
    for (const route of ['home', 'calendar', 'review', 'campaigns', 'settings', 'agents']) {
      await open(brandPath(E2E.tenantId, BRAND_2.id, route));
      const error = page.locator('main [data-error-code]').first();
      await expect
        .poll(() => error.getAttribute('data-error-code'), { timeout: 15_000, message: route })
        .toBe('NOT_FOUND');
      expect(await error.textContent()).toContain('Brand not found');
      expect(await page.locator('body').textContent()).not.toContain(BRAND_2.name);
    }
    // Company B is not the creator's: its address is refused.
    await open(pathB('home'));
    await expect
      .poll(() => page.locator('main [data-error-code]').first().getAttribute('data-error-code'), {
        timeout: 15_000,
      })
      .toBe('FORBIDDEN');
  }, 90_000);
});
