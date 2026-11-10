import type { ModelRef } from "./ports.ts"

/** Provider is the prefix; model ids may contain further namespace slashes. */
export function parseModelRef(ref: string | undefined): ModelRef | undefined {
  const at = ref?.indexOf("/") ?? -1
  if (!ref || at <= 0 || at === ref.length - 1) return undefined
  return { providerID: ref.slice(0, at), modelID: ref.slice(at + 1) }
}
