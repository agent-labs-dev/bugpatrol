import { type ChildProcess, spawn } from 'node:child_process';
import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ConfigError, InfrastructureError } from '@bugpatrol/core';
import { createIsolatedDisplay } from './cua/isolation.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const POLL_MS = 50;
const TERMINATE_WAIT_MS = 1_500;
const STDERR_LIMIT = 4_096;
// The reported pid is this shell, the app's parent: Chromium rewrites its own /proc environ for process titles.
// SIGTERM to the shell is forwarded to the app and waited on, so the app exits before the display goes away.
const REPORT_PID =
  'echo "$$" > "$1"; shift; trap \'kill -TERM "$app" 2>/dev/null\' TERM; "$@" & app=$!; ' +
  'while kill -0 "$app" 2>/dev/null; do wait "$app"; status=$?; done; exit "$status"';
// Chromium's single-instance markers point at the source profile's running app; a copy must not inherit them.
const PROFILE_LOCKS = ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'DevToolsActivePort'];

type ChildResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
};

class LaunchFailure extends Error {
  constructor(
    readonly reason: string,
    options?: ErrorOptions,
  ) {
    super(reason, options);
    this.name = 'LaunchFailure';
  }
}

function forbiddenArgument(arg: string): string | undefined {
  if (
    /^--(?:user-data-dir|remote-debugging-port|remote-debugging-pipe|display)(?:=|$)|^--ozone-platform(?:=|-|$)/.test(
      arg,
    )
  ) {
    return arg.split('=', 1)[0];
  }
  if (arg.startsWith('--enable-features=')) {
    const features = arg.slice('--enable-features='.length).split(',');
    if (features.some((feature) => (feature.split('<')[0] ?? feature) === 'UseOzonePlatform')) {
      return '--enable-features=UseOzonePlatform';
    }
  }
  return undefined;
}

