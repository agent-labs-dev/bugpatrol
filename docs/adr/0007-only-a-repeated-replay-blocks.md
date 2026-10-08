# ADR 0007 — Only a repeated replay can block a pull request

**Status:** Accepted
**Date:** 2026-10-08
**Amends:** ADR 0005 §6 (the gate does not change)

## Context

The claim check of `bugpatrol review` gives each claim of a pull request a
verdict: `proven`, `not-proven`, `partly-proven` or `untested`. Teams asked for
a way to stop a merge when a claim is false. ADR 0001 says only a deterministic
check may fail a GitHub check, and ADR 0005 §6 says the agents never fail a
build. Most verdicts come from the judge, a model, so the verdict alone cannot
be the gate.

What a verdict rests on varies. Bugpatrol records it on each verdict as the
evidence source, and sets it from how it tested the claim. A model never sets it.

| Evidence | Who decides | Deterministic |
| --- | --- | --- |
| `replay` | Code, from a replay with no model: the bug check of an issue repro | Yes |
| `assertion` | Code: an exact check (an HTTP status, an exit code, an output) or the diff of normalised outputs | Yes |
| `explored` | The judge, from the screens of a replay on both builds, or from the explorer's account when no replay could repeat the flow | No |
| `bench` | The judge, from the numbers of repeated benchmark runs | No: runner noise |

A replay alone does not make a verdict deterministic. When the judge reads the
last screens of two replays, the screens are repeatable and the reading is not.
So a judged flow is `explored`, like a claim the explorer checked by hand.

## Decision

Blocking is off by default. `agents.review.block: true` turns it on.

With `block` on, `review` sets one check run, `Bugpatrol claim check`, on the
pull request commit. It is neutral unless a deterministic disproof exists. A
deterministic disproof is a `not-proven` verdict with evidence `replay` or
`assertion` that a second replay repeated. A verdict from the judge never
fails the check, however strong it looks.

Bugpatrol replays each such disproof a second time on the pull request build.
An issue repro and a same-behavior diff rest on both builds, so they also
replay a second time on the base build. An exact check holds on the pull
request build alone, so it repeats there only.

The two replays agree when code gives the same results on both: they stop at
the same step, the bug check gives the same answer, the exact checks give the
same results, and the normalised outputs are equal. Bugpatrol does not compare
screenshots, since no blocking verdict reads them. If any result differs, the
verdict becomes `untested` with the reason "Flaky replay", and it cannot fail
the check. A second replay that the time limit of the claim check cuts off
leaves the disproof as a comment.

The failed check names each claim, what Bugpatrol saw, and the evidence: the
issue repro, the exact check, or the outputs that differ. `review` then exits
1, the regression code, and the Action passes that through. With `block` off,
`review` sets no check and exits 0 when it only comments. An app that does not
start stays exit 4 and sets no check.

## Consequences

**Good.** A red claim check means code decided the disproof twice, with no
model, on each build the verdict rests on. A judge's verdict stays a comment,
also when the judge looked at a replay.

**Costly.** Only issue repros, exact checks and same-behavior diffs can block.
A web claim with no repro can never block, however clear its screens are. Each
disproof starts the pull request build a third time, and a repro or a diff
starts the base build a second time too.

**Costly.** The token needs `checks: write`. Without it the check run is not
set and Bugpatrol logs why, and the exit code still fails the job.
