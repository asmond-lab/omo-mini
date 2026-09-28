import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@code-yeongyu/senpi";
import { z } from "zod";
import { MiniError } from "./local.ts";
import { createMiniPeerEnvironment } from "./peer-thread-hosts.ts";
import { movePeer } from "./peer-thread-move.ts";
import { atomicJson, digest, type PeerRecord } from "./peer-thread-records.ts";
import type { Host, Model, Peer, PromptOptions } from "./peer-thread-rpc.ts";
import { checkProviderRequest } from "./policy.ts";
import { LOCAL_PROVIDER } from "./profile.ts";

const activeModel = z.object({ model: z.object({ provider: z.string(), id: z.string() }) }).passthrough();
type Route = { key: string; realId: string; host: Host };
type DiskPeer = {
  durable_id: string; source_host: string; name: string; cwd: string;
  session_path: string; created_at: string; updated_at: string;
};
type OpenPeer = { cwd?: string; name?: string; forkFrom?: string;
  model?: { provider: string; id: string; baseUrl: string; api: string } };

/**
 * The host Native's own thread tools use inside omo-mini. Native keeps routing,
 * receipts, names, delivery and interruption; this adapter only supplies Mini-owned
 * Senpi hosts, records and transcripts, all under the isolated Mini state directory.
 */
