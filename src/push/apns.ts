import { createSign } from "node:crypto"
import { readFile } from "node:fs/promises"
import { connect } from "node:http2"
import { UnregisteredToken, type PushMessage, type PushNotifier } from "../core/push.ts"

// Apple Push Notification service, token-based auth over HTTP/2. No SDK, for
// the same reason as fcm.ts: one signed JWT and one POST per device, and the
// only secret (the .p8 key) stays in a file the operator points at.
//
// iOS will not run an app to decide on a data-only push the way Android does,
// so the alert carries a localization key instead of words: the app's own
// Localizable.strings says what a finished turn or an ask reads as, and
// presentation stays with the client.

export interface ApnsConfig {
  /** the .p8 signing key's PEM text */
  key: string
  keyID: string
  teamID: string
  /** the app's bundle id */
  topic: string
  sandbox?: boolean
}

/** one HTTP/2 POST; swapped out in tests */
export type ApnsPost = (url: string, headers: Record<string, string>, body: string) => Promise<{ status: number; body: string }>

const b64url = (input: Buffer | string): string => Buffer.from(input).toString("base64url")

export const apnsPayload = (message: PushMessage): Record<string, unknown> => ({
  aps: {
    alert:
      message.kind === "ask.requested"
        ? { "loc-key": "JEP_ASK_REQUESTED", "loc-args": [message.title ?? ""] }
        : { "loc-key": "JEP_TURN_FINISHED" },
    sound: "default",
    "thread-id": message.sessionID,
  },
  kind: message.kind,
  sessionID: message.sessionID,
  ...(message.title ? { title: message.title } : {}),
})

const http2Post: ApnsPost = (url, headers, body) =>
  new Promise((resolve, reject) => {
    const u = new URL(url)
    const session = connect(u.origin)
    session.on("error", reject)
    const req = session.request({ ":method": "POST", ":path": u.pathname, ...headers })
    req.setTimeout(15_000, () => req.close())
    let status = 0
    let text = ""
    req.on("response", (h) => (status = Number(h[":status"]) || 0))
    req.setEncoding("utf8")
    req.on("data", (chunk: string) => (text += chunk))
    req.on("end", () => {
      session.close()
      resolve({ status, body: text })
    })
    req.on("error", (err) => {
      session.close()
      reject(err)
    })
    req.end(body)
  })

export class ApnsNotifier implements PushNotifier {
  #config: ApnsConfig
  #post: ApnsPost
  #jwt: { value: string; issuedAt: number } | null = null

  constructor(config: ApnsConfig, post: ApnsPost = http2Post) {
    this.#config = config
    this.#post = post
  }

  /** JEP_APNS_KEY (a .p8 path), JEP_APNS_KEY_ID, JEP_APNS_TEAM_ID, JEP_APNS_TOPIC, JEP_APNS_SANDBOX=1 */
  static async fromEnv(env: NodeJS.ProcessEnv): Promise<ApnsNotifier> {
    const { JEP_APNS_KEY, JEP_APNS_KEY_ID, JEP_APNS_TEAM_ID, JEP_APNS_TOPIC } = env
    if (!JEP_APNS_KEY || !JEP_APNS_KEY_ID || !JEP_APNS_TEAM_ID || !JEP_APNS_TOPIC) {
      throw new Error("APNs needs JEP_APNS_KEY, JEP_APNS_KEY_ID, JEP_APNS_TEAM_ID and JEP_APNS_TOPIC")
    }
    return new ApnsNotifier({
      key: await readFile(JEP_APNS_KEY, "utf8"),
      keyID: JEP_APNS_KEY_ID,
      teamID: JEP_APNS_TEAM_ID,
      topic: JEP_APNS_TOPIC,
      sandbox: env.JEP_APNS_SANDBOX === "1",
    })
  }

  get topic(): string {
    return this.#config.topic
  }

  // Apple wants the token refreshed between 20 and 60 minutes old
  #token(): string {
    const now = Math.floor(Date.now() / 1000)
    if (this.#jwt && now - this.#jwt.issuedAt < 40 * 60) return this.#jwt.value
    const header = b64url(JSON.stringify({ alg: "ES256", kid: this.#config.keyID }))
    const claims = b64url(JSON.stringify({ iss: this.#config.teamID, iat: now }))
    const signer = createSign("SHA256")
    signer.update(`${header}.${claims}`)
    const sig = signer.sign({ key: this.#config.key, dsaEncoding: "ieee-p1363" })
    this.#jwt = { value: `${header}.${claims}.${b64url(sig)}`, issuedAt: now }
    return this.#jwt.value
  }

  async send(deviceToken: string, message: PushMessage): Promise<boolean> {
    const host = this.#config.sandbox ? "api.sandbox.push.apple.com" : "api.push.apple.com"
    const res = await this.#post(
      `https://${host}/3/device/${deviceToken}`,
      {
        authorization: `bearer ${this.#token()}`,
        "apns-topic": this.#config.topic,
        "apns-push-type": "alert",
        "apns-priority": "10",
        "content-type": "application/json",
      },
      JSON.stringify(apnsPayload(message)),
    )
    if (res.status === 200) return true
    const body = res.body.slice(0, 300)
    // 410 is Apple saying the token is gone; BadDeviceToken is one that never was
    if (res.status === 410 || /BadDeviceToken|Unregistered|DeviceTokenNotForTopic/.test(body)) throw new UnregisteredToken(body)
    throw new Error(`apns send -> ${res.status}: ${body}`)
  }
}
