# The detection rubric

The brief names the hardest requirement precisely: find things that are "not logical", "not intuitive", "don't make sense", and typos. Those are not detector names - they are outcomes. This document converts each into something a program can evaluate.

## The governing rule

**A finding must be explainable to an engineer in one sentence, and that sentence must name a consequence.**

- "4.3% of pixels changed" - fails.
- "The Save button is behind the sticky footer and is unreachable at its centre point" - passes.

Where a detector cannot produce such a sentence, it reports at lower confidence and routes to a question rather than an issue.

The success metric is not findings per run. It is **the proportion of findings a human accepts as real**, tracked per detector, so a noisy detector can be tuned or retired.

## 1. Layout and rendering invariants - tier 1, deterministic

The highest-value detectors in the product: deterministic, free, and they catch the "this looks broken" class that pixel diffing alone cannot explain.

| Detector | Rule id | Signal | Catches |
| -------- | ------- | ------ | ------- |
| Occlusion | `layout/occlusion` | Interactive element covered at its centre (`elementFromPoint`) | "The button does nothing" bugs |
| Overlap | `layout/overlap` | Interactive/text boxes intersecting unexpectedly | Broken nav bars, colliding tooltips |
| Overflow / clipping | `layout/overflow` | `scrollWidth > clientWidth` under `overflow: hidden` | Truncated labels, text out of a card |
| Off-viewport | `layout/off-viewport` | Was visible in the baseline, now outside the viewport | Layout-shift regressions |
| Zero-size interactive | `layout/zero-size-interactive` | Clickable element with a ~zero box | Invisible buttons, unclickable links |
| Unexpected horizontal scroll | `layout/horizontal-scroll` | Page scrolls sideways where the baseline did not | Fixed-width breakage, usually mobile |
| Layout shift vs baseline | `layout/shift-versus-baseline` | Element moved beyond a threshold with no content change | Grid and alignment regressions |
| Contrast | `usability/contrast` | Computed contrast below WCAG AA | Unreadable text, grey-on-grey |
| Tap-target size | `usability/tap-target` | Interactive target below 24×24 CSS px | Mobile usability defects |
| Broken imagery | `rendering/broken-imagery` | Failed load, zero natural size | Missing assets, placeholder leaks |
| Unstyled content | `rendering/unstyled-content` | No stylesheet applied | A stylesheet failed to load |
| Console errors | `runtime/console-errors` | **New** errors versus baseline | JS failures leaving the UI half-working |

Implemented in `packages/invariants/`. Geometry comes from an in-page probe (`probe.ts`) running against real computed layout, not inferred from the DOM.

## 2. Accessibility - tier 1

axe-core violations, reported as **new violations versus baseline** rather than an absolute count. An app with 400 existing violations must not produce 400 findings on its first run.

Plus targeted checks: missing `alt`, missing form labels, missing page `title`, focus traps, unannounced dynamic content.

*Status: planned for M3.*

## 3. Content and copy - tier 1-2

This is where "find typos" becomes concrete. It decomposes into five distinct detectors:

| Detector | Method |
| -------- | ------ |
| Spelling | `cspell`/`hunspell` over user-visible strings, with a project dictionary seeded from the AppModel's domain vocabulary |
| False-positive filtering | Every hit goes to the decider as a `Noul`: is this a misspelling, or a brand/identifier/coinage? |
| Untranslated strings | Raw i18n keys rendered into the UI (`common.submit`) - distinctive, high-confidence |
| Placeholder leakage | Lorem ipsum, `TODO`, `FIXME`, `test123`, `foo`, `asdf` |
| Terminology inconsistency | Same concept named differently across screens ("Project" vs "Workspace") |
| Tone and clarity drift | Mixed imperative/second person, inconsistent capitalisation of the same control |

The dictionary-plus-decider combination is what makes this usable. A raw spellchecker on a web app produces hundreds of false positives from product names; a model asked to spellcheck a whole page is slow and imprecise. **Candidates from the dictionary, filtered by a cheap typed decision** is the combination that works.

*Status: planned for M4. The `IS_MISSPELLING` question is defined in `packages/decide/src/questions.ts`.*

## 4. State, feedback and error handling - tier 1-2

| Detector | Signal |
| -------- | ------ |
| Silent action | A click producing no navigation, no DOM change, no network call, no visible feedback |
| Unhandled error state | A 4xx/5xx from the app's own API with no user-facing error |
| Loading state absent | A slow request with no spinner or skeleton |
| Empty state absent | A zero-item collection rendering as blank space |
| Stuck error state | An error that persists after the condition is resolved |
| Validation gap | A form accepting obviously invalid input without complaint |
| Undismissable dialog | A modal with no close affordance except browser back |

## 5. Navigation and flow logic - tier 2-3

Closest to "not logical", and deliberately the tier that **never blocks a merge**, because it is the least objective.

| Detector | Signal |
| -------- | ------ |
| Dead end | A screen with no forward action and no way back except history |
| Unreachable screen | A route in the route table never reachable by navigation |
| Orphaned route | A screen reachable in the UI but absent from the route table |
| Loop | A navigation cycle returning to the same screen with no progress |
| Lost state on back | Filling a form, navigating away and back, losing the input |
| Unconfirmed destructive action | Delete/remove/revoke with no confirmation step |
| Feedback-free success | A submit that succeeds with nothing the user can perceive |
| Broken internal link | A link resolving to a 404 or a route absent from the table |
| Flow regression | A recorded flow can no longer complete - **the highest-severity functional signal Bugpatrol produces** |

## 6. Visual semantics - tier 3, sampled

The residue invariants cannot express, and the only place a vision model is genuinely required: "is this screen coherent?", "does this empty state look half-finished?", "does this error message match the failure that occurred?".

Sampled, never on every screen, never blocking.

## 7. Change-aware detectors - tier 1-2

Derived from the diff rather than the absolute state, which is what makes them low-noise.

| Detector | Signal |
| -------- | ------ |
| Copy changed | Text on a control changed - often intentional, so it **asks** rather than accuses |
| Control removed | A previously present interactive element is gone |
| Screen added/removed | A route appeared or disappeared versus the AppModel |
| Affordance changed | A button became a link; a primary action became secondary |
| Position changed | An element moved beyond a threshold with no content change |
