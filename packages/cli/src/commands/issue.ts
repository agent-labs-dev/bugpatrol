import { execFileSync } from 'node:child_process';
import { closeOnGitHub, dismissedFingerprints, Workspace } from '@bugpatrol/agents';
import { type BugpatrolConfig, ConfigError, fitLesson, type Issue } from '@bugpatrol/core';

/**
 * `bugpatrol issue list | dismiss <id> --reason "..." [--by name] | reopen <id>`
 *
 * The judge is a model, and a model is sometimes wrong. A human override is
 * the last word: a dismissed issue closes, and its fingerprints go into
 * triage.json, so the same finding does not come back on the next patrol.
 */
export async function runIssueCommand(
  args: string[],
  root: string,
  log: (line: string) => void,
  config?: BugpatrolConfig,
): Promise<void> {
  const [action, id, ...rest] = args;
  const workspace = new Workspace(root);

  if (action === 'list' || action === undefined) {
    const issues = await workspace.listIssues();
    const prs = new Map((await workspace.listFixes()).filter((fix) => fix.pr).map((fix) => [fix.issueId, fix.pr!]));
    for (const issue of issues.sort(bySeverity)) {
      const pr = prs.get(issue.id);
      const github = [issue.github && `#${issue.github.number}`, pr && `PR #${pr.number}`].filter(Boolean).join(' ');
      log(
        `${issue.id}  ${issue.severity.padEnd(8)} ${issue.status.padEnd(12)} x${String(issue.occurrences).padEnd(3)} ${github.padEnd(15)} ${issue.title}`,
      );
    }
    if (issues.length === 0) log('No issues. Run `bugpatrol explore`, then `bugpatrol judge`.');
    else
      log(
        `\n${issues.length} issue(s). Status: new = filed by the judge, not on GitHub; filed = on GitHub; ` +
          'fix-proposed = a fix waits for review; fixed; dismissed.',
      );
    return;
  }

  if (!id) throw new ConfigError(`bugpatrol issue ${action} needs an issue id`);
  const issue = await workspace.readIssue(id);
  if (!issue) throw new ConfigError(`No issue ${id}. Run \`bugpatrol issue list\`.`);

  if (action === 'dismiss') {
    const reason = flagValue(rest, '--reason');
    if (!reason) throw new ConfigError('bugpatrol issue dismiss needs --reason "why this is not a problem"');
    const by = flagValue(rest, '--by') ?? author();
    const at = new Date().toISOString();
    const dismissed: Issue = { ...issue, status: 'dismissed', closedBy: { by, reason, at } };
    await workspace.saveIssue(dismissed);
    if (config) await closeOnGitHub(root, config, dismissed, undefined, log);
    await workspace.recordTriage(await dismissedFingerprints(workspace, issue, reason, at));
    await workspace.upsertLessons([
      {
        role: 'judge',
        source: 'human',
        scope: issue.screenId,
        text: fitLesson(`Not a bug: ${issue.title}: ${reason}`),
      },
    ]);
    log(`Dismissed ${issue.id}: ${issue.title}`);
    return;
  }

  if (action === 'reopen') {
    await workspace.saveIssue({ ...issue, status: 'new', closedBy: undefined, publishSkipped: undefined });
    log(`Reopened ${issue.id}. Its fingerprints stay in triage.json until the judge files it again.`);
    return;
  }

  throw new ConfigError(`Unknown issue action: ${action}. Use list, dismiss or reopen.`);
}

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function author(): string {
  try {
    return execFileSync('git', ['config', 'user.name'], { encoding: 'utf8' }).trim() || 'human';
  } catch {
    return process.env.USER ?? 'human';
  }
}

const RANK: Record<Issue['severity'], number> = { critical: 0, major: 1, minor: 2, cosmetic: 3 };

function bySeverity(a: Issue, b: Issue): number {
  return RANK[a.severity] - RANK[b.severity] || b.lastSeenAt.localeCompare(a.lastSeenAt);
}
