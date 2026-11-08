import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import {
  type AgentEvent,
  type AgentRole,
  type AgentStatus,
  type AgentsFile,
  type AppMap,
  type AppMapScreen,
  type Candidate,
  type CoverageFile,
  type DeployFile,
  type FixProposal,
  type HttpExchange,
  type Issue,
  type Lesson,
  type LessonRole,
  type LogRecord,
  layout,
  type MemoryFile,
  type PrReview,
  paths,
  type Routine,
  type ScreenTransition,
  type SessionFlow,
  type SessionSignal,
  type SessionSummary,
  shortHash,
  type TriageFile,
  usageOf,
  withCapture,
} from '@bugpatrol/core';
import type { EventSink } from './types.js';
import type { Vars } from './vars.js';

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

async function atomic(file: string, value: unknown): Promise<void> {
  await mkdir(join(file, '..'), { recursive: true });
  // Unique per write, not per process: two writes in one process with one
  // temp name race, and the loser's rename fails or leaves torn JSON.
  const temp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temp, file);
}

const fileLocks = new Map<string, Promise<unknown>>();
const eventWrites = new Map<string, Promise<void>>();

/**
 * Read-modify-write on one file, one at a time. Every AgentSession has its
 * own Workspace, so the lock is keyed by path at module level, not held by
 * an instance.
 */
function serialized<T>(file: string, update: () => Promise<T>): Promise<T> {
  const previous = fileLocks.get(file) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(update);
  fileLocks.set(file, next);
  return next;
}

