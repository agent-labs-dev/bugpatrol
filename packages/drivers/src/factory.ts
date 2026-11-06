import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type Contract, requestPolicy } from '@bugpatrol/contract';
import { type BugpatrolConfig, ConfigError } from '@bugpatrol/core';
import { type ApiCredentials, ApiDriver } from './api.js';
import { Pacer } from './api-pacer.js';
import { CliDriver, PRIVATE_DIR } from './cli.js';
import { CuaDriver } from './cua/driver.js';
import { ElectronDriver } from './electron.js';
import { launchElectron } from './electron-launch.js';
import { MaestroDriver } from './maestro.js';
import { type ReadOnlyOptions, WriteLog } from './readonly.js';
import type { Driver } from './types.js';
import { WebDriver } from './web.js';

/**
 * A command runs in a shell, so a `${name}` that `vars` does not know is the
 * shell's own variable, such as one the command sets, and stays as written.
 */
function shellCommand(command: string, vars: (value: string) => string): string {
  return command
    .split(/(\$\{[A-Za-z_][A-Za-z_0-9]*\})/)
    .map((part, index) => {
      if (index % 2 === 0) return vars(part);
      try {
        return vars(part);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Unknown variable')) return part;
        throw error;
      }
    })
    .join('');
}

/** What `app.readOnly` asks of a driver, logging to `log`. Undefined when read-only mode is off. */
export function readOnlyOptions(config: BugpatrolConfig, log: WriteLog = new WriteLog()): ReadOnlyOptions | undefined {
  const readOnly = config.app.readOnly;
  if (!readOnly) return undefined;
  return {
    log,
    websockets: readOnly.websockets,
    dropFrames: readOnly.dropFrames.map((pattern) => new RegExp(pattern)),
  };
}

/**
 * Pick the transport configured for the app while resolving captured
 * endpoints. `source` is the checkout of the build under test, where a CLI
 * app runs its commands; it defaults to `app.source`. An api app needs the
 * `contract` that `startApp` loaded, for its request policy. `writes` is the
 * log of the read-only proxies that `startApp` started, which the driver
 * reports with its own blocked writes.
 */
export function createDriver(
  config: BugpatrolConfig,
  vars: (value: string) => string,
  redact: (value: string) => string = (value) => value,
  source: string = resolve(config.app.source),
  contract?: Contract,
  writes?: WriteLog,
): Driver {
  const { platform, connect } = config.app;
  const readOnly = readOnlyOptions(config, writes);
  if (platform === 'cli') {
    const { env, command, ...cli } = connect.cli;
    return new CliDriver({
      ...cli,
      ...(command ? { command: shellCommand(command, vars) } : {}),
      cwd: source,
      redact,
      ...(readOnly ? { writes: readOnly.log } : {}),
      env: Object.fromEntries(
        Object.entries(env).map(([name, value]) => [name, value.split(PRIVATE_DIR).map(vars).join(PRIVATE_DIR)]),
      ),
    });
  }
  if (platform === 'desktop') {
    if (!connect.cua) throw new ConfigError('Desktop driver requires app.connect.cua.launch');
    return new CuaDriver({
      ...connect.cua,
      command: vars(connect.cua.command),
      windowManager: vars(connect.cua.windowManager),
      launch: vars(connect.cua.launch),
      args: connect.cua.args.map((arg) => arg.split(PRIVATE_DIR).map(vars).join(PRIVATE_DIR)),
      windowTitle: connect.cua.windowTitle ? vars(connect.cua.windowTitle) : undefined,
      viewport: config.viewports[0]!,
      redact,
      ...(readOnly ? { writes: readOnly.log } : {}),
    });
  }
  if (platform === 'api') {
    const url = connect.url ?? config.run?.url;
    if (!url) throw new ConfigError('API driver requires app.connect.url');
    if (!contract) throw new ConfigError('API driver requires the contract of the app');
    const origin = vars(url);
    return new ApiDriver({
      url: origin,
      credentials: apiCredentials(connect, vars),
      policy: requestPolicy(contract, { ...connect, url: origin, readOnly: Boolean(readOnly) }),
      pacer: new Pacer({ perMinute: connect.perMinute }),
      timeoutMs: connect.timeoutMs,
      redact,
    });
  }
  if (platform === 'web') {
    const url = connect.url ?? config.run?.url;
    if (!url) {
      throw new ConfigError('Web driver requires app.connect.url or run.url');
    }
    const viewport = config.viewports[0]!;
    return new WebDriver({
      url: vars(url),
      viewport: { width: viewport.width, height: viewport.height },
      allowedOrigins: connect.allowedOrigins.map(vars),
      readOnly,
    });
  }
  if (platform === 'electron') {
    const { cdp, launch } = connect;
    const origins = connect.allowedOrigins.map(vars);
    if (cdp && !launch) return new ElectronDriver(vars(cdp), origins, undefined, readOnly);
    if (!launch || cdp) {
      throw new ConfigError('Electron driver requires exactly one of app.connect.cdp or app.connect.launch');
    }
    const options = {
      cwd: source,
      command: vars(launch.command),
      args: launch.args.map(vars),
      userDataDir: launch.userDataDir ? resolve(source, vars(launch.userDataDir)) : undefined,
      cdp: launch.cdp,
      width: launch.width,
      height: launch.height,
    };
    // The app starts on connect, so building a driver has no side effects.
    return new ElectronDriver(
      async () => launchElectron({ ...options, directory: await mkdtemp(join(tmpdir(), 'bugpatrol-electron-')) }),
      origins,
      undefined,
      readOnly,
    );
  }
  if (!connect.appId) {
    throw new ConfigError(`${platform} driver requires app.connect.appId`);
  }
  return new MaestroDriver(platform, {
    appId: vars(connect.appId),
    device: connect.device ? vars(connect.device) : undefined,
    ...(readOnly ? { writes: readOnly.log } : {}),
  });
}

/**
 * The credential sets of an api app (3b). `connect.headers` goes into each
 * set, and a set's own headers win. Without `connect.credentials`,
 * `connect.headers` is the only set.
 */
export function apiCredentials(
  connect: Pick<BugpatrolConfig['app']['connect'], 'headers' | 'credentials'>,
  vars: (value: string) => string,
): ApiCredentials {
  // Header names ignore case, so a set's own `authorization` replaces a shared `Authorization`.
  const set = (headers: Record<string, string> = {}) => {
    const own = new Set(Object.keys(headers).map((name) => name.toLowerCase()));
    const shared = Object.entries(connect.headers).filter(([name]) => !own.has(name.toLowerCase()));
    return Object.fromEntries([...shared, ...Object.entries(headers)].map(([name, value]) => [name, vars(value)]));
  };
  const { credentials } = connect;
  return {
    self: set(credentials?.self.headers),
    ...(credentials?.other ? { other: set(credentials.other.headers) } : {}),
  };
}
