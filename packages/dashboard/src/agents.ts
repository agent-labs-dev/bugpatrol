import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, relative, sep } from 'node:path';
import {
  type AgentEvent,
  type AgentRole,
  type AgentStatus,
  type AgentsFile,
  type AppMap,
  addUsage,
  type BugpatrolConfig,
  type Candidate,
  type ClaimVerdict,
  type FixProposal,
  fixerAttempts,
  type Issue,
  loadConfig,
  type MemoryFile,
  type PrReview,
  paths,
  type Routine,
  type SessionFlow,
  type SessionSummary,
  type TokenUsage,
  usageOf,
} from '@bugpatrol/core';

const roles: AgentRole[] = ['explorer', 'judge', 'fixer'];
const severity = { critical: 0, major: 1, minor: 2, cosmetic: 3 };
const open = new Set(['new', 'filed', 'fixing', 'fix-proposed']);
type ScreenEdge = {
  from: string;
  to: string;
  kind: 'tap' | 'open' | 'back' | 'other' | 'route';
  via?: string;
  count: number;
  steps: number;
};
type DashboardScreen =
  | (AppMap['screens'][number] & { openIssues: number; virtual?: false })
  | { id: '__start'; name: 'App start'; virtual: true; openIssues: 0 };

/** Files are written by live agents; a torn or missing read is ordinary, not a server failure. */
function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function list(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Every file under a directory, at any depth. */
function walk(dir: string): string[] {
  return list(dir).flatMap((name) => {
    const path = join(dir, name);
    try {
      return statSync(path).isDirectory() ? walk(path) : [path];
    } catch {
      return [];
    }
  });
}

function jsonLines<T>(file: string): T[] {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  // The last line can be in flight. A complete but invalid line is skipped too.
  return raw.split('\n').flatMap((line) => {
    try {
      return line.trim() ? [JSON.parse(line) as T] : [];
    } catch {
      return [];
    }
  });
}

/**
 * A status file says what a process was doing when it last wrote. When that
 * process is gone (killed, crashed, the laptop slept), "working" is a lie, so
 * the reader checks the pid before it believes it. A record with no pid is
 * taken at its word.
 */
function processAlive(pid: number | undefined): boolean {
  if (!pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const STOPPED = 'Stopped: its process ended.';

const verdictOrder: ClaimVerdict[] = ['proven', 'partly-proven', 'not-proven', 'untested'];
type ReviewRow = Omit<PrReview, 'claims' | 'findings' | 'sessions' | 'tested'> & {
  /** How many claims got each verdict. Absent when the claim check was off. */
  verdicts?: Partial<Record<ClaimVerdict, number>>;
  /** The problems that the pull request introduced. */
  introduced: number;
};
/** A video, an animated image, or a terminal cast that a claim replay recorded. */
type Recording = { path: string; kind: 'video' | 'image' | 'cast'; claimId?: string; build?: 'head' | 'base' };
const recordingKinds: Record<string, Recording['kind']> = {
  '.mp4': 'video',
  '.webm': 'video',
  '.gif': 'image',
  '.webp': 'image',
  '.cast': 'cast',
};

export class AgentReader {
  constructor(
    private readonly root: string,
    private readonly configFile?: string,
  ) {}

  memory(): MemoryFile {
    const value = readJson<MemoryFile>(paths.memory(this.root));
    return Array.isArray(value?.lessons) ? value : { version: 1, lessons: [] };
  }

  agents(): AgentsFile | undefined {
    const value = readJson<AgentsFile>(paths.agents(this.root));
    if (!Array.isArray(value?.agents)) return undefined;
    const agents = value.agents
      .filter((agent) => agent && roles.includes(agent.role) && typeof agent.state === 'string')
      .map((agent) => {
        const busy = agent.state === 'working' || agent.state === 'waiting';
        return busy && !processAlive(agent.pid) ? { ...agent, state: 'idle' as const, activity: STOPPED } : agent;
      });
    const patrol =
      value.patrol?.state === 'running' && !processAlive(value.patrol.pid)
        ? { ...value.patrol, state: 'stopped' as const, nextAt: undefined }
        : value.patrol;
    return { ...value, agents, patrol };
  }

  appmap(): AppMap {
    const value = readJson<AppMap>(paths.appMap(this.root));
    if (!Array.isArray(value?.screens)) return { version: 1, platform: 'web', screens: [], updatedAt: '' };
    return {
      ...value,
      screens: value.screens.filter(
        (screen) => screen && typeof screen.id === 'string' && typeof screen.lastSeenAt === 'string',
      ),
    };
  }

  issues(): (Issue & { pr?: FixProposal['pr'] & { ci?: string } })[] {
    const fixes = this.fixes();
    return list(paths.issues(this.root))
      .filter((name) => name.endsWith('.json'))
      .map((name) => readJson<Issue>(join(paths.issues(this.root), name)))
      .filter((issue): issue is Issue =>
        Boolean(
          issue?.id &&
            issue.title &&
            issue.lastSeenAt &&
            issue.evidence &&
            issue.judgement &&
            Array.isArray(issue.candidateIds),
        ),
      )
      .map((issue) => {
        const fix = fixes.find((entry) => entry.id === issue.fixId || entry.issueId === issue.id);
        return { ...issue, pr: fix?.pr ? { ...fix.pr, ci: fix.ci?.state } : undefined };
      })
      .sort(
        (a, b) => (severity[a.severity] ?? 9) - (severity[b.severity] ?? 9) || b.lastSeenAt.localeCompare(a.lastSeenAt),
      );
  }

  fixes(): FixProposal[] {
    return list(paths.fixes(this.root))
      .filter((name) => name.endsWith('.json'))
      .map((name) => readJson<FixProposal>(join(paths.fixes(this.root), name)))
      .filter((fix): fix is FixProposal => Boolean(fix?.id && fix.issueId));
  }

  routines(): Routine[] {
    return list(paths.routines(this.root))
      .filter((name) => name.endsWith('.json'))
      .map((name) => readJson<Routine>(join(paths.routines(this.root), name)))
      .filter((routine): routine is Routine => Boolean(routine?.id && Array.isArray(routine.steps)));
  }

  sessions(limit = 50): SessionSummary[] {
    return list(paths.sessions(this.root))
      .filter((id) => /^[\w-]+$/.test(id))
      .map((id) => ({ id, value: readJson<SessionSummary>(join(paths.session(this.root, id), 'session.json')) }))
      .filter(({ id, value }) => value?.id === id)
      .map(({ value }) => value)
      .filter((session): session is SessionSummary =>
        Boolean(
          session?.id && session.startedAt && Array.isArray(session.screensFound) && Array.isArray(session.issues),
        ),
      )
      .map((session) =>
        session.status === 'running' && !processAlive(session.pid)
          ? { ...session, status: 'failed' as const, summary: session.summary ?? `Interrupted. ${STOPPED}` }
          : session,
      )
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, limit);
  }

  session(id: string): { session: SessionSummary; events: AgentEvent[]; candidates: Candidate[] } | undefined {
    const session = this.sessions(Infinity).find((entry) => entry.id === id);
    if (!session) return undefined;
    const dir = paths.session(this.root, id);
    const events = jsonLines<AgentEvent>(join(dir, 'events.jsonl'));
    return {
      // A running session has no totals yet: add up its events so far.
      session: session.status === 'running' ? { ...session, ...usageOf(events) } : session,
      events,
      candidates: jsonLines<Candidate>(join(dir, 'candidates.jsonl')),
    };
  }

  /** One session's merged flow view: actions, failed requests, backend logs. */
  flow(id: string): SessionFlow | undefined {
    return readJson<SessionFlow>(paths.sessionFlow(this.root, id));
  }

  issue(id: string):
    | {
        issue: Issue;
        fix?: FixProposal;
        gaveUpAfter?: number;
        attemptDiffs?: Record<number, string>;
        candidates: Candidate[];
        routine?: Routine;
      }
    | undefined {
    const issue = this.issues().find((entry) => entry.id === id);
    if (!issue) return undefined;
    const fix = this.fixes().find((entry) => entry.id === issue.fixId || entry.issueId === id);
    const routine = this.routines().find((entry) => entry.id === issue.evidence?.routineId);
    const ids = new Set(issue.candidateIds);
    const candidates = this.sessions(Infinity)
      .flatMap((session) => jsonLines<Candidate>(join(paths.session(this.root, session.id), 'candidates.jsonl')))
      .filter((candidate) => ids.has(candidate.id));
    return {
      issue,
      fix,
      gaveUpAfter: fix && this.gaveUpAfter(fix),
      attemptDiffs: fix && this.attemptDiffs(fix),
      candidates,
      routine,
    };
  }

  /** Each attempt's diff file that exists, by attempt number, as an artifact path. */
  private attemptDiffs(fix: FixProposal): Record<number, string> {
    return Object.fromEntries(
      (fix.attempts ?? [])
        .map((attempt) => [attempt.n, paths.fixAttemptDiff(this.root, fix.id, attempt.n)] as const)
        .filter(([, file]) => existsSync(file))
        .map(([n, file]) => [n, relative(this.root, file).split(sep).join('/')]),
    );
  }

  /** The fixer's attempt count, when this fix failed and reached the limit. CI fix attempts have their own limit. */
  private gaveUpAfter(fix: FixProposal): number | undefined {
    const limit = this.config()?.agents.fixer.attempts;
    const count = fixerAttempts(fix.attempts).length;
    if (fix.status !== 'failed' || limit === undefined) return undefined;
    return count >= limit ? count : undefined;
  }

  screens(): Omit<AppMap, 'screens'> & { screens: DashboardScreen[]; edges: ScreenEdge[]; entryId?: string } {
    const map = this.appmap();
    const issues = this.issues().filter((issue) => open.has(issue.status));
    const ids = new Set(map.screens.map((screen) => screen.id));
    const routines = this.routines();
    const byRoutine = new Map(routines.map((routine) => [routine.id, routine]));
    const screenByRoutine = new Map(
      map.screens.filter((screen) => screen.routineId).map((screen) => [screen.routineId!, screen.id]),
    );
    for (const routine of routines)
      if (routine.screenId && ids.has(routine.screenId) && !screenByRoutine.has(routine.id)) {
        screenByRoutine.set(routine.id, routine.screenId);
      }
    const edges = map.screens
      .flatMap<ScreenEdge>((screen) => {
        if (screen.transitions?.length)
          return screen.transitions.map((edge) => ({
            from: screen.id,
            to: edge.to,
            kind: edge.kind,
            via: edge.via,
            count: edge.count,
            steps: edge.steps,
          }));
        const routine =
          byRoutine.get(screen.routineId ?? '') ??
          byRoutine.get(`screen-${screen.id}`) ??
          routines.find((item) => item.screenId === screen.id);
        if (routine?.requires?.length)
          return routine.requires.flatMap((id) => {
            const from = screenByRoutine.get(id);
            return from ? [{ from, to: screen.id, kind: 'route' as const, via: 'route', count: 1, steps: 0 }] : [];
          });
        return screen.links.map((to) => ({
          from: screen.id,
          to,
          kind: 'other' as const,
          via: undefined,
          count: 1,
          steps: 0,
        }));
      })
      .filter((edge) => edge.from !== edge.to && ids.has(edge.from) && ids.has(edge.to));
    for (const screen of map.screens) {
      if (edges.some((edge) => edge.to === screen.id && edge.kind !== 'back')) continue;
      const routine = byRoutine.get(screen.routineId ?? '') ?? byRoutine.get(`screen-${screen.id}`);
      if (!routine) continue;
      if (!routine.requires?.length || routine.requires.some((id) => !screenByRoutine.has(id))) {
        edges.push({ from: '__start', to: screen.id, kind: 'route', via: 'route', count: 1, steps: 0 });
      }
    }
    // In a cycle, every screen has an edge in. The app then starts on the
    // screen that enter-app reaches, or else on the first recorded screen.
    if (map.screens.length && !edges.some((edge) => edge.from === '__start')) {
      const entry =
        byRoutine
          .get('enter-app')
          ?.requires?.map((id) => screenByRoutine.get(id))
          .find(Boolean) ?? map.screens[0]!.id;
      edges.push({ from: '__start', to: entry, kind: 'route', via: 'route', count: 1, steps: 0 });
    }
    const screens: DashboardScreen[] = map.screens.map((screen) => ({
      ...screen,
      openIssues: issues.filter((issue) => issue.screenId === screen.id).length,
    }));
    if (screens.length) screens.push({ id: '__start', name: 'App start', virtual: true, openIssues: 0 });
    return { ...map, screens, edges, entryId: screens.length ? '__start' : undefined };
  }

  /** Every stored review, newest first, as one row each: the claims become a count per verdict. */
  reviews(): ReviewRow[] {
    return this.reviewRecords()
      .map(({ claims, findings, sessions: _, tested: __, ...review }) => {
        const verdicts = claims && Object.fromEntries(verdictOrder.map((verdict) => [verdict, 0]));
        for (const finding of claims ?? []) verdicts![finding.verdict] = (verdicts![finding.verdict] ?? 0) + 1;
        const introduced = findings.filter((finding) => finding.verdict === 'introduced').length;
        return { ...review, ...(verdicts ? { verdicts } : {}), introduced };
      })
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /**
   * One review and the recordings in its run directory. A recording names its
   * claim and build in its path (`claim-1/head.mp4`), so the page can put it
   * next to that claim. One that names neither still shows, on its own.
   */
  review(pr: number): { review: PrReview; recordings: Recording[] } | undefined {
    const review = this.reviewRecords().find((entry) => entry.pr.number === pr);
    if (!review) return undefined;
    const recordings = walk(paths.reviewDir(this.root, pr))
      .map((file) => ({ file, kind: recordingKinds[extname(file).toLowerCase()] }))
      .filter((entry): entry is { file: string; kind: Recording['kind'] } => Boolean(entry.kind))
      .map(({ file, kind }) => {
        const path = relative(this.root, file).split(sep).join('/');
        const inside = relative(paths.reviewDir(this.root, pr), file);
        const claimId = inside.match(/\bclaim-\d+(?!\d)/)?.[0];
        const build = inside.match(/\b(head|base)\b/)?.[1] as Recording['build'];
        return { path, kind, ...(claimId ? { claimId } : {}), ...(build ? { build } : {}) };
      })
      .sort((a, b) => a.path.localeCompare(b.path));
    return { review, recordings };
  }

  private reviewRecords(): PrReview[] {
    const dir = dirname(paths.review(this.root, 0));
    return list(dir)
      .filter((name) => /^pr-\d+\.json$/.test(name))
      .map((name) => readJson<PrReview>(join(dir, name)))
      .filter((review): review is PrReview =>
        Boolean(
          review?.pr &&
            Number.isInteger(review.pr.number) &&
            review.head &&
            review.startedAt &&
            Array.isArray(review.findings),
        ),
      );
  }

  /** Each role as the config sets it, in the same form as the runtime labels. */
  private configuredAgents(): Record<AgentRole, { enabled: boolean; runtime: string }> | undefined {
    const config = this.config();
    if (!config) return undefined;
    return Object.fromEntries(
      roles.map((role) => {
        const { enabled, use } = config.agents[role];
        const runtime = use.runtime === 'cli' ? `cli:${use.command.split(/\s+/)[0]}` : `model:${use.via}/${use.model}`;
        return [role, { enabled, runtime }];
      }),
    ) as Record<AgentRole, { enabled: boolean; runtime: string }>;
  }

  /** Undefined when the project has no config, unless the dashboard was given one. */
  private config(): BugpatrolConfig | undefined {
    try {
      return loadConfig(this.root, {}, this.configFile);
    } catch (error) {
      if (this.configFile) throw error;
      return undefined;
    }
  }

  overview(now = new Date()): object {
    const agentFile = this.agents();
    const appmap = this.appmap();
    const issues = this.issues();
    const sessions = this.sessions(Infinity);
    const today = now.toLocaleDateString('en-CA');
    const configured = this.configuredAgents();
    // A role with no entry has not run yet: show it from the config, not as off.
    const agents: AgentStatus[] = roles.map(
      (role) =>
        agentFile?.agents.find((agent) => agent.role === role) ?? {
          role,
          state: configured?.[role].enabled === false ? 'off' : configured ? 'idle' : 'off',
          runtime: configured?.[role].runtime ?? '',
          updatedAt: '',
          spentUsd: 0,
        },
    );
    const active = sessions.find((session) => session.status === 'running');
    const detail = active ? this.session(active.id) : undefined;
    const events = detail?.events.filter(isFeedEvent).slice(-12) ?? [];
    const screenshot = [...(detail?.events ?? [])].reverse().find((event) => event.screenshot)?.screenshot;
    const openIssues = issues.filter((issue) => open.has(issue.status));
    const fixes = this.fixes();
    // Every open issue, so the list and the "open" count agree while the fixer works.
    const attention = openIssues.slice(0, 8).map((issue) => {
      const fix = fixes.find((entry) => entry.id === issue.fixId || entry.issueId === issue.id);
      return {
        ...issue,
        pr: fix?.pr ? { ...fix.pr, ci: fix.ci?.state } : undefined,
        fix: fix ? { status: fix.status } : undefined,
      };
    });
    const prStates = fixes.map((fix) => fix.pr?.state).filter(Boolean);
    const issueStates = issues.map((issue) => issue.github?.state).filter(Boolean);
    const github =
      fixes.some((fix) => fix.pr) || issues.some((issue) => issue.github)
        ? `PRs: ${['open', 'merged', 'closed'].map((state) => `${prStates.filter((item) => item === state).length} ${state}`).join(' · ')} · ` +
          `Issues: ${['open', 'closed'].map((state) => `${issueStates.filter((item) => item === state).length} ${state}`).join(' · ')}`
        : undefined;
    return {
      project: { name: basename(this.root), platform: appmap.platform },
      patrol: agentFile?.patrol ?? { state: 'stopped', cycle: 0 },
      agents,
      counts: {
        issuesOpen: openIssues.length,
        issuesBySeverity: Object.fromEntries(
          Object.keys(severity).map((key) => [key, openIssues.filter((issue) => issue.severity === key).length]),
        ),
        fixesProposed: fixes.filter((fix) => fix.status === 'proposed').length,
        screens: appmap.screens.length,
        sessionsToday: sessions.filter((session) => new Date(session.startedAt).toLocaleDateString('en-CA') === today)
          .length,
        spentTodayUsd: sessions
          .filter((session) => new Date(session.startedAt).toLocaleDateString('en-CA') === today)
          .reduce((sum, session) => sum + session.costUsd, 0),
      },
      usage: usageReport(sessions, now),
      attention,
      github,
      live: detail ? { summary: detail.session, events, screenshot } : null,
      recentSessions: sessions.slice(0, 6),
      screens: [...appmap.screens].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt)).slice(0, 8),
    };
  }
}

/**
 * The feed shows what the agent did, not how it thought about it. Reasoning
 * and the raw tool call are one level down (the session timeline's toggle);
 * a tool result with an empty summary is one that another event already
 * reports, such as a recorded screen.
 */
type UsageRow = { role: AgentRole; model: string; sessions: number; tokens: TokenUsage };

/**
 * Tokens today for each agent, and the tokens of the last 7 days for each
 * agent and model, with the number of sessions, so that two models on the same
 * agent can be compared per session.
 */
export function usageReport(
  sessions: SessionSummary[],
  now = new Date(),
): {
  todayByRole: Partial<Record<AgentRole, TokenUsage>>;
  week: UsageRow[];
  weekTotal?: TokenUsage;
} {
  const today = now.toLocaleDateString('en-CA');
  const weekStart = now.getTime() - 7 * 24 * 3_600_000;
  const todayByRole: Partial<Record<AgentRole, TokenUsage>> = {};
  const rows = new Map<string, UsageRow>();
  let weekTotal: TokenUsage | undefined;
  for (const session of sessions) {
    if (!session.tokens) continue;
    const started = new Date(session.startedAt);
    if (started.toLocaleDateString('en-CA') === today)
      todayByRole[session.role] = addUsage(todayByRole[session.role], session.tokens);
    if (started.getTime() < weekStart) continue;
    weekTotal = addUsage(weekTotal, session.tokens);
    for (const [model, tokens] of Object.entries(session.tokensByModel ?? { unknown: session.tokens })) {
      const key = `${session.role}\u0000${model}`;
      const row = rows.get(key) ?? { role: session.role, model, sessions: 0, tokens: { input: 0, output: 0 } };
      row.sessions++;
      row.tokens = addUsage(row.tokens, tokens)!;
      rows.set(key, row);
    }
  }
  const week = [...rows.values()].sort(
    (a, b) =>
      roles.indexOf(a.role) - roles.indexOf(b.role) ||
      b.tokens.input + b.tokens.output - (a.tokens.input + a.tokens.output),
  );
  return { todayByRole, week, ...(weekTotal ? { weekTotal } : {}) };
}

function isFeedEvent(event: AgentEvent): boolean {
  if (event.kind === 'thought' || event.kind === 'tool-call') return false;
  return event.summary.trim().length > 0;
}
