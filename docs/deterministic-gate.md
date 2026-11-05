# The deterministic gate (web)

For web apps, `bugpatrol run` is a merge gate that uses no agent. The agents explore freely. The gate replays frozen artifacts and compares them with pinned baselines, so it gives the same result on the same commit. Only this gate can fail a CI check. The agents never block a merge ([ADR 0001](adr/0001-split-the-brain-from-the-gate.md)).

## Try it

```bash
PLAYWRIGHT_SKIP_BROWSER_GC=1 npx -y -p bugpatrol@latest playwright install chromium
npx bugpatrol init --gate           # write a starter .bugpatrol/bugpatrol.yml; correct each TODO value
npx bugpatrol run --no-models       # capture the baselines
npx bugpatrol run --no-models       # compare: clean
```

`--no-models` makes a full run with no network traffic.

To see the gate find a defect, use the fixture app in this repo:

```bash
git clone https://github.com/agent-labs-dev/bugpatrol && cd bugpatrol/examples/fixture-app
npx bugpatrol run --no-models       # capture the baselines
npx bugpatrol run --no-models       # compare: clean
BREAK=color node server.js &         # add one known defect
npx bugpatrol run --no-models       # exit 1, with a diff image
```

## Exit codes

| Exit code | Meaning |
| --- | --- |
| 0 | Clean, or findings that do not block |
| 1 | A tier-1 regression: **the only code that blocks a merge** |
| 2 | A configuration or usage error |
| 3 | Recon is required, or the app model is not approved |
| 4 | The test is not complete: an infrastructure error, missing evidence, no tested screen, or no decision budget left |

## Tiers

The gate has three tiers. Only tier 1 can fail a check:

| Tier | What it is | Model | Blocks a merge |
| --- | --- | --- | --- |
| T1 Deterministic | Pixel diff, layout invariants, accessibility, console, network | None | Yes |
| T2 Decided | Is it an anomaly, a bug or intended, worth an issue? | Decider | No |
| T3 Judged | Visual meaning and flow reasoning | Judge | No |

To check the determinism guarantee (three runs, one commit, zero diffs), run `bash scripts/determinism-check.sh` in a clone of this repo.

## More

- [Technical specification](spec/bugpatrol-technical-spec.md): the gate in full
- [The determinism contract](determinism-contract.md): what the gate guarantees, and how
- [The detection rubric](detection-rubric.md): each automatic check and what it finds
