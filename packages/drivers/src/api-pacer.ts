/** The longest wait a `Retry-After` can ask for. A longer one gives a rate-limited result instead. */
const MAX_WAIT_MS = 60_000;
/** A 429 without `Retry-After`. */
const DEFAULT_WAIT_MS = 1_000;

/**
 * T7: requests leave at most `perMinute` per minute, and a `Retry-After` or
 * a 429 holds back the next request until the server is ready. A 429 means
 * "try later", never a bug.
 */
export class Pacer {
  private readonly intervalMs: number;
  /** The earliest time for the next request. */
  private next = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor({ perMinute = 60 }: { perMinute?: number } = {}) {
    this.intervalMs = 60_000 / perMinute;
  }

  /** Waits for the turn of one request. Requests take their turns in order. */
  acquire(): Promise<void> {
    const turn = this.queue.then(async () => {
      const wait = this.next - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      this.next = Date.now() + this.intervalMs;
    });
    this.queue = turn;
    return turn;
  }

  /**
   * Reads the status and `Retry-After` of a response, and holds back the next
   * request as the server asks. For a 429, it says if one more try can wait
   * for its turn, or if the request is rate-limited.
   */
  onResponse(status: number, retryAfter: string | null): 'retry' | 'rate-limited' | undefined {
    // RFC 9110 gives Retry-After a wait only on a 429 and a 503.
    if (status !== 429 && status !== 503) return undefined;
    const ms = retryAfterMs(retryAfter) ?? (status === 429 ? DEFAULT_WAIT_MS : undefined);
    if (ms === undefined) return undefined;
    this.next = Math.max(this.next, Date.now() + Math.min(ms, MAX_WAIT_MS));
    if (status !== 429) return undefined;
    return ms <= MAX_WAIT_MS ? 'retry' : 'rate-limited';
  }
}

/** Both forms: delay-seconds, or an HTTP date. */
function retryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value.trim())) return Number(value.trim()) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}
