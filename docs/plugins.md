# 写插件

先看 [README 的内置插件目录](../README.md#插件体系四个方向都能自由替换)选择已有实现；需要扩展时，从下面三个可运行的最小模板开始，替换业务部分：

| 模板 | 已经演示了什么 | 你要替换什么 |
|---|---|---|
| [Agent 模板](../examples/plugins/hello-agent/agent.ts) | 用 `echo` 模拟执行，读取输出与会话编号 | 新 Agent 的启动命令和输出解析 |
| [通道模板](../examples/plugins/hello-channel/channel.ts) | 领卡片、写到文件、报告送达；通过命令行回答 | 目标平台的发送、更新和回答回调 |
| [事件插件模板](../examples/plugins/hello-source/source.ts) | 验证 HMAC-SHA256 签名，把模拟订单转换成事件 | 业务系统的验签方式和字段映射 |

事件插件、接单程序、通道和命令行共用同一套 HTTP + JSON 接口。只用 Shell 接协议，可以看 [接单脚本](../examples/worker.sh) 和 [通道脚本](../examples/channel.sh)：设置中台地址与密钥后运行，需要 `curl`、`jq`。它们适合演示短任务；长任务使用内置接单程序的心跳、停止和恢复能力。

一个插件就是一个目录，入口为 `agent.ts`、`channel.ts` 或 `source.ts`。只用 `node:` 模块和自己目录里的文件，类型在插件里声明；不要相对引用引擎源码：装在 `~/.agent-autoloop/plugins/` 的插件，相对路径到不了引擎。内置插件和引擎放在一起发布，才能直接引 `worker/agents.ts` 里的 `findProgram`、`tail` 这些小工具，引擎不反过来引插件。

用 `agent-autoloop add <git 地址>` 安装到 `~/.agent-autoloop/plugins/<仓库名>`，也接受本地 Git 仓库。插件名就是那个目录名：仓库名转成小写，只能用小写字母、数字和 `-`，别的名字会被拒绝，并说出它算出来的名字；规则的 `use` 和来源的 `adapter` 都写这个名字。它只克隆，不装依赖、不跑安装脚本、不自动更新。加载时会执行插件，安装目录的同名插件优先。

## 先跑起来

在引擎目录运行这条命令：它把三个例子分别装进临时中台，实际走完验签、派活、运行、通知和报告，退出后清理。

```bash
node --disable-warning=ExperimentalWarning --test --test-name-pattern='agent-autoloop add' tests/example-plugins.test.ts
```

## Agent 插件

从 [hello-agent/agent.ts](../examples/plugins/hello-agent/agent.ts) 开始。它用 `echo` 代替模型，克隆到别处也能运行。

| 导出对象的方法 | 作用 |
|---|---|
| `command(turn)` | 返回命令参数数组；参数不作为 shell 代码执行 |
| `read(stdout, code, stderr)` | 返回 `text`、`session`、`usage`、`sessionUsage`、`error`、`finished`、`started`；运行中 `code` 为 `null` |
| `link(session)` | 可选，打开这个会话的链接。回执写错时，`read` 返回了 `session` 的插件都只重写回执，和有没有链接无关 |
| `check()` | 可选，能用返回 `null`，否则返回下一步怎么做 |

`turn` 包含 `prompt`、`session`、`resume`、`cwd`、`access`、`model`、`effort`、`command`、`contextFile`、`folder`。`contextFile` 是资料文件，受限 CLI 需要允许读取 `folder`。`read` 要能处理未写完的输出；CLI 真正完成后才返回 `text`。`read` 抛错或什么也不返回时，还在跑的接着跑，结束后这一轮算没跑成，留在原会话重派。

支持 `resume` 的插件，从 Agent 收下提示词起都要返回 `started: true`，包括运行中和出错之后。否则干到一半断了，也会被当成会话接不上，开新会话把业务重做一遍。返回了 `session` 就要按 `turn.resume` 接回原会话：没跑成的重派和写错回执的重写都靠它；接不回去的 CLI 不要返回 `session`。

`usage` 是这次启动用掉的量。有的 CLI 只给整个会话累计到现在的数（Codex 的 Token、Claude Code 的费用），这几项放进 `sessionUsage`，同时要返回 `session`。接单程序启动前记下这个会话上次的累计值，结束后相减，和 `usage` 合起来上报；这些记录放在 `~/.agent-autoloop/worker/usage/`，接单程序中途重启也不会多算。

没有记录的续接（换了电脑、升级前就有的会话）或累计值变小时，这几项这次不报，不猜；下一次续接恢复正常。其他程序在同一个会话里用掉的量分不出来，比如本人打开链接接着聊，会算进下一次续接。CLI 改成只报单次时，插件要把这几项改回 `usage`，不要靠数字大小去猜。

在规则里选择这个插件：

```json
{ "name": "Hello", "worker": "my-computer", "use": "hello-agent", "access": "read" }
```

只需要打印最后一条消息时，用内置 `command` 加参数数组即可，不必写插件。参数里可以用 `{prompt}`、`{model}`、`{effort}`、`{cwd}`、`{context}`，每个参数只替换一轮，替换进去的提示词原样传给程序：提示词里写着 `{cwd}` 或 `$&`，到程序那边也还是这几个字，不会被再替换一次。运行时还有环境变量 `AGENT_AUTOLOOP_CONTEXT`（资料文件）和 `AGENT_AUTOLOOP_RUN`（第几轮）。

DeepSeek Harness 有内置 `dsh` 插件，规则里写 `use: "dsh"`，要 0.2.2 或更新，`agent-autoloop doctor` 会查。现在 npm 的 `latest` 还是旧版，要这样装：`npm install -g @deepseek-ai/dsh@next --allow-scripts=koffi,node-pty,@deepseek-ai/dsh-subprocess-local`。新版 npm 默认不跑依赖的安装脚本，不放行这三个包，装完看着正常，一跑才出错。从旧版升上来的，0.2.2 可能读不到 `~/.dsh/.credentials.yaml` 里的 `refs`，报 `MISSING_CREDENTIAL`：把密钥放进环境变量，Linux 的系统服务放 `~/.config/environment.d/*.conf`。只上报 Token，不上报费用。有用户在 WSL2 上用 0.2.2-rc.1 和第三方 OpenAI 兼容服务实测跑通了问答、用量和 `resume`。它以 `dsh headless --json` 跑一轮，从 `session` 事件拿会话编号，用 `--session-id` 续接，把 `step_end` 的用量汇总为 Token，`final` 事件才算跑完；`access` 每次都映射成 `--permission-mode`，要人批准的调用用 `--approval-policy never` 直接拒绝。规则里的 `model`、`effort` 不起作用，用 DSH 自己的配置。没有可打开的桌面会话链接。DSH 默认把会话日志上传给 DeepSeek，见[它的说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/reference/README.md)。

### 浏览器接入

浏览器工具装在运行 Agent 的电脑上，由该 CLI 的工具配置或项目 Skill 提供。Codex 插件启动的是后台 [`codex exec`](https://developers.openai.com/codex/noninteractive/)；可以使用它已配置的 [MCP 工具](https://developers.openai.com/codex/mcp/)，不能只凭桌面应用能打开网页就认定后台也能访问同一浏览器。

Claude 委托 Codex 的完整规则、Skill 和参数调用脚本见[浏览器交接模板](../examples/recipes/browser-handoff/README.md)。入口命令、目标与允许操作由本人配置；网页助手返回证据和会话编号，主任务负责业务与回执。

已有专用浏览器入口时，在规则的 `prompt` 或 `skill` 写明实际命令、会话接续方式和允许的操作。只交网页步骤，返回看到的内容、操作结果和阻塞原因；主任务负责业务和中台回执。浏览器入口不是必装组件，中台不捆绑某台电脑的脚本，也不自动修改 CLI 的工具配置。

需要网页验收的任务，要用同一后台启动方式实际打开目标页面，核对内容并接续一次会话。缺少可用入口或需要本人恢复连接、登录、验证时，保留未验收项，用现有 `ask` 等待恢复；不要写“没跑成”触发重派，也不能把 HTTP 查询当作已经完成网页验收。

## 通道插件

从 [hello-channel/channel.ts](../examples/plugins/hello-channel/channel.ts) 开始。它把卡片写进文件，用命令行回答。

默认导出异步函数，参数是 `{ hub, options, log, signal }`；`options` 来自 `config.json`，不含中台密钥。

| 调用 | 作用 |
|---|---|
| `hub.nextCard(50)` | 长轮询领卡片，没卡片返回 `{ card: null }` |
| `hub.delivered(id, version, ref)` | 报告送达，保存外部消息编号 |
| `hub.failed(id, version, error)` | 报告发送失败 |
| `hub.answer(id, { choice, by, ref })` | 转交回答；核对回答人和原消息；算数时带回记好后的卡片 |

`ref` 为空就发新消息，有值就更新原消息；不能更新时只报告。没报告的卡片一分钟后重派。`signal` 中止时退出；函数在此之前返回或抛错，都记日志并在 30 秒后重启，所以它要一直运行。插件和中台在同一个进程里：没接住的错误只记日志，不让中台退出。

在 `rules.json` 登记通道、用 `agent-autoloop key new channel cards` 取密钥，再把下面这项放进 `config.json` 的 `channels`，重启中台：

```json
{ "cards": { "use": "hello-channel", "key": "通道密钥", "file": "/tmp/cards.txt" } }
```

能收回调的通道要在规则里设置 `answerers`，没设时通道里谁都能回答，`doctor` 会提醒；只能发文字的通道设置 `links: true`，发送 `card.link`。拿到链接的人能回答这张卡片。

通道和中台共用一个 Node 进程，外部调用应异步等待。内置飞书通道的用户查询、发送和更新均异步调用 CLI，发送期间中台仍能接收事件和心跳。

能在回调里直接响应的平台，可以先 `hub.answer`，算数时返回里的 `card` 就是记好之后的卡片，把它画进响应，点完就显示结果；这一版和中台随后交来的一样，不用再改一次消息。[feishu-instant](../examples/plugins/feishu-instant/README.md) 是飞书的例子：用官方 Node SDK 自己维持长连接，卡片样子沿用内置飞书通道；它要另装 SDK，并把 App Secret 放进 `secrets.env`。

## 事件插件

从 [hello-source/source.ts](../examples/plugins/hello-source/source.ts) 开始。它检查 `x-shop-signature` 中的 HMAC-SHA256，再把订单变成事件。

默认导出同步函数，参数为 `{ headers, body, secret }`。先验签，再解析原文；返回事件数组，无事返回 `[]`，拒绝请求就抛异常。事件插件只翻译，不发请求。

在 `rules.json` 登记来源：

```json
{ "shop": { "name": "商店", "adapter": "hello-source" } }
```

请求地址是 `/v1/in/shop`；秘密放在 `secrets.env` 的 `AGENT_AUTOLOOP_SECRET_SHOP`（来源名转大写，`-` 换成 `_`；改完重启中台），不写进规则。事件必须有稳定的 `id` 和合法的 `type`，可带 `subject`、`summary`、`detail`、`link`，上限见[协议](protocol.md#来源把世界变成事件)。

来源能直接发标准 JSON 时不必写插件，用来源密钥调用 `POST /v1/events` 即可。

## access 实际能做什么

`access` 由插件翻译，不是中台提供的系统沙箱。以下是未额外放宽本机权限时的行为。

| 插件 | `read` | `edit` | `full` |
|---|---|---|---|
| Codex | `read-only`：能跑 shell，不能写文件，命令默认不能联网 | `workspace-write`：能跑 shell、写工作目录和临时目录，命令默认不能联网 | `danger-full-access`：能写文件、跑 shell、联网，无审批 |
| Claude Code | `plan`：能读文件和运行只读命令；其他命令取决于自动审批及本机规则 | `acceptEdits`：再允许目录内文件编辑和常见文件操作；任意 shell 或联网仍需放行 | `bypassPermissions`：跳过工具审批，没有额外系统隔离 |
| DeepSeek Harness | `read-only`：不能写文件，读文件和联网不受限 | `workspace-write`：命令和文件改动限于工作目录和临时目录，读文件和联网不受限 | `danger-full-access`：不受限制 |
| ACP | Agent 来问时，同意读和搜索 | 再同意工作目录内的编辑 | 同意它来问的所有操作 |

Codex 的三个档位已用插件命令实跑；DeepSeek Harness 和 Claude Code 分别依据 [DSH 文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/reference/README.md)和[官方权限说明](https://code.claude.com/docs/en/permission-modes)整理，没有调用模型实跑。Codex 的命令网络限制与托管搜索、MCP 不是同一个边界，详见[官方沙箱说明](https://learn.chatgpt.com/docs/agent-approvals-security)。用户的 CLI 配置可能改变上述能力；`read` 也不代表读不到本机密钥。

ACP 的 `access` 只管 Agent 主动来问的操作。规范允许 Agent 不询问就执行，这种操作 `access` 拦不住，要用 Agent 自己的模式限制，比如 `command` 里写 `env INITIAL_AGENT_MODE=read-only …`。ACP 的 `model`、`effort` 不生效，也要在 Agent 自己那边设置。

场景模板据此选权限：早报用 `edit` 写本地文件，issue 用 `edit` 改代码并让固定脚本联网取正文，告警用 `read` 看代码和事件附带的调用栈。反馈处理和飞书摘要用 `edit`，网站排查用 `read`；固定巡检与飞书读取脚本负责联网，摘要 Agent 只读完整快照。`command` 和固定脚本以本机账号运行，不受 `access` 约束。

## 一致性测试

在引擎目录运行协议的现有 HTTP 检查，全部使用临时数据和随机端口：

```bash
node --disable-warning=ExperimentalWarning --test tests/conformance.test.ts
```

检查其他中台实现时，用 `agent-autoloop conformance <测试地址> --config <测试凭据文件>`，文件格式见[协议](protocol.md#一致性和复现)。它会写事件和卡片，只对专用测试中台运行。

插件本身的完整接入测试见 [tests/example-plugins.test.ts](../tests/example-plugins.test.ts)。用其他语言写独立进程也可以，参考 [curl/jq 通道](../examples/channel.sh)和[接单程序](../examples/worker.sh)。
