# AGENTS.md

OpenCode v2 plugin wrapper for context-mode (mksglu/context-mode). The upstream ships an OpenCode v1-style adapter; this repo re-registers its tools and hooks on the v2 `Plugin.define({ id, setup })` API.

## Structure

- `index.js` is the entire plugin — one default export, no other runtime source files. `scripts/smoke.mjs` is a test harness only and is never loaded by OpenCode.
- `index.js` runs `ensureContextMode()` at **module load time** (top level, before `Plugin.define`), so `context-mode` is installed before the plugin loader resolves anything. Do not move that call into `setup`; the loader can attempt a load before `setup` finishes.
- The only scripts in `package.json` are `npm run check` (`node --check index.js`) and `npm run smoke` (`node scripts/smoke.mjs`). The smoke test stubs `@opencode/plugin` in `node_modules`, calls `setup()` with a fake `ctx`, and asserts the ctx tools and hooks register — it does not need an OpenCode process. It points `CONTEXT_MODE_MCP_SENTINEL_DIR` at `node_modules/.smoke-sentinel` and deletes it on exit, so the PreToolUse assertion never depends on (or leaves behind) markers in the host's `/tmp`; cleanup runs at the end of the script, which is why the fake `ctx.event.subscribe` iterator is finite (a never-ending stub would keep the process alive). Verify changes in OpenCode as well by loading the plugin (`"plugins": ["/absolute/path/to/context-mode-opencode-v2"]` in `opencode.json`) and smoke-testing `await tools.ctx_stats()` via Code Mode.
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
| `experimental.chat.system.transform` | `ctx.session.hook("context")` — routing block + resume snapshot, plus wrapper-side routing backfill (see Routing) |
| `event` (message.updated) | `ctx.event.subscribe` with an `AbortController`; cleanup returned from `setup` |

Gotchas an agent is likely to miss:

