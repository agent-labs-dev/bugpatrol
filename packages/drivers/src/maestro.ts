import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { type Locator, type Platform, sha256 } from '@bugpatrol/core';
import type { ScreenSnapshot } from '@bugpatrol/invariants';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { locatorFor, stepFor } from './dom.js';
import type { ActResult, Driver, DriverAction, Observation, UiElement } from './types.js';

const exec = promisify(execFile);
export type MaestroOptions = { appId: string; device?: string; command?: string };
type TextPart = { type: 'text'; text: string };
type ImagePart = { type: 'image'; data: string; mimeType: string };
type Part = TextPart | ImagePart;
type Node = Record<string, unknown>;
type Schema = {
  elements: Node[];
  ui_schema?: {
    defaults?: Record<string, unknown>;
    abbreviations?: Record<string, string>;
  };
};
type Target = { locator?: Locator; element?: UiElement };
/** A running screen recording. On Android `file` is on the device, so it is pulled at the end. */
type Recording = { child: ChildProcess; exited: Promise<unknown>; file: string };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Rejects when the promise takes longer than `ms`. */
async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms / 1000} s`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Accepts the loose key names used by agents while preserving Maestro's platform back key. */
export function maestroKey(key: string, platform: Platform): string {
  const names: Record<string, string> = {
    enter: 'Enter',
    return: 'Enter',
    backspace: 'Backspace',
    home: 'Home',
    back: platform === 'android' ? 'back' : 'Back',
  };
  return names[key.trim().toLowerCase()] ?? key.trim();
}

/** Ignore chatty MCP text and use the element tree that can drive actions. */
export function parseHierarchy(parts: Part[]): Schema {
  for (const part of parts) {
    if (part.type !== 'text') {
      continue;
    }
    try {
      const value = JSON.parse(part.text) as Schema;
      if (Array.isArray(value.elements)) {
        return value;
      }
    } catch {}
  }
  throw new Error('Maestro inspect_screen returned no element hierarchy');
}

function bounds(value: unknown): UiElement['box'] | undefined {
  const match = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(String(value ?? ''));
  if (!match) {
    return undefined;
  }
  const [x1, y1, x2, y2] = match.slice(1).map(Number);
  return { x: x1!, y: y1!, width: x2! - x1!, height: y2! - y1! };
}

function inside(box: UiElement['box'], root: UiElement['box']): boolean {
  return (
    box.width > 0 &&
    box.height > 0 &&
    box.x >= root.x &&
    box.y >= root.y &&
    box.x + box.width <= root.x + root.width &&
    box.y + box.height <= root.y + root.height
  );
}

function nativeRole(
  leaf: boolean,
  hint: string,
  val: string,
  name: string,
  a11y: string,
  rid: string,
  txt: string,
): string {
  if (leaf && (hint || val || /email|password|search|name/i.test(name))) {
    return 'textbox';
  }
  if (leaf && (a11y || rid)) {
    return 'button';
  }
  if (txt && !a11y && !rid) {
    return 'text';
  }
  return 'group';
}

/**
 * The screen box. iOS puts it on the first node; Android wraps the windows in a
 * node with no bounds, so use the union of the shallowest level that has them.
 */
function rootBounds(roots: Node[], read: (node: Node, name: string) => unknown): UiElement['box'] | undefined {
  const first = bounds(read(roots[0] ?? {}, 'bounds'));
  if (first) {
    return first;
  }
  let level = roots;
  while (level.length > 0) {
    const boxes = level.map((node) => bounds(read(node, 'bounds'))).filter((box) => box !== undefined);
    if (boxes.length > 0) {
      const x1 = Math.min(...boxes.map((box) => box.x));
      const y1 = Math.min(...boxes.map((box) => box.y));
      const x2 = Math.max(...boxes.map((box) => box.x + box.width));
      const y2 = Math.max(...boxes.map((box) => box.y + box.height));
      return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
    }
    level = level.flatMap((node) => {
      const children = read(node, 'children');
      return Array.isArray(children) ? (children as Node[]) : [];
    });
  }
  return undefined;
}

/** Keep only visible native nodes so refs match the current screen geometry. */
export function flattenHierarchy(schema: Schema): {
  elements: UiElement[];
  viewport: { width: number; height: number };
} {
  const aliases = schema.ui_schema?.abbreviations ?? {};
  const defaults = schema.ui_schema?.defaults ?? {};
  const key = (name: string) => Object.entries(aliases).find(([, expanded]) => expanded === name)?.[0] ?? name;
  const read = (node: Node, name: string) => node[key(name)] ?? node[name] ?? defaults[key(name)] ?? defaults[name];
  const roots = schema.elements;
  const root = rootBounds(roots, read);
  if (!root) {
    throw new Error('Maestro hierarchy has no root bounds');
  }
  const viewport = { width: root.width, height: root.height };
  const elements: UiElement[] = [];
  const visit = (node: Node, parent?: UiElement) => {
    const box = bounds(read(node, 'bounds'));
    const a11y = String(read(node, 'accessibilityText') ?? '').trim();
    const txt = String(read(node, 'text') ?? '').trim();
    const hint = String(read(node, 'hintText') ?? '').trim();
    const val = String(read(node, 'value') ?? '').trim();
    const rid = String(read(node, 'resource-id') ?? '').trim();
    const name = a11y || txt || hint || val || rid;
    const children = read(node, 'children');
    const descendants = Array.isArray(children) ? (children as Node[]) : [];
    let current = parent;
    if (box && inside(box, root) && name) {
      const duplicate = parent && parent.name === name && JSON.stringify(parent.box) === JSON.stringify(box);
      if (!duplicate && elements.length < 150) {
        const leaf = descendants.length === 0;
        const role = nativeRole(leaf, hint, val, name, a11y, rid, txt);
        current = {
          ref: `e${elements.length + 1}`,
          role,
          name,
          text: txt || undefined,
          value: val || undefined,
          testId: rid || undefined,
          box: {
            x: box.x - root.x,
            y: box.y - root.y,
            width: box.width,
            height: box.height,
          },
          interactive: role !== 'text' && role !== 'group',
          enabled: read(node, 'enabled') !== false,
          focused: read(node, 'focused') === true,
          checked: read(node, 'checked') === true,
        };
        elements.push(current);
      }
    }
    for (const child of descendants) {
      visit(child, current);
    }
  };
  for (const node of roots) {
    visit(node);
  }
  return { elements, viewport };
}

const KEYBOARD_KEYS = new Set([
  'shift',
  'delete',
  'space',
  'numbers',
  'more',
  'go',
  'return',
  'emoji',
  'dictate',
  'next keyboard',
]);

/**
 * Removes what belongs to the OS rather than the app: the root node, the
 * status bar, scroll indicators, and the software keyboard's keys. They are
 * a third of a typical element list, and a model that sees 35 keyboard keys
 * starts to tap them. An open keyboard stays visible as ONE element, because
 * whether it is open matters.
 */
export function pruneSystemChrome(
  elements: UiElement[],
  viewport: { width: number; height: number },
  statusBarHeight: number,
): UiElement[] {
  const isRoot = (element: UiElement) => element.box.width >= viewport.width && element.box.height >= viewport.height;
  const inStatusBar = (element: UiElement) => element.box.y + element.box.height <= statusBarHeight;
  const isScrollBar = (element: UiElement) => /scroll bar/i.test(element.name);
  const isKey = (element: UiElement) =>
    element.role === 'button' &&
    element.box.y >= viewport.height * 0.4 &&
    (element.name.length === 1 || KEYBOARD_KEYS.has(element.name.toLowerCase()));

  const keys = elements.filter(isKey);
  const keyboardOpen = keys.length >= 15;
  const kept = elements.filter((element) => {
    if (isRoot(element) || inStatusBar(element) || isScrollBar(element)) return false;
    return !(keyboardOpen && isKey(element));
  });

  if (keyboardOpen) {
    const top = Math.min(...keys.map((key) => key.box.y));
    kept.push({
      ref: '',
      role: 'keyboard',
      name: 'Software keyboard (open)',
      box: { x: 0, y: top, width: viewport.width, height: viewport.height - top },
      interactive: false,
      enabled: true,
    });
  }
  return kept.map((element, index) => ({ ...element, ref: `e${index + 1}` }));
}

/** JSON quoting also produces valid YAML strings for app ids and typed text. */
export const yamlString = (value: string): string => JSON.stringify(value);

/** Keep every native action in one flow format accepted by Maestro. */
export function buildFlow(appId: string, commands: string[]): string {
  return `appId: ${yamlString(appId)}\n---\n${commands.map((command) => `- ${command}`).join('\n')}`;
}

/** Exact text matching prevents a tap from choosing a similar label. */
export const regexText = (value: string): string => `^${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;

/** Prefer resource ids, then exact names, before a fallback point. */
export function tapCommand(locator: Locator): string {
  if (locator.testId) {
    return `tapOn:\n    id: ${yamlString(locator.testId)}`;
  }
  const label = locator.name || locator.text;
  if (label) {
    return `tapOn:\n    text: ${yamlString(regexText(label))}`;
  }
  if (locator.point) {
    const point = `${Math.round(locator.point.x)},${Math.round(locator.point.y)}`;
    return `tapOn:\n    point: ${yamlString(point)}`;
  }
  throw new Error('Tap needs an id, text, or point');
}

export function typeCommands(action: Extract<DriverAction, { kind: 'type' }>, target: Target): string[] {
  const commands = target.locator ? [tapCommand(target.locator)] : [];
  if (!action.append)
    commands.push(
      `eraseText: ${
        target.element?.value === undefined || target.element.value === '••••' ? 100 : target.element.value.length + 10
      }`,
    );
  commands.push(`inputText: ${yamlString(action.value)}`);
  if (action.submit) commands.push('pressKey: Enter');
  return commands;
}

/** A swipe moves content opposite to the explorer's scroll direction. */
export function scrollCommand(direction: 'up' | 'down' | 'left' | 'right'): string {
  const swipe = { up: 'DOWN', down: 'UP', left: 'RIGHT', right: 'LEFT' }[direction];
  return `swipe:\n    direction: ${swipe}`;
}

/** Feed native geometry into the same invariant engine used for browsers. */
export function nativeSnapshot(observation: Observation, screenId: string): ScreenSnapshot {
  return {
    screenId,
    viewport: {
      name: 'window',
      width: observation.viewport.width,
      height: observation.viewport.height,
    },
    url: observation.location,
    title: observation.title,
    elements: observation.elements.map((element) => {
      const selector = element.testId ? `id=${element.testId}` : `text=${element.name}`;
      return {
        selector,
        box: element.box,
        visible: true,
        rendered: true,
        interactive: element.interactive,
        hitSelector: selector,
        zIndex: 0,
      };
    }),
    document: {
      scrollWidth: observation.viewport.width,
      clientWidth: observation.viewport.width,
      scrollHeight: observation.viewport.height,
      clientHeight: observation.viewport.height,
      hasStylesheets: true,
    },
    images: [],
    links: [],
    consoleErrors: observation.consoleErrors,
  };
}

/** Run mobile actions through Maestro while normalising its observations. */
export class MaestroDriver implements Driver {
  readonly platform: Platform;
  private client?: Client;
  private transport?: StdioClientTransport;
  private deviceId?: string;
  private lastObservation?: Observation;
  private recording?: Recording;

  constructor(
    platform: 'ios' | 'android',
    private readonly options: MaestroOptions,
  ) {
    this.platform = platform;
  }

  async connect(): Promise<void> {
    this.transport = new StdioClientTransport({
      command: this.options.command ?? 'maestro',
      args: ['mcp'],
      stderr: 'pipe',
    });
    this.client = new Client({ name: 'bugpatrol-drivers', version: '0.0.0' });
    await this.client.connect(this.transport);
    this.deviceId = this.options.device ?? (await this.defaultDevice());
  }

  private async defaultDevice(): Promise<string> {
    try {
      if (this.platform === 'ios') {
        const { stdout } = await exec('xcrun', ['simctl', 'list', 'devices', 'booted', '-j']);
        const parsed = JSON.parse(stdout) as { devices: Record<string, Array<{ udid: string; state: string }>> };
        const groups = Object.values(parsed.devices);
        const device = groups.flat().find((item) => item.state === 'Booted');
        if (device) {
          return device.udid;
        }
      } else {
        const { stdout } = await exec('adb', ['devices']);
        const serial = stdout
          .split('\n')
          .slice(1)
          .map((line) => /^([^\s]+)\s+device$/.exec(line)?.[1])
          .find(Boolean);
        if (serial) {
          return serial;
        }
      }
    } catch {
      // The MCP server can enumerate a device when platform CLIs are unavailable.
    }
    const devices = await this.client!.callTool({ name: 'list_devices', arguments: {} });
    for (const part of devices.content as Part[]) {
      if (part.type !== 'text') {
        continue;
      }
      try {
        const parsed = JSON.parse(part.text) as unknown;
        const list = Array.isArray(parsed) ? parsed : (parsed as { devices?: unknown[] }).devices;
        const first = Array.isArray(list) ? (list[0] as { id?: string; device_id?: string } | undefined) : undefined;
        if (first?.device_id || first?.id) {
          return first.device_id ?? first.id!;
        }
      } catch {}
    }
    throw new Error(`No ${this.platform} device available`);
  }

  /**
   * The platform tools, not Maestro: Maestro's take_screenshot returns a JPEG,
   * and a lossy frame can never be compared pixel for pixel. simctl and adb
   * also answer in well under a second.
   */
  private async screenshot(): Promise<Buffer> {
    if (this.platform === 'android') {
      const { stdout } = await exec('adb', ['-s', this.deviceId!, 'exec-out', 'screencap', '-p'], {
        encoding: 'buffer',
        maxBuffer: 20_000_000,
      });
      return Buffer.from(stdout);
    }
    const dir = await mkdtemp(join(tmpdir(), 'bugpatrol-maestro-'));
    const file = join(dir, 'screen.png');
    try {
      await exec('xcrun', ['simctl', 'io', this.deviceId!, 'screenshot', file]);
      return await readFile(file);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async observe(): Promise<Observation> {
    const [inspection, screenshot] = await Promise.all([
      this.client!.callTool({ name: 'inspect_screen', arguments: { device_id: this.deviceId } }),
      this.screenshot(),
    ]);
    const tree = flattenHierarchy(parseHierarchy(inspection.content as Part[]));
    const viewport = tree.viewport;
    const statusBar = this.platform === 'ios' ? 54 : 24;
    const elements = pruneSystemChrome(tree.elements, viewport, statusBar);
    const pixelWidth = screenshot.readUInt32BE(16);
    const observation: Observation = {
      platform: this.platform,
      location: this.options.appId,
      screenshot,
      viewport: { ...viewport, scale: pixelWidth / viewport.width },
      elements,
      volatileRegions: [
        {
          x: 0,
          y: 0,
          width: viewport.width,
          height: statusBar,
          reason: 'status bar',
        },
      ],
      consoleErrors: [],
      at: new Date().toISOString(),
    };
    this.lastObservation = observation;
    return observation;
  }

  private target(action: Extract<DriverAction, { kind: 'tap' | 'type' | 'scroll' }>): Target {
    const element = action.ref ? this.lastObservation?.elements.find((item) => item.ref === action.ref) : undefined;
    if (action.ref && !element) {
      throw new Error(`Unknown element ref: ${action.ref}`);
    }
    return { locator: element ? locatorFor(element) : action.locator, element };
  }

  private async run(commands: string[]): Promise<void> {
    const yaml = buildFlow(this.options.appId, commands);
    const result = await this.client!.callTool({
      name: 'run',
      arguments: { device_id: this.deviceId, yaml },
    });
    if (result.isError) {
      throw new Error('Maestro flow failed');
    }
    for (const part of result.content as Part[]) {
      if (part.type !== 'text') {
        continue;
      }
      try {
        const parsed = JSON.parse(part.text) as { success?: boolean; error?: string };
        if (parsed.success === false) {
          throw new Error(parsed.error ?? 'Maestro flow failed');
        }
      } catch (error) {
        if (error instanceof SyntaxError) {
          continue;
        }
        throw error;
      }
    }
  }

  private async tap(action: Extract<DriverAction, { kind: 'tap' }>): Promise<Target> {
    const target = this.target(action);
    if (!target.locator) {
      throw new Error('Tap needs a target');
    }
    await this.run([tapCommand(target.locator)]);
    return target;
  }

  private async type(action: Extract<DriverAction, { kind: 'type' }>): Promise<Target> {
    const target = this.target(action);
    await this.run(typeCommands(action, target));
    return target;
  }

  private async press(action: Extract<DriverAction, { kind: 'press' }>): Promise<void> {
    const key = maestroKey(action.key, this.platform);
    await this.run([`pressKey: ${yamlString(key)}`]);
  }

  private async scroll(action: Extract<DriverAction, { kind: 'scroll' }>): Promise<Target> {
    const target = this.target(action);
    await this.run([scrollCommand(action.direction)]);
    return target;
  }

  private async back(): Promise<void> {
    const command = this.platform === 'ios' ? 'swipe:\n    start: "2%,50%"\n    end: "90%,50%"' : 'back';
    await this.run([command]);
  }

  private async open(action: Extract<DriverAction, { kind: 'open' }>): Promise<void> {
    await this.run([`openLink: ${yamlString(action.url)}`]);
  }

  private async wait(action: Extract<DriverAction, { kind: 'wait' }>): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, action.ms));
  }

  private async switchWindow(): Promise<void> {
    throw new Error('Window switching is unsupported on mobile');
  }

  async act(action: DriverAction): Promise<ActResult> {
    if (action.kind === 'request') return { ok: false, error: 'HTTP requests require the API driver' };
    if (action.kind === 'run') return { ok: false, error: 'Commands require the CLI driver' };
    if (action.kind === 'upload') return { ok: false, error: 'Uploads are supported on web and Electron only' };
    try {
      let target: Target = {};
      switch (action.kind) {
        case 'tap':
          target = await this.tap(action);
          break;
        case 'type':
          target = await this.type(action);
          break;
        case 'press':
          await this.press(action);
          break;
        case 'scroll':
          target = await this.scroll(action);
          break;
        case 'back':
          await this.back();
          break;
        case 'open':
          await this.open(action);
          break;
        case 'wait':
          await this.wait(action);
          break;
        case 'window':
          await this.switchWindow();
          break;
      }
      return { ok: true, step: stepFor(action, target.element, target.locator) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message.slice(0, 200) };
    }
  }

  /**
   * Settled means the element tree stopped changing, not the pixels. A native
   * screen has a blinking text cursor and animated system chrome, so two
   * identical screenshots can take many seconds; the tree is what a tap
   * depends on, and it is cheap to read.
   */
  async settle(
    options: { timeoutMs?: number; intervalMs?: number } = {},
  ): Promise<{ frames: number; stable: boolean }> {
    const timeout = options.timeoutMs ?? 6000;
    const interval = options.intervalMs ?? 250;
    const start = Date.now();
    let previous = '';
    let frames = 0;
    while (Date.now() - start < timeout) {
      const inspection = await this.client!.callTool({
        name: 'inspect_screen',
        arguments: { device_id: this.deviceId },
      });
      const tree = flattenHierarchy(parseHierarchy(inspection.content as Part[]));
      const current = sha256(JSON.stringify(tree.elements.map((element) => [element.name, element.box])));
      frames++;
      if (current === previous) {
        return { frames, stable: true };
      }
      previous = current;
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
    return { frames, stable: false };
  }

  snapshot(observation: Observation, screenId: string): ScreenSnapshot {
    return nativeSnapshot(observation, screenId);
  }

  /**
   * Records through the device, as the platform tools do: `simctl io
   * recordVideo` on iOS, `screenrecord` on Android. Android stops a recording
   * by itself after 3 minutes.
   */
  async startRecording(): Promise<void> {
    if (this.recording) throw new Error('A recording is already running');
    this.recording = this.platform === 'ios' ? await this.recordSimulator() : await this.recordEmulator();
  }

  private async recordSimulator(): Promise<Recording> {
    const dir = await mkdtemp(join(tmpdir(), 'bugpatrol-maestro-'));
    const file = join(dir, 'recording.mp4');
    const child = spawn('xcrun', ['simctl', 'io', this.deviceId!, 'recordVideo', '--codec=h264', '--force', file]);
    const exited = once(child, 'exit');
    let said = '';
    // simctl writes this to stderr once it has the first frame, so the first step is in the video.
    const started = new Promise<void>((resolve) => {
      child.stderr.on('data', (chunk: Buffer) => {
        said += chunk;
        if (said.includes('Recording started')) resolve();
      });
    });
    try {
      if ((await within(Promise.race([started, exited]), 10_000, 'Starting the recording')) !== undefined) {
        throw new Error(`simctl could not record: ${said.trim() || 'it exited'}`);
      }
    } catch (error) {
      child.kill('SIGKILL');
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
    return { child, exited, file };
  }

  private async recordEmulator(): Promise<Recording> {
    const file = `/sdcard/bugpatrol-${randomUUID()}.mp4`;
    const child = spawn('adb', ['-s', this.deviceId!, 'shell', 'screenrecord', file]);
    const exited = once(child, 'exit');
    let failed: unknown;
    exited.catch((error) => {
      failed = error;
    });
    let said = '';
    child.stderr.on('data', (chunk: Buffer) => {
      said += chunk;
    });
    // screenrecord creates its file once the encoder runs.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (failed || child.exitCode !== null) {
        throw new Error(`screenrecord could not record: ${said.trim() || String(failed ?? 'it exited')}`);
      }
      try {
        await this.adb('shell', 'test', '-e', file);
        return { child, exited, file };
      } catch {
        await sleep(200);
      }
    }
    await this.stopScreenrecord(file);
    throw new Error('Starting the recording took longer than 10 s');
  }

  private adb(...args: string[]) {
    return exec('adb', ['-s', this.deviceId!, ...args]);
  }

  /** Killing adb leaves screenrecord running on the device, so the signal goes to screenrecord itself. */
  private async stopScreenrecord(file: string): Promise<void> {
    await this.adb('shell', 'pkill', '-INT', '-f', file).catch(() => {});
  }

  async stopRecording(name: string): Promise<string> {
    const recording = this.recording;
    if (!recording) throw new Error('No recording is running');
    this.recording = undefined;
    const file = `${name}.mp4`;
    if (this.platform === 'ios') {
      // `simctl help io`: SIGINT stops the recording, and simctl exits once the file is final.
      recording.child.kill('SIGINT');
      try {
        await within(recording.exited, 30_000, 'Stopping the recording');
        await copyFile(recording.file, file);
      } finally {
        await rm(dirname(recording.file), { recursive: true, force: true });
      }
      return file;
    }
    await this.stopScreenrecord(recording.file);
    try {
      await within(recording.exited, 30_000, 'Stopping the recording');
      await this.adb('pull', recording.file, file);
    } finally {
      await this.adb('shell', 'rm', '-f', recording.file).catch(() => {});
    }
    return file;
  }

  async close(): Promise<void> {
    const recording = this.recording;
    this.recording = undefined;
    if (recording && this.platform === 'android') {
      await this.stopScreenrecord(recording.file);
      await this.adb('shell', 'rm', '-f', recording.file).catch(() => {});
    } else if (recording) {
      recording.child.kill('SIGKILL');
      await rm(dirname(recording.file), { recursive: true, force: true });
    }
    await this.client?.close();
    await this.transport?.close();
  }
}
