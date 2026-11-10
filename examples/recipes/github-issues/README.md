# 跟进 GitHub issue

## 解决什么
每五分钟读新 issue，在本地改代码并通知你查看；不提交、不推送、不回复 issue。

## 怎么启用
把本目录的 `SKILL.md` 复制到 `~/.codex/skills/handle-issue/`；Claude Code 用 `~/.claude/skills/handle-issue/`。
把 `rules.json` 的 `sources`、`agents`、`rules` 并进 `~/.agent-autoloop/rules.json`，然后检查：
```bash
agent-autoloop check
```
接单电脑需要已登录的 `gh`；轮询脚本把正文一并交给 Agent。

## 要改哪几处
- 两处 `worker` 换成接单电脑；`use` 选 `codex` 或 `claude`。
- `owner/repo` 换成仓库，把 `created:>=YYYY-MM-DDT00:00:00+08:00` 中的 `YYYY-MM-DD` 换成启用日期；GitHub 按 UTC 算日期，不带时区的话，北京时间当天早上 8 点前开的 Issue 会被漏掉。`cwd` 换成干净的项目目录。
- 权限：`edit`。Agent 只读资料、改本地文件；联网由固定轮询脚本完成，它不受 `access` 限制。Claude 默认不放行任意测试命令，见[权限说明](../../../docs/plugins.md#access-实际能做什么)。
