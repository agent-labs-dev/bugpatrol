import { evaluateAll, PROBE_SOURCE, type ScreenSnapshot } from '@bugpatrol/invariants';
import { type Browser, chromium, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1024, height: 700 } });
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

async function snapshot(html: string): Promise<ScreenSnapshot> {
  await page.setContent(`<!doctype html><html><body style="margin:0">${html}</body></html>`);
  const probe = (await page.evaluate(PROBE_SOURCE)) as Omit<ScreenSnapshot, 'screenId' | 'viewport' | 'consoleErrors'>;
  return { ...probe, screenId: '/', viewport: { name: 'desktop', width: 1024, height: 700 }, consoleErrors: [] };
}

const rules = (s: ScreenSnapshot) => evaluateAll(s).map((v) => v.ruleId);

describe('probe: contrast against what is actually painted', () => {
  it('composites a translucent background over the dark layer beneath it', async () => {
    // White text on 18% white glass over navy. It renders as white-on-dark;
    // reading only the glass colour made it white-on-white, 1.00:1.
    const s = await snapshot(`
      <div style="background:#081222;padding:40px">
        <button id="glass" style="background:rgba(255,255,255,0.18);color:#fff;border:0;padding:12px 24px;font-size:16px">Channels</button>
      </div>`);
    expect(rules(s)).not.toContain('usability/contrast');
  });

  it('still flags genuinely unreadable text', async () => {
    const s = await snapshot(`<p style="color:#cdd1d8;background:#fff;font-size:16px">Low contrast</p>`);
    expect(rules(s)).toContain('usability/contrast');
  });

  it('treats semi-transparent black as a real layer, not as transparent', async () => {
    // rgba(0, 0, 0, 0.5) used to match a startsWith("rgba(0, 0, 0, 0") check
    // and be skipped, so dark overlays were ignored entirely.
    const s = await snapshot(`
      <div style="background:#fff">
        <div style="background:rgba(0,0,0,0.5);padding:20px">
          <p style="color:#fff;font-size:16px;margin:0">On a dark overlay</p>
        </div>
      </div>`);
    const text = s.elements.find((e) => e.selector.includes('p'))!;
    // 50% black over white is mid-grey. Canvas stores alpha in 8 bits, so 0.5
    // round-trips as 128/255 and the channel can land on 127 or 128.
    const [r, g, b] = text.backgroundColor!.match(/\d+/g)!.map(Number);
    for (const channel of [r, g, b]) expect(Math.abs(channel! - 128)).toBeLessThanOrEqual(1);
  });

  it('reads oklch() colours, which Tailwind v4 emits for every utility', async () => {
    const s = await snapshot(
      `<button style="background:oklch(0.52 0.21 278);color:#fff;border:0;padding:12px;font-size:16px">Continue</button>`,
    );
    const button = s.elements.find((e) => e.selector.includes('button'))!;
    expect(button.backgroundColor).not.toBe('rgb(255, 255, 255)');
    expect(rules(s)).not.toContain('usability/contrast');
  });

  it('sees a positioned sibling painted behind the text, not just ancestors', async () => {
    // A transparent header over a full-bleed hero: the hero is a sibling, so an
    // ancestor walk reached the pale page background and reported 1.4:1.
    const s = await snapshot(`
      <div style="background:#cad5b2;position:relative;height:300px">
        <div style="position:absolute;inset:0;background:#1d4ed8"></div>
        <header style="position:relative;padding:20px">
          <a href="/docs" style="color:#f3f5ee;font-size:16px">Docs</a>
        </header>
      </div>`);
    const link = s.elements.find((e) => e.selector.includes(' a') || e.selector.endsWith('a'))!;
    expect(link.backgroundColor).toBe('rgb(29, 78, 216)');
    expect(rules(s)).not.toContain('usability/contrast');
  });

  it('declines to judge text over a hero image it cannot read', async () => {
    const s = await snapshot(`
      <div style="position:relative;height:300px">
        <img alt="" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" style="position:absolute;inset:0;width:100%;height:100%">
        <p style="position:relative;color:#eee;font-size:16px;padding:20px">Caption</p>
      </div>`);
    expect(rules(s)).not.toContain('usability/contrast');
  });

  it('declines to judge text over a background image rather than guessing', async () => {
    const s = await snapshot(`
      <div style="background-image:linear-gradient(#000,#fff);padding:20px">
        <p style="color:#777;font-size:16px;margin:0">Over a gradient</p>
      </div>`);
    const text = s.elements.find((e) => e.selector.includes('p'))!;
    expect(text.backgroundColor).toBeUndefined();
    expect(rules(s)).not.toContain('usability/contrast');
  });
});

