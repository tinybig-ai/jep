// PURE — minimal-layout segmentation. The minimal style shows thinking and
// tool calls as one flat icon line, and until now the whole turn collapsed
// into [all icons][all text] — destroying the chronology of "I checked this,
// here's what I found, now I'm running that".
//
// The fix is multiple messages: a segment is the verbosity accumulated since
// the last piece of user-visible text, plus that text. When a text part is
// finalized the segment ships as its own message, and the next verbosity
// accumulate into a fresh one.

import type { Part, ReasoningPart, TextPart, ToolCallPart } from "../../core/types.ts"
import type { RichBlock } from "./rich.ts"
import { mdToRich, closeStreamingTable } from "./rich.ts"
import { fmtDuration } from "./fmt.ts"

export interface MinimalSegment {
  /** reasoning / tool / marker parts that happened before the segment's text */
  icons: Part[]
  /** the user-visible text of the segment, in order */
  text: TextPart[]
}

// Walk parts in order; non-text parts join the current segment's icons, and
// the first non-text part after text opens the next segment. Markers
// (step-start/step-finish, snapshots) ride in the icons bucket — they render
// as nothing, but they must not leak into a later segment's text.
export function splitMinimalSegments(parts: Part[]): MinimalSegment[] {
  const segments: MinimalSegment[] = [{ icons: [], text: [] }]
  let current = segments[segments.length - 1]!
  for (const p of parts) {
    if (p.kind === "text") {
      current.text.push(p)
      continue
    }
    if (current.text.length > 0) {
      segments.push({ icons: [], text: [] })
      current = segments[segments.length - 1]!
    }
    current.icons.push(p)
  }
  return segments
}

export interface MinimalRenderers {
  /** whether thinking shows at all (the chat's Verbosity setting) */
  thinking: boolean
  tools: boolean
  /** duration for a reasoning part — frozen when known, live estimate otherwise */
  ms: (p: ReasoningPart) => number | undefined
  icon: (t: ToolCallPart) => string
}

// One segment as rich blocks: the icon line (only when there is anything on
// it), then the segment's text. The same shape the live draft shows, so a
// segment's permanent message looks exactly like what was on screen.
export function minimalSegmentBlocks(seg: MinimalSegment, r: MinimalRenderers): RichBlock[] {
  const bits: string[] = []
  for (const p of seg.icons) {
    if (p.kind === "reasoning" && r.thinking && p.text.trim()) bits.push(`💭 ${thinkingPhrase(r.ms(p)).toLowerCase()}`)
    else if (p.kind === "tool" && r.tools) bits.push(r.icon(p))
  }
  const out: RichBlock[] = []
  if (bits.length) out.push({ type: "paragraph", text: bits.join("  ") })
  for (const p of seg.text) {
    if (p.text.trim()) out.push(...mdToRich(closeStreamingTable(p.text)))
  }
  return out
}

// "Thought for Ns" once we know how long it actually took (sub-second rounds
// up to 1s rather than printing "0s"); "Thinking" while that's still unknown
export const thinkingPhrase = (ms?: number): string => (ms != null ? `Thought for ${fmtDuration(Math.max(ms, 1000))}` : "Thinking")
