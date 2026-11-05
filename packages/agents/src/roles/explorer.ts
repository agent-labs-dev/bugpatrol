import type { Endpoint } from '@bugpatrol/core';
import { ApiDriver } from '@bugpatrol/drivers';
import { rankForExplorer } from '../coverage.js';
import { noGuide, readGuide } from '../guide.js';
import { explorerPrompt, explorerSystem } from '../prompts.js';
import type { AgentSession } from '../session.js';
import { BLOCKED, explorerTools } from '../tools/explorer.js';
import type { RoleOutcome, Runtime, Tool } from '../types.js';
import { lessonsFor } from '../workspace.js';
import { reflectOnSession } from './reflect.js';

/** How many endpoints an api explorer gets to test first in one run. */
const ENDPOINTS_PER_RUN = 10;

const STOP_REASONS: Record<RoleOutcome['stop'], string> = {
  done: 'finished',
  'max-steps': 'used all its steps',
  budget: 'reached its budget',
  timeout: 'reached its time limit',
  error: 'stopped on an error',
};

/**
 * The finish tool's text when the explorer wrote one. Otherwise a sentence
 * Bugpatrol writes itself: the model's last thought at a step limit is a note to
 * itself ("I'll open Settings next"), not a summary of the session.
 */
function sessionSummary(outcome: RoleOutcome, screens: number | undefined, candidates: number): string {
  // The counts come from the files, not from the model: its own count can be wrong. An API has no screens.
  const known = screens === undefined ? '' : `${screens} screen(s) known, `;
  const counts = `${known}${candidates} candidate(s) raised in ${outcome.steps} steps.`;
  if (outcome.stop === 'done' && outcome.summary) return `${outcome.summary.trim()}\n${counts}`;
  if (outcome.stop === 'error') {
    const cause = (outcome.error ?? outcome.summary ?? '').trim().replace(/\s+/g, ' ');
    if (cause)
      return `The explorer stopped on an error: ${cause.slice(0, 300)}${cause.length > 300 ? '…' : ''}. ${counts}`;
  }
  return `The explorer ${STOP_REASONS[outcome.stop]}. ${counts}`;
}

/** Path segments that name no resource: a version, or the API itself. */
const GENERIC_SEGMENT = /^(?:api|v\d+(?:\.\d+)?|rest|public|internal)$/i;
const stem = (word: string) => word.toLowerCase().replace(/(?:ies|es|s)$/, '');

/**
 * The endpoints that a goal names, in the order of `endpoints`. A goal with
 * paths, such as `/v1/runs/*`, names the endpoints under them. A goal without
 * paths names the endpoints whose path has a word of the goal, such as "runs"
 * for "the run APIs".
 */
function goalEndpoints(goal: string, endpoints: Endpoint[]): Endpoint[] {
  const shape = (path: string) => path.replace(/\{[^}]*\}/g, '{}').replace(/\/+$/, '');
  const prefixes = [...goal.matchAll(/(?:\/[\w.{}~-]+)+/g)].map((match) => shape(match[0]));
  if (prefixes.length)
    return endpoints.filter((endpoint) => {
      const path = shape(endpoint.template);
      return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
    });
  const words = new Set((goal.match(/[a-z][a-z0-9]{2,}/gi) ?? []).map(stem));
  return endpoints.filter((endpoint) =>
    endpoint.template
      .split(/[/_-]/)
      .some(
        (segment) => segment && !segment.startsWith('{') && !GENERIC_SEGMENT.test(segment) && words.has(stem(segment)),
      ),
  );
}

/**
 * The goal's endpoints that got no request in the session, as a line of the
 * summary. A run that spent its steps elsewhere did not meet its goal, and the
 * summary must not read as a clean pass.
 */
function goalGap(session: AgentSession, api: ApiDriver, goal: Endpoint[]): string | undefined {
  const { contract } = api.policy;
  const reached = new Set(
    session.trail.flatMap((step) => (step.kind === 'request' ? [contract.match(step.method, step.url)?.key] : [])),
  );
  const missed = goal.filter((endpoint) => !reached.has(endpoint.key));
  if (!missed.length) return undefined;
  return `Goal not met: ${missed.length} of the ${goal.length} endpoint(s) that the goal names got no request: ${missed.map((endpoint) => endpoint.key).join(', ')}.`;
}

