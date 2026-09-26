// 交付确认与重新派发：任务被写进"没人读"的响应（服务工作线程被杀、连接中断）时，
// 必须被重新派发，而不是静默消失。这是真机测出来的那类 120 秒静默超时的根治手段。
import { createBroker } from '../lib/broker.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TOKEN = 'C'.repeat(43);
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { if (ok) { pass++; console.log('  ✓ ' + name + (extra ? '   ' + extra : '')); } else { fail++; console.log('  ✗ ' + name + (extra ? '   ' + extra : '')); } };

function readNdjson(res) {
  const events = [];
  let settle = null;
  const finished = new Promise((resolve) => { settle = resolve; });
  (async () => {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let at;
      while ((at = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, at).trim();
        buf = buf.slice(at + 1);
        if (!line) continue;
        const ev = JSON.parse(line);
        events.push(ev);
        if (ev.type === 'result') settle(ev);
      }
    }
    settle(events.find((e) => e.type === 'result') || null);
  })().catch(() => settle(null));
  return { events, finished };
}

/** 一次 poll：有任务就拿走（不回结果），没有就返回 null（长轮询会等满，所以用超时兜住） */
async function pollTake(base, hint = 1500) {
  const res = await fetch(base + '/ext/poll', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
    body: JSON.stringify({ clientId: 'fake', version: '1', state: 't' }),
    signal: AbortSignal.timeout(hint),
  }).catch(() => null);
  if (!res || !res.ok) return null;
  return res.json().catch(() => null);
}
const report = (base, body) => fetch(base + '/ext/result', {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN }, body: JSON.stringify(body),
}).then((r) => r.json());

console.log('=== 1) 交付没人接手 → 自动重新派发（并且换新租约）===');
{
  const broker = createBroker({ token: TOKEN, port: 0, timeoutMs: 8000, stallMs: 6000, ackTimeoutMs: 300, maxDeliveries: 3, log: () => {} });
  await broker.start();
  const base = `http://127.0.0.1:${broker.port}`;

  const taskRes = await fetch(base + '/task', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
    body: JSON.stringify({ prompt: 'P', timeoutMs: 8000 }),
  });
  const { finished } = readNdjson(taskRes);

  const first = await pollTake(base);
  check('第一次交付拿到任务', !!first?.task, first?.task?.id);
  check('第一次派发带上了 activeTaskId', first?.activeTaskId === first?.task?.id);

  // 故意什么都不回报：模拟"这个 poller 背后的连接已经死了"
  await sleep(700);
  const second = await pollTake(base);
  check('同一个任务被重新派发', !!second?.task && second.task.id === first.task.id, second?.task?.id);
  check('重新派发换了新租约（旧租约作废）', second?.task?.lease && second.task.lease !== first.task.lease);
  check('阶段里写明了重新派发的原因', (broker.snapshot().tasks.find((t) => t.id === first.task.id)?.phases || []).some((p) => /重新派发/.test(p)));

  const stale = await report(base, { taskId: first.task.id, lease: first.task.lease, ok: true, text: '旧租约的结果' });
  check('用旧租约回报被拒（不会被当成结果）', stale.ok === false && stale.stale === true, JSON.stringify(stale));

  await report(base, { taskId: second.task.id, lease: second.task.lease, ok: true, text: '重新派发后的结果' });
  const final = await finished;
  check('重新派发后正常完成', final?.ok === true && String(final.text).includes('重新派发后的结果'), JSON.stringify(final?.text));

  await broker.close();
}

console.log('\n=== 2) 一直没人接手 → 交够次数后明确失败（不无限重投）===');
{
  const broker = createBroker({ token: TOKEN, port: 0, timeoutMs: 8000, stallMs: 6000, ackTimeoutMs: 300, maxDeliveries: 2, log: () => {} });
  await broker.start();
  const base = `http://127.0.0.1:${broker.port}`;
  const taskRes = await fetch(base + '/task', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
    body: JSON.stringify({ prompt: 'P2', timeoutMs: 8000 }),
  });
  const { finished } = readNdjson(taskRes);
  await pollTake(base);          // 第一次：领走不回
  await sleep(700);
  await pollTake(base);          // 第二次：又领走不回
  const final = await Promise.race([finished, sleep(4000).then(() => null)]);
  check('达到最大交付次数后判失败', final?.ok === false, JSON.stringify(final?.error)?.slice(0, 60));
  check('错误码是 WEB_NO_ACK（点明是"没人接手"而不是超时）', final?.code === 'WEB_NO_ACK', String(final?.code));
  check('错误文案给了可执行的解释', /没有(得到)?(页面)?响应|重新派发|不稳定/.test(String(final?.error)));
  await broker.close();
}

