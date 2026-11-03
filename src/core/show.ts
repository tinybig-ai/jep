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

/** The paths `jep-show` itself reported in a call's output: "showing /abs/path (N bytes)", one per line.
 *  The command line alone cannot say what a shell loop or a variable expands to
 *  (`for r in 1 2 3; do jep-show /tmp/row$r.png; done`); what the command printed can. */
export function shownInOutput(output: unknown): string[] {
  if (typeof output !== "string") return []
  return [...output.matchAll(/^showing (\/.+?) \(\d+ bytes\)\s*$/gm)].map((m) => m[1]!)
}

/** the paths one tool call shows: a `jep-show` command line, or the `jep_show` MCP tool
 *  (whose name each harness decorates its own way: mcp__jep-tools__jep_show, jep-tools_jep_show).
 *  For a shell call, what the command printed counts too (see shownInOutput). */
export function shownFrom(name: string, input: unknown, output?: unknown): string[] {
  if (!input || typeof input !== "object") return []
  const args = input as Record<string, unknown>
  if (/jep_show$/i.test(name)) return Array.isArray(args.paths) ? args.paths.filter((p): p is string => typeof p === "string" && p !== "") : []
  if (typeof args.command !== "string") return []
  const fromCommand = shownPaths(args.command).filter((p) => !/[$`]/.test(p)) // an unexpanded variable is not a path
  return [...new Set([...fromCommand, ...(args.command.includes("jep-show") ? shownInOutput(output) : [])])]
}

/** a part with `shown` filled in when it is a call that showed something */
export function withShown<P extends { kind: string }>(part: P): P {
  if (part.kind !== "tool") return part
  const call = part as unknown as { name: string; input: unknown; output?: unknown }
  const shown = shownFrom(call.name, call.input, call.output)
  return shown.length ? { ...part, shown } : part
}
