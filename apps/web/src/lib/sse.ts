// a small server-sent events parser for a fetch body. EventSource cannot POST, so /execute uses fetch
import { parsePlanJson } from "./json.ts";
import type { ExecEvent } from "./types.ts";

export class SseParser {
  private buf = "";
  constructor(private readonly onEvent: (e: ExecEvent) => void) {}

  push(chunk: string): void {
    this.buf += chunk.replace(/\r\n/g, "\n");
    let i: number;
    while ((i = this.buf.indexOf("\n\n")) >= 0) {
      const block = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 2);
      this.block(block);
    }
  }

  end(): void {
    if (this.buf.trim()) this.block(this.buf);
    this.buf = "";
  }

  private block(block: string): void {
    let name: string | undefined;
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) continue;
      const c = line.indexOf(":");
      const field = c < 0 ? line : line.slice(0, c);
      const value = c < 0 ? "" : line.slice(c + 1).replace(/^ /, "");
      if (field === "event") name = value;
      else if (field === "data") data.push(value);
    }
    if (data.length === 0) return;
    let parsed: unknown;
    try {
      parsed = parsePlanJson(data.join("\n"));
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    const e = parsed as Record<string, unknown>;
    if (typeof e.type !== "string" && name) e.type = name;
    if (typeof e.at !== "number") e.at = Date.now();
    if (typeof e.type === "string") this.onEvent(e as unknown as ExecEvent);
  }
}
