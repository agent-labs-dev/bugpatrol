import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentReader } from './agents.js';
import { writeAgentFixture } from './fixtures/agent-workspace.js';
import { type Dashboard, startDashboard, watchProject } from './server.js';
import { layoutGraph } from './ui/graph-layout.js';

let root: string;
let dashboard: Dashboard | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bugpatrol-agents-'));
});
afterEach(async () => {
  await dashboard?.close();
  dashboard = undefined;
  rmSync(root, { recursive: true, force: true });
});

describe('AgentReader', () => {
  it('prefers transitions and replay prerequisites over visit-order links', () => {
    writeAgentFixture(root);
    const file = join(root, '.bugpatrol', 'appmap.json');
    const map = JSON.parse(readFileSync(file, 'utf8'));
    map.screens[0].transitions = [
      { to: 'settings', kind: 'tap', via: 'Settings', count: 3, steps: 1 },
      { to: 'home', kind: 'back', count: 1, steps: 1 },
      { to: 'missing', kind: 'open', count: 1, steps: 1 },
    ];
    map.screens[4].links = ['home'];
    for (const screen of map.screens.slice(0, 4)) screen.routineId = `screen-${screen.id}`;
    writeFileSync(file, JSON.stringify(map));
    const routine = {
      version: 1,
      id: 'enter-app',
      description: 'Enter',
      platform: 'electron',
      screenId: null,
      steps: [],
      createdAt: '',
      updatedAt: '',
    };
    mkdirSync(join(root, '.bugpatrol', 'routines'), { recursive: true });
    writeFileSync(join(root, '.bugpatrol', 'routines', 'enter-app.json'), JSON.stringify(routine));
    for (const [id, screenId, requires] of [
      ['screen-settings', 'settings', ['screen-home']],
      ['screen-billing', 'billing', ['enter-app']],
      ['screen-projects', 'projects', ['missing']],
    ] as const)
      writeFileSync(
        join(root, '.bugpatrol', 'routines', `${id}.json`),
        JSON.stringify({ ...routine, id, screenId, requires }),
      );
    const result = new AgentReader(root).screens();
    expect(result.entryId).toBe('__start');
    expect(result.screens.find((screen) => screen.id === '__start')).toMatchObject({
      name: 'App start',
      virtual: true,
    });
    expect(result.edges.filter((edge) => edge.from === 'home')).toEqual([
      { from: 'home', to: 'settings', kind: 'tap', via: 'Settings', count: 3, steps: 1 },
      { from: 'home', to: 'settings', kind: 'route', via: 'route', count: 1, steps: 0 },
    ]);
    expect(result.edges).toContainEqual({
      from: '__start',
      to: 'billing',
      kind: 'route',
      via: 'route',
      count: 1,
      steps: 0,
    });
    expect(result.edges).toContainEqual({
      from: '__start',
      to: 'projects',
      kind: 'route',
      via: 'route',
      count: 1,
      steps: 0,
    });
    expect(result.edges).toContainEqual({
      from: 'profile',
      to: 'home',
      kind: 'other',
      via: undefined,
      count: 1,
      steps: 0,
    });
    expect(result.edges.some((edge) => edge.from === 'projects')).toBe(false);
  });

  it('links App start to the enter-app screen when every screen has an edge in', () => {
    const dir = join(root, '.bugpatrol');
    mkdirSync(join(dir, 'routines'), { recursive: true });
    const screen = (id: string, to: string) => ({
      id,
      name: id,
      routineId: `screen-${id}`,
      links: [],
      transitions: [{ to, kind: 'tap', via: to, count: 1, steps: 1 }],
      lastSeenAt: '',
      firstSeenAt: '',
    });
    writeFileSync(
      join(dir, 'appmap.json'),
      JSON.stringify({
        version: 1,
        platform: 'web',
        updatedAt: '',
        screens: [screen('chat', 'home'), screen('home', 'chat')],
      }),
    );
    for (const [id, requires] of [
      ['enter-app', ['screen-home']],
      ['screen-home', []],
      ['screen-chat', []],
    ] as const) {
      writeFileSync(join(dir, 'routines', `${id}.json`), JSON.stringify({ id, requires, screenId: null, steps: [] }));
    }
    const result = new AgentReader(root).screens();
    expect(result.edges.filter((edge) => edge.from === '__start').map((edge) => edge.to)).toEqual(['home']);
    expect(layoutGraph(result.screens, result.edges, result.entryId).unlinkedY).toBeNull();
  });

  it('connects screens through routineId when routines have no screenId', () => {
    const dir = join(root, '.bugpatrol');
    mkdirSync(join(dir, 'routines'), { recursive: true });
    const ids = ['signin', 'home', 'settings', 'browse'];
    writeFileSync(
      join(dir, 'appmap.json'),
      JSON.stringify({
        version: 1,
        platform: 'web',
        updatedAt: '',
        screens: ids.map((id) => ({
          id,
          name: id,
          routineId: `screen-${id}`,
          links: [],
          lastSeenAt: '2026-01-01',
          firstSeenAt: '2026-01-01',
        })),
      }),
    );
    for (const [id, requires] of [
      ['enter-app', []],
      ['screen-signin', []],
      ['screen-home', ['enter-app']],
      ['screen-settings', ['screen-home']],
      ['screen-browse', ['enter-app']],
    ] as const)
      writeFileSync(join(dir, 'routines', `${id}.json`), JSON.stringify({ id, requires, screenId: null, steps: [] }));
    const result = new AgentReader(root).screens();
    expect(
      result.edges
        .filter((edge) => edge.from === '__start')
        .map((edge) => edge.to)
        .sort(),
    ).toEqual(['browse', 'home', 'signin']);
    expect(result.edges).toContainEqual({
      from: 'home',
      to: 'settings',
      kind: 'route',
      via: 'route',
      count: 1,
      steps: 0,
    });
    const reached = new Set(['__start']);
    for (let pass = 0; pass < result.screens.length; pass++)
      for (const edge of result.edges) {
        if (reached.has(edge.from)) reached.add(edge.to);
      }
    expect(reached.size).toBe(result.screens.length);
    expect(layoutGraph(result.screens, result.edges, result.entryId).unlinkedY).toBeNull();
  });

  it('shows a role that has not run yet from the config, not as off', () => {
    mkdirSync(join(root, '.bugpatrol'), { recursive: true });
    writeFileSync(
      join(root, '.bugpatrol', 'bugpatrol.yml'),
      [
        'version: 1',
        'app:',
        '  connect: { url: "http://localhost:3000" }',
        'agents:',
        '  explorer: { use: { runtime: model, via: openrouter, model: z-ai/glm-5.3-flash } }',
        '  judge: { use: claude }',
        '',
      ].join('\n'),
    );
    const agents = (new AgentReader(root).overview() as { agents: { role: string; state: string; runtime: string }[] })
      .agents;
    expect(agents).toMatchObject([
      { role: 'explorer', state: 'idle', runtime: 'model:openrouter/z-ai/glm-5.3-flash' },
      { role: 'judge', state: 'idle', runtime: 'cli:claude' },
      { role: 'fixer', state: 'off', runtime: 'cli:claude' },
    ]);
  });

  it('tolerates missing and corrupt state and fills all three roles', () => {
    const reader = new AgentReader(root);
    expect(reader.issues()).toEqual([]);
    expect(reader.sessions()).toEqual([]);
    expect(reader.appmap().screens).toEqual([]);
    expect((reader.overview() as { agents: { state: string }[] }).agents.map((agent) => agent.state)).toEqual([
      'off',
      'off',
      'off',
    ]);
    mkdirSync(join(root, '.bugpatrol', 'runs', 'issues'), { recursive: true });
    writeFileSync(join(root, '.bugpatrol', 'runs', 'agents.json'), '{');
    writeFileSync(join(root, '.bugpatrol', 'runs', 'issues', 'broken.json'), '{');
    expect(reader.issues()).toEqual([]);
    expect(reader.agents()).toBeUndefined();
  });

  it('skips a torn last event line and sorts attention by severity then recency', () => {
    writeAgentFixture(root);
    const file = join(root, '.bugpatrol', 'runs', 'sessions', 'ses_live', 'events.jsonl');
    appendFileSync(file, '{"at":');
    const reader = new AgentReader(root);
    expect(reader.session('ses_live')?.events).toHaveLength(25);
    expect(reader.session('../escape')).toBeUndefined();
    const overview = reader.overview() as {
      attention: { id: string; fix?: { status: string } }[];
      agents: unknown[];
      counts: { issuesOpen: number };
      live: { events: { kind: string }[]; screenshot: string };
    };
    expect(overview.attention.map((issue) => issue.id)).toEqual(['iss-billing', 'iss-settings', 'iss-profile']);
    expect(overview.attention.find((issue) => issue.id === 'iss-settings')?.fix?.status).toBe('proposed');
    expect(overview.agents).toHaveLength(3);
    expect(overview.counts.issuesOpen).toBe(3);
    // An issue that the fixer works on stays in the list, so the list matches the count.
    const profile = join(root, '.bugpatrol', 'runs', 'issues', 'iss-profile.json');
    writeFileSync(profile, JSON.stringify({ ...JSON.parse(readFileSync(profile, 'utf8')), status: 'fixing' }));
    const fixing = new AgentReader(root).overview() as { attention: { id: string }[]; counts: { issuesOpen: number } };
    expect(fixing.attention.map((issue) => issue.id)).toContain('iss-profile');
    expect(fixing.attention).toHaveLength(fixing.counts.issuesOpen);
    expect(overview.live.events.length).toBeGreaterThan(0);
    expect(overview.live.events.length).toBeLessThanOrEqual(12);
    expect(overview.live.events.every((event) => event.kind !== 'thought' && event.kind !== 'tool-call')).toBe(true);
    expect(overview.live.screenshot).toContain('.bugpatrol/runs/sessions/ses_live/');
  });

  it('joins an issue to its proposal and candidates', () => {
    writeAgentFixture(root);
    const detail = new AgentReader(root).issue('iss-billing');
    expect(detail?.candidates.map((candidate) => candidate.id)).toEqual(['cand-ses_live-0']);
    expect(new AgentReader(root).issue('iss-settings')?.fix?.diff).toContain('+new padding');
    const billing = new AgentReader(root).screens().screens.find((screen) => screen.id === 'billing');
    expect(billing?.openIssues).toBe(1);
  });

  it('passes GitHub state into issue rows and the overview', () => {
    writeAgentFixture(root);
    const reader = new AgentReader(root);
    const issue = reader.issues().find((item) => item.id === 'iss-settings')!;
    const fix = reader.issue(issue.id)!.fix!;
    writeFileSync(
      join(root, '.bugpatrol', 'runs', 'issues', `${issue.id}.json`),
      JSON.stringify({
        ...issue,
        github: { number: 8, url: 'https://github.com/o/r/issues/8', at: 'now', state: 'open' },
      }),
    );
    writeFileSync(
      join(root, '.bugpatrol', 'runs', 'fixes', `${fix.id}.json`),
      JSON.stringify({
        ...fix,
        pr: { number: 7, url: 'https://github.com/o/r/pull/7', draft: false, state: 'merged' },
      }),
    );
    expect(reader.issues().find((item) => item.id === issue.id)).toMatchObject({
      github: { state: 'open' },
      pr: { state: 'merged' },
    });
    expect((reader.overview() as { github: string }).github).toContain('1 merged');
  });
});

