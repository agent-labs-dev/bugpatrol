import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AgentEvent,
  AgentsFile,
  AppMap,
  Candidate,
  FixProposal,
  Issue,
  PrReview,
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
  writeReviewFixture(root, at);
}

/**
 * A finished review of pull request 42 with a claim check: one claim proven by a
 * recorded replay, one not proven with screenshots only, one untested, and an
 * introduced and a pre-existing finding. The recordings are stand-in bytes;
 * `scripts/fixture.mjs` swaps in real ones when ffmpeg is installed.
 */
function writeReviewFixture(root: string, at: (minutes: number) => string): void {
  const dir = join(root, '.bugpatrol', 'runs', 'reviews');
  const shots = '.bugpatrol/runs/reviews/pr-42/shots';
  const file = (relative: string, bytes: Buffer | string): string => {
    const path = join(root, relative);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, bytes);
    return relative;
  };
  const png = Buffer.from(PNG, 'base64');
  const shot = (name: string): string => file(`${shots}/${name}.png`, png);
  file('.bugpatrol/runs/reviews/pr-42/claim-1/head.mp4', 'mp4');
  file('.bugpatrol/runs/reviews/pr-42/claim-1/base.mp4', 'mp4');
  file('.bugpatrol/runs/reviews/pr-42/claim-1/head.gif', 'gif');
  const cast = [
    { version: 2, width: 60, height: 8 },
    [0.1, 'o', '$ acme export --json\r\n'],
    [0.6, 'o', '\u001b[32m{"ok": true}\u001b[0m\r\n'],
  ];
  file('.bugpatrol/runs/reviews/pr-42/claim-3/head.cast', `${cast.map((line) => JSON.stringify(line)).join('\n')}\n`);
  const review: PrReview = {
    version: 1,
    pr: { number: 42, url: 'https://github.com/acme/desktop/pull/42', title: 'Let users rename a project' },
    head: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
    base: '0f1e2d3c4b5a69788796a5b4c3d2e1f012345678',
    baseRef: 'main',
    status: 'finished',
    startedAt: at(40),
    endedAt: at(30),
    sessions: { explorer: 'ses_done', claims: 'ses_claims', headReplay: 'ses_head', baseReplay: 'ses_base' },
    tested: 'Opened projects, renamed one, and checked the list.',
    claims: [
      {
        claim: {
          id: 'claim-1',
          text: 'A project can be renamed from its menu.',
          platform: 'electron',
          source: { kind: 'section' },
          testable: true,
        },
        verdict: 'proven',
        evidence: 'replay',
        reason: 'The new name shows in the list on this pull request and the menu item is missing on the base.',
        did: 'Opened the project menu and renamed the project on both builds.',
        routine: '.bugpatrol/runs/reviews/pr-42/routines/claim-1.json',
        steps: ['Open Projects', 'Open the menu of "Acme"', 'Tap "Rename"', 'Type "Acme 2"'],
        head: { ok: true, shots: [shot('claim-1-head-0'), shot('claim-1-head-1')] },
        base: { ok: false, shots: [shot('claim-1-base-0')], failedStep: 1, error: 'No element named "Rename".' },
      },
      {
        claim: {
          id: 'claim-2',
          text: 'Renaming keeps the project open.',
          platform: 'electron',
          source: { kind: 'commit', commit: 'a1b2c3d' },
          testable: true,
        },
        verdict: 'not-proven',
        evidence: 'explored',
        reason: 'The project closed after the rename.',
        saw: 'The app went back to the project list.',
        head: { ok: true, shots: [shot('claim-2-head-0')] },
        base: { ok: true, shots: [shot('claim-2-base-0')] },
      },
      {
        claim: {
          id: 'claim-3',
          text: 'The export command prints JSON.',
          platform: 'desktop',
          source: { kind: 'issue', number: 12 },
          testable: true,
        },
        verdict: 'partly-proven',
        evidence: 'assertion',
        reason: 'The output is JSON, but the exit code was 1.',
        head: { ok: true, shots: [] },
      },
      {
        claim: {
          id: 'claim-4',
          text: 'Clean up the project store.',
          platform: 'electron',
          source: { kind: 'body' },
          testable: false,
          untestable: 'A refactor has no behavior to test.',
        },
        verdict: 'untested',
        reason: 'The claim is not testable.',
      },
    ],
    findings: [
      {
        candidateId: 'cand-pr-1',
        screenId: 'projects',
        verdict: 'introduced',
        title: 'Rename field overflows the menu',
        severity: 'minor',
        reason: 'The field is wider than the menu on this pull request only.',
        file: 'src/projects/menu.tsx',
        line: 18,
        steps: ['Open Projects', 'Open the menu of "Acme"'],
        head: shot('finding-1-head'),
        base: shot('finding-1-base'),
      },
      {
        candidateId: 'cand-pr-2',
        verdict: 'pre-existing',
        title: 'Project list flickers on load',
        severity: 'cosmetic',
        reason: 'The base build flickers too.',
        steps: ['Open Projects'],
      },
    ],
    posted: { url: 'https://github.com/acme/desktop/pull/42#pullrequestreview-1', at: at(29) },
    costUsd: 0.12,
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'pr-42.json'), JSON.stringify(review, null, 2));
  writeFileSync(
    join(dir, 'pr-41.json'),
    JSON.stringify(
      {
        ...review,
        pr: { ...review.pr, number: 41, title: 'Faster start' },
        status: 'failed',
        error: 'The app did not start.',
        claims: undefined,
        findings: [],
        startedAt: at(300),
        endedAt: at(299),
      },
      null,
      2,
    ),
  );
}
