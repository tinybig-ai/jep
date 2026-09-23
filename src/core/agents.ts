// A requested agent id the harness doesn't offer is not an error: it just isn't
// a switch, so the turn runs under the harness default. The adapter is the only
// one who knows its own ids, so adapters and clients share this one rule rather
// than each hardcoding a vocabulary.
import type { AgentRef } from "./ports.ts"

export const resolveAgent = (agents: AgentRef[] | undefined, id: string | null | undefined): string | undefined =>
  id && agents?.some((a) => a.id === id) ? id : undefined
