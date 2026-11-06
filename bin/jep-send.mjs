#!/usr/bin/env node
// `jep-send FILE...`: hand a file to the person in this Telegram chat.
//
// The command only checks the files and says what it did. jep reads the paths
// back out of the recorded call and uploads them. Telegram's bot limit is 50 MB.
import { statSync } from "node:fs"
import { resolve } from "node:path"

const MAX = 50 * 1024 * 1024
const paths = process.argv.slice(2).filter((a) => !a.startsWith("-"))
if (!paths.length) {
  console.error("usage: jep-send FILE...")
  process.exit(2)
}
let bad = 0
for (const p of paths) {
  const abs = resolve(p)
  let size = -1
  try {
    const info = statSync(abs)
    if (info.isFile()) size = info.size
  } catch {}
  if (size < 0) console.error(`not a file: ${abs}`), bad++
  else if (size > MAX) console.error(`too big for Telegram (50 MB): ${abs}`), bad++
  else console.log(`sending ${abs} (${size} bytes)`)
}
process.exit(bad ? 1 : 0)
