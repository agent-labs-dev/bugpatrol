import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { overlayBugpatrol } from './overlay.js';

describe('overlayBugpatrol', () => {
  it('gives the retest the checkout scripts, and restores the worktree after it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bugpatrol-overlay-'));
    const worktree = join(root, '.bugpatrol', 'runs', 'worktrees', 'iss_1');
    try {
      await mkdir(join(root, '.bugpatrol', 'runs'), { recursive: true });
      await writeFile(join(root, '.bugpatrol', 'mint.sh'), 'new script');
      await writeFile(join(root, '.bugpatrol', 'added.sh'), 'only in the checkout');
      await writeFile(join(root, '.bugpatrol', 'runs', 'agents.json'), '{}');
      await mkdir(join(worktree, '.bugpatrol'), { recursive: true });
      await writeFile(join(worktree, '.bugpatrol', 'mint.sh'), 'committed script');

      const restore = await overlayBugpatrol(root, root, worktree);
      expect(await readFile(join(worktree, '.bugpatrol', 'mint.sh'), 'utf8')).toBe('new script');
      expect(await readFile(join(worktree, '.bugpatrol', 'added.sh'), 'utf8')).toBe('only in the checkout');
      await expect(readFile(join(worktree, '.bugpatrol', 'runs', 'agents.json'))).rejects.toThrow();

      await restore();
      expect(await readFile(join(worktree, '.bugpatrol', 'mint.sh'), 'utf8')).toBe('committed script');
      await expect(readFile(join(worktree, '.bugpatrol', 'added.sh'))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("leaves the build's own committed routines and app map in the worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), 'bugpatrol-overlay-'));
    const worktree = join(root, '.bugpatrol', 'runs', 'worktrees', 'pr-7');
    try {
      await mkdir(join(root, '.bugpatrol', 'routines'), { recursive: true });
      await writeFile(join(root, '.bugpatrol', 'routines', 'enter-app.json'), 'checkout routine');
      await writeFile(join(root, '.bugpatrol', 'routines', 'only-here.json'), 'checkout routine');
      await writeFile(join(root, '.bugpatrol', 'appmap.json'), 'checkout map');
      await mkdir(join(worktree, '.bugpatrol', 'routines'), { recursive: true });
      await writeFile(join(worktree, '.bugpatrol', 'routines', 'enter-app.json'), 'committed routine');

      const restore = await overlayBugpatrol(root, root, worktree);
      expect(await readFile(join(worktree, '.bugpatrol', 'routines', 'enter-app.json'), 'utf8')).toBe(
        'committed routine',
      );
      await expect(readFile(join(worktree, '.bugpatrol', 'routines', 'only-here.json'))).rejects.toThrow();
      await expect(readFile(join(worktree, '.bugpatrol', 'appmap.json'))).rejects.toThrow();
      await restore();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does nothing when the config is outside the source repo', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bugpatrol-overlay-'));
    try {
      await mkdir(join(root, 'config', '.bugpatrol'), { recursive: true });
      await writeFile(join(root, 'config', '.bugpatrol', 'mint.sh'), 'script');
      await mkdir(join(root, 'wt'), { recursive: true });
      await (await overlayBugpatrol(join(root, 'config'), join(root, 'app'), join(root, 'wt')))();
      await expect(readFile(join(root, 'wt', '.bugpatrol', 'mint.sh'))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
