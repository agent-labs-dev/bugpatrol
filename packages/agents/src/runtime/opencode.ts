import { execFileSync } from 'node:child_process';

/**
 * opencode ships two released lines that do not agree on flags or config
 * shape. v1 (`opencode-ai` on npm, 1.18.x) has `--auto`, no `--standalone`,
 * config keyed directly under `mcp`, and a `permission` map. v2
 * (`@opencode/cli`, 2.x) adds `--standalone`, nests servers under
 * `mcp.servers`, and uses an ordered `permissions` list. The preset resolves
 * the installed line once and caches it.
 */
export type OpencodeMajor = 1 | 2;

let detected: OpencodeMajor | null | undefined;

export function detectOpencodeMajor(program = 'opencode'): OpencodeMajor | undefined {
  if (detected !== undefined) return detected ?? undefined;
  try {
    const out = execFileSync(program, ['--version'], { timeout: 10_000, encoding: 'utf8' });
    const match = out.match(/(\d+)\.\d+\.\d+/);
    if (!match) {
      detected = null;
      return undefined;
    }
    const major = Number(match[1]);
    detected = major === 1 || major === 2 ? (major as OpencodeMajor) : null;
    return detected ?? undefined;
  } catch {
    detected = null;
    return undefined;
  }
}

const v1Tools = `OPENCODE_CONFIG_CONTENT='{"mcp":{"bugpatrol":{"type":"remote","url":"'{mcpUrl}'","oauth":false}},"permission":{"*":"deny","bugpatrol_*":"allow"}}' opencode run --auto --format json`;
const v1Fixer = 'opencode run --auto --format json';
const v2Tools = `OPENCODE_CONFIG_CONTENT='{"mcp":{"servers":{"bugpatrol":{"type":"remote","url":"'{mcpUrl}'","oauth":false}}},"permissions":[{"action":"*","resource":"*","effect":"deny"},{"action":"bugpatrol_*","resource":"*","effect":"allow"},{"action":"execute","resource":"*","effect":"allow"}]}' opencode run --standalone --auto --format json`;
const v2Fixer = 'opencode run --standalone --auto --format json';

/** The preset string for the installed opencode line, or the v2 default when unknown. */
export function opencodePreset(role: 'tools' | 'fixer', major: OpencodeMajor | undefined): string {
  if (major === 1) return role === 'fixer' ? v1Fixer : v1Tools;
  return role === 'fixer' ? v2Fixer : v2Tools;
}
