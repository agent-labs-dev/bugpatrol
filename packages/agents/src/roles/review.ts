import { execFile } from 'node:child_process';
import { appendFile, lstat, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  type BugpatrolConfig,
  type Candidate,
  type Claim,
  type ClaimCheckRun,
  type ClaimFinding,
  ConfigError,
  InfrastructureError,
  instructionsPath,
  type Platform,
  type PrReview,
  paths,
  type ReviewFinding,
  type ReviewVerdict,
  type Severity,
} from '@bugpatrol/core';
import { type Driver, createDriver as makeDriver } from '@bugpatrol/drivers';
import { type Capabilities, detectCapabilities } from '../capabilities.js';
import { defaultGh, ensureAssetsBranch, type Gh, ghReady, limitBody, resolveRepo, uploadImage } from '../github.js';
import { startApp } from '../lifecycle.js';
import { withSessionLogs } from '../logs.js';
import { activePatrolPid } from '../patrol.js';
import {
  explorerBaseSystem,
  explorerClaimsPart,
  explorerReviewPrompt,
  explorerReviewSystem,
  judgeClaimsSystem,
  judgeReviewSystem,
} from '../prompts.js';
import {
  claimMedia,
  numberDiff,
  REVIEW_MARKER,
  renderReview,
  SUPERSEDED_MARKER,
  short,
  supersededBody,
} from '../review-comment.js';
import { createRuntime as makeRuntime } from '../runtime/index.js';
import { AgentSession } from '../session.js';
import { explorerTools } from '../tools/explorer.js';
import type { Tool } from '../types.js';
import { Vars } from '../vars.js';
import { lessonsFor, Workspace } from '../workspace.js';
import { pickBenches, runBenches } from './benches.js';
import { type CaptureTarget, captureTargets, image, targetLines } from './capture.js';
import { type ClaimFlow, checkClaims, claimCheckRun, claimTools, replayDisproofs, reproClaims } from './claims.js';
import { stopOnCancellation } from './explorer.js';
import { linkEnvFiles, stepWords } from './fixer.js';
import { overlayBugpatrol } from './overlay.js';

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) =>
  (await exec('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
const schema = (properties: Record<string, unknown> = {}, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const string = { type: 'string' };
const response = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });
const CHECK_NAME = 'Bugpatrol claim check';

/** A lockfile diff is long and says nothing about a screen. */
const DIFF_PATHS = ['.', ':(exclude,glob)**/*.lock', ':(exclude,glob)**/*-lock.*', ':(exclude,glob)**/*.lockb'];
const DIFF_LIMIT = 40_000;
/** An issue that the pull request closes is context for the claims, and a long one would crowd out the diff. */
const ISSUE_LIMIT = 4_000;
const MB = 1024 * 1024;
/** GitHub serves a larger file from the assets branch as a download, not as media (spike #58). */
const UPLOAD_LIMIT = 10 * MB;
const PLATFORMS: Platform[] = ['web', 'electron', 'ios', 'android', 'api', 'desktop', 'cli'];

/**
 * The explorer on a pull request build acts and reports, and writes nothing
 * else. A screen, a routine or a lesson from a build that may never merge
 * must not enter the map that the patrol keeps for the main branch.
 */
const REVIEW_TOOLS = new Set([
  'look',
  'tap',
  'tap_point',
  'type',
  'press',
  'scroll',
  'back',
  'open',
  'wait',
  'request',
  'run_command',
  'run_routine',
  'switch_window',
  'report_bug',
  'list_screens',
  'finish',
]);

export type ReviewOptions = {
  gh?: Gh;
  createDriver?: typeof makeDriver;
  createRuntime?: typeof makeRuntime;
  onLog?: (message: string) => void;
  onSession?: (session?: AgentSession) => void;
  /** Write the review to `.bugpatrol/runs/reviews/`, and send nothing to GitHub. */
  dryRun?: boolean;
  /** Test the pull request again, also when the last review tested the same commit. */
  force?: boolean;
  /** Run the code of a pull request from a fork. It runs on this machine with the app's secrets. */
  allowFork?: boolean;
  maxSteps?: number;
  /** Run the claim check for this review, also when `agents.review.claims` is off. */
  claims?: boolean;
  /** How long a replayed step waits for its target. */
  replayWindowMs?: number;
  /** Finds which platforms the machine can run. Tests stub it. */
  capabilities?: (platforms: Platform[]) => Promise<Capabilities>;
};

type PullRequest = {
  number: number;
  url: string;
  title: string;
  body: string;
  baseRef: string;
  head: string;
  /** The merge base: the base branch as it was when the pull request left it. */
  base: string;
  files: string[];
  /** The diff, with the line number of the new file before each line. */
  diff: string;
  /** The lines of each file that the diff shows: a review comment can go on these only. */
  lines: Map<string, Set<number>>;
  /** Read for the claim check only. */
  commits: { commit: string; message: string }[];
  issues: { number: number; title: string; body: string }[];
};

export type ReviewContext = {
  root: string;
  source: string;
  config: BugpatrolConfig;
  workspace: Workspace;
  repo: string;
  pr: PullRequest;
  opts: ReviewOptions;
  log: (message: string) => void;
};

const claimCheck = (ctx: Pick<ReviewContext, 'config' | 'opts'>) =>
  Boolean(ctx.opts.claims ?? ctx.config.agents.review.claims);
/** A check run that a deterministic disproof fails (ADR 0007). */
const blocking = (ctx: Pick<ReviewContext, 'config'>) => ctx.config.agents.review.block;

/** Holds the fetched pull request commit for the time of one review. */
const headRefOf = (number: number) => `refs/bugpatrol/pr-${number}`;

async function loadPullRequest(
  gh: Gh,
  repo: string,
  source: string,
  number: number,
  opts: { allowFork: boolean; claims: boolean },
): Promise<PullRequest> {
  const fields = `number,title,body,url,baseRefName,isCrossRepository${opts.claims ? ',closingIssuesReferences' : ''}`;
  const view = JSON.parse(
    await gh(['pr', 'view', String(number), '--repo', repo, '--json', fields], { cwd: source }),
  ) as {
    number: number;
    title: string;
    body: string;
    url: string;
    baseRefName: string;
    isCrossRepository: boolean;
    closingIssuesReferences?: { number: number }[];
  };
  if (view.isCrossRepository && !opts.allowFork)
    throw new ConfigError(
      `PR #${number} comes from a fork. A review runs its code on this machine, with the secrets of the app. ` +
        'Read the diff first. If you trust it, run the review again with --allow-fork.',
    );
  const headRef = headRefOf(number);
  const baseRef = `refs/remotes/origin/${view.baseRefName}`;
  await git(
    source,
    'fetch',
    '-q',
    'origin',
    `+refs/pull/${number}/head:${headRef}`,
    `+refs/heads/${view.baseRefName}:${baseRef}`,
  );
  const head = await git(source, 'rev-parse', headRef);
  const base = await git(source, 'merge-base', head, baseRef);
  const files = (await git(source, 'diff', '--name-only', base, head)).split('\n').filter(Boolean);
  const diff = numberDiff(await git(source, 'diff', '--no-color', base, head, '--', ...DIFF_PATHS));
  const commits = opts.claims
    ? (await git(source, 'log', '--reverse', '--format=%H%n%B%x00', `${base}..${head}`))
        .split('\0')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => {
          const [commit, ...message] = entry.split('\n');
          return { commit: commit!, message: message.join('\n').trim() };
        })
    : [];
  const issues: PullRequest['issues'] = [];
  for (const { number: issue } of view.closingIssuesReferences ?? []) {
    const read = JSON.parse(
      await gh(['issue', 'view', String(issue), '--repo', repo, '--json', 'number,title,body'], { cwd: source }),
    ) as { number: number; title: string; body: string | null };
    issues.push({ number: read.number, title: read.title, body: (read.body ?? '').slice(0, ISSUE_LIMIT) });
  }
  return {
    number,
    url: view.url,
    title: view.title,
    body: view.body ?? '',
    baseRef: view.baseRefName,
    head,
    base,
    files,
    diff: diff.text.length > DIFF_LIMIT ? `${diff.text.slice(0, DIFF_LIMIT)}\n(cut: the diff is longer)` : diff.text,
    lines: diff.lines,
    commits,
    issues,
  };
}

