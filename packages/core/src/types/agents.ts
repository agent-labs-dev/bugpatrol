import type { Severity } from './finding.js';
import type { TokenUsage } from './usage.js';

/**
 * The agent layer (ADR 0005). Everything here is written to `.bugpatrol/` as
 * plain JSON so the dashboard can render it and a human can audit it.
 */

export type AgentRole = 'explorer' | 'judge' | 'fixer';
export type LessonRole = AgentRole;
export type Lesson = {
  id: string;
  role: LessonRole;
  /** A screen or routine; absent means the whole app. */
  scope?: string;
  text: string;
  source: 'reflection' | 'agent' | 'human' | 'dismissal' | 'fixer-decline' | 'commit-hook' | 'verify' | 'rejected-pr';
  hits: number;
  createdAt: string;
  lastSeenAt: string;
  retired?: { at: string; reason: string };
};
export type MemoryFile = { version: 1; lessons: Lesson[] };

/** The longest lesson text. A lesson that a model or a human writes over it is rejected, not cut. */
export const LESSON_MAX_LENGTH = 200;

/**
 * Fits a lesson that Bugpatrol builds around outside text, such as stderr or
 * a dismissal reason, into the limit. It cuts at the last word boundary and
 * ends with an ellipsis, so the lesson never stops mid-word.
 */
export function fitLesson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= LESSON_MAX_LENGTH) return trimmed;
  const space = trimmed.lastIndexOf(' ', LESSON_MAX_LENGTH - 1);
  return `${trimmed.slice(0, space > 0 ? space : LESSON_MAX_LENGTH - 1).trimEnd()}…`;
}

/** Why a written lesson cannot be saved, or undefined when it fits. */
export function lessonTooLong(text: string): string | undefined {
  const length = text.trim().length;
  if (length > LESSON_MAX_LENGTH)
    return `The lesson has ${length} characters, and the limit is ${LESSON_MAX_LENGTH}. Nothing was saved. Write it shorter.`;
}

export type Platform = 'web' | 'electron' | 'ios' | 'android' | 'api' | 'desktop' | 'cli';

export type HttpMethod = 'GET' | 'HEAD' | 'OPTIONS' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * How Bugpatrol finds an element again on a later run. The locator is tried
 * first; the point is the last resort, and a replay that needed it is
 * reported as degraded.
 */
export type Locator = {
  testId?: string;
  role?: string;
  name?: string;
  text?: string;
  /** Web and Electron only. */
  selector?: string;
  point?: { x: number; y: number };
};

/**
 * One replayable action. `value` may hold `{{NAME}}` placeholders; they are
 * resolved when the step runs and never stored resolved.
 */
export type RoutineStep = (
  | { kind: 'tap'; target: Locator }
  | { kind: 'type'; target?: Locator; value: string; submit?: boolean; append?: boolean }
  | { kind: 'press'; key: string }
  | { kind: 'scroll'; direction: 'up' | 'down' | 'left' | 'right'; target?: Locator }
  | { kind: 'back' }
  | { kind: 'open'; url: string }
  | { kind: 'wait'; ms: number }
  | { kind: 'window'; match: string }
  | {
      kind: 'request';
      method: HttpMethod;
      url: string;
      headers?: Record<string, string>;
      body?: string;
      capture?: Record<string, string>;
    }
  /** CLI: runs a command in a terminal until it exits. `input` is typed into it at the start. */
  | { kind: 'run'; command: string; input?: string }
) & { at?: string };

export type Routine = {
  version: 1;
  /** Kebab-case, unique in the workspace. */
  id: string;
  description: string;
  platform: Platform;
  /** Run this routine first. For example `enter-app` before `open-settings`. */
  requires?: string[];
  steps: RoutineStep[];
  /** The screen this routine reaches, when it reaches one. */
  screenId?: string;
  createdAt: string;
  updatedAt: string;
  /** Replay history, so a routine that keeps breaking is visible as one. */
  lastReplay?: {
    at: string;
    ok: boolean;
    degraded?: boolean;
    error?: string;
    skipped?: number[];
    onFixBuild?: boolean;
  };
  /**
   * What the screen showed when the routine was saved: the names of a few
   * stable elements. A replay may skip a step whose target is gone (a banner
   * that did not appear this time, a detour) only if it still ends here.
   */
  expect?: { elements: string[] };
  /** Repro routines only: how a replay tells, with no model, that the bug shows at the end. */
  bug?: BugCheck;
  /** Claim routines only: exact checks on the last command or response, after the steps ran. */
  assert?: Assertion[];
  /**
   * Claim routines only: the claim says that the pull request keeps a
   * behavior, so each command or request must give the same output on both
   * builds, once normalised.
   */
  same?: boolean;
};

