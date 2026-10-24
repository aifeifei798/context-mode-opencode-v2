/**
 * OpenCode v2 wrapper for context-mode (mksglu/context-mode).
 *
 * context-mode ships an OpenCode v1-style plugin adapter
 * (`context-mode/build/adapters/opencode/plugin.js`). OpenCode v2 requires
 * plugins that export `Plugin.define({ id, setup })`, so this wrapper calls
 * the upstream v1 factory and re-registers its tools and hooks on the v2 API.
 *
 * Self-installing: OpenCode does not install npm dependencies for local
 * plugin directories, so this wrapper installs `context-mode` into its own
 * directory at module load time (before anything is imported) when it is
 * missing. Dropping `index.js` into `~/.config/opencode/plugins/` is enough.
 * Set `CONTEXT_MODE_AUTO_UPDATE=0` (or the `autoUpdate: false` plugin option)
 * to disable the background upgrade check.
 */
import { Plugin } from "@opencode/plugin"
import { spawn, spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
const CONTEXT_MODE_DIR = join(PLUGIN_DIR, "node_modules", "context-mode")
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

/** Minimal package.json so a bare `index.js` drop-in still installs deps. */
const FALLBACK_PACKAGE_JSON = {
  name: "context-mode-opencode-v2",
  version: "1.0.0",
  type: "module",
  dependencies: { "context-mode": "^1.0.169", zod: "^3.25.0" },
  allowScripts: {
    "better-sqlite3": true,
    "context-mode": true,
  },
}

/**
 * Non-blocking npm run, used for the background upgrade check so plugin
 * startup never waits on the network.
 */
function runNpm(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn("npm", args, { cwd: PLUGIN_DIR })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => { stdout += chunk.toString() })
    child.stderr.on("data", (chunk) => { stderr += chunk.toString() })
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`npm ${args.join(" ")} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    child.on("error", (error) => { clearTimeout(timer); reject(error) })
    child.on("close", (status) => {
      clearTimeout(timer)
      resolve({ status, stdout, stderr })
    })
  })
}

function npmInstall(args, timeoutMs) {
  return spawnSync("npm", ["install", "--no-audit", "--no-fund", ...args], {
    cwd: PLUGIN_DIR,
    encoding: "utf8",
    timeout: timeoutMs,
  })
}

function betterSqlite3Root() {
  const roots = [
    join(PLUGIN_DIR, "node_modules", "better-sqlite3"),
    join(CONTEXT_MODE_DIR, "node_modules", "better-sqlite3"),
  ]
  return roots.find((root) => existsSync(root)) ?? null
}

/**
 * better-sqlite3 is a transitive dep of context-mode (hoisted to the plugin's
 * own node_modules, or nested under context-mode if not hoisted). When
 * OpenCode installs a package plugin with Bun, install scripts may not run,
 * so the native binding can be missing even though the package is present.
 */
function nativeBindingPresent() {
  const root = betterSqlite3Root()
  if (!root) return false
  return (
    existsSync(join(root, "build", "Release", "better_sqlite3.node")) ||
    existsSync(join(root, "build", "Debug", "better_sqlite3.node"))
  )
}

/**
 * npm install does not re-run install scripts for packages that are already
 * in node_modules, so a missing binding is healed with `npm rebuild` and then
 * the package's own `install` script (prebuild-install || node-gyp rebuild).
 */
function healNativeBinding() {
  const root = betterSqlite3Root()
  if (!root) return false

  spawnSync("npm", ["rebuild", "better-sqlite3"], {
    cwd: PLUGIN_DIR,
    encoding: "utf8",
    timeout: 180_000,
  })
  if (nativeBindingPresent()) return true

  spawnSync("npm", ["run", "install"], {
    cwd: root,
    encoding: "utf8",
    timeout: 180_000,
  })
  return nativeBindingPresent()
}

function nativeBindingError() {
  return {
    ok: false,
    action: "native-binding-missing",
    error:
      "better-sqlite3's native binding was not built (install scripts were blocked). " +
      "Run `npm rebuild better-sqlite3` or `cd node_modules/better-sqlite3 && npm run install` in " + PLUGIN_DIR,
  }
}

/**
 * Ensure context-mode is available. Blocking, only when missing.
 * npm 12+ blocks install scripts unless `allowScripts` is declared in
 * package.json, which is why better-sqlite3's prebuilt binary needs it.
 */
function ensureContextMode() {
  if (existsSync(CONTEXT_MODE_DIR)) {
    if (nativeBindingPresent()) return { ok: true, action: "present" }
    if (healNativeBinding()) return { ok: true, action: "healed-native-binding" }
    return nativeBindingError()
  }

  if (!existsSync(join(PLUGIN_DIR, "package.json"))) {
    try {
      writeFileSync(join(PLUGIN_DIR, "package.json"), JSON.stringify(FALLBACK_PACKAGE_JSON, null, 2) + "\n")
    } catch (error) {
      return { ok: false, action: "no-package-json", error: error.message }
    }
  }

  const result = npmInstall([], 180_000)
  if (result.status === 0 && existsSync(CONTEXT_MODE_DIR)) {
    if (nativeBindingPresent() || healNativeBinding()) return { ok: true, action: "installed" }
    return nativeBindingError()
  }
  return {
    ok: false,
    action: "install-failed",
    error: result.error?.message || result.stderr?.trim() || `npm exited with ${result.status}`,
  }
}

function installedContextModeVersion() {
  try {
    return JSON.parse(readFileSync(join(CONTEXT_MODE_DIR, "package.json"), "utf8")).version
  } catch {
    return null
  }
}

/**
 * Background upgrade check: pull the latest context-mode once a day.
 * Never blocks plugin setup; the new version is picked up on the next load.
 */
function scheduleContextModeUpdate(ctx, enabled) {
  if (!enabled) return
  void (async () => {
    try {
      const lastCheck = await ctx.storage.get("contextModeUpdateCheck")
      if (lastCheck && Date.now() - Number(lastCheck) < UPDATE_CHECK_INTERVAL_MS) return
      await ctx.storage.set("contextModeUpdateCheck", Date.now())

      const view = await runNpm(["view", "context-mode", "version"], 30_000)
      if (view.status !== 0) return
      const latest = view.stdout?.trim()
      const current = installedContextModeVersion()
      if (!latest || latest === current) return

      const result = await runNpm(["install", "--no-audit", "--no-fund", "context-mode@" + latest], 180_000)
      await ctx.storage.set("contextModeUpdate", {
        from: current,
        to: latest,
        ok: result.status === 0,
        at: Date.now(),
      })
    } catch {
      // Update checks are best-effort; never break the session.
    }
  })()
}

// Run at module load, before any context-mode import is resolved by the
// plugin loader. Cheap no-op once node_modules/context-mode exists.
const dependency = ensureContextMode()

function wrapperVersion() {
  try {
    return JSON.parse(readFileSync(join(PLUGIN_DIR, "package.json"), "utf8")).version
  } catch {
    return null
  }
}

/**
 * Routing observability. The wrapper cannot see the adapter's internal
 * decisions, so it infers them from what the adapter mutates: a rewritten
 * `command` is a modify, an added `additionalContext` is a context nudge, and
 * a thrown error is a deny.
 */
const routingState = {
  injected: false,
  wrapperInjected: false,
  skipped: false,
  modify: 0,
  context: 0,
  deny: 0,
  sessions: new Set(),
  lastRewrite: null,
  // Sessions whose tool registry predates this plugin: Code Mode reports
  // `No tool named "ctx_*" is currently available` for every ctx call.
  staleSessions: new Set(),
  missingToolCalls: 0,
  lastMissingTool: null,
  lastCatalog: null,
}

// OpenCode does not hot-reload a session's tool registry, so a session created
// before this plugin registered its tools keeps the old one until it is
// reloaded. Code Mode surfaces that as a per-call error; we detect it and warn
// once per session.
const STALE_REGISTRY_ERROR = /No tool named "(ctx_[a-z_]+)" is currently available/i

const STALE_REGISTRY_NOTE =
  "<context_mode_stale_registry>\n" +
  "ctx_* tools are not in this session's tool registry. Run \"opencode service restart\" " +
  "or start a new session; until then do not call ctx_* tools.\n" +
  "</context_mode_stale_registry>"

// OpenCode's compaction reducer only trims messages — the system parts of the
// compaction request (base prompt, tool catalog, routing block, and the resume
// snapshot injected by the compaction hook) are never reduced. When the
// injected snapshot is larger than the compaction budget (model context limit
// minus the compaction buffer), the reducer cannot fit even one exchange and
// the step fails with "The compaction request cannot be reduced further without
// losing the latest exchange or checkpoint". The snapshot is a table of
// contents — full detail lives in the context-mode DB and is reachable via
// ctx_search — so it is safe to shrink it here.
const DEFAULT_SNAPSHOT_CHAR_CAP = 12000

function capCompactionContext(text, cap) {
  if (cap <= 0 || text.length <= cap) return text
  // The <errors> section is the usual bloat: every stored traceback is inlined
  // verbatim. Replace it with a deduplicated digest of the exception lines
  // (e.g. "ModuleNotFoundError: No module named 'sqlalchemy'"); ctx_search
  // retrieves the full tracebacks from the session DB.
  const shrunk = text.replace(
    /<errors count="(\d+)">([\s\S]*?)<\/errors>/,
    (_match, count, body) => {
      const [entries, toolCall = ""] = body.split("    For full details:")
      const seen = new Set()
      const lines = []
      for (const line of entries.split("\n")) {
        const trimmed = line.trim()
        if (!trimmed) continue
        if (
          /^[A-Za-z_][A-Za-z_.]*(?:Error|Exception|Warning):/.test(trimmed) ||
          /^Exited with code \d+$/.test(trimmed)
        ) {
          if (!seen.has(trimmed)) {
            seen.add(trimmed)
            lines.push(`    ${trimmed}`)
          }
        }
      }
      return (
        `<errors count="${count}">\n${lines.join("\n")}\n` +
        (toolCall ? `    For full details:${toolCall}\n` : "") +
        "  </errors>"
      )
    },
  )
  if (shrunk.length <= cap) return shrunk
  return (
    shrunk.slice(0, cap) +
    "\n[resume snapshot truncated — full session history is indexed; use ctx_search(queries: [...], source: \"session-events\") for details]"
  )
}

function warn(message) {
  process.stderr.write(`\x1b[33m[context-mode-v2] ${message}\x1b[0m\n`)
}

// ── MCP readiness sentinel ──────────────────────────────────────────────
// Upstream gates every PreToolUse rewrite (curl/wget, inline HTTP, webfetch,
// read, build) behind `isMCPReady()` in `hooks/core/mcp-ready.mjs`: it scans
// `<tmp>/context-mode-mcp-ready-*` for a live PID, or a sentinel whose mtime is
// younger than 90s, and `mcpRedirect()` returns null when the check fails.
// Only the MCP server process ever wrote that sentinel. On OpenCode v2 the ctx
// tools are registered natively in this process and no MCP server runs, so the
// check was always false and routing enforcement silently no-op'd (the symptom
// is `curl redirect rewritten: false` in the smoke test plus
// `PreToolUse enforcement: 0 decision(s)`). Write the sentinel for our own PID
// and refresh it on upstream's 30s cadence.
const SENTINEL_PREFIX = "context-mode-mcp-ready-"
const SENTINEL_REFRESH_MS = 30_000

function sentinelDirectory() {
  const override = process.env.CONTEXT_MODE_MCP_SENTINEL_DIR
  if (override && override.length > 0) return override
  return process.platform === "win32" ? tmpdir() : "/tmp"
}

// One sentinel per process, shared by every setup() call: OpenCode can load the
// plugin more than once (reload, several sessions), and the PID is the same.
// Refcounted so the first cleanup does not delete a marker a sibling setup
// still relies on.
let sentinelState = null

/**
 * Never throws: a read-only /tmp must degrade to "redirects disabled" rather
 * than block plugin setup.
 */
function startMcpReadySentinel() {
  if (!sentinelState) {
    const directory = sentinelDirectory()
    const path = join(directory, `${SENTINEL_PREFIX}${process.pid}`)
    const touch = () => {
      try {
        mkdirSync(directory, { recursive: true })
        writeFileSync(path, String(process.pid))
        return true
      } catch {
        return false
      }
    }
    const ready = touch()
    const timer = ready ? setInterval(touch, SENTINEL_REFRESH_MS) : null
    // The sentinel must not keep the host process alive.
    if (timer && typeof timer.unref === "function") timer.unref()
    sentinelState = { ready, path, timer, refs: 0 }
  }

  const state = sentinelState
  state.refs += 1
  let released = false
  return {
    ready: state.ready,
    path: state.path,
    stop: () => {
      if (released) return
      released = true
      state.refs -= 1
      if (state.refs > 0) return
      if (state.timer) clearInterval(state.timer)
      try {
        unlinkSync(state.path)
      } catch {
        // Best effort: a stale sentinel is reclaimed by upstream's PID probe.
      }
      if (sentinelState === state) sentinelState = null
    },
  }
}

export default Plugin.define({
  id: "context-mode.v2",
  async setup(ctx) {
    if (!dependency.ok) {
      throw new Error(
        `context-mode-opencode-v2 could not install context-mode (${dependency.error}). ` +
          `Run "npm install" in ${PLUGIN_DIR}, or install the plugin as a package: ` +
          `opencode plugin add github:aifeifei798/context-mode-opencode-v2`
      )
    }

    scheduleContextModeUpdate(ctx, ctx.options?.autoUpdate !== false && process.env.CONTEXT_MODE_AUTO_UPDATE !== "0")

    // Started before the adapter is asked for hooks, so the very first tool call
    // can already be routed. No MCP server runs under OpenCode v2, so nothing
    // else writes this sentinel.
    const sentinel = startMcpReadySentinel()
    if (!sentinel.ready) {
      warn(
        `could not write the context-mode readiness sentinel (${sentinel.path}); ` +
          "PreToolUse redirects stay disabled — set CONTEXT_MODE_MCP_SENTINEL_DIR to a writable directory",
      )
    }
    const cleanups = [() => sentinel.stop()]

    const adapterMod = await import("context-mode/plugin")
    const createContextModePlugin = adapterMod.server ?? adapterMod.ContextModePlugin
    if (typeof createContextModePlugin !== "function") {
      throw new Error(
        `context-mode ${installedContextModeVersion()} does not export a plugin factory ` +
          "(expected `server` or `ContextModePlugin`). Pin context-mode to 1.0.169 or update the wrapper."
      )
    }

    const { z } = await import("zod/v4")

    const directory = ctx.location?.directory ?? process.cwd()

    // The v1 factory expects { directory, client: { app: { log } } }.
    const snapshotCap = Number(
      ctx.options?.compactionSnapshotChars ??
        process.env.CONTEXT_MODE_COMPACTION_SNAPSHOT_CHARS ??
        DEFAULT_SNAPSHOT_CHAR_CAP,
    )
    const hooks = await createContextModePlugin({
      directory,
      client: {
        app: {
          log: async () => {},
        },
      },
    })

    if (!hooks.tool || Object.keys(hooks.tool).length === 0) {
      throw new Error(
        `context-mode ${installedContextModeVersion()} returned no ctx tools. ` +
          "The upstream adapter shape changed; update the wrapper or pin context-mode to 1.0.169."
      )
    }

    // ── routing block ────────────────────────────────────────────────────
    // The adapter only injects its routing block when the system prompt does not
    // already contain a quorum of ROUTING_MARKERS (`<context_window_protection>`,
    // `ctx_search`, `ctx_index`). Harnesses that merely *list* ctx tool names in
    // the tool catalog (Code Mode, MCP tool listings) trip that check, so the
    // rules never reach the prompt even though no rules are actually present.
    // Build the same block from upstream with the names registered here and
    // inject it when the real rules are missing.
    let wrapperRoutingBlock = null
    if (ctx.options?.routingBlock !== false && process.env.CONTEXT_MODE_ROUTING_BLOCK !== "0") {
      try {
        const routingBlockPath = join(
          PLUGIN_DIR,
          "node_modules",
          "context-mode",
          "hooks",
          "routing-block.mjs",
        )
        if (existsSync(routingBlockPath)) {
          const { createRoutingBlock } = await import(pathToFileURL(routingBlockPath).href)
          // Code Mode resolves ctx_* only through the execute tool's catalog
          // (`tools.ctx_*`). A direct native ctx_* call is not parsed by the
          // harness and stalls the turn, so guidance must name the catalog path.
          wrapperRoutingBlock =
            createRoutingBlock((bare) => `tools.${bare}`) +
            "\n  <calling_convention>\n" +
            "    On OpenCode, ctx_* tools are callable ONLY inside the `execute` tool as `tools.ctx_*(...)`.\n" +
            "    A direct native ctx_* tool call is not resolved by the harness and stalls the turn.\n" +
            "  </calling_convention>\n"
        }
      } catch {
        wrapperRoutingBlock = null
      }
    }

    // Distinctive phrases from the upstream routing block / configs AGENTS.md.
    // Any one of these means the rules are genuinely in the system prompt.
    const ROUTING_RULE_MARKERS = [
      "<context_window_protection>",
      "Every byte a tool returns",
      "PROGRAM the analysis, not COMPUTE it",
    ]

    // ── ctx_* tools ─────────────────────────────────────────────────────
    const registeredCtxTools = []
    const registeredNames = new Set()
    await ctx.tool.transform((editor) => {
      for (const [name, tool] of Object.entries(hooks.tool ?? {})) {
        registeredCtxTools.push(name)
        registeredNames.add(name)
        const shape = tool.args && typeof tool.args === "object" ? tool.args : {}
        editor.add({
          name,
          description: tool.description || name,
          input: z.toJSONSchema(z.object(shape), { io: "input" }),
          execute: async (input, toolCtx) => {
            // The v1 execute closure re-parses args with the original zod v3
            // schema (applying coercions/defaults) and returns { title, output }.
            const result = await tool.execute(input, {
              sessionID: toolCtx.sessionID,
              directory,
            })
            let content = String(result?.output ?? "")
            // ctx_stats ends with the upstream engine version. OpenCode has no
            // place to show a local plugin's own version (`plugin list` prints
            // "local" for every path-loaded plugin — Plugin.Info carries a
            // version only for package sources), so stamp the wrapper version
            // onto the stats footer where it is actually visible.
            const wrapper = wrapperVersion()
            if (name === "ctx_stats" && wrapper && !content.includes(`wrapper v${wrapper}`)) {
              content += `${content.endsWith("\n") || !content ? "" : "\n"}wrapper v${wrapper}\n`
            }
            return {
              content,
              metadata: { title: result?.title ?? name },
            }
          },
        })
      }

      editor.add({
        name: "ctx_routing",
        description:
          "Report context-mode routing status: whether the routing block is injected into the system prompt, whether PreToolUse enforcement is firing, the ctx tool names the model can actually call, and any routing markers found in AGENTS.md.",
        input: z.toJSONSchema(
          z.object({ verbose: z.boolean().optional() }),
          { io: "input" },
        ),
        execute: async (input) => ({
          content: routingReport(Boolean(input?.verbose)),
          metadata: { title: "Routing Status" },
        }),
      })
      registeredNames.add("ctx_routing")
    })

    // Upstream routing text uses the MCP-style OpenCode tool naming
    // (`context-mode_ctx_execute`) because the adapter was written for the MCP
    // path. Native plugin tools are registered bare, so rewrite guidance to the
    // names the model can actually call. Only rewrite when the bare name is
    // registered, so a future upstream that registers prefixed names is left
    // untouched.
    // Code Mode resolves ctx tools as `tools.ctx_*` inside `execute`; a direct
    // bare ctx_* call is not parsed by the harness and stalls the turn, so
    // guidance names are rewritten to the catalog path.
    function normalizeRoutingNames(text) {
      if (typeof text !== "string" || !text.includes("ctx_")) return text
      return text
        .replace(/context-mode_(ctx_[a-z_]+)/g, (match, bare) =>
          registeredNames.has(bare) ? `tools.${bare}` : match,
        )
        .replace(/(?<![\w.])ctx_([a-z_]+)/g, (match, bare) =>
          registeredNames.has(`ctx_${bare}`) ? `tools.ctx_${bare}` : match,
        )
    }

    // The harness renders the Code Mode tool catalog from the session's own tool
    // registry. If that registry predates this plugin, the catalog lists the
    // built-in tools but none of ours — the model still sees the routing rules
    // and burns turns on calls that cannot resolve.
    function inspectCatalog(strings) {
      if (!registeredCtxTools.length) return { found: false, visible: 0 }
      const catalog = strings.find((text) => text.includes("## Available tools"))
      if (!catalog) return { found: false, visible: 0 }
      if (!/(read|shell|edit)/.test(catalog)) return { found: false, visible: 0 }
      return {
        found: true,
        visible: registeredCtxTools.filter((name) => catalog.includes(name)).length,
      }
    }

    function routingReport(verbose) {
      const markerHits = []
      for (const file of ["AGENTS.md", "CLAUDE.md", "CONTEXT.md"]) {
        const path = join(directory, file)
        if (!existsSync(path)) continue
        let text = ""
        try {
          text = readFileSync(path, "utf8")
        } catch {
          continue
        }
        const markers = (adapterMod.ROUTING_MARKERS ?? []).filter((m) => text.includes(m))
        markerHits.push(`${file}: ${markers.length} routing marker(s)`)
      }

      const blockStatus = routingState.injected
        ? "injected by adapter"
        : routingState.wrapperInjected
          ? "injected by wrapper — adapter skipped it because the tool catalog tripped its marker quorum"
          : routingState.skipped
            ? "not injected — real routing rules already present in the system prompt"
            : "not yet observed in this process"

      const lines = [
        "Routing status",
        `  context-mode ${installedContextModeVersion() ?? "unknown"} · wrapper ${wrapperVersion()}`,
        `  ctx tools registered: ${registeredCtxTools.length} (${registeredCtxTools.join(", ")})`,
        `  tool naming: tools.ctx_* via Code Mode execute — direct native ctx_* calls stall the turn; upstream context-mode_* guidance names are rewritten to the catalog path`,
        `  PreToolUse enforcement: ${routingState.modify + routingState.context + routingState.deny} decision(s) observed (modify ${routingState.modify}, context ${routingState.context}, deny ${routingState.deny})`,
        `  PreToolUse readiness: ${
          sentinel.ready
            ? `sentinel active (${sentinel.path})`
            : `no sentinel at ${sentinel.path} — upstream isMCPReady() is false, so every redirect is skipped`
        }`,
        `  routing block: ${blockStatus}`,
      ]
      if (routingState.lastCatalog) {
        lines.push(
          `  tool catalog: ${routingState.lastCatalog.visible}/${registeredCtxTools.length} ctx tools visible in the last inspected session's catalog`,
        )
      }
      if (routingState.staleSessions.size) {
        lines.push(
          `  stale tool registry: ${routingState.staleSessions.size} session(s) in this process cannot call ctx tools ` +
            `(last failed call: ${routingState.lastMissingTool}, ${routingState.missingToolCalls} failure(s)) — ` +
            `run "opencode service restart" or start a new session`,
        )
      }
      if (markerHits.length) lines.push(`  project rules: ${markerHits.join("; ")}`)
      if (verbose) {
        lines.push(`  plugin dir: ${PLUGIN_DIR}`)
        lines.push(`  sessions with routing block: ${routingState.sessions.size}`)
        if (routingState.lastRewrite) {
          lines.push(`  last PreToolUse rewrite: ${String(routingState.lastRewrite).slice(0, 160)}`)
        }
        lines.push(
          "  note: copying configs/opencode/AGENTS.md is optional — the adapter injects the same rules per session and skips injection when markers are already present",
        )
      }
      return lines.join("\n")
    }

    // ── PreToolUse: routing enforcement (deny / modify / passthrough) ───
    if (hooks["tool.execute.before"]) {
      await ctx.tool.hook("execute.before", async (event) => {
        const args = event.input ?? {}
        const commandBefore = typeof args.command === "string" ? args.command : null
        const contextBefore = typeof args.additionalContext === "string"
        try {
          await hooks["tool.execute.before"](
            { tool: event.tool, sessionID: event.sessionID },
            { args },
          )
        } catch (error) {
          routingState.deny += 1
          throw error
        }
        // The adapter mutates `args` in place; align any tool names it injects
        // with the names actually registered on the v2 tool surface.
        if (typeof args.command === "string") args.command = normalizeRoutingNames(args.command)
        if (typeof args.additionalContext === "string") {
          args.additionalContext = normalizeRoutingNames(args.additionalContext)
          if (!contextBefore) routingState.context += 1
        }
        if (commandBefore !== null && args.command !== commandBefore) {
          routingState.modify += 1
          routingState.lastRewrite = args.command
        }
      })
    }

    // ── PostToolUse: session event capture ──────────────────────────────
    if (hooks["tool.execute.after"]) {
      await ctx.tool.hook("execute.after", async (event) => {
        let output = ""
        if (event.status === "completed") {
          if (typeof event.result?.output === "string") {
            output = event.result.output
          } else if (Array.isArray(event.result?.content)) {
            output = event.result.content.map((c) => c?.text ?? "").join("\n")
          } else {
            output = JSON.stringify(event.result ?? "")
          }
        }

        // A session whose tool registry was built before this plugin loaded
        // cannot call ctx tools. Warn once per session and tell that session to
        // stop trying, rather than letting it burn turns on failed calls.
        try {
          const stale = output.match(STALE_REGISTRY_ERROR)
          if (stale) {
            routingState.missingToolCalls += 1
            routingState.lastMissingTool = stale[1]
            if (!routingState.staleSessions.has(event.sessionID)) {
              routingState.staleSessions.add(event.sessionID)
              warn(
                `Detected active session ${event.sessionID} without ctx tools ` +
                `(last call: ${stale[1]}). Run "opencode service restart" or create a new session.`
              )
            }
          }
        } catch {
          // Detection is observational only; never break the turn over it.
        }

        await hooks["tool.execute.after"](
          { tool: event.tool, sessionID: event.sessionID, args: event.input },
          { output },
        )
      })
    }

    // ── chat.message: user-prompt capture ───────────────────────────────
    if (hooks["chat.message"]) {
      await ctx.session.hook("prompt", async (event) => {
        const text = typeof event.prompt?.text === "string" ? event.prompt.text : ""
        if (!text) return
        await hooks["chat.message"](
          { sessionID: event.sessionID },
          { parts: [{ type: "text", text }] },
        )
      })
    }

    // ── PreCompact: resume snapshot + auto-injection ────────────────────
    if (hooks["experimental.session.compacting"]) {
      await ctx.session.hook("compaction", async (event) => {
        const output = { context: [] }
        await hooks["experimental.session.compacting"](
          { sessionID: event.sessionID },
          output,
        )
        // v1 appended snapshots to the compaction prompt via output.context;
        // in v2 the compaction request's system parts serve the same purpose.
        // Cap the injected text: OpenCode's reducer trims messages only, so an
        // oversized system part makes the request irreducible (see
        // capCompactionContext above).
        for (const text of output.context) {
          if (!text) continue
          const capped = capCompactionContext(String(text), snapshotCap)
          if (capped.length !== String(text).length) {
            warn(
              `capped compaction snapshot from ${String(text).length} to ` +
                `${capped.length} chars (compactionSnapshotChars: 0 disables)`
            )
          }
          event.system.push({ type: "text", text: capped })
        }
      })
    }

    // ── system.transform: routing block + resume snapshot injection ─────
    if (hooks["experimental.chat.system.transform"]) {
      await ctx.session.hook("context", async (event) => {
        // Injection is best-effort: a bug here must not break the turn, so the
        // body is guarded and failures are reported on stderr rather than thrown
        // into the session.
        try {
          const system = Array.isArray(event.system) ? event.system : []
          const strings = system.map((part) => part?.text ?? "")
          await hooks["experimental.chat.system.transform"](
            { sessionID: event.sessionID },
            { system: strings },
          )
          if (strings.some((text) => text.includes("<context_window_protection>"))) {
            routingState.injected = true
            routingState.sessions.add(event.sessionID)
          } else if (ROUTING_RULE_MARKERS.some((marker) => strings.join("\n").includes(marker))) {
            routingState.skipped = true
          } else if (wrapperRoutingBlock) {
            // Adapter skipped injection because the tool catalog tripped its marker
            // quorum. Splice at index 1 (after the header) for the same cache-fold
            // reason the adapter uses.
            strings.splice(1, 0, wrapperRoutingBlock)
            routingState.wrapperInjected = true
            routingState.sessions.add(event.sessionID)
          }
          const catalog = inspectCatalog(strings)
          if (catalog.found) routingState.lastCatalog = catalog
          if (catalog.found && catalog.visible === 0 && !routingState.staleSessions.has(event.sessionID)) {
            routingState.staleSessions.add(event.sessionID)
            warn(
              `Detected active session ${event.sessionID} without ctx tools in its tool registry. ` +
              `Run "opencode service restart" or create a new session.`
            )
          }
          if (routingState.staleSessions.has(event.sessionID)) {
            strings.push(STALE_REGISTRY_NOTE)
          }
          event.system.length = 0
          for (const text of strings) {
            const t = String(text)
            // The adapter splices the resume snapshot into the system parts;
            // cap it the same way as the compaction injection so a bloated
            // <errors> section cannot blow the context window on resume.
            const capped = t.startsWith("<session_resume")
              ? capCompactionContext(t, snapshotCap)
              : t
            event.system.push({ type: "text", text: normalizeRoutingNames(capped) })
          }
        } catch (error) {
          warn(`routing injection failed for session ${event.sessionID}: ${error.message}`)
        }
      })
    }

    // ── message.updated: token/cost usage capture ───────────────────────
    if (hooks.event) {
      const controller = new AbortController()
      void (async () => {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (event.type !== "message.updated") continue
          const info = event.data?.info ?? event.data?.message ?? event.data
          try {
            // v1 handler accepts { event: { properties: { info } } }; normalize
            // the v2 payload into that shape.
            await hooks.event({
              event: { type: "message.updated", properties: { info } },
            })
          } catch {
            // Usage capture is best-effort; never break the session.
          }
        }
      })()
      cleanups.push(() => controller.abort())
    }

    return () => {
      for (const cleanup of cleanups) cleanup()
    }
  },
})
