import { type Locator, sha256 } from '@bugpatrol/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { locatorFor, stepFor } from '../dom.js';
import { nativeSnapshot } from '../maestro.js';
import type { ActResult, ControlEvent, Driver, DriverAction, Observation, UiElement } from '../types.js';
import { Control } from './control.js';
import { isolatedTransport } from './isolation.js';
import { type HumanInput, startViewer } from './viewer.js';

const windowSchema = z.object({ pid: z.number().int().positive(), window_id: z.number().int(), title: z.string() });
const frameSchema = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });
const stateSchema = z.object({
  window_title: z.string(),
  screenshot_width: z.number().positive(),
  screenshot_height: z.number().positive(),
  screenshot_frame_valid: z.literal(true),
  coordinate_frame: z.literal('window'),
  degraded_reason: z.string().nullish(),
  elements: z
    .array(
      z.object({
        element_token: z.string(),
        role: z.string(),
        label: z.string().nullish(),
        value: z.string().nullish(),
        enabled: z.boolean().optional(),
        focused: z.boolean().optional(),
        actions: z.array(z.string()).optional(),
        screenshot_frame: frameSchema.nullish(),
      }),
    )
    .default([]),
});
export type CuaOptions = {
  deliveryMode: 'background' | 'foreground';
  windowManager: string;
  command: string;
  launch: string;
  args: string[];
  windowTitle?: string;
  viewport: { width: number; height: number };
  viewer: { enabled: boolean; port: number; allowTakeover: boolean };
  redact: (value: string) => string;
};

/** Drives only the application launched inside this run's private X server and bus. */
export class CuaDriver implements Driver {
  readonly platform = 'desktop' as const;
  viewerUrl?: string;
  onControlEvent?: (event: ControlEvent) => void;
  private client?: Client;
  private isolation?: Awaited<ReturnType<typeof isolatedTransport>>;
  private viewer?: Awaited<ReturnType<typeof startViewer>>;
  private target?: z.infer<typeof windowSchema>;
  private appPid?: number;
  private lastObservation?: Observation;
  private observedVersion = -1;
  private diagnostics = '';
  get appProcessId(): number | undefined {
    return this.appPid;
  }
  get privateDirectory(): string | undefined {
    return this.isolation?.directory;
  }
  private readonly control = new Control((owner) =>
    this.onControlEvent?.({
      kind: 'control-change',
      owner,
      summary:
        owner === 'human'
          ? 'Human took control; agent paused; replay trail reset'
          : 'Control returned to agent; fresh observation required',
    }),
  );
  get controlVersion(): number {
    return this.control.version;
  }

  constructor(private readonly options: CuaOptions) {}

  private async call(name: string, args: Record<string, unknown>) {
    if (!this.client) throw new Error('Cua driver is not connected');
    const result = await this.client.callTool({ name, arguments: args }, CallToolResultSchema, { timeout: 20000 });
    const refusal = z
      .object({ status: z.literal('refused'), refusal: z.object({ code: z.string(), message: z.string() }) })
      .safeParse(result.structuredContent);
    if (refusal.success) throw new Error(`${refusal.data.refusal.code}: ${refusal.data.refusal.message}`);
    if (result.isError)
      throw new Error(`Cua ${name} failed: ${this.options.redact(JSON.stringify(result.content)).slice(0, 1000)}`);
    return CallToolResultSchema.parse(result);
  }