/**
 * Checks out one commit of the pull request in its own worktree, prepared
 * like a build, and removes the worktree after. The checkout is detached and
 * has no work of a person in it, so the forced removal loses nothing.
 */
async function withWorktree<T>(
  ctx: ReviewContext,
  name: 'head' | 'base',
  commit: string,
  run: (worktree: string) => Promise<T>,
): Promise<T> {
  const { root, source, config } = ctx;
  const worktree = join(paths.worktrees(root), `review-${ctx.pr.number}-${name}`);
  const remove = async () => {
    try {
      await lstat(worktree);
    } catch {
      return;
    }
    await git(source, 'worktree', 'remove', '--force', worktree);
  };
  // A review that was killed leaves its worktree behind.
  await remove();
  await mkdir(paths.worktrees(root), { recursive: true });
  await git(source, 'worktree', 'add', '-q', '--detach', worktree, commit);
  let restore = async () => {};
  try {
    await linkEnvFiles(source, worktree);
    restore = await overlayBugpatrol(root, source, worktree);
    const prepare = config.agents.fixer.retest.prepare;
    if (prepare) {
      ctx.log(`Preparing the ${name} worktree: ${prepare}`);
      await exec('/bin/sh', ['-c', prepare], { cwd: worktree, timeout: 600_000, maxBuffer: 4 * 1024 * 1024 });
    }
    return await run(worktree);
  } finally {
    try {
      await restore();
    } finally {
      await remove();
    }
  }
}

/** Starts the app from one commit of the pull request, in its own worktree. */
async function withBuild<T>(
  ctx: ReviewContext,
  name: 'head' | 'base',
  commit: string,
  run: (driver: Driver, vars: Vars, fresh: () => Promise<Driver>) => Promise<T>,
): Promise<T> {
  const { root, config } = ctx;
  return withWorktree(ctx, name, commit, async (worktree) => {
    let app: Awaited<ReturnType<typeof startApp>> | undefined;
    let driver: Driver | undefined;
    try {
      const vars = new Vars(config.app.secrets);
      app = await startApp(config.app, { root, vars, emit: ctx.log, source: worktree });
      const connect = async () => {
        await driver?.close();
        driver = undefined;
        const next = (ctx.opts.createDriver ?? makeDriver)(
          config,
          vars.resolve.bind(vars),
          (value) => vars.redact(value) as string,
          worktree,
        );
        driver = next;
        await next.connect();
        return next;
      };
      return await run(await connect(), vars, connect);
    } finally {
      try {
        await driver?.close();
      } finally {
        await app?.stop();
      }
    }
  });
}

