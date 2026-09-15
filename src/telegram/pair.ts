import { randomBytes } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"

export interface PairState {
  owner: number | null
  paired: number[]
}

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

export function newPairCode(): string {
  const b = randomBytes(9)
  let out = ""
  for (let i = 0; i < 9; i++) out += ALPHABET[b[i]! % ALPHABET.length]!
  return out
}

export interface PairOptions {
  // sliding window: at most `max` code attempts per `windowMs`
  max?: number
  windowMs?: number
  // rotate the code after this many total wrong attempts (0 = never)
  rotateAt?: number
}

export type PairAttempt =
  | { status: "ok"; pairing: "owner" | "paired" }
  | { status: "bad"; rotated?: boolean }
  | { status: "blocked"; retryIn: number }

export class Pairing {
  #code: string
  #owner: number | null
  #file: string | null
  #paired: Set<number>
  #max: number
  #windowMs: number
  #rotateAt: number
  #failures = 0
  #hits = new Map<number, number[]>()

  constructor(code: string, owner: number | null, file: string | null, paired: number[], opts: PairOptions = {}) {
    this.#code = code
    this.#owner = owner
    this.#file = file
    this.#paired = new Set(paired)
    this.#max = opts.max ?? 5
    this.#windowMs = opts.windowMs ?? 60_000
    this.#rotateAt = opts.rotateAt ?? 10
  }

  static load(code: string, file: string | null, opts: PairOptions = {}): Pairing {
    if (!file) return new Pairing(code, null, null, [], opts)
    try {
      const s = JSON.parse(readFileSync(file, "utf8")) as PairState
      return new Pairing(code, s.owner ?? null, file, s.paired ?? [], opts)
    } catch {
      return new Pairing(code, null, file, [], opts)
    }
  }

  get code(): string {
    return this.#code
  }

  get owner(): number | null {
    return this.#owner
  }

  isPaired(id: number): boolean {
    return this.#owner === id || this.#paired.has(id)
  }

  isOwner(id: number): boolean {
    return this.#owner === id
  }

  adoptOwner(id: number): void {
    if (this.#owner !== null) return
    this.#owner = id
    this.#paired.delete(id)
    this.#save()
  }

  authorize(id: number, code: string): "bad" | "paired" | "owner" {
    if (code.trim() !== this.#code) return "bad"
    if (this.#owner === null) {
      this.#owner = id
      this.#paired.delete(id)
      this.#save()
      return "owner"
    }
    this.#paired.add(id)
    this.#save()
    return "paired"
  }

  // rate-limited authorize: caller must go through this for user-entered codes.
  attempt(id: number, code: string): PairAttempt {
    const now = Date.now()
    const cut = now - this.#windowMs
    const hits = (this.#hits.get(id) ?? []).filter((h) => h > cut)
    hits.push(now)
    this.#hits.set(id, hits)

    if (hits.length > this.#max) {
      hits.shift()
      const retryIn = Math.max(1, Math.ceil((this.#windowMs - (now - hits[0]!)) / 1000))
      return { status: "blocked", retryIn }
    }

    const res = this.authorize(id, code)
    if (res === "bad") {
      this.#failures++
      if (this.#rotateAt > 0 && this.#failures >= this.#rotateAt) {
        this.#code = newPairCode()
        this.#failures = 0
        this.#hits.clear()
        return { status: "bad", rotated: true }
      }
      return { status: "bad" }
    }

    this.#hits.delete(id)
    this.#failures = 0
    return { status: "ok", pairing: res }
  }

  count(): number {
    return this.#paired.size + (this.#owner !== null ? 1 : 0)
  }

  #save(): void {
    if (!this.#file) return
    const data: PairState = { owner: this.#owner, paired: [...this.#paired] }
    writeFileSync(this.#file, JSON.stringify(data, null, 2))
  }
}