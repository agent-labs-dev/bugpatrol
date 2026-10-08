import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const apiRequestSchema = z.object({
  method: z.enum(['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']),
  url: z.string().min(1),
  headers: z.record(z.string()).optional(),
  body: z.string().optional(),
  capture: z.record(z.string().regex(/^RESPONSE_[A-Z0-9_]+$/), z.string()).optional(),
});

import {
  type BugCheck,
  type Candidate,
  fingerprint,
  type Locator,
  type Routine,
  type RoutineStep,
  type ScreenTransition,
  shortHash,
} from '@bugpatrol/core';
import type { DriverAction, Observation, UiElement } from '@bugpatrol/drivers';
import { addOccurrence, evaluateScreen } from '../evaluate.js';
import { bugMisses, replayRoutine } from '../replay.js';
import type { AgentSession } from '../session.js';
import type { Tool, ToolResult } from '../types.js';
import { lessonTools } from './memory.js';

const text = (value: string): ToolResult => ({ content: [{ type: 'text', text: value }] });
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const string = { type: 'string' };
const boolean = { type: 'boolean' };
const arg = (input: Record<string, unknown>, key: string) => String(input[key] ?? '');
const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'screen';

function elementLine(element: UiElement): string {
  const box = element.box;
  const flags = [
    element.value !== undefined ? `value=${JSON.stringify(element.value)}` : '',
    element.focused ? 'focused' : '',
    element.enabled ? '' : 'disabled',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    `[${element.ref}] ${element.role} ${JSON.stringify(element.name)}` +
    ` (${box.x},${box.y} ${box.width}x${box.height})${flags ? ` ${flags}` : ''}`
  );
}

/** What the app logged since the last observation: the signals that a screenshot does not show. */
export function errorLines(observation: Observation): string[] {
  const unique = (items: string[] = []) => [...new Set(items)].map((item) => item.slice(0, 200));
  const lines = (label: string, items: string[]) =>
    items.length
      ? [
          `${label}:`,
          ...items.slice(0, 5).map((item) => `- ${item}`),
          ...(items.length > 5 ? [`- (${items.length - 5} more)`] : []),
        ]
      : [];
  return [
    ...lines('Console errors', unique(observation.consoleErrors)),
    ...lines('Failed requests', unique(observation.networkErrors)),
  ];
}

function observationText(observation: Observation): string {
  const windows =
    observation.windows
      ?.map((window) => `${window.active ? '*' : ' '} ${window.title} (${window.location})`)
      .join('; ') ?? '(none)';
  return [
    `Location: ${observation.location}`,
    `Windows: ${windows}`,
    ...errorLines(observation),
    ...(observation.http
      ? [
          `HTTP ${observation.http.status} (${observation.http.contentType ?? 'no content type'})`,
          observation.http.body,
        ]
      : []),
    ...(observation.terminal
      ? [
          `$ ${observation.terminal.command}`,
          observation.terminal.exitCode === undefined
            ? 'The command did not exit.'
            : `Exit code: ${observation.terminal.exitCode}`,
          'Output:',
          observation.terminal.output.slice(-8000) || '(none)',
        ]
      : []),
    'Elements:',
    ...observation.elements.slice(0, 117).map(elementLine),
  ]
    .slice(0, 130)
    .join('\n');
}

async function observe(session: AgentSession, label: string, summary?: string): Promise<ToolResult> {
  const observation = await session.driver!.observe();
  const screenshot = await session.capture(observation, label);
  return {
    content: [
      { type: 'image', png: observation.screenshot },
      { type: 'text', text: session.vars.redact(observationText(observation)) as string },
    ],
    meta: { summary: summary ?? `Looked at ${observation.title || observation.location}`, screenshot },
  };
}

/**
 * Where the app is, for loop removal: the screen key plus the element names.
 * A URL alone is too coarse (a form or a dialog keeps it), and the names also
 * change when the app state changes, e.g. a new row in a list.
 */
