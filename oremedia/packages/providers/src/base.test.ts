import { describe, expect, it } from 'vitest';
import {
  classifyByStatus,
  missingScopes,
  outcomeFromClass,
  redactBody,
  retryAfterMs,
  truncateForTemporal,
} from './base';
import { ProviderTransportError } from './io';
import { validateVariantAgainstCapability, plainMeasure } from './capability';
import { ProviderRegistry } from './registry';
import type { ProviderCapabilityV1 } from '@oremedia/contracts/providers';
import { CapabilityUnsupportedError } from '@oremedia/contracts/errors';
import type { ProviderAdapter } from './contract';

const cap: ProviderCapabilityV1 = {
  key: 'test',
  version: 1,
  text: {
    maxLength: 100,
    weighted: false,
    supportsLinks: true,
    supportsMentions: false,
    supportsHashtags: true,
  },
  media: {
    image: {
      mimes: ['image/jpeg', 'image/png'],
      minWidth: 320,
      maxWidth: 4096,
      aspectRatios: [{ min: 0.8, max: 1.91 }],
      maxBytes: 8_000_000,
      maxCount: 10,
    },
    carousel: { min: 2, max: 10 },
    altText: true,
    publicUrlFetch: { required: true, processingWindowSec: 86400 },
  },
  threading: 'comments',
  asyncProcessing: true,
  idempotencyKeySupported: false,
  reconciliation: 'by_recent_posts_scan',
  analytics: { post: ['impressions'], account: ['followers'], latencyHours: 24 },
  comments: { read: true, reply: false },
  edit: false,
  delete: true,
  rateLimits: [{ scope: 'account', limit: 100, windowSec: 3600 }],
  requiredScopes: ['w_member_social'],
  certifiedAt: null,
};

describe('error classification (spec 14.5, R8)', () => {
  it('never turns an after-send failure into a retry', () => {
    expect(classifyByStatus({ status: 500, phase: 'after_send' })).toEqual({ kind: 'unknown' });
    expect(classifyByStatus({ status: 429, phase: 'after_send' })).toEqual({ kind: 'unknown' });
    expect(
      classifyByStatus({
        phase: 'after_send',
        error: new ProviderTransportError(new Error('timeout'), 'after_send'),
      }),
    ).toEqual({ kind: 'unknown' });
    expect(outcomeFromClass({ kind: 'unknown' }, 'x').outcome).toBe('unknown');
  });
  it('classifies definitive rejections, auth problems and pre-send transport errors', () => {
    expect(classifyByStatus({ status: 400, phase: 'after_send' })).toEqual({
      kind: 'rejected',
      code: 'http_400',
    });
    expect(classifyByStatus({ status: 401, phase: 'after_send' })).toEqual({ kind: 'refresh_token' });
    expect(classifyByStatus({ status: 403, phase: 'after_send' })).toEqual({ kind: 'reconnect_required' });
    const pre = classifyByStatus({
      phase: 'before_send',
      error: new ProviderTransportError(
        Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }),
        'before_send',
      ),
    });
    expect(pre.kind).toBe('rate_limited');
    expect(outcomeFromClass(pre, 'x').outcome).toBe('retryable_error');
  });
  it('truncates failure payloads before Temporal and redacts tokens', () => {
    expect(truncateForTemporal('x'.repeat(5000)).length).toBe(2000);
    expect(redactBody('{"access_token":"abcdefghijklmnop","id":"1"}')).not.toContain('abcdefghijklmnop');
  });
  it('bounds Retry-After and computes missing scopes', () => {
    expect(retryAfterMs('3')).toBe(3000);
    expect(retryAfterMs('99999')).toBe(15 * 60_000);
    expect(retryAfterMs(undefined)).toBe(5000);
    expect(missingScopes(['w_member_social', 'r_organization_social'], ['W_MEMBER_SOCIAL'])).toEqual([
      'r_organization_social',
    ]);
  });
});

describe('capability validation (spec 14.6)', () => {
  const measure = plainMeasure(cap.text.maxLength);
  it('accepts a valid variant', () => {
    expect(
      validateVariantAgainstCapability(
        cap,
        {
          text: 'hello #x',
          altTexts: ['a'],
          media: [{ mime: 'image/png', width: 1080, height: 1080, bytes: 1000 }],
          settings: {},
        },
        measure,
      ).ok,
    ).toBe(true);
  });
  it('reports every issue with a path', () => {
    const r = validateVariantAgainstCapability(
      cap,
      {
        text: 'x'.repeat(101) + ' @someone',
        altTexts: [],
        media: [{ mime: 'image/gif', width: 100, height: 1000, bytes: 9_000_000 }],
        settings: {},
      },
      measure,
    );
    expect(r.ok).toBe(false);
    const issues = r.issues.map((i) => i.issue);
    expect(issues.some((i) => i.startsWith('text_too_long'))).toBe(true);
    expect(issues).toContain('mentions_not_supported');
    expect(issues).toContain('mime_not_supported:image/gif');
    expect(issues).toContain('image_too_narrow');
    expect(issues).toContain('image_too_large');
    expect(issues.some((i) => i.startsWith('aspect_ratio_not_supported'))).toBe(true);
  });
  it('carousel bounds and unsupported video', () => {
    const three = Array.from({ length: 3 }, () => ({
      mime: 'image/png',
      width: 1080,
      height: 1080,
      bytes: 10,
    }));
    expect(
      validateVariantAgainstCapability(cap, { text: '', altTexts: [], media: three, settings: {} }, measure)
        .ok,
    ).toBe(true);
    expect(
      validateVariantAgainstCapability(
        cap,
        {
          text: '',
          altTexts: [],
          media: [{ mime: 'video/mp4', width: 1080, height: 1920, bytes: 10, durationMs: 1000 }],
          settings: {},
        },
        measure,
      ).issues.map((i) => i.issue),
    ).toContain('video_not_supported');
  });
});

describe('registry (spec 14.6): uncertified providers cannot be used by tenants', () => {
  const adapter = { key: 'test', capability: cap } as unknown as ProviderAdapter;
  it('get() refuses an uncertified adapter; forCertification exposes it', () => {
    const r = new ProviderRegistry().register(adapter);
    expect(() => r.get('test')).toThrow(CapabilityUnsupportedError);
    expect(() => r.get('nope')).toThrow(CapabilityUnsupportedError);
    try {
      r.get('test');
    } catch (e) {
      expect((e as CapabilityUnsupportedError).details?.[0]?.issue).toBe('provider_not_certified:test');
    }
    expect(r.forCertification('test')).toBe(adapter);
    expect(r.list()[0]).toMatchObject({ key: 'test', certified: false });
    const certified = {
      ...adapter,
      capability: { ...cap, certifiedAt: '2026-10-01T00:00:00.000Z' },
    } as unknown as ProviderAdapter;
    expect(new ProviderRegistry().register(certified).get('test')).toBe(certified);
  });
});
