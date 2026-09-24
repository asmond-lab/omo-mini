/** Terminal input assembler: bracketed paste stays one prompt; a native multi-line chunk is one prompt. */
export class InputAssembler {
  private pending = "";
  private paste = false;
  feed(chunk: string): string[] {
    const output: string[] = [];
    const parts = chunk.split(/(\x1b\[200~|\x1b\[201~)/);
    for (const part of parts) {
      if (part === "\x1b[200~") { this.paste = true; continue; }
      if (part === "\x1b[201~") { this.paste = false; continue; }
      if (this.paste) { this.pending += part; continue; }
      if (part === "\u0003") { output.push("/quit"); continue; }
      if (part === "\u007f" || part === "\b") { this.pending = this.pending.slice(0, -1); continue; }
      const matches = [...part.matchAll(/\r\n|\r|\n/g)];
      if (!matches.length) { this.pending += part; continue; }
      // A paste delivered as one OS chunk can include internal line breaks.
      if (matches.length > 1 || (matches[0]?.index ?? 0) + (matches[0]?.[0].length ?? 0) < part.length) {
        output.push(this.pending + part.replace(/(?:\r\n|\r|\n)$/, "").replace(/\r\n|\r/g, "\n"));
        this.pending = "";
      } else {
        output.push(this.pending + part.slice(0, matches[0]?.index ?? 0));
        this.pending = "";
      }
    }
    return output;
  }
}
