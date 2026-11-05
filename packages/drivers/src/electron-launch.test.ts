import { execFileSync } from 'node:child_process';
import { access, mkdtemp, readdir, readFile, readlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, InfrastructureError } from '@bugpatrol/core';
import { chromium } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { launchElectron } from './electron-launch.js';

function available(command: string): boolean {
  try {
    execFileSync('sh', ['-c', 'command -v "$1" >/dev/null 2>&1', 'bugpatrol-check', command], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function missingPrerequisite(): string | undefined {
  if (process.platform !== 'linux') return 'private display needs Linux';
  if (!available('Xvfb')) return 'no Xvfb on the PATH';
  if (!available('dbus-run-session')) return 'no dbus-run-session on the PATH';
  return undefined;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function processGroup(pid: number): Promise<number | undefined> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = stat
      .slice(stat.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/);
    const group = Number(fields[2]);
    return Number.isInteger(group) && group > 0 ? group : undefined;
  } catch {
    return undefined;
  }
}

async function groupProcesses(group: number): Promise<number[]> {
  const entries = await readdir('/proc', { withFileTypes: true });
  const pids: number[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const pid = Number(entry.name);
    if ((await processGroup(pid)) === group) pids.push(pid);
  }
  return pids;
}

async function processesUnder(directory: string): Promise<number[]> {
  const entries = await readdir('/proc', { withFileTypes: true });
  const pids: number[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    try {
      const cwd = await readlink(`/proc/${entry.name}/cwd`);
      if (cwd === directory || cwd.startsWith(`${directory}/`) || cwd.startsWith(`${directory} (deleted)`)) {
        pids.push(Number(entry.name));
      }
    } catch {
      // The process can exit between readdir and readlink.
    }
  }
  return pids;
}

async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for process state');
}

async function procEnv(pid: number): Promise<Record<string, string>> {
  const value = (await readFile(`/proc/${pid}/environ`)).toString();
  return Object.fromEntries(
    value
      .split('\0')
      .filter((entry) => entry.includes('='))
      .map((entry) => {
        const index = entry.indexOf('=');
        return [entry.slice(0, index), entry.slice(index + 1)];
      }),
  );
}

const reason = missingPrerequisite();
const directories = new Set<string>();

afterEach(async () => {
  await Promise.all([...directories].map((directory) => rm(directory, { recursive: true, force: true })));
  directories.clear();
});

describe('launchElectron', () => {
  it.skipIf(Boolean(reason))(
    `launches Chromium in a private display and cleans up its process group${reason ? ` (skipped: ${reason})` : ''}`,
    { timeout: 60_000 },
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'bugpatrol-electron-launch-'));
      directories.add(directory);
      const launched = await launchElectron({
        command: chromium.executablePath(),
        args: ['--no-sandbox', '--disable-gpu', '--no-first-run', 'data:text/html,<title>private</title>'],
        directory,
        width: 800,
        height: 600,
      });
      let xvfb: number | undefined;
      try {
        const appEnv = await procEnv(launched.pid);
        expect(appEnv.DISPLAY).toBeTruthy();
        expect(appEnv.DISPLAY).not.toBe(process.env.DISPLAY);
        const group = await processGroup(launched.pid);
        expect(group).toBeDefined();
        xvfb = await waitFor(async () => {
          const pids = await groupProcesses(group!);
          const matches: number[] = [];
          for (const pid of pids) {
            try {
              if ((await readFile(`/proc/${pid}/comm`, 'utf8')).trim() === 'Xvfb') matches.push(pid);
            } catch {
              // The process can exit between the group scan and comm read.
            }
          }
          return matches[0];
        }, 5_000);
        const browser = await chromium.connectOverCDP(launched.cdpUrl);
        try {
          const page = browser.contexts()[0]?.pages()[0];
          expect(page).toBeDefined();
          expect(await page!.evaluate(() => document.title)).toBe('private');
        } finally {
          await browser.close();
        }
      } finally {
        await launched.close();
        await launched.close();
      }
      expect(await exists(`/proc/${launched.pid}`)).toBe(false);
      expect(xvfb).toBeDefined();
      expect(await exists(`/proc/${xvfb}`)).toBe(false);
      expect(await exists(directory)).toBe(false);
    },
  );

  it.skipIf(Boolean(reason))(
    `reports a failed command and cleans up${reason ? ` (skipped: ${reason})` : ''}`,
    { timeout: 30_000 },
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'bugpatrol-electron-launch-failure-'));
      directories.add(directory);
      await expect(
        launchElectron({
          command: join(directory, 'missing-electron'),
          args: [],
          directory,
          width: 800,
          height: 600,
        }),
      ).rejects.toBeInstanceOf(InfrastructureError);
      expect(await exists(directory)).toBe(false);
      expect(await processesUnder(directory)).toEqual([]);
    },
  );

  it.skipIf(Boolean(reason))(
    `cleans up after cancellation${reason ? ` (skipped: ${reason})` : ''}`,
    { timeout: 30_000 },
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'bugpatrol-electron-launch-cancel-'));
      directories.add(directory);
      const controller = new AbortController();
      const launched = await launchElectron({
        command: chromium.executablePath(),
        args: ['--no-sandbox', '--disable-gpu', '--no-first-run', 'data:text/html,<title>cancel</title>'],
        directory,
        width: 800,
        height: 600,
        signal: controller.signal,
      });
      const group = await processGroup(launched.pid);
      expect(group).toBeDefined();
      controller.abort();
      await waitFor(async () => {
        const processes = await groupProcesses(group!);
        return processes.length === 0 ? processes : undefined;
      }, 10_000);
      await waitFor(async () => ((await exists(directory)) ? undefined : true), 10_000);
      expect(await exists(directory)).toBe(false);
      await launched.close();
    },
  );

  it('rejects display and debugging overrides before spawning', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bugpatrol-electron-launch-args-'));
    directories.add(directory);
    await expect(
      launchElectron({
        command: chromium.executablePath(),
        args: ['--remote-debugging-port=9222'],
        directory,
        width: 800,
        height: 600,
      }),
    ).rejects.toBeInstanceOf(ConfigError);
  });
});
