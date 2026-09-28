import { createHash, randomUUID } from "node:crypto";
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";
import { MiniError } from "./local.ts";

const hostSchema = z.object({
  version: z.literal(1),
  key: z.string().min(1),
  profile: z.string().min(1),
  socket: z.string().min(1),
  instanceId: z.string().min(1),
  modelId: z.string().min(1),
  context: z.number().int().positive(),
  baseUrl: z.string().min(1),
  cwd: z.string().min(1),
}).strict();
const peerSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  key: z.string().min(1),
  sessionPath: z.string().min(1),
  cwd: z.string().min(1),
  name: z.string().optional(),
  createdAt: z.iso.datetime(),
}).strict();
export type HostRecord = z.infer<typeof hostSchema>;
export type PeerRecord = z.infer<typeof peerSchema>;

export const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export function inside(base: string, path: string): boolean {
  const step = relative(base, path);
  return step === "" || (step !== ".." && !step.startsWith(`..${sep}`) && !isAbsolute(step));
}

function readChecked<T>(path: string, schema: z.ZodType<T>): T {
  if (!lstatSync(path).isFile()) throw new MiniError("profile", `Non-file Mini peer record at ${path}`);
  return schema.parse(JSON.parse(readFileSync(path, "utf8")));
}

/** Replace a record in one rename; a failed rename leaves the previous record bytes intact. */
export function atomicJson(path: string, value: object): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value) + "\n", { flag: "wx", mode: 0o600 });
  try {
    renameSync(temporary, path);
  } catch (error) {
    try {
      rmSync(temporary, { force: true });
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], `Mini record write and cleanup failed: ${String(error)}`);
    }
    throw error;
  }
}

/** Host and peer records live only under the isolated Mini agent RPC directory. */
export function createPeerRecords(agent: string, sessions: string, profile: string) {
  const directory = join(agent, "rpc", "mini-peers");
  const hostsDir = join(directory, "hosts");
  const peersDir = join(directory, "peers");
  const hostKey = (modelId: string, context: number, baseUrl: string, cwd: string) =>
    JSON.stringify({ profile, modelId, context, baseUrl, cwd });
  const hostFile = (key: string) => join(hostsDir, `${digest(key)}.json`);
  const peerFile = (id: string) => join(peersDir, `${digest(id)}.json`);
  const hostSocket = (key: string) =>
    join(agent, "rpc", `mini-peer-${profile.slice(0, 10)}-${digest(key).slice(0, 20)}.sock`);

  const hostRecords = (): HostRecord[] => {
    if (!existsSync(hostsDir)) return [];
    return readdirSync(hostsDir, { withFileTypes: true })
      .filter(entry => entry.name.endsWith(".json"))
      .flatMap(entry => {
        const path = join(hostsDir, entry.name);
        const record = readChecked(path, hostSchema);
        if (hostFile(record.key) !== path)
          throw new MiniError("profile", "Mini peer host record name does not match its key");
        if (record.profile !== profile) return [];
        // A record can never redirect Mini to a socket outside its own namespace.
        if (record.socket !== hostSocket(record.key))
          throw new MiniError("profile", "Mini peer host escaped its isolated socket namespace");
        return [record];
      });
  };

  const peerRecords = (): PeerRecord[] => {
    if (!existsSync(peersDir)) return [];
    return readdirSync(peersDir, { withFileTypes: true })
      .filter(entry => entry.name.endsWith(".json"))
      .map(entry => {
        const path = join(peersDir, entry.name);
        const record = readChecked(path, peerSchema);
        if (peerFile(record.id) !== path)
          throw new MiniError("profile", "Mini peer record name does not match its durable identity");
        return record;
      });
  };

  /** Canonical transcript path, confined to the isolated Mini session roots. */
  const sourceFile = (path: string) => {
    const file = realpathSync(path);
    if (!inside(agent, file) && !inside(sessions, file))
      throw new MiniError("session", "Session file is outside isolated Mini sessions");
    return file;
  };

  return { directory, hostKey, hostFile, peerFile, hostSocket, hostRecords, peerRecords, sourceFile };
}
