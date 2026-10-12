# dsh-plugin-mcp-session-meta

Makes **DeepSeek Harness** tell MCP servers *which conversation* is calling.

Every `tools/call` the harness sends gets the calling Agent's session id in
`params._meta.session_id`. That is the one piece of information an MCP server
needs to keep per-conversation state — and the one DSH currently leaves blank.

> Chinese documentation: [README.zh.md](README.zh.md).
> This is an **unofficial community plugin** — not affiliated with or endorsed by
> DeepSeek.

## The problem

DSH's MCP client passes `{ name, arguments }` straight through as the request
params, leaving `_meta` empty:

```js
call: (args, execution) => client.callTool({ name: tool.name, arguments: args }, { … })
```

But `_meta` is a first-class optional field of MCP's `BaseRequestParamsSchema`:

```js
const BaseRequestParamsSchema = z.object({ _meta: RequestMetaSchema.optional() })
```

So a server can only ever see *the process*, never *the conversation*. For a
server whose state is per-conversation — browser automation with tab groups,
editors, anything with sessions — every conversation in the harness shares one
bucket and the server has no way to tell them apart.

Other MCP clients already send it: ZCode sends `session_id`, Antigravity sends
`antigravity.google/conversation_id`, Codex sends `thread_id`, WorkBuddy sends
`workbuddy.ai/conversationId`. DSH is the odd one out.

The identity is already sitting at the call site — the agent loop sets
`ToolExecutionInput.agent` (*"The agent on whose behalf the call runs"*), and
`agent.id` **is** the SessionId. It is simply not forwarded.

## What it changes

Two patches, both in the derived artifact:

| Patch | Before | After |
|---|---|---|
| `clientInfo` | `{ name: "dsh-mcp-client", version: "0.0.1" }` — a middleware self-report with a placeholder version | `{ name, title: "DeepSeek Harness", version: "<real>" }` |
| `tools/call` params | `{ name, arguments }` | `{ name, arguments, _meta: { session_id: <agent.id> } }` |

`_meta` is omitted entirely when there is no Agent on the execution (nested
dispatches) — a missing key means "this frame doesn't know", which is different
from claiming a session.

## Install

The artifact has to be regenerated against **your** installed DSH, because the
patch targets DeepSeek's *compiled* bundle and that changes between releases.

```bash
git clone https://github.com/Liang-HZ/dsh-plugin-mcp-session-meta
cd dsh-plugin-mcp-session-meta

node sync.mjs                  # extract from your app.asar + patch (fails loudly if the anchors moved)
node install.mjs --list        # show the MCP entries in your profile
node install.mjs --server NAME # point that one entry at this package
```

Then **restart DSH** — see *Caching* below.

- `--profile web` — target another profile (default `desktop`)
- `--check` — report only, change nothing
- `--uninstall` — put the entry back to the upstream package

Only the entry you name is switched; other MCP servers keep using the upstream
client. Nothing else in the harness changes.

### Caching: a restart is required

DSH caches imported plugin modules. Editing plugin code — or even changing which
package an entry points at — does **not** take effect live: Node's ESM cache is
keyed by URL, and the plugin manager's enable/disable only re-runs `apply()` on
the already-imported module. A restart (or a brand-new entry id) is the only
thing that re-imports. Expect "the entry is active, the module name changed, and
it still runs the old code" until you restart.

## Compatibility

- Built and tested against `@deepseek-ai/dsh-mcp-client` **0.2.0-rc.2**
  (DeepSeek Harness 0.2.0-rc.2, macOS).
- `sync.mjs` asserts on both patch anchors. If a DSH upgrade moves them it
  **fails** rather than emitting an unpatched artifact — a silently unpatched
  copy is the worst outcome here, because the plugin would still load and simply
  stop doing anything.
- Node ≥ 22.15 (extraction uses `zlib.zstdDecompressSync`).

## How it is built (and why not a plain fork)

DeepSeek's harness repository does not accept external pull requests, and the app
bundle is code-signed with per-file integrity hashes — editing files inside
`app.asar` breaks the signature and is overwritten by every update.

So the artifact is **extracted, patched and regenerable** rather than a frozen
copy:

```bash
node sync.mjs          # regenerate lib/index.js from the installed app
node sync.mjs --check  # is the artifact still what this DSH would generate?
```

`sync.mjs` also reads the external modules the bundle imports and writes them
into `peerDependencies`. That is not bookkeeping: DSH's profile resolver supplies
packages **by peer declaration** ("Linked importers apply current peer
declarations at each ancestor node_modules"). An undeclared peer is not supplied,
and the plugin dies during import with no useful error. Deriving the list from
the artifact keeps it in step automatically.

## Notes for other DSH plugin authors

Two things that cost real time to discover:

1. **Declare every package you import as a `peerDependency`.** The resolver in
   `@deepseek-ai/dsh-app-boot` reads the importing package's own manifest to
   decide what to supply. Miss one and the fiber ends up `DISPOSED` with a bare
   `fiber state 4` and no message.
2. **`patchReload: "live"` is a profile setting.** The shipped `web` profile has
   it; a profile without it will not pick up patch edits without a restart.

## When to delete this

When DSH forwards the session id itself. The upstream fix is small — the identity
is already in scope at the call site — and this plugin exists only to fill the gap
in the meantime.

That request is filed here, with the exact change and the evidence:
**https://github.com/deepseek-ai/deepseek-harness/discussions/9519**

If it lands, this package is dead weight — uninstall it.

## License

MIT. The derived `lib/index.js` is a patched build of
[`@deepseek-ai/dsh-mcp-client`](https://www.npmjs.com/package/@deepseek-ai/dsh-mcp-client)
(MIT, © DeepSeek). See [NOTICE](NOTICE).
