# 飞书通道：点完立刻显示结果

内置飞书通道用 `lark-cli event consume` 收卡片点击。它对飞书的回调只回一个空响应，所以点了按钮会先转圈、再跳回选项，等中台另发一次“更新卡片”请求到了才显示“你选了……”。每次请求都要新起一个 `lark-cli` 进程，网络慢时一次就要好几秒。

这个插件换一种收法：

- 用飞书官方 Node SDK（`@larksuiteoapi/node-sdk`）自己维持长连接，收到点击先交给中台核对回答人和原消息，确认算数后**在回调响应里直接带上新卡片**，转圈结束就是结果。中台没记上时只回一句提示，原来的选项保留。
- 发卡片、更新卡片都走同一个 SDK 客户端，复用令牌和连接。
- 卡片的样子直接用内置飞书通道的 `render`，两边不会走样；没配 App Secret 时整个退回内置通道。

一台电脑上的实测（走代理到飞书）：点击到显示结果从 6～7 秒（中间会跳回选项）变成转圈结束即显示；发一张新卡片从 4～6 秒变成 2 秒左右。

## 代价

- **App Secret 要明文放在本机**：写进 `~/.agent-autoloop/secrets.env`（权限 0600，`agent-autoloop backup` 会一起备份）。内置通道由 `lark-cli` 加密保存它。
- **多一个依赖**：插件目录里要装飞书 SDK，连同它依赖的 ws、axios 等。中台本身仍然零依赖。
- **一个应用只能有一处在听**：飞书长连接不广播，同一个应用连了多个客户端时，每次点击随机交给其中一个。用这个插件后，不要再对这个应用运行 `lark-cli event consume`，也不要在别的电脑上接同一个应用。发消息、读文档这类普通 `lark-cli` 命令不受影响。
- **不随 `agent-autoloop update` 更新**：它是复制到安装目录的本地插件，仓库里改了要重新复制。

## 安装

1. 先按[配置手册](../../../skills/agent-autoloop/SKILL.md#接一个通道)接好内置飞书通道：`lark-cli` 建应用、登录拿到自己的 open_id、订阅“卡片回传交互”、在 `rules.json` 和 `config.json` 登记 `feishu`，并确认能收到卡片。
2. 复制插件并装 SDK：

   ```bash
   cp -R examples/plugins/feishu-instant ~/.agent-autoloop/plugins/
   cd ~/.agent-autoloop/plugins/feishu-instant && npm install
   ```

3. 在 `config.json` 的 `channels.feishu` 里加两项，其他保持不变：

   ```json
   "feishu": { "use": "feishu-instant", "appId": "cli_你的应用", "key": "…", "user": "ou_你的 open_id" }
   ```

   `rules.json` 里的 `feishu` 和 `answerers` 不用改：通道名还是 `feishu`，只是换了插件。

4. 从飞书开发者后台“凭证与基础信息”复制 App Secret，写进 `secrets.env`（输入不显示）：

   ```bash
   read -rs "s?App Secret: " && printf 'AGENT_AUTOLOOP_FEISHU_APP_SECRET=%s\n' "$s" >> ~/.agent-autoloop/secrets.env && chmod 600 ~/.agent-autoloop/secrets.env && unset s
   ```

   这是 zsh 的写法；bash 用 `read -rsp "App Secret: " s`。

5. 重启中台：`agent-autoloop service install`。`~/.agent-autoloop/logs/up.log` 里出现 `[feishu] [sdk info] [ws] ws client ready` 就连上了。原来的 `lark-cli` 后台在最后一个使用者断开 30 秒后自己退出，`lark-cli event status` 显示 `Bus: not running` 即可。
6. 运行 `agent-autoloop try`，在飞书里点一个选项，转圈结束应直接显示“你选了……，已记录，等待处理”。

## 换回内置通道

把 `config.json` 里 `feishu` 的 `"use": "feishu-instant"` 删掉，再 `agent-autoloop service install`。`secrets.env` 里的 App Secret 不用了可以删掉。
