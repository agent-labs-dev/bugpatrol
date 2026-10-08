import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { type BugpatrolConfig, ConfigError, type Routine } from '@bugpatrol/core';
import { defaultGh, type Gh } from '../github.js';
import { Workspace } from '../workspace.js';

/**
 * Keeps proven claim routines of a merged pull request as committed routines,
 * named `pr-<n>-<claim>`, so the patrol replays them from then on. Only an
 * explicit run does this: a review never writes to the committed routines.
 * It checks every claim before it writes, so a refusal keeps nothing.
 */
export async function promoteClaims(
  root: string,
  config: BugpatrolConfig,
  number: number,
  claimIds: string[],
  opts: { gh?: Gh } = {},
): Promise<Routine[]> {
  const gh = opts.gh ?? defaultGh;
  const workspace = new Workspace(root);
  const review = await workspace.readReview(number);
  if (!review?.claims)
    throw new ConfigError(`No claim check of PR #${number}. Run \`bugpatrol review ${number} --claims\` first.`);
  const chosen = claimIds.map((id) => {
    const finding = review.claims!.find((item) => item.claim.id === id);
    if (!finding)
      throw new ConfigError(
        `PR #${number} has no ${id}. Its claims: ${review.claims!.map((item) => item.claim.id).join(', ')}.`,
      );
    if (finding.verdict !== 'proven')
      throw new ConfigError(`${id} is ${finding.verdict}. Only a proven claim becomes a routine.`);
    if (!finding.routine)
      throw new ConfigError(`${id} has no claim routine: the explorer checked it, and no replay proved it.`);
    return finding;
  });
  const repo = config.agents.github.repo ? ['--repo', config.agents.github.repo] : [];
  const source = resolve(root, config.app.source);
  const state = await gh(['pr', 'view', String(number), ...repo, '--json', 'state', '-q', '.state'], { cwd: source });
  if (state.trim() !== 'MERGED')
    throw new ConfigError(
      `PR #${number} is not merged (${state.trim().toLowerCase() || 'unknown'}). Promote its claims after the merge.`,
    );
  const now = new Date().toISOString();
  const routines: Routine[] = [];
  for (const finding of chosen) {
    let saved: Routine;
    try {
      saved = JSON.parse(await readFile(resolve(root, finding.routine!), 'utf8')) as Routine;
    } catch {
      throw new ConfigError(
        `The routine of ${finding.claim.id} is gone from ${finding.routine}. Run \`bugpatrol review ${number} --claims --force\` again.`,
      );
    }
    routines.push({
      version: 1,
      id: `pr-${number}-${finding.claim.id}`,
      description: finding.claim.text,
      platform: saved.platform,
      steps: saved.steps,
      createdAt: now,
      updatedAt: now,
    });
  }
  for (const routine of routines) await workspace.saveRoutine(routine);
  return routines;
}
