import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { HarnessAdapter, ExecutionPolicyPort } from "./ports.ts"

export const EXECUTION_SETTING = {
  id: "mostPermissive",
  label: "Run all harnesses in their most permissive mode",
  description: "For all conversations, starting with the next turn: bypass Codex's sandbox, skip Claude and OpenCode approvals, and use Goose auto mode. Pi already has no built-in approval gate. Turning this off restores each conversation's own settings.",
  default: false,
}

export class ExecutionPolicy implements ExecutionPolicyPort {
  #file: string
  #enabled = false

  constructor(dataHome: string) {
    this.#file = join(dataHome, "execution-settings.json")
    try {
      this.#enabled = JSON.parse(readFileSync(this.#file, "utf8")).mostPermissive === true
    } catch { /* absent or invalid settings retain the default */ }
  }

  enabled(): boolean { return this.#enabled }

  setEnabled(enabled: boolean): void {
    mkdirSync(dirname(this.#file), { recursive: true })
    const tmp = `${this.#file}.tmp`
    writeFileSync(tmp, JSON.stringify({ mostPermissive: enabled }), { mode: 0o600 })
    renameSync(tmp, this.#file)
    this.#enabled = enabled
  }

  apply(settings?: Record<string, boolean>): Record<string, boolean> | undefined {
    return this.#enabled ? { ...settings, dangerouslySkipPermissions: true } : settings
  }
}

/** Decorate the shared adapter once so every caller observes the live policy.
 * The original methods stay bound to the adapter (including private fields). */
export function applyExecutionPolicy(adapter: HarnessAdapter, policy: ExecutionPolicyPort): HarnessAdapter {
  const prompt = adapter.prompt.bind(adapter)
  adapter.prompt = (id, text, options) => prompt(id, text, {
    ...options,
    harnessSettings: policy.apply(options?.harnessSettings),
  })
  return adapter
}
