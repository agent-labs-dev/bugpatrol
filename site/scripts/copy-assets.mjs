// The README and the site share one copy of each image: the originals stay in
// the repo's assets/ folder, and this copies them into public/ before a build.
import { copyFileSync, mkdirSync } from 'node:fs';

const files = ['logo.svg', 'dashboard.png', 'social-preview.png'];
mkdirSync(new URL('../public/assets/', import.meta.url), { recursive: true });
for (const file of files) {
  copyFileSync(new URL(`../../assets/${file}`, import.meta.url), new URL(`../public/assets/${file}`, import.meta.url));
}
