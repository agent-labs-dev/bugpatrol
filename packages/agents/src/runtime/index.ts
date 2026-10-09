import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { AgentRole, RoleRuntime } from '@bugpatrol/core';
import { MODEL_KEYS } from '@bugpatrol/decide';
import type { Runtime } from '../types.js';
import { CliRuntime } from './cli.js';
import { ModelRuntime } from './model.js';

/** Selects the configured execution loop without changing the role's tool contract. */
export function createRuntime(use: RoleRuntime, opts: { fetch?: typeof fetch } = {}): Runtime {
  return use.runtime === 'model' ? new ModelRuntime(use, opts) : new CliRuntime(use);
}

/** Gives status displays a stable, short label for a configured runtime. */
export function describeRuntime(use: RoleRuntime): string {
  return use.runtime === 'model' ? `model:${use.via}/${use.model}` : `cli:${commandProgram(use.command) ?? 'shell'}`;
}

/** The first word of a shell command that names a program, past any `NAME=value`. */
export function commandProgram(command: string): string | undefined {
  return command
    .trim()
    .split(/\s+/)
    .find((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
}

export function onPath(program: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const candidates = program.includes('/')
    ? [program]
    : (env.PATH ?? '').split(delimiter).map((dir) => join(dir, program));
  return candidates.some((file) => {
    try {
      accessSync(file, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
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
  return undefined;
}

export { CliRuntime, ModelRuntime };
