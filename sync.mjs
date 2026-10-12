#!/usr/bin/env node
// 从**已安装的 DeepSeek Harness** 重新生成 lib/index.js：把上游的 MCP 客户端桥接原样取出来，
// 只打两处补丁，别的字节一个都不动。
//
// 为什么是「提取 + 打补丁」而不是拷一份改好的文件：
//   上游仓库（deepseek-ai/deepseek-harness）明确不收外部 PR，而 app.asar 有 integrity 校验、
//   外层还有代码签名，改包里的文件既破坏签名、又会在每次更新时被覆盖。所以只能在这边持有一份
//   带补丁的副本；而副本一旦是「手改完就冻住」的，上游修 bug 时它就是个哑掉的旧版。
//   这个脚本让副本**随时可重生成**，并把「补丁锚点对不上」变成一次硬失败——上游改了那两处，
//   我们宁可生成不出来，也不能悄悄产出一个没打补丁的副本（那正是最难发现的一类假象）。
//
//   node sync.mjs            # 从默认安装位置重新生成
//   node sync.mjs --check    # 只比对：产物还是不是当前这个 DSH 生成的（更新后用来自检）
//   node sync.mjs --from /path/to/app.asar

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "lib", "index.js");
const PROVENANCE = path.join(HERE, "lib", "provenance.json");

/** 桌面端默认安装位置；--from 覆盖 */
const DEFAULT_ASAR = "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar";

/** 上游包在包内的路径（app.asar 里的顶层目录就叫 dsh） */
const PKG_DIR = "dsh/node_modules/@deepseek-ai/dsh-mcp-client";

const sha = (buf) => createHash("sha256").update(buf).digest("hex");

/**
 * 从 asar 里取出一个文件。asar 是 `16 字节头 + JSON 目录 + 数据段`：
 * 头里第 12 字节起是 JSON 目录的长度，目录之后**补到 4 字节边界**才是数据段
 * （少算这个补齐，读出来每条都整体前移 2 字节——文本还能 grep，JSON 直接解析不了）。
 * 目录项里的 offset 相对数据段起点。
 */
function readAsarFile(asarPath, innerPath) {
  const fd = fs.openSync(asarPath, "r");
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const headerSize = head.readUInt32LE(12);
    const headerBuf = Buffer.alloc(headerSize);
    fs.readSync(fd, headerBuf, 0, headerSize, 16);
    const tree = JSON.parse(headerBuf.toString("utf8").replace(/\0+$/, ""));
    const dataStart = Math.ceil((16 + headerSize) / 4) * 4;

    let node = tree;
    for (const part of innerPath.split("/").filter(Boolean)) {
      node = node?.files?.[part];
      if (!node) throw new Error(`asar 里没有 ${innerPath}`);
    }
    if (node.files) throw new Error(`${innerPath} 是目录`);
    const buf = Buffer.alloc(Number(node.size));
    fs.readSync(fd, buf, 0, Number(node.size), dataStart + Number(node.offset));
    return buf;
  } finally {
    fs.closeSync(fd);
  }
}

/** 应用版本：clientInfo 里报的版本号用它，跟打包版本同源 */
function appVersion(asarPath) {
  const plist = path.join(path.dirname(asarPath), "..", "Info.plist");
  try {
    const out = fs.readFileSync(plist, "utf8");
    const m = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(out);
    if (m) return m[1];
  } catch {}
  return null;
}

// ------------------------------------------------------------------ 两处补丁
//
// 都写成「锚点必须命中」的形式：找不到就抛，绝不静默放过。

/**
 * 补丁 1：clientInfo 带上品牌与真实版本。
 *
 * 上游硬编码 `{name:"dsh-mcp-client", version:"0.0.1"}`——name 是中间件自己的包名，
 * 跟「谁在开这一组标签页」毫无关系，version 是个占位符。MCP 握手的 clientInfo 是
 * **唯一一处客户端主动自报家门**的地方，报成机器串等于白报：下游只能退回猜父进程链。
 * 这里补上 title（协议里 BaseMetadataSchema 就是 `{name, title?}`，SDK 支持）和真实版本。
 */
function patchClientInfo(source, version) {
  const before = `\t\tconst generation = new Client({\n\t\t\tname: "dsh-mcp-client",\n\t\t\tversion: "0.0.1"\n\t\t}, {`;
  const after = `\t\tconst generation = new Client({\n\t\t\tname: "dsh-mcp-client",\n\t\t\ttitle: "DeepSeek Harness",\n\t\t\tversion: ${JSON.stringify(version)}\n\t\t}, {`;
  if (!source.includes(before)) throw new Error("补丁 1 锚点没命中：上游的 new Client({name,version}) 形状变了");
  return source.replace(before, after);
}

