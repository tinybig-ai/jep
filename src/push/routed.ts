import type { PushMessage, PushNotifier } from "../core/push.ts"

// One gateway, phones of both kinds. An iOS device registers its token as
// "apns:<hex>"; anything else is an FCM token, which is what Android has always
// sent. The gateway keeps one token list and never learns which is which.

export const APNS_PREFIX = "apns:"

export const routedNotifier = (senders: { fcm?: PushNotifier; apns?: PushNotifier }): PushNotifier => ({
  async send(deviceToken: string, message: PushMessage): Promise<boolean> {
    if (deviceToken.startsWith(APNS_PREFIX)) {
      return senders.apns ? senders.apns.send(deviceToken.slice(APNS_PREFIX.length), message) : false
    }
    return senders.fcm ? senders.fcm.send(deviceToken, message) : false
  },
})
