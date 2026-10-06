import type { PrReview, ReviewFinding, ReviewVerdict } from '@bugpatrol/core';

/** Finds the review comment again, so each review edits the one comment and never adds a second. */
export const REVIEW_MARKER = '<!-- bugpatrol:review -->';

const rank = { cosmetic: 0, minor: 1, major: 2, critical: 3 };
const short = (commit: string) => commit.slice(0, 7);

function details(summary: string, lines: string[]): string[] {
  return lines.length ? [`<details><summary>${summary}</summary>\n\n${lines.join('\n')}\n\n</details>`] : [];
}

/**
 * The pull request comment. Only a problem that the pull request introduces
 * gets a section with both screenshots; the rest is folded, so the author
 * reads first what is theirs to fix. The caller owns image upload: `imageUrl`
 * maps a workspace path to where a reader can load it.
 */
export function renderReviewComment(review: PrReview, imageUrl: (path: string) => string | undefined): string {
  const of = (verdict: ReviewVerdict) =>
    review.findings
      .filter((finding) => finding.verdict === verdict)
      .sort((a, b) => rank[b.severity] - rank[a.severity]);
  const introduced = of('introduced');
  const head = `\`${short(review.head)}\``;
  const base = `\`${short(review.base)}\``;
  const image = (path?: string) => {
    const url = path && imageUrl(path);
    return url ? `<img src="${url}" width="360">` : undefined;
  };
  const section = (finding: ReviewFinding, index: number) => [
    `#### ${index + 1}. ${finding.title}`,
    `**${finding.severity}**${finding.screenId ? ` · screen \`${finding.screenId}\`` : ''}`,
    finding.reason,
    `| Base ${base} | This pull request ${head} |\n| --- | --- |\n` +
      `| ${image(finding.base) ?? `_${finding.baseNote ?? 'No screenshot.'}_`} | ${image(finding.head) ?? '_No screenshot._'} |`,
    ...details(
      'Steps',
      finding.steps.map((step, number) => `${number + 1}. ${step}`),
    ),
  ];
  const line = (finding: ReviewFinding) => `- **${finding.title}** (${finding.severity}): ${finding.reason}`;
  return [
    REVIEW_MARKER,
    '### Bugpatrol review',
    introduced.length
      ? `**${introduced.length} ${introduced.length === 1 ? 'problem' : 'problems'} that this pull request introduces.**`
      : '**No problem found that this pull request introduces.**',
    review.sessions.base
      ? `Bugpatrol ran the app from this pull request (${head}) and from its base (${base} on \`${review.baseRef}\`), and repeated the same flows on both.`
      : `Bugpatrol ran the app from this pull request (${head}) and tested what the diff can affect.`,
    ...introduced.flatMap(section),
    ...details(`Already on \`${review.baseRef}\`, not from this pull request (${of('pre-existing').length})`, [
      ...of('pre-existing').map(line),
    ]),
    ...details(`Could not compare (${of('unclear').length})`, [
      ...of('unclear').map(
        (finding) => `${line(finding)}${finding.baseNote ? ` Base build: ${finding.baseNote}` : ''}`,
      ),
    ]),
    ...details(`Reported, then judged not a bug (${of('not-a-bug').length})`, [...of('not-a-bug').map(line)]),
    ...details('What Bugpatrol tested', review.tested ? [review.tested] : []),
    `<sub>Bugpatrol tested only what the diff can affect, not the whole app. This comment does not block the merge.</sub>`,
  ].join('\n\n');
}