/** The explorer tests what the diff can affect on the pull request build. Each report is a candidate. */
async function exploreHead(
  ctx: ReviewContext,
  review: PrReview,
  claims: Claim[],
  flows: Map<string, ClaimFlow>,
): Promise<Candidate[]> {
  const { root, config, workspace, pr, opts } = ctx;
  return withBuild(ctx, 'head', pr.head, async (driver, vars) => {
    const record = await workspace.startSession('explorer');
    review.sessions.explorer = record.id;
    const session = new AgentSession(root, config, vars, record.id, 'explorer', driver, ctx.log);
    opts.onSession?.(session);
    const runtime = (opts.createRuntime ?? makeRuntime)(config.agents.explorer.use);
    const maxSteps = opts.maxSteps ?? config.agents.explorer.maxSteps;
    const guide = instructionsPath(root, config.app.instructions);
    await session.activity(`Reviewing PR #${pr.number}`, 0, runtime.label);
    session.emit({ kind: 'session-start', summary: `Reviewing PR #${pr.number}: ${pr.title}` });
    try {
      const outcome = await withSessionLogs(
        { config, root, vars, onLog: ctx.log, workspace, session: record },
        async () =>
          runtime.run(
            {
              role: 'explorer',
              sessionId: record.id,
              system: explorerReviewSystem(
                config.app.platform,
                guide ? await readFile(guide, 'utf8') : '',
                lessonsFor(await workspace.readMemory(), 'explorer'),
              ),
              prompt: [
                explorerReviewPrompt({
                  pr,
                  screens: (await workspace.readAppMap())?.screens ?? [],
                  routines: await workspace.listRoutines(),
                  placeholders: vars.names(),
                  maxSteps,
                }),
                ...(claims.length ? [explorerClaimsPart(claims)] : []),
              ].join('\n\n'),
              tools: [
                ...explorerTools(session, { replay: { save: false } }).filter((tool) => REVIEW_TOOLS.has(tool.name)),
                ...(claims.length ? claimTools(session, ctx, claims, flows) : []),
              ].map((tool) => stopOnCancellation(session, tool)),
              maxSteps,
              budgetUsd: config.agents.explorer.budgetUsd,
              timeoutMs: config.agents.explorer.timeoutMs,
            },
            session.emit,
          ),
      );
      // "No problem found" from an explorer that did not run would be a false review.
      if (outcome.stop === 'error' || outcome.stop === 'timeout')
        throw new InfrastructureError(
          `The explorer did not finish (${outcome.stop}): ${outcome.error ?? outcome.summary ?? 'no result'}`,
        );
      const candidates = await workspace.readCandidates(record.id);
      review.costUsd += outcome.costUsd;
      review.tested =
        outcome.stop === 'done' && outcome.summary
          ? (vars.redact(outcome.summary.trim()) as string)
          : `The explorer stopped before it finished (${outcome.stop}), so it tested a part of the change only.`;
      await workspace.endSession(record.id, {
        steps: outcome.steps,
        costUsd: outcome.costUsd,
        summary: review.tested,
        candidates: candidates.length,
      });
      session.emit({ kind: 'session-end', summary: `${candidates.length} candidate(s) on PR #${pr.number}` });
      await session.idle(outcome.costUsd);
      return candidates;
    } catch (error) {
      await workspace.endSession(record.id, { status: 'failed', summary: String(error) });
      await session.idle();
      throw error;
    } finally {
      opts.onSession?.();
    }
  });
}

/**
 * Repeats the flow of each candidate on the merge base. A base build that
 * does not start is not the end of the review: the judge then decides from
 * the pull request build and the diff, and says what it could not compare.
 */
async function captureBase(ctx: ReviewContext, review: PrReview, candidates: Candidate[]): Promise<CaptureTarget[]> {
  const { root, config, workspace, pr, opts } = ctx;
  const targets: CaptureTarget[] = candidates.map((candidate) => ({
    shot: {
      screenId: candidate.screenId,
      routineId: candidate.evidence.routineId,
      before: candidate.evidence.screenshot,
    },
    steps: candidate.evidence.steps ?? [],
  }));
  try {
    await withBuild(ctx, 'base', pr.base, async (driver, vars) => {
      const record = await workspace.startSession('explorer');
      review.sessions.base = record.id;
      const session = new AgentSession(root, config, vars, record.id, 'explorer', driver, ctx.log);
      opts.onSession?.(session);
      const runtime = (opts.createRuntime ?? makeRuntime)(config.agents.explorer.use);
      const guide = instructionsPath(root, config.app.instructions);
      const summary = `Repeating ${targets.length} flow(s) on the base of PR #${pr.number}`;
      await session.activity(summary, 0, runtime.label);
      session.emit({ kind: 'session-start', summary });
      let cost = 0;
      let steps = 0;
      try {
        const outcome = await captureTargets(session, runtime, targets, {
          replay: { save: false },
          system: explorerBaseSystem(
            config.app.platform,
            guide ? await readFile(guide, 'utf8') : '',
            lessonsFor(await workspace.readMemory(), 'explorer'),
          ),
          prompt: `Pull request #${pr.number}: ${pr.title}\nFindings:\n${candidates
            .map((candidate, index) => `${index + 1}. ${candidate.summary}`)
            .join('\n')}\nTargets:\n${targetLines(targets)}`,
        });
        cost = outcome.costUsd;
        steps = outcome.steps;
      } finally {
        review.costUsd += cost;
        const reached = targets.filter((target) => target.shot.reached).length;
        const done = `Reached ${reached} of ${targets.length} flow(s) on the base of PR #${pr.number}`;
        await workspace.endSession(record.id, { summary: done, steps, costUsd: cost });
        session.emit({ kind: 'session-end', summary: done });
        await session.idle(cost);
        opts.onSession?.();
      }
    });
  } catch (error) {
    const reason = `The base build did not run: ${String(error).split('\n')[0]}`;
    ctx.log(reason);
    for (const target of targets)
      if (!target.shot.after) {
        target.shot.reached = false;
        target.shot.note = reason;
      }
  }
  return targets;
}

