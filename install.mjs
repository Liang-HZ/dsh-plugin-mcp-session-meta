#!/usr/bin/env node
// 把这份带补丁的 MCP 客户端装进某个 DeepSeek Harness profile。
//
// 做两件事，都是幂等的：
//   1. 在 profile 的 node_modules 下挂一个指向本目录的符号链接（profile 的 node_modules
//      是加载器的第一锚点：pnpm 管的条目先于安装自带的解析）。
//   2. 把 profile 的 cordis.patch.yml 里**那一条** MCP 客户端注册项的 name 换成我们。
//
// **为什么要换 name 而不是顶掉上游的包名**：挂在别人的包名上（把本包命名成
// `@deepseek-ai/dsh-mcp-client` 塞进 node_modules）能让配置一个字都不用改，但那就成了一份
// 隐形的影子包——DSH 升级后它继续跑旧代码，而盘上没有任何东西看得出这件事。用一个自己的
// 名字，配置里就写着「这条走的是谁」，代价是这里得改一行。
//
// **只改你指定的那一条**：一个 profile 里可能挂着十几个 MCP server，谁走补丁是你的选择。
// 不写 serverName 时只有一条才敢动，多条会先列出来让你用 `--server` 点名。
//
//   node install.mjs --list                 # 先看看有哪些注册项、各指向什么
//   node install.mjs                        # 装（只有一条注册项时）
//   node install.mjs --server my-browser    # 装（多条时点名）
//   node install.mjs --profile web          # 指定 profile，默认 desktop
//   node install.mjs --check                # 只检查，不写盘
//   node install.mjs --uninstall            # 摘掉（只摘我们写的那两处）
//
// **已知交互**：如果那条注册项是别人的安装器写的（比如 agent-in-chrome 的
// scripts/install.mjs），对方重建它时会把 name 写回 `@deepseek-ai/dsh-mcp-client`——
// 也就是把这一行覆盖掉。那之后重跑一次本脚本即可恢复，`--check` 会直接报出来。
// 想避免这个来回：同步运行时加 `--no-agents` 跳过整个注册环节。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = fs.realpathSync(path.dirname(fileURLToPath(import.meta.url)));
const PKG = JSON.parse(fs.readFileSync(path.join(HERE, "package.json"), "utf8"));
const NAME = PKG.name;

/*
 * 本包替换的是**某一条** MCP 客户端注册项，不是全部。一个 profile 里可能挂着十几个
 * server（浏览器、数据库、文件系统……），谁走补丁是用户自己的选择，所以这里不写死任何
 * serverName：注册项的判据是**模块名**（模块名里带 `dsh-mcp-client`），要改哪一条用
 * `--server <serverName>` 指定；不指定时只有一条才敢动。
 */

const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => console.log(`  \x1b[31m✗\x1b[0m ${m}`);

function profileDir(home, name) {
  return path.join(home, ".dsh", "profiles", name);
}

/** 顶层列表项的行范围（与 agent-in-chrome 安装器同一套形状判据） */
function itemRanges(lines) {
  const heads = [];
  for (let i = 0; i < lines.length; i++) if (/^- /.test(lines[i]) || /^-$/.test(lines[i])) heads.push(i);
  return heads.map((h, k) => ({ start: h, end: k + 1 < heads.length ? heads[k + 1] : lines.length, head: h }));
}