function locationKey(observation: Observation): string {
  const names = shortHash(
    observation.elements
      .map((item) => item.name)
      .sort()
      .join('|'),
  );
  return observation.platform === 'ios' || observation.platform === 'android'
    ? names
    : `${screenKey(observation)}|${names}`;
}

/** Where the app is: the location and the window, since one URL can host two windows. */
function screenKey(observation: Observation): string {
  const active = observation.windows?.find((window) => window.active);
  return `${observation.location}|${active?.title ?? ''}`;
}

function transition(session: AgentSession, to: string): ScreenTransition | undefined {
  const actions = session.trail.slice(session.lastScreenTrailIndex).filter((step) => step.kind !== 'wait');
  if (!session.lastScreenId || session.lastScreenId === to || !actions.length || actions.length > 4) return;
  const last = actions.at(-1)!;
  const kind = actions.some((step) => step.kind === 'open' || step.kind === 'window')
    ? 'open'
    : last.kind === 'back'
      ? 'back'
      : last.kind === 'tap' || last.kind === 'press' || (last.kind === 'type' && last.submit)
        ? 'tap'
        : 'other';
  const label =
    last.kind === 'tap'
      ? (last.target.name ?? last.target.text ?? last.target.testId ?? 'tap')
      : last.kind === 'open'
        ? `open ${last.url}`
        : last.kind === 'window'
          ? `window ${last.match}`
          : last.kind === 'back'
            ? 'back'
            : last.kind === 'press'
              ? `press ${last.key}`
              : last.kind === 'type'
                ? (last.target?.name ?? 'submit')
                : last.kind;
  const via = (session.vars.redact(label) as string).slice(0, 60);
  return { to, kind, via, steps: actions.length, count: 1, lastSeenAt: new Date().toISOString() };
}

async function arrive(session: AgentSession, to: string, key: string): Promise<void> {
  const edge = transition(session, to);
  if (session.lastScreenId && session.lastScreenId !== to) {
    await session.workspace.upsertScreen({
      id: session.lastScreenId,
      links: [to],
      ...(edge ? { transitions: [edge] } : {}),
      visits: 0,
    });
  }
  session.lastScreenId = to;
  session.lastScreenLocation = key;
  session.lastScreenTrailIndex = session.trail.length;
}

async function arriveAtKnownScreen(session: AgentSession, before?: Observation): Promise<void> {
  const after = session.lastObservation;
  if (!before || !after || screenKey(before) === screenKey(after)) return;
  const screens = (await session.workspace.readAppMap())?.screens ?? [];
  const key = screenKey(after);
  const matches = screens.filter((screen) => (screen.screenKey ?? `${screen.location}|`) === key);
  if (matches.length === 1) await arrive(session, matches[0]!.id, key);
}

/**
 * The last recorded screen, but only if the app is still on it. After a
 * window switch or a navigation with no record_screen, a report names no
 * screen rather than the wrong one.
 */
function currentScreenId(session: AgentSession): string | undefined {
  const observation = session.lastObservation;
  if (!observation || !session.lastScreenLocation) return session.lastScreenId;
  return screenKey(observation) === session.lastScreenLocation ? session.lastScreenId : undefined;
}

/** One sentence for the activity feed, named by what a person would see. */
function describe(session: AgentSession, action: DriverAction): string {
  const named = (ref?: string) => {
    const element = ref ? session.lastObservation?.elements.find((item) => item.ref === ref) : undefined;
    return element ? `"${element.name}"` : 'the screen';
  };
  switch (action.kind) {
    case 'tap':
      return `Tapped ${named(action.ref)}`;
    case 'type':
      return `Typed into ${named(action.ref)}`;
    case 'press':
      return `Pressed ${action.key}`;
    case 'scroll':
      return `Scrolled ${action.direction}`;
    case 'back':
      return 'Went back';
    case 'open':
      return 'Opened a link';
    case 'wait':
      return `Waited ${Math.round(action.ms / 1000)}s`;
    case 'window':
      return `Switched to the "${action.match}" window`;
    case 'request':
      return `${action.method} ${session.vars.redact(action.url)}`;
    case 'run':
      return `Ran ${session.vars.redact(action.command)}`;
  }
}

