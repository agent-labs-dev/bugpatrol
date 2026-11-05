import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { moveProfileFiles, paths } from './paths.js';

it('preserves the default config files when a second app profile is first used', () => {
  const root = mkdtempSync(join(tmpdir(), 'profile-ownership-'));
  try {
    mkdirSync(paths.routines(root), { recursive: true });
    writeFileSync(
      paths.config(root),
      'version: 1\napp: { platform: web, connect: { url: "http://localhost:3000" } }\n',
    );
    writeFileSync(join(root, '.bugpatrol', 'cli.yml'), 'version: 1\napp: { platform: cli }\n');
    writeFileSync(paths.appMap(root), '{"platform":"web","screens":[]}');
    writeFileSync(paths.routine(root, 'web-login'), '{"platform":"web","steps":[]}');
    moveProfileFiles(root, 'cli');
    expect(existsSync(paths.appMap(root)), 'the default app map must remain available').toBe(true);
    expect(readFileSync(paths.routine(root, 'web-login'), 'utf8')).toContain('web');
    expect(existsSync(paths.routine(root, 'web-login', 'cli'))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