/**
 * An exact check at the end of a routine: on the last command of a CLI app,
 * its exit code or a text in its output, or on the last response of an API,
 * its status or a text in its body.
 */
export type Assertion =
  | { kind: 'exit-code'; value: number }
  | { kind: 'output-includes'; value: string }
  | { kind: 'output-excludes'; value: string }
  | { kind: 'status'; value: number }
  | { kind: 'body-includes'; value: string }
  | { kind: 'body-excludes'; value: string };

/** One assertion after one replay. `actual` is what the command or the API gave, when the check is on a value. */
export type AssertionResult = { assertion: Assertion; ok: boolean; actual?: string };

/**
 * What the screen shows at the end of a repro while the bug is there. Each
 * part that is set must hold. The explorer names it when it reports the bug,
 * and Bugpatrol checks it against the screen right then.
 */
export type BugCheck = {
  /** Text on the last screen: an element's name, text, value or test id, or an API response body. */
  shows?: string;
  /** Text that the last screen lacks while the bug is there. */
  lacks?: string;
  /** Part of a console or network error that the flow logs. */
  error?: string;
};

export type ScreenTransition = {
  to: string;
  via?: string;
  kind: 'tap' | 'open' | 'back' | 'other';
  steps: number;
  count: number;
  lastSeenAt: string;
};

/** A screen the explorer found. `appmap.json` holds these. */
export type AppMapScreen = {
  /** Kebab-case, stable. The explorer names it; Bugpatrol de-duplicates it. */
  id: string;
  name: string;
  description: string;
  platform: Platform;
  /** URL, route, window title, or activity -- whatever the driver reports. */
  location?: string;
  /** Location and active window together, when known. */
  screenKey?: string;
  /** The routine that reaches this screen from a fresh session. */
  routineId?: string;
  /** Screens reached from this one, for the map. */
  links: string[];
  transitions?: ScreenTransition[];
  firstSeenAt: string;
  lastSeenAt: string;
  visits: number;
  /** Relative to the workspace root. */
  lastScreenshot?: string;
  baselineKey?: string;
};

export type AppMap = {
  version: 1;
  platform: Platform;
  summary?: string;
  screens: AppMapScreen[];
  updatedAt: string;
};

/**
 * A thing that might be wrong, before the judge has looked at it. It comes
 * from an invariant, a pixel diff, the decider, or the explorer's own eyes.
 */
export type Candidate = {
  id: string;
  sessionId: string;
  screenId?: string;
  source: 'invariant' | 'pixel-diff' | 'explorer' | 'decider';
  ruleId?: string;
  fingerprint: string;
  summary: string;
  detail?: string;
  severity: Severity;
  evidence: IssueEvidence;
  /** Where the decider routed it, and why. */
  route?: { to: 'judge' | 'issue' | 'ignore'; reason: string; confidence?: number };
  createdAt: string;
};

export type IssueEvidence = {
  screenshot?: string;
  baseline?: string;
  diff?: string;
  /** How to get there, as routine ids and then steps. */
  routineId?: string;
  steps?: RoutineStep[];
  /** The committed routine that replays `routineId` and then `steps`. Set when the issue is filed. */
  reproRoutineId?: string;
  /** How a replay of the flow tells that the bug shows. */
  bug?: BugCheck;
  console?: string[];
};

export type IssueStatus = 'new' | 'filed' | 'fixing' | 'fix-proposed' | 'fixed' | 'dismissed';

