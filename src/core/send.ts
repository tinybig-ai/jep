// `jep-send FILE...` is how an agent hands a file to the person in Telegram.
// The command only checks the file and says what it did. The Telegram client
// reads the paths back out of the recorded call and uploads them. Same shape
// as jep-show, for any file rather than an image.

/** the paths each `jep-send` call in a shell command line names */
export function sentPaths(command: string): string[] {
  const out: string[] = []
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    const words = [...segment.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? "")
    const at = words.findIndex((w) => /(^|\/)jep-send(\.mjs)?$/.test(w))
    if (at < 0) continue
    out.push(...words.slice(at + 1).filter((w) => w && !w.startsWith("-")))
  }
  return out
}

/** The paths `jep-send` reported: "sending /abs/path (N bytes)", one per line. */
export function sentInOutput(output: unknown): string[] {
  if (typeof output !== "string") return []
  return [...output.matchAll(/^sending (\/.+?) \(\d+ bytes\)\s*$/gm)].map((m) => m[1]!)
}

/** the paths one tool call is sending: a `jep-send` command, or the `jep_send` MCP tool.
 *  Once the call has printed its result, that is the list: a path it refused is not in it. */
export function sentFrom(name: string, input: unknown, output?: unknown): string[] {
  const args = input && typeof input === "object" ? input as Record<string, unknown> : {}
  const command = typeof input === "string" ? input : args.command ?? args.cmd
  if (!/jep_send$/i.test(name) && !(typeof command === "string" && command.includes("jep-send"))) return []
  // Only confirmed output grants delivery. Arguments may name files the tool
  // rejected, or refer to a command which never ran at all.
  const text = (value: unknown): string => {
    if (typeof value === "string") return value
    if (Array.isArray(value)) return value.map(text).join("\n")
    if (value && typeof value === "object") {
      const v = value as Record<string, unknown>
      return text(v.content ?? v.text ?? v.output ?? v.stdout)
    }
    return ""
  }
  return [...new Set(sentInOutput(text(output)))]
}

/** Shared Message.parts representation; every client already handles files. */
export function withSentFiles(parts: import("./types.ts").Part[]): import("./types.ts").Part[] {
  const files = new Set(parts.flatMap((p) => p.kind === "file" ? [p.filePath] : []))
  const out = [...parts]
  for (const part of parts) {
    if (part.kind !== "tool" || (part.status && part.status !== "completed" && part.status !== "error")) continue
    for (const filePath of sentFrom(part.name, part.input, part.output)) {
      if (files.has(filePath)) continue
      files.add(filePath)
      out.push({ kind: "file", filePath, id: `${part.id}:sent:${filePath}` })
    }
  }
  return out
}
