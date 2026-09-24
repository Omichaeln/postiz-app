import type { Page } from 'playwright';

/**
 * In-page accessibility audit for the application chrome (spec 21.3: WCAG 2.2 AA; colour is never the only carrier
 * of status; every action has a keyboard path). axe-core is not a dependency of this workspace, so this is a
 * focused DOM audit of the success criteria the specification names, run inside the page against computed styles:
 *
 * | Rule                  | WCAG 2.2                    | What is checked                                                   |
 * | --------------------- | --------------------------- | ----------------------------------------------------------------- |
 * | `accessible-name`     | 4.1.2 Name, Role, Value     | every interactive element (and role=img/img) has a name           |
 * | `form-label`          | 1.3.1, 3.3.2, 4.1.2         | every form control has a label (label, aria-label(ledby), title)  |
 * | `status-colour-only`  | 1.4.1 Use of Color          | every element coloured with a status token carries text or a name |
 * | `contrast`            | 1.4.3 Contrast (Minimum)    | text ≥ 4.5:1 (≥ 3:1 large) from computed colours, WCAG luminance  |
 * | `heading-order`       | 1.3.1, 2.4.6                | no skipped heading levels                                         |
 * | `single-h1`           | 2.4.2 / 1.3.1               | exactly one h1 per page                                           |
 * | `landmarks`           | 1.3.1, 2.4.1                | exactly one main; several navs are each named                     |
 * | `positive-tabindex`   | 2.4.3 Focus Order           | no tabindex > 0                                                   |
 * | `aria-reference`      | 1.3.1, 4.1.2                | aria-labelledby/-describedby/-controls/… and label[for] ids exist |
 * | `dialog-label`        | 4.1.2                       | open dialogs have an accessible name                              |
 * | `target-size`         | 2.5.8 Target Size (Minimum) | pointer targets ≥ 24×24 or spaced (inline and UA controls exempt) |
 * | `reflow`              | 1.4.10 Reflow               | no horizontal page scroll at 320–400 px widths                    |
 *
 * Plus two interaction checks, `keyboardPath` (2.1.1 Keyboard, 2.4.7 Focus Visible, 2.4.11 Focus Not Obscured: every
 * pointer action is reached by Tab, shows a focus indicator and is not entirely covered by fixed content) and
 * `dialogFocusTrap` (2.4.3: an open modal keeps focus inside); `focusNotObscured` runs the 2.4.11 hit test on the
 * current focus without moving it (content that appears on its own, such as a toast). Violations
 * name the rule, a CSS selector and the evidence, so a failure reads like a lint report.
 */
export type A11yRule =
  | 'accessible-name'
  | 'form-label'
  | 'status-colour-only'
  | 'contrast'
  | 'heading-order'
  | 'single-h1'
  | 'landmarks'
  | 'positive-tabindex'
  | 'aria-reference'
  | 'dialog-label'
  | 'target-size'
  | 'reflow';

export interface A11yViolation {
  rule: A11yRule | 'focus-visible' | 'focus-obscured' | 'keyboard-unreachable' | 'focus-trap';
  selector: string;
  detail: string;
}

export interface AuditOptions {
  /** Viewport is phone width: also check reflow (no horizontal scrolling). */
  narrow: boolean;
}

/** Runs every static rule in the page and returns the violations (empty = clean). */
export async function auditPage(page: Page, opts: AuditOptions): Promise<A11yViolation[]> {
  // Computed styles settle a frame after a change (the reduced-motion rule keeps a 0.01 ms transition everywhere).
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  return page.evaluate(auditDom, opts);
}

export interface KeyboardPathResult {
  /** Every pointer action on the screen, as `role "name"` (grouped widgets count once). */
  actions: string[];
  /** Actions Tab never reached, or pointer-only affordances with no keyboard path. */
  unreached: A11yViolation[];
  /** Focus stops whose computed outline/box-shadow did not change on focus, or that other content entirely covers. */
  invisibleFocus: A11yViolation[];
  /** Number of Tab presses the walk took. */
  stops: number;
}

