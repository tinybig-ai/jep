import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"

const source = readFileSync(new URL("../web/themes.js", import.meta.url), "utf8")
function browser(saved: Record<string, string> = {}, dark = false, blocked = false) {
  const store = new Map(Object.entries(saved))
  const vars = new Map<string, string>()
  const root = { dataset: {} as Record<string, string>, style: { colorScheme: "", setProperty: (key: string, value: string) => vars.set(key, value) } }
  let chrome = ""
  const themes = runInNewContext(source + "; JepThemes", {
    localStorage: {
      getItem: (key: string) => { if (blocked) throw new Error("Storage unavailable"); return store.get(key) ?? null },
      setItem: (key: string, value: string) => { if (blocked) throw new Error("Storage unavailable"); store.set(key, value) },
    },
    matchMedia: () => ({ matches: dark }),
    document: { documentElement: root, querySelector: () => ({ setAttribute: (_key: string, value: string) => { chrome = value } }) },
  })
  return { themes, root, vars, store, chrome: () => chrome, system: (value: boolean) => { dark = value; themes.apply() } }
}

test("existing light/dark choices retain Jep Classic and override the device", () => {
  const b = browser({ "jep.theme": "light" }, true)
  b.themes.apply()
  assert.equal(b.root.dataset.palette, "classic")
  assert.equal(b.root.dataset.appearance, "light")
  assert.equal(b.vars.get("--bg"), "#fcfbfa")
  assert.equal(b.vars.get("--shadow"), "0 1px 2px #0000000a, 0 6px 24px #00000010")
  b.themes.setMode("dark")
  b.system(false)
  assert.equal(b.root.dataset.appearance, "dark")
  assert.equal(b.vars.get("--bg"), "#111113")
})

test("themes and Auto/Light/Dark are independent durable choices", () => {
  const b = browser()
  b.themes.apply()
  for (const theme of b.themes.themes) {
    b.themes.setPalette(theme.id)
    for (const mode of ["system", "light", "dark"]) {
      b.themes.setMode(mode)
      assert.equal(b.store.get("jep.palette"), theme.id)
      for (const dark of [true, false]) {
        b.system(dark)
        const expected = mode === "system" ? dark ? "dark" : "light" : mode
        assert.equal(b.root.dataset.appearance, expected)
        assert.equal(b.root.dataset.palette, theme.id)
        assert.equal(b.root.style.colorScheme, expected)
        assert.equal(b.vars.get("--bg"), theme[expected].bg)
        assert.equal(b.chrome(), theme[expected].bg)
      }
      const reloaded = browser(Object.fromEntries(b.store), true)
      reloaded.themes.apply()
      assert.equal(reloaded.root.dataset.palette, theme.id)
      assert.equal(reloaded.root.dataset.appearance, mode === "system" ? "dark" : mode)
    }
  }
})

test("invalid or unavailable storage falls back safely and permits changes in this tab", () => {
  const invalid = browser({ "jep.theme": "broken", "jep.palette": "removed-theme" })
  invalid.themes.apply()
  assert.equal(invalid.root.dataset.palette, "classic")
  assert.equal(invalid.root.dataset.appearance, "light")
  const blocked = browser({}, true, true)
  blocked.themes.setPalette("forest")
  blocked.themes.setMode("light")
  assert.equal(blocked.root.dataset.palette, "forest")
  assert.equal(blocked.root.dataset.appearance, "light")
})

test("a preference changed in another tab updates palette and appearance together", () => {
  const b = browser()
  b.themes.apply()
  b.store.set("jep.palette", "sandstone")
  b.store.set("jep.theme", "dark")
  b.themes.refresh()
  assert.equal(b.root.dataset.palette, "sandstone")
  assert.equal(b.root.dataset.appearance, "dark")
})
