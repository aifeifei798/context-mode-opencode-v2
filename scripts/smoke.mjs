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
const handlers = {}

const ctx = {
  location: { directory: PLUGIN_DIR },
  options: {},
  storage: { get: async () => null, set: async () => {} },
  tool: {
    transform: async (callback) => {
      const editor = { add: (t) => tools.push(t) }
      await callback(editor)
    },
    hook: (name, handler) => {
      hooks.push("tool." + name)
      handlers["tool." + name] = handler
    },
  },
  session: {
    hook: (name, handler) => {
      hooks.push("session." + name)
      handlers["session." + name] = handler
    },
  },
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
  "ctx_routing",
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

// ── routing block injection + tool-name normalization ────────────────────
const contextHook = handlers["session.context"]
let injectionOk = false
let wrapperInjectionOk = false
let namingOk = false
if (contextHook) {
  const event = { sessionID: "ses_smoke_routing", system: [{ type: "text", text: "You are an assistant." }] }
  await contextHook(event)
  const joined = event.system.map((p) => p.text).join("\n")
  injectionOk = joined.includes("<context_window_protection>")
  const offending = [...new Set(joined.match(/context-mode_[a-z_]+/g) ?? [])]
  namingOk = offending.length === 0
  if (!namingOk) console.log("unnormalized names in prompt:", offending.join(", "))
  console.log("routing block injected by adapter:", injectionOk)
  console.log("guidance names normalized:", namingOk)

  // Harnesses that only *list* ctx tool names (tool catalogs) trip the adapter's
  // marker quorum; the wrapper must still supply the rules.
  const catalogEvent = {
    sessionID: "ses_smoke_catalog",
    system: [
      { type: "text", text: "You are an assistant." },
      { type: "text", text: "Available tools: ctx_search, ctx_index, ctx_execute." },
    ],
  }
  await contextHook(catalogEvent)
  const catalogJoined = catalogEvent.system.map((p) => p.text).join("\n")
  wrapperInjectionOk = catalogJoined.includes("<context_window_protection>") && !catalogJoined.includes("context-mode_ctx_")
  console.log("routing block supplied by wrapper when adapter skips:", wrapperInjectionOk)
}

// ── PreToolUse enforcement + normalization ────────────────────────────────
let redirectOk = false
const beforeHook = handlers["tool.execute.before"]
if (beforeHook) {
  const event = { tool: "shell", sessionID: "ses_smoke_routing", input: { command: "curl -s https://example.com" } }
  await beforeHook(event)
  const rewritten = String(event.input.command ?? "")
  redirectOk = rewritten.includes("redirected") && rewritten.includes("ctx_execute") && !rewritten.includes("context-mode_ctx_")
  console.log("curl redirect rewritten:", redirectOk)
}

// ── ctx_routing report ─────────────────────────────────────────────────────
let reportOk = false
const routing = tools.find((t) => t.name === "ctx_routing")
if (routing) {
  const out = await routing.execute({ verbose: true }, { sessionID: "ses_smoke_routing", directory: PLUGIN_DIR })
  reportOk = String(out.content).startsWith("Routing status")
  console.log("ctx_routing output:\n" + String(out.content))
}

if (createdStub) rmSync(stubDir, { recursive: true, force: true })

if (missing.length || badSchemas.length || !injectionOk || !wrapperInjectionOk || !namingOk || !redirectOk || !reportOk) {
  console.error(
    "FAILED:",
    missing.length ? "missing tools " + missing.join(",") : "",
    badSchemas.length ? "invalid schemas " + badSchemas.map((t) => t.name).join(",") : "",
    !injectionOk ? "routing block not injected" : "",
    !wrapperInjectionOk ? "wrapper did not supply routing rules when adapter skipped" : "",
    !namingOk ? "routing guidance not normalized" : "",
    !redirectOk ? "PreToolUse redirect not normalized" : "",
    !reportOk ? "ctx_routing report malformed" : "",
  )
  process.exit(1)
}
console.log("OK")
