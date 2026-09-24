/** Terminal input assembler: bracketed paste stays one prompt; a native multi-line chunk is one prompt. */
export class InputAssembler {
  private pending = "";
  private paste = false;
  private escape = "";
  private echoEscape = "";
  /** Echo only user-visible characters; escape markers may straddle OS chunks. */
  echo(chunk: string): string {
    const esc = String.fromCharCode(27);
    const del = String.fromCharCode(127);
    const cr = String.fromCharCode(13);
    const lf = String.fromCharCode(10);
    let visible = "";
    for (const char of chunk) {
      if (this.echoEscape || char === esc) {
        this.echoEscape += char;
        if (this.echoEscape === esc + "[200~" || this.echoEscape === esc + "[201~") this.echoEscape = "";
        else if (![esc + "[200~", esc + "[201~"].some(marker => marker.startsWith(this.echoEscape))) this.echoEscape = "";
        continue;
      }
      if (char === del) visible += String.fromCharCode(8) + " " + String.fromCharCode(8);
      else if (char === cr) visible += lf;
      else if (char === lf || (char >= " " && char !== del)) visible += char;
    }
    return visible;
  }
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
