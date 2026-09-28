import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stopOwnedWindowsTree } from "./native-context-recovery-owned-windows.ts";

type Frame = { type: string; id?: string; success?: boolean; method?: string; title?: string; options?: string[];
  toolCallId?: string; isError?: boolean; result?: { details?: { jsonOutputs?: { closed?: { worker_spec?: { start?: { execution_mode?: string }; plan?: { model?: string } } } }[] } };
  messages?: { role?: string; details?: { customType?: string | undefined; details?: { results?: { key?: string; data?: { answer?: string }; error?: unknown }[] } }[] }[] };
type Wire = { model: string; messages: { role: string; content?: unknown; tool_call_id?: string | undefined }[];
  tools: { function: { name: string; parameters?: { properties?: { op?: { const?: string | undefined } } } } }[] };
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function object(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw Error("Invalid Native object");
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string") throw Error("Invalid Native string");
  return value;
}
function optionalText(value: unknown): string | undefined { return value === undefined ? undefined : text(value); }
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw Error("Invalid Native array");
  return value;
}
function parseWire(value: unknown): Wire {
  const wire = object(value);
  return { model: text(wire["model"]), messages: list(wire["messages"]).map(value => {
    const m = object(value);
    return { role: text(m["role"]), content: m["content"], tool_call_id: optionalText(m["tool_call_id"]) };
  }), tools: wire["tools"] === undefined ? [] : list(wire["tools"]).map(value => {
    const fn = object(object(value)["function"]), parameters = fn["parameters"] === undefined ? undefined : object(fn["parameters"]);
    const properties = parameters?.["properties"] === undefined ? undefined : object(parameters["properties"]);
    const op = properties?.["op"] === undefined ? undefined : object(properties["op"]);
    return { function: { name: text(fn["name"]), parameters: { properties: { op: { const: optionalText(op?.["const"]) } } } } };
  }) };
}
function parseFrame(value: unknown): Frame {
  const frame = object(value), type = text(frame["type"]);
  if (type === "extension_ui_request") {
    const method = optionalText(frame["method"]), title = optionalText(frame["title"]);
    if (method !== "select" || !title?.startsWith("Permission required: ")) return { type };
    return { type, id: text(frame["id"]), method, title, options: list(frame["options"]).map(text) };
  }
  if (type === "response") {
    if (typeof frame["success"] !== "boolean") throw Error("Invalid Native response success");
    return { type, id: text(frame["id"]), success: frame["success"] };
  }
  if (type === "tool_execution_end") {
    if (frame["toolCallId"] !== "pool-eval") return { type, toolCallId: text(frame["toolCallId"]) };
    if (typeof frame["isError"] !== "boolean") throw Error("Invalid Native tool result error flag");
    const result = object(frame["result"]), details = object(result["details"]);
    return { type, toolCallId: text(frame["toolCallId"]), isError: frame["isError"], result: { details: {
      jsonOutputs: list(details["jsonOutputs"]).map(value => {
        const output = object(value);
        if (output["closed"] === undefined) return {};
        const spec = object(object(output["closed"])["worker_spec"]);
        return { closed: { worker_spec: { start: { execution_mode: text(object(spec["start"])["execution_mode"]) },
          plan: { model: text(object(spec["plan"])["model"]) } } } };
      }),
    } } };
  }
  if (type === "agent_end") return { type, messages: list(frame["messages"]).map(value => {
    const message = object(value), role = text(message["role"]);
    if (role !== "custom") return { role };
    if (!Array.isArray(message["details"])) return { role };
    return { role, details: list(message["details"]).map(value => {
      const item = object(value), customType = optionalText(item["customType"]);
      if (customType !== "senpi-task.workpool-aggregate") return { customType };
      const details = object(item["details"]);
      return { customType, details: { results: list(details["results"]).map(value => {
        const entry = object(value), data = entry["data"] === undefined ? undefined : object(entry["data"]);
        return { key: text(entry["key"]), ...(data === undefined ? {} : { data: { answer: text(data["answer"]) } }),
          ...(entry["error"] === undefined ? {} : { error: entry["error"] }) };
      }) } };
    }) };
  }) };
  return { type };
}

