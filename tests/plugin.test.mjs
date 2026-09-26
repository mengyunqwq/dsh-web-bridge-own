// 插件专属逻辑测试：DSH 流式分片、工具 schema 提取、配对密钥、broker 的进程内接口（含面板取消）
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBroker } from '../lib/broker.js';
import { replyChunks, schemasOf, parseReply } from '../lib/protocol.js';
import { loadToken, defaultTokenPath, TOKEN_RE } from '../lib/token.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { if (ok) { pass++; console.log('  ✓ ' + name + (extra ? '   ' + extra : '')); } else { fail++; console.log('  ✗ ' + name + (extra ? '   ' + extra : '')); } };

console.log('=== 1) DSH 流式分片（宿主按这个契约消费）===');
{
  const chunks = [...replyChunks({ kind: 'final', text: '答案' }, 0)];
  check('文本回复：block-start → text-delta → block-end → finish',
    chunks[0].type === 'block-start' && chunks[0].blockType === 'text' &&
    chunks[1].type === 'text-delta' && chunks[1].text === '答案' &&
    chunks[2].type === 'block-end' && chunks[2].block.text === '答案' &&
    chunks[3].type === 'finish', chunks.map((c) => c.type).join(' → '));
  check('finish 原因为 stop', chunks[3].reason.kind === 'stop');
  check('**不伪造 usage 分片**（网页端没有可信用量）', !chunks.some((c) => c.type === 'usage'));
  check('分片下标连续', chunks[0].index === 0 && chunks[1].index === 0 && chunks[2].index === 0);
}
{
  const chunks = [...replyChunks({ kind: 'tool_calls', text: '我来查一下', calls: [{ id: 'c1', name: 'get_weather', arguments: '{"city":"北京"}' }, { id: 'c2', name: 'get_time', arguments: '{}' }] }, 3)];
  check('工具调用：先文本块再两个工具块', chunks.filter((c) => c.blockType === 'tool-call').length === 2);
  check('工具分片带 id/name/参数', chunks.find((c) => c.type === 'tool-call-delta')?.id === 'c1' && chunks.find((c) => c.type === 'tool-call-delta')?.argumentsDelta === '{"city":"北京"}');
  const firstToolBlockEnd = chunks.find((c) => c.type === 'block-end' && c.block?.type === 'tool-call');
  check('工具块的 arguments 是字符串（宿主原样执行）', typeof firstToolBlockEnd?.block?.arguments === 'string', JSON.stringify(firstToolBlockEnd?.block));
  check('下标从传入值开始递增', chunks[0].index === 3 && firstToolBlockEnd.index === 4, `文本块 ${chunks[0].index} / 工具块 ${firstToolBlockEnd.index}`);
  check('finish 原因为 tool-calls', chunks[chunks.length - 1].reason.kind === 'tool-calls');
}
{
  const chunks = [...replyChunks({ kind: 'final', text: '' }, 0)];
  check('空文本不发文本块（只有 finish）', chunks.length === 1 && chunks[0].type === 'finish');
}

console.log('\n=== 2) 工具原始 schema 提取（两种常见形状都要认）===');
{
  const a = schemasOf([{ name: 'f', parameters: { type: 'object', properties: { x: { type: 'string' } } } }]);
  const b = schemasOf([{ type: 'function', function: { name: 'f', parameters: { type: 'object', properties: { x: { type: 'string' } } } } }]);
  check('裸定义形状', a.get('f')?.properties?.x?.type === 'string');
  check('OpenAI function 形状', b.get('f')?.properties?.x?.type === 'string');
  check('缺 parameters 时给安全的空对象（不返回 undefined 让调用方炸）', schemasOf([{ name: 'g' }]).get('g')?.type === 'object');
  check('空输入不报错', schemasOf().size === 0);
  // 与解析联动：用原始 schema 把多余字段剥掉
  const reply = parseReply('{"kind":"tool_calls","calls":[{"name":"f","arguments":{"x":"1","y":"多余"}}]}', { id: 'r', schemas: a });
  check('提取的 schema 真的能剥掉多余字段', !('y' in JSON.parse(reply.calls[0].arguments)));
}

