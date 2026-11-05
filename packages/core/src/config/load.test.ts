import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
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

  it('fills every nested default when whole sections are left out', () => {
    // A section absent from the file still gets the defaults of its fields:
    // an omitted `use` is the default model route, not an empty runtime.
    const c = parseConfig({ version: 1, app: { platform: 'cli' }, agents: { github: { enabled: false } } });
    expect(c.agents.explorer.use).toEqual({ runtime: 'model', via: 'openrouter', model: 'z-ai/glm-5.3-flash' });
    expect(c.agents.judge.use).toEqual({ runtime: 'model', via: 'openrouter', model: 'z-ai/glm-5.3-flash' });
    expect(c.agents.fixer.use).toMatchObject({ runtime: 'cli', agent: 'claude' });
    expect(c.agents.github.ci).toMatchObject({ enabled: true, attempts: 2 });
    expect(c.determinism.stabilityGate).toMatchObject({ consecutiveIdenticalFrames: 2, intervalMs: 120 });
    expect(c.decisions.confidence).toEqual({ high: 0.85, low: 0.55 });
    expect(c.scope.include).toEqual(['src/**', 'app/**']);
  });

  it('reads declared benchmarks, and rejects a parse rule that is no regular expression or a name used twice', () => {
    const bench = { name: 'p99', command: 'k6 run load.js', metric: 'p99 latency in ms', parse: 'p\\(99\\)=([\\d.]+)' };
    const review = (benches: unknown[]) => parseConfig({ ...minimal, agents: { review: { benches } } });
    expect(parseConfig(minimal).agents.review.benches).toEqual([]);
    expect(review([bench]).agents.review.benches).toMatchObject([{ ...bench, better: 'lower', runs: 5 }]);
    expect(() => review([{ ...bench, parse: '([' }])).toThrow(ConfigError);
    expect(() => review([bench, bench])).toThrow(ConfigError);
  });

  it('reads app.readOnly, and asks for a proxy where Bugpatrol cannot see the requests', () => {
    expect(parseConfig(minimal).app.readOnly).toBeUndefined();
    expect(parseConfig({ ...minimal, app: { readOnly: true } }).app.readOnly).toEqual({
      proxy: {},
      websockets: 'block',
      dropFrames: [],
    });
    const cli = (readOnly: unknown) => parseConfig({ version: 1, app: { platform: 'cli', readOnly } });
    expect(() => cli(true)).toThrow(/app.readOnly.proxy/);
    expect(cli({ proxy: { API_URL: '${API_URL}' } }).app.readOnly?.proxy).toEqual({ API_URL: '${API_URL}' });
    expect(() => cli({ proxy: { api: 'https://api.test' } })).toThrow(ConfigError);
    expect(() => cli({ proxy: { API: 'https://api.test' }, dropFrames: ['push'] })).toThrow(/websockets to pass/);
    expect(() => cli({ proxy: { API: 'https://api.test' }, mode: 'strict' })).toThrow(ConfigError);
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

  it('rejects an unknown setup key, naming it and the supported readiness field', () => {
    const setup = [{ run: 'npm run start', background: true, readyUrl: 'http://127.0.0.1:3017/demo' }];
    expect(() => parseConfig({ version: 1, app: { connect: { url: 'http://x' }, setup } })).toThrow(
      /app\.setup\.0: Unknown key `readyUrl`\. Use `readyWhen`/,
    );
    expect(() =>
      parseConfig({ version: 1, app: { connect: { url: 'http://x' }, teardown: [{ run: 'x', cmd: 'y' }] } }),
    ).toThrow(/app\.teardown\.0: Unknown key `cmd`\. Use `run`/);
  });

  it('rejects an unknown key anywhere a user writes one, rather than dropping it', () => {
    const app = { connect: { url: 'http://x' } };
    for (const [raw, where] of [
      [{ ...minimal, plaform: 'web' }, /<root>: Unknown key `plaform`/],
      [{ version: 1, app: { ...app, platfrom: 'cli' } }, /app: Unknown key `platfrom`/],
      [{ version: 1, app: { connect: { url: 'http://x', cdpPort: 1 } } }, /app\.connect: Unknown key `cdpPort`/],
      [{ version: 1, app, agents: { explorer: { maxStep: 3 } } }, /agents\.explorer: Unknown key `maxStep`/],
      [{ version: 1, app, agents: { fixer: { retest: { prepar: 'x' } } } }, /agents\.fixer\.retest: Unknown/],
      [{ ...minimal, run: { ...minimal.run, ready: { selector: 'x' } } }, /run\.ready: Unknown key `selector`/],
    ] as const) {
      expect(() => parseConfig(raw)).toThrow(where);
    }
  });

  it('accepts every config in the repo', () => {
    const root = join(import.meta.dirname, '../../../..');
    const files = [
      'bugpatrol.example.yml',
      ...readdirSync(join(root, 'examples')).map((dir) => join('examples', dir, '.bugpatrol', 'bugpatrol.yml')),
    ].filter((file) => existsSync(join(root, file)));
    expect(files.length).toBeGreaterThan(3);
    for (const file of files)
      expect(() => parseConfig(parseYaml(readFileSync(join(root, file), 'utf8')), file)).not.toThrow();
  });

  it('requires a bring-up command', () => {
    expect(() => parseConfig({ version: 1, run: { url: 'http://localhost:3000' } })).toThrow(ConfigError);
  });
});
