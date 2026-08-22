/**
 * Quote a string for safe use as a single word in a POSIX shell command.
 * Wraps the value in single quotes; embedded single quotes become '\''.
 * Nothing inside single quotes is expanded by the shell.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
