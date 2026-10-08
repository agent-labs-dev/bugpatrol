import { bugpatrolConfigSchema, ConfigError } from '@bugpatrol/core';
import { describe, expect, it } from 'vitest';
import { CliDriver } from './cli.js';
import { createDriver } from './factory.js';

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
});
