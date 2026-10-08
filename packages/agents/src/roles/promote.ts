import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { type BugpatrolConfig, ConfigError, type Routine } from '@bugpatrol/core';
import { defaultGh, type Gh } from '../github.js';
import { short } from '../review-comment.js';
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
  const merged = JSON.parse(
    await gh(['pr', 'view', String(number), ...repo, '--json', 'state,headRefOid'], { cwd: source }),
  ) as { state: string; headRefOid: string };
  if (merged.state !== 'MERGED')
    throw new ConfigError(
      `PR #${number} is not merged (${merged.state.toLowerCase() || 'unknown'}). Promote its claims after the merge.`,
    );
  // A proof of an older commit says nothing about the code that merged.
  if (merged.headRefOid !== review.head)
    throw new ConfigError(
      `The review of PR #${number} tested ${short(review.head)}, and the pull request merged ${short(merged.headRefOid)}. ` +
        `Run \`bugpatrol review ${number} --claims --force\`, then promote again.`,
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
      // The checks decide the verdict of a replay, so the patrol needs them too.
      ...(saved.assert ? { assert: saved.assert } : {}),
      ...(saved.same ? { same: saved.same } : {}),
      ...(saved.bug ? { bug: saved.bug } : {}),
      createdAt: now,
      updatedAt: now,
    });
  }
  for (const routine of routines) await workspace.saveRoutine(routine);
  return routines;
}
