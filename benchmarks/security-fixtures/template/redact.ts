// Dummy token only; never use a real credential.
export function audit(line: string): string {
  return `audit: ${line}`;
}
