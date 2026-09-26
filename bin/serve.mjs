#!/usr/bin/env node
// bin/serve.mjs — 独立跑本机 broker（不装进 DSH 也能用：任何客户端调 /task 都行）
//
// 用法：
//   node bin/serve.mjs                 # 默认 127.0.0.1:3081
//   node bin/serve.mjs --port 3099
//   node bin/serve.mjs --print-token   # 顺便打印配对密钥（首次配置扩展时有用）
//
// 注意：与 DSH 插件**不要**同时占用同一个端口；插件方式下由插件自己启动 broker。

import { createBroker } from '../lib/broker.js';
import { loadToken } from '../lib/token.js';

const args = process.argv.slice(2);
const value = (name, fallback) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : fallback; };
const port = Number(value('port', process.env.DSH_WEB_BRIDGE_PORT || 3081));
const host = value('host', '127.0.0.1');

const token = loadToken({ tokenPath: value('token-path', undefined) }, (m) => console.log('  ' + m));
if (args.includes('--print-token')) console.log('  配对密钥：' + token);

const broker = createBroker({
  token, port, host,
  timeoutMs: Number(value('timeout', 240_000)),
  stallMs: Number(value('stall', 90_000)),
  log: (m) => console.log('  ' + m),
});

await broker.start();
console.log(`  broker 就绪：http://${host}:${broker.port}　（状态：/status，任务：POST /task）`);
console.log('  下一步：确认浏览器已加载扩展（npm run setup 生成 chrome/）并登录 chat.deepseek.com，');
console.log('          然后 node bin/measure.mjs --port ' + broker.port + ' --tools 量一轮。');

const shutdown = async (signal) => {
  console.log(`\n  收到 ${signal}，正在关闭…`);
  await broker.close();
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
