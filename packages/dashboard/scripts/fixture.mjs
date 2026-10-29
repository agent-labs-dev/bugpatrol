// Run: pnpm build && node packages/dashboard/scripts/fixture.mjs /tmp/bugpatrol-fixture [client|api|monorepo]
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { writeProjectFixture } from '../dist/fixtures/project.js';

const root = resolve(process.argv[2] || '/tmp/bugpatrol-fixture');
const shape = process.argv[3] || 'monorepo';
if (!['client', 'api', 'monorepo'].includes(shape)) {
  console.error('The shape is client, api, or monorepo.');
  process.exit(2);
}
mkdirSync(root, { recursive: true });
writeProjectFixture(root, shape);

// The fixture's recordings are stand-in bytes. With ffmpeg, make them real so they play.
const claim = join(root, '.bugpatrol/runs/reviews/pr-42/claim-1');
if (!existsSync(claim)) {
  console.log(`Fixture written to ${root}. Run bugpatrol dashboard there.`);
  process.exit(0);
}
const clip = (source, file) => {
  // Browsers play H.264 only in 4:2:0.
  const pixels = file.endsWith('.mp4') ? ['-pix_fmt', 'yuv420p'] : [];
  execFileSync('ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    source,
    '-t',
    '3',
    ...pixels,
    join(claim, file),
  ]);
};
try {
  clip('testsrc=size=640x400:rate=10', 'head.mp4');
  clip('smptebars=size=640x400:rate=10', 'base.mp4');
  clip('testsrc=size=320x200:rate=8', 'head.gif');
} catch {
  console.log('No ffmpeg: the fixture videos will not play.');
}
console.log(`Fixture written to ${root}. Run bugpatrol dashboard there.`);
