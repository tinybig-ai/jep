// PURE — what is in a Telegram message, and what to call the file it carries.
// No I/O, no state, no API calls: a message in, a fact about it out. bot.ts
// decides what to *do* with the answer.

import type { TgMessage } from "./api.ts"

// Long enough for a rambling thought, short enough that a misdirected podcast
// doesn't tie up the transcriber for an hour.
export const VOICE_MAX_SEC = Number(process.env.JEP_VOICE_MAX_SEC ?? "") || 600

// Telegram's shapes for "someone talking": the press-and-hold mic, an attached
// audio file, the round video note, and an audio file sent as a document. All
// four are a spoken prompt, and all four decode the same way.
export interface AudioIn {
  fileID: string
  /** what to save it as — the decoder sniffs content, but a sane name helps */
  ext: string
  seconds: number
  /** how to name it back to the user ("that voice note") */
  kind: string
}

export const audioOf = (m: TgMessage): AudioIn | null => {
  if (m.voice) return { fileID: m.voice.file_id, ext: ".oga", seconds: m.voice.duration ?? 0, kind: "voice note" }
  if (m.audio) {
    const name = m.audio.file_name ?? ""
    const dot = name.lastIndexOf(".")
    return { fileID: m.audio.file_id, ext: dot > 0 ? name.slice(dot).toLowerCase() : ".m4a", seconds: m.audio.duration ?? 0, kind: "audio" }
  }
  if (m.video_note) return { fileID: m.video_note.file_id, ext: ".mp4", seconds: m.video_note.duration ?? 0, kind: "video note" }
  // someone forwarding a recording usually sends it as a file
  if (m.document?.mime_type?.startsWith("audio/")) {
    const name = m.document.file_name ?? ""
    const dot = name.lastIndexOf(".")
    return { fileID: m.document.file_id, ext: dot > 0 ? name.slice(dot).toLowerCase() : ".ogg", seconds: 0, kind: "recording" }
  }
  return null
}


export const IMAGE_RE = /\.(png|jpe?g|webp|gif|svg)$/i
export const imageExt = (mime?: string): string | null => {
  const m = (mime ?? "").split(";")[0]?.trim()
  const byMime: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/svg+xml": ".svg",
  }
  return byMime[m ?? ""] ?? null
}

// Stickers and photo thumbnails arrive with no file name and no mime type, so
// the extension has to come from the bytes. Getting it wrong matters: the
// harness derives the mime it sends the model from the extension alone, so a
// WEBP called .jpg is rejected as corrupt rather than read.
// The decoder picks its parser from the file *name*, so an extension that
// disagrees with the bytes makes it refuse a file it can read perfectly well.
// Telegram's declared type is usually right, but it is hearsay; the container
// signature is not.
export const sniffAudioExt = (b: Buffer): string | null => {
  const ascii = (from: number, to: number) => b.toString("ascii", from, to)
  if (b.length >= 4 && ascii(0, 4) === "OggS") return ".oga" // Ogg — Opus or Vorbis
  if (b.length >= 4 && ascii(0, 4) === "caff") return ".caf" // CoreAudio
  if (b.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") return ".wav"
  if (b.length >= 12 && ascii(4, 8) === "ftyp") return ".m4a" // ISO-BMFF: m4a, mp4, video notes
  if (b.length >= 3 && ascii(0, 3) === "ID3") return ".mp3"
  if (b.length >= 2 && b[0] === 0xff && (b[1]! & 0xe0) === 0xe0) return ".mp3" // bare frame sync
  if (b.length >= 4 && ascii(0, 4) === "fLaC") return ".flac"
  return null
}

export const sniffImageExt = (b: Buffer): string | null => {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return ".jpg"
  if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return ".png"
  if (b.length >= 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return ".webp"
  if (b.length >= 4 && b.toString("ascii", 0, 4) === "GIF8") return ".gif"
  return null
}

// what a sticker actually means, for the harness: the emoji is the content,
// the set name is context. Sent as text so an animated sticker we can't
// render still says something instead of arriving as an empty message.
export const stickerPrompt = (s: NonNullable<TgMessage["sticker"]>): string => {
  const parts = [s.emoji, s.set_name ? `from the "${s.set_name}" sticker set` : ""].filter(Boolean)
  return `[sticker${parts.length ? `: ${parts.join(" ")}` : ""}]`
}