/** The judge compares the two builds and gives each candidate a verdict. */
async function judgeFindings(
  ctx: ReviewContext,
  review: PrReview,
  candidates: Candidate[],
  targets: CaptureTarget[],
): Promise<ReviewFinding[]> {
  const { root, config, workspace, pr, opts } = ctx;
  const vars = new Vars(config.app.secrets);
  const record = await workspace.startSession('judge');
  review.sessions.judge = record.id;
  const session = new AgentSession(root, config, vars, record.id, 'judge', undefined, ctx.log);
  opts.onSession?.(session);
  const runtime = (opts.createRuntime ?? makeRuntime)(config.agents.judge.use);
  const baseNote = (index: number) => {
    const shot = targets[index]!.shot;
    return shot.reached ? (shot.note ?? '') : `Not reached on the base build. ${shot.note ?? ''}`.trim();
  };
  const verdicts = new Map<
    string,
    Pick<ReviewFinding, 'verdict' | 'title' | 'severity' | 'reason' | 'file' | 'line'>
  >();
  const tools: Tool[] = [
    {
      name: 'view_finding',
      description: 'View one finding: the report, then the pull request build and the base build screenshots.',
      inputSchema: schema({ id: string }, ['id']),
      async run(input) {
        const index = candidates.findIndex((candidate) => candidate.id === input.id);
        const candidate = candidates[index];
        if (!candidate) return { ...response('Unknown finding id'), isError: true };
        const head = await image(root, candidate.evidence.screenshot);
        const base = await image(root, targets[index]!.shot.after);
        return {
          content: [
            {
              type: 'text',
              text: `${candidate.id} on ${candidate.screenId ?? 'unknown screen'}: ${candidate.summary}\n${candidate.detail ?? ''}\nPull request build${head.length ? ':' : ': no screenshot.'}`,
            },
            ...head,
            { type: 'text', text: `Base build${base.length ? ':' : ': no screenshot.'} ${baseNote(index)}` },
            ...base,
          ],
        };
      },
    },
    {
      name: 'classify',
      description:
        'Give one finding its verdict, with a title of at most 80 characters and a reason. For an introduced finding, ' +
        'add file and line when the diff shows the changed line that causes it.',
      inputSchema: schema(
        {
          id: string,
          verdict: { type: 'string', enum: ['introduced', 'pre-existing', 'not-a-bug', 'unclear'] },
          title: string,
          severity: { type: 'string', enum: ['cosmetic', 'minor', 'major', 'critical'] },
          reason: string,
          file: string,
          line: { type: 'integer', minimum: 1 },
        },
        ['id', 'verdict', 'title', 'severity', 'reason'],
      ),
      async run(input) {
        if (!candidates.some((candidate) => candidate.id === input.id))
          return { ...response('Unknown finding id'), isError: true };
        const title = String(input.title ?? '').trim();
        if (title.length > 80)
          return {
            ...response(`The title has ${title.length} characters; the limit is 80. Write a shorter title.`),
            isError: true,
          };
        const file = typeof input.file === 'string' && input.file ? input.file : undefined;
        const line = Number.isInteger(input.line) ? Number(input.line) : undefined;
        // GitHub refuses a whole review for one comment on a line that the diff does not show.
        if (file && !(line && pr.lines.get(file)?.has(line)))
          return {
            ...response(
              `The diff does not show line ${line ?? '(none)'} of ${file}. Use a path and a line number from the diff, or leave file and line out.`,
            ),
            isError: true,
          };
        verdicts.set(String(input.id), {
          verdict: input.verdict as ReviewVerdict,
          title,
          severity: input.severity as Severity,
          reason: String(input.reason ?? '').trim(),
          ...(file && input.verdict === 'introduced' ? { file, line } : {}),
        });
        const left = candidates.filter((candidate) => !verdicts.has(candidate.id)).map((candidate) => candidate.id);
        return response(`${input.id}: ${input.verdict}. ${left.length ? `Left: ${left.join(', ')}` : 'All decided.'}`);
      },
    },
    {
      name: 'finish',
      description: 'Finish with one sentence, when every finding has a verdict.',
      inputSchema: schema({ summary: string }, ['summary']),
      async run(input) {
        return { ...response(String(input.summary ?? '')), done: true };
      },
    },
  ];
  let cost = 0;
  let steps = 0;
  let status: 'finished' | 'failed' = 'finished';
  await session.activity(`Judging ${candidates.length} finding(s) on PR #${pr.number}`, 0, runtime.label);
  session.emit({ kind: 'session-start', summary: `Judging ${candidates.length} finding(s) on PR #${pr.number}` });
  try {
    const outcome = await runtime.run(
      {
        role: 'judge',
        sessionId: record.id,
        system: judgeReviewSystem(lessonsFor(await workspace.readMemory(), 'judge')),
        prompt: `PULL REQUEST #${pr.number}: ${pr.title}\n${pr.body.trim() || '(no description)'}\n\nDIFF (each line has its sign, then its line number in the new file)\n${pr.diff}\n\nFINDINGS\n${candidates
          .map(
            (candidate, index) =>
              `- ${candidate.id} [${candidate.severity}] on ${candidate.screenId ?? 'unknown screen'}: ${candidate.summary}. ` +
              `Base build: ${targets[index]!.shot.reached ? 'reached' : 'not reached'}.`,
          )
          .join('\n')}`,
        tools,
        maxSteps: Math.max(config.agents.judge.maxSteps, candidates.length * 2 + 10),
        budgetUsd: config.agents.judge.budgetUsd,
        timeoutMs: config.agents.judge.timeoutMs,
      },
      session.emit,
    );
    cost = outcome.costUsd;
    steps = outcome.steps;
  } catch (error) {
    status = 'failed';
    throw error;
  } finally {
    review.costUsd += cost;
    const count = [...verdicts.values()].filter((item) => item.verdict === 'introduced').length;
    const summary = `PR #${pr.number}: ${count} introduced problem(s) in ${candidates.length} finding(s)`;
    await workspace.endSession(record.id, { status, summary, steps, costUsd: cost });
    session.emit({ kind: 'session-end', summary });
    await session.idle(cost);
    opts.onSession?.();
  }
  return candidates.map((candidate, index) => ({
    candidateId: candidate.id,
    screenId: candidate.screenId,
    // A finding that the judge did not reach is never shown as the pull request's fault.
    ...(verdicts.get(candidate.id) ?? {
      verdict: 'unclear' as const,
      title: candidate.summary.slice(0, 80),
      severity: candidate.severity,
      reason: 'The judge gave no verdict.',
    }),
    steps: [
      ...(candidate.evidence.routineId ? [`Run the routine ${candidate.evidence.routineId}`] : []),
      ...(candidate.evidence.steps ?? []).map(stepWords),
    ],
    head: candidate.evidence.screenshot,
    base: targets[index]!.shot.after,
    baseNote: baseNote(index) || undefined,
  }));
}