describe('probe: zero-size interactive elements', () => {
  it('does not flag a responsive variant hidden with display:none', async () => {
    // Tailwind's `hidden md:flex`: 0x0 on purpose, unreachable by design.
    const s = await snapshot(`<nav><a href="/a" style="display:none">Desktop link</a></nav>`);
    expect(rules(s)).not.toContain('layout/zero-size-interactive');
  });

  it('does not flag a link inside a display:none ancestor', async () => {
    const s = await snapshot(`<div style="display:none"><a href="/a">Hidden</a></div>`);
    expect(rules(s)).not.toContain('layout/zero-size-interactive');
  });

  it('still flags a rendered button that collapsed to nothing', async () => {
    const s = await snapshot(`<button style="width:0;height:0;padding:0;border:0;overflow:hidden">Save</button>`);
    expect(rules(s)).toContain('layout/zero-size-interactive');
  });
});

describe('probe: occlusion inside a scroll container', () => {
  // A board wider than its scroll box, keys rotated and absolutely placed, as
  // on a narrow screen. Keys past the right edge are scrolled out of view: a
  // point test there lands on the shell around the board.
  const board = (extra = '') => `
    <div class="shell" style="padding:20px;background:#eee">
      <div class="board" style="width:300px;height:200px;overflow-x:auto;overflow-y:hidden;position:relative">
        <div style="position:relative;width:900px;height:180px">
          ${[20, 140, 260, 420, 600, 780]
            .map(
              (left, index) =>
                `<button class="key" style="position:absolute;left:${left}px;top:60px;width:60px;height:40px;transform:rotate(${index % 2 ? 12 : -12}deg)">K${index + 1}</button>`,
            )
            .join('')}
          ${extra}
        </div>
      </div>
    </div>`;

  it('does not call a key scrolled out of its board occluded', async () => {
    const s = await snapshot(board());
    expect(rules(s)).not.toContain('layout/occlusion');
  });

  it('does not call a rotated key in view occluded', async () => {
    const s = await snapshot(board());
    const visible = s.elements.filter((e) => e.selector.includes('key') && e.box.x + e.box.width < 320);
    expect(visible.length).toBeGreaterThan(0);
    for (const key of visible) expect(key.hitSelector).toBe(key.selector);
  });

  it('still reports a key in view that something covers', async () => {
    const s = await snapshot(
      board(
        `<div class="cover" style="position:absolute;left:120px;top:40px;width:120px;height:90px;background:#000"></div>`,
      ),
    );
    const found = evaluateAll(s).filter((v) => v.ruleId === 'layout/occlusion');
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toContain('div.cover');
  });
});

describe('probe: the rendered pixels overrule the DOM', () => {
  async function snapshotWithPixels(html: string): Promise<ScreenSnapshot> {
    const s = await snapshot(html);
    const shot = await page.screenshot({ fullPage: true });
    const { confirmContrastWithPixels } = await import('./pixel-contrast.js');
    confirmContrastWithPixels(s.elements, shot, { deviceScaleFactor: 1, masks: [] });
    return s;
  }

  it('drops a false alarm from a decorative layer the DOM cannot see', async () => {
    // A real marketing-site /download pattern. The blue hero sets pointer-events:none,
    // so elementsFromPoint skips it and the DOM reads light text on the pale
    // page background (1.4:1). The screenshot shows light text on blue.
    const s = await snapshotWithPixels(`
      <div style="background:#cad5b2;position:relative;height:300px">
        <div style="position:absolute;inset:0;background:#1d4ed8;pointer-events:none"></div>
        <header style="position:relative;padding:20px">
          <a href="/docs" style="color:#f3f5ee;font-size:16px">Docs</a>
        </header>
      </div>`);
    const link = s.elements.find((e) => e.selector.endsWith('a'))!;
    expect(link.pixelContrast).toBeGreaterThan(4.5);
    expect(rules(s)).not.toContain('usability/contrast');
  });

  it('confirms a genuine failure and reports the measured ratio', async () => {
    const s = await snapshotWithPixels(
      `<p style="color:#b9bec7;background:#fff;font-size:16px;padding:8px">Faint label</p>`,
    );
    const finding = evaluateAll(s).find((v) => v.ruleId === 'usability/contrast');
    expect(finding?.message).toContain('Confirmed on the rendered pixels');
    expect(finding?.detail?.pixelConfirmed).toBe(true);
  });
});

