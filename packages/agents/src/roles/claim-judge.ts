import type { PrReview } from '@bugpatrol/core';
import { createRuntime as makeRuntime } from '../runtime/index.js';
import { AgentSession } from '../session.js';
import type { Tool } from '../types.js';
import { Vars } from '../vars.js';
import type { ReviewContext } from './review.js';

/**
 * One judge session of the claim check, with no driver: it writes or
 * classifies the claims, picks the benchmarks, or gives the verdicts. The
 * tools hold what it decides. A runtime that throws fails the review.
 */
export async function claimJudge(
  ctx: ReviewContext,
  review: PrReview,
  task: {
    session: 'claims' | 'claimJudge' | 'benches';
    start: string;
    system: string;
    prompt: string;
    tools: Tool[];
    /** The steps that the tools need at least, one for each claim and the finish. */
    minSteps?: number;
    summary: () => string;
  },
): Promise<void> {
  const { root, config, workspace, opts } = ctx;
  const record = await workspace.startSession('judge');
  review.sessions[task.session] = record.id;
  const session = new AgentSession(root, config, new Vars(config.app.secrets), record.id, 'judge', undefined, ctx.log);
  opts.onSession?.(session);
  const runtime = (opts.createRuntime ?? makeRuntime)(config.agents.judge.use);
  const limits = config.agents.review;
  let cost = 0;
  let steps = 0;
  let status: 'finished' | 'failed' = 'finished';
  await session.activity(task.start, 0, runtime.label);
  session.emit({ kind: 'session-start', summary: task.start });
  try {
    const outcome = await runtime.run(
      {
        role: 'judge',
        sessionId: record.id,
        system: task.system,
        prompt: task.prompt,
        tools: task.tools,
        maxSteps: Math.max(limits.maxSteps, task.minSteps ?? 0),
        budgetUsd: limits.budgetUsd,
        timeoutMs: limits.timeoutMs,
      },
      session.emit,
    );
    cost = outcome.costUsd;
    steps = outcome.steps;
  } catch (error) {
    status = 'failed';
    throw error;
  } finally {
    review.costUsd += cost;
    const summary = task.summary();
    await workspace.endSession(record.id, { status, summary, steps, costUsd: cost });
    session.emit({ kind: 'session-end', summary });
    await session.idle(cost);
    opts.onSession?.();
  }
}
