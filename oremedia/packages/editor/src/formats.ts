import type { FormatDefinition } from '@oremedia/contracts/creative';

/** Format definitions referenced by page.formatKey: dimensions and safe areas per channel format. */
export const FORMAT_DEFINITIONS: Readonly<Record<string, FormatDefinition>> = {
  square_1080: {
    key: 'square_1080',
    label: 'Square 1080',
    width: 1080,
    height: 1080,
    safeArea: { top: 54, right: 54, bottom: 54, left: 54 },
    providerKeys: ['instagram_business', 'facebook_page', 'linkedin_page'],
  },
  ig_feed_4x5: {
    key: 'ig_feed_4x5',
    label: 'Instagram feed 4:5',
    width: 1080,
    height: 1350,
    safeArea: { top: 54, right: 54, bottom: 54, left: 54 },
    providerKeys: ['instagram_business'],
  },
  ig_story_9x16: {
    key: 'ig_story_9x16',
    label: 'Instagram story 9:16',
    width: 1080,
    height: 1920,
    safeArea: { top: 250, right: 54, bottom: 250, left: 54 },
    providerKeys: ['instagram_business', 'facebook_page'],
  },
  li_1200x627: {
    key: 'li_1200x627',
    label: 'LinkedIn link image',
    width: 1200,
    height: 627,
    safeArea: { top: 40, right: 40, bottom: 40, left: 40 },
    providerKeys: ['linkedin_page'],
  },
  li_1080x1080: {
    key: 'li_1080x1080',
    label: 'LinkedIn square',
    width: 1080,
    height: 1080,
    safeArea: { top: 54, right: 54, bottom: 54, left: 54 },
    providerKeys: ['linkedin_page'],
  },
  fb_1200x630: {
    key: 'fb_1200x630',
    label: 'Facebook link image',
    width: 1200,
    height: 630,
    safeArea: { top: 40, right: 40, bottom: 40, left: 40 },
    providerKeys: ['facebook_page'],
  },
  x_1600x900: {
    key: 'x_1600x900',
    label: 'X image 16:9',
    width: 1600,
    height: 900,
    safeArea: { top: 48, right: 48, bottom: 48, left: 48 },
    providerKeys: ['x'],
  },
  tt_1080x1920: {
    key: 'tt_1080x1920',
    label: 'TikTok 9:16',
    width: 1080,
    height: 1920,
    safeArea: { top: 260, right: 120, bottom: 320, left: 54 },
    providerKeys: ['tiktok'],
  },
};

export const formatFor = (key: string): FormatDefinition | undefined => FORMAT_DEFINITIONS[key];
