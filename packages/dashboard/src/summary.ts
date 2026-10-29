import { readdirSync } from 'node:fs';
import { basename, extname, join, relative, sep } from 'node:path';
import { loadConfig, type Platform, paths, type SessionSummary, type Severity } from '@bugpatrol/core';
import type { AgentReader, SessionCandidate } from './agents.js';
import { type CoverageMatrix, type CoverageTotals, coverageTotals } from './coverage.js';

/**
 * A part of the project that Bugpatrol tests: a client app, which has screens,
 * or a backend, which has endpoints. A monorepo has one config file for each
 * part, and all of them write to the same `.bugpatrol/runs/`.
 */
type Surface = {
  kind: 'client' | 'api';
  platform: Platform;
  /** The config files that test this surface, relative to the root. Empty when only the data shows it. */
  configs: string[];
  /** True when the dashboard reads the config of this surface. */
  active: boolean;
};

type ScreenTotals = {
  found: number;
  /** The screens with a routine that reaches them again. */
  replayable: number;
  /** The screens with at least one open issue. */
  withIssues: number;
};

type Verdict = { tone: 'pass' | 'warn' | 'fail' | 'info'; text: string };

/** The numbers of the whole project. Each page reads them from here, so two pages cannot disagree. */
export type ProjectSummary = {
  name: string;
  /** The config that the dashboard reads, relative to the root. Absent when the project has none. */
  config?: string;
  /** What a command needs to use the same config: empty for the default config. */
  configArg: string;
  surfaces: Surface[];
  /** The names of the log sources in the active config. */
  logs: string[];
  issues: { open: number; total: number; bySeverity: Record<Severity, number> };
  /** The candidates that wait for the judge, and how many of them failed again on a second replay. */
  waiting: { total: number; repeat: number };
  coverage: { screens?: ScreenTotals; api?: CoverageTotals };
  lastSession?: Pick<SessionSummary, 'id' | 'role' | 'status' | 'startedAt' | 'endedAt' | 'summary'>;
  verdict: Verdict;
};

const OPEN = new Set(['new', 'filed', 'fixing', 'fix-proposed', 'waits-for-deploy']);

export function projectSummary(reader: AgentReader, root: string, configFile?: string): ProjectSummary {
  const map = reader.appmap();
  const matrix = reader.coverage();
  const issues = reader.issues();
  const open = issues.filter((issue) => OPEN.has(issue.status));
  const waiting = reader.waiting();
  const sessions = reader.sessions(1);
  const found = surfaces(root, configFile, { screens: map.screens.length > 0, platform: map.platform, api: !!matrix });
  const active = configPath(root, configFile);
  const bySeverity: Record<Severity, number> = { critical: 0, major: 0, minor: 0, cosmetic: 0 };
  for (const issue of open) bySeverity[issue.severity]++;
  const withIssues = new Set(open.map((issue) => issue.screenId).filter(Boolean));
  const last = sessions[0];
  return {
    name: basename(root),
    ...(active.exists ? { config: active.path } : {}),
    configArg: configFile ? ` --config ${active.path}` : '',
    surfaces: found,
    logs: reader.logSources(),
    issues: { open: open.length, total: issues.length, bySeverity },
    waiting: { total: waiting.length, repeat: waiting.filter((candidate) => candidate.blocking).length },
    coverage: {
      ...(found.some((surface) => surface.kind === 'client')
        ? {
            screens: {
              found: map.screens.length,
              replayable: map.screens.filter((screen) => screen.routineId).length,
              withIssues: map.screens.filter((screen) => withIssues.has(screen.id)).length,
            },
          }
        : {}),
      ...(matrix ? { api: coverageTotals(matrix) } : {}),
    },
    ...(last
      ? {
          lastSession: {
            id: last.id,
            role: last.role,
            status: last.status,
            startedAt: last.startedAt,
            ...(last.endedAt ? { endedAt: last.endedAt } : {}),
            ...(last.summary ? { summary: last.summary } : {}),
          },
        }
      : {}),
    verdict: verdict({
      tested: !!last || !!matrix || map.screens.length > 0,
      severe: bySeverity.critical + bySeverity.major,
      open: open.length,
      waiting: waiting.length,
    }),
  };
}

