import type {
  ChannelVariantInput,
  ProviderCapabilityV1,
  ValidationResult,
} from '@oremedia/contracts/providers';

/**
 * Spec 14.6 / 20.2: server-side validation shared by every entry point, driven by the capability register.
 * Pure: no network. The adapter supplies `measureText` so weighted counting stays inside the adapter.
 */
export function validateVariantAgainstCapability(
  cap: ProviderCapabilityV1,
  variant: ChannelVariantInput,
  measure: (text: string) => { length: number; limit: number },
): ValidationResult {
  const issues: ValidationResult['issues'] = [];
  const m = measure(variant.text);
  if (m.length > m.limit) issues.push({ path: 'text', issue: `text_too_long:${m.length}>${m.limit}` });
  if (!cap.text.supportsLinks && /https?:\/\//i.test(variant.text))
    issues.push({ path: 'text', issue: 'links_not_supported' });
  if (!cap.text.supportsMentions && /(^|\s)@\w+/.test(variant.text))
    issues.push({ path: 'text', issue: 'mentions_not_supported' });
  if (!cap.text.supportsHashtags && /(^|\s)#\w+/.test(variant.text))
    issues.push({ path: 'text', issue: 'hashtags_not_supported' });

  const images = variant.media.filter((x) => x.mime.startsWith('image/'));
  const videos = variant.media.filter((x) => x.mime.startsWith('video/'));
  if (images.length && !cap.media.image) issues.push({ path: 'media', issue: 'images_not_supported' });
  if (videos.length && !cap.media.video) issues.push({ path: 'media', issue: 'video_not_supported' });
  if (cap.media.image) {
    if (images.length > cap.media.image.maxCount)
      issues.push({ path: 'media', issue: `too_many_images:${images.length}>${cap.media.image.maxCount}` });
    images.forEach((img, i) => {
      const p = `media.${i}`;
      if (!cap.media.image?.mimes.includes(img.mime))
        issues.push({ path: p, issue: `mime_not_supported:${img.mime}` });
      if (img.width < (cap.media.image?.minWidth ?? 0)) issues.push({ path: p, issue: 'image_too_narrow' });
      if (img.width > (cap.media.image?.maxWidth ?? Infinity))
        issues.push({ path: p, issue: 'image_too_wide' });
      if (img.bytes > (cap.media.image?.maxBytes ?? Infinity))
        issues.push({ path: p, issue: 'image_too_large' });
      const ratio = img.width / img.height;
      const ok = cap.media.image?.aspectRatios.length
        ? cap.media.image.aspectRatios.some((r) => ratio >= r.min - 1e-6 && ratio <= r.max + 1e-6)
        : true;
      if (!ok) issues.push({ path: p, issue: `aspect_ratio_not_supported:${ratio.toFixed(3)}` });
    });
  }
  if (cap.media.video) {
    videos.forEach((v, i) => {
      const p = `media.${i}`;
      if (!cap.media.video?.mimes.includes(v.mime))
        issues.push({ path: p, issue: `mime_not_supported:${v.mime}` });
      if ((v.durationMs ?? 0) > (cap.media.video?.maxDurationSec ?? Infinity) * 1000)
        issues.push({ path: p, issue: 'video_too_long' });
      if (v.bytes > (cap.media.video?.maxBytes ?? Infinity))
        issues.push({ path: p, issue: 'video_too_large' });
    });
  }
  if (images.length > 1) {
    if (!cap.media.carousel) issues.push({ path: 'media', issue: 'carousel_not_supported' });
    else if (images.length < cap.media.carousel.min || images.length > cap.media.carousel.max)
      issues.push({ path: 'media', issue: `carousel_count_out_of_range:${images.length}` });
  }
  if (!cap.media.altText && variant.altTexts.some((a) => a.length > 0))
    issues.push({ path: 'altTexts', issue: 'alt_text_not_supported' });
  if (variant.altTexts.length > variant.media.length)
    issues.push({ path: 'altTexts', issue: 'more_alt_texts_than_media' });
  return { ok: issues.length === 0, issues };
}

/** Default unweighted counting; adapters with weighted rules (e.g. X) override measureText. */
export const plainMeasure = (limit: number) => (text: string) => ({
  length: [...text.normalize('NFC')].length,
  limit,
});