/** Whether the explorer finished saying it could not test the app at all. */
export function wasBlocked(outcome: RoleOutcome): boolean {
  return outcome.stop === 'done' && (outcome.summary ?? '').startsWith(BLOCKED);
}

export function stopOnCancellation(session: AgentSession, tool: Tool): Tool {
  return {
    ...tool,
    async run(input) {
      const result = await tool.run(input);
      return session.cancelled ? { ...result, done: true } : result;
    },
  };
}

/** Runs the app-facing role with its shared QA instructions and current map. */
export async function runExplorer(
  session: AgentSession,
  runtime: Runtime,
  opts: { goal?: string; maxSteps?: number } = {},
): Promise<RoleOutcome> {
  const config = session.config.agents.explorer;
  const map = await session.workspace.readAppMap();
  const routines = await session.workspace.listRoutines();
  const guide = await readGuide(session.root, session.config);
  if (guide.text === undefined) session.emit({ kind: 'setup', summary: noGuide(session.root, guide) });
  const api = session.driver instanceof ApiDriver ? session.driver : undefined;
  const ranked = api
    ? rankForExplorer(await session.workspace.readCoverage(), api.policy, Infinity, {
        crossUser: api.credentialSets.includes('other'),
      })
    : undefined;
  // The goal names what this run is for, so its endpoints come before the coverage order.
  const goal =
    ranked && opts.goal
      ? goalEndpoints(
          opts.goal,
          ranked.map((item) => item.endpoint),
        )
      : [];
  const endpoints = ranked
    ? [
        ...goal.map((endpoint) => ({ endpoint, reason: 'named by the goal' })),
        ...ranked.filter((item) => !goal.includes(item.endpoint)),
      ].slice(0, Math.max(ENDPOINTS_PER_RUN, goal.length))
    : undefined;
  const task = {
    role: 'explorer' as const,
    sessionId: session.sessionId,
    system: explorerSystem(
      session.config.app.platform,
      guide.text ?? '',
      lessonsFor(await session.workspace.readMemory(), 'explorer'),
      session.config.agents.checks,
    ),
    prompt: explorerPrompt({
      goal: opts.goal,
      screens: map?.screens ?? [],
      routines,
      placeholders: session.vars.names(),
      maxSteps: opts.maxSteps ?? config.maxSteps,
      endpoints,
    }),
    tools: explorerTools(session).map((tool) => stopOnCancellation(session, tool)),
    maxSteps: opts.maxSteps ?? config.maxSteps,
    budgetUsd: config.budgetUsd,
    timeoutMs: config.timeoutMs,
  };
  await session.activity('Exploring the app', 0, runtime.label);
  session.emit({ kind: 'session-start', summary: 'Explorer started' });
  try {
    const outcome = await runtime.run(task, session.emit);
    const candidates = await session.workspace.readCandidates(session.sessionId);
    const screens = (await session.workspace.readAppMap())?.screens ?? [];
    outcome.summary = sessionSummary(outcome, api ? undefined : screens.length, candidates.length);
    const gap = api && goalGap(session, api, goal);
    if (gap) outcome.summary = `${outcome.summary}\n${gap}`;
    await session.workspace.endSession(session.sessionId, {
      status: outcome.stop === 'error' ? 'failed' : 'finished',
      steps: outcome.steps,
      costUsd: outcome.costUsd,
      summary: outcome.summary,
      candidates: candidates.length,
      screensFound: screens.map((item) => item.id),
    });
    session.emit({ kind: 'session-end', summary: outcome.summary ?? `Explorer stopped: ${outcome.stop}` });
    await session.idle(outcome.costUsd);
    const learned = await reflectOnSession(session.root, session.config, session.sessionId, {
      vars: session.vars,
      onLog: (message) => session.emit({ kind: 'error', summary: message }),
    });
    if (learned) session.emit({ kind: 'lesson', summary: `Saved ${learned} lesson(s) for the next sessions` });
    return outcome;
  } catch (error) {
    await session.workspace.endSession(session.sessionId, { status: 'failed', summary: String(error) });
    await session.idle();
    throw error;
  }
}
