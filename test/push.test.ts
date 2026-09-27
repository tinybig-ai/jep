import { test } from "node:test"
import assert from "node:assert/strict"
import { createVerify, generateKeyPairSync } from "node:crypto"
import { UnregisteredToken, type PushMessage, type PushNotifier } from "../src/core/push.ts"
import { ApnsNotifier, apnsPayload, type ApnsPost } from "../src/push/apns.ts"
import { routedNotifier } from "../src/push/routed.ts"

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" })
const key = privateKey.export({ type: "pkcs8", format: "pem" }).toString()
const finished: PushMessage = { sessionID: "s1", kind: "turn.finished" }

const recorder = (status = 200, body = "") => {
  const sent: { url: string; headers: Record<string, string>; body: string }[] = []
  const post: ApnsPost = async (url, headers, b) => {
    sent.push({ url, headers, body: b })
    return { status, body }
  }
  return { sent, post }
}

test("an APNs push is a signed alert whose words the app supplies", async () => {
  const { sent, post } = recorder()
  const apns = new ApnsNotifier({ key, keyID: "KID", teamID: "TEAM", topic: "dev.jep.client", sandbox: true }, post)
  assert.equal(await apns.send("abc", { sessionID: "s1", kind: "ask.requested", title: "Allow?" }), true)
  const [req] = sent
  assert.equal(req!.url, "https://api.sandbox.push.apple.com/3/device/abc")
  assert.equal(req!.headers["apns-topic"], "dev.jep.client")
  assert.equal(req!.headers["apns-push-type"], "alert")
  const body = JSON.parse(req!.body)
  assert.deepEqual(body.aps.alert, { "loc-key": "JEP_ASK_REQUESTED", "loc-args": ["Allow?"] })
  assert.equal(body.aps["thread-id"], "s1")
  assert.equal(body.sessionID, "s1")
  assert.equal(body.kind, "ask.requested")

  const [header, claims, sig] = req!.headers.authorization!.replace("bearer ", "").split(".")
  assert.deepEqual(JSON.parse(Buffer.from(header!, "base64url").toString()), { alg: "ES256", kid: "KID" })
  assert.equal(JSON.parse(Buffer.from(claims!, "base64url").toString()).iss, "TEAM")
  const verify = createVerify("SHA256")
  verify.update(`${header}.${claims}`)
  assert.ok(verify.verify({ key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(sig!, "base64url")))
})

test("a finished turn names no conversation text", () => {
  assert.deepEqual(apnsPayload(finished).aps, { alert: { "loc-key": "JEP_TURN_FINISHED" }, sound: "default", "thread-id": "s1" })
})

test("a token Apple calls gone is reported so the gateway prunes it", async () => {
  const gone = new ApnsNotifier({ key, keyID: "K", teamID: "T", topic: "x" }, recorder(410, '{"reason":"Unregistered"}').post)
  await assert.rejects(gone.send("abc", finished), UnregisteredToken)
  const bad = new ApnsNotifier({ key, keyID: "K", teamID: "T", topic: "x" }, recorder(400, '{"reason":"BadDeviceToken"}').post)
  await assert.rejects(bad.send("abc", finished), UnregisteredToken)
  const busy = new ApnsNotifier({ key, keyID: "K", teamID: "T", topic: "x" }, recorder(503, "later").post)
  await assert.rejects(busy.send("abc", finished), (err) => !(err instanceof UnregisteredToken))
})

test("the production host is used unless sandbox is asked for", async () => {
  const { sent, post } = recorder()
  await new ApnsNotifier({ key, keyID: "K", teamID: "T", topic: "x" }, post).send("abc", finished)
  assert.equal(sent[0]!.url, "https://api.push.apple.com/3/device/abc")
})

test("each token goes to the service that issued it", async () => {
  const got: string[] = []
  const sender = (name: string): PushNotifier => ({
    send: async (token) => {
      got.push(`${name}:${token}`)
      return true
    },
  })
  const both = routedNotifier({ fcm: sender("fcm"), apns: sender("apns") })
  await both.send("apns:abc", finished)
  await both.send("fcm-token", finished)
  assert.deepEqual(got, ["apns:abc", "fcm:fcm-token"])
  const fcmOnly = routedNotifier({ fcm: sender("fcm") })
  assert.equal(await fcmOnly.send("apns:zzz", finished), false)
  assert.deepEqual(got, ["apns:abc", "fcm:fcm-token"])
})