/**
 * 补丁 2：每次 tools/call 带上调用方会话身份。
 *
 * 上游把 `{name, arguments}` 当 params 直接发给 SDK（`client.callTool(params, …)` →
 * `request({method:"tools/call", params})`，params 原样上线）。而 MCP 的
 * `BaseRequestParamsSchema` 本来就带一个可选的 `_meta`——**协议级的归属通道是现成的，
 * 只是没被用**。
 *
 * `execution.agent` 是 agent loop 在派发工具时填的「这次调用代表哪个 Agent」，
 * `agent.id` 就是 SessionId。填进 `_meta.session_id` 之后，MCP server 侧第一次有了
 * 「这一段调用属于哪轮对话」的确定答案，不必再去猜。
 *
 * 没有 agent 的调用（pty 内的 PTC 子派发等）**不加这个键**，而不是加个 undefined：
 * 缺键是「这一帧不知道」，带上一个空值反而是在声称知道。
 */
function patchSessionMeta(source) {
  const before = `\t\t\tcall: (args, execution) => client.callTool({\n\t\t\t\tname: tool.name,\n\t\t\t\targuments: args\n\t\t\t}, {`;
  const after = `\t\t\tcall: (args, execution) => client.callTool(sessionCallParams(tool.name, args, execution), {`;
  if (!source.includes(before)) throw new Error("补丁 2 锚点没命中：上游的 callTool params 形状变了");
  return source.replace(before, after);
}

/** 补丁 2 的辅助函数，插在 import 块之后（函数声明会提升，位置只为可读） */
const HELPER = `
/**
 * tools/call 的 params：按需带上这一帧的调用方会话身份。
 *
 * 见 sync.mjs 里补丁 2 的说明——上游只发 {name, arguments}，而 MCP 的请求 params
 * 本来就有可选的 _meta，协议级的归属通道一直空着。
 *
 * 键名用裸的 \`session_id\`：这是 MCP 各客户端在这个字段上的既成交互形状
 * （ZCode 每帧都带它，别的服务端也照这个名字读），不是我们自造的名字。
 */
function sessionCallParams(name, args, execution) {
	const params = { name, arguments: args };
	const id = execution?.agent?.id;
	if (typeof id === "string" && id) params._meta = { session_id: id };
	return params;
}
`;

/** 插在最后一个顶层 import 之后 */
function insertHelper(source) {
  const lines = source.split("\n");
  let last = -1;
  for (let i = 0; i < lines.length; i++) if (/^import\s/.test(lines[i]) || /^import\{/.test(lines[i])) last = i;
  if (last < 0) throw new Error("找不到 import 块，辅助函数没处放");
  lines.splice(last + 1, 0, HELPER);
  return lines.join("\n");
}

const BANNER = (meta) =>
  `//! 本文件由 sync.mjs 生成，**不要手改**——改 sync.mjs 再重跑。\n` +
  `//!\n` +
  `//! 来源：${meta.asar}\n` +
  `//!       ${PKG_DIR}/lib/index.js（@deepseek-ai/dsh-mcp-client ${meta.pkgVersion}）\n` +
  `//! 补丁：clientInfo 补 title/真实版本；tools/call 的 params 带 _meta.session_id\n` +
  `//! 上游 sha256 ${meta.sourceSha}\n`;

/**
 * 产物里 import 到的**外部包名**（去掉 node: 内建、去掉相对路径、去掉子路径）。
 *
 * 这份清单必须写进 package.json 的 peerDependencies，一个都不能少：
 * 运行时的解析器是**按 peer 声明供给**的——上游 app-boot 的 profile-resolution/resolver.ts
 * 原话是 "Linked importers apply current peer declarations at each ancestor node_modules"，
 * 即它读**导入方自己 package.json 里声明的 peer 名单**，再在各级 node_modules 位置把安装自带的
 * 包摆上去。少声明一个，那一个就解析不到，插件在导入阶段就死（表现是 fiber 直接变成 disposed，
 * 连一句有意义的错误都没有）。所以这份名单从产物里数出来，不靠人记。
 *
 * 版本号：`@deepseek-ai/dsh-*` 用 `workspace:*`——上游兼容性预检把 workspace:^ / workspace:~ /
 * workspace:* 一律解释为「跟随当前运行时」，既不会随 DSH 升级失效，也不需要跟着改版本号。
 * 其余的（schemastery、MCP SDK）不是 dsh 包、不进那道预检，给 `*` 即可。
 */
function externalPackages(text) {
  const names = new Set();
  for (const m of text.matchAll(/\bfrom\s*"([^"]+)"|\bimport\s*\(\s*"([^"]+)"/g)) {
    const spec = m[1] || m[2];
    if (!spec || spec.startsWith("node:") || spec.startsWith(".")) continue;
    const parts = spec.split("/");
    names.add(spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]);
  }
  return [...names].sort();
}

