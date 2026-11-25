// A color theme and its light/dark appearance are independent preferences.
// Loaded before first paint so a saved palette never flashes Jep Classic.
const JepThemes = (() => {
  const themes = [
    { id: "classic", name: "Jep Classic", description: "Warm neutrals · Jep red",
      light: { bg: "#fcfbfa", side: "#f5f3f0", line: "#e8e5e0", text: "#1c1b19", dim: "#8b877f", bubble: "#efece7", accent: "#d93445", code: "#f3f1ed", user: "#c8283c", "user-top": "#e5495c", card: "#ffffff", hover: "#ebe8e3" },
      dark: { bg: "#111113", side: "#161619", line: "#26262b", text: "#ececee", dim: "#8e8e96", bubble: "#202024", accent: "#ef5363", code: "#1a1a1e", user: "#a81c31", "user-top": "#d23a4e", card: "#1b1b1f", hover: "#222227" } },
    { id: "ocean", name: "Ocean", description: "Cool slate · Clear blue",
      light: { bg: "#f7fafc", side: "#edf3f8", line: "#d9e3ec", text: "#172b3a", dim: "#596d7d", bubble: "#e5edf4", accent: "#1767a5", code: "#edf2f7", user: "#15568a", "user-top": "#1b6da7", card: "#ffffff", hover: "#dce7f0" },
      dark: { bg: "#0e1722", side: "#131f2c", line: "#27384a", text: "#e3edf6", dim: "#9aafc2", bubble: "#1c2d3f", accent: "#79baf3", code: "#142231", user: "#164c76", "user-top": "#1d5f90", card: "#172534", hover: "#23374b" } },
    { id: "forest", name: "Forest", description: "Soft sage · Deep green",
      light: { bg: "#f8faf7", side: "#eff4ed", line: "#dce5d7", text: "#203126", dim: "#60745f", bubble: "#e7eee1", accent: "#2c6a42", code: "#edf2e8", user: "#2d6342", "user-top": "#36734c", card: "#ffffff", hover: "#dfe8d7" },
      dark: { bg: "#111a15", side: "#17221b", line: "#2b3b30", text: "#e6efe5", dim: "#a3b9a4", bubble: "#203127", accent: "#86c89b", code: "#19271f", user: "#285a3d", "user-top": "#316e4b", card: "#1c2b22", hover: "#2a3d2f" } },
    { id: "sandstone", name: "Sandstone", description: "Warm paper · Earth tones",
      light: { bg: "#fcf8f1", side: "#f4eddf", line: "#e6dbca", text: "#35291f", dim: "#786653", bubble: "#f0e6d6", accent: "#8b522c", code: "#f5ecde", user: "#805031", "user-top": "#965d35", card: "#fffdf8", hover: "#eaddc8" },
      dark: { bg: "#1d1713", side: "#251e18", line: "#43352a", text: "#f1e6d8", dim: "#c1aa91", bubble: "#35291f", accent: "#dfac7b", code: "#2b211a", user: "#71492d", "user-top": "#8b5835", card: "#2b231c", hover: "#443427" } },
    { id: "mono", name: "Mono", description: "Pure black · Clean white", flat: true, monochrome: true,
      light: { bg: "#ffffff", side: "#fafafa", line: "#e4e4e4", text: "#111111", dim: "#626262", bubble: "#f0f0f0", accent: "#111111", code: "#f6f6f6", user: "#191919", "user-top": "#191919", card: "#ffffff", hover: "#eaeaea" },
      dark: { bg: "#000000", side: "#080808", line: "#262626", text: "#f5f5f5", dim: "#9e9e9e", bubble: "#171717", accent: "#eeeeee", code: "#0c0c0c", user: "#303030", "user-top": "#303030", card: "#0c0c0c", hover: "#1c1c1c" } },
    { id: "graphite", name: "Graphite", description: "Soft charcoal · Neutral gray", flat: true, monochrome: true,
      light: { bg: "#f8f8f8", side: "#f0f0f0", line: "#dedede", text: "#252525", dim: "#6c6c6c", bubble: "#e9e9e9", accent: "#454545", code: "#f0f0f0", user: "#3b3b3b", "user-top": "#3b3b3b", card: "#fdfdfd", hover: "#e1e1e1" },
      dark: { bg: "#1c1c1c", side: "#202020", line: "#353535", text: "#ededed", dim: "#ababab", bubble: "#2a2a2a", accent: "#cacaca", code: "#242424", user: "#454545", "user-top": "#454545", card: "#242424", hover: "#333333" } },
    { id: "pearl", name: "Pearl", description: "Cool whites · Brushed silver", flat: true,
      light: { bg: "#fafbfc", side: "#f2f4f6", line: "#dfe3e8", text: "#272c32", dim: "#656e78", bubble: "#ebeff3", accent: "#4e5d6c", code: "#f1f4f6", user: "#465463", "user-top": "#465463", card: "#ffffff", hover: "#e3e8ed" },
      dark: { bg: "#101317", side: "#171b20", line: "#2e353e", text: "#e8ecf0", dim: "#a1abb7", bubble: "#222830", accent: "#c4ced8", code: "#1a1f25", user: "#394652", "user-top": "#394652", card: "#1b2026", hover: "#2a323c" } },
    { id: "dusk", name: "Dusk", description: "Muted violet · Smoky neutrals", flat: true,
      light: { bg: "#fbf9fc", side: "#f1edf5", line: "#e2dce8", text: "#332b3b", dim: "#74647f", bubble: "#ece6f1", accent: "#6d577e", code: "#f3eef7", user: "#604d70", "user-top": "#604d70", card: "#ffffff", hover: "#e5ddec" },
      dark: { bg: "#19151e", side: "#201b26", line: "#38303f", text: "#ede7f2", dim: "#b4a5c2", bubble: "#2b2433", accent: "#c4afd6", code: "#221c29", user: "#51425f", "user-top": "#51425f", card: "#251f2d", hover: "#342b3d" } },
  ]
  const read = (key) => { try { return localStorage.getItem(key) } catch { return null } }
  const write = (key, value) => { try { localStorage.setItem(key, value) } catch {} }
  const validMode = (mode) => ["light", "dark"].includes(mode) ? mode : "system"
  const validPalette = (id) => themes.some((theme) => theme.id === id) ? id : "classic"
  let mode = validMode(read("jep.theme"))
  let palette = validPalette(read("jep.palette"))
  const resolve = (choice, dark) => validMode(choice) === "system" ? (dark ? "dark" : "light") : validMode(choice)
  const colors = (id, appearance) => {
    const theme = themes.find((t) => t.id === validPalette(id))
    const value = theme[appearance === "dark" ? "dark" : "light"]
    return { ...value, ring: value.accent + (appearance === "dark" ? "38" : "2e"),
      shadow: theme.flat ? "none" : appearance === "dark" ? "0 1px 2px #0006, 0 8px 28px #0005" : "0 1px 2px #0000000a, 0 6px 24px #00000010",
      "shadow-lg": appearance === "dark" ? "0 2px 8px #0008, 0 24px 60px #000a" : "0 2px 6px #0000000f, 0 20px 50px #00000024",
      "brand-top": theme.id === "classic" ? "#f66676" : value["user-top"],
      "brand-bottom": theme.id === "classic" ? "#c42438" : value.user,
      "brand-shadow": theme.id === "classic" ? "#c42438" : value.user,
    }
  }
  const state = () => ({ mode, palette, appearance: resolve(mode, matchMedia("(prefers-color-scheme: dark)").matches) })
  const apply = () => {
    const current = state()
    const root = document.documentElement
    if (mode === "system") delete root.dataset.theme
    else root.dataset.theme = mode
    root.dataset.palette = palette
    root.dataset.monochrome = String(themes.find((theme) => theme.id === palette).monochrome === true)
    root.dataset.appearance = current.appearance
    root.style.colorScheme = current.appearance
    for (const [key, value] of Object.entries(colors(palette, current.appearance))) root.style.setProperty("--" + key, value)
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", colors(palette, current.appearance).bg)
    return current
  }
  const setMode = (value) => { mode = validMode(value); write("jep.theme", mode); return apply() }
  const setPalette = (value) => { palette = validPalette(value); write("jep.palette", palette); return apply() }
  const refresh = () => { mode = validMode(read("jep.theme")); palette = validPalette(read("jep.palette")); return apply() }
  return { themes, colors, resolve, state, apply, setMode, setPalette, refresh }
})()
