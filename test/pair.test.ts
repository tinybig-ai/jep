import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Pairing, newPairCode } from "../src/clients/telegram/pair.ts"

function home(): string {
  return mkdtempSync(join(tmpdir(), "jep-pair-"))
}

test("the boot code is persisted so it can be read back out of band", () => {
  const dir = home()
  try {
    const file = join(dir, "pairing.json")
    const p = Pairing.load("BOOT1234", file)
    const saved = JSON.parse(readFileSync(file, "utf8"))
    assert.equal(p.code, "BOOT1234")
    assert.equal(saved.code, "BOOT1234", "npm run pair reads this back")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a successful pairing spends the code and persists the fresh one", () => {
  const dir = home()
  try {
    const file = join(dir, "pairing.json")
    const p = Pairing.load("CODEAAA1", file)
    assert.equal(p.authorize(42, "CODEAAA1"), "owner")
    const saved = JSON.parse(readFileSync(file, "utf8"))
    assert.equal(saved.owner, 42)
    assert.equal(saved.code, p.code)
    assert.notEqual(saved.code, "CODEAAA1", "a spent code is never valid again")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("rotation after repeated failures rewrites the persisted code", () => {
  const dir = home()
  try {
    const file = join(dir, "pairing.json")
    const p = Pairing.load("STARTED1", file, { max: 100, rotateAt: 2 })
    assert.deepEqual(p.attempt(1, "nope"), { status: "bad" })
    assert.deepEqual(p.attempt(1, "nope"), { status: "bad", rotated: true })
    const saved = JSON.parse(readFileSync(file, "utf8"))
    assert.equal(saved.code, p.code)
    assert.notEqual(saved.code, "STARTED1")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("no file means no persistence, and nothing throws", () => {
  const p = Pairing.load("NONE1234", null)
  assert.equal(p.code, "NONE1234")
  assert.equal(p.authorize(1, "NONE1234"), "owner")
})

test("newPairCode is 9 chars of the unambiguous alphabet", () => {
  for (let i = 0; i < 50; i++) {
    assert.match(newPairCode(), /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{9}$/)
  }
})

test("status() reports owner, devices and code through the admin port", () => {
  const dir = home()
  try {
    const p = Pairing.load("PORTCODE1", join(dir, "pairing.json"))
    assert.deepEqual(p.status(), {
      client: "telegram",
      label: "Telegram bot",
      code: "PORTCODE1",
      owner: null,
      devices: 0,
      hint: "send /pair <code>",
    })
    p.authorize(7, "PORTCODE1")
    const s = p.status()
    assert.equal(s.owner, "7")
    assert.equal(s.devices, 1)
    assert.notEqual(s.code, "PORTCODE1")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("onChange fires when the persisted state changes", () => {
  const dir = home()
  try {
    const p = Pairing.load("ONCHANGE1", join(dir, "pairing.json"))
    let n = 0
    p.onChange = () => {
      n++
    }
    p.authorize(1, "ONCHANGE1")
    assert.ok(n >= 1, "pairing a chat notifies the aggregate writer")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
