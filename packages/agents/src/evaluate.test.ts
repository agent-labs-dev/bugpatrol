import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_CHECKS, parseConfig } from '@bugpatrol/core';
import { RULES } from '@bugpatrol/invariants';
import { describe, expect, it } from 'vitest';
import { evaluateScreen, groupViolations } from './evaluate.js';
import { judgePrompt, judgeSystem } from './prompts.js';
import { AgentSession } from './session.js';
import { FakeDriver, type FakeScreen } from './testing/fake-driver.js';
import { judgeTools } from './tools/judge.js';
import { Vars } from './vars.js';
import { Workspace } from './workspace.js';

// These tests cover the automatic checks, so they turn all of them on.
const config = parseConfig({
  version: 1,
  app: { connect: { url: 'fake://home' } },
  agents: { checks: [...AGENT_CHECKS] },
});

// Three 12px buttons: each breaks the tap-target rule on its own.
const tiny = (ref: string, x: number) => ({
  ref,
  role: 'button',
  name: `Tiny ${ref}`,
  box: { x, y: 100, width: 12, height: 12 },
  interactive: true,
  enabled: true,
});
const screens: Record<string, FakeScreen> = {
  home: { elements: [tiny('e1', 10), tiny('e2', 60), tiny('e3', 110)], color: 30 },
};

async function capture(root: string, sessionConfig = config) {
  const workspace = new Workspace(root);
  const record = await workspace.startSession('explorer');
  const driver = new FakeDriver(screens);
  await driver.connect();
  const session = new AgentSession(root, sessionConfig, new Vars(), record.id, 'explorer', driver);
  const observation = await driver.observe();
  const snapshot = driver.snapshot(observation, 'home');
  const candidates = await evaluateScreen(session, { screenId: 'home', observation, snapshot });
  return { workspace, session, candidates };
}

