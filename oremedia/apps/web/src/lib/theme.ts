import { useCallback, useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';
const KEY = 'oremedia.theme';

const read = (): Theme => {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    // storage blocked: fall through to the system preference
  }
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
};

/** Light and dark sets both come from packages/ui/tokens.css; the choice is a per-device convenience. */
export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>(read);
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      // storage blocked: the attribute still applies for this page
    }
  }, [theme]);
  const toggle = useCallback(() => setTheme((t) => (t === 'dark' ? 'light' : 'dark')), []);
  return { theme, toggle };
}
