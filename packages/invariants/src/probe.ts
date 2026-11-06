/**
 * The in-page probe. Serialized and evaluated inside the browser to produce a
 * ScreenSnapshot, so every geometric invariant runs against real computed
 * layout rather than an inference from the DOM.
 *
 * It is written as a string rather than a function because it must not close
 * over anything in the Node scope, and because it is injected into a page that
 * is, by definition, untrusted content (spec 11.1).
 */
export const PROBE_SOURCE = String.raw`
(() => {
  const INTERACTIVE = 'a,button,input,select,textarea,summary,[role=button],[role=link],[role=tab],[onclick],[tabindex]:not([tabindex="-1"])';
  const MAX_ELEMENTS = 1500;

  // Declared before the element loop below, which uses them: functions in this
  // probe hoist, constants do not.
  // Any CSS colour -> sRGB, via a 1x1 canvas. getComputedStyle returns colours
  // in whatever space they were written in, and Tailwind v4 writes oklch(), so
  // a regex over rgb() silently misreads every modern utility colour as absent.
  const colorCanvas = document.createElement('canvas');
  colorCanvas.width = colorCanvas.height = 1;
  const colorCtx = colorCanvas.getContext('2d', { willReadFrequently: true });
  const colorCache = new Map();

  const OPAQUE_MEDIA = new Set(['IMG', 'VIDEO', 'CANVAS', 'IFRAME', 'SVG', 'PICTURE', 'OBJECT', 'EMBED']);


  // Selectors must be UNIQUE in the document. Change-aware rules pair baseline
  // and current elements by selector, and masks and Intent Ledger scopes match
  // by selector. A depth-capped path is not unique on any page with repeated
  // structure -- 652 of 766 elements on a changelog shared a selector, one of
  // them 84 times -- so shift detection compared unrelated elements and
  // reported 1,246 moves on pixel-identical screenshots.
  //
  // Escaped, so the selector is valid CSS: Tailwind classes such as
  // text-muted-foreground/60, text-[12px] and md:flex are not valid raw.
  const selectorCache = new WeakMap();

  function isUnique(selector) {
    try {
      return document.querySelectorAll(selector).length === 1;
    } catch {
      return false;
    }
  }

  function selectorFor(el) {
    const cached = selectorCache.get(el);
    if (cached) return cached;
    const result = buildSelector(el);
    selectorCache.set(el, result);
    return result;
  }

  function buildSelector(el) {
    if (el.dataset && el.dataset.testid) {
      const byTestId = '[data-testid="' + el.dataset.testid.replace(/"/g, '\\"') + '"]';
      if (isUnique(byTestId)) return byTestId;
    }
    if (el.id && isUnique('#' + CSS.escape(el.id))) return '#' + CSS.escape(el.id);

    const parts = [];
    let node = el;
    while (node && node.nodeType === 1) {
      // An ancestor with a unique id is a stable anchor: stop there.
      if (node !== el && node.id && isUnique('#' + CSS.escape(node.id))) {
        parts.unshift('#' + CSS.escape(node.id));
        break;
      }
      let part = node.tagName.toLowerCase();
      if (node.classList && node.classList.length > 0) part += '.' + [...node.classList].slice(0, 2).map((c) => CSS.escape(c)).join('.');
      const parent = node.parentElement;
      if (parent) {
        const siblings = [...parent.children].filter((c) => c.tagName === node.tagName);
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      const candidate = parts.join(' > ');
      // Shortest suffix that names exactly this element, so selectors stay
      // readable where the page allows it.
      if (isUnique(candidate)) return candidate;
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  // True when the point is outside the visible box of an ancestor that clips
  // its overflow, and the element is not painted there under anything else.
  // Covered elements are still in the stack at the point; clipped ones are not.
  // The stack check also keeps an absolutely placed element whose containing
  // block sits outside the scroll box, which that box does not clip.
  function clippedAt(el, x, y) {
    if (document.elementsFromPoint(x, y).includes(el)) return false;
    for (let node = el.parentElement; node && node !== document.documentElement; node = node.parentElement) {
      const cs = getComputedStyle(node);
      if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
      const box = node.getBoundingClientRect();
      if (x < box.left || x > box.right || y < box.top || y > box.bottom) return true;
    }
    return false;
  }

  function hasText(el) {
    for (const child of el.childNodes) {
      if (child.nodeType === 3 && child.textContent.trim().length > 0) return true;
    }
    return false;
  }

  const seen = new Set();
  const elements = [];
  const candidates = [...document.querySelectorAll(INTERACTIVE), ...document.querySelectorAll('*')];

  for (const el of candidates) {
    if (elements.length >= MAX_ELEMENTS) break;
    if (seen.has(el)) continue;
    const interactive = el.matches(INTERACTIVE);
    const style = getComputedStyle(el);
    // A container that clips its content is, by definition, one whose own
    // direct children are elements rather than text -- so collecting only
    // interactive-or-has-text elements makes the overflow detector structurally
    // unable to fire on the very elements it exists to catch.
    const clipping =
      (style.overflow === 'hidden' || style.overflowX === 'hidden') && el.scrollWidth > el.clientWidth + 1;
    if (!interactive && !clipping && !hasText(el)) continue;
    seen.add(el);

    const rect = el.getBoundingClientRect();
    const visible =
      style.visibility !== 'hidden' &&
      style.display !== 'none' &&
      Number(style.opacity) > 0.01 &&
      rect.width > 0 &&
      rect.height > 0;

    let hitSelector;
    if (visible && interactive) {
      const cx = rect.x + rect.width / 2;
      const cy = rect.y + rect.height / 2;
      if (cx >= 0 && cy >= 0 && cx <= innerWidth && cy <= innerHeight) {
        const hit = document.elementFromPoint(cx, cy);
        // Walking up from the hit target means a click landing on a child of the
        // element still counts as reaching it.
        hitSelector = hit && (hit === el || el.contains(hit)) ? selectorFor(el) : hit ? selectorFor(hit) : undefined;
        // An element scrolled out of its scroll box is not painted at its own
        // centre at all: the point hits whatever is around the box. That is
        // reachable by scrolling, not covered, so it is not judged from here.
        if (hitSelector !== undefined && hitSelector !== selectorFor(el) && clippedAt(el, cx, cy)) hitSelector = undefined;
      }
    }

    const background = effectiveBackground(el);
    // False for display:none (on the element or any ancestor) and
    // visibility:hidden. A responsive variant hidden with "hidden md:flex" is
    // 0x0 by design; only an element that IS rendered yet has no box is broken.
    const rendered = typeof el.checkVisibility === 'function'
      ? el.checkVisibility({ visibilityProperty: true })
      : style.display !== 'none' && style.visibility !== 'hidden';

    elements.push({
      selector: selectorFor(el),
      box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      visible,
      rendered,
      interactive,
      zIndex: Number(style.zIndex) || 0,
      hitSelector,
      color: background ? effectiveColor(el, background) : style.color,
      backgroundColor: background ?? undefined,
      fontSize: parseFloat(style.fontSize) || 16,
      overflowHidden: style.overflow === 'hidden' || style.overflowX === 'hidden',
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    });
  }

  function parseRgba(value) {
    if (!value) return null;
    if (colorCache.has(value)) return colorCache.get(value);
    let out = null;
    if (colorCtx) {
      colorCtx.clearRect(0, 0, 1, 1);
      colorCtx.fillStyle = 'rgba(0, 0, 0, 0)';
      colorCtx.fillStyle = value;
      colorCtx.fillRect(0, 0, 1, 1);
      const d = colorCtx.getImageData(0, 0, 1, 1).data;
      out = { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
    }
    colorCache.set(value, out);
    return out;
  }

  // The elements actually painted beneath a point, top first. This includes
  // positioned siblings -- a header over a hero image has the hero behind it,
  // and no ancestor walk can see that.
  function paintStackBelow(el) {
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return null;
    const stack = document.elementsFromPoint(x, y);
    const index = stack.indexOf(el);
    if (index === -1) return null;
    return stack.slice(index);
  }

  function ancestorsOf(el) {
    const out = [];
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) out.push(node);
    return out;
  }

  function effectiveBackground(el) {
    // What is actually painted behind the text: every translucent layer down to
    // the first opaque one, alpha-composited. Taking the first non-transparent
    // colour instead read white-on-18%-white-glass as white-on-white (1.00:1)
    // when it renders as white-on-dark.
    //
    // A background image or media element anywhere in that stack means the
    // colour behind the text is not knowable from computed style. That returns
    // null and the contrast check is skipped rather than guessed -- a finding
    // that cannot be explained is worse than no finding (spec 8.8).
    const stack = paintStackBelow(el) ?? ancestorsOf(el);
    const layers = [];
    for (const node of stack) {
      if (OPAQUE_MEDIA.has(node.tagName.toUpperCase()) && node !== el) return null;
      const cs = getComputedStyle(node);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return null;
      const c = parseRgba(cs.backgroundColor);
      if (c && c.a > 0) {
        layers.push(c);
        if (c.a >= 0.999) break;
      }
    }
    // The canvas behind an unpainted page is white.
    let out = { r: 255, g: 255, b: 255 };
    for (let i = layers.length - 1; i >= 0; i--) {
      const l = layers[i];
      out = { r: l.r * l.a + out.r * (1 - l.a), g: l.g * l.a + out.g * (1 - l.a), b: l.b * l.a + out.b * (1 - l.a) };
    }
    return 'rgb(' + Math.round(out.r) + ', ' + Math.round(out.g) + ', ' + Math.round(out.b) + ')';
  }

  function effectiveColor(el, background) {
    // Translucent text is composited over its background too.
    const fg = parseRgba(getComputedStyle(el).color);
    const bg = parseRgba(background);
    if (!fg || !bg) return getComputedStyle(el).color;
    const a = fg.a;
    return 'rgb(' + Math.round(fg.r * a + bg.r * (1 - a)) + ', ' + Math.round(fg.g * a + bg.g * (1 - a)) + ', ' + Math.round(fg.b * a + bg.b * (1 - a)) + ')';
  }

  // Outgoing links. These are what the app-graph is drawn from: every one is a
  // candidate edge from this screen to another. Collected here rather than
  // per-element because the graph cares about destinations, not geometry.
  const links = [];
  const seenHrefs = new Set();
  for (const anchor of [...document.querySelectorAll('a[href]')].slice(0, 400)) {
    const href = anchor.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) continue;
    let resolved;
    try {
      resolved = new URL(href, location.href).toString();
    } catch {
      continue;
    }
    if (seenHrefs.has(resolved)) continue;
    seenHrefs.add(resolved);
    const rect = anchor.getBoundingClientRect();
    links.push({
      href: resolved,
      text: (anchor.textContent || '').trim().slice(0, 120),
      external: new URL(resolved).origin !== location.origin,
      // Markup hints that a link is a file or a feed rather than a page.
      download: anchor.hasAttribute('download'),
      type: anchor.getAttribute('type') || undefined,
      selector: selectorFor(anchor),
      box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    });
  }

  const images = [...document.images].slice(0, 300).map((img) => ({
    selector: selectorFor(img),
    naturalWidth: img.naturalWidth,
    naturalHeight: img.naturalHeight,
    complete: img.complete,
    alt: img.alt,
  }));

  return {
    url: location.href,
    title: document.title,
    elements,
    links,
    images,
    document: {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      scrollHeight: document.documentElement.scrollHeight,
      clientHeight: document.documentElement.clientHeight,
      hasStylesheets: document.styleSheets.length > 0,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
    },
  };
})()
`;
