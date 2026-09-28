import { readFile, readdir, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { Socket } from "node:net";

type Owner = { pid: number; nonce: string; startedAt: string; endpoint: { kind: string; path: string } };
type Identity = { pid: number; commandLine: string; executablePath: string; createdMs: number };
export type DaemonExit = { task: string; owner: Owner; process: Identity; signal: "SIGTERM" | "already_absent"; exitVerified: boolean };

async function powershell(script: string): Promise<string> {
  const child = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script], { stdout: "pipe", stderr: "pipe" });
  const [exit, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (exit !== 0) throw new Error(`Daemon identity/exit inspection failed (${exit}): ${error || output}`);
  return output.trim();
}
async function identity(pid: number): Promise<Identity | null> {
  const output = await powershell(`$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if($null -eq $p){'null'}else{[pscustomobject]@{pid=[int]$p.ProcessId;commandLine=$p.CommandLine;executablePath=$p.ExecutablePath;createdMs=([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds()}|ConvertTo-Json -Compress}`);
  const value: unknown = JSON.parse(output);
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid process identity for ${pid}`);
  const found = value as Record<string, unknown>;
  if (found.pid !== pid || typeof found.commandLine !== "string" || typeof found.executablePath !== "string" ||
      typeof found.createdMs !== "number" || !Number.isSafeInteger(found.createdMs)) throw new Error(`Incomplete process identity for ${pid}`);
  return found as Identity;
}
function parseOwner(value: unknown): Owner {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid daemon owner record");
  const data = value as Record<string, unknown>;
  const endpoint = data.endpoint;
  if (!Number.isSafeInteger(data.pid) || Number(data.pid) < 1 || typeof data.nonce !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(data.nonce) || typeof data.startedAt !== "string" || !Number.isFinite(Date.parse(data.startedAt)) ||
      !endpoint || typeof endpoint !== "object" || Array.isArray(endpoint) ||
      (endpoint as Record<string, unknown>).kind !== "windows" || typeof (endpoint as Record<string, unknown>).path !== "string")
    throw new Error("Invalid daemon owner identity");
  return data as Owner;
}
/** Native's authenticated omo/ping protocol, bounded by an event-driven socket timeout. */
function pingOwner(endpoint: string, token: string): Promise<Owner> {
  return new Promise((done, reject) => {
    const socket = new Socket();
    let buffer = "", finished = false;
    const finish = (error?: Error, owner?: Owner) => {
      if (finished) return;
      finished = true; clearTimeout(timer); socket.destroy();
      if (error) reject(error); else done(owner!);
    };
    const timer = setTimeout(() => finish(new Error(`Native owner ping timed out at ${endpoint}`)), 2000);
    socket.once("connect", () => socket.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "omo/ping",
      params: { _omo: { protocolVersion: 1, token } } }) + String.fromCharCode(10)));
    socket.on("data", chunk => {
      buffer += chunk.toString("utf8");
      if (buffer.length > 8192) return finish(new Error("Native owner ping response oversized"));
      const end = buffer.indexOf(String.fromCharCode(10));
      if (end < 0) return;
      try {
        const result: unknown = JSON.parse(buffer.slice(0, end));
        if (!result || typeof result !== "object" || Array.isArray(result) || (result as Record<string, unknown>).id !== 1)
          throw new Error("Invalid Native owner ping response");
        finish(undefined, parseOwner((result as Record<string, unknown>).result));
      } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
    socket.once("error", error => finish(error));
    socket.connect(endpoint);
  });
}

/** Stop only authenticated, live daemons created in this suite's private Native state roots. */
export async function stopOwnedDaemons(scratch: string, taskIds: readonly string[], productRoot: string, startedAt: string): Promise<{ exits: DaemonExit[]; error?: string }> {
  const exits: DaemonExit[] = [];
  try {
    if (process.platform !== "win32") throw new Error("Owned daemon lifecycle requires Windows identity/exit inspection");
    const runtime = join(productRoot, "node_modules", "omo-ai", "plugin", "runtime", "lsp-daemon");
    const info: unknown = JSON.parse(await readFile(join(runtime, "dist", "package.json"), "utf8"));
    const version = typeof info === "object" && info !== null ? (info as Record<string, unknown>).version : undefined;
    if (typeof version !== "string" || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-.][A-Za-z0-9.-]+)?$/.test(version))
      throw new Error("Unknown installed LSP daemon version");
    const daemonCli = await realpath(join(runtime, "dist", "cli.js"));
    for (const task of taskIds) {
      const base = join(scratch, task, "state", "home", ".omo", "lsp-daemon");
      if (!existsSync(base)) continue;
      const entries = await readdir(base, { withFileTypes: true });
      // Native's own sibling sweep markers are regular files, not daemon owners.
      if (entries.some(entry => entry.isDirectory() ? entry.name !== `v${version}` :
          !entry.isFile() || !["lsp-daemon-sweep.stamp", "lsp-proxy-sweep.stamp"].includes(entry.name)))
        throw new Error(`Unknown daemon version/state under ${task}`);
      if (!entries.some(entry => entry.isDirectory())) continue;
      const dir = join(base, `v${version}`);
      const canonical = await realpath(dir);
      if (resolve(canonical) !== resolve(dir) || !resolve(canonical).startsWith(`${resolve(scratch)}${sep}`))
        throw new Error(`Daemon state escaped scratch in ${task}`);
      const ownerFile = join(dir, "daemon.owner"), pidFile = join(dir, "daemon.pid"), endpointFile = join(dir, "daemon.endpoint");
      if (!existsSync(ownerFile)) {
        if (existsSync(pidFile) || existsSync(endpointFile)) throw new Error(`Unknown daemon owner in ${task}`);
        continue; // Cleanly exited Native daemons remove their own owner/pid/endpoint metadata.
      }
      const owner = parseOwner(JSON.parse(await readFile(ownerFile, "utf8")));
      const pidText = (await readFile(pidFile, "utf8")).trim();
      const endpointText = (await readFile(endpointFile, "utf8")).trim();
      if (pidText !== String(owner.pid) || endpointText !== owner.endpoint.path)
        throw new Error(`Conflicting daemon owner metadata in ${task}`);
      const previous = await identity(owner.pid);
      if (!previous) {
        exits.push({ task, owner, process: { pid: owner.pid, commandLine: "", executablePath: "", createdMs: 0 }, signal: "already_absent", exitVerified: true });
        continue;
      }
      const created = previous.createdMs, declared = Date.parse(owner.startedAt), suiteStart = Date.parse(startedAt);
      const cliPattern = new RegExp(`(?:^|\\s)"?${daemonCli.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"?\\s+daemon\\s*$`, "i");
      if (!cliPattern.test(previous.commandLine) ||
          resolve(previous.executablePath).toLowerCase() !== resolve(process.execPath).toLowerCase() ||
          created < suiteStart - 2000 || declared < created || declared - created > 120000)
        throw new Error(`Unattested daemon process ${owner.pid} in ${task}`);
      const token = (await readFile(join(dir, "daemon.auth"), "utf8")).trim();
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error(`Invalid Native daemon auth token in ${task}`);
      const ping = await pingOwner(owner.endpoint.path, token);
      if (!ping || ping.pid !== owner.pid || ping.nonce !== owner.nonce || ping.startedAt !== owner.startedAt ||
          ping.endpoint.kind !== owner.endpoint.kind || ping.endpoint.path !== owner.endpoint.path ||
          JSON.stringify(parseOwner(JSON.parse(await readFile(ownerFile, "utf8")))) !== JSON.stringify(owner) ||
          (await identity(owner.pid))?.createdMs !== created)
        throw new Error(`Unattested live daemon owner ${owner.pid} in ${task}`);
      process.kill(owner.pid, "SIGTERM");
      const wait = await powershell(`$p=Get-Process -Id ${owner.pid} -ErrorAction SilentlyContinue; if($p -and -not $p.WaitForExit(10000)){exit 3}; exit 0`);
      if (wait || await identity(owner.pid)) throw new Error(`Owned daemon ${owner.pid} remained after SIGTERM`);
      exits.push({ task, owner, process: previous, signal: "SIGTERM", exitVerified: true });
    }
    return { exits };
  } catch (error) {
    return { exits, error: error instanceof Error ? error.stack ?? error.message : String(error) };
  }
}
