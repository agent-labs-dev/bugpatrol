// Bugpatrol dashboard. Vanilla ES modules on purpose: no build step means the UI
// is served straight from source, so `bugpatrol dashboard` works from a clone with
// nothing compiled but the CLI itself.
import { parseCast } from './cast.js';
import { layoutGraph } from './graph-layout.js';

const view = document.getElementById('view');
const tabs = document.getElementById('tabs');
const liveEl = document.getElementById('live');
const projectEl = document.getElementById('project-name');
const surfacesEl = document.getElementById('surfaces');
const patrolEl = document.getElementById('patrol');

const state = {
  view: 'overview',
  summary: null,
  overview: null,
  issues: [],
  issueFilter: 'open',
  selectedIssueId: null,
  issueDetail: null,
  sessions: [],
  selectedSessionId: null,
  sessionDetail: null,
  flow: null,
  appmap: null,
  selectedScreenId: null,
  routines: [],
  memory: { lessons: [] },
  coverage: null,
  coverageFilter: { failedOnly: false, hideSkipped: false, query: '' },
  selectedCell: null,
  runs: [],
  selectedRunId: null,
  reviews: [],
  selectedReview: null,
  reviewDetail: null,
  detail: null,
  live: null,
  root: '',
};

let screenMode = 'graph';
try {
  screenMode = localStorage.getItem('bugpatrol-screen-mode') === 'grid' ? 'grid' : 'graph';
} catch {
  /* storage may be disabled */
}
const graphCamera = { box: null, key: '' };
let showBackLinks = false;
let renderedState = '';
let renderedPage = '';

// ---------------------------------------------------------------- data

// Mirrors isFeedEvent in agents.ts: the feed shows actions, not reasoning.
function isFeedEvent(event) {
  if (event.kind === 'thought' || event.kind === 'tool-call') return false;
  return Boolean(event.summary?.trim());
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} -> ${response.status}`);
  return response.json();
}

const artifact = (path) => `/api/artifact?path=${encodeURIComponent(path)}`;

async function fetchText(path) {
  const response = await fetch(artifact(path));
  if (!response.ok) throw new Error(String(response.status));
  return response.text();
}

async function refresh({ keepSelection = true } = {}) {
  const snapshot = await getJson('/api/state');
  state.runs = snapshot.runs;
  state.live = snapshot.live;
  state.root = snapshot.root;
  state.summary = await getJson('/api/summary');
  state.overview = await getJson('/api/overview');
  renderHeader();
  const patrol = state.overview.patrol;
  patrolEl.textContent = patrol.state === 'running' ? `Patrol running · cycle ${patrol.cycle}` : 'Patrol stopped';
  patrolEl.classList.toggle('running', patrol.state === 'running');
  liveEl.classList.toggle(
    'working',
    state.overview.agents.some((agent) => agent.state === 'working'),
  );

  // Follow the newest run unless the user has deliberately pinned an older one.
  const stillExists = state.runs.some((r) => r.id === state.selectedRunId);
  if (!keepSelection || !stillExists) state.selectedRunId = state.runs[0]?.id ?? null;

  if (state.view === 'checks' && state.selectedRunId) {
    state.detail = await getJson(`/api/runs/${encodeURIComponent(state.selectedRunId)}`);
  }
  if (state.view === 'issues') {
    state.issues = await getJson('/api/issues');
    state.appmap = await getJson('/api/appmap');
    const visible = visibleIssues();
    if (!visible.some((issue) => issue.id === state.selectedIssueId)) {
      state.selectedIssueId = visible[0]?.id ?? null;
    }
    if (state.selectedIssueId) {
      state.issueDetail = await getJson(`/api/issues/${encodeURIComponent(state.selectedIssueId)}`);
    } else {
      state.issueDetail = null;
    }
  }
  if (state.view === 'activity' || state.view === 'flow') {
    state.sessions = await getJson('/api/sessions');
    if (!state.sessions.some((session) => session.id === state.selectedSessionId)) {
      state.selectedSessionId = state.sessions[0]?.id ?? null;
    }
    if (state.selectedSessionId) {
      state.sessionDetail = await getJson(`/api/sessions/${encodeURIComponent(state.selectedSessionId)}`);
    } else {
      state.sessionDetail = null;
    }
  }
  if (state.view === 'flow') {
    state.flow = state.selectedSessionId
      ? await getJson(`/api/flow/${encodeURIComponent(state.selectedSessionId)}`).catch(() => null)
      : null;
  }
  if (state.view === 'screens') {
    state.appmap = await getJson('/api/appmap');
    state.issues = await getJson('/api/issues');
    state.routines = await getJson('/api/routines');
    // A detail shows only after a click and closes if its screen goes away.
    if (!state.appmap?.screens.some((screen) => screen.id === state.selectedScreenId)) {
      state.selectedScreenId = null;
    }
  }
  if (state.view === 'memory') state.memory = await getJson('/api/memory');
  if (state.view === 'coverage') {
    state.coverage = state.summary.coverage.api ? await getJson('/api/coverage') : null;
    if (!state.coverage?.cells[state.selectedCell]?.exchange) state.selectedCell = null;
    if (state.summary.coverage.screens) {
      state.appmap = await getJson('/api/appmap');
      state.issues = await getJson('/api/issues');
    }
  }
  if (state.view === 'reviews') {
    const reviews = await getJson('/api/reviews');
    if (!reviews.some((review) => review.pr.number === state.selectedReview)) {
      state.selectedReview = reviews[0]?.pr.number ?? null;
    }
    const detail = state.selectedReview ? await getJson(`/api/reviews/${state.selectedReview}`) : null;
    state.reviews = reviews;
    state.reviewDetail = detail;
  }
  // A rebuilt page closes what the reader opened and restarts a playing video: skip it when nothing changed.
  const key = JSON.stringify(state);
  if (key === renderedState && view.childElementCount) return;
  renderedState = key;
  render();
}

function connectLive() {
  const source = new EventSource('/api/events');
  source.addEventListener('changed', () => refresh());
  source.onopen = () => liveEl.classList.remove('stale');
  source.onerror = () => liveEl.classList.add('stale');
}

// ---------------------------------------------------------------- render

function render() {
  // Checks shows `bugpatrol run` gate results. A project with no gate runs
  // (native apps have none) does not need the tab.
  const hasChecks = state.runs.length > 0 || state.live?.status === 'running';
  if (state.view === 'checks' && !hasChecks) state.view = 'overview';
  for (const button of tabs.querySelectorAll('button')) {
    button.classList.toggle('active', button.dataset.view === state.view);
    if (button.dataset.view === 'checks') button.hidden = !hasChecks;
  }
  // The same page, drawn again with new data, keeps what the reader opened and where they were.
  const page = JSON.stringify([
    state.view,
    state.selectedIssueId,
    state.selectedSessionId,
    state.selectedReview,
    state.selectedRunId,
    state.selectedScreenId,
    state.selectedCell,
  ]);
  const opened = page === renderedPage ? detailsOpen() : undefined;
  const scroll = window.scrollY;
  // A scroll box, such as the coverage matrix, keeps its place too.
  const boxes = opened
    ? [...view.querySelectorAll('[data-keep-scroll]')].map((box) => [box.scrollLeft, box.scrollTop])
    : [];
  const typing = opened && document.activeElement?.matches('input[type="search"]');
  renderedPage = page;
  view.innerHTML = '';
  if (state.view === 'checks') {
    const banner = renderLiveBanner();
    if (banner) view.append(banner);
  }
  const renderers = {
    overview: renderOverview,
    issues: renderIssues,
    activity: renderActivity,
    flow: renderFlow,
    screens: renderScreens,
    reviews: renderReviews,
    memory: renderMemory,
    coverage: renderCoverage,
    checks: renderRuns,
  };
  view.append(renderers[state.view]());
  if (opened) {
    for (const [key, details] of detailsByKey()) if (opened.has(key)) details.open = opened.get(key);
    for (const [index, box] of [...view.querySelectorAll('[data-keep-scroll]')].entries())
      if (boxes[index]) [box.scrollLeft, box.scrollTop] = boxes[index];
    if (typing) view.querySelector('input[type="search"]')?.focus();
    window.scrollTo(0, scroll);
  }
}

/** Each <details> on the page by its summary and its place among the ones with the same summary. */
function detailsByKey() {
  const seen = new Map();
  return [...view.querySelectorAll('details')].map((details) => {
    const summary = details.querySelector('summary')?.textContent ?? '';
    const nth = (seen.get(summary) ?? 0) + 1;
    seen.set(summary, nth);
    return [`${summary}#${nth}`, details];
  });
}

function detailsOpen() {
  return new Map(detailsByKey().map(([key, details]) => [key, details.open]));
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value !== undefined && value !== null) node.setAttribute(key, String(value));
  }
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
}

function svgEl(tag, props = {}, children = []) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value !== undefined && value !== null) node.setAttribute(key, String(value));
  }
  for (const child of children) if (child) node.append(child);
  return node;
}

/** Shown only while a run is actually in flight. */
function renderLiveBanner() {
  const live = state.live;
  if (live?.status !== 'running') return null;
  const done = live.captured.length;
  const total = live.plannedCaptures || done;
  return el('div', { class: 'runbanner' }, [
    el('span', { class: 'spinner' }),
    el('span', { text: `Run in progress: ${done}/${total} captures` }),
    live.currentStep ? el('span', { class: 'muted', text: live.currentStep }) : null,
  ]);
}

function renderRuns() {
  if (state.runs.length === 0) {
    return el('div', {
      class: 'empty',
      html:
        state.live?.status === 'running'
          ? 'First check in progress.'
          : 'No runs yet. Run <code>bugpatrol run</code> in this project and results appear here automatically.',
    });
  }

  const list = el(
    'div',
    { class: 'card runlist' },
    state.runs.map((run) => {
      const button = el(
        'button',
        {
          class: `runitem${run.id === state.selectedRunId ? ' active' : ''}`,
          onclick: async () => {
            state.selectedRunId = run.id;
            state.detail = await getJson(`/api/runs/${encodeURIComponent(run.id)}`);
            render();
          },
        },
        [
          el('div', { class: 'row' }, [
            el('span', { class: `badge ${verdictClass(run)}`, text: verdictLabel(run) }),
            el('span', { class: 'mono', text: shortCommit(run.commit) }),
          ]),
          el('div', {
            class: 'when',
            text: `${formatTime(run.startedAt)} · ${run.mode} · ${run.findings.total} finding(s)`,
          }),
        ],
      );
      return button;
    }),
  );

  return el('div', { class: 'layout' }, [list, renderDetail()]);
}

function renderDetail() {
  if (!state.detail) return el('div', { class: 'card empty', text: 'Select a run.' });
  const { run, findings, trace } = state.detail;

  const header = el('div', {}, [
    el('h2', {}, [
      el('span', {
        class: `badge ${verdictClass(summaryOf(run, findings))}`,
        text: verdictLabel(summaryOf(run, findings)),
      }),
      el('span', { text: `  ${run.mode} run on ${shortCommit(run.commit)}` }),
    ]),
    el('div', { class: 'kv' }, [
      el('span', { text: `${run.plan.coverage.screensSelected}/${run.plan.coverage.screensTotal} screens` }),
      el('span', { text: `exit ${run.exitCode}` }),
      el('span', { text: `${run.suppressionCount} suppressed` }),
      el('span', { text: `$${(run.cost.decisionUsd ?? 0).toFixed(5)} decision spend` }),
      el('span', { text: formatTime(run.startedAt) }),
    ]),
  ]);

  const children = [header];

  if (!trace) {
    children.push(
      el('div', { class: 'notes' }, [
        el('p', { text: 'This run predates the trace format, so only its findings are available.' }),
      ]),
    );
  }

  const byScreen = new Map();
  for (const finding of findings) {
    const key = String(finding.screenId ?? '');
    if (!byScreen.has(key)) byScreen.set(key, []);
    byScreen.get(key).push(finding);
  }

  // A trace screen is one page at one viewport, and it records exactly which
  // findings it produced. Grouping by page alone listed the mobile findings
  // under desktop too, so every finding appeared twice.
  const byId = new Map(findings.map((f) => [f.id, f]));
  const seen = new Set();
  const viewports = new Map();
  for (const screen of trace?.screens ?? []) {
    for (const id of screen.findingIds ?? []) {
      const finding = byId.get(id);
      if (!finding) continue;
      const key = `${finding.screenId}|${problemKey(finding)}`;
      if (!viewports.has(key)) viewports.set(key, new Set());
      viewports.get(key).add(screen.viewport);
    }
  }
  for (const screen of trace?.screens ?? []) {
    const own = Array.isArray(screen.findingIds)
      ? screen.findingIds.map((id) => byId.get(id)).filter(Boolean)
      : (byScreen.get(screen.screenId) ?? []);
    const unique = own.filter((finding) => !seen.has(`${finding.screenId}|${problemKey(finding)}`));
    for (const finding of unique) seen.add(`${finding.screenId}|${problemKey(finding)}`);
    children.push(renderScreen(screen, unique, trace, viewports));
  }

  if (trace?.suppressed?.length) {
    children.push(
      el('div', { class: 'screen' }, [
        el('h3', { text: `Suppressed by the Intent Ledger (${trace.suppressed.length})` }),
        ...trace.suppressed.map((s) =>
          el('div', { class: 'finding' }, [
            el('div', { text: `${s.ruleId} on ${s.screenId}` }),
            el('div', { class: 'why', text: `"${s.reason}": ${s.decidedBy}` }),
          ]),
        ),
      ]),
    );
  }

  return el('div', { class: 'card detail' }, children);
}

