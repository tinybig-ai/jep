import type { AskAction, AskDisplay, AskOption, AskRequest } from "./types.ts"

// What an ask is asking, in a person's words.
//
// Every harness names a permission its own way — opencode says
// `external_directory`, with the path down in `detail` — and a notification
// built from that name reads `externaldirectory`, which tells the person
// nothing. The adapter still owns the raw title (it is what the harness will
// understand); this turns it into a sentence a screen can show, and says which
// options mean "go ahead" and "no" so a notifier need not know a harness's
// option ids.

const VERBS: Record<string, string> = {
  external_directory: "Access a folder outside the project",
  externaldirectory: "Access a folder outside the project",
  bash: "Run a command",
  shell: "Run a command",
  edit: "Edit a file",
  write: "Write a file",
  read: "Read a file",
  glob: "List files",
  grep: "Search files",
  list: "List files",
  webfetch: "Fetch a web page",
  websearch: "Search the web",
  task: "Start a subagent",
  skill: "Use a skill",
  lsp: "Ask the language server",
  todo: "Update the plan",
}

/** `external_directory` -> `External directory`; an unknown name is still
 *  readable once its separators are gone */
const human = (title: string): string => {
  const words = title.replace(/[._-]+/g, " ").replace(/\s+/g, " ").trim()
  if (!words) return "Needs a decision"
  return words[0]!.toUpperCase() + words.slice(1)
}

/** the verb a permission names, as a question */
export const permissionTitle = (title: string): string => {
  const verb = VERBS[title.trim().toLowerCase()]
  if (verb) return `${verb}?`
  return `${human(title).replace(/[?.\s]+$/, "")}?`
}

const roleOf = (option: AskOption): AskAction["role"] => {
  const text = `${option.id} ${option.label}`.toLowerCase()
  if (option.style === "danger" || /\b(reject|deny|decline|no|stop|cancel|abort)\b/.test(text)) return "reject"
  if (/\b(always|all|forever|don.t ask)\b/.test(text)) return "always"
  if (/\b(allow|approve|accept|yes|once|ok|continue|proceed|run)\b/.test(text)) return "allow"
  return "answer"
}

const clip = (text: string, max = 300): string => {
  const one = text.replace(/\r\n/g, "\n").trim()
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one
}

/**
 * The one place that decides how an ask reads and which of its options are the
 * yes and the no. Clients and notifications both go through it, so a path, a
 * command, or a question gets the same words wherever it is shown.
 */
export const describeAsk = (ask: AskRequest): AskDisplay => {
  const actions: AskAction[] = ask.options.map((o) => {
    const role = roleOf(o)
    return { id: o.id, label: o.label.replace(/\s+/g, " ").trim(), role, ...(o.style ? { style: o.style } : {}) }
  })
  const allow = actions.find((a) => a.role === "allow") ?? actions.find((a) => a.role === "always")
  const reject = actions.find((a) => a.role === "reject")
  const first = ask.questions?.[0]
  const isQuestion = ask.kind === "question" || Boolean(ask.questions?.length)
  const detail = ask.detail?.trim()
  // a multi-question ask is answered per question; one button cannot stand in
  // for the whole set, so it gets no notification actions
  const answerable = !isQuestion || (ask.questions?.length ?? 0) <= 1
  const body = (detail && detail !== ask.title ? detail : "") || first?.detail?.trim() || ""
  return {
    title: isQuestion ? human(ask.title) : permissionTitle(ask.title),
    // empty is a fact: a notification then shows only the sentence, and its
    // client supplies whatever "waiting" line it has in its own language
    body: clip(body || (isQuestion ? first?.title ?? "" : "")),
    actions,
    ...(answerable && allow ? { allow: allow.id } : {}),
    ...(answerable && reject ? { reject: reject.id } : {}),
  }
}
