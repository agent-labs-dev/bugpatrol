import { judgePrompt, judgeSystem } from '../prompts.js';
import type { AgentSession } from '../session.js';
import { judgeTools, pendingCandidates } from '../tools/judge.js';
import type { RoleOutcome, Runtime } from '../types.js';
import { lessonsFor } from '../workspace.js';

/** Reviews unresolved candidates so only confirmed problems become issues. */
export async function runJudge(
  session: AgentSession,
  runtime: Runtime,
  opts: { sessionIds: string[] },
): Promise<RoleOutcome> {
  const candidates = await pendingCandidates(session, opts.sessionIds);
  const issues = await session.workspace.listIssues();
  const config = session.config.agents.judge;
  await session.activity(`Judging ${candidates.length} candidates`, 0, runtime.label);
  session.emit({ kind: 'session-start', summary: `Judging ${candidates.length} candidates` });
  try {
    const task = {
      role: 'judge' as const,
      sessionId: session.sessionId,
      system: judgeSystem(lessonsFor(await session.workspace.readMemory(), 'judge'), session.config.app.platform),
      prompt: judgePrompt(opts.sessionIds, candidates, issues),
      tools: judgeTools(session, opts.sessionIds, runtime.label),
      // Each candidate needs a look and a decision, so a big session must not
      // run out of steps halfway and leave candidates undecided.
      maxSteps: Math.max(config.maxSteps, candidates.length * 2 + 10),
      budgetUsd: config.budgetUsd,
      timeoutMs: config.timeoutMs,
    };
    const outcome = candidates.length
      ? await runtime.run(task, session.emit)
      : {
          stop: 'done' as const,
          steps: 0,
          costUsd: 0,
          summary: 'No candidates to judge',
        };
    const after = await session.workspace.listIssues();
    const newIssues = after.filter((item) => !issues.some((before) => before.id === item.id));
    await session.workspace.endSession(session.sessionId, {
      status: outcome.stop === 'error' ? 'failed' : 'finished',
      steps: outcome.steps,
      costUsd: outcome.costUsd,
      summary: outcome.summary,
      issues: newIssues.map((item) => item.id),
    });
    session.emit({ kind: 'session-end', summary: outcome.summary ?? `Judge stopped: ${outcome.stop}` });
    await session.idle(outcome.costUsd);
    return outcome;
  } catch (error) {
    await session.workspace.endSession(session.sessionId, { status: 'failed', summary: String(error) });
    await session.idle();
    throw error;
  }
}
