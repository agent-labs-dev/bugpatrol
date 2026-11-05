import { chromium, type Page } from 'playwright';
import { WebDriver } from './web.js';

// An app may open its first window after CDP is ready; this matches the launcher's own readiness timeout.
const PAGE_TIMEOUT_MS = 30_000;
const PAGE_POLL_MS = 100;

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

  /** The app's pages, polled because a window can open, or leave about:blank, after connect. */
  private async appPages(): Promise<Page[]> {
    const deadline = Date.now() + PAGE_TIMEOUT_MS;
    while (true) {
      const pages = this.context!.pages().filter(
        (page) => !page.url().startsWith('devtools://') && page.url() !== 'about:blank',
      );
      if (pages.length > 0) return pages;
      if (Date.now() >= deadline) {
        throw new Error(`Electron CDP connection has no app page after ${PAGE_TIMEOUT_MS / 1000}s`);
      }
      await new Promise((resolve) => setTimeout(resolve, PAGE_POLL_MS));
    }
  }

  private async choosePage(): Promise<Page> {
    const pages = await this.appPages();
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