function verdict(counts: { tested: boolean; severe: number; open: number; waiting: number }): Verdict {
  if (!counts.tested) return { tone: 'info', text: 'Not tested yet' };
  if (counts.severe) return { tone: 'fail', text: 'Problems found' };
  if (counts.waiting) return { tone: 'warn', text: 'Findings wait for the judge' };
  if (counts.open) return { tone: 'warn', text: 'Open issues' };
  return { tone: 'pass', text: 'No open problems' };
}

function configPath(root: string, configFile?: string): { path: string; exists: boolean } {
  const file = paths.config(root, configFile);
  return { path: relative(root, file).split(sep).join('/'), exists: platformOf(root, file) !== undefined };
}

function platformOf(root: string, file: string): Platform | undefined {
  try {
    return loadConfig(root, {}, file).app.platform;
  } catch {
    // Not a config, for example `endpoints.yml`, or a config with an error.
    return undefined;
  }
}

/**
 * The surfaces of the project: one for each platform that a config file in
 * the Bugpatrol folder tests, and one for data that no config explains (a
 * sweep or screens from a config that is gone). The active config comes first.
 */
function surfaces(
  root: string,
  configFile: string | undefined,
  data: { screens: boolean; platform: Platform; api: boolean },
): Surface[] {
  const active = paths.config(root, configFile);
  const dir = paths.dir(root);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    names = [];
  }
  const files = [
    ...new Set([active, ...names.filter((name) => ['.yml', '.yaml'].includes(extname(name))).map((n) => join(dir, n))]),
  ];
  const byPlatform = new Map<Platform, Surface>();
  for (const file of files) {
    const platform = platformOf(root, file);
    if (!platform) continue;
    const surface = byPlatform.get(platform) ?? {
      kind: platform === 'api' ? 'api' : 'client',
      platform,
      configs: [],
      active: false,
    };
    surface.configs.push(relative(root, file).split(sep).join('/'));
    if (file === active) surface.active = true;
    byPlatform.set(platform, surface);
  }
  const found = [...byPlatform.values()];
  if (data.api && !found.some((surface) => surface.kind === 'api'))
    found.push({ kind: 'api', platform: 'api', configs: [], active: false });
  if (data.screens && !found.some((surface) => surface.kind === 'client'))
    found.push({ kind: 'client', platform: data.platform, configs: [], active: false });
  return found.sort((a, b) => Number(b.active) - Number(a.active));
}

/** A group of findings with the same failure, such as "the status is 400". */
type FindingGroup = {
  label: string;
  count: number;
  /** How many failed again on a second replay. */
  repeat: number;
  /** The assertion ids that failed, for a sweep finding. */
  assertions: string[];
  candidateIds: string[];
};

/** What one session did, in numbers, so a reader sees the result before the events. */
export type SessionReport = {
  durationMs?: number;
  steps: number;
  screens: string[];
  issues: number;
  /**
   * The coverage cells that the session wrote: present when the session ran a
   * sweep. `endpoints` counts the endpoints with a case that passed or failed,
   * as the coverage totals do.
   */
  sweep?: { endpoints: number; pass: number; fail: number; blocked: number };
  findings: Record<SessionCandidate['state'], number> & { total: number; repeat: number };
  groups: FindingGroup[];
  byCase: { label: string; count: number }[];
  /** The assertion ids that failed, such as `contract:status`. */
  byCheck: { label: string; count: number }[];
  byScreen: { label: string; count: number }[];
};

const STATE_WORDS: Record<SessionCandidate['state'], string> = {
  waiting: 'Wait for the judge',
  filed: 'Filed as issues',
  dismissed: 'Dismissed by the judge',
  ignored: 'Not sent to the judge',
};