describe('reviews', () => {
  it('lists each reviewed pull request, newest first, with its claim verdicts', () => {
    writeAgentFixture(root);
    writeFileSync(join(root, '.bugpatrol', 'runs', 'reviews', 'pr-9.json'), '{');
    const reviews = new AgentReader(root).reviews();
    expect(reviews).toMatchObject([
      {
        pr: { number: 42, title: 'Let users rename a project' },
        head: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
        base: '0f1e2d3c4b5a69788796a5b4c3d2e1f012345678',
        status: 'finished',
        verdicts: { proven: 1, 'not-proven': 1, 'partly-proven': 1, untested: 1 },
        introduced: 1,
      },
      { pr: { number: 41 }, status: 'failed', error: 'The app did not start.', introduced: 0 },
    ]);
    expect(reviews[1]).not.toHaveProperty('verdicts');
    expect(reviews[0]).not.toHaveProperty('claims');
  });

  it('gives one review with the recordings in its run directory, matched to claim and build', () => {
    writeAgentFixture(root);
    const reader = new AgentReader(root);
    const detail = reader.review(42);
    expect(detail?.review.claims?.[0]?.claim.id).toBe('claim-1');
    expect(detail?.review.findings.map((finding) => finding.verdict)).toEqual(['introduced', 'pre-existing']);
    const dir = '.bugpatrol/runs/reviews/pr-42';
    expect(detail?.recordings).toEqual([
      { path: `${dir}/claim-1/base.mp4`, kind: 'video', claimId: 'claim-1', build: 'base' },
      { path: `${dir}/claim-1/head.gif`, kind: 'image', claimId: 'claim-1', build: 'head' },
      { path: `${dir}/claim-1/head.mp4`, kind: 'video', claimId: 'claim-1', build: 'head' },
      { path: `${dir}/claim-3/head.cast`, kind: 'cast', claimId: 'claim-3', build: 'head' },
    ]);
    expect(reader.review(7)).toBeUndefined();
  });

  it('matches claim-1 and claim-10 apart, and keeps a recording that names neither', () => {
    const dir = join(root, '.bugpatrol', 'runs', 'reviews');
    mkdirSync(join(dir, 'pr-5'), { recursive: true });
    writeFileSync(
      join(dir, 'pr-5.json'),
      JSON.stringify({ version: 1, pr: { number: 5 }, head: 'h', base: 'b', startedAt: 'now', findings: [] }),
    );
    for (const name of ['claim-10-base.webm', 'session.mp4']) writeFileSync(join(dir, 'pr-5', name), 'x');
    expect(new AgentReader(root).review(5)?.recordings).toEqual([
      { path: '.bugpatrol/runs/reviews/pr-5/claim-10-base.webm', kind: 'video', claimId: 'claim-10', build: 'base' },
      { path: '.bugpatrol/runs/reviews/pr-5/session.mp4', kind: 'video' },
    ]);
  });
});