console.log('\n=== 3) 配对密钥（三处共用的唯一实现）===');
{
  const dir = mkdtempSync(join(tmpdir(), 'token-test-'));
  const path = join(dir, 'sub', 'token');
  check('默认路径在 ~/.dsh/web-bridge-own/token', defaultTokenPath().replace(/\\/g, '/').endsWith('.dsh/web-bridge-own/token'));
  const logs = [];
  const t1 = loadToken({ tokenPath: path }, (m) => logs.push(m));
  check('缺失时生成一份且格式正确', TOKEN_RE.test(t1), t1.slice(0, 8) + '…');
  check('写了文件并打了日志', existsSync(path) && logs.some((m) => /生成/.test(m)));
  if (process.platform !== 'win32') check('文件权限 0600', (statSync(path).mode & 0o777) === 0o600);
  const t2 = loadToken({ tokenPath: path });
  check('第二次复用同一份（不会每次换密钥把扩展踢下线）', t2 === t1);
  check('文件内容与返回一致（含换行）', readFileSync(path, 'utf8').trim() === t1);
  check('显式合法密钥优先于文件', loadToken({ token: 'A'.repeat(43), tokenPath: path }) === 'A'.repeat(43));
  writeFileSync(path, 'not-a-valid-token\n');
  const t3 = loadToken({ tokenPath: path });
  check('文件内容非法时重新生成', TOKEN_RE.test(t3) && t3 !== 'not-a-valid-token');
  rmSync(dir, { recursive: true, force: true });
}

console.log('\n=== 4) broker 的进程内接口（DSH 插件走这条，不必自己 HTTP 打自己）===');
const TOKEN = 'B'.repeat(43);
const broker = createBroker({ token: TOKEN, port: 0, timeoutMs: 5000, stallMs: 3000, log: () => {} });
await broker.start();
const H = { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN };
const extPoll = async (reply) => {
  const res = await fetch(`http://127.0.0.1:${broker.port}/ext/poll`, { method: 'POST', headers: H, body: JSON.stringify({ clientId: 'fake', version: '1', state: 't' }) });
  const body = await res.json();
  if (!body.task) return null;
  const { id, lease } = body.task;
  if (reply !== null) await fetch(`http://127.0.0.1:${broker.port}/ext/result`, { method: 'POST', headers: H, body: JSON.stringify({ taskId: id, lease, ok: true, text: reply }) });
  return body.task;
};

/** 只领活、不回结果（用来测取消/中断时任务仍在跑的情形） */
const extTake = async () => {
  const res = await fetch(`http://127.0.0.1:${broker.port}/ext/poll`, { method: 'POST', headers: H, body: JSON.stringify({ clientId: 'fake', version: '1', state: 't' }) });
  return (await res.json()).task || null;
};

{
  const phases = [];
  const p = broker.run({ prompt: 'P1', timeoutMs: 4000, onProgress: (phase) => phases.push(phase) });
  await sleep(120);
  const job = await extPoll('{"kind":"final","text":"来自网页"}');
  const result = await p;
  check('run() 拿到结果', result.ok === true && result.text.includes('来自网页'));
  check('结果带上了耗时分解', typeof result.queuedMs === 'number' && typeof result.executedMs === 'number', `queued=${result.queuedMs} exec=${result.executedMs}`);
  check('任务被真的派发给了扩展（扩展侧拿到 id）', !!job?.id);
  check('进度回调可用（面板据此显示阶段）', Array.isArray(phases));
}

{
  // 面板的"叫停"走的就是 broker.cancel()。注意**不能**先让扩展回报结果，
  // 否则任务已经正常结束，cancel() 自然返回 false（我第一版就是这么写错的）。
  const p = broker.run({ prompt: 'P2', timeoutMs: 4000 }).catch((e) => e);
  await sleep(120);
  const job = await extTake();                 // 只领活，不回结果：任务处于"正在跑"
  const cancelled = broker.cancel();
  const err = await p;
  check('cancel() 报告成功', cancelled === true, 'job=' + String(job?.id));
  check('等待方收到 WEB_ABORTED', err?.code === 'WEB_ABORTED', String(err?.code));
  check('取消后没有活动任务', broker.snapshot().active === null);
}

{
  const controller = new AbortController();
  const p = broker.run({ prompt: 'P3', timeoutMs: 4000, signal: controller.signal }).catch((e) => e);
  await sleep(120);
  controller.abort();
  const err = await p;
  check('signal 中断 → 等待方立刻得到 WEB_ABORTED', err?.code === 'WEB_ABORTED', String(err?.code));
  check('中断后 broker 里没有残留活动任务', broker.snapshot().active === null);
}

await broker.close();
console.log('\n' + (fail === 0 ? `全部通过 ✓  (${pass} 项)` : `失败 ${fail} 项 ✗ (通过 ${pass})`));
process.exit(fail === 0 ? 0 : 1);
