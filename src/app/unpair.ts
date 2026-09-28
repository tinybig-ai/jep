// Forgets every phone paired with the gateway: their tokens stop working on
// the next request, no restart needed, and each must pair again with a fresh
// code. Run it with the same JEP_DATA_HOME the daemon uses.
import { homedir } from "node:os"
import { join } from "node:path"
import { revokeGatewayTokens } from "../clients/gateway/index.ts"

const DATA_HOME = process.env.JEP_DATA_HOME ?? join(homedir(), ".local", "share", "jep-tg")
const n = await revokeGatewayTokens(DATA_HOME)
console.log(`unpaired ${n} device${n === 1 ? "" : "s"} (${DATA_HOME})`)
