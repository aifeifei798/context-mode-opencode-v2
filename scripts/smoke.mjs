/**
 * Offline smoke test — no OpenCode process required.
 *
 * OpenCode injects `@opencode/plugin` into the plugin runtime, so it is not a
 * dependency of this package. To exercise index.js outside OpenCode we drop a
 * minimal stub into node_modules, call setup() with a fake ctx, and assert that
 * the upstream adapter's ctx tools and hooks are registered.
 *
 *   npm run smoke
 */
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const stubDir = join(PLUGIN_DIR, "node_modules", "@opencode", "plugin")
const createdStub = !existsSync(join(stubDir, "index.js"))

if (createdStub) {
  mkdirSync(stubDir, { recursive: true })
  writeFileSync(join(stubDir, "package.json"), JSON.stringify({ name: "@opencode/plugin", version: "0.0.0-stub", type: "module", main: "index.js", exports: "./index.js" }) + "\n")
  writeFileSync(join(stubDir, "index.js"), "export const Plugin = { define: (obj) => obj }\n")
}

const mod = await import(join(PLUGIN_DIR, "index.js"))

const tools = []
const hooks = []

const ctx = {
  location: { directory: PLUGIN_DIR },
  options: {},
  storage: { get: async () => null, set: async () => {} },
  tool: {
    transform: async (callback) => {
      const editor = { add: (t) => tools.push(t) }
      await callback(editor)
    },
    hook: (name) => hooks.push("tool." + name),
  },
  session: { hook: (name) => hooks.push("session." + name) },
  event: {
    subscribe: ({ signal }) => ({
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          await new Promise((resolve) => setTimeout(resolve, 300))
          return signal?.aborted ? { done: true, value: undefined } : { done: false, value: { type: "other" } }
        },
      }),
    }),
  },
}

const cleanup = await mod.default.setup(ctx)
if (typeof cleanup === "function") cleanup()

const expectedTools = [
  "ctx_execute",
  "ctx_execute_file",
  "ctx_index",
  "ctx_search",
  "ctx_fetch_and_index",
  "ctx_batch_execute",
  "ctx_stats",
  "ctx_doctor",
  "ctx_upgrade",
  "ctx_purge",
  "ctx_insight",
]

const missing = expectedTools.filter((name) => !tools.some((t) => t.name === name))
const badSchemas = tools.filter((t) => !t.input || t.input.type !== "object")

console.log("plugin id:", mod.default.id)
console.log("tools registered:", tools.length, "->", tools.map((t) => t.name).join(", "))
console.log("hooks registered:", hooks.join(", "))
console.log("schema objects:", tools.length - badSchemas.length, "/", tools.length)

const stats = tools.find((t) => t.name === "ctx_stats")
if (stats) {
  const out = await stats.execute({}, { sessionID: "ses_smoke", directory: PLUGIN_DIR })
  console.log("ctx_stats output:", String(out.content).slice(0, 120).replace(/\n/g, " "))
  console.log("ctx_stats metadata:", JSON.stringify(out.metadata))
}

if (createdStub) rmSync(stubDir, { recursive: true, force: true })

if (missing.length || badSchemas.length) {
  console.error("FAILED: missing tools", missing, "invalid schemas", badSchemas.map((t) => t.name))
  process.exit(1)
}
console.log("OK")
