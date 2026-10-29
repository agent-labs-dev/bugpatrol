import { isDeepStrictEqual } from 'node:util';
import { type Contract, type ContractResponse, checkContract, checkSchema } from '@bugpatrol/contract';
import {
  type Assertion,
  type AssertionResult,
  type BugCheck,
  type ClaimReplay,
  type ContractCheck,
  type RoutineStep,
  resolvePointer,
} from '@bugpatrol/core';
import { ApiDriver, type Driver, type DriverAction, type Observation, type RawResponse } from '@bugpatrol/drivers';
import { stoppedAt } from './review-comment.js';
import type { AgentSession } from './session.js';

/** Carries a replay failure back to the explorer without creating a finding. */
export type ReplayResult = { ok: boolean; failedStep?: number; error?: string; degraded: boolean };

/**
 * The parts of a bug check that do not hold on a screen, in words, so an
 * empty list means the bug shows. `errors` are the console and network
 * errors of the whole flow: a driver reports each one once only.
 */
export function bugMisses(check: BugCheck, screen: Observation, errors: string[]): string[] {
  const texts = [
    screen.title,
    screen.capture.kind === 'http' ? screen.capture.exchange?.response?.body : undefined,
    screen.terminal?.output,
    ...screen.elements.flatMap((element) => [element.name, element.text, element.value, element.testId]),
  ].filter((text): text is string => Boolean(text));
  const onScreen = (part: string) => texts.some((text) => text.includes(part));
  const misses: string[] = [];
  if (check.shows && !onScreen(check.shows)) misses.push(`the screen does not show "${check.shows}"`);
  if (check.lacks && onScreen(check.lacks)) misses.push(`the screen shows "${check.lacks}"`);
  if (check.error && !errors.some((error) => error.includes(check.error!)))
    misses.push(`no console or network error has "${check.error}"`);
  return misses;
}

/**
 * The one place that evaluates assertions: the checks of a routine step, of
 * a claim, and of the contract. Each one is exact, so the same output gives
 * the same result on each run. The status and the body texts read the
 * exchange on the screen. The other API kinds read `raw`, the response
 * before redaction (`Driver.lastRaw`), so redaction cannot change a verdict;
 * `contract` and `schema` send it to `@bugpatrol/contract`. Each `actual`
 * comes from the redacted exchange only.
 */
export function checkAssertions(
  assertions: Assertion[],
  screen: Observation,
  api: { raw?: RawResponse; contract?: Contract } = {},
): AssertionResult[] {
  const { terminal } = screen;
  const exchange = screen.capture.kind === 'http' ? screen.capture.exchange : undefined;
  const http = exchange?.response;
  return assertions.flatMap((assertion): AssertionResult[] => {
    if (assertion.kind === 'exit-code' || assertion.kind === 'status') {
      const code = assertion.kind === 'status' ? http?.status : terminal?.exitCode;
      const ok = code !== undefined && [assertion.value].flat().includes(code);
      return [{ assertion, ok, actual: code === undefined ? 'none' : String(code) }];
    }
    if (
      assertion.kind === 'output-includes' ||
      assertion.kind === 'output-excludes' ||
      assertion.kind === 'body-includes' ||
      assertion.kind === 'body-excludes'
    ) {
      const text = (assertion.kind.startsWith('body') ? http?.body : terminal?.output) ?? '';
      const has = text.includes(assertion.value);
      return [{ assertion, ok: assertion.kind.endsWith('includes') ? has : !has }];
    }
    const { raw } = api;
    if (!raw) return [{ assertion, ok: false, actual: 'none' }];
    if (assertion.kind === 'pointer') {
      const found = resolvePointer(raw.json, assertion.pointer);
      const ok = found !== undefined && (!('equals' in assertion) || isDeepStrictEqual(found.value, assertion.equals));
      const shown = found && resolvePointer(parseJson(http?.body), assertion.pointer);
      return [{ assertion, ok, actual: shown ? short(JSON.stringify(shown.value)) : 'missing' }];
    }
    if (assertion.kind === 'header') {
      const name = assertion.name.toLowerCase();
      const value = raw.headers[name];
      const shown = http?.headers[name];
      const actual = value === undefined ? 'missing' : shown;
      return [
        {
          assertion,
          ok: value !== undefined && matches(assertion.matches, value),
          ...(actual === undefined ? {} : { actual }),
        },
      ];
    }
    if (!api.contract) throw new Error(`A ${assertion.kind} assertion needs the contract of the API`);
    const response: ContractResponse = { ...raw, ...(http?.tooLarge ? { tooLarge: true } : {}) };
    if (assertion.kind === 'schema') return [checkSchema(assertion.ref, response, api.contract)];
    const request = exchange?.request;
    const endpoint = request && api.contract.match(request.method, request.path);
    if (!endpoint) return [{ assertion, ok: false, actual: request ? `${request.method} ${request.path}` : 'none' }];
    return checkContract(endpoint, response, api.contract);
  });
}

