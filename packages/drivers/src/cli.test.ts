import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { castGif, readCast } from './cast.js';
import { CliDriver, type CliDriverOptions } from './cli.js';

const SECRET = 'hunter2-very-secret';
const redact = (value: string) => value.replaceAll(SECRET, '[redacted]');

async function withDriver(
  run: (driver: CliDriver, dir: string) => Promise<void>,
  timeoutMs = 10_000,
  options: Partial<CliDriverOptions> = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'bugpatrol-cli-'));
  const driver = new CliDriver({ cwd: dir, timeoutMs, redact, ...options });
  await driver.connect();
  try {
    await run(driver, dir);
  } finally {
    await driver.close();
    await rm(dir, { recursive: true, force: true });
  }
}

describe('CliDriver', () => {
  it('runs a real command in a terminal and records a cast with frames and no secret', { timeout: 30_000 }, () =>
    withDriver(async (driver, dir) => {
      await expect(driver.stopRecording(join(dir, 'none'))).rejects.toThrow('No recording is running');
      await driver.startRecording();
      await expect(driver.startRecording()).rejects.toThrow('A recording is already running');
      // The secret comes in two pieces, so redaction must see the whole line.
      const command = `[ -t 1 ] && echo "a terminal in $(basename "$PWD")"; printf 'hunter2-'; sleep 0.3; printf 'very-secret\\n'; printf '\\033[32mdone\\033[0m\\n'; exit 3`;
      const result = await driver.act({ kind: 'run', command });
      expect(result).toMatchObject({ ok: true, step: { kind: 'run' } });
      const observation = await driver.observe();
      expect(observation.platform).toBe('cli');
      expect(observation.terminal).toMatchObject({ exitCode: 3 });
      expect(observation.terminal!.output).toBe(`a terminal in ${dir.split('/').at(-1)}\n[redacted]\ndone`);
      expect(observation.capture.kind === 'image' && observation.capture.png.subarray(1, 4).toString()).toBe('PNG');

      const file = await driver.stopRecording(join(dir, 'head'));
      expect(file).toBe(join(dir, 'head.cast'));
      const text = await readFile(file, 'utf8');
      expect(text).not.toContain(SECRET);
      // The first piece alone is in the command line, but never in the output.
      expect(text.split('\n').slice(2).join('\n')).not.toContain('hunter2-');
      const cast = await readCast(file);
      expect(cast.events.length).toBeGreaterThan(1);
      expect(cast.events.map(([, output]) => output).join('')).toContain('$\u001b[0m [ -t 1 ]');
      expect(cast.events.at(-1)![0]).toBeGreaterThan(0.2);

      expect(await castGif(file, join(dir, 'head.gif'))).toBe(true);
      expect((await readFile(join(dir, 'head.gif'))).includes(SECRET)).toBe(false);
    }),
  );

  it('types the input of a command into it, and redacts the command line', { timeout: 30_000 }, () =>
    withDriver(async (driver) => {
      const result = await driver.act({ kind: 'run', command: `read name; echo "hi $name" # ${SECRET}`, input: 'ada' });
      expect(result.ok).toBe(true);
      const { terminal } = await driver.observe();
      expect(terminal).toMatchObject({ exitCode: 0 });
      expect(terminal!.output).toContain('hi ada');
      expect(terminal!.command).toBe('read name; echo "hi $name" # [redacted]');
    }),
  );

  it('keeps the colours of a command whole when a short secret matches their parameters', { timeout: 30_000 }, () =>
    withDriver(
      async (driver) => {
        await driver.act({ kind: 'run', command: `printf '\\033[2;18mdim\\033[0m 18 rows\\n'` });
        expect((await driver.observe()).terminal!.output).toBe('dim {{ROWS}} rows');
      },
      10_000,
      { redact: (value) => value.replaceAll('18', '{{ROWS}}') },
    ),
  );

  it('stops a command that runs past the time limit', { timeout: 30_000 }, () =>
    withDriver(async (driver) => {
      const started = Date.now();
      const result = await driver.act({ kind: 'run', command: 'echo waiting; sleep 30' });
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/still running after 1 s/) });
      expect((await driver.observe()).terminal).toMatchObject({ output: 'waiting' });
      expect((await driver.observe()).terminal!.exitCode).toBeUndefined();
    }, 1000),
  );

  it('refuses the actions of a screen', () =>
    withDriver(async (driver) => {
      expect(await driver.act({ kind: 'tap', ref: 'e1' })).toMatchObject({ ok: false });
    }));

  it('runs each command with the app environment, in a private folder that close removes', {
    timeout: 30_000,
  }, async () => {
    let home = '';
    await withDriver(
      async (driver) => {
        expect(
          await driver.act({ kind: 'run', command: 'echo "home=$APP_HOME"; echo "mode=$APP_MODE"' }),
        ).toMatchObject({
          ok: true,
        });
        const { terminal } = await driver.observe();
        home = /home=(.*)/.exec(terminal!.output)![1]!;
        expect(home).toMatch(/bugpatrol-app-.*\/home$/);
        expect(terminal!.output).toContain('mode=test');
        expect((await stat(dirname(home))).isDirectory()).toBe(true);
        expect(process.env.APP_HOME).toBeUndefined();
      },
      10_000,
      { env: { APP_HOME: '{{PRIVATE_DIR}}/home', APP_MODE: 'test' } },
    );
    await expect(stat(dirname(home))).rejects.toThrow();
  });
});

