# Development

This page is for work on Bugpatrol itself. To use Bugpatrol in your app, run `npx bugpatrol`. Refer to [Getting started](getting-started.md).

## Build and test

Node 22+ and pnpm 9+.

```bash
pnpm install
pnpm build
pnpm test
pnpm check   # Biome: lint and format. `pnpm check:fix` applies the fixes.
pnpm knip    # Dead code: unused files, exports, and dependencies.
```

CI runs `pnpm check --error-on-warnings` and `pnpm knip`. The pre-commit hook runs Biome on the staged files and then knip.

To run the CLI from your checkout:

```bash
node packages/cli/dist/bin.js --help
```

To build the npm package (one bundle in `packages/bugpatrol/dist/`):

```bash
pnpm --filter bugpatrol build
node packages/bugpatrol/dist/bin.js --version
```

To look at the dashboard with sample data:

```bash
node packages/dashboard/scripts/fixture.mjs /tmp/bugpatrol-fixture
cd /tmp/bugpatrol-fixture && node "$OLDPWD/packages/cli/dist/bin.js" dashboard
```

Refer to [CONTRIBUTING.md](../CONTRIBUTING.md) for the rules that the product depends on.

## Releases

A maintainer runs the **Release** workflow in GitHub Actions and selects `patch`, `minor`, or `major`. The workflow tests the repo, bumps `packages/bugpatrol/package.json`, publishes `bugpatrol` to npm with provenance, and pushes a tag and a GitHub release. The internal `@bugpatrol/*` packages are private. The bundle includes them.

## Examples

| Folder | What it shows |
| --- | --- |
| `examples/fixture-app` | A small web app for the deterministic gate, with defects you can switch on (`BREAK=...`) |
| `examples/review-smoke` | The config that the `Review smoke` workflow uses to run the Bugpatrol Action on each pull request against `examples/fixture-app`. It needs the `OPENROUTER_API_KEY` secret |
| `examples/electron-app` | An Electron app: a test user from the app's E2E harness, CDP, onboarding, the fixer, and GitHub |
| `examples/expo-app` | An Expo app on the iOS simulator: Metro, a deep-link sign-in, and Maestro |

## Packages

| Package | What it does |
| --- | --- |
| `bugpatrol` | The npm package: one bundle of the CLI and the dashboard UI |
| `@bugpatrol/cli` | The `bugpatrol` command |
| `@bugpatrol/core` | The data types, the config schema, file paths, fingerprints, and exit codes |
| `@bugpatrol/agents` | The explorer, judge, and fixer; the retest, publish, and memory steps; model and CLI runtimes; routines; the patrol; workspace files |
| `@bugpatrol/drivers` | One driver interface for web (Playwright), Electron (CDP), and iOS and Android (Maestro) |
| `@bugpatrol/decide` | The decider for the web gate: a general model, a local model, or the offline heuristic |
| `@bugpatrol/invariants` | The layout checks: contrast, overlap, clipped text, tap size, and more |
| `@bugpatrol/diff` | Pixel and perceptual comparison, masks, and tolerance rules |
| `@bugpatrol/capture` | The Playwright capture for the deterministic gate, with the determinism contract |
| `@bugpatrol/dashboard` | The local dashboard: its server and its UI |
| `@bugpatrol/triage` | Clustering and noise control for the gate's findings |
| `@bugpatrol/report` | Report formats for the gate: HTML, PR comment, JUnit, and SARIF |
| `@bugpatrol/recon` | App bring-up, crawl safety, and the change map for the gate (in progress) |
| `@bugpatrol/github-app` | A GitHub App for checks, issues, and slash commands (in progress) |

## Design documents

- [ADR 0005: agents, drivers, and the patrol](adr/0005-agents-drivers-and-the-patrol.md): the agent design
- [Architecture decisions](adr/): all ADRs
- [Technical specification](spec/bugpatrol-technical-spec.md): the deterministic gate
- [Competitive landscape](research/oss-visual-testing-landscape-2026.md): the research behind the design

## The landing page

`site/` is the landing page: a Next.js app with Tailwind, built as a static export. Its copy follows this README, so change both together. `pnpm --filter @bugpatrol/site dev` serves it at http://localhost:3000, and `build` writes `site/out/`. Both first copy the logo, the dashboard screenshot, and the social preview from `assets/` into `site/public/assets/`, so the README and the site share one copy of each image.

The `Pages` workflow builds it with `SITE_BASE_PATH=/bugpatrol` and publishes it to GitHub Pages on each push to `main` that changes `site/` or `assets/`.
