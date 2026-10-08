import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Issue, paths } from '@bugpatrol/core';
import { describe, expect, it } from 'vitest';
import { Vars } from './vars.js';
import { Workspace } from './workspace.js';

describe('Workspace', () => {
  it('merges screens and persists sessions with relative screenshots and append-only events', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bugpatrol-work-'));
    const workspace = new Workspace(root);
    try {
      await workspace.upsertScreen({ id: 'home', links: ['settings'], lastScreenshot: 'first.png' });
      const screen = await workspace.upsertScreen({ id: 'home', links: ['profile'], visits: 2 });
      expect(screen.links).toEqual(['settings', 'profile']);
      expect(screen.visits).toBe(3);
      expect(screen.lastScreenshot).toBe('first.png');
      const transition = {
        to: 'settings',
        kind: 'tap' as const,
        via: 'Settings',
        steps: 3,
        count: 1,
        lastSeenAt: 'old',
      };
      await workspace.upsertScreen({ id: 'home', transitions: [transition], visits: 0 });
      const repeated = await workspace.upsertScreen({
        id: 'home',
        transitions: [{ ...transition, steps: 1 }],
        visits: 0,
      });
      expect(repeated.transitions).toMatchObject([{ to: 'settings', count: 2, steps: 1 }]);
      expect(repeated.transitions?.[0]?.lastSeenAt).not.toBe('old');
      expect((await readdir(paths.dir(root))).some((name) => name.includes('.tmp-'))).toBe(false);
      const session = await workspace.startSession('explorer');
      const vars = new Vars();
      vars.set('TOKEN', 'secret-value');
      const sink = workspace.recordEvent(session.id, 'explorer', vars);
      sink({ kind: 'thought', summary: 'secret-value' });
      await workspace.appendEvent(session.id, {
        sessionId: session.id,
        role: 'explorer',
        kind: 'thought',
        summary: 'next',
      });
      const screenshot = await workspace.saveScreenshot(session.id, Buffer.from('png'), 'home');
      expect(screenshot).toMatch(/^\.bugpatrol\/runs\/sessions\/.*\/001-home\.png$/);
      await new Promise((done) => setTimeout(done, 20));
      const events = await readFile(join(paths.session(root, session.id), 'events.jsonl'), 'utf8');
      expect(events).toContain('{{TOKEN}}');
      expect(events).toContain('"at"');
      await workspace.endSession(session.id, { steps: 2 });
      expect((await workspace.listSessions(1))[0]?.steps).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('finds an issue by fingerprint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bugpatrol-issue-'));
    try {
      const workspace = new Workspace(root);
      const issue: Issue = {
        version: 1,
        id: 'iss_1',
        fingerprint: 'abc',
        title: 'Bad',
        body: '',
        severity: 'minor',
        status: 'new',
        candidateIds: [],
        evidence: {},
        judgement: { by: 'judge', reason: 'visible', at: 'now' },
        occurrences: 1,
        firstSeenAt: 'now',
        lastSeenAt: 'now',
      };
      await workspace.saveIssue(issue);
      expect((await workspace.findIssueByFingerprint('abc'))?.id).toBe('iss_1');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('agent status under concurrency', () => {
  it('keeps agents.json valid when many status writes overlap', async () => {
    const { mkdtempSync, readFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = mkdtempSync(join(tmpdir(), 'bugpatrol-status-'));
    const one = new Workspace(root);
    const two = new Workspace(root);
    await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        (index % 2 ? one : two).setAgentStatus(index % 3 ? 'explorer' : 'judge', { activity: `step ${index}` }),
      ),
    );
    const file = JSON.parse(readFileSync(join(root, '.bugpatrol', 'runs', 'agents.json'), 'utf8'));
    expect(file.agents.map((agent: { role: string }) => agent.role).sort()).toEqual(['explorer', 'judge']);
  });
});
