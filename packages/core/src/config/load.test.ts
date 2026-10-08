import { describe, expect, it } from 'vitest';
import { ConfigError } from '../errors.js';
import { parseConfig, resolveSecretRefs } from './load.js';

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
    expect(c.agents.review).toMatchObject({ claims: false, maxSteps: 60 });
    expect(c.agents.review.budgetUsd).toBeUndefined();
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

  it('requires a bring-up command', () => {
    expect(() => parseConfig({ version: 1, run: { url: 'http://localhost:3000' } })).toThrow(ConfigError);
  });
});

describe('resolveSecretRefs', () => {
  it('resolves ${VAR} from the environment', () => {
    expect(resolveSecretRefs({ a: '${TOKEN}' }, { TOKEN: 's3cret' })).toEqual({ a: 's3cret' });
  });

  it('fails loudly on a missing secret instead of sending an empty string', () => {
    expect(() => resolveSecretRefs('${MISSING}', {})).toThrow(ConfigError);
  });
});
