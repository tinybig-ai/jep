#!/usr/bin/env node
// `jep-show IMAGE...`: show an image to the person reading this conversation in jep.
//
// The command only checks the files and says what it did. The call itself is
// the message: jep reads the paths back out of the recorded command and draws
// the images in the chat. Plain node, no imports from the tree.
import { statSync } from "node:fs"
import { resolve } from "node:path"

const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp|svg|heic|heif)$/i
const paths = process.argv.slice(2).filter((a) => !a.startsWith("-"))
if (!paths.length) {
  console.error("usage: jep-show IMAGE...")
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
  else if (!IMAGE.test(abs)) console.error(`not an image type jep can draw: ${abs}`), bad++
  else console.log(`showing ${abs} (${size} bytes)`)
}
process.exit(bad ? 1 : 0)