async function act(session: AgentSession, action: DriverAction, recorded?: RoutineStep): Promise<ToolResult> {
  const version = session.driver!.controlVersion;
  const before = session.lastObservation;
  const replacement = 'ref' in action ? resolveOldRef(session, action.ref) : undefined;
  if (replacement && 'ref' in action) action = { ...action, ref: replacement.ref };
  const summary = describe(session, action);
  const result = await session.driver!.act(action);
  if (!result.ok) return failed(session, result.error ?? 'Action failed', summary);
  session.vars.capture(result.captures);
  await session.driver!.settle();
  const viewed = await observe(session, action.kind, summary);
  if (version !== session.driver!.controlVersion)
    return failed(session, 'Human takeover interrupted this action. Look again; start a new routine.', summary);
  if (recorded ?? result.step)
    session.trail.push({ ...(recorded ?? result.step)!, at: locationKey(session.lastObservation!) });
  await arriveAtKnownScreen(session, before);
  if (replacement) viewed.content.unshift({ type: 'text', text: replacement.message });
  return viewed;
}

function resolveOldRef(session: AgentSession, ref?: string): { ref: string; message: string } | undefined {
  if (!ref || session.lastObservation?.elements.some((item) => item.ref === ref)) return;
  const old = session.previousObservation?.elements.find((item) => item.ref === ref);
  if (!old) return;
  const matches =
    session.lastObservation?.elements.filter((item) => item.role === old.role && item.name === old.name) ?? [];
  const center = (box: UiElement['box']) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
  const from = center(old.box);
  const nearest = matches
    .map((item) => ({ item, distance: Math.hypot(center(item.box).x - from.x, center(item.box).y - from.y) }))
    .sort((a, b) => a.distance - b.distance)[0];
  if (!nearest || (matches.length > 1 && nearest.distance > 100)) return;
  return {
    ref: nearest.item.ref,
    message: `Ref ${ref} was from an older screen; used ${nearest.item.ref} (${JSON.stringify(old.name)}).`,
  };
}

/**
 * A failed action returns the screen as it is now, not only the error. The
 * usual cause is a ref from an older list, and without the new list the
 * model spends its next step on `look`.
 */
async function failed(session: AgentSession, error: string, summary: string): Promise<ToolResult> {
  const current = await observe(session, 'failed', `${summary}: failed`);
  const hint = /unknown element ref/i.test(error)
    ? ' The screen changed since that list. Use a ref from the list below.'
    : '';
  return {
    content: [{ type: 'text', text: `Error: ${error}.${hint}` }, ...current.content],
    isError: true,
    meta: current.meta,
  };
}

async function saveRoutine(
  session: AgentSession,
  id: string,
  description: string,
  screenId?: string,
): Promise<{ routine: Routine; flattenedFrom?: number }> {
  const prior = await session.workspace.readRoutine(id);
  const now = new Date().toISOString();
  let steps = session.trail.slice(session.anchor.index);
  let requires = session.anchor.routineId && session.anchor.routineId !== id ? [session.anchor.routineId] : [];
  const chain: Routine[] = [];
  const seen = new Set([id]);
  let parent = requires[0];
  while (parent && !seen.has(parent)) {
    seen.add(parent);
    const routine = await session.workspace.readRoutine(parent);
    if (!routine) break;
    chain.unshift(routine);
    parent = routine.requires?.[0];
  }
  const flattenedFrom = chain.length > 2 ? chain.length + 1 : undefined;
  if (flattenedFrom) {
    requires = [chain[0]!.id];
    steps = [...chain.slice(1).flatMap((routine) => routine.steps), ...steps];
  }
  const routine: Routine = {
    version: 1,
    id,
    description,
    platform: session.config.app.platform,
    requires,
    steps: compactSteps(steps),
    screenId,
    expect: endState(session),
    createdAt: prior?.createdAt ?? now,
    updatedAt: now,
  };
  await session.workspace.saveRoutine(routine);
  session.anchor = { routineId: id, index: session.trail.length };
  return { routine, flattenedFrom };
}

