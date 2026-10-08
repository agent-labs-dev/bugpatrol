import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace } from '@bugpatrol/agents';
import { describe, expect, it } from 'vitest';
import { runMemoryCommand } from './memory.js';

describe('bugpatrol memory', () => {
  it('adds, lists, and removes a lesson', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bugpatrol-memory-cli-'));
    try {
      const lines: string[] = [];
      const log = (line: string) => {
        lines.push(line);
      };
      await runMemoryCommand(['add', '--role', 'judge', 'Check the guide.', '--scope', 'welcome'], root, log);
      const id = (await new Workspace(root).readMemory()).lessons[0]!.id;
      await runMemoryCommand(['list', '--role', 'judge'], root, log);
      expect(lines.join('\n')).toContain(`${id}  judge  1  human  welcome  Check the guide.`);
      await runMemoryCommand(['remove', id], root, log);
      expect((await new Workspace(root).readMemory()).lessons).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a lesson over 200 characters and saves nothing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bugpatrol-memory-cli-'));
    try {
      const text = 'Check the guide before you report a layout bug. '.repeat(5);
      await expect(runMemoryCommand(['add', '--role', 'judge', text], root, () => {})).rejects.toThrow(
        'The lesson has 239 characters, and the limit is 200.',
      );
      expect((await new Workspace(root).readMemory()).lessons).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