export type Issue = {
  version: 1;
  id: string;
  fingerprint: string;
  title: string;
  /** Markdown, written by the judge. */
  body: string;
  severity: Severity;
  status: IssueStatus;
  screenId?: string;
  candidateIds: string[];
  evidence: IssueEvidence;
  /** The judge's reason, kept so the call is auditable. */
  judgement: { by: string; reason: string; confidence?: number; at: string };
  occurrences: number;
  firstSeenAt: string;
  lastSeenAt: string;
  github?: {
    number: number;
    url: string;
    at: string;
    state?: 'open' | 'closed';
    stateReason?: 'completed' | 'not_planned' | 'reopened' | null;
    stateAt?: string;
    checkedAt?: string;
  };
  fixRejected?: { pr: number; url: string; at: string };
  publishSkipped?: { reason: string; at: string };
  fixId?: string;
  /** Set when a human closed the issue. A human decision overrides the judge. */
  closedBy?: { by: string; reason: string; at: string };
  regression?: { at: string; fromStatus: 'fixed' };
  notSeen?: number;
};

/** `declined`: the fixer read the code and found no bug to fix; its summary says why. */
export type FixStatus =
  | 'running'
  | 'retesting'
  | 'proposed'
  | 'declined'
  | 'failed'
  | 'verified'
  | 'opened'
  | 'rejected';

export type RetestOutcome = 'fixed' | 'not-fixed' | 'unclear' | 'error' | 'skipped';
/**
 * The retests that count as fix attempts: the ones with a verdict. A retest
 * that stopped on a setup error or was skipped says nothing about the fix.
 */
export function judgedRetests(retests: Retest[] = []): Retest[] {
  return retests.filter((retest) => retest.outcome !== 'error' && retest.outcome !== 'skipped');
}

export type RetestShot = {
  /** The screen the issue saw the problem on; undefined when unknown. */
  screenId?: string;
  routineId?: string;
  before?: string;
  after?: string;
  note?: string;
  reached?: boolean;
};

export type Retest = {
  build?: 'main';
  attempt: number;
  outcome: RetestOutcome;
  reason: string;
  /** What the explorer saw when it captured the after screenshot. */
  note?: string;
  explorerSessionId?: string;
  judgeSessionId?: string;
  /** Workspace-relative screenshot paths, same form as Issue.evidence.screenshot. */
  before?: string;
  after?: string;
  shots?: RetestShot[];
  at: string;
  costUsd?: number;
};

export type FixProposal = {
  version: 1;
  id: string;
  issueId: string;
  status: FixStatus;
  runtime: string;
  repo: string;
  branch: string;
  worktree: string;
  worktreeRemovedAt?: string;
  /** `git diff --stat` and the full diff, relative to the base commit. */
  diffStat?: string;
  diff?: string;
  /** The fix commit on the branch. A merge check trusts only this commit. */
  commit?: string;
  summary?: string;
  /** The `verify` command that passed on this change. */
  checks?: string;
  error?: string;
  startedAt: string;
  endedAt?: string;
  costUsd?: number;
  retests?: Retest[];
  pr?: {
    number: number;
    url: string;
    draft: boolean;
    at?: string;
    state?: 'open' | 'merged' | 'closed';
    stateAt?: string;
    checkedAt?: string;
  };
  /** The CI checks on the PR, and the fixer's attempts to make them pass. */
  ci?: {
    state: 'none' | 'pending' | 'passed' | 'failed' | 'gave-up';
    /** The commit that the checks ran on. */
    head?: string;
    failing?: string[];
    attempts: number;
    checkedAt: string;
  };
};

export type ReviewVerdict = 'introduced' | 'pre-existing' | 'not-a-bug' | 'unclear';

/** One explorer report on a pull request build, after the judge compared it with the base build. */
export type ReviewFinding = {
  candidateId: string;
  screenId?: string;
  verdict: ReviewVerdict;
  title: string;
  severity: Severity;
  reason: string;
  /** The changed line that causes an introduced problem, when the judge found it in the diff. */
  file?: string;
  line?: number;
  /** The flow, in words, from the routine to the problem. */
  steps: string[];
  /** Workspace-relative screenshots of the same flow on the two builds. */
  head?: string;
  base?: string;
  /** What happened when Bugpatrol repeated the flow on the base build. */
  baseNote?: string;
};

/**
 * Where a claim comes from. `section` is a claims section that the author
 * wrote in the pull request body; Bugpatrol takes it as written. The others
 * are the places the judge reads when it writes the claims itself.
 */