/**
 * Up to six names that identify where the routine ended. Test ids first, as
 * the most stable; names with digits are left out, because times, counts and
 * dates change between runs, and so are loading placeholders.
 */
function endState(session: AgentSession): Routine['expect'] {
  const elements = session.lastObservation?.elements ?? [];
  // A loading state is on the way to the end, not the end itself.
  const transient = (name: string) => /skeleton|spinner|loading|opening|please wait/i.test(name);
  const stable = (name: string) => name.length > 1 && name.length <= 60 && !/\d/.test(name) && !transient(name);
  const byTestId = elements.filter((item) => item.testId && !transient(item.testId)).map((item) => item.testId!);
  const byName = elements.filter((item) => item.interactive && stable(item.name)).map((item) => item.name);
  const names = [...new Set([...byTestId, ...byName])].slice(0, 6);
  return names.length ? { elements: names } : undefined;
}

function compactSteps(steps: RoutineStep[]): RoutineStep[] {
  const compacted: RoutineStep[] = [];
  for (const step of steps) {
    if (step.kind === 'wait') continue;
    if (step.kind === 'request' || step.kind === 'run') {
      compacted.push(step);
      continue;
    }
    const previous = compacted.at(-1);
    if (previous && sameStep(previous, step)) continue;
    compacted.push(step);
    if (step.at) {
      // A detour: the app left this place and came back to it unchanged. The
      // steps after the first visit add nothing. Steps that stay in one place
      // (typing into a form) are not a detour.
      const earlier = compacted.findIndex((item) => item.at === step.at);
      const left = earlier >= 0 && compacted.slice(earlier + 1, -1).some((item) => item.at !== step.at);
      if (left) compacted.splice(earlier + 1);
    }
  }
  return compacted;
}

function sameStep(left: RoutineStep, right: RoutineStep): boolean {
  return stepSignature(left) === stepSignature(right);
}

function locatorSignature(locator?: Locator): string {
  if (!locator) return '';
  if (locator.testId) return `id:${locator.testId}`;
  if (locator.role && locator.name) return `role:${locator.role}:${locator.name}`;
  if (locator.text) return `text:${locator.text}`;
  if (locator.selector) return `selector:${locator.selector}`;
  return `point:${locator.point?.x},${locator.point?.y}`;
}

function stepSignature(step: RoutineStep): string {
  if (step.kind === 'tap') return `tap:${locatorSignature(step.target)}`;
  if (step.kind === 'type') {
    return `type:${locatorSignature(step.target)}:${step.value}:${Boolean(step.submit)}:${Boolean(step.append)}`;
  }
  if (step.kind === 'scroll') {
    return `scroll:${locatorSignature(step.target)}:${step.direction}`;
  }
  if (step.kind === 'press') return `press:${step.key}`;
  if (step.kind === 'open') return `open:${step.url}`;
  if (step.kind === 'window') return `window:${step.match}`;
  if (step.kind === 'request' || step.kind === 'run') return JSON.stringify(step);
  return step.kind;
}

/**
 * Tool calls operate on refs; only replayable locators and placeholders enter routines.
 * `replay` goes to each run_routine replay: a build that is not the main build
 * passes `save: false`, so a routine that it breaks does not look broken on main.
 */
