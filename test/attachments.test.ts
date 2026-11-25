// The "Attached files:" list is jep talking to a print-mode harness. It must never
// reach the reader, whether or not a message had words and whether or not the
// harness kept the blank line that precedes the list.
import test from "node:test"
import assert from "node:assert/strict"
import { attachedPaths, stripAttachments, transcriptText, withAttachments } from "../src/core/transcript.ts"

const paths = ["/a/one.png", "/a/two.png"]

test("a message with words loses only the list", () => {
  const sent = withAttachments("look at these", paths)
  assert.equal(stripAttachments(sent), "look at these")
  assert.deepEqual(attachedPaths(sent), paths)
})

test("a message of only pictures leaves nothing, even when the harness trimmed the blank lines", () => {
  for (const sent of [withAttachments("", paths), withAttachments("", paths).trimStart(), withAttachments("", paths).trim()]) {
    assert.equal(transcriptText(sent), "")
    assert.deepEqual(attachedPaths(sent), paths)
  }
})

test("words that merely mention the header are left alone", () => {
  const words = "he wrote Attached files: and then stopped"
  assert.equal(stripAttachments(words), words)
  assert.deepEqual(attachedPaths(words), [])
})

test("Codex image wrappers disappear while each attachment survives once", () => {
  const wrappers = paths.map((p, i) => `<image name=[Image #${i + 1}] path="${p}"></image>`).join("")
  const raw = withAttachments(`${wrappers}why this error?`, paths)
  assert.equal(transcriptText(raw), "why this error?")
  assert.deepEqual(attachedPaths(raw), paths)
  assert.equal(transcriptText(wrappers), "")
  assert.deepEqual(attachedPaths(wrappers), paths)
  for (const text of [
    'Show <image name=[Image #1] path="/a/one.png"></image> in the docs',
    '`<image name=[Image #1] path="/a/one.png"></image>`',
    '<image href="/a/one.png"></image>',
  ]) assert.equal(transcriptText(text), text)
})