function renderScreen(screen, findings, trace, viewports) {
  const shots = [];
  if (screen.artifacts.baseline) shots.push(shot(screen.artifacts.baseline, 'expected'));
  if (screen.artifacts.actual) shots.push(shot(screen.artifacts.actual, 'actual'));
  if (screen.artifacts.diff) shots.push(shot(screen.artifacts.diff, 'diff'));

  const fired = screen.checks.filter((c) => c.fired);
  const passed = screen.checks.filter((c) => !c.fired);

  return el('section', { class: 'screen' }, [
    el('div', { class: 'screen-head' }, [
      el('strong', { text: screen.title || screen.screenId }),
      el('span', { class: 'vp', text: `${screen.viewport} · ${screen.url}` }),
      screen.baselineCreated ? el('span', { class: 'badge info', text: 'baseline created' }) : null,
    ]),

    shots.length ? el('div', { class: 'shots' }, shots) : null,

    el('div', { class: 'checks' }, [
      ...fired.map((c) =>
        el('span', { class: `chk fired sev-${c.severity ?? 'minor'}`, title: c.message ?? '', text: c.ruleId }),
      ),
      passed.length ? el('span', { class: 'muted', text: `${passed.length} other checks passed` }) : null,
    ]),

    ...groupFindings(findings).map((group) => renderGroup(group, trace, viewports)),

    renderReasoning(screen),
  ]);
}

/** Same rule, same claim, different element: one problem. Mirrors graph.ts. */
function problemKey(finding) {
  return `${finding.ruleId}|${finding.route}|${(finding.summary ?? '').replace(/"[^"]*"/, '"…"')}`;
}

function groupFindings(findings) {
  const groups = new Map();
  for (const finding of findings) {
    const key = problemKey(finding);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(finding);
  }
  return [...groups.values()];
}

function renderGroup(group, trace, viewports) {
  const first = group[0];
  const key = `${first.screenId}|${problemKey(first)}`;
  const tags = [...(viewports.get(key) ?? [])];
  if (group.length === 1) {
    const card = renderFinding(first, trace);
    card.append(
      el(
        'div',
        { class: 'viewport-tags' },
        tags.map((viewport) => el('span', { text: viewport })),
      ),
    );
    return card;
  }
  const card = renderFinding(
    {
      ...first,
      summary: first.summary.replace(/"[^"]*"/, `${group.length} elements`),
    },
    trace,
  );
  card.append(
    el(
      'div',
      { class: 'viewport-tags' },
      tags.map((viewport) => el('span', { text: viewport })),
    ),
  );
  const selectors = group.map((f) => (f.summary.match(/"([^"]*)"/) ?? [])[1]).filter(Boolean);
  card.append(
    el('details', { class: 'members' }, [
      el('summary', { text: `The same problem on ${group.length} elements` }),
      el(
        'ul',
        {},
        selectors.map((sel) => el('li', {}, [el('code', { text: sel })])),
      ),
    ]),
  );
  return card;
}

function renderFinding(finding, trace) {
  const why = trace?.findings?.find((t) => t.findingId === finding.id)?.routeReason;
  return el('div', { class: `finding sev-${finding.severity}` }, [
    el('div', { text: finding.summary }),
    why ? el('div', { class: 'why', text: `Routed to ${finding.route}: ${why}` }) : null,
    el('div', {
      class: 'meta',
      text: `${finding.ruleId} · ${finding.tier} · ${finding.severity} · ${finding.fingerprint}`,
    }),
  ]);
}

/**
 * The "show your work" panel. Everything that led to the verdict for this
 * screen: how the capture settled, what the diff measured, what was masked,
 * and what the decision layer was asked.
 */
function renderReasoning(screen) {
  const rows = [];
  const add = (label, value) => {
    if (value !== undefined && value !== null && value !== '') rows.push([label, value]);
  };

  if (screen.stability) {
    add('Capture settled', `after ${screen.stability.frames} frame(s), ${screen.stability.elapsedMs}ms`);
  }
  add('Selected because', screen.planReason);

  if (screen.diff) {
    const d = screen.diff;
    add(
      'Pixel diff',
      d.identical
        ? `identical (${d.engine}, ${Math.round(d.durationMs)}ms)`
        : `${d.changedPixels} px across ${d.regionCount} region(s): ` +
            `${(d.changedFraction * 100).toFixed(3)}% of compared area (${d.engine})`,
    );
    add('Masked', `${(d.maskedFraction * 100).toFixed(1)}% of the screen, ` + `${d.maskedRegionCount} region(s)`);
    if (!d.enginesAgreed) add('Engines disagreed', `cross-check saw ${d.crossCheckChangedPixels} px`);
    // First line only: older runs stored the loader's full multi-line dump.
    if (d.degraded) add('Degraded', d.degraded.split('\n')[0].replace(/(: \/\S+)+.*$/, ''));
    if (d.dimensionMismatch) {
      add('Dimensions changed', `${d.dimensionMismatch.baseline.join('x')} → ${d.dimensionMismatch.actual.join('x')}`);
    }
  }

  if (screen.maskedSelectors?.length) add('Mask selectors', screen.maskedSelectors.join(', '));
  if (screen.missingFonts?.length) add('Missing fonts', screen.missingFonts.join(', '));
  if (screen.consoleErrors?.length) add('Console errors', screen.consoleErrors.slice(0, 5).join(' | '));
  if (screen.links?.length) {
    add('Links found', `${screen.links.length} (${screen.links.filter((l) => l.external).length} external)`);
  }

  if (screen.decision) {
    const d = screen.decision;
    add(
      'Decision layer',
      d.decider === 'none' ? `not consulted: ${d.skippedReason}` : `${d.decider}, $${(d.costUsd ?? 0).toFixed(6)}`,
    );
    if (d.stateChars) add('State digest', `${d.stateChars} chars (hash ${String(d.stateHash ?? '').slice(0, 12)})`);
    for (const [key, answer] of Object.entries(d.answers ?? {})) {
      add(`· ${key}`, `${answer.value} (confidence ${Number(answer.confidence).toFixed(2)})`);
    }
  }

  return el('details', { class: 'reasoning' }, [
    el('summary', { text: 'How Bugpatrol reached this' }),
    el(
      'table',
      {},
      rows.map(([k, v]) => el('tr', {}, [el('td', { text: k }), el('td', { text: String(v) })])),
    ),
  ]);
}

function shot(path, caption) {
  const img = el('img', {
    src: artifact(path),
    alt: caption,
    loading: 'lazy',
    onclick: () => openLightbox(path, caption),
  });
  return el('figure', {}, [img, el('figcaption', { text: caption })]);
}

// Agent views use text nodes for all state read from disk. Even markdown is built
// from a small allowlist of DOM elements rather than inserted as HTML.
const roleIcons = {
  explorer: '<circle cx="8" cy="8" r="5"/><path d="m8 4 2 4-4 2 2-6Z"/>',
  judge: '<path d="M3 6h10M8 3v9M5 12h6M4 6l-2 4h4L4 6Zm8 0-2 4h4l-2-4Z"/>',
  fixer: '<path d="M10 3a3 3 0 0 0-3 4l-4 4a2 2 0 0 0 2 2l4-4a3 3 0 0 0 4-3l-2 1-2-2 1-2Z"/>',
  system: '<circle cx="8" cy="8" r="5"/>',
  decider: '<path d="m3 8 3 3 7-7"/>',
};

function roleIcon(role) {
  const icon = roleIcons[role] ?? roleIcons.system;
  const svg =
    `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" ` +
    `stroke-width="1.4" aria-hidden="true">${icon}</svg>`;
  return el('span', { class: 'role-icon', title: role, 'aria-label': role, html: svg });
}

function relativeTime(value) {
  if (!value) return '-';
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (!Number.isFinite(seconds)) return value;
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hr ago`;
  return `${Math.floor(seconds / 86400)} d ago`;
}

function money(value) {
  return `$${Number(value ?? 0).toFixed(3)}`;
}

function count(value) {
  const n = Number(value ?? 0);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** "25.6k in · 4 out tokens", or a dash when the runtime reported no usage. */
function tokens(usage, suffix = ' tokens') {
  if (!usage) return `no tokens reported`;
  return `${usage.estimated ? '~' : ''}${count(usage.input)} in · ${count(usage.output)} out${suffix}`;
}

function tokenDetail(usage) {
  if (!usage) return 'The runtime reported no token usage.';
  return [
    `${usage.input} input tokens`,
    usage.cacheRead ? `${usage.cacheRead} of them from the cache` : '',
    usage.cacheWrite ? `${usage.cacheWrite} written to the cache` : '',
    `${usage.output} output tokens`,
    usage.listCostUsd ? `list price ${money(usage.listCostUsd)}` : '',
    usage.estimated ? 'estimated from the text length' : '',
  ]
    .filter(Boolean)
    .join(', ');
}

function renderUsage(usage) {
  const rows = usage?.week ?? [];
  const head = ['Agent', 'Model', 'Sessions', 'Input', 'Cached', 'Output', 'Per session', 'List price'];
  return el('section', { class: 'card panel usage' }, [
    title('Token usage', usage?.weekTotal ? `Last 7 days · ${tokens(usage.weekTotal)}` : 'Last 7 days'),
    rows.length
      ? el('table', { class: 'usage-table' }, [
          el(
            'tr',
            {},
            head.map((text) => el('th', { text })),
          ),
          ...rows.map((row) =>
            el('tr', { title: tokenDetail(row.tokens) }, [
              el('td', { text: capital(row.role) }),
              el('td', { text: row.model }),
              el('td', { text: String(row.sessions) }),
              el('td', { text: count(row.tokens.input) }),
              el('td', { text: row.tokens.cacheRead ? count(row.tokens.cacheRead) : '-' }),
              el('td', { text: count(row.tokens.output) }),
              el('td', { text: count(Math.round((row.tokens.input + row.tokens.output) / Math.max(1, row.sessions))) }),
              el('td', { text: row.tokens.listCostUsd ? money(row.tokens.listCostUsd) : '-' }),
            ]),
          ),
        ])
      : el('p', {
          class: 'empty',
          text: 'No token usage yet. The API agents, claude (--output-format json), and codex (--json) report their tokens.',
        }),
  ]);
}

/** A capture file: a screenshot, or the exchange file of an API, which shows as text. */
function captureFile(path, label, className = '') {
  if (!path) return el('div', { class: `image-empty ${className}`, text: 'No capture' });
  if (path.endsWith('.exchange.json')) {
    const small = isThumb(className);
    const view = small
      ? httpThumb(undefined, label, className)
      : el('pre', { class: `http ${className}`, title: label, text: 'Loading the exchange…' });
    // The server formats the exchange, so the dashboard shows the same text as the models and issues.
    fetch(`/api/exchange?path=${encodeURIComponent(path)}`)
      .then((response) => (response.ok ? response.text() : Promise.reject(new Error(String(response.status)))))
      .then((text) => {
        if (small) view.textContent = text.match(/^HTTP \d{3}/m)?.[0] ?? 'HTTP';
        else view.textContent = text;
      })
      .catch(() => {
        if (!small) view.textContent = 'The exchange is not available.';
      });
    return view;
  }
  return el('img', {
    class: className,
    src: artifact(path),
    alt: label,
    loading: 'lazy',
    onclick: () => openLightbox(path, label),
  });
}

/** The capture of an issue: its screenshot, or the HTTP exchange of an API as the server formatted it. */
function captureView(capture, label, className = '') {
  if (capture?.kind !== 'http') return captureFile(capture?.screenshot, label, className);
  if (isThumb(className)) return httpThumb(capture.exchange?.response?.status, label, className);
  return el('pre', { class: `http ${className}`, title: label, text: capture.text });
}

const isThumb = (className) => /\b(?:thumb|event-thumb)\b/.test(className);

/** A thumbnail is too small for the exchange text, so it shows the status only. */
function httpThumb(status, label, className) {
  return el('div', { class: `http-thumb ${className}`, title: label, text: status ? `HTTP ${status}` : 'HTTP' });
}

function severityChip(value) {
  return el('span', { class: `severity severity-${value}`, text: value });
}

function title(text, aside) {
  return el('div', { class: 'section-title' }, [
    el('h2', { text }),
    aside ? el('span', { class: 'muted', text: aside }) : null,
  ]);
}

// ---------------------------------------------------------------- shared blocks

const DOCS = 'https://github.com/agent-labs-dev/bugpatrol/blob/main/docs';

const PLATFORM_WORDS = {
  api: 'API',
  web: 'Web app',
  electron: 'Electron app',
  desktop: 'Desktop app',
  ios: 'iOS app',
  android: 'Android app',
  cli: 'CLI app',
};

const surfaceName = (surface) => PLATFORM_WORDS[surface.platform] ?? surface.platform;
const fileName = (path) => path?.split('/').pop() ?? '';

function surfacesOf(kind) {
  return (state.summary?.surfaces ?? []).filter((surface) => surface.kind === kind);
}

/** The project's surfaces in the top bar. The surface of the config that the dashboard reads is marked. */
function renderHeader() {
  const summary = state.summary;
  projectEl.textContent = summary.name;
  surfacesEl.replaceChildren(
    ...summary.surfaces.map((surface) =>
      el('span', {
        class: `surface${surface.active ? ' active' : ''}`,
        title: surface.configs.length
          ? `${surface.active ? 'The dashboard reads' : 'Config'}: ${surface.configs.join(', ')}`
          : 'From the data. No config file tests it now.',
        text: surfaceName(surface),
      }),
    ),
    summary.config ? el('span', { class: 'muted', title: summary.config, text: fileName(summary.config) }) : null,
  );
}

/** A command for the config that the dashboard reads, or for the config of another surface. */
function cli(args, surface) {
  const config =
    surface && !surface.active && surface.configs[0]
      ? ` --config ${surface.configs[0]}`
      : (state.summary?.configArg ?? '');
  return `bugpatrol ${args}${config}`;
}

/** A command with a copy button. */
function commandBox(text) {
  const button = el('button', {
    type: 'button',
    class: 'copy',
    text: 'Copy',
    'aria-label': `Copy the command ${text}`,
  });
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = 'Copied';
    } catch {
      button.textContent = 'Copy failed';
    }
    setTimeout(() => {
      button.textContent = 'Copy';
    }, 1500);
  });
  return el('div', { class: 'command' }, [el('code', { text }), button]);
}

/**
 * The one empty state of the dashboard: what the block shows, why it is
 * empty now, and the one next step, as a command or a button.
 */
function emptyState({ heading, why = [], command, action, docs, compact = false }) {
  return el('div', { class: `empty-state${compact ? ' compact' : ''}` }, [
    el('h3', { text: heading }),
    ...[].concat(why).map((text) => el('p', { text })),
    command ? commandBox(command) : null,
    action ? el('button', { type: 'button', class: 'primary', text: action.label, onclick: action.onclick }) : null,
    docs
      ? el('a', { class: 'docs', href: docs, target: '_blank', rel: 'noopener noreferrer', text: 'Read the docs' })
      : null,
  ]);
}

/** A note with one command, for a block that has data but also a next step. */
function callout(text, command) {
  return el('div', { class: 'callout' }, [el('p', { text }), commandBox(command)]);
}

const number = (value) => Number(value ?? 0).toLocaleString('en-US');

function percent(part, whole) {
  if (!whole) return '0%';
  const value = (part / whole) * 100;
  return value > 0 && value < 1 ? '<1%' : `${Math.round(value)}%`;
}

/** A row of numbers. A stat with an action is a button. */
function statBand(stats, className = '') {
  return el(
    'div',
    { class: `band ${className}` },
    stats.filter(Boolean).map(({ label, value, note, tone, bar, go }) =>
      el(
        go ? 'button' : 'div',
        {
          class: `stat${tone ? ` tone-${tone}` : ''}`,
          ...(go ? { type: 'button', onclick: go } : {}),
        },
        [
          el('span', { class: 'stat-label', text: label }),
          el('strong', { class: 'stat-value', text: String(value) }),
          bar ?? null,
          note ? el('span', { class: 'stat-note', title: note, text: note }) : null,
        ],
      ),
    ),
  );
}

const CELL_STATES = ['pass', 'fail', 'blocked', 'skip', 'untested'];

/** The cases of each state as one stacked bar. */
function caseBar(cases) {
  const states = CELL_STATES.filter((name) => cases[name]);
  const total = states.reduce((sum, name) => sum + cases[name], 0);
  return el(
    'div',
    { class: 'bar', role: 'img', 'aria-label': states.map((name) => `${number(cases[name])} ${name}`).join(', ') },
    states.map((name) =>
      el('span', {
        class: `bar-${name}`,
        style: `flex-grow: ${cases[name] / total}`,
        title: `${number(cases[name])} ${name}`,
      }),
    ),
  );
}

function caseLegend(cases) {
  return el(
    'div',
    { class: 'bar-legend' },
    CELL_STATES.filter((name) => cases[name] !== undefined).map((name) =>
      el('span', {}, [el('i', { class: `bar-${name}` }), `${number(cases[name])} ${name}`]),
    ),
  );
}

async function go(view) {
  state.view = view;
  if (view === 'screens') state.selectedScreenId = null;
  await refresh();
}

async function openSession(id) {
  state.view = 'activity';
  state.selectedSessionId = id;
  await refresh();
}

function formatDuration(ms) {
  if (ms === undefined) return '-';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

const CI_WORDS = { pending: 'CI running', passed: 'CI green', failed: 'CI failed, fixing', 'gave-up': 'CI red' };

function githubChip({ kind, number, url, state, draft, ci }) {
  const label = kind === 'pr' ? 'PR' : 'Issue';
  const shown = state === 'open' && draft ? 'draft' : state;
  const checks = state === 'open' || !state ? CI_WORDS[ci] : undefined;
  return el('a', {
    href: url,
    target: '_blank',
    rel: 'noopener noreferrer',
    class: `gh-chip gh-${shown || 'unknown'}${checks ? ` ci-${ci}` : ''}`,
    text: `${label} #${number}${shown ? ` · ${shown}` : ''}${checks ? ` · ${checks}` : ''}`,
    onclick: (event) => event.stopPropagation(),
  });
}

