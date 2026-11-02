import { describe, expect, it } from 'vitest';
import { Vars } from './vars.js';

describe('Vars', () => {
  it('resolves captures and allowlisted environment values', () => {
    const vars = new Vars(['TOKEN'], { TOKEN: 'top-secret' });
    vars.set('CDP_PORT', '9624');
    expect(vars.resolve('{{TOKEN}}:${CDP_PORT}')).toBe('top-secret:9624');
    expect(vars.has('CDP_PORT')).toBe(true);
  });

  it('refreshes non-secret response ids without overwriting configured variables', () => {
    const vars = new Vars(['RESPONSE_AUTH'], { RESPONSE_AUTH: 'configured-secret' });
    vars.capture({ RESPONSE_THREAD: 'old-thread' });
    vars.capture({ RESPONSE_THREAD: 'new-thread' });
    expect(vars.resolve('{{RESPONSE_THREAD}}')).toBe('new-thread');
    expect(vars.redact('old-thread new-thread configured-secret')).toBe('old-thread new-thread {{RESPONSE_AUTH}}');
    expect(() => vars.capture({ RESPONSE_AUTH: 'replacement' })).toThrow('cannot overwrite');
  });

  it('lists names but never values for an unknown strict placeholder', () => {
    const vars = new Vars();
    vars.set('TOKEN', 'top-secret');
    expect(() => vars.resolve('{{MISSING}}')).toThrow('Available: TOKEN');
    expect(() => vars.resolve('{{MISSING}}')).not.toThrow('top-secret');
  });

  it('never gives agent input an undeclared environment variable', () => {
    const vars = new Vars([], { PRIVATE_KEY: 'synthetic-secret' });
    expect(() => vars.resolve('{{PRIVATE_KEY}}')).toThrow('Unknown variable PRIVATE_KEY');
    expect(vars.resolve('${PRIVATE_KEY}')).toBe('${PRIVATE_KEY}');
  });

  it('leaves a shell ${name} in agent input to the shell, and still fills in a declared one', () => {
    const vars = new Vars(['TOKEN'], { TOKEN: 'top-secret' });
    const loop = 'for s in a b; do luajit tests/${s}_spec.lua; done';
    expect(vars.resolve(loop)).toBe(loop);
    expect(vars.resolve('echo ${HOME} ${TOKEN}')).toBe('echo ${HOME} top-secret');
  });

  it('keeps trusted setup expansion separate from agent authority', () => {
    const vars = new Vars([], { SETUP_TOKEN: 'setup-only' });
    expect(vars.resolveConfig('${SETUP_TOKEN}')).toBe('setup-only');
    expect(vars.redact('setup-only')).toBe('{{SETUP_TOKEN}}');
    expect(vars.names()).toEqual([]);
    expect(vars.resolve('${SETUP_TOKEN}')).toBe('${SETUP_TOKEN}');
    expect(vars.resolveConfig('${SHELL_VAR}')).toBe('${SHELL_VAR}');
  });

  it('preserves numeric response ids and literal request data while redacting secret history', () => {
    const vars = new Vars([], { RESPONSE_CONFIGURED: 'configured' });
    vars.capture({ RESPONSE_ID: '1' });
    expect(vars.redact('{"id":2,"parent":1,"limit":10}')).toBe('{"id":2,"parent":1,"limit":10}');
    vars.set('TOKEN', 'old-secret');
    vars.set('TOKEN', 'new-secret');
    vars.capture({ RESPONSE_LITERAL: '{{TOKEN}}' });
    expect(vars.resolve('{{RESPONSE_LITERAL}}')).toBe('{{TOKEN}}');
    expect(vars.redact('old-secret new-secret')).toBe('{{TOKEN}} {{TOKEN}}');
    vars.resolveConfig('${RESPONSE_CONFIGURED}');
    expect(() => vars.capture({ RESPONSE_CONFIGURED: 'replacement' })).toThrow('cannot overwrite');
  });

  it('redacts short nonempty secrets without replacing empty strings', () => {
    const vars = new Vars(['PIN', 'EMPTY'], { PIN: '12', EMPTY: '' });
    expect(vars.redact('PIN=12')).toBe('PIN={{PIN}}');
  });

  it('redacts nested strings, preferring the longest value, and preserves buffers', () => {
    const vars = new Vars();
    vars.set('SHORT', 'abcd');
    vars.set('LONG', 'abcdef');
    const png = Buffer.from('abcdef');
    expect(vars.redact({ nested: ['abcdef and abcd'], png })).toEqual({ nested: ['{{LONG}} and {{SHORT}}'], png });
    expect(vars.redact(png)).toBe(png);
  });
});