/**
 * A small full screen app: a list with a cursor on the alternate screen, j
 * and k or the arrows move it, enter opens a detail, escape closes it. It
 * starts a child of its own, and writes both pids, so a test can see that a
 * stop kills them.
 */
const TUI = `
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const items = ['alpha', 'bravo', 'charlie', 'delta'];
let cursor = 0;
let open = false;
const helper = spawn('sleep', ['300'], { stdio: 'ignore' });
writeFileSync('pids', process.pid + ' ' + helper.pid);
const out = (text) => process.stdout.write(text);
function draw() {
  out('\\x1b[H\\x1b[2J');
  if (open) return out('Detail: ' + items[cursor] + '\\r\\n\\r\\nesc back');
  out('Items ' + process.stdout.columns + 'x' + process.stdout.rows + '\\r\\n');
  items.forEach((item, index) => out((index === cursor ? '> ' : '  ') + item + '\\r\\n'));
  out('j/k move  enter open  q quit');
}
out('\\x1b[?1049h\\x1b[?25l');
process.stdin.setRawMode(true);
process.stdin.on('data', (data) => {
  const key = data.toString();
  if (key === 'q') {
    out('\\x1b[?1049l');
    process.exit(0);
  }
  if (open) open = key !== '\\x1b';
  else if (key === 'j' || key === '\\x1b[B') cursor = Math.min(items.length - 1, cursor + 1);
  else if (key === 'k' || key === '\\x1b[A') cursor = Math.max(0, cursor - 1);
  else if (key === '\\r') open = true;
  draw();
});
process.stdout.on('resize', draw);
draw();
`;

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function gone(pids: number[]): Promise<boolean> {
  for (let tries = 0; tries < 40 && pids.some(alive); tries++) await new Promise((resolve) => setTimeout(resolve, 50));
  return !pids.some(alive);
}

async function screen(driver: CliDriver): Promise<string> {
  const { terminal } = await driver.observe();
  expect(terminal?.screen).toBe(true);
  return terminal!.output;
}

async function press(driver: CliDriver, ...keys: string[]): Promise<string> {
  expect(await driver.act({ kind: 'session', op: 'keys', keys })).toMatchObject({ ok: true });
  await driver.settle();
  return screen(driver);
}