function issueChips(issue) {
  return [
    issue.pr ? githubChip({ kind: 'pr', ...issue.pr }) : null,
    issue.github ? githubChip({ kind: 'issue', ...issue.github }) : null,
  ];
}

function renderOverview() {
  const data = state.overview;
  const summary = state.summary;
  if (!data || !summary) return el('div', { class: 'empty', text: 'Loading overview…' });
  const agents = el(
    'div',
    { class: 'agent-grid' },
    data.agents.map((agent) =>
      el('article', { class: 'card agent-card' }, [
        el('div', { class: 'agent-head' }, [
          roleIcon(agent.role),
          el('strong', { text: capital(agent.role) }),
          el('span', { class: `state-dot ${agent.state}`, title: agent.state }),
        ]),
        el('div', { class: 'muted', text: agent.runtime || 'No runtime configured' }),
        el('p', { text: agent.activity || capital(agent.state) }),
        // Bugpatrol sees only the API calls that it makes. A local agent CLI
        // bills the user's own plan, so its cost is not in this number.
        el('div', {
          class: 'muted',
          title: tokenDetail(data.usage?.todayByRole?.[agent.role]),
          text: `${tokens(data.usage?.todayByRole?.[agent.role])} today`,
        }),
        el('div', {
          class: 'muted',
          text:
            `API ${money(agent.spentUsd)} today` +
            (String(agent.runtime).startsWith('cli') ? ' · the model runs on your CLI plan' : ''),
        }),
      ]),
    ),
  );
  return el('div', {}, [
    renderConfidence(summary),
    el('div', { class: 'overview-grid' }, [
      renderAttention(data, summary),
      el('div', { class: 'stack-gap' }, [data.live ? renderLive(data.live) : null, renderRecentSessions(data)]),
    ]),
    renderSurfaceCoverage(data, summary),
    agents,
    renderUsage(data.usage),
  ]);
}

/** The numbers that say if the project works: the verdict, the open problems, the coverage, and the last session. */
function renderConfidence(summary) {
  const { issues, waiting, coverage, lastSession, verdict } = summary;
  const severe = issues.bySeverity.critical + issues.bySeverity.major;
  const api = coverage.api;
  return statBand(
    [
      { label: 'Status', value: verdict.text, tone: verdict.tone },
      {
        label: 'Open issues',
        value: number(issues.open),
        note: severe ? `${severe} critical or major` : issues.open ? 'None is critical or major' : 'None',
        tone: severe ? 'fail' : undefined,
        go: () => go('issues'),
      },
      {
        label: 'Wait for the judge',
        value: number(waiting.total),
        note: waiting.repeat
          ? `${number(waiting.repeat)} failed two times`
          : waiting.total
            ? 'The judge did not read them yet'
            : 'None',
        tone: waiting.total ? 'warn' : undefined,
        go: () => go('activity'),
      },
      surfacesOf('api').length
        ? {
            label: 'API coverage',
            value: api ? percent(api.tested, api.endpoints) : '-',
            note: api ? `${number(api.tested)} of ${number(api.endpoints)} endpoints tested` : 'No sweep yet',
            go: () => go('coverage'),
          }
        : null,
      surfacesOf('client').length
        ? {
            label: 'Screens',
            value: number(coverage.screens?.found),
            note: coverage.screens?.found ? `${coverage.screens.withIssues} with open issues` : 'No screens yet',
            go: () => go('coverage'),
          }
        : null,
      {
        label: 'Last session',
        value: lastSession ? (lastSession.status === 'running' ? 'Running' : relativeTime(lastSession.startedAt)) : '-',
        note: lastSession
          ? firstSentence(lastSession.summary) || `${capital(lastSession.role)} session`
          : 'No session yet',
        go: lastSession ? () => openSession(lastSession.id) : undefined,
      },
    ],
    'confidence',
  );
}

/** The open issues, then the findings that wait for the judge. */
function renderAttention(data, summary) {
  const { issues, waiting } = summary;
  const tested = summary.verdict.tone !== 'info';
  const issueRows = data.attention.map((issue) =>
    el('button', { class: 'attention-row', onclick: () => openIssue(issue.id) }, [
      captureView(issue.evidence?.capture, issue.title, 'thumb'),
      el('span', { class: 'grow' }, [
        el('strong', { text: issue.title }),
        el('span', { class: 'row-meta' }, [
          el('small', { class: 'muted', text: `${issueWhere(issue)} · ×${issue.occurrences}` }),
          ...issueChips(issue),
        ]),
      ]),
      severityChip(issue.severity),
      el('span', { class: 'muted', text: issueStatus(issue, issue.fix) }),
    ]),
  );
  const waitingRows = data.waiting.slice(0, 5).map((candidate) =>
    el('button', { class: 'attention-row', onclick: () => openSession(candidate.sessionId) }, [
      captureView(candidate.capture, candidate.summary, 'thumb'),
      el('span', { class: 'grow' }, [
        el('strong', { class: 'truncate', text: candidate.summary }),
        el('small', {
          class: 'muted',
          text: `${candidate.blocking ? 'Failed two times' : capital(candidate.source)} · ${relativeTime(candidate.createdAt)}`,
        }),
      ]),
      severityChip(candidate.severity),
    ]),
  );
  return el('section', { class: 'card panel' }, [
    title('Needs attention', `${number(issues.open)} open · ${number(waiting.total)} wait for the judge`),
    issueRows.length || waitingRows.length
      ? null
      : emptyState({
          heading: tested ? 'Nothing needs attention' : 'Not tested yet',
          why: tested
            ? 'No issue is open, and no finding waits for the judge.'
            : 'A patrol tests the project. The explorer reports findings, and the judge files the real problems as issues.',
          command: cli('patrol --once'),
          compact: true,
        }),
    issueRows.length ? el('div', { class: 'stack' }, issueRows) : null,
    waitingRows.length
      ? el('div', { class: 'subsection' }, [
          el('h3', { text: `Findings that wait for the judge (${number(waiting.total)})` }),
          callout(
            'The judge reads each finding and files the real problems as issues. Run the judge now:',
            cli('patrol --once'),
          ),
          el('div', { class: 'stack' }, waitingRows),
          waiting.total > waitingRows.length
            ? el('button', {
                type: 'button',
                class: 'link',
                text: `Show all ${number(waiting.total)} findings in Activity`,
                onclick: () => go('activity'),
              })
            : null,
        ])
      : null,
  ]);
}

function renderLive(live) {
  return el('section', { class: 'card panel' }, [
    title('Live', 'Session running'),
    captureFile(live.capture, 'Newest session capture', 'live-shot'),
    el('div', { class: 'event-list' }, live.events.map(renderEventRow)),
  ]);
}

/** One coverage block for each surface: the endpoints of an API, the screens of a client app. */
function renderSurfaceCoverage(data, summary) {
  const blocks = summary.surfaces.map((surface) =>
    el('div', { class: 'surface-block' }, [
      el('div', { class: 'surface-head' }, [
        el('h3', { text: surfaceName(surface) }),
        surface.configs[0] ? el('span', { class: 'muted mono', text: fileName(surface.configs[0]) }) : null,
      ]),
      surface.kind === 'api'
        ? apiCoverageBlock(summary.coverage.api, surface)
        : screenCoverageBlock(data, summary, surface),
    ]),
  );
  return el('section', { class: 'card panel block' }, [
    title('Coverage', summary.surfaces.length > 1 ? 'For each surface' : ''),
    data.github ? el('div', { class: 'muted github-summary', text: `GitHub · ${data.github}` }) : null,
    blocks.length
      ? el('div', { class: 'surface-list' }, blocks)
      : emptyState({
          heading: 'No config yet',
          why: 'Bugpatrol reads the config in .bugpatrol/ to know what to test.',
          command: 'bugpatrol init',
          compact: true,
        }),
  ]);
}

function apiCoverageBlock(api, surface) {
  if (!api)
    return emptyState({
      heading: 'No sweep yet',
      why: 'The sweep sends each case of each endpoint and checks the answer against the spec.',
      command: cli('sweep', surface),
      compact: true,
    });
  return el('button', { type: 'button', class: 'surface-numbers', onclick: () => go('coverage') }, [
    el('div', { class: 'surface-line' }, [
      el('strong', { class: 'big', text: percent(api.tested, api.endpoints) }),
      el('span', { text: `of the endpoints tested: ${number(api.tested)} of ${number(api.endpoints)}` }),
    ]),
    caseBar(api.cases),
    caseLegend(api.cases),
    api.remaining
      ? el('small', { class: 'muted', text: `${number(api.remaining)} cases wait for the next sweep.` })
      : null,
  ]);
}

function screenCoverageBlock(data, summary, surface) {
  const screens = summary.coverage.screens;
  if (!screens?.found)
    return emptyState({
      heading: 'No screens yet',
      why: surface.configs[0]
        ? `${fileName(surface.configs[0])} tests the ${surfaceName(surface).toLowerCase()}. The explorer finds its screens when it runs.`
        : 'The explorer finds the screens when it runs.',
      command: cli('explore', surface),
      compact: true,
    });
  return el('div', {}, [
    el('div', { class: 'surface-line' }, [
      el('strong', { class: 'big', text: number(screens.found) }),
      el('span', {
        text: `screens found · ${number(screens.replayable)} with a routine · ${number(screens.withIssues)} with open issues`,
      }),
    ]),
    el(
      'div',
      { class: 'coverage-row' },
      data.screens.map((screen) =>
        el('button', { class: 'coverage-item', onclick: () => openScreen(screen.id) }, [
          captureFile(screen.lastCapture, screen.name),
          el('span', { text: screen.name }),
        ]),
      ),
    ),
  ]);
}

