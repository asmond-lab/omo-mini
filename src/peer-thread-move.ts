import { MiniError } from "./local.ts";
import { UnclosedPeerError, type Host, type LivePeer, type Model, type Peer } from "./peer-thread-rpc.ts";

type Side = { host: Host; model: Model };

async function listed(host: Host, id: string): Promise<boolean> {
  return (await host.listSessions()).some(peer => peer.sessionId === id);
}

async function select(host: Host, id: string, model: Model): Promise<void> {
  const selected = await host.setModel(id, model.provider, model.id);
  if (selected.provider !== model.provider || selected.id !== model.id)
    throw new MiniError("model_selection", `Native peer did not select ${model.provider}/${model.id}`);
}

/**
 * Move one durable peer transcript to another owned local-model host.
 * Invariant: on any failure exactly one live writer remains - the original peer on its
 * original host with its original model - unless a destination writer cannot be proven
 * closed, in which case the source is NOT reopened and every failure is reported.
 */
export async function movePeer(input: {
  source: Side & { id: string; peer: LivePeer };
  destination: Side;
  permission: string;
  commit(): void;
}): Promise<Peer> {
  const { source, destination, permission, commit } = input;
  const peer = source.peer;
  const open = (side: Side) => side.host.openSession({
    cwd: peer.cwd,
    provider: side.model.provider,
    modelId: side.model.id,
    permissionPreset: permission,
    sessionPath: peer.sessionPath,
    ...(peer.name ? { name: peer.name } : {}),
  });
  const restore = async () => {
    const restored = await open(source);
    // The transcript now ends with the destination's model_change; select the original again.
    await select(source.host, restored.sessionId, source.model);
  };

  // Native refuses with session_busy unless this is the only attachment and the session
  // owns no turn, bash, compaction or background work, so a live turn is never aborted.
  try {
    await source.host.closeIfIdle(source.id);
  } catch (error) {
    let live: boolean;
    try {
      live = await listed(source.host, source.id);
    } catch (check) {
      throw new AggregateError([error, check], `Could not verify the source peer after a refused close: ${String(error)}`);
    }
    if (!live) {
      try {
        await restore();
      } catch (rollback) {
        throw new AggregateError([error, rollback], `Could not restore the source peer after its close: ${String(error)}`);
      }
    }
    throw error;
  }

  let moved: Peer | undefined;
  try {
    moved = await open(destination);
    await select(destination.host, moved.sessionId, destination.model);
    commit();
    return moved;
  } catch (error) {
    const failures: unknown[] = [error];
    let writerClosed = !(error instanceof UnclosedPeerError);
    if (moved) {
      try {
        await destination.host.closeSession(moved.sessionId);
        writerClosed = !(await listed(destination.host, moved.sessionId));
        if (!writerClosed) failures.push(new MiniError("session", "Destination peer still owns the transcript"));
      } catch (cleanup) {
        writerClosed = false;
        failures.push(cleanup);
      }
    }
    if (writerClosed) {
      try {
        await restore();
      } catch (rollback) {
        failures.push(rollback);
      }
    } else {
      failures.push(new MiniError("session", "Source peer was not reopened: a destination writer may be live"));
    }
    if (failures.length > 1) throw new AggregateError(failures, `Mini peer move failed: ${String(error)}`);
    throw error;
  }
}
