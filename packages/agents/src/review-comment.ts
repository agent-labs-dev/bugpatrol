import type {
  AssertionResult,
  BenchBuild,
  ClaimBench,
  ClaimEvidence,
  ClaimFinding,
  ClaimSource,
  ClaimVerdict,
  PrReview,
  ReviewFinding,
  ReviewVerdict,
} from '@bugpatrol/core';
import { assertionWords } from './replay.js';

/**
 * Finds the reviews of Bugpatrol again, whatever account posted them: a person's gh login, or a CI token.
 * A named review (`agents.review.name`) has its own marker, so two reviews of one pull request never replace each other.
 */
export function reviewMarker(name?: string): string {
  return name ? `<!-- bugpatrol:review:${name} -->` : '<!-- bugpatrol:review -->';
}
export const REVIEW_MARKER = reviewMarker();
/** A review that a later one replaced. */
export const SUPERSEDED_MARKER = '<!-- bugpatrol:superseded -->';

const rank = { cosmetic: 0, minor: 1, major: 2, critical: 3 };
/** The short hash of a commit, as GitHub shows it. */
export const short = (commit: string) => commit.slice(0, 7);
/** Where a replay that failed stopped, counting the steps from 1. */
export const stoppedAt = (replay?: { failedStep?: number }) => `stopped at step ${(replay?.failedStep ?? 0) + 1}`;

function details(summary: string, lines: string[], open = false): string[] {
  return lines.length
    ? [`<details${open ? ' open' : ''}><summary>${summary}</summary>\n\n${lines.join('\n')}\n\n</details>`]
    : [];
}

/** Text for one cell of a Markdown table. */
const cell = (text: string) => text.replaceAll('|', '\\|').replace(/\s*\n\s*/g, ' ');

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

function sourceWords(source: ClaimSource): string {
  switch (source.kind) {
    case 'section':
      return 'the claims section';
    case 'title':
      return 'the title';
    case 'body':
      return 'the description';
    case 'commit':
      return `commit \`${short(source.commit)}\``;
    case 'issue':
      return `issue #${source.number}`;
  }
}

const evidenceWords: Record<ClaimEvidence, string> = {
  replay: 'a replay of the same steps on both builds, with no model',
  assertion: 'an exact check on both builds',
  explored: 'the explorer and the judge, with no replay',
  bench: 'a benchmark on both builds',
};
/** A flow that both builds replayed, and whose verdict the judge read from the screens. */
const judgedReplay = 'the judge, from the screens of a replay of the same steps on both builds';

/** The median and the spread of a benchmark on each build, and the command that measured them. */
function benchLines(bench: ClaimBench, base: string, head: string): string[] {
  const spread = (numbers: BenchBuild) => `${numbers.min} to ${numbers.max}`;
  return [
    `Bugpatrol ran the benchmark \`${bench.name}\` ${bench.runs} times on each build, in turn. ${bench.metric}, ${bench.better} is better.`,
    `| | Base ${base} | This pull request ${head} |\n| --- | --- | --- |\n` +
      `| Median | ${bench.base.median} | ${bench.head.median} |\n` +
      `| Spread | ${spread(bench.base)} | ${spread(bench.head)} |`,
    ...details('Each run', [
      `\`${bench.command}\``,
      `Base: ${bench.base.values.join(', ')}`,
      `This pull request: ${bench.head.values.join(', ')}`,
    ]),
  ];
}

/** A claim whose builds both have a GIF shows the GIFs only. Otherwise it shows the screenshots of each step. */
const recorded = (finding: ClaimFinding) => Boolean(finding.base?.recording?.gif && finding.head?.recording?.gif);

/** The files that the claims of a review show: the recordings and the full videos, or the screenshots. */
export function claimMedia(review: PrReview): string[] {
  return (review.claims ?? [])
    .filter((finding) => finding.verdict !== 'untested')
    .flatMap((finding) =>
      [finding.base, finding.head].flatMap((replay) => [
        ...(recorded(finding) ? [] : (replay?.shots ?? [])),
        ...(replay?.recording ? [replay.recording.gif, replay.recording.file] : []),
      ]),
    )
    .filter((path): path is string => Boolean(path));
}

