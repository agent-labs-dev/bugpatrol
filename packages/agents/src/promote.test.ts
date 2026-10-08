import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ClaimFinding, ConfigError, type PrReview, parseConfig, paths, type Routine } from '@bugpatrol/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Gh } from './github.js';
import { replayRoutine } from './replay.js';
import { promoteClaims } from './roles/promote.js';
import { AgentSession } from './session.js';
import { FakeDriver } from './testing/fake-driver.js';
import { Vars } from './vars.js';
import { Workspace } from './workspace.js';

const config = parseConfig({
  version: 1,
  app: { connect: { url: 'fake://home' } },
  agents: { github: { enabled: true, repo: 'o/r' } },
});

/** A claim routine as the review saved it: every step from the start of the app. */
const flow = (claim: string): Routine => ({
  version: 1,
  id: claim,
  description: 'Open settings and save',
  platform: 'web',
  steps: [
    { kind: 'open', url: 'fake://home' },
    { kind: 'tap', target: { name: 'Open settings', role: 'button' } },
  ],
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
});

const finding = (id: string, verdict: ClaimFinding['verdict'], routine = true): ClaimFinding => ({
  claim: { id, text: `Settings save (${id})`, platform: 'web', source: { kind: 'section' }, testable: true },
  verdict,
  ...(verdict === 'untested' ? {} : { evidence: routine ? ('replay' as const) : ('explored' as const) }),
  reason: 'The saved value shows after a reload.',
  ...(routine ? { routine: `.bugpatrol/runs/reviews/pr-7/routines/${id}.json` } : {}),
});

const review = (claims: ClaimFinding[]): PrReview => ({
  version: 1,
  pr: { number: 7, url: 'https://github.com/o/r/pull/7', title: 'Fix settings' },
  head: 'a'.repeat(40),
  base: 'b'.repeat(40),
  baseRef: 'main',
  status: 'finished',
  startedAt: '2026-10-01T00:00:00.000Z',
  sessions: {},
  findings: [],
  claims,
  costUsd: 0,
});

/** gh that answers the state of pull request 7. */
const ghWith =
  (state: string): Gh =>
  async (args) => {
    if (args[0] === 'pr' && args[1] === 'view' && args[2] === '7') return state;
    throw new Error(`Unexpected gh ${args.join(' ')}`);
  };

let root: string;
let workspace: Workspace;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'bugpatrol-promote-'));
  workspace = new Workspace(root);
  await workspace.saveReview(
    review([finding('claim-1', 'proven'), finding('claim-2', 'not-proven'), finding('claim-3', 'proven', false)]),
  );
  const dir = join(paths.reviewDir(root, 7), 'routines');
  await mkdir(dir, { recursive: true });
  for (const id of ['claim-1', 'claim-2'])
    await writeFile(join(dir, `${id}.json`), `${JSON.stringify(flow(id), null, 2)}\n`);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('promoteClaims', () => {
  it('keeps a proven claim routine of a merged pull request in the committed routines', async () => {
    const kept = await promoteClaims(root, config, 7, ['claim-1'], { gh: ghWith('MERGED') });
    expect(kept.map((routine) => routine.id)).toEqual(['pr-7-claim-1']);
    const routines = await workspace.listRoutines();
    expect(routines).toHaveLength(1);
    expect(routines[0]).toMatchObject({
      id: 'pr-7-claim-1',
      description: 'Settings save (claim-1)',
      steps: flow('claim-1').steps,
    });
    expect(existsSync(paths.routine(root, 'pr-7-claim-1'))).toBe(true);

    // The patrol replays it from the committed routines, with no model.
    const record = await workspace.startSession('explorer');
    const driver = new FakeDriver({
      home: {
        elements: [
          {
            ref: 'e1',
            role: 'button',
            name: 'Open settings',
            box: { x: 10, y: 10, width: 40, height: 40 },
            interactive: true,
            enabled: true,
          },
        ],
        next: { e1: 'settings' },
      },
      settings: { elements: [] },
    });
    const session = new AgentSession(root, config, new Vars(), record.id, 'explorer', driver);
    expect((await replayRoutine(session, 'pr-7-claim-1', { windowMs: 200 })).ok).toBe(true);
    expect((await driver.observe()).location).toBe('fake://settings');
  });

  it('refuses a pull request that is not merged, and keeps nothing', async () => {
    await expect(promoteClaims(root, config, 7, ['claim-1'], { gh: ghWith('OPEN') })).rejects.toThrow(
      /PR #7 is not merged/,
    );
    expect(await workspace.listRoutines()).toEqual([]);
  });

  it('refuses a claim that is not proven, with no routine, or unknown, and keeps nothing', async () => {
    const gh = ghWith('MERGED');
    await expect(promoteClaims(root, config, 7, ['claim-1', 'claim-2'], { gh })).rejects.toThrow(
      /claim-2 is not-proven/,
    );
    await expect(promoteClaims(root, config, 7, ['claim-3'], { gh })).rejects.toThrow(/claim-3 has no claim routine/);
    await expect(promoteClaims(root, config, 7, ['claim-9'], { gh })).rejects.toThrow(ConfigError);
    expect(await workspace.listRoutines()).toEqual([]);
  });

  it('refuses a pull request with no review of its claims', async () => {
    await expect(promoteClaims(root, config, 8, ['claim-1'], { gh: ghWith('MERGED') })).rejects.toThrow(
      /No claim check of PR #8/,
    );
  });
});
