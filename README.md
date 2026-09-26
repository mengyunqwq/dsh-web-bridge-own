# dsh-web-bridge-own

把**你自己浏览器里已登录的 DeepSeek 网页**接到 DSH 的模型层：DSH 里选 `deepseek-web` 这个
provider，请求就会送到一个专用标签页，由网页生成，再把答复带回来（含工具调用）。

这是**独立实现**：仓库里不含 [xinyuquan985-coder/DSH-webtokens](https://github.com/xinyuquan985-coder/DSH-webtokens)
的任何代码。之所以要独立写一份，是因为上游仓库**没有声明任何开源许可证**（默认保留所有权利），
既不能随本项目分发，也不能改一份发出去。

## 它由三部分组成

| 部分 | 文件 | 做什么 |
|---|---|---|
| 浏览器扩展 | `extension/` | 在**你的浏览器**里用你的登录态把提示词提交到网页、把答复原文取回。只搬运文本。 |
| 本机 broker | `lib/broker.js` | `127.0.0.1:3081` 上的本机服务：与扩展长轮询派发/回报、排队、超时、取消、状态。 |
| DSH 插件 | `index.js` / `panel.js` | 把上面两者接进 DSH 的模型层（`provider = deepseek-web`），并提供本机状态面板。 |

协议（提示词组装、从答复原文抠 JSON、工具参数校验、格式约束、重试）都在 `lib/protocol.js`——
**不在扩展里**。所以扩展很薄，而且协议要改时不需要用户重新加载扩展。

## 安装

### 1. 铺扩展目录 + 生成配对密钥

```bash
npm run setup            # 生成/复用 ~/.dsh/web-bridge-own/token，并铺出 chrome/
npm run setup -- --print-token
```

### 2. 人工两步（Chromium 硬限制，脚本替代不了）

1. `edge://extensions` / `chrome://extensions` → 打开「开发者模式」→「加载已解压的扩展程序」→ 选 **`chrome/`** 目录；
2. 在该浏览器里打开并登录 <https://chat.deepseek.com>。

### 3. 装进 DSH

本包声明了 DSH bundle 补丁（`package.json` 的 `dsh.bundle.patch` → `cordis.patch.yml`），
放进 DSH 的 profile 依赖即可（与安装其它 bundle 插件的方式相同）。加载后会插入：

```yaml
- id: deepseek-web-bridge-own
  name: dsh-web-bridge-own
  config: { port: 3081, token: <env DSH_WEB_BRIDGE_OWN_TOKEN 或留空走 token 文件> }
```

> ⚠ **与上游插件二选一**：两者的 provider id（`deepseek-web`）与默认端口（3081）都相同，
> 同时启用会争抢端口。替换步骤：先在 DSH 里禁用/卸载上游 `dsh-web-bridge`，再启用本插件。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `port` | `3081` | 本机 broker 端口（扩展的 host_permissions 也写的是这个端口） |
| `host` | `127.0.0.1` | 只监听本机；同时对 `Host` 头做校验（挡 DNS rebinding） |
| `timeoutMs` | `240000` | 一轮任务的总预算（含排队） |
| `stallMs` | `90000` | 停滞看门狗：这么久没有任何进展就判失败并让网页停下 |
| `token` | 空 | 配对密钥；留空则用 `tokenPath` |
| `tokenPath` | `~/.dsh/web-bridge-own/token` | 密钥文件位置 |

## 状态面板

DSH 同源下可访问（需通过 DSH 自己的连接鉴权）：

- `GET /web-bridge-own/panel` —— 连接状态、排队数、当前阶段、最近一次结果（**不含提示词内容**）
- `POST /web-bridge-own/cancel` —— 叫停当前这一轮

排查时先看这里：`connected: false` 一般是"扩展没加载 / 没登录 / 没打开专用标签页"。

## 安全性质（都是踩过坑才留下的）

- **发送前先落标记**：万一页面在"已提交、还没拿到结果"时被刷新，醒过来只报错、**绝不重发**——
  否则你的账号里会出现两条一模一样的提问。
- **12 秒确认窗口**：网页没确认收到（输入框清空或出现停止按钮）就判失败，同样不重发。
- **租约 lease**：每个任务一个租约，扩展回报必须带对，旧实例写不进新任务。
- **Host 校验 + Bearer 密钥**：只接受本机端口的请求，挡住"恶意域名解析到 127.0.0.1"这类攻击。
- **先入库再提交**：broker 记下"已派发"之后才让页面提交，中途重载不会造成重复提问。

## 测试

```bash
npm test
```

全部**不需要浏览器**（浏览器那部分用假 DOM 做判定表）：

- `tests/protocol.test.mjs` —— 提示词组装、从答复原文抠 JSON（围栏/散文/字符串里的花括号）、
  校验、工具参数剥字段、OpenAI 响应转换
- `tests/broker.test.mjs` —— 鉴权、Host 校验、租约、单 worker 串行、取消、停滞看门狗、超时文案
- `tests/extension-logic.test.mjs` —— JSON 完整性、自适应结束判定、基线扫描（**必须排除"思考"文本**）、
  输入框/停止按钮识别、扩展清单自检

## 结束判定为什么不用等 5 秒

不少实现要求"答复 5 秒不变"才认为生成结束，于是每一轮都凭空多等 5 秒。本实现的前提是
**停止按钮消失**（网页确实停止生成），然后按内容形态决定还要稳多久：

| 答复形态 | 还要稳多久 |
|---|---|
| 一个完整 JSON 对象（括号闭合且能解析） | 800ms |
| 以 `}` 或 ``` 围栏收尾 | 1200ms |
| 其它（散文、可能还没写完） | 2500ms |
| 停止按钮还在 | **永不接受** |

轮询间隔也跟着走：生成中 1000ms（少扫 DOM），生成结束后 300ms。

## 已知限制（诚实清单）

- **网页改版会让选择器失效**。选择器集中在 `extension/dom.js` 的 `SELECTORS`，改版时改那一处；
  认不出页面时扩展会明确报错，而不是静默发错内容。
- **专用标签页要留在正常窗口里**。后台/最小化时浏览器会节流渲染，答复可能变慢；
  `extension/clock.js` 只在任务进行中做缓解，不保证根治。
- **单 worker 串行**：一个网页会话一次只跑一轮，第二个任务排队（这与"像人一样用一个网页"一致）。
- 网页端不提供真实 token 用量，因此**不返回 usage**（不伪造数字）。

## 许可

MIT（见 `LICENSE`）。本仓库代码为独立编写；行为逻辑参考了"把网页当模型用"这件事的通行做法
（输入框、停止按钮、答复容器等属于网页事实）。
