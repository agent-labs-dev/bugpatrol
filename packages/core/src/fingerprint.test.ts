import { describe, expect, it } from 'vitest';
import { baselineKey, fingerprint, normalizeRegionSignature } from './fingerprint.js';
import type { EndpointKey } from './types/endpoint.js';

describe('fingerprint', () => {
  it('is stable across runs for identical input', () => {
    const input = { screenId: 's1', ruleId: 'pixel-diff', regions: [{ x: 10, y: 10, width: 40, height: 20 }] };
    expect(fingerprint(input)).toBe(fingerprint(input));
  });

  it('survives a small positional shift', () => {
    // The whole point of bucketing: a finding that moves a few pixels must keep
    // its identity, or suppression and flake history silently stop working.
    const a = fingerprint({ screenId: 's1', ruleId: 'r', regions: [{ x: 10, y: 10, width: 40, height: 20 }] });
    const b = fingerprint({ screenId: 's1', ruleId: 'r', regions: [{ x: 12, y: 11, width: 40, height: 20 }] });
    expect(a).toBe(b);
  });

  it('changes when the region moves to a different part of the screen', () => {
    const a = fingerprint({ screenId: 's1', ruleId: 'r', regions: [{ x: 10, y: 10, width: 40, height: 20 }] });
    const b = fingerprint({ screenId: 's1', ruleId: 'r', regions: [{ x: 800, y: 600, width: 40, height: 20 }] });
    expect(a).not.toBe(b);
  });

  it('keys an api failure on the endpoint, the case, and the failed check', () => {
    const key = { endpoint: 'GET /items/{id}' as EndpointKey, case: 'missing-id' as const, assertionId: 'status' };
    expect(fingerprint(key)).toBe(fingerprint({ ...key }));
    expect(fingerprint(key)).not.toBe(fingerprint({ ...key, case: 'other-user' }));
    expect(fingerprint(key)).not.toBe(fingerprint({ ...key, assertionId: 'contract:schema' }));
    expect(fingerprint(key)).not.toBe(fingerprint({ ...key, endpoint: 'GET /items' as EndpointKey }));
  });

  it('distinguishes rules on the same screen', () => {
    const a = fingerprint({ screenId: 's1', ruleId: 'overlap' });
    const b = fingerprint({ screenId: 's1', ruleId: 'occlusion' });
    expect(a).not.toBe(b);
  });
});

describe('normalizeRegionSignature', () => {
  it('is order independent', () => {
    const r1 = { x: 0, y: 0, width: 10, height: 10 };
    const r2 = { x: 200, y: 200, width: 10, height: 10 };
    expect(normalizeRegionSignature([r1, r2])).toBe(normalizeRegionSignature([r2, r1]));
  });
});

describe('baselineKey', () => {
  it('binds a baseline to the image it was captured in', () => {
    expect(baselineKey('abc', 'sha256:one')).not.toBe(baselineKey('abc', 'sha256:two'));
  });
});
