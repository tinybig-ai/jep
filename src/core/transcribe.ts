// Speech → text, locally. Dictation is the natural way to talk to an agent
// from a phone, and a voice note is the one input Telegram makes easier than
// typing, so this is input plumbing rather than a feature the agent could do
// for itself.
//
// Two steps, because they fail for different reasons and the difference is
// what you need to be told:
//
//   1. decode — whatever Telegram sent becomes 16 kHz mono WAV. Voice notes
//      are Ogg/Opus, which ffmpeg handles and, when it isn't installed,
//      macOS's own afconvert does too (CoreAudio reads the Ogg container and
//      the Opus codec natively). Doing it here rather than letting whisper
//      shell out to ffmpeg itself is what makes the no-ffmpeg machine work.
//   2. transcribe — whisper, via the venv that already has the model cached.
//
// Nothing here knows about Telegram, and `JEP_TRANSCRIBE_CMD` replaces step 2
// wholesale, which is both the escape hatch for a different engine and the
// seam the tests use: the command is run with the path of the decoded 16 kHz
// mono WAV appended as one argument, and whatever it prints on stdout is the
// transcript.

import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { existsSync } from "node:fs"
import { mkdir, rm } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { basename, join } from "node:path"

const execFileAsync = promisify(execFile)

/** where whisper-local lives: its venv has whisper installed and the model cached */
const WHISPER_DIR = process.env.JEP_WHISPER_DIR ?? join(homedir(), "Documents", "code", "whisper-local")
/** "medium" is what whisper-local already downloaded; anything else re-downloads */
const WHISPER_MODEL = process.env.JEP_WHISPER_MODEL ?? "medium"
/** whisper on a CPU is slower than real time; a long note must not hang a turn forever */
const TIMEOUT_MS = (Number(process.env.JEP_TRANSCRIBE_TIMEOUT ?? "") || 300) * 1000
const MAX_BUFFER = 8 * 1024 * 1024

/** jep's own driver script — see the comment on `whisperScript` */
const SCRIPT = join(import.meta.dirname, "..", "..", "scripts", "transcribe.py")

export interface Transcription {
  text: string
  /** which engine produced it, for the log */
  via: string
}

/** why transcription is unavailable, phrased as the thing to go and do */
export type Unavailable = { ok: false; why: string }
export type Ready = { ok: true; engine: string; decoder: string }

// `command -v` in a shell is the portable "is this installed" test
async function onPath(bin: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("/bin/sh", ["-c", `command -v ${bin} 2>/dev/null`])
    return stdout.trim().length > 0
  } catch {
    return false
  }
}

/** the interpreter that has whisper importable, or null */
function whisperPython(): string | null {
  const venv = join(WHISPER_DIR, ".venv", "bin", "python")
  return existsSync(venv) ? venv : null
}

/** whether this machine can transcribe at all, and with what */
export async function transcriberStatus(): Promise<Ready | Unavailable> {
  const decoder = (await onPath("ffmpeg")) ? "ffmpeg" : (await onPath("afconvert")) ? "afconvert" : null
  if (!decoder) return { ok: false, why: "no audio decoder — install ffmpeg (`brew install ffmpeg`)" }
  if (process.env.JEP_TRANSCRIBE_CMD) return { ok: true, engine: "JEP_TRANSCRIBE_CMD", decoder }
  const py = whisperPython()
  if (!py) {
    return {
      ok: false,
      why: `no transcriber — expected a whisper venv at ${join(WHISPER_DIR, ".venv")}. Set JEP_WHISPER_DIR, or JEP_TRANSCRIBE_CMD to any command that prints a transcript.`,
    }
  }
  return { ok: true, engine: `whisper ${WHISPER_MODEL}`, decoder }
}

/** whatever came in → 16 kHz mono WAV, the one shape whisper wants */
async function decodeToWav(src: string, dst: string): Promise<string> {
  if (await onPath("ffmpeg")) {
    await execFileAsync("ffmpeg", ["-nostdin", "-loglevel", "error", "-y", "-i", src, "-ac", "1", "-ar", "16000", dst], {
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    })
    return "ffmpeg"
  }
  // macOS ships this, and CoreAudio reads Ogg/Opus — which is what a Telegram
  // voice note is, and the reason this path exists at all
  await execFileAsync("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", src, dst], {
    timeout: TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
  })
  return "afconvert"
}

/**
 * whisper-local's own transcribe.py hands the file path to whisper, and
 * whisper decodes it by shelling out to ffmpeg — so on a machine without
 * ffmpeg it cannot read anything at all. jep's script takes the already
 * decoded WAV and passes samples straight in, which is why the decode step
 * above is separate.
 */
async function runWhisper(py: string, wav: string): Promise<string> {
  const { stdout } = await execFileAsync(py, [SCRIPT, wav], {
    timeout: TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
    env: { ...process.env, JEP_WHISPER_MODEL: WHISPER_MODEL },
  })
  return stdout
}

/**
 * Transcribe an audio file. Throws with a sentence worth showing a person:
 * every failure here ends up in a chat message, and "spawn ENOENT" is not an
 * answer to "why did my voice note do nothing".
 */
async function runTranscribe(file: string): Promise<Transcription> {
  const status = await transcriberStatus()
  if (!status.ok) throw new Error(status.why)

  const work = join(tmpdir(), `jep-stt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  await mkdir(work, { recursive: true })
  const wav = join(work, `${basename(file).replace(/\.[^.]*$/, "")}.wav`)
  try {
    let decoder: string
    try {
      decoder = await decodeToWav(file, wav)
    } catch (err) {
      const detail = ((err as { stderr?: string })?.stderr || (err as Error)?.message || "").trim().split("\n")[0]
      throw new Error(`couldn't decode the audio${detail ? `: ${detail.slice(0, 200)}` : ""}`)
    }

    const override = process.env.JEP_TRANSCRIBE_CMD
    let out: string
    try {
      out = override
        ? (await execFileAsync("/bin/sh", ["-c", `${override} "$1"`, "sh", wav], { timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER })).stdout
        : await runWhisper(whisperPython()!, wav)
    } catch (err) {
      const e = err as { killed?: boolean; signal?: string; stderr?: string; message?: string }
      if (e.killed || e.signal === "SIGTERM") throw new Error(`transcribing took longer than ${Math.round(TIMEOUT_MS / 1000)}s and was given up on`)
      const detail = (e.stderr || e.message || "").trim().split("\n").filter(Boolean).pop() ?? ""
      throw new Error(`the transcriber failed${detail ? `: ${detail.slice(0, 200)}` : ""}`)
    }

    const text = out.trim()
    if (!text) throw new Error("the audio came back empty — no speech in it?")
    return { text, via: `${status.ok ? status.engine : "?"} via ${decoder}` }
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {})
  }
}

// One at a time. The model is 1.5 GB in memory, so two notes arriving together
// must not load it twice — and they do arrive together, because the natural way
// to correct a voice note is to send another one straight after it.
let queue: Promise<unknown> = Promise.resolve()

export function transcribe(file: string): Promise<Transcription> {
  const next = queue.then(
    () => runTranscribe(file),
    () => runTranscribe(file),
  )
  queue = next.catch(() => {})
  return next
}
