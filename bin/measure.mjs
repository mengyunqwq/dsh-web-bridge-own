#!/usr/bin/env node
// bin/measure.mjs — 量一轮真实端到端：本机 → broker → 浏览器扩展 → DeepSeek 网页 → 回来
//
// 用法：
//   node bin/measure.mjs                       # 文本问答（默认 http://127.0.0.1:3081）
//   node bin/measure.mjs --port 3099
//   node bin/measure.mjs --tools               # 额外跑一轮"工具调用"，验证 tool_calls 解析
//   node bin/measure.mjs --prompt "随便问点什么"
//
// 输出：每个阶段（progress）的到达时间、总耗时、排队/执行分解、解析结果，以及与基线的对比。
// 基线说明：换成这个自研实现之前，实测单轮中位 9.7 秒，其中约 5 秒纯粹是等"答复 5 秒不变"。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { buildTask, parseReply, schemasOf } from '../lib/protocol.js';
import { loadToken } from '../lib/token.js';

const args = process.argv.slice(2);
const value = (name, fallback = undefined) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : fallback; };
const port = Number(value('port', process.env.DSH_WEB_BRIDGE_PORT || 3081));
const BASE = `http://127.0.0.1:${port}`;
const token = loadToken({ tokenPath: value('token-path', undefined) }, () => {});
const BASELINE_MS = 9700;

async function status() {
  try { return await (await fetch(BASE + '/status', { signal: AbortSignal.timeout(4000) })).json(); }
  catch (error) { return { error: error.message }; }
}

async function runOnce({ label, prompt, tools = [], timeoutMs = 120_000, nudge = '', quiet = false }) {
  const built = buildTask({ messages: [{ role: 'user', content: prompt }], tools, requestId: undefined, nudge });
  const started = Date.now();
  const marks = [];
  const res = await fetch(BASE + '/task', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify({ prompt: built.prompt, timeoutMs }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}：${(await res.text()).slice(0, 200)}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let result = null;
  for (;;) {
    const { value: chunk, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(chunk, { stream: true });
    let at;
    while ((at = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, at).trim();
      buf = buf.slice(at + 1);
      if (!line) continue;
      let event; try { event = JSON.parse(line); } catch { continue; }
      if (event.type === 'progress') { marks.push({ at: Date.now() - started, phase: event.phase }); if (!quiet) console.log(`    +${String(Date.now() - started).padStart(6)}ms  ${event.phase}`); }
      else if (event.type === 'result') result = event;
    }
  }
  if (!result) throw new Error('没有收到结果行');
  const total = Date.now() - started;
  console.log(`  ${label}：${result.ok ? '成功' : '失败'}　总耗时 ${total}ms` +
    (result.queuedMs !== null && result.queuedMs !== undefined ? `（排队 ${result.queuedMs}ms + 执行 ${result.executedMs}ms）` : ''));
  if (!result.ok) { console.log(`    错误：${result.error}${result.code ? '  [' + result.code + ']' : ''}`); return { result, total, marks }; }

  // 解析失败不再让工具直接崩：打印可读原因，把判断留给调用方（例如缺参数时带提醒重试一次）
  let reply;
  try {
    reply = parseReply(result.text, { id: built.id, schemas: schemasOf(tools) });
  } catch (error) {
    console.log(`    解析失败：${error.message}  [${error.code || '未知'}]`);
    return { result, parseError: error, total, marks };
  }
  if (reply.kind === 'final') {
    console.log(`    解析：final　${(reply.text || '').replace(/\s+/g, ' ').slice(0, 80)}`);
  } else {
    console.log(`    解析：tool_calls　${reply.calls.map((c) => c.name + '(' + c.arguments + ')').join(' ')}`);
  }
  for (const w of reply.warnings || []) console.log('    提示：' + w);
  return { result, reply, total, marks };
}

console.log(`=== 自研桥接真机量测（${BASE}）===`);
const s = await status();
if (s.error) { console.log(`  ✗ 读 /status 失败：${s.error}\n    服务没起来？在仓库根目录跑：npm start（或本目录的 node 脚本起 broker）`); process.exit(1); }
console.log(`  本机 broker：${s.mode === 'own' ? '自研' : '(未知实现)'}　扩展${s.connected ? '已连接' : '**未连接**'}　worker=${s.workerVersion ?? '—'}　排队=${s.queued}`);
if (!s.connected) {
  console.log('  ⚠ 扩展没连上：先在浏览器里「加载已解压的扩展程序」指向 chrome/（npm run setup 生成），');
  console.log('    并确认该浏览器已登录 https://chat.deepseek.com，然后再跑一次本工具。');
}

const text = value('prompt', '请回复一句中文问候，并按输出契约只用 JSON。');
console.log(`\n--- 场景 1：文本问答 ---`);
console.log(`  提问：${text}`);
const r1 = await runOnce({ label: '文本问答', prompt: text });
if (r1.result?.ok) {
  const delta = BASELINE_MS - r1.total;
  console.log(`  对比基线：${BASELINE_MS}ms → ${r1.total}ms　${delta >= 0 ? '快' : '慢'} ${Math.abs(delta)}ms` +
    (delta > 0 ? `（预期主要来自不再固定等 5 秒）` : ''));
}

if (args.includes('--tools')) {
  console.log(`\n--- 场景 2：工具调用（验证 tool_calls 解析与参数）---`);
  const tools = [{
    type: 'function',
    function: {
      name: 'get_weather', description: '查询某城市天气',
      parameters: { type: 'object', properties: { city: { type: 'string', description: '城市名' } }, required: ['city'], additionalProperties: false },
    },
  }];
  const first = await runOnce({ label: '工具调用', prompt: '请调用 get_weather 工具查询「北京」的天气，不要直接回答天气。', tools });
  // 镜像产品行为：缺必需参数属于"模型没按契约输出"，可安全重试一次，并带上提醒。
  // （网页侧失败绝不重试——那会让用户账号里出现两条一样的提问。）
  if (first.parseError?.code === 'WEB_TOOL_MISSING_ARGS') {
    console.log('  → 缺必需参数：按产品行为带提醒重试一次（网页侧失败不会重试）');
    await runOnce({
      label: '工具调用（重试）',
      prompt: '请调用 get_weather 工具查询「北京」的天气，不要直接回答天气。',
      tools,
      nudge: '上一轮你的工具调用缺少必需参数。这次请把 parameters 里 required 列出的字段全部填上，不要交空对象。',
    });
  }
}

console.log('\n完成。');
