import { mkdtempSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildHarnesses } from "./core/harnesses.ts"
import { runComplianceSuite } from "./core/compliance.ts"

/**
 * Runs the port compliance suite against a harness by id:
 *
 *   npm run probe:harness -- codex
 *   npm run probe:harness -- claude opencode
 *
 * The point is the port, not any one harness. If every harness satisfies
 * HarnessAdapter unchanged, the seam is real; the first one that needs
 * ports.ts widened is telling you something.
 *
 * Each runs against a throwaway workspace, so nothing touches a real project.
 */
async function main() {
  const wanted = process.argv.slice(2).filter((a) => !a.startsWith("-"))
  const all = buildHarnesses()
  const targets = wanted.length ? all.filter((h) => wanted.includes(h.id)) : all
  if (!targets.length) {
    console.error(`no such harness. available: ${all.map((h) => h.id).join(", ")}`)
    process.exit(1)
  }

  let failedTotal = 0
  for (const harness of targets) {
    const ws = mkdtempSync(join(tmpdir(), `jep-${harness.id}-`))
    mkdirSync(ws, { recursive: true })
    console.log(`\n── ${harness.id} ${"─".repeat(Math.max(0, 40 - harness.id.length))}`)
    console.log(`   workspace: ${ws}`)

    let adapter
    try {
      adapter = await harness.start(ws)
    } catch (err) {
      console.log(`   SKIP — cannot start: ${(err as Error)?.message ?? err}`)
      continue
    }
    const health = await adapter.health()
    console.log(`   ${health.version}\n`)

    const rows = await runComplianceSuite(adapter)
    let failed = 0
    for (const r of rows) {
      const mark = r.ok === true ? "PASS" : r.ok === "manual" ? "MANUAL" : "FAIL"
      if (r.ok === false) failed++
      console.log(`   ${mark.padEnd(7)} ${r.method.padEnd(16)} ${r.note}`)
    }
    await adapter.close()
    failedTotal += failed
    console.log(`\n   ${rows.length - failed}/${rows.length} ok, ${failed} failed`)
  }
  console.log("")
  process.exit(failedTotal ? 1 : 0)
}

main().catch((err) => {
  console.error("harness probe failed:", err)
  process.exit(1)
})
