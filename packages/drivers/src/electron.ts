import { chromium, type Page } from 'playwright';
import { WebDriver } from './web.js';

/** Reuse web observation over CDP without taking ownership of the Electron app. */
export class ElectronDriver extends WebDriver {
  override readonly platform = 'electron' as const;

  constructor(
    private readonly cdpUrl: string,
    allowedOrigins: string[] = [],
  ) {
    super({ url: '', viewport: { width: 1280, height: 800 }, allowedOrigins });
  }

  override async connect(): Promise<void> {
    this.browser = await chromium.connectOverCDP(this.cdpUrl);
    this.context = this.browser.contexts()[0];
    if (!this.context) {
      throw new Error('Electron CDP connection has no context');
    }
    this.page = await this.choosePage();
    this.home = new URL(this.page.url());
    for (const page of this.context.pages()) {
      this.watch(page);
    }
    this.context.on('page', (page) => this.watch(page));
  }

  private async choosePage(): Promise<Page> {
    const pages = this.context!.pages().filter(
      (page) => !page.url().startsWith('devtools://') && page.url() !== 'about:blank',
    );
    if (pages.length === 0) {
      throw new Error('Electron CDP connection has no app page');
    }
    for (const page of pages) {
      const focused = await page
        .evaluate(() => document.hasFocus() && document.visibilityState === 'visible')
        .catch(() => false);
      if (focused) {
        return page;
      }
    }
    return pages[0]!;
  }

  override async close(): Promise<void> {
    // CDP browser.close disconnects Playwright; it does not stop Electron.
    await this.browser?.close();
  }
}