/**
 * The claims come first: they are what the author says the pull request
 * does. A tested claim is a section with both builds side by side. The
 * claims that Bugpatrol could not test are a list with the reason, so the
 * reviewer knows what is left to check by hand.
 */
function claimLines(
  review: PrReview,
  image: (path?: string) => string | undefined,
  url: (path: string) => string | undefined,
): string[] {
  const claims = review.claims;
  if (!claims) return [];
  const head = `\`${short(review.head)}\``;
  const base = `\`${short(review.base)}\``;
  const shot = (path: string | undefined, fallback: string) => image(path) ?? `_${fallback}_`;
  const stopped = (finding: ClaimFinding, build: 'head' | 'base') => {
    const replay = finding[build];
    return replay && !replay.ok ? `The replay ${stoppedAt(replay)}.` : 'No screenshot.';
  };
  /**
   * The GIF of a build or its last screen, then the full recording: a video, or a terminal cast. A recording
   * with no URL, such as one over the upload limit, stays in the run directory.
   */
  const last = (finding: ClaimFinding, build: 'head' | 'base') => {
    const recording = finding[build]?.recording;
    const video = recording && url(recording.file);
    const label = recording?.file.endsWith('.cast') ? 'Terminal recording' : 'Full video';
    return (
      shot(recording?.gif ?? finding[build]?.shots.at(-1), stopped(finding, build)) +
      (video
        ? `<br><a href="${video}">${label}</a>`
        : recording
          ? `<br>${label}: \`${recording.file}\` in the run, and in the dashboard`
          : '')
    );
  };
  /** Each exact check of a claim on both builds. */
  const checks = (finding: ClaimFinding) => {
    const results = finding.head?.assertions;
    if (!results?.length) return [];
    const cellText = (text: string) => text.replaceAll('|', '\\|');
    const result = (item?: AssertionResult) =>
      !item ? '-' : item.ok ? 'Passed' : item.actual !== undefined ? `Failed, ${assertionWords(item, true)}` : 'Failed';
    return [
      `| Check | Base ${base} | This pull request ${head} |\n| --- | --- | --- |\n` +
        results
          .map(
            (item, index) =>
              `| ${cellText(assertionWords(item))} | ${cellText(result(finding.base?.assertions?.[index]))} | ${cellText(result(item))} |`,
          )
          .join('\n'),
    ];
  };
  /** Each output of a same-behavior claim that differs between the builds, then the rules that normalised them. */
  const compared = (finding: ClaimFinding) => {
    if (!finding.compared) return [];
    const html = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    return [
      ...finding.compared.parts.map((part) => {
        const fence = part.diff.includes('```') ? '~~~~' : '```';
        return `\`${part.step}\` on the base ${base} (\`-\`) and on this pull request ${head} (\`+\`):\n\n${fence}diff\n${part.diff}\n${fence}`;
      }),
      ...details(
        'Normalised before the diff',
        finding.compared.rules.map((rule) => `- ${html(rule)}`),
      ),
    ];
  };
  const section = (finding: ClaimFinding) => {
    const replayed = Boolean(finding.head);
    const steps = finding.steps ?? [];
    return [
      `From ${sourceWords(finding.claim.source)}.` +
        (finding.evidence
          ? ` Evidence: ${finding.evidence === 'explored' && replayed ? judgedReplay : evidenceWords[finding.evidence]}.`
          : ''),
      finding.reason,
      // With a replay, the screenshots show the rest.
      ...(finding.saw && (finding.verdict === 'not-proven' || !replayed) ? [`Bugpatrol saw: ${finding.saw}`] : []),
      ...(finding.bench ? benchLines(finding.bench, base, head) : []),
      ...(finding.did
        ? [
            `${replayed ? 'What Bugpatrol did on both builds' : 'What Bugpatrol did on this pull request'}: ${finding.did}`,
          ]
        : []),
      ...checks(finding),
      ...compared(finding),
      ...(replayed
        ? [
            `| Base ${base} | This pull request ${head} |\n| --- | --- |\n` +
              `| ${last(finding, 'base')} | ${last(finding, 'head')} |`,
            ...details(
              'Each step',
              recorded(finding)
                ? []
                : [
                    `| Step | Base ${base} | This pull request ${head} |\n| --- | --- | --- |`,
                    ...['Start', ...steps].map(
                      (step, index) =>
                        `| ${index ? `${index}. ${step}` : step} | ${shot(finding.base?.shots[index], '-')} | ${shot(finding.head?.shots[index], '-')} |`,
                    ),
                  ],
            ),
          ]
        : []),
    ].join('\n\n');
  };
  if (!claims.length) return ['#### Claims (0)', 'Bugpatrol found no claim in the pull request.'];
  const order: ClaimVerdict[] = ['not-proven', 'partly-proven', 'proven', 'untested'];
  const sorted = [...claims].sort((a, b) => order.indexOf(a.verdict) - order.indexOf(b.verdict));
  const counts = (['proven', 'partly-proven', 'not-proven', 'untested'] as const)
    .map((verdict) => [verdict, claims.filter((finding) => finding.verdict === verdict).length] as const)
    .filter(([, count]) => count)
    .map(([verdict, count]) => `${count} ${verdictWords[verdict].toLowerCase()}`);
  const evidence = (finding: ClaimFinding) =>
    finding.evidence === 'explored' && finding.head
      ? 'replay, judged'
      : finding.evidence
        ? evidenceLabel[finding.evidence]
        : '';
  return [
    `#### Claims (${claims.length}): ${counts.join(' · ')}`,
    '| Claim | Verdict | Evidence |\n| --- | --- | --- |\n' +
      sorted
        .map((finding) =>
          finding.verdict === 'untested'
            ? `| ${cell(finding.claim.text)} | Untested: ${cell(finding.reason)} | |`
            : `| ${cell(finding.claim.text)} | ${verdictWords[finding.verdict]} | ${evidence(finding)} |`,
        )
        .join('\n'),
    ...sorted
      .filter((finding) => finding.verdict !== 'untested')
      .flatMap((finding) =>
        details(
          `${verdictWords[finding.verdict]}: ${finding.claim.text}`,
          [section(finding)],
          finding.verdict !== 'proven',
        ),
      ),
  ];
}

