import type { DomainEvent } from "./types.ts"

// Waking a sleeping phone.
//
// A backgrounded Android app's sockets are frozen, so a push is the only way
// to reach it with nothing running — and the only way to do that without a
// foreground service, which the OS insists on announcing with a standing
// notification. This port is the sender; who may be woken and with what is
// here, and how it travels is the adapter's business.

/** A fact delivered to a device, never a notification: the payload is data and
 * the client decides what — if anything — to show. Sending a `notification`
 * payload would let FCM draw it, putting presentation in the daemon's hands. */
export interface PushMessage {
  sessionID: string
  /** the fact's own name, not a sentence */
  kind: "turn.finished" | "ask.requested"
  title?: string
}

/**
 * Which facts are worth waking a phone for. A transport decision, not a
 * presentation one — the same reason the daemon owns `turn.aborted` and the
 * client owns `NotificationPolicy`.
 *
 * A finished turn is the point of the whole exercise. An ask is the harness
 * blocked on an answer: nothing moves until somebody looks.
 */
export const pushFor = (event: DomainEvent): PushMessage | null => {
  switch (event.type) {
    case "session.idle":
      return { sessionID: event.sessionID, kind: "turn.finished" }
    case "ask.requested":
      return { sessionID: event.ask.sessionID, kind: "ask.requested", title: event.ask.title }
    default:
      return null
  }
}

/** The device is gone — an uninstall, a wiped token, a restored phone.
 * Retrying it forever would be a leak; the sender prunes it instead. Part of
 * the port so the gateway never has to know which service reported it. */
export class UnregisteredToken extends Error {}

/** the driven port: how a wake actually reaches one device */
export interface PushNotifier {
  /** @returns true when delivered; throws UnregisteredToken when the token is dead */
  send(deviceToken: string, message: PushMessage): Promise<boolean>
}
