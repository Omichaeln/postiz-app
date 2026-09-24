/**
 * X weighted text counting (spec 14.5: weighted counting lives in the adapter, not a generic helper; 20.2 count.length
 * refactor). Rules as X documents them for its v3 configuration: scale 100, default weight 200, weight 100 for the
 * code point ranges below, every URL counts as 23 characters (transformedURLLength), an emoji sequence counts as 2.
 */
const WEIGHT_ONE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0, 4351],
  [8192, 8205],
  [8208, 8223],
  [8242, 8247],
];
export const X_URL_WEIGHT = 23;
export const X_MAX_WEIGHTED_LENGTH = 280;

// Scheme URLs, www. hosts and bare domains on common TLDs (X's own extractor recognises a longer TLD list; the
// remainder is verified against the platform's response at certification).
const TLDS =
  'com|net|org|io|co|ai|app|dev|me|info|biz|tv|gov|edu|uk|de|fr|es|it|nl|se|no|dk|fi|pl|jp|cn|in|br|au|ca|us|eu|ch|at|be|ie|nz|za|mx|ar|cl|ru|kr|sg|hk|tw|id|ph|my|th|vn|tr|il|sa|ae|ng|ke|gh|zw|xyz|online|site|store|blog|shop|tech|news|media|studio|design|agency|group|club|live|social|link|page|cloud|digital|space|world|today|zone|art|life|network|systems|solutions|services';
const URL_RE = new RegExp(
  `https?://[^\\s<>"']+|\\bwww\\.[^\\s<>"']+|\\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+(?:${TLDS})\\b(?:/[^\\s<>"']*)?`,
  'giu',
);
const EMOJI_RE =
  /\p{Regional_Indicator}{2}|[#*0-9]️?⃣|\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})?(?:‍\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})?)*/gu;

function weighPlain(segment: string): number {
  let weight = 0;
  const withoutEmoji = segment.replace(EMOJI_RE, () => {
    weight += 200;
    return '';
  });
  for (const ch of withoutEmoji) {
    const cp = ch.codePointAt(0) ?? 0;
    weight += WEIGHT_ONE_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi) ? 100 : 200;
  }
  return weight;
}

/** Weighted length in characters (scale already divided out). */
export function weightedLength(text: string): number {
  const t = text.normalize('NFC');
  let weight = 0;
  let last = 0;
  for (const m of t.matchAll(URL_RE)) {
    weight += weighPlain(t.slice(last, m.index));
    weight += X_URL_WEIGHT * 100;
    last = m.index + m[0].length;
  }
  weight += weighPlain(t.slice(last));
  return Math.ceil(weight / 100);
}

export const measureX = (text: string): { length: number; limit: number } => ({
  length: weightedLength(text),
  limit: X_MAX_WEIGHTED_LENGTH,
});
