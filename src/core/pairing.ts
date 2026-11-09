import { randomBytes } from "node:crypto"
// Pairing is a per-client concern: Telegram locks the bot to a chat-id owner,
// the gateway hands out device tokens. But "show me the current codes" is
// shared, so each client reports its state through this one small admin port
// and tooling never has to read a client's private file format.
export interface PairingStatus {
  client: string
  label: string
  code?: string
  owner?: string | null
  devices: number
  /** the port a client listens on, when it has one */
  port?: number
  hint?: string
}

export interface PairingAdmin {
  readonly client: string
  status(): PairingStatus
  /** set by the composition root; called when the code or device set changes */
  onChange?: () => void
}

// a pairing code a person types into a client: unambiguous letters and digits
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

/**
 * What was typed, in the form codes are minted in: upper case, with no spaces or dashes. A phone keyboard
 * types lower case, and a code read aloud or copied out of a chat arrives with a space or a dash in it;
 * none of that should make the right code "wrong".
 */
export const normalizePairCode = (typed: string): string => typed.replace(/[\s-]+/g, "").toUpperCase()

export function newPairCode(): string {
  const b = randomBytes(9)
  let out = ""
  for (let i = 0; i < 9; i++) out += ALPHABET[b[i]! % ALPHABET.length]!
  return out
}
