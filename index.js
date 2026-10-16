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
import { fileURLToPath } from "node:url"
import { existsSync, readFileSync, writeFileSync } from "node:fs"

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

/**
 * Ensure context-mode is available. Blocking, only when missing.
 * npm 12+ blocks install scripts unless `allowScripts` is declared in
 * package.json, which is why better-sqlite3's prebuilt binary needs it.
 */
function ensureContextMode() {
  if (existsSync(CONTEXT_MODE_DIR)) return { ok: true, action: "present" }

  if (!existsSync(join(PLUGIN_DIR, "package.json"))) {
    try {
      writeFileSync(join(PLUGIN_DIR, "package.json"), JSON.stringify(FALLBACK_PACKAGE_JSON, null, 2) + "\n")
    } catch (error) {
      return { ok: false, action: "no-package-json", error: error.message }
    }
  }

  const result = npmInstall([], 180_000)
  if (result.status === 0 && existsSync(CONTEXT_MODE_DIR)) {
    return { ok: true, action: "installed" }
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

    // ── ctx_* tools ─────────────────────────────────────────────────────
    await ctx.tool.transform((editor) => {
      for (const [name, tool] of Object.entries(hooks.tool ?? {})) {
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
            return {
              content: String(result?.output ?? ""),
              metadata: { title: result?.title ?? name },
            }
          },
        })
      }
    })

    // ── PreToolUse: routing enforcement (deny / modify / passthrough) ───
    if (hooks["tool.execute.before"]) {
      await ctx.tool.hook("execute.before", async (event) => {
        await hooks["tool.execute.before"](
          { tool: event.tool, sessionID: event.sessionID },
          { args: event.input },
        )
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
        for (const text of output.context) {
          if (text) event.system.push({ type: "text", text: String(text) })
        }
      })
    }

    // ── system.transform: routing block + resume snapshot injection ─────
    if (hooks["experimental.chat.system.transform"]) {
      await ctx.session.hook("context", async (event) => {
        const strings = event.system.map((part) => part?.text ?? "")
        await hooks["experimental.chat.system.transform"](
          { sessionID: event.sessionID },
          { system: strings },
        )
        event.system.length = 0
        for (const text of strings) {
          event.system.push({ type: "text", text: String(text) })
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
      return () => controller.abort()
    }
  },
})
