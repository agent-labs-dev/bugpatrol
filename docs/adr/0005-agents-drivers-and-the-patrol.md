# ADR 0005 — Agents, drivers, and the patrol

**Status:** Accepted
**Date:** 2026-09-24
**Amends:** ADR 0001 (the agent no longer navigates only once)

## Context

Bugpatrol must test any app: a website, an Electron or native desktop app, and a
React Native or native mobile app. It must also work with any auth system.
A fixed crawler with fixed login strategies cannot do this. The goal is a QA
team that uses the app all the time, judges what it sees, reports issues, and
proposes fixes.

ADR 0001 is still correct about the merge gate. A model must never decide if a
build passes. But ADR 0001 also said that the agent navigates only once, during
Recon. That rule is too strict for a tool that must use the app continuously.

## Decision

### 1. Four roles, one contract each

| Role | Job | Default runtime |
|---|---|---|
| **Explorer** | Operates the app. Finds screens, records them, learns routines, reports what looks wrong. | model loop |
| **Decider** (Jev) | Answers fast typed questions: is this anomalous, what route, what severity. | Jev (ADR 0003) |
| **Judge** | Reviews the candidates that the decider cannot settle. Writes issues. | model loop |
| **Fixer** | Writes a code change for an issue in a git worktree. | CLI agent |

Each role (except the decider) has a **runtime**:

- `model`: Bugpatrol runs its own tool-use loop. The provider is `openrouter`,
  `vercel`, `openai`, `anthropic`, or `custom`, and the model name is free text.
- `cli`: Bugpatrol starts a user-supplied command, for example `claude -p` or
  `codex exec`. Bugpatrol gives the command the prompt and an MCP endpoint that
  exposes the same tools that the model loop uses.

The tool set is the contract, not the runtime. A role has one tool registry,
and both runtimes use it. So a user can change the runtime of a role without
any other change.

### 2. Drivers: one interface for every platform

A `Driver` gives the explorer two operations: `observe()` and `act()`.
`observe()` returns a screenshot, a normalised element list with bounds, and
a location (URL, route, window, or app id). `act()` does one action, for
example a tap on an element, text input, a key, a scroll, back, or a URL or
deep link.

| Platform | Driver | Transport |
|---|---|---|
| `web` | Playwright page | Playwright |
| `electron` | Playwright over CDP | `connect.cdp` |
| `ios`, `android` | Maestro | `maestro mcp` over stdio |

The driver also converts an observation to a `ScreenSnapshot`. So the
geometry invariants (tap target, off-viewport, overlap), the pixel diff, and
the decider work on every platform. The DOM-only rules run only when a DOM is
present.

### 3. The app lifecycle belongs to the user

Bugpatrol does not guess how to start a native app or how to log in. The config
has `app.setup` commands, `app.connect`, and `app.teardown`. A setup command
can capture values from its output, for example a CDP port or a login deep
link. `app.instructions` is a Markdown file in plain English. It tells the
explorer how to log in, how to finish onboarding, what the product is, and
what it must never do.

Secrets never go to a model. The instructions and the tools use
`{{NAME}}` placeholders. Bugpatrol puts in the real value at the moment the
driver types or opens it. The event log redacts every captured and secret
value.

### 4. The agent writes the scripts, Bugpatrol replays them

The explorer records each action with a stable locator (test id, role and
name, or text) and a fallback point. When the explorer finds a screen, the
action trail becomes a **routine**: a replayable path to that screen. The
explorer can also save a named routine, for example `login` or
`finish-onboarding`.

Later sessions replay routines with no model. A replay that fails does not
become a finding. It goes back to the explorer, which repairs the routine.
Nothing in Bugpatrol hardcodes an app-specific script.

### 5. The patrol

`bugpatrol` (the same as `bugpatrol patrol`) repeats one cycle until it is stopped:

1. Run `app.setup` and connect the driver.
2. Replay known routines and capture known screens (no model).
3. Explore with a step and cost budget, to find new screens and bugs.
4. Evaluate each capture: invariants, pixel diff, then the decider.
5. The judge reviews the candidates that the decider sent to it.
6. The fixer proposes a change for each accepted issue, if it is enabled.
7. Run `app.teardown`.

`bugpatrol explore`, `bugpatrol judge`, and `bugpatrol fix` run one step alone.

### 6. The gate does not change

`bugpatrol run` stays deterministic. Only a tier-1 regression fails it (ADR 0001,
spec "Routing"). The patrol never fails a build. It produces issues and fix
proposals.

