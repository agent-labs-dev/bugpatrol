import { resolve } from 'node:path';
import { type BugpatrolConfig, ConfigError } from '@bugpatrol/core';
import { ApiDriver } from './api.js';
import { CliDriver } from './cli.js';
import { CuaDriver } from './cua/driver.js';
import { ElectronDriver } from './electron.js';
import { MaestroDriver } from './maestro.js';
import type { Driver } from './types.js';
import { WebDriver } from './web.js';

/**
 * Pick the transport configured for the app while resolving captured
 * endpoints. `source` is the checkout of the build under test, where a CLI
 * app runs its commands; it defaults to `app.source`.
 */
export function createDriver(
  config: BugpatrolConfig,
  vars: (value: string) => string,
  redact: (value: string) => string = (value) => value,
  source: string = resolve(config.app.source),
): Driver {
  const { platform, connect } = config.app;
  if (platform === 'cli') return new CliDriver({ cwd: source, timeoutMs: connect.cli.timeoutMs, redact });
  if (platform === 'desktop') {
    if (!connect.cua) throw new ConfigError('Desktop driver requires app.connect.cua.launch');
    return new CuaDriver({
      ...connect.cua,
      command: vars(connect.cua.command),
      windowManager: vars(connect.cua.windowManager),
      launch: vars(connect.cua.launch),
      args: connect.cua.args.map((arg) => arg.split('{{PRIVATE_DIR}}').map(vars).join('{{PRIVATE_DIR}}')),
      windowTitle: connect.cua.windowTitle ? vars(connect.cua.windowTitle) : undefined,
      viewport: config.viewports[0]!,
      redact,
    });
  }
  if (platform === 'api') {
    const url = connect.url ?? config.run?.url;
    if (!url) throw new ConfigError('API driver requires app.connect.url');
    return new ApiDriver({
      url: vars(url),
      headers: Object.fromEntries(Object.entries(connect.headers).map(([name, value]) => [name, vars(value)])),
      methods: connect.methods,
      timeoutMs: connect.timeoutMs,
      viewport: config.viewports[0]!,
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
    });
  }
  if (platform === 'electron') {
    if (!connect.cdp) {
      throw new ConfigError('Electron driver requires app.connect.cdp');
    }
    return new ElectronDriver(vars(connect.cdp), connect.allowedOrigins.map(vars));
  }
  if (!connect.appId) {
    throw new ConfigError(`${platform} driver requires app.connect.appId`);
  }
  return new MaestroDriver(platform, {
    appId: vars(connect.appId),
    device: connect.device ? vars(connect.device) : undefined,
  });
}
