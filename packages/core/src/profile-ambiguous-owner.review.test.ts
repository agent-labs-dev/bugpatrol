import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { moveProfileFiles, paths } from './paths.js';

it('does not give an existing web config files to a newly selected cli profile when no default config exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'profile-ambiguous-owner-'));
  try {
    mkdirSync(paths.routines(root), { recursive: true });
    // Before this PR, a repository using only web.yml kept its files in the shared layout.
    writeFileSync(
      join(root, '.bugpatrol', 'web.yml'),
      'version: 1\napp: { platform: web, connect: { url: "http://localhost:3000" } }\n',
    );
    writeFileSync(paths.appMap(root), '{"version":1,"platform":"web","screens":[]}');
    writeFileSync(paths.routine(root, 'web-login'), '{"platform":"web","steps":[]}');
    // Adding another config supplies no evidence that it owns those old files.
    writeFileSync(join(root, '.bugpatrol', 'cli.yml'), 'version: 1\napp: { platform: cli }\n');
    moveProfileFiles(root, 'cli');
    expect(
      existsSync(paths.appMap(root)),
      'files whose owner is ambiguous must stay available for their actual owner',
    ).toBe(true);
    expect(readFileSync(paths.routine(root, 'web-login'), 'utf8')).toContain('web');
    expect(existsSync(paths.routine(root, 'web-login', 'cli'))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
