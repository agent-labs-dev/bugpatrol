import { bugpatrolConfigSchema, ConfigError } from '@bugpatrol/core';
import { describe, expect, it } from 'vitest';
import { credentialSets } from './api.js';
import { CliDriver } from './cli.js';
import { apiCredentials, createDriver } from './factory.js';

const vars = (value: string) => value;

describe('createDriver', () => {
  it('requires a CDP endpoint for Electron', () => {
    const config = bugpatrolConfigSchema.parse({ version: 1, app: { platform: 'electron' } });
    expect(() => createDriver(config, vars)).toThrow(ConfigError);
    expect(() => createDriver(config, vars)).toThrow('app.connect.cdp');
  });

  it.each(['ios', 'android'] as const)('requires an app id for %s', (platform) => {
    const config = bugpatrolConfigSchema.parse({ version: 1, app: { platform } });
    expect(() => createDriver(config, vars)).toThrow(ConfigError);
    expect(() => createDriver(config, vars)).toThrow('app.connect.appId');
  });

  it('runs a CLI app from the source of the build', () => {
    const config = bugpatrolConfigSchema.parse({
      version: 1,
      app: { platform: 'cli', connect: { cli: { timeoutMs: 5000 } } },
    });
    const driver = createDriver(config, vars, vars, '/work/review-7-head');
    expect(driver).toBeInstanceOf(CliDriver);
    expect(driver.platform).toBe('cli');
  });

  it('puts connect.headers into each credential set, and a set header wins whatever its case', () => {
    const connect = (extra: Record<string, unknown> = {}) =>
      bugpatrolConfigSchema.parse({
        version: 1,
        app: {
          platform: 'api',
          connect: { url: 'http://127.0.0.1:1', headers: { Accept: 'application/json', Authorization: 'x' }, ...extra },
        },
      }).app.connect;
    expect(apiCredentials(connect(), vars)).toEqual({ self: { Accept: 'application/json', Authorization: 'x' } });
    const two = apiCredentials(
      connect({
        credentials: {
          self: { headers: { authorization: 'Bearer {{A}}' } },
          other: { headers: { authorization: 'Bearer {{B}}', 'X-Workspace-Id': 'ws-b' } },
        },
      }),
      (value) => value.replace('{{B}}', 'token-b'),
    );
    expect(two).toEqual({
      self: { Accept: 'application/json', authorization: 'Bearer {{A}}' },
      other: { Accept: 'application/json', authorization: 'Bearer token-b', 'X-Workspace-Id': 'ws-b' },
    });
    expect(credentialSets(two)).toEqual(['self', 'other']);
    expect(credentialSets(apiCredentials({ headers: {} }, vars))).toEqual([]);
  });
});
