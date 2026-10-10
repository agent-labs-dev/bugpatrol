import { noGuide, readGuide } from '../guide.js';
import { explorerPrompt, explorerSystem } from '../prompts.js';
import type { AgentSession } from '../session.js';
import { explorerTools } from '../tools/explorer.js';
import type { RoleOutcome, Runtime, Tool } from '../types.js';
import { lessonsFor } from '../workspace.js';
import { reflectOnSession } from './reflect.js';

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
function sessionSummary(outcome: RoleOutcome, screens: number, candidates: number): string {
  // The counts come from the files, not from the model: its own count can be wrong.
  const counts = `${screens} screen(s) known, ${candidates} candidate(s) raised in ${outcome.steps} steps.`;
  if (outcome.stop === 'done' && outcome.summary) return `${outcome.summary.trim()}\n${counts}`;
  if (outcome.stop === 'error') {
    const cause = (outcome.error ?? outcome.summary ?? '').trim().replace(/\s+/g, ' ');
    if (cause)
      return `The explorer stopped on an error: ${cause.slice(0, 300)}${cause.length > 300 ? '…' : ''}. ${counts}`;
  }
  return `The explorer ${STOP_REASONS[outcome.stop]}. ${counts}`;
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
    outcome.summary = sessionSummary(outcome, screens.length, candidates.length);
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
