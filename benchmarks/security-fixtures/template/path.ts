import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Deliberately vulnerable toy document lookup.
export async function document(root: string, name: string): Promise<string> {
  return readFile(join(root, name), "utf8");
}
