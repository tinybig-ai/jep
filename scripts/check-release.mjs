import { readFileSync } from "node:fs"

const [tag, owner] = process.argv.slice(2)
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)))
const app = JSON.parse(readFileSync(new URL("../homeassistant/config.json", import.meta.url)))
const repository = JSON.parse(readFileSync(new URL("../repository.json", import.meta.url)))
if (!/^v\d+\.\d+\.\d+$/.test(tag ?? "") || tag !== `v${pkg.version}` || app.version !== pkg.version) {
  throw new Error("The release tag, package.json version and Home Assistant app version must match")
}
if (app.image !== `ghcr.io/${owner?.toLowerCase()}/{arch}-jep`) throw new Error("The Home Assistant image must belong to the release repository owner")
if (new URL(repository.url).pathname.split("/")[1]?.toLowerCase() !== owner?.toLowerCase()) throw new Error("repository.json must identify the publishing repository owner")
console.log(`Validated ${tag}: daemon, Home Assistant version and image registry agree`)
