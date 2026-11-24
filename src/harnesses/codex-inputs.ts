// Native Codex rollouts omit inputs rejected before a turn starts (for
// example invalid CLI arguments). Keep those words visible after a refresh.
import { mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import type { Message } from "../core/types.ts"

const directory = (home: string, thread: string): string => join(home, "jep-failed-inputs", encodeURIComponent(thread))

export const forgetFailedCodexInputs = (home: string, thread: string): Promise<void> => rm(directory(home, thread), { recursive: true, force: true })

export async function rememberFailedCodexInput(home: string, thread: string, text: string, time: number): Promise<void> {
  const dir = directory(home, thread)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const id = randomUUID()
  const message: Message = {
    id: `codex://${thread}:failed-input-${id}`,
    sessionID: `codex://${thread}`,
    role: "user",
    time,
    parts: [{ kind: "text", text }],
  }
  await writeFile(join(dir, `${time}-${id}.json`), JSON.stringify(message), { mode: 0o600 })
}

export async function failedCodexInputs(home: string, thread: string): Promise<Message[]> {
  const dir = directory(home, thread)
  const files = await readdir(dir).catch(() => [] as string[])
  const messages: Message[] = []
  for (const file of files) {
    if (!file.endsWith(".json")) continue
    try {
      const message = JSON.parse(await readFile(join(dir, file), "utf8")) as Message
      if (message.role === "user" && message.sessionID === `codex://${thread}` && Array.isArray(message.parts)) messages.push(message)
    } catch { /* a receipt still being written is picked up on the next read */ }
  }
  return messages
}
