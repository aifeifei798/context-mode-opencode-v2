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

### Option A — local plugin directory (recommended)

OpenCode does not auto-install npm dependencies for local plugin directories, so install them manually:

```bash
git clone https://github.com/aifeifei798/context-mode-opencode-v2
cd context-mode-opencode-v2
npm install
```

Then point OpenCode at the directory in `~/.config/opencode/opencode.json`:

```jsonc
{
  "plugins": ["./plugins/context-mode-opencode-v2"]
}
```

Notes:

- `better-sqlite3` is a native dependency. The included `.npmrc` (`allowScripts=better-sqlite3`) lets its prebuilt binaries install; if your npm blocks scripts, run `cd node_modules/better-sqlite3 && npm run install`.
- Requires OpenCode v2.x and Node 18+.

### Option B — GitHub plugin reference

```jsonc
{
  "plugins": ["github:aifeifei798/context-mode-opencode-v2"]
}
```

OpenCode fetches GitHub plugins and installs their dependencies; if the native `better-sqlite3` build is blocked by your npm script policy, fall back to Option A.

## Verify

After restarting OpenCode, the ctx tools should appear in the session tool catalog. Quick smoke test through Code Mode:

```js
await tools.ctx_stats()
```

## Caveats

- The wrapper targets context-mode **1.0.169**. If upstream changes the adapter export shape (`server` / `ContextModePlugin`) or hook names, the wrapper may need updating.
- ctx tools are exposed through Code Mode's `execute` catalog; long-running commands inside `ctx_batch_execute` are bounded by the `timeout` argument you pass, not by a platform default.

## License

MIT