function renderRecentSessions(data) {
  const next = data.patrol?.nextAt
    ? `Next patrol at ${new Date(data.patrol.nextAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    : data.live
      ? ''
      : 'Quiet now';
  return el('section', { class: 'card panel' }, [
    title('Recent sessions', next),
    data.recentSessions.length
      ? el(
          'div',
          { class: 'stack' },
          data.recentSessions.map((session) =>
            el('button', { class: 'list-row', onclick: () => openSession(session.id) }, [
              roleIcon(session.role),
              el('span', { class: 'grow' }, [
                el('strong', {
                  class: 'truncate',
                  text: firstSentence(session.summary) || `${capital(session.role)} session`,
                }),
                el('small', {
                  class: 'muted',
                  text: `${capital(session.role)} · ${relativeTime(session.startedAt)} · ${duration(session)}`,
                }),
              ]),
              el('span', { class: `badge ${SESSION_BADGE[session.status] ?? 'info'}`, text: session.status }),
            ]),
          ),
        )
      : emptyState({
          heading: 'No sessions yet',
          why: 'Each run of an agent is a session.',
          command: cli('patrol --once'),
          compact: true,
        }),
  ]);
}

const SESSION_BADGE = { running: 'warn', failed: 'fail', finished: 'info' };

/** Where an issue shows: its screen, or for an API issue, its request. */
function issueWhere(issue) {
  const request = issue.evidence?.capture?.kind === 'http' ? issue.evidence.capture.exchange?.request : undefined;
  return !issue.screenId && request ? `${request.method} ${request.path}` : screenName(issue.screenId);
}

function screenName(id) {
  return (
    state.appmap?.screens.find((screen) => screen.id === id)?.name ||
    state.overview?.screens.find((screen) => screen.id === id)?.name ||
    id ||
    'Unknown screen'
  );
}

function capital(value) {
  return value ? value[0].toUpperCase() + value.slice(1) : '';
}

async function openIssue(id) {
  state.view = 'issues';
  state.selectedIssueId = id;
  await refresh();
}

function renderIssues() {
  if (!state.issues.length) {
    const { waiting, verdict } = state.summary;
    return el('section', { class: 'card panel' }, [
      title('Issues'),
      emptyState({
        heading: 'No issues yet',
        why: [
          'An issue is a problem that the judge confirmed, with its evidence, its steps, and its fix.',
          waiting.total
            ? `${number(waiting.total)} findings wait for the judge now. The judge files the real problems as issues.`
            : verdict.tone === 'info'
              ? 'Bugpatrol did not test this project yet.'
              : 'The judge found no real problem yet.',
        ],
        command: cli('patrol --once'),
        action: waiting.total ? { label: 'Show the findings', onclick: () => go('activity') } : undefined,
      }),
    ]);
  }
  const filters = ['open', 'fixed', 'dismissed', 'all'];
  const filtered = visibleIssues();
  const list = el('div', { class: 'card panel' }, [
    title('Issues', `${filtered.length}`),
    el(
      'div',
      { class: 'filters' },
      filters.map((filter) =>
        el('button', {
          class: `filter ${state.issueFilter === filter ? 'active' : ''}`,
          text: capital(filter),
          onclick: async () => {
            state.issueFilter = filter;
            await refresh();
          },
        }),
      ),
    ),
    filtered.length
      ? null
      : el('p', { class: 'muted', text: `No issue is ${state.issueFilter}. Select a different filter.` }),
    ...filtered.map((issue) =>
      el(
        'button',
        { class: `list-row ${issue.id === state.selectedIssueId ? 'active' : ''}`, onclick: () => openIssue(issue.id) },
        [
          // The chips sit under the title, so a long title keeps the row's width.
          el('span', { class: 'grow' }, [
            el('strong', { text: issue.title }),
            el('span', { class: 'row-meta' }, [
              el('small', {
                class: 'muted',
                text: `${issueWhere(issue)} · ${relativeTime(issue.lastSeenAt)}`,
              }),
              ...issueChips(issue),
            ]),
          ]),
          severityChip(issue.severity),
        ],
      ),
    ),
  ]);
  return el('div', { class: 'master-detail' }, [list, renderIssueDetail()]);
}

function visibleIssues() {
  return state.issues.filter(
    (issue) =>
      state.issueFilter === 'all' ||
      (state.issueFilter === 'open'
        ? !['fixed', 'dismissed'].includes(issue.status)
        : issue.status === state.issueFilter),
  );
}

function renderIssueDetail() {
  const detail = state.issueDetail;
  if (!detail) return el('section', { class: 'card panel empty', text: 'Select an issue.' });
  const { issue, fix, candidates, gaveUpAfter, attemptDiffs = {} } = detail;
  const evidence = issue.evidence ?? {};
  const capture = evidence.capture;
  const shots =
    capture?.kind === 'http'
      ? [
          el('figure', { class: 'http-evidence' }, [
            captureView(capture, 'HTTP exchange'),
            el('figcaption', { text: 'HTTP exchange' }),
          ]),
        ]
      : [
          ['Screenshot', capture?.screenshot],
          ['Baseline', capture?.baseline],
          ['Diff', capture?.diff],
        ]
          .filter(([, path]) => path)
          .map(([label, path]) => el('figure', {}, [captureFile(path, label), el('figcaption', { text: label })]));
  const steps = evidence.steps ?? detail.routine?.steps ?? [];
  return el('article', { class: 'card panel issue-detail' }, [
    el('div', { class: 'detail-heading' }, [el('h1', { text: issue.title }), severityChip(issue.severity)]),
    fix?.pr || issue.github || issue.publishSkipped
      ? el('div', { class: 'kv' }, [
          ...issueChips({ pr: fix?.pr, github: issue.github }),
          issue.publishSkipped
            ? el('span', { class: 'muted', text: `Not published: ${issue.publishSkipped.reason}` })
            : null,
        ])
      : null,
    issue.fixRejected
      ? el('p', {
          class: 'muted',
          text: `The team closed PR #${issue.fixRejected.pr} without a merge. Bugpatrol will not propose this change again.`,
        })
      : null,
    el('div', { class: 'kv' }, [
      el('span', { text: issueStatus(issue, fix) }),
      el('span', { text: issueWhere(issue) }),
      el('span', { text: `×${issue.occurrences}` }),
      el('span', { text: `First ${relativeTime(issue.firstSeenAt)}` }),
      el('span', { text: `Last ${relativeTime(issue.lastSeenAt)}` }),
    ]),
    markdown(issue.body),
    shots.length ? el('div', { class: 'evidence-grid' }, shots) : null,
    // The judge writes the clean steps in the body. The recorded path is the
    // exact replay, detours included, so it is one click away.
    el('details', { class: 'recorded-path' }, [
      el('summary', {
        text:
          `Recorded path: ${evidence.routineId ? `the routine ${evidence.routineId}, then ` : ''}` +
          `${steps.length} step(s)`,
      }),
      steps.length
        ? el(
            'ol',
            {},
            steps.map((step) => el('li', { text: stepWords(step) })),
          )
        : null,
    ]),
    title("Judge's reasoning"),
    el('p', { text: `${issue.judgement.by}: ${issue.judgement.reason}` }),
    issue.judgement.confidence !== undefined
      ? el('p', { class: 'muted', text: `Confidence ${Math.round(issue.judgement.confidence * 100)}%` })
      : null,
    candidates.length
      ? el('p', { class: 'muted', text: `From ${candidates.map((candidate) => candidate.id).join(', ')}` })
      : null,
    fix
      ? el('section', { class: 'fix' }, [
          el('div', { class: 'section-title' }, [el('h2', { text: 'Proposed fix' }), fixBadge(fix)]),
          gaveUpAfter
            ? el('p', { class: 'gave-up', text: `The fixer stopped after ${gaveUpAfter} fix attempts.` })
            : null,
          markdown(fix.summary || 'No summary yet.'),
          ...(fix.attempts?.length
            ? []
            : fix.retests?.length
              ? [
                  retestBlock(fix.retests.at(-1), issue),
                  fix.retests.length > 1
                    ? el('details', { class: 'earlier-retests' }, [
                        el('summary', { text: `Earlier retests (${fix.retests.length - 1})` }),
                        ...fix.retests
                          .slice(0, -1)
                          .reverse()
                          .map((retest) => retestBlock(retest, issue)),
                      ])
                    : null,
                ]
              : []),
          title('Code change'),
          fix.diffStat ? el('pre', { text: fix.diffStat }) : null,
          // Collapsed: the verdict and the screenshots come first; the diff is
          // one click away for the reader who reviews the code.
          fix.diff
            ? el('details', { class: 'diff-details' }, [
                el('summary', { text: `Show the diff (${fix.diff.split(/^diff --git /m).length - 1} file(s))` }),
                diffBlock(fix.diff),
              ])
            : null,
          el('div', { class: 'kv' }, [
            el('span', { text: fix.branch }),
            fix.worktreeRemovedAt
              ? el('span', { text: `Worktree removed ${new Date(fix.worktreeRemovedAt).toLocaleString()}` })
              : el('code', { text: fix.worktree }),
          ]),
          ...(fix.attempts?.length
            ? [title('Fix attempts', 'oldest first'), attemptTimeline(fix, issue, attemptDiffs)]
            : []),
        ])
      : null,
  ]);
}

/** The first sentence, for a list row. Long agent summaries belong in the detail. */
function firstSentence(text) {
  if (!text) return '';
  const plain = text
    .replace(/[*`#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const match = plain.match(/^(.{20,160}?[.!?])(\s|$)/);
  const sentence = match ? match[1] : plain;
  return sentence.length > 160 ? `${sentence.slice(0, 157)}...` : sentence;
}

function issueStatus(issue, fix) {
  if (issue.status === 'dismissed') return issue.closedBy ? `Dismissed by ${issue.closedBy.by}` : 'Dismissed';
  if (issue.status === 'fixed') return issue.closedBy ? `Fixed: ${issue.closedBy.reason}` : 'Fixed';
  if (issue.status === 'waits-for-deploy') return 'Merged, waits for a deploy';
  if (fix?.status === 'rejected' || issue.fixRejected) return 'Fix rejected by the team';
  if (issue.status === 'new' && issue.regression) return 'Regression';
  if (fix?.status === 'verified') return 'Fix verified in the app';
  if (fix?.status === 'retesting') return 'Retesting the fix';
  if (fix?.status === 'proposed' && ['not-fixed', 'unclear'].includes(fix.retests?.at(-1)?.outcome))
    return 'Fix not verified';
  if (fix && ['proposed', 'verified', 'opened'].includes(fix.status)) return 'Fix proposed';
  // The fixer read the code and found nothing to fix: a human should look.
  if (fix && fix.status === 'declined') return 'Fixer: not a bug?';
  return capital(issue.status.replace('-', ' '));
}

function stepWords(step) {
  const target = step.target?.name || step.target?.text || step.target?.testId || step.target?.selector || 'target';
  if (step.kind === 'tap') return `Tap "${target}"`;
  if (step.kind === 'type') return `Type "${step.value}"${step.submit ? ' and submit' : ''}`;
  if (step.kind === 'press') return `Press ${step.key}`;
  if (step.kind === 'scroll') return `Scroll ${step.direction}`;
  if (step.kind === 'open') return `Open ${step.url}`;
  if (step.kind === 'wait') return `Wait ${step.ms} ms`;
  if (step.kind === 'window') return `Switch to window "${step.match}"`;
  if (step.kind === 'upload') return `Upload a sample ${step.file} file to "${target}"`;
  return step.kind === 'back' ? 'Go back' : step.kind;
}

function diffBlock(diff) {
  return el(
    'div',
    { class: 'diff-files' },
    diff
      .split(/(?=^diff --git )/m)
      .filter(Boolean)
      .map((section) => {
        const lines = section.split('\n');
        const file = lines[0]?.match(/^diff --git a\/.* b\/(.*)$/)?.[1] ?? 'Patch';
        return el('section', { class: 'diff-file' }, [
          el('h3', { text: file }),
          el(
            'pre',
            { class: 'diff-block' },
            lines.map((line) =>
              el('span', {
                class:
                  line.startsWith('+') && !line.startsWith('+++')
                    ? 'added'
                    : line.startsWith('-') && !line.startsWith('---')
                      ? 'removed'
                      : line.startsWith('@@')
                        ? 'hunk'
                        : '',
                text: line || ' ',
              }),
            ),
          ),
        ]);
      }),
  );
}

function fixBadge(fix) {
  const last = fix.retests?.at(-1);
  const label =
    fix.status === 'verified'
      ? 'Verified in the app'
      : fix.status === 'retesting'
        ? 'Retesting…'
        : fix.status === 'declined'
          ? 'Declined'
          : fix.status === 'failed'
            ? 'Failed'
            : last && last.outcome !== 'fixed'
              ? 'Not verified'
              : 'Proposed';
  const kind = fix.status === 'verified' ? 'pass' : ['declined', 'failed'].includes(fix.status) ? 'fail' : 'warn';
  return el('span', { class: `badge ${kind}`, text: label });
}

const ATTEMPT_KINDS = { first: 'First fix', rerun: 'Rerun', refix: 'Refix', ci: 'CI fix' };
const ATTEMPT_OUTCOMES = {
  proposed: ['Proposed', 'pass'],
  'no-change': ['No change', 'warn'],
  declined: ['Declined', 'warn'],
  'verify-failed': ['Verify failed', 'fail'],
  error: ['Error', 'fail'],
  timeout: ['Timed out', 'fail'],
  abandoned: ['Abandoned', 'fail'],
};

/** Each fix attempt, oldest first, with the retests that judged it. */
function attemptTimeline(fix, issue, attemptDiffs) {
  const last = fix.attempts.at(-1).n;
  const judged = (n) =>
    (fix.retests ?? []).filter((retest) =>
      // A retest from before attempts were recorded, or one naming an unknown attempt, judged the last one.
      fix.attempts.some((attempt) => attempt.n === retest.fixAttempt) ? retest.fixAttempt === n : n === last,
    );
  return el(
    'ol',
    { class: 'attempt-timeline' },
    fix.attempts.map((attempt) => {
      const [outcome, kind] = attempt.outcome
        ? (ATTEMPT_OUTCOMES[attempt.outcome] ?? [attempt.outcome, 'info'])
        : ['Running…', 'info'];
      return el('li', { class: 'attempt' }, [
        el('div', { class: 'detail-heading' }, [
          el('h3', { text: `Attempt ${attempt.n}: ${ATTEMPT_KINDS[attempt.kind] ?? attempt.kind}` }),
          el('span', { class: `badge ${kind}`, text: outcome }),
        ]),
        el('div', { class: 'kv' }, [
          el('span', { text: relativeTime(attempt.startedAt) }),
          attempt.costUsd !== undefined ? el('span', { text: money(attempt.costUsd) }) : null,
        ]),
        attempt.reason ? markdown(attempt.reason) : null,
        attempt.diffStat ? el('pre', { text: attempt.diffStat }) : null,
        attemptDiffs[attempt.n] ? lazyDiff(attemptDiffs[attempt.n]) : null,
        attempt.verifyOutput
          ? el('details', { class: 'diff-details' }, [
              el('summary', { text: 'Show the verify output' }),
              el('pre', { text: attempt.verifyOutput }),
            ])
          : null,
        ...judged(attempt.n).map((retest) => retestBlock(retest, issue)),
      ]);
    }),
  );
}

/** A diff file that loads the first time the reader opens it. */
function lazyDiff(path) {
  const body = el('div', { class: 'muted', text: 'Loading…' });
  let loaded = false;
  return el(
    'details',
    {
      class: 'diff-details',
      ontoggle: (event) => {
        if (!event.target.open || loaded) return;
        loaded = true;
        fetchText(path)
          .then((diff) => body.replaceWith(diffBlock(diff)))
          .catch((error) => {
            body.textContent = `Could not read the diff: ${error.message}`;
          });
      },
    },
    [el('summary', { text: 'Show the diff' }), body],
  );
}

function retestBlock(retest, issue) {
  const capture = issue.evidence?.capture;
  const before = retest.before ?? capture?.screenshot;
  // An API issue has no before file: the reported exchange is the before.
  const beforeView = (path) =>
    !path && capture?.kind === 'http' ? captureView(capture, 'Before') : captureFile(path, 'Before');
  const pair = (shot) =>
    el('div', { class: 'retest-shot-pair' }, [
      retest.captures?.length ? el('h4', { text: screenName(shot.screenId) }) : null,
      shot.reached === false ? el('span', { class: 'muted', text: 'Not reached' }) : null,
      shot.note ? el('p', { class: 'muted', text: shot.note }) : null,
      el('div', { class: 'retest-shots' }, [
        el('figure', {}, [beforeView(shot.before), el('figcaption', { text: 'Before' })]),
        el('figure', {}, [
          captureFile(shot.after, 'After (with the fix)'),
          el('figcaption', { text: 'After (with the fix)' }),
        ]),
      ]),
    ]);
  return el('div', { class: 'retest-block' }, [
    el('h3', { text: `Retest ${retest.attempt}: ${retest.outcome}` }),
    el('p', { text: retest.reason }),
    retest.captures?.length
      ? retest.captures.map((shot) => pair(shot))
      : pair({ before, after: retest.after, note: retest.note }),
  ]);
}

function markdown(source = '') {
  const container = el('div', { class: 'markdown' });
  const lines = source.split('\n');
  let list = null;
  let code = null;
  for (const line of lines) {
    if (line.startsWith('```')) {
      if (code) {
        container.append(code);
        code = null;
      } else code = el('pre', {}, [el('code')]);
      list = null;
      continue;
    }
    if (code) {
      code.firstChild.textContent += `${line}\n`;
      continue;
    }
    const match = line.match(/^\s*(?:[-*]|\d+\.) (.*)$/);
    if (match) {
      const tag = /^\s*\d+\./.test(line) ? 'ol' : 'ul';
      if (!list || list.tagName.toLowerCase() !== tag) {
        list = el(tag);
        container.append(list);
      }
      list.append(el('li', {}, inlineMarkdown(match[1])));
      continue;
    }
    list = null;
    if (line.trim()) container.append(el('p', {}, inlineMarkdown(line)));
  }
  if (code) container.append(code);
  return container;
}

