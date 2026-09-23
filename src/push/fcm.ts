import { createSign } from "node:crypto"
import { readFile } from "node:fs/promises"
import { UnregisteredToken, type PushMessage, type PushNotifier } from "../core/push.ts"

// Firebase Cloud Messaging, HTTP v1. No SDK: the daemon mints its own OAuth2
// token from the service account (an RS256 JWT exchanged for an access token)
// and posts one message per device. Two reasons it is written out rather than
// pulled in — a Firebase admin SDK is a large dependency for one HTTP call,
// and this keeps the only secret (the service account key) in one file that
// the operator points at, never in the repo.

interface ServiceAccount {
  client_email: string
  private_key: string
  project_id: string
}

const TOKEN_URL = "https://oauth2.googleapis.com/token"
const SCOPE = "https://www.googleapis.com/auth/firebase.messaging"
const b64url = (input: Buffer | string): string => Buffer.from(input).toString("base64url")

export class FcmNotifier implements PushNotifier {
  #account: ServiceAccount
  #access: { value: string; expiresAt: number } | null = null

  constructor(account: ServiceAccount) {
    this.#account = account
  }

  /** @param path the service account JSON, e.g. from a GCP service account key */
  static async fromFile(path: string): Promise<FcmNotifier> {
    const account = JSON.parse(await readFile(path, "utf8")) as ServiceAccount
    if (!account.client_email || !account.private_key || !account.project_id) {
      throw new Error(`${path} is not a service account key (needs client_email, private_key, project_id)`)
    }
    return new FcmNotifier(account)
  }

  get projectID(): string {
    return this.#account.project_id
  }

  async #accessToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000)
    if (this.#access && this.#access.expiresAt - 60 > now) return this.#access.value

    const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))
    const claims = b64url(
      JSON.stringify({ iss: this.#account.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 }),
    )
    const signer = createSign("RSA-SHA256")
    signer.update(`${header}.${claims}`)
    const assertion = `${header}.${claims}.${b64url(signer.sign(this.#account.private_key))}`

    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) throw new Error(`fcm auth -> ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const data = (await res.json()) as { access_token?: string; expires_in?: number }
    if (!data.access_token) throw new Error("fcm auth returned no access_token")
    this.#access = { value: data.access_token, expiresAt: now + (data.expires_in ?? 3600) }
    return this.#access.value
  }

  async send(deviceToken: string, message: PushMessage): Promise<boolean> {
    const access = await this.#accessToken()
    const res = await fetch(`https://fcm.googleapis.com/v1/projects/${this.#account.project_id}/messages:send`, {
      method: "POST",
      headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
      body: JSON.stringify({
        message: {
          token: deviceToken,
          // data only, deliberately: see core/push.ts
          data: { kind: message.kind, sessionID: message.sessionID, ...(message.title ? { title: message.title } : {}) },
          android: { priority: "high" },
        },
      }),
      signal: AbortSignal.timeout(15_000),
    })
    if (res.ok) return true
    const body = (await res.text()).slice(0, 300)
    // 404, or the two codes FCM uses for a token that will never work again
    if (res.status === 404 || /UNREGISTERED|INVALID_ARGUMENT/.test(body)) throw new UnregisteredToken(body)
    throw new Error(`fcm send -> ${res.status}: ${body}`)
  }
}
