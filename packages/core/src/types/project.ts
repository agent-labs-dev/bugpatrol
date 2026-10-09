import type { BugpatrolConfig } from '../config/schema.js';
import type { ArtifactRef, ProjectId, SecretRef } from './ids.js';

export type Project = {
  id: ProjectId;
  repo: { owner: string; name: string; defaultBranch: string };
  /** GitHub App installation id. */
  installationId: number;
  stack: StackProfile;
  config: BugpatrolConfig;
  createdAt: Date;
};

export type StackProfile = {
  framework?: string;
  packageManager?: 'pnpm' | 'npm' | 'yarn' | 'bun';
  buildCommand?: string;
  testCommand?: string;
  nodeVersion?: string;
  /** Provenance: which files implied each fact. Detection is never silent. */
  detectedFrom: string[];
  confidence: number;
};

export type Viewport = { name: string; width: number; height: number; deviceScaleFactor?: number };

export type Action =
  | { kind: 'goto'; url: string }
  | { kind: 'click'; selector: string }
  | { kind: 'fill'; selector: string; value: string }
  | { kind: 'press'; selector: string; key: string }
  | { kind: 'select'; selector: string; value: string }
  | { kind: 'expectUrl'; url: string }
  | { kind: 'expectVisible'; selector: string }
  | { kind: 'wait'; forSelector: string };

export type HealthCheck = {
  url: string;
  /** "The port is open" is not sufficient -- plenty of apps serve a 200 error page. */
  selectors?: string[];
  forbidConsoleErrors?: boolean;
  timeoutMs: number;
};

export type RecipeResolution = 'config' | 'precedent' | 'convention' | 'docs' | 'agent' | 'manual';

/** How to actually run the product, resolved once during Recon. */
export type Recipe = {
  version: number;
  /**
   * PINNED container image digest. The determinism contract (spec 7.1) depends
   * on baselines and comparisons running in the same image; a digest change
   * invalidates baselines rather than producing a diff storm.
   */
  image: string;
  run: string;
  healthCheck: HealthCheck;
  env: Record<string, SecretRef>;
  fixtures?: string[];
  viewports: Viewport[];
  resolvedBy: RecipeResolution;
};