function inlineMarkdown(line) {
  const parts = [];
  const pattern = /(\*\*([^*]+)\*\*|`([^`]+)`)/g;
  let start = 0;
  for (const match of line.matchAll(pattern)) {
    if (match.index > start) parts.push(document.createTextNode(line.slice(start, match.index)));
    parts.push(el(match[2] ? 'strong' : 'code', { text: match[2] || match[3] }));
    start = match.index + match[0].length;
  }
  if (start < line.length) parts.push(document.createTextNode(line.slice(start)));
  return parts;
}

function sessionList(heading) {
  return el('section', { class: 'card panel' }, [
    title(heading, `${state.sessions.length}`),
    ...state.sessions.map((session) =>
      el(
        'button',
        {
          class: `list-row ${session.id === state.selectedSessionId ? 'active' : ''}`,
          onclick: async () => {
            state.selectedSessionId = session.id;
            await refresh();
          },
        },
        [
          roleIcon(session.role),
          el('span', { class: 'grow' }, [
            el('strong', { text: firstSentence(session.summary) || `${capital(session.role)} session` }),
            el('small', {
              class: 'muted',
              text: `${capital(session.role)} · ${relativeTime(session.startedAt)} · ${duration(session)}`,
            }),
          ]),
          session.status === 'finished'
            ? null
            : el('span', { class: `badge ${SESSION_BADGE[session.status]}`, text: session.status }),
        ],
      ),
    ),
  ]);
}

function noSessions(page) {
  return el('section', { class: 'card panel' }, [
    title(page),
    emptyState({
      heading: 'No sessions yet',
      why: [
        page === 'Flow'
          ? 'Flow puts the actions of a session, the requests that failed, and the backend logs in one timeline.'
          : 'Activity shows each agent session: what it tested, what it found, and what the judge decided.',
        'No agent ran in this project yet.',
      ],
      command: cli('patrol --once'),
    }),
  ]);
}

function renderActivity() {
  if (!state.sessions.length) return noSessions('Activity');
  const detail = state.sessionDetail;
  return el('div', { class: 'master-detail' }, [
    sessionList('Sessions'),
    detail ? renderSessionDetail(detail) : el('section', { class: 'card panel empty', text: 'Select a session.' }),
  ]);
}

// Most findings of a sweep wait for the judge, so that state is quiet text and the others are badges.
const CANDIDATE_STATES = {
  waiting: ['', 'Waits for the judge'],
  filed: ['fail', 'Filed as an issue'],
  dismissed: ['info', 'Dismissed'],
  ignored: ['info', 'Not sent to the judge'],
};

/** One session: its numbers first, then its findings by failure, then its events. */
function renderSessionDetail(detail) {
  const { session, report, candidates, events } = detail;
  const { findings, sweep } = report;
  const cases = sweep ? sweep.pass + sweep.fail + sweep.blocked : 0;
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const agentEvents = events.some((event) => event.kind !== 'candidate');
  const timeline = el(
    'div',
    { class: 'event-list' },
    events.filter((event) => state.showThoughts || isFeedEvent(event)).map(renderEventRow),
  );
  return el('section', { class: 'card panel session-detail' }, [
    title(
      firstSentence(session.summary) || `${capital(session.role)} session`,
      `${capital(session.role)} · ${formatTime(session.startedAt)}`,
    ),
    statBand([
      { label: 'Duration', value: session.status === 'running' ? 'Running' : formatDuration(report.durationMs) },
      sweep
        ? {
            label: 'Cases in this session',
            value: number(cases),
            note: `${number(sweep.endpoints)} endpoints tested · ${number(sweep.blocked)} blocked`,
          }
        : null,
      sweep
        ? {
            label: 'Pass · fail · blocked',
            value: `${number(sweep.pass)} · ${number(sweep.fail)} · ${number(sweep.blocked)}`,
            bar: caseBar(sweep),
          }
        : null,
      report.steps || !sweep
        ? { label: 'Steps', value: number(report.steps), note: `${report.screens.length} screens found` }
        : null,
      {
        label: 'Findings',
        value: number(findings.total),
        note: sweep
          ? `${number(findings.repeat)} failed two times`
          : `${number(findings.filed)} filed as ${findings.filed === 1 ? 'an issue' : 'issues'}`,
      },
      {
        label: 'Wait for the judge',
        value: number(findings.waiting),
        note: `${number(findings.filed)} filed · ${number(findings.dismissed)} dismissed`,
        tone: findings.waiting ? 'warn' : undefined,
      },
      session.tokens
        ? {
            label: 'Tokens',
            value: count(session.tokens.input + session.tokens.output),
            note: `API ${money(session.costUsd)}`,
          }
        : null,
    ]),
    findings.waiting
      ? callout(
          `The judge did not read ${number(findings.waiting)} findings of this session yet. Run the judge:`,
          cli('patrol --once'),
        )
      : null,
    report.groups.length
      ? el('section', { class: 'subsection' }, [
          title(
            'Findings',
            `${number(findings.total)} in ${report.groups.length} ${report.groups.length === 1 ? 'group' : 'groups'}`,
          ),
          ...report.groups.map((group) => findingGroup(group, byId)),
        ])
      : el('p', { class: 'muted', text: 'This session reported no finding.' }),
    countChips('Findings by case', report.byCase),
    countChips('Findings by check', report.byCheck),
    countChips(
      'Findings by screen',
      report.byScreen.map(({ label, count: n }) => ({ label: screenName(label), count: n })),
    ),
    // A sweep uses no model, so it has no usage to show.
    session.tokensByModel
      ? el('section', { class: 'subsection' }, [
          title('Usage'),
          el(
            'div',
            { class: 'muted session-usage' },
            Object.entries(session.tokensByModel).map(([model, usage]) =>
              el('div', { title: tokenDetail(usage), text: `${model}: ${tokens(usage)}` }),
            ),
          ),
        ])
      : null,
    // A sweep has no actions: its events repeat its findings, so they stay one click away.
    agentEvents
      ? el('section', { class: 'subsection' }, [
          title(
            'Timeline',
            state.showThoughts
              ? `${events.length} events`
              : `${events.filter(isFeedEvent).length} of ${events.length} events`,
          ),
          // The heading shows the first sentence. A longer summary shows here in full.
          session.summary && firstSentence(session.summary) !== session.summary.trim()
            ? el('div', { class: 'session-summary' }, [markdown(session.summary)])
            : null,
          el('label', { class: 'toggle' }, [
            el('input', {
              type: 'checkbox',
              ...(state.showThoughts ? { checked: '' } : {}),
              onchange: (event) => {
                state.showThoughts = event.target.checked;
                render();
              },
            }),
            el('span', { text: 'Show agent reasoning' }),
          ]),
          timeline,
        ])
      : el('details', { class: 'subsection raw-events' }, [
          el('summary', { text: `All events (${events.length})` }),
          timeline,
        ]),
  ]);
}

function countChips(heading, counts) {
  if (!counts.length) return null;
  return el('section', { class: 'subsection' }, [
    title(heading),
    el(
      'div',
      { class: 'chips' },
      counts.map(({ label, count: n }) =>
        el('span', { class: 'chip' }, [el('span', { text: label }), el('strong', { text: number(n) })]),
      ),
    ),
  ]);
}

/** A group of findings with the same failure. Each finding opens to its evidence. */
function findingGroup(group, byId) {
  const members = group.candidateIds.map((id) => byId.get(id)).filter(Boolean);
  return el('details', { class: 'finding-group' }, [
    el('summary', {}, [
      el('span', { class: 'group-label', text: capital(group.label) }),
      ...group.assertions.map((id) => el('code', { class: 'assertion', text: id })),
      el('span', {
        class: 'muted group-repeat',
        text: group.repeat && group.repeat < group.count ? `${group.repeat} of ${group.count} failed two times` : '',
      }),
      el('strong', { class: 'group-count', text: number(group.count) }),
    ]),
    ...members.map((candidate) => {
      const [badge, words] = CANDIDATE_STATES[candidate.state] ?? ['info', candidate.state];
      const at = candidate.source === 'sweep' ? candidate.summary.indexOf(': ') : -1;
      const capture = candidate.evidence?.capture;
      return el('details', { class: 'candidate-row' }, [
        el('summary', {}, [
          el('span', { class: 'grow truncate', text: at > 0 ? candidate.summary.slice(0, at) : candidate.summary }),
          candidate.state === 'filed' && candidate.issueId
            ? el('button', {
                type: 'button',
                class: `badge ${badge}`,
                text: words,
                onclick: (event) => {
                  event.preventDefault();
                  openIssue(candidate.issueId);
                },
              })
            : el('span', { class: badge ? `badge ${badge}` : 'muted state-words', text: words }),
        ]),
        candidate.route?.reason ? el('p', { class: 'muted', text: candidate.route.reason }) : null,
        capture?.kind === 'http'
          ? el('pre', { class: 'http', text: candidate.text })
          : captureFile(capture?.screenshot, candidate.summary, 'candidate-shot'),
      ]);
    }),
  ]);
}

function duration(session) {
  const end = session.endedAt ? new Date(session.endedAt).getTime() : Date.now();
  const seconds = Math.max(0, Math.round((end - new Date(session.startedAt).getTime()) / 1000));
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function renderEventRow(event) {
  return el('div', { class: 'event-row' }, [
    el('time', { text: new Date(event.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }),
    roleIcon(event.role),
    el('span', { class: 'grow truncate', text: event.summary }),
    event.tokens && event.kind !== 'usage'
      ? el('small', {
          class: 'muted token-chip',
          title: `${event.model ?? ''} ${tokenDetail(event.tokens)}`.trim(),
          text: tokens(event.tokens, ''),
        })
      : null,
    event.capture ? captureFile(event.capture, event.summary, 'event-thumb') : null,
    event.input !== undefined || event.output !== undefined
      ? el('details', {}, [
          el('summary', { text: 'Tool data' }),
          el('pre', { text: JSON.stringify({ input: event.input, output: event.output }, null, 2) }),
        ])
      : null,
  ]);
}

// The flow view is what a human reads when triaging: the agent's actions, the
// failed requests the app reported, and the backend logs that followed, merged
// in time order. A log close behind a failure is marked correlated.
function renderFlow() {
  if (!state.sessions.length) return noSessions('Flow');
  const flow = state.flow;
  const list = sessionList('Sessions');
  if (!flow) return el('div', { class: 'master-detail' }, [list, el('section', { class: 'card panel' }, [noFlow()])]);
  const sources = flow.sources.length
    ? flow.sources.map((source) =>
        el('div', {
          text: `${source.name} (${source.kind}): ${source.collected} line${source.collected === 1 ? '' : 's'}`,
        }),
      )
    : [el('div', { text: 'The config had no log source for this session, so the flow has no backend logs.' })];
  return el('div', { class: 'master-detail' }, [
    list,
    el('section', { class: 'card panel' }, [
      title('Flow', `${capital(flow.role)} · ${relativeTime(flow.startedAt)}`),
      el('div', { class: 'muted session-usage' }, sources),
      flow.entries.length
        ? el('div', { class: 'event-list' }, flow.entries.map(renderFlowRow))
        : el('div', { class: 'muted', text: 'This session recorded nothing.' }),
    ]),
  ]);
}

const LOGS_EXAMPLE = `logs:
  - name: api
    kind: file
    path: logs/api.log`;

/** Why the selected session has no flow, and the next step. */
function noFlow() {
  const summary = state.summary;
  const session = state.sessionDetail?.session;
  const report = state.sessionDetail?.report;
  const what =
    'Flow puts the actions of a session, the requests that failed, and the backend logs in one timeline, so you can see which log line follows which request.';
  if (session?.status === 'running')
    return emptyState({
      heading: 'The flow shows when the session ends',
      why: [what, 'This session runs now. Bugpatrol writes its flow at the end.'],
    });
  if (!summary.logs.length)
    return emptyState({
      heading: 'No backend logs',
      why: [
        what,
        `${summary.config ? fileName(summary.config) : 'The config'} has no logs: source, so Bugpatrol reads no backend logs. Add one, then run a patrol:`,
      ],
      command: LOGS_EXAMPLE,
      docs: `${DOCS}/dashboard.md#flow`,
    });
  if (report?.sweep && !report.steps)
    return emptyState({
      heading: 'A sweep has no flow',
      why: [
        what,
        'This session is a sweep from bugpatrol sweep, which reads no logs. A patrol runs the sweep and reads the logs: sources too.',
      ],
      command: cli('patrol --once'),
    });
  return emptyState({
    heading: 'No flow for this session',
    why: [what, 'This session ran before the config had a logs: source. The next patrol writes a flow.'],
    command: cli('patrol --once'),
  });
}

