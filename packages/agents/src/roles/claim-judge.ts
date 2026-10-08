import type { PrReview } from '@bugpatrol/core';
import { createRuntime as makeRuntime } from '../runtime/index.js';
import { AgentSession } from '../session.js';
import type { Tool } from '../types.js';
import { Vars } from '../vars.js';
import type { ReviewContext } from './review.js';

type Limits = { maxSteps: number; budgetUsd?: number; timeoutMs: number };

const reached = (limit: string) => `The claim check reached ${limit} before it finished this claim.`;

const duration = (ms: number) =>
  ms % 60_000 === 0 ? `${ms / 60_000} minutes` : ms % 1000 === 0 ? `${ms / 1000} seconds` : `${ms} ms`;

/**
 * The limits of one claim check, `agents.review`, across all its sessions:
 * the judges, the claim work of the explorer, the replays and the
 * benchmarks. Each session gets what is left. The time counts only while
 * claim work runs, so the explorer's hunt for bugs does not use it.
 */
export class ClaimBudget {
  private steps = 0;
  private cost = 0;
  private ms = 0;
  private since: number | undefined;
  private depth = 0;

  constructor(private readonly limits: Limits) {}

  /** What the next session may use. */
  left(): Limits {
    const { maxSteps, budgetUsd, timeoutMs } = this.limits;
    return {
      maxSteps: Math.max(0, maxSteps - this.steps),
      ...(budgetUsd === undefined ? {} : { budgetUsd: Math.max(0, budgetUsd - this.cost) }),
      timeoutMs: Math.max(0, timeoutMs - this.elapsed()),
    };
  }

  spend(used: { steps?: number; costUsd?: number }): void {
    this.steps += used.steps ?? 0;
    this.cost += used.costUsd ?? 0;
  }

  /** Starts the clock. A clock that runs already keeps running, so nested claim work counts once. */
  start(): void {
    if (this.depth++ === 0) this.since = Date.now();
  }

  stop(): void {
    if (--this.depth > 0 || this.since === undefined) return;
    this.ms += Date.now() - this.since;
    this.since = undefined;
  }

  /** Runs claim work on the clock. */
  async timed<T>(run: () => Promise<T>): Promise<T> {
    this.start();
    try {
      return await run();
    } finally {
      this.stop();
    }
  }

  private elapsed(): number {
    return this.ms + (this.since === undefined ? 0 : Date.now() - this.since);
  }

  /** Why no model may work on the claim check any more, or undefined while some of each limit is left. */
  get spent(): string | undefined {
    const { maxSteps, budgetUsd } = this.limits;
    if (this.steps >= maxSteps) return reached(`its limit of ${maxSteps} model steps (agents.review.maxSteps)`);
    if (budgetUsd !== undefined && this.cost >= budgetUsd)
      return reached(`its cost limit of $${budgetUsd.toFixed(2)} (agents.review.budgetUsd)`);
    return this.late;
  }

  /** Why no replay or benchmark may run any more. They use no model, so only the time limit stops them. */
  get late(): string | undefined {
    const { timeoutMs } = this.limits;
    return this.elapsed() >= timeoutMs
      ? reached(`its time limit of ${duration(timeoutMs)} (agents.review.timeoutMs)`)
      : undefined;
  }
}

/**
 * One judge session of the claim check, with no driver: it writes or
 * classifies the claims, picks the benchmarks, or gives the verdicts. The
 * tools hold what it decides. It gets what is left of the limits of the
 * claim check, and does not start when nothing is left. A runtime that
 * throws fails the review.
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
    summary: () => string;
  },
): Promise<void> {
  const { root, config, workspace, opts, budget } = ctx;
  if (budget.spent) {
    ctx.log(`${task.start}: skipped. ${budget.spent}`);
    return;
  }
  const record = await workspace.startSession('judge');
  review.sessions[task.session] = record.id;
  const session = new AgentSession(root, config, new Vars(config.app.secrets), record.id, 'judge', undefined, ctx.log);
  opts.onSession?.(session);
  const runtime = (opts.createRuntime ?? makeRuntime)(config.agents.judge.use);
  let cost = 0;
  let steps = 0;
  let status: 'finished' | 'failed' = 'finished';
  await session.activity(task.start, 0, runtime.label);
  session.emit({ kind: 'session-start', summary: task.start });
  try {
    const outcome = await budget.timed(() =>
      runtime.run(
        {
          role: 'judge',
          sessionId: record.id,
          system: task.system,
          prompt: task.prompt,
          tools: task.tools,
          ...budget.left(),
        },
        session.emit,
      ),
    );
    cost = outcome.costUsd;
    steps = outcome.steps;
  } catch (error) {
    status = 'failed';
    throw error;
  } finally {
    budget.spend({ steps, costUsd: cost });
    review.costUsd += cost;
    const summary = task.summary();
    await workspace.endSession(record.id, { status, summary, steps, costUsd: cost });
    session.emit({ kind: 'session-end', summary });
    await session.idle(cost);
    opts.onSession?.();
  }
}
