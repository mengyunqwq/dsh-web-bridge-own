// 自研 broker 测试：用「假扩展 + 假客户端」跑完整生命周期（无需浏览器）
import { request as httpRequest } from 'node:http';
import { createBroker } from '../lib/broker.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { if (ok) { pass++; console.log('  ✓ ' + name + (extra ? '   ' + extra : '')); } else { fail++; console.log('  ✗ ' + name + (extra ? '   ' + extra : '')); } };
// 硬看门狗：脚本自身绝不能挂住（上次就是卡在 broker.close() 上，导致命令一直不返回）
const watchdog = setTimeout(() => { console.log('\n⏱ 测试自身超时（60s）——说明还有地方会挂住'); process.exit(3); }, 60_000);

const TOKEN = 'tk_test_' + Math.random().toString(16).slice(2);
// 注意：确认窗口（ackTimeoutMs / handoffTimeoutMs）显式放大，让"停滞看门狗"先触发——
// 否则 1.5 秒的确认窗口会先把任务重新派发，第 6 节就测不到想测的东西（实测踩到）。
const broker = createBroker({ token: TOKEN, port: 0, timeoutMs: 3000, stallMs: 1200, ackTimeoutMs: 20_000, handoffTimeoutMs: 20_000, log: () => {} });
await broker.start();
const BASE = `http://127.0.0.1:${broker.port}`;
console.log(`  broker 起在 ${BASE}`);
const H = { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN };
const post = (path, body) => fetch(BASE + path, { method: 'POST', headers: H, body: JSON.stringify(body ?? {}) });

/** 读 NDJSON 流，把每条解析出来交给回调；返回一个 promise，收到 result 行后 resolve */
function readNdjson(res) {
  const events = [];
  let done = null;
  const finished = new Promise((resolve) => { done = resolve; });
  (async () => {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        const ev = JSON.parse(line);
        events.push(ev);
        if (ev.type === 'result') done(ev);
      }
    }
    done(events.find((e) => e.type === 'result') || null);
  })().catch(() => done(null));
  return { events, finished };
}

async function poll(body) { return (await post('/ext/poll', body)).json(); }

