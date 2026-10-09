# The determinism contract

The research is unambiguous: false positives from rendering differences are the number-one reason teams abandon visual testing. Reports of "50-95% of tests fail randomly" are not outliers, and the second-order damage is worse - once engineers believe the red is noise, they ignore real failures too.

So determinism is not a configuration surface. It is a **contract**, and every clause is enforced in code rather than documented as advice.

## The core guarantee

**Baselines are captured in exactly the same pinned image that later runs the comparison.**

If the image digest changes, baselines are invalidated and re-captured rather than silently producing diffs. Where competing tools tell users to "generate baselines on a machine that matches CI", Bugpatrol makes the question structurally impossible to get wrong.

| Enforced | How | Where |
| -------- | --- | ----- |
| Same OS, libc, everything | Image pinned by digest in the `Recipe` | `images/runner/Dockerfile`, `determinism.image` |
| Same browser build | Playwright pinned with the image | `packages/capture/package.json` |
| Same fonts | Bundled in the image, host fonts absent | `images/runner/Dockerfile` |
| No font-substitution surprises | The run fails loudly on a fallback | `assertNoFontFallback` |

## Rendering

| Clause | Setting | Where |
| ------ | ------- | ----- |
| Rasterisation | CPU/SwiftShader, GPU disabled | `DETERMINISTIC_CHROMIUM_ARGS` |
| Sub-pixel antialiasing | Disabled (`--disable-lcd-text`) | `DETERMINISTIC_CHROMIUM_ARGS` |
| Device pixel ratio | Fixed and recorded with the baseline | `viewports[].deviceScaleFactor` |
| Scrollbars | Forced overlay (`--hide-scrollbars`) | `DETERMINISTIC_CHROMIUM_ARGS` |
| Colour profile | Forced sRGB | `DETERMINISTIC_CHROMIUM_ARGS` |

## Time, motion and randomness

| Clause | Setting | Where |
| ------ | ------- | ----- |
| Clock | `Date`, `Date.now`, `performance.now` frozen | `buildFreezeScript` |
| Timezone | Pinned | `determinism.timezone` |
| Locale | Pinned, including number/date/currency formatting | `determinism.locale` |
| Randomness | `Math.random` seeded (mulberry32) | `buildFreezeScript` |
| Animations | `prefers-reduced-motion` + injected CSS | `STABILITY_STYLESHEET` |
| Caret | `caret-color: transparent` + `caret: 'hide'` | `STABILITY_STYLESHEET` |
| Fonts loaded before capture | `await document.fonts.ready` | `waitForStableFrame` |

## The stability gate

This is the difference between "we waited 2 seconds" and "the frame is stable".

Polling sleeps are the single most common cause of intermittent visual failures in existing tools. Bugpatrol does not use them. Capture is only taken once **two consecutive frames are byte-identical**, with a bounded retry and a hard timeout.

On timeout it raises an **infrastructure error**, not a diff. Reporting "this screen never settled" is honest. Reporting it as a regression is not.

See `packages/capture/src/stability-gate.ts`.

## Network

| Clause | Setting |
| ------ | ------- |
| Third-party requests | Blocked by default, and reported as blocked |
| Analytics, ads, chat, cookie banners | Stubbed out |
| API data | Seeded fixtures with stable IDs |
| Slow responses | Held until the stability gate passes, not timed out |

Blocking third-party requests serves two purposes at once: it removes the largest source of rendering non-determinism, and it removes the largest accidental data-exfiltration path out of a crawled page.

## Masking

Some content is legitimately unstable: avatars, relative timestamps, live counters. The contract is that **masks are declared, visible and accounted for** - never silent.

Masked regions are excluded from the numerator *and* the denominator of the diff score, and **the percentage of the screen masked is reported alongside every diff**.

A diff that is 60% masked is not a passing diff. It is a hollow test, and the report says so (`evaluate()` raises a `hollow-test` flag).

## Tolerance - and the trap in it

Every existing tool exposes a tolerance knob, and every one of them has a user who turned it up until the build went green and it stopped catching anything. The research documents both failure modes: anti-aliasing suppression masking genuine regressions, and a zero-threshold config reporting a completely missing button as **PASSING**.

| Rule | Enforcement |
| ---- | ----------- |
| Default is exact for tier-1 gates | `tolerance.default` is the literal `'exact'`; there is no global threshold field |
| Tolerance is per-region, never global | `tolerance.regions[]` requires a screen and a selector |
| Perceptual comparison is a separate signal | SSIM is reported alongside the exact diff, never replacing it |
| Tolerance changes are logged as Ledger entries | Raising a threshold has an author, a reason and a date |
| Masked percentage is reported | Hiding a region cannot hide that it was hidden |
| Masked **and** relaxed is flagged | The highest-risk configuration, surfaced rather than tolerated |

**The principle: a diff score is never the only number reported.** Raw pixel delta, perceptual score, masked percentage and region count all travel together, so a human can see when a green result is green because the test got weaker rather than because the app got better.

## Bugpatrol's own acceptance test

Three consecutive runs against an unchanged commit must produce zero diffs across every screen and viewport. It runs on every commit - see `.github/workflows/determinism.yml`.

Until that holds, nothing built on top of this signal can be trusted.