/**
 * Lists every pointer-actionable element from the DOM, then walks the page with Tab and records what receives focus
 * and whether its focus indicator is visible (computed outline or box-shadow differs from the unfocused state).
 * Roving-tabindex widgets (tabs, listboxes, radio groups, the calendar grid) are one stop: reaching any member counts.
 */
export async function keyboardPath(page: Page): Promise<KeyboardPathResult> {
  const actions = await page.evaluate(enumerateActions);
  const reached = new Set<string>();
  const invisible = new Map<string, A11yViolation>();
  const limit = actions.count * 2 + 40;
  let first: string | null = null;
  let stops = 0;
  for (let i = 0; i < limit; i += 1) {
    await page.keyboard.press('Tab');
    stops += 1;
    const stop = await page.evaluate(readFocusStop);
    if (!stop) continue;
    if (stop.group) reached.add(stop.group);
    if (!stop.indicatorVisible && !invisible.has(stop.selector))
      invisible.set(stop.selector, {
        rule: 'focus-visible',
        selector: stop.selector,
        detail: `${stop.label}: outline/box-shadow unchanged on focus`,
      });
    if (stop.obscured && !invisible.has(`${stop.selector}#obscured`))
      invisible.set(`${stop.selector}#obscured`, {
        rule: 'focus-obscured',
        selector: stop.selector,
        detail: `${stop.label}: entirely covered by other content while focused`,
      });
    if (first === null) first = stop.selector;
    else if (stop.selector === first && reached.size >= actions.groups.length) break;
  }
  const unreached: A11yViolation[] = actions.groups
    .filter((g) => !reached.has(g.group))
    .map((g) => ({
      rule: 'keyboard-unreachable',
      selector: g.selector,
      detail: `${g.label} is not reached by Tab`,
    }));
  for (const p of actions.pointerOnly)
    unreached.push({
      rule: 'keyboard-unreachable',
      selector: p.selector,
      detail: `${p.label}: pointer cursor on an element with no keyboard path`,
    });
  return {
    actions: actions.groups.map((g) => g.label),
    unreached,
    invisibleFocus: [...invisible.values()],
    stops,
  };
}

/**
 * 2.4.11 Focus Not Obscured for the element that has focus now, without moving it: the same hit test `keyboardPath`
 * applies at every Tab stop. Used when content appears on its own (a toast) while focus stays where it is.
 */
export async function focusNotObscured(page: Page): Promise<A11yViolation[]> {
  const stop = await page.evaluate(readFocusStop);
  if (!stop) return [{ rule: 'focus-obscured', selector: 'body', detail: 'nothing has focus' }];
  return stop.obscured
    ? [
        {
          rule: 'focus-obscured',
          selector: stop.selector,
          detail: `${stop.label}: entirely covered by other content while focused`,
        },
      ]
    : [];
}

/** With a dialog open: Tab and Shift+Tab never leave it, and it has a name (spec 21.3 "focus is managed"). */
export async function dialogFocusTrap(page: Page): Promise<A11yViolation[]> {
  const info = await page.evaluate(() => {
    const d = [
      ...document.querySelectorAll<HTMLElement>('[role="dialog"],[role="alertdialog"],dialog[open]'),
    ].find((el) => el.getClientRects().length > 0);
    if (!d) return null;
    d.setAttribute('data-a11y-dialog', '1');
    const focusables = d.querySelectorAll(
      'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
    ).length;
    return { focusables };
  });
  if (!info) return [{ rule: 'focus-trap', selector: 'body', detail: 'no open dialog to test' }];
  const out: A11yViolation[] = [];
  for (const key of ['Tab', 'Shift+Tab']) {
    for (let i = 0; i < info.focusables + 3; i += 1) {
      await page.keyboard.press(key);
      const inside = await page.evaluate(() => {
        const d = document.querySelector('[data-a11y-dialog]');
        return Boolean(d && document.activeElement && d.contains(document.activeElement));
      });
      if (!inside) {
        out.push({
          rule: 'focus-trap',
          selector: '[data-a11y-dialog]',
          detail: `${key} moved focus out of the dialog`,
        });
        break;
      }
    }
  }
  return out;
}

