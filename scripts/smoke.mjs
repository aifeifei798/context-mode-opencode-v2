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

// Isolate the MCP readiness sentinel. The wrapper writes
// `<dir>/context-mode-mcp-ready-<pid>` at setup so upstream's isMCPReady()
// gate opens; pointing it at a scratch dir keeps the test deterministic and
// leaves no markers in the host's /tmp.
const sentinelDir = join(PLUGIN_DIR, "node_modules", ".smoke-sentinel")
process.env.CONTEXT_MODE_MCP_SENTINEL_DIR = sentinelDir
rmSync(sentinelDir, { recursive: true, force: true })

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
      [Symbol.asyncIterator]: () => {
        // Finite: one foreign event, then done. The real loop runs until
        // cleanup aborts it; a never-ending stub would keep this test alive
        // after the assertions (cleanup now runs at the end, not right after
        // setup, so the readiness sentinel is still present for the
        // PreToolUse assertion).
        let emitted = false
        return {
          next: async () => {
            await new Promise((resolve) => setTimeout(resolve, 300))
            if (signal?.aborted) return { done: true, value: undefined }
            if (emitted) return { done: true, value: undefined }
            emitted = true
            return { done: false, value: { type: "other" } }
          },
        }
      },
    }),
  },
}

const cleanup = await mod.default.setup(ctx)

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
let statsVersionOk = false
if (stats) {
  const out = await stats.execute({}, { sessionID: "ses_smoke", directory: PLUGIN_DIR })
  const statsText = String(out.content)
  statsVersionOk = /wrapper v\d+\.\d+\.\d+/.test(statsText)
  console.log("ctx_stats output:", statsText.slice(0, 120).replace(/\n/g, " "))
  console.log("ctx_stats carries wrapper version:", statsVersionOk)
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
let sentinelOk = false
const beforeHook = handlers["tool.execute.before"]
if (beforeHook) {
  const event = { tool: "shell", sessionID: "ses_smoke_routing", input: { command: "curl -s https://example.com" } }
  await beforeHook(event)
  const rewritten = String(event.input.command ?? "")
  redirectOk = rewritten.includes("redirected") && rewritten.includes("ctx_execute") && !rewritten.includes("context-mode_ctx_")
  console.log("curl redirect rewritten:", redirectOk)
  sentinelOk = existsSync(join(sentinelDir, `context-mode-mcp-ready-${process.pid}`))
  console.log("readiness sentinel:", sentinelOk)
}

// ── stale tool registry detection ───────────────────────────────────────────
// A session created before the plugin registered its tools keeps the old
// registry; Code Mode surfaces that as a per-call error. The wrapper must warn
// and stop that session from retrying.
let staleOk = false
const afterHook = handlers["tool.execute.after"]
const staleSession = "ses_smoke_stale"
if (afterHook && contextHook) {
  await afterHook({
    tool: "execute",
    sessionID: staleSession,
    input: { code: "tools.ctx_execute({ code: 'console.log(1)' })" },
    status: "completed",
    result: {
      content: [
        {
          type: "text",
          text: 'No tool named "ctx_execute" is currently available. Please use a tool from the available tool list.',
        },
      ],
    },
  })
  const noteEvent = { sessionID: staleSession, system: [{ type: "text", text: "You are an assistant." }] }
  await contextHook(noteEvent)
  const noteJoined = noteEvent.system.map((p) => p.text).join("\n")
  staleOk = noteJoined.includes("<context_mode_stale_registry>")
  console.log("stale registry note injected for that session:", staleOk)

  // Proactive signal: the harness renders the Code Mode catalog from the
  // session's registry, so a stale registry lists built-ins only.
  let catalogStaleOk = false
  let healthyOk = false
  if (contextHook) {
    const staleCatalogEvent = {
      sessionID: "ses_smoke_stale_catalog",
      system: [
        { type: "text", text: "You are an assistant." },
        { type: "text", text: "## Available tools\n- read (1 tool)\n- shell (1 tool)\n- edit (1 tool)" },
      ],
    }
    await contextHook(staleCatalogEvent)
    catalogStaleOk = staleCatalogEvent.system.map((p) => p.text).join("\n").includes("<context_mode_stale_registry>")

    const healthyEvent = {
      sessionID: "ses_smoke_healthy",
      system: [
        { type: "text", text: "You are an assistant." },
        { type: "text", text: "## Available tools\n- read (1 tool)\n- shell (1 tool)\n- ctx_execute (1 tool)" },
      ],
    }
    await contextHook(healthyEvent)
    healthyOk = !healthyEvent.system.map((p) => p.text).join("\n").includes("<context_mode_stale_registry>")
  }
  staleOk = staleOk && catalogStaleOk && healthyOk
  console.log("stale registry detected from tool catalog:", catalogStaleOk, "| healthy session not flagged:", healthyOk)
}

// ── ctx_routing report ─────────────────────────────────────────────────────
let reportOk = false
let reportText = ""
const routing = tools.find((t) => t.name === "ctx_routing")
if (routing) {
  const out = await routing.execute({ verbose: true }, { sessionID: "ses_smoke_routing", directory: PLUGIN_DIR })
  reportText = String(out.content)
  reportOk = reportText.startsWith("Routing status") && reportText.includes("stale tool registry")
  console.log("ctx_routing output:\n" + reportText)
}

if (typeof cleanup === "function") cleanup()

if (createdStub) rmSync(stubDir, { recursive: true, force: true })
rmSync(sentinelDir, { recursive: true, force: true })

if (missing.length || badSchemas.length || !statsVersionOk || !injectionOk || !wrapperInjectionOk || !namingOk || !redirectOk || !reportOk || !staleOk) {
  console.error(
    "FAILED:",
    missing.length ? "missing tools " + missing.join(",") : "",
    badSchemas.length ? "invalid schemas " + badSchemas.map((t) => t.name).join(",") : "",
    !injectionOk ? "routing block not injected" : "",
    !wrapperInjectionOk ? "wrapper did not supply routing rules when adapter skipped" : "",
    !namingOk ? "routing guidance not normalized" : "",
    !statsVersionOk ? "ctx_stats does not report the wrapper version" : "",
    !sentinelOk ? "MCP readiness sentinel not written (PreToolUse redirects stay disabled)" : "",
    !redirectOk ? "PreToolUse redirect not normalized" : "",
    !reportOk ? "ctx_routing report malformed" : "",
    !staleOk ? "stale tool registry not detected" : "",
  )
  process.exit(1)
}
console.log("OK")
