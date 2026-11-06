import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { detectBringUp } from './bringup.js';

it('discovers existing CI startup commands in the ESM package', () => {
  const root = mkdtempSync(join(tmpdir(), 'bh-bringup-'));
  try {
    mkdirSync(join(root, '.github/workflows'), { recursive: true });
    writeFileSync(join(root, '.github/workflows/ci.yml'), 'steps:\n  - run: pnpm run dev\n');
    expect(detectBringUp(root)).toMatchObject([{ command: 'pnpm run dev', rung: 'precedent' }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("prefers the repo's own dev commands, also in an app folder, over a compose stack", () => {
  const root = mkdtempSync(join(tmpdir(), 'bh-bringup-'));
  try {
    writeFileSync(join(root, 'docker-compose.yml'), 'services:\n  web:\n    ports: ["80:80"]\n');
    mkdirSync(join(root, 'frontend'));
    writeFileSync(join(root, 'frontend/package.json'), JSON.stringify({ scripts: { dev: 'next dev' } }));
    writeFileSync(join(root, 'frontend/pnpm-lock.yaml'), '');
    expect(detectBringUp(root).map(({ command, cwd }) => ({ command, cwd }))).toEqual([
      { command: 'pnpm --dir frontend run dev', cwd: 'frontend' },
      { command: 'docker compose up', cwd: undefined },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