function parseJson(body: string | undefined): unknown {
  try {
    return body === undefined ? undefined : JSON.parse(body);
  } catch {
    return undefined;
  }
}

function matches(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern).test(value);
  } catch {
    return false;
  }
}

const short = (text: string) => (text.length > 80 ? `${text.slice(0, 79)}…` : text);

/** Each part of a contract check as a sentence, and what the API did instead. */
const CONTRACT_WORDS: Record<ContractCheck, [string, (actual: string) => string]> = {
  status: ['The status is declared in the spec', (actual) => `the status ${actual} is not declared in the spec`],
  'no-5xx': ['The status is not a server error', (actual) => `the status is ${actual}`],
  'content-type': [
    'The content type is declared in the spec',
    (actual) => (actual === 'none' ? 'the response has no content type' : `the content type ${actual} is not declared`),
  ],
  schema: ['The body matches the schema of the spec', (actual) => `the body does not match the schema: ${actual}`],
};

/** An assertion as a sentence, or with `failed`, what the command or the API did instead. */
export function assertionWords(result: Pick<AssertionResult, 'assertion' | 'actual'>, failed = false): string {
  const { assertion, actual } = result;
  if (assertion.kind === 'exit-code')
    return failed
      ? actual === 'none'
        ? 'the command did not exit'
        : `the exit code is ${actual}`
      : `The exit code is ${assertion.value}`;
  if (failed && actual === 'none' && assertion.kind !== 'contract') return 'no response came';
  switch (assertion.kind) {
    case 'status':
      return failed ? `the status is ${actual}` : `The status is ${[assertion.value].flat().join(' or ')}`;
    case 'contract': {
      if (failed && actual === 'none') return 'no response came';
      if (!assertion.check)
        return failed ? `the spec has no endpoint for ${actual}` : 'The response conforms to the spec';
      const [pass, fail] = CONTRACT_WORDS[assertion.check];
      return failed ? fail(actual ?? 'none') : pass;
    }
    case 'schema':
      return failed ? `the body does not match ${assertion.ref}: ${actual}` : `The body matches ${assertion.ref}`;
    case 'pointer': {
      if (failed) return `\`${assertion.pointer}\` is ${actual}`;
      return `\`${assertion.pointer}\` ${'equals' in assertion ? `is ${JSON.stringify(assertion.equals)}` : 'exists'}`;
    }
    case 'header':
      if (!failed) return `The ${assertion.name} header matches /${assertion.matches}/`;
      if (actual === 'missing') return `the response has no ${assertion.name} header`;
      return actual === undefined
        ? `the ${assertion.name} header does not match /${assertion.matches}/`
        : `the ${assertion.name} header is "${actual}"`;
    default: {
      const what = assertion.kind.startsWith('body') ? 'body' : 'output';
      const has = assertion.kind.endsWith('includes');
      if (failed) return `the ${what} ${has ? 'lacks' : 'has'} "${assertion.value}"`;
      return `The ${what} ${has ? 'has' : 'does not have'} "${assertion.value}"`;
    }
  }
}

/** What a replay decides with no model: where it stopped, the bug check, the outputs, and the assertions. */
export type ReplayOutcome = Pick<ClaimReplay, 'ok' | 'failedStep' | 'bug' | 'outputs' | 'assertions'>;

/**
 * "Repeats on a second replay", the one rule that lets a failure block
 * (ADR 0001, ADR 0007). `replay` runs the steps of the failures a second
 * time and gives the second outcome of each by id. For each failure with a
 * second outcome, `differs` says why the failure does not repeat. It is
 * absent when the failure repeats.
 */
export async function confirmFailure<T extends ReplayOutcome>(
  failing: Map<string, T | undefined>,
  replay: (ids: string[]) => Promise<Map<string, T>>,
): Promise<Map<string, { again: T; differs?: string }>> {
  const again = await replay([...failing.keys()]);
  const confirmed = new Map<string, { again: T; differs?: string }>();
  for (const [id, first] of failing) {
    const second = again.get(id);
    if (!second) continue;
    const differs = difference(first, second);
    confirmed.set(id, { again: second, ...(differs ? { differs } : {}) });
  }
  return confirmed;
}

/**
 * Why a second replay differs from the first, or undefined when both gave
 * the same results that code decides: where the replay stopped, the bug
 * check, the outputs and the exact checks. The screens may differ, for
 * example by a time on the page; no verdict reads them.
 */
