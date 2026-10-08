import type { RoutineStep } from '@bugpatrol/core';
import type { Driver, DriverAction } from '@bugpatrol/drivers';
import type { AgentSession } from './session.js';

/** Carries a replay failure back to the explorer without creating a finding. */
export type ReplayResult = { ok: boolean; failedStep?: number; error?: string; degraded: boolean };

/** Replay issue-local steps from the current screen; the first failure stops the path. */
export async function replaySteps(
  session: AgentSession,
  steps: RoutineStep[],
  opts: { windowMs?: number; onStep?: (index: number) => Promise<void> } = {},
): Promise<ReplayResult> {
  const result = await runSteps(session, steps, opts.windowMs ?? 30_000, false, opts.onStep);
  return { ok: !result.error, failedStep: result.failedStep, error: result.error, degraded: result.degraded };
}

/**
 * `onStep` runs after each step that worked, once the screen settled. An
 * error that it throws is not a failed step: it goes to the caller.
 */
async function runSteps(
  session: AgentSession,
  steps: RoutineStep[],
  windowMs: number,
  skippable: boolean,
  onStep?: (index: number) => Promise<void>,
) {
  const driver = session.driver as Driver;
  const version = driver.controlVersion;
  let degraded = false;
  let failedStep: number | undefined;
  let error: string | undefined;
  const skipped: number[] = [];
  for (let index = 0; index < steps.length; index++) {
    if (session.cancelled) {
      failedStep = index;
      error = 'Interrupted';
      break;
    }
    const step = steps[index]!;
    try {
      const result = await actWhenReady(driver, toAction(step, session), session, windowMs);
      if (version !== driver.controlVersion)
        throw new Error('Human takeover interrupted replay; look again and start a new path');
      degraded ||= Boolean(result.degraded);
      if (!result.ok) {
        if (skippable && result.retryable !== false && isTargeted(step)) {
          skipped.push(index);
          continue;
        }
        failedStep = index;
        error = result.error ?? 'Action failed';
        break;
      }
      session.vars.capture(result.captures);
      await driver.settle();
      if (version !== driver.controlVersion)
        throw new Error('Human takeover interrupted replay; look again and start a new path');
    } catch (cause) {
      failedStep = index;
      error = String(cause);
      break;
    }
    await onStep?.(index);
  }
  return { degraded, failedStep, error, skipped };
}

/** Dependencies are replayed once; a failed path is a repair task, never a finding. */
export async function replayRoutine(
  session: AgentSession,
  id: string,
  options: { seen?: Set<string>; dependency?: boolean; windowMs?: number; save?: boolean; onFixBuild?: boolean } = {},
): Promise<ReplayResult> {
  const version = session.driver?.controlVersion;
  const seen = options.seen ?? new Set<string>();
  if (options.dependency && session.completedRoutines.has(id)) {
    return { ok: true, degraded: false };
  }
  if (seen.has(id)) {
    return { ok: true, degraded: false };
  }
  seen.add(id);
  const routine = await session.workspace.readRoutine(id);
  if (!routine) {
    return { ok: false, degraded: false, error: `Unknown routine ${id}` };
  }
  let degraded = false;
  let failedStep: number | undefined;
  let error: string | undefined;
  for (const dependency of routine.requires ?? []) {
    const result = await replayRoutine(session, dependency, {
      seen,
      dependency: true,
      windowMs: options.windowMs,
      save: options.save,
      onFixBuild: options.onFixBuild,
    });
    degraded ||= result.degraded;
    if (!result.ok) {
      error = `Required routine ${dependency}: ${result.error}`;
      break;
    }
  }
  const skipped: number[] = [];
  if (!error) {
    // With an end check, a missing target may be a banner that did not show or
    // a detour; the check at the end decides. Without one, the first miss fails.
    const skippable = Boolean(routine.expect);
    const result = await runSteps(session, routine.steps, options.windowMs ?? (skippable ? 10_000 : 30_000), skippable);
    degraded ||= result.degraded;
    failedStep = result.failedStep;
    error = result.error;
    skipped.push(...result.skipped);
    if (!error && skipped.length) {
      const arrived = await endsWhereExpected(session.driver as Driver, routine.expect!.elements);
      if (arrived) {
        degraded = true;
      } else {
        failedStep = skipped[0];
        error = `Step ${skipped[0]} found no target, and the screen does not match where the routine should end`;
      }
    }
  }
  if (version !== session.driver?.controlVersion)
    error = 'Human takeover interrupted replay; look again and start a new path';
  if (options.save !== false || (options.onFixBuild && error))
    await session.workspace.saveRoutine({
      ...routine,
      lastReplay: {
        at: new Date().toISOString(),
        ok: !error,
        degraded,
        error,
        skipped: skipped.length ? skipped : undefined,
        onFixBuild: options.onFixBuild && error ? true : undefined,
      },
    });
  if (!error) {
    session.completedRoutines.add(id);
  }
  return {
    ok: !error,
    failedStep,
    error,
    degraded,
  };
}

function isTargeted(step: RoutineStep): boolean {
  return (step.kind === 'tap' || step.kind === 'type' || step.kind === 'scroll') && Boolean(step.target);
}

/** Most of the expected names on screen: layouts drift, so one missing name is not a failure. */
async function endsWhereExpected(driver: Driver, expected: string[]): Promise<boolean> {
  await driver.settle();
  const observation = await driver.observe();
  const present = new Set(observation.elements.flatMap((item) => [item.name, item.testId ?? '']));
  const found = expected.filter((name) => present.has(name)).length;
  return found / expected.length >= 0.6;
}

async function actWhenReady(driver: Driver, action: DriverAction, session: AgentSession, windowMs: number) {
  const retry =
    (action.kind === 'tap' || action.kind === 'type' || action.kind === 'scroll') && Boolean(action.locator);
  const deadline = Date.now() + windowMs;
  let degraded = false;
  while (true) {
    const result = await driver.act(action);
    degraded ||= Boolean(result.degraded);
    if (result.ok || result.retryable === false || !retry || Date.now() >= deadline || session.cancelled) {
      return { ...result, degraded };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

function toAction(step: RoutineStep, session: AgentSession): DriverAction {
  if (step.kind === 'tap') return { kind: 'tap', locator: step.target };
  if (step.kind === 'type') {
    return {
      kind: 'type',
      locator: step.target,
      value: session.vars.resolve(step.value),
      submit: step.submit,
      append: step.append,
    };
  }
  if (step.kind === 'scroll') return { kind: 'scroll', direction: step.direction, locator: step.target };
  if (step.kind === 'open') return { kind: 'open', url: session.vars.resolve(step.url) };
  if (step.kind === 'window') return { kind: 'window', match: step.match };
  if (step.kind === 'request')
    return {
      ...step,
      url: session.vars.resolve(step.url),
      headers: step.headers
        ? Object.fromEntries(Object.entries(step.headers).map(([key, value]) => [key, session.vars.resolve(value)]))
        : undefined,
      body: step.body === undefined ? undefined : session.vars.resolve(step.body),
    };
  return step;
}
