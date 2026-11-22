import type {
  AgentRole,
  AgentStatus,
  BugpatrolConfig,
  HttpExchange,
  RoutineStep,
  SessionSignal,
} from '@bugpatrol/core';
import type { Driver, Observation } from '@bugpatrol/drivers';
import { terminalRecord } from './evidence.js';
import type { EventSink } from './types.js';
import type { Vars } from './vars.js';
import { Workspace } from './workspace.js';

/** One role's mutable context; the workspace owns durable state. */
export class AgentSession {
  readonly workspace: Workspace;
  readonly emit: EventSink;
  readonly trail: RoutineStep[] = [];
  readonly completedRoutines = new Set<string>();
  /** Original trail identities for saved steps, whose JSON loses object identity when read back. */
  readonly savedRoutineSteps = new Map<string, RoutineStep[]>();
  anchor: { routineId?: string; index: number } = { index: 0 };
  lastObservation?: Observation;
  previousObservation?: Observation;
  /** The last capture file: a PNG, or the exchange JSON of an API. */
  lastCapture?: string;
  /** The text of the terminal beside the last capture (see `Evidence`), on a CLI app. */
  lastTerminal?: string;
  lastScreenId?: string;
  lastScreenTrailIndex = 0;
  /** Where the app was when lastScreenId was recorded. */
  lastScreenLocation?: string;
  /**
   * The console and network errors that the app logged since the start of what
   * a report replays: the session, a claim flow or a replayed routine (see
   * `startFlow`). An observation holds only what was logged since the one
   * before it, so a report checks its error against all of these. Each keeps
   * the trail step that showed it, since a saved routine can leave that step
   * out (see `keepErrors`). One seen before the first step of the flow has none:
   * the start of the replay shows it.
   */
  private readonly errorsSeen: { text: string; step?: RoutineStep }[] = [];
  /** How many of errorsSeen the last observation added. */
  private lastObservationErrors = 0;
  /** Where the trail of the current flow starts. */
  private flowStart = 0;
  /** Issues already counted as seen again in this session. */
  readonly seenIssues = new Set<string>();
  cancelled = false;
  /** Read-only mode and `app.connect.deny`: the requests of the app that Bugpatrol blocked in this session. */
  writesBlocked = 0;
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
    this.workspace = new Workspace(root, config.profile);
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
          this.lastTerminal = undefined;
          this.lastScreenId = undefined;
          this.lastScreenLocation = undefined;
          this.lastScreenTrailIndex = 0;
          this.errorsSeen.length = 0;
          this.lastObservationErrors = 0;
          this.flowStart = 0;
        }
        this.emit(event);
      };
  }

  /**
   * Starts a flow that a report replays from here: after the routine
   * `routineId`, or from the current state of the app. The errors seen before
   * it are not part of that replay. A saved routine continues the flow instead,
   * since it holds the steps before it.
   */
  startFlow(routineId?: string): void {
    this.anchor = { ...(routineId ? { routineId } : {}), index: this.trail.length };
    this.errorsSeen.length = 0;
    this.lastObservationErrors = 0;
    this.flowStart = this.trail.length;
  }

  /**
   * Adds a step to the trail. The observation after its action showed the
   * errors that the step caused, so those errors belong to it.
   */
  recordStep(step: RoutineStep): void {
    this.trail.push(step);
    for (const error of this.errorsSeen.slice(this.errorsSeen.length - this.lastObservationErrors)) error.step = step;
  }

  /**
   * An action that failed adds no step, so a replay never takes it: the errors
   * that its observation showed are not part of the replay.
   */
  dropFailedActionErrors(): void {
    this.errorsSeen.splice(this.errorsSeen.length - this.lastObservationErrors);
    this.lastObservationErrors = 0;
  }

  /** Keeps only the errors whose step (none before the flow's first step) a replay still takes. */
  keepErrors(replayed: (step?: RoutineStep) => boolean): void {
    const kept = this.errorsSeen.filter(({ step }) => replayed(step));
    this.errorsSeen.splice(0, this.errorsSeen.length, ...kept);
    this.lastObservationErrors = 0;
  }

  /** The errors that a replay of a report shows. */
  errorsInReplay(): string[] {
    return this.errorsSeen.map(({ text }) => text);
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
   * `exchange.json`. An API that has had no request yet has no file. A
   * terminal's text goes beside its PNG.
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
    if (this.lastObservation !== observation) {
      this.previousObservation = this.lastObservation;
      // A look shows what the last step went on to log; an action's own step is added after it.
      const step = this.trail.length > this.flowStart ? this.trail.at(-1) : undefined;
      const errors = [...observation.consoleErrors, ...(observation.networkErrors ?? [])];
      this.errorsSeen.push(...errors.map((text) => ({ text, step })));
      this.lastObservationErrors = errors.length;
    }
    this.lastObservation = observation;
    this.lastCapture = file;
    this.lastTerminal =
      file && observation.terminal
        ? await this.workspace.saveTerminalText(file, this.vars.redact(terminalRecord(observation.terminal)) as string)
        : undefined;
    this.reportBlockedWrites(observation.blockedWrites);
    await this.recordSignals(observation);
    return file;
  }

  /**
   * One event for each request that read-only mode or `app.connect.deny` blocked. Without `lines`, it
   * takes those that no observation reported yet, so none goes unreported at
   * the end of a session.
   */
  reportBlockedWrites(lines: string[] = this.driver?.writes?.drain() ?? []): void {
    for (const line of lines) {
      this.writesBlocked++;
      this.emit({ kind: 'write-blocked', summary: `Bugpatrol blocked ${line}` });
    }
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
