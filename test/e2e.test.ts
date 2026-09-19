// The mock-first ritual (PHILOSOPHY §8) as an assertion instead of something
// you read. Replays a fixture through the real bot with the mock Telegram API
// and checks the CALL dump, which is the same evidence a human would squint at.
//
// Opt-in: it boots a real harness per workspace, so it is slower than the rest
// of the suite and needs the harness binary on PATH. `npm run test:e2e`.

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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

function replay(fixture: string, extraEnv: Record<string, string> = {}, reuseHome?: string): Call[] {
  // a caller passing a home keeps the sessions between replays, which is how a
  // test can have a *past* to search
  const home = reuseHome ?? mkdtempSync(join(tmpdir(), "jep-e2e-"))
  try {
    const out = execFileSync("node", ["--experimental-strip-types", "src/tg.ts"], {
      cwd: ROOT,
      input: readFileSync(join(ROOT, "fixture", fixture), "utf8"),
      encoding: "utf8",
      // the dump truncates rich payloads by default, and the buttons this
      // asserts on sit at the end of them
      env: {
        ...process.env,
        JEP_TG_MOCK: "1",
        JEP_TG_PAIR_CODE: "TESTCODE",
        JEP_DATA_HOME: home,
        JEP_DUMP_CHARS: "200000",
        ...extraEnv,
      },
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
    if (!reuseHome) rmSync(home, { recursive: true, force: true })
  }
}

/**
 * A repository with known contents: 20 commits (so the log pages), one heavily
 * modified file (so the diff pages) and one untracked file.
 *
 * The /git assertions used to run against fixture/workspace-alpha, which sits
 * inside the jep checkout — so they passed only while this repo happened to
 * have uncommitted changes, and broke the moment it was committed.
 */
function seedRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "jep-e2e-repo-"))
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", ...args], { cwd: dir, encoding: "utf8" })
  git("init", "-q", "-b", "main", ".")
  for (let i = 1; i <= 20; i++) {
    writeFileSync(join(dir, "history.txt"), `commit ${i}\n`)
    git("add", ".")
    git("commit", "-qm", `change number ${i}`)
  }
  writeFileSync(join(dir, "big.txt"), Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n"))
  git("add", ".")
  git("commit", "-qm", "add a big file")
  // now make it dirty, in three different ways
  writeFileSync(join(dir, "big.txt"), Array.from({ length: 400 }, (_, i) => `changed line ${i}`).join("\n"))
  writeFileSync(join(dir, "history.txt"), "edited\n")
  git("add", "history.txt")
  writeFileSync(join(dir, "brand-new.txt"), "fresh\n")
  return dir
}

/** every button label + callback_data in a rich message, flattened */
const buttons = (c: Call): Array<{ text: string; callback_data: string }> =>
  (c.rich?.blocks ?? [])
    .filter((b) => b.type === "buttons")
    .flatMap((b) => (b.buttons ?? []) as Array<{ text: string; callback_data: string }>)

const blockTypes = (c: Call): string[] => (c.rich?.blocks ?? []).map((b) => String(b.type))

