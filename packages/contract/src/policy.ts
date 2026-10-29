import { type AppConfig, ConfigError, type Endpoint, HTTP_METHODS, type HttpMethod } from '@bugpatrol/core';
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

type PolicyConnect = Pick<AppConfig['connect'], 'methods' | 'deny' | 'disposable'> & { url: string };

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
  const writesAllowed = connect.disposable || isLoopback(connect.url);
  const allowedMethods = HTTP_METHODS.filter(
    (method) => connect.methods.includes(method) && (writesAllowed || READS.includes(method)),
  );
  const deny = connect.deny.map(denyRule);
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
      // The decoded path too: a server that decodes %2F must not reach a denied route.
      const paths = [...(found ? [found.template] : []), decodedPath(url)];
      const rule = deny.find((item) => (!item.method || item.method === method) && paths.some(item.test));
      if (rule) return { ok: false, reason: `app.connect.deny has ${rule.glob}` };
      if (!allowedMethods.includes(method)) {
        if (!writesAllowed && !READS.includes(method))
          return {
            ok: false,
            reason: 'the target is read-only: writes need a loopback url or app.connect.disposable',
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
function isLoopback(url: string): boolean {
  let hostname: string;
  try {
    ({ hostname } = new URL(url));
  } catch {
    return false;
  }
  return hostname === 'localhost' || hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

/** `[METHOD] /path`: `*` is one segment or a part of one, and a `**` segment is any number of segments. */
function denyRule(glob: string): { glob: string; method?: HttpMethod; test(path: string): boolean } {
  const [first, second] = glob.trim().split(/\s+/);
  const method = second === undefined ? undefined : first!.toUpperCase();
  const path = second ?? first!;
  if ((method && !HTTP_METHODS.includes(method as HttpMethod)) || !path.startsWith('/'))
    throw new ConfigError(`app.connect.deny ${glob}: use an optional method and a path that starts with /`);
  const source = path
    .split('/')
    .slice(1)
    .map((segment) =>
      segment === '**'
        ? '(?:/[^/]*)*'
        : `/${segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replaceAll('\\*', '[^/]*')}`,
    )
    .join('');
  const pattern = new RegExp(`^${source}/?$`, 's');
  return { glob, ...(method ? { method: method as HttpMethod } : {}), test: (value) => pattern.test(value) };
}

function decodedPath(url: string): string {
  const { pathname } = new URL(url, 'http://policy.invalid');
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}
