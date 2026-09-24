/** Terminal input assembler: bracketed paste stays one prompt; a native multi-line chunk is one prompt. */
export class InputAssembler {
  private pending = "";
  private paste = false;
  private escape = "";
  feed(chunk: string): string[] {
    const output: string[] = [];
    let plain = "";
    const submit = (text: string) => {
      if (this.paste) { this.pending += text.replace(/\r\n|\r/g, "\n"); return; }
      const normalized = text.replace(/\r\n|\r/g, "\n");
      if (normalized.includes("\n")) {
        // Native paste arrives as one chunk without bracket markers on some terminals.
        output.push(this.pending + normalized.replace(/\n$/, ""));
        this.pending = "";
      } else this.pending += normalized;
    };
    for (const char of chunk) {
      if (this.escape || char === "\x1b") {
        this.escape += char;
        if (this.escape === "\x1b[200~" || this.escape === "\x1b[201~") {
          submit(plain); plain = "";
          this.paste = this.escape === "\x1b[200~";
          this.escape = "";
        } else if (!["\x1b[200~", "\x1b[201~"].some(marker => marker.startsWith(this.escape))) {
          this.escape = "";
        }
        continue;
      }
      if (!this.paste && (char === "\x03" || char === "\x7f" || char === "\b")) {
        submit(plain); plain = "";
        if (char === "\x03") { this.pending = ""; output.push("/quit"); }
        else this.pending = this.pending.slice(0, -1);
        continue;
      }
      plain += char;
    }
    submit(plain);
    return output;
  }
}
