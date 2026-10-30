import { missingId } from '@bugpatrol/contract';
import type { AppConfig } from '@bugpatrol/core';

/** Captures and allowlisted secrets share one redaction and interpolation path. */
export class Vars {
  private readonly values = new Map<string, string>();
  private readonly responseNames = new Set<string>();
  private readonly historicalValues: [string, string][] = [];
  private readonly configValues = new Map<string, string>();

  constructor(
    secrets: AppConfig['secrets'] = [],
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    for (const name of secrets) {
      if (env[name] !== undefined) {
        this.set(name, env[name]);
      }
    }
  }

  set(name: string, value: string): void {
    const previous = this.values.get(name);
    if (previous !== undefined && previous !== value && !this.responseNames.has(name))
      this.historicalValues.push([name, previous]);
    this.values.set(name, value);
  }

  /** Response captures may refresh their own names, never overwrite setup/auth variables. */
  capture(values: Record<string, string> = {}): void {
    for (const name of Object.keys(values)) {
      if (
        !/^RESPONSE_[A-Z0-9_]+$/.test(name) ||
        ((this.has(name) || this.configValues.has(name)) && !this.responseNames.has(name))
      )
        throw new Error(`Response capture cannot overwrite configured variable ${name}`);
    }
    for (const [name, value] of Object.entries(values)) {
      this.responseNames.add(name);
      this.set(name, value);
    }
  }

  has(name: string): boolean {
    return this.values.has(name);
  }

  names(): string[] {
    return [...this.values.keys()];
  }

  entries(): [string, string][] {
    return [...this.values.entries()];
  }

  /** Agent input may use only declared secrets and captured setup values. */
  resolve(text: string): string {
    return this.interpolate(text, false);
  }

  /** Only repository-owned setup commands and paths may read the host environment. */
  resolveConfig(text: string): string {
    return this.interpolate(text, true);
  }

  /** `{{NAME|missing}}` gives an id of the same shape as the value that does not exist (see `missingId`). */
  private interpolate(text: string, trusted: boolean): string {
    const placeholder = /\{\{([A-Za-z_][A-Za-z_0-9]*)(\|missing)?\}\}|\$\{([A-Za-z_][A-Za-z_0-9]*)\}/g;
    return text.replace(
      placeholder,
      (match, strict: string | undefined, missing: string | undefined, env: string | undefined) => {
        const name = strict ?? env ?? '';
        const value = this.values.get(name);
        if (value !== undefined) {
          return missing ? missingId(value) : value;
        }
        if (trusted && env !== undefined) {
          const configured = this.env[name];
          if (configured !== undefined) this.configValues.set(name, configured);
          return configured ?? match;
        }
        throw new Error(`Unknown variable ${name}. Available: ${this.names().join(', ') || '(none)'}`);
      },
    );
  }

  redact(value: unknown): unknown {
    if (Buffer.isBuffer(value)) {
      return value;
    }
    if (typeof value === 'string') {
      const entries = [...this.entries(), ...this.historicalValues, ...this.configValues.entries()].filter(
        ([name, secret]) => secret.length > 0 && !this.responseNames.has(name),
      );
      entries.sort((a, b) => b[1].length - a[1].length);
      let result = value;
      for (const [name, secret] of entries) {
        result = result.replaceAll(secret, `{{${name}}}`);
      }
      return result;
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.redact(item));
    }
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.redact(item)]));
    }
    return value;
  }
}