async function listJson<T>(dir: string): Promise<T[]> {
  try {
    const files = (await readdir(dir)).filter((file) => file.endsWith('.json'));
    return Promise.all(files.map(async (file) => (await readJson<T>(join(dir, file))) as T));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

/** State stays plain JSON so a dashboard and a human can inspect the same data. */
export class Workspace {
  /**
   * `profile` picks the committed app map and routines and the local state
   * under `runs/` (`config.profile`, see profileOf).
   */
  constructor(
    readonly root: string,
    readonly profile?: string,
  ) {}

  private current<T extends Issue | Candidate>(record: T): T {
    return withCapture(record, layout(this.root).dir);
  }

  async readMemory(): Promise<MemoryFile> {
    return (await readJson<MemoryFile>(paths.memory(this.root, this.profile))) ?? { version: 1, lessons: [] };
  }

  upsertLessons(lessons: Omit<Lesson, 'id' | 'hits' | 'createdAt' | 'lastSeenAt'>[]): Promise<Lesson[]> {
    return serialized(paths.memory(this.root, this.profile), async () => {
      const memory = await this.readMemory();
      const now = new Date().toISOString();
      const saved: Lesson[] = [];
      for (const lesson of lessons) {
        const text = lesson.text.trim();
        if (!text) continue;
        const id = `les_${shortHash(`${lesson.role}:${text.toLowerCase().replace(/\s+/g, ' ')}`)}`;
        const previous = memory.lessons.find((item) => item.id === id);
        const next: Lesson = {
          ...lesson,
          id,
          text,
          hits: (previous?.hits ?? 0) + 1,
          createdAt: previous?.createdAt ?? now,
          lastSeenAt: now,
        };
        if (previous) memory.lessons.splice(memory.lessons.indexOf(previous), 1, next);
        else memory.lessons.push(next);
        saved.push(next);
      }
      for (const role of ['explorer', 'judge', 'fixer'] as LessonRole[]) {
        const active = memory.lessons
          .filter((item) => item.role === role && !item.retired)
          .sort((a, b) => a.lastSeenAt.localeCompare(b.lastSeenAt));
        for (const lesson of active.slice(0, Math.max(0, active.length - 40))) {
          lesson.retired = { at: now, reason: 'Pruned: not seen recently' };
        }
      }
      await atomic(paths.memory(this.root, this.profile), memory);
      return saved;
    });
  }

  retireLesson(id: string, reason: string): Promise<void> {
    return serialized(paths.memory(this.root, this.profile), async () => {
      const memory = await this.readMemory();
      const lesson = memory.lessons.find((item) => item.id === id);
      if (!lesson) throw new Error(`Unknown lesson ${id}`);
      lesson.retired = { at: new Date().toISOString(), reason };
      await atomic(paths.memory(this.root, this.profile), memory);
    });
  }

  removeLesson(id: string): Promise<void> {
    return serialized(paths.memory(this.root, this.profile), async () => {
      const memory = await this.readMemory();
      const next = memory.lessons.filter((item) => item.id !== id);
      if (next.length === memory.lessons.length) throw new Error(`Unknown lesson ${id}`);
      await atomic(paths.memory(this.root, this.profile), { version: 1, lessons: next });
    });
  }

  async readEvents(sessionId: string): Promise<AgentEvent[]> {
    await eventWrites.get(join(paths.session(this.root, sessionId, this.profile), 'events.jsonl'));
    try {
      const raw = await readFile(join(paths.session(this.root, sessionId, this.profile), 'events.jsonl'), 'utf8');
      return raw.split('\n').flatMap((line) => {
        try {
          return line.trim() ? [JSON.parse(line) as AgentEvent] : [];
        } catch {
          return [];
        }
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  readAppMap(): Promise<AppMap | undefined> {
    return readJson(paths.appMap(this.root, this.profile));
  }

  async writeAppMap(map: AppMap): Promise<void> {
    await atomic(paths.appMap(this.root, this.profile), map);
  }

  /** The sweep's coverage cells and cursor. Absent before the first sweep. */
  readCoverage(): Promise<CoverageFile | undefined> {
    return readJson(paths.coverage(this.root, this.profile));
  }

  async writeCoverage(coverage: CoverageFile): Promise<void> {
    await atomic(paths.coverage(this.root, this.profile), coverage);
  }

  /** The last probe of `app.connect.version`. Absent before the first probe. */
  readDeploy(): Promise<DeployFile | undefined> {
    return readJson(paths.deploy(this.root, this.profile));
  }

  async writeDeploy(deploy: DeployFile): Promise<void> {
    await atomic(paths.deploy(this.root, this.profile), deploy);
  }

  async upsertScreen(screen: Partial<AppMapScreen> & Pick<AppMapScreen, 'id'>): Promise<AppMapScreen> {
    const now = new Date().toISOString();
    const map = await this.readAppMap();
    const previous = map?.screens.find((item) => item.id === screen.id);
    const transitions = [...(previous?.transitions ?? [])];
    for (const incoming of screen.transitions ?? []) {
      const found = transitions.find(
        (item) => item.to === incoming.to && item.kind === incoming.kind && item.via === incoming.via,
      );
      if (found) {
        found.count += 1;
        found.steps = Math.min(found.steps, incoming.steps);
        found.lastSeenAt = now;
      } else transitions.push({ ...incoming, count: 1, lastSeenAt: now } satisfies ScreenTransition);
    }
    const merged: AppMapScreen = {
      name: screen.name ?? previous?.name ?? screen.id,
      description: screen.description ?? previous?.description ?? '',
      platform: screen.platform ?? previous?.platform ?? map?.platform ?? 'web',
      firstSeenAt: previous?.firstSeenAt ?? now,
      ...previous,
      ...screen,
      id: screen.id,
      links: [...new Set([...(previous?.links ?? []), ...(screen.links ?? [])])],
      ...(transitions.length ? { transitions } : {}),
      visits: (previous?.visits ?? 0) + (screen.visits ?? 1),
      lastSeenAt: screen.lastSeenAt ?? now,
      lastCapture: screen.lastCapture ?? previous?.lastCapture,
    };
    const screens = [...(map?.screens ?? []).filter((item) => item.id !== screen.id), merged];
    await atomic(paths.appMap(this.root, this.profile), {
      version: 1,
      platform: map?.platform ?? merged.platform,
      screens,
      ...(map?.endpoints ? { endpoints: map.endpoints } : {}),
      updatedAt: now,
    });
    return merged;
  }

  listRoutines(): Promise<Routine[]> {
    return listJson(paths.routines(this.root, this.profile));
  }
  readRoutine(id: string): Promise<Routine | undefined> {
    return readJson(paths.routine(this.root, id, this.profile));
  }
  saveRoutine(value: Routine): Promise<void> {
    return atomic(paths.routine(this.root, value.id, this.profile), value);
  }
  async listIssues(): Promise<Issue[]> {
    return (await listJson<Issue>(paths.issues(this.root, this.profile))).map((issue) => this.current(issue));
  }
  async readIssue(id: string): Promise<Issue | undefined> {
    const issue = await readJson<Issue>(paths.issue(this.root, id, this.profile));
    return issue && this.current(issue);
  }
  saveIssue(value: Issue): Promise<void> {
    return atomic(paths.issue(this.root, value.id, this.profile), value);
  }
  async findIssueByFingerprint(fingerprint: string): Promise<Issue | undefined> {
    return (await this.listIssues()).find((issue) => issue.fingerprint === fingerprint);
  }
  listFixes(): Promise<FixProposal[]> {
    return listJson(paths.fixes(this.root, this.profile));
  }
  readFix(id: string): Promise<FixProposal | undefined> {
    return readJson(paths.fix(this.root, id, this.profile));
  }
  saveFix(value: FixProposal): Promise<void> {
    return atomic(paths.fix(this.root, value.id, this.profile), value);
  }
  async readFixAttemptDiff(id: string, n: number): Promise<string | undefined> {
    try {
      return await readFile(paths.fixAttemptDiff(this.root, id, n, this.profile), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
  async saveFixAttemptDiff(id: string, n: number, diff: string): Promise<void> {
    const file = paths.fixAttemptDiff(this.root, id, n, this.profile);
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, diff);
  }

  readReview(pr: number): Promise<PrReview | undefined> {
    return readJson(paths.review(this.root, pr, this.profile));
  }
  saveReview(value: PrReview): Promise<void> {
    return atomic(paths.review(this.root, value.pr.number, this.profile), value);
  }

  /** The session header, as written by `startSession`. */
  async readSession(id: string): Promise<SessionSummary | undefined> {
    return readJson<SessionSummary>(join(paths.session(this.root, id, this.profile), 'session.json'));
  }

  /**
   * Keep the app's own failures with the moment they were seen. A failed
   * request is the link between a user action and the backend's logs, so it is
   * recorded as it happens rather than reconstructed afterwards.
   */
  async appendSignals(sessionId: string, signals: SessionSignal[]): Promise<void> {
    if (signals.length === 0) return;
    await mkdir(paths.session(this.root, sessionId, this.profile), { recursive: true });
    await appendFile(
      paths.sessionSignals(this.root, sessionId, this.profile),
      `${signals.map((signal) => JSON.stringify(signal)).join('\n')}\n`,
    );
  }

  async readSignals(sessionId: string): Promise<SessionSignal[]> {
    try {
      const text = (await readFile(paths.sessionSignals(this.root, sessionId, this.profile), 'utf8')).trim();
      return text === '' ? [] : text.split('\n').map((line) => JSON.parse(line) as SessionSignal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  /** The backend logs one session collected, and its merged flow view. */
  async saveSessionLogs(sessionId: string, logs: LogRecord[]): Promise<void> {
    await atomic(paths.sessionLogs(this.root, sessionId, this.profile), { version: 1, records: logs });
  }

  async saveSessionFlow(sessionId: string, flow: SessionFlow): Promise<void> {
    await atomic(paths.sessionFlow(this.root, sessionId, this.profile), flow);
  }

  /** `revision`: the revision of the app that the session tests, when it is known. */
  async startSession(role: AgentRole, revision?: string): Promise<SessionSummary> {
    const now = new Date();
    const id = `ses_${now
      .toISOString()
      .replace(/[-:TZ.]/g, '')
      .slice(0, 14)}_${randomBytes(2).toString('hex')}`;
    const session: SessionSummary = {
      version: 1,
      id,
      role,
      ...(this.profile && { profile: this.profile }),
      pid: process.pid,
      ...(revision && { revision }),
      startedAt: now.toISOString(),
      status: 'running',
      steps: 0,
      costUsd: 0,
      screensFound: [],
      candidates: 0,
      issues: [],
    };
    await atomic(join(paths.session(this.root, id, this.profile), 'session.json'), session);
    return session;
  }

  async appendEvent(sessionId: string, event: Omit<AgentEvent, 'at'>): Promise<void> {
    const dir = paths.session(this.root, sessionId, this.profile);
    await mkdir(dir, { recursive: true });
    await appendFile(join(dir, 'events.jsonl'), `${JSON.stringify({ ...event, at: new Date().toISOString() })}\n`);
  }

  /**
   * Saves one capture of a session as `NNN-<label>.png`, or for an API as
   * `NNN-<label>.exchange.json`, and returns the workspace-relative file.
   */
  async saveCapture(
    sessionId: string,
    capture: { kind: 'image'; png: Buffer } | { kind: 'http'; exchange: HttpExchange },
    label: string,
  ): Promise<string> {
    const dir = paths.session(this.root, sessionId, this.profile);
    await mkdir(dir, { recursive: true });
    const files = await readdir(dir);
    const number = files.filter((file) => /^\d{3}-.*\.(?:png|exchange\.json)$/.test(file)).length + 1;
    const name = `${String(number).padStart(3, '0')}-${basename(label).replace(/[^a-zA-Z0-9_-]/g, '-')}`;
    const file = join(dir, capture.kind === 'image' ? `${name}.png` : `${name}.exchange.json`);
    await writeFile(file, capture.kind === 'image' ? capture.png : `${JSON.stringify(capture.exchange, null, 2)}\n`);
    return relative(this.root, file);
  }

  /**
   * Saves the text of a terminal beside its capture, as
   * `NNN-<label>.terminal.txt`, and returns the workspace-relative file.
   */
  async saveTerminalText(capture: string, text: string): Promise<string> {
    const file = capture.replace(/\.png$/, '.terminal.txt');
    await writeFile(join(this.root, file), text);
    return file;
  }

  async appendCandidate(sessionId: string, candidate: Candidate): Promise<void> {
    const dir = paths.session(this.root, sessionId, this.profile);
    await mkdir(dir, { recursive: true });
    await appendFile(join(dir, 'candidates.jsonl'), `${JSON.stringify(candidate)}\n`);
  }

  async readCandidates(sessionId: string): Promise<Candidate[]> {
    try {
      const lines = (
        await readFile(join(paths.session(this.root, sessionId, this.profile), 'candidates.jsonl'), 'utf8')
      ).trim();
      return lines ? lines.split('\n').map((line) => this.current(JSON.parse(line) as Candidate)) : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  /** The candidates of a session that the judge or a review dismissed, one line each. */
  async readDecisions(sessionId: string): Promise<{ candidateId: string; decision: string; reason: string }[]> {
    try {
      const text = await readFile(paths.sessionDecisions(this.root, sessionId, this.profile), 'utf8');
      return text
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async updateSession(id: string, patch: Partial<SessionSummary>): Promise<SessionSummary> {
    const file = join(paths.session(this.root, id, this.profile), 'session.json');
    const current = await readJson<SessionSummary>(file);
    if (!current) {
      throw new Error(`Unknown session ${id}`);
    }
    const next = { ...current, ...patch, id: current.id };
    await atomic(file, next);
    return next;
  }

  async endSession(id: string, patch: Partial<SessionSummary> = {}): Promise<SessionSummary> {
    return this.updateSession(id, {
      status: 'finished',
      endedAt: new Date().toISOString(),
      ...usageOf(await this.readEvents(id)),
      ...patch,
    });
  }

  async listSessions(limit = 20): Promise<SessionSummary[]> {
    let ids: string[];
    try {
      ids = await readdir(paths.sessions(this.root, this.profile));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
    const sessions = await Promise.all(
      ids.map((id) => readJson<SessionSummary>(join(paths.session(this.root, id, this.profile), 'session.json'))),
    );
    const valid = sessions.filter((session): session is SessionSummary => Boolean(session));
    return valid.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit);
  }

  /** A torn or corrupt status file reads as empty: status is advisory, never a reason to fail. */
  async readAgents(): Promise<AgentsFile> {
    try {
      return (await readJson<AgentsFile>(paths.agents(this.root, this.profile))) ?? { version: 1, agents: [] };
    } catch {
      return { version: 1, agents: [] };
    }
  }

  setAgentStatus(role: AgentRole, patch: Partial<AgentStatus>): Promise<AgentStatus> {
    return serialized(paths.agents(this.root, this.profile), () => this.writeAgentStatus(role, patch));
  }

  private async writeAgentStatus(role: AgentRole, patch: Partial<AgentStatus>): Promise<AgentStatus> {
    const file = await this.readAgents();
    const previous = file.agents.find((agent) => agent.role === role);
    const next: AgentStatus = {
      state: 'idle',
      runtime: '',
      spentUsd: 0,
      ...previous,
      ...patch,
      role,
      pid: process.pid,
      updatedAt: new Date().toISOString(),
    };
    file.agents = [...file.agents.filter((agent) => agent.role !== role), next];
    await atomic(paths.agents(this.root, this.profile), file);
    return next;
  }

  setPatrol(patch: Partial<NonNullable<AgentsFile['patrol']>>): Promise<void> {
    return serialized(paths.agents(this.root, this.profile), () => this.writePatrol(patch));
  }

  private async writePatrol(patch: Partial<NonNullable<AgentsFile['patrol']>>): Promise<void> {
    const file = await this.readAgents();
    file.patrol = {
      cycle: 0,
      state: 'stopped',
      startedAt: new Date().toISOString(),
      ...file.patrol,
      ...patch,
      pid: process.pid,
    };
    await atomic(paths.agents(this.root, this.profile), file);
  }

  async readTriage(): Promise<TriageFile> {
    try {
      return (await readJson<TriageFile>(paths.triage(this.root, this.profile))) ?? { version: 1, fingerprints: {} };
    } catch {
      return { version: 1, fingerprints: {} };
    }
  }

  recordTriage(entries: TriageFile['fingerprints']): Promise<void> {
    return serialized(paths.triage(this.root, this.profile), async () => {
      const file = await this.readTriage();
      file.fingerprints = { ...file.fingerprints, ...entries };
      await atomic(paths.triage(this.root, this.profile), file);
    });
  }

  recordEvent(sessionId: string, role: AgentEvent['role'], vars: Vars): EventSink {
    return (event) => {
      const file = join(paths.session(this.root, sessionId, this.profile), 'events.jsonl');
      const previous = eventWrites.get(file) ?? Promise.resolve();
      const next = previous.then(() =>
        this.appendEvent(sessionId, vars.redact({ ...event, sessionId, role }) as Omit<AgentEvent, 'at'>),
      );
      eventWrites.set(file, next);
      void next.catch(() => undefined);
    };
  }
}

export function lessonsFor(memory: MemoryFile, role: LessonRole, limit = 15): Lesson[] {
  return memory.lessons
    .filter((lesson) => lesson.role === role && !lesson.retired)
    .sort(
      (a, b) =>
        Number(b.source === 'human') - Number(a.source === 'human') ||
        b.hits - a.hits ||
        b.lastSeenAt.localeCompare(a.lastSeenAt),
    )
    .slice(0, limit);
}

/** The issue's own fingerprint and every candidate it collected. */
export async function dismissedFingerprints(
  workspace: Workspace,
  issue: Issue,
  reason: string,
  at: string,
): Promise<TriageFile['fingerprints']> {
  const entries: TriageFile['fingerprints'] = {
    [issue.fingerprint]: { decision: 'dismissed', issueId: issue.id, reason, at },
  };
  const ids = new Set(issue.candidateIds);
  if (!ids.size) return entries;
  for (const session of await workspace.listSessions(Infinity)) {
    for (const candidate of await workspace.readCandidates(session.id)) {
      if (ids.has(candidate.id))
        entries[candidate.fingerprint] = { decision: 'dismissed', issueId: issue.id, reason, at };
    }
  }
  return entries;
}
