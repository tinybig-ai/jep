// PURE — agent skills on disk: a directory of subdirectories, each with a
// SKILL.md whose YAML-ish frontmatter carries the name, a description, and an
// optional `disable-model-invocation` flag. The same file format runs under
// every harness; what differs is where each one looks and whether it honors
// the flag — codex reads $CODEX_HOME/skills and has no toggle.
//
// Reads take directories; the one write changes one frontmatter line and
// leaves the rest of the file byte-for-byte alone — a skill is prose with a
// header, not a data format.

import { readFile, readdir, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

export interface Skill {
  name: string
  description: string
  /** user-level (~/.claude/skills) or project-level (<workspace>/.claude/skills) */
  scope: "user" | "project"
  path: string
  disableModelInvocation: boolean
}

export async function listSkills(userDirs: string[], projectDirs: string[]): Promise<Skill[]> {
  const scans = [...userDirs.map((d) => readSkillDir(d, "user" as const)), ...projectDirs.map((d) => readSkillDir(d, "project" as const))]
  const found = (await Promise.all(scans)).flat()
  // project skills shadow user skills of the same name — that's how the
  // harnesses resolve them, and the list should say what will actually run
  const byName = new Map<string, Skill>()
  for (const s of found) byName.set(s.name, s)
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

// Where each harness looks, and whether flipping `disable-model-invocation`
// means anything to it. Verified against the harnesses' own loaders:
// claude scans ~/.claude/skills and ~/.agents/skills plus <ws>/.claude/skills;
// opencode auto-loads those same user dirs plus <ws>/.opencode/skill(s);
// codex reads $CODEX_HOME/skills (default ~/.codex/skills) and its SKILL.md
// has no disable flag — show, don't toggle.
export interface SkillDirs {
  userDirs: string[]
  projectDirs: string[]
  toggleable: boolean
}

export function skillDirsFor(harness: string, workspaceDir: string): SkillDirs {
  const home = homedir()
  if (harness === "codex") {
    return {
      userDirs: [join(process.env.CODEX_HOME ?? join(home, ".codex"), "skills")],
      projectDirs: [],
      toggleable: false,
    }
  }
  if (harness === "opencode") {
    return {
      userDirs: [join(home, ".claude", "skills"), join(home, ".agents", "skills")],
      projectDirs: [join(workspaceDir, ".opencode", "skills"), join(workspaceDir, ".opencode", "skill")],
      toggleable: true,
    }
  }
  // claude, and any harness we don't know yet gets the widest net: the
  // cross-agent ~/.agents/skills convention plus the Claude originals
  return {
    userDirs: [join(home, ".claude", "skills"), join(home, ".agents", "skills")],
    projectDirs: [join(workspaceDir, ".claude", "skills")],
    toggleable: true,
  }
}

// SKILL.md files sit at uneven depths: a plain skill dir has them at depth 2,
// but synced trees (claude mirrors ~/.agents/skills under a UUID bucket) bury
// them deeper. A bounded walk from each top-level entry finds them all.
const SKILL_WALK_DEPTH = 4

async function readSkillDir(dir: string, scope: Skill["scope"]): Promise<Skill[]> {
  let entries: string[]
  try {
    entries = (await readdir(dir, { withFileTypes: true })).filter((e) => !e.name.startsWith(".")).map((e) => e.name)
  } catch {
    return []
  }
  const out: Skill[] = []
  for (const entry of entries) {
    const root = `${dir}/${entry}`
    const found = await walkForSkill(root, scope, 1)
    if (found) out.push(found)
  }
  return out
}

async function walkForSkill(dir: string, scope: Skill["scope"], depth: number): Promise<Skill | null> {
  const path = `${dir}/SKILL.md`
  try {
    const text = await readFile(path, "utf8")
    return { ...parseFrontmatter(text), scope, path }
  } catch {
    /* no SKILL.md here — descend if there's room left */
  }
  if (depth >= SKILL_WALK_DEPTH) return null
  let children: string[]
  try {
    children = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name)
  } catch {
    return null
  }
  for (const child of children) {
    const found = await walkForSkill(`${dir}/${child}`, scope, depth + 1)
    if (found) return found
  }
  return null
}

// frontmatter is the `---` … `---` block of `key: value` lines at the top.
// Values may be folded (`description: >-` with indented continuation lines).
export function parseFrontmatter(text: string): { name: string; description: string; disableModelInvocation: boolean } {
  const lines = text.split("\n")
  if (lines[0]?.trim() !== "---") return { name: "", description: "", disableModelInvocation: false }
  let name = ""
  let description = ""
  let disableModelInvocation = false
  let folding: "description" | null = null
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim() === "---" || line.trim() === "...") break
    const fold = /^(\s+)(.*)$/.exec(line)
    if (fold && folding && fold[2]!.trim()) {
      description = `${description} ${fold[2]!.trim()}`.trim()
      continue
    }
    const kv = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line)
    if (!kv) continue
    const [, key, raw] = kv
    const value = raw!.trim()
    folding = null
    if (key === "name") name = value
    else if (key === "description") {
      if (value === ">-" || value === ">" || value === "|") folding = "description"
      else description = value
    } else if (key === "disable-model-invocation") disableModelInvocation = value === "true"
  }
  return { name, description, disableModelInvocation }
}

// Flip `disable-model-invocation` in the frontmatter — adding the line right
// after `---` if it isn't there. Everything outside the replaced line is
// untouched, so descriptions, prose and formatting survive.
export async function writeSkillModelInvocation(path: string, disabled: boolean): Promise<void> {
  const text = await readFile(path, "utf8")
  const lines = text.split("\n")
  if (lines[0]?.trim() !== "---") throw new Error(`${path} has no frontmatter`)
  const flag = `disable-model-invocation: ${disabled}`
  const end = lines.findIndex((l, i) => i > 0 && (l.trim() === "---" || l.trim() === "..."))
  if (end === -1) throw new Error(`${path} has no closing frontmatter marker`)
  for (let i = 1; i < end; i++) {
    const replaced = lines[i]!.replace(/^disable-model-invocation\s*:\s*(true|false)\s*$/, flag)
    if (replaced !== lines[i]) {
      lines[i] = replaced
      await writeFile(path, lines.join("\n"))
      return
    }
  }
  lines.splice(1, 0, flag)
  await writeFile(path, lines.join("\n"))
}
