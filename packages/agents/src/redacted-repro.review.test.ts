import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Claim, type PrReview, parseConfig, type Routine } from '@bugpatrol/core';
import { expect, it } from 'vitest';
import { ClaimBudget } from './roles/claim-judge.js';
import { type ClaimFlow, checkClaims } from './roles/claims.js';
import type { ReviewContext } from './roles/review.js';
import { AgentSession } from './session.js';
import { FakeDriver } from './testing/fake-driver.js';
import { explorerTools } from './tools/explorer.js';
import { Vars } from './vars.js';
import { Workspace } from './workspace.js';

it('reproduces an accepted redacted error check on an unchanged build', async () => {
  const root = await mkdtemp(join(tmpdir(), 'redacted-repro-'));
  try {
    const config = parseConfig({ version: 1, app: { connect: { url: 'fake://home' } } });
    const workspace = new Workspace(root);
    const vars = new Vars();
    vars.set('ORG', 'private-organization');
    const fresh = async () =>
      new FakeDriver({
        home: { elements: [], consoleErrors: ['POST /organizations/private-organization/runs → 429'] },
      });
    const record = await workspace.startSession('explorer');
    const session = new AgentSession(root, config, vars, record.id, 'explorer', await fresh());
    const report = explorerTools(session).find((tool) => tool.name === 'report_bug')!;
    expect(
      (
        await report.run({
          title: 'Runs fail',
          what_is_wrong: 'Run rejected',
          expected: 'Run succeeds',
          severity: 'major',
          error: 'POST /organizations/private-organization/runs → 429',
        })
      ).isError,
    ).toBeFalsy();
    const [candidate] = await workspace.readCandidates(record.id);
    expect(candidate!.evidence.bug).toEqual({ error: 'POST /organizations/{{ORG}}/runs → 429' });
    const routine: Routine = {
      version: 1,
      id: 'repro',
      description: 'Runs fail',
      platform: 'web',
      steps: [],
      bug: candidate!.evidence.bug,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const claim: Claim = {
      id: 'claim-1',
      text: 'Fixes runs',
      platform: 'web',
      source: { kind: 'issue', number: 1 },
      testable: true,
    };
    const flow: ClaimFlow = { kind: 'repro', issue: 1, did: 'Run', routine, check: routine.bug!, path: 'repro.json' };
    const ctx: ReviewContext = {
      root,
      source: root,
      repo: 'o/r',
      config,
      workspace,
      opts: {},
      log: () => {},
      pr: {
        number: 1,
        head: 'head',
        base: 'base',
        url: 'https://github.com/o/r/pull/1',
        title: 'Fixes runs',
        body: 'Closes #1',
        baseRef: 'main',
        files: [],
        diff: '',
        lines: new Map(),
        commits: [],
        issues: [],
      },
      budget: new ClaimBudget(config.agents.review),
    };
    const findings = await checkClaims(
      ctx,
      { sessions: {} } as PrReview,
      [claim],
      new Map([[claim.id, flow]]),
      new Map(),
      async (_name, _commit, run) => run(await fresh(), vars, fresh),
    );
    expect(findings[0]!.base).toMatchObject({ ok: true, bug: true });
    expect(findings[0]!.verdict).toBe('not-proven');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
