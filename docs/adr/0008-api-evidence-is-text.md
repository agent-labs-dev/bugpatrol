# ADR 0008 — API evidence is text

**Status:** Accepted
**Date:** 2026-10-29
**Amends:** ADR 0005 §2 (an observation of an API has no screenshot)

## Context

ADR 0005 says that `observe()` returns a screenshot. The first api driver
followed that rule. It started Chromium and drew each HTTP response as a page,
and the models read a picture of JSON.

A picture of JSON loses data. A model cannot copy an exact value from it, and a
long body does not fit on the screen. The DOM rules, the contrast rule, and the
pixel diff then ran on a page that Bugpatrol drew itself. Their findings were
about Bugpatrol, not about the app. Chromium also made each API patrol slow.

## Decision

1. Evidence is a union of two kinds: `image` and `http`. The type
   `Evidence` in `packages/core/src/types/evidence.ts` is the one owner.
   An `image` holds the files of a screenshot, a baseline, and a diff. An
   `http` holds one `HttpExchange`: the request, the response or the error,
   the latency, and the time.
2. `Observation.capture` holds a PNG or an exchange. Each reader of evidence
   handles both kinds, and the type checker finds each reader.
3. `formatHttpExchange()` in `packages/core/src/http.ts` is the one renderer of
   an exchange. The models, the GitHub issues, the review comments, and the
   dashboard show the same text. Issues and comments put it in a markdown
   `http` block. A body over the model cap is cut, and a marker line says so.
4. `ApiDriver` implements `Driver` directly, like `CliDriver`. It starts no
   browser, and it has no viewport.
5. `ApiDriver.toExchange()` is the one place that redacts an exchange. It keeps
   only allowlisted response headers. It shows only the request headers that
   the step set, and it hides each header or JSON key that names a credential.
   The configured headers carry the app's credentials, so they never show.
6. A response body over 1 MiB is evidence with `tooLarge`, not an error. A
   failed request clears the last exchange, so old evidence never stands for a
   new request.
7. `Driver.lastRaw()` gives the response before redaction, for checks in the
   process only. It never goes into a tool result, a log, or a file.
8. A session saves an exchange as `NNN-<label>.exchange.json`, not as a PNG.
9. The DOM rules, the contrast rule, and the pixel diff do not run on an `api`
   observation. The contract is the check of an API.

## Consequences

- The models get exact text, and the judge reads the same bytes as the server
  sent, after redaction.
- An API patrol needs no Chromium.
- Old run data with `evidence.screenshot` is not migrated. The dashboard and
  the agents read only the new shape.
- Each new reader of evidence must handle both kinds. A reader that expects a
  PNG for an API is a type error.
