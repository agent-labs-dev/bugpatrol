import { writeFile } from 'node:fs/promises';
import type { Locator, Platform } from '@bugpatrol/core';
import {
  type ActResult,
  type Driver,
  type DriverAction,
  encodeFrames,
  type Frame,
  type Observation,
  type UiElement,
} from '@bugpatrol/drivers';
import type { ScreenSnapshot } from '@bugpatrol/invariants';
import { PNG } from 'pngjs';

export type FakeScreen = {
  elements: UiElement[];
  next?: Record<string, string>;
  color?: number;
  consoleErrors?: string[];
  networkErrors?: string[];
};

/** Small deterministic app for role tests; every screen has a valid PNG. */
export class FakeDriver implements Driver {
  readonly platform: Platform;
  readonly actions: DriverAction[] = [];
  connected = false;
  closed = false;
  current: string;
  failAt?: number;
  startRecording?: () => Promise<void>;
  stopRecording?: (name: string) => Promise<string>;
  private frames?: Frame[];

  /**
   * `record: 'video'` records the screens it shows into a real MP4, which
   * needs ffmpeg. `record: 'broken'` writes a file that is no video, and
   * `record: 'huge'` one of 11 MB.
   */
  constructor(
    readonly screens: Record<string, FakeScreen>,
    start = 'home',
    platform: Platform = 'web',
    options: { record?: 'video' | 'broken' | 'huge' } = {},
  ) {
    this.current = start;
    this.platform = platform;
    const record = options.record;
    if (!record) return;
    this.startRecording = async () => {
      this.frames = [{ data: (await this.observe()).screenshot, at: Date.now() }];
    };
    this.stopRecording = async (name) => {
      const file = `${name}.mp4`;
      if (record === 'broken') await writeFile(file, 'not a video');
      else if (record === 'huge') await writeFile(file, Buffer.alloc(11 * 1024 * 1024));
      else await encodeFrames(this.frames ?? [], file, Date.now());
      this.frames = undefined;
      return file;
    };
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async observe(): Promise<Observation> {
    const screen = this.screens[this.current];
    if (!screen) throw new Error(`Unknown fake screen ${this.current}`);
    const png = new PNG({ width: 10, height: 10 });
    const color = screen.color ?? this.current.split('').reduce((sum, char) => sum + char.charCodeAt(0), 0);
    for (let index = 0; index < png.data.length; index += 4) {
      png.data[index] = color % 256;
      png.data[index + 1] = Math.floor(color / 2) % 256;
      png.data[index + 2] = Math.floor(color / 3) % 256;
      png.data[index + 3] = 255;
    }
    return {
      platform: this.platform,
      location: `fake://${this.current}`,
      title: this.current,
      screenshot: PNG.sync.write(png),
      viewport: { width: 100, height: 100, scale: 1 },
      elements: screen.elements,
      volatileRegions: [],
      consoleErrors: screen.consoleErrors ?? [],
      networkErrors: screen.networkErrors ?? [],
      at: new Date().toISOString(),
    };
  }

  async act(action: DriverAction): Promise<ActResult> {
    const result = await this.step(action);
    this.frames?.push({ data: (await this.observe()).screenshot, at: Date.now() });
    return result;
  }

  private async step(action: DriverAction): Promise<ActResult> {
    this.actions.push(action);
    if (this.failAt === this.actions.length) return { ok: false, error: 'fake action failed' };
    if (action.kind === 'tap') {
      const element = this.find(action.ref, action.locator);
      if (!element) return { ok: false, error: 'element not found' };
      this.current = this.screens[this.current]?.next?.[element.ref] ?? this.current;
      return { ok: true, step: { kind: 'tap', target: locator(element) } };
    }
    if (action.kind === 'type') {
      const element = this.find(action.ref, action.locator);
      if (action.ref && !element) return { ok: false, error: 'element not found' };
      return {
        ok: true,
        step: {
          kind: 'type',
          target: element ? locator(element) : undefined,
          value: action.value,
          submit: action.submit,
        },
      };
    }
    if (action.kind === 'scroll')
      return {
        ok: true,
        step: {
          kind: 'scroll',
          direction: action.direction,
          target: this.find(action.ref, action.locator) ? locator(this.find(action.ref, action.locator)!) : undefined,
        },
      };
    if (action.kind === 'open') {
      const target = action.url.replace('fake://', '');
      if (this.screens[target]) this.current = target;
      return { ok: true, step: { kind: 'open', url: action.url } };
    }
    if (action.kind === 'window') return { ok: true, step: { kind: 'window', match: action.match } };
    if (action.kind === 'wait') return { ok: true, step: { kind: 'wait', ms: action.ms } };
    if (action.kind === 'press') return { ok: true, step: { kind: 'press', key: action.key } };
    return { ok: true, step: { kind: 'back' } };
  }

  async settle(): Promise<{ frames: number; stable: boolean }> {
    return { frames: 2, stable: true };
  }

  snapshot(observation: Observation, screenId: string): ScreenSnapshot {
    return {
      screenId,
      url: observation.location,
      title: observation.title,
      viewport: { name: this.platform, width: 100, height: 100 },
      elements: observation.elements.map((element) => ({
        selector: element.testId ?? element.ref,
        box: element.box,
        visible: true,
        interactive: element.interactive,
        zIndex: 0,
      })),
      document: {
        scrollWidth: 100,
        clientWidth: 100,
        scrollHeight: 100,
        clientHeight: 100,
        hasStylesheets: true,
      },
      images: [],
      consoleErrors: [],
    };
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  private find(ref?: string, target?: Locator): UiElement | undefined {
    return this.screens[this.current]?.elements.find(
      (element) =>
        element.ref === ref ||
        (target?.testId && element.testId === target.testId) ||
        (target?.role && target?.name && element.role === target.role && element.name === target.name) ||
        (target?.text && element.text === target.text),
    );
  }
}

function locator(element: UiElement): Locator {
  return {
    testId: element.testId,
    role: element.role,
    name: element.name,
    text: element.text,
    selector: element.selector,
    point: {
      x: element.box.x + element.box.width / 2,
      y: element.box.y + element.box.height / 2,
    },
  };
}
