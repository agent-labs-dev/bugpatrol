import { InfrastructureError } from '@bugpatrol/core';
import { chromium, type Page } from 'playwright';
import { WebDriver } from './web.js';

type AppPageCandidate = { url: string; visible: boolean; focused: boolean };

const browserOwnedProtocols = new Set([
  'data:',
  'about:',
  'blob:',
  'javascript:',
  'view-source:',
  'chrome:',
  'chrome-error:',
  'chrome-extension:',
  'chrome-untrusted:',
  'devtools:',
]);

const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);

/** An app scheme or a loopback dev server, rather than a remote page a window happens to show (an OAuth window). */
function local(url: URL): boolean {
  return (url.protocol !== 'http:' && url.protocol !== 'https:') || loopbackHosts.has(url.hostname);
}

/**
 * The page bugpatrol treats as the app: a visible page first, then an app page over a remote one, then the focused one.
 * Visibility leads so a hidden background window never beats the window a person sees.
 */
export function appPage(candidates: AppPageCandidate[]): number | undefined {
  let best: { index: number; rank: number } | undefined;
  candidates.forEach((candidate, index) => {
    if (!URL.canParse(candidate.url)) return;
    const url = new URL(candidate.url);
    if (browserOwnedProtocols.has(url.protocol)) return;
    const rank = (candidate.visible ? 0 : 4) + (local(url) ? 0 : 2) + (candidate.focused ? 0 : 1);
    if (best === undefined || rank < best.rank) best = { index, rank };
  });
  return best?.index;
}

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
    const pages = this.context!.pages();
    const candidates = await Promise.all(
      pages.map(async (page) => {
        const url = page.url();
        const state = await page
          .evaluate(() => ({ visible: document.visibilityState === 'visible', focused: document.hasFocus() }))
          .catch(() => ({ visible: false, focused: false }));
        return { url, ...state };
      }),
    );
    const index = appPage(candidates);
    if (index === undefined) {
      throw new InfrastructureError(
        `Electron CDP connection has no app page. URLs seen: ${candidates.map(({ url }) => url).join(', ')}`,
      );
    }
    return pages[index]!;
  }

  override async close(): Promise<void> {
    // CDP browser.close disconnects Playwright; it does not stop Electron.
    await this.browser?.close();
  }
}
