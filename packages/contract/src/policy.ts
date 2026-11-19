import { type AppConfig, ConfigError, denyRule, type Endpoint, HTTP_METHODS, type HttpMethod } from '@bugpatrol/core';
import type { Contract, SkipReason } from './contract.js';
import { matcher } from './match.js';

export type PolicyVerdict =
  | { ok: true; endpoint?: Endpoint }
  /** `readOnly` marks a write that only the write gate stops. */
  | { ok: false; reason: string; readOnly?: true };

/** What Bugpatrol may request. Only the api driver enforces it. */
export type RequestPolicy = {
  /** The contract that the policy gates on. The contract checks of a replay read it too. */
  contract: Contract;
  /** Decision 4: the target is loopback, or the config says it is disposable. */
  writesAllowed: boolean;
  /** The write gate and `app.connect.methods` together (Q4). */
  allowedMethods: HttpMethod[];
  check(method: HttpMethod, url: string): PolicyVerdict;
};

/** `readOnly`: `app.readOnly` is on, so only reads go out, whatever the target. */
type PolicyConnect = Pick<AppConfig['connect'], 'methods' | 'deny' | 'disposable'> & {
  url: string;
  readOnly?: boolean;
};

const READS: readonly HttpMethod[] = ['GET', 'HEAD', 'OPTIONS'];

const SKIPPED: Record<SkipReason, string> = {
  'x-bugpatrol-skip': 'the spec marks it x-bugpatrol-skip',
  'event-stream': 'it answers with an event stream',
};

/**
 * The one gate for every request (decision 4). `connect.deny` and
 * `x-bugpatrol-skip` match the path template of the endpoint, so a value in
 * a path parameter cannot dodge them. A URL that matches no endpoint can only
 * read.
 */
export function requestPolicy(contract: Contract, connect: PolicyConnect): RequestPolicy {
  const writesAllowed = !connect.readOnly && (connect.disposable || isLoopback(connect.url));
  const allowedMethods = HTTP_METHODS.filter(
    (method) => connect.methods.includes(method) && (writesAllowed || READS.includes(method)),
  );
  const denied = denyList(connect.deny);
  const skipped = contract.skipped.map(({ key, reason }) => {
    const space = key.indexOf(' ');
    return { method: key.slice(0, space) as HttpMethod, template: key.slice(space + 1), reason };
  });
  const match = matcher<Endpoint | (typeof skipped)[number]>([...contract.endpoints, ...skipped]);

  return {
    contract,
    writesAllowed,
    allowedMethods,
    check(method, url) {
      const found = match(method, url);
      if (found && 'reason' in found) return { ok: false, reason: SKIPPED[found.reason] };
      const rule = denied(method, url, found?.template);
      if (rule) return { ok: false, reason: `app.connect.deny has ${rule}` };
      if (!allowedMethods.includes(method)) {
        if (!writesAllowed && !READS.includes(method))
          return {
            ok: false,
            reason: connect.readOnly
              ? 'app.readOnly is on: only GET, HEAD and OPTIONS go out'
              : 'the target is read-only: writes need a loopback url or app.connect.disposable',
            readOnly: true,
          };
        return { ok: false, reason: `app.connect.methods does not have ${method}` };
      }
      if (!found && !READS.includes(method)) return { ok: false, reason: 'the contract has no such endpoint' };
      return { ok: true, ...(found ? { endpoint: found } : {}) };
    },
  };
}

/** A URL that does not parse, for example with a placeholder still in it, is not loopback. */
export function isLoopback(url: string): boolean {
  let hostname: string;
  try {
    ({ hostname } = new URL(url));
  } catch {
    return false;
  }
  return hostname === 'localhost' || hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

/**
 * `app.connect.deny` as one test: the glob that a request matches, or
 * undefined. It matches the path of `url`, on any host, and `template`, the
 * path template of the endpoint, when there is one. The api request policy,
 * the web and Electron drivers and the read-only proxies all use it.
 */
export function denyList(globs: string[]): (method: string, url: string, template?: string) => string | undefined {
  const rules = globs.map((glob) => {
    const rule = denyRule(glob);
    if (!rule) throw new ConfigError(`app.connect.deny ${glob}: use an optional method and a path that starts with /`);
    return rule;
  });
  return (method, url, template) => {
    // Both the encoded and the decoded path: a server may split the path before
    // or after it decodes %2F, and neither reading may reach a denied route.
    const paths = [...(template ? [template] : []), ...requestPaths(url)];
    return rules.find((rule) => (!rule.method || rule.method === method.toUpperCase()) && paths.some(rule.test))?.glob;
  };
}

function requestPaths(url: string): string[] {
  const { pathname } = new URL(url, 'http://policy.invalid');
  try {
    return [pathname, decodeURIComponent(pathname)];
  } catch {
    return [pathname];
  }
}
