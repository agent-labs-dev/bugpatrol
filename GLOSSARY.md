# Bugpatrol

A QA team of AI agents that explores an app, files the bugs it finds, fixes them, and retests the fixes.

## Language

### Fixing

**Fix record**:
Everything Bugpatrol knows about fixing one issue: the current proposal, every fix attempt, every retest, and the PR.
_Avoid_: Fix proposal (that is the current change only), fix file

**Fix attempt**:
One fixer session on one issue, of any kind: a first fix, a rerun after a failure, a refix after a not-fixed retest, or a fix for a failed CI check. Each one ends with an outcome.
_Avoid_: Try, run, rerun (as a noun for the session)

**Retest**:
One check of a fix attempt's change in the running app, with a verdict from the QA lead. A retest judges a fix attempt; it is not one.
_Avoid_: Fix attempt, verification

**Verify**:
The repo's own command (type check, tests) that a fix attempt's change must pass before it becomes a proposal.
_Avoid_: Checks, retest
