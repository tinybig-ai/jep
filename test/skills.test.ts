// core/skills.ts — SKILL.md frontmatter parsing and the one-line toggle, as
// unit tests on real files. The folded description (>- with continuation
// lines) is the shape every real skill file here uses, so it gets a case.

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { listSkills, parseFrontmatter, writeSkillModelInvocation } from "../src/core/skills.ts"

test("frontmatter: plain values, folded description, and the disable flag", () => {
  const { name, description, disableModelInvocation } = parseFrontmatter(
    ["---", "name: review", "description: >-", "  Review code changes with", "  the Bugbot or Security Review subagent.", "disable-model-invocation: true", "---", "# Review", "", "body"].join("\n"),
  )
  assert.equal(name, "review")
  assert.equal(description, "Review code changes with the Bugbot or Security Review subagent.")
  assert.equal(disableModelInvocation, true)
})

test("frontmatter: no frontmatter, or no flags at all, degrade honestly", () => {
  assert.deepEqual(parseFrontmatter("just prose"), { name: "", description: "", disableModelInvocation: false })
  const bare = parseFrontmatter(["---", "name: x", "description: y", "---"].join("\n"))
  assert.equal(bare.disableModelInvocation, false)
})

test("list: user and project scopes, project shadows user, sorted by name", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jep-skl-"))
  const user = join(dir, "user")
  const project = join(dir, "project")
  const skill = (root: string, name: string, body: string) => {
    mkdirSync(join(root, name), { recursive: true })
    writeFileSync(join(root, name, "SKILL.md"), body)
  }
  skill(user, "loop", "---\nname: loop\ndescription: Run things on a loop.\n---\nbody")
  skill(user, "review", "---\nname: review\ndescription: User-level review.\n---\nbody")
  skill(project, "review", "---\nname: review\ndescription: Project override.\n---\nbody")
  mkdirSync(join(project, "not-a-skill")) // no SKILL.md — skipped
  try {
    const skills = await listSkills([user], project)
    assert.deepEqual(
      skills.map((s) => `${s.name}@${s.scope}`),
      ["loop@user", "review@project"],
      "project wins the name collision, sorted by name",
    )
    assert.equal(skills[1]!.description, "Project override.")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("toggle: flipping an existing flag rewrites one line", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jep-skl-"))
  const file = join(dir, "SKILL.md")
  const before = "---\nname: x\ndescription: y\ndisable-model-invocation: false\n---\n\n# X\n\nkeep\nthis\n"
  writeFileSync(file, before)
  await writeSkillModelInvocation(file, true)
  assert.equal(readFileSync(file, "utf8"), before.replace("disable-model-invocation: false", "disable-model-invocation: true"))
})

test("toggle: a file without the flag gains it as the first frontmatter line", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jep-skl-"))
  const file = join(dir, "SKILL.md")
  const before = "---\nname: x\ndescription: y\n---\n\n# X\n"
  writeFileSync(file, before)
  await writeSkillModelInvocation(file, true)
  const after = readFileSync(file, "utf8")
  assert.equal(after, "---\ndisable-model-invocation: true\nname: x\ndescription: y\n---\n\n# X\n")
})

test("toggle: a file with no frontmatter is an error, not a mangled file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jep-skl-"))
  const file = join(dir, "SKILL.md")
  writeFileSync(file, "no frontmatter here\n")
  await assert.rejects(() => writeSkillModelInvocation(file, true), /no frontmatter/)
})
