import { type Candidate, type FixProposal, type Issue, judgedRetests } from '@bugpatrol/core';

export type ReportInput = {
  kind: 'pr' | 'issue';
  summary: string;
  issue: Issue;
  candidates: Candidate[];
  fix?: FixProposal;
  imageUrl: (workspacePath: string) => string | undefined;
  redact: (text: string) => string;
  closes?: number;
};

/** Full GitHub report. The caller owns image upload; this function only formats text. */
export function buildReport(input: ReportInput): string {
  const { issue, fix, kind, imageUrl } = input;
  const image = (path?: string, width = 320) =>
    path && imageUrl(path) ? `<img src="${imageUrl(path)}" width="${width}">` : '';
  const screens = [
    { screenId: issue.screenId, path: issue.evidence.screenshot },
    ...input.candidates.map((candidate) => ({ screenId: candidate.screenId, path: candidate.evidence.screenshot })),
  ];
  const seenScreens = new Set<string>();
  const seenPaths = new Set<string>();
  const shots = screens
    .flatMap(({ screenId, path }) => {
      if (!path || (screenId && seenScreens.has(screenId)) || seenPaths.has(path)) return [];
      if (screenId) seenScreens.add(screenId);
      seenPaths.add(path);
      const tag = image(path);
      return tag ? [`**${screenId ?? 'Other screen'}**\n\n${tag}`] : [];
    })
    .slice(0, 6);
  // The judge writes the issue body with its own "## What happened" heading;
  // keep one, and put the body's other parts one level under it.
  const body = issue.body.replace(/^##\s+What happened\s*\n/i, '').replace(/^## /gm, '### ');
  const parts = [
    input.summary,
    '## What happened',
    body,
    '## Screenshots',
    shots.join('\n\n') || 'No screenshots available.',
  ];
  if (kind === 'pr' && fix) {
    parts.push(
      '## The fix',
      fix.summary ?? '',
      `\`\`\`text\n${fix.diffStat ?? ''}\n\`\`\``,
      fix.checks
        ? `**Checks:** Bugpatrol ran \`${fix.checks}\` on this change, and it passed.`
        : '**Checks:** Bugpatrol ran no checks on this change. Set `agents.fixer.verify` to run them.',
    );
    const retest = judgedRetests(fix.retests).at(-1);
    if (retest) {
      const verdict =
        retest.outcome === 'fixed' ? '✅ Fixed' : retest.outcome === 'not-fixed' ? '⚠️ Not fixed' : '❔ Unclear';
      const rows = (
        retest.shots?.length ? retest.shots : [{ screenId: issue.screenId, before: retest.before, after: retest.after }]
      ).map(
        (shot) =>
          `| ${shot.screenId ?? 'Screen'} | ${image(shot.before ?? retest.before, 240)} | ${image(shot.after ?? retest.after, 240)} |`,
      );
      parts.push(
        '## Verified in the app',
        `${verdict} — ${retest.reason}`,
        `| Screen | Before | After |\n| --- | --- | --- |\n${rows.join('\n')}`,
        'Bugpatrol started the app from this branch, repeated the flow, and compared the screens.',
      );
    } else parts.push(`Not verified in the app: ${fix.retests?.at(-1)?.reason ?? 'retest disabled'}`);
  }
  if (kind === 'issue' && fix && ['declined', 'failed'].includes(fix.status))
    parts.push('## Fix attempt', `${fix.status}: ${fix.summary ?? fix.error ?? ''}`);
  // A judge reason that only repeats the issue text adds nothing to read.
  const reason = issue.judgement.reason.trim();
  const repeats = issue.body.includes(reason.slice(0, 80));
  const day = (at: string) => at.slice(0, 10);
  parts.push(
    '## Why this matters',
    `${repeats ? '' : `${reason}\n\n`}Severity: ${issue.severity}. ` +
      `Seen ${issue.occurrences} time(s), first ${day(issue.firstSeenAt)}, last ${day(issue.lastSeenAt)}.`,
  );
  if (kind === 'pr' && input.closes) parts.push(`Closes #${input.closes}`);
  parts.push('---', `<sub>Filed by Bugpatrol · ${issue.id}${fix ? ` · ${fix.id}` : ''}</sub>`);
  // First, so the cut below never drops it.
  const repro = kind === 'issue' ? issue.evidence.reproRoutineId : undefined;
  if (repro) parts.unshift(`<!-- bugpatrol:routine ${repro} -->`);
  const text = input.redact(parts.join('\n\n'));
  return text.length <= 60_000
    ? text
    : `${text.slice(0, 60_000)}\n\n…(cut; the full report is in the Bugpatrol dashboard)`;
}

/**
 * The repro routine id hidden in a Bugpatrol issue body, so a fresh clone can
 * map an issue number to its committed routine.
 */
export function reproRoutineId(body: string): string | undefined {
  return /<!-- bugpatrol:routine ([A-Za-z0-9_][\w.-]*) -->/.exec(body)?.[1];
}