describe('evaluateScreen', () => {
  it('runs the absolute checks on first sight and groups one rule into one candidate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bugpatrol-eval-'));
    try {
      const { candidates } = await capture(root);
      const taps = candidates.filter((item) => item.ruleId === 'usability/tap-target');
      expect(taps).toHaveLength(1);
      expect(taps[0]!.summary).toMatch(/^3 elements/);
      expect(taps[0]!.evidence.capture).toEqual({ kind: 'image', screenshot: expect.stringMatching(/\.png$/) });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not raise a fingerprint the judge dismissed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bugpatrol-eval-'));
    try {
      const first = await capture(root);
      const record = await first.workspace.startSession('judge');
      const judge = new AgentSession(root, config, new Vars(), record.id, 'judge');
      const dismiss = judgeTools(judge, [first.session.sessionId], 'test').find((tool) => tool.name === 'dismiss')!;
      await dismiss.run({ candidate_ids: first.candidates.map((item) => item.id), reason: 'Icon buttons by design' });

      const second = await capture(root);
      expect(second.candidates.filter((item) => item.ruleId === 'usability/tap-target')).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('adds an occurrence to a filed issue instead of a new candidate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bugpatrol-eval-'));
    try {
      const first = await capture(root);
      const record = await first.workspace.startSession('judge');
      const judge = new AgentSession(root, config, new Vars(), record.id, 'judge');
      const file = judgeTools(judge, [first.session.sessionId], 'test').find((tool) => tool.name === 'file_issue')!;
      await file.run({
        candidate_ids: first.candidates.map((item) => item.id),
        title: 'Buttons are too small to tap',
        body: '**What happened** ...',
        severity: 'minor',
        reason: 'Three controls are 12px.',
      });
      const [issue] = await first.workspace.listIssues();

      const second = await capture(root);
      expect(second.candidates.filter((item) => item.ruleId === 'usability/tap-target')).toHaveLength(0);
      expect((await first.workspace.readIssue(issue!.id))!.occurrences).toBe(issue!.occurrences + 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('closes an automatic-check issue after three clean visits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bugpatrol-eval-'));
    const original = screens.home!.elements;
    try {
      const first = await capture(root);
      const record = await first.workspace.startSession('judge');
      const judge = new AgentSession(root, config, new Vars(), record.id, 'judge');
      const file = judgeTools(judge, [first.session.sessionId], 'test').find((item) => item.name === 'file_issue')!;
      const candidate = first.candidates.find((item) => item.ruleId === 'usability/tap-target')!;
      await file.run({
        candidate_ids: [candidate.id],
        title: 'Small controls',
        body: 'Small',
        severity: 'minor',
        reason: 'Too small',
      });
      const [issue] = await first.workspace.listIssues();
      screens.home!.elements = [];
      for (let visit = 1; visit <= 3; visit++) {
        await capture(root);
        expect((await first.workspace.readIssue(issue!.id))?.notSeen).toBe(visit);
      }
      expect(await first.workspace.readIssue(issue!.id)).toMatchObject({
        status: 'fixed',
        closedBy: { by: 'Bugpatrol', reason: expect.stringContaining('in 3 visits') },
      });
    } finally {
      screens.home!.elements = original;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps an issue open when its check is off now, because the check cannot see it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bugpatrol-eval-'));
    try {
      const first = await capture(root);
      const record = await first.workspace.startSession('judge');
      const judge = new AgentSession(root, config, new Vars(), record.id, 'judge');
      const file = judgeTools(judge, [first.session.sessionId], 'test').find((item) => item.name === 'file_issue')!;
      const candidate = first.candidates.find((item) => item.ruleId === 'usability/tap-target')!;
      await file.run({
        candidate_ids: [candidate.id],
        title: 'Small controls',
        body: 'Small',
        severity: 'minor',
        reason: 'Too small',
      });
      const [issue] = await first.workspace.listIssues();
      const contrastOnly = parseConfig({
        version: 1,
        app: { connect: { url: 'fake://home' } },
        agents: { checks: ['usability/contrast'] },
      });
      for (let visit = 1; visit <= 3; visit++) {
        const later = await capture(root, contrastOnly);
        expect(later.candidates.filter((item) => item.ruleId === 'usability/tap-target')).toEqual([]);
      }
      const after = await first.workspace.readIssue(issue!.id);
      expect(after?.status).toBe(issue!.status);
      expect(after?.notSeen ?? 0).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('offers every invariant rule except console errors, which the explorer reads itself', () => {
    const ids = RULES.map((rule) => rule.id).filter((id) => id !== 'runtime/console-errors');
    expect([...AGENT_CHECKS].sort()).toEqual([...ids, 'pixel-diff'].sort());
  });
});

describe('file_issue with issue_id', () => {
  it("adds a new session's candidates to the named open issue", async () => {
    const root = await mkdtemp(join(tmpdir(), 'bugpatrol-eval-'));
    try {
      const first = await capture(root);
      const judgeOnce = async (sessionId: string, input: Record<string, unknown>) => {
        const record = await first.workspace.startSession('judge');
        const judge = new AgentSession(root, config, new Vars(), record.id, 'judge');
        const tool = judgeTools(judge, [sessionId], 'test').find((item) => item.name === 'file_issue')!;
        return tool.run(input);
      };
      await judgeOnce(first.session.sessionId, {
        candidate_ids: first.candidates.map((item) => item.id),
        title: 'Buttons are too small to tap',
        body: 'x',
        severity: 'minor',
        reason: 'Three 12px controls.',
      });
      const [issue] = await first.workspace.listIssues();

      // A later session raises the same problem under another fingerprint.
      const other = await first.workspace.startSession('explorer');
      const candidate = { ...first.candidates[0]!, id: 'can_other', sessionId: other.id, fingerprint: 'different' };
      await first.workspace.appendCandidate(other.id, candidate);
      const result = await judgeOnce(other.id, { candidate_ids: ['can_other'], issue_id: issue!.id, reason: 'Same.' });

      expect(result.isError).toBeFalsy();
      expect(await first.workspace.listIssues()).toHaveLength(1);
      const updated = await first.workspace.readIssue(issue!.id);
      expect(updated).toMatchObject({ occurrences: 2 });
      expect(updated!.candidateIds).toContain('can_other');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reopens a fixed issue as a regression and refuses a dismissed issue', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bugpatrol-eval-'));
    try {
      const first = await capture(root);
      const record = await first.workspace.startSession('judge');
      const judge = new AgentSession(root, config, new Vars(), record.id, 'judge');
      const tool = judgeTools(judge, [first.session.sessionId], 'test').find((item) => item.name === 'file_issue')!;
      const issue = {
        version: 1 as const,
        id: 'iss_fixed',
        fingerprint: 'old',
        title: 'Old problem',
        body: 'Old',
        severity: 'minor' as const,
        status: 'fixed' as const,
        screenId: 'home',
        candidateIds: [],
        evidence: { capture: { kind: 'image' as const, screenshot: 'old.png' } },
        judgement: { by: 'test', reason: 'Real', at: 'now' },
        occurrences: 1,
        firstSeenAt: 'now',
        lastSeenAt: 'now',
      };
      await first.workspace.saveIssue(issue);
      const input = { candidate_ids: [first.candidates[0]!.id], issue_id: issue.id, reason: 'Returned' };
      expect((await tool.run(input)).isError).toBeFalsy();
      expect(await first.workspace.readIssue(issue.id)).toMatchObject({
        status: 'new',
        occurrences: 2,
        regression: { fromStatus: 'fixed' },
      });
      const dismissed = { ...issue, id: 'iss_dismissed', status: 'dismissed' as const };
      await first.workspace.saveIssue(dismissed);
      expect((await tool.run({ ...input, issue_id: dismissed.id })).content[0]).toMatchObject({
        text: expect.stringContaining('dismiss this candidate instead'),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('judge prompts', () => {
  it('shows the newest closed issues and regression rules', () => {
    const old = {
      version: 1 as const,
      id: 'iss_1',
      fingerprint: 'one',
      title: 'Old',
      body: '',
      severity: 'minor' as const,
      status: 'dismissed' as const,
      candidateIds: [],
      evidence: { capture: { kind: 'image' as const, screenshot: 'old.png' } },
      judgement: { by: 'test', reason: 'Noise', at: 'now' },
      occurrences: 1,
      firstSeenAt: '2026-01-01',
      lastSeenAt: '2026-01-01',
      closedBy: { by: 'human', reason: 'By design', at: '2026-01-02' },
    };
    const prompt = judgePrompt(
      [],
      [],
      [old, { ...old, id: 'iss_2', status: 'fixed', title: 'Recent', closedBy: { ...old.closedBy, at: '2026-01-03' } }],
    );
    expect(prompt).toContain('RECENTLY CLOSED ISSUES\n- iss_2 [fixed]: Recent\n- iss_1 [dismissed: By design]: Old');
    expect(judgeSystem()).toContain('reopens it as a regression');
  });
});

describe('groupViolations', () => {
  it('keeps the worst severity of the group', () => {
    const entries = groupViolations([
      { ruleId: 'layout/overlap', message: 'a overlaps b', severity: 'minor', selector: '#a' },
      { ruleId: 'layout/overlap', message: 'c overlaps d', severity: 'major', selector: '#c' },
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ severity: 'major', signature: '#a|#c' });
  });
});
