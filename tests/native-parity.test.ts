import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type Frame = { type: string; id?: string; method?: string; title?: string; options?: string[];
  success?: boolean; data?: Record<string, unknown>; messages?: unknown[];
  toolCallId?: string; isError?: boolean; result?: { content?: unknown } };
type Wire = { tools?: { function?: { name?: string; parameters?: unknown } }[];
  messages?: { role?: string; tool_call_id?: string; content?: unknown }[] };

// Real mini launcher -> Native RPC -> stdio MCP; only the model HTTP wire is simulated.
test("Native MCP call and eval schema lookup execute with permission and reinject results", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-mini-native-parity-"));
  const agent = join(root, "state", "agent");
  const requests: Wire[] = [];
  const modelRoutes: string[] = [];
  const frames: Frame[] = [];
  const listeners = new Set<(frame: Frame) => void>();
  let child: ReturnType<typeof spawn> | undefined;
  let stderr = "", buffer = "", nextId = 0;
  const approvals: string[] = [];
  const tail = "MCP-TAIL-719";
  // Over the removed 6000-char mini truncation; under Native's 8192-token
  // single-result admission floor, which intentionally projects larger output.
  const expectedResult = "MCP-PARITY-719" + "X".repeat(7168) + tail;
  const mcp = `process.stdin.setEncoding("utf8"); let pending="";
    process.stdin.on("data", chunk => { pending += chunk; let end;
      while ((end = pending.indexOf("\\n")) !== -1) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        if (!line.trim()) continue;
        const request = JSON.parse(line);
        if (request.id === undefined) continue;
        let result;
        if (request.method === "initialize") result = {protocolVersion:"2025-03-26",capabilities:{tools:{}},serverInfo:{name:"parity",version:"1.0.0"}};
        else if (request.method === "tools/list") result = {tools:[{name:"echo",description:"Return fixture value",inputSchema:{type:"object",properties:{value:{type:"string"}},required:["value"]}}]};
        else if (request.method === "tools/call") result = {content:[{type:"text",text:"MCP-PARITY-" + request.params.arguments.value + "X".repeat(7168) + "MCP-TAIL-719"}]};
        else result = {};
        process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:request.id,result}) + "\\n");
      }
    });`;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/api/v")) modelRoutes.push(path);
    if (path === "/api/v0/models") return Response.json({ data: [{ id: "parity-local", state: "loaded", type: "llm", loaded_context_length: 65536, capabilities: ["tool_use"] }] });
    // Native's downloaded-model startup may use v1; keep v0 only for legacy discovery.
    // The advertised max deliberately differs from the effective loaded instance context.
    if (path === "/api/v1/models") return Response.json({ models: [{
      key: "parity-local", type: "llm", max_context_length: 262144,
      capabilities: { trained_for_tool_use: true, vision: false },
      loaded_instances: [{ id: "parity-local", config: { context_length: 65536 } }],
    }] });
    if (path === "/api/v1/models/load" && request.method === "POST") {
      expect(await request.json()).toMatchObject({ model: "parity-local" });
      return Response.json({ instance_id: "parity-local", load_config: { context_length: 65536 } });
    }
    if (path !== "/v1/chat/completions") return new Response("Not Found", { status: 404 });
    requests.push(await request.json() as Wire);
    const call = requests.length === 1;
    const evalCall = requests.length === 2;
    const delta = call
      ? { tool_calls: [{ index: 0, id: "mcp-call-1", type: "function", function: { name: "mcp_parity_echo", arguments: '{"value":"719"}' } }] }
      : evalCall
      ? { tool_calls: [{ index: 0, id: "eval-call-1", type: "function", function: { name: "eval", arguments: JSON.stringify({
          language: "js",
          code: `const schema = await tool_schema("mcp_parity_echo");
            if (schema.name !== "mcp_parity_echo" || schema.parameters?.properties?.value?.type !== "string" ||
                !schema.parameters?.required?.includes("value")) throw new Error("Wrong active MCP tool schema");
            print(JSON.stringify({ name: schema.name, valueType: schema.parameters.properties.value.type,
              required: schema.parameters.required }));`,
          summary: "Inspect the active local MCP tool schema in eval.",
        }) } }] }
      : { content: "Parity complete." };
    return new Response(`data: ${JSON.stringify({ id: "parity", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "parity", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: call || evalCall ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  function wait(predicate: (frame: Frame) => boolean): Promise<Frame> {
    return new Promise((accept, reject) => {
      const timer = setTimeout(() => { listeners.delete(onFrame); reject(new Error(`Native RPC timeout; ${stderr.slice(-1200)}`)); }, 30000);
      const onFrame = (frame: Frame) => { if (predicate(frame)) { clearTimeout(timer); listeners.delete(onFrame); accept(frame); } };
      listeners.add(onFrame);
    });
  }
  function send(type: string, extra: Record<string, unknown> = {}): Promise<Frame> {
    const id = String(++nextId);
    const answer = wait(frame => frame.type === "response" && frame.id === id);
    child!.stdin!.write(JSON.stringify({ id, type, ...extra }) + "\n");
    return answer;
  }
  try {
    await mkdir(agent, { recursive: true });
    await writeFile(join(agent, "mcp.json"), JSON.stringify({ mcpServers: { parity: {
      command: process.execPath, args: ["--eval", mcp], lifecycle: "eager", startupTimeoutMs: 3000,
      exposure: "direct", directTools: true,
    } } }));
    child = spawn(process.execPath, ["src/cli.ts", "rpc", "--root", root, "--state-dir", join(root, "state"), "--base-url", `http://127.0.0.1:${server.port}/v1`],
      { cwd: resolve(import.meta.dir, ".."), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let end = buffer.indexOf("\n");
      while (end >= 0) {
        const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
        if (line.startsWith("{")) {
          const frame = JSON.parse(line) as Frame;
          frames.push(frame);
          const tool = /^Permission required: (mcp_parity_echo|eval)\n/.exec(frame.title ?? "")?.[1];
          if (frame.type === "extension_ui_request" && frame.method === "select" && tool) {
            expect(frame.options).toContain("Allow once");
            approvals.push(tool);
            // Respond to the real Native permission boundary; never bypass approval globally.
            child!.stdin!.write(JSON.stringify({ type: "extension_ui_response", id: frame.id, value: "Allow once" }) + "\n");
          }
          for (const listener of listeners) listener(frame);
        }
        end = buffer.indexOf("\n");
      }
    });
    const commands = await send("get_commands");
    expect(commands.success).toBe(true);
    const rows = commands.data?.["commands"] as { name: string; source: string }[];
    for (const name of ["tasks", "dag", "loop"]) expect(rows.some(row => row.name === name && row.source === "extension")).toBe(true);
    expect(rows.some(row => row.name === "skill:programming" && row.source === "skill")).toBe(true);
    const surfaces = await send("get_loaded_surfaces");
    expect(surfaces.success).toBe(true);
    const mcpServers = surfaces.data?.["mcpServers"] as { name: string; toolCount: number; status: string }[];
    expect(mcpServers.some(entry => entry.name === "parity" && entry.toolCount === 1 && entry.status === "connected"), `MCP inventory: ${JSON.stringify(mcpServers)}; stderr: ${stderr.slice(-1200)}`).toBe(true);
    const ended = wait(frame => frame.type === "agent_end");
    expect((await send("prompt", { message: "Call parity echo with value 719 and report the result." })).success).toBe(true);
    await ended;
    const names = requests[0]?.tools?.map(tool => tool.function?.name);
    for (const name of ["eval", "task", "workpool"]) expect(names).toContain(name);
    const schema = requests[0]?.tools?.find(tool => tool.function?.name === "mcp_parity_echo")?.function?.parameters;
    expect(schema).toMatchObject({ properties: { value: { type: "string" } }, required: ["value"] });
    expect(modelRoutes).toContain("/api/v1/models");
    expect(modelRoutes).not.toContain("/api/v0/models");
    expect(approvals).toEqual(["mcp_parity_echo", "eval"]);
    expect(requests).toHaveLength(3);
    const mcpResult = requests[1]?.messages?.find(message => message.role === "tool" && message.tool_call_id === "mcp-call-1");
    expect(Buffer.byteLength(expectedResult, "utf8")).toBeGreaterThan(7000);
    expect(mcpResult?.content).toBe(expectedResult);
    expect((mcpResult?.content as string).endsWith(tail)).toBe(true);
    const evalResult = frames.find(frame => frame.type === "tool_execution_end" && frame.toolCallId === "eval-call-1");
    expect(evalResult).toMatchObject({ isError: false });
    const reinjected = requests[2]?.messages?.find(message => message.role === "tool" && message.tool_call_id === "eval-call-1");
    expect(reinjected).toBeDefined();
    expect(typeof reinjected?.content).toBe("string");
    expect(reinjected?.content as string).toContain('{"name":"mcp_parity_echo","valueType":"string","required":["value"]}');
    expect(JSON.stringify(frames.filter(frame => frame.type === "agent_end").at(-1))).toContain("Parity complete.");
  } finally {
    if (child && child.exitCode === null) {
      const exited = new Promise<void>((accept, reject) => {
        const timer = setTimeout(() => reject(new Error("Native parity RPC did not stop")), 10000);
        child!.once("exit", () => { clearTimeout(timer); accept(); });
      });
      child.stdin?.end(); child.kill(); await exited;
    }
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 90000);