describe("mock replay", { skip: enabled ? false : "set JEP_E2E=1 (boots a real harness)" }, () => {
  test("the /git fixture drives all three screens", () => {
    const repo = seedRepo()
    try {
      runGitScreens(repo)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  function runGitScreens(repo: string): void {
    const calls = replay("telegram-mock-git.jsonl", { JEP_WORKSPACES: repo })

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
    // the end of the range depends on how many commits the repo has; the start
    // is the thing "Older ›" is responsible for
    assert.ok(
      pages.some((p) => /^commits 16–\d+$/.test(p)),
      `Older › did not advance a page: ${JSON.stringify(pages)}`,
    )

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
  }

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

  test("a voice note is transcribed, shown, and run as the prompt", () => {
    // The engine is stubbed through the documented override so the assertion
    // is about jep's handling, not about what whisper heard. Everything before
    // it is real: the download, the container sniff, the afconvert decode.
    // (The trailing # swallows the audio path the override is handed.)
    const calls = replay("telegram-mock-voice.jsonl", { JEP_TRANSCRIBE_CMD: 'echo "say only the word ok" #' })

    const placeholder = calls.find((c) => c.text.includes("transcribing"))
    assert.ok(placeholder, "something is said immediately — silence reads as a dropped message")

    const receipt = calls.find((c) => c.method === "editMessageText" && c.text.startsWith("🎤 say only the word ok"))
    assert.ok(receipt, "the placeholder becomes what was heard")

    assert.ok(
      calls.some((c) => c.method === "sendMessageDraft"),
      "and then it runs as an ordinary prompt",
    )

    // the two failure paths say so rather than going quiet
    assert.ok(
      calls.some((c) => /limit is 10m/.test(c.text)),
      "an over-long note is refused with the limit and how to change it",
    )
    assert.ok(
      calls.some((c) => /couldn't transcribe/.test(c.text)),
      "and an undecodable one says what went wrong",
    )
  })

  test("the queue is visible, droppable and steerable", () => {
    const calls = replay("telegram-mock-queue.jsonl")

    // /queue on an idle chat is a real answer, not an empty screen
    assert.ok(
      calls.some((c) => JSON.stringify(c.rich ?? {}).includes("nothing running")),
      "an idle chat says so",
    )

    // three prompts fired in a row: one running, two behind it
    const views = calls.filter((c) => JSON.stringify(c.rich ?? {}).includes("waiting"))
    const counts = views.map((c) => JSON.stringify(c.rich).match(/waiting[^0-9]*(\d+)/)?.[1])
    assert.ok(counts.includes("2"), `expected a queue of 2, saw ${JSON.stringify(counts)}`)
    // dropping one has to change the list, not just answer the tap — the flag
    // alone used to leave the dropped turn sitting there
    assert.ok(counts.includes("1"), "dropping one leaves one")

    const answers = calls.filter((c) => c.method === "answerCallbackQuery").map((c) => c.text)
    assert.ok(answers.includes("dropped"), "a single drop is confirmed")
    assert.ok(
      answers.some((t) => /^dropped \d+$/.test(t)),
      "and so is clearing the rest",
    )
    assert.ok(
      answers.includes("that one is already running"),
      "the running turn is not droppable — ⏹ Stop is the button for that",
    )

    // /steer with no argument explains itself rather than sending nothing
    assert.ok(
      calls.some((c) => c.text.startsWith("usage: /steer")),
      "bare /steer says what it wants",
    )
    assert.ok(
      calls.some((c) => /saying this next/.test(c.text)),
      "and with an argument it says what it did",
    )
  })

  test("search finds a conversation by title and by what was said in it", () => {
    const home = mkdtempSync(join(tmpdir(), "jep-e2e-find-"))
    try {
      // The first pass creates the conversations; a prompt only reaches the
      // transcript when its queued turn runs, which is after this fixture's own
      // /find has already gone by. The second pass is the one with a past.
      replay("telegram-mock-find.jsonl", {}, home)
      const calls = replay("telegram-mock-find.jsonl", {}, home)

      assert.ok(
        calls.some((c) => c.text.startsWith("usage: /find")),
        "bare /find explains itself",
      )

      const results = calls.find((c) => JSON.stringify(c.rich ?? {}).includes("of them"))
      assert.ok(results, "the search reports what it found")
      const shown = JSON.stringify(results.rich)
      assert.match(shown, /the pelican thread/, "a title match")
      assert.match(shown, /unrelated notes/, "and a conversation that only *says* it")
      assert.match(shown, /standing on the jetty/, "with the line it was found in")
      assert.ok(shown.includes('"bold"'), "and the term marked inside that line")

      // the footer says what was actually searched, so "nothing" is never
      // mistaken for "not there"
      const miss = calls.find((c) => c.text.includes("nothing for"))
      assert.ok(miss, "a miss is reported")
      assert.match(miss.text, /searched \d+ titles? · \d+ transcripts?/)

      assert.ok(
        JSON.stringify(results.rich).includes("open:"),
        "and every hit is tappable through the same callback /ls uses",
      )
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("messages still queued when the process died are picked up", () => {
    const home = mkdtempSync(join(tmpdir(), "jep-e2e-recover-"))
    try {
      // A store as a crash would leave it: two prompts accepted, never run.
      // One is recent enough to be worth sending, one is from last week.
      writeFileSync(
        join(home, "store.json"),
        JSON.stringify({
          titles: {},
          models: {},
          pending: {
            "123": [
              { text: "Reply with the single word: resumed", queuedAt: Date.now() - 60_000 },
              { text: "Reply with the single word: ancient", queuedAt: Date.now() - 7 * 86_400_000 },
            ],
          },
        }),
      )
      // JEP_TG_OWNER stands in for the pairing that would have survived too
      const calls = replay("telegram-mock-recover.jsonl", { JEP_TG_OWNER: "123" }, home)

      const notice = calls.find((c) => c.text.includes("picking up"))
      assert.ok(notice, "the chat is told what was recovered")
      assert.match(notice.text, /1 message/, "only the recent one is resumed")
      assert.match(notice.text, /dropped 1 older one/, "and the stale one is named, not silently lost")
      assert.match(notice.text, /ancient/, "by what it said")

      assert.ok(
        calls.some((c) => c.method === "sendMessageDraft"),
        "the recovered prompt actually runs",
      )

      // and it is claimed immediately, so a crash loop cannot replay it
      const after = JSON.parse(readFileSync(join(home, "store.json"), "utf8")) as { pending?: Record<string, unknown[]> }
      assert.ok(!after.pending?.["123"]?.length, "the queue is not left to be replayed twice")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("usage reports the conversation's own spend", () => {
    const home = mkdtempSync(join(tmpdir(), "jep-e2e-usage-"))
    try {
      // same two-pass trick: usage only exists once a turn has actually run
      replay("telegram-mock-usage.jsonl", {}, home)
      const calls = replay("telegram-mock-usage.jsonl", {}, home)
      const view = calls.find((c) => JSON.stringify(c.rich ?? {}).includes("this conversation"))
      assert.ok(view, "/usage draws a screen")
      const shown = JSON.stringify(view.rich)
      assert.match(shown, /this workspace/, "and rolls the project up too")
      assert.match(shown, /tokens/)
      // the local default is a free model, and the harness prices it at zero —
      // which must read as $0, never as unknown
      assert.match(shown, /\$0/)
      assert.match(shown, /most recent conversation/, "with an honest scope footer")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("replying to a message relays its text in quotes", () => {
    // The referent the user is pointing at has to reach the harness, or the
    // prompt opens on a bare "this" with nothing to attach to. Here the queue
    // label *is* the relayed prompt (see #runTurn), so it is the evidence.
    const calls = replay("telegram-mock-reply.jsonl")

    const views = calls.filter((c) => JSON.stringify(c.rich ?? {}).includes("Replying to this message:"))
    assert.ok(views.length >= 3, "each reply carries its referent")
    const all = JSON.stringify(views.map((v) => v.rich))
    assert.match(all, /build failed/, "a bot message is quoted verbatim")
    assert.match(all, /a note from a person/, "a human message is quoted too")
    assert.match(all, /the rich answer/, "a rich bot message is quoted from its blocks")
  })

  test("settings offers MCP and skills screens that answer honestly", () => {
    // The mock harness's config has no mcp key and opencode has no skill
    // concept — both screens must say so plainly rather than rendering an
    // empty list that looks like a bug. Against the real machine these same
    // screens list the codex TOML servers and the ~/.claude skills.
    const calls = replay("telegram-mock-mcp.jsonl")
    const rich = calls.filter((c) => c.rich).map((c) => JSON.stringify(c.rich))
    assert.ok(
      rich.some((r) => r.includes("MCP servers") && r.includes("none configured")),
      "the MCP screen opens from settings and states the empty truth",
    )
    assert.ok(
      rich.some((r) => r.includes("Skills") && r.includes("no skills")),
      "a harness without skills is told, not faked",
    )
    assert.ok(rich.some((r) => r.includes("set:mcp") && r.includes("set:skills")), "settings root carries both entries")
  })

  test("the spinner goes out before anything is fetched or asked", () => {
    // A photo is the case that used to break this: the download (getFile, then
    // the bytes — two round trips to Telegram) was awaited before the turn was
    // even queued, so the screen stayed empty for exactly as long as the
    // attachment took to arrive.
    const calls = replay("telegram-mock-spinner.jsonl")

    const spinner = calls.findIndex((c) => c.method === "sendMessageDraft" && /text=""/.test(c.text))
    assert.ok(spinner !== -1, "the turn opens with an empty draft, which is the native shimmer")
    assert.match(calls[spinner]!.text, /can_stop=true/, "and it carries the stop button")

    // nothing about the turn may precede it: not the typing action, not a
    // content frame, not the reply
    const firstTurnWork = calls.findIndex(
      (c) => c.method === "sendChatAction" || c.method === "sendRichMessageDraft" || c.method === "sendRichMessage",
    )
    assert.ok(
      firstTurnWork === -1 || spinner < firstTurnWork,
      `something reached the chat before the spinner: ${calls[firstTurnWork]?.method}`,
    )

    // and the photo still got through to the model afterwards
    assert.ok(
      calls.some((c) => c.method === "sendRichMessage" || c.method === "sendRichMessageDraft"),
      "the turn still ran",
    )
  })
})