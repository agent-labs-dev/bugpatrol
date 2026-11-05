import type { AgentEvent, AgentRole, RoleRuntime } from '@bugpatrol/core';

/**
 * A tool is the contract between a role and its runtime (ADR 0005). The model
 * loop calls `run` in-process; the CLI runtime exposes the same tool over MCP.
 * So a role behaves the same whatever runs it.
 */
export type ToolContent = { type: 'text'; text: string } | { type: 'image'; png: Buffer };

export type ToolResult = {
  content: ToolContent[];
  isError?: boolean;
  /** Set by `finish`-style tools: the runtime stops after this result. */
  done?: boolean;
  /**
   * What the activity feed shows for this call. The text content is written
   * for the model and is long; `summary` is one sentence for a human, and
   * `capture` links the step to what the app showed after it: a screenshot,
   * or the exchange file of an API.
   */
  meta?: { summary?: string; capture?: string; screenId?: string };
};

/**
 * The tools an agent may call after its steps are used, and that use no step:
 * it hands back with finish, and reports a bug it found but had no step left
 * for, so the finding is not lost in the finish text.
 */
export function handsBack(name: string): boolean {
  return name.startsWith('finish') || name === 'report_bug';
}

/**
 * The step budget, enforced where tools are called so that no runtime can go
 * over it. A call to any tool but a hand-back one uses a step; once all are
 * used, it is refused and runs nothing.
 */
export function useStep(name: string, tools: Tool[], budget: { steps: number; max: number }): ToolResult | undefined {
  if (handsBack(name)) return undefined;
  if (budget.steps < budget.max) {
    budget.steps++;
    return undefined;
  }
  const text = tools.some((tool) => tool.name === 'report_bug')
    ? 'The step budget is used. Report each bug that you found and did not report yet with report_bug, then call finish.'
    : 'The step budget is used. Call finish now.';
  return { content: [{ type: 'text', text }], isError: true };
}

export type Tool = {
  name: string;
  description: string;
  /** JSON Schema for the input object. */
  inputSchema: Record<string, unknown>;
  run(input: Record<string, unknown>): Promise<ToolResult>;
};

export type RoleTask = {
  role: AgentRole;
  sessionId: string;
  /** Stable instructions: who the agent is, the rules, the app guide. */
  system: string;
  /** This session's goal and the current knowledge. */
  prompt: string;
  tools: Tool[];
  maxSteps: number;
  /** No limit when it is not set. */
  budgetUsd?: number;
  timeoutMs: number;
  /** The working directory for a CLI runtime. Default: the workspace root. */
  workdir?: string;
};

export type RoleOutcome = {
  /** `done`: a finish tool ran. The others say why the runtime stopped. */
  stop: 'done' | 'max-steps' | 'budget' | 'timeout' | 'error';
  steps: number;
  costUsd: number;
  /** The last text the agent wrote, or the finish tool's summary. */
  summary?: string;
  /** A finish tool ran, also after the steps were used: `summary` is its text. */
  finished?: boolean;
  error?: string;
};

export type EventSink = (event: Omit<AgentEvent, 'at' | 'sessionId' | 'role'>) => void;

/** `model` and `cli` both implement this. */
export interface Runtime {
  readonly label: string;
  run(task: RoleTask, emit: EventSink): Promise<RoleOutcome>;
}

export type RuntimeFactory = (use: RoleRuntime) => Runtime;
