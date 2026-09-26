// panel.js — 本机状态面板（与 DSH 同源，走 connection 的鉴权检查）
//
// 只暴露"看状态"和"叫停"，不暴露任何提示词内容：网页桥接里跑的是用户的对话与代码，
// 面板是排查用的小窗口，不该成为新的泄露面。

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

export function registerPanel(ctx, broker, config = {}) {
  const routes = [
    ['/web-bridge-own/panel', 'GET'],
    ['/web-bridge-own/cancel', 'POST'],
  ];

  for (const [path, method] of routes) {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path,
      handler(req, res) {
        const rejection = ctx.connection.requestRejection(req);
        if (rejection !== undefined) { res.writeHead(rejection); res.end(); return; }
        if (req.method !== method) { json(res, 405, { error: '方法不允许' }); return; }

        if (path.endsWith('/panel')) {
          const s = broker.status();
          json(res, 200, {
            ok: true,
            implementation: 'dsh-web-bridge-own',
            version: '1.0.0',
            port: config.port ?? 3081,
            connected: s.connected,
            workerVersion: s.workerVersion,
            workerState: s.workerState,
            queued: s.queued,
            active: s.active,
            lastPhase: broker.lastPhase ?? null,
            lastOutcome: broker.lastOutcome ?? null,
            note: s.connected ? '扩展已连接' : '扩展未连接：请在浏览器里加载 extension/ 并登录 chat.deepseek.com',
          });
          return;
        }

        // POST /cancel
        const cancelled = broker.cancel();
        json(res, 200, { ok: true, cancelled });
      },
    }), 'dsh-web-bridge-own: ' + path);
  }
}
