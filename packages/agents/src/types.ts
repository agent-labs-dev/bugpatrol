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
   * `screenshot` links the step to what the app looked like after it.
   */
  meta?: { summary?: string; screenshot?: string; screenId?: string };
};

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
