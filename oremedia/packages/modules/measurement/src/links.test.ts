import { describe, expect, it } from 'vitest';
import { SHORT_CODE_PATTERN, extractUrls, newShortCode, rewriteLinks, utmFor, withUtm } from './links';

describe('tracked link rewriting (spec 15.4)', () => {
  it('short codes match what the redirector accepts and are unpredictable', () => {
    const codes = new Set(Array.from({ length: 200 }, newShortCode));
    expect(codes.size).toBe(200);
    for (const c of codes) expect(c).toMatch(SHORT_CODE_PATTERN);
  });
  it('extracts URLs from running text without trailing punctuation, once each', () => {
    expect(
      extractUrls('See https://a.example/x?y=1. Also (https://b.example/p), and https://a.example/x?y=1!'),
    ).toEqual(['https://a.example/x?y=1', 'https://b.example/p']);
  });
  it('rewrites every URL to the redirect domain and keeps already-short links and bad URLs as written', () => {
    let n = 0;
    const { text, links } = rewriteLinks(
      'Buy at https://shop.example/a and https://shop.example/a; docs https://ore.link/abcd1234 http://[bad',
      'https://ore.link',
      () => `code${++n}`,
    );
    expect(links).toEqual([{ destination: 'https://shop.example/a', shortCode: 'code1' }]);
    expect(text).toBe(
      'Buy at https://ore.link/code1 and https://ore.link/code1; docs https://ore.link/abcd1234 http://[bad',
    );
  });
  it('adds UTM parameters without overriding ones the destination already carries', () => {
    const utm = utmFor({ campaign: 'pr_1', content: 'cv_1' });
    expect(withUtm('https://x.example/p?utm_source=newsletter', utm)).toBe(
      'https://x.example/p?utm_source=newsletter&utm_medium=social&utm_campaign=pr_1&utm_content=cv_1',
    );
  });
});
