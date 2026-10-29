import type {
  AgentRole,
  AgentStatus,
  BugpatrolConfig,
  HttpExchange,
  RoutineStep,
  SessionSignal,
} from '@bugpatrol/core';
import type { Driver, Observation } from '@bugpatrol/drivers';
import type { EventSink } from './types.js';
import type { Vars } from './vars.js';
import { Workspace } from './workspace.js';

/** One role's mutable context; the workspace owns durable state. */
export class AgentSession {
  readonly workspace: Workspace;
  readonly emit: EventSink;
  readonly trail: RoutineStep[] = [];
  readonly completedRoutines = new Set<string>();
  anchor: { routineId?: string; index: number } = { index: 0 };
  lastObservation?: Observation;
  previousObservation?: Observation;
  /** The last capture file: a PNG, or the exchange JSON of an API. */
  lastCapture?: string;
  lastScreenId?: string;
  lastScreenTrailIndex = 0;
  /** Where the app was when lastScreenId was recorded. */
  lastScreenLocation?: string;
  /** Issues already counted as seen again in this session. */
  readonly seenIssues = new Set<string>();
  cancelled = false;
  private spentUsd = 0;
  private runtimeLabel = '';
  private statusQueue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly root: string,
    readonly config: BugpatrolConfig,
    readonly vars: Vars,
    readonly sessionId: string,
    readonly role: AgentRole,
    readonly driver?: Driver,
    onEvent?: (summary: string) => void,
  ) {
    this.workspace = new Workspace(root);
    const record = this.workspace.recordEvent(sessionId, role, vars);
    this.emit = (event) => {
      record(event);
      onEvent?.(vars.redact(event.summary) as string);
      if (event.costUsd) {
        this.spentUsd += event.costUsd;
        this.statusQueue = this.statusQueue
          .then(() =>
            this.workspace.setAgentStatus(role, {
              state: 'working',
              sessionId,
              spentUsd: this.spentUsd,
            }),
          )
          .catch(() => undefined);
      }
    };
    if (driver)
      driver.onControlEvent = (event) => {
        if (event.kind === 'control-change') {
          this.trail.length = 0;
          this.anchor = { index: 0 };
          this.completedRoutines.clear();
          this.lastObservation = undefined;
          this.previousObservation = undefined;
          this.lastCapture = undefined;
          this.lastScreenId = undefined;
          this.lastScreenLocation = undefined;
          this.lastScreenTrailIndex = 0;
        }
        this.emit(event);
      };
  }

  /** Status for the dashboard. A failed status write is logged, never thrown into a tool. */
  async activity(text: string, spentUsd?: number, runtime?: string): Promise<void> {
    this.runtimeLabel = runtime ?? this.runtimeLabel;
    await this.safeStatus({
      state: 'working',
      activity: text,
      sessionId: this.sessionId,
      spentUsd: spentUsd ?? this.spentUsd,
      runtime: this.runtimeLabel,
    });
  }

  async idle(spentUsd = 0): Promise<void> {
    await this.statusQueue;
    await this.safeStatus({
      state: 'idle',
      activity: undefined,
      sessionId: undefined,
      spentUsd,
    });
  }

  private async safeStatus(patch: Partial<AgentStatus>): Promise<void> {
    try {
      await this.workspace.setAgentStatus(this.role, patch);
    } catch (error) {
      this.emit({ kind: 'error', summary: `Could not update the agent status: ${String(error).slice(0, 120)}` });
    }
  }

  /**
   * Saves what the observation shows: a PNG, or for an API the exchange as
   * `exchange.json`. An API that has had no request yet has no file.
   */
  async capture(observation: Observation, label: string): Promise<string | undefined> {
    const { capture } = observation;
    const file =
      capture.kind === 'image'
        ? await this.workspace.saveCapture(this.sessionId, capture, label)
        : capture.exchange
          ? await this.workspace.saveCapture(
              this.sessionId,
              { kind: 'http', exchange: this.vars.redact(capture.exchange) as HttpExchange },
              label,
            )
          : undefined;
    if (this.lastObservation !== observation) this.previousObservation = this.lastObservation;
    this.lastObservation = observation;
    this.lastCapture = file;
    await this.recordSignals(observation);
    return file;
  }

  /**
   * Keep the app's own failures with the moment they were seen. A failed
   * request is the link between a user action and the backend's logs, so it is
   * recorded as it happens rather than reconstructed afterwards.
   */
  private async recordSignals(observation: Observation): Promise<void> {
    const signals: SessionSignal[] = [];
    for (const text of observation.consoleErrors) {
      signals.push({ at: observation.at, kind: 'console', text: this.vars.redact(text) as string });
    }
    for (const text of observation.networkErrors ?? []) {
      signals.push({ at: observation.at, kind: 'request', text: this.vars.redact(text) as string });
    }
    if (signals.length === 0) return;
    try {
      await this.workspace.appendSignals(this.sessionId, signals);
    } catch (error) {
      this.emit({
        kind: 'error',
        summary: `Could not record the app's failed requests: ${String(error).slice(0, 120)}`,
      });
    }
  }
}
