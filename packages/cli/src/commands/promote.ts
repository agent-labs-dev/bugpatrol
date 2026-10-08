import { promoteClaims } from '@bugpatrol/agents';
import { type BugpatrolConfig, ConfigError } from '@bugpatrol/core';

/** `promote <pr> <claim>...`: the pull request as a number or a URL, then the claim ids. */
export function parsePromoteArgs(args: string[]): { pr: number; claims: string[] } {
  const [target, ...claims] = args;
  const pr = Number(/^(?:.*\/pull\/)?(\d+)\/?$/.exec(target ?? '')?.[1]);
  if (!Number.isInteger(pr) || pr < 1) throw new ConfigError('promote needs a pull request number or URL');
  const flag = claims.find((claim) => claim.startsWith('-'));
  if (flag) throw new ConfigError(`Unknown flag for promote: ${flag}`);
  if (!claims.length) throw new ConfigError('promote needs at least one claim id, for example claim-1');
  return { pr, claims };
}

export async function runPromoteCommand(
  args: string[],
  root: string,
  config: BugpatrolConfig,
  log: (line: string) => void,
): Promise<void> {
  const { pr, claims } = parsePromoteArgs(args);
  const routines = await promoteClaims(root, config, pr, claims);
  for (const routine of routines) log(`  ${routine.id}  ${routine.description}`);
  log(`Kept ${routines.length} routine(s) in .bugpatrol/routines/. Commit them, and the patrol replays them.`);
}
