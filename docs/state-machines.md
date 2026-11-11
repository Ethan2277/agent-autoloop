# 状态与转换

这里集中列出状态的权威位置、写入者和约束；HTTP 字段见[协议](protocol.md)。一轮 `done` 不代表事项没有后续，`delivery=success` 不代表一定上线。

## 事件、事项、轮次

| 对象 | 状态与存储 | 谁在哪里改 |
| --- | --- | --- |
| 事件 | `events` 的 `source + key` 去重；`routed/paused/hops` 区分已派、暂停跳过、无人接、超过 8 层未派 | `kernel/decide.ts` 的 `ingest/recordEvent` 接来源、回执、回答、时钟和手动运行 |
| 事项 | 没有单独状态列；`rule + lane` 对应的轮次、未结卡片、未来复查共同表达进展 | `enqueue/answer/tick/retryLater`；运行中来的事件排下一轮，失败时把同事项的队列合进重试轮次 |
| 轮次 | `runs.state`: `queued → claimed → done/nothing/cancelled`；`claimed → unknown`；失败从 claimed/unknown 回 queued，`attempts/not_before` 表达等重试 | `claimNext/finish/applyReceipt/retryLater/cancel/stopRun/sweep`。unknown 不是失败，迟到结果照收，后续新活可以继续 |
| 停止 | `claimed + cancel_at` 表示正在停；进程结束才 cancelled；排队可直接取消 | 本人 `cancel`，worker 停整个进程组后交结果；停止期间收到 failed 也归 cancelled，不能重派 |
| 执行归属 | `agent/rules_version/issued/claim` 固定领取归属；`session/resume` 是续接提示 | `assignQueued/settleSession/claimNext/started/finish`。排队用最新规则，领取后保留原 worker 和规则快照；重复 claim 换 token |

`done + open 提问`、`done + 未来复查` 都合法：只结束这一轮。连续失败最多 10 次，终态轮次不能重排。本人要再做用新事件或手动 `run`。已交回的 `last_issued/last_result/last_answer` 保证同 token 同内容重交只确认一次，不同内容返回 409。

禁止同组同 lane 同时领取两轮、停止后自动重试、换 Agent 沿用旧 Agent 会话、回答/复查丢掉原 lane。unknown 放开组后，新轮仍不能打开可能在用的会话。并发、原会话及 token 检查在上述入口统一执行。

## 卡片、投递、复查与暂停

| 对象 | 状态与存储 | 谁在哪里改 |
| --- | --- | --- |
| 提问 | `cards.state`: `open → decided → done` 或 `open → closed` | `createCard` 创建；`answer` 核对本人、通道和消息 ref，只改 open，产生 `answer_event`；成功处理回答的 `applyReceipt` 才写 done；`resolve/closeCard` 表示无需决定 |
| 通知 | 普通通知 open → closed；FYI 创建时就是 closed | `cardFromReceipt/notify/tell` 创建，本人或允许范围内的回执结案。decided 不等于执行过；续办被取消仍保留决定，不伪造 done |
| 投递 | `deliveries[card_id:channel]` 的 `version/ref/tries/not_before/given_up` 组合：未发、已租出、重试等待、已同步、放弃 | `nextCard` 租给通道，`delivered` 确认，`failed` 排重试；卡片版本更高时更新原消息。超过窗口放弃，重复 tell 可重新启动已放弃投递 |
| 复查 | `timers.event_id=null` 等待，非空已触发；同 `rule/lane/key` 只一个待触发 | `scheduleReview` 设置、改期、取消；`tick` 记唯一 timer.due 并派回原事项；删规则后到期只留记录、不派发 |
| 定时计划 | `schedules.cron/next_at/skipped_at`，不是业务完成态 | `tick` 更新；错过只补最近一次，配置改变重新计时，暂停时跳过 |
| 暂停 | `pauses[name]` 有效记录表示暂停，含 since/until；恢复删除 | 本人 `pauseRule/resumeRule`、到期 `tick`。已经领取的不受影响，队列及回答复查留队，新来源事件跳过且恢复不补派；暂停不能手动运行 |

卡片的回答和结案只能有一个发生。失败回执只允许通知，提问、结案、复查、发事件不生效。卡片与投递版本不同只是待同步，不能理解成卡片重开。

复查保存创建者 `agent` 与 `session`，只有规则仍派给同一 Agent 才续接；旧日志缺 agent 的复查照常到期、保留资料，不再强行沿用旧会话，仍按规则的 resume 决定是否续接当前 Agent 最近的会话。不迁移旧事实。卡片的续接已有同样归属检查。

`due` 是 `kernel/due.ts` 算的时钟索引，和业务事实同事务提交；不是另一份业务状态。`kernel/store.ts` 独占追加事实，`kernel/evolve.ts` 独占持久投影写入。