### 7. Surfaces

Issues and fixes go to the dashboard by default. Set `agents.github.enabled`
to publish to GitHub. After the fix cycle, the judge opens a PR for a completed
fix and an issue for a major or critical bug with no fix. Each report has the
full evidence and screenshots. Images live on an orphan `bugpatrol-assets` branch,
outside the PR diff. `bugpatrol publish --dry-run` writes reports locally without
posting them. A human dismissal prevents later publishing. Bugpatrol syncs GitHub
state each patrol cycle. A PR closed without a merge rejects its fix; Bugpatrol
keeps the issue open and does not propose that change again. A GitHub issue
closed as not planned is dismissed; one closed as completed is fixed. Reopening
the issue returns it to filed.

### 8. State on disk

All agent state is files under `.bugpatrol/`, so the dashboard can read it and a
human can audit it. The routines and the app map are committed (ADR 0006).
Everything else is in the gitignored `runs/` folder:

| Path | Content |
|---|---|
| `appmap.json` | Committed. Screens that the explorer found, with the routine to each one |
| `routines/*.json` | Committed. Replayable action lists, and the repro routine of each issue |
| `runs/issues/*.json` | Judged issues, with evidence and status |
| `runs/fixes/*.json` | Fix proposals: branch, diff, verification |
| `runs/sessions/<id>/events.jsonl` | Each agent step: tool call, result, cost |
| `runs/sessions/<id>/*.png` | Screenshots for each step |
| `runs/triage.json` | The judge's decisions, by fingerprint |
| `runs/agent-baselines/` | The baseline screenshot and snapshot of each screen |
| `runs/agents.json` | The current status of each role |

### 9. Noise control

The live runs on two real apps (an Electron app and an Expo app) showed that the judge spends most of
its effort on noise unless Bugpatrol removes it first. These rules apply
before a candidate reaches the judge:

- The absolute checks run on the first capture of a screen, so a problem
  that is present from the start shows once, and not later as a "change".
- One rule on one screen makes one candidate, with the elements listed in
  it. Eleven labels with low contrast are one decision.
- `triage.json` records each fingerprint that the judge filed or dismissed.
  A dismissed fingerprint is not raised again. A filed fingerprint adds an
  occurrence to its issue. Pixel diffs are not recorded, because an
  accepted visual change moves the baseline.
- Explorer reports use the same triage record. A dismissed report stays quiet.
  A filed report adds an occurrence. The judge sees recent closed issues.
  It keeps dismissals closed and reopens a fixed issue if the bug returns.
- Bugpatrol closes an automatic-check issue after three clean visits to its
  screen. It rechecks merged fixes on the main build and closes an issue only
  when the recheck finds that the problem is gone.
- The judge first looks for one shared cause. When many screens fail in the
  same way, it files one issue that lists the screens.
- The fixer takes at most `agents.fixer.maxPerCycle` issues in each cycle,
  worst first.
- Each status record has the writer's process ID. The dashboard shows work
  from a process that is not alive as stopped.

### 10. Retest

After the fixer commits a change, Bugpatrol stops the patrol app. It starts the app from the fix worktree. A setup command runs in the worktree when its resolved directory matches `app.source`. Every command receives `BUGPATROL_SOURCE` with the effective source directory.

The explorer repeats the issue flow and captures an after screenshot. The judge compares it with the issue screenshot and gives a verdict. If the issue remains, the fixer gets the verdict and tries again, up to `agents.fixer.retest.attempts` total attempts. The fixer only changes code. The explorer uses the app, and the judge decides the result.

### 11. Memory

`.bugpatrol/memory.json` stores short lessons for the explorer, judge, and fixer. A reflection after an explorer run learns from failed or repeated actions; human dismissals, judge dismissals, declined fixes, commit hooks, and verification failures also add lessons. Each role reads its active lessons before working. Bugpatrol retires the oldest lessons when a role has more than 40 active ones. A human can list, add, retire, or remove lessons with `bugpatrol memory`.

## Consequences

**Good.** One codebase tests web, desktop, and mobile apps. A new platform
needs only a new driver. A user can change any role to a better model or to a
local CLI agent without code changes. The merge gate keeps its guarantees.

**Costly.** A patrol costs money all the time. Each role has a budget per
session, and the dashboard shows the spend. Native captures are less
deterministic than a pinned browser, so native pixel diffs go to the decider
and the judge and never to a gate.

**Rejected alternative:** hardcoded strategies for each auth system and each
platform. This works only for the apps that the authors know, and the goal is
any app.
