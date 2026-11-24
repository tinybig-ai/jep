import type { ModelRef } from "./ports.ts"

/** Only the first slash separates provider from model; model ids can contain
 * provider namespaces of their own (e.g. litellm/chatgpt/gpt-5.6-luna). */
export function parseModelRef(ref: string | undefined): ModelRef | undefined {
  const at = ref?.indexOf("/") ?? -1
  if (!ref || at <= 0 || at === ref.length - 1) return undefined
  return { providerID: ref.slice(0, at), modelID: ref.slice(at + 1) }
}
