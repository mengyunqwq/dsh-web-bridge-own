// index.js — dsh-web-bridge-own：把「已登录的 DeepSeek 网页」接到 DSH 的模型层
//
// 为什么有这份东西：上游插件（xinyuquan985-coder/DSH-webtokens）**没有声明任何开源许可证**，
// 默认保留所有权利，因此不能随本仓库分发、也不能改一份发出去。本实现是独立编写的等价物：
// 行为逻辑参考了"把网页当模型用"这件事的通行做法，代码全部自写，不包含上游任何代码。
//
// 组成：本机 broker（lib/broker.js，127.0.0.1:3081）+ 自研协议（lib/protocol.js）
//      + 浏览器扩展（extension/，负责在网页里提交与取回文本）+ 这个插件（把两者接进 DSH）。
//
// 与上游在职责划分上的关键差别：**扩展只搬运文本**，JSON 解析、工具参数校验、格式约束都在
// 本进程里做（lib/protocol.js）。好处是扩展更薄，协议要改时不必让用户重新加载扩展。

import z from '@deepseek-ai/schemastery';
import { LlmAdapter, LlmError, resolveRetryPolicy } from '@deepseek-ai/dsh-llm';
import { createBroker } from './lib/broker.js';
import { buildTask, parseReply, replyChunks, schemasOf } from './lib/protocol.js';
import { loadToken } from './lib/token.js';
import { registerPanel } from './panel.js';

export const name = 'deepseek-web-bridge-own';
export const inject = ['llm'];

export const Config = z.object({
  token: z.string().default(''),
  port: z.number().default(3081),
  host: z.string().default('127.0.0.1'),
  timeoutMs: z.number().default(240_000),
  stallMs: z.number().default(90_000),
  tokenPath: z.string().default(''),
});

/** 网页端的上下文窗口没有公开可信数字，这里取一个保守值（宁可报小，不要乐观） */
const CONTEXT_TOKENS = 128_000;

/** 会话标题之类的内部用途：本地生成，不占用网页一次往返 */
function localTitle(messages = []) {
  const text = (messages || [])
    .filter((m) => m?.role === 'user')
    .flatMap((m) => (Array.isArray(m.content) ? m.content : [m.content]))
    .filter((b) => b && (b.type === 'text' || typeof b === 'string'))
    .map((b) => (typeof b === 'string' ? b : b.text))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24);
  return text || 'DeepSeek 网页会话';
}

export class WebAdapter extends LlmAdapter {
  constructor(broker, config = {}) { super(); this.broker = broker; this.config = config; }

  providerInfo(provider) { return { id: provider, name: 'DeepSeek 网页（自研桥接）' }; }

  providerRetryPolicy() { return resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, 'deepseek-web-own'); }

  async listModels(provider) {
    return [{ provider, id: 'deepseek-web', name: 'DeepSeek 网页', inputModalities: ['text'] }];
  }

  async resolveModel(provider, model) {
    return { provider, id: model, name: 'DeepSeek 网页', inputModalities: ['text'], context: { contextWindow: CONTEXT_TOKENS } };
  }

  async *stream(options) {
    if (options.purpose === 'session-title') {
      yield* replyChunks({ kind: 'final', text: localTitle(options.messages) });
      return;
    }
    const started = Date.now();
    let index = 0;
    try {
      // 可以安全重试的失败：**只是模型这次没按契约输出**（缺参数、写成散文、编号不对）。
      // 绝不包含网页侧失败（页面重载、超时、断线）——重试那些会在用户账号里发两条一样的提问。
      const retryable = new Set(['WEB_TOOL_MISSING_ARGS', 'WEB_REPLY_JSON', 'WEB_REPLY_KIND', 'WEB_REPLY_TEXT', 'WEB_REPLY_CALLS']);
      const nudgeFor = (error) => (error?.code === 'WEB_TOOL_MISSING_ARGS'
        ? '上一轮你的工具调用缺少必需参数。这次请把 parameters 里 required 列出的字段**全部填上**，不要交空对象，也不要多写其它字段。'
        : '');
      let lastError = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        const built = buildTask({
          messages: options.messages || [],
          tools: options.tools || [],
          guard: true,
          nudge: attempt > 1 ? nudgeFor(lastError) : '',
        });
        this.broker.lastPhase = attempt > 1 ? '第 2 次尝试：已重新提交到网页' : '已提交到网页';
        try {
          const result = await this.broker.run({
            prompt: built.prompt,
            timeoutMs: this.config.timeoutMs,
            signal: options.signal,
            onProgress: (phase) => { this.broker.lastPhase = phase; },
          });
          this.broker.lastPhase = '网页已返回，正在解析';
          const reply = parseReply(result.text, { id: built.id, schemas: schemasOf(options.tools) });
          this.broker.lastOutcome = { at: Date.now(), kind: reply.kind, tools: (reply.calls || []).map((c) => c.name), ms: Date.now() - started, chars: (result.text || '').length };
          yield* replyChunks(reply, index);
          return;
        } catch (error) {
          lastError = error;
          if (attempt === 2 || !retryable.has(error?.code)) throw error;
          this.broker.lastPhase = `第 1 次没有通过（${error.message}），正在重试一次`;
        }
      }
    } catch (error) {
      // 失败时也要给宿主一段可读的终止文字（否则界面只显示空回复），但**仍然抛错**——
      // 这一轮没有成功，不能假装成功。
      const message = error?.message || String(error);
      this.broker.lastOutcome = { at: Date.now(), error: message, code: error?.code, ms: Date.now() - started };
      const text = '网页桥接已停止：' + message + '\n\n本轮网页回复未作为工具调用执行。';
      yield { type: 'block-start', index, blockType: 'text' };
      yield { type: 'text-delta', index, text };
      yield { type: 'block-end', index, block: { type: 'text', text } };
      throw new LlmError(message, error?.code || 'WEB_BRIDGE_OWN_ERROR');
    }
  }
}

export async function apply(ctx, config) {
  const log = (m) => { try { console.log('[dsh-web-bridge-own] ' + m); } catch { /* ignore */ } };
  const token = loadToken(config, log);
  const broker = createBroker({
    token,
    port: config.port,
    host: config.host,
    timeoutMs: config.timeoutMs,
    stallMs: config.stallMs,
    log,
    onEvent: (event) => { broker.lastEvent = event; },
  });

  // 面板：同源、需通过 connection 的鉴权检查（与 DSH 其它页面一致）
  ctx.inject(['connection', 'webServer'], (scope) => registerPanel(scope, broker, config));

  // broker 的生命周期挂在 ctx.effect 上：插件卸载/重载时自动关闭，不会留下占端口的孤儿进程
  await ctx.effect(async () => {
    await broker.start();
    return () => broker.close();
  }, 'dsh-web-bridge-own: 本机 broker');

  // provider id 沿用 'deepseek-web'：替换上游插件后，DSH 里已有的模型配置不需要改
  ctx.llm.registerAdapter(['deepseek-web'], new WebAdapter(broker, config));
  log(`就绪：provider deepseek-web，broker 127.0.0.1:${broker.port}（扩展需要加载并登录 chat.deepseek.com）`);
}
