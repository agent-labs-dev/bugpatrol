// Run: pnpm build && node packages/dashboard/scripts/fixture.mjs /tmp/bugpatrol-fixture
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { writeAgentFixture } from '../dist/fixtures/agent-workspace.js';

const root = resolve(process.argv[2] || '/tmp/bugpatrol-fixture');
mkdirSync(root, { recursive: true });
writeAgentFixture(root);

// The fixture's recordings are stand-in bytes. With ffmpeg, make them real so they play.
const claim = join(root, '.bugpatrol/runs/reviews/pr-42/claim-1');
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