// Synthetic model responses only. Workpool admission, PROCESS child, yield, and aggregate run in Native.
test("PROCESS workpool child yields one keyed item to its local parent", async () => {
  const base = await mkdtemp(join(tmpdir(), "omo-process-workpool-test-"));
  // The workspace lives inside the fixture HOME: the child's project-config walk stops
  // there and never reaches the real user's ~/.omo above the temp directory.
  const home = join(base, "home"), root = join(home, "ws"), temp = join(base, "temp"), state = join(base, "state");
  await mkdir(join(root, ".omo"), { recursive: true }); await mkdir(temp);
  await writeFile(join(root, ".omo", "omo.json"), JSON.stringify({ task: {
    default_execution_mode: "process", process_runner: "child-process",
  } }));
  const model = "pool-local-instance", key = "one-key", input = "one-input", answer = "one-result";
  const calls: { kind: string; body?: Wire; path: string }[] = [];
  const listeners = new Set<(frame: Frame) => void>();
  const pending = new Set<(error: Error) => void>();
  let buffer = "", stderr = "", primary: unknown, protocolError: Error | undefined, ownedClosed = false, aggregateDelivered = false;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let child: ReturnType<typeof spawn> | undefined, closed: Promise<void> | undefined;
  const workerPrompt = `Yield assigned ${key} as {"answer":"${answer}"}; do not create another pool.`;
  const code = `const p=await workpool({category:"quick",prompt:${JSON.stringify(workerPrompt)}},"one-pool",{mode:"fresh"});` +
    `display({pushed:(await p.push([{key:${JSON.stringify(key)},input:${JSON.stringify(input)}}])).details});` +
    `display({closed:(await p.close()).details});`;
  function reply(delta: object, finish: "stop" | "tool_calls") {
    return new Response(`data: ${JSON.stringify({ id: "pool-fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "pool-fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  }
  function tool(id: string, name: string, args: object) {
    return reply({ tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, "tool_calls");
  }
  try {
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/api/v1/models") return Response.json({ models: [{ key: model, type: "llm", max_context_length: 131072,
        capabilities: { trained_for_tool_use: true, vision: false }, loaded_instances: [{ id: model, config: { context_length: 65536 } }] }] });
      if (path !== "/v1/chat/completions") { calls.push({ kind: "unexpected", path }); return new Response("not found", { status: 404 }); }
      const body = parseWire(await request.json()), messages = body.messages;
      const worker = messages.some(m => m.role === "user" && JSON.stringify(m.content ?? "").includes(input)) ||
        body.tools.some(t => t.function.name === "workpool" && t.function.parameters?.properties?.op?.const === "yield");
      const aggregate = !worker && messages.some(m => m.role === "user" && JSON.stringify(m.content ?? "").includes(key) &&
        (JSON.stringify(m.content ?? "").includes(answer) || JSON.stringify(m.content ?? "").includes("item_missing_yield")));
      const reinjected = !worker && !aggregate && messages.some(m => m.role === "tool" && m.tool_call_id === "pool-eval");
      calls.push({ kind: worker ? "worker" : aggregate ? "aggregate" : reinjected ? "reinjected" : "parent", body, path });
      if (body.model !== model) return new Response("wrong local model", { status: 400 });
      if (aggregate) return reply({ content: "Aggregate delivered." }, "stop");
      if (reinjected) return reply({ content: "Await keyed aggregate." }, "stop");
      if (worker) {
        if (messages.some(m => m.role === "tool" && m.tool_call_id === "pool-yield")) return reply({ content: "Worker complete." }, "stop");
        return tool("pool-yield", "workpool", { op: "yield", results: [{ key, data: { answer } }] });
      }
      return tool("pool-eval", "eval", { language: "js", code, summary: "Queue and close one PROCESS workpool item" });
    } });
    const spawned = spawn(process.execPath, ["src/cli.ts", "rpc", "--root", root, "--state-dir", state,
      "--base-url", `http://127.0.0.1:${server.port}/v1`, "--model", model], { cwd: resolve(import.meta.dir, ".."),
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      env: { ...process.env, HOME: home, USERPROFILE: home, TEMP: temp, TMP: temp,
        PI_CODING_AGENT_DIR: join(state, "agent"), OMO_CODING_AGENT_DIR: join(state, "agent"),
        PI_PROVIDER: "cloud-canary", PI_MODEL: "cloud-canary", OPENAI_API_KEY: "cloud-canary-unusable" } });
    child = spawned;
    closed = new Promise<void>((accept, reject) => { spawned.once("close", () => accept()); spawned.once("error", reject); });
    void closed.catch(() => {}); // Finally awaits this same promise; prevent an early unhandled rejection.
    function wait(match: (frame: Frame) => boolean, label: string): Promise<Frame> {
      const signal = new Promise<Frame>((accept, reject) => {
        const clear = () => { clearTimeout(timer); listeners.delete(onFrame); spawned.off("exit", onExit); pending.delete(cancel); };
        const cancel = (error: Error) => { clear(); reject(error); };
        const onExit = () => cancel(Error(`${label}: RPC exited: ${stderr.slice(-700)}`));
        const onFrame = (frame: Frame) => { if (match(frame)) { clear(); accept(frame); } };
        const timer = setTimeout(() => cancel(Error(`${label}: Native deadline: ${JSON.stringify(calls.map(c => c.kind))} ${stderr.slice(-700)}`)), 55000);
        listeners.add(onFrame); spawned.once("exit", onExit); pending.add(cancel);
      });
      void signal.catch(() => {});
      return signal;
    }
    spawned.stderr.on("data", chunk => { stderr += chunk.toString(); });
      spawned.stdout.on("data", chunk => {
        try {
          buffer += chunk.toString(); let end: number;
          while ((end = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
            if (!line.startsWith("{")) continue;
            const value: unknown = JSON.parse(line), frame = parseFrame(value);
            if (frame.type === "extension_ui_request" && frame.method === "select" && frame.title?.startsWith("Permission required: ")) {
              if (!frame.options?.includes("Allow once") || !frame.id) throw Error("Native approval lacks verified ID / Allow once");
              spawned.stdin.write(JSON.stringify({ type: "extension_ui_response", id: frame.id, value: "Allow once" }) + "\n");
            }
            for (const listener of listeners) listener(frame);
          }
        } catch (error) {
          protocolError = error instanceof Error ? error : Error(String(error));
          for (const cancel of [...pending]) cancel(protocolError);
        }
      });
      const finished = wait(f => f.type === "tool_execution_end" && f.toolCallId === "pool-eval", "pool create/push/close");
      const aggregate = wait(f => f.type === "agent_end" && f.messages?.some(m => m.role === "custom" && m.details?.some(d => d.customType === "senpi-task.workpool-aggregate")) === true, "one keyed aggregate");
      const response = wait(f => f.type === "response" && f.id === "1", "RPC prompt");
      spawned.stdin.write(JSON.stringify({ id: "1", type: "prompt", message: "Queue one PROCESS workpool item and report the aggregate." }) + "\n");
      expect((await response).success).toBe(true);
      const result = await finished;
      expect(result.isError, JSON.stringify(result.result)).toBe(false);
      const closedRecord = result.result?.details?.jsonOutputs?.find(output => output.closed)?.closed;
      expect(closedRecord?.worker_spec?.start?.execution_mode).toBe("process");
      expect(closedRecord?.worker_spec?.plan?.model).toBe(`omo-mini-local/${model}`);
      const end = await aggregate;
      const deliveries = end.messages?.flatMap(m => m.role === "custom" ? m.details?.filter(d => d.customType === "senpi-task.workpool-aggregate") ?? [] : [])
        .flatMap(d => d.details?.results ?? []);
      expect(deliveries).toEqual([{ key, data: { answer } }]);
      aggregateDelivered = true; // Native has terminal delivery for this one keyed item; RPC shutdown owns its PROCESS worker.
      expect(calls.some(c => c.kind === "worker" && c.body?.tools.some(t => t.function.name === "workpool" && t.function.parameters?.properties?.op?.const === "yield"))).toBe(true);
      expect(calls.filter(c => c.body).every(c => c.body?.model === model && c.path === "/v1/chat/completions")).toBe(true);
      expect(calls.some(c => c.kind === "aggregate")).toBe(true);
  } catch (error) { primary = error; }
  finally {
      for (const cancel of [...pending]) cancel(Error("Owned workpool fixture stopped"));
      const failures: unknown[] = protocolError === undefined || primary === protocolError ? [] : [protocolError];
      const waitClosed = async (signal: Promise<void>, label: string) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([signal, new Promise<never>((_accept, reject) => {
          timer = setTimeout(() => reject(Error(label)), 10000);
        })]); } finally { if (timer) clearTimeout(timer); }
      };
      try {
        if (child) {
          if (!closed) throw Error("RPC close signal was not installed");
          if (process.platform === "win32") {
            if (child.exitCode !== null || child.signalCode !== null) throw Error("RPC parent exited before descendant snapshot; closure unverified");
            const pid = child.pid;
            if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid < 1) throw Error("RPC has no attested PID");
            await stopOwnedWindowsTree(pid);
          } else {
            if (!child.stdin) throw Error("Owned RPC stdin unavailable");
            child.stdin.end(); // Allow Native to shut down its PROCESS worker and RPC together.
          }
          await waitClosed(closed, "Owned PROCESS RPC did not close");
          if (process.platform !== "win32" && !aggregateDelivered)
            throw Error("Native PROCESS terminal delivery unverified; descendants may remain");
        }
        ownedClosed = true;
      } catch (error) {
        failures.push(error);
        // An attestation failure is not permission to leave the direct child running.
        // Its close alone does NOT verify descendants: retain scratch in this path.
        if (child && closed) {
          try {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
            await waitClosed(closed, "Failed owned RPC direct child did not close");
          } catch (failure) { failures.push(failure); }
        }
      }
      try { server?.stop(true); } catch (error) { failures.push(error); }
      if (ownedClosed) {
        try { await rm(base, { recursive: true, force: true }); } catch (error) { failures.push(error); }
      } else failures.push(Error(`Owned closure unverified; scratch retained: ${base}`));
      if (primary !== undefined || failures.length) {
        if (failures.length === 0) throw primary;
        throw new AggregateError(primary === undefined ? failures : [primary, ...failures], "PROCESS workpool assertion / cleanup failures");
      }
    }
}, 120000);
