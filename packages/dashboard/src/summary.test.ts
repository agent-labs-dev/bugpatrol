import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { paths } from '@bugpatrol/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentReader } from './agents.js';
import { writeProjectFixture } from './fixtures/project.js';
import { startDashboard } from './server.js';
import { projectSummary } from './summary.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bugpatrol-summary-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const summaryOf = (configFile?: string) => projectSummary(new AgentReader(root, configFile), root, configFile);

describe('projectSummary', () => {
  it('shows a client app as one client surface with its screens', () => {
    writeProjectFixture(root, 'client');
    const summary = summaryOf();
    expect(summary.surfaces).toEqual([
      { kind: 'client', platform: 'electron', configs: ['.bugpatrol/bugpatrol.yml'], active: true },
    ]);
    expect(summary.coverage).toEqual({ screens: { found: 5, replayable: 5, withIssues: 3 } });
    expect(summary.logs).toEqual(['api']);
    expect(summary.issues).toMatchObject({ open: 4, total: 5, bySeverity: { critical: 1, major: 2, minor: 1 } });
    // The judge filed the first billing candidate. The second session's billing candidate waits.
    expect(summary.waiting).toEqual({ total: 1, repeat: 0 });
    expect(summary.verdict).toEqual({ tone: 'fail', text: 'Problems found' });
  });

  it('counts the cases of an API without the declared columns, which copy a case', () => {
    writeProjectFixture(root, 'api');
    const summary = summaryOf();
    expect(summary.surfaces).toEqual([
      { kind: 'api', platform: 'api', configs: ['.bugpatrol/bugpatrol.yml'], active: true },
    ]);
    expect(summary.coverage.screens).toBeUndefined();
    expect(summary.coverage.api).toEqual({
      endpoints: 13,
      tested: 9,
      cases: { pass: 17, fail: 5, blocked: 2, skip: 3, untested: 2 },
      remaining: 2,
    });
    // Five failures: the judge filed one, and four wait. Three of them failed again on a second replay.
    expect(summary.waiting).toEqual({ total: 4, repeat: 3 });
    expect(summary.lastSession).toMatchObject({ id: 'ses_sweep', status: 'finished' });
  });

  it('shows each config of a monorepo as a surface, with the config of the dashboard first', () => {
    writeProjectFixture(root, 'monorepo');
    const client = summaryOf();
    expect(client.surfaces.map((surface) => [surface.platform, surface.configs, surface.active])).toEqual([
      ['electron', ['.bugpatrol/bugpatrol.yml'], true],
      ['api', ['.bugpatrol/api.yml'], false],
    ]);
    expect(client.configArg).toBe('');
    expect(Object.keys(client.coverage)).toEqual(['screens', 'api']);
    // Both surfaces write to one runs folder, so the findings of both wait for one judge.
    expect(client.waiting.total).toBe(5);

    const api = summaryOf('.bugpatrol/api.yml');
    expect(api.surfaces.map((surface) => [surface.platform, surface.active])).toEqual([
      ['api', true],
      ['electron', false],
    ]);
    expect(api.config).toBe('.bugpatrol/api.yml');
    expect(api.configArg).toBe(' --config .bugpatrol/api.yml');
    expect(api.logs).toEqual([]);
  });

  it('finds a surface in the data when no config tests it', () => {
    writeProjectFixture(root, 'api');
    rmSync(paths.config(root));
    const summary = summaryOf();
    expect(summary.config).toBeUndefined();
    expect(summary.surfaces).toEqual([{ kind: 'api', platform: 'api', configs: [], active: false }]);
  });

  it('says that a project with no data is not tested yet', () => {
    expect(summaryOf()).toMatchObject({
      surfaces: [],
      coverage: {},
      waiting: { total: 0, repeat: 0 },
      verdict: { tone: 'info', text: 'Not tested yet' },
    });
  });

  it('stops counting a candidate that the judge dismissed', () => {
    writeProjectFixture(root, 'api');
    appendFileSync(
      paths.sessionDecisions(root, 'ses_sweep'),
      `${JSON.stringify({ candidateId: 'can_sweep_3', decision: 'dismiss', reason: 'expected', at: '' })}\n`,
    );
    expect(summaryOf().waiting).toEqual({ total: 3, repeat: 3 });
  });
});

describe('session report', () => {
  it('groups the findings of a sweep by failure, case, and check', () => {
    writeProjectFixture(root, 'api');
    const detail = new AgentReader(root).session('ses_sweep')!;
    // The same endpoints as the coverage totals: the blocked cases test nothing.
    expect(detail.report.sweep).toEqual({ endpoints: 9, pass: 17, fail: 5, blocked: 2 });
    expect(detail.report.findings).toEqual({ total: 5, repeat: 4, waiting: 4, filed: 1, dismissed: 0, ignored: 0 });
    expect(detail.report.groups.map((group) => [group.label, group.count, group.assertions])).toEqual([
      ['the status is 500', 2, ['contract:status', 'contract:no-5xx', 'status']],
      ['the body does not match the schema', 1, ['contract:schema']],
      ['the status is 200', 1, ['contract:status', 'status']],
      ['the status is 404', 1, ['contract:status']],
    ]);
    expect(detail.report.byCase).toEqual([
      { label: 'invalid-input', count: 2 },
      { label: 'ok', count: 1 },
      { label: 'missing-id', count: 1 },
      { label: 'repeat-delete', count: 1 },
    ]);
    expect(detail.report.byCheck[0]).toEqual({ label: 'contract:status', count: 4 });
    const filed = detail.candidates.find((candidate) => candidate.state === 'filed');
    expect(filed).toMatchObject({
      issueId: 'iss-sweep-item',
      summary: 'DELETE /items/{id} repeat-delete: the status is 500',
    });
    // The page shows the exchange as the text that the models read.
    expect(filed?.text).toMatch(/^DELETE \/items\/1/);
  });

  it('groups the reports of an explorer by what became of them', () => {
    writeProjectFixture(root, 'client');
    const { report } = new AgentReader(root).session('ses_live')!;
    expect(report.sweep).toBeUndefined();
    expect(report.steps).toBe(25);
    expect(report.groups.map((group) => [group.label, group.count])).toEqual([
      ['Filed as issues', 1],
      ['Not sent to the judge', 1],
    ]);
    expect(report.byScreen.map((entry) => entry.label).sort()).toEqual(['billing', 'settings']);
  });
});

describe('GET /api/summary', () => {
  it('serves the summary of the config that the dashboard reads', async () => {
    writeProjectFixture(root, 'monorepo');
    const dashboard = await startDashboard({ root, port: 0, configFile: '.bugpatrol/api.yml' });
    try {
      const summary = await (await fetch(`${dashboard.url}/api/summary`)).json();
      expect(summary.config).toBe('.bugpatrol/api.yml');
      expect(summary.surfaces[0]).toMatchObject({ platform: 'api', active: true });
      const overview = await (await fetch(`${dashboard.url}/api/overview`)).json();
      // The overview lists the candidates that wait, with the status of an exchange and no body.
      expect(overview.waiting).toHaveLength(5);
      const http = overview.waiting.find((candidate: { source: string }) => candidate.source === 'sweep');
      expect(http.capture).toEqual({ kind: 'http', exchange: { response: { status: expect.any(Number) } } });
      writeFileSync(join(root, '.bugpatrol', 'api.yml'), 'not: a config');
      expect((await fetch(`${dashboard.url}/api/summary`)).status).toBe(500);
    } finally {
      await dashboard.close();
    }
  });
});