console.log('\n=== 3) 两级确认：收到即确认能免掉误重发，但没接手仍会重发 ===');
{
  // 一级窗口 300ms、二级（接手）窗口 1500ms。
  // 注意必须把两个窗口拉开：如果"不该重发"的那次 poll 一直等到二级窗口过去，
  // 重发会正好落在这个 poll 的等待期里，看起来就像"提前重发了"（我第一版就这么写错的）。
  const broker = createBroker({ token: TOKEN, port: 0, timeoutMs: 9000, stallMs: 8000, ackTimeoutMs: 300, handoffTimeoutMs: 1500, maxDeliveries: 3, log: () => {} });
  await broker.start();
  const base = `http://127.0.0.1:${broker.port}`;
  const progress = (body) => fetch(base + '/ext/progress', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN }, body: JSON.stringify(body),
  }).then((r) => r.json());

  const taskRes = await fetch(base + '/task', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
    body: JSON.stringify({ prompt: 'P3', timeoutMs: 9000 }),
  });
  const { finished } = readNdjson(taskRes);
  const first = await pollTake(base);

  // 扩展收到就确认（stage=receipt）
  const ack = await progress({ taskId: first.task.id, lease: first.task.lease, stage: 'receipt', phase: '扩展已收到任务，正在准备标签页' });
  check('收到确认被接受', ack.ok === true, JSON.stringify(ack));

  // 超过一级窗口、但离二级窗口还远：**不应该**重发（页面在加载是合法的慢）
  await sleep(400);
  const during = await pollTake(base, 300);        // 300ms 后主动放弃，远早于 1500ms
  check('收到已确认 + 尚未到接手窗口 → 不重发', !during?.task, JSON.stringify(during));

  // 等到超过二级窗口：内容脚本一直没接手 → 必须重发
  await sleep(1300);
  const after = await pollTake(base, 2000);
  check('一直没接手 → 重发同一个任务', after?.task?.id === first.task.id, after?.task?.id);
  check('重发原因写明是"没接手"', (broker.snapshot().tasks.find((t) => t.id === first.task.id)?.phases || []).some((p) => /没接手/.test(p)));

  // 接手后正常完成
  await progress({ taskId: after.task.id, lease: after.task.lease, phase: '内容脚本已接手，正在准备提交' });
  await report(base, { taskId: after.task.id, lease: after.task.lease, ok: true, text: '两级确认后的结果' });
  const final = await finished;
  check('最终正常完成', final?.ok === true && String(final.text).includes('两级确认'), String(final?.text));
  await broker.close();
}

console.log('\n=== 4) 已派发后超时 → 不可重试的错误码（避免重复提问）===');
{
  // ack 窗口故意设得很大，让任务自己的总预算先到
  const broker = createBroker({ token: TOKEN, port: 0, timeoutMs: 1200, stallMs: 6000, ackTimeoutMs: 20_000, handoffTimeoutMs: 20_000, maxDeliveries: 3, log: () => {} });
  await broker.start();
  const base = `http://127.0.0.1:${broker.port}`;
  const taskRes = await fetch(base + '/task', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
    body: JSON.stringify({ prompt: 'P4', timeoutMs: 1200 }),
  });
  const { finished } = readNdjson(taskRes);
  await pollTake(base);           // 领走，但一直不回报（提示词可能已经发出去了）
  const final = await Promise.race([finished, sleep(4000).then(() => null)]);
  check('已派发后超时用 WEB_TIMEOUT_AFTER_DISPATCH', final?.code === 'WEB_TIMEOUT_AFTER_DISPATCH', String(final?.code));
  check('文案提醒不要直接重试', /不要直接重试|先在网页/.test(String(final?.error)), String(final?.error).slice(0, 60));
  await broker.close();
}

console.log('\n' + (fail === 0 ? `全部通过 ✓  (${pass} 项)` : `失败 ${fail} 项 ✗ (通过 ${pass})`));
process.exit(fail === 0 ? 0 : 1);
