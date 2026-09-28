import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);
// Deliberately vulnerable toy argument forwarding.
export async function echoLabel(label: string): Promise<string> {
  const { stdout } = await run(process.execPath, ["-e", `console.log('${label}')`]);
  return stdout.trim();
}
