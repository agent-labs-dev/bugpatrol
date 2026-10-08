import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { castGif, readCast } from './cast.js';
import { CliDriver } from './cli.js';

const SECRET = 'hunter2-very-secret';
const redact = (value: string) => value.replaceAll(SECRET, '[redacted]');

async function withDriver(run: (driver: CliDriver, dir: string) => Promise<void>, timeoutMs = 10_000) {
  const dir = await mkdtemp(join(tmpdir(), 'bugpatrol-cli-'));
  const driver = new CliDriver({ cwd: dir, timeoutMs, redact });
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
      expect(observation.screenshot.subarray(1, 4).toString()).toBe('PNG');

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
});