function renderFlowRow(entry) {
  return el('div', { class: `event-row flow-row flow-${entry.kind}${entry.correlated ? ' correlated' : ''}` }, [
    el('time', { text: new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }),
    el('span', { class: 'flow-kind', text: entry.kind }),
    el('span', { class: 'grow truncate', text: entry.summary }),
    entry.level ? el('small', { class: 'muted', text: entry.level }) : null,
    entry.capture ? captureFile(entry.capture, entry.summary, 'event-thumb') : null,
  ]);
}

async function openScreen(id) {
  state.view = 'screens';
  state.selectedScreenId = id;
  await refresh();
}

/** Screens belong to a client app. For an API, the page says so and points to Coverage. */
function noScreens() {
  const clients = surfacesOf('client');
  const apis = surfacesOf('api');
  const coverage = { label: 'Open Coverage', onclick: () => go('coverage') };
  if (!clients.length)
    return emptyState({
      heading: 'This project tests an API',
      why: [
        'Screens shows the screens that the explorer finds in a client app, and how they connect.',
        `${apis[0]?.configs[0] ? fileName(apis[0].configs[0]) : 'The config'} tests an API, which has no screens. Coverage shows its endpoints and cases.`,
        'A monorepo can test a client app too: add a config for it in .bugpatrol/.',
      ],
      action: coverage,
    });
  const client = clients[0];
  return emptyState({
    heading: 'No screens yet',
    why: [
      'Screens shows the screens that the explorer finds in a client app, and how they connect.',
      `${client.configs[0] ? fileName(client.configs[0]) : 'This project'} tests the ${surfaceName(client).toLowerCase()}. The explorer did not find a screen yet.`,
      apis.length ? 'This project also tests an API. Coverage shows its endpoints.' : '',
    ].filter(Boolean),
    command: cli('explore', client),
  });
}

function renderScreens() {
  const graphScreens = state.appmap?.screens ?? [];
  const screens = graphScreens.filter((screen) => !screen.virtual);
  if (!screens.length) return el('section', { class: 'card panel' }, [title('Screens'), noScreens()]);
  const edges = state.appmap?.edges ?? [];
  const selected = screens.find((screen) => screen.id === state.selectedScreenId);
  if (selected) {
    const routine = state.routines.find((entry) => entry.id === selected.routineId);
    const issues = state.issues.filter(
      (issue) => issue.screenId === selected.id && !['fixed', 'dismissed'].includes(issue.status),
    );
    return el('div', { class: 'card panel screen-detail' }, [
      el('button', {
        class: 'back',
        text: '← All screens',
        onclick: () => {
          state.selectedScreenId = null;
          render();
        },
      }),
      title(selected.name, `${selected.visits} visits · ${relativeTime(selected.lastSeenAt)}`),
      captureFile(selected.lastCapture, selected.name, 'screen-large'),
      el('p', { text: selected.description }),
      title('Routine'),
      el('p', {
        text: routine
          ? `${routine.id} · ${routine.description} · ${routine.steps} steps`
          : selected.routineId || 'No routine',
      }),
      ...[
        ['Comes from', edges.filter((edge) => edge.to === selected.id), 'from'],
        ['Goes to', edges.filter((edge) => edge.from === selected.id), 'to'],
      ].map(([heading, links, end]) =>
        el('section', { class: 'screen-links' }, [
          title(heading),
          ...links.map((edge) =>
            el('button', { class: 'list-row', onclick: () => openScreen(edge[end]) }, [
              el('strong', { text: screenName(edge[end]) }),
              edge.via ? el('small', { class: 'muted', text: edge.via }) : null,
            ]),
          ),
        ]),
      ),
      title('Open issues', `${selected.openIssues}`),
      ...issues.map((issue) =>
        el('button', { class: 'list-row', onclick: () => openIssue(issue.id) }, [
          el('strong', { text: issue.title }),
          severityChip(issue.severity),
        ]),
      ),
    ]);
  }
  const toggle = el(
    'div',
    { class: 'screen-mode', role: 'group', 'aria-label': 'Screen view' },
    ['graph', 'grid'].map((mode) =>
      el('button', {
        class: screenMode === mode ? 'active' : '',
        text: mode === 'graph' ? 'Graph' : 'Grid',
        'aria-pressed': screenMode === mode,
        onclick: () => {
          screenMode = mode;
          try {
            localStorage.setItem('bugpatrol-screen-mode', mode);
          } catch {
            /* disabled */
          }
          render();
        },
      }),
    ),
  );
  const apis = surfacesOf('api');
  return el('div', {}, [
    title('Screens', `${screens.length} found`),
    apis.length
      ? el('p', { class: 'muted surface-note' }, [
          `This project also tests an API${apis[0].configs[0] ? ` (${fileName(apis[0].configs[0])})` : ''}. `,
          el('button', {
            type: 'button',
            class: 'link',
            text: 'Coverage shows its endpoints.',
            onclick: () => go('coverage'),
          }),
        ])
      : null,
    toggle,
    screenMode === 'graph'
      ? renderScreenGraph(graphScreens, edges)
      : el(
          'div',
          { class: 'screen-grid' },
          screens.map((screen) =>
            el(
              'button',
              {
                class: 'card screen-card',
                onclick: () => openScreen(screen.id),
              },
              [
                captureFile(screen.lastCapture, screen.name),
                el('div', { class: 'screen-copy' }, [
                  el('strong', { text: screen.name }),
                  el('p', { class: 'truncate muted', text: screen.description }),
                  el('small', {
                    class: 'muted',
                    text: `${relativeTime(screen.lastSeenAt)} · ${screen.visits} visits`,
                  }),
                  screen.openIssues ? el('span', { class: 'issue-count', text: `${screen.openIssues} open` }) : null,
                ]),
              ],
            ),
          ),
        ),
  ]);
}

function renderScreenGraph(screens, allEdges) {
  const layout = layoutGraph(screens, allEdges, state.appmap?.entryId);
  const key = `${screens.map((screen) => screen.id).join('|')}|${allEdges.length}`;
  const canvas = svgEl('svg', { class: 'screen-graph', role: 'group', 'aria-label': 'Map of app screens' });
  const marker = svgEl(
    'marker',
    {
      id: 'graph-arrow',
      markerWidth: 9,
      markerHeight: 9,
      refX: 8,
      refY: 4.5,
      orient: 'auto',
      markerUnits: 'userSpaceOnUse',
    },
    [svgEl('path', { d: 'M 0 0 L 9 4.5 L 0 9 Z' })],
  );
  const mutedMarker = svgEl(
    'marker',
    {
      id: 'graph-arrow-muted',
      markerWidth: 9,
      markerHeight: 9,
      refX: 8,
      refY: 4.5,
      orient: 'auto',
      markerUnits: 'userSpaceOnUse',
    },
    [svgEl('path', { d: 'M 0 0 L 9 4.5 L 0 9 Z' })],
  );
  canvas.append(svgEl('defs', {}, [marker, mutedMarker]));
  const edgeNodes = layout.edges
    .filter((edge) => showBackLinks || edge.kind !== 'back')
    .map((edge) => {
      const path = svgEl('path', {
        d: edge.path,
        class: `graph-edge ${edge.kind}`,
        'data-from': edge.from,
        'data-to': edge.to,
        'marker-end': `url(#graph-arrow${['route', 'other', 'back'].includes(edge.kind) ? '-muted' : ''})`,
        'stroke-width': ['route', 'other'].includes(edge.kind) ? 1 : 1.5 + Math.min(4, Math.log2(edge.count || 1)),
      });
      path.append(svgEl('title', { text: edge.via || edge.kind }));
      return path;
    });
  canvas.append(svgEl('g', { class: 'graph-edges' }, edgeNodes));
  if (layout.unlinkedX !== null)
    canvas.append(
      svgEl('text', { x: layout.unlinkedX, y: layout.unlinkedY + 20, class: 'graph-unlinked', text: 'Not linked' }),
    );
  const screenById = new Map(screens.map((screen) => [screen.id, screen]));
  let dragMoved = false;
  for (const node of layout.nodes) {
    const screen = screenById.get(node.id);
    if (screen.virtual) {
      canvas.append(
        svgEl('g', { class: 'graph-start', 'aria-label': 'App start' }, [
          svgEl('rect', { x: node.x, y: node.y, width: node.w, height: node.h, rx: node.h / 2 }),
          svgEl('text', {
            x: node.x + node.w / 2,
            y: node.y + node.h / 2 + 5,
            'text-anchor': 'middle',
            text: 'App start',
          }),
        ]),
      );
      continue;
    }
    const card = svgEl('g', {
      class: 'graph-node',
      role: 'button',
      tabindex: 0,
      'aria-label': `${screen.name}${screen.openIssues ? `, ${screen.openIssues} open issues` : ''}`,
      onclick: () => {
        if (!dragMoved) openScreen(node.id);
      },
      onkeydown: (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openScreen(node.id);
        }
      },
      onpointerenter: () => {
        for (const path of edgeNodes)
          path.classList.toggle(
            'faded',
            path.getAttribute('data-from') !== node.id && path.getAttribute('data-to') !== node.id,
          );
      },
      onpointerleave: () => {
        for (const path of edgeNodes) path.classList.remove('faded');
      },
    });
    card.append(svgEl('rect', { x: node.x, y: node.y, width: node.w, height: node.h, rx: 9, class: 'graph-card' }));
    if (screen.lastCapture)
      card.append(
        svgEl('image', {
          x: node.x + 5,
          y: node.y + 5,
          width: node.w - 10,
          height: 104,
          href: artifact(screen.lastCapture),
          preserveAspectRatio: 'xMidYMin slice',
        }),
      );
    card.append(
      svgEl('text', {
        x: node.x + 10,
        y: node.y + 134,
        class: 'graph-name',
        text: screen.name.length > 24 ? `${screen.name.slice(0, 23)}…` : screen.name,
      }),
    );
    if (screen.openIssues) {
      card.append(svgEl('circle', { cx: node.x + node.w - 12, cy: node.y + 12, r: 12, class: 'graph-issue' }));
      card.append(
        svgEl('text', {
          x: node.x + node.w - 12,
          y: node.y + 16,
          'text-anchor': 'middle',
          class: 'graph-issue-text',
          text: screen.openIssues,
        }),
      );
    }
    card.append(svgEl('title', { text: screen.name }));
    canvas.append(card);
  }
  let box = graphCamera.key === key ? graphCamera.box : null;
  const setBox = (next) => {
    box = next;
    graphCamera.box = next;
    graphCamera.key = key;
    canvas.setAttribute('viewBox', `${next.x} ${next.y} ${next.w} ${next.h}`);
  };
  const fit = () => {
    const width = canvas.clientWidth,
      height = canvas.clientHeight;
    if (!width || !height) return;
    const scale = Math.max((layout.width + 80) / width, (layout.height + 100) / height);
    setBox({
      x: (layout.width - width * scale) / 2,
      y: (layout.height - height * scale) / 2,
      w: width * scale,
      h: height * scale,
    });
  };
  const zoom = (factor, clientX, clientY) => {
    if (!box) fit();
    const bounds = canvas.getBoundingClientRect();
    const fx = (clientX - bounds.left) / bounds.width,
      fy = (clientY - bounds.top) / bounds.height;
    const w = Math.max(200, Math.min(layout.width * 5, box.w * factor));
    const h = (w * bounds.height) / bounds.width;
    setBox({ x: box.x + (box.w - w) * fx, y: box.y + (box.h - h) * fy, w, h });
  };
  canvas.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      zoom(Math.exp(event.deltaY * 0.001), event.clientX, event.clientY);
    },
    { passive: false },
  );
  const pointers = new Map();
  let lastPinch = 0;
  canvas.addEventListener('pointerdown', (event) => {
    dragMoved = false;
    pointers.set(event.pointerId, [event.clientX, event.clientY]);
    event.target.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!pointers.has(event.pointerId)) return;
    const before = pointers.get(event.pointerId);
    if (Math.hypot(event.clientX - before[0], event.clientY - before[1]) > 3) dragMoved = true;
    pointers.set(event.pointerId, [event.clientX, event.clientY]);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const distance = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (lastPinch) zoom(lastPinch / distance, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      lastPinch = distance;
    } else if (box)
      setBox({
        ...box,
        x: box.x - ((event.clientX - before[0]) * box.w) / canvas.clientWidth,
        y: box.y - ((event.clientY - before[1]) * box.h) / canvas.clientHeight,
      });
  });
  const endPointer = (event) => {
    pointers.delete(event.pointerId);
    lastPinch = 0;
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  requestAnimationFrame(() => {
    if (!canvas.isConnected) return;
    if (box) {
      setBox(box);
      return;
    }
    if (canvas.clientWidth && canvas.clientHeight) {
      fit();
      return;
    }
    const observer = new ResizeObserver(() => {
      if (!canvas.isConnected) {
        observer.disconnect();
        return;
      }
      if (canvas.clientWidth && canvas.clientHeight) {
        observer.disconnect();
        fit();
      }
    });
    observer.observe(canvas);
  });
  return el('div', { class: 'graph-wrap' }, [
    el('div', { class: 'graph-toolbar' }, [
      el('button', { text: 'Fit', onclick: fit }),
      el('button', {
        text: '+',
        'aria-label': 'Zoom in',
        onclick: () =>
          zoom(
            0.8,
            canvas.getBoundingClientRect().x + canvas.clientWidth / 2,
            canvas.getBoundingClientRect().y + canvas.clientHeight / 2,
          ),
      }),
      el('button', {
        text: '−',
        'aria-label': 'Zoom out',
        onclick: () =>
          zoom(
            1.25,
            canvas.getBoundingClientRect().x + canvas.clientWidth / 2,
            canvas.getBoundingClientRect().y + canvas.clientHeight / 2,
          ),
      }),
      el('label', {}, [
        el('input', {
          type: 'checkbox',
          checked: showBackLinks ? '' : null,
          onchange: (event) => {
            showBackLinks = event.target.checked;
            render();
          },
        }),
        ' Show back links',
      ]),
    ]),
    el('p', { class: 'graph-legend', text: 'Solid = tap · dashed = deep link · grey = replay route' }),
    canvas,
  ]);
}