/**
 * A later `bugpatrol judge` reads the candidates of each recent explorer
 * session. It must not file a problem that exists only on this pull request
 * as an issue of the main branch, so the review decides those candidates
 * here. A pre-existing problem stays open for that judge: the base build has it.
 */
async function settleCandidates(ctx: ReviewContext, sessionId: string, findings: ReviewFinding[]): Promise<void> {
  const lines = findings
    .filter((finding) => finding.verdict !== 'pre-existing')
    .map((finding) =>
      JSON.stringify({
        candidateId: finding.candidateId,
        decision: 'dismiss',
        reason: `Review of PR #${ctx.pr.number}: ${finding.verdict}`,
        at: new Date().toISOString(),
      }),
    );
  if (lines.length)
    await appendFile(join(paths.session(ctx.root, sessionId), 'decisions.jsonl'), `${lines.join('\n')}\n`);
}

/**
 * The claims of a claims section that the author wrote in the pull request
 * body: a heading named Claims, then a list. Each list item is one claim, as written.
 */
function sectionClaims(body: string): string[] | undefined {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => /^#{1,6}\s+claims\s*:?\s*$/i.test(line.trim()));
  if (start < 0) return undefined;
  const level = /^#+/.exec(lines[start]!.trim())![0].length;
  const claims: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const heading = /^(#{1,6})\s/.exec(line.trim());
    if (heading && heading[1]!.length <= level) break;
    const item = /^\s{0,3}(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.+)$/.exec(line);
    if (item) claims.push(item[1]!.trim());
    // A line that continues the item above it.
    else if (claims.length && /^\s+\S/.test(line)) claims[claims.length - 1] += ` ${line.trim()}`;
  }
  return claims.length ? claims : undefined;
}

/** The claims of the pull request: the author's claims section as written, or else the judge's. */
async function readClaims(ctx: ReviewContext, review: PrReview): Promise<Claim[]> {
  const { config, pr } = ctx;
  const section = sectionClaims(pr.body);
  if (section)
    return section.map((text, index) => ({
      id: `claim-${index + 1}`,
      text,
      platform: config.app.platform,
      source: { kind: 'section' },
      testable: true,
    }));
  return writeClaims(ctx, review);
}

