import { sha256 } from '@bugpatrol/core';
import { PROBE_SOURCE, type ScreenSnapshot } from '@bugpatrol/invariants';
import { type Browser, type BrowserContext, type CDPSession, chromium, type Page } from 'playwright';
import { observeDom, resolveTarget, stepFor } from './dom.js';
import type { ActResult, Driver, DriverAction, Observation, UiElement } from './types.js';
import { encodeFrames, type Frame, hasFfmpeg } from './video.js';

export type WebOptions = {
  url: string;
  viewport: { width: number; height: number };
  headless?: boolean;
};

type TargetResult = { degraded: boolean; element?: UiElement };

/** Browser and CDP drivers share observation and action semantics across startup modes. */
export class WebDriver implements Driver {
  readonly platform: 'web' | 'electron' | 'api' = 'web';
  protected browser?: Browser;
  protected context?: BrowserContext;
  protected page?: Page;
  protected lastObservation?: Observation;
  private readonly errors = new Map<Page, string[]>();
  private readonly failures = new Map<Page, string[]>();
  private readonly watched = new WeakSet<Page>();
  private recording?: { cdp: CDPSession; page: Page; frames: Frame[] };

  constructor(protected readonly options: WebOptions) {}

  async connect(): Promise<void> {
    const headless = this.options.headless ?? true;
    // A headless browser draws nothing a patrol needs a GPU for, and on some
    // hosts the GPU process fails to start and every new page then hangs.
    this.browser = await chromium.launch({ headless, args: headless ? ['--disable-gpu'] : [] });
    this.context = await this.browser.newContext({
      viewport: this.options.viewport,
      reducedMotion: 'reduce',
    });
    this.context.on('page', (page) => this.watch(page));
    this.page = await this.context.newPage();
    this.watch(this.page);
    await this.page.goto(this.options.url);
  }

  protected activePage(): Page {
    if (!this.page) {
      throw new Error('Driver is not connected');
    }
    return this.page;
  }

