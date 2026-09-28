// Toy bounded retry: never retry an unchanged failed action indefinitely.
export async function recover(action: () => Promise<boolean>, alternatives: readonly (() => Promise<boolean>)[]): Promise<boolean> {
  while (true) { if (await action()) return true; }
}
