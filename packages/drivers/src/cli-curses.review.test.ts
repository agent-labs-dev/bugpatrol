import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { CliDriver } from './cli.js';

it('sends an arrow recognized by a curses app in application cursor mode', { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bugpatrol-curses-review-'));
  const driver = new CliDriver({ cwd: directory, timeoutMs: 5000 });
  try {
    await writeFile(
      join(directory, 'app.py'),
      `import curses

def main(screen):
    screen.keypad(True)
    screen.addstr(0, 0, 'READY')
    screen.refresh()
    key = screen.getch()
    screen.addstr(1, 0, 'DOWN_OK' if key == curses.KEY_DOWN else 'WRONG_KEY_' + str(key))
    screen.refresh()
    while screen.getch() != ord('q'):
        pass

curses.wrapper(main)
`,
    );
    await driver.connect();
    expect(await driver.act({ kind: 'session', op: 'start', command: 'python3 -I app.py' })).toMatchObject({
      ok: true,
    });
    expect(await driver.act({ kind: 'session', op: 'wait', text: 'READY', timeoutMs: 5000 })).toMatchObject({
      ok: true,
    });
    expect(await driver.act({ kind: 'session', op: 'keys', keys: ['down'] })).toMatchObject({ ok: true });
    await driver.settle();
    expect((await driver.observe()).terminal!.output).toContain('DOWN_OK');
  } finally {
    await driver.close();
    await rm(directory, { recursive: true, force: true });
  }
});