/** 从一项里读出这条注册：条目 id、模块名、config 里的 serverName。读不出模块名就不是我们管得着的 */
function entryInfo(text) {
  const grab = (re) => re.exec(text)?.[1] ?? null;
  return {
    id: grab(/^\s+-\s+id:\s*['"]?([\w.@/-]+)['"]?\s*$/m),
    module: grab(/^\s+name:\s*['"]?([\w.@/-]+)['"]?\s*$/m),
    serverName: grab(/^\s+serverName:\s*['"]?([\w.-]+)['"]?\s*$/m),
  };
}

/**
 * profile 里所有 **MCP 客户端桥**注册项。判据是模块名，不是 serverName：
 * 谁注册进来的、那个 server 叫什么，跟本包无关——用户可能装了十几个。
 */
function mcpEntries(lines) {
  const out = [];
  for (const r of itemRanges(lines)) {
    const info = entryInfo(lines.slice(r.start, r.end).join("\n"));
    if (!info.module || !/dsh-mcp-client/.test(info.module)) continue;
    let nameLine = null;
    for (let i = r.head; i < r.end; i++) {
      if (/^\s+name:\s/.test(lines[i])) {
        nameLine = i;
        break;
      }
    }
    out.push({ ...r, ...info, nameLine });
  }
  return out;
}

function readPatch(file) {
  return fs.readFileSync(file, "utf8").split("\n");
}

/** 这条注册现在指向哪个模块（去掉 YAML 的引号，好读也好比） */
function moduleOf(entry, lines) {
  if (entry.nameLine === null) return null;
  return (
    lines[entry.nameLine]
      .replace(/^\s+name:\s*/, "")
      .trim()
      .replace(/^['"]|['"]$/g, "")
  );
}

/** 把候选全列出来——用 --server 指哪一条之前，得先让人看见有哪些 */
function printEntries(entries, lines) {
  console.log("  这个 profile 里的 MCP 客户端注册项：\n");
  for (const e of entries) {
    const cur = moduleOf(e, lines);
    console.log(`    serverName  ${e.serverName ?? "（没有这一行）"}`);
    console.log(`      条目 id   ${e.id ?? "（没有）"}`);
    console.log(`      模块      ${cur ?? "（没有 name 行）"}${cur && cur.includes(NAME) ? "   ← 本包" : ""}`);
  }
  console.log("");
}

function backup(file) {
  const stamp = new Date().toISOString().replace(/[-:.]/g, "").replace("Z", "Z");
  const dest = `${file}.bak-${stamp}`;
  fs.copyFileSync(file, dest);
  return path.basename(dest);
}

const QUOTED = `'${NAME}'`;

function linkPath(dir) {
  return path.join(dir, "node_modules", NAME);
}

function ensureLink(dir) {
  const link = linkPath(dir);
  fs.mkdirSync(path.dirname(link), { recursive: true });
  let cur = null;
  try {
    cur = fs.readlinkSync(link);
  } catch {}
  if (cur === HERE) return "已就位";
  if (cur) {
    fs.unlinkSync(link);
    fs.symlinkSync(HERE, link, "dir");
    return `改指向 ${cur} → ${HERE}`;
  }
  if (fs.existsSync(link)) {
    // 真目录（不是链接）：不动它，让人自己看
    throw new Error(`${link} 是个真目录而不是链接，没敢覆盖`);
  }
  fs.symlinkSync(HERE, link, "dir");
  return "新建链接";
}

function main() {
  const argv = process.argv.slice(2);
  const home = os.homedir();
  const pIdx = argv.indexOf("--profile");
  const profileName = pIdx >= 0 ? argv[pIdx + 1] : "desktop";
  const check = argv.includes("--check");
  const uninstall = argv.includes("--uninstall");
  const list = argv.includes("--list");
  const sIdx = argv.indexOf("--server");
  const want = sIdx >= 0 ? argv[sIdx + 1] : null;

  const dir = profileDir(home, profileName);
  const patch = path.join(dir, "cordis.patch.yml");
  console.log(`\n\x1b[1m${NAME} → DSH profile「${profileName}」\x1b[0m`);
  console.log(`  profile  ${dir}\n`);

  if (!fs.existsSync(path.join(dir, "package.json"))) {
    bad(`不是 profile（没有 package.json）: ${dir}`);
    process.exit(1);
  }

  // ---- 1. node_modules 链接
  const link = linkPath(dir);
  if (uninstall) {
    try {
      if (fs.lstatSync(link).isSymbolicLink()) {
        fs.unlinkSync(link);
        ok(`已摘掉链接 ${link}`);
      }
    } catch {}
  } else if (check) {
    let cur = null;
    try {
      cur = fs.readlinkSync(link);
    } catch {}
    if (cur === HERE) ok(`链接就位 ${link}`);
    else bad(`链接不对：${link} → ${cur === null ? "（不存在）" : cur}`);
  } else {
    ok(`链接 ${ensureLink(dir)}`);
  }

  // ---- 2. 配置里那一条的模块名
  if (!fs.existsSync(patch)) {
    bad(`找不到 ${patch}——这个 profile 还没注册过 MCP server？`);
    process.exit(1);
  }
  const lines = readPatch(patch);
  const entries = mcpEntries(lines);
  if (!entries.length) {
    bad(`${path.basename(patch)} 里没有 MCP 客户端注册项（模块名里带 dsh-mcp-client 的那些）`);
    process.exit(1);
  }
  if (list) {
    printEntries(entries, lines);
    return;
  }
  if (!want && entries.length > 1) {
    printEntries(entries, lines);
    bad("有多条，用 --server <serverName> 指定要接哪一条");
    process.exit(1);
  }
  const entry = want ? (entries.find((e) => e.serverName === want) ?? null) : entries[0];
  if (!entry) {
    printEntries(entries, lines);
    bad(`没有 serverName 为 ${want} 的注册项`);
    process.exit(1);
  }
  const cur = moduleOf(entry, lines);

  if (uninstall) {
    if (cur && cur.includes(NAME)) {
      const bak = backup(patch);
      lines[entry.nameLine] = `      name: '@deepseek-ai/dsh-mcp-client'`;
      fs.writeFileSync(patch, lines.join("\n"));
      ok(`name 已还原为上游（备份 ${bak}）`);
    } else {
      ok("name 本来就是上游的，没动");
    }
    return;
  }

  if (cur && cur.includes(NAME)) {
    ok(`配置已指向本包（${path.basename(patch)} 第 ${entry.nameLine + 1} 行）`);
  } else if (check) {
    bad(`配置指向 ${cur ?? "（没找到 name 行）"}——跑 node install.mjs 接上`);
  } else {
    const bak = backup(patch);
    if (entry.nameLine === null) {
      lines.splice(entry.head + 1, 0, `      name: ${QUOTED}`);
    } else {
      lines[entry.nameLine] = `      name: ${QUOTED}`;
    }
    fs.writeFileSync(patch, lines.join("\n"));
    ok(`配置已指向本包（${cur ?? "（无）"} → ${NAME}，备份 ${bak}）`);
  }

  // ---- 3. 上游漂移：产物还是不是当前这个 DSH 生成的
  if (check) {
    const r = spawnSync(process.execPath, [path.join(HERE, "sync.mjs"), "--check"], { encoding: "utf8" });
    process.stdout.write(r.stdout || "");
    process.stderr.write(r.stderr || "");
    if (r.status !== 0) process.exitCode = 1;
  }
}

main();
