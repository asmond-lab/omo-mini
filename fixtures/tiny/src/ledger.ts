export function invoiceTotal(base: number, handling: number): number {
  return base + handling;
}

export function labelFor(code: string): string {
  return `invoice:${code}`;
}
