import { mkdtempSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startCodexAdapter } from "./adapters/codex.ts"
import { runComplianceSuite } from "./core/compliance.ts"

/**
 * Runs the same port compliance suite against the Codex adapter that the
 * opencode one has to pass. The point is the port, not Codex: if a second
 * harness can satisfy HarnessAdapter unchanged, the seam is real.
 *
 * Uses a throwaway workspace so nothing here touches a real project.
 */
async function main() {
  const ws = process.env.JEP_CODEX_PROBE_WS ?? mkdtempSync(join(tmpdir(), "jep-codex-"))
  mkdirSync(ws, { recursive: true })
  console.log(`\ncodex adapter compliance  ·  workspace: ${ws}\n`)

  const adapter = await startCodexAdapter(ws)
  const health = await adapter.health()
  console.log(`  codex: ${health.version}\n`)

  const rows = await runComplianceSuite(adapter)
  let failed = 0
  for (const r of rows) {
    const mark = r.ok === true ? "PASS" : r.ok === "manual" ? "MANUAL" : "FAIL"
    if (r.ok === false) failed++
    console.log(`  ${mark.padEnd(7)} ${r.method.padEnd(16)} ${r.note}`)
  }
  await adapter.close()
  console.log(`\n${rows.length - failed}/${rows.length} ok, ${failed} failed\n`)
  process.exit(failed ? 1 : 0)
}

main().catch((err) => {
  console.error("codex probe failed:", err)
  process.exit(1)
})
