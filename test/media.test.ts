// telegram/media.ts — what is in a message, and what to call the file it
// carries. The sniffers matter more than they look: the extension decides
// which parser the decoder picks, and a wrong one is refused outright.

import { test } from "node:test"
import assert from "node:assert/strict"
import { audioOf, imageExt, sniffAudioExt, sniffImageExt, stickerPrompt } from "../src/telegram/media.ts"
import type { TgMessage } from "../src/telegram/api.ts"

const msg = (over: Partial<TgMessage>): TgMessage => ({ message_id: 1, chat: { id: 1, type: "private" }, ...over })

test("a voice note is Ogg and carries its duration", () => {
  const a = audioOf(msg({ voice: { file_id: "f1", duration: 12 } }))
  assert.deepEqual(a, { fileID: "f1", ext: ".oga", seconds: 12, kind: "voice note" })
})

test("an attached audio file keeps its own extension", () => {
  assert.equal(audioOf(msg({ audio: { file_id: "f", file_name: "Memo.MP3", duration: 3 } }))!.ext, ".mp3")
  assert.equal(audioOf(msg({ audio: { file_id: "f", duration: 3 } }))!.ext, ".m4a", "no name, assume what Telegram usually sends")
})

test("a video note is someone talking too", () => {
  const a = audioOf(msg({ video_note: { file_id: "f", duration: 5 } }))
  assert.equal(a!.kind, "video note")
  assert.equal(a!.ext, ".mp4")
})

test("a recording forwarded as a document counts as audio", () => {
  const a = audioOf(msg({ document: { file_id: "f", file_name: "call.ogg", mime_type: "audio/ogg" } }))
  assert.equal(a!.kind, "recording")
  assert.equal(a!.ext, ".ogg")
})

test("a document that is not audio is not audio", () => {
  assert.equal(audioOf(msg({ document: { file_id: "f", file_name: "a.pdf", mime_type: "application/pdf" } })), null)
  assert.equal(audioOf(msg({ text: "hello" })), null)
  assert.equal(audioOf(msg({ photo: [{ file_id: "p" }] })), null)
})

test("a missing duration is zero, not undefined — the cap compares numbers", () => {
  assert.equal(audioOf(msg({ voice: { file_id: "f" } }))!.seconds, 0)
})

// ─── container sniffing ───

const head = (...parts: Array<string | number[]>): Buffer =>
  Buffer.concat(parts.map((p) => (typeof p === "string" ? Buffer.from(p, "ascii") : Buffer.from(p))))

test("audio containers are recognised by signature", () => {
  assert.equal(sniffAudioExt(head("OggS", [0, 2, 0, 0])), ".oga", "a Telegram voice note")
  assert.equal(sniffAudioExt(head("caff", [0, 1, 0, 0])), ".caf")
  assert.equal(sniffAudioExt(head("RIFF", [0, 0, 0, 0], "WAVE")), ".wav")
  assert.equal(sniffAudioExt(head([0, 0, 0, 24], "ftypM4A ")), ".m4a")
  assert.equal(sniffAudioExt(head("ID3", [3, 0, 0])), ".mp3")
  assert.equal(sniffAudioExt(head([0xff, 0xfb, 0x90, 0x00])), ".mp3", "a bare frame sync")
  assert.equal(sniffAudioExt(head("fLaC", [0, 0, 0, 34])), ".flac")
})

test("anything else is not claimed as audio", () => {
  assert.equal(sniffAudioExt(head("%PDF-1.7")), null)
  assert.equal(sniffAudioExt(Buffer.alloc(0)), null, "an empty buffer must not index past the end")
  assert.equal(sniffAudioExt(head([0x89], "PNG")), null)
})

test("image sniffing still knows its four", () => {
  assert.equal(sniffImageExt(head([0xff, 0xd8, 0xff, 0xe0])), ".jpg")
  assert.equal(sniffImageExt(head([0x89], "PNG")), ".png")
  assert.equal(sniffImageExt(head("RIFF", [0, 0, 0, 0], "WEBP")), ".webp")
  assert.equal(sniffImageExt(head("GIF89a")), ".gif")
  assert.equal(sniffImageExt(head("nope")), null)
})

test("an image extension comes from the mime type, parameters and all", () => {
  assert.equal(imageExt("image/png"), ".png")
  assert.equal(imageExt("image/jpeg; charset=binary"), ".jpg")
  assert.equal(imageExt("application/pdf"), null)
  assert.equal(imageExt(undefined), null)
})

test("a sticker says what it meant, since the image may be unreadable", () => {
  assert.equal(stickerPrompt({ file_id: "s", emoji: "🔥", set_name: "Fire" }), '[sticker: 🔥 from the "Fire" sticker set]')
  assert.equal(stickerPrompt({ file_id: "s" }), "[sticker]")
})
