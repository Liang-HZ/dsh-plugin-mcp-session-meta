# dsh-mcp-client-session-meta

给 DeepSeek Harness 的 MCP 客户端补上**协议级的会话归属**：每次 `tools/call` 的
`params._meta.session_id` 填上调用方那一轮对话的 SessionId。

## 为什么

@deepseek-ai/dsh-mcp-client 把 `{name, arguments}` 当 params 直接交给 SDK
（`client.callTool(params, …)` → `request({method:"tools/call", params})`，params 原样上线），
而 MCP 的 `BaseRequestParamsSchema` **本来就带一个可选的 `_meta`**——

```js
const BaseRequestParamsSchema = z.object({ _meta: RequestMetaSchema.optional() })
```

也就是说协议级的归属通道一直是现成的，只是没被用。后果在 MCP server 侧很具体：
它只能看到「这个进程」，看不到「这一轮对话」。像 agent-in-chrome 那种要按对话隔离标签页的
服务端，就只能回落到「一个 MCP 进程一个 sid」——同一台 DSH 里所有对话共享一份清单。

agent loop 在派发工具时已经把身份填好了（`ToolExecutionInput.agent`，注释写着
"The agent on whose behalf the call runs"），`agent.id` 就是 SessionId。差的就是把它递下去。

## 它是怎么来的

上游仓库（deepseek-ai/deepseek-harness）明确**不收外部 PR**，而 app.asar 有 integrity 校验、
外层还有代码签名——改包里的文件既破坏签名、又会在每次更新时被覆盖。所以这份产物是
**提取 + 打补丁 + 可重生成**，而不是「拷一份改好的冻住」：

```
node sync.mjs          # 从已安装的 DSH 重新生成 lib/index.js
node sync.mjs --check  # 上游变了没有（变了就重新生成）
```

`sync.mjs` 做四件事，任何一件对不上都**硬失败**（宁可生成不出来，也不产出一个没打补丁的副本）：

1. 从 app.asar 取出上游 `lib/index.js`（asar 的数据段在 JSON 目录之后**补齐到 4 字节边界**，
   少算这一步每条记录都会整体前移 2 字节——文本还能 grep，JSON 直接解析不了）；
2. 补 `clientInfo`：上游硬编码 `{name:"dsh-mcp-client", version:"0.0.1"}`，name 是中间件自己的
   包名、version 是占位符。补上 `title: "DeepSeek Harness"` 与真实版本
   （`BaseMetadataSchema = {name, title?}` 是协议里就有的字段）；
3. 补 `_meta.session_id`：把 `callTool` 的 params 换成 `sessionCallParams(...)`，
   有 `execution.agent.id` 才带这个键，没有就**不带**（缺键是「这一帧不知道」，
   带个空值反而是在声称知道）；
4. 从产物里**数出**它 import 到的外部包，写进 `package.json` 的 `peerDependencies`。

第 4 条不是形式主义：运行时的解析器是**按 peer 声明供给**的（上游 app-boot 的
`profile-resolution/resolver.ts`：「Linked importers apply current peer declarations at each
ancestor node_modules」——它读导入方自己 manifest 里的 peer 名单）。一个都不声明，插件在导入
阶段就死，表现是 fiber 直接变成 disposed，连一句有意义的错误都没有。

## 装

```
node install.mjs                 # 装进 ~/.dsh/profiles/desktop
node install.mjs --profile web   # 指定 profile
node install.mjs --check         # 只检查
node install.mjs --uninstall     # 摘掉
```

它做两件事：在 profile 的 `node_modules` 下挂一个指向本目录的符号链接；把 profile 的
`cordis.patch.yml` 里那条 agent-in-chrome 注册项的 `name` 换成我们（改前备份）。

**为什么用新名字而不是顶掉上游包名**：把本包命名成 `@deepseek-ai/dsh-mcp-client` 塞进
`node_modules` 能让配置一个字都不用改，但那会成一份**隐形的影子包**——DSH 升级后它继续跑旧代码，
而盘上没有任何东西看得出这件事。用自己名字的代价是这里得改一行，收益是配置里写着「这条走的是谁」。

### ⚠️ 改完必须重启 DSH

**实测（2026-10-12）**：DSH 对插件模块有缓存——改插件的代码、甚至改条目指向的包名，
都不会让新代码生效：

- Node 的 ESM 缓存按 URL 命中，同一个文件路径第二次导入拿到的是**旧模块对象**；
- 插件管理器 `set_plugin` 的启用/停用**只重新跑已导入模块的 `apply`**，不重新导入；
- desktop profile 的 `package.json` 里没有 `web` profile 那份 `patchReload: "live"`。

所以本机验证时「条目已激活、`moduleName` 也变了、却仍跑旧行为」是常态而不是异常。
**改动要生效只有两条路**：重启 DSH，或者给条目换一个全新的 `id`（新条目才会重新导入）。

### 和 agent-in-chrome 安装器的相互作用

agent-in-chrome 的 `scripts/install.mjs` 重建那条注册项时，会把 `name` 写回
`@deepseek-ai/dsh-mcp-client`——也就是把这一行覆盖掉。**2026-10-12 实测复现过一次**：
运行 `install.mjs --agents=deepseek-harness` 同步运行时时，配置那行当场被改了回去
（有意思的是跑着的客户端仍是补丁版——模块缓存没让它切走——但**下次重启就会静默退回内置版**）。

两条出路：

- 只想同步 agent-in-chrome 的运行时、不想动 agent 注册：加 `--no-agents`
  （`node scripts/install.mjs --no-agents --yes`），它跳过整个注册环节，配置一个字都不碰；
- 已经跑了全量注册：补一次 `node install.mjs` 即可恢复，`node install.mjs --check`
  会直接报出「被覆盖了」。

## 状态：已实测通过

DSH 重启后（2026-10-12，0.2.0-rc.2），线上帧里的 `rpcMeta` 实际长这样：

```json
{
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": {
    "name": "dsh-mcp-client", "title": "DeepSeek Harness", "version": "0.2.0-rc.2"
  },
  "io.modelcontextprotocol/clientCapabilities": {},
  "session_id": "session-4cc66452-c277-42ad-b234-8a28492100e8"
}
```

两处补丁都到了线上（`title` 之前是 null、版本是占位符 `0.0.1`）。服务端 MCP 侧的归属随之
从进程级切成对话级：

```
session        s81189-mv4zegzs   →   s81189-mv4zegzs::session-4cc66452-…
sessionOrigin  from:"fallback"   →   from:"_meta.session_id"
               caller: null       →   caller:"session-4cc66452-…"
```

合起来，这一轮对话在 MCP 服务端眼里的四段身份：

```json
{ "brand": "DeepSeek Harness", "surface": "app",
  "workspace": "onework-agent", "workspaceKind": "git",
  "session": "为 dsh 安装 agent in chrome MCP" }
```

其余已验证：产物从当前安装的 DSH 生成、语法通过、两处补丁就位（`sync.mjs --check` 通过）；
8 个 peer 从产物自动数出；包能被 profile 解析、条目 `fiberPhase: active`。

## 卸载

```
node install.mjs --uninstall     # 摘链接 + name 还原为上游
rm -rf ~/.dsh/profiles/desktop/node_modules/dsh-mcp-client-session-meta
```

`lib/index.js` 是 MIT 代码（@deepseek-ai/dsh-mcp-client）的派生，随包带上上游 LICENSE。
