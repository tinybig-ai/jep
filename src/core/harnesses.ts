import { startOpenCodeServer } from "../adapters/opencode.ts"
import { startCodexAdapter } from "../adapters/codex.ts"
import { startClaudeAdapter } from "../adapters/claude.ts"
import type { HarnessAdapter, HarnessSupervisor } from "./ports.ts"

/**
 * The registry behind HarnessSupervisor: the one place that knows how to bring
 * a harness up for a directory. Everything above it (Ws, the bot, the port
 * compliance suite) only ever sees a HarnessAdapter, so adding a harness means
 * adding a row here and nothing else.
 */
export interface HarnessDef extends HarnessSupervisor {
  readonly id: string
  /**
   * The harness's mark: one emoji, unique across the registry. It stands alone
   * on every /ls row, so it has to identify the harness with no text beside it
   * — which is also why uniqueness is enforced rather than hoped for.
   *
   * Keep to U+1F535–1F53A (Unicode 6.0, 2010) or older. The coloured circles
   * added in Unicode 12 render as missing-glyph boxes on fonts that never
   * shipped them. Prefer a distinct *shape*: at list-row size a colour
   * difference alone is easy to miss, and a shape survives a monochrome
   * fallback.
   */
  readonly icon: string
  /** false when the harness isn't installed/usable on this machine */
  available(): Promise<boolean>
}

export interface HarnessInfo extends HarnessDef {
  /** "<icon> <id>", for buttons — never parsed back apart */
  readonly label: string
}

export interface HarnessOpts {
  /** isolated XDG_DATA_HOME, so a harness's sessions never mix with the user's CLI */
  dataHome?: string
}

export function buildHarnesses(opts: HarnessOpts = {}): HarnessInfo[] {
  return seal(defineHarnesses(opts))
}

// Ids and icons must both be unique: the id routes sessions and the icon is
// the only thing distinguishing one conversation's harness from another's in
// a list. A collision is a programming error, so it fails at startup rather
// than silently mislabelling rows.
function seal(defs: HarnessDef[]): HarnessInfo[] {
  const ids = new Set<string>()
  const icons = new Set<string>()
  for (const d of defs) {
    if (!d.id) throw new Error("[harness] a harness has no id")
    if (ids.has(d.id)) throw new Error(`[harness] duplicate id '${d.id}'`)
    if (!d.icon) throw new Error(`[harness] '${d.id}' has no icon`)
    if (icons.has(d.icon)) throw new Error(`[harness] icon ${d.icon} is used by more than one harness ('${d.id}')`)
    ids.add(d.id)
    icons.add(d.icon)
  }
  return defs.map((d) => ({ ...d, label: `${d.icon} ${d.id}` }))
}

function defineHarnesses(opts: HarnessOpts): HarnessDef[] {
  return [
    {
      id: "opencode",
      icon: "🔵",
      async start(workspace: string): Promise<HarnessAdapter> {
        return startOpenCodeServer(workspace, opts.dataHome ? { dataHome: opts.dataHome } : {})
      },
      async available(): Promise<boolean> {
        // opencode is the default harness and jep boots with one already
        // running; probing it would mean spawning a second server per check
        return true
      },
    },
    {
      id: "codex",
      icon: "🔺",
      async start(workspace: string): Promise<HarnessAdapter> {
        return startCodexAdapter(workspace)
      },
      async available(): Promise<boolean> {
        try {
          // cheap: no server, just `codex --version`
          const probe = await startCodexAdapter(process.cwd())
          const h = await probe.health()
          await probe.close()
          return h.healthy
        } catch {
          return false
        }
      },
    },
    {
      id: "claude",
      icon: "🔶",
      async start(workspace: string): Promise<HarnessAdapter> {
        return startClaudeAdapter(workspace)
      },
      async available(): Promise<boolean> {
        try {
          const probe = await startClaudeAdapter(process.cwd())
          const h = await probe.health()
          await probe.close()
          return h.healthy
        } catch {
          return false
        }
      },
    },
  ]
}

export const DEFAULT_HARNESS = process.env.JEP_HARNESS ?? "opencode"