const verdictWords: Record<ClaimVerdict, string> = {
  proven: 'Proven',
  'partly-proven': 'Partly proven',
  'not-proven': 'Not proven',
  untested: 'Untested',
};
const evidenceLabel: Record<ClaimEvidence, string> = {
  replay: 'replay',
  assertion: 'exact check',
  explored: 'explored',
  bench: 'benchmark',
};

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
 * reads first what is theirs to fix. The caller owns upload: `imageUrl` maps
 * a workspace path, of a picture or a video, to where a reader can load it.
 */
export function renderReview(
  review: PrReview,
  imageUrl: (path: string) => string | undefined,
  inDiff: (file: string, line: number) => boolean,
  name?: string,
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
      ...shots(finding),
    ].join('\n\n');
  const shots = (finding: ReviewFinding) => [
    `| Base ${base} | This pull request ${head} |\n| --- | --- |\n` +
      `| ${image(finding.base) ?? `_${finding.baseNote ?? 'No screenshot.'}_`} | ${image(finding.head) ?? '_No screenshot._'} |`,
    ...details(
      'Steps',
      finding.steps.map((step, number) => `${number + 1}. ${step}`),
    ),
  ];
  const problem = (finding: ReviewFinding, index: number) => {
    const where = onLine(finding)
      ? `on \`${finding.file}:${finding.line}\` (line comment)`
      : finding.file && finding.line
        ? `\`${finding.file}:${finding.line}\``
        : finding.screenId
          ? `screen \`${finding.screenId}\``
          : '';
    const headline = [`**${index + 1}. ${finding.title}**`, finding.severity, where].filter(Boolean).join(' · ');
    if (onLine(finding)) return headline;
    return [
      headline,
      finding.reason,
      ...details('Screenshots and steps', [
        shots(finding)[0]!,
        ...finding.steps.map((step, number) => `${number + 1}. ${step}`),
      ]),
    ].join('\n\n');
  };
  const others = [
    ...of('pre-existing').map((finding) => [finding, `Already on \`${review.baseRef}\``] as const),
    ...of('unclear').map((finding) => [finding, 'Could not compare'] as const),
    ...of('not-a-bug').map((finding) => [finding, 'Not a bug'] as const),
  ];
  const otherCounts = [
    [of('pre-existing').length, `already on \`${review.baseRef}\``],
    [of('unclear').length, 'could not compare'],
    [of('not-a-bug').length, 'not a bug'],
  ]
    .filter(([count]) => count)
    .map(([count, words]) => `${count} ${words}`);
  const coverage = review.coverage;
  const hint = nextRunHint(review);
  const body = [
    reviewMarker(name),
    name ? `### Bugpatrol review: ${name}` : '### Bugpatrol review',
    `**${introduced.length ? `${introduced.length} ${introduced.length === 1 ? 'problem' : 'problems'}` : 'No problem'} introduced** · ` +
      `tested ${head} against \`${review.baseRef}\` ${base}`,
    ...(hint ? [`> **Next run:** ${hint}`] : []),
    ...(introduced.length
      ? [`#### Problems this pull request introduces (${introduced.length})`, ...introduced.map(problem)]
      : []),
    ...claimLines(review, image, imageUrl),
    ...(coverage
      ? [
          ...(coverage.tested.length ? ['#### Tested', coverage.tested.map((line) => `- ${line}`).join('\n')] : []),
          ...(coverage.untested.length
            ? ['#### Not tested', coverage.untested.map((item) => `- ${item.what}: ${item.why}`).join('\n')]
            : []),
        ]
      : review.tested
        ? ['#### Tested', review.tested]
        : []),
    ...(others.length
      ? details(`Other findings (${others.length}): ${otherCounts.join(' · ')}`, [
          '| Finding | Severity | Verdict | Why |\n| --- | --- | --- | --- |',
          ...others.map(
            ([finding, verdict]) =>
              `| ${cell(finding.title)} | ${finding.severity} | ${verdict} | ${cell(
                `${finding.reason}${finding.verdict === 'unclear' && finding.baseNote ? ` Base build: ${finding.baseNote}` : ''}`,
              )} |`,
          ),
        ])
      : []),
    `<sub>Updated on each push. Tests only what the diff can affect.${review.check ? '' : ' Does not block the merge.'}</sub>`,
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

/** The review that holds the line comments of one test. The PR comment holds the rest, and changes on each push. */
export function lineReviewBody(count: number, comment: string, name?: string): string {
  return [
    reviewMarker(name),
    `**Bugpatrol review${name ? `: ${name}` : ''}**: ${count} ${count === 1 ? 'problem' : 'problems'} on the changed lines. ` +
      `[The full review](${comment}) is updated on each push.`,
  ].join('\n\n');
}

/** The one change that would let the next review test more, or undefined when none would. */
function nextRunHint(review: PrReview): string | undefined {
  if (review.cutShort?.by === 'max-steps')
    return `The explorer used all ${review.cutShort.limit} steps. Raise \`agents.explorer.maxSteps\`, or the Action's \`steps\` input.`;
  if (review.cutShort?.by === 'budget')
    return `The explorer spent its $${review.cutShort.limit.toFixed(2)} budget. Raise \`agents.explorer.budgetUsd\`.`;
  if (review.files && !review.files.guide)
    return 'Add `.bugpatrol/instructions.md`, an app guide that tells the explorer how to use the app.';
  return undefined;
}

/** The body of a review after a later review replaced it. Its marker stays, so it is never replaced again. */
export function supersededBody(head: string, name?: string): string {
  return `${reviewMarker(name)}\n${SUPERSEDED_MARKER}\n_A Bugpatrol review of \`${short(head)}\` replaced this one._`;
}
