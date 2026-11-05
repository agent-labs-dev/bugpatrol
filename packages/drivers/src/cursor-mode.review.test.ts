import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { CliDriver } from './cli.js';

it('sends an Up key that a curses TUI recognizes in application cursor mode', { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-mode-'));
  const driver = new CliDriver({ cwd: root, timeoutMs: 5000 });
  try {
    await writeFile(
      join(root, 'app.py'),
      [
        'import curses, time',
        'def app(screen):',
        '    screen.keypad(True)',
        '    screen.addstr(0, 0, "ready-for-key")',
        '    screen.refresh()',
        '    key = screen.getch()',
        '    screen.addstr(1, 0, "up-recognized" if key == curses.KEY_UP else "wrong-key-" + str(key))',
        '    screen.refresh()',
        '    time.sleep(3)',
        'curses.wrapper(app)',
      ].join('\n'),
    );
    await driver.connect();
    await driver.act({ kind: 'session', op: 'start', command: 'python3 -I app.py' });
    expect(await driver.act({ kind: 'session', op: 'wait', text: 'ready-for-key', timeoutMs: 4000 })).toMatchObject({
      ok: true,
    });
    await driver.act({ kind: 'session', op: 'keys', keys: ['up'] });
    await driver.act({ kind: 'session', op: 'wait', text: 'recognized', timeoutMs: 1500 });
    expect((await driver.observe()).terminal?.output).toContain('up-recognized');
  } finally {
    await driver.close();
    await rm(root, { recursive: true, force: true });
  }
});