console.log('\n=== 1) 鉴权与 Host 校验 ===');
{
  const s = await (await fetch(BASE + '/status')).json();
  check('/status 不需要密钥即可读', s.ok === true && s.connected === false, JSON.stringify(s.worker));
  const bad = await fetch(BASE + '/task', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' }, body: '{"prompt":"x"}' });
  check('密钥不对 → 401', bad.status === 401);
  const viaWrongHost = await new Promise((resolve) => {
    const req = httpRequest({ host: '127.0.0.1', port: broker.port, path: '/status', method: 'GET', headers: { Host: 'evil.example.com' } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(0)); req.end();
  });
  check('Host 不是本机端口 → 403（挡 DNS rebinding）', viaWrongHost === 403, 'HTTP ' + viaWrongHost);
}

console.log('\n=== 2) 完整生命周期：扩展长轮询领活 → 客户端拿进度与结果 ===');
{
  const pollP = poll({ clientId: 'ext-1', version: '1.0.0', state: '已连接' });      // 扩展开始长轮询
  await sleep(80);
  const s1 = (await (await fetch(BASE + '/status')).json());
  check('扩展 poll 后 /status 显示已连接', s1.connected === true, JSON.stringify(s1.worker));

  const taskRes = await post('/task', { prompt: '把这句话交给网页', timeoutMs: 3000 });
  check('客户端 /task 返回 200 且是 NDJSON', taskRes.status === 200 && String(taskRes.headers.get('content-type')).includes('ndjson'));
  const { events, finished } = readNdjson(taskRes);

  const job = await pollP;
  check('扩展领到了任务', !!job.task && job.task.prompt === '把这句话交给网页' && typeof job.task.lease === 'string', JSON.stringify(job.task && { id: job.task.id, lease: job.task.lease?.slice(0, 6) + '…' }));
  const taskId = job.task.id, lease = job.task.lease;

  const p1 = await (await post('/ext/progress', { taskId, lease, phase: '正在提交到网页' })).json();
  check('扩展上报进度被接受', p1.ok === true);
  await post('/ext/progress', { taskId, lease, phase: '网页正在生成' });
  const res1 = await (await post('/ext/result', { taskId, lease, ok: true, text: '{"kind":"final","text":"网页的回答"}' })).json();
  check('扩展回报结果被接受', res1.ok === true);

  const final = await finished;
  check('客户端收到 result', !!final && final.ok === true && final.text.includes('网页的回答'));
  check('客户端收到两条进度', events.filter((e) => e.type === 'progress').map((e) => e.phase).join('|') === '正在提交到网页|网页正在生成');
  check('result 带上了阶段与耗时分解', Array.isArray(final.phases) && final.queuedMs !== null && final.executedMs !== null, `queued=${final.queuedMs} exec=${final.executedMs}`);
}

console.log('\n=== 3) 租约不匹配的回报被丢弃（旧实例写不进新任务）===');
{
  const pollP = poll({ clientId: 'ext-1', version: '1.0.0', state: 'x' });
  await sleep(50);
  const taskRes = await post('/task', { prompt: 'P2', timeoutMs: 3000 });
  const { finished } = readNdjson(taskRes);
  const job = (await pollP).task;
  const stale = await (await post('/ext/result', { taskId: job.id, lease: 'wrong-lease', ok: true, text: '伪造结果' })).json();
  check('lease 不对 → 拒绝', stale.ok === false && stale.stale === true, JSON.stringify(stale));
  const okRes = await (await post('/ext/result', { taskId: job.id, lease: job.lease, ok: true, text: '真结果' })).json();
  check('lease 正确 → 接受', okRes.ok === true);
  const final = await finished;
  check('客户端拿到的是真结果', final.text === '真结果');
}

console.log('\n=== 4) 单 worker 串行：第二个任务要等第一个跑完才派发 ===');
{
  const pollP1 = poll({ clientId: 'ext-1', version: '1.0.0', state: 'x' });
  await sleep(50);
  const t1 = await post('/task', { prompt: 'A', timeoutMs: 4000 });
  const r1 = readNdjson(t1);
  const jobA = (await pollP1).task;
  // 第一个还在跑：再起一个 poll 与一个任务
  const pollP2 = poll({ clientId: 'ext-1', version: '1.0.0', state: 'x' });
  const t2 = await post('/task', { prompt: 'B', timeoutMs: 4000 });
  const r2 = readNdjson(t2);
  await sleep(150);
  const snap = broker.snapshot();
  check('同时只派发一个（另一个在排队）', snap.active === jobA.id && snap.queued.length === 1, JSON.stringify({ active: snap.active === jobA.id, queued: snap.queued.length }));
  await post('/ext/result', { taskId: jobA.id, lease: jobA.lease, ok: true, text: 'A 完成' });
  await r1.finished;
  const jobB = (await pollP2).task;
  check('第一个完成后才派发第二个', !!jobB && jobB.prompt === 'B');
  await post('/ext/result', { taskId: jobB.id, lease: jobB.lease, ok: true, text: 'B 完成' });
  const fb = await r2.finished;
  check('第二个也正常完成', fb.text === 'B 完成');
}

console.log('\n=== 5) 客户端断开 → 任务取消，并且扩展会被告知停下 ===');
{
  const pollP = poll({ clientId: 'ext-1', version: '1.0.0', state: 'x' });
  await sleep(50);
  const ac = new AbortController();
  const taskRes = await fetch(BASE + '/task', { method: 'POST', headers: H, body: JSON.stringify({ prompt: '会被取消', timeoutMs: 5000 }), signal: ac.signal });
  const job = (await pollP).task;
  ac.abort();                                  // 模拟客户端刷新/断网
  await sleep(200);
  const p = await (await post('/ext/progress', { taskId: job.id, lease: job.lease, phase: '还在跑' })).json();
  check('取消后扩展上报进度 → 得到 cancelled', p.cancelled === true, JSON.stringify(p));
  const again = await poll({ clientId: 'ext-1', version: '1.0.0', state: 'x' });
  check('取消后扩展再 poll → 被告知停止哪条任务', !!(again.cancelledTaskId || !again.task), JSON.stringify(again).slice(0, 90));
}

console.log('\n=== 6) 停滞看门狗：派发后毫无进展 → 主动失败 ===');
{
  const pollP = poll({ clientId: 'ext-1', version: '1.0.0', state: 'x' });
  await sleep(50);
  const taskRes = await post('/task', { prompt: '会停滞', timeoutMs: 8000 });
  const r = readNdjson(taskRes);
  const job = (await pollP).task;
  const final = await Promise.race([r.finished, sleep(4000).then(() => null)]);
  check('停滞时客户端拿到失败结果', !!final && final.ok === false && /停滞/.test(final.error), final ? final.error.slice(0, 60) : '（超时未返回）');
  check('失败码是 WEB_STALL', final?.code === 'WEB_STALL');
}

console.log('\n=== 7) 没人来取任务 → 总超时后按"未被取走"报错 ===');
{
  const taskRes = await post('/task', { prompt: '没人取', timeoutMs: 300 });
  const r = readNdjson(taskRes);
  const final = await Promise.race([r.finished, sleep(3000).then(() => null)]);
  check('超时失败且指出是没人取走', !!final && final.ok === false && /没有取走/.test(final.error), final ? final.error.slice(0, 70) : '（超时未返回）');
}

console.log('\n=== 8) OpenAI 兼容面：非流式失败必须立刻给出错误（不能挂死）===');
{
  // 修复前的缺陷：/v1/chat/completions 非流式在 chatOnce 之前就 writeHead(200)，
  // 失败时 sendJson(502) 写不进去、res 永不 end —— 客户端挂到超时。现在 writeHead
  // 挪到成功路径上，失败分支能真正发出 504/502。
  const started = Date.now();
  const res = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ model: 'web-deepseek', messages: [{ role: 'user', content: 'hi' }], stream: false, timeout_ms: 600 }),
  });
  const elapsed = Date.now() - started;
  check('非流式失败时能拿到确定的 HTTP 状态码（而不是挂死）', res.status === 504 || res.status === 502, 'HTTP ' + res.status);
  const body = await res.json().catch(() => null);
  check('错误体外形是 OpenAI 的 error 结构', !!body && !!body.error && typeof body.error.message === 'string' && typeof body.error.code === 'string', JSON.stringify(body).slice(0, 120));
  check('响应要快（broker 超时 600ms + 一点余量），而不是挂到客户端超时', elapsed < 5000, elapsed + 'ms');
}

