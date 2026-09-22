package dev.jep.client.device

import dev.jep.client.domain.repository.ChatEvent

// What is worth interrupting the person for. Deliberately the *client's* call,
// not the daemon's: the daemon says how a turn ended (see core/types.ts), and
// what that deserves — a notification, a list mark, silence — depends on the
// client. A CLI would print, Telegram sends a message, this notifies.
//
// Pure, so the rules can be tested without Android.
object NotificationPolicy {

    /** what an event is worth telling the person about, if anything */
    enum class Notice { FINISHED, ASKED }

    /**
     * @param openSessionId the conversation on screen, when the app is up
     * @param foreground     whether the app is in front of the person
     */
    fun decide(event: ChatEvent, openSessionId: String?, foreground: Boolean): Notice? {
        // they are looking at this very conversation — never interrupt
        if (foreground && openSessionId != null && openSessionId == event.sessionId) return null
        // the app is up: the conversation list carries the signal instead, so a
        // notification would only be noise on top of what they can already see
        if (foreground) return null
        return when (event) {
            // a finished turn is the thing worth reaching for the phone for
            is ChatEvent.Quiet -> Notice.FINISHED
            // the harness is blocked on an answer; nothing moves until they act
            is ChatEvent.Asked -> Notice.ASKED
            // a failure, a stop, a dropped feed: not worth an interruption, and
            // the chat shows them when opened
            else -> null
        }
    }
}