/** Formats violations for an assertion message. */
export const formatViolations = (screen: string, violations: A11yViolation[]): string =>
  violations.length === 0
    ? `${screen}: clean`
    : `${screen}: ${violations.length} violation(s)\n${violations.map((v) => `  [${v.rule}] ${v.selector} — ${v.detail}`).join('\n')}`;

// ---------------------------------------------------------------------------------------------------------------
// In-page functions. Each is serialised by page.evaluate, so everything it uses is declared inside it.
// ---------------------------------------------------------------------------------------------------------------

function auditDom(opts: AuditOptions): A11yViolation[] {
  const out: A11yViolation[] = [];
  const add = (rule: A11yRule, el: Element | null, detail: string) =>
    out.push({ rule, selector: el ? selectorOf(el) : 'document', detail });

  function selectorOf(el: Element): string {
    const parts: string[] = [];
    let node: Element | null = el;
    while (node && node !== document.body && parts.length < 4) {
      const testId = node.getAttribute('data-testid');
      if (node.id && !/^(radix-|:r)/.test(node.id)) {
        parts.unshift(`${node.localName}#${CSS.escape(node.id)}`);
        break;
      }
      if (testId) {
        parts.unshift(`${node.localName}[data-testid="${testId}"]`);
        break;
      }
      const parent: Element | null = node.parentElement;
      const siblings = parent ? [...parent.children].filter((c) => c.localName === node?.localName) : [];
      parts.unshift(
        siblings.length > 1 ? `${node.localName}:nth-of-type(${siblings.indexOf(node) + 1})` : node.localName,
      );
      node = parent;
    }
    const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
    return `${parts.join(' > ')}${text ? ` ("${text}")` : ''}`;
  }

  /** Hidden from assistive technology: aria-hidden, inert or hidden in the ancestry. */
  function atHidden(el: Element): boolean {
    for (let n: Element | null = el; n; n = n.parentElement) {
      if (n.getAttribute('aria-hidden') === 'true' || n.hasAttribute('inert') || n.hasAttribute('hidden'))
        return true;
    }
    return false;
  }
  const rendered = (el: Element) =>
    el.checkVisibility({ visibilityProperty: true } as CheckVisibilityOptions) &&
    el.getClientRects().length > 0;
  /** Clipped to a pixel (the sr-only pattern): read by screen readers, not seen. */
  const visuallyHidden = (el: Element) => {
    const r = el.getBoundingClientRect();
    return r.width <= 1 || r.height <= 1;
  };

  /** Text an element contributes to a name: text nodes, img alt and descendant aria-labels; aria-hidden skipped. */
  function textOf(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
    if (!(node instanceof Element)) return '';
    if (node.getAttribute('aria-hidden') === 'true') return '';
    const style = getComputedStyle(node);
    if (style.display === 'none') return '';
    const label = node.getAttribute('aria-label');
    if (label?.trim()) return label;
    if (node instanceof HTMLImageElement) return node.alt;
    return [...node.childNodes].map(textOf).join(' ');
  }
  function byIds(ids: string): string {
    return ids
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ');
  }
  const NAME_FROM_CONTENT = new Set([
    'button',
    'link',
    'tab',
    'option',
    'menuitem',
    'menuitemradio',
    'menuitemcheckbox',
    'checkbox',
    'radio',
    'switch',
    'treeitem',
    'heading',
    'cell',
    'columnheader',
    'rowheader',
    'tooltip',
  ]);
  function roleOf(el: Element): string {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.split(/\s+/)[0] ?? '';
    const tag = el.localName;
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'input') {
      const type = (el as HTMLInputElement).type;
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
      return 'textbox';
    }
    return '';
  }
  function nameOf(el: Element): string {
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy && byIds(labelledBy).trim()) return byIds(labelledBy).trim();
    const label = el.getAttribute('aria-label');
    if (label?.trim()) return label.trim();
    if (el instanceof HTMLInputElement && ['button', 'submit', 'reset'].includes(el.type) && el.value)
      return el.value;
    if ('labels' in el) {
      const labels = (el as HTMLInputElement).labels;
      const text = labels ? [...labels].map((l) => textOf(l)).join(' ') : '';
      if (text.trim()) return text.trim();
    }
    if (el instanceof HTMLImageElement) return el.alt;
    if (NAME_FROM_CONTENT.has(roleOf(el))) {
      const text = textOf(el).trim();
      if (text) return text;
    }
    return (el.getAttribute('title') ?? '').trim();
  }

  // ---- colour ----
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const colourCache = new Map<string, [number, number, number, number]>();
  /** Any CSS colour (rgb, oklch, color-mix, …) resolved through the canvas to sRGB bytes and alpha. */
  function rgba(css: string): [number, number, number, number] {
    const hit = colourCache.get(css);
    if (hit) return hit;
    let value: [number, number, number, number] = [0, 0, 0, 0];
    if (ctx) {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = 'rgba(0,0,0,0)';
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      value = [d[0] ?? 0, d[1] ?? 0, d[2] ?? 0, (d[3] ?? 0) / 255];
    }
    colourCache.set(css, value);
    return value;
  }
  /** Source-over compositing of `top` onto an opaque `bottom`. */
  const over = (
    top: [number, number, number, number],
    bottom: [number, number, number, number],
  ): [number, number, number, number] => {
    const a = top[3];
    return [
      top[0] * a + bottom[0] * (1 - a),
      top[1] * a + bottom[1] * (1 - a),
      top[2] * a + bottom[2] * (1 - a),
      1,
    ];
  };
  /** WCAG 2.x relative luminance. */
  const luminance = ([r, g, b]: [number, number, number, number]) => {
    const lin = (c: number) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  };
  const ratio = (a: [number, number, number, number], b: [number, number, number, number]) => {
    const la = luminance(a);
    const lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  };
  /** The opaque colour behind an element: its own and its ancestors' backgrounds composited from the root. */
  function backdrop(el: Element): [number, number, number, number] | null {
    const chain: Element[] = [];
    for (let n: Element | null = el; n; n = n.parentElement) chain.push(n);
    let colour: [number, number, number, number] = [255, 255, 255, 1];
    for (const n of chain.reverse()) {
      const s = getComputedStyle(n);
      if (s.backgroundImage !== 'none') return null; // an image or gradient: the contrast is not computable from colours
      colour = over(rgba(s.backgroundColor), colour);
    }
    return colour;
  }

  // ---- contrast (1.4.3) ----
  const seen = new Set<Element>();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const el = node.parentElement;
    if (!el || seen.has(el) || !(node.textContent ?? '').trim()) continue;
    seen.add(el);
    if (el.closest('svg,script,style,noscript,option,[data-a11y-ignore]')) continue;
    if (!rendered(el) || visuallyHidden(el)) continue;
    // Inactive UI components are exempt from 1.4.3.
    if (el.closest(':disabled,[aria-disabled="true"]')) continue;
    const s = getComputedStyle(el);
    let opacity = 1;
    for (let n: Element | null = el; n; n = n.parentElement) opacity *= Number(getComputedStyle(n).opacity);
    const bg = backdrop(el);
    if (!bg) continue;
    const fgRaw = rgba(s.color);
    const fg = over([fgRaw[0], fgRaw[1], fgRaw[2], fgRaw[3] * opacity], bg);
    const size = parseFloat(s.fontSize);
    const bold = Number(s.fontWeight) >= 700;
    const large = size >= 24 || (bold && size >= 18.66);
    const needed = large ? 3 : 4.5;
    const got = ratio(fg, bg);
    if (got + 1e-6 < needed)
      add(
        'contrast',
        el,
        `${got.toFixed(2)}:1 < ${needed}:1 (text ${s.color} on rgb(${bg.slice(0, 3).map(Math.round).join(', ')}), ${size}px)`,
      );
  }

  // ---- names and labels (4.1.2, 1.3.1, 3.3.2) ----
  const INTERACTIVE =
    'a[href],button,summary,input:not([type="hidden"]),select,textarea,iframe,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"],[role="option"],[role="switch"],[role="checkbox"],[role="radio"],[role="treeitem"],[role="combobox"],[role="textbox"],[role="listbox"],[role="slider"],[role="spinbutton"],[role="searchbox"]';
  const FORM_ROLES = new Set([
    'textbox',
    'combobox',
    'listbox',
    'checkbox',
    'radio',
    'switch',
    'slider',
    'spinbutton',
    'searchbox',
  ]);
  for (const el of document.querySelectorAll(INTERACTIVE)) {
    if (atHidden(el) || !rendered(el)) continue;
    const role = roleOf(el);
    const name = nameOf(el);
    const isFormControl =
      el instanceof HTMLInputElement ||
      el instanceof HTMLSelectElement ||
      el instanceof HTMLTextAreaElement ||
      (FORM_ROLES.has(role) && !(el instanceof HTMLButtonElement));
    if (
      isFormControl &&
      !(el instanceof HTMLInputElement && ['button', 'submit', 'reset', 'image'].includes(el.type))
    ) {
      if (!name) add('form-label', el, `${el.localName}${role ? ` (role ${role})` : ''} has no label`);
    } else if (!name) add('accessible-name', el, `${role || el.localName} has no accessible name`);
  }
  for (const el of document.querySelectorAll('img,[role="img"],svg[role="img"]')) {
    if (atHidden(el) || !rendered(el)) continue;
    if (el instanceof HTMLImageElement && el.hasAttribute('alt')) continue;
    if (!nameOf(el)) add('accessible-name', el, `${el.localName} image has no text alternative`);
  }

  // ---- colour is never the only carrier of status (1.4.1) ----
  const STATUS =
    /(^|\s)(?:[a-z-]+:)*(text|border|border-l|bg|fill|stroke|ring|outline|decoration)-status-(good|warning|critical|info)\b/;
  for (const el of document.querySelectorAll('[class*="status-"]')) {
    if (!STATUS.test(el.getAttribute('class') ?? '') || !rendered(el)) continue;
    const carrier = atHidden(el)
      ? (() => {
          let n: Element | null = el.parentElement;
          while (n && atHidden(n)) n = n.parentElement;
          return n;
        })()
      : el;
    const text = carrier ? `${textOf(carrier)} ${nameOf(carrier)}`.trim() : '';
    if (!text) add('status-colour-only', el, 'status colour with no text or accessible name');
  }

  // An open modal hides the rest of the page from assistive technology (Radix marks it aria-hidden), so the page's
  // h1 and main are correctly absent from the accessibility tree; the page-level rules apply to the page, not to it.
  const modalOpen = [...document.querySelectorAll('[role="dialog"],[role="alertdialog"],dialog[open]')].some(
    (d) => rendered(d) && [...document.querySelectorAll('main')].every((m) => atHidden(m)),
  );

  // ---- headings (1.3.1, 2.4.6) ----
  const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]')].filter(
    (h) => !atHidden(h) && h.checkVisibility(),
  );
  const levelOf = (h: Element) =>
    h.getAttribute('role') === 'heading' ? Number(h.getAttribute('aria-level') ?? 2) : Number(h.localName[1]);
  const h1s = headings.filter((h) => levelOf(h) === 1);
  if (!modalOpen && h1s.length !== 1)
    add('single-h1', h1s[1] ?? null, `${h1s.length} h1 elements (expected exactly 1)`);
  let previous = 0;
  for (const h of headings) {
    const level = levelOf(h);
    if (previous && level > previous + 1) add('heading-order', h, `h${level} follows h${previous}`);
    if (!textOf(h).trim()) add('accessible-name', h, 'empty heading');
    previous = level;
  }

  // ---- landmarks (1.3.1, 2.4.1) ----
  const mains = [...document.querySelectorAll('main,[role="main"]')].filter((m) => !atHidden(m));
  if (!modalOpen && mains.length !== 1)
    add('landmarks', mains[1] ?? null, `${mains.length} main landmarks (expected exactly 1)`);
  const navs = [...document.querySelectorAll('nav,[role="navigation"]')].filter((n) => !atHidden(n));
  if (navs.length > 1)
    for (const n of navs)
      if (!nameOf(n)) add('landmarks', n, 'several navigation landmarks; this one has no name');

  // ---- focus order (2.4.3) ----
  for (const el of document.querySelectorAll('[tabindex]'))
    if (Number(el.getAttribute('tabindex')) > 0)
      add('positive-tabindex', el, `tabindex=${el.getAttribute('tabindex')}`);

  // ---- id references (1.3.1, 4.1.2) ----
  const REFS = [
    'aria-labelledby',
    'aria-describedby',
    'aria-controls',
    'aria-owns',
    'aria-activedescendant',
    'aria-errormessage',
    'aria-details',
    'aria-flowto',
  ];
  for (const attr of REFS)
    for (const el of document.querySelectorAll(`[${attr}]`)) {
      // False positive (as in axe-core): a collapsed control or an unselected tab may point at a popup or panel that
      // is only mounted when opened; Radix Select/Tabs render them lazily.
      if (
        attr === 'aria-controls' &&
        (el.getAttribute('aria-expanded') === 'false' ||
          (el.getAttribute('role') === 'tab' && el.getAttribute('aria-selected') === 'false'))
      )
        continue;
      for (const id of (el.getAttribute(attr) ?? '').split(/\s+/).filter(Boolean))
        if (!document.getElementById(id)) add('aria-reference', el, `${attr} → #${id} does not exist`);
    }
  for (const label of document.querySelectorAll('label[for]')) {
    const id = label.getAttribute('for') ?? '';
    if (!document.getElementById(id)) add('aria-reference', label, `label for="${id}" does not exist`);
  }

  // ---- dialogs (4.1.2) ----
  for (const d of document.querySelectorAll('[role="dialog"],[role="alertdialog"],dialog[open]'))
    if (rendered(d) && !nameOf(d)) add('dialog-label', d, 'dialog has no accessible name');

  // ---- target size (2.5.8) ----
  const TARGETS =
    'a[href],button,summary,select,input[type="checkbox"],input[type="radio"],[role="button"],[role="link"],[role="tab"],[role="option"],[role="menuitem"],[role="checkbox"],[role="radio"],[role="switch"]';
  const targets = [...document.querySelectorAll(TARGETS)].filter((el) => {
    if (atHidden(el) || !rendered(el) || visuallyHidden(el)) return false;
    // Exception "inline": a link in a sentence. Exception "user agent control": unstyled native check/radio.
    if (el.localName === 'a' && getComputedStyle(el).display === 'inline') return false;
    if (el instanceof HTMLInputElement && getComputedStyle(el).appearance !== 'none') return false;
    // Composite-widget members are sized by their container row (e.g. a listbox option spans the list width).
    return true;
  });
  const rects = targets.map((el) => el.getBoundingClientRect());
  const small = rects.map((r) => r.width < 24 - 0.01 || r.height < 24 - 0.01);
  targets.forEach((el, i) => {
    if (!small[i]) return;
    const r = rects[i] as DOMRect;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    // Exception "spacing": a 24 px circle on the target touches no other target (or another small target's circle).
    const clash = targets.some((other, j) => {
      if (j === i || other.contains(el) || el.contains(other)) return false;
      const o = rects[j] as DOMRect;
      if (small[j]) return Math.hypot(o.left + o.width / 2 - cx, o.top + o.height / 2 - cy) < 24;
      const dx = Math.max(o.left - cx, 0, cx - o.right);
      const dy = Math.max(o.top - cy, 0, cy - o.bottom);
      return Math.hypot(dx, dy) < 12;
    });
    if (clash)
      add(
        'target-size',
        el,
        `${Math.round(r.width)}×${Math.round(r.height)} px and too close to another target`,
      );
  });

  // ---- reflow (1.4.10) ----
  if (opts.narrow) {
    const excess = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    if (excess > 1) add('reflow', null, `page scrolls horizontally by ${excess}px at ${window.innerWidth}px`);
  }
  return out;
}