const canBind = await new Promise<boolean>((done) => {
  const server = createServer();
  server.once('error', () => done(false));
  server.listen(0, '127.0.0.1', () => server.close(() => done(true)));
});

describe.skipIf(!canBind)('agent API', () => {
  it('uses the selected profile and fails loudly when that profile disappears', async () => {
    mkdirSync(join(root, '.bugpatrol'));
    const file = join(root, '.bugpatrol', 'api.yml');
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        app: { platform: 'api', connect: { url: 'http://127.0.0.1:1234' } },
        agents: { explorer: { use: { runtime: 'cli', command: 'profile-api' } } },
      }),
    );
    dashboard = await startDashboard({ root, port: 0, configFile: '.bugpatrol/api.yml' });
    const overview = await (await fetch(`${dashboard.url}/api/overview`)).json();
    expect((await (await fetch(`${dashboard.url}/api/state`)).json()).hasConfig).toBe(true);
    expect(overview.agents.find((agent: { role: string }) => agent.role === 'explorer')).toMatchObject({
      state: 'idle',
      runtime: 'cli:profile-api',
    });
    rmSync(file);
    expect((await fetch(`${dashboard.url}/api/overview`)).status).toBe(500);
  });

  it('serves overview, detail and routine summaries', async () => {
    writeAgentFixture(root);
    dashboard = await startDashboard({ root, port: 0 });
    const overview = await (await fetch(`${dashboard.url}/api/overview`)).json();
    expect(overview.project.platform).toBe('electron');
    expect(overview.attention[0].severity).toBe('critical');
    expect(overview.recentSessions).toHaveLength(2);
    const issue = await (await fetch(`${dashboard.url}/api/issues/iss-settings`)).json();
    expect(issue.fix.status).toBe('proposed');
    const routines = await (await fetch(`${dashboard.url}/api/routines`)).json();
    expect(routines).toHaveLength(2);
    expect(routines[0].steps).toBe(1);
  });

  it('serves reviews and plays their recordings, with byte ranges for seeking', async () => {
    writeAgentFixture(root);
    const video = join(root, '.bugpatrol', 'runs', 'reviews', 'pr-42', 'claim-1', 'head.mp4');
    writeFileSync(video, '0123456789');
    dashboard = await startDashboard({ root, port: 0 });
    const list = await (await fetch(`${dashboard.url}/api/reviews`)).json();
    expect(list.map((review: { pr: { number: number } }) => review.pr.number)).toEqual([42, 41]);
    const detail = await (await fetch(`${dashboard.url}/api/reviews/42`)).json();
    expect(detail.review.claims).toHaveLength(4);
    expect((await fetch(`${dashboard.url}/api/reviews/7`)).status).toBe(404);
    expect((await fetch(`${dashboard.url}/api/reviews/abc`)).status).toBe(404);

    const url = `${dashboard.url}/api/artifact?path=${encodeURIComponent('.bugpatrol/runs/reviews/pr-42/claim-1/head.mp4')}`;
    const whole = await fetch(url);
    expect(whole.headers.get('content-type')).toBe('video/mp4');
    expect(whole.headers.get('accept-ranges')).toBe('bytes');
    expect(await whole.text()).toBe('0123456789');
    const part = await fetch(url, { headers: { range: 'bytes=2-5' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(await part.text()).toBe('2345');
    const tail = await fetch(url, { headers: { range: 'bytes=7-' } });
    expect(await tail.text()).toBe('789');
    const suffix = await fetch(url, { headers: { range: 'bytes=-2' } });
    expect(await suffix.text()).toBe('89');
    const outside = await fetch(url, { headers: { range: 'bytes=20-30' } });
    expect(outside.status).toBe(416);
    expect(outside.headers.get('content-range')).toBe('bytes */10');

    for (const [file, type] of [
      ['claim-1/head.gif', 'image/gif'],
      ['claim-3/head.cast', 'application/x-asciicast'],
    ]) {
      const response = await fetch(
        `${dashboard.url}/api/artifact?path=${encodeURIComponent(`.bugpatrol/runs/reviews/pr-42/${file}`)}`,
      );
      expect(response.headers.get('content-type')).toBe(type);
    }
  });
});

describe('watchProject', () => {
  it('picks up .bugpatrol created after start', async () => {
    let changes = 0;
    const watcher = watchProject(root, () => {
      changes += 1;
    });
    expect(watcher).toBeDefined();
    try {
      mkdirSync(join(root, '.bugpatrol'));
      await new Promise((done) => setTimeout(done, 700));
      expect(changes).toBeGreaterThan(0);
    } finally {
      watcher?.close();
    }
  });
});

describe('stale status', () => {
  it('shows work from a dead process as stopped', () => {
    const root = mkdtempSync(join(tmpdir(), 'bugpatrol-stale-'));
    try {
      // A pid far above any real one: the process cannot exist.
      const dead = 2 ** 22 + 12345;
      mkdirSync(join(root, '.bugpatrol', 'runs', 'sessions', 'ses_1'), { recursive: true });
      writeFileSync(
        join(root, '.bugpatrol', 'runs', 'agents.json'),
        JSON.stringify({
          version: 1,
          patrol: { cycle: 1, state: 'running', startedAt: '2026-01-01T00:00:00.000Z', pid: dead },
          agents: [
            {
              role: 'fixer',
              state: 'working',
              activity: 'Fixing 9 issues',
              runtime: 'cli:claude',
              updatedAt: '2026-01-01T00:00:00.000Z',
              spentUsd: 0,
              pid: dead,
            },
          ],
        }),
      );
      writeFileSync(
        join(root, '.bugpatrol', 'runs', 'sessions', 'ses_1', 'session.json'),
        JSON.stringify({
          version: 1,
          id: 'ses_1',
          role: 'fixer',
          pid: dead,
          startedAt: '2026-01-01T00:00:00.000Z',
          status: 'running',
          steps: 0,
          costUsd: 0,
          screensFound: [],
          candidates: 0,
          issues: [],
        }),
      );
      const reader = new AgentReader(root);
      expect(reader.agents()?.patrol?.state).toBe('stopped');
      expect(reader.agents()?.agents[0]).toMatchObject({ state: 'idle', activity: 'Stopped: its process ended.' });
      expect(reader.sessions()[0]?.status).toBe('failed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('usageReport', () => {
  it('adds up the tokens today for each agent, and the week for each agent and model', async () => {
    const { usageReport } = await import('./agents.js');
    const now = new Date(2026, 8, 26, 12);
    const at = (day: number, hour: number) => new Date(2026, 8, day, hour).toISOString();
    const session = (
      id: string,
      role: 'explorer' | 'judge',
      startedAt: string,
      byModel: Record<string, { input: number; output: number }>,
    ) => ({
      version: 1 as const,
      id,
      role,
      startedAt,
      status: 'finished' as const,
      steps: 1,
      costUsd: 0,
      screensFound: [],
      candidates: 0,
      issues: [],
      tokens: Object.values(byModel).reduce(
        (sum, u) => ({ input: sum.input + u.input, output: sum.output + u.output }),
        { input: 0, output: 0 },
      ),
      tokensByModel: byModel,
    });
    const report = usageReport(
      [
        session('a', 'explorer', at(26, 10), {
          glm: { input: 1000, output: 100 },
          'gpt-mini': { input: 300, output: 0 },
        }),
        session('b', 'explorer', at(24, 10), { glm: { input: 3000, output: 300 } }),
        session('c', 'judge', at(26, 11), { 'claude-sonnet-5': { input: 500, output: 50 } }),
        session('old', 'judge', at(1, 11), { 'claude-sonnet-5': { input: 9999, output: 9 } }),
      ],
      now,
    );
    expect(report.todayByRole.explorer).toEqual({ input: 1300, output: 100 });
    expect(report.todayByRole.judge).toEqual({ input: 500, output: 50 });
    expect(report.week.map((row) => [row.role, row.model, row.sessions, row.tokens.input])).toEqual([
      ['explorer', 'glm', 2, 4000],
      ['explorer', 'gpt-mini', 1, 300],
      ['judge', 'claude-sonnet-5', 1, 500],
    ]);
    expect(report.weekTotal).toEqual({ input: 4800, output: 450 });
  });
});