console.log('\n=== 9) OpenAI 兼容面：参数错误 → 400（与网页侧无关的真 400）===');
{
  const res = await post('/v1/chat/completions', { model: 'web-deepseek', messages: [] });
  check('空 messages → 400', res.status === 400, 'HTTP ' + res.status);
  const body = await res.json().catch(() => null);
  check('400 也带 error.message', !!body?.error?.message, JSON.stringify(body).slice(0, 80));
}

console.log('\n=== 10) N2：不把任务派给"自称忙"的 worker，且残留队列 id 不阻塞派发 ===');
{
  // 先消费可能残留的取消通知：/ext/poll 遇到未送达的取消通知会立刻返回、**不登记等待者**，
  // 会让后面的快照断言看到 pollers=0（这是通知机制的正常行为，不是 N2 的问题）。
  await poll({ clientId: 'ext-1', version: '1.0.0', state: 'x', busy: true });
  await sleep(60);

  // 先进一个 busy:true 的 poll（模拟扩展正在跑上一轮），再入队一个任务：
  // 修复前 dispatchNext 会照派 → 扩展静默忽略 → 交付凭空消失（白烧一次重投）。
  const busyPoll = poll({ clientId: 'ext-1', version: '1.0.0', state: '忙', busy: true });
  await sleep(60);
  const s1 = broker.snapshot();
  check('快照里能看到"忙"的等待者', s1.busyPollers === 1 && s1.pollers === 1, JSON.stringify({ pollers: s1.pollers, busy: s1.busyPollers }));

  const taskRes = post('/task', { prompt: '忙时不派发', timeoutMs: 4000 });
  await sleep(200);
  const s2 = broker.snapshot();
  check('忙 worker 在场时任务留在队列里、不派发', s2.active === null && s2.tasks.some((t) => t.state === 'queued'), JSON.stringify({ active: s2.active }));

  // 扩展闲下来再 poll → 立刻拿到任务（队列里若有更早的残留 id，也必须被跳过而不是卡住）
  const idlePoll = poll({ clientId: 'ext-1', version: '1.0.0', state: '空闲', busy: false });
  const got = await Promise.race([idlePoll, sleep(3000).then(() => null)]);
  check('worker 变闲后任务被派发（残留 id 不阻塞）', !!got?.task && got.task.prompt === '忙时不派发', JSON.stringify(got?.task ? { id: got.task.id } : got));
  if (got?.task) await post('/ext/result', { taskId: got.task.id, lease: got.task.lease, ok: true, text: '{"kind":"final","text":"完成"}' });
  const r = readNdjson(await taskRes);
  await Promise.race([r.finished, sleep(3000)]);
  // 那个"忙"的长轮询会在 broker.close() 时被正常结束，这里不用管它
}

