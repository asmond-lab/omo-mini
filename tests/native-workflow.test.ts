import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type Frame = { type: string; id?: string; success?: boolean; method?: string; title?: string; options?: string[];
  toolCallId?: string; isError?: boolean; result?: { content?: unknown }; messages?: unknown[] };
type Chat = { model?: string; messages?: { role?: string; tool_call_id?: string; content?: unknown }[] };
type Proof = { run_id: string; status: string; goalStatus: string; nodes: {
  id: string; state: string; output: string; dependsOn: string[]; startedAt: string; completedAt: string;
}[] };

test("Native two-node DAG completes in dependency order on the selected local model", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-mini-workflow-"));
  const chat: Chat[] = [], paths: string[] = [], frames: Frame[] = [], order: string[] = [], approvals: string[] = [];
  const listeners = new Set<(frame: Frame) => void>();
  const pending = new Set<(reason: Error) => void>();
  let rpc: ReturnType<typeof spawn> | undefined;
  let buffer = "", stderr = "", firstAnswered = false, secondEarly = false;
  const first = "WORKFLOW-FIRST-462", second = "WORKFLOW-SECOND-573";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    paths.push(path);
    if (path === "/api/v1/models") return Response.json({ models: [{
      key: "workflow-local", type: "llm", max_context_length: 262144,
      capabilities: { trained_for_tool_use: true, vision: false },
      loaded_instances: [{ id: "workflow-local", config: { context_length: 65536 } }],
    }] });
    if (path !== "/v1/chat/completions") return new Response("Not Found", { status: 404 });
    const body = await request.json() as Chat;
    chat.push(body);
    const user = JSON.stringify(body.messages?.filter(message => message.role === "user"));
    const resumed = body.messages?.some(message => message.role === "tool" && message.tool_call_id === "workflow-call-1") ?? false;
    const node = !resumed && user.includes(first) ? "first" : !resumed && user.includes(second) ? "second" : undefined;
    if (node) { order.push(node); if (node === "second" && !firstAnswered) secondEarly = true; }
    const delta = node === "first" ? { content: "FIRST-ANSWER-462" }
      : node === "second" ? { content: "SECOND-ANSWER-573" }
      : resumed ? { content: "Workflow complete." }
      : { tool_calls: [{ index: 0, id: "workflow-call-1", type: "function", function: { name: "eval", arguments: JSON.stringify({
          language: "js", summary: "Register a fixture goal and verify two dependent local workflow nodes.",
          code: `const goal = await tool.create_goal({objective:"Prove both local fixture nodes complete in dependency order with their exact results."});
            if (goal.hasError || goal.details?.goal?.status !== "active") throw Error("Fixture goal registration failed: " + goal.text);
            const sdk = await import(\`\${env("OMO_DAG_SDK_ROOT")}/sdk.js\`);
            const run = await sdk.start({key:"workflow-fixture",name:"Two-node local fixture",nodes:[
              {id:"first",category:"quick",task_summary:"Return first workflow fixture answer",prompt:"Reply ${first} using exactly FIRST-ANSWER-462 and no tools."},
              {id:"second",category:"quick",task_summary:"Return second workflow fixture answer",prompt:"Reply ${second} using exactly SECOND-ANSWER-573 and no tools.",dependsOn:["first"]}
            ]});
            const result = await run.done();
            const final = result.details?.result, snapshot = final?.snapshot, nodes = snapshot?.nodes;
            if (result.details?.kind !== "waited" || final?.status !== "completed" || snapshot?.status !== "completed" ||
                !Array.isArray(nodes) || nodes.length !== 2 ||
                nodes[0]?.id !== "first" || nodes[0]?.state !== "completed" || nodes[0]?.output !== "FIRST-ANSWER-462" ||
                nodes[1]?.id !== "second" || nodes[1]?.state !== "completed" || nodes[1]?.output !== "SECOND-ANSWER-573" ||
                !nodes[1]?.dependsOn?.includes("first") || !nodes[0]?.completedAt || !nodes[1]?.startedAt ||
                !Number.isFinite(Date.parse(nodes[0].completedAt)) || !Number.isFinite(Date.parse(nodes[1].startedAt)) ||
                Date.parse(nodes[0].completedAt) > Date.parse(nodes[1].startedAt))
              throw Error("DAG nodes did not finish in dependency order: " + JSON.stringify({status:final?.status,nodes}));
            const finishedGoal = await tool.update_goal({status:"complete"});
            if (finishedGoal.hasError || finishedGoal.details?.goal?.status !== "complete") throw Error("Goal completion failed: " + finishedGoal.text);
            print("DAG_VERIFIED:" + JSON.stringify({run_id:run.run_id,status:final.status,goalStatus:finishedGoal.details.goal.status,
              nodes:nodes.map(n=>({id:n.id,state:n.state,output:n.output,dependsOn:n.dependsOn,startedAt:n.startedAt,completedAt:n.completedAt}))}));`,
        }) } }] };
    if (node === "first") firstAnswered = true;
    const finish = node || resumed ? "stop" : "tool_calls";
    return new Response(`data: ${JSON.stringify({ id: "workflow", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "workflow", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  function wait(match: (frame: Frame) => boolean): Promise<Frame> {
    const result = new Promise<Frame>((accept, reject) => {
      const clear = () => { clearTimeout(timer); listeners.delete(onFrame); pending.delete(cancel); };
      const cancel = (error: Error) => { clear(); reject(error); };
      const onFrame = (frame: Frame) => { if (match(frame)) { clear(); accept(frame); } };
      const timer = setTimeout(() => cancel(new Error(`Workflow event deadline: paths=${JSON.stringify(paths)} order=${JSON.stringify(order)} frames=${JSON.stringify(frames.slice(-8))} stderr=${stderr.slice(-900)}`)), 60000);
      listeners.add(onFrame); pending.add(cancel);
    });
    void result.catch(() => {});
    return result;
  }
  try {
    rpc = spawn(process.execPath, ["src/cli.ts", "rpc", "--root", root, "--state-dir", join(root, "state"), "--base-url", `http://127.0.0.1:${server.port}/v1`],
      { cwd: resolve(import.meta.dir, ".."), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    rpc.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    rpc.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let end = buffer.indexOf("\n");
      while (end >= 0) {
        const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
        if (line.startsWith("{")) {
          const frame = JSON.parse(line) as Frame;
          frames.push(frame);
          const tool = /^Permission required: (eval|workflow)\n/.exec(frame.title ?? "")?.[1];
          if (frame.type === "extension_ui_request" && frame.method === "select" && tool) {
            expect(frame.options).toContain("Allow once");
            approvals.push(tool);
            rpc!.stdin!.write(JSON.stringify({ type: "extension_ui_response", id: frame.id, value: "Allow once" }) + "\n");
          }
          for (const listener of listeners) listener(frame);
        }
        end = buffer.indexOf("\n");
      }
    });
    const started = wait(frame => frame.type === "tool_execution_start" && frame.toolCallId === "workflow-call-1");
    const finished = wait(frame => frame.type === "tool_execution_end" && frame.toolCallId === "workflow-call-1");
    const ended = wait(frame => frame.type === "agent_end");
    const response = wait(frame => frame.type === "response" && frame.id === "1");
    rpc.stdin!.write(JSON.stringify({ id: "1", type: "prompt", message: "Run the disposable two-node local DAG and await its completed node results." }) + "\n");
    expect((await response).success).toBe(true);
    await started;
    const outcome = await finished;
    expect(outcome.isError, `workflow result: ${JSON.stringify(outcome.result)}`).toBe(false);
    const output = (outcome.result?.content as { type?: string; text?: string }[] | undefined)?.find(part => part.type === "text")?.text;
    const line = output?.split("\n").find(entry => entry.startsWith("DAG_VERIFIED:"));
    const proof = JSON.parse(line?.slice("DAG_VERIFIED:".length) ?? "null") as Proof | null;
    expect(proof?.run_id?.startsWith("dag_")).toBe(true);
    expect(proof?.status).toBe("completed");
    expect(proof?.goalStatus).toBe("complete");
    expect(proof?.nodes.map(node => [node.id, node.state, node.output, node.dependsOn])).toEqual([
      ["first", "completed", "FIRST-ANSWER-462", []],
      ["second", "completed", "SECOND-ANSWER-573", ["first"]],
    ]);
    expect(Date.parse(proof!.nodes[0]!.completedAt)).toBeLessThanOrEqual(Date.parse(proof!.nodes[1]!.startedAt));
    await ended;
    expect(order).toEqual(["first", "second"]);
    expect(secondEarly).toBe(false);
    expect(paths).toContain("/api/v1/models");
    expect(paths).not.toContain("/api/v0/models");
    expect(chat).toHaveLength(4);
    expect(chat.every(body => body.model === "workflow-local")).toBe(true);
    expect(chat.some(body => body.messages?.some(message => message.role === "tool" && message.tool_call_id === "workflow-call-1" && typeof message.content === "string" && message.content.includes("DAG_VERIFIED:")))).toBe(true);
    expect(JSON.stringify(frames.filter(frame => frame.type === "agent_end").at(-1))).toContain("Workflow complete.");
    expect(approvals).toEqual(["eval", "workflow", "workflow"]);
  } finally {
    for (const cancel of pending) cancel(new Error("Workflow fixture stopped"));
    if (rpc && rpc.exitCode === null) {
      const exit = new Promise<void>((accept, reject) => {
        const timer = setTimeout(() => reject(new Error("Workflow RPC did not stop")), 10000);
        rpc!.once("exit", () => { clearTimeout(timer); accept(); });
      });
      rpc.stdin?.end(); rpc.kill(); await exit;
    }
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 120000);
