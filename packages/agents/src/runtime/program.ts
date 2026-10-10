/** The first word of a shell command that names a program, past any `NAME=value`. */
export function commandProgram(command: string): string | undefined {
  return command
    .trim()
    .split(/\s+/)
    .find((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
}