export function sessionReport(
  session: SessionSummary,
  candidates: SessionCandidate[],
  matrix: CoverageMatrix | undefined,
): SessionReport {
  const start = Date.parse(session.startedAt);
  const end = session.endedAt ? Date.parse(session.endedAt) : Date.now();
  const sweep = { endpoints: new Set<string>(), pass: 0, fail: 0, blocked: 0 };
  for (const [key, cell] of Object.entries(matrix?.cells ?? {})) {
    if (!cell.at || / declared:\d+$/.test(key)) continue;
    const at = Date.parse(cell.at);
    if (at < start || at > end) continue;
    if (cell.state !== 'pass' && cell.state !== 'fail' && cell.state !== 'blocked') continue;
    sweep[cell.state]++;
    if (cell.state !== 'blocked') sweep.endpoints.add(key.slice(0, key.lastIndexOf(' ')));
  }
  const findings = { total: candidates.length, repeat: 0, waiting: 0, filed: 0, dismissed: 0, ignored: 0 };
  const groups = new Map<string, FindingGroup>();
  const byCase = new Map<string, number>();
  const byCheck = new Map<string, number>();
  const byScreen = new Map<string, number>();
  for (const candidate of candidates) {
    findings[candidate.state]++;
    if (candidate.blocking) findings.repeat++;
    const failure = sweepFailure(candidate);
    // A sweep groups by its failure. An explorer report has free text, so it groups by what became of it.
    const label =
      failure?.words ??
      (candidate.source === 'sweep' ? candidate.summary : (candidate.ruleId ?? STATE_WORDS[candidate.state]));
    const group = groups.get(label) ?? { label, count: 0, repeat: 0, assertions: [], candidateIds: [] };
    group.count++;
    if (candidate.blocking) group.repeat++;
    group.candidateIds.push(candidate.id);
    const cell = failure ? matrix?.cells[failure.key] : undefined;
    for (const id of cell?.state === 'fail' ? (cell.reason?.split(', ') ?? []) : []) {
      if (!group.assertions.includes(id)) group.assertions.push(id);
      byCheck.set(id, (byCheck.get(id) ?? 0) + 1);
    }
    groups.set(label, group);
    if (failure) byCase.set(failure.case, (byCase.get(failure.case) ?? 0) + 1);
    if (candidate.screenId) byScreen.set(candidate.screenId, (byScreen.get(candidate.screenId) ?? 0) + 1);
  }
  const ranked = (counts: Map<string, number>) =>
    [...counts].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
  return {
    ...(Number.isFinite(end - start) ? { durationMs: end - start } : {}),
    steps: session.steps,
    screens: session.screensFound,
    issues: session.issues.length,
    ...(sweep.pass + sweep.fail + sweep.blocked
      ? { sweep: { endpoints: sweep.endpoints.size, pass: sweep.pass, fail: sweep.fail, blocked: sweep.blocked } }
      : {}),
    findings,
    groups: [...groups.values()].sort((a, b) => b.count - a.count),
    byCase: ranked(byCase),
    byCheck: ranked(byCheck),
    byScreen: ranked(byScreen),
  };
}

/**
 * The case key and the failure words of a sweep candidate. The sweep writes
 * its summary as `<case key>: <failure words>`, and the rule id as `sweep:<case>`.
 */
function sweepFailure(candidate: SessionCandidate): { key: string; case: string; words: string } | undefined {
  if (candidate.source !== 'sweep' || !candidate.ruleId?.startsWith('sweep:')) return undefined;
  const id = candidate.ruleId.slice('sweep:'.length);
  const at = candidate.summary.indexOf(': ');
  if (id === 'spec' || at < 0) return undefined;
  return { key: candidate.summary.slice(0, at), case: id, words: candidate.summary.slice(at + 2) };
}
