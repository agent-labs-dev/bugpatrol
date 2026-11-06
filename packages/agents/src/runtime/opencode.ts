import { execFileSync } from 'node:child_process';
import type { AgentRole } from '@bugpatrol/core';
import { commandProgram, onPath } from './program.js';

/**
 * The presets target opencode 1.x. 2.x (`@opencode/cli`, checked on 2.0.31
 * and 2.2.5) rejects `--pure`, and the first turn of `opencode run` does not
 * see MCP tools: they register after the session takes its tool snapshot.
 * So when the installed opencode is 2.x, a role runs this pinned 1.x instead.
 * npm 12 blocks install scripts unless allowed, and opencode-ai links its
 * platform binary in one. Retire the fallback when a 2.x preset reaches the
 * Bugpatrol tools on its first turn.
 */
export const OPENCODE_1 = 'npx -y --allow-scripts=opencode-ai opencode-ai@1';

/** The installed opencode's version, or undefined when `--version` fails. */
function installedVersion(program: string, env: NodeJS.ProcessEnv): string | undefined {
  try {
    return execFileSync(program, ['--version'], { env, timeout: 5000, encoding: 'utf8' }).trim();
  } catch {
    return undefined;
  }
}

/** The semver and major of a version line, such as `opencode v2.2.5`. */
function parse(version: string): { semver?: string; major?: number } {
  const match = version.match(/(\d+)\.\d+\.\d+/);
  return { semver: match?.[0], major: match ? Number(match[1]) : undefined };
}

/** Says why the installed opencode cannot run a role, or undefined when it can. */
export function opencodeProblem(role: AgentRole, program: string, env: NodeJS.ProcessEnv): string | undefined {
  const version = installedVersion(program, env);
  if (version === undefined)
    return `The ${role} runs opencode, but \`${program} --version\` failed, so Bugpatrol cannot tell which opencode this is.`;
  const { semver, major } = parse(version);
  if (major === 1) return undefined;
  if (major !== undefined && major > 1 && onPath('npx', env)) return undefined;
  const fallback =
    major !== undefined && major > 1
      ? ', and npx is not on PATH to run 1.x beside it. Install Node.js with npx, or'
      : '.';
  return `The ${role} runs opencode ${semver ?? `"${version}"`}, but Bugpatrol supports only opencode 1.x${fallback} Install it with \`npm i -g opencode-ai@1\`, or set agents.${role}.use.`;
}

/**
 * The command to run: unchanged on opencode 1.x, and with the program
 * replaced by the pinned 1.x when the installed one is newer. The note says so.
 */
export function opencodeCommand(command: string, env: NodeJS.ProcessEnv): { command: string; note?: string } {
  const program = commandProgram(command);
  if (!program) return { command };
  const version = installedVersion(program, env);
  const { semver, major } = parse(version ?? '');
  if (major === undefined || major <= 1) return { command };
  const at = command.search(new RegExp(`(^|\\s)${program.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`));
  const start = command.indexOf(program, at);
  return {
    command: command.slice(0, start) + OPENCODE_1 + command.slice(start + program.length),
    note: `opencode ${semver} is installed, and Bugpatrol supports only 1.x, so it runs opencode 1.x through \`${OPENCODE_1}\`.`,
  };
}