// ---------------------------------------------------------------- reviews

const VERDICT_BADGE = { proven: 'pass', 'partly-proven': 'warn', 'not-proven': 'fail', untested: 'info' };
const VERDICT_WORDS = {
  proven: 'Proven',
  'partly-proven': 'Partly proven',
  'not-proven': 'Not proven',
  untested: 'Untested',
};
const EVIDENCE_WORDS = { replay: 'replay', assertion: 'assertion', explored: 'explored', bench: 'benchmark' };

async function openReview(number) {
  state.selectedReview = number;
  await refresh();
}

function renderReviews() {
  if (!state.reviews.length)
    return el('section', { class: 'card panel' }, [
      title('Pull request reviews'),
      emptyState({
        heading: 'No pull request reviews yet',
        why: [
          'A review tests one pull request in the running app. It checks each claim of the pull request and lists the problems that the pull request adds.',
          'Bugpatrol did not review a pull request in this project yet. Give the number of a pull request:',
        ],
        command: cli('review <pr>'),
        docs: `${DOCS}/github.md`,
      }),
    ]);
  const list = el('div', { class: 'card panel' }, [
    title('Pull request reviews', `${state.reviews.length}`),
    ...state.reviews.map((review) =>
      el(
        'button',
        {
          class: `list-row ${review.pr.number === state.selectedReview ? 'active' : ''}`,
          onclick: () => openReview(review.pr.number),
        },
        [
          el('span', { class: 'grow' }, [
            el('strong', { text: `#${review.pr.number} ${review.pr.title ?? ''}` }),
            el('span', { class: 'row-meta' }, [
              el('small', {
                class: 'muted',
                text: `${reviewStatus(review)} · ${relativeTime(review.endedAt ?? review.startedAt)}`,
              }),
              ...Object.entries(review.verdicts ?? {})
                .filter(([, count]) => count)
                .map(([verdict, count]) =>
                  el('span', { class: `badge ${VERDICT_BADGE[verdict]}`, text: `${count} ${verdict}` }),
                ),
              review.introduced ? el('span', { class: 'badge fail', text: `${review.introduced} introduced` }) : null,
            ]),
          ]),
        ],
      ),
    ),
  ]);
  return el('div', { class: 'master-detail review-page' }, [list, renderReviewDetail()]);
}

function reviewStatus(review) {
  if (review.status === 'running') return 'Running';
  if (review.status === 'failed') return 'Failed';
  return review.posted ? 'Posted' : 'Finished';
}

function link(href, text) {
  return el('a', { href, target: '_blank', rel: 'noopener noreferrer', text });
}

function renderReviewDetail() {
  const detail = state.reviewDetail;
  if (!detail) return el('section', { class: 'card panel empty', text: 'Select a review.' });
  const { review, recordings } = detail;
  const ids = new Set((review.claims ?? []).map((finding) => finding.claim.id));
  const loose = recordings.filter((rec) => !rec.claimId || !ids.has(rec.claimId));
  const introduced = review.findings.filter((finding) => finding.verdict === 'introduced');
  const others = ['pre-existing', 'unclear', 'not-a-bug']
    .map((verdict) => [verdict, review.findings.filter((finding) => finding.verdict === verdict)])
    .filter(([, findings]) => findings.length);
  return el('article', { class: 'card panel review-detail' }, [
    el('div', { class: 'detail-heading' }, [
      el('h1', { text: `#${review.pr.number} ${review.pr.title ?? ''}` }),
      el('span', {
        class: `badge ${review.status === 'failed' ? 'fail' : review.status === 'running' ? 'warn' : 'info'}`,
        text: reviewStatus(review),
      }),
    ]),
    el('div', { class: 'kv' }, [
      review.pr.url ? link(review.pr.url, 'Pull request') : null,
      review.posted ? link(review.posted.url, 'Review on GitHub') : null,
      el('span', { class: 'mono', title: review.head, text: `head ${shortCommit(review.head)}` }),
      el('span', {
        class: 'mono',
        title: review.base,
        text: `base ${shortCommit(review.base)}${review.baseRef ? ` (${review.baseRef})` : ''}`,
      }),
      el('span', { text: `Started ${relativeTime(review.startedAt)}` }),
      review.costUsd ? el('span', { text: `$${review.costUsd.toFixed(3)}` }) : null,
    ]),
    review.error ? el('p', { class: 'review-error', text: review.error }) : null,
    review.claims
      ? el('section', {}, [
          title('Claims', `${review.claims.length}`),
          review.claims.length
            ? null
            : el('p', { class: 'muted', text: 'Bugpatrol found no claim in the pull request.' }),
          ...review.claims.map((finding) =>
            claimBlock(
              finding,
              recordings.filter((rec) => rec.claimId === finding.claim.id),
            ),
          ),
        ])
      : null,
    el('section', {}, [
      title('Introduced problems', `${introduced.length}`),
      introduced.length
        ? null
        : el('p', { class: 'muted', text: 'Bugpatrol found no problem that this pull request introduced.' }),
      ...introduced.map(findingBlock),
    ]),
    ...others.map(([verdict, findings]) =>
      el('details', { class: 'review-others' }, [
        el('summary', { text: `${capital(verdict.replace(/-/g, ' '))} (${findings.length})` }),
        ...findings.map(findingBlock),
      ]),
    ),
    loose.length
      ? el('section', {}, [
          title('Other recordings', `${loose.length}`),
          el(
            'div',
            { class: 'retest-shots' },
            loose.map((rec) => recordingView(rec)),
          ),
        ])
      : null,
    review.tested ? el('section', {}, [title('What Bugpatrol tested'), markdown(review.tested)]) : null,
  ]);
}

function claimSource(source) {
  if (source.kind === 'section') return 'the claims section';
  if (source.kind === 'commit') return `commit ${shortCommit(source.commit)}`;
  if (source.kind === 'issue') return `issue #${source.number}`;
  return `the ${source.kind}`;
}

function claimBlock(finding, recordings) {
  const { claim } = finding;
  const tested = finding.head || finding.base || recordings.length;
  return el('div', { class: 'claim-block' }, [
    el('div', { class: 'detail-heading' }, [
      el('h3', { text: claim.text }),
      el('span', {
        class: `badge ${VERDICT_BADGE[finding.verdict] ?? 'info'}`,
        text: VERDICT_WORDS[finding.verdict] ?? finding.verdict,
      }),
    ]),
    el('div', { class: 'kv' }, [
      el('span', {
        text: `Evidence: ${finding.evidence ? (EVIDENCE_WORDS[finding.evidence] ?? finding.evidence) : 'none'}`,
      }),
      el('span', { text: `From ${claimSource(claim.source)}` }),
      el('span', { text: claim.platform }),
    ]),
    el('p', { text: finding.reason }),
    finding.saw ? el('p', {}, [el('strong', { text: 'Saw: ' }), finding.saw]) : null,
    finding.did ? el('p', { class: 'muted', text: finding.did }) : null,
    claim.untestable ? el('p', { class: 'muted', text: `Not testable: ${claim.untestable}` }) : null,
    tested
      ? el('div', { class: 'retest-shots' }, [
          buildEvidence(
            'Base',
            finding.base,
            recordings.filter((rec) => rec.build === 'base'),
          ),
          buildEvidence(
            'This pull request',
            finding.head,
            recordings.filter((rec) => rec.build === 'head'),
          ),
        ])
      : null,
    finding.steps?.length
      ? el('details', { class: 'recorded-path' }, [
          el('summary', { text: `Claim routine: ${finding.steps.length} step(s)` }),
          el(
            'ol',
            {},
            finding.steps.map((step) => el('li', { text: step })),
          ),
          finding.routine ? el('code', { text: finding.routine }) : null,
        ])
      : null,
  ]);
}

/**
 * One build's evidence for a claim. A full video plays when there is one, then
 * an animated recording, then a terminal cast. Without a recording the step
 * screenshots show instead.
 */
function buildEvidence(label, replay, recordings) {
  const pick =
    recordings.find((rec) => rec.kind === 'video') ??
    recordings.find((rec) => rec.kind === 'image') ??
    recordings.find((rec) => rec.kind === 'cast');
  const stopped = replay?.failedStep !== undefined ? ` at step ${replay.failedStep + 1}` : '';
  const note = !replay
    ? 'Not replayed.'
    : replay.ok
      ? null
      : `Stopped${stopped}${replay.error ? `: ${replay.error}` : '.'}`;
  const shots = replay?.shots ?? [];
  const strip = () =>
    el(
      'div',
      { class: 'shot-strip' },
      shots.map((path, index) =>
        captureFile(path, `${label}: ${index ? `after step ${index}` : 'before the first step'}`),
      ),
    );
  return el('figure', { class: 'build-evidence' }, [
    pick ? recordingView(pick) : shots.length ? strip() : el('div', { class: 'image-empty', text: 'No capture' }),
    el('figcaption', {}, [label, note ? el('span', { class: 'build-note', text: ` · ${note}` }) : null]),
    pick && shots.length
      ? el('details', { class: 'build-shots' }, [el('summary', { text: `Screenshots (${shots.length})` }), strip()])
      : null,
  ]);
}

function recordingView(rec) {
  const name = rec.path.split('/').pop();
  if (rec.kind === 'video')
    return el('div', { class: 'recording' }, [
      el('video', { src: artifact(rec.path), controls: '', preload: 'metadata', playsinline: '' }),
      el('small', { class: 'muted', text: name }),
    ]);
  if (rec.kind === 'image')
    return el('div', { class: 'recording' }, [
      captureFile(rec.path, name),
      el('small', { class: 'muted', text: name }),
    ]);
  return castPlayer(rec.path);
}

/** A terminal cast as plain text. It shows the end state; Play replays the output in time. */
function castPlayer(path) {
  const screen = el('pre', { class: 'cast-screen', text: 'Loading the cast…' });
  const play = el('button', { type: 'button', class: 'filter', text: 'Play', disabled: '' });
  let cast;
  let timers = [];
  play.addEventListener('click', () => {
    for (const timer of timers) clearTimeout(timer);
    screen.textContent = '';
    // A pause longer than a second plays as one second, so a slow command does not stall the replay.
    let at = 0;
    let last = 0;
    timers = cast.events.map((event) => {
      at += Math.min(event.at - last, 1);
      last = event.at;
      return setTimeout(() => {
        screen.textContent += event.text;
      }, at * 1000);
    });
  });
  fetchText(path)
    .then((text) => {
      cast = parseCast(text);
      if (!cast) throw new Error('not an asciicast file');
      screen.textContent = cast.events.map((event) => event.text).join('');
      play.removeAttribute('disabled');
    })
    .catch((error) => {
      screen.textContent = `Could not read the cast: ${error.message}`;
    });
  return el('div', { class: 'recording' }, [
    screen,
    el('div', { class: 'kv' }, [play, el('small', { class: 'muted', text: path.split('/').pop() })]),
  ]);
}

function findingBlock(finding) {
  return el('div', { class: 'claim-block' }, [
    el('div', { class: 'detail-heading' }, [el('h3', { text: finding.title }), severityChip(finding.severity)]),
    finding.file ? el('code', { text: `${finding.file}${finding.line ? `:${finding.line}` : ''}` }) : null,
    el('p', { text: finding.reason }),
    finding.head || finding.base
      ? el('div', { class: 'retest-shots' }, [
          el('figure', {}, [captureFile(finding.base, 'Base'), el('figcaption', { text: 'Base' })]),
          el('figure', {}, [
            captureFile(finding.head, 'This pull request'),
            el('figcaption', { text: 'This pull request' }),
          ]),
        ])
      : null,
    finding.baseNote ? el('p', { class: 'muted', text: finding.baseNote }) : null,
    finding.steps?.length
      ? el('details', { class: 'recorded-path' }, [
          el('summary', { text: `Steps (${finding.steps.length})` }),
          el(
            'ol',
            {},
            finding.steps.map((step) => el('li', { text: step })),
          ),
        ])
      : null,
  ]);
}

function renderMemory() {
  const lessons = state.memory?.lessons ?? [];
  const row = (lesson) =>
    el('div', { class: 'memory-row' }, [
      el('span', { class: 'grow', text: lesson.text }),
      el('span', { class: 'badge info', text: lesson.scope ?? 'app' }),
      el('span', { class: 'muted', text: `${lesson.source} · ×${lesson.hits} · ${relativeTime(lesson.lastSeenAt)}` }),
    ]);
  if (!lessons.length)
    return el('section', { class: 'card panel' }, [
      title('Memory'),
      emptyState({
        heading: 'No lessons yet',
        why: [
          'A lesson is a fact about the app that an agent keeps for its next sessions, for example how to sign in.',
          'The agents save lessons when they learn something. You can also add one:',
        ],
        command: cli('memory add --role explorer "text"'),
      }),
    ]);
  return el('section', { class: 'card panel' }, [
    title('Memory'),
    el('p', { class: 'muted', text: 'Use bugpatrol memory to edit lessons.' }),
    ...['explorer', 'judge', 'fixer'].map((role) =>
      el('section', { class: 'memory-group' }, [
        el('h3', { text: capital(role) }),
        ...lessons.filter((lesson) => lesson.role === role && !lesson.retired).map(row),
      ]),
    ),
    el('details', {}, [
      el('summary', { text: `Retired lessons (${lessons.filter((lesson) => lesson.retired).length})` }),
      ...lessons.filter((lesson) => lesson.retired).map(row),
    ]),
  ]);
}