console.log('\n=== 11) 问题5（折中）：已提交后的格式失败不再自动重试，缺参数仍重试一次 ===');
{
  // 用**有界轮询**（AbortSignal 超时即断开）：超时会让 broker 把等待者摘掉，
  // 不会留下一个"抢下一节任务"的长轮询（实测踩到：无界 poll 会串台）。
  const BOUND = 3000;
  const pollBounded = async () => {
    try {
      const r = await fetch(BASE + '/ext/poll', {
        method: 'POST', headers: H,
        body: JSON.stringify({ clientId: 'ext-1', version: '1.0.0', state: 'x' }),
        signal: AbortSignal.timeout(BOUND),
      });
      return await r.json();
    } catch { return null; }
  };
  /** 反复取任务直到收满 maxTasks 个；每个任务按 reply(i, requestId) 回文本 */
  const collect = async (reply, maxTasks, rounds = 4) => {
    const prompts = [];
    for (let i = 0; i < rounds && prompts.length < maxTasks; i++) {
      const job = await pollBounded();
      if (!job?.task) continue;
      prompts.push(job.task.prompt);
      const text = reply(prompts.length - 1, job.task.requestId);
      await post('/ext/result', { taskId: job.task.id, lease: job.task.lease, ok: true, text });
    }
    return prompts;
  };

  // 先消费可能残留的取消通知
  await poll({ clientId: 'ext-1', version: '1.0.0', state: 'x', busy: true });
  await sleep(60);

  // 场景一：扩展回散文（WEB_REPLY_JSON）。修复前会换新 requestId 重发一轮 → 账号里两条提问。
  const proseCollect = collect(() => '我直接说人话，不输出 JSON。', 2);
  const res = await post('/v1/chat/completions', { model: 'web-deepseek', messages: [{ role: 'user', content: 'hi' }], stream: false, timeout_ms: 6000 });
  const body = await res.json().catch(() => null);
  const prosePrompts = await Promise.race([proseCollect, sleep(12000).then(() => [])]);
  check('散文答复只提交了一次（不再自动重发）', prosePrompts.length === 1, '提交次数=' + prosePrompts.length);
  check('报出的是解析类错误码（不再重试）', String(body?.error?.code || '') === 'WEB_REPLY_JSON', JSON.stringify(body?.error || {}).slice(0, 100));

  // 场景二：缺必需参数（WEB_TOOL_MISSING_ARGS）仍应自动重试一次（换新 requestId）
  const schema = [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }];
  const missingCollect = collect((i) => (i === 0
    ? '{"kind":"tool_calls","calls":[{"name":"get_weather","arguments":{}}]}'      // 缺 city
    : '{"kind":"final","text":"第二次好了"}'), 2);
  const res2 = await post('/v1/chat/completions', { model: 'web-deepseek', messages: [{ role: 'user', content: '查天气' }], tools: schema, stream: false, timeout_ms: 8000 });
  const body2 = await res2.json().catch(() => null);
  const missingPrompts = await Promise.race([missingCollect, sleep(12000).then(() => [])]);
  check('缺必需参数仍自动重试一次（共两次提交）', missingPrompts.length === 2, '提交次数=' + missingPrompts.length);
  check('第二次的答复被采纳', body2?.choices?.[0]?.message?.content === '第二次好了', JSON.stringify(body2?.error || body2?.choices?.[0]?.message || {}).slice(0, 120));
}

await broker.close();
clearTimeout(watchdog);
console.log('\n' + (fail === 0 ? `全部通过 ✓  (${pass} 项)` : `失败 ${fail} 项 ✗ (通过 ${pass})`));
process.exit(fail === 0 ? 0 : 1);
