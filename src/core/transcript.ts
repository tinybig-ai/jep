// The first prompt of a fresh session carries a jep context header (see
// JEP_CONTEXT): a note telling the harness it is being driven through jep, not
// a terminal, and naming the shell tools jep puts within reach (jep-watch,
// jep-restart, jep-show) so the agent can find them with no setup. It is
// addressed to the model, not the reader. Left in a transcript it buries the
// message a person actually sent under a screen of preamble, so every client
// strips it before showing history. The cleanup is pure and lives here so no
// client has to reinvent it.
export const JEP_CONTEXT = [
  "[jep context — background only, not a request]",
  "This conversation is relayed through jep, a phone-first control plane for coding agents (headless, no terminal on the other end). jep's own code and docs are in this checkout — see docs/PROCESSES.md and docs/PHILOSOPHY.md.",
  "",
  "jep exposes these tools for the agent to use:",
  "  jep-watch   -- wait for a condition (e.g., a test to pass, a file to appear)",
  "  jep-restart -- queue a daemon restart (waits for all turns to end, then restarts)",
  "  jep-rename  -- give this conversation a new title",
  "  jep-read    -- read another conversation (the person is asked first; --list shows them)",
  "  jep-show    -- display an image file in the phone (path or URL)",
  "Run them as shell commands. They find the conversation from the working directory.",
].join("\n")
export const JEP_CONTEXT_FOOTER = "Ignore the block above. Treat the message below as the user's entire, only request.\n---"

// The header to put ahead of a prompt, or "" when it must not be added. It is
// added once per conversation, not per turn: the first prompt of a fresh
// session carries it, so the model learns jep is driving and which shell tools
// jep exposes, without paying for the block on every turn. `briefed` is the
// adapter's own set of conversations that have been briefed, so it is the one
// truth whichever client sends the turn.
//
// It stands down when the text already carries the footer: the Telegram bot
// builds its own header (with its own extra line and its own per-chat toggle),
// and a second copy would just be noise. `brief === false` is the client
// saying "not this turn" (the bot's context toggle). Every adapter calls this
// the same way, so the tools are announced on every harness without any of
// them (or their clients) growing a special case.
export const contextFor = (text: string, briefed: Set<string>, key: string, brief = true): string => {
  if (!brief) return ""
  if (text.includes(JEP_CONTEXT_FOOTER)) {
    briefed.add(key)
    return ""
  }
  if (briefed.has(key)) return ""
  briefed.add(key)
  return `${JEP_CONTEXT}\n\n${JEP_CONTEXT_FOOTER}\n\n`
}

export const stripInjectedContext = (text: string): string => {
  const i = text.indexOf(JEP_CONTEXT_FOOTER)
  return i === -1 ? text : text.slice(i + JEP_CONTEXT_FOOTER.length)
}

// An attachment has no flag in a print-mode CLI, so naming the paths in the
// prompt is what lets the agent open them. That list is jep talking to the
// harness, not part of the message — shown back to the reader it appears as if
// they typed a filesystem path they never saw, and it makes the text the
// harness recorded differ from the text the client sent, so a client matching
// its own outgoing message against the record never finds it.
// Built here and stripped here, so the two can't drift.
export const ATTACHMENT_HEADER = "Attached files:"

export const withAttachments = (text: string, paths: string[] = []): string =>
  paths.length ? `${text}\n\n${ATTACHMENT_HEADER}\n${paths.map((p) => `- ${p}`).join("\n")}` : text

// A quote is part of a message: the words it answers, shown above it the way a
// chat app shows a reply. No harness has a reply-to, and the model has to read
// the quoted words, so each adapter hands them over in the most structured form
// its harness takes (opencode: a part of its own, tagged; claude: a content
// block of its own; codex: text only) and reads back only what it wrote. This
// is the block the model reads, the same on every harness.
export const QUOTE_HEADER = "[in reply to]"

export const quoteBlock = (quote: string): string =>
  `${QUOTE_HEADER}\n${quote.trim().split("\n").map((l) => (l.trim() ? `> ${l}` : ">")).join("\n")}`

/** the quote in a block quoteBlock wrote, or null: the whole block must be one */
export const readQuoteBlock = (block: string): string | null => {
  if (!block.startsWith(`${QUOTE_HEADER}\n`)) return null
  const lines = block.slice(QUOTE_HEADER.length + 1).trimEnd().split("\n")
  if (!lines.every((l) => l.startsWith(">"))) return null
  return lines.map((l) => l.replace(/^> ?/, "")).join("\n").trim() || null
}

// A loop continuation is jep talking to the harness: the marker names the
// iteration, and the body is the next instruction. It is a boundary in the
// conversation, not something a person said, so clients draw a divider and
// never the words.
const LOOP_MARKER = /^<!-- jep:loop (\d{1,3})\/(\d{1,3}) -->\n?/

export const loopMarker = (iteration: number, max: number): string => `<!-- jep:loop ${iteration}/${max} -->`

export const readLoopMarker = (text: string): { iteration: number; max: number } | null => {
  const m = text.match(LOOP_MARKER)
  return m ? { iteration: Number(m[1]), max: Number(m[2]) } : null
}

