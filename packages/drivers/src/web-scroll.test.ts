import { type Browser, type BrowserContext, chromium, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { observeDom } from './dom.js';
import { WebDriver } from './web.js';

let browser: Browser;
let context: BrowserContext;
let page: Page;

class FixtureDriver extends WebDriver {
  bind(pageValue: Page): void {
    this.browser = browser;
    this.context = context;
    this.page = pageValue;
  }
}

beforeAll(async () => {
  browser = await chromium.launch();
  context = await browser.newContext({ viewport: { width: 800, height: 600 } });
  page = await context.newPage();
});

afterAll(async () => {
  await browser?.close();
});

const rows = Array.from({ length: 40 }, (_, index) => `<li>Row ${index + 1}</li>`).join('');

describe('scroll with a target', () => {
  it('turns the wheel over the target, wherever the pointer was left', async () => {
    await page.setContent(`
      <body style="margin:0">
        <div id="backdrop" style="position:fixed;inset:0;background:#0004"></div>
        <div role="dialog" style="position:fixed;left:400px;top:100px;width:300px">
          <ul id="list" role="list" aria-label="Results" style="height:120px;overflow-y:auto;margin:0">${rows}</ul>
        </div>
      </body>
    `);
    const driver = new FixtureDriver({ url: '', viewport: { width: 800, height: 600 } });
    driver.bind(page);
    await driver.observe();
    const list = (await observeDom(page)).find((element) => element.selector === '#list');
    expect(list).toBeDefined();
    // The pointer sits over the backdrop, as after a click on another dialog's button.
    await page.mouse.move(50, 500);

    const result = await driver.act({ kind: 'scroll', direction: 'down', ref: list!.ref });

    expect(result.ok).toBe(true);
    await expect.poll(() => page.locator('#list').evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  });

  it('turns the wheel at a point target', async () => {
    await page.setContent(`
      <body style="margin:0">
        <ul id="list" style="position:absolute;left:500px;top:300px;width:200px;height:120px;overflow-y:auto;margin:0">${rows}</ul>
      </body>
    `);
    const driver = new FixtureDriver({ url: '', viewport: { width: 800, height: 600 } });
    driver.bind(page);
    await driver.observe();
    await page.mouse.move(10, 10);

    const result = await driver.act({ kind: 'scroll', direction: 'down', locator: { point: { x: 600, y: 360 } } });

    expect(result.ok).toBe(true);
    await expect.poll(() => page.locator('#list').evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  });
});
