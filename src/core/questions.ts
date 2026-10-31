import type { AskOption, AskQuestion, AskRequest } from "./types.ts"

// A question as a harness states it. opencode's `question` tool says `multiple`;
// Claude's AskUserQuestion (and the ACP bridge over it) says `multiSelect`; both
// carry `header`, the question text, and labelled options. One parser turns
// either into the shape every client already draws, so no client learns which
// harness asked.
export interface RawQuestion {
  question?: string
  header?: string
  multiple?: boolean
  multiSelect?: boolean
  options?: Array<{ label?: string; description?: string }>
}

export interface GroupedQuestions {
  /** one per question, each holding only its own choices */
  questions: AskQuestion[]
  /** every option across every question, for the answer plumbing */
  options: AskOption[]
  /** option id -> the whole label the harness must receive back */
  labels: Map<string, string>
  /** the key the harness keys its answers by, in question order (the text) */
  keys: string[]
  count: number
}

// ids carry a question index and a clipped label, so a tap names both the slot
// it fills and the answer it carries; the full label is remembered separately
const LABEL_ID_MAX = 28

export const groupAskQuestions = (raw: RawQuestion[]): GroupedQuestions => {
  const options: AskOption[] = []
  const labels = new Map<string, string>()
  const keys: string[] = []
  const questions: AskQuestion[] = raw.map((q, qi) => {
    const own: AskOption[] = []
    for (const o of q.options ?? []) {
      const label = String(o?.label ?? "").trim()
      if (!label) continue
      const id = `${qi}:${label.slice(0, LABEL_ID_MAX)}`
      const option: AskOption = { id, label: label.slice(0, 64) }
      own.push(option)
      options.push(option)
      labels.set(id, label)
    }
    keys.push(String(q.question ?? q.header ?? "").trim())
    return {
      title: String(q.header || q.question || "question").trim(),
      ...(q.question ? { detail: q.question } : {}),
      ...(q.multiple || q.multiSelect ? { multiple: true } : {}),
      options: own,
    }
  })
  return { questions, options, labels, keys, count: questions.length }
}

// A client answers a whole multi-question ask in one option id: a JSON array of
// the ids it picked, so the harness gets every answer at once (it cannot accept
// a partial reply — the turn stays parked until the answers arrive together). A
// one-question ask still sends the bare id, and a bare id is not valid JSON, so
// JSON is only attempted for something that looks like an array.
export function parseOptionIDs(optionID: string): string[] {
  const trimmed = optionID.trim()
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed)
      if (Array.isArray(parsed)) {
        return parsed.filter((x): x is string => typeof x === "string" && x.length > 0)
      }
    } catch {
      // not JSON after all: fall through and treat it as a single id
    }
  }
  return optionID ? [optionID] : []
}

// The harness takes one list of labels per question, in order. Drop each picked
// id into its question's slot: several labels land in one slot when the question
// allowed a multiple choice, and a question nobody touched keeps its empty list
// rather than shifting the ones after it along.
export const answersByQuestion = (
  optionID: string,
  grouped: Pick<GroupedQuestions, "count" | "labels">,
): string[][] => {
  const out: string[][] = Array.from({ length: Math.max(grouped.count, 1) }, () => [])
  for (const id of parseOptionIDs(optionID)) {
    const label = grouped.labels.get(id) ?? id
    const prefix = id.slice(0, id.indexOf(":"))
    const qi = /^\d+$/.test(prefix) ? Number(prefix) : 0
    out[qi >= 0 && qi < out.length ? qi : 0]!.push(label)
  }
  return out
}

// Claude's AskUserQuestion tool reads its answers as one string per question:
// a multi-select is comma-joined, and any item that itself holds the separator
// or a quote is JSON-quoted so it stays one item when the tool splits it back.
const joinAnswer = (items: string[]): string =>
  items.map((item) => (item.includes(", ") || item.includes('"') ? JSON.stringify(item) : item)).join(", ")

/**
 * The `answers` map AskUserQuestion's tool reads out of `updatedInput`, keyed by
 * each question's text. A question left blank is omitted (the tool reports it
 * skipped), which is the closest the option UI can come to "no answer".
 */
export const answersFor = (optionID: string, grouped: GroupedQuestions): Record<string, string> => {
  const lists = answersByQuestion(optionID, grouped)
  const answers: Record<string, string> = {}
  grouped.questions.forEach((q, i) => {
    const key = grouped.keys[i] ?? ""
    const picked = lists[i] ?? []
    if (!key || picked.length === 0) return
    answers[key] = q.multiple ? joinAnswer(picked) : picked.join(", ")
  })
  return answers
}

/**
 * The ask a harness's question tool produces, when its input carries questions.
 * A harness with no questions (or a malformed list) is not a question ask, and
 * the caller falls back to its permission path. Pure, so both the adapter and
 * its tests agree on the shape without a live model.
 */
export const questionAsk = (
  id: string,
  sessionID: string,
  input: Record<string, unknown>,
  opts: { callID?: string; at?: number } = {},
): { ask: AskRequest; grouped: GroupedQuestions } | null => {
  const raw = input.questions
  if (!Array.isArray(raw) || raw.length === 0) return null
  const grouped = groupAskQuestions(raw as RawQuestion[])
  if (!grouped.count) return null
  const first = grouped.questions[0]
  const ask: AskRequest = {
    id,
    sessionID,
    kind: "question",
    title: grouped.count > 1 ? `${grouped.count} questions` : first?.title || "question",
    ...(grouped.count === 1 && first?.detail ? { detail: first.detail } : {}),
    options: grouped.options,
    questions: grouped.questions,
    ...(opts.callID ? { callID: opts.callID } : {}),
    at: opts.at ?? Date.now(),
  }
  return { ask, grouped }
}