export function createMiniPeerHost() {
  const { sessions, permission, profile, records, active, root, current, admittedCwd, eligible, start, recover } =
    createMiniPeerEnvironment();
  const routed = new Map<string, Route>();
  const address = (key: string, id: string) => `${digest(key).slice(0, 16)}:${id}`;
  let disk: DiskPeer[] = [];

  // Native reads diskSessions synchronously right after listSessions, so the listing
  // refreshes this snapshot from Native's own session discovery metadata.
  const refreshDisk = async () => {
    const infos = new Map((await SessionManager.listAll(sessions)).map(info => [realpathSync(info.path), info]));
    disk = records.peerRecords().flatMap(record => {
      if (!existsSync(record.sessionPath)) return [];
      const info = infos.get(records.sourceFile(record.sessionPath));
      if (!info) return [];
      if (info.id !== record.id) throw new MiniError("session", "Mini peer record contradicts its Native session header");
      return [{
        durable_id: record.id, source_host: records.hostSocket(record.key), name: info.name ?? record.name ?? record.id,
        cwd: record.cwd, session_path: info.path,
        created_at: info.created.toISOString(), updated_at: info.modified.toISOString(),
      }];
    });
  };
  const refresh = async () => {
    await recover();
    const peers: Peer[] = [];
    for (const [key, host] of active) {
      for (const peer of await host.listSessions()) {
        const id = address(key, peer.sessionId);
        routed.set(id, { key, realId: peer.sessionId, host });
        peers.push({ ...peer, sessionId: id });
      }
    }
    await refreshDisk();
    // Native renders a missing createdAt as the epoch; report the recorded creation and last write.
    const known = new Map(records.peerRecords().map(record => [record.id, record]));
    const written = new Map(disk.map(entry => [entry.durable_id, entry.updated_at]));
    return peers.map(peer => {
      const record = peer.durableSessionId ? known.get(peer.durableSessionId) : undefined;
      return record ? { ...peer, createdAt: record.createdAt, updatedAt: written.get(record.id) ?? record.createdAt } : peer;
    });
  };
  const target = async (id: string) => {
    await refresh();
    const route = routed.get(id);
    if (!route) throw new MiniError("session", `Mini peer ${id} is not live`);
    return route;
  };
  // Only a recorded Mini peer or a durable session in the isolated session directory.
  const forkSource = async (id: string) => {
    const peer = records.peerRecords().find(item => item.id === id);
    if (peer) return records.sourceFile(peer.sessionPath);
    const session = (await SessionManager.listAll(sessions)).find(item => item.id === id);
    if (session) return records.sourceFile(session.path);
    throw new MiniError("session", `No isolated durable session ${id} exists for fork_from`);
  };
  const on = <T>(call: (route: Route) => Promise<T>) => async (id: string) => call(await target(id));

  return {
    socket: join(records.directory, `mini-peer-${profile}.sock`),
    stateDirectory: join(records.directory, "thread-tools", digest(root).slice(0, 16)),
    diskSessions: () => disk,
    listSessions: refresh,
    async openSession(input: OpenPeer): Promise<Peer> {
      if (!input.model) throw new MiniError("model_selection", "Select a loaded local model before creating a peer");
      checkProviderRequest(input.model, current());
      const cwd = admittedCwd(input.cwd);
      const sessionPath = input.forkFrom
        ? SessionManager.forkFrom(await forkSource(input.forkFrom), cwd, sessions).getSessionFile()
        : undefined;
      const selected = current();
      const { key, host } = await start(input.model.id, selected.context, selected.baseUrl, cwd);
      const peer = await host.openSession({
        cwd, provider: LOCAL_PROVIDER, modelId: input.model.id, permissionPreset: permission,
        ...(sessionPath ? { sessionPath } : {}), ...(input.name ? { name: input.name } : {}),
      });
      if (sessionPath) await host.setModel(peer.sessionId, LOCAL_PROVIDER, input.model.id);
      if (!peer.durableSessionId || !peer.sessionPath)
        throw new MiniError("session", "Native peer has no durable session identity");
      const createdAt = new Date().toISOString();
      const record: PeerRecord = {
        version: 1, id: peer.durableSessionId, key, sessionPath: peer.sessionPath, cwd, createdAt,
        ...(input.name ? { name: input.name } : {}),
      };
      atomicJson(records.peerFile(record.id), record);
      const id = address(key, peer.sessionId);
      routed.set(id, { key, realId: peer.sessionId, host });
      return { ...peer, sessionId: id, createdAt, updatedAt: createdAt };
    },
    async release() {
      const hosts = [...active.values()];
      active.clear();
      routed.clear();
      const failures: unknown[] = [];
      for (const host of hosts) {
        try {
          await host.release();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length) throw new AggregateError(failures, "Mini peer release failed");
    },
    getMessages: on(route => route.host.getMessages(route.realId)),
    getState: on(route => route.host.getState(route.realId)),
    prompt: async (id: string, text: string, options?: PromptOptions) =>
      on(route => route.host.prompt(route.realId, text, options))(id),
    interrupt: async (id: string, turnId?: string) => on(route => route.host.interrupt(route.realId, turnId))(id),
    async setSessionName(id: string, name: string) {
      const route = await target(id);
      const result = await route.host.setSessionName(route.realId, name);
      const live = (await route.host.listSessions()).find(item => item.sessionId === route.realId);
      const record = records.peerRecords().find(item => item.key === route.key && item.sessionPath === live?.sessionPath);
      if (record) atomicJson(records.peerFile(record.id), { ...record, name });
      return result;
    },
    async setModel(id: string, provider: string, modelId: string): Promise<Model> {
      if (provider !== LOCAL_PROVIDER) throw new MiniError("local_only", "Cloud peer model selection is blocked");
      const route = await target(id);
      const previous = records.hostRecords().find(item => item.key === route.key);
      if (!previous) throw new MiniError("profile", "Missing owned Mini peer host record");
      const peer = (await route.host.listSessions()).find(item => item.sessionId === route.realId);
      if (!peer?.durableSessionId || !peer.sessionPath)
        throw new MiniError("session", "Peer cannot be moved without its durable file");
      const original = activeModel.parse(await route.host.getState(route.realId)).model;
      if (original.provider !== LOCAL_PROVIDER) throw new MiniError("local_only", "Peer has no local model to restore");
      const selected = await eligible(modelId, previous.baseUrl);
      // Same guard host: Native's own set_model semantics apply unchanged.
      if (selected.id === previous.modelId && selected.context === previous.context)
        return route.host.setModel(route.realId, provider, selected.id);
      const prior = records.peerRecords().find(item => item.id === peer.durableSessionId);
      if (!prior) throw new MiniError("session", "Peer cannot be moved without its Mini record");
      const destination = await start(selected.id, selected.context, previous.baseUrl, peer.cwd);
      const record: PeerRecord = {
        version: 1, id: peer.durableSessionId, key: destination.key, sessionPath: peer.sessionPath, cwd: peer.cwd,
        createdAt: prior.createdAt,
        ...(peer.name ? { name: peer.name } : {}),
      };
      const moved = await movePeer({
        source: {
          id: route.realId, host: route.host, model: original,
          peer: { ...peer, durableSessionId: peer.durableSessionId, sessionPath: peer.sessionPath },
        },
        destination: { host: destination.host, model: { provider, id: selected.id } },
        permission,
        commit: () => atomicJson(records.peerFile(record.id), record),
      });
      routed.delete(id);
      routed.set(address(destination.key, moved.sessionId), {
        key: destination.key, realId: moved.sessionId, host: destination.host,
      });
      return { provider, id: selected.id };
    },
    getAvailableModels: on(route => route.host.getAvailableModels(route.realId)),
    setThinkingLevel: async (id: string, level: string, scope?: string) =>
      on(route => route.host.setThinkingLevel(route.realId, level, scope))(id),
    getAvailableThinkingLevels: on(route => route.host.getAvailableThinkingLevels(route.realId)),
  };
}
