import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '@bugpatrol/core';
import { describe, expect, it } from 'vitest';
import type { Runtime } from '../types.js';
import { Vars } from '../vars.js';
import { Workspace } from '../workspace.js';
import { reflectOnSession } from './reflect.js';

const config = parseConfig({ version: 1, app: { connect: { url: 'fake://home' } } });

describe('reflection', () => {
  it('sends failed taps and repeated types to a fake runtime and saves redacted lessons', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bugpatrol-reflect-'));
    try {
      const workspace = new Workspace(root);
      const session = await workspace.startSession('explorer');
      const event = (kind: 'tool-call' | 'tool-result', tool: string, input?: unknown, output?: string) =>
        workspace.appendEvent(session.id, {
          sessionId: session.id,
          role: 'explorer',
          kind,
          tool,
          summary: output ? `${tool}: failed` : `Called ${tool}`,
          input,
          output,
        });
      await event('tool-call', 'tap', { ref: 'e1' });
      await event('tool-result', 'tap', undefined, 'Error: no target');
      await event('tool-call', 'type', { ref: 'e2', text: 'one' });
      await event('tool-result', 'type');
      await event('tool-call', 'type', { ref: 'e2', text: 'two' });
      await event('tool-result', 'type');
      await workspace.endSession(session.id, { summary: 'Finished.' });
      const vars = new Vars();
      vars.set('TOKEN', 'secret-value');
      const runtime: Runtime = {
        label: 'fake',
        async run(task) {
          expect(task.prompt).toContain('Failed tap');
          expect(task.prompt).toContain('Typed into e2 again: "two"');
          await task.tools
            .find((tool) => tool.name === 'add_lesson')!
            .run({
              text: 'On Login, use secret-value in the token field.',
              scope: 'login',
            });
          return { stop: 'done', steps: 1, costUsd: 0, summary: '' };
        },
      };
      await reflectOnSession(root, config, session.id, { vars, createRuntime: () => runtime });
      expect((await workspace.readMemory()).lessons[0]).toMatchObject({
        scope: 'login',
        text: 'On Login, use {{TOKEN}} in the token field.',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a lesson over 200 characters without counting it, and states the limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bugpatrol-reflect-'));
    try {
      const workspace = new Workspace(root);
      const session = await workspace.startSession('explorer');
      await workspace.appendEvent(session.id, {
        sessionId: session.id,
        role: 'explorer',
        kind: 'tool-result',
        tool: 'tap',
        summary: 'tap: failed',
        output: 'Error: no target',
      });
      await workspace.endSession(session.id, { summary: 'Finished.' });
      const long = `${'On Channels, open the member list first. '.repeat(5)}Then tap.`;
      const short = 'On Channels, open the member list first.'.padEnd(200, '!');
      let rejected: unknown;
      const runtime: Runtime = {
        label: 'fake',
        async run(task) {
          expect(task.system).toContain('200 characters');
          const add = task.tools.find((tool) => tool.name === 'add_lesson')!;
          expect(add.description).toContain('200 characters');
          rejected = await add.run({ text: long });
          await add.run({ text: short });
          return { stop: 'done', steps: 1, costUsd: 0, summary: '' };
        },
      };
      const reflectConfig = parseConfig({
        version: 1,
        app: { connect: { url: 'fake://home' } },
        agents: { memory: { maxPerSession: 1 } },
      });
      await reflectOnSession(root, reflectConfig, session.id, { createRuntime: () => runtime });
      expect(rejected).toMatchObject({ isError: true });
      expect(JSON.stringify(rejected)).toContain(`${long.length} characters`);
      expect((await workspace.readMemory()).lessons.map((lesson) => lesson.text)).toEqual([short]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not call a runtime for a clean session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bugpatrol-reflect-'));
    try {
      const workspace = new Workspace(root);
      const session = await workspace.startSession('explorer');
      await workspace.endSession(session.id, { summary: 'Finished.' });
      await reflectOnSession(root, config, session.id, {
        createRuntime: () => {
          throw new Error('called');
        },
      });
      expect((await workspace.readMemory()).lessons).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
