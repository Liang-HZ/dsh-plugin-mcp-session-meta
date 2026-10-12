# dsh-plugin-mcp-session-meta

让 **DeepSeek Harness** 告诉 MCP server：**这一帧是哪一段对话在调**。

DSH 发出的每一次 `tools/call`，都会带上发起调用的那个 Agent 的 session id：
`params._meta.session_id`。这是 MCP server 维持「按对话隔离」所需的那一条信息，
也正是 DSH 目前空着的那一条。

> English documentation: [README.md](README.md)。
> 这是**非官方社区插件**，与 DeepSeek 无隶属或背书关系。

## 为什么

DSH 的 MCP 客户端把 `{ name, arguments }` 原样当作请求参数发出去，`_meta` 一直空着：

```js
call: (args, execution) => client.callTool({ name: tool.name, arguments: args }, { … })
```

而 `_meta` 是 MCP 协议里 `BaseRequestParamsSchema` 的一等可选字段：

```js
const BaseRequestParamsSchema = z.object({ _meta: RequestMetaSchema.optional() })
```

于是服务端只能看到**这个进程**，看不到**这一轮对话**。对于状态按对话划分的服务端——
按标签页分组的浏览器自动化、编辑器、任何带会话的东西——harness 里所有对话只能共用
一个桶，服务端无从区分。

其它 MCP 客户端早就发了：ZCode 发 `session_id`、Antigravity 发
`antigravity.google/conversation_id`、Codex 发 `thread_id`、WorkBuddy 发
`workbuddy.ai/conversationId`。**DSH 是落单的那一个。**

身份其实就摆在调用点上——agent loop 会填 `ToolExecutionInput.agent`（注释原话
"The agent on whose behalf the call runs"），`agent.id` **就是** SessionId。
差的是把它递下去。

## 改了什么

两处补丁，都在派生出来的产物里：

| 补丁 | 之前 | 之后 |
|---|---|---|
| `clientInfo` | `{ name: "dsh-mcp-client", version: "0.0.1" }`——中间件自报的机器串，版本还是占位符 | `{ name, title: "DeepSeek Harness", version: "<真实版本>" }` |
| `tools/call` 的参数 | `{ name, arguments }` | `{ name, arguments, _meta: { session_id: <agent.id> } }` |

execution 上没有 Agent 时（嵌套派发）**整个 `_meta` 都不带**——缺键是「这一帧不知道」，
和声称自己属于某段会话是两回事。

## 装

产物必须按**你自己装的**那版 DSH 重新生成：补丁打在 DeepSeek 的**编译产物**上，
而那份产物每个版本都不一样。

```bash
git clone https://github.com/Liang-HZ/dsh-plugin-mcp-session-meta
cd dsh-plugin-mcp-session-meta

node sync.mjs                  # 从你的 app.asar 提取 + 打补丁（锚点对不上会硬失败）
node install.mjs --list        # 列出你 profile 里的 MCP 注册项
node install.mjs --server NAME # 把其中一条指向本包
```

然后**重启 DSH**——理由见下面的「缓存」。

- `--profile web` —— 指定别的 profile（默认 `desktop`）
- `--check` —— 只看，不写盘
- `--uninstall` —— 把那条注册项还原成上游包

**只会切换你点名的那一条**，别的 MCP server 照旧用上游客户端，harness 里别的东西
一个都不动。

### ⚠️ 改完必须重启 DSH

DSH 对插件模块有缓存。改插件的代码、甚至改条目指向的包名，**都不会让新代码生效**：

- Node 的 ESM 缓存按 URL 命中，同一个文件路径第二次导入拿到的是**旧模块对象**；
- 插件管理器 `set_plugin` 的启用/停用**只重新跑已导入模块的 `apply`**，不重新导入；
- `patchReload: "live"` 是**每个 profile 自己的设置**，出厂那个 `web` profile 有，
  没有这一项的 profile 不会热加载 patch 改动。

所以「条目已激活、`moduleName` 也变了、却仍跑旧行为」是常态而不是异常。
**改动要生效只有两条路**：重启 DSH，或者给条目换一个全新的 `id`（新条目才会重新导入）。

## 兼容性

- 针对 `@deepseek-ai/dsh-mcp-client` **0.2.0-rc.2**（DeepSeek Harness 0.2.0-rc.2，macOS）
  实测通过。
- `sync.mjs` 对两处锚点都有断言。DSH 升级把它们挪走时它会**硬失败**，而不是产出一个
  没打补丁的副本——后者是这里最坏的结果：插件照样加载，只是从此什么都不做。
- Node ≥ 22.15（提取用到 `zlib.zstdDecompressSync`）。

## 它是怎么来的（以及为什么不直接 fork 一份）

DeepSeek 的 harness 仓库**不收外部 PR**；而 app 包有代码签名和逐文件 integrity 校验——
改 `app.asar` 里的文件既破坏签名，又会在每次更新时被覆盖。

所以产物是**提取 + 打补丁 + 可重生成**，不是一份改完就冻住的拷贝：

```bash
node sync.mjs          # 从已安装的 DSH 重新生成 lib/index.js
node sync.mjs --check  # 产物还是不是当前这个 DSH 会生成的那一份
```

`sync.mjs` 还会把产物 import 到的外部包读出来写进 `peerDependencies`。这不是记账：
DSH 的解析器是**按 peer 声明供给**包的（上游 app-boot 的 `profile-resolution/resolver.ts`：
「Linked importers apply current peer declarations at each ancestor node_modules」——它读导入方
自己 manifest 里的 peer 名单）。少声明一个，那一个就解析不到，插件在导入阶段就死，
表现是 fiber 直接变成 disposed、连一句有意义的错误都没有。从产物里数出来，就不会漂。

## 给其它 DSH 插件作者的两条

两条都是花过时间才发现的：

1. **你 import 的每个包都要声明成 `peerDependency`。** `@deepseek-ai/dsh-app-boot` 的解析器
   读的是**导入方自己的 manifest**，据此决定供给哪些包。漏一个，fiber 会变成 `DISPOSED`，
   报错只有一句 `fiber state 4`，没有任何说明。
2. **`patchReload: "live"` 是 profile 设置。** 出厂的 `web` profile 有；没有这一项的
   profile 不会热加载 patch 改动，必须重启。

## 什么时候可以删掉它

等 DSH 自己把 session id 透传下来。上游那处改动很小——身份本来就在调用点的作用域里——
本插件只是为了在这之前把缺口补上。

## 许可

MIT。派生的 `lib/index.js` 是
[`@deepseek-ai/dsh-mcp-client`](https://www.npmjs.com/package/@deepseek-ai/dsh-mcp-client)
（MIT，© DeepSeek）的补丁构建，见 [NOTICE](NOTICE)。
