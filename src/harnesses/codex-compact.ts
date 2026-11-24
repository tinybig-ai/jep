import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { stopTree } from "../core/proctree.ts"

type Result = { ok: boolean; error?: string }

/** One native compaction over app-server's JSONL protocol. The start RPC only
 * acknowledges the request; success belongs to the completed compaction turn.
 * Wait for the process to leave too, so its rollout is flushed before resuming. */
export function compactCodexThread(
  child: ChildProcessWithoutNullStreams,
  threadId: string,
  cwd: string,
  timeoutMs = 10 * 60_000,
): Promise<Result> {
  return new Promise((resolve) => {
    let result: Result | undefined
    let buffer = ""
    let stderr = ""
    let started = false
    let turnId: string | undefined
    let compacted = false
    let shutdown: ReturnType<typeof setTimeout> | undefined
    const finish = (value: Result) => {
      if (result) return
      result = value
      clearTimeout(timer)
      child.stdin.end()
      shutdown = setTimeout(() => stopTree(child), 3_000)
    }
    const timer = setTimeout(() => {
      finish({ ok: false, error: "Codex compaction timed out" })
      stopTree(child)
    }, timeoutMs)
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`)
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdin.on("error", (err: Error) => finish({ ok: false, error: err.message }))
    child.on("error", (err: Error) => finish({ ok: false, error: err.message }))
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-4_000) })
    child.once("close", (code, signal) => {
      clearTimeout(timer)
      if (shutdown) clearTimeout(shutdown)
      resolve(result ?? { ok: false, error: `Codex exited before compaction finished (${signal ?? code ?? "unknown"})${stderr.trim() ? `: ${stderr.trim().slice(-500)}` : ""}` })
    })
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk
      let newline: number
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (!line.trim() || result) continue
        let message
        try { message = JSON.parse(line) } catch { continue }
        if (!message || typeof message !== "object") continue
        // Unexpected server requests must get an answer rather than parking
        // forever on an approval that this maintenance operation cannot show.
        if (message.method && message.id != null) {
          send({ id: message.id, error: { code: -32601, message: "Not supported during compaction" } })
          continue
        }
        if (message.id === 1 || message.id === 2 || message.id === 3) {
          if (message.error) {
            finish({ ok: false, error: message.error.message ?? "Codex refused compaction" })
          } else if (message.id === 1) {
            send({ method: "initialized", params: {} })
            send({ id: 2, method: "thread/resume", params: { threadId, cwd, approvalPolicy: "never", excludeTurns: true } })
          } else if (message.id === 2) {
            if (message.result?.thread?.status?.type === "active") {
              finish({ ok: false, error: "a turn is running on this session" })
              continue
            }
            started = true
            send({ id: 3, method: "thread/compact/start", params: { threadId } })
          }
          continue
        }
        const params = message.params
        if (!started || params?.threadId !== threadId) continue
        if (message.method === "turn/started") turnId = params.turn?.id
        if (message.method === "item/started" && params.item?.type === "contextCompaction") turnId = params.turnId
        if (message.method === "item/completed" && params.item?.type === "contextCompaction" && params.turnId === turnId) compacted = true
        if (message.method === "error" && !params.willRetry) {
          finish({ ok: false, error: params.error?.message ?? "Codex compaction failed" })
        }
        if (message.method === "turn/completed" && turnId && params.turn?.id === turnId) {
          finish(params.turn.status === "completed" && compacted
            ? { ok: true }
            : { ok: false, error: params.turn.error?.message ?? `Codex compaction ${params.turn.status ?? "did not complete"}` })
        }
      }
    })
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "jep", title: "Jep", version: "0.2.0" } } })
  })
}