function validateArguments(args: string[]): void {
  for (const arg of args) {
    const forbidden = forbiddenArgument(arg);
    if (forbidden) throw new ConfigError(`Electron launcher does not allow ${forbidden} in app args`);
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

function groupExists(groupPid: number): boolean {
  try {
    process.kill(-groupPid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

function childResult(child: ChildProcess): { done: Promise<ChildResult>; get: () => ChildResult | undefined } {
  let result: ChildResult | undefined;
  const done = new Promise<ChildResult>((resolve) => {
    const finish = (next: ChildResult) => {
      if (result) return;
      result = next;
      resolve(next);
    };
    child.once('error', (error) => finish({ code: null, signal: null, error }));
    child.once('close', (code, signal) => finish({ code, signal }));
  });
  return { done, get: () => result };
}

/** The first whitespace-separated token of `file` as a positive integer, or undefined until it is written. */
async function readPositiveInt(file: string): Promise<number | undefined> {
  try {
    const value = Number((await readFile(file, 'utf8')).trim().split(/\s+/, 1)[0]);
    return Number.isInteger(value) && value > 0 ? value : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** True once the fixed CDP port answers: Chromium writes DevToolsActivePort only for an ephemeral port. */
async function cdpAnswers(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1_000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForReady(
  profile: string,
  cdp: number | 'auto',
  pidFile: string,
  child: { get: () => ChildResult | undefined },
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<{ port: number; pid: number }> {
  const deadline = Date.now() + timeoutMs;
  const portFile = join(profile, 'DevToolsActivePort');
  const awaited = cdp === 'auto' ? 'DevToolsActivePort' : `CDP on port ${cdp}`;
  while (true) {
    if (signal?.aborted) throw new LaunchFailure('launch aborted');
    const pid = await readPositiveInt(pidFile);
    const port = cdp === 'auto' ? await readPositiveInt(portFile) : pid && (await cdpAnswers(cdp)) ? cdp : undefined;
    if (port && pid) return { port, pid };
    const exited = child.get();
    if (exited) {
      throw new LaunchFailure(`child exited before ${awaited} was ready`, exited.error);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new LaunchFailure(`timed out waiting for ${awaited}`);
    await wait(Math.min(POLL_MS, remaining));
  }
}

function sendSignal(pid: number, name: NodeJS.Signals): boolean {
  try {
    process.kill(pid, name);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

/** Stop the app first through its parent shell, then the display group if anything is left. */
async function terminate(
  groupPid: number | undefined,
  child: { done: Promise<ChildResult>; get: () => ChildResult | undefined },
  appShellPid?: number,
): Promise<void> {
  if (!groupPid) return;
  if (appShellPid && sendSignal(appShellPid, 'SIGTERM')) {
    await Promise.race([child.done.then(() => undefined), wait(TERMINATE_WAIT_MS)]);
    if (!groupExists(groupPid)) return;
  }
  try {
    process.kill(-groupPid, 'SIGTERM');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    throw error;
  }
  await Promise.race([child.done.then(() => undefined), wait(TERMINATE_WAIT_MS)]);
  if (groupExists(groupPid)) {
    try {
      process.kill(-groupPid, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
    await Promise.race([child.done.then(() => undefined), wait(TERMINATE_WAIT_MS)]);
  }
  // A process in uninterruptible sleep can outlive SIGKILL briefly; wait a bounded time for the group to go.
  for (let waited = 0; groupExists(groupPid) && waited < TERMINATE_WAIT_MS; waited += 50) await wait(50);
}

async function removeDirectory(directory: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      await rm(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EBUSY' && code !== 'ENOTEMPTY') throw error;
      await wait(100);
    }
  }
  await rm(directory, { recursive: true, force: true });
}

function failureMessage(reason: string, result: ChildResult | undefined, stderr: string): string {
  const code = result?.code ?? 'unknown';
  const signal = result?.signal ? `, signal ${result.signal}` : '';
  const error = result?.error ? `, spawn error ${result.error.message}` : '';
  return `Electron launch failed: ${reason}; child exit code: ${code}${signal}${error}; stderr tail: ${stderr || '<empty>'}`;
}

export async function launchElectron(options: {
  command: string;
  args: string[];
  directory: string;
  /** Where the app runs, so a relative command or app path resolves against the app source. */
  cwd: string;
  userDataDir?: string;
  cdp?: number | 'auto';
  width: number;
  height: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<{ cdpUrl: string; pid: number; close(): Promise<void> }> {
  validateArguments(options.args);
  const profile = join(options.directory, 'profile');
  const pidFile = join(options.directory, 'electron.pid');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cdp = options.cdp ?? 'auto';
  let child: ChildProcess | undefined;
  let childState: ReturnType<typeof childResult> | undefined;
  let stderr = '';

  try {
    await mkdir(options.directory, { recursive: true, mode: 0o700 });
    if (options.userDataDir) {
      await cp(options.userDataDir, profile, { recursive: true });
    } else {
      await mkdir(profile, { recursive: true, mode: 0o700 });
    }
    await Promise.all(PROFILE_LOCKS.map((name) => rm(join(profile, name), { force: true })));
    const display = await createIsolatedDisplay(options.directory, options.width, options.height);
    if (options.signal?.aborted) throw new LaunchFailure('launch aborted');
    const appArgs = [
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${cdp === 'auto' ? 0 : cdp}`,
      '--ozone-platform=x11',
      ...options.args,
    ];
    child = spawn(
      display.command,
      display.args(['sh', '-c', REPORT_PID, 'bugpatrol-electron', pidFile, options.command, ...appArgs]),
      { cwd: options.cwd, env: display.env, stdio: ['ignore', 'ignore', 'pipe'] },
    );
    childState = childResult(child);
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-STDERR_LIMIT);
    });
    const ready = await waitForReady(profile, cdp, pidFile, childState, options.signal, timeoutMs);
    let closePromise: Promise<void> | undefined;
    let removeListeners = () => {};
    const close = async (): Promise<void> => {
      closePromise ??= (async () => {
        removeListeners();
        await terminate(child!.pid, childState!, ready.pid);
        await removeDirectory(options.directory);
      })();
      return closePromise;
    };
    // The CLI's own SIGINT and SIGTERM handlers cancel the session and close the driver, which calls close().
    const onAbort = () => void close().catch(() => undefined);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    removeListeners = () => options.signal?.removeEventListener('abort', onAbort);
    if (options.signal?.aborted) {
      await close();
      throw new LaunchFailure('launch aborted');
    }
    return { cdpUrl: `http://127.0.0.1:${ready.port}`, pid: ready.pid, close };
  } catch (error) {
    if (child && childState) await terminate(child.pid, childState);
    await removeDirectory(options.directory);
    if (error instanceof ConfigError) throw error;
    const reason =
      error instanceof LaunchFailure ? error.reason : error instanceof Error ? error.message : String(error);
    throw new InfrastructureError(failureMessage(reason, childState?.get(), stderr), { cause: error });
  }
}
