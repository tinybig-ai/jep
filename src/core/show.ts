// `jep-show IMAGE...` is how an agent puts a picture in front of the person on
// the other end. Every harness has a shell and records the call as a tool, so
// the transcript already holds what was shown: the command line. A client
// reads the paths back out of it and draws them, and the gateway lets the
// device fetch exactly those files, the way it does for a file the agent read.

/** the paths each `jep-show` call in a shell command line names */
export function shownPaths(command: string): string[] {
  const out: string[] = []
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    const words = [...segment.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? "")
    const at = words.findIndex((w) => /(^|\/)jep-show(\.mjs)?$/.test(w))
    if (at < 0) continue
    out.push(...words.slice(at + 1).filter((w) => w && !w.startsWith("-")))
  }
  return out
}

/** the paths one tool call shows: a `jep-show` command line, or the `jep_show` MCP tool
 *  (whose name each harness decorates its own way: mcp__jep-tools__jep_show, jep-tools_jep_show) */
export function shownFrom(name: string, input: unknown): string[] {
  if (!input || typeof input !== "object") return []
  const args = input as Record<string, unknown>
  if (/jep_show$/i.test(name)) return Array.isArray(args.paths) ? args.paths.filter((p): p is string => typeof p === "string" && p !== "") : []
  return typeof args.command === "string" ? shownPaths(args.command) : []
}
