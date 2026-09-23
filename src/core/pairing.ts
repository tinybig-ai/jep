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
  hint?: string
}

export interface PairingAdmin {
  readonly client: string
  status(): PairingStatus
  /** set by the composition root; called when the code or device set changes */
  onChange?: () => void
}