function difference(first: ReplayOutcome | undefined, second: ReplayOutcome): string | undefined {
  const at = (replay: ReplayOutcome | undefined) => (replay?.ok ? 'replayed all its steps' : stoppedAt(replay));
  if (first?.ok !== second.ok || first?.failedStep !== second.failedStep)
    return `the first replay ${at(first)}, and the second ${at(second)}`;
  if (first?.bug !== second.bug) return 'the bug showed on one replay only';
  // The normalised outputs are the evidence of a same-behavior claim.
  if (first?.outputs || second.outputs)
    return JSON.stringify(first?.outputs) === JSON.stringify(second.outputs)
      ? undefined
      : 'the outputs of the second replay differ from the first';
  const results = (replay?: ReplayOutcome) =>
    JSON.stringify(replay?.assertions?.map((result) => [result.ok, result.actual]));
  return results(first) === results(second) ? undefined : 'the exact checks gave a different result';
}

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
 * error that it throws is not a failed step: it goes to the caller. With
 * `assert`, a step whose assertions fail is a failed step.
 */
async function runSteps(
  session: AgentSession,
  steps: RoutineStep[],
  windowMs: number,
  skippable: boolean,
  onStep?: (index: number) => Promise<void>,
  assert?: { contract?: Contract },
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
      if (assert && step.assert?.length) {
        const results = checkAssertions(step.assert, await driver.observe(), {
          raw: driver.lastRaw?.(),
          contract: assert.contract,
        });
        const failed = results.filter((item) => !item.ok);
        if (failed.length) {
          failedStep = index;
          error = `The checks failed: ${failed.map((item) => assertionWords(item, true)).join(', and ')}`;
          break;
        }
      }
    } catch (cause) {
      failedStep = index;
      error = String(cause);
      break;
    }
    await onStep?.(index);
  }
  return { degraded, failedStep, error, skipped };
}

/**
 * Dependencies are replayed once; a failed path is a repair task, never a
 * finding. A step whose assertions fail fails the replay. The `contract` and
 * `schema` assertions need `contract`; without it, the replay uses the
 * contract of the api driver.
 */
export async function replayRoutine(
  session: AgentSession,
  id: string,
  options: {
    seen?: Set<string>;
    dependency?: boolean;
    windowMs?: number;
    save?: boolean;
    onFixBuild?: boolean;
    contract?: Contract;
  } = {},
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
      contract: options.contract,
    });
    degraded ||= result.degraded;
    if (!result.ok) {
      error = `Required routine ${dependency}: ${result.error}`;
      break;
    }
  }
  let contract = options.contract;
  const needsContract = routine.steps.some((step) =>
    step.assert?.some((item) => item.kind === 'contract' || item.kind === 'schema'),
  );
  // The api driver gates on the contract that startApp built; the checks read the same one.
  contract ??= session.driver instanceof ApiDriver ? session.driver.policy.contract : undefined;
  if (!error && !contract && needsContract) error = 'The checks need the API contract, and this app has none';
  const skipped: number[] = [];
  if (!error) {
    // With an end check, a missing target may be a banner that did not show or
    // a detour; the check at the end decides. Without one, the first miss fails.
    const skippable = Boolean(routine.expect);
    const result = await runSteps(
      session,
      routine.steps,
      options.windowMs ?? (skippable ? 10_000 : 30_000),
      skippable,
      undefined,
      { contract },
    );
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
  return (
    (step.kind === 'tap' || step.kind === 'type' || step.kind === 'scroll' || step.kind === 'upload') &&
    Boolean(step.target)
  );
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
    (action.kind === 'tap' || action.kind === 'type' || action.kind === 'scroll' || action.kind === 'upload') &&
    Boolean(action.locator);
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

/** A routine step as a driver action, with its placeholders resolved. */
export function toAction({ assert: _assert, ...step }: RoutineStep, session: AgentSession): DriverAction {
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
  if (step.kind === 'upload') return { kind: 'upload', locator: step.target, file: step.file };
  if (step.kind === 'request')
    return {
      ...step,
      url: session.vars.resolve(step.url),
      headers: step.headers
        ? Object.fromEntries(Object.entries(step.headers).map(([key, value]) => [key, session.vars.resolve(value)]))
        : undefined,
      body: step.body === undefined ? undefined : session.vars.resolve(step.body),
    };
  if (step.kind === 'run')
    return {
      kind: 'run',
      command: session.vars.resolve(step.command),
      ...(step.input === undefined ? {} : { input: session.vars.resolve(step.input) }),
    };
  return step;
}
