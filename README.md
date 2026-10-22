# context-mode-opencode-v2

An OpenCode **v2** plugin wrapper for [context-mode](https://github.com/mksglu/context-mode).

Upstream context-mode ships an OpenCode **v1**-style plugin adapter. OpenCode v2 requires plugins that export a default definition via `Plugin.define({ id, setup })`, so loading the v1 adapter directly fails with:

```text
Plugin must export a default definition with an id and an effect or setup function
```

This wrapper calls the upstream adapter factory and re-registers everything on the v2 API:

- **ctx_\* tools** (`ctx_batch_execute`, `ctx_search`, `ctx_execute`, `ctx_stats`, ...) registered natively via `ctx.tool.transform`, with input schemas derived from the upstream zod v3 schemas converted to JSON Schema (zod v4 `toJSONSchema`).
- **PreToolUse routing enforcement** (`tool.execute.before`) via `ctx.tool.hook("execute.before")`, plus the MCP readiness sentinel upstream requires before any redirect fires (see below).
- **PostToolUse session event capture** (`tool.execute.after`) via `ctx.tool.hook("execute.after")`.
- **User prompt capture** (`chat.message`) via `ctx.session.hook("prompt")`.
- **PreCompact resume snapshot** (`experimental.session.compacting`) via `ctx.session.hook("compaction")`.
- **System prompt transform** (`experimental.chat.system.transform`) via `ctx.session.hook("context")`.
- **Token/cost usage capture** (`message.updated`) via `ctx.event.subscribe`.

## Install

The plugin installs its own dependencies. OpenCode does **not** run `npm install` for local plugin directories, so `index.js` bootstraps `context-mode` into the plugin's own directory the first time it is loaded.

### Option A — drop it in (recommended)

```bash
mkdir -p ~/.config/opencode/plugins/context-mode-opencode-v2
cp index.js ~/.config/opencode/plugins/context-mode-opencode-v2/index.js
```

That is the whole setup: on first load the wrapper writes a `package.json` if none exists, runs `npm install`, and registers the ctx tools.

```bash
opencode plugin list
```

### Option B — point OpenCode at a checkout

```bash
git clone https://github.com/aifeifei798/context-mode-opencode-v2
cd context-mode-opencode-v2
npm install
```

```jsonc
// ~/.config/opencode/opencode.json
{
  "plugins": ["/absolute/path/to/context-mode-opencode-v2"]
}
```

`npm install` is optional here too — the bootstrap runs it if `node_modules/context-mode` is missing.

### Option C — install as a package plugin

```bash
opencode plugin add github:aifeifei798/context-mode-opencode-v2
```

OpenCode installs package plugins and their dependencies, and `opencode plugin update` upgrades them.

Notes:

- Requires OpenCode v2.x and Node 18+.
- `better-sqlite3` is a native dependency. npm 12+ blocks install scripts unless `allowScripts` is declared in **package.json** (the `.npmrc` form is no longer recognised). It is declared here. The wrapper also checks for the compiled binding (`node_modules/better-sqlite3/build/Release/better_sqlite3.node`) and heals it with `npm rebuild better-sqlite3` if it is missing — this is the case when OpenCode installs a package plugin with Bun and skips install scripts.
- Relative plugin paths resolve **from the config file that contains the entry**, so `"./plugins/context-mode-opencode-v2"` in `~/.config/opencode/opencode.json` means `~/.config/opencode/plugins/context-mode-opencode-v2`.

## Keeping context-mode up to date

`package.json` declares `context-mode` with a caret range, and the wrapper checks npm for a newer release once per day in the background (never blocking plugin load). The upgraded version is picked up on the next plugin reload.

Disable it with either:

```jsonc
{ "plugins": [{ "package": "./plugins/context-mode-opencode-v2", "options": { "autoUpdate": false } }] }
```

or `CONTEXT_MODE_AUTO_UPDATE=0` in the environment.

If a future upstream release changes the adapter export shape or hook names, the wrapper fails loudly with an actionable message instead of silently registering zero tools.

## Routing rules — no `AGENTS.md` copy needed

Upstream's OpenCode docs tell you to copy the routing rules into your project:

```bash
cp node_modules/context-mode/configs/opencode/AGENTS.md AGENTS.md
```

That step is **optional here**. The adapter injects the same rules into the system prompt per session (`experimental.chat.system.transform`), and the wrapper maps that to `ctx.session.hook("context")`. PreToolUse enforcement (`tool.execute.before`) also runs: `curl`/`wget` and inline HTTP are rewritten, and raw-output-heavy commands get a think-in-code nudge.

Two things the wrapper fixes around that injection:

1. **Marker false positive.** The adapter skips injection when the system prompt already contains a quorum of `ROUTING_MARKERS` (`<context_window_protection>`, `ctx_search`, `ctx_index`). Harnesses that merely *list* ctx tool names in the tool catalog (Code Mode, MCP tool listings) trip that check, so the rules never reach the prompt even though no rules are present. The wrapper detects this and injects the upstream routing block itself, built from `context-mode/hooks/routing-block.mjs` with the tool names actually registered.
2. **Tool-name mismatch.** Upstream guidance text uses the MCP-style OpenCode convention (`context-mode_ctx_execute`), but native plugin tools are registered bare (`ctx_execute`). The wrapper rewrites guidance to the registered names, so the model is pointed at tools that exist.

That enforcement is gated upstream: `mcpRedirect()` returns `null` unless `isMCPReady()` finds a live `context-mode-mcp-ready-<pid>` sentinel in `/tmp` (or one touched within 90 s), and only the MCP server ever wrote it. Under OpenCode v2 the ctx tools are native plugin tools and no MCP server runs, so the gate was permanently closed and every redirect silently no-op'd. The wrapper writes the sentinel for its own PID at setup and refreshes it every 30 s; `ctx_routing` reports the result as `PreToolUse readiness: sentinel active (<path>)`. Override the directory with `CONTEXT_MODE_MCP_SENTINEL_DIR` if `/tmp` is not writable — otherwise setup warns and runs with redirects disabled.

Check what is actually active:

```
ctx_routing({ verbose: true })
```

```
Routing status
  context-mode 1.0.169 · wrapper 1.3.1
  ctx tools registered: 11 (ctx_execute, ctx_search, ...)
  PreToolUse enforcement: 2 decision(s) observed (modify 2, context 0, deny 0)
  PreToolUse readiness: sentinel active (/tmp/context-mode-mcp-ready-12345)
  routing block: injected by wrapper — adapter skipped it because the tool catalog tripped its marker quorum
  project rules: AGENTS.md: 0 routing marker(s)
```

If a session in this process has a stale tool registry, the report also prints a `stale tool registry:` line — see [Troubleshooting](#troubleshooting).

Turn the wrapper-side injection off with `"options": { "routingBlock": false }` or `CONTEXT_MODE_ROUTING_BLOCK=0`. If you do copy `configs/opencode/AGENTS.md` into your project, the wrapper sees the real rules and does not duplicate them.

## Dependency boundary

This package is a thin adapter, not a fork. Everything except `index.js` (~150 lines) comes from upstream:

| Layer | What it is | Size | License |
|---|---|---|---|
| `index.js` (this repo) | v1 → v2 hook/tool adapter + dependency bootstrap | ~150 lines | MIT |
| `context-mode/build/adapters/opencode/` | upstream OpenCode adapter | ~1,000 lines | Elastic License 2.0 |
| `context-mode` core engine | indexing, search, session storage, bundles | ~10,000 lines / ~2.4 MB | Elastic License 2.0 |
| `better-sqlite3` | native SQLite binding used by the core | native | MIT |

Runtime data (per-session SQLite databases, indexed content) lives in `~/.config/opencode/context-mode/{sessions,content}` and is owned by the upstream engine, not by this wrapper.

Because the core is **Elastic License 2.0**, this wrapper may not be redistributed as a hosted or managed service that runs context-mode for third parties. Self-hosted use, local installs, and npm/GitHub distribution of the adapter with attribution to [mksglu/context-mode](https://github.com/mksglu/context-mode) are fine.

## Releasing

npm publishing is **not required**. OpenCode's `plugin add` accepts a Git package specifier, so the repository itself is the distribution channel:

```bash
opencode plugin add github:aifeifei798/context-mode-opencode-v2   # installs from the repo
opencode plugin check                                            # reports outdated package plugins
opencode plugin update                                           # re-resolves the repo
```

Verified on OpenCode v2.0.30: the Git path caches the repo under `~/.cache/opencode/npm/git-<name>-<hash>/`, installs `context-mode` as a dependency, and the wrapper heals the missing `better-sqlite3` binding on first load (OpenCode's package install leaves `node_modules/better-sqlite3/build` empty).

If you do have an npm account, the same package can be published for the bare-name path:

```bash
npm login
npm publish          # package.json `files` limits the payload to index.js, README, LICENSE, AGENTS.md
```

Before releasing, run the offline smoke test (no OpenCode process required):

```bash
npm run check    # node --check index.js
npm run smoke    # stubs @opencode/plugin, calls setup(), asserts the 11 ctx tools + ctx_routing and the routing hooks
```

## How OpenCode discovers the plugin

Two discovery paths exist, and mixing them loads the plugin twice:

| Path | Loaded automatically? |
|---|---|
| `~/.config/opencode/plugins/<dir>/index.js` (global) | Yes — direct `.js`/`.ts` files and immediate plugin package directories are discovered |
| `.opencode/plugins/<dir>/` in a project | Yes |
| `plugins/` next to a project-root `opencode.json(c)` | **No** — must be listed in `plugins`, or moved under `.opencode/` |

If you previously dropped a copy into `~/.config/opencode/plugins/` and now also list the directory in `plugins`, both instances load. Keep exactly one:

```bash
# move the stale copy out of the discovered plugins directory
mv ~/.config/opencode/plugins/context-mode-v2 ~/.config/opencode/.backup/context-mode-v2-old
```

## Working on the plugin locally (dev setup)

Point the global config at the checkout so edits are picked up without re-copying files:

```jsonc
// ~/.config/opencode/opencode.json
{
  "plugins": ["/absolute/path/to/context-mode-opencode-v2"]
}
```

Then:

```bash
cd /absolute/path/to/context-mode-opencode-v2
npm install
npm run reload   # node --check + smoke test + opencode service restart
```

Reload behaviour (verified on OpenCode v2.0.30):

- Changes under watched config directories (`~/.config/opencode/`, `.opencode/`) reload automatically.
- A local plugin directory outside those watched directories is **not** watched — editing `index.js` in the checkout does **not** hot-reload the running server (confirmed: the live session kept the old code until `opencode service restart`).
- `npm run reload` is the one-liner for the edit → verify → restart loop.
- Verified on OpenCode v2.0.30 with context-mode 1.0.169.
- `@opencode/plugin` is provided by OpenCode's plugin runtime; it is intentionally not a dependency of this package.

## Verify

```bash
opencode plugin list
# ID               VERSION  SOURCE
# context-mode.v2  local    /absolute/path/to/context-mode-opencode-v2/index.js
```

The server log should show the plugin being loaded without errors:

```bash
grep -i "loading plugin" ~/.local/share/opencode/log/opencode.log | tail -3
```

Then smoke-test the tools through Code Mode:

```js
await tools.ctx_stats()
```

Rollback: delete the `plugins` entry from `opencode.json` and move the backup copy back into `~/.config/opencode/plugins/`.

## Troubleshooting

### `No tool named "ctx_batch_execute" is currently available`

OpenCode builds a session's tool registry when the session is loaded into a server process. A session that was created **before** the plugin registered its ctx tools keeps the old registry until it is reloaded. The routing rules are injected per request, so they still reach that session's system prompt — the model dutifully calls `ctx_*` and every call fails.

Two things to know:

- Indexed events are **not** proof the tools are callable. The hooks (event capture, resume snapshot) can run normally while the tool registry is stale, so `~/.config/opencode/context-mode/sessions/<session>.db` will happily show hundreds of captured events with zero working ctx calls.
- `ctx.session.hook("context")` receives an `event.tools` map that only contains OpenCode's built-in tools, not plugin-registered ones, so that map is not a usable per-session signal.

The wrapper detects the stale registry two ways and warns once per session:

1. **Tool catalog check.** The harness renders the Code Mode tool catalog from the session's own registry. If that catalog lists built-ins but none of the registered ctx tools, the wrapper prints a highlighted warning to stderr:

   ```
   [context-mode-v2] Detected active session ses_… without ctx tools in its tool registry. Run "opencode service restart" or create a new session.
   ```

   and appends a short `<context_mode_stale_registry>` note to that session's system prompt so the model stops burning turns on calls that cannot resolve.
2. **Failed-call check.** Any tool result containing `No tool named "ctx_*" is currently available` is counted, warned about, and surfaced by `ctx_routing`:

   ```
   stale tool registry: 1 session(s) in this process cannot call ctx tools (last failed call: ctx_execute, 4 failure(s)) — run "opencode service restart" or start a new session
   ```

Fix: start a new session, or restart the service so the old session is reloaded into a process that has the plugin:

```bash
opencode service restart
```

Verified on a session that had four failed ctx calls: after reload, `ctx_stats` returns, the PreToolUse `curl`/`wget` rewrite fires in the same session (see `PreToolUse readiness` in `ctx_routing`), and no stale-registry warning is printed.

### PreToolUse redirects never fire (`curl` runs untouched)

Symptom: `curl`/`wget`/inline-HTTP commands run as-is, `ctx_routing` shows `PreToolUse enforcement: 0 decision(s)`, and the smoke test fails with `curl redirect rewritten: false`.

Cause: upstream only rewrites commands when `isMCPReady()` is true, which means a live `context-mode-mcp-ready-<pid>` file in `/tmp`. Every redirect was written for the MCP server deployment; a native-plugin deployment has no MCP server. The wrapper writes that sentinel itself, so this should only happen when the write failed — `/tmp` read-only, or a sandbox with an unusual tmp root.

Check and fix:

```
ctx_routing({ verbose: true })     # look at "PreToolUse readiness"
ls -la /tmp/context-mode-mcp-ready-*   # pid must be the OpenCode service process
```

If the report says the sentinel is missing, point it at a writable directory:

```bash
CONTEXT_MODE_MCP_SENTINEL_DIR=~/.cache/context-mode opencode service restart
```

Do **not** hand-create a sentinel for a dead PID and expect it to stick: upstream probes the PID and deletes markers older than 90 s that it cannot see.

### SQLite concurrency

No action needed. Upstream opens every session database with `PRAGMA journal_mode = WAL`, `PRAGMA synchronous = NORMAL`, `PRAGMA busy_timeout = 30000`, and wraps writes in `withRetry()` (exponential backoff on `SQLITE_BUSY` / `database is locked`, `[100, 500, 2000]` ms). Confirmed on live session DBs:

```bash
sqlite3 ~/.config/opencode/context-mode/sessions/<session>.db 'PRAGMA journal_mode; PRAGMA busy_timeout;'
# wal
# 30000
```

Concurrent agents in the same process share those DBs safely; the `*-wal` / `*-shm` side files in `~/.config/opencode/context-mode/sessions/` are the WAL mode in action.

## Caveats

- The wrapper is tested against context-mode **1.0.169** and declares it with a caret range. If upstream changes the adapter export shape (`server` / `ContextModePlugin`) or hook names, the wrapper throws with an actionable message rather than silently loading nothing.
- The bootstrap also checks for `better-sqlite3`'s native binding (`node_modules/better-sqlite3/build/Release/better_sqlite3.node`). If install scripts were blocked, it reports `native-binding-missing` instead of failing later at runtime.
- ctx tools are exposed through Code Mode's `execute` catalog; long-running commands inside `ctx_batch_execute` are bounded by the `timeout` argument you pass, not by a platform default.

## License

MIT for this wrapper. The upstream `context-mode` engine it depends on is **Elastic License 2.0** — see [Dependency boundary](#dependency-boundary).
