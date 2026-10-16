/**
 * OpenCode v2 wrapper for context-mode (mksglu/context-mode).
 *
 * context-mode ships an OpenCode v1-style plugin adapter
 * (`context-mode/build/adapters/opencode/plugin.js`). OpenCode v2 requires
 * plugins that export `Plugin.define({ id, setup })`, so this wrapper calls
 * the upstream v1 factory and re-registers its tools and hooks on the v2 API.
 */
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "context-mode.v2",
  async setup(ctx) {
    const adapterMod = await import("context-mode/plugin")
    const createContextModePlugin = adapterMod.server ?? adapterMod.ContextModePlugin
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
