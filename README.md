# context-mode-opencode-v2

An OpenCode **v2** plugin wrapper for [context-mode](https://github.com/mksglu/context-mode).

Upstream context-mode ships an OpenCode **v1**-style plugin adapter. OpenCode v2 requires plugins that export a default definition via `Plugin.define({ id, setup })`, so loading the v1 adapter directly fails with:

```text
Plugin must export a default definition with an id and an effect or setup function
```

This wrapper calls the upstream adapter factory and re-registers everything on the v2 API:

- **ctx_\* tools** (`ctx_batch_execute`, `ctx_search`, `ctx_execute`, `ctx_stats`, ...) registered natively via `ctx.tool.transform`, with input schemas derived from the upstream zod v3 schemas converted to JSON Schema (zod v4 `toJSONSchema`).
- **PreToolUse routing enforcement** (`tool.execute.before`) via `ctx.tool.hook("execute.before")`.
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

```bash
npm login
npm publish          # package.json `files` limits the payload to index.js, README, LICENSE, AGENTS.md
```

After publishing, users get the zero-config path:

```bash
opencode plugin add context-mode-opencode-v2
opencode plugin update context-mode-opencode-v2
```

Before releasing, run the offline smoke test (no OpenCode process required):

```bash
npm run check    # node --check index.js
npm run smoke    # stubs @opencode/plugin, calls setup(), asserts 11 ctx tools + ctx_stats output
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
opencode service restart
```

Reload behaviour:

- Changes under watched config directories (`~/.config/opencode/`, `.opencode/`) reload automatically.
- A local plugin directory outside those watched directories is **not** watched — after editing `index.js`, restart the service (`opencode service restart`).
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

## Caveats

- The wrapper is tested against context-mode **1.0.169** and declares it with a caret range. If upstream changes the adapter export shape (`server` / `ContextModePlugin`) or hook names, the wrapper throws with an actionable message rather than silently loading nothing.
- The bootstrap also checks for `better-sqlite3`'s native binding (`node_modules/better-sqlite3/build/Release/better_sqlite3.node`). If install scripts were blocked, it reports `native-binding-missing` instead of failing later at runtime.
- ctx tools are exposed through Code Mode's `execute` catalog; long-running commands inside `ctx_batch_execute` are bounded by the `timeout` argument you pass, not by a platform default.

## License

MIT for this wrapper. The upstream `context-mode` engine it depends on is **Elastic License 2.0** — see [Dependency boundary](#dependency-boundary).
