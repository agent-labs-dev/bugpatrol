import type { AgentRole, RoleRuntime } from '@bugpatrol/core';
import { MODEL_KEYS } from '@bugpatrol/decide';
import type { Runtime } from '../types.js';
import { CliRuntime } from './cli.js';
import { ModelRuntime } from './model.js';
import { opencodeProblem } from './opencode.js';
import { commandProgram, isOpencode, onPath } from './program.js';

/** Selects the configured execution loop without changing the role's tool contract. */
export function createRuntime(use: RoleRuntime, opts: { fetch?: typeof fetch } = {}): Runtime {
  return use.runtime === 'model' ? new ModelRuntime(use, opts) : new CliRuntime(use);
}

/** Gives status displays a stable, short label for a configured runtime. */
export function describeRuntime(use: RoleRuntime): string {
  return use.runtime === 'model' ? `model:${use.via}/${use.model}` : `cli:${commandProgram(use.command) ?? 'shell'}`;
}

/**
 * Says what stops a role from reaching an LLM, before the app starts: a
 * missing key or a CLI that is not installed. Undefined means ready.
 */
export function runtimeProblem(
  role: AgentRole,
  use: RoleRuntime,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (use.runtime === 'model') {
    const key = MODEL_KEYS[use.via];
    if (!env[key])
      return `The ${role} uses ${use.via}, but ${key} is not set. Set it, or run the ${role} on a local agent CLI (use: claude).`;
    if (use.via === 'custom' && !use.endpoint) return `The ${role} uses a custom model, but it has no endpoint.`;
    return undefined;
  }
  const program = commandProgram(use.command);
  if (program && !onPath(program, env))
    return `The ${role} runs \`${program}\`, but it is not on PATH. Install it, or set agents.${role}.use.`;
  if (program && isOpencode(program)) return opencodeProblem(role, program, env);
  return undefined;
}

export { commandProgram, onPath } from './program.js';
export { CliRuntime, ModelRuntime };
