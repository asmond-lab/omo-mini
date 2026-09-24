/** Reproducible sequential real-CLI evaluation; no oracle files enter the model root. */
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const source = resolve(import.meta.dir, "corpus");
const tasks = JSON.parse(await readFile(join(source, "tasks.json"), "utf8")) as { fixture_root: string; tasks: { id: string; question: string }[] };
const oracle = JSON.parse(await readFile(join(source, "oracle/answers.json"), "utf8")) as Record<string, {
  values: string[]; citations: { path: string; start: number; end: number }[]; status?: string; pixels?: object;
}>;
const root = await mkdtemp(join(tmpdir(), "omo-mini-public-eval-"));
const fixture = join(root, "fixture");
const reportPath = resolve(import.meta.dir, "../docs/evidence/performance.json");
try {
  await cp(join(source, tasks.fixture_root), fixture, { recursive: true });
  const png = Buffer.from((await readFile(join(fixture, "assets/status.png.b64"), "utf8")).trim(), "base64");
  await writeFile(join(fixture, "assets/status.png"), png);
  const report: { version: string; fixture: string; runs: object[] } = { version: "0.1.0", fixture: "public Tidewatch (11 file questions + 1 image attachment)", runs: [] };
  for (const strategy of ["baseline", "grounded"] as const) {
    const results = [];
    for (const item of tasks.tasks) {
      const args = ["dist/cli.js", "run", "--root", fixture, "--task", item.id === "T12" ?
        "Look at the attached PNG image. What are the colors of its top-left and top-right pixels? Do not infer colors from base64 text." : item.question,
        "--strategy", strategy, "--json"];
      if (item.id === "T12") args.push("--image", "assets/status.png");
      const proc = Bun.spawn([process.execPath, ...args], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe", signal: AbortSignal.timeout(105000) });
      const [out, err, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      let result: { answer: string; reason: string; elapsedMs: number; usage: { input: number; output: number } | null;
        tools: { name: string; isError: boolean }[]; requests: number; requestBytes: number[]; error?: string };
      try { result = JSON.parse(out); }
      catch { throw new Error(`${strategy}/${item.id}: CLI output not JSON (exit ${exit}; stderr ${err.slice(0, 300)}; stdout ${out.slice(0, 300)})`); }
      const expected = oracle[item.id];
      if (!expected) throw new Error(`Missing oracle ${item.id}`);
      const answer = result.answer ?? "";
      const correct = item.id === "T09" ? /(?:not found|no (?:such|pagerduty|integration)|couldn't find)/i.test(answer) && !/key\s*[:=]\s*\S+/i.test(answer) :
        item.id === "T12" ? /(?:top.left[\s\S]*red[\s\S]*top.right[\s\S]*blue|red[\s\S]*blue)/i.test(answer) :
        expected.values.every(value => answer.toLowerCase().includes(value.toLowerCase()));
      // Only citations in the *answer* count. Tool transcript references do not.
      const normalizedAnswer = answer.replaceAll(String.fromCharCode(92), "/");
      const citations = expected.citations.filter(c => {
        for (let line = c.start; line <= c.end; line++) {
          const marker = `${c.path}:${line}`;
          const at = normalizedAnswer.indexOf(marker);
          if (at >= 0 && !"0123456789".includes(normalizedAnswer[at + marker.length] ?? " ")) return true;
        }
        return false;
      });
      const row = { id: item.id, exit, reason: result.reason, answer, correct, citations: citations.length,
        expectedCitations: item.id === "T12" ? 0 : expected.citations.length, validCalls: result.tools?.filter(t => !t.isError).length ?? 0,
        invalidCalls: result.tools?.filter(t => t.isError).length ?? 0, requests: result.requests, requestBytes: result.requestBytes,
        usage: result.usage, elapsedMs: result.elapsedMs, ...(result.error ? { error: result.error } : {}) };
      results.push(row);
      console.log(`${strategy} ${item.id}: ${exit}/${result.reason} values=${correct} cited=${citations.length}/${row.expectedCitations} ${row.elapsedMs}ms calls=${row.validCalls}/${row.invalidCalls}`);
    }
    report.runs.push({ strategy, results, summary: { correct: results.filter(r => r.correct && r.reason === "stop").length,
      citationSpans: results.reduce((n, r) => n + r.citations, 0), expectedCitationSpans: results.reduce((n, r) => n + r.expectedCitations, 0),
      validCalls: results.reduce((n, r) => n + r.validCalls, 0), invalidCalls: results.reduce((n, r) => n + r.invalidCalls, 0),
      elapsedMs: results.reduce((n, r) => n + r.elapsedMs, 0), requestBytes: results.reduce((n, r) => n + r.requestBytes.reduce((a, b) => a + b, 0), 0),
      providerInput: results.reduce((n, r) => n + (r.usage?.input ?? 0), 0), providerOutput: results.reduce((n, r) => n + (r.usage?.output ?? 0), 0) } });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
} finally { await rm(root, { recursive: true, force: true }); }