interface ActionGroup {
  group: string;
  label: string;
  selector: string;
}

function enumerateActions(): {
  count: number;
  groups: ActionGroup[];
  pointerOnly: Array<{ selector: string; label: string }>;
} {
  function selectorOf(el: Element): string {
    const parts: string[] = [];
    let node: Element | null = el;
    while (node && node !== document.body && parts.length < 4) {
      const testId = node.getAttribute('data-testid');
      if (node.id && !/^(radix-|:r)/.test(node.id)) {
        parts.unshift(`${node.localName}#${CSS.escape(node.id)}`);
        break;
      }
      if (testId) {
        parts.unshift(`${node.localName}[data-testid="${testId}"]`);
        break;
      }
      const parent: Element | null = node.parentElement;
      const siblings = parent ? [...parent.children].filter((c) => c.localName === node?.localName) : [];
      parts.unshift(
        siblings.length > 1 ? `${node.localName}:nth-of-type(${siblings.indexOf(node) + 1})` : node.localName,
      );
      node = parent;
    }
    return parts.join(' > ');
  }
  const atHidden = (el: Element) => Boolean(el.closest('[aria-hidden="true"],[inert],[hidden]'));
  const rendered = (el: Element) =>
    el.checkVisibility({ visibilityProperty: true } as CheckVisibilityOptions) &&
    el.getClientRects().length > 0;
  const label = (el: Element) => {
    const role =
      el.getAttribute('role') ??
      (el.localName === 'a'
        ? 'link'
        : el.localName === 'input'
          ? `input[${(el as HTMLInputElement).type}]`
          : el.localName);
    const name = el.getAttribute('aria-label') ?? (el as HTMLInputElement).labels?.[0]?.textContent ?? '';
    const text = (name || el.textContent || el.getAttribute('title') || el.getAttribute('placeholder') || '')
      .trim()
      .replace(/\s+/g, ' ');
    return `${role} "${text.slice(0, 60)}"`;
  };
  const ACTIONABLE =
    'a[href],button,summary,input:not([type="hidden"]),select,textarea,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="option"],[role="switch"],[role="checkbox"],[role="radio"],[role="treeitem"],[role="combobox"],[role="slider"],[tabindex]:not([tabindex="-1"])';
  const COMPOSITE =
    '[role="tablist"],[role="listbox"],[role="radiogroup"],[role="menu"],[role="menubar"],[role="grid"],[role="toolbar"],[role="tree"]';
  // A previous walk's marks would merge groups across screens.
  for (const el of document.querySelectorAll('[data-a11y-group]')) el.removeAttribute('data-a11y-group');
  const groups = new Map<string, ActionGroup>();
  let n = 0;
  const candidates = [...document.querySelectorAll(ACTIONABLE)].filter(
    (el) => !atHidden(el) && rendered(el) && !(el as HTMLButtonElement).disabled,
  );
  for (const el of candidates) {
    let key: string;
    const composite = el.closest(COMPOSITE);
    const radioName = el instanceof HTMLInputElement && el.type === 'radio' ? el.name : '';
    if (radioName) key = `radio:${radioName}`;
    else if (composite && composite !== el) {
      key = composite.getAttribute('data-a11y-group') ?? `g${n++}`;
      composite.setAttribute('data-a11y-group', key);
    } else if (
      (el.getAttribute('tabindex') === '-1' || el.getAttribute('tabindex') === '0') &&
      el.closest('ol,ul')?.querySelector('[tabindex="-1"]')
    ) {
      // Roving tabindex without a composite role (the calendar's day grid): the list is one stop.
      const list = el.closest('ol,ul') as Element;
      key = list.getAttribute('data-a11y-group') ?? `g${n++}`;
      list.setAttribute('data-a11y-group', key);
    } else key = el.getAttribute('data-a11y-group') ?? `e${n++}`;
    el.setAttribute('data-a11y-group', key);
    if (!groups.has(key)) groups.set(key, { group: key, label: label(el), selector: selectorOf(el) });
  }
  // Pointer affordances with no semantics: a pointer cursor on something that is neither actionable nor inside one.
  const pointerOnly: Array<{ selector: string; label: string }> = [];
  for (const el of document.body.querySelectorAll('*')) {
    if (atHidden(el) || el.closest(ACTIONABLE) || el.closest('label') || el.querySelector(ACTIONABLE))
      continue;
    if (getComputedStyle(el).cursor !== 'pointer' || !rendered(el)) continue;
    pointerOnly.push({
      selector: selectorOf(el),
      label: `${el.localName} "${(el.textContent ?? '').trim().slice(0, 40)}"`,
    });
  }
  // Focus indicator baseline: the unfocused outline and box-shadow of every stop.
  (document.activeElement as HTMLElement | null)?.blur();
  const baseline = new Map<Element, string>();
  for (const el of candidates) {
    const s = getComputedStyle(el);
    baseline.set(el, `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor}|${s.boxShadow}`);
  }
  (window as unknown as { __a11yBaseline: Map<Element, string> }).__a11yBaseline = baseline;
  return { count: candidates.length, groups: [...groups.values()], pointerOnly };
}

