import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '@bugpatrol/core';
import { describe, expect, it } from 'vitest';
import { AgentSession } from '../session.js';
import { Vars } from '../vars.js';
import { Workspace } from '../workspace.js';
import { lessonTools, similarLesson } from './memory.js';

async function session(memory: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'bugpatrol-memory-'));
  const config = parseConfig({ version: 1, app: { connect: { url: 'http://x' } }, agents: { memory } });
  const workspace = new Workspace(root);
  const record = await workspace.startSession('judge');
  const vars = new Vars();
  vars.set('TOKEN', 'secret-value');
  return { root, workspace, session: new AgentSession(root, config, vars, record.id, 'judge') };
}

describe('save_lesson', () => {
  it('saves a lesson for its own role or for another role, with secrets hidden', async () => {
    const f = await session({ maxPerSession: 2 });
    try {
      const [tool] = lessonTools(f.session, 'judge');
      await tool!.run({ text: 'Mark all as read on Tasks is intended.' });
      await tool!.run({
        text: 'Change the .web.tsx file too, token secret-value.',
        for: 'fixer',
        scope: 'settings-usage',
      });
      const limited = await tool!.run({ text: 'One too many.' });
      const lessons = (await f.workspace.readMemory()).lessons;
      expect(lessons.map((lesson) => [lesson.role, lesson.source])).toEqual([
        ['judge', 'agent'],
        ['fixer', 'agent'],
      ]);
      expect(lessons[1]).toMatchObject({
        scope: 'settings-usage',
        text: 'Change the .web.tsx file too, token {{TOKEN}}.',
      });
      expect(JSON.stringify(limited)).toContain('limit');
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('rejects a lesson over 200 characters without counting it, and saves one at 200 unchanged', async () => {
    const f = await session({ maxPerSession: 1 });
    try {
      const [tool] = lessonTools(f.session, 'judge');
      expect(tool!.description).toContain('200 characters');
      const rejected = await tool!.run({ text: `${'Open Settings. '.repeat(12)}Wait a bit.`.padEnd(201, '!') });
      expect(rejected.isError).toBe(true);
      expect(JSON.stringify(rejected)).toContain('201 characters');
      expect(JSON.stringify(rejected)).toContain('200');
      expect((await f.workspace.readMemory()).lessons).toEqual([]);

      const text = `${'Open Settings. '.repeat(12)}Wait a bit.`.padEnd(200, '!');
      await tool!.run({ text });
      expect((await f.workspace.readMemory()).lessons.map((lesson) => lesson.text)).toEqual([text]);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('shows a similar lesson instead of a second copy, and confirms it with same', async () => {
    const f = await session();
    try {
      const [tool] = lessonTools(f.session, 'judge');
      await tool!.run({
        text:
          'Bugpatrol drives the Expo web target with mouse clicks, so a View with onTouchEnd ' +
          'never fires there; use Pressable onPress instead.',
        for: 'fixer',
      });
      const again =
        'On the web target, a View with onTouchEnd gets no mouse click, so use Pressable with onPress for tap targets.';
      const shown = JSON.stringify(await tool!.run({ text: again, for: 'fixer' }));
      const [first] = (await f.workspace.readMemory()).lessons;
      expect(shown).toContain(first!.id);
      expect((await f.workspace.readMemory()).lessons).toHaveLength(1);

      await tool!.run({ text: again, for: 'fixer', same: first!.id });
      expect((await f.workspace.readMemory()).lessons).toMatchObject([{ id: first!.id, hits: 2 }]);

      await tool!.run({ text: again, for: 'fixer', different: true });
      expect((await f.workspace.readMemory()).lessons).toHaveLength(2);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('does not match lessons about different things', () => {
    const lessons = [
      {
        id: 'les_1',
        role: 'fixer' as const,
        text: 'ModelPickerSheet stores the pick as "provider:id", ' + 'so each screen must accept a bare id.',
        source: 'agent' as const,
        hits: 1,
        createdAt: '',
        lastSeenAt: '',
      },
    ];
    expect(
      similarLesson(lessons, 'fixer', 'On the web target, a View with onTouchEnd gets no mouse click.'),
    ).toBeUndefined();
    expect(
      similarLesson(
        lessons,
        'judge',
        'ModelPickerSheet stores the pick as provider:id, so screens must accept a bare id.',
      ),
    ).toBeUndefined();
    expect(
      similarLesson(
        lessons,
        'fixer',
        'ModelPickerSheet stores the pick as provider:id, so screens must accept a bare id.',
      )?.id,
    ).toBe('les_1');
  });

  it('is not there when memory is off', async () => {
    const f = await session({ enabled: false });
    try {
      expect(lessonTools(f.session, 'fixer')).toEqual([]);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});
