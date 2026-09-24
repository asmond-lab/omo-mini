// Manual real-model QA. Only public fixture prompts are sent; state is disposable.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discover } from "../src/local.ts";
import { DEFAULT_BASE_URL } from "../src/profile.ts";

const dir = await mkdtemp(join(tmpdir(), "omo-mini-live-"));
const root = join(import.meta.dir, "..", "fixtures", "tiny");
const prompts = [
  ["korean", "안녕"],
  ["korean", "너 현재 로컬모델로 돌아가고있는거야? 현재 모델 ID와 작업 폴더를 알려줘."],
  ["korean", "이 공개 토큰 기억해: CERULEAN-PAW-781."],
  ["korean", "방금 공개 토큰은?"],
  ["fresh", "앞서 공개 토큰을 알려줬니? 모르면 모른다고 해."],
  ["korean", "이 세션에서 앞서 알려준 공개 토큰을 알려줘."],
] as const;

async function turn(session: string, prompt: string) {
  const child = Bun.spawn([process.execPath, "src/cli.ts", "run", "--root", root, "--state-dir", dir,
    "--session", session, "--task", prompt, "--json"],
    { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 90000);
  try {
    const [exit, raw, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const events = raw.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    const assistant = events.filter(event => event.type === "agent_end").at(-1)?.messages?.filter((m: { role: string }) => m.role === "assistant").at(-1);
    const answer = assistant?.content?.filter((block: { type: string }) => block.type === "text").map((block: { text: string }) => block.text).join("\n");
    if (exit !== 0 || assistant?.stopReason !== "stop") throw new Error(`Turn failed (${exit}): ${errors.slice(-700)} ${raw.slice(-500)}`);
    return { session, prompt, answer: answer?.replace(/(?:[A-Za-z]:|\/[a-z])\/Users\/[^/\s`]+\/Desktop\/dev\/omo-mini\/fixtures\/tiny/gi, "<workspace>/fixtures/tiny"), usage: assistant.usage };
  } finally { clearTimeout(timer); }
}

try {
  const model = await discover(DEFAULT_BASE_URL);
  const start = performance.now();
  const turns = [];
  for (const [session, prompt] of prompts) turns.push(await turn(session, prompt));
  const evidence = { model: model.id, loadedContext: model.loaded_context_length, root: "fixtures/tiny",
    elapsedMs: Math.round(performance.now() - start), turns };
  console.log(JSON.stringify(evidence, null, 2));
  if (!turns[1]?.answer?.includes(model.id) || !turns[3]?.answer?.includes("CERULEAN-PAW-781") ||
    turns[4]?.answer?.includes("CERULEAN-PAW-781") || !turns[5]?.answer?.includes("CERULEAN-PAW-781"))
    throw new Error("Local model identity or session-continuity assertion failed");
} finally { await rm(dir, { recursive: true, force: true }); }
