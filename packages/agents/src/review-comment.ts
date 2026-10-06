import type { PrReview, ReviewFinding, ReviewVerdict } from '@bugpatrol/core';

/** Finds the reviews of Bugpatrol again, whatever account posted them: a person's gh login, or a CI token. */
export const REVIEW_MARKER = '<!-- bugpatrol:review -->';
/** A review that a later one replaced. */
export const SUPERSEDED_MARKER = '<!-- bugpatrol:superseded -->';

const rank = { cosmetic: 0, minor: 1, major: 2, critical: 3 };
const short = (commit: string) => commit.slice(0, 7);

function details(summary: string, lines: string[]): string[] {
  return lines.length ? [`<details><summary>${summary}</summary>\n\n${lines.join('\n')}\n\n</details>`] : [];
}

/**
 * Puts the line number of the new file before each line of a unified diff,
 * so the judge can name a line without counting from the hunk header. `lines`
 * holds the numbers of each file: GitHub accepts a review comment only on a
 * line that the diff shows.
 */
export function numberDiff(diff: string): { text: string; lines: Map<string, Set<number>> } {
  const lines = new Map<string, Set<number>>();
  const text: string[] = [];
  let file: string | undefined;
  let next = 0;
  let inHunk = false;
  for (const raw of diff.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (raw.startsWith('diff --git ')) {
      file = undefined;
      inHunk = false;
    } else if (!inHunk && raw.startsWith('+++ ')) {
      // A deleted file has no line to comment on.
      file = raw === '+++ /dev/null' ? undefined : raw.slice('+++ b/'.length);
    } else if (hunk) {
      next = Number(hunk[1]);
      inHunk = true;
    } else if (inHunk && file && (raw[0] === '+' || raw[0] === ' ')) {
      lines.set(file, (lines.get(file) ?? new Set()).add(next));
      text.push(`${raw[0]}${String(next).padStart(5)} ${raw.slice(1)}`);
      next++;
      continue;
    } else if (inHunk && raw[0] === '-') {
      text.push(`-${' '.repeat(5)} ${raw.slice(1)}`);
      continue;
    }
    text.push(raw);
  }
  return { text: text.join('\n'), lines };
}

export type RenderedReview = {
  body: string;
  /** One for each introduced problem that the judge put on a line of the diff. */
  comments: { path: string; line: number; body: string }[];
};

/**
 * The pull request review. A problem that the pull request introduces is a
 * comment on the changed line that causes it, with both screenshots. When the
 * judge named no line, or a line that the diff does not show, the problem is
 * a section of the review body instead. The rest is folded, so the author
 * reads first what is theirs to fix. The caller owns image upload: `imageUrl`
 * maps a workspace path to where a reader can load it.
 */
export function renderReview(
  review: PrReview,
  imageUrl: (path: string) => string | undefined,
  inDiff: (file: string, line: number) => boolean,
): RenderedReview {
  const of = (verdict: ReviewVerdict) =>
    review.findings
      .filter((finding) => finding.verdict === verdict)
      .sort((a, b) => rank[b.severity] - rank[a.severity]);
  const introduced = of('introduced');
  const onLine = (finding: ReviewFinding) =>
    Boolean(finding.file && finding.line && inDiff(finding.file, finding.line));
  const located = introduced.filter(onLine);
  const head = `\`${short(review.head)}\``;
  const base = `\`${short(review.base)}\``;
  const image = (path?: string) => {
    const url = path && imageUrl(path);
    return url ? `<img src="${url}" width="360">` : undefined;
  };
  const section = (finding: ReviewFinding, heading: string) =>
    [
      heading,
      `**${finding.severity}**${finding.screenId ? ` · screen \`${finding.screenId}\`` : ''}`,
      finding.reason,
      `| Base ${base} | This pull request ${head} |\n| --- | --- |\n` +
        `| ${image(finding.base) ?? `_${finding.baseNote ?? 'No screenshot.'}_`} | ${image(finding.head) ?? '_No screenshot._'} |`,
      ...details(
        'Steps',
        finding.steps.map((step, number) => `${number + 1}. ${step}`),
      ),
    ].join('\n\n');
  const line = (finding: ReviewFinding) => `- **${finding.title}** (${finding.severity}): ${finding.reason}`;
  const where =
    located.length === 0
      ? []
      : located.length === introduced.length
        ? ['Each one is a comment on the changed line that causes it.']
        : [
            `${located.length} of them ${located.length === 1 ? 'is a comment on the changed line that causes it' : 'are comments on the changed lines that cause them'}. The others are below.`,
          ];
  const body = [
    REVIEW_MARKER,
    '### Bugpatrol review',
    introduced.length
      ? `**${introduced.length} ${introduced.length === 1 ? 'problem' : 'problems'} that this pull request introduces.**`
      : '**No problem found that this pull request introduces.**',
    ...where,
    review.sessions.base
      ? `Bugpatrol ran the app from this pull request (${head}) and from its base (${base} on \`${review.baseRef}\`), and repeated the same flows on both.`
      : `Bugpatrol ran the app from this pull request (${head}) and tested what the diff can affect.`,
    ...introduced
      .filter((finding) => !onLine(finding))
      .map((finding, index) => section(finding, `#### ${index + 1}. ${finding.title}`)),
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
    `<sub>Bugpatrol tested only what the diff can affect, not the whole app. This review does not block the merge.</sub>`,
  ].join('\n\n');
  return {
    body,
    comments: located.map((finding) => ({
      path: finding.file!,
      line: finding.line!,
      body: section(finding, `**${finding.title}**`),
    })),
  };
}

/** The body of a review after a later review replaced it. Its marker stays, so it is never replaced again. */
export function supersededBody(head: string): string {
  return `${REVIEW_MARKER}\n${SUPERSEDED_MARKER}\n_A Bugpatrol review of \`${short(head)}\` replaced this one._`;
}
