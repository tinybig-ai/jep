// The mock-first ritual (PHILOSOPHY §8) as an assertion instead of something
// you read. Replays a fixture through the real bot with the mock Telegram API
// and checks the CALL dump, which is the same evidence a human would squint at.
//
// Opt-in: it boots a real harness per workspace, so it is slower than the rest
// of the suite and needs the harness binary on PATH. `npm run test:e2e`.

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const ROOT = join(import.meta.dirname, "..")
const enabled = process.env.JEP_E2E === "1"

interface Call {
  method: string
  /** the dump's trailing text="…" field, already unquoted */
  text: string
  mode?: string
  /** the rich_message payload, where the call carried one */
  rich?: { blocks?: Array<Record<string, unknown>> }
  raw: string
}

function replay(fixture: string): Call[] {
  const home = mkdtempSync(join(tmpdir(), "jep-e2e-"))
  try {
    const out = execFileSync("node", ["--experimental-strip-types", "src/tg.ts"], {
      cwd: ROOT,
      input: readFileSync(join(ROOT, "fixture", fixture), "utf8"),
      encoding: "utf8",
      // the dump truncates rich payloads by default, and the buttons this
      // asserts on sit at the end of them
      env: { ...process.env, JEP_TG_MOCK: "1", JEP_TG_PAIR_CODE: "TESTCODE", JEP_DATA_HOME: home, JEP_DUMP_CHARS: "200000" },
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    })
    return out
      .split("\n")
      .filter((l) => l.startsWith("CALL "))
      .map((raw) => {
        const method = raw.slice(5, raw.indexOf(" ", 5))
        // `text=` is the last field, but its *value* can contain " text=" too
        // (a draft's dump embeds one). The real field is the leftmost whose
        // remainder parses as a complete JSON string.
        let at = -1
        let text = ""
        for (let i = raw.indexOf(" text="); i !== -1; i = raw.indexOf(" text=", i + 1)) {
          try {
            text = JSON.parse(raw.slice(i + 6)) as string
            at = i
            break
          } catch {
            /* an occurrence inside the value — keep looking */
          }
        }
        const richAt = raw.indexOf(" rich=")
        const rich = richAt === -1 || at === -1 ? undefined : (JSON.parse(raw.slice(richAt + 6, at)) as Call["rich"])
        return { method, text, mode: raw.match(/ mode=(\w+)/)?.[1], rich, raw }
      })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

/** every button label + callback_data in a rich message, flattened */
const buttons = (c: Call): Array<{ text: string; callback_data: string }> =>
  (c.rich?.blocks ?? [])
    .filter((b) => b.type === "buttons")
    .flatMap((b) => (b.buttons ?? []) as Array<{ text: string; callback_data: string }>)

const blockTypes = (c: Call): string[] => (c.rich?.blocks ?? []).map((b) => String(b.type))

describe("mock replay", { skip: enabled ? false : "set JEP_E2E=1 (boots a real harness)" }, () => {
  test("the /git fixture drives all three screens", () => {
    const calls = replay("telegram-mock-git.jsonl")

    const commands = calls.find((c) => c.method === "setMyCommands")
    assert.ok(commands, "the command menu is published at boot")
    assert.match(commands.text, /\/git/)

    // §3: every outbound text goes through the markdown→HTML choke point
    for (const c of calls.filter((c) => c.method === "sendMessage" || c.method === "editMessageText")) {
      assert.equal(c.mode, "HTML", `not rendered through mdToHtml: ${c.raw.slice(0, 120)}`)
    }

    const status = calls.find((c) => c.rich && blockTypes(c).includes("table"))
    assert.ok(status, "the status screen draws the changes as a native table")
    assert.ok(blockTypes(status).includes("details"), "with the latest commits folded into a details block")
    const statusButtons = buttons(status).map((b) => b.callback_data)
    assert.ok(
      statusButtons.some((d) => d.startsWith("gitf:")),
      "and one diff button per changed file",
    )
    assert.ok(statusButtons.includes("git:df") && statusButtons.includes("git:log"))

    // the log pages forward and back, and says which page it is on
    const pages = calls.filter((c) => c.rich && blockTypes(c).includes("pre")).flatMap((c) =>
      (c.rich!.blocks ?? []).filter((b) => b.type === "paragraph").map((b) => String(b.text ?? "")),
    )
    assert.ok(pages.includes("commits 1–15"), `no first page in ${JSON.stringify(pages)}`)
    assert.ok(pages.includes("commits 16–30"), "Older › advanced a page")

    // the diff pager offers more, and every screen stays well inside the
    // wire limit — a message Telegram rejects shows nothing at all
    const diffs = calls.filter((c) => buttons(c).some((b) => b.callback_data === "git:dfm"))
    assert.ok(diffs.length >= 2, "the full diff paged at least once")
    for (const c of calls.filter((c) => c.rich)) {
      assert.ok(JSON.stringify(c.rich).length < 4000, `a screen grew past the wire limit: ${c.raw.slice(0, 80)}`)
    }

    const doc = calls.find((c) => c.method === "sendDocument")
    assert.ok(doc, "📎 As file sends the patch as a document")
    assert.match(doc.text, /\.diff/)
  })

  test("a fresh chat pairs, answers, and never sends unrendered text", () => {
    const calls = replay("telegram-mock.jsonl")
    assert.ok(
      calls.some((c) => c.text.includes("Paired")),
      "the pairing code is accepted",
    )
    for (const c of calls.filter((c) => c.method === "sendMessage" || c.method === "editMessageText")) {
      assert.equal(c.mode, "HTML")
    }
    assert.ok(
      calls.some((c) => c.method === "sendMessageDraft" && c.text.includes("can_stop=true")),
      "a turn opens with the native stop-able placeholder",
    )
    assert.ok(
      calls.some((c) => c.method === "pinChatMessage"),
      "the status line is pinned",
    )
  })
})
