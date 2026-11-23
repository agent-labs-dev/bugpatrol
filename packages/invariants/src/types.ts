import type { ElementGeometry, Severity } from '@bugpatrol/core';

/** A single captured screen state, in one viewport, ready for evaluation. */
export type ScreenLink = {
  href: string;
  text: string;
  external: boolean;
  /** The anchor has a `download` attribute. */
  download?: boolean;
  /** The anchor's `type` attribute, e.g. application/rss+xml. */
  type?: string;
  selector: string;
  box: { x: number; y: number; width: number; height: number };
};

export type ScreenSnapshot = {
  screenId: string;
  viewport: { name: string; width: number; height: number; scale?: number };
  url: string;
  title?: string;
  /** Outgoing links. Every one is a candidate edge in the app graph. */
  links?: ScreenLink[];
  elements: ElementGeometry[];
  document: {
    scrollWidth: number;
    clientWidth: number;
    scrollHeight: number;
    clientHeight: number;
    hasStylesheets: boolean;
  };
  images: Array<{ selector: string; naturalWidth: number; naturalHeight: number; complete: boolean; alt?: string }>;
  consoleErrors: string[];
};

export type InvariantViolation = {
  ruleId: string;
  /**
   * One sentence, naming a consequence. This is the governing rule of the
   * whole detector suite (spec 8.8): "4.3% of pixels changed" fails it,
   * "the Save button is behind the sticky footer and unreachable" passes it.
   */
  message: string;
  severity: Severity;
  selector?: string;
  region?: { x: number; y: number; width: number; height: number };
  /** Supporting numbers, shown in the report and fed into the tier-2 state. */
  detail?: Record<string, number | string | boolean>;
};

export type InvariantRule = {
  id: string;
  title: string;
  /** What a human sees when this fires. Used in docs and the report. */
  catches: string;
  defaultSeverity: Severity;
  /**
   * Whether the rule needs the baseline snapshot. Change-aware rules are lower
   * noise, because they only fire on a delta rather than on the absolute state.
   */
  changeAware: boolean;
  evaluate(snapshot: ScreenSnapshot, baseline?: ScreenSnapshot): InvariantViolation[];
};
