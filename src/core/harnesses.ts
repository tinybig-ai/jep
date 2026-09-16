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
export interface HarnessInfo extends HarnessSupervisor {
  readonly id: string
  /**
   * Shown in the picker, and its leading emoji marks each /ls row.
   *
   * Kept to U+1F535–1F53A (Unicode 6.0, 2010): the coloured circles added in
   * Unicode 12 render as missing-glyph boxes on fonts that never shipped them.
   * Distinct by *shape* as well as colour, since at list-row size a colour
   * difference alone is easy to miss.
   */
  readonly label: string
  /** false when the harness isn't installed/usable on this machine */
  available(): Promise<boolean>
}

export interface HarnessOpts {
  /** isolated XDG_DATA_HOME, so a harness's sessions never mix with the user's CLI */
  dataHome?: string
}

export function buildHarnesses(opts: HarnessOpts = {}): HarnessInfo[] {
  return [
    {
      id: "opencode",
      label: "🔵 opencode",
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
      label: "🔺 codex",
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
      label: "🔶 claude",
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
