import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { moveProfileFiles, paths, profileOf } from './paths.js';

it('adding a second config preserves the default config app map, inventory and routines', () => {
  const root = mkdtempSync(join(tmpdir(), 'bugpatrol-profile-review-'));
  try {
    mkdirSync(paths.routines(root), { recursive: true });
    writeFileSync(
      paths.config(root),
      'version: 1\napp: { platform: web, connect: { url: "http://localhost:3000" } }\n',
    );
    writeFileSync(paths.appMap(root), '{"version":1,"platform":"web","screens":[]}');
    writeFileSync(paths.endpointInventory(root), 'endpoints: []\n');
    writeFileSync(paths.routine(root, 'web-login'), '{"id":"web-login","steps":[]}');
    writeFileSync(
      join(root, '.bugpatrol', 'electron.yml'),
      'version: 1\napp: { platform: electron, connect: { launch: { command: electron } } }\n',
    );

    // bin.ts invokes this on the first command using --config .bugpatrol/electron.yml.
    moveProfileFiles(root, profileOf(root, '.bugpatrol/electron.yml'));

    expect({
      map: existsSync(paths.appMap(root)),
      inventory: existsSync(paths.endpointInventory(root)),
      routine: existsSync(paths.routine(root, 'web-login')),
    }).toEqual({ map: true, inventory: true, routine: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
