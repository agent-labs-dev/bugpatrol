import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '@bugpatrol/core';
import { describe, expect, it } from 'vitest';
import { type DoctorProbes, readDoctorConfig, runChecks } from './doctor.js';

function project(yaml = 'version: 1\napp: { platform: cli }\n', file = 'bugpatrol.yml'): string {
  const root = mkdtempSync(join(tmpdir(), 'bugpatrol-doctor-'));
  mkdirSync(join(root, '.bugpatrol'));
  writeFileSync(join(root, '.bugpatrol', file), yaml);
  return root;
}

const installed: DoctorProbes = { chromium: () => undefined };
const cliConfig = 'version: 1\napp: { platform: cli }\nagents: { explorer: { use: claude }, judge: { use: claude } }\n';

describe('runChecks', () => {
  it('checks each agent LLM, and leaves out the gate checks without a run block', async () => {
    const config = parseConfig({
      version: 1,
      app: { platform: 'cli' },
      agents: { explorer: { use: { runtime: 'model', via: 'openrouter' } } },
    });
    const root = project();
    const checks = await runChecks(root, { path: join(root, '.bugpatrol', 'bugpatrol.yml'), config }, installed);
    const names = checks.map((check) => check.name);
    expect(names).toEqual(expect.arrayContaining(['config', 'node', 'explorer', 'judge']));
    expect(names).not.toContain('decider');
    expect(names).not.toContain('fixer');
    expect(names).not.toContain('pinned-image');
    expect(names).not.toContain('app-model');
    const explorer = checks.find((check) => check.name === 'explorer')!;
    expect(explorer.ok).toBe(false);
    expect(explorer.detail).toContain('OPENROUTER_API_KEY is not set');
  });

  it('keeps the gate checks for a gate config, and suggests no command that is not built', async () => {
    const root = project();
    const config = parseConfig({ version: 1, run: { command: 'npm run dev', url: 'http://localhost:3000' } });
    const checks = await runChecks(root, { path: join(root, '.bugpatrol', 'bugpatrol.yml'), config }, installed);
    expect(checks.map((check) => check.name)).toContain('pinned-image');
    expect(checks.map((check) => check.detail).join('\n')).not.toContain('recon');
  });

  it('reports the selected profile, also from a folder with no default config', async () => {
    const root = project(cliConfig, 'cli.yml');
    const elsewhere = mkdtempSync(join(tmpdir(), 'bugpatrol-doctor-cwd-'));
    const selected = join(root, '.bugpatrol', 'cli.yml');
    const checks = await runChecks(elsewhere, readDoctorConfig(elsewhere, selected), installed);
    expect(checks.find((check) => check.name === 'config')).toMatchObject({ ok: true, detail: `${selected} found` });
    expect(checks.map((check) => check.name)).toContain('cli:python3');
  });

  it('fails on a selected profile that is missing or invalid, with the reason', async () => {
    const root = project('version: 1\napp: { platform: cli, setup: [{ run: x, readyUrl: y }] }\n', 'cli.yml');
    const invalid = await runChecks(root, readDoctorConfig(root, '.bugpatrol/cli.yml'), installed);
    expect(invalid.find((check) => check.name === 'config')).toMatchObject({ ok: false, fatal: true });
    expect(invalid.find((check) => check.name === 'config')!.detail).toContain('Unknown key `readyUrl`');
    const missing = await runChecks(root, readDoctorConfig(root, '.bugpatrol/web.yml'), installed);
    expect(missing.find((check) => check.name === 'config')).toMatchObject({
      ok: false,
      detail: `${join(root, '.bugpatrol', 'web.yml')} not found`,
    });
  });

  it('with no config, reports only the config and Node', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bugpatrol-doctor-empty-'));
    const checks = await runChecks(root, readDoctorConfig(root), installed);
    expect(checks.map((check) => check.name)).toEqual(['config', 'node']);
    expect(checks[0]).toMatchObject({ ok: false, detail: 'No .bugpatrol/bugpatrol.yml. Run `bugpatrol init`.' });
  });

  it('checks the browser of a web app, with the install command for the pinned Playwright', async () => {
    const root = project();
    const config = parseConfig({ version: 1, app: { connect: { url: 'http://127.0.0.1:1' } } });
    const loaded = { path: join(root, '.bugpatrol', 'bugpatrol.yml'), config };
    const missing = 'Chromium for Playwright 1.48.2 is not installed. Run: npx -y playwright@1.48.2 install chromium';
    const checks = await runChecks(root, loaded, { chromium: () => missing });
    expect(checks.find((check) => check.name === 'browser')).toMatchObject({ ok: false, fatal: true, detail: missing });
    const cli = parseConfig({ version: 1, app: { platform: 'cli' } });
    const cliChecks = await runChecks(root, { ...loaded, config: cli }, { chromium: () => missing });
    expect(cliChecks.map((check) => check.name)).not.toContain('browser');
  });

  it('checks that the app URL answers when no setup command starts the app', async () => {
    const server = createServer((_, response) => response.writeHead(404).end());
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address() as AddressInfo;
    try {
      const root = project();
      const path = join(root, '.bugpatrol', 'bugpatrol.yml');
      const check = async (app: object) =>
        (await runChecks(root, { path, config: parseConfig({ version: 1, app }) }, installed)).find(
          (each) => each.name === 'url',
        );
      expect(await check({ connect: { url: `http://127.0.0.1:${port}` } })).toMatchObject({ ok: true });
      server.close();
      expect(await check({ connect: { url: `http://127.0.0.1:${port}` } })).toMatchObject({ ok: false, fatal: true });
      const started = { setup: [{ run: 'npm run dev', background: true }], connect: { url: 'http://127.0.0.1:1' } };
      expect(await check(started)).toBeUndefined();
      expect(await check({ connect: { url: 'http://${HOST}:1' } })).toMatchObject({ ok: true });
      expect(await check({ platform: 'api', connect: { url: 'http://127.0.0.1:1' } })).toMatchObject({ ok: false });
    } finally {
      server.close();
    }
  });

  it('names where a profile keeps its app map, routines and run state', () => {
    const config = {
      ...parseConfig({ version: 1, app: { connect: { url: 'http://localhost:3000' } } }),
      profile: 'cli',
    };
    const check = runChecks(project(), config).find((each) => each.name === 'profile');
    expect(check?.detail).toBe(
      'cli: app map and routines in .bugpatrol/cli/, run state in .bugpatrol/runs/profiles/cli/',
    );
  });
});
