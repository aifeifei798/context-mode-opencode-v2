# AGENTS.md

OpenCode v2 plugin wrapper for context-mode (mksglu/context-mode). The upstream ships an OpenCode v1-style adapter; this repo re-registers its tools and hooks on the v2 `Plugin.define({ id, setup })` API.

## Structure

- `index.js` is the entire plugin — one default export, no other source files.
- No build, test, lint, or typecheck scripts exist in `package.json`. Verify changes by loading the plugin in OpenCode (`"plugins": ["./plugins/context-mode-opencode-v2"]` in `opencode.json`) and smoke-testing `await tools.ctx_stats()` via Code Mode.
- ESM (`"type": "module"`), Node 18+, OpenCode v2.x required.

## How the adapter works (read before editing)

`setup` imports `context-mode/plugin`, resolves the v1 factory as `adapterMod.server ?? adapterMod.ContextModePlugin`, calls it with `{ directory, client: { app: { log } } }`, and maps the returned hook object onto v2 APIs:

| v1 hook | v2 registration |
|---|---|
| `tool` (ctx_* tools) | `ctx.tool.transform` — zod v3 arg schemas converted via `zod/v4` `z.toJSONSchema(..., { io: "input" })` |
| `tool.execute.before` | `ctx.tool.hook("execute.before")` |
| `tool.execute.after` | `ctx.tool.hook("execute.after")` (normalize `event.result` to a string `output`) |
| `chat.message` | `ctx.session.hook("prompt")` |
| `experimental.session.compacting` | `ctx.session.hook("compaction")` (v1 `output.context` → v2 `event.system` parts) |
| `experimental.chat.system.transform` | `ctx.session.hook("context")` |
| `event` (message.updated) | `ctx.event.subscribe` with an `AbortController`; cleanup returned from `setup` |

Gotchas an agent is likely to miss:

- The wrapper is pinned to context-mode **1.0.169** (`^1.0.169`). If upstream changes the export shape (`server` / `ContextModePlugin`) or hook names, the mapping in `index.js` breaks — check the installed adapter in `node_modules/context-mode/plugin` before assuming.
- `package.json` declares `zod ^3.25`, but the code imports `zod/v4` (the v4 API subpath shipped in zod 3.25+). Do not "fix" this to a plain `zod` import; `z.toJSONSchema` with `io: "input"` is required.
- v1 tool `execute` closures re-parse args with the original zod v3 schemas (coercions/defaults), so pass through the JSON-Schema-validated input as-is; return `{ content, metadata: { title } }`.
- Usage capture (`message.updated`) is best-effort and must never throw out of the session — keep the `try/catch`.

## Dependencies / setup

- `npm install` is required for local plugin directories (OpenCode does not auto-install deps for local plugins).
- `better-sqlite3` is a native transitive dep of context-mode; `.npmrc` sets `allowScripts=better-sqlite3` so its prebuilt binaries install. If npm blocks scripts: `cd node_modules/better-sqlite3 && npm run install`.