describe('CliDriver session', () => {
  it('drives a full screen app with keys, and a stop kills it and its children', { timeout: 30_000 }, () =>
    withDriver(async (driver, dir) => {
      await writeFile(join(dir, 'tui.cjs'), TUI);
      expect(await driver.act({ kind: 'session', op: 'start', command: 'node tui.cjs' })).toMatchObject({
        ok: true,
        step: { kind: 'session', op: 'start', command: 'node tui.cjs' },
      });
      expect(await driver.act({ kind: 'session', op: 'wait', text: 'Items', timeoutMs: 5000 })).toMatchObject({
        ok: true,
      });
      const first = await screen(driver);
      expect(first).toContain('Items 80x24');
      expect(first).toContain('> alpha');

      // The screen is what the app shows now, not a log: the old cursor is gone.
      const moved = await press(driver, 'j', 'down');
      expect(moved).toContain('> charlie');
      expect(moved).not.toContain('> alpha');
      expect(await press(driver, 'k')).toContain('> bravo');
      expect(await press(driver, 'enter')).toContain('Detail: bravo');
      expect(await press(driver, 'escape')).toContain('> bravo');

      expect(await driver.act({ kind: 'session', op: 'resize', cols: 60, rows: 20 })).toMatchObject({ ok: true });
      expect(await driver.act({ kind: 'session', op: 'wait', text: 'Items 60x20', timeoutMs: 5000 })).toMatchObject({
        ok: true,
      });
      const observation = await driver.observe();
      expect(observation.viewport).toMatchObject({ width: 480, height: 320 });

      const pids = (await readFile(join(dir, 'pids'), 'utf8')).split(' ').map(Number);
      expect(pids.every(alive)).toBe(true);
      expect(await driver.act({ kind: 'session', op: 'stop' })).toMatchObject({ ok: true });
      expect(await gone(pids)).toBe(true);
      expect((await driver.observe()).terminal).toMatchObject({ screen: true, exitCode: expect.any(Number) });
      expect(await driver.act({ kind: 'session', op: 'keys', keys: ['j'] })).toMatchObject({
        ok: false,
        error: expect.stringMatching(/exited/),
      });
    }),
  );

  it('fails a wait for text that never shows, and a key that a terminal cannot send', { timeout: 30_000 }, () =>
    withDriver(async (driver, dir) => {
      expect(await driver.act({ kind: 'session', op: 'keys', keys: ['j'] })).toMatchObject({
        ok: false,
        error: expect.stringMatching(/No session/),
      });
      await writeFile(join(dir, 'tui.cjs'), TUI);
      await driver.act({ kind: 'session', op: 'start', command: `node tui.cjs # ${SECRET}` });
      expect((await driver.observe()).terminal!.command).toBe('node tui.cjs # [redacted]');
      const started = Date.now();
      expect(await driver.act({ kind: 'session', op: 'wait', text: 'zulu', timeoutMs: 500 })).toMatchObject({
        ok: false,
        error: '"zulu" is not on the screen after 1 s',
      });
      expect(Date.now() - started).toBeLessThan(3000);
      expect(await driver.act({ kind: 'session', op: 'keys', keys: ['ctrl+1'] })).toMatchObject({
        ok: false,
        error: expect.stringMatching(/no key ctrl\+1/),
      });
      expect(await driver.act({ kind: 'session', op: 'wait', timeoutMs: 5000 })).toMatchObject({ ok: true });
    }),
  );

  it('starts the configured program on connect, so the first look is at it', { timeout: 30_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bugpatrol-cli-'));
    await writeFile(join(dir, 'tui.cjs'), TUI);
    const driver = new CliDriver({ cwd: dir, timeoutMs: 10_000, command: 'node tui.cjs' });
    try {
      await driver.connect();
      expect(await driver.act({ kind: 'session', op: 'wait', text: 'Items', timeoutMs: 5000 })).toMatchObject({
        ok: true,
      });
      expect(await screen(driver)).toContain('> alpha');
    } finally {
      await driver.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('kills a running session on close', { timeout: 30_000 }, async () => {
    let pids: number[] = [];
    await withDriver(async (driver, dir) => {
      await writeFile(join(dir, 'tui.cjs'), TUI);
      await driver.act({ kind: 'session', op: 'start', command: 'node tui.cjs' });
      await driver.act({ kind: 'session', op: 'wait', text: 'Items', timeoutMs: 5000 });
      pids = (await readFile(join(dir, 'pids'), 'utf8')).split(' ').map(Number);
    });
    expect(pids).toHaveLength(2);
    expect(await gone(pids)).toBe(true);
  });

  it('blanks a secret that the program shows, on its screenshot and in its recording', { timeout: 30_000 }, () =>
    withDriver(
      async (driver, dir) => {
        await driver.startRecording();
        // The secret comes in two pieces of output, and draws as one on the screen.
        await driver.act({
          kind: 'session',
          op: 'start',
          command: `printf 'key: hunter2-'; sleep 0.3; printf 'very-secret\\n'; sleep 30`,
        });
        await driver.act({ kind: 'session', op: 'wait', text: 'very-secret', timeoutMs: 5000 });
        const observation = await driver.observe();
        expect(observation.terminal!.output).toBe('key: {{TOKEN}}');
        const png = PNG.sync.read((observation.capture as { png: Buffer }).png);
        // Column 5 of row 0 holds the first character of the secret: a grey block.
        const index = (8 * png.width + 5 * 8 + 4) * 4;
        expect([...png.data.subarray(index, index + 3)]).toEqual([0x80, 0x80, 0x80]);
        await driver.act({ kind: 'session', op: 'stop' });
        // The first event is the command line, which holds the two pieces apart.
        const output = (await readCast(await driver.stopRecording(join(dir, 'tui')))).events
          .slice(1)
          .map(([, text]) => text)
          .join('');
        expect(output).not.toContain('very-secret');
        expect(output).toContain('key: {{TOKEN}}');
      },
      10_000,
      // The real redaction puts {{NAME}} in place of a secret, and the recording relies on that.
      { redact: (value) => value.replaceAll(SECRET, '{{TOKEN}}') },
    ),
  );

  it('waits for a slow program to answer a key before it shows the screen', { timeout: 30_000 }, () =>
    withDriver(async (driver, dir) => {
      await writeFile(
        join(dir, 'slow.cjs'),
        `process.stdin.setRawMode(true);
process.stdout.write('ready');
process.stdin.on('data', () => setTimeout(() => process.stdout.write('\\x1b[H\\x1b[2Jdone'), 400));`,
      );
      await driver.act({ kind: 'session', op: 'start', command: 'node slow.cjs' });
      await driver.act({ kind: 'session', op: 'wait', text: 'ready', timeoutMs: 5000 });
      expect(await press(driver, 'x')).toBe('done');
    }),
  );

  it('waits out the escape delay after a lone escape, so the next key is not read as alt', { timeout: 30_000 }, () =>
    withDriver(async (driver) => {
      // Raw mode, then each read and the time since the read before it.
      const program = `python3 -I -c "
import os, sys, time, tty
tty.setraw(0)
print('ready', end='\\r\\n', flush=True)
last = None
for _ in range(3):
    data = os.read(0, 16)
    now = time.monotonic()
    gap = 0 if last is None else int((now - last) * 1000)
    last = now
    print(repr(data), gap, end='\\r\\n', flush=True)
"`;
      await driver.act({ kind: 'session', op: 'start', command: program });
      await driver.act({ kind: 'session', op: 'wait', text: 'ready', timeoutMs: 5000 });
      await driver.act({ kind: 'session', op: 'keys', keys: ['escape', 'j', 'alt+x'] });
      await driver.act({ kind: 'session', op: 'wait', text: "'\\x1bx'", timeoutMs: 5000 });
      const lines = (await driver.observe()).terminal!.output.split('\n');
      const gap = (bytes: string) =>
        Number(
          lines
            .find((line) => line.startsWith(bytes))!
            .split(' ')
            .at(-1),
        );
      expect(gap("b'j'")).toBeGreaterThanOrEqual(900);
      expect(gap("b'\\x1bx'")).toBeLessThan(900);
    }),
  );

  it('says that a screen which never stops changing is not stable', { timeout: 30_000 }, () =>
    withDriver(async (driver) => {
      await driver.act({ kind: 'session', op: 'start', command: 'while true; do date +%N; sleep 0.02; done' });
      expect(await driver.settle({ timeoutMs: 800 })).toMatchObject({ stable: false });
    }),
  );
});

describe('CliDriver isolation', () => {
  it("gives the app only the allowed host variables and its own env, never Bugpatrol's", {
    timeout: 30_000,
  }, async () => {
    process.env.BUGPATROL_TEST_TOKEN = 'leaked-token';
    try {
      await withDriver(
        async (driver) => {
          await driver.act({
            kind: 'run',
            command: 'echo "token=$BUGPATROL_TEST_TOKEN"; echo "home=$HOME"; echo "term=$TERM"; echo "own=$OWN"',
          });
          const { output } = (await driver.observe()).terminal!;
          expect(output).toContain('token=\n');
          expect(output).toMatch(/home=\S*bugpatrol-app-\S+\n/);
          expect(output).not.toContain(`home=${process.env.HOME}\n`);
          expect(output).toContain('term=xterm-256color');
          expect(output).toContain('own=mine');
        },
        10_000,
        { env: { OWN: 'mine' } },
      );
    } finally {
      delete process.env.BUGPATROL_TEST_TOKEN;
    }
  });

  it('refuses a command that would start a program outside its terminal', { timeout: 30_000 }, () =>
    withDriver(async (driver) => {
      for (const command of [
        "tmux new-session -d -s bp 'bun app.ts'",
        'FOO=1 /usr/bin/tmux new -d',
        "sh -c 'screen -dmS bp app'",
        'bash -lc "tmux new -d"',
        "eval 'setsid app'",
        'setsid app; echo done',
      ]) {
        expect(await driver.act({ kind: 'run', command }), command).toMatchObject({ ok: false });
        expect(await driver.act({ kind: 'session', op: 'start', command }), command).toMatchObject({ ok: false });
      }
      for (const command of [
        'echo a && echo b',
        'sleep 0 & wait',
        'echo screen | grep screen',
        `echo screen | grep "screen"`,
        "echo 'tmux' | grep -c 'tmux'",
      ]) {
        expect(await driver.act({ kind: 'run', command }), command).toMatchObject({ ok: true });
      }
    }),
  );

  it('keeps the app env away from the terminal helper', { timeout: 30_000 }, () =>
    withDriver(
      async (driver) => {
        // With this PATH or PYTHONHOME, python3 itself would not start.
        expect(await driver.act({ kind: 'run', command: '/bin/echo "path=$PATH"' })).toMatchObject({ ok: true });
        expect((await driver.observe()).terminal).toMatchObject({ exitCode: 0, output: 'path=/nonexistent' });
      },
      10_000,
      { env: { PATH: '/nonexistent', PYTHONHOME: '/nonexistent', PYTHONPATH: '/nonexistent' } },
    ),
  );

  it('waits for the app to exit before it removes the private folder', { timeout: 30_000 }, async () => {
    let home = '';
    await withDriver(
      async (driver) => {
        await driver.act({
          kind: 'session',
          op: 'start',
          command: 'mkdir -p "$HOME"; echo "$HOME"; while true; do echo x >> "$HOME/log"; sleep 0.01; done',
        });
        await driver.act({ kind: 'session', op: 'wait', text: 'bugpatrol-app-', timeoutMs: 5000 });
        home = (await driver.observe()).terminal!.output.trim();
      },
      10_000,
      { env: { HOME: '{{PRIVATE_DIR}}/home' } },
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    await expect(stat(dirname(home))).rejects.toThrow();
  });

  it('kills a silent command when Bugpatrol itself dies', { timeout: 30_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bugpatrol-cli-'));
    try {
      const driver = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
      const script = `import { CliDriver } from ${JSON.stringify(driver)};
const driver = new CliDriver({ cwd: process.cwd(), timeoutMs: 60000 });
await driver.connect();
void driver.act({ kind: 'run', command: 'sleep 300 & echo $! > pid; wait' });`;
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: dir, stdio: 'ignore' });
      let pid = 0;
      for (let tries = 0; tries < 100 && !pid; tries++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        pid = Number(await readFile(join(dir, 'pid'), 'utf8').catch(() => '0'));
      }
      expect(pid).toBeGreaterThan(0);
      expect(alive(pid)).toBe(true);
      child.kill('SIGKILL');
      expect(await gone([pid])).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
