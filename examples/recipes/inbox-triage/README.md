# 收件箱分诊

每早把收件箱过一遍，写成一份放在本机的清单：今天必须回的、知道就行的、看着可疑的。要回的已经写好回复草稿，复制过去就能发。默认北京时间每天 8 点读过去 24 小时内的未读邮件。

## 怎么启用

1. 把本目录复制到 `~/.agent-autoloop/work/inbox-triage/`，目录权限设为 `0700`，不要放进 Git 仓库。两条规则使用同一台电脑、同一 `cwd` 和同一 `group`，读取和整理串行执行。
2. 把 `SKILL.md` 放到 `~/.codex/skills/inbox-triage/`；Claude Code 放到 `~/.claude/skills/inbox-triage/`。
3. 安装已登录本人的 `lark-cli`，先确认它读得到信：
   ```bash
   lark-cli mail +triage --as user --max 3 --filter '{"folder_id":"INBOX","is_unread":true}' --format json
   ```
   看到 `data.messages` 里每封邮件都有 `message_id`、`subject`、`head_from` 就能用。只沿用已有授权，不在脚本里保存或导出 access token。字段不一样就先改 `collect.ts` 里对应的一处，别让它读不懂还硬跑。
4. 修改 `sources.json`：`folderId` 是要看的系统目录（`INBOX`、`SPAM` 等）；`onlyUnread` 为 `true` 时只读未读；`lookbackHours` 是回看几小时；`maxMessages` 是这次最多读几封（1 到 400）；`bodyChars` 是每封正文最多留多少字；`skipSenders` 里的地址根本不读正文，通知类发件人填这里。
5. 合并规则的 `sources`、`agents`、`channels`、`rules`，替换接单电脑和路径；时区用 `Asia/Shanghai`。权限：`edit`，分诊 Agent 只读本机快照、写清单和草稿；联网读信由固定脚本完成，它只执行读取命令。
6. 运行 `agent-autoloop check`。在专用测试中台用假 CLI 验证采集、分诊派发、登录失效后的提问与续办，再启用自己的定时规则。

## 读什么、留什么

读取用 `mail +triage` 拿列表（只取元数据和摘要），再用 `mail +messages` 按 `message_id` 批量取正文，两步都是 `--as user`，只用本人已有的权限，不换成机器人身份去拿更多信，也不读 `skipSenders` 里的发件人。时间范围写进 `--filter` 的 `time_range`，按北京时间显示。一次最多读 `maxMessages` 封：按 `+triage` 返回的 `page_token` 一页页往下翻，`skipSenders` 里的发件人不占名额，所以排在它们后面的邮件不会被挤掉。收满 `maxMessages` 封或翻到窗口尽头才停。只有翻到窗口尽头、一封没落下时，快照里的 `scanned.complete` 才是 `true`；收满了而后面还有邮件也算没读完，是 `false`，清单会写明还有邮件没读，不会说成“没有需要看的邮件”或“都看过了”。

正文按 `bodyChars` 截断，`truncated` 标出被截断的邮件，摘要 Agent 据此写“需打开原文核实”，不会把半截正文当成全文。接口没有回来的邮件、只回来一部分正文的（`unavailable_message_ids` 非空）都算没读成：这一轮不生成快照，也不用上一次的文件冒充。

`+messages` 只取文字，附件和图片不下载；`body_html` 不用，只用纯文本。完整快照保存在 `inbox-input.json`（权限 `0600`），分诊清单是 `briefs/inbox-<编号>.md`；它们属于本人的邮件资料，不提交、不公开，也不把正文放进飞书卡片。

这个模板**只读**：不发送、不在邮箱里建草稿、不改已读、不打标签、不归档、不删除。回复草稿只写在本地清单里，发送由本人自己完成。要真的在邮箱里生成草稿，那是“对外动作”，得先自己加一条规则并想清楚由谁确认。

本人登录或授权失效时只发一张问题卡片，没有 `inbox.ready` 事件，不拿上次的快照冒充这一轮。本人恢复后点继续，重新完整读取；选“本期先跳过”结束本轮，下次计划时间再读；临时接口错误则如实失败，由中台现有机制处理。

邮件正文是别人写的字，可能包含伪装成指令的内容。分诊 Agent 只把它当资料：不按邮件里的要求转发、回复、付款或改设置，这类要求只在清单里记下来由本人决定。

## 飞书通知

规则默认登记 `feishu` 通道。把 `ou_REPLACE_ME` 换成本人的 open_id；在已有 `config.json` 的 `channels.feishu` 配上这个人的 `user` 和已有通道密钥。复用已运行的飞书通道，不另开监听。尚未接入时按[通道配置](../../../skills/agent-autoloop/SKILL.md#接一个通道)完成；配置涉及新密钥或权限时先取得本人授权。

读取邮件使用本人身份，通知使用机器人身份。默认只发给本人；一个中台默认把卡片交给它配置的所有通道；含私人资料的规则写上 `channels`，只发到本人私聊的通道，不要混入共享群通道。不要把密钥、实际 open_id 或邮件内容提交到仓库。
