import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AgentEvent,
  AgentsFile,
  AppMap,
  Candidate,
  FixProposal,
  Issue,
  Routine,
  SessionSummary,
} from '@bugpatrol/core';

// A valid one-pixel PNG keeps the fixture self-contained, with no image package.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=';

/** Write a complete desktop patrol workspace for human UI review and API tests. */
export function writeAgentFixture(root: string): void {
  const committed = join(root, '.bugpatrol');
  const dir = join(committed, 'runs');
  const now = new Date();
  const at = (minutes: number): string => new Date(now.getTime() - minutes * 60_000).toISOString();
  const save = (relative: string, value: unknown, base = dir): void => {
    const file = join(base, relative);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, JSON.stringify(value, null, 2));
  };
  const shot = (session: string, name: string): string => `.bugpatrol/runs/sessions/${session}/${name}.png`;
  const screens = ['home', 'settings', 'billing', 'projects', 'profile'].map((id, index) => ({
    id,
    name: id[0]!.toUpperCase() + id.slice(1),
    description: `${id} controls and current account information`,
    platform: 'electron' as const,
    location: `acme://${id}`,
    routineId: index ? `open-${id}` : 'open-home',
    links: index < 4 ? [id === 'home' ? 'settings' : 'home'] : [],
    firstSeenAt: at(140 - index),
    lastSeenAt: at(index * 4),
    visits: 8 - index,
    lastScreenshot: shot('ses_live', `00${index + 1}-${id}`),
  }));
  const map: AppMap = {
    version: 1,
    platform: 'electron',
    summary: 'Acme desktop workspace',
    screens,
    updatedAt: at(1),
  };
  save('appmap.json', map, committed);
  const agents: AgentsFile = {
    version: 1,
    patrol: { cycle: 3, state: 'running', startedAt: at(180), nextAt: at(-20) },
    agents: [
      {
        role: 'explorer',
        state: 'working',
        runtime: 'model: z-ai/glm-5.3-flash',
        activity: 'Checking billing settings.',
        sessionId: 'ses_live',
        updatedAt: at(0),
        spentUsd: 0.082,
      },
      {
        role: 'judge',
        state: 'idle',
        runtime: 'model: anthropic/claude-sonnet-4',
        activity: 'Waiting for candidates.',
        updatedAt: at(2),
        spentUsd: 0.021,
      },
      {
        role: 'fixer',
        state: 'idle',
        runtime: 'cli: claude',
        activity: 'Fix proposal ready for review.',
        updatedAt: at(8),
        spentUsd: 0.014,
      },
    ],
  };
  save('agents.json', agents);
  for (const [index, id] of ['ses_live', 'ses_done'].entries()) {
    const live = index === 0;
    const session: SessionSummary = {
      version: 1,
      id,
      role: 'explorer',
      startedAt: at(live ? 15 : 125),
      endedAt: live ? undefined : at(95),
      status: live ? 'running' : 'finished',
      summary: live ? 'Exploring billing and account settings.' : 'Mapped the main workspace screens.',
      steps: 25,
      costUsd: live ? 0.082 : 0.057,
      screensFound: live ? ['billing', 'settings'] : ['home', 'projects', 'profile'],
      candidates: 2,
      issues: live ? ['iss-billing', 'iss-settings'] : ['iss-profile'],
    };
    save(`sessions/${id}/session.json`, session);
    const events: AgentEvent[] = Array.from({ length: 25 }, (_, step) => ({
      at: at((live ? 15 : 125) - step * 0.5),
      sessionId: id,
      role: step % 7 === 0 ? 'judge' : 'explorer',
      kind: step % 6 === 0 ? 'thought' : step % 5 === 0 ? 'screen' : step % 3 === 0 ? 'tool-result' : 'tool-call',
      summary: step % 5 === 0 ? `Captured ${screens[step % 5]!.name}.` : `Inspected control ${step + 1}.`,
      tool: step % 3 === 0 ? 'driver.observe' : undefined,
      input: step % 3 === 0 ? { screen: screens[step % 5]!.id } : undefined,
      output: step % 3 === 0 ? { visible: true } : undefined,
      screenshot: step % 5 === 0 ? screens[step % 5]!.lastScreenshot : undefined,
      screenId: screens[step % 5]!.id,
      costUsd: 0.002,
    }));
    const eventLines = events.map((event) => JSON.stringify(event)).join('\n');
    writeFileSync(join(dir, 'sessions', id, 'events.jsonl'), `${eventLines}\n`);
    const candidates: Candidate[] = [0, 1].map((number) => ({
      id: `cand-${id}-${number}`,
      sessionId: id,
      screenId: number ? 'settings' : 'billing',
      source: 'explorer',
      fingerprint: `fingerprint-${id}-${number}`,
      summary: number ? 'Settings value is clipped.' : 'Billing total differs from invoice.',
      severity: number ? 'minor' : 'critical',
      evidence: { screenshot: screens[number ? 1 : 2]!.lastScreenshot },
      route: { to: number ? 'ignore' : 'judge', reason: number ? 'Expected responsive layout.' : 'Incorrect total.' },
      createdAt: at(number + 5),
    }));
    const candidateLines = candidates.map((candidate) => JSON.stringify(candidate)).join('\n');
    writeFileSync(join(dir, 'sessions', id, 'candidates.jsonl'), `${candidateLines}\n`);
  }
  for (const screen of screens) {
    const file = join(root, screen.lastScreenshot!);
    writeFileSync(file, Buffer.from(PNG, 'base64'));
  }
  const issues: Issue[] = [
    {
      id: 'iss-billing',
      screenId: 'billing',
      severity: 'critical',
      status: 'new',
      title: 'Invoice total differs from checkout',
      body: 'The **invoice total** is wrong.\n\n- Open billing\n- Compare the total',
      candidateIds: ['cand-ses_live-0'],
      occurrences: 3,
      lastSeenAt: at(1),
    },
    {
      id: 'iss-settings',
      screenId: 'settings',
      severity: 'major',
      status: 'fix-proposed',
      title: 'Save button overlaps account text',
      body: 'The button covers the account name.',
      candidateIds: [],
      occurrences: 2,
      lastSeenAt: at(4),
      fixId: 'fix-settings',
    },
    {
      id: 'iss-profile',
      screenId: 'profile',
      severity: 'minor',
      status: 'filed',
      title: 'Profile description is clipped',
      body: 'Long descriptions lose their final line.',
      candidateIds: [],
      occurrences: 1,
      lastSeenAt: at(100),
    },
    {
      id: 'iss-old',
      screenId: 'home',
      severity: 'cosmetic',
      status: 'fixed',
      title: 'Old border mismatch',
      body: 'Resolved in the last cycle.',
      candidateIds: [],
      occurrences: 4,
      lastSeenAt: at(160),
    },
  ].map((part) => ({
    version: 1,
    fingerprint: part.id,
    evidence: {
      screenshot: screens.find((s) => s.id === part.screenId)!.lastScreenshot,
      routineId: `open-${part.screenId}`,
      steps: [
        { kind: 'tap', target: { name: 'Settings' } },
        { kind: 'type', value: '{{E2E_EMAIL}}' },
        { kind: 'press', key: 'Enter' },
      ],
    },
    judgement: { by: 'model: judge', reason: 'Visible and repeatable.', confidence: 0.92, at: at(3) },
    firstSeenAt: at(150),
    ...part,
    severity: part.severity as Issue['severity'],
    status: part.status as Issue['status'],
  }));
  for (const issue of issues) save(`issues/${issue.id}.json`, issue);
  const fix: FixProposal = {
    version: 1,
    id: 'fix-settings',
    issueId: 'iss-settings',
    status: 'proposed',
    runtime: 'cli: claude',
    repo: 'acme-desktop',
    branch: 'bugpatrol/fix-settings',
    worktree: '/tmp/acme-fix-settings',
    diffStat: 'src/settings.css | 2 +-',
    diff: 'diff --git a/src/settings.css b/src/settings.css\n-old padding\n+new padding',
    summary: 'Give the account name enough room.',
    startedAt: at(22),
    endedAt: at(8),
    costUsd: 0.014,
  };
  save('fixes/fix-settings.json', fix);
  const routines: Routine[] = ['open-home', 'open-settings'].map((id) => ({
    version: 1,
    id,
    description: `Reach the ${id.slice(5)} screen`,
    platform: 'electron',
    screenId: id.slice(5),
    steps: [{ kind: 'tap', target: { name: id === 'open-home' ? 'Home' : 'Settings' } }],
    createdAt: at(160),
    updatedAt: at(5),
    lastReplay: { at: at(5), ok: true },
  }));
  for (const routine of routines) save(`routines/${routine.id}.json`, routine, committed);
}