export type ClaimSource =
  | { kind: 'section' }
  | { kind: 'title' }
  | { kind: 'body' }
  | { kind: 'commit'; commit: string }
  | { kind: 'issue'; number: number };

/** One thing that a pull request says it does. */
export type Claim = {
  /** `claim-<n>`, in the order of the list. */
  id: string;
  text: string;
  /** The platform that a test of the claim needs. */
  platform: Platform;
  source: ClaimSource;
  testable: boolean;
  /** Why the claim cannot be tested ("clean up the code"). Set when `testable` is false. */
  untestable?: string;
};

export type ClaimVerdict = 'proven' | 'not-proven' | 'partly-proven' | 'untested';

/**
 * What a verdict rests on. `replay` is a bug check that code decides on a
 * replay, and `assertion` an exact check or an output diff. Only those two
 * are deterministic, so only they may ever fail a check (ADR 0001). A
 * verdict that the judge reads, also from the screens of a replay, is
 * `explored`.
 */
export type ClaimEvidence = 'replay' | 'assertion' | 'explored' | 'bench';

/** One replay of a claim routine on one build, with no model. */
export type ClaimReplay = {
  ok: boolean;
  /** Workspace-relative screenshots: the screen before the first step, then one after each step that ran. */
  shots: string[];
  /** Where a replay that failed partway stopped, counted from 0. */
  failedStep?: number;
  error?: string;
  /**
   * The recording of the replay, workspace-relative, when the driver can
   * record. `gif` is the short copy that a review shows inline. It is
   * absent when the recording does not fit the budget or does not convert.
   */
  recording?: { file: string; gif?: string };
  /** Issue repros only: whether the bug check of the repro routine held at the end of a full replay. */
  bug?: boolean;
  /** The assertions of the claim routine, checked at the end of a full replay. */
  assertions?: AssertionResult[];
  /** Same-behavior claims only: the normalised output of each command or request, in order. */
  outputs?: ClaimOutput[];
};

/** The output of one command or one response, normalised. `step` is the command or the request line. */
export type ClaimOutput = { step: string; text: string };

/** How the outputs of the two builds compared: the normalisation rules, then each output that differs. */
export type ClaimComparison = {
  rules: string[];
  /** `diff` has the lines of the base build after `- `, and the lines of the pull request build after `+ `. */
  parts: { step: string; diff: string }[];
};

/** The numbers of one benchmark on one build. The spread is from `min` to `max`. */
export type BenchBuild = { values: number[]; median: number; min: number; max: number };

/** One declared benchmark, run on both builds in turn. */
export type ClaimBench = {
  name: string;
  command: string;
  metric: string;
  better: 'lower' | 'higher';
  /** Runs on each build. */
  runs: number;
  head: BenchBuild;
  base: BenchBuild;
};

/** One claim of a pull request, with the verdict of the claim check. */
export type ClaimFinding = {
  claim: Claim;
  verdict: ClaimVerdict;
  /** Absent when nothing tested the claim. Bugpatrol sets it, never a model. */
  evidence?: ClaimEvidence;
  reason: string;
  /** What Bugpatrol saw on the pull request build. Always set on a `not-proven` verdict. */
  saw?: string;
  /** One sentence on what Bugpatrol did on both builds. */
  did?: string;
  /** The claim routine, workspace-relative. It lives in the run directory of the review only. */
  routine?: string;
  /** The steps of the claim routine, in words. */
  steps?: string[];
  head?: ClaimReplay;
  base?: ClaimReplay;
  /** The benchmark that measured a speed claim. */
  bench?: ClaimBench;
  /** Same-behavior claims only: the diff of the normalised outputs of both builds. */
  compared?: ClaimComparison;
  /**
   * The second replay on the pull request build. Blocking replays each
   * deterministic disproof again before it counts, and a different result
   * makes the verdict untested.
   */
  again?: ClaimReplay;
  /** Same-behavior claims only: the second replay on the base build, so the diff itself must repeat. */
  againBase?: ClaimReplay;
};

/**
 * The GitHub check run of the claim check, set only when `agents.review.block`
 * is on. Only a deterministic disproof that a second replay repeated fails it.
 */
export type ClaimCheckRun = {
  conclusion: 'neutral' | 'failure';
  title: string;
  /** Markdown: on a failure, each disproved claim and the evidence that disproved it. */
  summary: string;
  /** The check run on GitHub. Absent on a dry run. */
  url?: string;
};

