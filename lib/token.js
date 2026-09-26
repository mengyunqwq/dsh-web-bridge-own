// lib/token.js — 配对密钥的唯一来源（插件与 bin/setup.mjs 共用同一份实现）
//
// 为什么单独一个文件：密钥在哪里、怎么生成，是"扩展连不上"这类问题最常见的根源。
// 三处各写一遍必然漂移，所以只留这一份，并且**不依赖 DSH 的任何包**，可以单独测试。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function defaultTokenPath() {
  return join(homedir(), '.dsh', 'web-bridge-own', 'token');
}

/**
 * 取得配对密钥。顺序：显式给定 → 文件里已有的 → 生成一份并写入文件（0600）。
 * @param {{token?:string, tokenPath?:string}} config
 * @param {(message:string)=>void} log
 */
export function loadToken(config = {}, log = () => {}) {
  const given = String(config.token || '');
  if (TOKEN_RE.test(given)) return given;
  if (given) log('配置里的 token 格式不对（应为 43 个 base64url 字符），改用密钥文件');
  const path = config.tokenPath || defaultTokenPath();
  try {
    const existing = readFileSync(path, 'utf8').trim();
    if (TOKEN_RE.test(existing)) return existing;
    log(`密钥文件里的内容格式不对 → 重新生成：${path}`);
  } catch { /* 首次运行，正常 */ }
  const fresh = randomBytes(32).toString('base64url');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, fresh + '\n', { mode: 0o600 });
  log(`已生成配对密钥 → ${path}`);
  return fresh;
}
