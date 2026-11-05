import { chromium, type Page } from 'playwright';
import { WebDriver } from './web.js';

type LaunchHandle = { cdpUrl: string; close(): Promise<void> };

/** Where the app's CDP endpoint comes from: a running app, or one Bugpatrol launches on connect. */
export type ElectronTarget = string | (() => Promise<LaunchHandle>);

/** Reuse web observation over CDP; owns the Electron app only when it launched it. */
export class ElectronDriver extends WebDriver {
  override readonly platform = 'electron' as const;
  private launched?: LaunchHandle;

  constructor(
    private readonly target: ElectronTarget,
    allowedOrigins: string[] = [],
  ) {
    super({ url: '', viewport: { width: 1280, height: 800 }, allowedOrigins });
  }

  override async connect(): Promise<void> {
    let cdpUrl: string;
    if (typeof this.target === 'string') {
      cdpUrl = this.target;
    } else {
      this.launched = await this.target();
      cdpUrl = this.launched.cdpUrl;
    }
    this.browser = await chromium.connectOverCDP(cdpUrl);
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
    // CDP browser.close disconnects Playwright; it does not stop Electron, so a launched app is stopped here.
    try {
      await this.browser?.close();
    } finally {
      await this.launched?.close();
    }
  }
}
