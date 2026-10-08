import type { HttpMethod, Locator, Platform, RoutineStep } from '@bugpatrol/core';
import type { ScreenSnapshot } from '@bugpatrol/invariants';

/**
 * One interactive or text-bearing thing on the screen, normalised across
 * platforms. `ref` is short (`e12`) and valid only for the observation that
 * produced it; the explorer uses refs, and Bugpatrol turns each ref into a
 * stable `Locator` before it records a step.
 */
export type UiElement = {
  ref: string;
  role: string;
  /** Accessible name, label, or visible text -- the best human-readable handle. */
  name: string;
  text?: string;
  value?: string;
  testId?: string;
  /** Web and Electron only: a unique CSS selector. */
  selector?: string;
  /** In logical pixels (CSS px on web, points on iOS, dp on Android). */
  box: { x: number; y: number; width: number; height: number };
  interactive: boolean;
  enabled: boolean;
  focused?: boolean;
  checked?: boolean;
};

export type Observation = {
  platform: Platform;
  /** URL, route, window title, or activity. */
  location: string;
  title?: string;
  /** PNG bytes of what is on screen now. */
  screenshot: Buffer;
  /** The logical size of the screen the element boxes are in. */
  viewport: { width: number; height: number; scale: number };
  elements: UiElement[];
  /** Web and Electron: every window, so the explorer can switch. */
  windows?: Array<{ id: string; title: string; location: string; active: boolean }>;
  /**
   * Areas that change without any product change, for example the status
   * bar clock on a phone. The pixel diff masks them and reports the mask.
   */
  volatileRegions: Array<{ x: number; y: number; width: number; height: number; reason: string }>;
  /** Errors the app logged since the previous observation. */
  consoleErrors: string[];
  /** Web and Electron: failed requests since the previous observation, e.g. `GET /api/me → 500`. */
  networkErrors?: string[];
  at: string;
  /** API only: sanitized response evidence, also rendered in the screenshot. */
  http?: { method: HttpMethod; status: number; body: string; contentType: string | null };
};

/**
 * What the explorer asks for. A `ref` comes from the last observation; a
 * `locator` comes from a recorded routine. `{{NAME}}` placeholders in `value`
 * and `url` are resolved by the driver's caller, never by the model.
 */
export type DriverAction =
  | { kind: 'tap'; ref?: string; locator?: Locator }
  | { kind: 'type'; ref?: string; locator?: Locator; value: string; submit?: boolean; append?: boolean }
  | { kind: 'press'; key: string }
  | { kind: 'scroll'; direction: 'up' | 'down' | 'left' | 'right'; ref?: string; locator?: Locator }
  | { kind: 'back' }
  | { kind: 'open'; url: string }
  | { kind: 'wait'; ms: number }
  | { kind: 'window'; match: string }
  | {
      kind: 'request';
      method: HttpMethod;
      url: string;
      headers?: Record<string, string>;
      body?: string;
      capture?: Record<string, string>;
    };

export type ActResult = {
  ok: boolean;
  /** False when delivery may be partial or a control boundary invalidated the path. */
  retryable?: boolean;
  /** API response strings selected by replayable JSON pointers. */
  captures?: Record<string, string>;
  /** Set when a locator failed and the driver fell back to the point. */
  degraded?: boolean;
  error?: string;
  /** The step to record for replay, with a stable locator in place of the ref. */
  step?: RoutineStep;
};

/**
 * The only thing the agent layer knows about a platform (ADR 0005). A new
 * platform is a new Driver; nothing above this interface changes.
 */
export type ControlEvent =
  | { kind: 'control-change'; summary: string; owner: 'agent' | 'human' }
  | { kind: 'human-action'; summary: string };

export interface Driver {
  readonly viewerUrl?: string;
  readonly controlVersion?: number;
  onControlEvent?: (event: ControlEvent) => void;
  interrupt?(): void;
  readonly platform: Platform;
  /** Connect to an app that `app.setup` already started. */
  connect(): Promise<void>;
  observe(): Promise<Observation>;
  act(action: DriverAction): Promise<ActResult>;
  /**
   * Wait until the screen stops changing: two identical screenshots in a row,
   * or the timeout. Returns how many frames it took.
   */
  settle(options?: { timeoutMs?: number; intervalMs?: number }): Promise<{ frames: number; stable: boolean }>;
  /**
   * The observation in the shape the invariant engine and the pipeline take,
   * so every platform gets the same geometry checks.
   */
  snapshot(observation: Observation, screenId: string): ScreenSnapshot;
  /**
   * Starts a recording of the screen. A driver without it has no recording,
   * and its callers keep screenshots. It throws when this host cannot record.
   */
  startRecording?(): Promise<void>;
  /** Stops the recording, writes it to `name` plus the extension of its format, and returns that file. */
  stopRecording?(name: string): Promise<string>;
  close(): Promise<void>;
}