const CASE_WORDS = {
  ok: ['2xx', 'The request as the spec describes it'],
  'no-auth': ['no-auth', 'The request without credentials'],
  'invalid-input': ['invalid-input', 'A body or a parameter that the schema rejects'],
  'missing-id': ['missing-id', 'An id that does not exist'],
  'other-user': ['other-user', 'The data of one user, read by a second user'],
  'repeat-delete': ['repeat-delete', 'The same DELETE two times'],
};
const CELL_WORDS = {
  pass: 'Pass',
  fail: 'Fail',
  blocked: 'Blocked: the sweep could not run the case',
  skip: 'Skip: the request policy refuses the case',
  untested: 'Untested: the case waits in the sweep cursor',
};

function caseHeader(id) {
  if (id.startsWith('declared:')) {
    const code = id.slice('declared:'.length);
    return [code, `A declared error status. The cell shows the case that got ${code}.`];
  }
  return CASE_WORDS[id] ?? [id, id];
}

const LEGEND = { pass: '200', fail: '500', blocked: 'blocked', skip: 'skip', untested: 'untested' };
const CELL_BADGE = { pass: 'pass', fail: 'fail', blocked: 'warn' };

/** The exchange behind one cell, as the server formats it, in a panel at the side of the matrix. */
function renderCellExchange(key, cell) {
  const space = key.lastIndexOf(' ');
  const label = `${key.slice(0, space)} · ${caseHeader(key.slice(space + 1))[0]}`;
  const reason = cell.state === 'fail' ? `Failed checks: ${cell.reason}` : cell.reason;
  return el('aside', { class: 'drawer card', 'aria-label': 'The exchange of the cell' }, [
    el('div', { class: 'section-title' }, [
      el('h2', { class: 'mono', text: label }),
      el('span', { class: `badge ${CELL_BADGE[cell.state] ?? 'info'}`, text: cell.state }),
      el('button', {
        type: 'button',
        class: 'close',
        'aria-label': 'Close the exchange',
        text: '×',
        onclick: () => {
          state.selectedCell = null;
          render();
        },
      }),
    ]),
    reason ? el('p', { class: 'muted', text: reason }) : null,
    captureFile(cell.exchange, label),
  ]);
}

/** Coverage for each surface of the project: the endpoints of an API, the screens of a client app. */
function renderCoverage() {
  const summary = state.summary;
  if (!summary.surfaces.length)
    return el('section', { class: 'card panel' }, [
      title('Coverage'),
      emptyState({
        heading: 'No config yet',
        why: 'Coverage shows what Bugpatrol tested: the screens of a client app and the endpoints of an API.',
        command: 'bugpatrol init',
      }),
    ]);
  return el(
    'div',
    { class: 'stack-gap' },
    summary.surfaces.map((surface) =>
      surface.kind === 'api' ? renderApiCoverage(surface) : renderScreenCoverage(surface),
    ),
  );
}

function surfaceTitle(surface, aside) {
  return el('div', { class: 'section-title' }, [
    el('h2', {}, [
      surfaceName(surface),
      surface.configs[0]
        ? el('span', { class: 'muted mono config-name', text: ` ${fileName(surface.configs[0])}` })
        : null,
    ]),
    aside ? el('span', { class: 'muted', text: aside }) : null,
  ]);
}

function renderScreenCoverage(surface) {
  const totals = state.summary.coverage.screens;
  const screens = (state.appmap?.screens ?? []).filter((screen) => !screen.virtual);
  if (!totals?.found)
    return el('section', { class: 'card panel' }, [
      surfaceTitle(surface),
      screenCoverageBlock(null, state.summary, surface),
    ]);
  const open = state.issues.filter((issue) => !['fixed', 'dismissed'].includes(issue.status));
  const rows = screens
    .map((screen) => ({ screen, issues: open.filter((issue) => issue.screenId === screen.id).length }))
    .sort((a, b) => b.issues - a.issues || a.screen.name.localeCompare(b.screen.name));
  return el('section', { class: 'card panel' }, [
    surfaceTitle(surface, 'Screens that the explorer found'),
    statBand([
      { label: 'Screens found', value: number(totals.found) },
      { label: 'With a routine', value: number(totals.replayable), note: 'Bugpatrol can reach them again' },
      {
        label: 'With open issues',
        value: number(totals.withIssues),
        tone: totals.withIssues ? 'fail' : undefined,
        note: `${number(open.length)} open issues in all`,
      },
    ]),
    el('table', { class: 'usage-table screen-table' }, [
      el(
        'tr',
        {},
        ['Screen', 'Visits', 'Routine', 'Open issues', 'Last seen'].map((text) => el('th', { text })),
      ),
      ...rows.map(({ screen, issues }) =>
        el('tr', {}, [
          el('td', {}, [
            el('button', { type: 'button', class: 'link', text: screen.name, onclick: () => openScreen(screen.id) }),
          ]),
          el('td', { text: number(screen.visits) }),
          el('td', { text: screen.routineId ? 'Yes' : 'No' }),
          el('td', {}, [
            issues
              ? el('span', { class: 'issue-count', text: `${issues} open` })
              : el('span', { class: 'muted', text: '0' }),
          ]),
          el('td', { text: relativeTime(screen.lastSeenAt) }),
        ]),
      ),
    ]),
  ]);
}

/**
 * The rank of an endpoint: 0 with a failed case, 1 with a passed case, 2 with
 * a case that waits in the cursor, and 3 when the sweep skipped or blocked all of its cases.
 */
function endpointRank(endpoint, cases, cells) {
  let rank = 3;
  for (const id of cases) {
    const cell = cells[`${endpoint} ${id}`]?.state;
    if (cell === 'fail') return 0;
    if (cell === 'pass') rank = 1;
    if (cell === 'untested') rank = Math.min(rank, 2);
  }
  return rank;
}

function renderApiCoverage(surface) {
  const totals = state.summary.coverage.api;
  const data = state.coverage;
  if (!totals || !data)
    return el('section', { class: 'card panel' }, [surfaceTitle(surface), apiCoverageBlock(undefined, surface)]);
  const { cases, cells } = data;
  const own = CELL_STATES.reduce((sum, name) => sum + totals.cases[name], 0);
  const ranks = new Map(data.endpoints.map((endpoint) => [endpoint, endpointRank(endpoint, cases, cells)]));
  const endpoints = [...data.endpoints].sort((a, b) => ranks.get(a) - ranks.get(b));
  const filter = state.coverageFilter;
  const tbody = el('tbody', {
    onclick: (event) => {
      const button = event.target.closest('button[data-key]');
      if (!button) return;
      const key = button.dataset.key;
      state.selectedCell = state.selectedCell === key ? null : key;
      render();
    },
  });
  const shown = el('span', { class: 'muted' });
  const fill = () => {
    const query = filter.query.trim().toLowerCase();
    const rows = endpoints.filter(
      (endpoint) =>
        (!filter.failedOnly || ranks.get(endpoint) === 0) &&
        (!filter.hideSkipped || ranks.get(endpoint) < 3) &&
        (!query || endpoint.toLowerCase().includes(query)),
    );
    tbody.replaceChildren(...rows.map((endpoint) => matrixRow(endpoint, cases, cells)));
    shown.textContent = `${number(rows.length)} of ${number(endpoints.length)} endpoints`;
  };
  fill();
  const declared = cases.filter((id) => id.startsWith('declared:')).length;
  const table = el('table', { class: `matrix${filter.hideSkipped ? ' hide-skipped' : ''}` }, [
    el('thead', {}, [
      // The declared columns repeat a case that got that status, so they get their own group.
      declared
        ? el('tr', { class: 'matrix-groups' }, [
            el('th', {}),
            el('th', {}),
            el('th', { colspan: declared, class: 'declared', text: 'Declared error statuses' }),
            cases.length > declared + 1 ? el('th', { colspan: cases.length - declared - 1, text: 'Cases' }) : null,
          ])
        : null,
      el('tr', {}, [
        el('th', { text: 'Endpoint' }),
        ...cases.map((id) => {
          const [label, tip] = caseHeader(id);
          return el('th', { class: id.startsWith('declared:') ? 'declared' : '', title: tip, text: label });
        }),
      ]),
    ]),
    tbody,
  ]);
  const toggle = (key, label) =>
    el('label', { class: 'toggle' }, [
      el('input', {
        type: 'checkbox',
        ...(filter[key] ? { checked: '' } : {}),
        onchange: (event) => {
          filter[key] = event.target.checked;
          table.classList.toggle('hide-skipped', filter.hideSkipped);
          fill();
        },
      }),
      el('span', { text: label }),
    ]);
  const selected = state.selectedCell && cells[state.selectedCell];
  return el('section', { class: 'card panel' }, [
    surfaceTitle(surface, 'Endpoint × case, from the sweep'),
    statBand([
      {
        label: 'Endpoints tested',
        value: percent(totals.tested, totals.endpoints),
        note: `${number(totals.tested)} of ${number(totals.endpoints)}`,
      },
      {
        label: 'All cases',
        value: number(own),
        bar: caseBar(totals.cases),
        note: `${number(totals.cases.pass)} pass · ${number(totals.cases.fail)} fail`,
      },
      {
        label: 'Failed',
        value: number(totals.cases.fail),
        tone: totals.cases.fail ? 'fail' : undefined,
        note: `${percent(totals.cases.fail, totals.cases.pass + totals.cases.fail)} of the cases that ran`,
      },
      {
        label: 'Blocked · skipped',
        value: `${number(totals.cases.blocked)} · ${number(totals.cases.skip)}`,
        note: 'The sweep could not run them, or the policy refuses them',
      },
      {
        label: 'Wait in the cursor',
        value: number(totals.remaining),
        note: totals.remaining ? 'The next sweep runs them first' : 'This pass is complete',
      },
    ]),
    el('div', { class: 'matrix-tools' }, [
      el('input', {
        type: 'search',
        class: 'search',
        placeholder: 'Search the paths',
        'aria-label': 'Search the endpoint paths',
        value: filter.query,
        oninput: (event) => {
          filter.query = event.target.value;
          fill();
        },
      }),
      toggle('failedOnly', 'Failed only'),
      toggle('hideSkipped', 'Hide skipped and blocked'),
      shown,
      el('div', { class: 'matrix-legend' }, [
        ...Object.entries(LEGEND).map(([name, sample]) =>
          el('span', {}, [el('span', { class: `matrix-cell ${name}`, text: sample }), name]),
        ),
        el('span', { text: 'Blank: the sweep makes no such case.' }),
      ]),
    ]),
    el('div', { class: 'matrix-scroll', 'data-keep-scroll': '' }, [table]),
    selected ? renderCellExchange(state.selectedCell, selected) : null,
  ]);
}

function matrixRow(endpoint, cases, cells) {
  const space = endpoint.indexOf(' ');
  return el('tr', {}, [
    el('th', { scope: 'row' }, [
      el('span', { class: 'method', text: endpoint.slice(0, space) }),
      el('code', { text: endpoint.slice(space + 1) }),
    ]),
    ...cases.map((id) => {
      const key = `${endpoint} ${id}`;
      const cell = cells[key];
      if (!cell) return el('td', { class: 'matrix-none', title: 'The sweep makes no such case for this endpoint' });
      const tip = [CELL_WORDS[cell.state], cell.reason, cell.at ? relativeTime(cell.at) : ''].filter(Boolean);
      const props = {
        class: `matrix-cell ${cell.state}${state.selectedCell === key ? ' active' : ''}`,
        text: cell.status ?? cell.state,
      };
      return el('td', { class: `cell-${cell.state}` }, [
        cell.exchange
          ? el('button', {
              ...props,
              type: 'button',
              'data-key': key,
              title: [...tip, 'Click to open the exchange'].join('\n'),
            })
          : el('span', { ...props, title: tip.join('\n') }),
      ]);
    }),
  ]);
}

// ---------------------------------------------------------------- lightbox

const lightbox = document.getElementById('lightbox');
const lightboxImg = document.getElementById('lightbox-img');
const lightboxCaption = document.getElementById('lightbox-caption');

function openLightbox(path, caption) {
  lightboxImg.src = artifact(path);
  lightboxCaption.textContent = `${caption}: ${path}`;
  lightbox.hidden = false;
}
lightbox.addEventListener('click', () => {
  lightbox.hidden = true;
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') lightbox.hidden = true;
});

// ---------------------------------------------------------------- boot

tabs.addEventListener('click', async (event) => {
  const target = event.target.closest('button');
  if (!target) return;
  state.view = target.dataset.view;
  if (state.view === 'screens') state.selectedScreenId = null;
  if (state.view === 'coverage') state.selectedCell = null;
  await refresh();
});

function summaryOf(run, findings) {
  return {
    exitCode: run.exitCode,
    status: run.status,
    findings: { blocking: findings.filter((f) => f.route === 'check').length },
  };
}

function verdictClass(summary) {
  if (summary.exitCode === 4) return 'info';
  if (summary.findings.blocking > 0) return 'fail';
  if (summary.status === 'incomplete') return 'warn';
  return 'pass';
}

function verdictLabel(summary) {
  if (summary.exitCode === 4) return 'could not test';
  if (summary.findings.blocking > 0) return `${summary.findings.blocking} blocking`;
  if (summary.status === 'incomplete') return 'incomplete';
  return 'pass';
}

/** Abbreviate a real SHA; leave a human label like `working-tree` intact. */
function shortCommit(commit) {
  return /^[0-9a-f]{40}$/i.test(commit) ? commit.slice(0, 8) : commit;
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

connectLive();
setInterval(() => {
  if (state.overview?.agents.some((agent) => agent.state === 'working')) refresh();
}, 5000);
refresh({ keepSelection: false }).catch((error) => {
  view.append(el('div', { class: 'empty', text: String(error) }));
});
