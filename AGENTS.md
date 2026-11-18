# bugpatrol

Bugpatrol finds regressions in an app's UI and API: a deterministic gate (tier 1) that can block a merge, plus agents and a dashboard that raise issues and questions. TypeScript pnpm monorepo (`packages/*`, `site/`, `examples/*`), Biome, knip, vitest. Setup, packages and releases are in [docs/development.md](docs/development.md); the product rules are in [CONTRIBUTING.md](CONTRIBUTING.md).

## Gate

```sh
pnpm gate           # biome check, knip, tsc --build
pnpm gate:changed   # biome on changed files, tsc --build, vitest for changed files
```

CI also runs `pnpm test` (needs Playwright, ffmpeg and Xvfb), the package and site builds and the determinism workflow, so leave the full suite to CI. The pre-commit hook runs lint-staged and knip.

## Invariants

- Only tier 1 (deterministic, zero marginal cost) may fail a Check; everything else routes to an issue, question or suggestion (ADR 0001, 0002, 0007).
- Never over-silence: suppression and auto-fix need high confidence, raising a question has no floor. The tests in `packages/decide/src/thresholds.test.ts` are load-bearing.
- Every finding names a consequence. Infrastructure failure (exit 4) is never a regression and never blocks.
- Nothing is hidden silently: suppressed counts, masks and incomplete runs appear in the report. No global tolerance knob.
- A new detector implements `InvariantRule` in `packages/invariants/src/rules/`, is registered in `registry.ts`, is listed in `docs/detection-rubric.md` and has a true-positive, a near-miss and (if change-aware) a no-baseline test.
- Internal `@bugpatrol/*` packages are private; the `bugpatrol` package bundles them. Releases run only from the Release workflow.

## Standards

- `repo-standards`: the RS-* requirements every cjber and agent-labs-dev repo meets; its `audit.py` checks this repo.
