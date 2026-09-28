#!/usr/bin/env node
// bin/setup.mjs — 铺好扩展目录并生成/复用配对密钥
//
// 做的事（都很小，但要一次说清，否则用户会卡在"扩展连不上"）：
//   ① 取出（或生成）配对密钥：优先 --token，其次 ~/.dsh/web-bridge-own/token；
//   ② 把 extension/ 铺到 chrome/，并写 local-config.json（扩展据此与本机 broker 认证）；
//     local-config.json 里同时写 token 与 base（broker 的地址）——**端口可配**，
//     扩展不再永远指 3081：改端口只要 setup --port <n> 重跑一次 + 重载扩展即可。
//   ③ 铺目录前清空 chrome/（保留 local-config.json）：扩展增删文件后不会留下旧残骸，
//     manifest 与实际文件列表永远一致；
//   ④ 打印接下来要人工做的两步：加载扩展、登录网页。

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadToken, defaultTokenPath, TOKEN_RE } from '../lib/token.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXT_SRC = join(ROOT, 'extension');
const CHROME_DIR = join(ROOT, 'chrome');
const args = process.argv.slice(2);
const value = (name) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : undefined; };

function die(message) { console.error('\n✗ ' + message + '\n'); process.exit(1); }

function token() {
  const given = value('token');
  if (given && !TOKEN_RE.test(given)) die('--token 格式不对（应为 43 个 base64url 字符）');
  const t = loadToken({ token: given, tokenPath: value('token-path') }, (m) => console.log('  ✓ ' + m));
  return t;
}

function port() {
  const raw = value('port');
  if (raw === undefined) return 3081;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) die('--port 必须是 1~65535 的整数（当前：' + raw + '）');
  return n;
}

if (!existsSync(join(EXT_SRC, 'manifest.json'))) die('找不到 extension/manifest.json');
const pairToken = token();
const bridgePort = port();
const base = `http://127.0.0.1:${bridgePort}`;

mkdirSync(CHROME_DIR, { recursive: true });
// 铺新文件前先清掉旧目录内容（local-config.json 最后单独重写）：
// 扩展改名/删文件后，这里不会残留没用的旧文件，避免"manifest 与目录不一致"。
for (const f of readdirSync(CHROME_DIR)) {
  if (f === 'local-config.json') continue;
  rmSync(join(CHROME_DIR, f), { recursive: true, force: true });
}
const files = readdirSync(EXT_SRC).filter((f) => f !== 'local-config.json');
for (const f of files) copyFileSync(join(EXT_SRC, f), join(CHROME_DIR, f));
writeFileSync(
  join(CHROME_DIR, 'local-config.json'),
  JSON.stringify({ token: pairToken, base }, null, 2) + '\n',
  { mode: 0o600 },
);

console.log(`  ✓ 扩展目录已就绪（${files.length} 个文件）→ ${CHROME_DIR}`);
console.log(`  ✓ 本机桥接地址：${base}（DSH 插件配置里的 port 需与它一致，当前：${bridgePort}）`);
if (args.includes('--print-token')) console.log('  配对密钥: ' + pairToken);

console.log(`
接下来两步（只能人工做，Chromium 不允许脚本代替）：

  1) 浏览器打开  edge://extensions  或  chrome://extensions
     打开「开发者模式」，点「加载已解压的扩展程序」，选择：
       ${CHROME_DIR}
     （已加载过的话，改完 token/base 后点一下「重新加载」即可）

  2) 在该浏览器里打开并登录  https://chat.deepseek.com
     （扩展只负责把提示词提交到网页、把答复原文带回来；登录状态始终在你自己浏览器里）

如果你是通过 DSH 插件方式使用，另需在 DSH 里启用本插件（见 README「装进 DSH」）：
  插件 id: deepseek-web-bridge-own      provider: deepseek-web      端口: ${bridgePort}
  ⚠ 上游插件 dsh-web-bridge 与本插件不能同时启用（provider 与端口都相同）。
`);
