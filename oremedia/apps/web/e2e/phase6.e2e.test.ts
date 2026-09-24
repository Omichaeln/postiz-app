import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { createMockHandler, E2E, MockBackend } from './mock-api';
import { P5 } from './mock-phase5';
import { P6 } from './mock-phase6';
import { startStaticServer } from './static-server';

/**
 * Phase 6 screens (spec 16.9 intelligence workspace, 16.6 experiments, 13 campaigns and briefs, 14.7 channel
 * settings; spec 21.2 required states) in the BUILT app at phone width against the in-process mock transport.
 * Opt-in like the other smokes (`OREMEDIA_E2E=1`); the states come from mock-phase6.ts seeds and backdoors.
 */
const enabled = process.env['OREMEDIA_E2E'] === '1';
const dist = fileURLToPath(new URL('../dist', import.meta.url));
const chromiumPath = process.env['OREMEDIA_CHROMIUM_PATH'];
const launchOptions = chromiumPath
  ? { executablePath: chromiumPath, headless: true, args: ['--no-sandbox'] }
  : { channel: 'chromium' as const, headless: true, args: ['--no-sandbox'] };

describe.skipIf(!enabled)('phase 6 screens (built app in Chromium, mock transport, phone width)', () => {
  const backend = new MockBackend();
  const p6 = backend.phase6;
  let origin = '';
  let close: () => Promise<void> = async () => {};
  let browser: Browser;
  let page: Page;

  const brandPath = (rest: string) =>
    `/c/${encodeURIComponent(E2E.tenantId)}/b/${encodeURIComponent(E2E.brandId)}/${rest}`;
  const open = async (rest: string) => {
    await page.goto('about:blank');
    await page.goto(`${origin}${brandPath(rest)}`);
  };
  const text = (testId: string) => page.getByTestId(testId).first().textContent();
  const count = (testId: string) => page.getByTestId(testId).count();
  const noHorizontalOverflow = () =>
    page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
  const requestsTo = (path: string) => backend.requests.filter((r) => r.path === path);

  beforeAll(async () => {
    if (!existsSync(`${dist}/index.html`))
      throw new Error(`build first: pnpm --filter @oremedia/web build (missing ${dist}/index.html)`);
    const served = await startStaticServer({ dist, trpcHandler: createMockHandler(backend) });
    origin = served.origin;
    close = served.close;
    browser = await chromium.launch(launchOptions);
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

  // ---- intelligence workspace (spec 16.9; spec 21.2 intelligence states) ----

  it('loading, then What changed with freshness, coverage, partial coverage and anomalies as text and table', async () => {
    // The workspace itself is prefetched by the route loader; the anomalies below it load in the screen.
    backend.delays.set('intelligence.anomalies.list', 1_500);
    await open('intelligence');
    await expect
      .poll(() => page.getByRole('status').filter({ hasText: 'Loading anomalies' }).count(), {
        timeout: 15_000,
      })
      .toBe(1);
    backend.delays.delete('intelligence.anomalies.list');
    await expect.poll(() => count('what-changed'), { timeout: 15_000 }).toBe(1);
    const changed = await text('what-changed');
    expect(changed).toContain('Fetched');
    expect(changed).toContain('h ago');
    expect(changed).toContain('Coverage');
    expect(changed).toContain('sources: qualified_enquiries, reach');
    expect(changed).toContain('no competitor monitoring');
    expect(changed).toContain('missing snapshots are reported as gaps, never as zero');
    expect(await count('coverage-partial')).toBe(1);
    expect(await count('stale')).toBe(0);
    await expect.poll(() => count('anomaly'), { timeout: 15_000 }).toBe(1);
    const anomaly = await text('anomaly');
    expect(anomaly).toContain('High severity');
    expect(anomaly).toContain('complaints');
    const table = page.getByTestId('anomaly').getByRole('table');
    expect(await table.textContent()).toContain('baseline2');
    expect(await table.textContent()).toContain('observed9');
    expect(await noHorizontalOverflow()).toBe(true);
  }, 45_000);

  it('What we learned separates hypotheses from experimentally supported findings, with customer voice', async () => {
    await page.getByRole('tab', { name: 'What we learned' }).click();
    await expect.poll(() => count('what-we-learned'), { timeout: 15_000 }).toBe(1);
    const learned = await text('what-we-learned');
    expect(learned).toContain('Hypothesis');
    expect(learned).toContain('Posts with a price in the first frame');
    expect(learned).toContain('Observations and hypotheses are not findings');
    const findings = await text('findings');
    expect(findings).toContain('Finding');
    expect(findings).toContain('Experimentally supported');
    expect(findings).not.toContain('Posts with a price');
    await expect.poll(() => count('cluster'), { timeout: 15_000 }).toBe(1);
    expect(await text('cluster')).toContain('Question');
    expect(await text('cluster')).toContain('14 messages');
    expect(await text('voice')).toContain('not a representative measure of market demand');
  }, 30_000);

  it('What to do next ranks recommendations with exactly their actions; accepting creates the brief', async () => {
    await page.getByRole('tab', { name: 'What to do next' }).click();
    await expect.poll(() => count('recommendation'), { timeout: 15_000 }).toBe(3);
    const next = await text('what-to-do-next');
    expect(next).toContain('Ranking policy: baseline.');
    expect(next).toContain('Fetched');
    const first = page.getByTestId('recommendation').first();
    expect(await first.textContent()).toContain('#1');
    const actions = first.getByRole('group', { name: /Actions for/ }).getByRole('button');
    expect(await actions.allTextContents()).toEqual(['Create brief', 'Dismiss']);
    await first.getByRole('button', { name: 'Create brief' }).click();
    await first.getByLabel('Audience').fill('Customers abroad');
    await first.getByLabel('Message').fill('We ship to Ireland');
    await first.getByRole('button', { name: 'Accept: Create brief' }).click();
    await expect.poll(() => page.getByTestId('recommendation-accepted').count(), { timeout: 15_000 }).toBe(1);
    expect(p6.recommendations.get(P6.recommendations.brief)?.state).toBe('accepted');
    const briefId = p6.recommendations.get(P6.recommendations.brief)?.downstreamId ?? '';
    expect(await text('recommendation-accepted')).toContain(briefId);
    await page.getByTestId('recommendation-accepted').getByRole('link', { name: 'Open' }).click();
    await expect.poll(() => page.url(), { timeout: 15_000 }).toContain(`campaigns?brief=${briefId}`);
    await expect.poll(() => text('brief-state'), { timeout: 15_000 }).toContain('Awaiting acceptance');
    expect(await text('brief-detail')).toContain(P6.recommendations.brief);
    expect(await text('brief-detail')).toContain('Suggested plan');
  }, 45_000);

  it('dismiss needs a reason, which is sent with the decision', async () => {
    await open('intelligence?view=next');
    await expect.poll(() => count('recommendation'), { timeout: 15_000 }).toBe(2);
    const card = page.getByTestId('recommendation').filter({ hasText: 'Test price-first carousels' });
    await card.getByRole('button', { name: 'Dismiss' }).click();
    const submit = card.locator('form').getByRole('button', { name: 'Dismiss' });
    expect(await submit.getAttribute('aria-disabled')).toBe('true');
    await card.getByLabel('Reason for dismissing').fill('We ran this test last quarter');
    await submit.click();
    await expect
      .poll(() => p6.recommendations.get(P6.recommendations.test)?.state, { timeout: 15_000 })
      .toBe('dismissed');
    expect(p6.recommendations.get(P6.recommendations.test)?.dismissalReason).toBe(
      'We ran this test last quarter',
    );
    // The decided card stays with its outcome after the workspace refreshes.
    await expect
      .poll(() => card.getAttribute('data-recommendation-state'), { timeout: 15_000 })
      .toBe('dismissed');
    expect(await card.textContent()).toContain('Dismissed');
    expect(typeof requestsTo('intelligence.recommendations.dismiss').at(-1)?.headers['idempotency-key']).toBe(
      'string',
    );
  }, 30_000);

  it('no objective: ranking is refused and the page links to set one', async () => {
    const objective = p6.objective;
    p6.objective = null;
    await open('intelligence?view=next');
    await expect.poll(() => count('no-objective'), { timeout: 15_000 }).toBe(1);
    expect(await text('no-objective')).toContain('recommendations are not ranked');
    const link = page.getByTestId('no-objective').getByRole('link', { name: 'Set an objective' });
    expect(await link.getAttribute('href')).toBe(brandPath('system'));
    expect(await text('what-to-do-next')).toContain('Unranked list.');
    expect(await text('what-to-do-next')).not.toContain('#1');
    p6.objective = objective;
  }, 30_000);

  it('analyse now shows the running state until the analyst writes its insights', async () => {
    await open('intelligence');
    await expect.poll(() => count('what-changed'), { timeout: 15_000 }).toBe(1);
    await page.getByLabel('Analyst principal').fill(P6.principalId);
    await page.getByRole('button', { name: 'Analyse now' }).click();
    await expect.poll(() => count('analysis-running'), { timeout: 15_000 }).toBe(1);
    expect(await text('analysis-running')).toContain('brand-analyst:');
    expect(p6.pendingAnalysis).not.toBeNull();
    p6.completeAnalysis();
    await expect.poll(() => count('analysis-running'), { timeout: 20_000 }).toBe(0);
    expect(await text('what-changed')).toContain('Saves rose 18%');
  }, 45_000);

  it('stale snapshots are marked with text next to the numbers', async () => {
    p6.makeStale();
    await open('intelligence');
    await expect.poll(() => count('stale'), { timeout: 15_000 }).toBeGreaterThan(0);
    expect(await page.getByTestId('stale').first().textContent()).toContain('Stale');
    expect(await text('what-changed')).toContain('d ago');
  }, 30_000);

  it('the playbook shows reconsider-by dates and lets an approver approve a proposal', async () => {
    await open('intelligence?view=playbook');
    await expect.poll(() => count('playbook-approved'), { timeout: 15_000 }).toBe(1);
    const approved = await text('playbook-approved');
    expect(approved).toContain('Reply to product questions within four hours.');
    expect(approved).toContain('reconsider by');
    expect(approved).toContain('Due for review');
    const proposed = page.getByTestId('playbook-proposed');
    await expect
      .poll(() => proposed.getByRole('button', { name: 'Approve' }).count(), { timeout: 15_000 })
      .toBe(1);
    await proposed.getByRole('button', { name: 'Approve' }).click();
    await expect
      .poll(() => p6.playbook.get(P6.playbook.proposed)?.state, { timeout: 15_000 })
      .toBe('approved');
    await expect
      .poll(() => text('playbook-approved'), { timeout: 15_000 })
      .toContain('Use customer photos on Fridays.');
  }, 45_000);

  it('a role without playbook.approve sees no approve control, only why', async () => {
    backend.role = 'analyst';
    p6.playbook.set('pbe_other', {
      ...(p6.playbook.get(P6.playbook.approved) as NonNullable<ReturnType<typeof p6.playbook.get>>),
      id: 'pbe_other',
      practice: 'Post a behind-the-scenes photo each week.',
      state: 'proposed',
      approvedByUserId: null,
    });
    await page.reload();
    await open('intelligence?view=playbook');
    const proposed = page.getByTestId('playbook-proposed');
    await expect
      .poll(() => proposed.textContent(), { timeout: 15_000 })
      .toContain('Post a behind-the-scenes photo each week.');
    expect(await proposed.getByRole('button', { name: 'Approve' }).count()).toBe(0);
    expect(await proposed.textContent()).toContain('Approval needs a person with playbook.approve');
    backend.role = 'owner';
  }, 30_000);

  it('permission denied and a failed load are distinct states with a retry', async () => {
    backend.denied.add('intelligence.workspace.get');
    await open('intelligence');
    await expect
      .poll(() => page.getByRole('status').filter({ hasText: 'Permission denied' }).count(), {
        timeout: 15_000,
      })
      .toBe(1);
    expect(await page.locator('main').textContent()).toContain('intelligence.workspace.get');
    backend.denied.delete('intelligence.workspace.get');
    // Once for the route loader's prefetch, once for the screen's own read.
    backend.failNext.set('intelligence.workspace.get', 2);
    await open('intelligence');
    await expect
      .poll(() => page.getByRole('alert').filter({ hasText: 'Something went wrong' }).count(), {
        timeout: 15_000,
      })
      .toBe(1);
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect.poll(() => count('what-changed'), { timeout: 15_000 }).toBe(1);
  }, 45_000);

  it('no data: every view says so instead of estimating (empty recommendations too)', async () => {
    p6.clearAnalysis();
    await open('intelligence');
    await expect.poll(() => text('what-changed'), { timeout: 15_000 }).toContain('No data yet');
    expect(await text('what-changed')).toContain('No analysis has run for this brand yet');
    await page.getByRole('tab', { name: 'What to do next' }).click();
    await expect.poll(() => text('what-to-do-next'), { timeout: 15_000 }).toContain('No recommendations');
  }, 30_000);

  // ---- experiments (spec 16.6) ----

  it('lists experiments with state chips and the mode label as text', async () => {
    await open('experiments');
    await expect.poll(() => page.getByTestId(/^experiment-exp_/).count(), { timeout: 15_000 }).toBe(5);
    const list = await text('experiments');
    for (const label of ['Designed', 'Running', 'Analysed', 'Structured comparison', 'Randomised'])
      expect(list).toContain(label);
    expect(list).toContain('directional; not causal');
    expect(await noHorizontalOverflow()).toBe(true);
  }, 30_000);

  it('create, pre-register (frozen hash shown), start and stop', async () => {
    await page.getByLabel('Hypothesis').fill('A question hook lifts enquiries');
    await page.getByLabel('Primary metric key').fill('qualified_enquiries');
    await page.locator('#x-v0-revision').fill(P5.revisions.one);
    await page.locator('#x-v1-revision').fill(P5.revisions.two);
    await page.getByRole('button', { name: 'Create draft' }).click();
    await expect.poll(() => page.url(), { timeout: 15_000 }).toMatch(/experiment=exp_/);
    await expect.poll(() => text('experiment-state'), { timeout: 15_000 }).toContain('Designed');
    expect(await text('design-hash')).toContain('not frozen yet');
    await page.getByRole('button', { name: 'Pre-register (freeze design)' }).click();
    await expect.poll(() => text('experiment-state'), { timeout: 15_000 }).toContain('Pre-registered');
    expect(await text('design-hash')).toMatch(/[0-9a-f]{64}/);
    expect(await count('design-frozen')).toBe(1);
    await page.getByRole('button', { name: 'Start' }).click();
    await expect.poll(() => text('experiment-state'), { timeout: 15_000 }).toContain('Running');
    await page.getByLabel('Stop reason (optional)').fill('Budget moved');
    await page.getByRole('button', { name: 'Stop' }).click();
    await expect.poll(() => text('experiment-state'), { timeout: 15_000 }).toContain('Stopped');
  }, 45_000);

  it('results show the verdict and the conclusion label; a guardrail breach is not supported', async () => {
    await open(`experiments?experiment=${P6.experiments.supported}`);
    await expect.poll(() => count('experiment-result'), { timeout: 15_000 }).toBe(1);
    expect(await page.getByTestId('experiment-result').getAttribute('data-verdict')).toBe('supported');
    expect(await text('experiment-result')).toContain('Supported');
    expect(await text('experiment-result')).toContain('Difference +');
    expect(await text('experiment-result')).toContain('95% interval');
    await open(`experiments?experiment=${P6.experiments.inconclusive}`);
    await expect
      .poll(() => text('conclusion-label'), { timeout: 15_000 })
      .toContain('directional; not causal');
    expect(await text('experiment-result')).toContain('Inconclusive');
    await open(`experiments?experiment=${P6.experiments.breach}`);
    await expect.poll(() => count('guardrail-breach'), { timeout: 15_000 }).toBe(1);
    expect(await text('guardrail-breach')).toContain('Guardrail breached: complaints');
    expect(await text('experiment-result')).toContain('Not supported');
  }, 45_000);

  it('no result before the sample and window: the refusal is explained', async () => {
    await open(`experiments?experiment=${P6.experiments.running}`);
    await expect
      .poll(() => text('results'), { timeout: 15_000 })
      .toContain('No result before the sample and window');
    const variants = p6.experiment(P6.experiments.running).variants;
    await page.locator(`#obs-${variants[0]?.id}-n`).fill('12');
    await page.locator(`#obs-${variants[0]?.id}-x`).fill('2');
    await page.locator(`#obs-${variants[1]?.id}-n`).fill('10');
    await page.locator(`#obs-${variants[1]?.id}-x`).fill('1');
    await page.getByRole('button', { name: 'Compute results' }).click();
    await expect.poll(() => count('results-refused'), { timeout: 15_000 }).toBe(1);
    const refused = await text('results-refused');
    expect(refused).toContain('The observation window has not ended');
    expect(refused).toContain('below the pre-registered minimum of 30 per arm');
  }, 30_000);

  it('a changed design is rejected as the API returns it', async () => {
    p6.changeDesign(P6.experiments.running);
    await page.getByRole('button', { name: 'Compute results' }).click();
    await expect.poll(() => count('design-changed'), { timeout: 15_000 }).toBe(1);
    const changed = await text('design-changed');
    expect(changed).toContain('Results are computed only against the pre-registered design');
    expect(changed).toContain('changed after pre-registration');
  }, 30_000);

  // ---- campaigns and briefs (spec 13, 21.2 campaign planner) ----

  it('campaigns show missed dates; a new campaign starts empty', async () => {
    await open('campaigns');
    await expect.poll(() => count(`campaign-${P6.campaigns.missed}`), { timeout: 15_000 }).toBe(1);
    expect(await text(`campaign-${P6.campaigns.missed}`)).toContain('Missed date');
    expect(await text(`campaign-${P6.campaigns.spring}`)).not.toContain('Missed date');
    await page.getByLabel('Campaign name').fill('Summer');
    await page.getByLabel('Starts').fill('2026-06-01T09:00');
    await page.getByLabel('Ends').fill('2026-06-30T18:00');
    await page.getByRole('button', { name: 'Create campaign' }).click();
    await expect.poll(() => page.url(), { timeout: 15_000 }).toMatch(/campaign=cmp_/);
    await expect.poll(() => text('briefs'), { timeout: 15_000 }).toContain('No briefs yet');
    expect(await noHorizontalOverflow()).toBe(true);
  }, 45_000);

  it('a brief awaiting acceptance is accepted, keeping its intent key across a failed attempt', async () => {
    await open(`campaigns?brief=${P6.briefs.awaiting}`);
    await expect.poll(() => count('brief-awaiting'), { timeout: 15_000 }).toBe(1);
    backend.failNext.set('content.briefs.accept', 1);
    const before = requestsTo('content.briefs.accept').length;
    await page.getByRole('button', { name: 'Accept brief' }).click();
    await expect.poll(() => requestsTo('content.briefs.accept').length, { timeout: 15_000 }).toBe(before + 1);
    await expect
      .poll(() => text('brief-detail'), { timeout: 15_000 })
      .toContain('The brief was not accepted');
    await page.getByRole('button', { name: 'Accept brief' }).click();
    await expect.poll(() => text('brief-state'), { timeout: 15_000 }).toContain('Accepted');
    const [failed, retried] = requestsTo('content.briefs.accept').slice(before);
    expect(typeof failed?.headers['idempotency-key']).toBe('string');
    expect(retried?.headers['idempotency-key']).toBe(failed?.headers['idempotency-key']);
    expect(p6.brief(P6.briefs.awaiting).state).toBe('accepted');
  }, 45_000);

  it('suggested and incomplete briefs are labelled with what is missing', async () => {
    await open(`campaigns?brief=${P6.briefs.suggested}`);
    await expect.poll(() => text('brief-detail'), { timeout: 15_000 }).toContain('Suggested plan');
    expect(await text('brief-awaiting')).toContain('suggested, not written by a person');
    await open(`campaigns?brief=${P6.briefs.incomplete}`);
    await expect.poll(() => count('brief-incomplete'), { timeout: 15_000 }).toBe(1);
    expect(await text('brief-incomplete')).toContain('Missing: audience, channels');
  }, 30_000);

  it('packages show revision states, superseded history and invalid variants with findings', async () => {
    await open(`campaigns?brief=${P6.briefs.accepted}&package=${P6.packages.review}`);
    await expect.poll(() => text('revision-state'), { timeout: 15_000 }).toContain('In review');
    expect(await text('revision-history')).toContain('Superseded');
    const invalid = page.locator('[data-testid="variant"][data-variant-valid="false"]');
    await expect.poll(() => invalid.count(), { timeout: 15_000 }).toBe(1);
    expect(await invalid.textContent()).toContain('Invalid');
    expect(await invalid.textContent()).toContain('caption is 310 characters; the channel allows 280');
    expect(await text('package-detail')).toContain('Needs reconnecting');
    await page.getByTestId(`package-${P6.packages.changes}`).click();
    await expect.poll(() => text('revision-state'), { timeout: 15_000 }).toContain('Changes requested');
    expect(await text('revision-detail')).toContain('revise the package');
    await page.getByTestId(`package-${P6.packages.approved}`).click();
    await expect.poll(() => text('revision-state'), { timeout: 15_000 }).toContain('Approved');
  }, 45_000);

  it('generate variants: one per channel, the invalid one lists its finding', async () => {
    const detail = page.getByTestId('package-detail');
    await expect.poll(() => detail.getByLabel(/Acme X \(x\)/).count(), { timeout: 15_000 }).toBe(1);
    await detail.getByLabel(/Acme X \(x\)/).check();
    await detail.getByLabel(/Acme LinkedIn \(linkedin\)/).check();
    await detail.getByRole('button', { name: 'Generate variants' }).click();
    await expect.poll(() => count('variants-generated'), { timeout: 15_000 }).toBe(1);
    expect(await text('variants-generated')).toContain('2 variants generated');
    await expect.poll(() => detail.getByTestId('variant').count(), { timeout: 15_000 }).toBe(2);
    const invalid = detail.locator('[data-testid="variant"][data-variant-valid="false"]');
    expect(await invalid.textContent()).toContain('caption is 34 characters; the channel allows 30');
  }, 45_000);

  it('revising supersedes the current revision and links the chosen studio documents', async () => {
    await page.getByTestId(`package-${P6.packages.changes}`).click();
    const detail = page.getByTestId('package-detail');
    await expect.poll(() => text('revision-state'), { timeout: 15_000 }).toContain('Changes requested');
    await detail.getByLabel('Master copy').fill('Workshop dates for October and November.');
    await detail.getByLabel('Creative document ids').fill('doc_e2e_poster');
    await detail.getByRole('button', { name: 'Create next revision' }).click();
    await expect.poll(() => text('revision-state'), { timeout: 15_000 }).toContain('Draft');
    expect(await text('revision-history')).toContain('Superseded');
    const link = page
      .getByTestId('studio-links')
      .getByRole('link', { name: 'Open doc_e2e_poster in the studio' });
    expect(await link.getAttribute('href')).toBe(brandPath('studio/doc_e2e_poster'));
  }, 45_000);

  // ---- brand settings: channels (spec 14.7) ----

  it('channels show their status as text, with reconnect for an expired token', async () => {
    await open('settings');
    await expect.poll(() => count(`channel-${P5.channels.expired}`), { timeout: 15_000 }).toBe(1);
    const expired = page.getByTestId(`channel-${P5.channels.expired}`);
    expect(await expired.textContent()).toContain('Needs reconnecting');
    expect(await expired.textContent()).toContain('Token expired');
    expect(await expired.getByRole('button', { name: 'Reconnect' }).count()).toBe(1);
    expect(await page.getByTestId(`channel-${P5.channels.ok}`).textContent()).toContain('Connected');
    expect(await noHorizontalOverflow()).toBe(true);
  }, 30_000);

  it('an uncertified provider is shown unavailable with the reason', async () => {
    const row = page.getByTestId('provider-facebook_page');
    await row.getByRole('button', { name: 'Connect Facebook Page' }).click();
    await expect.poll(() => row.getByTestId('unavailable-reason').count(), { timeout: 15_000 }).toBe(1);
    expect(await row.textContent()).toContain('Unavailable');
    expect(await row.getByTestId('unavailable-reason').textContent()).toContain('Not certified');
    expect(
      await row.getByRole('button', { name: 'Connect Facebook Page' }).getAttribute('aria-disabled'),
    ).toBe('true');
  }, 30_000);

  it('connect start gives the authorisation URL as a new-tab link (never an iframe); completion connects', async () => {
    const row = page.getByTestId('provider-linkedin_page');
    await row.getByRole('button', { name: 'Connect LinkedIn Page' }).click();
    const link = row.getByTestId('authorise-link');
    await expect.poll(() => link.count(), { timeout: 15_000 }).toBe(1);
    expect(await link.getAttribute('target')).toBe('_blank');
    expect(await link.getAttribute('rel')).toContain('noopener');
    const href = (await link.getAttribute('href')) ?? '';
    expect(href.startsWith('https://provider.example/oauth/authorize')).toBe(true);
    expect(new URL(href).searchParams.get('redirect_uri')).toBe(`${origin}${brandPath('settings')}`);
    expect(await page.locator('iframe').count()).toBe(0);
    const state = new URL(href).searchParams.get('state') ?? '';
    // The provider sends the person back to the settings page with state and code.
    await open(`settings?state=${encodeURIComponent(state)}&code=auth_code_1`);
    await expect.poll(() => count('connect-callback'), { timeout: 15_000 }).toBe(1);
    await page.getByRole('button', { name: 'Finish connecting' }).click();
    await expect.poll(() => count('connect-completed'), { timeout: 15_000 }).toBe(1);
    expect(await text('connect-completed')).toContain('Connected: Acme LinkedIn Page (linkedin_page)');
    await expect.poll(() => text('channels'), { timeout: 15_000 }).toContain('Acme LinkedIn Page');
    await page.getByRole('button', { name: 'Done' }).click();
    await expect.poll(() => page.url()).not.toContain('code=');
  }, 45_000);

  it('reconnect rotates the expired channel back to Connected', async () => {
    const row = page.getByTestId(`channel-${P5.channels.expired}`);
    await row.getByRole('button', { name: 'Reconnect' }).click();
    await expect.poll(() => row.getByTestId('authorise-link').count(), { timeout: 15_000 }).toBe(1);
    const href = (await row.getByTestId('authorise-link').getAttribute('href')) ?? '';
    const state = new URL(href).searchParams.get('state') ?? '';
    await open(`settings?state=${encodeURIComponent(state)}&code=auth_code_2`);
    await page.getByRole('button', { name: 'Finish connecting' }).click();
    await expect.poll(() => count('connect-completed'), { timeout: 15_000 }).toBe(1);
    await expect
      .poll(() => page.getByTestId(`channel-${P5.channels.expired}`).getAttribute('data-channel-status'), {
        timeout: 15_000,
      })
      .toBe('active');
  }, 45_000);

  it('disconnect asks for confirmation, then the channel shows Disconnected', async () => {
    await open('settings');
    const row = page.getByTestId(`channel-${P5.channels.two}`);
    await expect.poll(() => row.count(), { timeout: 15_000 }).toBe(1);
    await row.getByRole('button', { name: 'Disconnect' }).click();
    await expect.poll(() => page.getByRole('alertdialog').count()).toBe(1);
    await page.getByRole('button', { name: 'Keep connected' }).click();
    await expect.poll(() => page.getByRole('alertdialog').count()).toBe(0);
    expect(backend.phase5.channels.get(P5.channels.two)?.status).toBe('active');
    await row.getByRole('button', { name: 'Disconnect' }).click();
    await page.getByTestId('confirm-disconnect').click();
    await expect.poll(() => row.getAttribute('data-channel-status'), { timeout: 15_000 }).toBe('disabled');
    expect(await row.textContent()).toContain('Disconnected');
    expect(await row.getByRole('button', { name: 'Connect again' }).count()).toBe(1);
  }, 45_000);

  it('permission denied: the list and a connect attempt say so', async () => {
    backend.denied.add('publishing.channels.connect.start');
    const row = page.getByTestId('provider-instagram_business');
    await row.getByRole('button', { name: 'Connect Instagram Business' }).click();
    await expect.poll(() => row.getByTestId('connect-denied').count(), { timeout: 15_000 }).toBe(1);
    expect(await row.getByTestId('connect-denied').textContent()).toContain('channel.connect');
    backend.denied.delete('publishing.channels.connect.start');
    backend.denied.add('publishing.channels.list');
    await open('settings');
    await expect
      .poll(() => page.getByTestId('channels').textContent(), { timeout: 15_000 })
      .toContain('Permission denied');
    expect(await count('providers')).toBe(0);
    backend.denied.delete('publishing.channels.list');
  }, 45_000);
});