// ------------------------------------------------------------------ 主流程

function generate(asarPath) {
  const pkgJson = JSON.parse(readAsarFile(asarPath, `${PKG_DIR}/package.json`).toString("utf8"));
  const upstream = readAsarFile(asarPath, `${PKG_DIR}/lib/index.js`).toString("utf8");
  const sourceSha = sha(Buffer.from(upstream));

  const version = appVersion(asarPath) || pkgJson.version;
  let out = patchClientInfo(upstream, version);
  out = patchSessionMeta(out);
  out = insertHelper(out);

  const meta = { asar: asarPath, pkgVersion: pkgJson.version, appVersion: version, sourceSha, at: new Date().toISOString() };
  const text = BANNER(meta) + out;
  return { text, meta, upstreamSha: sourceSha, peers: externalPackages(out) };
}

/**
 * 把算出来的依赖清单落进 package.json 的 peerDependencies：**运行时靠它决定供给哪些包**，
 * 所以它和 lib/index.js 是同一次生成的两个产物，必须一起更新（见 externalPackages 的说明）。
 */
function writePeers(peers) {
  const file = path.join(HERE, "package.json");
  const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
  const declared = {};
  for (const name of peers) declared[name] = name.startsWith("@deepseek-ai/dsh-") ? "workspace:*" : "*";
  const same =
    JSON.stringify(Object.keys(pkg.peerDependencies || {}).sort()) === JSON.stringify(Object.keys(declared).sort()) &&
    Object.entries(declared).every(([k, v]) => (pkg.peerDependencies || {})[k] === v);
  if (same) return false;
  pkg.peerDependencies = declared;
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
  return true;
}

function write(text, meta, peers) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, text);
  fs.writeFileSync(PROVENANCE, JSON.stringify(meta, null, 2) + "\n");
  // 上游 LICENSE 一并带上：这份产物是 MIT 代码的派生，署名不能丢
  try {
    fs.writeFileSync(path.join(HERE, "LICENSE"), readAsarFile(meta.asar, `${PKG_DIR}/LICENSE`));
  } catch {}
  return writePeers(peers);
}

function main() {
  const argv = process.argv.slice(2);
  const fromArg = argv.indexOf("--from");
  const asarPath = fromArg >= 0 ? argv[fromArg + 1] : DEFAULT_ASAR;
  const check = argv.includes("--check");

  if (!fs.existsSync(asarPath)) {
    console.error(`✗ 找不到 ${asarPath}（用 --from 指定 app.asar）`);
    process.exit(1);
  }

  const { text, meta, peers } = generate(asarPath);

  if (check) {
    let prev = null;
    try {
      prev = JSON.parse(fs.readFileSync(PROVENANCE, "utf8"));
    } catch {}
    if (!prev) {
      console.error("✗ 还没生成过（lib/provenance.json 不存在），跑 node sync.mjs");
      process.exit(1);
    }
    if (prev.sourceSha !== meta.sourceSha) {
      console.error(
        `✗ 上游变了：产物是按 ${prev.pkgVersion} 生成的，现在装的是 ${meta.pkgVersion}\n` +
          `  跑 node sync.mjs 重新生成（补丁锚点若已失效它会直接报出来）`
      );
      process.exit(1);
    }
    if (!fs.existsSync(OUT) || sha(fs.readFileSync(OUT)) !== sha(Buffer.from(text))) {
      console.error("✗ lib/index.js 与 provenance 对不上（被手改过？），跑 node sync.mjs 重新生成");
      process.exit(1);
    }
    console.log(`✓ 与当前安装的 DSH ${meta.pkgVersion} 一致`);
    return;
  }

  const peersChanged = write(text, meta, peers);
  console.log(`✓ 生成 lib/index.js`);
  console.log(`  来源   ${asarPath}`);
  console.log(`  上游   @deepseek-ai/dsh-mcp-client ${meta.pkgVersion}（sha256 ${meta.sourceSha.slice(0, 16)}…）`);
  console.log(`  补丁   clientInfo title/version + tools/call 的 _meta.session_id`);
  console.log(`  依赖   ${peers.length} 个 peer（运行时按这份名单供给）${peersChanged ? "，package.json 已更新" : ""}`);
  for (const p of peers) console.log(`         ${p}`);
}

main();
