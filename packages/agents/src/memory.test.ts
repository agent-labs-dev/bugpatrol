import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Lesson } from '@bugpatrol/core';
import { describe, expect, it } from 'vitest';
import { explorerSystem } from './prompts.js';
import { lessonsFor, Workspace } from './workspace.js';

describe('memory', () => {
  it('upserts, sorts human lessons first, and retires the oldest past 40', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bugpatrol-memory-'));
    try {
      const workspace = new Workspace(root);
      const input = { role: 'explorer' as const, source: 'reflection' as const, text: 'Open Settings first.' };
      await workspace.upsertLessons([input]);
      await workspace.upsertLessons([input]);
      expect((await workspace.readMemory()).lessons).toMatchObject([{ hits: 2 }]);
      await workspace.upsertLessons([{ ...input, source: 'human', text: 'Follow the guide.' }]);
      expect(lessonsFor(await workspace.readMemory(), 'explorer')[0]?.source).toBe('human');
      for (let i = 0; i < 40; i++) await workspace.upsertLessons([{ ...input, text: `Visit screen ${i}.` }]);
      const memory = await workspace.readMemory();
      expect(memory.lessons.filter((lesson) => !lesson.retired)).toHaveLength(40);
      expect(memory.lessons.find((lesson) => lesson.text === 'Open Settings first.')?.retired?.reason).toBe(
        'Pruned: not seen recently',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('stores a lesson text as given, without cutting it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bugpatrol-memory-'));
    try {
      const workspace = new Workspace(root);
      const text = 'Open the member list on Channels before you mention an agent. '.repeat(4).trim();
      await workspace.upsertLessons([{ role: 'explorer', source: 'reflection', text: ` ${text} ` }]);
      expect((await workspace.readMemory()).lessons.map((lesson) => lesson.text)).toEqual([text]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('places explorer lessons before the app guide only when present', () => {
    const lesson: Lesson = {
      id: 'les_1',
      role: 'explorer',
      text: 'Use the Settings tab.',
      source: 'human',
      hits: 1,
      createdAt: 'now',
      lastSeenAt: 'now',
    };
    const withLesson = explorerSystem('web', 'Stay safe.', [lesson]);
    expect(withLesson.indexOf('LESSONS FROM EARLIER RUNS')).toBeLessThan(withLesson.indexOf('APP GUIDE'));
    expect(withLesson).toContain('- [app] Use the Settings tab.');
    expect(explorerSystem('web', 'Stay safe.')).not.toContain('LESSONS FROM EARLIER RUNS');
  });
});
