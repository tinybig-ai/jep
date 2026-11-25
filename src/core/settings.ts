// A conversation's own settings, declared once and served to every client as
// data: `GET`-style options in, `{values}` out. A client that draws its form
// from this list needs no change when a setting is added — which is the whole
// reason keeping going is not four hardcoded toggles in four codebases.
//
import { DRIVE_MODES, type DriveMode } from "./keepgoing.ts"

export type ConversationSettings = Record<string, boolean | string>
export const KEEP_UNTIL_MAX = 1000
export const keepUntilOf = (stored: ConversationSettings | undefined): string =>
  typeof stored?.keep_until === "string" ? stored.keep_until.trim().slice(0, KEEP_UNTIL_MAX) : ""

// It borrows the shape the harness settings already use (`{id,label,description,
// default}`) so one client code path covers both.

export interface SettingSpec {
  id: string
  label: string
  /** one line, in the person's words, for under the switch */
  description: string
  default: boolean
}

/** what the daemon offers per conversation today */
export const CONVERSATION_SETTINGS: SettingSpec[] = [
  {
    id: "keep_going",
    label: "Keep going",
    description: "Requests in this conversation carry on past one turn until the agent says it is done (jep-end-turn).",
    default: false,
  },
]

/** The mode a conversation is in is stored as two flags so older records keep
 *  meaning what they meant: `keep_going` alone is keep, with `relentless` it is
 *  relentless. Clients see one value and cycle it. */
export const driveOf = (stored: ConversationSettings | undefined): DriveMode =>
  stored?.relentless === true ? "relentless" : keepsGoing(stored) ? "keep" : "normal"

export const withDrive = (stored: ConversationSettings | undefined, mode: DriveMode): ConversationSettings => ({
  ...(stored ?? {}),
  keep_going: mode !== "normal",
  relentless: mode === "relentless",
})

/** the next mode when the person taps the button */
export const nextDrive = (mode: DriveMode): DriveMode => DRIVE_MODES[(DRIVE_MODES.indexOf(mode) + 1) % DRIVE_MODES.length]!

/** settings clients draw as switches: the mode has its own control */
export const switchSettings = (): SettingSpec[] => CONVERSATION_SETTINGS.filter((s) => s.id !== "keep_going")

export const knownSetting = (id: string): SettingSpec | undefined => CONVERSATION_SETTINGS.find((s) => s.id === id)

/** declared options with this conversation's values filled in, defaults where unset */
export const settingValues = (stored: ConversationSettings | undefined): Record<string, boolean> =>
  Object.fromEntries(CONVERSATION_SETTINGS.map((s) => {
    const value = stored?.[s.id]
    return [s.id, typeof value === "boolean" ? value : s.default]
  }))

/** whether a conversation keeps going: its setting, else the declared default */
export const keepsGoing = (stored: ConversationSettings | undefined): boolean =>
  settingValues(stored).keep_going === true