/** Without a claims section, the judge writes the claims from what the pull request says. */
async function writeClaims(ctx: ReviewContext, review: PrReview): Promise<Claim[]> {
  const { root, config, workspace, pr, opts } = ctx;
  const vars = new Vars(config.app.secrets);
  const record = await workspace.startSession('judge');
  review.sessions.claims = record.id;
  const session = new AgentSession(root, config, vars, record.id, 'judge', undefined, ctx.log);
  opts.onSession?.(session);
  const runtime = (opts.createRuntime ?? makeRuntime)(config.agents.judge.use);
  const claims: Claim[] = [];
  const sourceOf = (input: Record<string, unknown>): Claim['source'] | string => {
    if (input.source === 'title' || input.source === 'body') return { kind: input.source };
    if (input.source === 'commit') {
      const found = pr.commits.find((item) => item.commit === input.commit);
      return found
        ? { kind: 'commit', commit: found.commit }
        : `The pull request has no commit ${String(input.commit)}. Use a full hash from the prompt.`;
    }
    if (input.source === 'issue') {
      const found = pr.issues.find((item) => item.number === input.issue);
      return found
        ? { kind: 'issue', number: found.number }
        : `The pull request closes no issue #${String(input.issue)}. ` +
            `It closes: ${pr.issues.map((item) => `#${item.number}`).join(', ') || 'none'}.`;
    }
    return 'Use the source title, body, commit or issue.';
  };
  const tools: Tool[] = [
    {
      name: 'add_claim',
      description:
        'Add one claim of the pull request. Name its source: title, body, commit (with the commit hash) or issue ' +
        '(with the issue number). A claim that cannot be tested needs testable false and a reason.',
      inputSchema: schema(
        {
          text: string,
          platform: { type: 'string', enum: PLATFORMS },
          source: { type: 'string', enum: ['title', 'body', 'commit', 'issue'] },
          commit: string,
          issue: { type: 'integer', minimum: 1 },
          testable: { type: 'boolean' },
          reason: string,
        },
        ['text', 'platform', 'source', 'testable'],
      ),
      async run(input) {
        const refuse = (message: string) => ({ ...response(message), isError: true });
        const text = String(input.text ?? '').trim();
        const reason = String(input.reason ?? '').trim();
        const testable = input.testable !== false;
        const source = sourceOf(input);
        if (!text) return refuse('Write the claim in text.');
        if (!PLATFORMS.includes(input.platform as Platform))
          return refuse(`Use one platform of ${PLATFORMS.join(', ')}.`);
        if (!testable && !reason) return refuse('Say in reason why this claim cannot be tested.');
        if (typeof source === 'string') return refuse(source);
        const claim: Claim = {
          id: `claim-${claims.length + 1}`,
          text: vars.redact(text) as string,
          platform: input.platform as Platform,
          source,
          testable,
          ...(testable ? {} : { untestable: vars.redact(reason) as string }),
        };
        claims.push(claim);
        return response(`${claim.id}: ${testable ? 'testable' : 'not testable'}.`);
      },
    },
    {
      name: 'finish',
      description: 'Finish with one sentence, when every claim is added.',
      inputSchema: schema({ summary: string }, ['summary']),
      async run(input) {
        return { ...response(String(input.summary ?? '')), done: true };
      },
    },
  ];
  const limits = config.agents.review;
  let cost = 0;
  let steps = 0;
  let status: 'finished' | 'failed' = 'finished';
  const start = `Reading the claims of PR #${pr.number}`;
  await session.activity(start, 0, runtime.label);
  session.emit({ kind: 'session-start', summary: start });
  try {
    const outcome = await runtime.run(
      {
        role: 'judge',
        sessionId: record.id,
        system: judgeClaimsSystem(lessonsFor(await workspace.readMemory(), 'judge')),
        prompt: [
          `PULL REQUEST #${pr.number}: ${pr.title}`,
          pr.body.trim() || '(no description)',
          `PLATFORM OF THE APP: ${config.app.platform}`,
          `COMMITS\n${pr.commits.map((item) => `commit ${item.commit}\n${item.message}`).join('\n\n') || '(none)'}`,
          `ISSUES THAT IT CLOSES\n${
            pr.issues.map((item) => `ISSUE #${item.number}: ${item.title}\n${item.body.trim()}`).join('\n\n') ||
            '(none)'
          }`,
          `DIFF (each line has its sign, then its line number in the new file)\n${pr.diff}`,
        ].join('\n\n'),
        tools,
        maxSteps: limits.maxSteps,
        budgetUsd: limits.budgetUsd,
        timeoutMs: limits.timeoutMs,
      },
      session.emit,
    );
    cost = outcome.costUsd;
    steps = outcome.steps;
  } catch (error) {
    status = 'failed';
    throw error;
  } finally {
    review.costUsd += cost;
    const summary = `PR #${pr.number}: ${claims.length} claim(s)`;
    await workspace.endSession(record.id, { status, summary, steps, costUsd: cost });
    session.emit({ kind: 'session-end', summary });
    await session.idle(cost);
    opts.onSession?.();
  }
  return claims;
}

async function runReview(ctx: ReviewContext): Promise<PrReview> {
  const { workspace, pr } = ctx;
  const review: PrReview = {
    version: 1,
    pr: { number: pr.number, url: pr.url, title: pr.title },
    head: pr.head,
    base: pr.base,
    baseRef: pr.baseRef,
    status: 'running',
    startedAt: new Date().toISOString(),
    sessions: {},
    findings: [],
    costUsd: 0,
  };
  await workspace.saveReview(review);
  try {
    const claims = claimCheck(ctx) ? await readClaims(ctx, review) : undefined;
    // The issues that it closes with a repro routine: a replay checks them, never the explorer or a benchmark.
    const repros = claims ? await reproClaims(ctx, claims.length + 1) : { claims: [], flows: new Map() };
    claims?.push(...repros.claims);
    const explorable = (claim: Claim) => !repros.flows.has(claim.id);
    // Each claim is untested until a test gives it a verdict, also when the review fails on the way.
    const notYet = (claim: Claim, reason: string): ClaimFinding => ({
      claim,
      verdict: 'untested',
      reason: claim.untestable ?? reason,
    });
    if (claims) {
      review.claims = claims.map((claim) => notYet(claim, 'The review stopped before it tested this claim.'));
      await rm(paths.reviewDir(ctx.root, pr.number), { recursive: true, force: true });
    }
    const platform = ctx.config.app.platform;
    const testable = (claims ?? []).filter((claim) => claim.testable);
    // Detection runs before any exploring, and only for the claim check.
    const missing: Capabilities = testable.length
      ? await (ctx.opts.capabilities ?? ((platforms) => detectCapabilities(ctx.config, platforms)))([
          ...new Set(testable.map((claim) => claim.platform)),
        ])
      : {};
    const toTest = testable.filter((claim) => claim.platform === platform && !missing[platform]);
    const untestedHere = (claim: Claim) =>
      notYet(claim, missing[claim.platform] ?? `The app runs on ${platform}, and this claim needs ${claim.platform}.`);
    if (!pr.files.length) {
      review.tested = `The pull request changes no file against \`${pr.baseRef}\`.`;
      if (claims) review.claims = claims.map((claim) => notYet(claim, 'The pull request changes no file.'));
    } else if (missing[platform]) {
      // The app cannot start here, so nothing else runs, and the review still posts.
      review.tested = `Bugpatrol could not run the app on this machine. ${missing[platform]}`;
      review.claims = claims!.map(untestedHere);
    } else {
      const flows = new Map<string, ClaimFlow>(repros.flows);
      const picks =
        testable.some(explorable) && ctx.config.agents.review.benches.length
          ? await pickBenches(ctx, review, testable.filter(explorable))
          : new Map<string, string>();
      // A benchmark measures its claims; the explorer tests the others.
      const toExplore = toTest.filter((claim) => explorable(claim) && !picks.has(claim.id));
      const candidates = await exploreHead(ctx, review, toExplore, flows);
      if (claims) {
        const measured = await runBenches(ctx, picks, (run) =>
          withWorktree(ctx, 'base', pr.base, (base) =>
            withWorktree(ctx, 'head', pr.head, (head) => run({ head, base })),
          ),
        );
        const build = <T>(
          name: 'head' | 'base',
          commit: string,
          run: (driver: Driver, vars: Vars, fresh: () => Promise<Driver>) => Promise<T>,
        ) => withBuild(ctx, name, commit, run);
        const toCheck = [
          ...toExplore,
          ...testable.filter((claim) => picks.has(claim.id)),
          ...toTest.filter((claim) => !explorable(claim)),
        ];
        const checked = await checkClaims(ctx, review, toCheck, flows, measured, build);
        const tested = blocking(ctx) ? await replayDisproofs(ctx, review, checked, flows, build) : checked;
        review.claims = claims.map(
          (claim) => tested.find((finding) => finding.claim.id === claim.id) ?? untestedHere(claim),
        );
      }
      // With no report there is nothing to compare, so the base build does not start.
      if (candidates.length) {
        const targets = await captureBase(ctx, review, candidates);
        review.findings = await judgeFindings(ctx, review, candidates, targets);
        await settleCandidates(ctx, review.sessions.explorer!, review.findings);
      }
    }
    if (blocking(ctx)) review.check = claimCheckRun(review.claims ?? [], review.head);
    review.status = 'finished';
  } catch (error) {
    review.status = 'failed';
    review.error = String(error);
    throw error;
  } finally {
    review.endedAt = new Date().toISOString();
    await workspace.saveReview(review);
  }
  return review;
}

/** The marked reviews on the pull request that no later review replaced yet. */
async function openReviews(gh: Gh, reviews: string): Promise<{ id: string; commit: string }[]> {
  const select = `.[] | select(.body | contains("${REVIEW_MARKER}")) | select(.body | contains("${SUPERSEDED_MARKER}") | not)`;
  return (await gh(['api', '--paginate', reviews, '--jq', `${select} | "\\(.id) \\(.commit_id)"`]))
    .split('\n')
    .filter(Boolean)
    .map((row) => {
      const [id, commit] = row.split(' ');
      return { id: id!, commit: commit! };
    });
}

/**
 * GitHub keeps a submitted review for good, so an old review gets a one-line
 * body, and Bugpatrol deletes its line comments. A comment that a person
 * answered stays: the answer is theirs.
 */
async function supersede(ctx: ReviewContext, gh: Gh, old: { id: string }[], head: string): Promise<void> {
  const pulls = `repos/${ctx.repo}/pulls`;
  const ids = new Set(old.map((review) => review.id));
  for (const id of ids)
    await gh(['api', '-X', 'PUT', `${pulls}/${ctx.pr.number}/reviews/${id}`, '--input', '-'], {
      input: JSON.stringify({ body: supersededBody(head) }),
    });
  const rows = (
    await gh([
      'api',
      '--paginate',
      `${pulls}/${ctx.pr.number}/comments`,
      '--jq',
      '.[] | "\\(.id) \\(.pull_request_review_id) \\(.in_reply_to_id)"',
    ])
  )
    .split('\n')
    .filter(Boolean)
    .map((row) => row.split(' ') as [string, string, string]);
  const answered = new Set(rows.map(([, , parent]) => parent));
  for (const [id, review, parent] of rows)
    if (ids.has(review) && parent === 'null' && !answered.has(id))
      await gh(['api', '-X', 'DELETE', `${pulls}/comments/${id}`]);
}

/**
 * Posts a pull request review with the event COMMENT, which never blocks a
 * merge. A new test of the pull request posts a new review and replaces the
 * older ones. The same result on the same commit only updates the body.
 */
async function publishReview(ctx: ReviewContext, gh: Gh, review: PrReview, tested: boolean): Promise<void> {
  const { root, config, repo, pr } = ctx;
  const redact = (text: string) => new Vars(config.app.secrets).redact(text) as string;
  const inDiff = (file: string, line: number) => pr.lines.get(file)?.has(line) ?? false;
  if (ctx.opts.dryRun) {
    const file = paths.review(root, pr.number).replace(/\.json$/, '.md');
    const rendered = renderReview(review, (path) => resolve(root, path), inDiff);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(
      file,
      redact(
        [
          rendered.body,
          ...rendered.comments.map(
            (comment) => `---\n\nOn \`${comment.path}\` line ${comment.line}:\n\n${comment.body}`,
          ),
          ...(review.check
            ? [
                `---\n\nCheck run ${CHECK_NAME}: \`${review.check.conclusion}\`, ${review.check.title}\n\n${review.check.summary}`,
              ]
            : []),
        ].join('\n\n'),
      ),
    );
    ctx.log(`Wrote the review of PR #${pr.number} to ${file}. Nothing went to GitHub.`);
    return;
  }
  const branch = config.agents.github.assetsBranch;
  const urls = new Map<string, string>();
  const shown = [
    ...review.findings
      .filter((finding) => finding.verdict === 'introduced')
      .flatMap((finding) => [finding.head, finding.base]),
    ...claimMedia(review),
  ].filter((path): path is string => Boolean(path));
  if (shown.length) await ensureAssetsBranch(gh, repo, branch);
  for (const path of new Set(shown)) {
    try {
      const { size } = await stat(resolve(root, path));
      if (size > UPLOAD_LIMIT) {
        ctx.log(
          `Did not upload ${path}: it has ${(size / MB).toFixed(1)} MB, over the limit of ${UPLOAD_LIMIT / MB} MB.`,
        );
        continue;
      }
      urls.set(path, await uploadImage(gh, repo, branch, resolve(root, path), `pr-${pr.number}`));
    } catch (error) {
      ctx.log(`Could not upload ${path}: ${String(error).split('\n')[0]}`);
    }
  }
  const rendered = renderReview(review, (path) => urls.get(path), inDiff);
  const body = limitBody(redact(rendered.body));
  const reviews = `repos/${repo}/pulls/${pr.number}/reviews`;
  const open = await openReviews(gh, reviews);
  const current = open.find((item) => item.commit === review.head);
  let posted: { html_url: string };
  if (current && !tested) {
    posted = JSON.parse(
      await gh(['api', '-X', 'PUT', `${reviews}/${current.id}`, '--input', '-'], { input: JSON.stringify({ body }) }),
    );
  } else {
    posted = JSON.parse(
      await gh(['api', '-X', 'POST', reviews, '--input', '-'], {
        input: JSON.stringify({
          commit_id: review.head,
          event: 'COMMENT',
          body,
          comments: rendered.comments.map((comment) => ({
            path: comment.path,
            line: comment.line,
            side: 'RIGHT',
            body: limitBody(redact(comment.body)),
          })),
        }),
      }),
    );
    try {
      await supersede(ctx, gh, open, review.head);
    } catch (error) {
      ctx.log(`Could not replace the older review(s) of PR #${pr.number}: ${String(error).split('\n')[0]}`);
    }
  }
  review.posted = { url: posted.html_url, at: new Date().toISOString() };
  await ctx.workspace.saveReview(review);
  ctx.log(`${current && !tested ? 'Updated' : 'Posted'} the review of PR #${pr.number}: ${posted.html_url}`);
  if (review.check) await setCheckRun(ctx, gh, review, review.check);
}

/**
 * Sets the check run of the claim check on the pull request commit. The
 * exit code carries the same result, so a token without `checks: write`
 * loses the check on GitHub, and the run still fails.
 */
async function setCheckRun(ctx: ReviewContext, gh: Gh, review: PrReview, check: ClaimCheckRun): Promise<void> {
  const redact = (text: string) => new Vars(ctx.config.app.secrets).redact(text) as string;
  try {
    const run = JSON.parse(
      await gh(['api', '-X', 'POST', `repos/${ctx.repo}/check-runs`, '--input', '-'], {
        input: JSON.stringify({
          name: CHECK_NAME,
          head_sha: review.head,
          status: 'completed',
          conclusion: check.conclusion,
          ...(review.posted ? { details_url: review.posted.url } : {}),
          output: { title: check.title, summary: limitBody(redact(check.summary)) },
        }),
      }),
    ) as { html_url: string };
    check.url = run.html_url;
    await ctx.workspace.saveReview(review);
    ctx.log(`Set the claim check of PR #${ctx.pr.number} to ${check.conclusion}: ${run.html_url}`);
  } catch (error) {
    ctx.log(
      `Could not set the claim check of PR #${ctx.pr.number} (the token needs checks: write): ${String(error).split('\n')[0]}`,
    );
  }
}

/**
 * A differential review of one pull request: the explorer tests what the
 * diff can affect on the pull request build, repeats each reported flow on
 * the merge base, and the judge keeps only what the pull request introduces.
 * The result is a pull request review that comments and never blocks a merge (ADR 0005, section 6).
 * With `agents.review.block` on, a claim check run fails on a disproof that a replay repeated (ADR 0007).
 */
export async function reviewPullRequest(
  root: string,
  config: BugpatrolConfig,
  number: number,
  opts: ReviewOptions = {},
): Promise<PrReview> {
  if (!opts.dryRun && !config.agents.github.enabled)
    throw new ConfigError(
      'GitHub is off. Set agents.github.enabled: true in .bugpatrol/bugpatrol.yml, ' +
        'or run `bugpatrol review <pr> --dry-run` to write the review to .bugpatrol/runs/reviews/ only.',
    );
  const gh = opts.gh ?? defaultGh;
  const ready = await ghReady(gh);
  if (!ready.ok) throw new ConfigError(ready.reason.replace('GitHub publish skipped', 'Review stopped'));
  const workspace = new Workspace(root);
  const patrol = activePatrolPid((await workspace.readAgents()).patrol);
  if (patrol)
    throw new ConfigError(
      `A patrol runs (pid ${patrol}), and it uses the app. Stop the patrol, or review when it waits for a new commit.`,
    );
  const source = resolve(root, config.app.source);
  const log = opts.onLog ?? (() => {});
  const { repo } = await resolveRepo(gh, config, source);
  try {
    const pr = await loadPullRequest(gh, repo, source, number, {
      allowFork: Boolean(opts.allowFork),
      claims: claimCheck({ config, opts }),
    });
    const ctx: ReviewContext = { root, source, config, workspace, repo, pr, opts, log };
    const last = await workspace.readReview(number);
    let review: PrReview;
    const covered = last && (last.claims || !claimCheck(ctx)) && (last.check || !blocking(ctx));
    if (last?.status === 'finished' && last.head === pr.head && covered && !opts.force) {
      log(`PR #${number} has a review of ${short(pr.head)}: published it again. Use --force to test the commit again.`);
      review = last;
    } else {
      log(`Reviewing PR #${number} at ${short(pr.head)} against ${short(pr.base)} on ${pr.baseRef}.`);
      review = await runReview(ctx);
    }
    await publishReview(ctx, gh, review, review !== last);
    return review;
  } finally {
    // The ref of a pull request that is not there yet deletes as a no-op.
    await git(source, 'update-ref', '-d', headRefOf(number));
  }
}