  async connect(): Promise<void> {
    try {
      this.isolation = await isolatedTransport(
        this.options.command,
        this.options.windowManager,
        this.options.viewport.width,
        this.options.viewport.height,
      );
      this.client = new Client({ name: 'bugpatrol-cua', version: '0.0.0' });
      this.isolation.transport.stderr?.on('data', (data: Buffer) => {
        this.diagnostics = this.options.redact(this.diagnostics + data.toString()).slice(-2000);
      });
      await this.client.connect(this.isolation.transport);
      const tools = await this.client.listTools();
      for (const name of [
        'launch_app',
        'list_windows',
        'get_window_state',
        'click',
        'type_text',
        'press_key',
        'hotkey',
        'scroll',
      ]) {
        if (!tools.tools.some((tool) => tool.name === name)) throw new Error(`Cua installation lacks ${name}`);
      }
      const launch = await this.call('launch_app', {
        launch_path: this.options.launch,
        additional_arguments: this.options.args.map((arg) =>
          arg.replaceAll('{{PRIVATE_DIR}}', this.isolation!.directory),
        ),
      });
      this.appPid = z.object({ pid: z.number().int().positive() }).parse(launch.structuredContent).pid;
      const deadline = Date.now() + 15000;
      while (!this.target && Date.now() < deadline) {
        const windows = await this.windows();
        const matches = windows.filter(
          (window) => !this.options.windowTitle || window.title.includes(this.options.windowTitle),
        );
        if (matches.length === 1) this.target = matches[0];
        else if (matches.length > 1) throw new Error('Several app windows match; configure cua.windowTitle');
        else await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (!this.target) throw new Error('Launched app produced no matching private window');
      await this.observe();
      if (this.options.viewer.enabled) {
        this.viewer = await startViewer({
          ...this.options.viewer,
          owner: () => this.control.owner,
          change: (owner) => this.control.change(owner),
          frame: () => this.control.preview(async () => (await this.capture(false)).screenshot),
          input: (input) => this.control.human(() => this.humanInput(input)),
        });
        this.viewerUrl = this.viewer.url;
      }
    } catch (error) {
      await this.close();
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}${this.diagnostics ? `\nPrivate display: ${this.diagnostics}` : ''}`,
      );
    }
  }

  private async windows() {
    const result = await this.call('list_windows', { pid: this.appPid, on_screen_only: true });
    return z
      .object({ windows: z.array(windowSchema) })
      .parse(result.structuredContent)
      .windows.filter((window) => window.pid === this.appPid);
  }

  private async capture(tree = true): Promise<Observation> {
    if (!this.target) throw new Error('No private app window');
    const result = await this.call('get_window_state', {
      pid: this.target.pid,
      window_id: this.target.window_id,
      include_accessibility_tree: tree,
      max_elements: 300,
      max_image_dimension: 0,
      timeout_ms: 5000,
    });
    const state = stateSchema.parse(result.structuredContent);
    const image = result.content.find((part) => part.type === 'image' && part.mimeType === 'image/png');
    if (image?.type !== 'image') throw new Error('Cua did not return a PNG window capture');
    const screenshot = Buffer.from(image.data, 'base64');
    if (
      screenshot.readUInt32BE(16) !== state.screenshot_width ||
      screenshot.readUInt32BE(20) !== state.screenshot_height
    )
      throw new Error('Cua screenshot geometry does not match the window frame');
    const elements: UiElement[] = state.elements.flatMap((element) => {
      const frame = element.screenshot_frame;
      if (!frame || frame.w <= 0 || frame.h <= 0) return [];
      return [
        {
          ref: element.element_token,
          role: element.role === 'entry' ? 'textbox' : element.role,
          name: this.options.redact(element.label ?? ''),
          value: element.value ? this.options.redact(element.value) : undefined,
          box: { x: frame.x, y: frame.y, width: frame.w, height: frame.h },
          enabled: element.enabled !== false,
          focused: element.focused,
          interactive: Boolean(element.actions?.length) || element.role === 'entry',
        },
      ];
    });
    return {
      platform: this.platform,
      location: this.options.redact(state.window_title),
      title: this.options.redact(state.window_title),
      screenshot,
      viewport: { width: state.screenshot_width, height: state.screenshot_height, scale: 1 },
      elements,
      windows: [
        {
          id: String(this.target.window_id),
          title: this.options.redact(state.window_title),
          location: this.options.redact(state.window_title),
          active: true,
        },
      ],
      volatileRegions: [],
      consoleErrors: [],
      at: new Date().toISOString(),
    };
  }

  observe(): Promise<Observation> {
    return this.control.agent(async () => {
      const observation = await this.capture();
      this.lastObservation = observation;
      this.observedVersion = this.control.version;
      return observation;
    });
  }

  private async input(name: string, args: Record<string, unknown>): Promise<void> {
    if (!this.target) throw new Error('No private app window');
    await this.call(name, {
      ...args,
      pid: this.target.pid,
      window_id: this.target.window_id,
      delivery_mode: this.options.deliveryMode,
    });
  }

  private async key(key: string): Promise<void> {
    const keys = key.split('+').map((part) => part.trim());
    if (keys.length > 1) await this.input('hotkey', { keys });
    else await this.input('press_key', { key });
  }

  private async resolve(
    action: Extract<DriverAction, { kind: 'tap' | 'type' | 'scroll' }>,
  ): Promise<{ element?: UiElement; locator?: Locator }> {
    const previous = action.ref
      ? this.lastObservation?.elements.find((element) => element.ref === action.ref)
      : undefined;
    if (action.ref && !previous) throw new Error('Unknown ref; look again');
    const locator = previous ? locatorFor(previous) : action.locator;
    if (!locator) return {};
    if (!locator.role && !locator.name && locator.point) {
      const fresh = await this.capture(false);
      if (
        !this.lastObservation ||
        fresh.viewport.width !== this.lastObservation.viewport.width ||
        fresh.viewport.height !== this.lastObservation.viewport.height
      )
        throw new Error('App window resized; look again before using a point');
      if (
        locator.point.x < 0 ||
        locator.point.y < 0 ||
        locator.point.x >= fresh.viewport.width ||
        locator.point.y >= fresh.viewport.height
      )
        throw new Error('Point is outside the app window');
      return { locator };
    }
    if (!locator.role || !locator.name) throw new Error('Cua requires a named target or an explicit screenshot point');
    const fresh = await this.capture();
    const matches = fresh.elements.filter(
      (element) => element.role === locator.role && element.name === locator.name && element.enabled,
    );
    if (matches.length !== 1) throw new Error(`Cua target is missing or ambiguous: ${locator.role} ${locator.name}`);
    return { element: matches[0]!, locator };
  }

  async act(action: DriverAction): Promise<ActResult> {
    try {
      return await this.control.agent(async () => {
        if (this.observedVersion !== this.control.version)
          throw new Error('Human takeover changed the app; look again before acting');
        let target: { element?: UiElement; locator?: Locator } = {};
        switch (action.kind) {
          case 'tap':
            target = await this.resolve(action);
            if (target.element) await this.input('click', { element_token: target.element.ref });
            else if (target.locator?.point) await this.input('click', target.locator.point);
            else throw new Error('Tap requires a current ref, named locator, or explicit screenshot point');
            break;
          case 'type':
            target = await this.resolve(action);
            if (target.element) await this.input('click', { element_token: target.element.ref });
            if (!action.append) {
              await this.key('ctrl+a');
              await this.key('BackSpace');
            }
            await this.input('type_text', { text: action.value });
            if (action.submit) await this.key('Return');
            break;
          case 'press':
            await this.key(action.key);
            break;
          case 'scroll':
            target = await this.resolve(action);
            await this.input('scroll', {
              direction: action.direction,
              amount: 3,
              ...(target.element ? { element_token: target.element.ref } : {}),
            });
            break;
          case 'back':
            await this.key('alt+Left');
            break;
          case 'wait':
            await new Promise((resolve) => setTimeout(resolve, action.ms));
            break;
          case 'window': {
            const matches = (await this.windows()).filter((window) => window.title.includes(action.match));
            if (matches.length !== 1)
              throw new Error('Window match must uniquely identify a window in the launched app');
            this.target = matches[0];
            break;
          }
          case 'open':
            throw new Error('Desktop open is unsupported; use app UI or trusted launch arguments');
          case 'upload':
            throw new Error('Uploads are supported on web and Electron only');
          case 'request':
            throw new Error('HTTP requests require the API driver');
          case 'run':
            throw new Error('Commands require the CLI driver');
        }
        return {
          ok: true,
          degraded: Boolean(target.locator?.point && !target.element),
          step: stepFor(action, target.element, target.locator),
        };
      });
    } catch (error) {
      return {
        ok: false,
        retryable: false,
        error: this.options.redact(error instanceof Error ? error.message : String(error)),
      };
    }
  }

  private async humanInput(input: HumanInput): Promise<void> {
    const frame = await this.capture(false);
    switch (input.kind) {
      case 'tap':
        if (input.x >= frame.viewport.width || input.y >= frame.viewport.height)
          throw new Error('Point is outside the app window');
        await this.input('click', { x: input.x, y: input.y });
        break;
      case 'type':
        await this.input('type_text', { text: input.value });
        break;
      case 'press':
        await this.key(input.key);
        break;
      case 'scroll':
        await this.input('scroll', { direction: input.direction, amount: 3 });
        break;
    }
    // User text is never recorded as a replayable agent action.
    this.onControlEvent?.({ kind: 'human-action', summary: `Human ${input.kind} in private app window` });
  }

  async settle(
    options: { timeoutMs?: number; intervalMs?: number } = {},
  ): Promise<{ frames: number; stable: boolean }> {
    return this.control.agent(async () => {
      let previous = '';
      let frames = 0;
      const deadline = Date.now() + (options.timeoutMs ?? 3000);
      while (Date.now() < deadline) {
        const hash = sha256((await this.capture(false)).screenshot);
        frames++;
        if (hash === previous) return { frames, stable: true };
        previous = hash;
        await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 120));
      }
      return { frames, stable: false };
    });
  }

  snapshot = nativeSnapshot;

  interrupt(): void {
    this.control.close();
  }

  async close(): Promise<void> {
    this.control.close();
    const pid = this.isolation?.transport.pid;
    const results = await Promise.allSettled([this.viewer?.close(), this.client?.close()]);
    let killError: unknown;
    if (pid) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') killError = error;
      }
    }
    await this.isolation?.remove();
    this.client = undefined;
    this.isolation = undefined;
    this.viewer = undefined;
    this.target = undefined;
    this.appPid = undefined;
    this.viewerUrl = undefined;
    if (killError) throw killError;
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  }
}
