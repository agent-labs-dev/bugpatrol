import { type ChildProcess, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { type Contract, loadContract } from '@bugpatrol/contract';
import { type AppCommand, type AppConfig, ConfigError, InfrastructureError } from '@bugpatrol/core';
import { type ReadOnlyProxy, startReadOnlyProxy, WriteLog } from '@bugpatrol/drivers';
import type { Vars } from './vars.js';

type Options = {
  root: string;
  vars: Vars;
  emit?: (summary: string) => void;
  source?: string;
  /** The config profile, whose endpoint inventory an api app reads. */
  profile?: string;
};

type RunningApp = {
  vars: Vars;
  /**
   * An api app: its contract, loaded one time when setup is done, because
   * the spec can come from the running app. The driver, the sweep, and the
   * explorer of this run all use this one object. Without a spec or an
   * endpoint inventory it has no endpoints, so only reads can go out.
   */
  contract?: Contract;
  /** Read-only mode: the writes that it blocked, to give to the driver. */
  writes?: WriteLog;
  stop(): Promise<void>;
};

/** Shell commands belong to the app configuration. A source override swaps commands rooted at app.source into the worktree; every command receives BUGPATROL_SOURCE (and BUGHUNTERS_SOURCE, its name before the rename). Output is redacted. */
export async function startApp(app: AppConfig, opts: Options): Promise<RunningApp> {
  const children: ChildProcess[] = [];
  const report = (message: string) => opts.emit?.(opts.vars.redact(message) as string);
  const configuredSource = resolve(opts.root, app.source);
  const effectiveSource = opts.source ?? configuredSource;

  async function run(command: AppCommand, phase: 'Setup' | 'Teardown'): Promise<void> {
    const shell = opts.vars.resolveConfig(command.run);
    const configuredCwd = resolve(opts.root, opts.vars.resolveConfig(command.cwd ?? '.'));
    const cwd = opts.source && configuredCwd === configuredSource ? opts.source : configuredCwd;
    const env = {
      ...process.env,
      ...Object.fromEntries(opts.vars.entries()),
      BUGPATROL_SOURCE: effectiveSource,
      BUGHUNTERS_SOURCE: effectiveSource,
    };
    const started = Date.now();
    const child = spawn('/bin/sh', ['-c', shell], {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let settled = false;
    const captures = Object.entries(command.capture).map(([name, pattern]) => [name, new RegExp(pattern)] as const);
    const append = (chunk: Buffer) => {
      output += chunk.toString();
      for (const [name, pattern] of captures) {
        const match = pattern.exec(output);
        if (match?.[1] !== undefined) {
          opts.vars.set(name, match[1]);
        }
      }
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    const exit = new Promise<number>((done, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => {
        settled = true;
        done(code ?? 1);
      });
    });
    const timeout = setTimeout(() => killGroup(child), command.timeoutMs);
    try {
      if (command.background) {
        if (command.readyWhen) {
          const ready = new RegExp(command.readyWhen);
          await new Promise<void>((done, reject) => {
            const wait = setTimeout(() => finish(new Error('timed out waiting for ready output')), command.timeoutMs);
            const finish = (error?: Error) => {
              clearTimeout(wait);
              child.stdout?.off('data', check);
              child.stderr?.off('data', check);
              child.off('exit', onExit);
              child.off('error', finish);
              if (error) {
                reject(error);
              } else {
                done();
              }
            };
            const check = () => {
              if (ready.test(output)) {
                finish();
              }
            };
            const onExit = () => finish(new Error('exited before ready'));
            child.stdout?.on('data', check);
            child.stderr?.on('data', check);
            child.once('exit', onExit);
            child.once('error', finish);
            check();
          });
        }
        children.push(child);
        void exit.catch(() => undefined);
      } else {
        const code = await exit;
        if (code !== 0) {
          throw new Error(`exit ${code}`);
        }
      }
      report(`${phase}: ran \`${shell}\` (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    } catch (cause) {
      if (!settled) {
        killGroup(child);
      }
      const tail = output.trim().split('\n').slice(-20).join('\n');
      const message = `${phase} command \`${opts.vars.redact(shell)}\` failed: ${String(cause)}`;
      throw new InfrastructureError(`${message}\n${opts.vars.redact(tail)}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  let contract: Contract | undefined;
  const writes = app.readOnly ? new WriteLog() : undefined;
  const proxies: ReadOnlyProxy[] = [];
  const closeProxies = () => Promise.all(proxies.splice(0).map((proxy) => proxy.close()));
  try {
    // First, so that setup, connect and the explorer can all use {{NAME}}.
    for (const [name, value] of Object.entries(app.readOnly?.proxy ?? {})) {
      const upstream = opts.vars.resolveConfig(value);
      if (!URL.canParse(upstream) || !/^https?:$/.test(new URL(upstream).protocol))
        throw new ConfigError(`app.readOnly.proxy.${name} is not an http(s) URL: ${opts.vars.redact(upstream)}`);
      const proxy = await startReadOnlyProxy(upstream, {
        log: writes!,
        websockets: app.readOnly!.websockets,
        dropFrames: app.readOnly!.dropFrames.map((pattern) => new RegExp(pattern)),
      });
      proxies.push(proxy);
      // Before the URL is a variable, which redaction would hide.
      report(`Read-only: {{${name}}} is ${proxy.url}, which passes only GET, HEAD and OPTIONS to the backend`);
      opts.vars.set(name, proxy.url);
    }
    for (const command of app.setup) {
      await run(command, 'Setup');
    }
    if (app.platform === 'api')
      contract = await loadContract(opts.root, app.connect, opts.vars.resolve.bind(opts.vars), opts.profile);
  } catch (error) {
    // A setup that fails halfway may already hold resources (a test run, an
    // identity). Teardown undoes what it can before the error goes up.
    for (const command of app.teardown) {
      try {
        await run(command, 'Teardown');
      } catch (cause) {
        report(String(cause));
      }
    }
    for (const child of children) {
      killGroup(child);
    }
    await closeProxies();
    throw error;
  }
  return {
    vars: opts.vars,
    ...(contract ? { contract } : {}),
    ...(writes ? { writes } : {}),
    async stop() {
      for (const command of app.teardown) {
        try {
          await run(command, 'Teardown');
        } catch (error) {
          report(String(error));
        }
      }
      await Promise.all(
        children.map(async (child) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            return;
          }
          killGroup(child);
          const timer = setTimeout(() => killGroup(child, 'SIGKILL'), 5_000);
          await new Promise<void>((done) => child.once('exit', () => done()));
          clearTimeout(timer);
        }),
      );
      await closeProxies();
      if (writes) report(`Read-only mode blocked ${writes.count} write(s) in this run`);
    },
  };
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (!child.pid) {
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}