  protected watch(page: Page): void {
    if (this.watched.has(page)) {
      return;
    }
    this.watched.add(page);
    const errors: string[] = [];
    this.errors.set(page, errors);
    page.on('console', (message) => {
      // The failed requests list has the same failure, with its URL.
      if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) {
        errors.push(message.text());
      }
    });
    page.on('pageerror', (error) => errors.push(`${error.name}: ${error.message}`));
    const failures: string[] = [];
    this.failures.set(page, failures);
    const add = (line: string) => {
      if (failures.length < 50) failures.push(line);
    };
    page.on('response', (response) => {
      const type = response.request().resourceType();
      if (response.status() >= 400 && ['fetch', 'xhr', 'document'].includes(type)) {
        add(`${response.request().method()} ${response.url()} → ${response.status()}`);
      }
    });
    page.on('requestfailed', (request) => {
      const reason = request.failure()?.errorText ?? 'failed';
      // A navigation or a new render cancels requests all the time.
      if (/ERR_ABORTED|NS_BINDING_ABORTED|cancelled/i.test(reason)) return;
      if (['fetch', 'xhr', 'document'].includes(request.resourceType()))
        add(`${request.method()} ${request.url()} → ${reason}`);
    });
  }

  async observe(): Promise<Observation> {
    const page = this.activePage();
    const context = this.context!;
    for (const candidate of context.pages()) {
      this.watch(candidate);
    }
    const [screenshot, elements, title] = await Promise.all([
      page.screenshot({ fullPage: false }),
      observeDom(page),
      page.title(),
    ]);
    await this.captureProbe();
    const windows = await Promise.all(
      context.pages().map(async (candidate, index) => ({
        id: String(index),
        title: await candidate.title().catch(() => ''),
        location: candidate.url(),
        active: candidate === page,
      })),
    );
    const size = page.viewportSize() ?? (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })));
    const errors = this.errors.get(page) ?? [];
    const observation: Observation = {
      platform: this.platform,
      location: page.url(),
      title,
      screenshot,
      viewport: { ...size, scale: 1 },
      elements,
      windows,
      volatileRegions: [],
      consoleErrors: errors.splice(0),
      networkErrors: (this.failures.get(page) ?? []).splice(0),
      at: new Date().toISOString(),
    };
    this.lastObservation = observation;
    return observation;
  }

  private async tap(page: Page, action: Extract<DriverAction, { kind: 'tap' }>): Promise<TargetResult> {
    const target = action.ref ?? action.locator;
    if (!target) {
      throw new Error('Tap needs a target');
    }
    const resolved = await resolveTarget(page, target, this.lastObservation);
    if (resolved.locator) {
      await resolved.locator.click();
    } else {
      await page.mouse.click(resolved.point!.x, resolved.point!.y);
    }
    return { degraded: resolved.degraded, element: resolved.element };
  }

  private async type(page: Page, action: Extract<DriverAction, { kind: 'type' }>): Promise<TargetResult> {
    const target = action.ref ?? action.locator;
    let result: TargetResult = { degraded: false };
    if (target) {
      const resolved = await resolveTarget(page, target, this.lastObservation);
      result = { degraded: resolved.degraded, element: resolved.element };
      if (resolved.locator) {
        if (action.append) {
          const current = await resolved.locator.inputValue().catch(() => resolved.locator!.textContent());
          await resolved.locator.fill((current ?? '') + action.value);
        } else await resolved.locator.fill(action.value);
      } else {
        await page.mouse.click(resolved.point!.x, resolved.point!.y);
        if (!action.append) {
          await page.keyboard.press('ControlOrMeta+A');
          await page.keyboard.press('Delete');
        }
        await page.keyboard.insertText(action.value);
      }
    } else {
      if (!action.append) {
        await page.keyboard.press('ControlOrMeta+A');
        await page.keyboard.press('Delete');
      }
      await page.keyboard.insertText(action.value);
    }
    if (action.submit) {
      await page.keyboard.press('Enter');
    }
    return result;
  }

  private async scroll(page: Page, action: Extract<DriverAction, { kind: 'scroll' }>): Promise<TargetResult> {
    const target = action.ref ?? action.locator;
    let result: TargetResult = { degraded: false };
    if (target) {
      const resolved = await resolveTarget(page, target, this.lastObservation);
      result = { degraded: resolved.degraded, element: resolved.element };
      if (resolved.locator) {
        await resolved.locator.scrollIntoViewIfNeeded();
      }
    }
    const distance = 550;
    const x = action.direction === 'left' ? -distance : action.direction === 'right' ? distance : 0;
    const y = action.direction === 'up' ? -distance : action.direction === 'down' ? distance : 0;
    await page.mouse.wheel(x, y);
    return result;
  }

  private async switchWindow(action: Extract<DriverAction, { kind: 'window' }>): Promise<void> {
    const match = action.match.toLowerCase();
    const pages = this.context!.pages();
    const found = await Promise.all(
      pages.map(async (candidate) => ({
        candidate,
        title: await candidate.title().catch(() => ''),
      })),
    );
    const chosen = found.find(
      ({ candidate, title }) => candidate.url().toLowerCase().includes(match) || title.toLowerCase().includes(match),
    );
    if (!chosen) {
      throw new Error(`Window not found: ${action.match}`);
    }
    this.page = chosen.candidate;
    await this.page.bringToFront();
  }

  async act(action: DriverAction): Promise<ActResult> {
    if (action.kind === 'request') return { ok: false, error: 'HTTP requests require the API driver' };
    if (action.kind === 'run') return { ok: false, error: 'Commands require the CLI driver' };
    try {
      const page = this.activePage();
      let result: TargetResult = { degraded: false };
      switch (action.kind) {
        case 'tap':
          result = await this.tap(page, action);
          break;
        case 'type':
          result = await this.type(page, action);
          break;
        case 'scroll':
          result = await this.scroll(page, action);
          break;
        case 'press':
          await page.keyboard.press(playwrightKey(action.key));
          break;
        case 'back':
          await page.goBack();
          break;
        case 'open':
          await page.goto(action.url);
          break;
        case 'wait':
          await page.waitForTimeout(action.ms);
          break;
        case 'window':
          await this.switchWindow(action);
          break;
      }
      await this.activePage()
        .waitForLoadState('domcontentloaded', { timeout: 5000 })
        .catch(() => {});
      const fallback = 'locator' in action ? action.locator : undefined;
      return {
        ok: true,
        degraded: result.degraded,
        step: stepFor(action, result.element, fallback),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message.slice(0, 200) };
    }
  }

  async settle(
    options: { timeoutMs?: number; intervalMs?: number } = {},
  ): Promise<{ frames: number; stable: boolean }> {
    const page = this.activePage();
    const timeout = options.timeoutMs ?? 5000;
    const interval = options.intervalMs ?? 150;
    const start = Date.now();
    let previous = '';
    let frames = 0;
    while (Date.now() - start < timeout) {
      const current = sha256(await page.screenshot({ fullPage: false }));
      frames++;
      if (current === previous) {
        return { frames, stable: true };
      }
      previous = current;
      await page.waitForTimeout(interval);
    }
    return { frames, stable: false };
  }

  snapshot(observation: Observation, screenId: string): ScreenSnapshot {
    const probe = this.probe;
    if (!probe) {
      throw new Error('Observe before taking a snapshot');
    }
    return {
      ...probe,
      screenId,
      viewport: {
        name: this.platform === 'web' ? 'window' : 'desktop',
        width: observation.viewport.width,
        height: observation.viewport.height,
      },
      consoleErrors: observation.consoleErrors,
    };
  }

  private probe?: Omit<ScreenSnapshot, 'screenId' | 'viewport' | 'consoleErrors'>;

  protected async captureProbe(): Promise<void> {
    this.probe = (await this.activePage().evaluate(PROBE_SOURCE)) as typeof this.probe;
  }

  /**
   * Records through the CDP screencast of the page, not the video option of
   * Playwright: that option is set when a context opens, and Electron hands
   * over a context that is already open. Chromium draws a frame only when
   * the screen changes, so a still screen costs nothing.
   */
  async startRecording(): Promise<void> {
    if (!hasFfmpeg()) throw new Error('Recording needs ffmpeg on the PATH');
    if (this.recording) throw new Error('A recording is already running');
    const page = this.activePage();
    const cdp = await page.context().newCDPSession(page);
    const frames: Frame[] = [];
    cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
      frames.push({ data: Buffer.from(data, 'base64'), at: Date.now() });
      cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 80, maxWidth: 1280, maxHeight: 1280 });
    this.recording = { cdp, page, frames };
  }

  async stopRecording(name: string): Promise<string> {
    const recording = this.recording;
    if (!recording) throw new Error('No recording is running');
    this.recording = undefined;
    const end = Date.now();
    await recording.cdp.send('Page.stopScreencast').catch(() => {});
    await recording.cdp.detach().catch(() => {});
    // A window that is not drawn, for example in the background, sends no frame.
    if (!recording.frames.length)
      recording.frames.push({ data: await recording.page.screenshot({ type: 'jpeg' }), at: end });
    const file = `${name}.mp4`;
    await encodeFrames(recording.frames, file, end);
    return file;
  }

  async close(): Promise<void> {
    await this.context?.close();
    await this.browser?.close();
  }
}

const KEY_NAMES: Record<string, string> = {
  enter: 'Enter',
  return: 'Enter',
  esc: 'Escape',
  escape: 'Escape',
  tab: 'Tab',
  space: 'Space',
  backspace: 'Backspace',
  delete: 'Delete',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  cmd: 'Meta',
  command: 'Meta',
  meta: 'Meta',
  ctrl: 'Control',
  control: 'Control',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift',
};

/**
 * Models write key names loosely ("enter", "cmd+k", "Esc"), and Playwright
 * rejects anything that is not its exact name. Each part of a chord is mapped
 * on its own; anything unknown passes through unchanged.
 */
export function playwrightKey(key: string): string {
  return key
    .split('+')
    .map((part) => KEY_NAMES[part.trim().toLowerCase()] ?? part.trim())
    .join('+');
}
