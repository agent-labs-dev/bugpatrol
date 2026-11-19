# Contributing

## Setup

```bash
pnpm install
pnpm build
pnpm test
pnpm check   # Biome: lint and format. `pnpm check:fix` applies the fixes.
pnpm knip    # Dead code: unused files, exports, and dependencies.
```

CI runs `pnpm check --error-on-warnings` and `pnpm knip`. The pre-commit hook runs Biome on the staged files and then knip.

Node 22+ and pnpm 12. pnpm switches to the version in `packageManager` by itself.

## The rules that matter most

These are not style preferences. They are the properties the product depends on, and a change that breaks one is a bug regardless of what else it does.

1. **Only tier 1 may block a merge.** If you add a detector that can fail a Check, it must be deterministic and have zero marginal cost. Everything else routes to an issue, a question, or a suggestion.

2. **Never over-silence.** Auto-suppression and auto-fix require high confidence. Raising a question has no confidence floor. Bugpatrol may be wrong about raising something; it may never be wrong about hiding something. See `packages/decide/src/thresholds.ts` — the tests there encode this and should be treated as load-bearing.

3. **Every finding names a consequence.** "4.3% of pixels changed" is not a finding. "The Save button is unreachable" is. If your detector cannot produce that sentence, it reports at lower confidence and asks.

4. **Infrastructure failure is not product failure.** Exit 4 means "Bugpatrol could not test". It must never be reported as a regression and must never block on its own.

5. **Nothing is hidden silently.** Suppressed counts, masked percentages, quarantined findings and incomplete runs are all surfaced in the report. A green result that is green because the test got weaker must say so.

6. **No global tolerance knob.** Per-region only. This is deliberate; see ADR 0002.

## Adding a detector

1. Implement `InvariantRule` in `packages/invariants/src/rules/`.
2. Register it in `registry.ts`.
3. Add it to `docs/detection-rubric.md` with what it catches.
4. Write tests covering the true positive, a near-miss that must **not** fire, and — for a change-aware rule — the no-baseline case.

Set `changeAware: true` if the rule only makes sense against a baseline. The registry skips those when no baseline exists, which is what prevents first-run avalanches.

## Tests

Tests live next to the code as `*.test.ts`. Prefer tests that encode a design property over tests that restate the implementation — the ones in `thresholds.test.ts` and `registry.test.ts` are the model.

## Commits

Conventional commits. Keep the diff minimal; a sprawling diff cannot be reviewed, which is the same standard Bugpatrol holds its own fix PRs to.