describe('probe: selectors', () => {
  it('escapes Tailwind class names so reported selectors are valid CSS', async () => {
    const s = await snapshot(`<p class="text-muted-foreground/60 text-[12px] md:flex">Label</p>`);
    const selector = s.elements.find((e) => e.selector.includes('text-'))!.selector;
    // querySelector throws on an invalid selector; this must resolve.
    const found = await page.evaluate((sel) => document.querySelector(sel)?.textContent, selector);
    expect(found).toBe('Label');
  });
});

describe('probe: selectors are unique in the document', () => {
  // A real marketing-site /changelog pattern: dozens of release entries with identical
  // structure. A depth-capped selector named them all the same thing.
  const changelog = (entries: number) =>
    '<main>' +
    Array.from(
      { length: entries },
      (_, i) =>
        `<article class="entry"><div class="meta"><div class="row"><div class="tags"><span class="tag">#tag${i}</span></div></div></div></article>`,
    ).join('') +
    '</main>';

  it('gives every element a selector that matches only that element', async () => {
    const s = await snapshot(changelog(40));
    const selectors = s.elements.map((e) => e.selector);
    expect(new Set(selectors).size).toBe(selectors.length);
    for (const selector of selectors.slice(0, 10)) {
      const count = await page.evaluate((sel) => document.querySelectorAll(sel).length, selector);
      expect(count).toBe(1);
    }
  });

  it('reports no layout shift when nothing moved, however repetitive the page', async () => {
    // Regression: pairing baseline and current elements by a shared selector
    // compared unrelated elements and reported 1,246 moves on pixel-identical
    // screenshots.
    const baseline = await snapshot(changelog(40));
    const current = await snapshot(changelog(40));
    const shifts = evaluateAll(current, { baseline }).filter((v) => v.ruleId === 'layout/shift-versus-baseline');
    expect(shifts).toEqual([]);
  });

  it('still detects a real shift in a repeated structure', async () => {
    const baseline = await snapshot(changelog(5));
    await page.setContent(
      `<!doctype html><html><body style="margin:0">${changelog(5).replace('<main>', '<main style="padding-top:40px">')}</body></html>`,
    );
    const probe = (await page.evaluate(PROBE_SOURCE)) as Omit<
      ScreenSnapshot,
      'screenId' | 'viewport' | 'consoleErrors'
    >;
    const current: ScreenSnapshot = {
      ...probe,
      screenId: '/',
      viewport: { name: 'desktop', width: 1024, height: 700 },
      consoleErrors: [],
    };
    const shifts = evaluateAll(current, { baseline }).filter((v) => v.ruleId === 'layout/shift-versus-baseline');
    expect(shifts.length).toBe(5);
  });

  it('prefers a short selector when one is already unique', async () => {
    const s = await snapshot('<div><p class="only">Alone</p></div>');
    expect(s.elements.find((e) => e.selector.includes('only'))!.selector).toBe('p.only');
  });

  it('falls back to structure when a test id is duplicated', async () => {
    const s = await snapshot('<button data-testid="row-action">A</button><button data-testid="row-action">B</button>');
    const selectors = s.elements.filter((e) => e.interactive).map((e) => e.selector);
    expect(new Set(selectors).size).toBe(2);
  });
});
