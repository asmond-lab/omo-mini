function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, ordered(item)]));
  }
  return value;
}

export function toolActionKey(tool: string, input: Record<string, unknown>): string {
  const execution = tool === "bash" || tool === "powershell"
    ? Object.fromEntries(Object.entries(input).filter(([key]) => key !== "description"))
    : input;
  return JSON.stringify([tool, ordered(execution)]);
}