export function explorerTools(
  session: AgentSession,
  opts: { replay?: Parameters<typeof replayRoutine>[2] } = {},
): Tool[] {
  const tools: Tool[] = [
    ...(session.driver?.platform === 'desktop'
      ? [
          {
            name: 'tap_point',
            description:
              'Tap an explicit point in the latest native window screenshot when no semantic ref can reach the control. Coordinates are screenshot pixels. Recorded and replayed as degraded; never a fallback from an ambiguous ref.',
            inputSchema: schema({ x: { type: 'number', minimum: 0 }, y: { type: 'number', minimum: 0 } }, ['x', 'y']),
            run(input: Record<string, unknown>) {
              const point = z
                .object({ x: z.number().finite().nonnegative(), y: z.number().finite().nonnegative() })
                .parse(input);
              return act(session, { kind: 'tap', locator: { point } });
            },
          },
        ]
      : []),
    ...(session.driver?.platform === 'api'
      ? [
          {
            name: 'request',
            description:
              'Send an HTTP request to the configured API origin. Use {{NAME}} placeholders for credentials. Only repository-allowed methods can run; redirects are not followed. Returns status and response evidence, not an application screenshot.',
            inputSchema: schema(
              {
                method: { type: 'string', enum: ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'] },
                url: string,
                headers: { type: 'object', additionalProperties: string },
                body: string,
                capture: {
                  type: 'object',
                  additionalProperties: string,
                  description:
                    'Map RESPONSE_NAME variables to JSON pointers in the response, e.g. {RESPONSE_THREAD_ID: "/result/id"}. Use explicit {{RESPONSE_NAME}} placeholders in later URLs/bodies; literals remain literal on replay. Credential fields cannot be captured.',
                },
              },
              ['method', 'url'],
            ),
            async run(input: Record<string, unknown>) {
              const parsed = apiRequestSchema.parse(input);
              const resolved = apiRequestSchema.parse(session.vars.redact(parsed));
              const action: Extract<DriverAction, { kind: 'request' }> = {
                kind: 'request',
                ...resolved,
                url: session.vars.resolve(parsed.url),
                headers: parsed.headers
                  ? Object.fromEntries(
                      Object.entries(parsed.headers).map(([name, value]) => [name, session.vars.resolve(value)]),
                    )
                  : undefined,
                body: parsed.body === undefined ? undefined : session.vars.resolve(parsed.body),
              };
              return act(session, action, { kind: 'request', ...resolved });
            },
          },
        ]
      : []),
    ...(session.driver?.platform === 'cli'
      ? [
          {
            name: 'run_command',
            description:
              'Run one command in a terminal, from the root of the source, until it exits. Use {{NAME}} placeholders for credentials. input: text typed into the command when it starts, a line for each prompt. Returns the screen, the exit code, and the output.',
            inputSchema: schema({ command: string, input: string }, ['command']),
            async run(input: Record<string, unknown>) {
              const command = arg(input, 'command');
              const typed = input.input === undefined ? undefined : arg(input, 'input');
              if (!command.trim()) return { ...text('Give the command to run.'), isError: true };
              const recorded = session.vars.redact({ command, ...(typed ? { input: typed } : {}) }) as {
                command: string;
                input?: string;
              };
              return act(
                session,
                {
                  kind: 'run',
                  command: session.vars.resolve(command),
                  ...(typed ? { input: session.vars.resolve(typed) } : {}),
                },
                { kind: 'run', ...recorded },
              );
            },
          },
        ]
      : []),
    {
      name: 'look',
      description: 'Observe the current screen.',
      inputSchema: schema({}),
      run: () => observe(session, 'look'),
    },
    {
      name: 'tap',
      description: 'Tap one element by its latest ref.',
      inputSchema: schema({ ref: string }, ['ref']),
      async run(input) {
        const ref = arg(input, 'ref');
        await session.activity(`Tapping ${ref}`);
        return act(session, { kind: 'tap', ref });
      },
    },
    {
      name: 'type',
      description: 'Type in a field, preserving {{NAME}} placeholders for secrets.',
      inputSchema: schema(
        {
          ref: string,
          text: string,
          submit: boolean,
          append: { type: 'boolean', description: 'Add to the text already in the field. Default: replace it.' },
        },
        ['text'],
      ),
      async run(input) {
        const version = session.driver!.controlVersion;
        const before = session.lastObservation;
        const value = arg(input, 'text');
        const replacement = resolveOldRef(session, input.ref as string | undefined);
        const ref = replacement?.ref ?? (input.ref as string | undefined);
        const submit = Boolean(input.submit);
        const append = input.append === true;
        const summary = describe(session, { kind: 'type', ref, value });
        await session.activity('Typing in a field');
        const result = await session.driver!.act({
          kind: 'type',
          ref,
          value: session.vars.resolve(value),
          submit,
          append,
        });
        if (!result.ok) return failed(session, result.error ?? 'Action failed', summary);
        await session.driver!.settle();
        const viewed = await observe(session, 'type', summary);
        if (version !== session.driver!.controlVersion)
          return failed(session, 'Human takeover interrupted typing. Look again; start a new routine.', summary);
        session.trail.push({
          kind: 'type',
          target: result.step?.kind === 'type' ? result.step.target : undefined,
          value: session.vars.redact(value) as string,
          submit,
          ...(append ? { append: true } : {}),
          at: locationKey(session.lastObservation!),
        });
        await arriveAtKnownScreen(session, before);
        if (replacement) viewed.content.unshift({ type: 'text', text: replacement.message });
        return viewed;
      },
    },
    {
      name: 'press',
      description: 'Press one key.',
      inputSchema: schema({ key: string }, ['key']),
      run: (input) => act(session, { kind: 'press', key: arg(input, 'key') }),
    },
    {
      name: 'scroll',
      description: 'Scroll one direction.',
      inputSchema: schema(
        {
          direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
          ref: string,
        },
        ['direction'],
      ),
      run(input) {
        const direction = input.direction as 'up' | 'down' | 'left' | 'right';
        return act(session, { kind: 'scroll', direction, ref: input.ref as string | undefined });
      },
    },
    {
      name: 'back',
      description: 'Go back.',
      inputSchema: schema({}),
      run: () => act(session, { kind: 'back' }),
    },
    {
      name: 'open',
      description: 'Open a URL or deep link; placeholders resolve only in the driver.',
      inputSchema: schema({ url: string }, ['url']),
      run(input) {
        const url = arg(input, 'url');
        return act(
          session,
          { kind: 'open', url: session.vars.resolve(url) },
          { kind: 'open', url: session.vars.redact(url) as string },
        );
      },
    },
    {
      name: 'wait',
      description: 'Wait up to ten seconds.',
      inputSchema: schema({ seconds: { type: 'number' } }, ['seconds']),
      run(input) {
        const ms = Math.min(10_000, Math.max(0, Number(input.seconds) * 1000));
        return act(session, { kind: 'wait', ms }, { kind: 'wait', ms });
      },
    },
    {
      name: 'record_screen',
      description: 'Record this screen and its routine in the app map.',
      inputSchema: schema({ id: string, name: string, description: string }, ['id', 'name', 'description']),
      async run(input) {
        const id = slug(arg(input, 'id'));
        const name = arg(input, 'name');
        const description = arg(input, 'description');
        await session.activity(`Recording ${name}`);
        await session.driver!.settle();
        const observation = await session.driver!.observe();
        const screenshot = await session.capture(observation, id);
        const findings = session.config.agents.checks.length
          ? await evaluateScreen(session, {
              screenId: id,
              observation,
              snapshot: session.driver!.snapshot(observation, id),
            })
          : [];
        const previous = session.lastScreenId;
        const edge = transition(session, id);
        const routineId = `screen-${id}`;
        await saveRoutine(session, routineId, description, id);
        await session.workspace.upsertScreen({
          id,
          name,
          description,
          platform: observation.platform,
          location: observation.location,
          screenKey: screenKey(observation),
          routineId,
          lastScreenshot: screenshot,
        });
        if (previous && previous !== id) {
          await session.workspace.upsertScreen({
            id: previous,
            links: [id],
            ...(edge ? { transitions: [edge] } : {}),
            visits: 0,
          });
        }
        session.lastScreenId = id;
        session.lastScreenLocation = screenKey(observation);
        session.lastScreenTrailIndex = session.trail.length;
        const screens = (await session.workspace.readAppMap())?.screens ?? [];
        const names = screens.map((screen) => screen.id).join(', ') || id;
        const found = !session.config.agents.checks.length
          ? ''
          : findings.length
            ? ` ${findings.length} automatic finding(s): ${findings.map((item) => item.summary).join('; ')}.`
            : ' No automatic findings.';
        const errors = errorLines(observation);
        session.emit({
          kind: 'screen',
          summary: `Recorded ${name}${findings.length ? ` (${findings.length} automatic finding(s))` : ''}`,
          screenId: id,
          screenshot,
        });
        return {
          ...text(
            session.vars.redact(
              `Recorded ${name}.${found} Known screens: ${names}${errors.length ? `\n${errors.join('\n')}` : ''}`,
            ) as string,
          ),
          meta: { summary: '', screenshot, screenId: id },
        };
      },
    },
    {
      name: 'save_routine',
      description: 'Save actions since the last anchor; use enter-app after sign-in or onboarding.',
      inputSchema: schema({ id: string, description: string }, ['id', 'description']),
      async run(input) {
        const id = slug(arg(input, 'id'));
        const { routine, flattenedFrom } = await saveRoutine(session, id, arg(input, 'description'));
        return text(
          `Saved ${routine.id} (requires ${routine.requires?.join(', ') || 'none'}, ${routine.steps.length} steps${flattenedFrom ? `, flattened from a chain of ${flattenedFrom}` : ''}).`,
        );
      },
    },
    {
      name: 'run_routine',
      description: 'Replay a known routine without model navigation.',
      inputSchema: schema({ id: string }, ['id']),
      async run(input) {
        const id = arg(input, 'id');
        const result = await replayRoutine(session, id, opts.replay);
        if (!result.ok) {
          return {
            ...text(`Routine ${id} failed at step ${result.failedStep ?? 'dependency'}: ${result.error}`),
            isError: true,
          };
        }
        session.anchor = { routineId: id, index: session.trail.length };
        await session.driver!.settle();
        return observe(session, `routine-${id}`, `Replayed the routine ${id}`);
      },
    },
    {
      name: 'report_bug',
      description:
        "Report a visible product bug for judge review. screen_id is the id you gave record_screen for the screen you are on, or 'unrecorded'. " +
        'Name how a replay can tell that the bug shows, with no one looking, in one or more of: shows (text on this ' +
        'screen only while the bug is there, like "NaN" or an error message), lacks (text that this screen should ' +
        'have and lacks), error (part of a console or network error that you saw). Bugpatrol checks each against ' +
        'this screen. Without them, a fix of the bug cannot be proven by a replay.',
      inputSchema: schema(
        {
          screen_id: string,
          title: string,
          what_is_wrong: string,
          expected: string,
          severity: { type: 'string', enum: ['cosmetic', 'minor', 'major', 'critical'] },
          shows: string,
          lacks: string,
          error: string,
        },
        ['screen_id', 'title', 'what_is_wrong', 'expected', 'severity'],
      ),
      async run(input) {
        const title = arg(input, 'title');
        if (!session.lastScreenshot || !session.lastObservation) {
          await session.capture(await session.driver!.observe(), 'reported-bug');
        }
        const bug: BugCheck = {};
        for (const key of ['shows', 'lacks', 'error'] as const) {
          const value = session.vars.redact(arg(input, key).trim()) as string;
          if (value) bug[key] = value;
        }
        const observation = session.lastObservation!;
        const misses = bugMisses(bug, observation, [
          ...observation.consoleErrors,
          ...(observation.networkErrors ?? []),
        ]);
        if (misses.length)
          return { ...text(`Not reported: ${misses.join(', and ')}. Fix or leave out that part.`), isError: true };
        const requested = arg(input, 'screen_id');
        const known = (await session.workspace.readAppMap())?.screens.some((screen) => screen.id === requested);
        const screenId = known ? requested : currentScreenId(session);
        const fallback = known ? '' : ` Used current screen as fallback for ${requested || 'missing screen_id'}.`;
        const candidate: Candidate = {
          id: `can_${shortHash(`${session.sessionId}:${title}:${randomUUID()}`)}`,
          sessionId: session.sessionId,
          screenId,
          source: 'explorer',
          fingerprint: fingerprint({
            screenId: screenId ?? 'unknown',
            ruleId: 'explorer',
            domNodeSignature: title.toLowerCase(),
          }),
          summary: session.vars.redact(title) as string,
          detail: session.vars.redact(`${arg(input, 'what_is_wrong')}\nExpected: ${arg(input, 'expected')}`) as string,
          severity: input.severity as Candidate['severity'],
          evidence: {
            screenshot: session.lastScreenshot,
            routineId: session.anchor.routineId,
            steps: session.trail.slice(session.anchor.index).map(({ at: _at, ...step }) => step as RoutineStep),
            ...(Object.keys(bug).length ? { bug } : {}),
          },
          route: { to: 'judge', reason: 'Explorer reported a visible bug' },
          createdAt: new Date().toISOString(),
        };
        const decided = (await session.workspace.readTriage()).fingerprints[candidate.fingerprint];
        if (decided?.decision === 'dismissed')
          return text(`Not reported: the QA lead dismissed this before (${decided.reason}). Continue.${fallback}`);
        if (decided?.decision === 'filed' && decided.issueId) {
          const issue = await session.workspace.readIssue(decided.issueId);
          if (issue && issue.status !== 'fixed' && issue.status !== 'dismissed') {
            await addOccurrence(session, issue.id);
            return text(`Already filed as ${issue.id}; counted one more occurrence.${fallback}`);
          }
        }
        await session.workspace.appendCandidate(session.sessionId, candidate);
        session.emit({ kind: 'candidate', summary: title, screenshot: session.lastScreenshot });
        return text(`Reported ${candidate.id}: ${title}.${fallback}`);
      },
    },
    {
      name: 'list_screens',
      description: 'List known screens and their routines.',
      inputSchema: schema({}),
      async run() {
        const screens = (await session.workspace.readAppMap())?.screens ?? [];
        const lines = screens.map((screen) => `${screen.id}: ${screen.name} (${screen.routineId ?? 'no routine'})`);
        return text(lines.join('\n') || '(none)');
      },
    },
    {
      name: 'finish',
      description: 'Finish exploring with a short summary.',
      inputSchema: schema({ summary: string }, ['summary']),
      async run(input) {
        return { ...text(arg(input, 'summary')), done: true };
      },
    },
  ];
  if (
    session.driver?.platform === 'web' ||
    session.driver?.platform === 'electron' ||
    session.driver?.platform === 'desktop'
  ) {
    tools.push({
      name: 'switch_window',
      description: 'Switch to a web or Electron window.',
      inputSchema: schema({ match: string }, ['match']),
      run: (input) => act(session, { kind: 'window', match: arg(input, 'match') }),
    });
  }
  tools.push(...lessonTools(session, 'explorer'));
  if (session.driver?.platform === 'desktop') return tools.filter((tool) => tool.name !== 'open');
  return session.driver?.platform === 'api' || session.driver?.platform === 'cli'
    ? tools.filter((tool) => !['tap', 'type', 'press', 'scroll', 'back', 'open'].includes(tool.name))
    : tools;
}
