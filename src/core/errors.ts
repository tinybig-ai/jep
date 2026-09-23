// Renders a HarnessError for humans, in one place: the Telegram bot, the
// gateway and the phone all say a provider failure the same way. What broke,
// on which provider/model, and the provider's own words.
import type { HarnessError } from "./types.ts"

export const describeError = (e: HarnessError): string => {
  const loc = e.provider && e.model ? `${e.provider}/${e.model}` : (e.provider ?? e.model ?? "")
  const tags = [loc, e.status ? `HTTP ${e.status}` : ""].filter(Boolean)
  const tail = tags.length ? ` (${tags.join(", ")})` : ""
  // "error" as a name says nothing; name the failure only when it has a real one
  const named = e.name && !/^error$/i.test(e.name)
  return named ? `${e.name}${tail}: ${e.message}` : `${e.message}${tail}`
}
