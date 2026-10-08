# ADR 0007 — Only a repeated replay can block a pull request

**Status:** Accepted
**Date:** 2026-10-08
**Amends:** ADR 0005 §6 (the gate does not change)

## Context

The claim check of `bugpatrol review` gives each claim of a pull request a
verdict: `proven`, `not-proven`, `partly-proven` or `untested`. Teams asked for
a way to stop a merge when a claim is false. ADR 0001 says only a deterministic
check may fail a GitHub check, and ADR 0005 §6 says the agents never fail a
build. A model picks every claim verdict, so the verdict alone cannot be the
gate.

What a verdict rests on varies. Bugpatrol records it on each verdict as the
evidence source, and sets it from how it tested the claim. A model never sets it.

| Evidence | What Bugpatrol did | Deterministic |
| --- | --- | --- |
| `replay` | Replayed the claim routine on both builds, with no model | Yes |
| `assertion` | Checked an exact result: an HTTP status, an exit code, an output | Yes |
| `explored` | The explorer checked the claim, and the judge decided from its account | No |
| `bench` | Read a metric from repeated benchmark runs | No: runner noise |

## Decision

Blocking is off by default. `agents.review.block: true` turns it on.

With `block` on, `review` sets one check run, `Bugpatrol claim check`, on the
pull request commit. It is neutral unless a deterministic disproof exists. A
deterministic disproof is a `not-proven` verdict with evidence `replay` or
`assertion` that a second replay repeated.

Bugpatrol replays each such disproof a second time on the pull request build.
The two replays agree when both stop at the same step and the last screenshots
are the same bytes. If they differ, the verdict becomes `untested` with the
reason "Flaky replay", and it cannot fail the check.

The failed check names each claim, what Bugpatrol saw, and the claim routine.
`review` then exits 1, the regression code, and the Action passes that through.
With `block` off, `review` sets no check and exits 0 when it only comments. An
app that does not start stays exit 4 and sets no check.

The judge still reads the screens and gives the verdict. Blocking does not
remove the model. It requires that the model looked at a screen that a replay
with no model gives twice.

## Consequences

**Good.** A red claim check means the same steps, replayed twice with no model,
ended on the same screen, and the judge read that screen as a disproof. An
`explored` or `bench` verdict stays a comment however strong it looks.

**Costly.** Each disproof starts the pull request build a third time. The
byte-equal screenshot rule is strict: a clock, an animation or a random value on
the last screen turns a real disproof into "Flaky replay". That errs toward
not blocking, which is the safe side. If it blocks too rarely, the next step is
to mask volatile regions the way the gate does.

**Costly.** The token needs `checks: write`. Without it the check run is not
set and Bugpatrol logs why, and the exit code still fails the job.
