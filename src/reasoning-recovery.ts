type Step = { readonly id: number; readonly paragraphs: ReadonlySet<string>; readonly length: number };

export const REASONING_RECOVERY = `<local_reasoning_recovery>
The last two tool steps repeated a substantial part of the same reasoning. Re-evaluate the latest tool results before continuing. Check whether the assumed capability or approach is actually supported. Keep any new reasoning brief and specific to what changed; do not restate the previous plan. Take the next concrete supported action, or explain the missing prerequisite if no supported action is available. This notice does not mean the task is complete or that a different command will work.
</local_reasoning_recovery>`;

export class ReasoningRecovery {
  private previous: Step | undefined;
  private pending = false;

  reset(): void { this.previous = undefined; this.pending = false; }

  observe(id: number, blocks: readonly string[]): void {
    if (this.previous?.id === id) return;
    const paragraphs = new Set(blocks.join("\n\n").slice(0, 16_384).split(/\n\s*\n/)
      .map(part => part.replace(/\s+/gu, " ").trim()).filter(part => part.length >= 80));
    const length = [...paragraphs].reduce((total, part) => total + part.length, 0);
    const repeated = [...paragraphs].reduce((total, part) => total + (this.previous?.paragraphs.has(part) ? part.length : 0), 0);
    this.pending = repeated >= 160 && repeated >= 0.6 * Math.min(length, this.previous?.length ?? 0);
    this.previous = { id, paragraphs, length };
  }

  consume(messages: readonly { role: string; timestamp: number }[]): boolean {
    const latest = messages.findLast(message => message.role === "assistant" || message.role === "user");
    if (!this.pending || latest?.role !== "assistant" || latest.timestamp !== this.previous?.id) return false;
    this.pending = false;
    return true;
  }
}