## worker 本地执行

状态存在 `worker/runs/<run>-<attempt>/entry.json`、stdout 和 exit 文件，由 `worker/worker.ts` 改：`start` 先保存已领任务；`launch` 保存 turn 后启动带标记进程组；`check` 结合 pid、真实进程命令、退出标记区分运行、不可核实、退出；`stop` 保存 stopping/why，进程组确实结束后 `conclude` 得结果；回执重写由 repairs/turn/resume 表达，最多两次；`endWith` 先持久化 result，`settle` 才提交；接受或明确 4xx 拒收移除 entry，5xx/连接失败继续保留；`tidy` 只清没有 entry 的过期目录。

进程读不到不等于已退出，退出码还没写不等于失败，已续接后中断不能换会话重做。

## PR 交付、审查、发布

权威在 GitHub PR（head/base/draft/closed/merged/auto_merge）、标签、提交状态、工作流、健康版本。进度事件仅供展示。`plugins/delivery/delivery.ts` 每步重读，`run.ts/handoff.ts` 负责退回和约重查。

| 状态 | 权威条件及改动入口 |
| --- | --- |
| 待交付 | 交接 CLI/本人加 deliver；`poll.ts` 按 PR、head、标签事件发稳定事件，不留游标 |
| 已接手/审查中 | 执行器写 delivery=pending，读固定 main 上的设置；`review.ts` 执行策略 |
| 等修复 | 审查状态 failure、可信审查账本含未处理项；不可同提交重新审一遍抹掉发现 |
| 检查中 | 当前 head 最新 pull_request workflow 及要求的矩阵 job 都成功；转 ready 之前的检查不算 |
| 合并中 | main/head/base/标签/策略仍匹配；执行器调用 merge/auto-merge 并读回，响应丢失先确认 |
| 发布中 | PR 已合并且 deliver 仍在；`waitLive` 等覆盖 merge 的 Ship 成功并核对线上版本 |
| live | Ship 成功且健康版本包含目标，执行器写 delivery=success、清标签、报阶段 |
| merged/docs_only | 没线上服务只完成合并；或健康版本到目标全差异只有内部文档，无需上线；描述必须区分 |
| reviewed | deliver-review 要求只审查，完成清标签；部分清除失败不能变成全文交付 |
| returned | delivery=failure，去 deliver/deliver-review；deliver-attended 由交接者领取，三分钟未领才按既有规则转告 |
| withdrawn | 检查中撤 deliver，关闭 auto-merge，成功结束但未合并发布，明确报告撤回；不等于 live |
| retrying | 中台 later 的 delivery-retry 保存 head、GitHub/执行错误计数；换 head 清计数，达限退回；不可写结果时保留重交 |

关闭未合并的 PR 先写 delivery 失败再清标签，避免等待者卡 pending。ask-owner 是独立 Issue 的转告状态，转告成功才清除，不是上线阶段。来源只认可信账号的 `delivery-agent/<PR号>` 状态；PR 正文审查账本与可信状态绑定轮次、head、审查器和正文摘要。免审不是审查通过，填写「处理」不是复审完成。

## 历史依据与已知旧记录

| Git 提交 / PR | 原问题与约束 |
| --- | --- |
| cbf158a / #111 | 停止后先交失败会重排；parallel 改动使回答/复查落错事项。失败停止归 cancelled，lane 保持 |
| fdacb94 / #54 | 删规则后队列永久无人领取；现取消并通知 |
| 4a0094f / #67 | 失败终止丢回执用量、会话及去重；现保留本次事实 |
| c94a9c5 / #60 | 已续接中断改开新会话重做；现只在未接上时开新会话 |
| 21594a5 / #211 | 实机事故明确记录：WebSocket 报错后回退 HTTPS 完成，仍被旧错误判失败；12 次成功重做，耗 111 万输入 Token。完成事件现清先前连接错误 |
| ad0384f / #118 | FYI closed 却无 closed_at；新记录已修复，旧事实不伪造时间 |
| f25ce4a / #113、4f971cd / #88 | 重复审查漏掉原发现；同步 main 后结束轮次导致一直追赶 main。现绑定提交、同轮同步 |
| 5285e0e / #240、e8748fd / #242 | 多项目交付、可信审查账本、应急重试的现行边界，不能再按已退役交付进程推断 |

#245 用回归复现后修了三处：复查跨 Agent 携带会话、撤回缺进度终态、关闭 PR 留 pending，分别在 `tests/resume-thread.test.ts`、`tests/delivery.test.ts`、`tests/delivery-run.test.ts`。代码复现不等于已确认线上事故。
