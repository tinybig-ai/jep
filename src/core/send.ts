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
  if (!input || typeof input !== "object") return []
  const args = input as Record<string, unknown>
  const fromArgs = (): string[] =>
    Array.isArray(args.paths) ? args.paths.filter((p): p is string => typeof p === "string" && p !== "") : []
  if (/jep_send$/i.test(name)) {
    if (typeof output === "string") return sentInOutput(output)
    return fromArgs()
  }
  if (typeof args.command !== "string" || !args.command.includes("jep-send")) return []
  if (typeof output === "string") return sentInOutput(output)
  return sentPaths(args.command).filter((p) => !/[$`]/.test(p))
}