async function readFocusStop(): Promise<{
  group: string | null;
  selector: string;
  label: string;
  indicatorVisible: boolean;
  obscured: boolean;
} | null> {
  // Read after the next frames: with reduced motion the app keeps a 0.01 ms transition on every property, so the
  // computed outline changes one frame after focus (what a person sees a frame later).
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return null;
  const parts: string[] = [];
  let node: Element | null = el;
  while (node && node !== document.body && parts.length < 4) {
    const testId = node.getAttribute('data-testid');
    if (node.id && !/^(radix-|:r)/.test(node.id)) {
      parts.unshift(`${node.localName}#${CSS.escape(node.id)}`);
      break;
    }
    if (testId) {
      parts.unshift(`${node.localName}[data-testid="${testId}"]`);
      break;
    }
    const parent: Element | null = node.parentElement;
    const siblings = parent ? [...parent.children].filter((c) => c.localName === node?.localName) : [];
    parts.unshift(
      siblings.length > 1 ? `${node.localName}:nth-of-type(${siblings.indexOf(node) + 1})` : node.localName,
    );
    node = parent;
  }
  const s = getComputedStyle(el);
  const now = `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor}|${s.boxShadow}`;
  const baseline = (window as unknown as { __a11yBaseline?: Map<Element, string> }).__a11yBaseline?.get(el);
  // No baseline: the element appeared after enumeration or is a container stop; judge it by having any indicator.
  const hasIndicator =
    (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) || s.boxShadow !== 'none';
  const indicatorVisible = baseline === undefined ? hasIndicator : baseline !== now && hasIndicator;
  // 2.4.11: hit-test the centre and inner corners; the stop is obscured when none of them lands on the element.
  const r = el.getBoundingClientRect();
  const inset = Math.min(2, r.width / 2, r.height / 2);
  const points = [
    [r.left + r.width / 2, r.top + r.height / 2],
    [r.left + inset, r.top + inset],
    [r.right - inset, r.top + inset],
    [r.left + inset, r.bottom - inset],
    [r.right - inset, r.bottom - inset],
  ].filter(([x, y]) => (x ?? -1) >= 0 && (y ?? -1) >= 0 && (x ?? 0) < innerWidth && (y ?? 0) < innerHeight);
  const obscured =
    r.width > 1 &&
    r.height > 1 &&
    points.length > 0 &&
    points.every(([x, y]) => {
      const hit = document.elementFromPoint(x ?? 0, y ?? 0);
      return (
        !hit ||
        !(
          el.contains(hit) ||
          hit.contains(el) ||
          (el instanceof HTMLInputElement && [...(el.labels ?? [])].some((l) => l.contains(hit)))
        )
      );
    });
  const group =
    el.getAttribute('data-a11y-group') ??
    el.closest('[data-a11y-group]')?.getAttribute('data-a11y-group') ??
    null;
  const label = `${el.getAttribute('role') ?? el.localName} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 50)}"`;
  return { group, selector: parts.join(' > '), label, indicatorVisible, obscured };
}
