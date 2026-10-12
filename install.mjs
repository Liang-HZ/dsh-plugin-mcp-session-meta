#!/usr/bin/env node
// 把这份带补丁的 MCP 客户端装进某个 DeepSeek Harness profile。
//
// 做两件事，都是幂等的：
//   1. 在 profile 的 node_modules 下挂一个指向本目录的符号链接（profile 的 node_modules
//      是加载器的第一锚点：pnpm 管的条目先于安装自带的解析）。
//   2. 把 profile 的 cordis.patch.yml 里那条 agent-in-chrome 注册项的 name 换成我们。
//
// **为什么要换 name 而不是顶掉上游的包名**：挂在别人的包名上（把本包命名成
// `@deepseek-ai/dsh-mcp-client` 塞进 node_modules）能让配置一个字都不用改，但那就成了一份
// 隐形的影子包——DSH 升级后它继续跑旧代码，而盘上没有任何东西看得出这件事。用一个自己的
// 名字，配置里就写着「这条走的是谁」，代价是这里得改一行。
//
// **已知交互**：agent-in-chrome 的安装器（scripts/install.mjs）重建那条注册项时会把
// name 写回 `@deepseek-ai/dsh-mcp-client`——也就是把这一行覆盖掉。那之后跑一次
// `node install.mjs` 即可恢复；`node install.mjs --check` 会直接报出「被覆盖了」。
//
//   node install.mjs                    # 装进 ~/.dsh/profiles/desktop
//   node install.mjs --profile web      # 指定 profile
//   node install.mjs --check            # 只检查，不写盘
//   node install.mjs --uninstall        # 摘掉（只摘我们写的那两处）

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = fs.realpathSync(path.dirname(fileURLToPath(import.meta.url)));
const PKG = JSON.parse(fs.readFileSync(path.join(HERE, "package.json"), "utf8"));
const NAME = PKG.name;

/** 这条注册项在配置里的标识（agent-in-chrome 安装器写的那个） */
const SERVER_NAME = "agent-in-chrome";
const ENTRY_ID = "mcp-agent-in-chrome";

const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => console.log(`  \x1b[31m✗\x1b[0m ${m}`);
const warn = (m) => console.log(`  \x1b[33m!\x1b[0m ${m}`);

function profileDir(home, name) {
  return path.join(home, ".dsh", "profiles", name);
}

/** 顶层列表项的行范围（与 agent-in-chrome 安装器同一套形状判据） */
function itemRanges(lines) {
  const heads = [];
  for (let i = 0; i < lines.length; i++) if (/^- /.test(lines[i]) || /^-$/.test(lines[i])) heads.push(i);
  return heads.map((h, k) => ({ start: h, end: k + 1 < heads.length ? heads[k + 1] : lines.length, head: h }));
}

/** 这一项是不是那条 agent-in-chrome 注册（认 serverName，或认条目 id） */
function isOurEntry(text) {
  return (
    new RegExp(`serverName:\\s*['"]?${SERVER_NAME}['"]?\\s*$`, "m").test(text) ||
    new RegExp(`-\\s+id:\\s*['"]?${ENTRY_ID}['"]?\\s*$`, "m").test(text)
  );
}

function readPatch(file) {
  return fs.readFileSync(file, "utf8").split("\n");
}

/** 找到那条注册项并返回 { start, end, head, nameLine } */
function findEntry(lines) {
  for (const r of itemRanges(lines)) {
    const text = lines.slice(r.start, r.end).join("\n");
    if (!isOurEntry(text)) continue;
    for (let i = r.head; i < r.end; i++) {
      if (/^\s+name:\s/.test(lines[i])) return { ...r, nameLine: i };
    }
    return { ...r, nameLine: null };
  }
  return null;
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

  // ---- 2. 配置里的 name
  if (!fs.existsSync(patch)) {
    bad(`找不到 ${patch}（agent-in-chrome 还没注册到这个 profile？）`);
    process.exit(1);
  }
  const lines = readPatch(patch);
  const entry = findEntry(lines);
  if (!entry) {
    bad(`${path.basename(patch)} 里没有 serverName: ${SERVER_NAME} 的注册项——先装 agent-in-chrome`);
    process.exit(1);
  }
  const cur = entry.nameLine === null ? null : lines[entry.nameLine].replace(/^\s+name:\s*/, "").trim();

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
