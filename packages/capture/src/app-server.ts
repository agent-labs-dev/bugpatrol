import { type ChildProcess, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import type { BugpatrolConfig } from '@bugpatrol/core';
import { InfrastructureError, requireRun } from '@bugpatrol/core';

export type AppServer = {
  url: string;
  /** Already running when Bugpatrol started, so it is not ours to stop. */
  external: boolean;
  stop(): Promise<void>;
  stderrTail(): string;
};

const PROBE_INTERVAL_MS = 500;
const STDERR_TAIL_LINES = 20;

/**
 * Brings the product up and proves it is actually serving.
 *
 * Everything that fails in here is an INFRASTRUCTURE error, never a product
 * failure: "Bugpatrol could not start your dev server" and "Bugpatrol found a bug"
 * are different statements, and conflating them is how a CI check gets
 * switched off (spec 5.1).
 */
export async function startApp(
  config: BugpatrolConfig,
  options: { cwd: string; env?: NodeJS.ProcessEnv; reuseExisting?: boolean } = { cwd: process.cwd() },
): Promise<AppServer> {
  const url = requireRun(config).url;

  // If something is already serving here, use it. Re-spawning would either
  // fail on the port or leave two servers fighting over it.
  if (options.reuseExisting !== false && (await isHealthy(config))) {
    return { url, external: true, stop: async () => {}, stderrTail: () => '' };
  }

  const stderr: string[] = [];
  const child = spawn(requireRun(config).command, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env, TZ: config.determinism.timezone, LANG: 'en_US.UTF-8' },
    shell: true,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    stderr.push(...chunk.toString().split('\n').filter(Boolean));
    if (stderr.length > STDERR_TAIL_LINES) stderr.splice(0, stderr.length - STDERR_TAIL_LINES);
  });
  // stdout is drained so a chatty dev server cannot fill its pipe buffer and
  // deadlock waiting for a reader that never arrives.
  child.stdout?.resume();

  let exited: number | null = null;
  child.on('exit', (code) => {
    exited = code ?? 0;
  });

  const server: AppServer = {
    url,
    external: false,
    stop: () => stopProcess(child),
    stderrTail: () => stderr.join('\n'),
  };

  const deadline = Date.now() + requireRun(config).ready.timeoutMs;
  while (Date.now() < deadline) {
    if (exited !== null) {
      await server.stop();
      throw new InfrastructureError(
        `The bring-up command exited with code ${exited} before the app became healthy.\n` +
          `  command: ${requireRun(config).command}\n` +
          (stderr.length > 0 ? `  stderr:\n${stderr.map((l) => `    ${l}`).join('\n')}` : '  (no stderr)'),
      );
    }
    if (await isHealthy(config)) return server;
    await delay(PROBE_INTERVAL_MS);
  }

  await server.stop();
  throw new InfrastructureError(
    `The app at ${url} did not pass its health check within ${requireRun(config).ready.timeoutMs}ms.\n` +
      `  command: ${requireRun(config).command}\n` +
      (requireRun(config).ready.selectors.length > 0
        ? `  required selectors: ${requireRun(config).ready.selectors.join(', ')}\n`
        : '') +
      (stderr.length > 0 ? `  stderr:\n${stderr.map((l) => `    ${l}`).join('\n')}` : ''),
  );
}

/**
 * "The port is open" is not sufficient -- plenty of apps serve a 200 error page
 * (spec 1.1). A health check is a URL plus a predicate, so this also requires
 * every configured readiness selector to be present in the response body.
 *
 * The selector check here is a cheap substring probe against server-rendered
 * markup; the authoritative DOM check happens once a browser is attached.
 */
export async function isHealthy(config: BugpatrolConfig): Promise<boolean> {
  try {
    const response = await fetch(requireRun(config).url, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return false;
    if (requireRun(config).ready.selectors.length === 0) return true;

    const body = await response.text();
    return requireRun(config).ready.selectors.every((selector) => bodyMentions(body, selector));
  } catch {
    return false;
  }
}

/**
 * Turns a simple readiness selector into something checkable against raw HTML.
 * Only the forms a person actually puts in `ready.selectors` are handled;
 * anything more exotic falls back to requiring a 200, and the real check
 * happens in the browser.
 */
function bodyMentions(body: string, selector: string): boolean {
  const attr = selector.match(/^\[([a-zA-Z-]+)=([^\]]+)\]$/);
  if (attr) return body.includes(`${attr[1]}="${attr[2]!.replace(/["']/g, '')}"`);
  if (selector.startsWith('#')) return body.includes(`id="${selector.slice(1)}"`);
  if (selector.startsWith('.')) return body.includes(selector.slice(1));
  return true;
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.pid === undefined) return;
  // Killing the group, not the child: `shell: true` means the pid is a shell,
  // and the dev server is its child. Signalling only the shell orphans the
  // server and leaves the port held for the next run.
  const groupAlive = () => {
    if (process.platform === 'win32') return false;
    try {
      process.kill(-child.pid!, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
  };
  const done = new Promise<void>((resolve) =>
    child.exitCode !== null ? resolve() : child.once('exit', () => resolve()),
  );
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  if (process.platform === 'win32') {
    await Promise.race([done, delay(5000)]);
    return;
  }
  // The shell may exit immediately, but descendants still need the full grace period.
  for (let waited = 0; groupAlive() && waited < 5000; waited += 50) await delay(50);
  if (groupAlive()) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
  // The shell can exit before a child such as `uv run api` has reaped its own
  // descendants. Keep the run-owned process group fenced off until it is gone,
  // otherwise the next patrol can inherit its port and report a false failure.
  for (let waited = 0; groupAlive() && waited < 5000; waited += 50) await delay(50);
}
