import { describe, expect, it } from 'vitest';
import { ConfigError } from '../errors.js';
import { parseConfig } from './load.js';

const minimal = { version: 1, run: { command: 'pnpm dev', url: 'http://localhost:3000' } };

describe('parseConfig', () => {
  it('applies conservative defaults', () => {
    const c = parseConfig(minimal);
    expect(c.tolerance.default).toBe('exact');
    expect(c.crawl.allowDestructive).toBe(false);
    expect(c.production.allowMutations).toBe(false);
    expect(c.surfaces.fixPRs).toBe(false);
    expect(c.determinism.blockThirdPartyRequests).toBe(true);
    expect(c.viewports).toHaveLength(2);
    expect(c.agents.review).toMatchObject({ claims: false, maxSteps: 150 });
    expect(c.agents.review.budgetUsd).toBeUndefined();
    expect(c.agents.fixer).toMatchObject({ attempts: 3, retest: { attempts: 2 } });
  });

  it('reads declared benchmarks, and rejects a parse rule that is no regular expression or a name used twice', () => {
    const bench = { name: 'p99', command: 'k6 run load.js', metric: 'p99 latency in ms', parse: 'p\\(99\\)=([\\d.]+)' };
    const review = (benches: unknown[]) => parseConfig({ ...minimal, agents: { review: { benches } } });
    expect(parseConfig(minimal).agents.review.benches).toEqual([]);
    expect(review([bench]).agents.review.benches).toMatchObject([{ ...bench, better: 'lower', runs: 5 }]);
    expect(() => review([{ ...bench, parse: '([' }])).toThrow(ConfigError);
    expect(() => review([bench, bench])).toThrow(ConfigError);
  });

  it('rejects an unknown version rather than guessing', () => {
    expect(() => parseConfig({ ...minimal, version: 2 })).toThrow(ConfigError);
  });

  it('rejects an auth login flow, since nothing reads it, but accepts the kind: none older configs carry', () => {
    expect(() => parseConfig({ ...minimal, auth: { kind: 'none' } })).not.toThrow();
    expect(() => parseConfig({ ...minimal, auth: { kind: 'form', loginUrl: '/login' } })).toThrow(
      /does not read `auth`/,
    );
  });

  it('requires a bring-up command', () => {
    expect(() => parseConfig({ version: 1, run: { url: 'http://localhost:3000' } })).toThrow(ConfigError);
  });
});
