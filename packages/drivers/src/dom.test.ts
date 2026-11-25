import { type Browser, type BrowserContext, chromium, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { observeDom, resolveTarget } from './dom.js';
import { openAllowed, WebDriver } from './web.js';

let browser: Browser;
let context: BrowserContext;
let page: Page;

class FixtureDriver extends WebDriver {
  bind(browserValue: Browser, contextValue: BrowserContext, pageValue: Page): void {
    this.browser = browserValue;
    this.context = contextValue;
    this.page = pageValue;
  }
}

beforeAll(async () => {
  browser = await chromium.launch();
  context = await browser.newContext({ viewport: { width: 800, height: 600 } });
  page = await context.newPage();
  await page.setContent(`
    <label for="email">Email address</label>
    <input id="email" type="email" value="before">
    <label>Unbound note</label>
    <label>Middle name <input id="middle"></label>
    <input data-testid="secret" type="password" value="not-a-secret" aria-label="Password">
    <input placeholder="Search things">
    <button data-testid="save">Save</button>
    <button>Save</button>
    <h1>Dashboard</h1>
    <div role="button" aria-label="More options">...</div>
  `);
});

afterAll(async () => {
  await browser?.close();
});

describe('DOM driver', () => {
  it('records document-order refs, accessible names, safe values, and unique selectors', async () => {
    const elements = await observeDom(page);
    expect(elements.map((element) => element.ref)).toEqual(elements.map((_, index) => `e${index + 1}`));
    expect(elements.find((element) => element.selector === '#email')?.name).toBe('Email address');
    expect(elements.find((element) => element.testId === 'secret')).toMatchObject({
      name: 'Password',
      value: '••••',
    });
    expect(elements.filter((element) => element.name === 'Email address')).toHaveLength(1);
    expect(elements.filter((element) => element.name === 'Middle name')).toHaveLength(1);
    expect(elements.find((element) => element.name === 'Unbound note')?.role).toBe('label');
    expect(elements.find((element) => element.name === 'Search things')?.role).toBe('textbox');
    expect(elements.find((element) => element.name === 'Dashboard')?.role).toBe('heading');
    for (const element of elements) expect(await page.locator(element.selector!).count()).toBe(1);
  });

  it('resolves locators in priority order and marks point fallback degraded', async () => {
    const byId = await resolveTarget(page, { testId: 'save', role: 'button', name: 'Other' });
    expect(await byId.locator?.getAttribute('data-testid')).toBe('save');
    const byRole = await resolveTarget(page, { testId: 'missing', role: 'button', name: 'Save' });
    expect(byRole.degraded).toBe(false);
    const byText = await resolveTarget(page, { text: 'Dashboard' });
    expect(await byText.locator?.textContent()).toBe('Dashboard');
    const byPoint = await resolveTarget(page, { testId: 'missing', point: { x: 12, y: 34 } });
    expect(byPoint).toMatchObject({ point: { x: 12, y: 34 }, degraded: true });
  });

  it('waits for a named target to render before falling back to its point', async () => {
    await page.evaluate(() => {
      setTimeout(() => {
        const field = document.createElement('input');
        field.setAttribute('aria-label', 'Late username');
        document.body.append(field);
      }, 700);
    });
    const late = { role: 'textbox', name: 'Late username', point: { x: 1, y: 1 } };
    expect(await resolveTarget(page, late)).toMatchObject({ degraded: true });
    const resolved = await resolveTarget(page, late, undefined, 3000);
    expect(resolved.degraded).toBe(false);
    expect(await resolved.locator?.getAttribute('aria-label')).toBe('Late username');
  });

  it('acts on refs and records stable locators without refs', async () => {
    const driver = new FixtureDriver({ url: '', viewport: { width: 800, height: 600 } });
    driver.bind(browser, context, page);
    const observation = await driver.observe();
    const input = observation.elements.find((element) => element.name === 'Email address')!;
    const typed = await driver.act({ kind: 'type', ref: input.ref, value: 'after' });
    expect(typed).toMatchObject({
      ok: true,
      step: {
        kind: 'type',
        target: { role: 'textbox', name: 'Email address', selector: '#email' },
      },
    });
    expect(JSON.stringify(typed.step)).not.toContain('"ref"');
    expect(await page.locator('#email').inputValue()).toBe('after');
    const appended = await driver.act({ kind: 'type', ref: input.ref, value: ' more', append: true });
    expect(await page.locator('#email').inputValue()).toBe('after more');
    expect(appended.step).toMatchObject({ kind: 'type', append: true });
    const save = observation.elements.find((element) => element.testId === 'save')!;
    const tapped = await driver.act({ kind: 'tap', ref: save.ref });
    expect(tapped).toMatchObject({ ok: true, step: { kind: 'tap', target: { testId: 'save' } } });
  });
});

describe('controls the explorer could not see or use', () => {
  let other: Page;
  let driver: FixtureDriver;

  beforeAll(async () => {
    other = await context.newPage();
    await other.setContent(`
      <details><summary>Shipping details</summary><p>Ships in 2 days</p></details>
      <button aria-expanded="false" aria-controls="more">More</button>
      <label for="photo" style="padding: 8px">Add photo</label>
      <input id="photo" type="file" accept="image/*" hidden>
      <input id="doc" type="file" aria-label="Attach document">
      <p id="files"></p>
      <button id="remove" onclick="document.getElementById('files').textContent = confirm('Remove it?') ? 'removed' : 'kept'">Remove</button>
      <button id="later" onclick="setTimeout(() => { document.getElementById('files').textContent = confirm('Delete later?') ? 'deleted' : 'spared'; }, 800)">Remove later</button>
      <script>
        for (const id of ['photo', 'doc'])
          document.getElementById(id).addEventListener('change', (event) => {
            const file = event.target.files[0];
            document.getElementById('files').textContent = id + ':' + file.name + ':' + file.size;
          });
      </script>
    `);
    driver = new FixtureDriver({ url: 'http://app.test/', viewport: { width: 800, height: 600 } });
    driver.bind(browser, context, other);
  });

  it('lists disclosures with their state, and a label that stands in for a hidden file input', async () => {
    const elements = (await driver.observe()).elements;
    expect(elements.find((element) => element.name === 'Shipping details')).toMatchObject({
      interactive: true,
      expanded: false,
    });
    expect(elements.find((element) => element.name === 'More')?.expanded).toBe(false);
    expect(elements.find((element) => element.name === 'Add photo')?.interactive).toBe(true);
    expect(elements.find((element) => element.name === 'Attach document')?.role).toBe('button');
  });

  it('uploads a sample file through a file input or the control that opens the picker', async () => {
    let elements = (await driver.observe()).elements;
    const label = elements.find((element) => element.name === 'Add photo')!;
    const viaLabel = await driver.act({ kind: 'upload', ref: label.ref, file: 'image' });
    expect(viaLabel).toMatchObject({
      ok: true,
      step: { kind: 'upload', file: 'image', target: { name: 'Add photo' } },
    });
    expect(await other.locator('#files').textContent()).toMatch(/^photo:bugpatrol-sample\.png:\d+$/);
    elements = (await driver.observe()).elements;
    const input = elements.find((element) => element.name === 'Attach document')!;
    expect((await driver.act({ kind: 'upload', ref: input.ref, file: 'pdf' })).ok).toBe(true);
    expect(await other.locator('#files').textContent()).toMatch(/^doc:bugpatrol-sample\.pdf:\d+$/);
    const heading = (await driver.observe()).elements.find((element) => element.name === 'More')!;
    const refused = await driver.act({ kind: 'upload', ref: heading.ref, file: 'text' });
    expect(refused).toMatchObject({ ok: false, error: expect.stringContaining('No file picker opened') });
  }, 15_000);

  it('accepts a native confirm and reports it in the next observation', async () => {
    const remove = (await driver.observe()).elements.find((element) => element.name === 'Remove')!;
    expect((await driver.act({ kind: 'tap', ref: remove.ref })).ok).toBe(true);
    expect(await other.locator('#files').textContent()).toBe('removed');
    expect((await driver.observe()).dialogs).toEqual(['confirm "Remove it?": accepted']);
    expect((await driver.observe()).dialogs).toEqual([]);
  });

  it('dismisses a native confirm when the tap requests the cancel path', async () => {
    const remove = (await driver.observe()).elements.find((element) => element.name === 'Remove')!;
    const result = await driver.act({ kind: 'tap', ref: remove.ref, dialog: 'dismiss' });
    expect(result).toMatchObject({ ok: true, step: { kind: 'tap', dialog: 'dismiss' } });
    expect(await other.locator('#files').textContent()).toBe('kept');
    expect((await driver.observe()).dialogs).toEqual(['confirm "Remove it?": dismissed']);
  });

  it('dismisses a confirm the tap opens after a later wait has started', async () => {
    const later = (await driver.observe()).elements.find((element) => element.name === 'Remove later')!;
    expect((await driver.act({ kind: 'tap', ref: later.ref, dialog: 'dismiss' })).ok).toBe(true);
    expect((await driver.act({ kind: 'wait', ms: 1200 })).ok).toBe(true);
    await expect.poll(() => other.locator('#files').textContent()).toBe('spared');
  });

  it('changes the page viewport and records the replayable size', async () => {
    const result = await driver.act({ kind: 'viewport', width: 320, height: 240 });
    expect(result).toMatchObject({ ok: true, step: { kind: 'viewport', width: 320, height: 240 } });
    expect(await other.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({
      width: 320,
      height: 240,
    });
    expect((await driver.observe()).viewport).toMatchObject({ width: 320, height: 240 });
  });

  it('captures plain visible viewport text (including inline spans) and excludes hidden or scrolled-out text', async () => {
    const textPage = await context.newPage();
    try {
      await textPage.setContent(`
        <label for="runs-on">Runs on</label>
        <select id="runs-on"><option value="dev_1" selected>Barry</option></select>
        <p>A run starts on <strong>barry</strong>.</p>
        <div style="display:none">Hidden display text</div>
        <div style="visibility:hidden">Hidden visibility text</div>
        <div style="opacity:0">Transparent text</div>
        <div style="width:1px;height:1px;overflow:hidden">Screen reader only text</div>
        <div style="height:40px;overflow:auto">
          <div style="height:120px">Visible top line</div>
          <p>Scrolled below container</p>
        </div>
        <p>Token secret-value-123 here</p>
      `);
      const textDriver = new FixtureDriver({
        url: '',
        viewport: { width: 800, height: 600 },
        redact: (value) => value.replaceAll('secret-value-123', '[REDACTED]'),
      });
      textDriver.bind(browser, context, textPage);
      const observation = await textDriver.observe();
      expect(observation.visibleText).toContain('A run starts on barry.');
      expect(observation.visibleText).toContain('Barry');
      expect(observation.visibleText).toContain('Visible top line');
      expect(observation.visibleText).toContain('Token [REDACTED] here');
      expect(observation.visibleText).not.toContain('secret-value-123');
      expect(observation.visibleText).not.toContain('Hidden display text');
      expect(observation.visibleText).not.toContain('Hidden visibility text');
      expect(observation.visibleText).not.toContain('Transparent text');
      expect(observation.visibleText).not.toContain('Screen reader only text');
      expect(observation.visibleText).not.toContain('Scrolled below container');
    } finally {
      await textPage.close();
    }
  });
});

describe('openAllowed', () => {
  const web = new URL('http://localhost:3000/app');
  const packaged = new URL('file:///opt/app/resources/index.html');
  it.each([
    ['http://localhost:3000/settings', web, [], true],
    ['https://localhost:3000/', web, [], false],
    ['https://accounts.example.com/login', web, [], false],
    ['https://accounts.example.com/login', web, ['https://accounts.example.com'], true],
    ['https://accounts.example.com/login', web, ['not a url'], false],
    ['file:///etc/passwd', web, [], false],
    ['javascript:alert(1)', web, [], false],
    ['data:text/html,hi', web, [], false],
    ['file:///opt/app/resources/settings.html', packaged, [], true],
    ['file:///etc/passwd', packaged, [], false],
  ] as const)('%s from %s with %j: %s', (url, home, allowed, expected) => {
    expect(openAllowed(new URL(url), home, [...allowed])).toBe(expected);
  });
});
