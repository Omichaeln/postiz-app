import { randomBytes } from 'node:crypto';
import type { z } from 'zod';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import { TrackedLinkList } from '@oremedia/contracts/measurement';
import { requireTenant, type Tx } from '@oremedia/db';
import { newId } from '@oremedia/domain/ids';
import { policy } from '@oremedia/module-access';
import { audit } from '@oremedia/module-operations';
import { PublicationRepository } from '@oremedia/module-publishing';
import { assertBrandExists, linkTrackingOptions } from './hooks';
import { LinkClickRepository, TrackedLinkRepository } from './repositories';

/**
 * Spec 15.4 tracked links: every outbound URL in a channel variant's text becomes a `tracked_links` row with UTM
 * parameters and is rewritten to `<LINK_REDIRECT_DOMAIN>/<shortCode>`. The redirector (apps/redirector) resolves
 * the code globally, so the alphabet and length here are the ones its route accepts (`[A-Za-z0-9_-]{4,16}`).
 */
const linksRepo = new TrackedLinkRepository();
const clicksRepo = new LinkClickRepository();
const publicationsRepo = new PublicationRepository();

/** Redirector contract: SHORT_CODE in apps/redirector/src/server.ts. */
export const SHORT_CODE_PATTERN = /^[A-Za-z0-9_-]{4,16}$/;
export const SHORT_CODE_LENGTH = 10;

/** 10 characters of base64url (60 bits) from a CSPRNG; the unique index catches the astronomically rare clash. */
export function newShortCode(): string {
  return randomBytes(SHORT_CODE_LENGTH)
    .toString('base64url')
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, SHORT_CODE_LENGTH);
}

/** http(s) URLs in running text, without trailing punctuation a sentence would add. */
const URL_PATTERN = /https?:\/\/[^\s<>"']+/g;
const TRAILING = /[.,;:!?)\]}]+$/;

export function extractUrls(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(URL_PATTERN)) {
    const url = m[0].replace(TRAILING, '');
    if (!out.includes(url)) out.push(url);
  }
  return out;
}

export interface UtmContext {
  campaign: string;
  content: string;
}

/** The destination the visitor lands on: the original URL with UTM parameters the brand can attribute by. */
export function utmFor(ctx: UtmContext): Record<string, string> {
  return {
    utm_source: 'oremedia',
    utm_medium: 'social',
    utm_campaign: ctx.campaign,
    utm_content: ctx.content,
  };
}

export function withUtm(destination: string, utm: Record<string, string>): string {
  const url = new URL(destination);
  for (const [k, v] of Object.entries(utm)) if (!url.searchParams.has(k)) url.searchParams.set(k, v);
  return url.toString();
}

/**
 * Rewrites every URL of `text` to its short link. URLs already on the redirect domain are left alone, malformed
 * URLs are left as written (the provider's validation decides what happens to them), and the same URL appearing
 * twice maps to one tracked link.
 */
export function rewriteLinks(
  text: string,
  redirectBaseUrl: string,
  mint: (destination: string) => string | null,
): { text: string; links: Array<{ destination: string; shortCode: string }> } {
  const links: Array<{ destination: string; shortCode: string }> = [];
  let out = text;
  for (const url of extractUrls(text)) {
    if (url.startsWith(`${redirectBaseUrl}/`)) continue;
    try {
      new URL(url);
    } catch {
      continue;
    }
    const shortCode = mint(url);
    if (!shortCode) continue;
    links.push({ destination: url, shortCode });
    out = out.split(url).join(`${redirectBaseUrl}/${shortCode}`);
  }
  return { text: out, links };
}

export const toTrackedLinkDto = (
  l: Awaited<ReturnType<TrackedLinkRepository['getById']>>,
  clicks: number,
) => ({
  id: l.id,
  brandId: l.brandId,
  publicationId: l.publicationId,
  variantId: l.variantId,
  experimentId: l.experimentId,
  experimentVariantId: l.experimentVariantId,
  destination: l.destination,
  utm: l.utm,
  shortCode: l.shortCode,
  shortUrl: linkTrackingOptions().redirectBaseUrl
    ? `${linkTrackingOptions().redirectBaseUrl}/${l.shortCode}`
    : null,
  clicks,
  createdAt: l.createdAt.toISOString(),
});

const brandResource = (brandId: string) => {
  const { tenantId } = requireTenant();
  return { type: 'brand', tenantId, brandId, id: brandId };
};

export const linkService = {
  /**
   * The content module's LinkTracker (registered by the composition root): called inside the variant's
   * transaction with the variant text; returns the text to store.
   */
  async trackVariantLinks(
    input: {
      brandId: string;
      contentRevisionId: string;
      channelVariantId: string;
      channelConnectionId: string;
      text: string;
    },
    tx: Tx,
  ): Promise<string> {
    const base = linkTrackingOptions().redirectBaseUrl;
    if (!base) return input.text;
    const pending: Array<Omit<Parameters<TrackedLinkRepository['create']>[0], 'brandId'>> = [];
    const utm = utmFor({ campaign: input.contentRevisionId, content: input.channelVariantId });
    const { text } = rewriteLinks(input.text, base, (destination) => {
      const shortCode = newShortCode();
      pending.push({
        id: newId('trackedLink'),
        publicationId: null,
        variantId: input.channelVariantId,
        experimentId: null,
        experimentVariantId: null,
        destination: withUtm(destination, utm),
        utm,
        shortCode,
      });
      return shortCode;
    });
    for (const values of pending) await linksRepo.create({ ...values, brandId: input.brandId }, tx);
    if (pending.length)
      await audit.record(
        requireTenant().actor,
        'measurement.links.track',
        { type: 'channel_variant', id: input.channelVariantId },
        'allowed',
        tx,
        { brandId: input.brandId, count: pending.length },
      );
    return text;
  },

  /** insight.read on the brand; a publication id resolves through the publication's variant (spec 15.4). */
  async list(actor: ResolvedActor, input: z.infer<typeof TrackedLinkList>, tx?: Tx) {
    const parsed = TrackedLinkList.parse(input);
    await assertBrandExists(parsed.brandId, tx);
    await policy.assert(actor, 'insight.read', brandResource(parsed.brandId), {}, tx);
    const filter: { publicationId?: string; variantId?: string } = {};
    if (parsed.variantId) filter.variantId = parsed.variantId;
    if (parsed.publicationId) {
      const pub = await publicationsRepo.getById(parsed.publicationId, tx);
      filter.variantId = pub.channelVariantId;
    }
    const page = await linksRepo.list(parsed.brandId, filter, parsed.page, tx);
    const counts = await clicksRepo.countByLink(
      page.items.map((l) => l.id),
      tx,
    );
    return {
      items: page.items.map((l) => toTrackedLinkDto(l, counts.get(l.id) ?? 0)),
      nextCursor: page.nextCursor,
      uniqueVisitors: await clicksRepo.countUniqueVisitors(
        page.items.map((l) => l.id),
        tx,
      ),
    };
  },

  /** Click totals for the publication's links (the commercial-outcome input of the quality composite). */
  async clicksForVariant(brandId: string, variantId: string, tx?: Tx) {
    const links = await linksRepo.listForVariant(brandId, variantId, tx);
    const counts = await clicksRepo.countByLink(
      links.map((l) => l.id),
      tx,
    );
    return links.map((l) => ({ id: l.id, shortCode: l.shortCode, clicks: counts.get(l.id) ?? 0 }));
  },
};
