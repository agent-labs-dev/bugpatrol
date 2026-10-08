# ADR 0006 — Commit the routines and the app map

**Status:** Accepted
**Date:** 2026-10-08
**Amends:** ADR 0005 §8 (state on disk)

## Context

Routines and the app map lived in `.bugpatrol/runs/`, which git ignores. Two
things broke because of that.

A fresh CI runner starts with no routine, so it cannot replay anything with no
model. Every CI run has to explore from scratch.

A pull request that says `closes #123` cannot be checked against the bug. The
routine that reproduces issue #123 sits in the run directory of the machine
that filed it, and nowhere else.

A routine is small JSON: a list of steps with `{{NAME}}` placeholders, never
resolved secrets, and no pixels. The app map is the same kind of file. ADR 0004
already commits the small files and ignores the pixels.

## Decision

Routines and the app map move next to the config and are committed:

```
.bugpatrol/appmap.json        # committed: the screens the explorer found
.bugpatrol/routines/*.json    # committed: replayable flows, including issue repros
.bugpatrol/runs/              # gitignored: sessions, screenshots, issues, fixes,
                              # worktrees, triage, agent baselines, memory
```

When the judge files a new issue, Bugpatrol saves the issue's flow as a routine
named `repro-<hash>`. It requires the routine the explorer started from and
holds the steps after it. The issue records the routine id, and the GitHub issue
body carries it as a hidden marker, `<!-- bugpatrol:routine repro-<hash> -->`.
With a clone and an issue number, Bugpatrol reads the body, finds the marker,
and loads the committed routine. It does not need the run directory.

Bugpatrol writes these files to the working tree and never commits them. The
user commits them, or leaves them out on purpose.

Bugpatrol reads routines from the checkout it runs in, never from a build
worktree. A review or retest worktree keeps its own commit's copy: the overlay
that copies the checkout's `.bugpatrol/` scripts into a worktree skips routines
and the app map. So during `bugpatrol review`, the checkout's routines win, and
the pull request's copy is only data in its diff.

A project with routines in the old place gets them moved once, on the next
command, with a message that says to commit them. A routine already in the new
folder wins over an old copy with the same id.

## Consequences

**Good.** CI and a fresh clone can replay routines and issue repros with no
model. A routine change shows up in a pull request diff, where someone can
review it.

**Good.** The patrol's pull of the latest commit ignores uncommitted changes to
these files, so a patrol that keeps writing them still pulls.

**Costly.** The app map and routines change on most runs: visit counts, last
seen times, the last replay result. Those show up as uncommitted changes until
someone commits them, and two machines that commit them will conflict. If the
noise is too much, the next step is to split the volatile fields into the run
directory.