/** `reviews/pr-<number>.json`: the last review of one pull request. */
export type PrReview = {
  version: 1;
  pr: { number: number; url: string; title: string };
  /** The pull request commit and its merge base: the two builds that the review compared. */
  head: string;
  base: string;
  baseRef: string;
  status: 'running' | 'finished' | 'failed';
  startedAt: string;
  endedAt?: string;
  sessions: {
    explorer?: string;
    base?: string;
    judge?: string;
    /** The judge that wrote the claims. */
    claims?: string;
    /** The replays of the claim routines on each build, and the judge that gave the claim verdicts. */
    headReplay?: string;
    baseReplay?: string;
    claimJudge?: string;
    /** The judge that picked the benchmarks. */
    benches?: string;
    /** The second replay of the disproved claims on the pull request build, when blocking is on. */
    againReplay?: string;
    /** The second replay of the disproved same-behavior claims on the base build. */
    againBaseReplay?: string;
  };
  /** The explorer's own account of what it tested. */
  tested?: string;
  /** The claim check. Absent when the claim check was off. */
  claims?: ClaimFinding[];
  /** The check run of the claim check. Absent when blocking is off. */
  check?: ClaimCheckRun;
  findings: ReviewFinding[];
  /** The review on GitHub. */
  posted?: { url: string; at: string };
  error?: string;
  costUsd: number;
};

export type AgentEventKind =
  | 'session-start'
  | 'session-end'
  | 'control-change'
  | 'human-action'
  | 'setup'
  | 'thought'
  | 'tool-call'
  | 'tool-result'
  | 'screen'
  | 'candidate'
  | 'issue'
  | 'fix'
  | 'lesson'
  | 'usage'
  | 'error';

/** One line of `sessions/<id>/events.jsonl`. Every value is already redacted. */
export type AgentEvent = {
  at: string;
  sessionId: string;
  role: AgentRole | 'decider' | 'system';
  kind: AgentEventKind;
  /** One short sentence for the activity feed. */
  summary: string;
  tool?: string;
  input?: unknown;
  output?: unknown;
  screenshot?: string;
  screenId?: string;
  costUsd?: number;
  /** The tokens of the model call behind this event. */
  tokens?: TokenUsage;
  /** The model that used them, when the runtime knows it. */
  model?: string;
  durationMs?: number;
};

export type AgentState = 'idle' | 'working' | 'waiting' | 'failed' | 'off';

export type AgentStatus = {
  role: AgentRole;
  state: AgentState;
  runtime: string;
  /** What the agent does now, in one short sentence. */
  activity?: string;
  sessionId?: string;
  updatedAt: string;
  spentUsd: number;
  /** The process that wrote this. A reader treats "working" from a dead process as stopped. */
  pid?: number;
};

/** `agents.json`. */
export type AgentsFile = {
  version: 1;
  patrol?: {
    cycle: number;
    state: 'running' | 'stopped';
    startedAt: string;
    nextAt?: string;
    pid?: number;
    /** The source commit that the last full cycle tested. */
    commit?: string;
  };
  agents: AgentStatus[];
};

export type SessionSummary = {
  version: 1;
  id: string;
  role: AgentRole;
  /** The process that runs the session, so a crash does not look like a session in progress. */
  pid?: number;
  startedAt: string;
  endedAt?: string;
  status: 'running' | 'finished' | 'failed';
  summary?: string;
  steps: number;
  costUsd: number;
  /** The sum of the tokens on the session's events. */
  tokens?: TokenUsage;
  /** The same tokens for each model, for example the explorer's LLM and the reflect model. */
  tokensByModel?: Record<string, TokenUsage>;
  screensFound: string[];
  candidates: number;
  issues: string[];
};

/**
 * `triage.json`. The judge's decisions, keyed by fingerprint. A fingerprint
 * here is not raised again: a filed one adds an occurrence to its issue, a
 * dismissed one stays quiet. Pixel diffs are never recorded here, because an
 * accepted visual change resets the baseline instead.
 */
export type TriageFile = {
  version: 1;
  fingerprints: Record<string, { decision: 'filed' | 'dismissed'; issueId?: string; reason: string; at: string }>;
};
