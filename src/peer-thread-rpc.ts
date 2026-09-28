import { RpcClient } from "@code-yeongyu/senpi";
import { z } from "zod";
import { MiniError } from "./local.ts";

export type Peer = {
  sessionId: string;
  durableSessionId?: string;
  sessionPath?: string;
  cwd: string;
  name?: string;
  /** ISO times Native reports as created_at/updated_at; the adapter fills them from its records. */
  createdAt?: string;
  updatedAt?: string;
};
export type LivePeer = Peer & { durableSessionId: string; sessionPath: string };
export type PromptOptions = { streamingBehavior?: "steer" | "followUp" };
export type OpenInput = {
  cwd: string;
  provider: string;
  modelId: string;
  permissionPreset: string;
  sessionPath?: string;
  name?: string;
};
export type Model = { provider: string; id: string };
export type Host = {
  socket: string;
  listSessions(): Promise<Peer[]>;
  openSession(input: OpenInput): Promise<Peer>;
  closeSession(id: string): Promise<void>;
  closeIfIdle(id: string): Promise<void>;
  release(): Promise<void>;
  getMessages(id: string): Promise<unknown>;
  getState(id: string): Promise<unknown>;
  prompt(id: string, message: string, options?: PromptOptions): Promise<unknown>;
  interrupt(id: string, turnId?: string): Promise<unknown>;
  setSessionName(id: string, name: string): Promise<unknown>;
  setModel(id: string, provider: string, modelId: string): Promise<Model>;
  getAvailableModels(id: string): Promise<{ provider: string; id: string; name?: string }[]>;
  setThinkingLevel(id: string, level: string, scope?: string): Promise<unknown>;
  getAvailableThinkingLevels(id: string): Promise<unknown>;
};

/** A failed open whose session may still own the durable transcript. */
export class UnclosedPeerError extends AggregateError {}

const promptResult = z.object({ turnId: z.string().optional() }).passthrough();
const interruptResult = z.object({
  interrupted: z.boolean().optional(),
  turnId: z.string().optional(),
}).passthrough();
const modelResult = z.object({ provider: z.string(), id: z.string() }).passthrough();

/**
 * One owned Mini peer host. The pinned Senpi client owns the socket handshake; every
 * session is addressed through its own attachment so Native's ownership checks apply.
 */
export async function connectPeerHost(socket: string): Promise<Host> {
  const control = new RpcClient({ socketPath: socket });
  await control.start();
  const clients = new Map<string, RpcClient>();
  const pending = new Map<string, Promise<RpcClient>>();

  const clientFor = (id: string): Promise<RpcClient> => {
    const known = clients.get(id);
    if (known) return Promise.resolve(known);
    const inflight = pending.get(id);
    if (inflight) return inflight;
    const work = (async () => {
      const peer = (await control.listSessions()).find(entry => entry.sessionId === id);
      if (!peer?.sessionPath) throw new MiniError("session", `No live Native peer ${id} to attach`);
      const client = new RpcClient({ socketPath: socket });
      await client.start();
      try {
        const opened = await client.openSession({ sessionPath: peer.sessionPath, cwd: peer.cwd });
        if (opened.sessionId !== id) throw new MiniError("session", "Native peer attachment changed identity");
        clients.set(id, client);
        return client;
      } catch (error) {
        await client.stop();
        throw error;
      }
    })();
    pending.set(id, work);
    void work.then(() => pending.delete(id), () => pending.delete(id));
    return work;
  };

  const close = async (id: string, idleOnly: boolean) => {
    const client = await clientFor(id);
    // if_idle: the host refuses with session_busy unless this is the only attachment
    // and the session owns no turn, bash, compaction or background work.
    if (idleOnly) await client.requestSession({ type: "close_session", if_idle: true }, id);
    else await client.closeSession(id);
    clients.delete(id);
    await client.stop();
  };

  return {
    socket,
    listSessions: () => control.listSessions(),
    async openSession(input) {
      const client = new RpcClient({ socketPath: socket });
      await client.start();
      let openedId: string | undefined;
      try {
        const opened = await client.openSession({
          cwd: input.cwd,
          provider: input.provider,
          modelId: input.modelId,
          permissionPreset: input.permissionPreset,
          ...(input.sessionPath ? { sessionPath: input.sessionPath } : {}),
          retain_on_disconnect: true,
        });
        openedId = opened.sessionId;
        clients.set(openedId, client);
        if (input.name) await client.requestSession({ type: "set_session_name", name: input.name }, openedId);
        const listed = (await control.listSessions()).find(peer => peer.sessionId === openedId);
        if (!listed) throw new MiniError("session", "Native host did not list the newly opened peer");
        return listed;
      } catch (error) {
        const failures: unknown[] = [error];
        let unclosed = false;
        if (openedId) {
          const id = openedId;
          clients.delete(id);
          try {
            await client.closeSession(id);
            unclosed = (await control.listSessions()).some(peer => peer.sessionId === id);
            if (unclosed) failures.push(new MiniError("session", "Opened peer still owns its transcript"));
          } catch (cleanup) {
            unclosed = true;
            failures.push(cleanup);
          }
        }
        try {
          await client.stop();
        } catch (stopError) {
          failures.push(stopError);
        }
        if (unclosed) throw new UnclosedPeerError(failures, `Native peer open left a writer: ${String(error)}`);
        if (failures.length > 1) throw new AggregateError(failures, `Native peer open and cleanup failed: ${String(error)}`);
        throw error;
      }
    },
    closeSession: id => close(id, false),
    closeIfIdle: id => close(id, true),
    async release() {
      const failures: unknown[] = [];
      for (const client of [...clients.values(), control]) {
        try {
          await client.stop();
        } catch (error) {
          failures.push(error);
        }
      }
      clients.clear();
      if (failures.length) throw new AggregateError(failures, "Mini peer host release failed");
    },
    getMessages: async id => (await clientFor(id)).getMessages(),
    getState: async id => (await clientFor(id)).getState(),
    prompt: async (id, message, options) => promptResult.parse(
      await (await clientFor(id)).requestSession({ type: "prompt", message, ...options }, id)),
    interrupt: async (id, turnId) => interruptResult.parse(
      await (await clientFor(id)).requestSession({ type: "interrupt", ...(turnId ? { turnId } : {}) }, id)),
    setSessionName: async (id, name) =>
      (await clientFor(id)).requestSession({ type: "set_session_name", name }, id),
    setModel: async (id, provider, modelId) => modelResult.parse(
      await (await clientFor(id)).requestSession({ type: "set_model", provider, modelId }, id)),
    getAvailableModels: async id => (await clientFor(id)).getAvailableModels(),
    setThinkingLevel: async (id, level, scope) => (await clientFor(id)).requestSession(
      { type: "set_thinking_level", level, ...(scope === "turn" ? { scope } : {}) }, id),
    getAvailableThinkingLevels: async id => (await clientFor(id)).getAvailableThinkingLevels(),
  };
}
