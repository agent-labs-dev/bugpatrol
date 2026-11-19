import { describe, expect, it } from 'vitest';
import { configArgs, dropLauncherEnv, legacyEnv, withDefaultCommand } from './argv.js';

describe('withDefaultCommand', () => {
  it('starts the patrol with no command, and keeps the patrol flags', () => {
    expect(withDefaultCommand([])).toEqual(['patrol']);
    expect(withDefaultCommand(['--once'])).toEqual(['patrol', '--once']);
    expect(withDefaultCommand(['--once', '--force'])).toEqual(['patrol', '--once', '--force']);
  });

  it('passes a command and the help and version flags through', () => {
    expect(withDefaultCommand(['init', '--yes'])).toEqual(['init', '--yes']);
    expect(withDefaultCommand(['patrol', '--once'])).toEqual(['patrol', '--once']);
    expect(withDefaultCommand(['--help'])).toEqual(['--help']);
    expect(withDefaultCommand(['-v'])).toEqual(['-v']);
  });
});

describe('legacyEnv', () => {
  it('fills each BUGPATROL_ var from its BUGHUNTERS_ var, and keeps a value that is set', () => {
    const env = { BUGHUNTERS_MODEL_API_KEY: 'old', BUGHUNTERS_MODEL_NAME: 'old', BUGPATROL_MODEL_NAME: 'new' };
    legacyEnv(env);
    expect(env).toMatchObject({ BUGPATROL_MODEL_API_KEY: 'old', BUGPATROL_MODEL_NAME: 'new' });
  });
});

describe('dropLauncherEnv', () => {
  it('drops the npm_ variables npx sets, so app commands do not see npm as their package manager', () => {
    const env: NodeJS.ProcessEnv = {
      npm_config_user_agent: 'npm/12.2.2 node/v22.23.5 linux x64',
      npm_execpath: '/usr/lib/node_modules/npm/bin/npx-cli.js',
      npm_command: 'exec',
      PATH: '/usr/bin',
      NPM_CONFIG_REGISTRY: 'https://registry.example.com',
    };
    dropLauncherEnv(env);
    expect(env).toEqual({ PATH: '/usr/bin', NPM_CONFIG_REGISTRY: 'https://registry.example.com' });
  });
});

describe('configArgs', () => {
  it('selects a profile before or after the command and preserves other flags', () => {
    expect(configArgs(['--config', '.bugpatrol/api.yml', 'explore', '--steps', '5'])).toEqual({
      configFile: '.bugpatrol/api.yml',
      args: ['explore', '--steps', '5'],
    });
    expect(configArgs(['explore', '--config', '.bugpatrol/native.yml', '--steps', '5'])).toEqual({
      configFile: '.bugpatrol/native.yml',
      args: ['explore', '--steps', '5'],
    });
    expect(() => configArgs(['explore', '--config', '--steps'])).toThrow('requires a file path');
    expect(() => configArgs(['--config', 'a', '--config', 'b'])).toThrow('only once');
  });
});
