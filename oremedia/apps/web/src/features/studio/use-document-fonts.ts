import { useEffect, useState } from 'react';
import { useAssetUrls } from '../assets/use-assets';

/**
 * Spec 11.5: document fonts are asset versions (pinned files), never system fonts. Each ref is loaded as a FontFace
 * under its own id; the scene falls back and reports missingFont for refs that are not loaded.
 */
export function useDocumentFonts(fontRefs: string[]): (ref: string) => string | null {
  const urls = useAssetUrls(fontRefs);
  const [loaded, setLoaded] = useState<ReadonlySet<string>>(new Set());
  const entries = [...urls.entries()].map(([ref, url]) => `${ref}\u0000${url}`).join('\n');
  useEffect(() => {
    let cancelled = false;
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
    if (!fonts || entries.length === 0) return;
    void Promise.all(
      entries.split('\n').map(async (line) => {
        const [ref, url] = line.split('\u0000');
        if (!ref || !url) return null;
        try {
          const face = new FontFace(ref, `url(${url})`, { weight: '100 900' });
          await face.load();
          fonts.add(face);
          return ref;
        } catch {
          return null;
        }
      }),
    ).then((refs) => {
      if (cancelled) return;
      setLoaded(new Set(refs.filter((r): r is string => r !== null)));
    });
    return () => {
      cancelled = true;
    };
  }, [entries]);
  return (ref) => (loaded.has(ref) ? ref : null);
}