// A watch's wake-up is jep talking to the harness for the same reason a loop
// continuation is: the person did not type it, the daemon did, so it must never
// come back as one of their messages. The marker carries the one thing the
// client needs to name it — how the wait ended, and how long it was given — and
// the body (the note, the check, its output) stays in the transcript for the
// model, out of the bubble for the reader.
const NOTICE_MARKER = /^<!-- jep:notice (done|timeout|resumed)(?: (\d{1,5}))? -->\n?/

/** done/timeout: how a watch ended; resumed: a restart cut the turn off and jep picked it up */
export type NoticeKind = "done" | "timeout" | "resumed"

export const noticeMarker = (kind: NoticeKind, minutes?: number): string =>
  kind === "timeout" && minutes !== undefined ? `<!-- jep:notice ${kind} ${minutes} -->` : `<!-- jep:notice ${kind} -->`

export const readNoticeMarker = (text: string): { kind: NoticeKind; minutes?: number } | null => {
  const m = text.match(NOTICE_MARKER)
  if (!m) return null
  return { kind: m[1] as NoticeKind, ...(m[2] ? { minutes: Number(m[2]) } : {}) }
}

/** is this whole message jep's own scaffolding (a loop's next step, a watch's
 *  wake-up)? A harness that builds parts out of transcriptText() would empty
 *  such a message; it keeps the raw text instead, and the client, which knows
 *  the marker, draws a boundary and hides the body. */
export const isScaffold = (text: string): boolean => {
  const bare = stripInjectedContext(text)
  return Boolean(readLoopMarker(bare) ?? readNoticeMarker(bare))
}

/** for a harness that takes only text: the block, a blank line, the message */
export const withQuoteText = (text: string, quote?: string): string =>
  quote?.trim() ? `${quoteBlock(quote)}\n\n${text}` : text

/** undo withQuoteText, and nothing else: a message that does not open with
 *  the header is left whole, whatever markdown it holds */
export const splitQuoteText = (text: string): { quote?: string; text: string } => {
  if (!text.startsWith(`${QUOTE_HEADER}\n`)) return { text }
  const end = text.indexOf("\n\n")
  if (end < 0) return { text }
  const quote = readQuoteBlock(text.slice(0, end))
  return quote ? { quote, text: text.slice(end + 2) } : { text }
}

// Anchored to the end and only over lines that are all "- <path>", so a message
// that merely talks about attached files keeps its words.
// the blank line before it is gone when the message was only pictures and a harness trimmed the start
const ATTACHMENT_BLOCK = new RegExp(`(?:^|\\n{2})${ATTACHMENT_HEADER}\\n(?:- [^\\n]+(?:\\n|$))+$`)

export const stripAttachments = (text: string): string => text.replace(ATTACHMENT_BLOCK, "")

/** the paths an attachment list names, so a client can show them as files
 *  again once the list itself is stripped from the text */
export const attachedPaths = (text: string): string[] => {
  const block = text.match(ATTACHMENT_BLOCK)?.[0]
  if (!block) return []
  return block.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2).trim()).filter(Boolean)
}

// A harness splices a lot of machinery into the user's half of a transcript:
// background-task notifications, the envelope around a slash command, the
// stdout of a `!` shell line, system reminders. All of it is addressed to the
// model, and replayed in /log it reads as the user saying things they never
// said. Dropped whole — a turn that was only machinery disappears.
const NOISE_BLOCKS = [
  "system-reminder",
  "task-notification",
  "local-command-caveat",
  "local-command-stdout",
  "bash-stdout",
  "bash-stderr",
  "interrupted-output",
  "command-message",
  "command-args",
]

// These wrap something a person really said — a message relayed from another
// chat, or from a peer session — in routing metadata. The envelope goes, the
// message stays.
const UNWRAP_BLOCKS = ["channel", "cross-session-message"]

export const dropBlocks = (text: string): string => {
  let out = text
  for (const name of UNWRAP_BLOCKS) out = out.replace(new RegExp(`</?${name}(\\s[^>]*)?>`, "g"), "")
  for (const name of NOISE_BLOCKS) {
    out = out.replace(new RegExp(`<${name}>[\\s\\S]*?</${name}>`, "g"), "")
    // an unclosed one means the harness truncated mid-block; the rest of the
    // message is that block's tail, so it goes too
    out = out.replace(new RegExp(`<${name}>[\\s\\S]*$`), "")
  }
  return out.replace(/\n{3,}/g, "\n\n").trim()
}

// What the user actually typed, recovered from however the harness recorded
// it. A slash command and a `!` shell line are real input and stay; their
// surrounding bookkeeping does not.
export const transcriptText = (raw: string): string => {
  const text = stripAttachments(stripInjectedContext(raw))
  // jep's own scaffolding is not anybody's words: the marker is the whole
  // message, and the client draws it as a boundary instead
  if (readLoopMarker(text) || readNoticeMarker(text)) return ""
  const cmd = text.match(/<command-name>([^<]*)<\/command-name>/)
  if (cmd) {
    const args = text.match(/<command-args>([^<]*)<\/command-args>/)
    return [cmd[1]?.trim(), args?.[1]?.trim()].filter(Boolean).join(" ")
  }
  const bash = text.match(/<bash-input>([\s\S]*?)<\/bash-input>/)
  if (bash) return `! ${bash[1]!.trim()}`
  return dropBlocks(text)
}