- The wrapper is pinned to context-mode **1.0.169** (`^1.0.169`). If upstream changes the export shape (`server` / `ContextModePlugin`) or hook names, the mapping in `index.js` breaks — check the installed adapter in `node_modules/context-mode/plugin` before assuming.
- `package.json` declares `zod ^3.25`, but the code imports `zod/v4` (the v4 API subpath shipped in zod 3.25+). Do not "fix" this to a plain `zod` import; `z.toJSONSchema` with `io: "input"` is required.
- v1 tool `execute` closures re-parse args with the original zod v3 schemas (coercions/defaults), so pass through the JSON-Schema-validated input as-is; return `{ content, metadata: { title } }`.
- Usage capture (`message.updated`) is best-effort and must never throw out of the session — keep the `try/catch`.
- **Wrapper version visibility.** `opencode plugin list` prints `local` for every path-loaded plugin: `Plugin.Info.source` is a tagged union (`builtin` / `package` / `local` / `sdk` in `packages/schema/src/plugin.ts`) and carries a version only for `package` sources, and `Plugin.define` has no version field (adding one is silently ignored — verified). Do not try to hack it into the id or plugin metadata. The wrapper stamps `wrapper v<version>` onto the `ctx_stats` footer (upstream's own `v1.0.169` line stays above it) and prints `wrapper <version>` in the `ctx_routing` header; `npm run smoke` asserts the `ctx_stats` stamp.
- **PreToolUse redirects are gated on an MCP readiness sentinel that nothing else writes in this deployment.** Upstream's `mcpRedirect()` returns `null` unless `isMCPReady()` (`hooks/core/mcp-ready.mjs`) finds a live `context-mode-mcp-ready-<pid>` in `/tmp` or one whose mtime is under 90 s — the MCP server used to create it, and a native-plugin deployment has no MCP server. `startMcpReadySentinel()` in `index.js` writes `<sentinelDir>/context-mode-mcp-ready-${process.pid}` at setup and re-touches it every 30 s (interval `unref()`d), with a module-level refcount so repeated `setup()` calls in one process share it and only the last cleanup unlinks. Without it every redirect no-ops silently: the symptom is `curl redirect rewritten: false` in `npm run smoke` and `PreToolUse enforcement: 0 decision(s)` in `ctx_routing`. `CONTEXT_MODE_MCP_SENTINEL_DIR` overrides the directory (writable-`/tmp` escape hatch); a failed write must warn, not throw.

## Routing

Beyond the mechanical hook mapping, the wrapper owns three routing behaviours:

- **`ctx_routing` tool** (wrapper-only, not in upstream) reports versions, the registered ctx tool names, PreToolUse decision counters (modify/context/deny inferred from what the adapter mutates), whether the routing block reached the system prompt, and routing markers found in `AGENTS.md`/`CLAUDE.md`/`CONTEXT.md`.
- **Routing block backfill.** The adapter injects its `<context_window_protection>` block only when `systemHasRoutingInstructions()` is false. Tool catalogs that merely *list* `ctx_search`/`ctx_index` trip that quorum, so the rules never arrive. The wrapper checks for real rule markers (`<context_window_protection>`, "Every byte a tool returns", "PROGRAM the analysis, not COMPUTE it") and splices `createRoutingBlock` from `context-mode/hooks/routing-block.mjs` at index 1 (index 1, not unshift — same cache-fold reason as the adapter). Disable with the `routingBlock: false` plugin option or `CONTEXT_MODE_ROUTING_BLOCK=0`.
- **Name normalization.** Upstream guidance text uses MCP-style OpenCode names (`context-mode_ctx_execute`); OpenCode's Code Mode catalog resolves ctx tools only as `tools.ctx_*` inside `execute` — a direct native `ctx_*` call is not parsed by the harness and stalls the turn. `normalizeRoutingNames()` rewrites both `context-mode_ctx_*` and bare `ctx_*` to `tools.ctx_*` (only when the bare name is registered), in the system prompt and in PreToolUse rewrites; the wrapper block also appends a `<calling_convention>` note so the model never attempts a direct call.

Gotchas specific to routing:

- `registeredNames` must stay a **live** `Set` populated inside the `ctx.tool.transform` callback. Snapshotting it with `new Set(registeredCtxTools)` at setup time is empty, because OpenCode invokes the transform callback lazily — normalization then silently no-ops.
- The routing block is built with a Code Mode catalog namer (`(bare) => "tools." + bare`), so every guidance name points at the `execute`-resolved path. If tools ever get different registered names, pass a namer that maps to the callable path instead — bare names stall direct calls.
- `routingState` is module-level, so counters are per process, not per session; `sessions` is a `Set` of session IDs that saw the block.
- A session created before the plugin registered its ctx tools keeps a stale tool registry until it is reloaded: the routing block still reaches its system prompt (injection is per-request), but every `ctx_*` call fails with `No tool named ... is currently available`. `ctx.session.hook("context")`'s `event.tools` lists only OpenCode's built-in tools, not plugin-registered ones (verified empirically) — do not build an injection guard on it. The wrapper instead detects staleness from two signals: the harness-rendered Code Mode catalog (`## Available tools`) listing built-ins but none of `registeredCtxTools`, and any tool output matching `STALE_REGISTRY_ERROR`. Both add the session to `routingState.staleSessions`, warn once via `warn()` (ANSI-yellow stderr), append `STALE_REGISTRY_NOTE` to that session's system parts, and show up in the `ctx_routing` report. `catalogLacksCtxTools()` returns false when no catalog part is found, so harnesses without a catalog never false-positive.
- SQLite concurrency is handled upstream, not here: `context-mode/build/db-base.js` sets `journal_mode = WAL`, `synchronous = NORMAL`, `busy_timeout = 30000`, and wraps writes in `withRetry(fn, [100, 500, 2000])` on `SQLITE_BUSY` / `database is locked`. The wrapper opens no database of its own (`ctx.storage` is OpenCode's store, used only for the auto-update cooldown).

## Compaction snapshot cap

OpenCode v2's compaction reducer (`SessionRunner` → `O()` in the bundled binary) trims **messages only** — the system parts of the compaction request (base prompt, tool catalog, routing block, and the resume snapshot the compaction hook pushes into `event.system`) are never reduced. When the injected snapshot exceeds the compaction budget (`model limit.context − compaction.buffer`, e.g. 110000 − 20000 = 90000 tokens estimated at 4 chars/token), the reducer can't fit even one exchange and the step fails with `Session.StepFailedError: The compaction request cannot be reduced further without losing the latest exchange or checkpoint`.

The upstream snapshot bloats in the `<errors>` section: `buildResumeSnapshot` inlines every stored traceback verbatim (a 428-event session produced 268 KB, 265 KB of it tracebacks). `capCompactionContext()` in `index.js` replaces the errors body with a deduplicated digest of exception lines and hard-truncates with a ctx_search pointer if still over the cap. Default cap 12000 chars; override with the `compactionSnapshotChars` plugin option or `CONTEXT_MODE_COMPACTION_SNAPSHOT_CHARS` (0 disables). Full error text stays in the session DB and is reachable via `ctx_search(source: "session-events")`.

## Dependencies / setup

- OpenCode does **not** install npm dependencies for local plugin directories, so `index.js` self-installs: if `node_modules/context-mode` is missing (or `better-sqlite3`'s native binding is absent) it writes a fallback `package.json` (when none exists) and runs `npm install --no-audit --no-fund` in the plugin's own directory via `spawnSync`. Verified end-to-end by deleting `node_modules` and touching `index.js`.
- `nativeBindingPresent()` checks `node_modules/better-sqlite3/build/{Release,Debug}/better_sqlite3.node` (top-level or nested under `context-mode`). OpenCode's package-plugin install resolves dependencies but skips native install scripts, so this check is what turns a late runtime SIGSEGV/`Could not locate the bindings file` into an early, actionable `native-binding-missing` error.
- `opencode plugin add github:<owner>/<repo>` is a working install path without npm publishing. OpenCode writes a synthetic `package.json` under `~/.cache/opencode/npm/git-<name>-<hash>/<ts>/`, npm-installs the repo as a dependency, and loads `node_modules/<pkg>/index.js`. Deps are hoisted to the parent `node_modules`, so `PLUGIN_DIR/node_modules/context-mode` is absent and the bootstrap installs it into the plugin directory itself; `better-sqlite3/build/Release` is empty and gets healed. Verified end-to-end on OpenCode v2.0.30 with `--standalone`.
- npm 12+ blocks install scripts unless `allowScripts` is declared in **package.json**; the `.npmrc` form is now an unknown config and was removed. `allowScripts` uses bare package names (`better-sqlite3`, `context-mode`) so upstream version bumps are not silently blocked. If the native binding is still missing: `cd node_modules/better-sqlite3 && npm run install`.
- `scheduleContextModeUpdate()` runs `npm view context-mode version` once per 24 h in the background with `spawn` (non-blocking; cooldown stored in `ctx.storage`) and installs a newer release if found. The new version is picked up on the next reload. Disable with `CONTEXT_MODE_AUTO_UPDATE=0` or the `autoUpdate: false` plugin option.
- `@opencode/plugin` is supplied by OpenCode's runtime and is intentionally not a dependency.
- The checkout is not a watched config directory, so editing `index.js` does not hot-reload the running server by itself (verified: a probe line added to `ctx_routing` stayed invisible in a live session). The server does re-resolve and reload its plugin set when asked to enumerate plugins — `opencode plugin list` was enough on v2.1.2 — while `opencode service restart` always works. `npm run reload` chains `node --check index.js`, the smoke test, and the restart.

## Dependency boundary / license

This repo is an adapter, not a fork: ~150 lines here, ~1,000 lines of upstream adapter, ~10,000 lines (~2.4 MB) of upstream core. Runtime data lives in `~/.config/opencode/context-mode/{sessions,content}` and is owned by the upstream engine. The wrapper is MIT; the upstream `context-mode` core is **Elastic License 2.0**, so the wrapper must not be redistributed as a hosted/managed service running context-mode for third parties. Keep attribution to mksglu/context-mode.
