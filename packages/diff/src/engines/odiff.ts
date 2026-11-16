import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InfrastructureError } from '@bugpatrol/core';
import { compare } from 'odiff-bin';
import { boundingRegionsFromLines, maskedPixelCount } from '../mask-accounting.js';
import type { DiffRequest, DiffResult } from '../types.js';

/**
 * The primary engine. Published benchmark on cypress.io screenshots: 1.168s vs
 * pixelmatch's 7.712s, and 1.951s vs 10.614s at 4K (spec 5.2). Speed is the
 * whole point when the tool is meant to run on every push.
 *
 * odiff uses the same YIQ colour distance and anti-aliasing detection as
 * pixelmatch, which is why the two agree in the overwhelming majority of cases
 * and a disagreement is worth escalating rather than averaging.
 */
/**
 * Raised when odiff's prebuilt native binary cannot execute here at all --
 * typically a glibc too old for the published build. Distinct from a diff
 * failure, because the correct response is to fall back to the pure-JS engine
 * rather than to report a regression.
 */
export class OdiffUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`odiff's native binary cannot run on this host (${summarizeLoaderError(cause)})`, { cause });
    this.name = 'OdiffUnavailableError';
  }
}

/**
 * The dynamic loader reports a missing symbol version once per library, each
 * with two absolute paths -- a dozen lines that ended up verbatim in the
 * report. The one fact worth surfacing is what the binary needs.
 */
export function summarizeLoaderError(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  const versions = [...new Set(text.match(/GLIBC_[\d.]+/g) ?? [])];
  if (versions.length > 0) return `needs ${versions.join(', ')}, which this system's C library does not provide`;
  if (/ENOENT/.test(text)) return 'binary not found';
  if (/Exec format/i.test(text)) return 'built for a different CPU architecture';
  return text.split('\n')[0]!.slice(0, 160);
}

export async function diffWithOdiff(req: DiffRequest): Promise<DiffResult> {
  const started = performance.now();
  const masks = req.masks ?? [];

  const result = await runCompare(req, masks);

  if (result.match) {
    return {
      engine: 'odiff',
      identical: true,
      changedPixels: 0,
      changedFraction: 0,
      comparedPixels: 0,
      totalPixels: 0,
      maskedFraction: 0,
      maskedRegionCount: masks.length,
      regions: [],
      durationMs: performance.now() - started,
    };
  }

  if (result.reason === 'layout-diff') {
    // Different dimensions. Never tolerable: a resized screenshot is not a
    // comparison, and reporting a fraction here would be meaningless.
    return {
      engine: 'odiff',
      identical: false,
      changedPixels: 0,
      changedFraction: 1,
      comparedPixels: 0,
      totalPixels: 0,
      maskedFraction: 0,
      maskedRegionCount: masks.length,
      regions: [],
      dimensionMismatch: { baseline: [0, 0], actual: [0, 0] },
      durationMs: performance.now() - started,
    };
  }

  if (result.reason === 'file-not-exists') {
    throw new InfrastructureError(`odiff could not read one of the images: ${req.baselinePath}, ${req.actualPath}`);
  }

  const totalPixels =
    'diffPercentage' in result && result.diffCount
      ? Math.round(result.diffCount / Math.max(result.diffPercentage / 100, Number.EPSILON))
      : 0;
  const masked = maskedPixelCount(masks, 0, 0);

  return {
    engine: 'odiff',
    identical: false,
    changedPixels: result.diffCount ?? 0,
    changedFraction: (result.diffPercentage ?? 0) / 100,
    comparedPixels: Math.max(0, totalPixels - masked),
    totalPixels,
    maskedFraction: totalPixels > 0 ? masked / totalPixels : 0,
    maskedRegionCount: masks.length,
    regions: boundingRegionsFromLines(result.diffLines ?? []),
    diffImagePath: req.diffOutPath,
    durationMs: performance.now() - started,
  };
}

async function runCompare(req: DiffRequest, masks: DiffRequest['masks'] = []) {
  // odiff's Node wrapper always passes an output path, and odiff 4 fails a
  // pixel diff it cannot write, so an unwanted image goes to a scratch file.
  const scratch = req.diffOutPath ? undefined : await mkdtemp(join(tmpdir(), 'bugpatrol-odiff-'));
  try {
    return await compare(req.baselinePath, req.actualPath, req.diffOutPath ?? join(scratch!, 'diff.png'), {
      threshold: req.threshold ?? 0,
      antialiasing: req.antialiasing ?? false,
      captureDiffLines: true,
      failOnLayoutDiff: true,
      // odiff 4 rejects an empty region list as an invalid format.
      ...(masks.length > 0 && {
        ignoreRegions: masks.map((m) => ({
          x1: Math.floor(m.x),
          y1: Math.floor(m.y),
          x2: Math.ceil(m.x + m.width),
          y2: Math.ceil(m.y + m.height),
        })),
      }),
    });
  } catch (cause) {
    // odiff ships a prebuilt binary. On a host whose glibc predates the build,
    // it cannot start at all -- which is a property of the machine, not of the
    // images being compared, so it must not surface as a diff.
    if (cause instanceof Error && /GLIBC|not found|ENOENT|Exec format|cannot execute/i.test(cause.message)) {
      throw new OdiffUnavailableError(cause);
    }
    throw cause;
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }
}
