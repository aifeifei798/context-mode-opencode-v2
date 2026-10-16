# AGENTS.md

OpenCode v2 plugin wrapper for context-mode (mksglu/context-mode). The upstream ships an OpenCode v1-style adapter; this repo re-registers its tools and hooks on the v2 `Plugin.define({ id, setup })` API.

## Structure

- `index.js` is the entire plugin — one default export, no other source files.
- `index.js` runs `ensureContextMode()` at **module load time** (top level, before `Plugin.define`), so `context-mode` is installed before the plugin loader resolves anything. Do not move that call into `setup`; the loader can attempt a load before `setup` finishes.
- No build, test, lint, or typecheck scripts exist in `package.json` beyond `npm run check` (`node --check index.js`). Verify changes by loading the plugin in OpenCode (`"plugins": ["/absolute/path/to/context-mode-opencode-v2"]` in `opencode.json`) and smoke-testing `await tools.ctx_stats()` via Code Mode.
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

- OpenCode does **not** install npm dependencies for local plugin directories, so `index.js` self-installs: if `node_modules/context-mode` is missing (or `better-sqlite3`'s native binding is absent) it writes a fallback `package.json` (when none exists) and runs `npm install --no-audit --no-fund` in the plugin's own directory via `spawnSync`. Verified end-to-end by deleting `node_modules` and touching `index.js`.
- `nativeBindingPresent()` checks `node_modules/better-sqlite3/build/{Release,Debug}/better_sqlite3.node` (top-level or nested under `context-mode`). Package plugins installed by OpenCode's Bun loader may skip install scripts, so this check is what turns a late runtime SIGSEGV/`Could not locate the bindings file` into an early, actionable `native-binding-missing` error.
- npm 12+ blocks install scripts unless `allowScripts` is declared in **package.json**; the `.npmrc` form is now an unknown config and was removed. `allowScripts` uses bare package names (`better-sqlite3`, `context-mode`) so upstream version bumps are not silently blocked. If the native binding is still missing: `cd node_modules/better-sqlite3 && npm run install`.
- `scheduleContextModeUpdate()` runs `npm view context-mode version` once per 24 h in the background with `spawn` (non-blocking; cooldown stored in `ctx.storage`) and installs a newer release if found. The new version is picked up on the next reload. Disable with `CONTEXT_MODE_AUTO_UPDATE=0` or the `autoUpdate: false` plugin option.
- `@opencode/plugin` is supplied by OpenCode's runtime and is intentionally not a dependency.

## Dependency boundary / license

This repo is an adapter, not a fork: ~150 lines here, ~1,000 lines of upstream adapter, ~10,000 lines (~2.4 MB) of upstream core. Runtime data lives in `~/.config/opencode/context-mode/{sessions,content}` and is owned by the upstream engine. The wrapper is MIT; the upstream `context-mode` core is **Elastic License 2.0**, so the wrapper must not be redistributed as a hosted/managed service running context-mode for third parties. Keep attribution to mksglu/context-mode.
