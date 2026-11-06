import { isLoopback } from '@bugpatrol/contract';
import { InfrastructureError } from '@bugpatrol/core';
import { chromium, type Page } from 'playwright';
import { guardBrowser, type ReadOnlyOptions } from './readonly.js';
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

/** An app scheme or a loopback dev server, rather than a remote page a window happens to show (an OAuth window). */
function local(url: URL): boolean {
  return (url.protocol !== 'http:' && url.protocol !== 'https:') || isLoopback(url.href);
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

/** Scheme and host only: a data: or blob: URL carries the page itself, which can hold anything the app rendered. */
function pageLabel(url: string): string {
  if (!URL.canParse(url)) return '(unparsable)';
  const parsed = new URL(url);
  return parsed.host ? `${parsed.protocol}//${parsed.host}` : parsed.protocol;
}

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
    private readonly pageTimeoutMs = PAGE_TIMEOUT_MS,
    readOnly?: ReadOnlyOptions,
  ) {
    super({ url: '', viewport: { width: 1280, height: 800 }, allowedOrigins, readOnly });
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
    // Before any page is chosen, so no request of the app slips past.
    const { readOnly } = this.options;
    if (readOnly) await guardBrowser(this.context, readOnly);
    this.page = await this.choosePage();
    // WebSocket routes apply from a page's next load, and a socket opened before connect is not
    // held back at all, so each app page loads again.
    if (readOnly && (readOnly.websockets === 'block' || readOnly.dropFrames.length)) {
      for (const page of this.context.pages()) {
        if (URL.canParse(page.url()) && !browserOwnedProtocols.has(new URL(page.url()).protocol)) await page.reload();
      }
    }
    this.home = new URL(this.page.url());
    for (const page of this.context.pages()) {
      this.watch(page);
    }
    this.context.on('page', (page) => this.watch(page));
  }

  /** The page to drive, polled because the app can open its first window, or leave about:blank, after connect. */
  private async choosePage(): Promise<Page> {
    const deadline = Date.now() + this.pageTimeoutMs;
    while (true) {
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
      if (index !== undefined) return pages[index]!;
      if (Date.now() >= deadline) {
        throw new InfrastructureError(
          `Electron CDP connection has no app page after ${this.pageTimeoutMs / 1000}s. Pages seen: ${candidates.map(({ url }) => pageLabel(url)).join(', ')}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, PAGE_POLL_MS));
    }
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
